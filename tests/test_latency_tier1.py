"""Tier-1 latency fixes hold their contracts, proven with negative controls.

Three fixes under test, all from the 2026-09-19 beta.1 wave findings:
  1. halt's settle poll no longer cycles the document lock every 50 ms
     (66.6 s four-agent halt batch under load; the poll's lock passes both
     queued behind agent writes and added their own queue pressure);
  2. `_assert_synced_data_root` memoizes on its exact input strings
     (3.56 s of a 5.12 s stretched write was this guard's realpath calls
     re-entering the GIL convoy under CPU interference);
  3. `_safe_slug` caches passing containment verdicts (1.55 s same trace).
The memos must NOT weaken semantics: env changes re-run the full check,
rejections are never cached, and mid-settle carriers stay durable.
"""
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-latency-t1-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, store, supervisor as sup, warmpool  # noqa: E402


class _CountingLock:
    """Delegates every use to the real document lock, counting entries."""

    def __init__(self, real):
        self._real = real
        self.entries = 0

    def __enter__(self):
        self.entries += 1
        return self._real.__enter__()

    def __exit__(self, *exc):
        return self._real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._real, name)


class SettlePollLockDiscipline(unittest.TestCase):
    def setUp(self):
        self.slug = "t1-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.nid = "worker"
        self.st = sup.state(self.slug, self.nid)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "_cancel_working_cache"))
        self.stack.enter_context(patch.object(warmpool, "kill_node"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.stack.enter_context(patch.object(sup, "_wd_kill_tree"))

    def tearDown(self):
        self.stack.close()
        store._POOL.close_all(self.slug)

    def _halt_while_busy_for(self, seconds, counter):
        """Run halt() against a state that stays busy for `seconds`."""
        self.st["busy"] = True
        release = threading.Timer(seconds, lambda: self.st.update(busy=False))
        release.start()
        with patch.object(store, "DOC_LOCK", counter), \
                patch.object(halt.store, "DOC_LOCK", counter):
            result = halt.halt(self.slug, self.nid)
        release.join()
        return result

    def test_settle_poll_takes_no_lock_pass_per_iteration(self):
        counter = _CountingLock(store.DOC_LOCK)
        result = self._halt_while_busy_for(0.6, counter)
        self.assertTrue(result["halted"])
        # ~12 poll iterations happened. The old loop paid >= 2 lock passes per
        # iteration (its own acquire plus the Condition re-acquire) — >= 24.
        # The new loop pays: halt()'s bookkeeping, the initial capture, up to
        # two throttled _cut snapshots, and one commit pass.
        self.assertLessEqual(counter.entries, 10,
                             f"settle poll cycled the doc lock {counter.entries} times")

    def test_negative_control_forced_carrier_peek_restores_per_iteration_locking(self):
        """Prove the counter measures the poll: force the lock-free peek to
        claim carriers every iteration and the pass count must explode back
        to per-iteration locking."""
        counter = _CountingLock(store.DOC_LOCK)
        with patch.object(halt, "_pending_carriers", return_value=True):
            result = self._halt_while_busy_for(0.6, counter)
        self.assertTrue(result["halted"])
        self.assertGreater(counter.entries, 10,
                           "forced peek did not restore per-iteration locking — "
                           "the discipline test is not measuring the poll")

    def test_mid_settle_carriers_reach_the_durable_queue(self):
        self.st["busy"] = True

        def inject_then_release():
            time.sleep(0.15)
            with sup._state_lock:
                self.st.setdefault("queue", []).append(
                    {"text": "arrived mid-settle"})
            time.sleep(0.15)
            self.st["busy"] = False

        threading.Thread(target=inject_then_release).start()
        result = halt.halt(self.slug, self.nid)
        self.assertTrue(result["settled"])
        held = store.load_org(self.slug).node(self.nid).get("halt_queue") or []
        self.assertTrue(any(c.get("text") == "arrived mid-settle" for c in held),
                        "carrier arriving during settle was not made durable")


class DataRootGuardMemo(unittest.TestCase):
    def setUp(self):
        store._ROOT_SYNC_OK = None

    def tearDown(self):
        os.environ["ORGTREE_DATA"] = _root.name
        store._ROOT_SYNC_OK = None

    def test_desync_still_raises_after_a_pass(self):
        store._assert_synced_data_root()          # passes and memoizes
        with tempfile.TemporaryDirectory() as other:
            os.environ["ORGTREE_DATA"] = other
            with self.assertRaises(store.DataRootDesync):
                store._assert_synced_data_root()
        os.environ["ORGTREE_DATA"] = _root.name
        store._assert_synced_data_root()          # recovers

    def test_repeat_pass_makes_no_native_canonicalization_calls(self):
        store._assert_synced_data_root()
        real = os.path.realpath
        calls = []
        with patch.object(os.path, "realpath",
                          side_effect=lambda p: calls.append(p) or real(p)):
            store._assert_synced_data_root()
        self.assertEqual(calls, [],
                         "memoized guard still canonicalized paths natively")

    def test_failing_check_is_not_cached(self):
        with tempfile.TemporaryDirectory() as other:
            os.environ["ORGTREE_DATA"] = other
            for _ in range(2):                    # raises BOTH times
                with self.assertRaises(store.DataRootDesync):
                    store._assert_synced_data_root()


class TreeBytesBypassEquality(unittest.TestCase):
    """The serialize-once tree cache may bypass the framework encoder ONLY
    where equality proves the bytes identical (coordinator-sol decision,
    2026-09-19 21:35Z). This is that proof, on a real org payload, plus the
    preserved direct-caller contract."""

    @classmethod
    def setUpClass(cls):
        import types
        from orgtree import api
        cls.api = api
        cls.types = types
        org = store.create_org("tree-bytes-" + str(time.time_ns()))
        cls.slug = org.d["slug"]
        org.hire(ledger.USER, None, "luna", 0, "boss", charter="the boss")
        org.hire(ledger.USER, "boss", "luna", 0, "kid", charter="a child")
        store.save_org(org)

    def _req(self):
        return self.types.SimpleNamespace(
            state=self.types.SimpleNamespace(), headers={},
            url=self.types.SimpleNamespace(path="/api/orgs/x"))

    def test_served_bytes_equal_framework_encoding_of_the_same_dict(self):
        from starlette.testclient import TestClient
        client = TestClient(self.api.app)
        r = client.get(f"/api/orgs/{self.slug}")
        self.assertEqual(r.status_code, 200)
        tree = self.api.org_tree(self.slug, self._req())   # same cached build
        self.assertIsInstance(tree, dict, "direct caller must get the dict")
        from fastapi.responses import JSONResponse
        from fastapi.encoders import jsonable_encoder
        framework = JSONResponse(jsonable_encoder(tree)).body
        self.assertEqual(r.content, framework,
                         "bypassed serialization diverged from the framework encoding")

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all(cls.slug)

    def test_http_response_carries_the_etag_and_304_works(self):
        from starlette.testclient import TestClient
        client = TestClient(self.api.app)
        client.get(f"/api/orgs/{self.slug}")   # cold fetch warms the limits
        # cache, which is an etag input, so the FIRST tag rotates once
        # (pre-existing behavior, not part of the bytes bypass under test)
        r = client.get(f"/api/orgs/{self.slug}")
        etag = r.headers.get("etag")
        self.assertTrue(etag, "bytes response lost the ETag header")
        r2 = client.get(f"/api/orgs/{self.slug}",
                        headers={"If-None-Match": etag})
        self.assertEqual(r2.status_code, 304)


class SafeSlugMemo(unittest.TestCase):
    def setUp(self):
        store._SAFE_SLUG_OK.clear()

    def test_rejection_is_never_cached(self):
        for _ in range(2):
            with self.assertRaises(ledger.LedgerError):
                store._safe_slug("..")

    def test_cached_pass_skips_path_arithmetic_but_uncached_still_checks(self):
        store._safe_slug("plain-org")             # fills the cache
        with patch.object(store, "_slug_contained") as contained:
            store._safe_slug("plain-org")         # served from cache
            contained.assert_not_called()
        store._SAFE_SLUG_OK.clear()
        with patch.object(store, "_slug_contained", return_value=False):
            with self.assertRaises(ledger.LedgerError):
                store._safe_slug("plain-org")     # uncached -> real check runs


if __name__ == "__main__":
    unittest.main()
