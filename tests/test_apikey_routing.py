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
    accounts, apikey_accounts, appsettings, ledger, providers, registry,
    supervisor, tokens)

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

    def test_dead_credential_is_skipped_but_unobserved_still_serves(self):
        """(h) failure catalogue: an OBSERVED-dead key never holds the lane.

        A revoked or mistyped key — and a cutover row whose secret no longer
        exists — carries `auth == "unauthenticated"`. Left in list order it
        would take every metered turn and fail each one while a healthy key
        waited behind it. `unobserved` is the state a freshly pasted key is
        in and must keep serving, so the two are pinned together here: the
        skip is of a VERDICT, not of missing evidence.
        """
        r1, r2 = _key_row(1), _key_row(2)
        self.assertEqual(registry.get_account(r1["id"])["auth"], "unobserved")
        self.assertEqual(supervisor.apikey_lane_row("claude", "opus", NOW)["id"],
                         r1["id"])            # unobserved is eligible
        registry.set_auth(r1["id"], "unauthenticated")
        self.assertEqual(supervisor.apikey_lane_row("claude", "opus", NOW)["id"],
                         r2["id"])            # dead key → the next one
        registry.set_auth(r2["id"], "unauthenticated")
        # every key dead is a SHUT lane, not a silent retry on a dead row
        self.assertIsNone(supervisor.apikey_lane_row("claude", "opus", NOW))
        registry.set_auth(r2["id"], "authenticated")
        self.assertEqual(supervisor.apikey_lane_row("claude", "opus", NOW)["id"],
                         r2["id"])            # and it comes back when it heals


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

    def test_default_toggles_route_nothing_and_v1_field_is_inert(self):
        _key_row(1)                       # present but not consented to
        org = _org("mk-b")
        org.d["api_key"] = "ORGKEY"       # stale V1 field (cutover missed)
        env = supervisor.spawn_env(org, tier="opus", nid="root")
        self.assertNotIn("ANTHROPIC_API_KEY", env)   # V1 lane removed
        self.assertNotIn(registry.MARKER, env)       # and no unconsented row

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


class AttributionTests(unittest.TestCase):
    """Stage (c2): served-row classification, spend banking, keepalive TTL
    and the board lane label. The auto-resume fast-wake branch replicates
    apikey_route_for (pinned above) over a freeze record and is exercised by
    the integration pass in stage (h)."""

    def setUp(self):
        _fresh()

    def test_served_metered_row_answers_rows_only(self):
        row = _key_row(1)
        self.assertEqual(supervisor.served_metered_row(row["id"])["id"],
                         row["id"])
        sub = _sub_row()
        self.assertIsNone(supervisor.served_metered_row(sub["id"]))
        for label in ("", "api-key", "key:unattributed", "no-such-row"):
            self.assertIsNone(supervisor.served_metered_row(label))

    def test_bank_api_cost_feeds_row_spend(self):
        row = _key_row(1)
        org = _org("bank-a")
        supervisor._bank_api_cost(org, 0.5, served=row["id"])
        supervisor._bank_api_cost(org, 0.25, served="")        # V1 shape
        self.assertAlmostEqual(org.d["api_cost_usd"], 0.75)
        spend = registry.spend_of(registry.get_account(row["id"]))
        self.assertAlmostEqual(spend["usd_total"], 0.5)
        self.assertEqual(spend["turns"], 1)

    def test_served_for_banking_reads_captured_attribution(self):
        row = _key_row(1)
        st = supervisor.state("bank-b", "root")
        st["ran_as"] = row["id"]
        self.assertEqual(supervisor._served_for_banking("bank-b", "root"),
                         row["id"])
        st["ran_as"] = "primary"
        self.assertEqual(supervisor._served_for_banking("bank-b", "root"), "")

    def test_working_cache_interval_keys_off_the_next_lane(self):
        row = _key_row(1)
        org = _org("ttl-a")
        with patch.object(supervisor, "_reported_working", return_value=True):
            cadence, billed = supervisor._working_cache_interval(org, "root")
            self.assertFalse(billed)                     # defaults: subscription
            self.assertEqual(cadence, supervisor.WORKING_CACHE_SUBSCRIPTION_S)
            org.nodes["root"]["account"] = row["id"]     # bound to a key row
            cadence, billed = supervisor._working_cache_interval(org, "root")
            self.assertTrue(billed)
            self.assertEqual(cadence, supervisor.WORKING_CACHE_API_KEY_S)
            del org.nodes["root"]["account"]             # unbound, routed lane
            appsettings.set_subscription_inference_enabled("claude", False)
            cadence, billed = supervisor._working_cache_interval(org, "root")
            self.assertTrue(billed)
            self.assertEqual(cadence, supervisor.WORKING_CACHE_API_KEY_S)

    def test_turn_usage_selection_names_the_account_lane(self):
        _key_row(1)
        org = _org("lane-a")
        appsettings.set_subscription_inference_enabled("claude", False)
        provider, lane = supervisor._turn_usage_selection(org, "root",
                                                          time.time())
        self.assertEqual((provider, lane), ("claude", "account"))


if __name__ == "__main__":
    unittest.main()


class ProviderScopeTests(unittest.TestCase):
    """The two switches must act for the provider the TIER belongs to.

    Both were Claude-only while the UI already offered Codex the same
    controls, so an operator could turn OpenAI fallback on, or OpenAI and
    Antigravity subscription inference off, and the engine would carry on
    exactly as before. A switch that silently does nothing is worse than an
    absent one, because the machine looks like it consented.
    """

    def setUp(self):
        _fresh()

    def _openai_key(self, n=1):
        row, _ = apikey_accounts.register(
            'openai', 'sk-proj-' + 'o' * 40 + str(n))
        return registry.get_account(row['id'])

    def _openai_sub(self):
        row = registry.create_account(
            'openai', 'codex profile',
            {'kind': 'managed',
             'path': os.path.join(_root, f'cx{time.time_ns()}')})
        return registry.get_account(row['id'])

    def test_openai_route_obeys_its_own_toggles_not_claudes(self):
        key = self._openai_key()
        self._openai_sub()
        tier = 'terra'
        self.assertEqual(providers.provider_of(tier), 'openai')
        # defaults: fallback off, inference on -> the subscription serves
        self.assertIsNone(supervisor.apikey_route_for(tier, NOW))
        # flipping CLAUDE must not move the codex lane
        appsettings.set_apikey_fallback_enabled('claude', True)
        appsettings.set_subscription_inference_enabled('claude', False)
        self.assertIsNone(supervisor.apikey_route_for(tier, NOW))
        # its own fallback consent still waits for exhaustion
        appsettings.set_apikey_fallback_enabled('openai', True)
        self.assertIsNone(supervisor.apikey_route_for(tier, NOW))

    def test_openai_fallback_routes_once_its_subscriptions_are_out(self):
        key = self._openai_key()
        sub = self._openai_sub()
        tier = 'terra'
        appsettings.set_apikey_fallback_enabled('openai', True)
        self.assertIsNone(supervisor.apikey_route_for(tier, NOW))
        registry.record_mark(sub['id'], tier, NOW + 3600, now=NOW)
        got = supervisor.apikey_route_for(tier, NOW)
        self.assertIsNotNone(got)
        self.assertEqual(got['id'], key['id'])

    def test_openai_inference_off_routes_every_codex_turn_to_the_key(self):
        key = self._openai_key()
        self._openai_sub()                      # healthy, and irrelevant now
        appsettings.set_subscription_inference_enabled('openai', False)
        got = supervisor.apikey_route_for('terra', NOW)
        self.assertIsNotNone(got)
        self.assertEqual(got['id'], key['id'])

    def test_google_has_no_key_route_at_all(self):
        appsettings.set_subscription_inference_enabled('google', False)
        self.assertIsNone(supervisor.apikey_route_for('flash', NOW))
        with self.assertRaises(ValueError):
            appsettings.set_apikey_fallback_enabled('google', True)

    def test_claude_env_never_receives_an_openai_key_row(self):
        # spawn_env builds an ANTHROPIC process: asking the shared router
        # without the Anthropic axis would inject the wrong provider.
        self._openai_key()
        appsettings.set_subscription_inference_enabled('openai', False)
        org = _org('cross-lane')
        env = supervisor.spawn_env(org, 'terra', 'root')
        self.assertNotIn(registry.MARKER, env)
        self.assertNotIn('ANTHROPIC_API_KEY', env)


class CodexSpawnGateTests(unittest.TestCase):
    """codex_bound_home is the ONE place a codex spawn picks its home, so it
    is where both OpenAI switches have to bite. Before this, an unbound
    codex node fell straight through to the ambient ~/.codex login: the
    disable did not disable, and the fallback had nothing to route to.
    """

    def setUp(self):
        _fresh()

    def _key(self):
        row, _ = apikey_accounts.register(
            'openai', 'sk-proj-' + 'k' * 44)
        return registry.get_account(row['id'])

    def _sub(self):
        row = registry.create_account(
            'openai', 'codex profile',
            {'kind': 'managed',
             'path': os.path.join(_root, f'cxs{time.time_ns()}')})
        return registry.get_account(row['id'])

    def _codex_org(self, slug, account=None):
        org = ledger.Org.create(slug)
        org.nodes['root'] = {'state': 'live', 'parent': None,
                            'generation': 1, 'model': 'terra'}
        if account:
            org.nodes['root']['account'] = account
        return org

    def test_unbound_stays_ambient_by_default(self):
        self._key()
        org = self._codex_org('cx-default')
        self.assertEqual(supervisor.codex_bound_home(org, 'root'), ('', ''))

    def test_unbound_routes_to_the_key_home_when_inference_is_off(self):
        key = self._key()
        appsettings.set_subscription_inference_enabled('openai', False)
        org = self._codex_org('cx-keyonly')
        home, acct = supervisor.codex_bound_home(org, 'root')
        self.assertEqual(acct, key['id'])
        self.assertEqual(home, key['credential']['path'])

    def test_inference_off_with_no_usable_key_refuses_instead_of_spending(self):
        key = self._key()
        registry.set_enabled(key['id'], False)      # the only key, switched off
        appsettings.set_subscription_inference_enabled('openai', False)
        org = self._codex_org('cx-shut')
        with self.assertRaises(RuntimeError) as cm:
            supervisor.codex_bound_home(org, 'root')
        self.assertIn('subscription inference is disabled', str(cm.exception))

    def test_bound_subscription_is_refused_not_silently_rerouted(self):
        self._key()
        sub = self._sub()
        appsettings.set_subscription_inference_enabled('openai', False)
        org = self._codex_org('cx-bound', account=sub['id'])
        with self.assertRaises(RuntimeError) as cm:
            supervisor.codex_bound_home(org, 'root')
        self.assertIn('rebind', str(cm.exception))

    def test_bound_key_account_still_runs_with_inference_off(self):
        key = self._key()
        appsettings.set_subscription_inference_enabled('openai', False)
        org = self._codex_org('cx-boundkey', account=key['id'])
        home, acct = supervisor.codex_bound_home(org, 'root')
        self.assertEqual(acct, key['id'])
        self.assertEqual(home, key['credential']['path'])

    def test_fallback_consent_routes_an_unbound_node_once_exhausted(self):
        key = self._key()
        sub = self._sub()
        appsettings.set_apikey_fallback_enabled('openai', True)
        org = self._codex_org('cx-fb')
        self.assertEqual(supervisor.codex_bound_home(org, 'root'), ('', ''))
        registry.record_mark(sub['id'], 'terra', time.time() + 3600)
        home, acct = supervisor.codex_bound_home(org, 'root')
        self.assertEqual(acct, key['id'])


class GoogleInferenceGateTests(unittest.TestCase):
    """Antigravity has no API-key lane (no such login exists, measured
    1.1.24), so for Google the subscription switch is absolute: turning it
    off must stop the provider rather than quietly keep using the very
    login it was turned off for. The guard sits at the antigravity leg,
    which is that provider's only spawn seam.
    """

    def setUp(self):
        _fresh()

    def _agy_org(self, slug):
        org = ledger.Org.create(slug)
        org.nodes['root'] = {'state': 'live', 'parent': None,
                            'generation': 1, 'model': 'flash'}
        return org

    def _run(self, org):
        return supervisor._antigravity_leg(
            org.d['slug'], 'root', org, {}, 'hello', [])

    def test_disabled_google_inference_refuses_the_turn(self):
        installed = {'installed': True, 'path': 'agy', 'connected': True}
        org = self._agy_org('agy-off')
        appsettings.set_subscription_inference_enabled('google', False)
        with patch.object(providers, 'antigravity_status',
                          return_value=installed):
            with self.assertRaises(RuntimeError) as cm:
                self._run(org)
        self.assertIn('subscription inference is disabled',
                      str(cm.exception))
        # and it says WHY there is no fallback, so the reader is not left
        # hunting for an API-key option that does not exist
        self.assertIn('no API-key account lane', str(cm.exception))

    def test_enabled_google_inference_passes_this_gate(self):
        installed = {'installed': True, 'path': 'agy', 'connected': True}
        org = self._agy_org('agy-on')
        with patch.object(providers, 'antigravity_status',
                          return_value=installed):
            try:
                self._run(org)
            except RuntimeError as e:
                # it fails later for unrelated fixture reasons; what matters
                # is that it is NOT stopped by the inference gate
                self.assertNotIn('subscription inference is disabled',
                                 str(e))
            except Exception:                                # noqa: BLE001
                pass
