"""What `GET /api/accounts/{id}/usage` SAYS when the token refresh fails.

The bug this covers was not only that the refresh broke — it was that the
breakage lied. The account row reads `authenticated` because a profile
directory holds an account uuid, which is a fact about a FILE and stays true
long after the login behind it stops working. So when subproxy could not
refresh, the panel showed a raw `HTTP Error 403: Forbidden` beside a row
labelled authenticated, and the only action it suggested was signing in
again — for a failure that was a Cloudflare block on a scripting User-Agent
and had never reached the OAuth server at all.

Three things are asserted here, at the real route rather than on the helper:
  1. `error` is a sentence a person can act on; the technical line lives in
     `detail` (user ruling 2026-09-11).
  2. a sign-in prompt appears ONLY when something actually judged the
     credential.
  3. the two cases are driven through the SAME code path, so neither
     assertion can pass by being unreachable.

No network, no CLI, no real credentials.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.error


def _refuse_live_root(bound):
    """⚠ `store.DATA_ROOT` BINDS AT FIRST IMPORT for the whole process, so
    under `discover` an earlier module's fixture root is what this module
    gets. Demanding our OWN root would make this file fail for a reason that
    has nothing to do with what it tests — so guard the property that
    actually matters: this must never be the operator's live storage. True in
    a standalone run and a combined one alike, and it still raises when it is
    ever untrue (`LiveRootGuardTests` proves that it does)."""
    bound = Path(bound).resolve()
    for protected in (Path.home() / "orgtree",
                      os.environ.get("ORGTREE_AGENT_PARENT_DATA"),
                      os.environ.get("ORGTREE_AGENT_LEGACY_DATA")):
        if not protected:
            continue
        protected = Path(protected).resolve()
        if bound == protected or protected in bound.parents:
            raise AssertionError(f"REFUSING: store bound to live root {bound}")


class LiveRootGuardTests(unittest.TestCase):
    """POSITIVE CONTROL for the guard above. A safety check nobody has ever
    seen fail is a check nobody knows works — and this one cannot be
    triggered through the normal fixture path, because setUpClass points
    ORGTREE_DATA at a temp dir before store is ever imported."""

    def test_the_guard_refuses_the_live_root(self):
        with self.assertRaises(AssertionError):
            _refuse_live_root(str(Path.home() / "orgtree"))

    def test_the_guard_refuses_a_path_inside_the_live_root(self):
        with self.assertRaises(AssertionError):
            _refuse_live_root(str(Path.home() / "orgtree" / "orgs"))

    def test_the_guard_allows_a_throwaway_root(self):
        with tempfile.TemporaryDirectory(prefix="guard-ok-") as d:
            _refuse_live_root(d)      # must not raise


class RefreshFailureStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-refresh-status-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import api, registry, store, subproxy
        _refuse_live_root(store.DATA_ROOT)
        cls.api, cls.registry, cls.subproxy = api, registry, subproxy

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _claude_row(self):
        """A managed claude row WITH a credentials file whose access token has
        expired — so the route reaches the refresh instead of short-circuiting
        somewhere earlier. (A row with no file at all takes a different branch
        and would make every assertion below vacuous.)"""
        RefreshFailureStatusTests._seq += 1
        d = Path(self.root) / f"prof-{self._seq}"
        d.mkdir(parents=True, exist_ok=True)
        (d / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {
            "accessToken": "at-expired", "refreshToken": "rt-fixture",
            "expiresAt": 0, "scopes": ["user:profile", "user:inference"]}}),
            encoding="utf-8")
        return self.registry.create_account(
            "claude", "secondary", {"kind": "managed", "path": str(d)})

    def _usage_when_refresh_fails(self, error):
        row = self._claude_row()

        def fake_urlopen(req, timeout=None):
            raise error

        orig = self.subproxy.urllib.request.urlopen
        self.subproxy.urllib.request.urlopen = fake_urlopen
        try:
            return asyncio.run(self.api.accounts_usage(row["id"]))
        finally:
            self.subproxy.urllib.request.urlopen = orig

    @staticmethod
    def _http(code, body):
        return urllib.error.HTTPError(
            "https://platform.claude.com/v1/oauth/token", code, "reason",
            {}, io.BytesIO(body))

    # ---------------------------------------------------------- the WAF case
    def test_edge_block_does_not_claim_the_account_needs_signing_in(self):
        """⚠ THE REPORTED BUG. 403 + `error code: 1010` is a WAF answer; the
        refresh token was never looked at, so there is nothing here that
        entitles the panel to send the user to a sign-in screen."""
        out = self._usage_when_refresh_fails(
            self._http(403, b"error code: 1010\n"))
        self.assertFalse(out["available"])
        self.assertNotIn("reauth_required", out)
        self.assertNotIn("reauth_evidence", out)

    def test_edge_block_says_something_a_person_can_act_on(self):
        out = self._usage_when_refresh_fails(
            self._http(403, b"error code: 1010\n"))
        self.assertEqual(out["error"], self.subproxy.RECOVERABLE_MESSAGE)
        self.assertNotIn("403", out["error"])
        self.assertNotIn("1010", out["error"])

    def test_the_technical_line_is_still_available_for_diagnosis(self):
        """Removed from the headline, NOT thrown away — throwing it away is
        what made the original 403 impossible to diagnose."""
        out = self._usage_when_refresh_fails(
            self._http(403, b"error code: 1010\n"))
        self.assertIn("403", out["detail"])
        self.assertIn("error code: 1010", out["detail"])

    # ------------------------------------------------- the genuine sign-out
    def test_a_rejected_refresh_token_does_ask_for_a_sign_in(self):
        """POSITIVE CONTROL for all three tests above: same route, same
        fixture, same code path, opposite answer. Wiring that simply never
        set `reauth_required` would pass those and fail this."""
        out = self._usage_when_refresh_fails(self._http(
            400, b'{"error": "invalid_grant", "error_description": "bad"}'))
        self.assertFalse(out["available"])
        self.assertTrue(out["reauth_required"])
        self.assertEqual(out["reauth_evidence"], "measured_refresh_rejected")
        self.assertEqual(out["error"], self.subproxy.SIGNED_OUT_MESSAGE)
        self.assertIn("invalid_grant", out["detail"])

    def test_a_moved_endpoint_is_not_a_sign_in_problem_either(self):
        out = self._usage_when_refresh_fails(self._http(
            404, b'{"type":"error","error":{"type":"not_found_error"}}'))
        self.assertNotIn("reauth_required", out)
        self.assertEqual(out["error"], self.subproxy.RECOVERABLE_MESSAGE)

    def test_a_dropped_connection_is_not_a_sign_in_problem_either(self):
        out = self._usage_when_refresh_fails(
            urllib.error.URLError("connection reset"))
        self.assertNotIn("reauth_required", out)
        self.assertEqual(out["error"], self.subproxy.RECOVERABLE_MESSAGE)

    # ------------------------------------------------------------- coverage
    def test_standing_still_rides_every_answer(self):
        out = self._usage_when_refresh_fails(
            self._http(403, b"error code: 1010\n"))
        self.assertIn("standing", out)
        self.assertEqual(out["provider"], "claude")


if __name__ == "__main__":
    unittest.main()
