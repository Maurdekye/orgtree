"""Docket ownership survives an agent's generation advance (user bug 2026-09-12).

`perf-pass` cheap-compacted, and its performance umbrella plus six child
tickets read as abandoned: the stale-owner reconciler handed them to the
coordinator, the first live top-level agent. The cause was
`ledger._work_owner_state` comparing the item's stored owner generation with
the node's current one for EQUALITY, so every session replacement looked like
a vanished owner — while `_work_next_recipient` one screen away already said
"a compaction or rehire replaces the agent, not the assignment".

These tests are behavioural against the real ledger: real hires, real docket
rows written through `work_create`/`work_update`/`work_assign`, and the real
generation-advance methods (`cheap_compact`, `compact_split`,
`record_cli_compaction`, `reseed`, a cross-provider `switch_model`). Nothing
here pokes a generation number in by hand except where it stands in for an
identity the id was re-minted out from under, which is the one case that must
still read stale.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-genowner-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

from orgtree import ledger  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

_n = 0

#: every status a ticket can sit in and still be the owner's live work. The
#: reconciler only skips CLOSED rows, so each of these is a row a generation
#: advance could have stolen.
LIVE_STATUSES = ("open", "in_progress", "blocked", "review", "deploy_ready",
                 "backlogged")


def fixture(tier="haiku"):
    """The reported org: `coordinator` is the only live top-level agent (so it
    is exactly what `work_reassign_abandoned` would hand a stolen item to), and
    `perf-pass` is its report and the owner under test."""
    global _n
    _n += 1
    org = ledger.Org.create(f"gen-{_n}")
    org.hire(USER, None, tier, 3, "coordinator")
    org.hire(USER, "coordinator", tier, 0, "perf-pass")
    org.hire(USER, "coordinator", tier, 0, "peer-agent")
    # a reviewer must be the owner itself, its subtree or its superior
    org.hire(USER, "perf-pass", tier, 0, "review-sub")
    return org


def make_item(org, owner, title, status="in_progress", parent=None,
              reviewer=None):
    """One realistic ticket, created and driven the way the tool drives it."""
    org.work_create(owner, title,
                    objective=f"Problem: {title} is not done. Solution: do it.",
                    owner=owner, parent=parent)
    it = org.d["work_items"][-1]
    slug = it["slug"]
    if status == "review":
        org.work_update(owner, slug, ["drafted"], ["await review"],
                        status="review", reviewer=(reviewer or "coordinator"))
    elif status == "blocked":
        org.work_update(owner, slug, ["drafted"], ["unblock"], status="blocked",
                        blocked_reason="waiting on a fixture event; the "
                                       "fixture itself is what unblocks it")
    elif status != "in_progress":
        org.work_update(owner, slug, ["drafted"], ["continue"], status=status)
    else:
        org.work_update(owner, slug, ["drafted"], ["continue"],
                        status="in_progress")
    return slug


def view(org, slug, viewer=USER):
    for it in org._work_all():
        if it["slug"] == slug:
            return org._work_view(it, False, viewer, 10.0)
    raise AssertionError(f"{slug} vanished")


def stored(org, slug):
    for it in org._work_all():
        if it["slug"] == slug:
            return it
    raise AssertionError(f"{slug} vanished")


def age_out(org):
    """Push every row past the abandoned-ticket threshold, as a long-running
    ticket naturally is by the time a recovery pass looks at it."""
    for it in org._work_all():
        it["docket_at"] = "1970-01-01T00:00:00Z"
        it["updated_at"] = "1970-01-01T00:00:00Z"


FAR_FUTURE = 10_000_000.0


class GenerationAdvanceKeepsOwnershipTests(unittest.TestCase):
    def test_cheap_compaction_reproduction_umbrella_and_six_children(self):
        """THE REPORTED FAILURE, end to end."""
        org = fixture()
        umbrella = make_item(org, "perf-pass", "Performance umbrella")
        kids = [make_item(org, "perf-pass", f"Performance child {i}",
                          status=LIVE_STATUSES[i], parent=umbrella)
                for i in range(6)]
        every = [umbrella, *kids]
        before = {s: len(stored(org, s)["history"]) for s in every}
        before_status = {s: stored(org, s)["status"] for s in every}
        age_out(org)

        gen_before = org.nodes["perf-pass"]["generation"]
        org.cheap_compact(USER, "perf-pass")
        gen_after = org.nodes["perf-pass"]["generation"]
        self.assertEqual(gen_after, gen_before + 1, "fixture must really advance")
        self.assertEqual(org.nodes["perf-pass"]["state"], "live")

        # nothing reads as abandoned, however long the recovery pass waits
        self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])

        for slug in every:
            v = view(org, slug)
            self.assertEqual(v["owner"]["node"], "perf-pass", slug)
            self.assertTrue(v["owner_current"], slug)
            self.assertEqual(v["owner_state"], "live", slug)
            # projected onto the generation the agent is at NOW
            self.assertEqual(v["owner"]["generation"], gen_after, slug)
            # …and no ownership event, status change or attention change
            it = stored(org, slug)
            self.assertEqual(len(it["history"]), before[slug], slug)
            self.assertEqual(it["status"], before_status[slug], slug)
            self.assertFalse(v["effective_attention"], slug)
            self.assertIsNone(it.get("manual_attention"), slug)

        # the coordinator was told nothing: no assignment mail claiming a move
        self.assertNotIn("docket.assigned", str(org.d.get("mail") or {}))

    def test_projection_is_read_only_and_history_keeps_the_old_generation(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Read-only projection")
        gen_before = org.nodes["perf-pass"]["generation"]
        org.cheap_compact(USER, "perf-pass")
        v = view(org, slug)
        self.assertEqual(v["owner"]["generation"],
                         org.nodes["perf-pass"]["generation"])
        # the STORED row is untouched — a read may not edit ownership
        self.assertEqual(stored(org, slug)["owner"]["generation"], gen_before)
        # `created_by`/`last_updater` are history and name who actually acted
        self.assertEqual(v["created_by"]["generation"], gen_before)
        self.assertEqual(v["last_updater"]["generation"], gen_before)

    def test_every_supported_generation_advance_path(self):
        """cheap compaction, the CLI fork, an in-place CLI compaction, a
        re-seed, and a cross-provider model switch."""
        def advance_cheap(org):
            org.cheap_compact(USER, "perf-pass")

        def advance_fork(org):
            org.compact_split("perf-pass", "fresh-session-id")

        def advance_cli(org):
            org.record_cli_compaction("perf-pass")

        def advance_reseed(org):
            org.nodes["perf-pass"]["state"] = "unrecoverable"
            org.reseed(USER, "perf-pass", "reseeded-session-id")

        def advance_switch(org):
            # cross-provider: a Claude tier to a Codex one replaces the session
            org.switch_model(USER, "perf-pass", "astra")

        for advance in (advance_cheap, advance_fork, advance_cli,
                        advance_reseed, advance_switch):
            with self.subTest(path=advance.__name__):
                org = fixture()
                slug = make_item(org, "perf-pass", "Owned across a transition")
                gen_before = org.nodes["perf-pass"]["generation"]
                age_out(org)
                advance(org)
                gen_after = org.nodes["perf-pass"]["generation"]
                if advance is not advance_switch:
                    self.assertGreater(gen_after, gen_before)
                self.assertEqual(org.nodes["perf-pass"]["state"], "live")
                self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])
                v = view(org, slug)
                self.assertEqual(v["owner"]["node"], "perf-pass")
                self.assertTrue(v["owner_current"])
                self.assertEqual(v["owner_state"], "live")
                self.assertEqual(v["owner"]["generation"], gen_after)

    def test_routing_and_rights_reach_the_current_generation(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Routing after a compaction")
        review = make_item(org, "perf-pass", "Reviewed by a compacted agent",
                           status="review", reviewer="review-sub")
        org.cheap_compact(USER, "perf-pass")
        org.cheap_compact(USER, "review-sub")
        gen = org.nodes["perf-pass"]["generation"]

        # the reminder/next-action recipient is still the owner
        self.assertEqual(org._work_next_recipient(stored(org, slug)),
                         ("perf-pass", "owner"))
        # a compacted REVIEWER is still the reviewer, not a stale seat
        self.assertEqual(org._work_next_recipient(stored(org, review)),
                         ("review-sub", "reviewer"))
        self.assertEqual(view(org, review)["reviewer"]["node"], "review-sub")
        self.assertEqual(view(org, review)["reviewer"]["generation"],
                         org.nodes["review-sub"]["generation"])

        # the user's reply reaches it, and it is listed as a live recipient
        self.assertEqual(org.work_reply_target(slug)["node"], "perf-pass")
        self.assertEqual(
            [(r["node"], r["state"]) for r in view(org, slug)["reply_recipients"]],
            [("perf-pass", "live")])

        # management rights survive: the successor may still drive its item
        r = org.work_update("perf-pass", slug, ["still mine"], ["carry on"])
        self.assertEqual(r["rev"], stored(org, slug)["rev"])
        self.assertEqual(stored(org, slug)["owner"]["node"], "perf-pass")
        # an ordinary update by the owner does not move the assignment
        self.assertEqual(view(org, slug)["owner"]["generation"], gen)
        # and the successor can still be reached as a reviewer
        self.assertTrue(org._work_can_read("perf-pass", stored(org, slug)))
        self.assertTrue(org._work_can_manage("perf-pass", stored(org, slug)))

    def test_repeated_advances_and_nested_children_stay_owned(self):
        org = fixture()
        top = make_item(org, "perf-pass", "Nested parent")
        mid = make_item(org, "perf-pass", "Nested middle", parent=top)
        leaf = make_item(org, "perf-pass", "Nested leaf", parent=mid)
        age_out(org)
        for _ in range(3):
            org.cheap_compact(USER, "perf-pass")
        self.assertEqual(org.nodes["perf-pass"]["generation"], 3)
        self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])
        for slug in (top, mid, leaf):
            v = view(org, slug)
            self.assertTrue(v["owner_current"], slug)
            self.assertEqual(v["owner"]["generation"], 3, slug)


class PreservedStaleAndAssignmentBehaviourTests(unittest.TestCase):
    """The half that must NOT change: a genuinely gone owner is still
    recovered, and explicit reassignment still works exactly as before."""

    def test_retired_owner_is_still_reassigned(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Owner retires")
        age_out(org)
        org.retire(USER, "perf-pass")
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["owner"]["node"] for m in moved], ["coordinator"])
        self.assertEqual([m["previous_owner_state"] for m in moved], ["retired"])
        self.assertEqual(view(org, slug)["owner"]["node"], "coordinator")

    def test_dissolved_owner_is_still_reassigned(self):
        org = fixture()
        org.hire(USER, "perf-pass", "haiku", 0, "sub-agent")
        slug = make_item(org, "sub-agent", "Owner is dissolved with its tree")
        age_out(org)
        org.dissolve(USER, "perf-pass")
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["owner"]["node"] for m in moved], ["coordinator"])
        self.assertEqual([m["previous_owner_state"] for m in moved], ["retired"])
        self.assertEqual(view(org, slug)["owner"]["node"], "coordinator")

    def test_deleted_owner_is_still_reassigned(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Owner is deleted")
        age_out(org)
        org.delete(USER, "perf-pass")
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["owner"]["node"] for m in moved], ["coordinator"])
        self.assertEqual([m["previous_owner_state"] for m in moved], ["missing"])

    def test_a_re_minted_namesake_does_not_inherit_the_item(self):
        """A deleted agent frees its id; a later hire of the same name must
        read as a replaced identity rather than as the owner coming back. Both
        guards apply at once here — `delete` marked the reference and the
        namesake's `born` does not match — and the mark is the stronger claim,
        so the state reads 'missing'."""
        org = fixture()
        org.cheap_compact(USER, "perf-pass")      # the seat is at gen 1 …
        slug = make_item(org, "perf-pass", "Held by an agent that is deleted")
        self.assertEqual(stored(org, slug)["owner"]["generation"], 1)  # … so is the ref
        age_out(org)
        org.delete(USER, "perf-pass")
        org.hire(USER, "coordinator", "haiku", 0, "perf-pass")   # namesake
        self.assertEqual(org.nodes["perf-pass"]["generation"], 0)
        v = view(org, slug)
        self.assertFalse(v["owner_current"])
        self.assertEqual(v["owner_state"], "missing")
        self.assertEqual(v["owner"]["generation"], 1)   # served verbatim
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["owner"]["node"] for m in moved], ["coordinator"])

    def test_a_namesake_advancing_past_the_stored_generation_is_still_not_the_owner(self):
        """state-review's blocking repro (2026-09-12). A namesake is not
        stopped by an arithmetic comparison — it can compact its way past any
        stored generation — so the reference carries the seat's own `born`
        stamp and the deleted holder is marked as well. Neither decays."""
        org = fixture()
        org.cheap_compact(USER, "perf-pass")
        slug = make_item(org, "perf-pass", "Deleted owner replacement advances")
        age_out(org)
        was = dict(stored(org, slug)["owner"])
        self.assertEqual(was["generation"], 1)
        org.delete(USER, "perf-pass")
        org.hire(USER, "coordinator", "haiku", 0, "perf-pass")
        org.cheap_compact(USER, "perf-pass")
        org.cheap_compact(USER, "perf-pass")
        self.assertEqual(org.nodes["perf-pass"]["generation"], 2)   # past stored 1

        v = view(org, slug)
        self.assertFalse(v["owner_current"])
        self.assertEqual(v["owner"]["node"], "perf-pass")   # still says who held it
        self.assertEqual(v["owner"]["generation"], 1)       # verbatim, not projected
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["owner"]["node"] for m in moved], ["coordinator"])

    def test_the_mint_id_alone_rejects_a_namesake(self):
        """The `born` half on its own, with `delete`'s mark taken back off, so
        neither mechanism can hide a failure in the other.

        This is why `born` is the agent's mint id and not its `created` stamp:
        stamps are millisecond-resolution, and a delete plus a same-name hire
        land in one millisecond often enough that this exact test failed about
        one run in four while `created` was the marker."""
        org = fixture()
        slug = make_item(org, "perf-pass", "Mint id under test")
        born = stored(org, slug)["owner"]["born"]
        self.assertEqual(born, org.nodes["perf-pass"]["seat_id"])
        age_out(org)
        org.delete(USER, "perf-pass")
        org.hire(USER, "coordinator", "haiku", 0, "perf-pass")
        stored(org, slug)["owner"].pop("deleted", None)      # mark removed
        for _ in range(4):
            org.cheap_compact(USER, "perf-pass")
        self.assertFalse(view(org, slug)["owner_current"])
        self.assertEqual(view(org, slug)["owner_state"], "generation moved")

    def test_deletion_marks_a_stampless_legacy_reference(self):
        """The `delete` half on its own, against a reference written before
        `born` existed — the shape every item already on disk has."""
        org = fixture()
        slug = make_item(org, "perf-pass", "Legacy reference under test")
        review = make_item(org, "perf-pass", "Legacy reviewer reference",
                           status="review", reviewer="review-sub")
        for s in (slug, review):
            for f in ("owner", "reviewer"):
                if isinstance(stored(org, s).get(f), dict):
                    stored(org, s)[f].pop("born", None)      # pre-stamp shape
        age_out(org)
        org.delete(USER, "perf-pass")
        org.hire(USER, "coordinator", "haiku", 0, "perf-pass")
        for _ in range(4):
            org.cheap_compact(USER, "perf-pass")             # advance well past 0
        self.assertTrue(stored(org, slug)["owner"]["deleted"])
        v = view(org, slug)
        self.assertFalse(v["owner_current"])
        self.assertEqual(v["owner_state"], "missing")
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual(sorted(m["owner"]["node"] for m in moved),
                         ["coordinator", "coordinator"])

    def test_deletion_marks_the_archive_too(self):
        """A reopened item must not come back owned by a namesake."""
        org = fixture()
        slug = make_item(org, "perf-pass", "Closed then its owner is deleted")
        org.work_update("perf-pass", slug, ["done"], [], status="done")
        age_out(org)
        org._work_sweep(now_ts=FAR_FUTURE)
        self.assertTrue(any(i["slug"] == slug for i in org._work_archive()))
        org.delete(USER, "perf-pass")
        self.assertTrue(stored(org, slug)["owner"]["deleted"])

    def test_deletion_does_not_edit_authored_history(self):
        """state-review's second finding (2026-09-12). `_work_assign_core`
        records the assignment as `{"from": frm, "to": it["owner"]}`, and
        `_work_name_reviewer` does the same for the reviewer — so the history
        row holds THE VERY SAME dict the item holds. Marking the holder in
        place reached into an authored row and edited it, with no rev bump and
        no event. Deep-compared, not identity-compared, so a shared object is
        caught rather than excused."""
        for mode in ("owner", "reviewer"):
            with self.subTest(mode=mode):
                org = fixture()
                slug = make_item(org, "perf-pass", "History stays historical")
                if mode == "owner":
                    org.work_assign(USER, slug, "peer-agent")
                    target = "peer-agent"
                else:
                    org.work_update("perf-pass", slug, ["drafted"], ["review"],
                                    status="review", reviewer="review-sub")
                    target = "review-sub"
                it = stored(org, slug)
                before = copy.deepcopy(it["history"])
                rev, upd = it["rev"], it["updated_at"]

                org.delete(USER, target)

                self.assertEqual(it["history"], before, mode)
                self.assertEqual(it["rev"], rev, mode)
                self.assertEqual(it["updated_at"], upd, mode)
                # the LIVE field really was marked — the row above is unchanged
                # because it is a different object now, not because nothing ran
                self.assertTrue(it[mode]["deleted"], mode)

    def test_deletion_does_not_edit_authored_history_in_the_archive(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Closed, then history checked")
        org.work_assign(USER, slug, "peer-agent")
        org.work_update("peer-agent", slug, ["done"], [], status="done")
        age_out(org)
        org._work_sweep(now_ts=FAR_FUTURE)
        it = stored(org, slug)
        self.assertTrue(any(i["slug"] == slug for i in org._work_archive()))
        before = copy.deepcopy(it["history"])
        rev = it["rev"]
        org.delete(USER, "peer-agent")
        self.assertEqual(it["history"], before)
        self.assertEqual(it["rev"], rev)
        self.assertTrue(it["owner"]["deleted"])

    def test_an_unrelated_owner_is_untouched_by_someone_elses_deletion(self):
        org = fixture()
        mine = make_item(org, "perf-pass", "Kept by an agent that stays")
        theirs = make_item(org, "peer-agent", "Held by the agent deleted")
        age_out(org)
        org.delete(USER, "peer-agent")
        self.assertNotIn("deleted", stored(org, mine)["owner"])
        self.assertTrue(view(org, mine)["owner_current"])
        self.assertTrue(stored(org, theirs)["owner"]["deleted"])
        moved = org.work_reassign_abandoned(now_ts=FAR_FUTURE)
        self.assertEqual([m["assigned"] for m in moved], [theirs])

    def test_renamed_owner_keeps_its_items_as_before(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Owner is renamed")
        org.cheap_compact(USER, "perf-pass")
        age_out(org)
        org.rename(USER, "perf-pass", "perf-pass-renamed")
        self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])
        v = view(org, slug)
        self.assertEqual(v["owner"]["node"], "perf-pass-renamed")
        self.assertTrue(v["owner_current"])

    def test_explicit_assignment_still_moves_the_item_and_is_recorded(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Explicitly handed over")
        org.cheap_compact(USER, "perf-pass")
        r = org.work_assign(USER, slug, "peer-agent")
        self.assertEqual(r["owner"]["node"], "peer-agent")
        it = stored(org, slug)
        self.assertTrue(any(h["op"] == "assign" for h in it["history"]))
        self.assertEqual(view(org, slug)["owner"]["node"], "peer-agent")
        self.assertIn("docket.assigned", str(org.d.get("mail") or {}))

    def test_a_closed_item_is_left_alone_whatever_its_owner_did(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Finished before the owner went")
        org.work_update("perf-pass", slug, ["done"], [], status="done")
        age_out(org)
        org.retire(USER, "perf-pass")
        self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])
        self.assertEqual(view(org, slug)["owner"]["node"], "perf-pass")

    def test_a_user_owned_reference_is_never_reconciled(self):
        org = fixture()
        slug = make_item(org, "perf-pass", "Handed to the user")
        stored(org, slug)["owner"] = USER
        age_out(org)
        v = view(org, slug)
        self.assertFalse(v["owner_current"])
        self.assertIsNone(v["owner_state"])
        self.assertEqual(org.work_reassign_abandoned(now_ts=FAR_FUTURE), [])


if __name__ == "__main__":
    unittest.main()
