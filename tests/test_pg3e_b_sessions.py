"""PG-3e-B: the supervisor's session / remote-control / account-switch leaf
writers run on `orgtx.org_tx` row transactions and never wait on DOC_LOCK.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * each converted writer still does its job (the field lands or is popped);
  * each one COMPLETES while another thread holds DOC_LOCK — the §3 rule
    "org_tx never waits on DOC_LOCK". A negative control shows the harness
    does detect a writer that still takes DOC_LOCK, so a pass is not vacuous;
  * each one locks only its own node row: a transaction holding ANOTHER node
    does not delay it, one holding the SAME node does;
  * `remote_reap`, which runs from a save hook INSIDE every save (and so
    inside an org_tx commit), no longer takes DOC_LOCK there, and still reaps
    a server whose seat is no longer flagged.

Run:  python tools/run-python-verification.py tests/test_pg3e_b_sessions.py
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-pg3e-b-")
os.environ["ORGTREE_DATA"] = _ROOT
os.environ["ORGTREE_STORE"] = "sqlite"

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import ledger, orgtx, store, supervisor  # noqa: E402
if not str(store.DATA_ROOT).lower().startswith(_ROOT.lower()):
    raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")

WAIT_S = 5.0
_seq = [0]


def _slug(prefix: str) -> str:
    _seq[0] += 1
    return f"{prefix}-{_seq[0]}"


def _org(slug: str) -> str:
    org = ledger.Org.create(slug)
    org.hire(ledger.USER, None, "opus", 0, "worker")
    org.hire(ledger.USER, None, "opus", 0, "other")
    store.save_org(org)
    return slug


def _node(slug: str, nid: str) -> dict:
    return store.load_org(slug).node(nid)


def _set(slug: str, nid: str, **fields) -> None:
    with orgtx.org_tx(slug, nodes=[nid]) as tx:
        tx.org.node(nid).update(fields)


class _Holder:
    """Holds a lock in a background thread until released."""

    def __init__(self, enter) -> None:
        self._enter = enter
        self._held = threading.Event()
        self._release = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        with self._enter():
            self._held.set()
            self._release.wait(30)

    def __enter__(self):
        self._t.start()
        assert self._held.wait(WAIT_S), "holder never acquired its lock"
        return self

    def __exit__(self, *exc):
        self._release.set()
        self._t.join(WAIT_S)


def _finishes(fn, timeout: float = WAIT_S) -> tuple[bool, list]:
    """Run fn in a thread; (finished within timeout, [result or exception])."""
    out: list = []

    def run():
        try:
            out.append(fn())
        except BaseException as e:            # noqa: BLE001
            out.append(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    return (not t.is_alive()), out


class NeverWaitsOnDocLock(unittest.TestCase):
    """Every converted writer completes while DOC_LOCK is held elsewhere."""

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("b"))

    def _assert_free_of_doc_lock(self, fn):
        with _Holder(lambda: store.DOC_LOCK):
            done, out = _finishes(fn)
        self.assertTrue(done, "the writer waited on DOC_LOCK")
        if out and isinstance(out[0], BaseException):
            raise out[0]
        return out[0] if out else None

    def test_negative_control_detects_a_doc_lock_writer(self) -> None:
        # the harness must be able to FAIL: a body that still takes DOC_LOCK
        # has to be reported as blocked, or every pass below means nothing
        def legacy():
            with store.DOC_LOCK:
                return True
        with _Holder(lambda: store.DOC_LOCK):
            done, _ = _finishes(legacy, timeout=0.5)
        self.assertFalse(done, "negative control: a DOC_LOCK writer was not "
                               "detected as blocked")

    def test_retire_breadcrumb_splice(self) -> None:
        _set(self.slug, "worker", cheap_compacted={"at": "x"})
        self._assert_free_of_doc_lock(
            lambda: supervisor._retire_breadcrumb_splice(self.slug, "worker"))
        self.assertNotIn("cheap_compacted", _node(self.slug, "worker"))

    def test_codex_route_persist(self) -> None:
        self._assert_free_of_doc_lock(
            lambda: supervisor._codex_route_persist(
                self.slug, "worker", {"route": "reserve", "live": 1},
                mark=("pool-a", {"at": "t"})))
        n = _node(self.slug, "worker")
        self.assertEqual(n["codex_route_last"], {"route": "reserve"})
        self.assertEqual(n["codex_routes"], {"pool-a": {"at": "t"}})
        supervisor._codex_route_persist(self.slug, "worker", {"route": "main"},
                                        clear_mark="pool-a")
        n = _node(self.slug, "worker")
        self.assertEqual(n["codex_route_last"], {"route": "main"})
        self.assertNotIn("codex_routes", n)

    def test_record_codex_native_home(self) -> None:
        _set(self.slug, "worker", desktop_import={"v": 1})
        org = store.load_org(self.slug)
        self._assert_free_of_doc_lock(
            lambda: supervisor._record_codex_native_home(
                org, "worker", {"codex_home": "C:/h"}))
        self.assertEqual(_node(self.slug, "worker")["codex_native_home"], "C:/h")

    def test_record_codex_native_home_refuses_a_changed_identity(self) -> None:
        _set(self.slug, "worker", desktop_import={"v": 1})
        stale = store.load_org(self.slug)
        _set(self.slug, "worker", session_id="moved-on")
        with self.assertRaises(ledger.LedgerError):
            supervisor._record_codex_native_home(
                stale, "worker", {"codex_home": "C:/h"})
        self.assertNotIn("codex_native_home", _node(self.slug, "worker"))

    def test_remote_unpark(self) -> None:
        _set(self.slug, "worker", remote_controlled={"at": "x"})
        self._assert_free_of_doc_lock(
            lambda: supervisor._remote_unpark(self.slug, "worker"))
        self.assertNotIn("remote_controlled", _node(self.slug, "worker"))

    def test_remote_control_stop(self) -> None:
        _set(self.slug, "worker", remote_controlled={"at": "x"})
        with patch.object(supervisor, "spend_unrun_pardon") as pardon, \
                patch.object(supervisor, "notify"), \
                patch.object(supervisor, "send_message") as send:
            r = self._assert_free_of_doc_lock(
                lambda: supervisor.remote_control_stop(self.slug, "worker"))
        self.assertEqual(r, {"ok": True})
        self.assertNotIn("remote_controlled", _node(self.slug, "worker"))
        pardon.assert_called_once()
        send.assert_not_called()                  # the mailbox was empty

    def test_drive_unfrozen_by_switch(self) -> None:
        _set(self.slug, "worker",
             switch_resume={"texts": ["finish it"], "views": ["finish (v)"]})
        with patch.object(supervisor, "send_message") as send:
            self._assert_free_of_doc_lock(
                lambda: supervisor.drive_unfrozen_by_switch(self.slug, ["worker"]))
        self.assertNotIn("switch_resume", _node(self.slug, "worker"))
        self.assertEqual([c.args[2] for c in send.call_args_list],
                         [supervisor.UNFROZEN_BY_SWITCH_TEXT, "finish it"])


    def test_log_escalation_to_org(self) -> None:
        self._assert_free_of_doc_lock(
            lambda: supervisor._log_escalation_to_org(
                {"by_org": self.slug, "by_node": "worker"},
                {"cut": ["other"], "not_settled": []}, ["worker"], "deploy"))
        evs = [e for e in store.load_org(self.slug).d["events"]
               if e.get("op") == "self_restart_forced"]
        self.assertEqual(len(evs), 1, "the forced-restart event did not land")

    def test_announce_missing_rebind_candidates(self) -> None:
        _set(self.slug, "worker", account="missing:claude")
        with patch.object(store, "list_orgs", return_value=[{"slug": self.slug}]),                 patch.object(supervisor, "send_message") as send:
            n = self._assert_free_of_doc_lock(
                lambda: supervisor.announce_missing_rebind_candidates(
                    "claude", "acct-2"))
        self.assertEqual(n, 1)
        send.assert_not_called()          # top-level: the user is told
        notes = [m for m in store.load_org(self.slug).d.get("user_mail_log") or []
                 if "acct-2" in str(m.get("body"))]
        self.assertEqual(len(notes), 1, "the user notice did not land")


    def _start(self):
        class P:
            pid, returncode = 4242, None

            def poll(self):
                return None

            def terminate(self):
                pass
        with patch.object(supervisor.subprocess, "Popen", return_value=P()),                 patch.object(supervisor.time, "sleep"),                 patch.object(supervisor, "_leash"),                 patch.object(supervisor, "_claude_argv", return_value=["claude"]),                 patch.object(supervisor, "notify"),                 patch.object(supervisor.halt, "check"):
            # `__wrapped__`: the body only. Its `@halt.worker` prologue and
            # epilogue still take DOC_LOCK around (never across) the body —
            # that registration is halt.py's, PG-3a's to convert.
            return self._assert_free_of_doc_lock(
                lambda: supervisor._remote_control_start_owned.__wrapped__(
                    self.slug, "worker"))

    def test_remote_control_start_parks_then_records_pid(self) -> None:
        try:
            r = self._start()
        finally:
            supervisor._remote_procs.pop((self.slug, "worker"), None)
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(_node(self.slug, "worker")["remote_controlled"]["pid"], 4242)

    def test_remote_control_start_refuses_under_a_latched_killswitch(self) -> None:
        with orgtx.org_tx(self.slug, sections=["killswitch"]) as tx:
            tx.d["killswitch"] = {"on": True, "at": "x"}
        r = self._start()
        self.assertIn("killswitch", r.get("error", ""))
        self.assertNotIn("remote_controlled", _node(self.slug, "worker"))


class CompactionSplit(unittest.TestCase):
    """The claude compaction split writes its bearer row, the successor's new
    session and the fork's cost in ONE org_tx that locks `nid` and `nid@gen`,
    with DOC_LOCK held elsewhere the whole time."""

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("cmp"))
        self.old = _node(self.slug, "worker")["session_id"]
        self.during = None                      # runs while the "fork" is in flight

    def _fork(self, new_sid="fork-1", cost=0.5):
        test = self

        class Proc:
            returncode = 0

            def communicate(self, input=None, timeout=None):
                if test.during is not None:
                    test.during()
                return (json.dumps({"session_id": new_sid,
                                    "total_cost_usd": cost}), "")

            def kill(self):
                pass
        with patch.object(supervisor.subprocess, "Popen", return_value=Proc()),                 patch.object(supervisor, "_claude_fork_context",
                             return_value=(self.old, {})),                 patch.object(supervisor, "_claude_argv", return_value=["claude"]),                 patch.object(supervisor, "_leash"),                 patch.object(supervisor, "_copy_prompt_views"),                 patch.object(supervisor, "occupancy_of", return_value=(12345, False)),                 patch.object(supervisor, "notify"),                 patch.object(supervisor.halt, "check"):
            with _Holder(lambda: store.DOC_LOCK):
                done, out = _finishes(
                    lambda: supervisor._compact_split_body(self.slug, "worker"))
        self.assertTrue(done, "the compaction write waited on DOC_LOCK")
        if out and isinstance(out[0], BaseException):
            raise out[0]
        self.assertIsNone(supervisor.state(self.slug, "worker").get("last_error"),
                          supervisor.state(self.slug, "worker").get("last_error"))

    def test_split_lands_whole(self) -> None:
        self._fork()
        org = store.load_org(self.slug)
        n = org.node("worker")
        self.assertEqual(n["session_id"], "fork-1")
        self.assertEqual(n["generation"], 1)
        self.assertEqual(n["predecessor"], "worker@0")
        self.assertEqual(n["occupancy"], 12345)
        self.assertTrue(n["compacted_unrun"])
        self.assertAlmostEqual(n["cost_usd"], 0.5)
        bearer = org.node("worker@0")
        self.assertEqual(bearer["state"], "archived")
        self.assertEqual(bearer["session_id"], self.old)
        self.assertTrue(any(e.get("op") == "compact_split" for e in org.d["events"]))

    def test_session_replaced_mid_fork_banks_cost_and_abandons(self) -> None:
        self.during = lambda: _set(self.slug, "worker", session_id="reseeded")
        self._fork()
        org = store.load_org(self.slug)
        self.assertEqual(org.node("worker")["session_id"], "reseeded")
        self.assertNotIn("worker@0", org.nodes)
        self.assertAlmostEqual(org.node("worker")["cost_usd"], 0.5)

    def test_generation_moved_mid_fork_relocks_the_right_bearer_row(self) -> None:
        # a CLI-side compaction bumps the generation WITHOUT changing the
        # session id, so the split still applies — but its bearer is now
        # worker@1, a row the first lock set did not name. The lineage tx has
        # to notice and lock the right row, not fail with UnlockedWrite.
        def bump():
            with orgtx.org_tx(self.slug, nodes=["worker", "worker@0"],
                              logs=["events", "notice_log"],
                              sections=["notices"]) as tx:
                tx.org.record_cli_compaction("worker")
        calls = []
        real_read = orgtx.org_read

        def read(slug, **kw):
            calls.append(1)
            got = real_read(slug, **kw)
            if len(calls) == 2:          # #1 is the pre-fork snapshot
                bump()                   # moves AFTER the read, before the lock
            return got
        with patch.object(orgtx, "org_read", side_effect=read):
            self._fork()
        org = store.load_org(self.slug)
        n = org.node("worker")
        self.assertEqual(n["session_id"], "fork-1")
        self.assertEqual(n["predecessor"], "worker@1")
        self.assertIn("worker@1", org.nodes)
        self.assertGreaterEqual(len(calls), 3, "the lock set was never recomputed")

    def test_node_deleted_mid_fork_banks_to_deleted_cost(self) -> None:
        def drop():
            with orgtx.org_tx(self.slug, nodes=["worker"]) as tx:
                del tx.org.d["nodes"]["worker"]
        self.during = drop
        self._fork()
        org = store.load_org(self.slug)
        self.assertNotIn("worker", org.nodes)
        self.assertAlmostEqual(float(org.d.get("deleted_cost_usd") or 0), 0.5)


class LineageRepairs(unittest.TestCase):
    """drop_phantom_generation / recover_lost_generation on org_tx."""

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("lin"))
        sid = _node(self.slug, "worker")["session_id"]
        with orgtx.org_tx(self.slug, nodes=["worker", "worker@0", "worker@1"]) as tx:
            nodes = tx.d["nodes"]
            base = dict(nodes["worker"])
            nodes["worker@0"] = {**base, "id": "worker@0", "state": "archived",
                                 "bearer_state": "lost", "successor": "worker",
                                 "predecessor": None, "session_id": sid,
                                 "generation": 0, "cli_boundary_offset": 5,
                                 "grant": 0}
            nodes["worker@1"] = {**base, "id": "worker@1", "state": "archived",
                                 "bearer_state": "knowledge",
                                 "successor": "worker", "predecessor": "worker@0",
                                 "session_id": "s-1", "generation": 1, "grant": 0}
            nodes["worker"]["predecessor"] = "worker@1"
            nodes["worker"]["generation"] = 2

    def _run(self, fn):
        with _Holder(lambda: store.DOC_LOCK):
            done, out = _finishes(fn)
        self.assertTrue(done, "the lineage repair waited on DOC_LOCK")
        if out and isinstance(out[0], BaseException):
            raise out[0]
        return out[0]

    def test_drop_phantom_relinks_every_pointer_and_removes_the_row(self) -> None:
        with patch.object(supervisor, "_phantom_evidence",
                          return_value={"phantom": True, "why": "dup"}),                 patch.object(supervisor, "notify"):
            out = self._run(lambda: supervisor.drop_phantom_generation(
                self.slug, "worker@0"))
        self.assertEqual(out["dropped"], "worker@0")
        org = store.load_org(self.slug)
        self.assertNotIn("worker@0", org.nodes)
        self.assertIsNone(org.node("worker@1")["predecessor"])
        self.assertTrue(any(e.get("op") == "drop_phantom_generation"
                            for e in org.d["events"]))

    def test_drop_phantom_refuses_unproven_and_writes_nothing(self) -> None:
        with patch.object(supervisor, "_phantom_evidence",
                          return_value={"phantom": False, "why": "unique"}),                 patch.object(supervisor, "notify"):
            with self.assertRaises(ledger.LedgerError):
                supervisor.drop_phantom_generation(self.slug, "worker@0")
        self.assertIn("worker@0", store.load_org(self.slug).nodes)

    def test_recover_lost_generation_records_the_cut(self) -> None:
        with patch.object(supervisor, "_phantom_evidence",
                          return_value={"phantom": False}),                 patch.object(supervisor, "_session_sharers", return_value=["worker"]),                 patch.object(supervisor, "_count_cli_compactions",
                             return_value=(1, 0, [(5, None)])),                 patch.object(supervisor, "_fork_bearer_session", return_value="cut-1"),                 patch.object(supervisor, "_discard_cut") as discard,                 patch.object(supervisor, "notify"):
            out = self._run(lambda: supervisor.recover_lost_generation(
                self.slug, "worker@0"))
        self.assertEqual(out["session_id"], "cut-1")
        n = _node(self.slug, "worker@0")
        self.assertEqual(n["bearer_state"], "knowledge")
        self.assertEqual(n["session_id"], "cut-1")
        discard.assert_not_called()

    def test_recover_discards_the_cut_when_the_row_moved(self) -> None:
        def cut(*_a):
            _set(self.slug, "worker@0", cli_boundary_offset=9)
            return "cut-2"
        with patch.object(supervisor, "_phantom_evidence",
                          return_value={"phantom": False}),                 patch.object(supervisor, "_session_sharers", return_value=["worker"]),                 patch.object(supervisor, "_count_cli_compactions",
                             return_value=(1, 0, [(5, None)])),                 patch.object(supervisor, "_fork_bearer_session", side_effect=cut),                 patch.object(supervisor, "_discard_cut") as discard,                 patch.object(supervisor, "notify"):
            with self.assertRaises(ledger.LedgerError):
                supervisor.recover_lost_generation(self.slug, "worker@0")
        discard.assert_called_once()
        self.assertEqual(_node(self.slug, "worker@0")["bearer_state"], "lost")


class WorkingCacheKeepalive(unittest.TestCase):
    """_working_cache_read: a lock-free decision snapshot, then the cost and
    freshness bank in one org_tx on the node."""

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("ka"))

    def test_keepalive_banks_cost_and_freshness_without_doc_lock(self) -> None:
        class Proc:
            returncode = 0

            def communicate(self, input=None, timeout=None):
                return ("{}", "")
        sup = supervisor
        with patch.object(sup.appsettings, "working_checkups_enabled", return_value=False),                 patch.object(sup, "_working_cache_due", return_value=True),                 patch.object(sup, "_working_cache_retry_due", return_value=True),                 patch.object(sup, "spawn_env", return_value={}),                 patch.object(sup, "spawn_argv", return_value=["claude"]),                 patch.object(sup, "_working_cache_cmd", return_value=[]),                 patch.object(sup, "_cache_snapshot", return_value={}),                 patch.object(sup, "_cache_persistable", return_value=None),                 patch.object(sup, "served_metered_row", return_value=None),                 patch.object(sup, "bills_the_key", return_value=False),                 patch.object(sup, "_leash"),                 patch.object(sup.subprocess, "Popen", return_value=Proc()),                 patch.object(sup, "_working_cache_result",
                             return_value={"total_cost_usd": 0.25}),                 patch.object(sup, "_working_cache_fork_id", return_value="fork-ka"),                 patch.object(sup, "_cache_refresh_receipt", return_value=None):
            with _Holder(lambda: store.DOC_LOCK):
                done, out = _finishes(lambda: sup._working_cache_read(self.slug, "worker"))
        self.assertTrue(done, "the keepalive waited on DOC_LOCK")
        self.assertFalse(out and isinstance(out[0], BaseException), out)
        n = _node(self.slug, "worker")
        self.assertAlmostEqual(float(n.get("cost_usd") or 0), 0.25)
        self.assertTrue(n.get("cache_keepalive_at"), "freshness was not recorded")


class LocksOnlyItsOwnNode(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("rows"))
        _set(self.slug, "worker", cheap_compacted={"at": "x"})

    def test_another_nodes_lock_does_not_delay_it(self) -> None:
        with _Holder(lambda: orgtx.org_tx(self.slug, nodes=["other"])):
            done, _ = _finishes(
                lambda: supervisor._retire_breadcrumb_splice(self.slug, "worker"))
        self.assertTrue(done)
        self.assertNotIn("cheap_compacted", _node(self.slug, "worker"))

    def test_the_same_nodes_lock_does(self) -> None:
        with _Holder(lambda: orgtx.org_tx(self.slug, nodes=["worker"])):
            done, _ = _finishes(
                lambda: supervisor._retire_breadcrumb_splice(self.slug, "worker"),
                timeout=0.5)
            self.assertFalse(done, "a FOR UPDATE on the same node must block it")
        # released: the waiting writer now lands
        for _ in range(50):
            if "cheap_compacted" not in _node(self.slug, "worker"):
                break
            threading.Event().wait(0.1)
        self.assertNotIn("cheap_compacted", _node(self.slug, "worker"))


class RemoteReapInsideASave(unittest.TestCase):
    class _Proc:
        def __init__(self) -> None:
            self.terminated = False

        def terminate(self) -> None:
            self.terminated = True

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _org(_slug("reap"))
        _set(self.slug, "worker", remote_controlled={"at": "x"})
        self.kept, self.gone = self._Proc(), self._Proc()
        supervisor._remote_procs[(self.slug, "worker")] = self.kept
        supervisor._remote_procs[(self.slug, "other")] = self.gone

    def tearDown(self) -> None:
        for k in [k for k in supervisor._remote_procs if k[0] == self.slug]:
            supervisor._remote_procs.pop(k, None)

    def test_an_org_tx_commit_reaps_without_doc_lock(self) -> None:
        # the save hook fires inside the org_tx's save_org; with DOC_LOCK held
        # elsewhere the old reap would have hung this commit
        def commit():
            with orgtx.org_tx(self.slug, nodes=["other"]) as tx:
                tx.org.node("other")["note"] = "touched"
        with _Holder(lambda: store.DOC_LOCK):
            done, out = _finishes(commit)
        self.assertTrue(done, "an org_tx commit waited on DOC_LOCK via remote_reap")
        self.assertFalse(out and isinstance(out[0], BaseException), out)
        self.assertTrue(self.gone.terminated, "the unflagged seat's server was not reaped")
        self.assertFalse(self.kept.terminated, "a live, flagged seat's server was reaped")
        self.assertNotIn((self.slug, "other"), supervisor._remote_procs)
        self.assertIn((self.slug, "worker"), supervisor._remote_procs)


if __name__ == "__main__":
    unittest.main()
