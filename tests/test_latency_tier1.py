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


class SlowTraceAttribution(unittest.TestCase):
    """The universal tracing decision (2026-09-19): durable stage attribution
    for every slow request, explicit unattributed time, wall-vs-CPU on the
    write stages, privacy boundary intact, bounded retention — each proven
    by DELIBERATE delays and controls, not by reading the code."""

    @classmethod
    def setUpClass(cls):
        import types
        from orgtree import api, slowtrace
        cls.api, cls.slowtrace, cls.types = api, slowtrace, types
        org = store.create_org("slowtrace-" + str(time.time_ns()))
        cls.slug = org.d["slug"]
        org.hire(ledger.USER, None, "luna", 0, "boss", charter="the boss")
        store.save_org(org)
        from starlette.testclient import TestClient
        cls.client = TestClient(api.app)

    @classmethod
    def tearDownClass(cls):
        store._POOL.close_all(cls.slug)

    def setUp(self):
        self._threshold = self.slowtrace.THRESHOLD_MS
        self.slowtrace.THRESHOLD_MS = 100.0
        self._before = len(self.slowtrace.tail(2000))

    def tearDown(self):
        self.slowtrace.THRESHOLD_MS = self._threshold

    def _new_rows(self):
        rows = self.slowtrace.tail(2000)
        return rows[self._before:]

    def test_delay_inside_the_save_stage_is_attributed_to_it_with_cpu_split(self):
        real = store._save_org

        def slow_save(org):
            time.sleep(0.25)
            return real(org)

        with patch.object(store, "_save_org", side_effect=slow_save):
            r = self.client.post(f"/api/orgs/{self.slug}/nodes/boss/scope",
                                 json={"charter": "traced charter"})
        self.assertEqual(r.status_code, 200, r.text[:200])
        rows = [x for x in self._new_rows() if "org_save_ms" in x]
        self.assertTrue(rows, "no durable row carried the save stage")
        row = rows[-1]
        self.assertGreaterEqual(row["org_save_ms"], 240,
                                "the deliberate in-stage delay was not attributed")
        # the sleep spends wall, not CPU: the pair is what separates work
        # from starvation (the astra tracing gap)
        self.assertLess(row.get("org_save_cpu_ms", 0.0), 100)
        self.assertLess(abs(row["unattributed_ms"]),
                        row["handler_ms"] * 0.5,
                        "most of the request should be attributed to stages")

    def test_delay_outside_every_stage_lands_in_unattributed(self):
        from orgtree import supervisor as sup
        real = sup.primed_restart

        def slow_primed():
            time.sleep(0.25)
            return real()

        with patch.object(sup, "primed_restart", side_effect=slow_primed):
            with self.api._tree_cache_lock:
                self.api._tree_cache.clear()
            r = self.client.get(f"/api/orgs/{self.slug}")
        self.assertEqual(r.status_code, 200)
        rows = [x for x in self._new_rows()
                if x.get("route") == "/api/orgs/{slug}"]
        self.assertTrue(rows, "no durable row for the delayed tree request")
        self.assertGreaterEqual(rows[-1]["unattributed_ms"], 200,
                                "out-of-stage time must be EXPLICIT, not vanish")

    def test_rows_exist_with_profiling_toggle_off_and_carry_worker_ready_ids(self):
        self.assertFalse(self.api._PROFILE_TIMING,
                         "suite assumes the verbose toggle is off (its default)")
        rows = self._new_rows()
        if not rows:                       # ensure at least one slow row
            real = store._save_org
            with patch.object(store, "_save_org",
                              side_effect=lambda o: (time.sleep(0.15), real(o))[1]):
                self.client.post(f"/api/orgs/{self.slug}/nodes/boss/scope",
                                 json={"charter": "toggle-off trace"})
            rows = self._new_rows()
        self.assertTrue(rows, "durable tracing must not depend on the toggle")
        for field in ("pid", "instance", "seq", "ts", "route"):
            self.assertIn(field, rows[-1])

    def test_smuggled_profile_field_never_reaches_the_durable_row(self):
        scope = {"type": "http", "method": "GET",
                 "route": self.types.SimpleNamespace(path="/api/test-smuggle")}
        poisoned = {"org_save_ms": 42.0, "secret_leak": 123.0,
                    "mail_body_len": 999.0}
        self.api._access_emit(scope, 200, 600.0, 601.0, 10, 1, poisoned)
        rows = [x for x in self._new_rows()
                if x.get("route") == "/api/test-smuggle"]
        self.assertTrue(rows)
        self.assertIn("org_save_ms", rows[-1])
        self.assertNotIn("secret_leak", rows[-1])
        self.assertNotIn("mail_body_len", rows[-1])

    def test_retention_is_bounded_by_rotation(self):
        st = self.slowtrace
        old_max = st._MAX_BYTES
        st._MAX_BYTES = 2000
        try:
            for i in range(60):
                st.emit({"route": "/api/rotation-test", "handler_ms": 500.0,
                         "total_ms": 500.0, "bytes": 0, "unattributed_ms": 0.0})
            size = os.path.getsize(st.path())
            self.assertLess(size, 2 * 2000 + 500,
                            "current file must stay near the cap")
            self.assertTrue(os.path.exists(st.path() + ".1"),
                            "rotation must keep exactly one previous file")
        finally:
            st._MAX_BYTES = old_max

    def test_always_on_tracing_overhead_is_negligible_on_the_hot_path(self):
        self.client.get(f"/api/orgs/{self.slug}")     # ensure cache filled
        lat = []
        for _ in range(60):
            t0 = time.perf_counter()
            r = self.client.get(f"/api/orgs/{self.slug}")
            lat.append((time.perf_counter() - t0) * 1000.0)
            self.assertEqual(r.status_code, 200)
        lat.sort()
        p50 = lat[len(lat) // 2]
        print(f"[overhead] cache-hit GET p50 with always-on tracing: {p50:.2f}ms")
        self.assertLess(p50, 25,
                        "always-on tracing must not make the hot path slow")


if __name__ == "__main__":
    unittest.main()
