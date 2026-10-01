"""A running turn's ORG STATE block reads the SHARED snapshot, not its own copy.

mem-leak-probe measured (2026-09-28, N=1000 on v3 cedd41b) a 16-way message
burst taking the engine from 1.0 to 5.1 GB in ~20 s. The per-caller tally of
lazy-row whole walks named one site on every turn: `_org_state_parts` ->
`children_index` on the turn's private admission copy, which decodes the whole
node table into that copy (~200 MB at N=1000) for the rest of the turn.

Actual PostgreSQL (disposable, via test_pgstore), on-demand rows ON. Proves:
  * the block rendered from the shared snapshot is TEXT-IDENTICAL to the block
    rendered from the turn's copy, facts included;
  * the snapshot is used only when it covers the admission commit — a newer
    sequence than the snapshot's is refused, not assumed;
  * the turn's copy stays row-sparse (control: the old path decodes every row);
  * read-only is ENFORCED: a render that writes into the snapshot (node row,
    top-level section, the document itself, a buffered append) is caught, the
    snapshot is evicted from the cache, and the block still comes out right;
  * a REAL turn (`_run_turn` against a fake CLI that blocks) keeps its copy
    row-sparse for as long as it runs. ORGTREE_TEST_LONG_TURN_S sets how long
    the blocked turn is sampled (default 3 s; the minutes-long case is
    ORGTREE_TEST_LONG_TURN_S=180, run once by hand).

Run:  python tools/run-python-verification.py tests/test_turn_org_state_shared.py
"""
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, orgtx, store, supervisor as sup, warmpool

N_NODES = 60
LONG_S = float(os.environ.get("ORGTREE_TEST_LONG_TURN_S", "3") or 3)


def tearDownModule():
    f.tearDownModule()


def decoded(org):
    """Node rows decoded in `org`, read without decoding any."""
    return dict.__len__(dict.get(org.d, "nodes"))


class _Lazy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org("ostate-" + uuid.uuid4().hex[:10])
        self.slug = org.d["slug"]
        org.hire(ledger.USER, None, "opus", 0, "boss")
        for i in range(N_NODES):
            org.hire(ledger.USER, "boss" if i % 3 else None, "opus", 0, f"w{i}")
        self.nid = "w1"
        org.node(self.nid)["session_id"] = "fixture-session"
        store.save_org(org)
        # the first transaction on a fresh org is a whole load that heals and
        # stamps the heal epoch; after it, copies decode rows only when touched
        with orgtx.org_tx(self.slug, nodes=[self.nid]):
            pass
        self.addCleanup(lambda: store._POOL.close_all(self.slug))

    def private(self):
        """The turn's kind of copy: a transaction's, lazy, nothing walked."""
        with orgtx.org_tx(self.slug, nodes=[self.nid]) as tx:
            org = tx.org
            org.node(self.nid)["inflight"] = {"marker": uuid.uuid4().hex}
        return org

    def block(self, org, view):
        out, pending = {}, {}
        # the block's header carries the wall clock: pin it so two renders compare
        with patch.object(sup, "now_iso", return_value="2026-09-28T00:00:00.000Z"):
            text = sup._envelope_state_block(org, self.nid, 1000.0, pending, out=out, view=view)
        return text, out, pending


@unittest.skipUnless(f.ADMIN, "disposable PostgreSQL required: NOT RUN")
class SharedView(_Lazy):

    def test_the_block_is_text_identical_and_the_copy_stays_sparse(self):
        store.LAZY_ROWS_FALLBACKS.clear()
        mine = self.private()
        self.assertLessEqual(decoded(mine), 3, f"the transaction copy arrived walked: "
                             f"{list(store.LAZY_ROWS_FALLBACKS)}")
        view = sup._org_state_view(self.slug, self.nid, store.org_seq(self.slug))
        self.assertIsNotNone(view, "the shared snapshot was not offered")
        self.assertTrue(getattr(view, "_shared_snapshot", False))
        new = self.block(mine, view)
        self.assertLessEqual(decoded(mine), 3,
                             f"the turn's copy decoded {decoded(mine)} node rows")
        old_copy = self.private()
        old = self.block(old_copy, None)
        # control: the old path is what decodes the table, so the check above
        # would have caught it
        self.assertGreater(decoded(old_copy), N_NODES,
                           "the control never walked its copy; the sparse check proves nothing")
        self.assertEqual(new[0], old[0])
        self.assertEqual(new[1], old[1])
        self.assertIn("Your peers:", new[0])
        # the roster facts recorded beside the text: same from either source
        self.assertEqual(sup._roster_facts(view, self.nid), sup._roster_facts(old_copy, self.nid))
        segs = sup._state_segments(mine, self.nid, new[0], new[1], "", view=view)
        self.assertEqual(len(segs), 1)
        self.assertLessEqual(decoded(mine), 3, "the roster facts walked the turn's copy")

    def test_the_snapshot_must_cover_the_admission_commit(self):
        mine = self.private()
        marker = mine.node(self.nid)["inflight"]["marker"]
        seq = store.org_seq(self.slug)
        view = sup._org_state_view(self.slug, self.nid, seq)
        self.assertEqual(view.node(self.nid)["inflight"]["marker"], marker,
                         "the snapshot does not include the admission commit")
        _, snap_seq = store.cached_org_seq(self.slug)
        self.assertGreaterEqual(snap_seq, seq)
        self.assertIsNone(sup._org_state_view(self.slug, self.nid, snap_seq + 1),
                          "a snapshot older than the admission commit was accepted")

    def test_a_node_missing_from_the_snapshot_or_the_switch_off_uses_the_copy(self):
        seq = store.org_seq(self.slug)
        self.assertIsNone(sup._org_state_view(self.slug, "nobody", seq))
        with patch.object(sup, "ORG_STATE_SHARED", False):
            self.assertIsNone(sup._org_state_view(self.slug, self.nid, seq))


@unittest.skipUnless(f.ADMIN, "disposable PostgreSQL required: NOT RUN")
class ReadOnlyGuard(_Lazy):
    """Each case makes the render WRITE into the snapshot. The guard must
    catch it, evict the snapshot, and still produce the right block."""

    def attempt(self, write):
        mine = self.private()
        view = sup._org_state_view(self.slug, self.nid, store.org_seq(self.slug))
        self.assertIsNotNone(view)
        expect = self.block(self.private(), None)[0]
        real = sup._org_state_parts

        def writing(org, nid, include_archived):
            parts = real(org, nid, include_archived)
            if org is view:
                write(org)
            return parts
        before = sup.SHARED_SNAPSHOT_WRITES[0]
        with patch.object(sup, "_org_state_parts", side_effect=writing), \
                contextlib.redirect_stdout(open(os.devnull, "w")):
            text = self.block(mine, view)[0]
        self.assertEqual(sup.SHARED_SNAPSHOT_WRITES[0], before + 1, "the write was not caught")
        self.assertIsNot(store.cached_org_seq(self.slug)[0], view,
                         "the written snapshot is still the cached one")
        self.assertEqual(text, expect, "the fallback block is wrong")

    def test_a_node_row_write(self):
        self.attempt(lambda org: org.node("w5").__setitem__("name", "changed"))

    def test_a_nested_node_write(self):
        self.attempt(lambda org: org.node("w5")["scope"].__setitem__("org_visibility", "full"))

    def test_a_node_delete(self):
        self.attempt(lambda org: org.nodes.pop("w7"))

    def test_a_section_replaced(self):
        self.attempt(lambda org: org.d.__setitem__("models", {}))

    def test_the_document_replaced(self):
        self.attempt(lambda org: setattr(org, "d", store.load_org(self.slug).d))

    def test_a_buffered_append(self):
        self.attempt(lambda org: store.log_append(org.d, "events", {"kind": "x"}))

    def test_a_clean_render_is_not_refused(self):
        mine = self.private()
        view = sup._org_state_view(self.slug, self.nid, store.org_seq(self.slug))
        before = sup.SHARED_SNAPSHOT_WRITES[0]
        self.block(mine, view)
        self.assertEqual(sup.SHARED_SNAPSHOT_WRITES[0], before)
        self.assertIs(store.cached_org_seq(self.slug)[0], view)


# the fake CLI: init, read the prompt, say so, block until released
_CHILD = r'''
import json,os,sys,time
flag=sys.argv[1]
def emit(e):print(json.dumps(e),flush=True)
emit({'type':'system','subtype':'init','session_id':'fixture-session','tools':[]})
sys.stdin.readline()
open(flag+'.blocked','w').close()
t0=time.time()
while not os.path.exists(flag+'.release') and time.time()-t0<3600:
    time.sleep(0.05)
emit({'type':'assistant','message':{'id':'a','role':'assistant','model':'claude',
      'content':[{'type':'text','text':'done'}],'usage':{'output_tokens':1}}})
emit({'type':'result','subtype':'success','is_error':False,'result':'done',
      'total_cost_usd':0,'usage':{'output_tokens':1}})
'''


def orgs_held_by(thread):
    """Distinct Org objects the thread's frame locals reach (an Org, or a
    transaction's `.org`)."""
    frame = sys._current_frames().get(thread.ident)
    held = {}
    while frame is not None:
        for value in list(frame.f_locals.values()):
            org = value if isinstance(value, ledger.Org) else getattr(value, "org", None)
            if isinstance(org, ledger.Org):
                held[id(org)] = org
        frame = frame.f_back
    return list(held.values())


@unittest.skipUnless(f.ADMIN, "disposable PostgreSQL required: NOT RUN")
class RunningTurn(_Lazy):

    def setUp(self):
        super().setUp()
        self.dir = Path(f.data) / "turns" / self.slug
        self.dir.mkdir(parents=True, exist_ok=True)
        self.script = self.dir / "child.py"
        self.script.write_text(_CHILD, encoding="utf-8")
        self.flag = str(self.dir / "turn")
        Path(sup.scratch_dir(self.slug, self.nid)).mkdir(parents=True, exist_ok=True)
        self.st = sup.state(self.slug, self.nid)
        self.st["busy"] = True
        self.procs = []
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.addCleanup(self.release)
        e = stack.enter_context
        e(patch.object(sup, "spawn_env", return_value={
            k: v for k, v in os.environ.items()
            if k.upper() in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")}))
        e(patch.object(sup, "_leash"))
        e(patch.object(sup, "_mcp_infrastructure_fingerprint", return_value="fixture"))
        e(patch.object(sup, "_record_prompt_view"))
        e(patch.object(sup, "cli_diagnosis", return_value=None))
        e(patch.object(sup, "notify"))
        e(patch.object(warmpool, "poke"))
        e(patch.object(warmpool, "warm_decision", return_value=(False, False)))
        e(patch.object(warmpool, "eligible", return_value=(False, "fixture")))
        e(patch.object(sup.appsettings, "wait_for_mcp_tools_enabled", return_value=False))
        e(patch("orgtree.transcript_ingest.capture_safely"))
        e(patch.object(sup, "_build_cmd", side_effect=lambda *a, **k: [
            sys.executable, str(self.script), self.flag]))
        popen = subprocess.Popen

        def spawn(*args, **kwargs):
            p = popen(*args, **kwargs)
            if kwargs.get("stdin") == subprocess.PIPE:
                self.procs.append(p)
            return p
        e(patch.object(subprocess, "Popen", side_effect=spawn))

    def release(self):
        Path(self.flag + ".release").touch()
        for proc in self.procs:
            try:
                proc.wait(timeout=10)
            except Exception:                                # noqa: BLE001
                proc.kill()
                proc.wait(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def run_blocked_turn(self, seconds):
        """Start a real turn, wait for the CLI to block, then sample the turn
        thread's Orgs for `seconds`: the largest decoded-row count seen, the
        most distinct Orgs, and the sample count."""
        store.LAZY_ROWS_FALLBACKS.clear()
        thread = threading.Thread(target=lambda: sup._run_turn(self.slug, self.nid, "hello"),
                                  daemon=True)
        thread.start()
        deadline = time.time() + 60
        while not os.path.exists(self.flag + ".blocked"):
            self.assertTrue(thread.is_alive(), "the turn ended before the CLI blocked")
            self.assertLess(time.time(), deadline, "the fake CLI never got its prompt")
            time.sleep(0.05)
        worst_rows, worst_orgs, samples = 0, 0, 0
        end = time.time() + seconds
        while True:
            orgs = orgs_held_by(thread)
            self.assertTrue(orgs, "the frame walk found no Org; the sample proves nothing")
            worst_rows = max(worst_rows, max(decoded(o) for o in orgs))
            worst_orgs = max(worst_orgs, len(orgs))
            samples += 1
            if time.time() >= end:
                break
            time.sleep(min(2.0, max(0.2, seconds / 30)))
        Path(self.flag + ".release").touch()
        thread.join(60)
        self.assertFalse(thread.is_alive(), "the turn runner must settle")
        return worst_rows, worst_orgs, samples

    def test_a_running_turn_keeps_its_copy_row_sparse(self):
        rows, orgs, samples = self.run_blocked_turn(LONG_S)
        print(f"\n[turn-org-state] blocked {LONG_S:.0f} s, {samples} samples: "
              f"max decoded node rows {rows} of {N_NODES + 1}, max Orgs {orgs}",
              file=sys.stderr)
        self.assertLessEqual(orgs, 1, f"the turn holds {orgs} Org copies")
        self.assertLessEqual(rows, 5, f"the running turn's copy decoded {rows} node rows; "
                             f"walks: {list(store.LAZY_ROWS_FALLBACKS)}")

    def test_control_the_old_path_decodes_every_row(self):
        with patch.object(sup, "ORG_STATE_SHARED", False):
            rows, _orgs, _samples = self.run_blocked_turn(0.5)
        self.assertGreater(rows, N_NODES,
                           "the old path did not decode the table: this measurement cannot "
                           "tell the fix from its absence")


if __name__ == "__main__":
    unittest.main()
