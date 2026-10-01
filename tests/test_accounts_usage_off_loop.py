"""`GET /api/accounts/{id}/usage` must not hold the event loop while it fetches.

Docket v3-the-first-agent-desk-opened-in-an-org-window: the route was an
`async def` that called `accountusage.view(row, allow_fetch=True)` directly,
and that call can make network reads (limits.fetch, codex_limits.fetch,
antigravity_limits.fetch). While the upstream was slow, no other request could
even start, so a freshly opened window's first desk waited ~10 s for its tree.

What this proves, through the real ASGI app on one event loop:
  * while a usage read is blocked in its fetch, a cheap request still answers
    promptly (the NEGATIVE CONTROL runs the same blocked fetch ON the loop and
    shows the cheap request waiting for it, so the timing can tell the two
    shapes apart);
  * the blocked read still returns its own answer, with the requested alias;
  * an unknown account is still a 404.

Run:  python tools/run-python-verification.py tests/test_accounts_usage_off_loop.py
"""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-usage-off-loop-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import httpx  # noqa: E402

from orgtree import accountusage, api, limits, registry  # noqa: E402

ROW = {"id": "claude-9", "provider": "claude", "credential": {"kind": "managed"}}
BLOCK_S = 1.5


class AccountsUsageOffLoop(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.entered = threading.Event()

        def slow_view(row, *, allow_fetch=True, now=None):
            self.entered.set()
            self.release.wait(BLOCK_S)     # a stalled upstream, blocking I/O
            return {"account": row["id"], "provider": "claude", "available": True}

        for target in (patch.object(registry, "get_account", side_effect=self._get_account),
                       patch.object(registry, "account_name", return_value="claude-9"),
                       patch.object(accountusage, "view", side_effect=slow_view),
                       patch.object(limits, "peek", return_value={"available": False})):
            target.start()
            self.addCleanup(target.stop)

    @staticmethod
    def _get_account(account_id):
        if account_id != "claude-9":
            raise registry.UnknownAccount(account_id)
        return dict(ROW)

    async def _race(self, app):
        """Start the usage read, then a cheap read, back to back on one loop.
        Time the cheap read from before either was sent: a usage read that
        holds the loop makes the cheap one wait for it; one on a worker does
        not."""
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://engine") as client:
            t0 = time.perf_counter()
            slow = asyncio.create_task(client.get("/api/accounts/claude-9/usage"))
            cheap_task = asyncio.create_task(client.get("/api/usage/peek"))
            cheap = await cheap_task
            cheap_s = time.perf_counter() - t0
            # overlap proof: the usage read reaches its blocking fetch and is
            # still in it after the cheap read has answered
            for _ in range(100):
                if self.entered.is_set():
                    break
                await asyncio.sleep(0.01)
            still_blocked = self.entered.is_set() and not slow.done()
            self.release.set()
            answer = await slow
            return cheap, cheap_s, still_blocked, answer

    def test_cheap_request_answers_while_usage_fetch_is_blocked(self):
        cheap, cheap_s, still_blocked, answer = asyncio.run(self._race(api.app))
        self.assertEqual(cheap.status_code, 200)
        self.assertLess(cheap_s, 0.5, f"a cheap request waited {cheap_s:.2f} s behind a usage fetch")
        self.assertTrue(still_blocked, "the usage read finished too early to prove anything")
        self.assertEqual(answer.status_code, 200)
        body = answer.json()
        self.assertEqual(body["account"], "claude-9")
        self.assertEqual(body["name"], "claude-9")
        self.assertTrue(body["available"])

    def test_negative_control_the_same_fetch_on_the_loop_blocks_everything(self):
        """The old shape: the blocking call made from the async body itself.
        The cheap request must wait for it, or the timing above proves nothing."""
        async def on_loop(account_id: str):
            row = registry.get_account(account_id)
            return accountusage.view(row, allow_fetch=True)

        with patch.object(api, "run_in_threadpool", create=True):
            route = next(r for r in api.app.router.routes
                         if getattr(r, "path", None) == "/api/accounts/{account_id}/usage")
            with patch.object(route, "endpoint", on_loop), \
                    patch.object(route, "app", _asgi_for(on_loop)):
                cheap, cheap_s, _still, answer = asyncio.run(self._race(api.app))
        self.assertEqual(cheap.status_code, 200)
        self.assertGreaterEqual(cheap_s, BLOCK_S * 0.8,
                                f"the on-loop control did not block ({cheap_s:.2f} s): the probe cannot tell")
        self.assertEqual(answer.status_code, 200)

    def test_unknown_account_is_still_404(self):
        from fastapi.testclient import TestClient
        r = TestClient(api.app).get("/api/accounts/nobody/usage")
        self.assertEqual(r.status_code, 404)


def _asgi_for(endpoint):
    """A bare ASGI app answering with `endpoint`'s JSON, run on the loop."""
    import json

    async def app(scope, receive, send):
        body = json.dumps(await endpoint(scope["path_params"]["account_id"])).encode()
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})
    return app


if __name__ == "__main__":
    unittest.main()
