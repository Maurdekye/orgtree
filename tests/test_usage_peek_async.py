"""The four `*/usage/peek` routes run on the event loop, with no threadpool
hop and no response-model validation, and answer byte-for-byte what they
answered as sync routes.

N1000 engprof (2026-09-28): the peeks were 59% of all requests. As sync
`def`s with a `dict[str, Any]` return annotation, each paid two threadpool
hops, one for the handler and one for response validation (~145 + 150 ms
queued at N1000, p50 ~230 ms for a ~1 ms read). What this proves:
  * each route's endpoint is a coroutine function and has no response model;
  * serving each route makes ZERO `run_in_threadpool` calls. The NEGATIVE
    CONTROL is the old shape (a sync route with the same annotation), which
    makes at least 2 through the same counter, so the counter works;
  * the response bytes equal the old shape's bytes for every kind of peek
    payload (unavailable, stale, available with float/int/unicode/null
    limits);
  * a peek can never wait on I/O, because nothing does I/O while holding the
    `_lock` a peek takes. Every cache-hit path of codex_limits.fetch and
    antigravity_limits.fetch calls `_account` (providers.*_status(): files
    and the CLI) with its module `_lock` RELEASED (review n1-review-astra on
    b35e6f0: at that commit it ran under the lock, so a slow status call held
    peek, and with it the event loop, for the whole call). A spy records the
    lock state at every `_account` call; the NEGATIVE CONTROL calls `_account`
    under the lock on purpose and the spy sees it. A timing probe blocks
    `_account` inside fetch() on a thread and requires peek() to return
    promptly; its negative control holds `_lock` across the block and peek()
    waits.

Run:  python tools/run-python-verification.py tests/test_usage_peek_async.py
"""
import inspect
import threading
import time
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-usage-peek-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from fastapi import FastAPI, routing  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from orgtree import api, antigravity_limits, codex_limits, limits, openrouter_limits  # noqa: E402

ROUTES = {
    "/api/usage/peek": limits,
    "/api/codex/usage/peek": codex_limits,
    "/api/antigravity/usage/peek": antigravity_limits,
    "/api/openrouter/usage/peek": openrouter_limits,
}
PAYLOADS = [
    {"available": False},
    {"available": False, "provider": "Codex", "error": "Codex usage readout is stale"},
    {"available": True, "provider": "Antigravity", "age": 12.3,
     "limits": [{"key": "five_hour", "label": "Session — 5 h", "utilization": 41.5,
                 "resets_at": "2026-09-28T17:00:00Z", "used": 3, "cap": None},
                {"key": "weekly", "label": "Weekly ✓", "utilization": 100,
                 "resets_at": None, "extra": {"nested": [1, 2.5, "x"]}}]},
    {"available": True, "limits": [], "age": 0.0},
]


def _old_shape_app(module) -> FastAPI:
    """The route as it was: a sync `def` annotated `-> dict[str, Any]`."""
    ref = FastAPI()

    @ref.get("/peek")
    def peek() -> dict[str, Any]:
        return module.peek()
    return ref


def _counting():
    n = [0]
    real = routing.run_in_threadpool

    async def counted(func, *args, **kwargs):
        n[0] += 1
        return await real(func, *args, **kwargs)
    return n, patch.object(routing, "run_in_threadpool", counted)


class UsagePeekAsync(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(api.app)

    def _route(self, path):
        (route,) = [r for r in api.app.routes if getattr(r, "path", None) == path]
        return route

    def test_routes_are_coroutines_without_response_model(self) -> None:
        for path in ROUTES:
            with self.subTest(path=path):
                route = self._route(path)
                self.assertTrue(inspect.iscoroutinefunction(route.endpoint))
                self.assertIsNone(route.response_model)
                self.assertIsNone(route.response_field)

    def test_no_threadpool_hop_and_the_counter_works(self) -> None:
        for path, module in ROUTES.items():
            with self.subTest(path=path), patch.object(module, "peek", return_value=PAYLOADS[2]):
                n, p = _counting()
                with p:
                    self.assertEqual(self.client.get(path).status_code, 200)
                self.assertEqual(n[0], 0, "the peek went through the threadpool")
                n, p = _counting()
                with p:
                    self.assertEqual(TestClient(_old_shape_app(module)).get("/peek").status_code, 200)
                self.assertGreaterEqual(n[0], 2, "negative control: the old shape's hops were not counted")

    def test_bytes_identical_to_the_old_shape(self) -> None:
        checked = 0
        for path, module in ROUTES.items():
            for payload in PAYLOADS:
                with self.subTest(path=path, payload=payload), \
                        patch.object(module, "peek", return_value=payload):
                    new = self.client.get(path)
                    old = TestClient(_old_shape_app(module)).get("/peek")
                    self.assertEqual(new.status_code, old.status_code)
                    self.assertEqual(new.headers["content-type"], old.headers["content-type"])
                    self.assertEqual(new.content, old.content)
                    checked += 1
        self.assertEqual(checked, len(ROUTES) * len(PAYLOADS))

    def test_real_peek_without_a_patch_still_answers(self) -> None:
        for path in ROUTES:
            with self.subTest(path=path):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 200)
                self.assertIn("available", r.json())



class NoIoUnderPeekLock(unittest.TestCase):
    """`_account` (providers.*_status: files, the CLI) never runs under `_lock`."""

    def spy(self, module):
        seen = []
        real = module._account

        def account(data, *rest):
            seen.append(module._lock.locked())   # single-threaded: held == held by the caller
            return real(data, *rest)
        return seen, patch.object(module, "_account", account)

    def test_negative_control_the_spy_sees_a_held_lock(self):
        seen, p = self.spy(codex_limits)
        with p, patch.object(codex_limits.providers, "codex_status", return_value={}):
            with codex_limits._lock:
                codex_limits._account({"available": False})
            codex_limits._account({"available": False})
        self.assertEqual(seen, [True, False])

    def _codex_fresh(self):
        return {"at": time.time(), "complete_at": time.time(), "account": "A",
                "data": {"available": True, "limits": []}}

    def test_codex_fetch_cache_hits_call_account_unlocked(self):
        status = {"installed": True, "connected": True, "kind": "chatgpt", "email": "a@b"}
        saved = dict(codex_limits._cache)
        self.addCleanup(codex_limits._cache.update, saved)
        seen, p = self.spy(codex_limits)
        with p, patch.object(codex_limits, "account_namespace", return_value="A"),                 patch.object(codex_limits.providers, "codex_status", return_value=status):
            # path 1: the first cache check
            codex_limits._cache.update(self._codex_fresh())
            self.assertTrue(codex_limits.fetch()["available"])
            # path 2: the re-check under _fetch_lock (another fetch filled the
            # cache while this one read the provider status)
            codex_limits._cache.update(at=0.0, data=None)

            def status_then_fill():
                codex_limits._cache.update(self._codex_fresh())
                return status
            with patch.object(codex_limits.providers, "codex_status", side_effect=status_then_fill):
                self.assertTrue(codex_limits.fetch()["available"])
        self.assertGreaterEqual(len(seen), 2, "both cache-hit paths must reach _account")
        self.assertEqual(set(seen), {False}, f"_account ran under codex_limits._lock: {seen}")

    def test_antigravity_fetch_cache_hits_call_account_unlocked(self):
        status = {"installed": True, "connected": True, "email": "a@b", "kind": "oauth",
                  "version": "1.2.3"}
        account = antigravity_limits._account_key(status)
        version = antigravity_limits.capability.version_key(status["version"])
        fresh = {"at": time.time(), "account": account, "version": version,
                 "data": {"available": True, "limits": []}}
        saved = dict(antigravity_limits._cache)
        self.addCleanup(antigravity_limits._cache.update, saved)
        seen, p = self.spy(antigravity_limits)
        with p, patch.object(antigravity_limits.providers, "antigravity_status", return_value=status),                 patch.object(antigravity_limits.providers, "antigravity_cached_status", return_value=status):
            # path 1: the check before _fetch_lock
            antigravity_limits._cache.update(fresh)
            self.assertTrue(antigravity_limits.fetch()["available"])
            # path 2: the re-check under _fetch_lock
            antigravity_limits._cache.update(at=0.0, data=None)
            real = antigravity_limits._supports_usage

            def supported_then_fill(v):
                antigravity_limits._cache.update(dict(fresh, at=time.time()))
                return real(v)
            with patch.object(antigravity_limits, "_supports_usage", side_effect=supported_then_fill):
                self.assertTrue(antigravity_limits.fetch()["available"])
        self.assertGreaterEqual(len(seen), 2, "both cache-hit paths must reach _account")
        self.assertEqual(set(seen), {False}, f"_account ran under antigravity_limits._lock: {seen}")

    def test_peek_is_prompt_while_fetch_is_blocked_in_account(self):
        """The reviewer's probe: fetch() stuck inside a slow `_account` must not hold peek()."""
        saved = dict(codex_limits._cache)
        self.addCleanup(codex_limits._cache.update, saved)
        codex_limits._cache.update(self._codex_fresh())

        def measure(hold_lock):
            entered, release = threading.Event(), threading.Event()

            def slow_account(data):
                entered.set()
                release.wait(10)
                return data

            def run():
                with patch.object(codex_limits, "account_namespace", return_value="A"),                         patch.object(codex_limits, "_account", slow_account):
                    if hold_lock:       # NEGATIVE CONTROL: the b35e6f0 shape
                        with codex_limits._lock:
                            codex_limits._account({})
                    else:
                        codex_limits.fetch()
            t = threading.Thread(target=run, daemon=True)
            t.start()
            self.assertTrue(entered.wait(10), "fetch never reached _account")
            timer = threading.Timer(0.5, release.set)
            timer.start()
            t0 = time.perf_counter()
            codex_limits.peek()
            ms = (time.perf_counter() - t0) * 1000
            release.set(); timer.cancel(); t.join(10)
            return ms
        self.assertGreater(measure(hold_lock=True), 400, "negative control: peek did not wait on a held lock")
        self.assertLess(measure(hold_lock=False), 100, "peek waited on fetch's _account")


if __name__ == "__main__":
    unittest.main()
