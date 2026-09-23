"""`orgtree_work update` never reports success for a change it did not make.

THE DEFECT THIS PINS. `action=update` accepted an `acceptance` argument,
returned an ordinary success payload, ADVANCED THE ITEM'S REVISION, and wrote
nothing at all. The argument was on the tool card and was named nowhere in the
dispatch that calls `work_update`, so it was read off the wire by nobody.

It bit its own reporters, twice, within three minutes and independently:
`switch-reliability` took an item from rev 14 to rev 15 with a seven-condition
rewrite and recorded in a review packet that the conditions were amended, and
`coordinator-opus` told the user a different ticket's acceptance had been
widened from five conditions to seven. Both statements were false, both were
made in good faith, and neither was catchable from the response — only by
reading the store afterwards.

THE REVISION BUMP IS THE DANGEROUS HALF. A silently ignored field that left the
revision alone would still be a bug, but a careful caller could notice. A bump
is a CLAIM THAT SOMETHING CHANGED, and it is what made the response
indistinguishable from a real write.

WHAT THIS SUITE PINS:

  §1  `update` WRITES `acceptance`: the stored conditions become the submitted
      ones, and the result says what they became.
  §2  The rewrite is VERSIONED into the append-only `scope` record — kind
      `acceptance`, the complete before and after, superseding the previous
      acceptance row — exactly as the description is.
  §3  CHECK STATE TRAVELS WITH THE TEXT, NOT THE INDEX: an unchanged condition
      keeps its checks through a reorder or an insertion, a changed one is
      cleared, and every clearing is disclosed in the result and counted in the
      history row.
  §4  ATOMICITY: every refusal — a blank entry, an over-limit condition, an
      empty list, a non-owner, a stale `expected_rev` — leaves the conditions,
      the revision and the scope record exactly as they were.
  §5  NO OTHER FIELD IS SILENTLY IGNORED: an argument `update` does not read is
      refused by name, with the action that does write it, and the refusal
      leaves the revision alone. The allow-list is asserted against the
      dispatch rather than restated by hand.
  §6  The tool card says `create/update`, because a card that says `create` is
      what made two agents believe the opposite of what the code did.
"""
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-acceptfield-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import api, ledger, mcptool, workfields  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402

_n = 0

FIVE = [f"Condition {i} holds." for i in range(1, 6)]


def fixture(acceptance=None):
    """A fresh org: `owner-a` owns an item carrying five conditions."""
    global _n
    _n += 1
    org = ledger.Org.create(f"af-{_n}")
    for nid in ("owner-a", "peer-b"):
        org.hire(USER, None, "haiku", 0, nid)
    org.work_create("owner-a", "Acceptance fixture",
                    objective="Problem: update dropped the acceptance field. "
                              "Solution: these assertions.",
                    acceptance=list(FIVE if acceptance is None else acceptance))
    return org, org.d["work_items"][-1]["slug"]


def item(org, slug):
    return next(i for i in org.d["work_items"] if i["slug"] == slug)


def texts(org, slug):
    return [c["text"] for c in item(org, slug)["acceptance"]]


def update(org, slug, **kw):
    kw.setdefault("done_so_far", ["did a thing"])
    kw.setdefault("working_on_next", ["next thing"])
    return org.work_update("owner-a", slug, kw.pop("done_so_far"),
                           kw.pop("working_on_next"), **kw)


class WritesTheField(unittest.TestCase):
    """§1 — the conditions the caller sent are the conditions stored."""

    def test_rewrite_is_stored(self):
        org, slug = fixture()
        widened = FIVE + ["A sixth condition.", "A seventh condition."]
        r = update(org, slug, acceptance=list(widened))
        self.assertEqual(texts(org, slug), widened)
        # the result carries what was STORED, so a caller never has to read the
        # item back to learn whether its rewrite landed
        self.assertEqual(r["acceptance"], widened)
        self.assertEqual(r["acceptance_change"]["from"], 5)
        self.assertEqual(r["acceptance_change"]["to"], 7)
        self.assertEqual(r["acceptance_change"]["added"],
                         ["A sixth condition.", "A seventh condition."])

    def test_the_original_reproduction(self):
        """The coordinator's measured case: 5 stored, 7 submitted."""
        org, slug = fixture()
        before_rev = item(org, slug)["rev"]
        update(org, slug, acceptance=FIVE + ["six.", "seven."])
        self.assertEqual(len(item(org, slug)["acceptance"]), 7)
        self.assertGreater(item(org, slug)["rev"], before_rev)

    def test_narrowing_and_amending(self):
        """The case the defect made impossible: amend one condition's text."""
        org, slug = fixture()
        amended = list(FIVE)
        amended[2] = "Condition 3 holds, on the supervisor path only."
        update(org, slug, acceptance=amended)
        self.assertEqual(texts(org, slug), amended)

    def test_an_identical_list_writes_nothing_and_says_so(self):
        org, slug = fixture()
        r = update(org, slug, acceptance=list(FIVE))
        self.assertTrue(r["acceptance_change"]["unchanged"])
        self.assertIsNone(r["acceptance_change"].get("scope_seq"))
        self.assertEqual(len(item(org, slug).get("scope") or []), 0)

    def test_absent_argument_is_silent(self):
        """A call that does not mention acceptance says nothing about it."""
        org, slug = fixture()
        r = update(org, slug)
        self.assertIsNone(r["acceptance"])
        self.assertIsNone(r["acceptance_change"])


class Versioned(unittest.TestCase):
    """§2 — the append-only scope record keeps both sides, in full."""

    def test_scope_row_holds_before_and_after(self):
        org, slug = fixture()
        update(org, slug, acceptance=FIVE[:2] + ["A new one."])
        rows = [r for r in item(org, slug)["scope"] if r["kind"] == "acceptance"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        for t in FIVE:
            self.assertIn(t, row["before"])
        self.assertIn("A new one.", row["after"])
        self.assertNotIn("A new one.", row["before"])
        self.assertEqual(row["mode"], "replace")
        self.assertEqual(row["by"]["node"], "owner-a")

    def test_second_rewrite_supersedes_the_first(self):
        org, slug = fixture()
        update(org, slug, acceptance=FIVE + ["six."])
        update(org, slug, acceptance=FIVE + ["six.", "seven."])
        rows = [r for r in item(org, slug)["scope"] if r["kind"] == "acceptance"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["superseded_by"], rows[1]["seq"])
        self.assertEqual(rows[1]["supersedes"], rows[0]["seq"])
        # the superseded row keeps its own text forever
        self.assertIn("six.", rows[0]["after"])

    def test_objective_and_acceptance_in_one_call_mint_two_rows(self):
        org, slug = fixture()
        update(org, slug, objective="Problem: still broken. Solution: fix it.",
               acceptance=FIVE + ["six."])
        kinds = [r["kind"] for r in item(org, slug)["scope"]]
        self.assertEqual(sorted(kinds), ["acceptance", "objective"])

    def test_history_row_points_at_the_scope_row(self):
        org, slug = fixture()
        update(org, slug, acceptance=FIVE + ["six."])
        row = item(org, slug)["history"][-1]["changes"]["acceptance"]
        seq = [r for r in item(org, slug)["scope"]
               if r["kind"] == "acceptance"][0]["seq"]
        self.assertEqual(row["scope_seq"], seq)
        self.assertEqual((row["from"], row["to"]), (5, 6))


def check_all(org, slug):
    """Mark every condition met, the way a real completion does."""
    for i in range(len(item(org, slug)["acceptance"])):
        org.work_check("owner-a", slug, i, "tests/x.log", "ran it",
                       classification="met", artifact="tests/x.log",
                       runner="python", execution="independent",
                       result="passed")


class ChecksTravelWithTheText(unittest.TestCase):
    """§3 — the index is not what a check is attached to."""

    def test_reorder_keeps_every_check(self):
        org, slug = fixture()
        check_all(org, slug)
        r = update(org, slug, acceptance=list(reversed(FIVE)))
        self.assertEqual(texts(org, slug), list(reversed(FIVE)))
        self.assertTrue(all(c["checked"] for c in item(org, slug)["acceptance"]))
        self.assertEqual(r["acceptance_change"]["checks_kept"], 5)
        self.assertEqual(r["acceptance_change"]["checks_cleared"], [])

    def test_insertion_does_not_shift_a_check_onto_another_condition(self):
        org, slug = fixture()
        check_all(org, slug)
        update(org, slug, acceptance=["A brand new first condition."] + FIVE)
        acc = item(org, slug)["acceptance"]
        self.assertIsNone(acc[0]["checked"])          # the new one is unchecked
        for cond, want in zip(acc[1:], FIVE):
            self.assertEqual(cond["text"], want)
            self.assertIsNotNone(cond["checked"])     # its own check came along

    def test_changed_text_clears_its_check_and_says_so(self):
        org, slug = fixture()
        check_all(org, slug)
        amended = list(FIVE)
        amended[1] = "Condition 2 holds, on the supervisor path only."
        r = update(org, slug, acceptance=amended)
        acc = item(org, slug)["acceptance"]
        self.assertIsNone(acc[1]["checked"])
        cleared = r["acceptance_change"]["checks_cleared"]
        self.assertEqual(len(cleared), 1)
        self.assertEqual(cleared[0]["was_index"], 1)
        self.assertEqual(cleared[0]["text"], FIVE[1])
        self.assertIn("re-check", r["acceptance_change"]["how"])
        self.assertEqual(
            item(org, slug)["history"][-1]["changes"]["acceptance"]
            ["checks_cleared"], 1)

    def test_a_cleared_check_blocks_completion_until_it_is_re_checked(self):
        """The completion guard is untouched, and it now sees the truth."""
        org, slug = fixture()
        check_all(org, slug)
        amended = list(FIVE)
        amended[0] = "Condition 1 holds, narrowed to the ledger."
        update(org, slug, acceptance=amended)
        with self.assertRaises(LedgerError):
            org.work_accept("owner-a", slug, "done")

    def test_a_repeated_sentence_carries_one_check_once(self):
        org, slug = fixture(["Same sentence.", "Same sentence."])
        org.work_check("owner-a", slug, 0, "tests/x.log", "ran it",
                       classification="met", artifact="tests/x.log",
                       runner="python", execution="independent",
                       result="passed")
        update(org, slug, acceptance=["Same sentence."])
        acc = item(org, slug)["acceptance"]
        self.assertEqual(len(acc), 1)
        self.assertIsNotNone(acc[0]["checked"])


class RefusalsWriteNothing(unittest.TestCase):
    """§4 — every refusal leaves the item, the rev and the scope alone."""

    def untouched(self, org, slug, call):
        before = (list(texts(org, slug)), item(org, slug)["rev"],
                  len(item(org, slug).get("scope") or []),
                  len(item(org, slug).get("history") or []))
        with self.assertRaises(LedgerError) as e:
            call()
        after = (list(texts(org, slug)), item(org, slug)["rev"],
                 len(item(org, slug).get("scope") or []),
                 len(item(org, slug).get("history") or []))
        self.assertEqual(before, after)
        return str(e.exception)

    def test_blank_entry(self):
        org, slug = fixture()
        msg = self.untouched(org, slug,
                             lambda: update(org, slug, acceptance=["ok.", "  "]))
        self.assertIn("acceptance[1]", msg)
        self.assertIn("NOTHING WAS WRITTEN", msg)

    def test_over_length_condition_names_the_three_numbers(self):
        org, slug = fixture()
        limit = workfields.limit_of("acceptance")
        long = "z" * (limit + 40)
        msg = self.untouched(org, slug,
                             lambda: update(org, slug, acceptance=["ok.", long]))
        self.assertIn(str(limit + 40), msg)
        self.assertIn(str(limit), msg)
        self.assertIn("40", msg)

    def test_empty_list_may_not_erase_the_contract(self):
        org, slug = fixture()
        msg = self.untouched(org, slug,
                             lambda: update(org, slug, acceptance=[]))
        self.assertIn("emptied", msg)

    def test_a_paragraph_is_not_a_list(self):
        org, slug = fixture()
        self.untouched(org, slug,
                       lambda: update(org, slug, acceptance="one; two"))

    def test_re_scoping_is_owner_level(self):
        org, slug = fixture()
        org.work_participants("owner-a", slug, add=["peer-b"])
        before = list(texts(org, slug))
        with self.assertRaises(LedgerError) as e:
            org.work_update("peer-b", slug, ["x"], ["y"],
                            acceptance=FIVE + ["six."])
        self.assertIn("re-scope", str(e.exception))
        self.assertEqual(texts(org, slug), before)

    def test_stale_expected_rev_refuses_before_the_rewrite(self):
        org, slug = fixture()
        stale = item(org, slug)["rev"]
        update(org, slug)                       # somebody else writes
        self.untouched(org, slug,
                       lambda: update(org, slug, acceptance=FIVE + ["six."],
                                      expected_rev=stale))


class NoOtherFieldIsIgnored(unittest.TestCase):
    """§5 — the audit half: what `update` cannot write, it refuses."""

    def call(self, **a):
        a.setdefault("action", "update")
        a.setdefault("slug", "x")
        api._work_refuse_unused(a, "update")

    def test_every_dispatched_argument_is_allowed(self):
        """The allow-list is READ FROM THE DISPATCH, not restated by hand.

        A field the dispatch reads but the list forgets would be refused for
        every caller; a field the list allows but the dispatch drops is this
        ticket's own defect, returning by a different door."""
        import inspect
        src = inspect.getsource(api._work_mutate_action)
        body = src.split('if act == "update":')[1].split('if act == "addendum":')[0]
        for name in api._WORK_UPDATE_ARGS:
            if name in ("action", "slug"):
                continue            # the envelope, read before the dispatch
            self.assertIn(f'"{name}"', body,
                          f"`{name}` is allowed on update but the dispatch "
                          f"never reads it — that is exactly the defect this "
                          f"suite exists for")

    def test_acceptance_is_allowed_now(self):
        self.call(acceptance=["one."])           # does not raise

    def test_participants_is_refused_with_its_real_route(self):
        with self.assertRaises(LedgerError) as e:
            self.call(participants=["peer-b"])
        msg = str(e.exception)
        self.assertIn("`participants`", msg)
        self.assertIn("action=participants", msg)
        self.assertIn("NOTHING WAS WRITTEN", msg)

    def test_the_other_silently_dropped_fields(self):
        for field, wanted in (("dependencies", "creation"),
                              ("kind", "creation"),
                              ("parent", "action=move"),
                              ("note", "objective"),
                              ("text", "action=decision"),
                              ("index", "action=check")):
            with self.assertRaises(LedgerError) as e:
                self.call(**{field: "x"})
            self.assertIn(f"`{field}`", str(e.exception))
            self.assertIn(wanted, str(e.exception))

    def test_an_unknown_argument_is_refused_too(self):
        with self.assertRaises(LedgerError) as e:
            self.call(acceptance_conditions=["one."])
        self.assertIn("acceptance_conditions", str(e.exception))

    def test_the_refusal_names_the_revision_promise(self):
        with self.assertRaises(LedgerError) as e:
            self.call(kind="code")
        self.assertIn("revision did not advance", str(e.exception))

    def test_a_plain_update_is_untouched(self):
        self.call(done_so_far=["a"], working_on_next=["b"], status="in_progress",
                  attention=True, attention_reason="look", expected_rev=3,
                  owner="owner-a", reviewer="peer-b", review_note="n",
                  review_candidate="abc1234", title="t", objective="o",
                  objective_append=None, keep_done=True, keep_next=True,
                  done_append=["c"], next_append=["d"], attention_amend=False,
                  reopen=False, blocked_reason="b", dropped_reason="d",
                  waiting_reason="w", candidate="abc1234",
                  review_evidence=[])


class TheCardSaysSo(unittest.TestCase):
    """§6 — the tool card is what a caller reads before it writes."""

    def test_acceptance_is_advertised_on_update(self):
        card = next(t for t in mcptool.TOOLS if t["name"] == "orgtree_work")
        desc = card["inputSchema"]["properties"]["acceptance"]["description"]
        self.assertTrue(desc.startswith("create/update:"), desc[:40])
        self.assertIn("scope", desc)
        self.assertIn("re-check", desc)


if __name__ == "__main__":
    unittest.main()
