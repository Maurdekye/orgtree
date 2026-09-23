"""`check` and `accept` honour `expected_rev` as REAL compare-and-set.

THE DEFECT THIS CLOSES. The `orgtree_work` card advertised `expected_rev` on
"update/evidence/receipt and every other mutating action". Eight actions
honoured it; nineteen read it not at all — accepted off the wire, dropped, and
on a mutating action the revision advanced anyway, so a caller that asked for
compare-and-set got a success it could not distinguish from a protected write.
`91454c5` made that honest by REFUSING the argument wherever it was dead.

Refusing is the right answer for seventeen of those nineteen. It is the wrong
answer for `check` and `accept`, which write the acceptance record that decides
whether an item is complete — the one write whose mistakes stop being looked
at, because a done item stops being read. Two agents interleaving there can
complete an item on evidence gathered against a state that no longer stands.
So those two get the real thing, and this suite is what says they have it.

WHAT IT PINS:

  §1  Both actions take `expected_rev` and honour it against the item `rev`,
      through the REAL API dispatch and not only the ledger method — the whole
      class of bug was the dispatch naming arguments and dropping the rest.
  §2  A stale `expected_rev` is refused BEFORE any mutation: the org document
      is byte-identical afterwards and the revision has not moved.
  §3  The refusal names both revisions and is a `StaleRevError`, so a caller
      can tell this refusal from a validation error by type rather than by
      matching on wording that may be improved later.
  §4  It stays OPTIONAL. Omitting it works exactly as it did — asserted as a
      negative control, because a guard that quietly required the field would
      break every existing caller and every one of them passes nothing.
  §5  The batch shape of `check` is covered too: a batch is the call most
      likely to have been composed against a read.
  §6  The scope line. A reviewer's `approve` reaches the same completion core
      by its own route and takes NO compare-and-set; widening it further is
      separate work and this asserts the boundary rather than leaving it to
      be rediscovered.
"""
import inspect
import json
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-cas-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import api, ledger  # noqa: E402
from orgtree.ledger import LedgerError, StaleRevError, USER  # noqa: E402

_n = 0


def fixture(conditions=("It refuses a stale write.", "It still accepts a fresh one.")):
    """A fresh org: `owner-a` owns one item with two acceptance conditions."""
    global _n
    _n += 1
    org = ledger.Org.create(f"cas-{_n}")
    for nid in ("owner-a", "peer-b"):
        org.hire(USER, None, "haiku", 0, nid)
    org.work_create("owner-a", "Compare-and-set fixture",
                    objective="Problem: check and accept advanced the rev "
                              "while ignoring expected_rev. Solution: these "
                              "assertions.",
                    acceptance=list(conditions))
    return org, org.d["work_items"][-1]["slug"]


def item(org, slug):
    return next(i for i in org.d["work_items"] if i["slug"] == slug)


def rev(org, slug):
    return int(item(org, slug)["rev"])


def snapshot(org):
    return json.dumps(org.d, sort_keys=True, default=str)


def moved_on(org, slug):
    """Somebody else writes to the item — the interleaving being guarded."""
    org.work_decision("owner-a", slug,
                      "A ruling that arrived between the read and the write.")


def call(org, act, slug, **a):
    """Through the real API dispatch, the way a tool call arrives."""
    return api._work_mutate_action(org, "owner-a",
                                   {"action": act, "slug": slug, **a},
                                   act, slug)


CHECK_OK = {"index": 0, "evidence_ref": "tests/test_work_accept_check_cas.py"}


class TheArgumentReachesTheLedger(unittest.TestCase):
    """§1 — the allow-list and the dispatch both carry it."""

    def test_both_actions_allow_it(self):
        for act in ("check", "accept"):
            self.assertIn("expected_rev", api._WORK_ACTION_ARGS[act], act)
            self.assertIn("expected_rev", api._work_allowed(act), act)

    def test_both_ledger_methods_take_it(self):
        for fn in ("work_check", "work_accept"):
            sig = inspect.signature(getattr(ledger.Org, fn))
            self.assertIn("expected_rev", sig.parameters, fn)

    def test_the_guard_no_longer_refuses_it(self):
        """The negative control for 91454c5's refusal: it must be GONE here.

        Before this ticket, `_work_refuse_unused` raised on exactly this call
        with "action=check does not write `expected_rev`". If that refusal
        comes back, the two halves have gone out of step and the card is
        promising something the guard rejects.
        """
        for act in ("check", "accept"):
            api._work_refuse_unused(
                {"action": act, "slug": "x", "expected_rev": 3}, act)

    def test_a_matching_rev_is_honoured_on_check(self):
        org, slug = fixture()
        r = rev(org, slug)
        out = call(org, "check", slug, expected_rev=r, **CHECK_OK)
        self.assertEqual(out["checked"], 0)
        self.assertGreater(rev(org, slug), r)
        self.assertTrue(item(org, slug)["acceptance"][0]["checked"])

    def test_a_matching_rev_is_honoured_on_accept(self):
        org, slug = fixture()
        r = rev(org, slug)
        out = call(org, "accept", slug, expected_rev=r, note="landed")
        self.assertEqual(out["accepted"], slug)
        self.assertEqual(item(org, slug)["status"], "done")
        self.assertGreater(rev(org, slug), r)


class AStaleRevIsRefusedBeforeAnyMutation(unittest.TestCase):
    """§2/§3 — byte-identical, rev unmoved, and refused by TYPE."""

    def stale(self, act, **a):
        org, slug = fixture()
        read_at = rev(org, slug)
        moved_on(org, slug)                     # the interleaving write
        now_at = rev(org, slug)
        self.assertNotEqual(read_at, now_at)
        before = snapshot(org)
        with self.assertRaises(StaleRevError) as e:
            call(org, act, slug, expected_rev=read_at, **a)
        self.assertEqual(snapshot(org), before,
                         f"action={act} was refused as stale and still "
                         f"changed the document")
        self.assertEqual(rev(org, slug), now_at)
        return org, slug, str(e.exception)

    def test_check_refuses_and_writes_nothing(self):
        org, slug, msg = self.stale("check", **CHECK_OK)
        self.assertIsNone(item(org, slug)["acceptance"][0]["checked"])
        self.assertIn("expected_rev", msg)
        self.assertIn("NOTHING WAS WRITTEN", msg)

    def test_accept_refuses_and_the_item_is_not_done(self):
        org, slug, msg = self.stale("accept", note="landed")
        self.assertNotEqual(item(org, slug)["status"], "done")
        self.assertIsNone(item(org, slug)["accepted"])
        self.assertIn("NOTHING WAS WRITTEN", msg)

    def test_the_refusal_names_both_revisions(self):
        org, slug = fixture()
        read_at = rev(org, slug)
        moved_on(org, slug)
        have = rev(org, slug)
        with self.assertRaises(StaleRevError) as e:
            call(org, "accept", slug, expected_rev=read_at)
        msg = str(e.exception)
        self.assertIn(f"expected_rev {read_at}", msg)
        self.assertIn(f"rev {have}", msg)

    def test_it_is_a_stale_rev_error_not_a_bare_ledger_error(self):
        """Callers tell this refusal apart by TYPE. `StaleRevError` subclasses
        `LedgerError`, so every existing handler still catches it."""
        org, slug = fixture()
        read_at = rev(org, slug)
        moved_on(org, slug)
        for act, a in (("check", CHECK_OK), ("accept", {})):
            with self.assertRaises(StaleRevError, msg=act):
                call(org, act, slug, expected_rev=read_at, **a)
        self.assertTrue(issubclass(StaleRevError, LedgerError))

    def test_a_non_integer_rev_is_a_readable_refusal(self):
        org, slug = fixture()
        before = snapshot(org)
        for act, a in (("check", CHECK_OK), ("accept", {})):
            with self.assertRaises(LedgerError, msg=act) as e:
                call(org, act, slug, expected_rev="nine", **a)
            self.assertIn("expected_rev must be the integer", str(e.exception))
        self.assertEqual(snapshot(org), before)


class OmittingItWorksExactlyAsBefore(unittest.TestCase):
    """§4 — the negative control. Every caller alive today passes nothing."""

    def test_check_without_it(self):
        org, slug = fixture()
        r = rev(org, slug)
        out = call(org, "check", slug, **CHECK_OK)
        self.assertEqual(out["checked"], 0)
        self.assertGreater(rev(org, slug), r)

    def test_accept_without_it(self):
        org, slug = fixture()
        out = call(org, "accept", slug, note="done")
        self.assertEqual(item(org, slug)["status"], "done")
        self.assertEqual(out["accepted"], slug)

    def test_check_without_it_is_unbothered_by_an_interleaving_write(self):
        """Opting out still means opting out — a caller that names no revision
        is not given one, or this would have broken every existing caller."""
        org, slug = fixture()
        moved_on(org, slug)
        out = call(org, "check", slug, **CHECK_OK)
        self.assertEqual(out["checked"], 0)

    def test_an_explicit_null_is_the_same_as_omitting(self):
        """`expected_rev: null` on the wire opts out, like every other
        None-defaulted compare-and-set argument in the ledger."""
        org, slug = fixture()
        moved_on(org, slug)
        out = call(org, "check", slug, expected_rev=None, **CHECK_OK)
        self.assertEqual(out["checked"], 0)


class TheBatchShapeIsCoveredToo(unittest.TestCase):
    """§5 — a batch is the call most likely composed against a read."""

    BATCH = [{"index": 0, "evidence_ref": "a.log"},
             {"index": 1, "evidence_ref": "b.log"}]

    def test_a_batch_honours_a_matching_rev(self):
        org, slug = fixture()
        out = call(org, "check", slug, checks=self.BATCH,
                   expected_rev=rev(org, slug))
        self.assertEqual(out["indexes"], [0, 1])

    def test_a_stale_batch_writes_none_of_its_elements(self):
        org, slug = fixture()
        read_at = rev(org, slug)
        moved_on(org, slug)
        before = snapshot(org)
        with self.assertRaises(StaleRevError):
            call(org, "check", slug, checks=self.BATCH, expected_rev=read_at)
        self.assertEqual(snapshot(org), before)
        for cond in item(org, slug)["acceptance"]:
            self.assertIsNone(cond["checked"])

    def test_a_batch_without_it_still_works(self):
        org, slug = fixture()
        moved_on(org, slug)
        out = call(org, "check", slug, checks=self.BATCH)
        self.assertEqual(out["indexes"], [0, 1])


class TheScopeLine(unittest.TestCase):
    """§6 — what was deliberately NOT widened, asserted so it is a decision
    rather than something a later reader has to rediscover."""

    def test_a_reviewers_approval_takes_no_compare_and_set(self):
        sig = inspect.signature(ledger.Org.work_review_decide)
        self.assertNotIn("expected_rev", sig.parameters)
        self.assertNotIn("expected_rev", api._WORK_ACTION_ARGS["review"])

    def test_the_shared_completion_core_is_reached_unguarded_by_review(self):
        """`accept` guards at its own door, not inside `_work_accept_core`, so
        the reviewer route through that core is unchanged by this ticket."""
        src = inspect.getsource(ledger.Org._work_accept_core)
        self.assertNotIn("_work_expect_rev", src)
        self.assertIn("_work_expect_rev",
                      inspect.getsource(ledger.Org.work_accept))

    def test_the_other_mutating_actions_still_refuse_it(self):
        """Seventeen of the nineteen were left refusing on purpose."""
        for act in ("claim", "decision", "participants", "assign", "move",
                    "supersede", "archive", "delete", "create", "handoff",
                    "review", "verdict"):
            self.assertNotIn("expected_rev", api._WORK_ACTION_ARGS[act], act)


if __name__ == "__main__":
    unittest.main()
