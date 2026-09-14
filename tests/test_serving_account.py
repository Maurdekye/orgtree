"""WHICH ACCOUNT IS SERVING THE INFERENCE RUNNING RIGHT NOW — the backend
gates (user requirement 2026-09-13, docket `show-the-active-inference-account`).

With several accounts signed in on one provider, nothing said which of them an
agent's current turn was actually running on. `accountusage.serving_card`
answers that, and it is composed server-side for the reason `ran_as_label` and
`codex_route.label` are: the backend owns the registry, so a renderer counting
available accounts itself would be a SECOND definition of "available" to drift
from this one.

Everything worth getting wrong is a gate, so every gate is tested in BOTH
polarities — a rule that answered a constant could not pass any of these.

⚠ THE CASE THIS FILE EXISTS FOR is `test_env_mismatch_is_not_an_answer`.
`identity_in_env` emits `account-env-mismatch:<id>` when a spawn's account
marker and its profile variable disagree, and its own docstring says answering
the marker there "would turn a mis-paired spawn into a CONFIDENT wrong
attribution". That string CONTAINS a real account id, so the naive resolution
produces a confident answer that is exactly backwards. It must read as
unknown.
"""
import os
import tempfile
import unittest


class ServingAccountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-servingacct-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import accountusage, registry, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.au = accountusage
        cls.registry = registry

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    # ---------------------------------------------------------------- helpers
    def _row(self, provider, label, *, auth="authenticated", kind="managed",
             enabled=None, mode=None, email=None):
        row = self.registry.create_account(
            provider, label,
            {"kind": kind, "path": os.path.join(self.root, provider + label)}
            if kind != "token" else {"kind": "token", "token_ref": label})
        doc = self.registry.load(strict=True)
        stored = self.registry.get_account(row["id"], doc)
        stored["auth"] = auth
        if mode is not None:
            stored["mode"] = mode
        if enabled is not None:
            stored["enabled"] = enabled
        if email is not None:
            stored["identity"] = {"email": email}
        self.registry.save(doc)
        return self.registry.get_account(row["id"])

    def _rows(self):
        rows = self.registry.list_accounts()
        return rows, {r["id"]: r for r in rows}

    def _card(self, ran_as, *, busy=True, public=False, primary="primary",
              ambient=None, configured=None, provider=None):
        rows, by_id = self._rows()
        return self.au.serving_card(
            ran_as, busy=busy, public=public, rows_by_id=by_id,
            counts=self.au.available_counts(rows), primary=primary,
            ambient_paths=ambient or {"claude": None, "openai": None, "google": None},
            configured_account=configured,
            registered=self.au.registered_counts(rows), provider=provider)

    # ------------------------------------------------------- the plurality gate
    def test_two_signed_in_accounts_produce_a_card(self):
        a = self._row("claude", "one", email="one@example.test")
        self._row("claude", "two")
        card = self._card(a["id"])
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], a["id"])
        self.assertEqual(card["provider"], "claude")
        self.assertEqual(card["email"], "one@example.test")
        self.assertEqual(card["auth"], "authenticated")
        self.assertEqual(card["state"], "ready")
        self.assertTrue(card["active"])

    def test_a_single_signed_in_account_produces_nothing(self):
        # nothing to disambiguate: the card would be pure noise
        a = self._row("claude", "only")
        self.assertIsNone(self._card(a["id"]))

    def test_plurality_is_per_provider_not_machine_wide(self):
        # THE INTERESTING SHAPE. Two providers, one account each. Machine-wide
        # there are two accounts; for the serving provider there is one, and
        # the count that matters is the serving provider's.
        a = self._row("claude", "solo")
        self._row("openai", "solo")
        self.assertIsNone(self._card(a["id"]))
        # …and adding a SECOND claude turns the same call on
        self._row("claude", "second")
        self.assertIsNotNone(self._card(a["id"]))

    def test_an_observed_signed_out_row_is_not_available(self):
        # `unauthenticated` is PROOF the account cannot serve — somebody
        # looked, and it is signed out. That one excludes.
        a = self._row("claude", "live")
        self._row("claude", "signed-out", auth="unauthenticated")
        self.assertIsNone(self._card(a["id"]))
        self._row("claude", "second-live")
        self.assertIsNotNone(self._card(a["id"]))

    def test_unobserved_is_uncertainty_and_still_counts(self):
        # ⚠ THE CORRECTION (coordinator 2026-09-13 17:21Z), and the bug it
        # caught: requiring `authenticated` here read "nobody has looked" as
        # "the account is gone" and deleted the card on a provider that really
        # does have two usable accounts.
        #
        # THIS IS THE OPERATOR'S OWN MACHINE, as a fixture: `openai/primary`
        # sits at auth=unobserved / state=ready beside a second usable Codex
        # account, and it serves turns. `standing_of` says `unobserved`
        # "gates nothing" — so it must not gate this either.
        primary = self._row("openai", "host", auth="unobserved")
        second = self._row("openai", "secondary", auth="authenticated",
                           email="codex-2@example.test")
        counts = self.au.available_counts(self.registry.list_accounts())
        self.assertEqual(counts.get("openai"), 2,
                         "an unobserved-but-enabled account was not counted")
        # …and the card appears, for EITHER of them serving
        card = self._card(second["id"])
        self.assertIsNotNone(card, "no card despite two available Codex accounts")
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        host_card = self._card(primary["id"])
        self.assertIsNotNone(host_card)
        assert host_card is not None
        # the uncertainty is REPORTED rather than smoothed into "ready"
        self.assertEqual(host_card["auth"], "unobserved")
        self.assertEqual(host_card["state"], "ready")

    def test_codex_primary_serving_row_uses_the_codex_ambient_identity(self):
        # `ran_as == "primary"` is provider-relative.  The registry alias
        # named `primary` is Claude-only, so resolving it without the node's
        # provider made a live Codex primary turn look up a Claude row and
        # disappear behind the plurality gate.
        host = self._row("openai", "host", auth="unobserved")
        self._row("openai", "secondary", auth="authenticated")
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        rows, by_id = self._rows()
        card = self.au.serving_card(
            "primary", busy=True, public=False, rows_by_id=by_id,
            counts=self.au.available_counts(rows), primary="not-the-host",
            ambient_paths=ambient, provider="openai")
        self.assertIsNotNone(card, "Codex primary turn lost its serving card")
        assert card is not None
        self.assertEqual(card["id"], "openai/primary")
        self.assertEqual(card["display"], "default")
        self.assertEqual(card["provider"], "openai")
        self.assertTrue(card["active"])

    def test_idle_codex_primary_card_uses_ambient_configured_identity(self):
        host = self._row("openai", "host", auth="unobserved")
        self._row("openai", "secondary", auth="authenticated")
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        card = self._card(None, busy=False, configured="primary", provider="openai",
                          primary="not-the-host", ambient=ambient)
        self.assertIsNotNone(card, "idle Codex primary binding was hidden")
        assert card is not None
        self.assertEqual(card["id"], "openai/primary")
        self.assertEqual(card["display"], "default")
        self.assertFalse(card["active"])

    def test_unregistered_codex_ambient_identity_counts_with_managed_row(self):
        # Installed RC2 shape: the registry has only openai-1 while the host
        # login is represented by the ambient Codex home, not a registry row.
        managed = self._row("openai", "secondary", auth="authenticated")
        rows, _ = self._rows()
        ambient = {"claude": None, "openai": os.path.join(self.root, "codex-home"),
                   "google": None}
        by_id = self.au.rows_for_cards(
            rows, "primary", ambient, host_metadata={"openai": {"email": None}})
        self.assertEqual(set(by_id), {managed["id"], "openai/primary"})
        card = self.au.serving_card(
            None, busy=False, public=False, rows_by_id=by_id,
            counts=self.au.available_counts(list(by_id.values())),
            registered=self.au.registered_counts(list(by_id.values())),
            configured_account="primary", primary="primary",
            ambient_paths=ambient, provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], "openai/primary")
        self.assertEqual(card["display"], "default")
        self.assertFalse(card["active"])
        self.assertNotIn(ambient["openai"], repr(card))

    def test_api_tree_accepts_explicit_codex_primary_binding(self):
        # The ambient card row is card-only: it has no registry tint ordinal.
        # An explicitly primary-bound node must still pass the full API tree
        # annotation path without trying to tint that synthetic row.
        from types import SimpleNamespace
        from unittest.mock import patch
        from engine.backend.orgtree import api, ledger, registry_migration, store

        managed = self._row("openai", "secondary", auth="authenticated")
        ambient = {"claude": None,
                   "openai": os.path.join(self.root, "codex-home"),
                   "google": None}
        org = ledger.Org.create("serving-card-primary-binding")
        hired = org.hire(ledger.USER, None, "luna", 0, "primary-codex")
        org.node(hired["node"])["account"] = "openai/primary"
        store.save_org(org)
        request = SimpleNamespace(
            state=SimpleNamespace(), headers={},
            url=SimpleNamespace(path="/api/orgs/serving-card-primary-binding"))
        with patch.object(registry_migration, "observe_ambient",
                          return_value=ambient):
            tree = api.org_tree("serving-card-primary-binding", request)
        node = tree["roots"][0]
        self.assertEqual(node["account"], "openai/primary")
        self.assertEqual(node["serving_account"]["id"], "openai/primary")
        self.assertFalse(node["serving_account"]["active"])

    def test_openai_apikey_card_uses_only_the_first_eight_key_characters(self):
        from engine.backend.orgtree import tokens

        key = "sk-live-account-key-never-render-the-rest"
        ref = "fixture-key-prefix"
        tokens.put(ref, key)
        api_row = self.registry.create_account(
            "openai", "metered", {"kind": "apikey", "token_ref": ref},
            mode="apikey")
        self._row("openai", "subscription", auth="unobserved")
        card = self._card(api_row["id"], provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["display"], key[:8])
        self.assertNotIn(key, repr(card))
        self.assertNotIn(ref, repr(card))
        self.assertNotIn("openai/", repr(card))
        self.assertNotIn("primary", repr(card))
        idle = self._card(None, busy=False, configured=api_row["id"],
                          provider="openai")
        self.assertIsNotNone(idle)
        assert idle is not None
        self.assertEqual(idle["display"], key[:8])
        self.assertFalse(idle["active"])

    # ------------------------------------- the provider-generic Claude card
    # (user requirement 2026-09-14: the live Fable agent had NO card beside
    # two registered Claude accounts, because the all-agent branch was
    # Codex-only. The same contract now holds for every provider.)
    def test_claude_primary_serving_row_uses_the_claude_ambient_identity(self):
        host = self._row("claude", "host", auth="unobserved")
        self._row("claude", "secondary", auth="authenticated")
        ambient = {"claude": host["credential"]["path"], "openai": None,
                   "google": None}
        rows, by_id = self._rows()
        card = self.au.serving_card(
            "primary", busy=True, public=False, rows_by_id=by_id,
            counts=self.au.available_counts(rows), primary="not-the-host",
            ambient_paths=ambient, provider="claude")
        self.assertIsNotNone(card, "Claude primary turn lost its serving card")
        assert card is not None
        self.assertEqual(card["id"], "claude/primary")
        self.assertEqual(card["display"], "default")
        self.assertEqual(card["provider"], "claude")
        self.assertTrue(card["active"])
        self.assertIsNone(card["label"])

    def test_idle_claude_primary_card_uses_ambient_configured_identity(self):
        host = self._row("claude", "host", auth="unobserved")
        self._row("claude", "secondary", auth="authenticated")
        ambient = {"claude": host["credential"]["path"], "openai": None,
                   "google": None}
        card = self._card(None, busy=False, configured="primary", provider="claude",
                          primary="not-the-host", ambient=ambient)
        self.assertIsNotNone(card, "idle Claude primary binding was hidden")
        assert card is not None
        self.assertEqual(card["id"], "claude/primary")
        self.assertEqual(card["display"], "default")
        self.assertFalse(card["active"])
        # Neither the provider-qualified selector nor the bare word `primary`
        # may be the visible token, and the label may not smuggle them back.
        self.assertNotIn("claude/", card["display"])
        self.assertNotEqual(card["display"], "primary")
        self.assertIsNone(card["label"])

    def test_idle_claude_secondary_card_uses_immutable_configured_id(self):
        self._row("claude", "host", auth="unobserved")
        second = self._row("claude", "secondary", auth="authenticated")
        card = self._card(None, busy=False, configured=second["id"], provider="claude")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        self.assertEqual(card["display"], second["id"])
        self.assertFalse(card["active"])

    def test_busy_claude_runtime_identity_overrides_configured_binding(self):
        host = self._row("claude", "host", auth="unobserved")
        second = self._row("claude", "secondary", auth="authenticated")
        card = self._card(second["id"], busy=True, configured=host["id"], provider="claude")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        self.assertEqual(card["display"], second["id"])
        self.assertTrue(card["active"])

    def test_claude_single_registered_account_stays_hidden_when_idle(self):
        host = self._row("claude", "host", auth="unobserved")
        ambient = {"claude": host["credential"]["path"], "openai": None,
                   "google": None}
        self.assertIsNone(self._card(None, busy=False, configured="primary",
                                     provider="claude", ambient=ambient))

    def test_claude_card_uses_registered_not_available_plurality(self):
        host = self._row("claude", "host", auth="unobserved")
        self._row("claude", "signed-out", auth="unauthenticated")
        ambient = {"claude": host["credential"]["path"], "openai": None,
                   "google": None}
        card = self._card(None, busy=False, configured="primary", provider="claude",
                          primary="primary", ambient=ambient)
        # Two registered identities, one currently observed usable: the
        # all-agent card distinguishes identities, same as the Codex rule.
        self.assertIsNotNone(card)

    def test_unregistered_claude_ambient_identity_counts_with_managed_row(self):
        # The operator's live shape: one managed secondary in the registry,
        # the host login present only as the ambient Claude home.
        managed = self._row("claude", "secondary", auth="authenticated")
        rows, _ = self._rows()
        ambient = {"claude": os.path.join(self.root, "claude-home"),
                   "openai": None, "google": None}
        by_id = self.au.rows_for_cards(
            rows, "primary", ambient, host_metadata={"claude": {"email": None}})
        self.assertEqual(set(by_id), {managed["id"], "claude/primary"})
        card = self.au.serving_card(
            None, busy=False, public=False, rows_by_id=by_id,
            counts=self.au.available_counts(list(by_id.values())),
            registered=self.au.registered_counts(list(by_id.values())),
            configured_account="primary", primary="primary",
            ambient_paths=ambient, provider="claude")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], "claude/primary")
        self.assertEqual(card["display"], "default")
        self.assertFalse(card["active"])
        self.assertNotIn(ambient["claude"], repr(card))

    def test_claude_apikey_card_uses_only_the_first_eight_key_characters(self):
        from engine.backend.orgtree import tokens

        key = "sk-ant-account-key-never-render-the-rest"
        ref = "fixture-claude-key-prefix"
        tokens.put(ref, key)
        api_row = self.registry.create_account(
            "claude", "metered", {"kind": "apikey", "token_ref": ref},
            mode="apikey")
        self._row("claude", "subscription", auth="unobserved")
        card = self._card(api_row["id"], provider="claude")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["display"], key[:8])
        self.assertNotIn(key, repr(card))
        self.assertNotIn(ref, repr(card))
        self.assertNotIn("claude/", repr(card))
        self.assertNotIn("primary", repr(card))
        idle = self._card(None, busy=False, configured=api_row["id"],
                          provider="claude")
        self.assertIsNotNone(idle)
        assert idle is not None
        self.assertEqual(idle["display"], key[:8])
        self.assertFalse(idle["active"])

    def test_idle_codex_secondary_card_uses_immutable_configured_id(self):
        self._row("openai", "host", auth="unobserved")
        second = self._row("openai", "secondary", auth="authenticated")
        card = self._card(None, busy=False, configured=second["id"], provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        self.assertEqual(card["display"], second["id"])
        self.assertFalse(card["active"])

    def test_busy_codex_runtime_identity_overrides_configured_binding(self):
        host = self._row("openai", "host", auth="unobserved")
        second = self._row("openai", "secondary", auth="authenticated")
        card = self._card(second["id"], busy=True, configured=host["id"], provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        self.assertEqual(card["display"], second["id"])
        self.assertTrue(card["active"])

    def test_idle_codex_unknown_binding_is_hidden(self):
        self._row("openai", "host", auth="unobserved")
        self._row("openai", "secondary", auth="authenticated")
        self.assertIsNone(self._card(None, busy=False, configured="missing:gone",
                                     provider="openai"))

    def test_busy_codex_unknown_runtime_does_not_fall_back_to_configured(self):
        host = self._row("openai", "host", auth="unobserved")
        self._row("openai", "secondary", auth="authenticated")
        self.assertIsNone(self._card("account-env-mismatch:wrong", busy=True,
                                     configured=host["id"], provider="openai"))

    def test_codex_card_uses_registered_not_available_plurality(self):
        host = self._row("openai", "host", auth="unobserved")
        self._row("openai", "signed-out", auth="unauthenticated")
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        card = self._card(None, busy=False, configured="primary", provider="openai",
                          primary="primary", ambient=ambient)
        # There are two registered identities even though only one is currently
        # observed as usable; the all-agent card distinguishes identities.
        self.assertIsNotNone(card)

    def test_codex_single_registered_account_stays_hidden_when_idle(self):
        host = self._row("openai", "host", auth="unobserved")
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        self.assertIsNone(self._card(None, busy=False, configured="primary",
                                     provider="openai", ambient=ambient))

    # ------------------------------ the codex lane's runtime attribution
    # (user report 2026-09-14, reopened `show-codex-account-ids-on-every-agent`:
    # claude agents wore account cards and codex agents wore none. The card
    # composition was sound — see the idle tests above, which pass on the
    # installed registry shape. What was missing is the OTHER half of the
    # contract: a BUSY node must name its runtime account authoritatively or
    # stay hidden, and the codex leg recorded no `ran_as` at all, so every
    # codex agent lost its card for exactly as long as it was mid-turn.)
    def test_codex_spawn_identity_is_read_off_the_frozen_process_spec(self):
        from engine.backend.orgtree import accounts, supervisor
        bound = self._row("openai", "secondary")
        # the shape `_codex_process_spec` returns: the marker is injected
        # beside the profile home by the codex lane's single injector
        self.assertEqual(
            supervisor.identity_in_spec(
                {"env_extra": {self.registry.MARKER: bound["id"]},
                 "codex_home": bound["credential"]["path"]}),
            bound["id"])
        # …and an UNBOUND node is on the ambient machine login, which owns no
        # registry row and is named exactly as the claude lane names its own
        for spec in ({"env_extra": {}}, {"env_extra": {self.registry.MARKER: ""}},
                     {}):
            self.assertEqual(supervisor.identity_in_spec(spec), accounts.PRIMARY)

    def test_codex_leg_captures_ran_as_before_it_does_anything_else(self):
        # ⚠ THE WIRING, not just the helper. The capture must happen inside
        # the codex leg — the claude lane's own capture sits beyond the
        # provider seam that sent this turn here — and it must happen BEFORE
        # the leg can fail, so a turn that dies still says what it ran as.
        # `codex_bound_home` is the next call after it, so stopping there
        # proves the ordering as well as the value.
        from unittest.mock import patch

        from engine.backend.orgtree import ledger, store, supervisor

        host = self._row("openai", "host", auth="unobserved")
        bound = self._row("openai", "secondary")
        org = ledger.Org.create("codex-leg-ran-as")
        hired = org.hire(ledger.USER, None, "luna", 0, "codex-worker")
        nid = hired["node"]
        org.node(nid)["account"] = bound["id"]
        store.save_org(org)

        class _Stop(Exception):
            pass

        manifest = {"provider_spec": {
            "env_extra": {self.registry.MARKER: bound["id"]},
            "cwd": self.root, "identity": "ident",
            "config_overrides": [], "port": "7360",
            "codex_home": bound["credential"]["path"]}}
        st: dict[str, object] = {}
        with patch.object(supervisor, "_codex_require_manifest_account_current"), \
             patch.object(supervisor, "codex_bound_home", side_effect=_Stop):
            with self.assertRaises(_Stop):
                supervisor._codex_leg_attempt(  # pyright: ignore[reportPrivateUsage]
                    "codex-leg-ran-as", nid, org, st, "hello", [],
                    startup_manifest=manifest)
        self.assertEqual(st.get("ran_as"), bound["id"])
        # …and the whole chain in one place: what the leg captured is what the
        # card composes from while the turn runs. Without the capture above
        # this is None — the installed failure exactly.
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        card = self._card(st.get("ran_as"), busy=True, provider="openai",
                          configured=bound["id"], ambient=ambient)
        assert card is not None
        self.assertEqual(card["display"], bound["id"])
        self.assertTrue(card["active"])

    def test_busy_codex_node_wears_the_account_that_served_the_turn(self):
        # the end of the same chain: the captured identity resolves to a row,
        # and the card names it while the turn runs
        host = self._row("openai", "host", auth="unobserved")
        bound = self._row("openai", "secondary")
        ambient = {"claude": None, "openai": host["credential"]["path"],
                   "google": None}
        card = self._card(bound["id"], busy=True, provider="openai",
                          configured=bound["id"], ambient=ambient)
        assert card is not None
        self.assertEqual(card["display"], bound["id"])
        self.assertTrue(card["active"])
        # …and an ambient codex turn, whose captured identity is the same
        # `primary` sentinel the claude lane uses, resolves through its OWN
        # provider rather than disappearing or naming a claude row
        from engine.backend.orgtree import accounts
        ambient_card = self._card(accounts.PRIMARY, busy=True, provider="openai",
                                  configured=None, ambient=ambient)
        assert ambient_card is not None
        self.assertEqual(ambient_card["display"], "default")
        self.assertTrue(ambient_card["active"])

    def test_claude_and_codex_cards_coexist_in_one_org(self):
        # the installed 2.1.4 shape, both providers plural at once: a managed
        # secondary beside an unregistered ambient host login, per provider.
        # One provider's rows must not decide the other's card.
        from types import SimpleNamespace
        from unittest.mock import patch

        from engine.backend.orgtree import (api, ledger, registry_migration,
                                            store, supervisor)

        claude_secondary = self._row("claude", "second")
        codex_secondary = self._row("openai", "second")
        ambient = {"claude": os.path.join(self.root, "claude-home"),
                   "openai": os.path.join(self.root, "codex-home"),
                   "google": None}
        org = ledger.Org.create("mixed-provider-cards")
        seats = {
            "claude-bound": ("opus", claude_secondary["id"]),
            "claude-ambient": ("opus", None),
            "codex-bound": ("luna", codex_secondary["id"]),
            "codex-ambient": ("luna", None),
        }
        ids: dict[str, str] = {}
        for title, (tier, account) in seats.items():
            hired = org.hire(ledger.USER, None, tier, 0, title)
            ids[title] = hired["node"]
            if account:
                org.node(hired["node"])["account"] = account
        store.save_org(org)
        request = SimpleNamespace(state=SimpleNamespace(), headers={},
                                  url=SimpleNamespace(
                                      path="/api/orgs/mixed-provider-cards"))
        # every seat mid-turn, each carrying the identity its own lane
        # captures at spawn — the state the user actually looked at
        running = {
            ids["claude-bound"]: claude_secondary["id"],
            ids["claude-ambient"]: "primary",
            ids["codex-bound"]: codex_secondary["id"],
            ids["codex-ambient"]: "primary",
        }
        real_state = supervisor.state

        def busy_state(slug: str, nid: str) -> dict[str, object]:
            # the real per-node state, with only the two turn facts the lanes
            # capture at spawn overlaid — everything else annotate reads stays
            # exactly what the supervisor answers
            st = dict(real_state(slug, nid))
            st.update(busy=True, ran_as=running.get(nid, ""))
            return st

        with patch.object(registry_migration, "observe_ambient",
                          return_value=ambient), \
             patch.object(supervisor, "state", side_effect=busy_state):
            tree = api.org_tree("mixed-provider-cards", request)

        def walk(nodes):
            for node in nodes:
                yield node
                yield from walk(node.get("children") or [])

        cards = {n["id"]: n.get("serving_account") for n in walk(tree["roots"])}
        for title, expected in (
                ("claude-bound", claude_secondary["id"]),
                ("claude-ambient", "default"),
                ("codex-bound", codex_secondary["id"]),
                ("codex-ambient", "default")):
            card = cards[ids[title]]
            self.assertIsNotNone(card, f"{title} lost its account card")
            assert card is not None
            self.assertEqual(card["display"], expected, title)
            self.assertTrue(card["active"], title)
        self.assertEqual(cards[ids["claude-bound"]]["provider"], "claude")
        self.assertEqual(cards[ids["codex-bound"]]["provider"], "openai")
        # The VISIBLE half of every card — the token and its label detail —
        # never spells a provider-qualified primary or the bare word
        # `primary`, on either provider. (`id` is the canonical API selector
        # and deliberately still carries it, so a reader comparing serving
        # against bound compares like with like.)
        for card in cards.values():
            assert card is not None
            self.assertNotIn("primary", str(card["display"]))
            self.assertNotIn("primary", str(card["label"] or ""))

    def test_a_disabled_key_row_is_not_available(self):
        # a disabled apikey row is skipped by routing, so it cannot serve and
        # must not be counted as a second account
        a = self._row("claude", "live")
        self._row("claude", "off", kind="token", mode="apikey", enabled=False)
        self.assertIsNone(self._card(a["id"]))
        self._row("claude", "on", kind="token", mode="apikey", enabled=True)
        self.assertIsNotNone(self._card(a["id"]))

    def test_a_limited_account_still_counts_and_still_serves(self):
        # ⚠ NOT USAGE CAPACITY. An account that has just gone limited is
        # exactly when knowing who is serving matters most; gating on capacity
        # would delete the card at that moment. `state` reports it instead.
        import time
        a = self._row("claude", "one")
        self._row("claude", "two")
        doc = self.registry.load(strict=True)
        self.registry.get_account(a["id"], doc)["marks"] = {
            "pooled": {"until": time.time() + 3600, "provenance": "observed"}}
        self.registry.save(doc)
        card = self._card(a["id"])
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["state"], "limited")

    # ----------------------------------------------------------- the busy gate
    def test_an_idle_node_gets_no_card_even_carrying_a_real_ran_as(self):
        # `ran_as` OUTLIVES ITS TURN — it is "the turn in flight or the most
        # recent one this process ran". Without the busy gate an idle agent
        # would keep wearing the account that served it an hour ago, which is
        # the stale-state failure `codex_route.live` exists to prevent.
        a = self._row("claude", "one")
        self._row("claude", "two")
        self.assertIsNotNone(self._card(a["id"], busy=True))
        self.assertIsNone(self._card(a["id"], busy=False))

    # ------------------------------------------------------ the authority gate
    def test_env_mismatch_is_not_an_answer(self):
        # THE POINT OF THIS FILE. The sentinel CARRIES a real account id, so a
        # naive resolution answers confidently and wrongly. It must read as
        # "cannot be established authoritatively" instead.
        a = self._row("claude", "one")
        self._row("claude", "two")
        self.assertIsNotNone(self._card(a["id"]))
        self.assertIsNone(self._card(f"account-env-mismatch:{a['id']}"))

    def test_sentinel_lanes_name_no_account(self):
        self._row("claude", "one")
        self._row("claude", "two")
        for sentinel in ("api-key", "key:unattributed", "openrouter"):
            self.assertIsNone(self._card(sentinel), sentinel)

    def test_empty_or_unknown_ran_as_names_no_account(self):
        self._row("claude", "one")
        self._row("claude", "two")
        for value in ("", None, "no-such-account"):
            self.assertIsNone(self._card(value), repr(value))

    def test_the_ambient_login_resolves_through_the_alias_map(self):
        # "primary" is a real, nameable account; it just reaches its row by
        # alias rather than by its own id
        host = self._row("claude", "host")
        self._row("claude", "second")
        self.assertIsNone(self._card("primary", primary="not-an-id"))
        card = self._card("primary", primary=host["id"])
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["provider"], "claude")

    # ------------------------------------------------------- the kiosk gate
    def test_a_kiosk_visitor_is_told_nothing(self):
        # D-145 keeps account identity off the public side. `ran_as_label`
        # drops only its uuid there because the rest is a positional ordinal
        # naming nobody; this card is nothing BUT identity, so all of it goes.
        a = self._row("claude", "one", email="who@example.test")
        self._row("claude", "two")
        self.assertIsNotNone(self._card(a["id"], public=False))
        self.assertIsNone(self._card(a["id"], public=True))

    # ------------------------------------------------------------- no secrets
    def test_the_card_carries_no_credential_material(self):
        a = self._row("claude", "one", email="one@example.test")
        self._row("claude", "two")
        card = self._card(a["id"])
        assert card is not None
        self.assertEqual(
            set(card), {"id", "display", "provider", "label", "email", "auth", "state", "active"})
        # the row's own credential block names a profile path and a token ref;
        # neither may appear anywhere in the composed card
        blob = repr(card)
        self.assertNotIn("credential", blob)
        self.assertNotIn(self.root, blob)
        for value in card.values():
            self.assertNotIn("token", str(value).lower())

    def test_canonical_id_matches_the_bound_account_composer(self):
        # the card's id and `account_label` must be the SAME spelling, so a
        # reader comparing serving against bound compares like with like
        host = self._row("claude", "host")
        self._row("claude", "second")
        ambient = {"claude": None, "openai": None, "google": None}
        rows, by_id = self._rows()
        card = self.au.serving_card(
            host["id"], busy=True, public=False, rows_by_id=by_id,
            counts=self.au.available_counts(rows), primary=host["id"],
            ambient_paths=ambient)
        assert card is not None
        self.assertEqual(
            card["id"],
            self.au.canonical_name(by_id[host["id"]], host["id"], ambient))

    # ---------------------------------------------------------- purity / cost
    def test_serving_row_reads_no_file(self):
        # ⚠ `annotate` runs PER NODE on a 6s heartbeat. A registry load in here
        # is the per-node filesystem work D-239 forbids — the trap
        # `accounts.serving_label` documents having fallen into once already
        # (41 opens for a 41-node org). The resolver takes pre-loaded rows and
        # must touch nothing, so this fails the test if it ever opens a file.
        a = self._row("claude", "one")
        self._row("claude", "two")
        rows, by_id = self._rows()
        counts = self.au.available_counts(rows)
        import builtins
        opened = []
        real_open = builtins.open

        def watched(*args, **kwargs):
            opened.append(args[0] if args else None)
            return real_open(*args, **kwargs)

        builtins.open = watched
        try:
            for _ in range(40):
                self.au.serving_card(
                    a["id"], busy=True, public=False, rows_by_id=by_id,
                    counts=counts, primary="primary",
                    ambient_paths={"claude": None, "openai": None, "google": None})
        finally:
            builtins.open = real_open
        self.assertEqual(opened, [], f"serving_card opened files: {opened[:5]}")


if __name__ == "__main__":
    unittest.main()
