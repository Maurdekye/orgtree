"""No `orgtree_work` action accepts an argument it does not read.

THE DEFECT THIS PINS, WIDENED. `274fdb2` established the rule on `update`:
that action took an `acceptance` argument, returned an ordinary success
payload, ADVANCED THE ITEM'S REVISION, and wrote nothing — the field was on the
tool card and named nowhere in the dispatch, so it was read off the wire by
nobody. It scoped its guard to `update` deliberately and said so.

The dispatch has the same shape everywhere. `orgtree_work` is ONE tool card
with 77 arguments serving 32 actions, and each action reads only the arguments
its own branch NAMES. So every one of the 77 was offered on every action, and
anything an action did not name was accepted, dropped, and — on a mutating
action — followed by a revision bump that claimed something had changed.

WHAT THE AUDIT FOUND (2026-09-17, against ded9ab4):

  * `expected_rev` was the one piece of genuinely dead schema. The card said
    "update/evidence/receipt and every other mutating action"; it was read by
    eight, and nineteen actions — `receipt` among them, named on the card —
    read it not at all. That is the worst shape of this bug, because the
    field's whole purpose is to make a call SAFE: a caller passing it believed
    it had compare-and-set and had none. Refused now, and the card corrected.

    ⚠ TWO OF THOSE NINETEEN LATER EARNED THE REAL THING instead of the
    refusal, on their own ticket: `check` and `accept` write the acceptance
    record that decides whether an item is complete, so they honour
    `expected_rev` for real and ten actions now do. Seventeen still refuse it
    — two of those (`receipt`, `rangediff`) because they do their own.
  * `slug` on `list` (reads as a filter) and on `create` (reads as choosing
    the new item's name; names are minted from `title`).
  * `note` on artifact `revoke`, while `grant` and `review_revoke` both keep
    one. `logs` on `rangediff`, while only `receipt` reads them.
  * Thirteen arguments the dispatch READS that the card never advertises —
    `waiting_reason`, `sha`, `evidence`, `name`, `title`/`evidence_ref` on
    `finding`, and several on `receipt`. They are live and stay accepted.

WHAT THIS SUITE PINS:

  §1  THE ALLOW-LIST IS READ FROM THE DISPATCH, per action, in BOTH
      directions. A name allowed but never read is this ticket's own defect
      coming back; a name read but not allowed would make the guard refuse a
      live argument. This is the durable half — the audit above is not.
  §2  Every action the dispatch answers to has an entry, aliases included.
  §3  A refused call leaves the org document BYTE-IDENTICAL and the revision
      unmoved: no field, no history row, no rev.
  §4  The refusal names the field AND the action that does write it.
  §5  `expected_rev` is refused everywhere it is dead, and the message
      distinguishes "redundant here" (receipt/rangediff, which do their own
      compare-and-set) from "no protection at all" (the other fifteen).
      `check` and `accept` are in NEITHER group any more — they honour it for
      real, and tests/test_work_accept_check_cas.py pins that behaviour.
  §6  The read-shaped actions are guarded too, and say so differently: a read
      moves no revision, so it must not claim one did not move.
  §7  The tool card no longer advertises `expected_rev` for actions that drop
      it — the refusal and the correction land in the same commit.
"""
import inspect
import json
import os
import re
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-deadargs-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import api, ledger, mcptool  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0


def fixture():
    """A fresh org: `owner-a` owns one item."""
    global _n
    _n += 1
    org = ledger.Org.create(f"da-{_n}")
    for nid in ("owner-a", "peer-b"):
        org.hire(USER, None, "haiku", 0, nid)
    org.work_create("owner-a", "Dead args fixture",
                    objective="Problem: actions accepted arguments nobody "
                              "read. Solution: these assertions.",
                    acceptance=["It refuses what it cannot write."])
    return org, org.d["work_items"][-1]["slug"]


# ─────────────────────────────────────────────────────────────────────────────
# the dispatch source, sliced per action — §1 hangs entirely on this being an
# honest reading of the code rather than a second copy of the table
# ─────────────────────────────────────────────────────────────────────────────

def _branches():
    """Each mutating action → the exact source of the branch that serves it."""
    src = inspect.getsource(api._work_mutate_action)
    # DOTALL and non-greedy: a branch header may span lines
    # (`if act in ("verdict", "candidate_verdict",\n  "review_verdict"):`),
    # and reading only its first line silently folded four actions into the
    # branch above them the first time this ran.
    heads = list(re.finditer(r"\n    if act (?:==|in) (.*?):\n", src, re.S))
    out = {}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(src)
        seg = src[m.start():end]
        for act in re.findall(r'"([a-z_]+)"', m.group(1)):
            out[act] = seg
    return out


BRANCH = _branches()

#: helper sources a branch delegates into, keyed by the action they serve
_HELPERS = {
    "artifact": ("_agent_work_artifact",),
    "artifact_read": ("_agent_work_artifact_read",),
    "receipts": ("_work_receipts_read",),
    "receipt": ("_work_receipt_call", "_work_checkout", "_work_receipt_logs"),
    "rangediff": ("_work_receipt_call", "_work_checkout"),
    "list": ("_work_read_call", "_work_projection"),
    "get": ("_work_read_call", "_work_projection"),
    "verify": ("_work_read_call",),
}


def source_for(act):
    """Everything that could possibly read an argument on behalf of `act`."""
    parts = [BRANCH[act]] if act in BRANCH else []
    for fn in _HELPERS.get(act, ()):
        parts.append(inspect.getsource(getattr(api, fn)))
    assert parts, act
    return "\n".join(parts)


#: the exclusive sources — code that serves exactly one action, so a name read
#: in it is a name read BY that action. The shared read dispatch is excluded:
#: `_work_read_call` serves list/get/verify at once, so reading
#: `include_archived` there says nothing about `get`.
_EXCLUSIVE = {
    **{act: [BRANCH[act]] for act in BRANCH},
    "artifact": [BRANCH["artifact"],
                 inspect.getsource(api._agent_work_artifact)],
    "artifact_read": [inspect.getsource(api._agent_work_artifact_read)],
    "receipts": [inspect.getsource(api._work_receipts_read)],
}

_READ_FORMS = (
    r'a\.get\("([a-z_]+)"\)',
    r'a\["([a-z_]+)"\]',
    r'_s\("([a-z_]+)"\)',
    r'_arg_flag\(a, "([a-z_]+)"\)',
    r'_arg_int\(a, "([a-z_]+)"',
    r'_work_list_arg\(a, "([a-z_]+)"\)',
    r'"([a-z_]+)" (?:not )?in a\b',
)


def names_read(sources):
    out = set()
    for s in sources:
        for pat in _READ_FORMS:
            out |= set(re.findall(pat, s))
    return out


class TheAllowListIsReadFromTheDispatch(unittest.TestCase):
    """§1 — both directions, per action. The durable half of this ticket."""

    def test_every_allowed_argument_is_actually_dispatched(self):
        """A name the table allows but the dispatch never reads IS the defect.

        That is exactly what `acceptance` was on `update` before 274fdb2: on
        the card, on the way in, and named nowhere in the call.
        """
        for act, allowed in api._WORK_ACTION_ARGS.items():
            src = source_for(act)
            for name in allowed:
                if name in ("action", "slug"):
                    continue    # the envelope, read before the branch runs
                self.assertIn(
                    f'"{name}"', src,
                    f"`{name}` is allowed on action={act} but that action's "
                    f"dispatch never reads it — that is exactly the defect "
                    f"this suite exists for")

    def test_every_dispatched_argument_is_allowed(self):
        """And the other way: a name the dispatch READS must be allowed.

        Without this, wiring a new argument into a branch and forgetting the
        table would make the guard refuse a live field — the same class of
        silent wrongness pointed the other way.
        """
        envelope = {"action", "slug", "id"}
        for act, sources in _EXCLUSIVE.items():
            allowed = api._work_allowed(act)
            for name in names_read(sources) - envelope:
                self.assertIn(
                    name, allowed,
                    f"action={act} READS `{name}` but the allow-list omits "
                    f"it, so the guard would refuse a field that works")

    def test_the_envelope_is_not_allowed_where_it_is_ignored(self):
        """`slug` is read by every action but `list` and `create`."""
        for act in api._WORK_ACTION_ARGS:
            allowed = api._work_allowed(act)
            if act in ("list", "create"):
                self.assertNotIn("slug", allowed, act)
            else:
                self.assertIn("slug", allowed, act)
            self.assertIn("action", allowed, act)


class EveryActionHasAnEntry(unittest.TestCase):
    """§2 — including the alias spellings, which are the same branch."""

    def actions_in_the_refusal(self):
        """Every action name the dispatch's own error message lists."""
        src = inspect.getsource(api._work_mutate_action)
        tail = src.split('action must be ')[1]
        return set(re.findall(r"[a-z_]+", tail.split('")')[0])) - {"n"}

    def test_the_dispatch_answers_to_nothing_the_table_omits(self):
        for act in sorted(BRANCH):
            self.assertIsNotNone(
                api._work_allowed(act),
                f"the dispatch serves action={act} and the allow-list has no "
                f"entry for it, so it is unguarded")
        for act in api._WORK_READ_ACTIONS:
            self.assertIsNotNone(api._work_allowed(act), act)

    def test_the_advertised_action_list_is_covered(self):
        for act in self.actions_in_the_refusal():
            self.assertIsNotNone(api._work_allowed(act), act)

    def test_aliases_share_their_target_read_set(self):
        for alias, canon in api._WORK_ACTION_ALIASES.items():
            self.assertIn(alias, BRANCH, alias)
            self.assertEqual(api._work_allowed(alias),
                             api._work_allowed(canon), alias)

    def test_an_unknown_action_is_left_to_the_dispatch(self):
        """A misspelled action gets the action-list message, not this one."""
        self.assertIsNone(api._work_allowed("uptdate"))
        api._work_refuse_unused({"action": "uptdate", "nonsense": 1},
                                "uptdate")          # does not raise


class ARefusedCallChangesNothing(unittest.TestCase):
    """§3 — byte-identical, revision unmoved, through the real dispatch."""

    def untouched(self, act, **extra):
        org, slug = fixture()
        before = json.dumps(org.d, sort_keys=True, default=str)
        rev = next(i for i in org.d["work_items"]
                   if i["slug"] == slug)["rev"]
        with self.assertRaises(LedgerError) as e:
            api._work_mutate_action(org, "owner-a",
                                    {"action": act, "slug": slug, **extra},
                                    act, slug)
        self.assertEqual(json.dumps(org.d, sort_keys=True, default=str), before,
                         f"action={act} was refused and still changed the "
                         f"document")
        self.assertEqual(next(i for i in org.d["work_items"]
                              if i["slug"] == slug)["rev"], rev)
        return str(e.exception)

    def test_a_field_belonging_to_another_action(self):
        self.untouched("check", acceptance=["one."])
        self.untouched("claim", done_so_far=["a"])
        self.untouched("accept", status="done")
        self.untouched("participants", owner="peer-b")

    def test_an_argument_nobody_ever_defined(self):
        msg = self.untouched("decision", ruling="x")
        self.assertIn("ruling", msg)
        self.assertIn("no `orgtree_work` action reads", msg)

    def test_a_supplied_receipt_keeps_its_own_message(self):
        """A generic guard in front of a specific one SHADOWS it.

        `evidence` already refused a caller-written receipt by name, and that
        message says what a receipt is and which action captures one. Putting
        "no action reads `receipt`" in front of it would have been a worse
        answer to the same mistake.
        """
        msg = self.untouched("evidence", receipt={"candidate": "abc1234"})
        self.assertIn("cannot be supplied by the caller", msg)
        self.assertIn("CAPTURED BY THE BACKEND", msg)

    def test_the_retired_id_keeps_its_own_message(self):
        """`id` has a better refusal than "unused argument" — it must win."""
        org, slug = fixture()
        with self.assertRaises(LedgerError) as e:
            api._work_mutate_action(org, "owner-a",
                                    {"action": "accept", "id": slug}, "accept",
                                    slug)
        self.assertIn("readable name", str(e.exception))

    def test_a_legitimate_call_still_works(self):
        """The negative control: the guard must not refuse a real call."""
        org, slug = fixture()
        r = api._work_mutate_action(
            org, "owner-a",
            {"action": "decision", "slug": slug,
             "text": "Refuse what you do not consume."},
            "decision", slug)
        self.assertTrue(r)
        self.assertEqual(len([s for s in
                              next(i for i in org.d["work_items"]
                                   if i["slug"] == slug)["scope"]
                              if s["kind"] == "decision"]), 1)


class TheRefusalNamesTheRoute(unittest.TestCase):
    """§4 — "unknown argument" makes the caller guess; this does not."""

    def refuse(self, act, **a):
        with self.assertRaises(LedgerError) as e:
            api._work_refuse_unused({"action": act, "slug": "x", **a}, act)
        return str(e.exception)

    def test_it_names_the_action_that_does_write_the_field(self):
        for act, field, wanted in (
                ("check", "text", "action=decision"),
                ("claim", "index", "action=check"),
                ("accept", "parent", "action=move"),
                ("decision", "participants", "action=participants"),
                ("move", "by", "action=supersede"),
                ("assign", "detail", "action=finding"),
                ("archive", "disposition", "action=dispose"),
                ("supersede", "path", "action=artifact"),
                ("delete", "stage", "action=claim"),
                ("participants", "dependencies", "creation")):
            msg = self.refuse(act, **{field: "x"})
            self.assertIn(f"`{field}`", msg)
            self.assertIn(wanted, msg)
            self.assertIn(f"action={act} does not write", msg)

    def test_a_derived_route_lists_every_writer(self):
        """`grant_to` is written by exactly one action, and it is named."""
        self.assertIn("action=artifact", self.refuse("grant", grant_to=["x"]))

    def test_the_route_is_derived_not_restated(self):
        """A field's route comes from the table, so it cannot go stale."""
        for field in ("scope", "grant_to", "old_tip", "logs", "command",
                      "next_actor", "supersedes", "gate", "blocked_count"):
            writers = sorted(k for k, v in api._WORK_ACTION_ARGS.items()
                             if field in v)
            self.assertTrue(writers, field)
            route = api._work_field_route(field, "accept")
            for w in writers:
                self.assertIn(f"action={w}", route, field)

    def test_the_action_specific_routes(self):
        self.assertIn("MINTED FROM ITS `title`",
                      self.refuse("create", slug="chosen-name"))
        self.assertIn("action=get", self.refuse("list", slug="x"))
        self.assertIn("action=receipt", self.refuse("rangediff", logs=["a.txt"]))
        self.assertIn("action=grant", self.refuse("revoke", note="why"))


class ExpectedRevIsTheDeadSchema(unittest.TestCase):
    """§5 — the one advertised-but-unread argument, and its two refusals.

    The card said "update/evidence/receipt and every other mutating action".
    Eight honoured it; nineteen read it not at all. The card is corrected in
    this same commit, and that pairing is the point: this field is not
    `acceptance`, which nobody could use successfully. Agents are passing
    `expected_rev` right now, correctly, BECAUSE THE CARD TELLS THEM TO — so a
    refusal that arrived before the correction would reject every careful
    caller for following the documentation.

    ⚠ `check` and `accept` LEFT THIS SET on their own later ticket: they were
    given genuine compare-and-set instead of a refusal, so they are asserted
    as HONOURING it here and exercised in test_work_accept_check_cas.py.
    Seventeen still refuse.
    """

    def test_nothing_is_exempt_from_the_guard_any_more(self):
        self.assertEqual(api._WORK_GUARD_EXEMPT, frozenset())

    def test_it_is_refused_wherever_it_is_dead(self):
        for act in ("claim", "participants", "decision",
                    "move", "assign", "supersede", "archive", "delete",
                    "review", "verdict", "create", "handoff", "receipt",
                    "rangediff", "review_request", "review_grant",
                    "review_revoke"):
            with self.assertRaises(LedgerError, msg=act) as e:
                api._work_refuse_unused({"action": act, "slug": "x",
                                         "expected_rev": 3}, act)
            self.assertIn("`expected_rev`", str(e.exception), act)

    def test_exactly_ten_actions_honour_it(self):
        honour = sorted(k for k, v in api._WORK_ACTION_ARGS.items()
                        if "expected_rev" in v)
        self.assertEqual(honour, ["accept", "addendum", "artifact", "check",
                                  "dispose", "evidence", "finding", "grant",
                                  "revoke", "update"])

    def test_every_honouring_action_has_the_ledger_parameter(self):
        """The allow-list is not the claim — the ledger signature is."""
        for act, fn in (("update", "work_update"),
                        ("addendum", "work_addendum"),
                        ("evidence", "work_evidence"),
                        ("finding", "work_finding"),
                        ("dispose", "work_finding_dispose"),
                        ("artifact", "work_artifact_record"),
                        ("grant", "work_artifact_grant"),
                        ("revoke", "work_artifact_revoke"),
                        ("check", "work_check"),
                        ("accept", "work_accept")):
            sig = inspect.signature(getattr(ledger.Org, fn))
            self.assertIn("expected_rev", sig.parameters, act)

    def test_no_other_action_has_it(self):
        """The measurement behind the audit: these ledger methods have no
        compare-and-set parameter at all, so the argument reached nothing."""
        for act, fn in (("claim", "work_claim"),
                        ("participants", "work_participants"),
                        ("decision", "work_decision"), ("move", "work_move"),
                        ("supersede", "work_supersede"),
                        ("delete", "work_delete"),
                        ("assign", "work_assign"),
                        ("archive", "work_archive_now"),
                        ("create", "work_create"),
                        ("review", "work_review_decide"),
                        ("verdict", "work_candidate_verdict")):
            sig = inspect.signature(getattr(ledger.Org, fn))
            self.assertNotIn(
                "expected_rev", sig.parameters,
                f"{fn} now takes expected_rev — action={act} should read it "
                f"instead of refusing it")

    def test_receipt_and_rangediff_are_told_it_is_redundant(self):
        """They are NOT missing compare-and-set — they do their own."""
        for act in ("receipt", "rangediff"):
            route = api._work_field_route("expected_rev", act)
            self.assertIn("its OWN compare-and-set", route)
            self.assertIn("stale", route)

    def test_the_others_are_told_they_had_no_protection(self):
        route = api._work_field_route("expected_rev", "claim")
        self.assertIn("NO protection", route)
        self.assertIn("action=update", route)
        self.assertIn("action=evidence", route)

    def test_the_route_now_names_check_and_accept_as_writers(self):
        """The refusal a dead action gives is DERIVED from the allow-list, so
        the two that gained real compare-and-set appear in it without anybody
        editing the sentence. If this ever fails, the derivation was replaced
        by a hand-written list and the next change will go stale silently."""
        route = api._work_field_route("expected_rev", "claim")
        self.assertIn("action=check", route)
        self.assertIn("action=accept", route)

    def test_a_refused_expected_rev_moves_nothing(self):
        org, slug = fixture()
        before = json.dumps(org.d, sort_keys=True, default=str)
        for act in ("claim", "decision", "participants"):
            with self.assertRaises(LedgerError):
                api._work_mutate_action(org, "owner-a",
                                        {"action": act, "slug": slug,
                                         "expected_rev": 1}, act, slug)
        self.assertEqual(json.dumps(org.d, sort_keys=True, default=str), before)


class TheReadActionsAreGuardedToo(unittest.TestCase):
    """§6 — and refused in words that fit a call that writes nothing."""

    def test_the_read_dispatch_applies_the_guard(self):
        src = inspect.getsource(api._work_read_call)
        self.assertIn("_work_refuse_unused(a, act)", src)
        # before any of the work, or the refusal is not free
        self.assertLess(src.index("_work_refuse_unused"),
                        src.index('if act in ("receipt", "rangediff")'))

    def test_a_read_refusal_claims_no_revision(self):
        with self.assertRaises(LedgerError) as e:
            api._work_refuse_unused({"action": "list", "slug": "x"}, "list")
        msg = str(e.exception)
        self.assertIn("action=list does not read", msg)
        self.assertNotIn("revision", msg)
        self.assertNotIn("NOTHING WAS WRITTEN", msg)

    def test_a_write_refusal_does(self):
        with self.assertRaises(LedgerError) as e:
            api._work_refuse_unused({"action": "check", "slug": "x",
                                     "text": "a ruling"}, "check")
        self.assertIn("revision did not advance", str(e.exception))

    def test_every_read_action_accepts_its_own_arguments(self):
        for act in ("list", "get", "verify", "receipts", "artifact_read",
                    "receipt", "rangediff"):
            a = {k: "x" for k in api._work_allowed(act)}
            a["action"] = act
            api._work_refuse_unused(a, act)       # does not raise

    def test_every_mutating_action_accepts_its_own_arguments(self):
        for act in api._WORK_ACTION_ARGS:
            a = {k: "x" for k in api._work_allowed(act)}
            a["action"] = act
            api._work_refuse_unused(a, act)       # does not raise
        for alias in api._WORK_ACTION_ALIASES:
            a = {k: "x" for k in api._work_allowed(alias)}
            a["action"] = alias
            api._work_refuse_unused(a, alias)     # does not raise


class TheCardSaysSo(unittest.TestCase):
    """§7 — the card is what a caller reads before it writes, and a promise
    the code refuses is worse than no promise."""

    def desc(self, field):
        card = next(t for t in mcptool.TOOLS if t["name"] == "orgtree_work")
        return card["inputSchema"]["properties"][field]["description"]

    def test_expected_rev_no_longer_claims_every_mutating_action(self):
        d = self.desc("expected_rev")
        self.assertNotIn("and every other mutating action", d)
        self.assertIn("AND NO OTHER ACTION", d)

    def test_it_names_every_action_that_honours_it(self):
        d = self.desc("expected_rev")
        for act in sorted(k for k, v in api._WORK_ACTION_ARGS.items()
                          if "expected_rev" in v):
            self.assertIn(act, d, act)

    def test_it_says_the_rest_refuse_rather_than_drop(self):
        d = self.desc("expected_rev")
        self.assertIn("REFUSES", d)
        self.assertIn("receipt", d)

    def test_slug_still_says_where_it_does_not_apply(self):
        self.assertIn("every action but list/create", self.desc("slug"))


if __name__ == "__main__":
    unittest.main()
