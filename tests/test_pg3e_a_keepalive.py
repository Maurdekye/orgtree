"""PG-3e-A (from PG-3e-B's tests, by agreement): the working-cache keepalive —
`_working_cache_read` is PG-3e-A's per decision 6; its conversion was written
by PG-3e-B and taken over as is.

Original PG-3e-B header: the supervisor's session / remote-control / account-switch leaf
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
import traceback
import unittest
from unittest.mock import patch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_ROOT = tempfile.mkdtemp(prefix="orgtree-pg3e-a-ka-")
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
    if t.is_alive():
        # say WHERE it is stuck, so a failure names the lock it waits on
        frame = sys._current_frames().get(t.ident)
        if frame is not None:
            out.append("".join(traceback.format_stack(frame)[-6:]))
    return (not t.is_alive()), out


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
                # `__wrapped__`: the body; @halt.worker's prologue is halt.py's (PG-3a)
                done, out = _finishes(
                    lambda: sup._working_cache_read.__wrapped__(self.slug, "worker"))
        self.assertTrue(done, f"the keepalive waited on DOC_LOCK: {out}")
        self.assertFalse(out and isinstance(out[0], BaseException), out)
        n = _node(self.slug, "worker")
        self.assertAlmostEqual(float(n.get("cost_usd") or 0), 0.25)
        self.assertTrue(n.get("cache_keepalive_at"), "freshness was not recorded")


if __name__ == "__main__":
    unittest.main()
