"""One agent tool call parses the org document once, and the gates it parses
for still see the write that landed a microsecond ago.

THE PROBLEM THESE PIN. A single `orgtree_*` call used to parse the WHOLE org
document three times before the verb did any work: once to authenticate the
seat (`api._agent_identity`), once for the halt/killswitch gate
(`halt.blocked`), and once for the verb itself. `orgtree_send_notice` did it
six times. On the live org that is 56-75 ms per parse and 210-550 ms per call
(measured 2026-09-18, `toolcalls/out/load-sites-orgtree.json`), and it is
serial, so it is also the aggregate throughput ceiling for the whole fleet.

THE FIX, AND WHAT COULD GO WRONG WITH IT. The two gates now read
`store.cached_org` -- the shared, `org_seq`-guarded snapshot the streaming path
has used since `aba2439` -- and so do the read-shaped verbs. That buys the
saving only if two things are true, and every test below exists because one of
them could silently stop being true:

  * THE SNAPSHOT IS NEVER STALE. It is invalidated by `org_seq`, which every
    save bumps, not by a clock. A gate that answered from before a halt, a
    killswitch or a retirement would be a security hole that no latency number
    would reveal. `test_gate_sees_*` and `test_read_verb_sees_*` are that check.
  * NOTHING MUTATES IT. The snapshot is shared with every reader in the
    process; a read path that stamped one field onto it would corrupt what
    every other reader sees, and would leave no trace on disk.
    `test_read_paths_leave_the_shared_snapshot_identical_to_disk` is that check.

AND THE WRITE PATH IS UNCHANGED ON PURPOSE. Write verbs still take their own
private `load_org` under `DOC_LOCK`; a shared or stale document in a
load-modify-save cycle is a lost update, which is far worse than the parse it
would save. `test_concurrent_writes_all_land` demonstrates that rather than
arguing it.

⚠ THE COUNTING TESTS ARE THE ACCEPTANCE EVIDENCE and they assert EXACT numbers,
not upper bounds: a bound would still pass if a future change quietly added a
parse back, which is the whole regression this file exists to catch.
"""

import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import traceback
import unittest
import unittest.mock
from types import SimpleNamespace

_root = tempfile.TemporaryDirectory(prefix="v2-toolcall-single-load-")
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name)
os.environ.pop("ORGTREE_AGENT_PARENT_DATA", None)
os.environ.pop("ORGTREE_AGENT_LEGACY_DATA", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException                       # noqa: E402

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, halt, ledger, store            # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class _LoadCounter:
    """Counts every real whole-document parse, including the ones `cached_org`
    makes on a miss -- `store.cached_org` reaches `load_org` as a module
    global, so one patch sees both the direct calls and the cached ones.

    ⚠ It also COUNTS ITS OWN CALLS, which is why every test resets it at the
    exact moment it starts measuring: a counter that silently included the
    fixture's loads would report a number nobody could reproduce."""

    def __init__(self):
        self.n = 0
        self._real = store.load_org

    def __enter__(self):
        self._patch = unittest.mock.patch.object(store, "load_org", self)
        self._patch.start()
        return self

    def __exit__(self, *exc):
        self._patch.stop()
        return False

    def __call__(self, slug):
        self.n += 1
        return self._real(slug)

    def reset(self):
        self.n = 0
        return self


class ToolCallSingleLoad(unittest.TestCase):

    _seq = 0

    def setUp(self):
        ToolCallSingleLoad._seq += 1
        self.slug = f"toolcall-load-{ToolCallSingleLoad._seq}-{time.time_ns()}"
        o = store.create_org(self.slug)
        self.boss = o.hire(ledger.USER, None, "haiku", 6, "boss")["node"]
        self.worker = o.hire(ledger.USER, self.boss, "haiku", 0,
                             "worker")["node"]
        self.peer = o.hire(ledger.USER, self.boss, "haiku", 0, "peer")["node"]
        self.item = str(o.work_create(
            ledger.USER, "A ticket to read and write",
            "The docket needs an item these tests can read and update. "
            "This is that item.",
            owner=self.worker)["created"])
        store.save_org(o)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------- helpers
    def call(self, tool, args, actor=None):
        request = SimpleNamespace(state=SimpleNamespace())
        return api.agent_call(
            api.AgentCall(org=self.slug, node=actor or self.worker,
                          tool=tool, args=args),
            request)

    def work_list(self, actor=None):
        return self.call("orgtree_work", {"action": "list"}, actor)

    def status(self, summary, actor=None):
        return self.call("orgtree_status",
                         {"status": "working", "summary": summary}, actor)

    def doc_bytes(self, org):
        """A stable serialisation of the EAGER document -- the part a gate
        reads. `eager_sections` deliberately does not materialise the
        append-only logs, so comparing it never changes what it measures."""
        import json
        return json.dumps(store.eager_sections(org.d), sort_keys=True,
                          default=str)

    # -------------------------------------------- the counted acceptance
    def test_read_verb_parses_the_document_zero_times_when_nothing_changed(self):
        """`orgtree_work list` -- authenticate, gate, serve -- used to be
        three whole-document parses. All three now come off one snapshot, and
        while no save has intervened that snapshot costs no parse at all."""
        self.work_list()                      # warm the snapshot
        with _LoadCounter() as c:
            c.reset()
            self.work_list()
            self.assertEqual(c.n, 0, "a warm read verb must not re-parse")

    def test_read_verb_parses_the_document_zero_times_after_a_write(self):
        """This pinned ONE parse when written: the document moved, so the
        snapshot was rebuilt by a full load, shared by all three readers.
        The rearchitecture's Phase A rebuilds it by re-reading only the rows
        the save changed (store._assemble_snapshot), so even the
        after-a-write read owes NO document parse — the refresh is a few KB
        of row reads. Staleness is still impossible by construction: the
        refresh is seq-gated against the save's own published change set,
        and the gate-freshness tests below run against this exact path."""
        self.status("something changed")      # bumps org_seq
        with _LoadCounter() as c:
            c.reset()
            self.work_list()
            self.assertEqual(c.n, 0,
                             "a section-granular refresh must not re-parse "
                             "the document")

    def test_write_verb_parses_the_document_once_not_twice(self):
        """A write verb owes ONE document parse and cannot owe zero (yet).

        This pinned 2 when it was written: one shared gate parse (the
        previous call's save invalidated the snapshot) plus one private
        write parse under `DOC_LOCK`. The state-access rearchitecture's
        Phase A made the first half disappear as a PARSE: an invalidated
        snapshot now REFRESHES section-granularly, re-reading only the rows
        the save changed (store._assemble_snapshot), so the gates cost a
        few KB instead of a document load — and the freshness they must
        keep is pinned by `test_gates_answer_from_the_last_save_*`, which
        runs against the refresh path now. The private write parse remains
        until the dispatch cycle is converted to `store.write_org`; when
        that lands, this pin moves to 0 on a warm resident and this
        docstring moves with it."""
        self.status("first")
        with _LoadCounter() as c:
            c.reset()
            self.status("second")
            self.assertEqual(c.n, 1,
                             "gate refresh is row-reads, not a parse; only "
                             "the private write parse remains")

    def test_write_verb_gates_are_free_after_a_read(self):
        """The same write verb, reached from a warm snapshot: the gates cost
        nothing and only the private write parse remains."""
        self.status("first")
        self.work_list()                      # warms the snapshot after the save
        with _LoadCounter() as c:
            c.reset()
            self.status("second")
            self.assertEqual(c.n, 1, "only the private write parse remains")

    def test_chart_parses_the_document_zero_times_when_nothing_changed(self):
        """`orgtree_chart` is the OTHER read-shaped door -- `read_transcript`,
        `read_scratch`, `send_file` and `list_tiers` come through the same
        block -- and it needs its own count: a mutation that put only this
        branch back to a private parse survived the `orgtree_work` counts."""
        self.call("orgtree_chart", {})         # warm the snapshot
        with _LoadCounter() as c:
            c.reset()
            self.call("orgtree_chart", {})
            self.assertEqual(c.n, 0, "a warm chart must not re-parse")

    def test_gates_answer_from_the_last_save_not_from_a_remembered_document(self):
        """THE STALENESS CONTROL, aimed at `store.cached_org` itself rather
        than at any caller.

        The snapshot is kept fresh by TWO independent mechanisms -- `org_seq`
        is compared on every read, and `_bump_org_seq` drops the entry on every
        save -- so removing either one alone still leaves a correct answer.
        This asserts the result they exist to produce, by writing straight to
        the store (no tool call, so no gate has a chance to reload for its own
        reasons) and then asking the gates. If BOTH guards were ever removed,
        every assertion here fails and the security tests above stop meaning
        anything."""
        self.work_list()                       # warm
        warm = store.cached_org(self.slug)
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node(self.peer)["title"] = "a title only a fresh read sees"
            store.save_org(org)
        after = store.cached_org(self.slug)
        self.assertIsNot(after, warm, "the save must have replaced the share")
        self.assertEqual(after.nodes[self.peer].get("title"),
                         "a title only a fresh read sees")
        self.assertEqual(self.doc_bytes(after),
                         self.doc_bytes(store.load_org(self.slug)))

    def test_no_write_path_ever_saves_the_shared_snapshot(self):
        """THE INVARIANT THE WHOLE CHANGE RESTS ON, asserted directly.

        `store.cached_org` hands back an object shared with every reader in the
        process. Saving one is not merely a style violation: the writer's
        mutations become visible to readers before the save, and the save
        itself runs against a document whose lazy-section baselines belong to
        somebody else. So this wraps `store.save_org` and refuses any org
        carrying `_shared_snapshot`, then drives every write door this change
        touched -- including `_agent_identity`'s legacy `seat_id` mint, which
        is the one branch of the READ path that writes and which no other test
        here reaches."""
        saved_shared = []
        real_save = store.save_org

        def guard(org):
            if getattr(org, "_shared_snapshot", False):
                saved_shared.append("".join(traceback.format_stack()[-6:-1]))
            return real_save(org)

        # strip the seat_id so the durable mint branch actually fires
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node(self.worker).pop("seat_id", None)
            real_save(org)
        self.work_list()                       # warm the shared snapshot

        with unittest.mock.patch.object(store, "save_org", guard):
            self.status("a write through the ordinary door")
            self.call("orgtree_work", {"action": "evidence", "slug": self.item,
                                       "kind": "note", "ref": "a-ref",
                                       "note": "a note"})
            minted = api._agent_identity(
                api.AgentCall(org=self.slug, node=self.worker,
                              tool="orgtree_send_file", args={}),
                SimpleNamespace(state=SimpleNamespace()), durable=True)

        self.assertEqual(saved_shared, [],
                         "a write path saved the shared snapshot")
        # the control: the mint branch really ran, so this test proves
        # something about it rather than about a branch it never reached
        self.assertTrue(minted.get("seat_id"), "the seat_id mint did not run")
        self.assertEqual(
            store.load_org(self.slug).node(self.worker).get("seat_id"),
            minted["seat_id"], "the minted seat_id was not persisted")

    # ------------------------------------------------- the gates are fresh
    def test_gate_sees_a_halt_latched_since_the_previous_call(self):
        self.work_list()                      # warm the snapshot
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node(self.worker)["halt"] = {"at": ledger.now(), "by": "user"}
            store.save_org(org)
        self.assertEqual(halt.blocked(self.slug, self.worker), "halt")
        with self.assertRaises(HTTPException) as caught:
            self.work_list()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("halted", str(caught.exception.detail))

    def test_gate_sees_a_killswitch_latched_since_the_previous_call(self):
        self.work_list()
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.d["killswitch"] = {"at": ledger.now(), "by": "user"}
            store.save_org(org)
        self.assertEqual(halt.blocked(self.slug, self.worker), "killswitch")
        self.assertIsNotNone(halt.org_killswitch(self.slug))
        with self.assertRaises(HTTPException) as caught:
            self.work_list()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("killswitch", str(caught.exception.detail))

    def test_identity_gate_sees_a_seat_archived_since_the_previous_call(self):
        """The authentication read is the one that must never go stale: a
        retired seat that could still call tools is a security defect, and a
        cache with any window at all would produce exactly that."""
        self.work_list()
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.retire(ledger.USER, self.worker)
            store.save_org(org)
        with self.assertRaises(HTTPException) as caught:
            self.work_list()
        self.assertEqual(caught.exception.status_code, 403)

    def test_read_verb_sees_a_write_made_by_the_previous_call(self):
        """End to end through the real dispatch, with no direct store access:
        a write verb lands, and the very next read verb reports it."""
        self.status("the summary the next read must see")
        chart = self.call("orgtree_chart", {})["chart"]
        self.assertIn("the summary the next read must see", chart)

    def test_read_verb_sees_a_docket_write_made_by_the_previous_call(self):
        self.work_list()                      # warm
        self.call("orgtree_work", {"action": "update", "slug": self.item,
                                   "done_so_far": ["a line only a fresh read sees"],
                                   "working_on_next": []})
        got = self.call("orgtree_work", {"action": "get", "slug": self.item})
        self.assertEqual(got["item"]["done_so_far"],
                         ["a line only a fresh read sees"])

    # ---------------------------------- the snapshot is never written to
    def test_read_paths_leave_the_shared_snapshot_identical_to_disk(self):
        """THE CONTROL FOR THE WHOLE CHANGE. A read path that stamped a field
        onto the shared object would corrupt every other reader in the process
        and leave nothing on disk to find it by. So after each read verb the
        shared snapshot is compared, field for field, against a fresh parse of
        what is actually stored."""
        for tool, args in (("orgtree_work", {"action": "list"}),
                           ("orgtree_work", {"action": "get",
                                             "slug": self.item}),
                           ("orgtree_chart", {}),
                           ("orgtree_chart", {"include_archived": True})):
            with self.subTest(tool=tool, args=args):
                before = store.org_seq(self.slug)
                self.call(tool, args)
                self.assertEqual(store.org_seq(self.slug), before,
                                 f"{tool} is not a read: it saved")
                shared = store.cached_org(self.slug)
                fresh = store.load_org(self.slug)
                self.assertEqual(self.doc_bytes(shared), self.doc_bytes(fresh),
                                 f"{tool} mutated the shared snapshot")

    def test_the_gates_do_not_mutate_the_shared_snapshot(self):
        """Same control, aimed at the two gates every call pays for --
        including on the refusal paths, where a mutation would be easiest to
        miss because the call raises before anything else looks at the doc."""
        self.work_list()
        for nid in (self.worker, "no-such-node"):
            with self.subTest(node=nid):
                halt.blocked(self.slug, nid)
                halt.requested(self.slug, nid)
                halt.org_killswitch(self.slug)
                shared = store.cached_org(self.slug)
                fresh = store.load_org(self.slug)
                self.assertEqual(self.doc_bytes(shared), self.doc_bytes(fresh))

    # ------------------------------------------------------ no lost update
    def test_concurrent_writes_all_land(self):
        """DEMONSTRATED, NOT ARGUED. Eight threads each drive one real write
        verb through `api.agent_call` at the same time. Every one of them is a
        load-modify-save cycle on the same document, so if any of them read a
        shared or stale copy its neighbour's row would vanish.

        `evidence` is the verb because it APPENDS: `update` replaces the
        progress lists, so a lost update there would be invisible in the final
        item. Appending makes the assertion exact -- eight calls, eight
        evidence rows, eight distinct notes, and the item's `rev` advanced by
        eight, because `rev` counts committed mutations.

        THE CONTROL IS THE COMPLETION COUNT. If the calls had raised instead of
        racing, the rows would also fail to appear, and a test that checked
        only the rows would read that as the same pass."""
        n = 8
        start = threading.Barrier(n)
        done, errors = [], []

        with store.DOC_LOCK:
            before = store.load_org(self.slug).work_get(self.worker, self.item)
            rev0 = int(before["rev"])
            ev0 = len(before.get("evidence") or [])

        def one(i):
            try:
                start.wait(timeout=30)
                self.call("orgtree_work",
                          {"action": "evidence", "slug": self.item,
                           "kind": "note", "ref": f"writer-{i}",
                           "note": f"writer {i} was here"})
                done.append(i)
            except BaseException as exc:                       # noqa: BLE001
                errors.append(f"{i}: {type(exc).__name__}: {exc}")

        threads = [threading.Thread(target=one, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)

        self.assertEqual(errors, [], "concurrent write verbs must not fail")
        self.assertEqual(len(done), n, "the control: every call completed")
        with store.DOC_LOCK:
            item = store.load_org(self.slug).work_get(self.worker, self.item)
        rows = item.get("evidence") or []
        self.assertEqual(len(rows) - ev0, n,
                         "one evidence row per call -- a lost update would "
                         "leave fewer")
        self.assertEqual(int(item["rev"]) - rev0, n,
                         "one committed revision per call")
        refs = {str(r.get("ref") or "") for r in rows}
        for i in range(n):
            self.assertIn(f"writer-{i}", refs,
                          "every writer's own row survived")


if __name__ == "__main__":
    unittest.main()
