"""What the `Staff…` menu COSTS to build, and what ORDER it comes back in.

⚠ THE DEFECT THIS FILE EXISTS FOR (user report 2026-09-15, after 2.1.5-beta.5).
beta.5 carried the warm staffing cache, and the user confirmed its visible half:
models that cannot be staffed are gone. The other half did not land. The menu
still loaded when it was opened, and the models it did show were in a mixed
order rather than the one the model-switch list shows.

The measurement that found it, on the operator's own organization (576 nodes,
an 80 MB store, sixteen tiers): `tier_block` builds its trial organization with
`copy.deepcopy(org.d)`, and a whole-document walk over `store.LazyDoc`
MATERIALISES every append-only log first — 17.5 MB of `steered_log`, 15.6 MB of
`mail_log`, 6.2 MB of `events`. One copy cost 978 ms. `preview` paid it once
PER TIER, so opening the menu spent 14.2 seconds deep-copying chat history that
a hire never reads. No network was involved at all, which is why moving the
network off the click did not fix it.

§1 proves the logs are not copied, §2 that one trial source serves every tier,
§3 that none of this changed a single verdict, §4 that the trial never reaches
the real document, and §5/§6 the ordering. Each section carries a control,
because every assertion here is the kind that reads green for the wrong reason:
a "not copied" that passes because nothing was copied at all, an "identical
verdicts" that is identical-and-empty, an order that matches because it was
hard-coded to match.
"""
import copy
import os
import pickle
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="staff-cost-", ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN="staff-cost-tests")
from engine.launch import load_app
app, *_ = load_app()
from orgtree import api, appsettings, ledger, quickstaff, staffcache, store

#: A provider document shaped like the real one — the families in the order the
#: model-switch dropdown groups them (Claude, Codex, Antigravity, then the
#: OpenRouter favorites) and, inside each, the order that dropdown lists them.
#: `catalog_order` reads THIS, which is the whole point: the menu's order is the
#: model list's order because it is literally the same sequence.
DOCUMENT = {"providers": [
    {"id": "claude", "hire_enabled": True, "tiers": [
        {"tier": "haiku", "seat": 1}, {"tier": "sonnet", "seat": 2},
        {"tier": "opus", "seat": 5}, {"tier": "fable", "seat": 10}]},
    {"id": "openai", "hire_enabled": True, "tiers": [
        {"tier": "luna", "seat": .2}, {"tier": "terra", "seat": 2},
        {"tier": "sol", "seat": 5}, {"tier": "astra", "seat": 10}]},
    {"id": "google", "hire_enabled": True, "tiers": [
        {"tier": "flash", "seat": 1}, {"tier": "pro", "seat": 2}]},
]}
#: The organization stores its tiers in a DIFFERENT order — this is the shape
#: the user photographed: fable first, the Codex family interleaved, the
#: Antigravity pair in the middle. If the menu simply walked `org.d["tiers"]`
#: this is the order it would print, and that is exactly what it used to do.
SCRAMBLED = {"fable": 10, "opus": 5, "flash": 1, "luna": .2, "haiku": 1,
             "astra": 10, "pro": 2, "sonnet": 2, "terra": 2, "sol": 5}
#: The same tiers in the order `DOCUMENT` lists them.
CATALOG = ["haiku", "sonnet", "opus", "fable", "luna", "terra", "sol", "astra",
           "flash", "pro"]


class LogTouched(Exception):
    """Raised by the tripwire below when an append-only log is copied."""


class Tripwire:
    """An object that cannot be copied or serialised, planted in a log section.

    This is the measurement. A trial document that deep-copies or pickles the
    whole org document walks straight into it; one that leaves the append-only
    logs alone never sees it. It is the defect itself, made into an assertion.
    """

    def __deepcopy__(self, memo):
        raise LogTouched("the trial document deep-copied an append-only log")

    def __reduce__(self):
        raise LogTouched("the trial document serialised an append-only log")


def _org_with_tiers(tiers):
    org = ledger.Org.create("cost-" + uuid.uuid4().hex[:8])
    org.d["tiers"] = dict(tiers)
    first = next(iter(tiers))
    owner = org.hire(ledger.USER, None, first, 40, "manager",
                     add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                         "subagents": False, "mcp": []},
                     org_visibility="self")["node"]
    item = org.work_create(owner, "Repair the widget",
                           "The widget is broken. Repair it.", status="backlogged")["slug"]
    return org, owner, item


class StaffingMenuCostTests(unittest.TestCase):
    """§1-§4 — what building the menu costs."""

    def setUp(self):
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        p = patch.object(api, "_providers_payload", return_value=DOCUMENT)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(staffcache, "_supported_efforts", return_value=["low", "high"])
        p.start(); self.addCleanup(p.stop)
        p = patch.object(api, "provider_hire_gate", return_value=None)
        p.start(); self.addCleanup(p.stop)
        # every tier eligible on one account, so nothing is filtered out for a
        # reason this file is not about
        p = patch.object(staffcache, "tier_accounts", side_effect=lambda snap, org, tier: [
            {"value": "claude/primary", "id": "default", "provider": "claude",
             "ambient": True, "email": None}])
        p.start(); self.addCleanup(p.stop)
        appsettings.set_quick_staff_behavior("under_assignee")
        self.addCleanup(appsettings.set_quick_staff_behavior, "request")
        self.org, self.owner, self.item = _org_with_tiers(SCRAMBLED)
        self.snap = staffcache.read()

    def _arm(self):
        """Plant the tripwire in every append-only log section."""
        for section in store.LAZY_SECTIONS:
            self.org.d[section] = ({"manager": [Tripwire()]}
                                   if section in store.DICT_LOGS else [Tripwire()])

    # ------------------------------------------------------------------ §1
    def test_building_the_menu_never_copies_an_append_only_log(self):
        """THE MEASURED DEFECT, as an assertion. 39 MB of chat history rode
        every trial hire; a hire reads none of it."""
        self._arm()
        result = quickstaff.preview(self.org, self.item, snap=self.snap)
        self.assertEqual([m["tier"] for m in result["models"]], CATALOG)

    def test_control_the_tripwire_really_does_fire_on_a_whole_document_copy(self):
        """CONTROL for §1: the copy the old code made DOES walk into it, so the
        section above passes because the logs were skipped and not because the
        tripwire is inert."""
        self._arm()
        with self.assertRaises(LogTouched):
            copy.deepcopy(self.org.d)
        with self.assertRaises(LogTouched):
            pickle.dumps(dict(self.org.d))

    def test_the_probe_source_carries_everything_a_hire_actually_judges_by(self):
        """Nothing is PRUNED — only the logs are absent. The trial organization
        still holds every node, tier, dir, credit pool and setting, which is why
        §3's verdicts can be identical rather than merely cheap."""
        logless = {k: v for k, v in self.org.d.items() if k not in store.LAZY_SECTIONS}
        was = ledger.Org(copy.deepcopy(logless))   # the trial as it was built before
        self._arm()
        trial = quickstaff.HireProbe(self.org).org()
        # compared against an organization built the OLD way from the same
        # sections, so `Org.__init__`'s own normalisations (it adds the legacy
        # `gpt-reserve` row to `tiers`, for one) are not mistaken for pruning
        for key in ("tiers", "nodes", "dirs", "default_visibility", "default_tools",
                    "max_top_grant", "work_items", "slug"):
            self.assertEqual(trial.d.get(key), was.d.get(key), key)
        for section in store.LAZY_SECTIONS:
            self.assertNotIn(section, trial.d, section)

    def test_a_hire_into_the_probe_document_still_works_without_its_logs(self):
        """The absent sections are APPEND-ONLY: a hire creates them as it writes
        (`store.log_append` on a plain document), so the trial is a working
        organization and not a crippled one."""
        trial = quickstaff.HireProbe(self.org).org()
        made = trial.hire(ledger.USER, self.owner, "haiku", 0, "probe-hire",
                          add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                              "subagents": False, "mcp": []},
                          org_visibility="self", charter="probe")
        self.assertIn(made["node"], trial.nodes)
        self.assertTrue(trial.d.get("events"), "the hire must still record its event")

    # ------------------------------------------------------------------ §2
    def test_one_trial_source_is_built_for_the_whole_menu(self):
        """The fix, stated as a count. Ten tiers used to mean ten whole-document
        copies; now they mean one source and ten cheap rebuilds from it."""
        built, rebuilt = [], []
        real_init, real_org = quickstaff.HireProbe.__init__, quickstaff.HireProbe.org

        def count_init(probe, org):
            built.append(org); return real_init(probe, org)

        def count_org(probe):
            rebuilt.append(1); return real_org(probe)

        with patch.object(quickstaff.HireProbe, "__init__", count_init), \
                patch.object(quickstaff.HireProbe, "org", count_org):
            quickstaff.preview(self.org, self.item, snap=self.snap)
        self.assertEqual(len(built), 1, "one trial source for the whole menu")
        self.assertEqual(len(rebuilt), len(SCRAMBLED),
                         "and one throwaway organization per tier judged")

    def test_control_a_single_tier_caller_still_builds_its_own(self):
        """CONTROL for §2: `probe` is an optional SHARING argument, not a new
        requirement. A caller that asks about one tier — the staffing door
        re-checking a click — gets its own source and needs to know nothing."""
        built = []
        real_init = quickstaff.HireProbe.__init__

        def count_init(probe, org):
            built.append(org); return real_init(probe, org)

        ctx = quickstaff.context(self.org, self.item)[1]
        with patch.object(quickstaff.HireProbe, "__init__", count_init):
            self.assertIsNone(quickstaff.tier_block(self.org, self.org._work_find(self.item)[0],
                                                    ctx, "haiku"))
        self.assertEqual(len(built), 1)

    # ------------------------------------------------------------------ §3
    def test_every_verdict_matches_the_whole_document_trial_it_replaced(self):
        """THE EQUIVALENCE. The shared probe is a cheaper way to reach the same
        answer, and this is the only claim that makes the speed worth having."""
        item = self.org._work_find(self.item)[0]
        ctx = quickstaff.context(self.org, self.item)[1]
        probe = quickstaff.HireProbe(self.org)
        for tier in SCRAMBLED:
            self.assertEqual(quickstaff.tier_block(self.org, item, ctx, tier, probe),
                             self._old_tier_block(item, ctx, tier), tier)

    def test_control_the_equivalence_covers_a_tier_that_is_actually_blocked(self):
        """CONTROL for §3: ten matching `None`s would also match if the probe
        never refused anything. A tier the organization does not hold must be
        refused by BOTH, with the same words."""
        item = self.org._work_find(self.item)[0]
        ctx = quickstaff.context(self.org, self.item)[1]
        probe = quickstaff.HireProbe(self.org)
        new = quickstaff.tier_block(self.org, item, ctx, "nonesuch", probe)
        self.assertEqual(new, self._old_tier_block(item, ctx, "nonesuch"))
        self.assertIsNotNone(new)
        # and a ceiling refusal, which the trial hire is what discovers
        with patch.object(ledger.Org, "_check_tier_ceiling",
                          side_effect=ledger.LedgerError("tier ceiling reached")):
            self.assertEqual(quickstaff.tier_block(self.org, item, ctx, "haiku", probe),
                             "tier ceiling reached")

    def _old_tier_block(self, item, ctx, tier):
        """`tier_block` exactly as it stood at ba65ad7 — the whole-document
        deep copy. Kept here so the equivalence is measured against the code
        that shipped, rather than against a description of it."""
        try:
            if tier not in self.org.d["tiers"]:
                return "That model is not available in this organization. Reopen Staff…."
            api.provider_hire_gate(self.org, tier)
            self.org._check_tier_ceiling(tier)
            args = quickstaff.staff_args(self.org, item, ctx, tier)
            trial = ledger.Org(copy.deepcopy(self.org.d))
            made = trial.hire(ledger.USER, args.get("target"), tier, args["grant"],
                              args["name"], add_dirs=args.get("add_dirs"),
                              tools=args.get("tools"),
                              org_visibility=args.get("org_visibility"),
                              charter=args["charter"])
            if args.get("permission_mode"):
                trial.set_scope(ledger.USER, made["node"],
                                permission_mode=args["permission_mode"])
        except (ledger.LedgerError, ValueError) as e:
            return str(e)
        return None

    # ------------------------------------------------------------------ §4
    def test_the_menu_leaves_the_real_organization_exactly_as_it_found_it(self):
        """A trial hire that reached the live document would spend credits and
        create seats for a menu nobody clicked."""
        before = copy.deepcopy(dict(self.org.d))
        quickstaff.preview(self.org, self.item, snap=self.snap)
        self.assertEqual(dict(self.org.d), before)

    def test_control_the_same_hire_against_the_real_document_does_change_it(self):
        """CONTROL for §4: the hire the trial runs is a real, mutating one — so
        "unchanged" above is isolation, not an inert probe."""
        before = copy.deepcopy(dict(self.org.d))
        self.org.hire(ledger.USER, self.owner, "haiku", 0, "for-real",
                      add_dirs=[], tools={"bash": False, "edit": False, "web": False,
                                          "subagents": False, "mcp": []},
                      org_visibility="self", charter="real")
        self.assertNotEqual(dict(self.org.d), before)


class StaffingMenuOrderTests(unittest.TestCase):
    """§5-§6 — the order the models come back in."""

    def setUp(self):
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        p = patch.object(api, "_providers_payload", return_value=DOCUMENT)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(staffcache, "_supported_efforts", return_value=["low", "high"])
        p.start(); self.addCleanup(p.stop)
        p = patch.object(api, "provider_hire_gate", return_value=None)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(staffcache, "tier_accounts", side_effect=lambda snap, org, tier: [
            {"value": "claude/primary", "id": "default", "provider": "claude",
             "ambient": True, "email": None}])
        p.start(); self.addCleanup(p.stop)
        appsettings.set_quick_staff_behavior("under_assignee")
        self.addCleanup(appsettings.set_quick_staff_behavior, "request")
        self.org, self.owner, self.item = _org_with_tiers(SCRAMBLED)
        self.snap = staffcache.read()

    # ------------------------------------------------------------------ §5
    def test_the_menu_is_ordered_by_the_model_list_and_not_by_the_document(self):
        """The user's beta.5 ruling: grouped by provider, tiers ordered within
        each provider, exactly as the model-switch list shows them."""
        self.assertNotEqual(list(SCRAMBLED), CATALOG, "the fixture must be scrambled")
        models = quickstaff.preview(self.org, self.item, snap=self.snap)["models"]
        self.assertEqual([m["tier"] for m in models], CATALOG)

    def test_every_staffing_surface_is_ordered_the_same_way(self):
        """The org-level document and the per-ticket menu are two readers of one
        rule, so they cannot disagree about the sequence either."""
        tiers = quickstaff.availability(self.org, self.snap)["tiers"]
        self.assertEqual([t["tier"] for t in tiers], CATALOG)
        models = quickstaff.preview(self.org, self.item, snap=self.snap)["models"]
        self.assertEqual([t["tier"] for t in tiers], [m["tier"] for m in models])

    def test_control_the_order_is_read_from_the_document_and_not_hard_coded(self):
        """CONTROL for §5: move a family in the provider document and the menu
        moves with it. Without this, an ordering table that merely happens to
        agree with the document today would pass every assertion above."""
        flipped = {"providers": list(reversed(DOCUMENT["providers"]))}
        with patch.object(api, "_providers_payload", return_value=flipped):
            staffcache.reset_for_tests()
            snap = staffcache.read()
            models = quickstaff.preview(self.org, self.item, snap=snap)["models"]
        self.assertEqual([m["tier"] for m in models],
                         ["flash", "pro", "luna", "terra", "sol", "astra",
                          "haiku", "sonnet", "opus", "fable"])

    # ------------------------------------------------------------------ §6
    def test_a_tier_the_document_does_not_list_keeps_its_place_at_the_end(self):
        """An organization may hold a tier the machine's provider document does
        not currently describe. It is not dropped and not interleaved by
        guesswork: it keeps the organization's own order, after everything the
        document does name."""
        org, _owner, item = _org_with_tiers(
            {"opus": 5, "mystery-b": 1, "haiku": 1, "mystery-a": 1})
        models = quickstaff.preview(org, item, snap=self.snap)["models"]
        self.assertEqual([m["tier"] for m in models],
                         ["haiku", "opus", "mystery-b", "mystery-a"])

    def test_the_order_survives_a_menu_that_omits_unstaffable_tiers(self):
        """Ordering and strict omission are independent: removing rows must not
        shuffle the rows that remain."""
        gate = {"fable", "sol", "flash"}
        with patch.object(api, "provider_hire_gate",
                          side_effect=lambda org, tier, **k: (_ for _ in ()).throw(
                              ledger.LedgerError("sign in")) if tier in gate else None):
            models = quickstaff.preview(self.org, self.item, snap=self.snap)["models"]
        self.assertEqual([m["tier"] for m in models],
                         [t for t in CATALOG if t not in gate])

    def test_catalog_order_survives_a_document_it_cannot_read(self):
        """`catalog_order` is asked for a position on every menu build, so a
        malformed or missing provider document must leave the list in the
        organization's own order rather than take the menu down."""
        self.assertEqual(quickstaff.catalog_order({"providers": None}), {})
        self.assertEqual(quickstaff.catalog_order({"providers": {"providers": "no"}}), {})
        self.assertEqual(
            quickstaff.in_catalog_order(["b", "a"], quickstaff.catalog_order({})),
            ["b", "a"])


if __name__ == "__main__":
    unittest.main()
