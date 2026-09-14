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
        self.assertFalse(card["active"])

    def test_idle_codex_secondary_card_uses_immutable_configured_id(self):
        self._row("openai", "host", auth="unobserved")
        second = self._row("openai", "secondary", auth="authenticated")
        card = self._card(None, busy=False, configured=second["id"], provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
        self.assertFalse(card["active"])

    def test_busy_codex_runtime_identity_overrides_configured_binding(self):
        host = self._row("openai", "host", auth="unobserved")
        second = self._row("openai", "secondary", auth="authenticated")
        card = self._card(second["id"], busy=True, configured=host["id"], provider="openai")
        self.assertIsNotNone(card)
        assert card is not None
        self.assertEqual(card["id"], second["id"])
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
            set(card), {"id", "provider", "label", "email", "auth", "state", "active"})
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
