"""Item-scoped reads: the holder of a docket item may read what earlier
holders of THAT SAME item wrote, and nothing else.

`orgtree_read_scratch` and `orgtree_read_transcript` are downward-only, which
is right for the chart and wrong for how work moves: when a ticket is
reassigned the previous implementer is usually an ARCHIVED PEER, so the agent
inheriting the ticket could not read one word of what it learned. These tests
pin the narrow grant that fixes it and, just as importantly, pin what it must
NOT reach — an unrelated peer, and an earlier holder of a DIFFERENT item.
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest
import unittest.mock
from types import SimpleNamespace

_root = tempfile.TemporaryDirectory(prefix="v2-item-scoped-reads-")
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException                       # noqa: E402

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, store, supervisor      # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class ItemScopedReads(unittest.TestCase):
    """One org, one handover, and every neighbour that must stay unreadable."""

    _seq = 0

    def setUp(self) -> None:
        # a fresh org per test: `store` keeps a process-wide connection pool,
        # so sharing one document across cases leaks state between them
        ItemScopedReads._seq += 1
        self.slug = f"item-scoped-reads-{ItemScopedReads._seq}"
        self.org = store.create_org(self.slug)
        o = self.org
        # a flat team: four PEERS under one coordinator. None of them is a
        # descendant of any other, so the chart rule grants nothing between
        # them and every read below is decided purely by the docket.
        self.boss = o.hire(ledger.USER, None, "haiku", 3, "boss")["node"]
        self.first = o.hire(ledger.USER, self.boss, "haiku", 0, "first")["node"]
        self.second = o.hire(ledger.USER, self.boss, "haiku", 0, "second")["node"]
        self.stranger = o.hire(ledger.USER, self.boss, "haiku", 0,
                               "stranger")["node"]
        self.other = o.hire(ledger.USER, self.boss, "haiku", 0, "other")["node"]

        # THE SHARED TICKET — created onto `first`, later handed to `second`.
        self.shared = str(o.work_create(
            ledger.USER, "Shared ticket",
            "The handover loses what the last agent learned. Hand it over "
            "with the working notes still reachable.",
            owner=self.first)["created"])
        # AN UNRELATED TICKET, held by `other` and worked before by `stranger`
        # — this is what proves the grant is per-item and not per-agent.
        self.unrelated = str(o.work_create(
            ledger.USER, "Unrelated ticket",
            "A different problem entirely. A different solution entirely.",
            owner=self.stranger)["created"])
        o.work_assign(ledger.USER, self.unrelated, self.other)

        for node, text in ((self.first, "what I learned on the shared ticket"),
                           (self.stranger, "notes nobody else is owed")):
            d = supervisor.scratch_dir(self.slug, node)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "breadcrumbs.md"), "w",
                      encoding="utf-8") as fh:
                fh.write(text)
        store.save_org(o)

    def tearDown(self) -> None:
        store._POOL.close_all("item-scoped-reads")

    # ---- helpers

    def call(self, tool, args, actor):
        request = SimpleNamespace(state=SimpleNamespace())
        return api.agent_call(
            api.AgentCall(org=self.slug, node=actor, tool=tool, args=args),
            request)

    def read_scratch(self, actor, target, path="breadcrumbs.md"):
        return self.call("orgtree_read_scratch",
                         {"node": target, "path": path}, actor)

    def read_transcript(self, actor, target):
        return self.call("orgtree_read_transcript", {"node": target}, actor)

    def refusal(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as caught:
            fn(*a, **kw)
        self.assertEqual(caught.exception.status_code, 422)
        return str(caught.exception.detail)

    def hand_over(self, retire_first=True):
        """The real reassignment: retire the outgoing holder (the common case
        — an item is normally reassigned only after its holder was retired),
        then move the item to the agent that inherits it."""
        o = store.load_org(self.slug)
        if retire_first:
            o.retire(ledger.USER, self.first)
        o.work_assign(ledger.USER, self.shared, self.second)
        store.save_org(o)
        return o

    # ---- acceptance 1: the inheriting holder can read the previous holder

    def test_new_holder_reads_the_archived_previous_holders_material(self):
        # BEFORE the handover the inheritor is just a peer and is refused.
        self.refusal(self.read_scratch, self.second, self.first)
        self.hand_over()
        got = self.read_scratch(self.second, self.first)
        self.assertEqual(got["content"], "what I learned on the shared ticket")
        self.assertEqual(got["access"]["via"], "item")
        self.assertEqual(got["access"]["item"], self.shared)
        # and the previous holder really is archived — this is the case the
        # fifteen reports actually hit, not a live-peer convenience
        self.assertEqual(
            store.load_org(self.slug).node(self.first)["state"], "archived")

    def test_transcript_takes_the_same_route_and_names_the_item(self):
        self.hand_over()
        got = self.read_transcript(self.second, self.first)
        self.assertEqual(got["node"], self.first)
        self.assertEqual(got["access"]["via"], "item")
        self.assertEqual(got["access"]["item"], self.shared)
        self.assertIn(self.first, got["access"]["note"])

    def test_listing_the_scratch_root_is_granted_by_the_same_item(self):
        self.hand_over()
        got = self.read_scratch(self.second, self.first, path="")
        self.assertIn("breadcrumbs.md", got["entries"])
        self.assertEqual(got["access"]["item"], self.shared)

    def test_a_live_previous_holder_is_reachable_too(self):
        """Archived is the common case, not the condition."""
        self.hand_over(retire_first=False)
        self.assertEqual(
            self.read_scratch(self.second, self.first)["access"]["via"], "item")

    # ---- acceptance 2: holding one item grants nothing about another

    def test_holding_one_item_grants_nothing_about_another(self):
        """`second` holds `shared`. `stranger` held `unrelated` before
        `other`. Neither fact touches the other, and the whole point of
        scoping by the item is that this stays a refusal."""
        self.hand_over()
        detail = self.refusal(self.read_scratch, self.second, self.stranger)
        self.assertIn("DOWNWARD", detail)
        # and the agent that DOES hold the unrelated item reads its own
        # previous holder, which proves the fixture is wired the way the
        # refusal above claims rather than being inert
        self.assertEqual(
            self.read_scratch(self.other, self.stranger)["access"]["item"],
            self.unrelated)

    def test_holding_an_item_grants_nothing_about_the_other_items_holder(self):
        self.hand_over()
        self.refusal(self.read_scratch, self.second, self.other)
        self.refusal(self.read_scratch, self.other, self.first)

    # ---- acceptance 3: an unrelated peer stays unreadable

    def test_unrelated_peers_remain_unreadable_in_both_directions(self):
        self.hand_over()
        for reader, target in ((self.second, self.other),
                               (self.other, self.second),
                               (self.stranger, self.first)):
            self.refusal(self.read_scratch, reader, target)
            self.refusal(self.read_transcript, reader, target)

    def test_the_grant_does_not_run_backwards_to_the_outgoing_holder(self):
        """`first` held the item and lost it. The read follows the item, so it
        is the CURRENT holder that may read backwards, never the reverse."""
        self.hand_over(retire_first=False)
        self.refusal(self.read_scratch, self.first, self.second)

    def test_a_superior_still_cannot_be_read(self):
        self.hand_over()
        self.refusal(self.read_scratch, self.second, self.boss)

    def test_the_chart_rule_is_untouched(self):
        self.assertEqual(
            self.read_scratch(self.boss, self.stranger)["access"]["via"],
            "chart")
        self.assertEqual(
            self.read_scratch(self.second, self.second,
                              path="")["access"]["via"], "self")

    def test_the_refusal_says_how_the_item_scoped_route_works(self):
        detail = self.refusal(self.read_scratch, self.second, self.other)
        self.assertIn("shared docket item", detail)
        self.assertIn("holders", detail)

    # ---- acceptance 4: the access is visible, not silent

    def test_the_item_publishes_its_holder_roster(self):
        self.hand_over()
        item = store.load_org(self.slug).work_get(self.boss, self.shared)
        self.assertEqual([r["node"] for r in item["holders"]],
                         [self.first, self.second])
        self.assertTrue(all("from" in r for r in item["holders"]))

    def test_the_outgoing_holder_is_told_its_material_became_readable(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        mail = "\n".join(m.get("body", "")
                         for m in o.d.get("mail", {}).get(self.first, []))
        self.assertIn("DOCKET REASSIGNMENT", mail)
        self.assertIn("may read your scratch folder", mail)
        self.assertIn("orgtree_read_scratch", mail)
        self.assertIn("scoped to THIS item", mail)
        # and it states the limit as well as the grant: the outgoing holder
        # is owed both halves, not just the part that exposes it
        self.assertIn("when this item closes and archives", mail)

    def test_both_tool_descriptions_state_the_item_scoped_rule(self):
        from orgtree import mcptool
        tools = {t["name"]: t["description"] for t in mcptool.TOOLS}
        for name in ("orgtree_read_scratch", "orgtree_read_transcript"):
            self.assertIn("item", tools[name])
            self.assertIn("holders", tools[name])

    # ---- the roster itself

    def test_the_roster_survives_a_history_fold(self):
        """`history` is a WINDOW — past the cap its oldest rows fold into one
        summary row. The roster is what authorizes the read precisely because
        it does not, and this is the test that would fail if the grant were
        ever re-derived from the assign trail."""
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        for _ in range(o.WORK_HISTORY_MAX + 5):
            o.work_update(self.second, self.shared, done_so_far=["churn"],
                          working_on_next=[])
        it, _ = o._work_find(self.shared)
        self.assertTrue(any(r.get("kind") == "folded"
                            for r in it["history"]))
        self.assertEqual([r["node"] for r in o._work_holders(it)],
                         [self.first, self.second])
        store.save_org(o)
        self.assertEqual(
            self.read_scratch(self.second, self.first)["access"]["item"],
            self.shared)

    def test_reassigning_to_the_same_holder_adds_no_row(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_assign(ledger.USER, self.shared, self.second)
        it, _ = o._work_find(self.shared)
        self.assertEqual([r["node"] for r in it["holders"]],
                         [self.first, self.second])

    def test_an_item_that_bounces_back_keeps_every_stretch(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_assign(ledger.USER, self.shared, self.first)
        it, _ = o._work_find(self.shared)
        self.assertEqual([r["node"] for r in it["holders"]],
                         [self.first, self.second, self.first])
        # the item is back with `first`, so `first` may read `second` now and
        # `second` may no longer read `first`
        store.save_org(o)
        self.assertEqual(
            self.read_scratch(self.first, self.second, path="")["access"]["via"],
            "item")
        self.refusal(self.read_scratch, self.second, self.first)

    def test_an_item_written_before_the_field_derives_its_roster(self):
        """Old documents carry no roster. Whatever history still holds is
        recovered, labelled `derived`, and seeded on the next assignment —
        never written back during a read."""
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        it, _ = o._work_find(self.shared)
        del it["holders"]
        derived = o._work_holders(it)
        self.assertEqual([r["node"] for r in derived],
                         [self.first, self.second])
        self.assertTrue(all(r.get("derived") for r in derived))
        self.assertNotIn("holders", it)          # a read must not write
        o.work_assign(ledger.USER, self.shared, self.stranger)
        self.assertEqual([r["node"] for r in it["holders"]],
                         [self.first, self.second, self.stranger])

    def test_the_user_is_never_a_party_to_an_item_scoped_read(self):
        o = store.load_org(self.slug)
        self.assertIsNone(o.work_item_read_grant(ledger.USER, self.first))
        self.assertIsNone(o.work_item_read_grant(self.second, ledger.USER))
        self.assertIsNone(o.work_item_read_grant(self.second, self.second))
        self.assertIsNone(o.work_item_read_grant("", self.first))

    # ---- THE USER'S RULINGS (2026-09-16), which are the whole access rule:
    #
    #   WHO      — holder + participants + the named reviewer. Everyone LISTED.
    #   SURVIVAL — the read ends the moment you stop being listed, and a
    #              closed item grants nothing to anybody.
    #
    # Reduced to one sentence: the agents who may read an item's earlier
    # holders are exactly the agents currently listed on that item, while that
    # item is open. Each test below pins one edge of that sentence.

    def test_a_listed_participant_reads_the_previous_holder(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        store.save_org(o)
        # not listed yet — refused
        self.refusal(self.read_scratch, self.stranger, self.first)
        o = store.load_org(self.slug)
        o.work_participants(ledger.USER, self.shared, add=[self.stranger])
        store.save_org(o)
        got = self.read_scratch(self.stranger, self.first)
        self.assertEqual(got["access"]["standing"], "participant")
        self.assertEqual(got["access"]["item"], self.shared)
        self.assertEqual(got["content"], "what I learned on the shared ticket")

    def test_the_named_reviewer_reads_the_previous_holder(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        # named by the USER: an agent may only name its own subtree or its
        # superior as reviewer, and `stranger` is neither to `second`
        o.work_update(ledger.USER, self.shared, done_so_far=["built"],
                      working_on_next=[], status="review",
                      reviewer=self.stranger, owner=self.second)
        store.save_org(o)
        self.assertEqual(
            self.read_scratch(self.stranger, self.first)["access"]["standing"],
            "reviewer")

    def test_a_participant_loses_the_read_when_removed_from_the_item(self):
        """The ruling is evaluated at CALL TIME, not cached: membership is the
        permission, so dropping the membership drops the read immediately."""
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_participants(ledger.USER, self.shared, add=[self.stranger])
        store.save_org(o)
        self.assertEqual(
            self.read_scratch(self.stranger, self.first)["access"]["standing"],
            "participant")
        o = store.load_org(self.slug)
        o.work_participants(ledger.USER, self.shared, remove=[self.stranger])
        store.save_org(o)
        self.refusal(self.read_scratch, self.stranger, self.first)

    def test_a_participant_gains_nothing_about_an_unrelated_item(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_participants(ledger.USER, self.shared, add=[self.stranger])
        store.save_org(o)
        # `stranger` is listed on `shared`, and `first` held `shared` — that
        # much is readable. `other` holds a DIFFERENT item and is not.
        self.assertEqual(
            self.read_scratch(self.stranger, self.first)["access"]["via"],
            "item")
        self.refusal(self.read_scratch, self.stranger, self.other)

    def test_a_former_holder_loses_the_read_when_the_item_archives(self):
        """The narrowest reading, taken deliberately and NOT softened: the
        agent that finished the item cannot read its history afterwards."""
        self.hand_over(retire_first=False)
        self.assertEqual(
            self.read_scratch(self.second, self.first)["access"]["via"], "item")
        o = store.load_org(self.slug)
        o.work_update(self.second, self.shared, status="done",
                      done_so_far=["landed"], working_on_next=[])
        o.work_archive_now(self.second, self.shared)
        it, arch = o._work_find(self.shared)
        self.assertTrue(arch)
        store.save_org(o)
        self.refusal(self.read_scratch, self.second, self.first)

    def test_a_participant_on_an_archived_item_reads_nothing_either(self):
        """A closed item is not a source of access AT ALL — not for its last
        holder, and not for anyone still listed beside it."""
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_participants(ledger.USER, self.shared, add=[self.stranger])
        store.save_org(o)
        self.assertEqual(
            self.read_scratch(self.stranger, self.first)["access"]["via"],
            "item")
        o = store.load_org(self.slug)
        o.work_update(self.second, self.shared, status="done",
                      done_so_far=["landed"], working_on_next=[])
        o.work_archive_now(self.second, self.shared)
        store.save_org(o)
        self.refusal(self.read_scratch, self.stranger, self.first)

    def test_the_read_never_reaches_the_current_holder(self):
        """`first` -> `second` -> `other`. What is readable is PREVIOUS
        holders, which the agent working the item right now is not: reading
        the live transcript of whoever holds the ticket is a wider thing than
        "do not lose what the last agent learned", and nobody asked for it."""
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        # the handover FIRST, then the participant add: an item never lists
        # its own holder as a participant too, so adding `second` while it
        # still owned the item would have been filtered straight back out
        o.work_assign(ledger.USER, self.shared, self.other)
        o.work_participants(ledger.USER, self.shared, add=[self.second])
        store.save_org(o)
        # `second` is still listed (as a participant) so it still reads
        # backwards to `first` — but never forward to `other`, which took the
        # item after it.
        self.assertEqual(
            self.read_scratch(self.second, self.first)["access"]["standing"],
            "participant")
        self.refusal(self.read_scratch, self.second, self.other)

    def test_a_holder_reads_only_behind_its_own_stretch(self):
        o = store.load_org(self.slug)
        o.work_assign(ledger.USER, self.shared, self.second)
        o.work_assign(ledger.USER, self.shared, self.other)
        store.save_org(o)
        # `other` holds it now and reads both earlier stretches
        self.assertEqual(
            self.read_scratch(self.other, self.first)["access"]["via"], "item")
        # `second` held it and lost it: not listed any more, so nothing
        self.refusal(self.read_scratch, self.second, self.first)


if __name__ == "__main__":
    unittest.main()
