"""D-232: self-subjugate is an atomic SUBTREE PROMOTION, not a seat swap.

The chosen descendant rises into the caller's former place carrying its own
entire team, and the caller drops in beneath it as a direct report, keeping
whatever is left of its own subtree.

These tests use an in-memory ledger only.  They are written to the standard
the ticket asks for: the structural claims are PROVEN against a full-tree
invariant walk rather than spot-checked on the two nodes that moved, the
atomicity claim is proven by deep-comparing the entire ledger document before
and after a refused call, and the "general swap is unchanged" claim is pinned
by exercising `swap_seats` directly.
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# The ledger imports the store lazily while constructing an Org.  Give the
# development guard an independent disposable root before that import.
_DATA = tempfile.TemporaryDirectory(prefix="d232-promotion-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402


# --------------------------------------------------------------------------
# invariants
# --------------------------------------------------------------------------
def assert_tree_sound(case: unittest.TestCase, org: ledger.Org) -> None:
    """Every structural promise the ticket makes, checked over the WHOLE tree.

    No duplicated node, no missing node, no dangling parent pointer, no cycle.
    This runs after every mutation in these tests, not only on the pair that
    moved — a promotion that quietly orphaned an unrelated branch would pass
    any check narrower than this one.
    """
    nodes = org.nodes
    # node keys are a set by construction; a duplicate would have to show up
    # as a node reachable from two parents, which the walk below catches
    seen_children: dict[str, str] = {}
    roots = 0
    for nid, n in nodes.items():
        p = n["parent"]
        if p is None:
            roots += 1
            continue
        case.assertIn(p, nodes, f"{nid} has a dangling parent pointer -> {p}")
        prev = seen_children.get(nid)
        case.assertIsNone(prev, f"{nid} is claimed by two parents")
        seen_children[nid] = p
    case.assertGreater(roots, 0, "the tree lost every root")

    # no cycle: walking up from any node must reach a root in <= len(nodes)
    for nid in nodes:
        cur, hops = nid, 0
        while cur is not None:
            hops += 1
            case.assertLessEqual(
                hops, len(nodes) + 1,
                f"cycle in the parent chain reachable from {nid}")
            cur = nodes[cur]["parent"]

    # every node is reachable downward from some root: nothing is stranded
    reach: set[str] = set()
    stack = [k for k, n in nodes.items() if n["parent"] is None]
    while stack:
        k = stack.pop()
        case.assertNotIn(k, reach, f"{k} reached twice — the tree is not a tree")
        reach.add(k)
        stack.extend(c for c, n in nodes.items() if n["parent"] == k)
    case.assertEqual(reach, set(nodes), "some node is unreachable from any root")


def parents(org: ledger.Org) -> dict[str, str | None]:
    return {k: n["parent"] for k, n in org.nodes.items()}


def notice_variants(org: ledger.Org) -> set[str]:
    """Every typed event variant currently sitting in anybody's notice box."""
    out: set[str] = set()
    for box in org.d.get("notices", {}).values():
        for entry in box:
            ev = entry.get("ev") or {}
            if ev.get("variant"):
                out.add(str(ev["variant"]))
    return out


class PromotionBase(unittest.TestCase):
    """The reference fixture, drawn the way the ticket draws it.

        top
        |- sibling            <- unrelated branch, must be untouched
        |  \\- sib-kid
        \\- boss              <- the CALLER
           |- x               <- caller's own report, must stay with the caller
           |  \\- x1
           \\- mid            <- the intermediate ancestor, must stay intact
              \\- tgt         <- the TARGET
                 |- t1
                 \\- t2
    """

    def setUp(self) -> None:
        self.org = ledger.Org.create(f"d232-{self.id().rsplit('.', 1)[-1]}")
        o = self.org
        o.hire(USER, None, "haiku", 60, "top")
        o.hire(USER, "top", "haiku", 4, "sibling")
        o.hire(USER, "sibling", "haiku", 0, "sib-kid")
        o.hire(USER, "top", "haiku", 30, "boss")
        o.hire(USER, "boss", "haiku", 4, "x")
        o.hire(USER, "x", "haiku", 0, "x1")
        o.hire(USER, "boss", "haiku", 12, "mid")
        o.hire(USER, "mid", "haiku", 6, "tgt")
        o.hire(USER, "tgt", "haiku", 0, "t1")
        o.hire(USER, "tgt", "haiku", 0, "t2")
        assert_tree_sound(self, o)


# --------------------------------------------------------------------------
# the required hierarchy transformation
# --------------------------------------------------------------------------
class HierarchyTransformationTests(PromotionBase):
    def test_deep_descendant_rises_with_its_whole_subtree(self):
        out = self.org.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, self.org)
        p = parents(self.org)
        # the target took the caller's former location, under the caller's
        # former superior
        self.assertEqual(p["tgt"], "top")
        # the caller is now a DIRECT report of the promoted target
        self.assertEqual(p["boss"], "tgt")
        # the target kept its full existing subtree — its reports were not
        # exchanged away for the caller's
        self.assertEqual(p["t1"], "tgt")
        self.assertEqual(p["t2"], "tgt")
        self.assertEqual(sorted(self.org.children("tgt")), ["boss", "t1", "t2"])
        self.assertEqual(out["promoted"], "tgt")
        self.assertEqual(out["demoted"], "boss")
        self.assertEqual(out["after"], {"tgt": "top", "boss": "tgt"})

    def test_caller_retains_the_remainder_of_its_subtree(self):
        self.org.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, self.org)
        p = parents(self.org)
        # everything the caller had, minus the detached target branch
        self.assertEqual(sorted(self.org.children("boss")), ["mid", "x"])
        self.assertEqual(p["x1"], "x")
        # the target's former parent lost the target branch and nothing else,
        # and the intermediate ancestor chain is structurally intact
        self.assertEqual(self.org.children("mid"), [])
        self.assertEqual(p["mid"], "boss")

    def test_unrelated_branch_is_untouched(self):
        before = {k: parents(self.org)[k] for k in ("top", "sibling", "sib-kid")}
        self.org.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, self.org)
        after = {k: parents(self.org)[k] for k in ("top", "sibling", "sib-kid")}
        self.assertEqual(before, after)

    def test_direct_child_promotion(self):
        """The degenerate case: the target is already a direct report."""
        self.org.subjugate("boss", "boss", "x")
        assert_tree_sound(self, self.org)
        p = parents(self.org)
        self.assertEqual(p["x"], "top")       # rose into the caller's place
        self.assertEqual(p["boss"], "x")      # caller dropped beneath it
        self.assertEqual(p["x1"], "x")        # target kept its own report
        self.assertEqual(sorted(self.org.children("x")), ["boss", "x1"])
        self.assertEqual(sorted(self.org.children("boss")), ["mid"])

    def test_top_level_handover(self):
        """A top-level caller hands its OWN seat over through the same
        transformation, and the result is the same shape."""
        self.org.subjugate("top", "top", "mid")
        assert_tree_sound(self, self.org)
        p = parents(self.org)
        self.assertIsNone(p["mid"])           # the promoted target is top level
        self.assertEqual(p["top"], "mid")     # the former top reports to it
        self.assertEqual(p["tgt"], "mid")     # it brought its own team up
        # and the former top keeps the rest of its own organization
        self.assertEqual(sorted(self.org.children("top")), ["boss", "sibling"])

    def test_promotion_is_not_a_swap_of_teams(self):
        """The regression the ticket exists to fix: under the old behaviour
        the two agents exchanged reports, severing the target from the
        organization it had built."""
        self.org.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, self.org)
        # the target did NOT inherit the caller's reports as a replacement set
        self.assertNotIn("x", self.org.children("tgt"))
        self.assertNotIn("mid", self.org.children("tgt"))
        # and the caller did NOT inherit the target's
        self.assertNotIn("t1", self.org.children("boss"))
        self.assertNotIn("t2", self.org.children("boss"))

    def test_superior_may_promote_within_a_reports_subtree(self):
        """The operation is not restricted to self-subjugation: an ancestor
        may perform it on a descendant pair it has authority over."""
        self.org.subjugate("top", "boss", "tgt")
        assert_tree_sound(self, self.org)
        self.assertEqual(parents(self.org)["tgt"], "top")
        self.assertEqual(parents(self.org)["boss"], "tgt")


# --------------------------------------------------------------------------
# atomicity
# --------------------------------------------------------------------------
class AtomicityTests(PromotionBase):
    def _assert_untouched(self, snapshot: dict) -> None:
        self.assertEqual(
            self.org.d, snapshot,
            "a refused promotion mutated the ledger — atomicity is broken")
        assert_tree_sound(self, self.org)

    def test_refusal_between_the_two_legs_applies_nothing(self):
        """The hard case: the FIRST re-parent succeeds and the SECOND is
        refused.  A non-atomic implementation leaves the target promoted and
        the caller still sitting where it was.

        The wedge is the No.34 report cap, checked by `_move` against the
        destination.  The target already holds the cap, so lifting it out of
        the caller's subtree is legal while seating the caller under it is
        not.
        """
        self.org.d["max_children"] = len(self.org.org_children("tgt"))
        snapshot = copy.deepcopy(self.org.d)
        with self.assertRaises(LedgerError) as caught:
            self.org.subjugate("boss", "boss", "tgt")
        self.assertIn("nothing was applied", str(caught.exception))
        self._assert_untouched(snapshot)

    def test_depth_cap_refusal_applies_nothing(self):
        """The other side of No.34: the promotion deepens the caller's
        retained subtree by one level."""
        # leg 1 SHALLOWS the target (tgt 3 -> 1, its team with it) and leg 2
        # DEEPENS the caller's retained branch by one (x1 3 -> 4).  A cap at
        # the tree's current depth therefore lets leg 1 through and refuses
        # leg 2 — which is exactly the half-applied state this test exists to
        # prove cannot survive.
        deepest = max(self.org.depth(k) for k in self.org.nodes)
        self.org.d["max_depth"] = deepest
        snapshot = copy.deepcopy(self.org.d)
        with self.assertRaises(LedgerError):
            self.org.subjugate("boss", "boss", "tgt")
        self._assert_untouched(snapshot)

    def test_every_validation_refusal_applies_nothing(self):
        """Each refusal the verb can raise, checked against a full-document
        comparison rather than a spot check."""
        cases = [
            ("boss", "boss", "boss"),        # target is the caller
            ("boss", "boss", "sibling"),     # not a descendant
            ("boss", "boss", "top"),         # an ancestor, not a descendant
            ("boss", "boss", "nope"),        # unknown node
            ("sibling", "boss", "tgt"),      # no authority over the caller
        ]
        for actor, nid, target in cases:
            with self.subTest(actor=actor, nid=nid, target=target):
                snapshot = copy.deepcopy(self.org.d)
                with self.assertRaises(LedgerError):
                    self.org.subjugate(actor, nid, target)
                self._assert_untouched(snapshot)

    def test_archived_party_is_refused_without_mutation(self):
        self.org.retire(USER, "t1")
        self.org.retire(USER, "t2")
        self.org.retire(USER, "tgt")
        snapshot = copy.deepcopy(self.org.d)
        with self.assertRaises(LedgerError):
            self.org.subjugate("boss", "boss", "tgt")
        self._assert_untouched(snapshot)

    def test_top_level_promotion_by_a_stranger_is_refused(self):
        """Only the top-level agent itself may hand its own seat over
        (Section 7.4).  Nobody below it can reseat it: authority is downward
        only, and no agent is an ancestor of a root, so the attempt dies on
        Section 7.1 before the top-level rule is even reached."""
        snapshot = copy.deepcopy(self.org.d)
        with self.assertRaises(LedgerError) as caught:
            self.org.subjugate("boss", "top", "tgt")
        self.assertIn("authority", str(caught.exception))
        self._assert_untouched(snapshot)
        # and the voluntary hand-over by the top-level agent itself is the
        # one route that IS open — pinned in test_top_level_handover


# --------------------------------------------------------------------------
# identity and continuity
# --------------------------------------------------------------------------
class IdentityContinuityTests(PromotionBase):
    def test_sessions_charters_and_node_identity_survive(self):
        o = self.org
        o.set_scope(USER, "boss", charter="the caller's own charter")
        o.set_scope(USER, "tgt", charter="the target's own charter")
        keys = ("session_id", "charter", "model", "state")
        before = {k: {f: o.node(k).get(f) for f in keys} for k in o.nodes}
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        after = {k: {f: o.node(k).get(f) for f in keys} for k in o.nodes}
        self.assertEqual(before, after,
                         "identity-bound fields moved with the seat")

    def test_no_node_is_recreated(self):
        """Identity continuity's precondition: the verb re-parents, it never
        re-creates.  Every node object keeps the same identity key."""
        before = set(self.org.nodes)
        self.org.subjugate("boss", "boss", "tgt")
        self.assertEqual(set(self.org.nodes), before)

    def test_docket_ownership_follows_the_agent(self):
        o = self.org
        made = o.work_create("tgt", "Target's own item",
                             "Problem: ownership must survive a promotion. "
                             "Solution: never re-key the owner.")
        slug = str(made["created"])
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        self.assertEqual(o.work_get("tgt", slug)["owner"]["node"], "tgt")

    def test_watchdogs_stay_attached_to_the_same_agent(self):
        o = self.org
        kept = [copy.deepcopy(w) for w in o.d.get("watchdogs", [])]
        o.subjugate("boss", "boss", "tgt")
        self.assertEqual(o.d.get("watchdogs", []), kept)

    def test_pending_mail_still_points_at_the_same_agents(self):
        o = self.org
        before = copy.deepcopy(o.d.get("mail", []))
        o.subjugate("boss", "boss", "tgt")
        after = o.d.get("mail", [])
        # the promotion adds notification mail; it never rewrites the
        # recipients or senders of what was already queued
        self.assertEqual(after[:len(before)], before)


# --------------------------------------------------------------------------
# authorization, recomputed from the NEW ancestry
# --------------------------------------------------------------------------
class AuthorizationTests(PromotionBase):
    def test_authority_follows_the_new_ancestry_in_both_directions(self):
        o = self.org
        self.assertTrue(o.is_ancestor("boss", "t1"))     # before
        self.assertFalse(o.is_ancestor("tgt", "x"))
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        # the caller's downward access to the promoted branch is GONE
        self.assertFalse(o.is_ancestor("boss", "t1"))
        self.assertFalse(o.is_ancestor("boss", "tgt"))
        # and the promoted target now commands the caller and its remainder
        self.assertTrue(o.is_ancestor("tgt", "boss"))
        self.assertTrue(o.is_ancestor("tgt", "x1"))

    def test_no_stale_downward_access_survives(self):
        """The caller may no longer act on the branch it used to command."""
        o = self.org
        o.subjugate("boss", "boss", "tgt")
        with self.assertRaises(LedgerError):
            o.set_scope("boss", "t1", charter="reaching into the old subtree")
        with self.assertRaises(LedgerError):
            o.retire("boss", "t2")

    def test_audiences_that_the_old_shape_justified_are_revoked(self):
        o = self.org
        o.audience_grant("boss", "t1", "boss")
        self.assertTrue(o._has_audience("t1", "boss"))
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        # anchored on the grantor (Section 7.3): boss no longer commands t1
        self.assertFalse(o._has_audience("t1", "boss"))


# --------------------------------------------------------------------------
# the seat-scoped ruling (user 2026-09-15)
# --------------------------------------------------------------------------
class SeatScopeRulingTests(PromotionBase):
    """"T inherits all of A's positional grants, A retains as much as
    pragmatic (besides [credit] grant)"."""

    def _widen_caller(self) -> None:
        o = self.org
        o.set_scope(USER, "boss", permission_mode="bypassPermissions",
                    tools={"bash": True, "web": True, "edit": True,
                           "subagents": True, "mcp": []},
                    team_charter="the caller's standing instruction")
        o.set_scope(USER, "tgt", permission_mode="plan",
                    tools={"bash": False, "web": False, "edit": False,
                           "subagents": False, "mcp": []},
                    team_charter="the target's own standing instruction")

    def test_target_inherits_the_callers_positional_grants(self):
        self._widen_caller()
        o = self.org
        out = o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        tgt = o.node("tgt")["scope"]
        self.assertEqual(tgt["permission_mode"], "bypassPermissions")
        self.assertTrue(tgt["tools"]["bash"])
        self.assertTrue(tgt["tools"]["edit"])
        # and it is disclosed rather than arriving in silence
        self.assertTrue(any("GRANTS IT" in w for w in out["warnings"]))

    def test_team_charter_is_the_one_thing_that_does_not_move(self):
        """User ruling 2026-09-15, second pass: "leave it untouched, dont
        change".  A charter is a single value, and the target brings its own
        team up with it — inheriting the caller's would overwrite the standing
        instruction for a team that never changed hands."""
        self._widen_caller()
        o = self.org
        out = o.subjugate("boss", "boss", "tgt")
        self.assertEqual(o.node("tgt").get("team_charter"),
                         "the target's own standing instruction")
        self.assertEqual(o.node("boss").get("team_charter"),
                         "the caller's standing instruction")
        # both parties are TOLD, rather than left to discover it
        self.assertTrue(any("keeps its own team charter" in w
                            for w in out["warnings"]),
                        "the caller was not told the charter did not transfer")
        self.assertTrue(any("orgtree_retool" in w for w in out["warnings"]))

    def test_the_promoted_agent_is_told_its_charter_is_its_own_to_write(self):
        o = self.org
        self._widen_caller()
        o.subjugate("boss", "boss", "tgt")
        texts = [str(e.get("text") or "")
                 for e in o.d.get("notices", {}).get("tgt", [])
                 if (e.get("ev") or {}).get("role") == "promoted"]
        self.assertTrue(texts, "the promoted agent got no promotion notice")
        self.assertTrue(any("TEAM CHARTER IS YOURS TO WRITE" in t
                            for t in texts))
        self.assertTrue(any("orgtree_retool" in t for t in texts))

    def test_a_target_with_no_charter_of_its_own_gains_none(self):
        """The caller's charter must not leak in through the empty case."""
        o = self.org
        o.set_scope(USER, "boss", team_charter="the caller's instruction")
        o.subjugate("boss", "boss", "tgt")
        self.assertIsNone(o.node("tgt").get("team_charter"))

    def test_caller_retains_all_of_its_own(self):
        self._widen_caller()
        o = self.org
        o.subjugate("boss", "boss", "tgt")
        boss = o.node("boss")["scope"]
        self.assertEqual(boss["permission_mode"], "bypassPermissions")
        self.assertTrue(boss["tools"]["bash"])
        self.assertEqual(o.node("boss").get("team_charter"),
                         "the caller's standing instruction")

    def test_the_callers_retained_team_is_not_clamped(self):
        """The finding that drove the question: any rule that left the caller
        holding less than it held would strip agents that never moved."""
        o = self.org
        self._widen_caller()
        o.set_scope(USER, "x", permission_mode="bypassPermissions",
                    tools={"bash": True, "web": True, "edit": True,
                           "subagents": True, "mcp": []})
        before = copy.deepcopy(o.node("x")["scope"])
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        self.assertEqual(o.node("x")["scope"], before,
                         "an agent that never moved lost capability")

    def test_the_targets_own_team_is_not_clamped(self):
        o = self.org
        self._widen_caller()
        before = copy.deepcopy(o.node("t1")["scope"])
        o.subjugate("boss", "boss", "tgt")
        self.assertEqual(o.node("t1")["scope"], before)

    def test_containment_invariant_holds_everywhere_afterwards(self):
        """No.30 + D-021 + D-102: every capability set stays a subset of its
        superior's.  Checked over the whole tree, not the moved pair."""
        self._widen_caller()
        o = self.org
        o.subjugate("boss", "boss", "tgt")
        for nid, n in o.nodes.items():
            p = n["parent"]
            if p is None:
                continue
            ps, cs = o.node(p)["scope"], n["scope"]
            with self.subTest(node=nid):
                self.assertLessEqual(
                    {d["path"] for d in cs["add_dirs"]},
                    {d["path"] for d in ps["add_dirs"]})
                for t in ("bash", "web", "edit", "subagents"):
                    if cs["tools"].get(t):
                        self.assertTrue(ps["tools"].get(t),
                                        f"{nid} holds tool {t} its superior lacks")
                self.assertLessEqual(
                    ledger.PM_LEVELS.index(cs.get("permission_mode", "acceptEdits")),
                    ledger.PM_LEVELS.index(ps.get("permission_mode", "acceptEdits")))

    def test_credit_grant_is_budget_neutral_for_everyone(self):
        """The ruling excludes the credit grant, and `_move` re-seats funding
        on its own — so every node's free credit is unchanged."""
        o = self.org
        before = {k: o.free(k) for k in o.nodes}
        o.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, o)
        after = {k: o.free(k) for k in o.nodes}
        self.assertEqual(before, after)

    def test_no_grant_goes_negative(self):
        self.org.subjugate("boss", "boss", "tgt")
        for nid, n in self.org.nodes.items():
            self.assertGreaterEqual(n["grant"], 0, f"{nid} holds a negative grant")


# --------------------------------------------------------------------------
# audit records and preview
# --------------------------------------------------------------------------
class AuditAndPreviewTests(PromotionBase):
    def test_the_log_records_promotion_semantics(self):
        o = self.org
        o.subjugate("boss", "boss", "tgt")
        row = [r for r in o.d["events"] if r["op"] == "subjugate"][-1]
        self.assertEqual(row["detail"]["promoted"], "tgt")
        self.assertEqual(row["detail"]["demoted"], "boss")
        self.assertEqual(row["detail"]["promoted_to"], "top")
        self.assertEqual(row["detail"]["demoted_to"], "tgt")
        self.assertEqual(row["detail"]["subtree"], 2)

    def test_interior_moves_are_not_logged_as_separate_reorganizations(self):
        """The committed transformation is ONE event.  Narrating the two
        interior legs would describe states that were never the result."""
        o = self.org
        before = len(o.d["events"])
        o.subjugate("boss", "boss", "tgt")
        added = o.d["events"][before:]
        self.assertEqual([r["op"] for r in added], ["subjugate"])

    def test_notifications_use_the_promotion_event_family(self):
        o = self.org
        base = notice_variants(o)
        o.subjugate("boss", "boss", "tgt")
        fresh = notice_variants(o) - base
        self.assertIn("lifecycle.subtree_promoted", fresh)
        # NOT the swap family, and not the raw interior moves either: the two
        # legs are implementation, and narrating them would tell agents about
        # a shape that was never the committed result
        self.assertNotIn("lifecycle.seat_swapped", fresh)
        self.assertNotIn("lifecycle.moved", fresh)

    def test_every_party_to_the_promotion_is_told(self):
        """The superior, the peers, the intermediate former parent, both
        teams and both principals each get their own rendering."""
        o = self.org
        roles = {}
        for nid, box in o.d.get("notices", {}).items():
            for e in box:
                ev = e.get("ev") or {}
                if ev.get("variant") == "lifecycle.subtree_promoted":
                    roles.setdefault(nid, set()).add(ev.get("role"))
        self.assertEqual(roles, {})          # nothing before the call
        o.subjugate("boss", "boss", "tgt")
        for nid, box in o.d.get("notices", {}).items():
            for e in box:
                ev = e.get("ev") or {}
                if ev.get("variant") == "lifecycle.subtree_promoted":
                    roles.setdefault(nid, set()).add(ev.get("role"))
                    self.assertTrue(str(e.get("text") or "").strip(),
                                    f"{nid} got an unrendered promotion event")
        self.assertEqual(roles.get("top"), {"new_parent"})
        self.assertEqual(roles.get("sibling"), {"peer"})
        # `mid` is BOTH: it lost the target out of its own team, and it is
        # still one of the caller's reports that just gained a level above
        # it.  Those are two separate facts and it is told both.
        self.assertEqual(roles.get("mid"), {"former_parent", "caller_child"})
        self.assertEqual(roles.get("x"), {"caller_child"})
        self.assertEqual(roles.get("t1"), {"target_child"})
        self.assertEqual(roles.get("t2"), {"target_child"})
        self.assertEqual(roles.get("tgt"), {"promoted"})
        # the caller is the actor here, so it is not mailed about its own act
        self.assertIsNone(roles.get("boss"))

    def test_preview_matches_the_committed_transformation(self):
        """The preview must describe the promotion, and must describe the
        SAME promotion the commit performs — a preview that still spoke of a
        seat swap would be the most misleading surface of all."""
        from orgtree import statepreview
        out = statepreview.preview(self.org, "boss", "orgtree_self_subjugate",
                                   {"target": "tgt"})
        self.assertFalse(out["applied"])
        # a preview runs on an isolated document: the live tree is untouched
        self.assertEqual(parents(self.org)["tgt"], "mid")
        self.assertEqual(parents(self.org)["boss"], "top")
        predicted = out["result"]
        self.assertEqual(predicted["promoted"], "tgt")
        self.assertEqual(predicted["demoted"], "boss")
        self.assertEqual(predicted["after"], {"tgt": "top", "boss": "tgt"})
        # now commit it for real and compare against what was predicted
        committed = self.org.subjugate("boss", "boss", "tgt")
        assert_tree_sound(self, self.org)
        for key in ("promoted", "demoted", "parent", "before", "after",
                    "subtree_kept", "retained_by_caller"):
            self.assertEqual(predicted[key], committed[key],
                             f"preview and commit disagree on {key!r}")
        self.assertEqual(parents(self.org)["tgt"], "top")
        self.assertEqual(parents(self.org)["boss"], "tgt")

    def test_result_reports_before_and_after_structure(self):
        out = self.org.subjugate("boss", "boss", "tgt")
        self.assertEqual(out["before"], {"boss": "top", "tgt": "mid"})
        self.assertEqual(out["after"], {"tgt": "top", "boss": "tgt"})
        self.assertEqual(out["subtree_kept"], 2)
        self.assertEqual(out["retained_by_caller"], 3)   # x, x1, mid

    def test_promotion_keeps_node_names_bound(self):
        """A promotion re-parents; it never rebinds a name.  The rename-repair
        classification has to say so, or a later repair refuses."""
        self.assertIn("subjugate", ledger.Org._NAME_KEEPING_OPS)
        self.assertIn("promote_subtree", ledger.Org._NAME_KEEPING_OPS)
        self.assertNotIn("subjugate", ledger.Org._NAME_BINDING_OPS)


# --------------------------------------------------------------------------
# the separate general swap is OUT OF SCOPE and must not have changed
# --------------------------------------------------------------------------
class SwapUnchangedTests(PromotionBase):
    """`orgtree_swap` keeps exactly the semantics it had: a pure relabeling of
    two positions, in which each agent takes over the OTHER's team.  This is
    deliberately different from the promotion and must stay that way."""

    def test_disjoint_swap_exchanges_teams_and_seats(self):
        o = self.org
        o.swap_seats(USER, "sibling", "x")
        assert_tree_sound(self, o)
        p = parents(o)
        self.assertEqual(p["sibling"], "boss")   # each took the other's seat
        self.assertEqual(p["x"], "top")
        # …and the other's reports: the teams did NOT travel with the agents
        self.assertEqual(p["sib-kid"], "x")
        self.assertEqual(p["x1"], "sibling")

    def test_nested_swap_still_exchanges_teams(self):
        o = self.org
        o.swap_seats(USER, "boss", "tgt")
        assert_tree_sound(self, o)
        p = parents(o)
        self.assertEqual(p["tgt"], "top")
        self.assertEqual(p["boss"], "mid")       # the seat, not "under tgt"
        self.assertEqual(p["x"], "tgt")          # boss's reports went to tgt
        self.assertEqual(p["t1"], "boss")        # and tgt's went to boss
        self.assertEqual(p["t2"], "boss")

    def test_swap_still_trades_seat_scoped_fields(self):
        o = self.org
        o.set_scope(USER, "boss", team_charter="boss team charter")
        o.set_scope(USER, "sibling", team_charter="sibling team charter")
        g_boss, g_sib = o.node("boss")["grant"], o.node("sibling")["grant"]
        o.swap_seats(USER, "boss", "sibling")
        self.assertEqual(o.node("boss")["grant"], g_sib)
        self.assertEqual(o.node("sibling")["grant"], g_boss)
        self.assertEqual(o.node("boss").get("team_charter"),
                         "sibling team charter")
        self.assertEqual(o.node("sibling").get("team_charter"),
                         "boss team charter")

    def test_swap_still_emits_the_seat_swapped_event(self):
        o = self.org
        base = notice_variants(o)
        o.swap_seats(USER, "sibling", "x")
        fresh = notice_variants(o) - base
        self.assertIn("lifecycle.seat_swapped", fresh)
        self.assertNotIn("lifecycle.subtree_promoted", fresh)

    def test_swap_still_refuses_top_level_reseating_by_an_agent(self):
        with self.assertRaises(LedgerError):
            self.org.swap_seats("boss", "top", "boss")

    def test_swap_is_still_reachable_and_logged_under_its_own_op(self):
        o = self.org
        before = len(o.d["events"])
        o.swap_seats(USER, "sibling", "x")
        self.assertEqual([r["op"] for r in o.d["events"][before:]], ["swap_seats"])


if __name__ == "__main__":       # pragma: no cover
    unittest.main()
