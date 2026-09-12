"""API-key accounts, stage (c1) — the metered routing seam (ticket
redesign-api-key-inference-accounts; user decisions 2026-09-12).

Covers, at the supervisor + registry level (no real spawn):
  · apikey_lane_row — list-order pick, disabled and marked rows skipped
  · _claude_subscription_exhausted — profile rows count as capacity until a
    live mark or an unauthenticated verdict; apikey/ambient/legacy-token
    rows never count; the resolve()-available short-circuit
  · apikey_route_for — both toggles default-off answer None; subscription
    inference OFF routes regardless of subscription capacity; fallback ON
    routes only once exhausted; a shut lane answers None
  · spawn_env — metered branch injects key + marker for an unbound node;
    default toggles leave every legacy lane byte-identical; the two
    subscription-off refusals (unbound with a shut lane, bound to a
    subscription account) raise for admission to hold
The admission-gate park itself is integration territory (it mirrors the
missing:-binding park verbatim and is held by the same frozen re-check);
its decision inputs are what these tests pin down.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="apikey-routing-")
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

from engine.backend.orgtree import (  # noqa: E402
    accounts, apikey_accounts, appsettings, ledger, registry, supervisor,
    tokens)

FAKE_KEY = "sk-ant-api03-" + "r" * 40
NOW = time.time()


def _fresh():
    for p in (registry.registry_path(), appsettings.path()):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def _key_row(n=1):
    row, _ = apikey_accounts.register("claude", FAKE_KEY[:-1] + str(n))
    return registry.get_account(row["id"])


def _sub_row(auth=None):
    row = registry.create_account(
        "claude", "profile",
        {"kind": "managed", "path": os.path.join(_root, f"p{time.time_ns()}")})
    if auth:
        registry.set_auth(row["id"], auth)
    return registry.get_account(row["id"])


def _org(slug, nid="root", account=None):
    org = ledger.Org.create(slug)
    org.nodes[nid] = {"state": "live", "parent": None, "generation": 1,
                      "model": "opus"}
    if account:
        org.nodes[nid]["account"] = account
    return org


class LaneRowTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_list_order_and_skips(self):
        r1, r2 = _key_row(1), _key_row(2)
        got = supervisor.apikey_lane_row("claude", "opus", NOW)
        self.assertEqual(got["id"], r1["id"])            # list order
        registry.record_mark(r1["id"], "opus", NOW + 3600, now=NOW)
        got = supervisor.apikey_lane_row("claude", "opus", NOW)
        self.assertEqual(got["id"], r2["id"])            # marked → skipped
        registry.set_enabled(r2["id"], False)
        self.assertIsNone(supervisor.apikey_lane_row("claude", "opus", NOW))
        self.assertIsNone(supervisor.apikey_lane_row("openai", "opus", NOW))


class ExhaustionTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_profile_rows_count_until_marked_or_signed_out(self):
        # fixture has no primary login and no legacy keys: resolve() is
        # already unavailable, so registry rows are the whole question
        sub = _sub_row()
        self.assertFalse(supervisor._claude_subscription_exhausted("opus", NOW))
        registry.record_mark(sub["id"], "opus", NOW + 3600, now=NOW)
        self.assertTrue(supervisor._claude_subscription_exhausted("opus", NOW))

    def test_irrelevant_rows_never_count_as_capacity(self):
        _key_row(1)                                      # apikey row
        _sub_row(auth="unauthenticated")                 # signed-out profile
        registry.create_account("openai", "codex",
                                {"kind": "managed",
                                 "path": os.path.join(_root, "cx")})
        self.assertTrue(supervisor._claude_subscription_exhausted("opus", NOW))

    def test_resolve_capacity_short_circuits(self):
        with patch.object(accounts, "resolve",
                          return_value={"account": "primary",
                                        "available": True,
                                        "refresh_at": None}):
            self.assertFalse(
                supervisor._claude_subscription_exhausted("opus", NOW))


class RouteTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_defaults_route_nothing(self):
        _key_row(1)
        self.assertIsNone(supervisor.apikey_route_for("opus", NOW))

    def test_subscription_off_routes_regardless_of_capacity(self):
        row = _key_row(1)
        appsettings.set_subscription_inference_enabled("claude", False)
        with patch.object(accounts, "resolve",
                          return_value={"account": "primary",
                                        "available": True,
                                        "refresh_at": None}):
            got = supervisor.apikey_route_for("opus", NOW)
        self.assertEqual(got["id"], row["id"])

    def test_fallback_waits_for_exhaustion_then_routes(self):
        row = _key_row(1)
        sub = _sub_row()
        appsettings.set_apikey_fallback_enabled("claude", True)
        self.assertIsNone(supervisor.apikey_route_for("opus", NOW))
        registry.record_mark(sub["id"], "opus", NOW + 3600, now=NOW)
        got = supervisor.apikey_route_for("opus", NOW)
        self.assertEqual(got["id"], row["id"])

    def test_shut_lane_and_foreign_tier_answer_none(self):
        row = _key_row(1)
        appsettings.set_subscription_inference_enabled("claude", False)
        registry.record_mark(row["id"], "opus", NOW + 3600, now=NOW)
        self.assertIsNone(supervisor.apikey_route_for("opus", NOW))
        self.assertIsNone(supervisor.apikey_route_for("astra", NOW))


class SpawnEnvTests(unittest.TestCase):
    def setUp(self):
        _fresh()

    def test_metered_branch_injects_key_and_marker(self):
        row = _key_row(1)
        appsettings.set_subscription_inference_enabled("claude", False)
        env = supervisor.spawn_env(_org("mk-a"), tier="opus", nid="root")
        self.assertEqual(env[registry.MARKER], row["id"])
        self.assertEqual(env["ANTHROPIC_API_KEY"],
                         tokens.get(row["credential"]["token_ref"]))
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env)

    def test_default_toggles_change_no_legacy_lane(self):
        _key_row(1)                       # present but not consented to
        org = _org("mk-b")
        org.d["api_key"] = "ORGKEY"
        env = supervisor.spawn_env(org, tier="opus", nid="root")
        self.assertEqual(env["ANTHROPIC_API_KEY"], "ORGKEY")   # V1 unchanged
        self.assertNotIn(registry.MARKER, env)

    def test_subscription_off_refusals_for_admission_to_hold(self):
        appsettings.set_subscription_inference_enabled("claude", False)
        with self.assertRaises(RuntimeError):             # shut lane, unbound
            supervisor.spawn_env(_org("mk-c"), tier="opus", nid="root")
        appsettings.set_subscription_inference_enabled("claude", True)
        sub = _sub_row()
        appsettings.set_subscription_inference_enabled("claude", False)
        with self.assertRaises(RuntimeError):             # bound subscription
            supervisor.spawn_env(_org("mk-d", account=sub["id"]),
                                 tier="opus", nid="root")
        # a node bound to an APIKEY row still runs with subscription off
        key = _key_row(2)
        env = supervisor.spawn_env(_org("mk-e", account=key["id"]),
                                   tier="opus", nid="root")
        self.assertEqual(env[registry.MARKER], key["id"])

    def test_fallback_on_exhausted_routes_unbound_spawn(self):
        row = _key_row(1)
        sub = _sub_row()
        appsettings.set_apikey_fallback_enabled("claude", True)
        env = supervisor.spawn_env(_org("mk-f"), tier="opus", nid="root")
        self.assertNotIn(registry.MARKER, env)            # capacity remains
        registry.record_mark(sub["id"], "opus", NOW + 3600)
        env = supervisor.spawn_env(_org("mk-g"), tier="opus", nid="root")
        self.assertEqual(env[registry.MARKER], row["id"])


if __name__ == "__main__":
    unittest.main()
