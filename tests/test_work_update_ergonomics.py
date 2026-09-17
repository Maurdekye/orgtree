"""Tests for work_update ergonomics: keep+append, status/attention-only updates,
and empty-list preservation.

Ticket: update-demands-both-progress-lists-and-keep-done

Five core acceptance criteria:
1. `keep_done` with `done_append` is accepted and stores the complete merged list,
   and the same for `keep_next` with `next_append`.
2. A status-only or attention-only update succeeds without re-sending either
   progress list, leaving both stored lists unchanged (byte-identical).
3. Keeping both stored lists on an item whose lists are empty is accepted rather
   than refused.
4. An update that sends a list still replaces that list exactly as it does today.
5. What is stored is still always the complete list, never a fragment.
"""
import copy
import os
import sys
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="v2-ergonomics-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine", "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import events  # noqa: E402,F401
from orgtree import events_render  # noqa: E402,F401
from orgtree import ledger
from orgtree.ledger import USER, LedgerError

_n = 0


def fixture():
    global _n
    _n += 1
    org = ledger.Org.create(f"ergo-{_n}")
    org.hire(USER, None, "haiku", 0, "owner-a")
    created = org.work_create(
        "owner-a",
        "Ergonomics test ticket",
        "the objective",
    )
    return org, str(created["slug"])


def item(org, wid):
    for bucket in ("work_items", "work_items_archive"):
        for it in org.d.get(bucket, []):
            if it.get("slug") == wid:
                return it
    raise KeyError(wid)


class TestWorkUpdateErgonomics(unittest.TestCase):

    # ─────────────────────────────────────────────────────────────────
    # 1. keep_done + done_append (and keep_next + next_append)
    # ─────────────────────────────────────────────────────────────────

    def test_keep_and_append_together_merges_with_stored(self):
        org, wid = fixture()
        # Seed with initial progress
        org.work_update(
            "owner-a", wid,
            done_so_far=["task 1", "task 2"],
            working_on_next=["task 3"],
        )
        rev = item(org, wid)["rev"]

        # keep_done with done_append AND keep_next with next_append
        res = org.work_update(
            "owner-a", wid,
            expected_rev=rev,
            keep_done=True,
            done_append=["task 2.5"],
            keep_next=True,
            next_append=["task 4"],
        )

        # 1. Accepted and returns merged lists
        self.assertEqual(res["done_so_far"], ["task 1", "task 2", "task 2.5"])
        self.assertEqual(res["working_on_next"], ["task 3", "task 4"])

        # 5. Stored list is complete, never a fragment
        stored = item(org, wid)
        self.assertEqual(stored["done_so_far"], ["task 1", "task 2", "task 2.5"])
        self.assertEqual(stored["working_on_next"], ["task 3", "task 4"])

    def test_append_alone_without_keep_flag_also_merges(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["step A"],
            working_on_next=["step B"],
        )
        rev = item(org, wid)["rev"]

        # done_append without keep_done, keep_next without next_append
        res = org.work_update(
            "owner-a", wid,
            expected_rev=rev,
            done_append=["step A2"],
            keep_next=True,
        )
        self.assertEqual(res["done_so_far"], ["step A", "step A2"])
        self.assertEqual(res["working_on_next"], ["step B"])

    def test_keep_and_append_requires_expected_rev(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["alpha"],
            working_on_next=["beta"],
        )
        with self.assertRaises(LedgerError) as cm:
            org.work_update(
                "owner-a", wid,
                keep_done=True,
                done_append=["gamma"],
                keep_next=True,
            )
        self.assertIn("expected_rev", str(cm.exception))

    def test_keep_and_append_whole_list_conflict_is_still_refused(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["one"],
            working_on_next=["two"],
        )
        rev = item(org, wid)["rev"]
        # Passing whole list AND append is refused
        with self.assertRaises(LedgerError) as cm:
            org.work_update(
                "owner-a", wid,
                expected_rev=rev,
                done_so_far=["whole list"],
                done_append=["appended item"],
                keep_next=True,
            )
        self.assertIn("pass either the whole done_so_far or a patch of it", str(cm.exception))

    # ─────────────────────────────────────────────────────────────────
    # 2. Status-only or attention-only updates preserve stored lists
    # ─────────────────────────────────────────────────────────────────

    def test_status_only_update_preserves_stored_lists_byte_identical(self):
        org, wid = fixture()
        initial_done = ["investigated bug", "wrote repro test"]
        initial_next = ["fix root cause in ledger.py"]
        org.work_update(
            "owner-a", wid,
            done_so_far=initial_done,
            working_on_next=initial_next,
        )
        stored_before = item(org, wid)
        done_before = copy.deepcopy(stored_before["done_so_far"])
        next_before = copy.deepcopy(stored_before["working_on_next"])

        # Status-only update without sending done_so_far or working_on_next
        res = org.work_update(
            "owner-a", wid,
            status="in_progress",
        )
        self.assertEqual(res["status"], "in_progress")
        self.assertEqual(res["done_so_far"], done_before)
        self.assertEqual(res["working_on_next"], next_before)

        stored_after = item(org, wid)
        self.assertEqual(stored_after["status"], "in_progress")
        self.assertEqual(stored_after["done_so_far"], done_before)
        self.assertEqual(stored_after["working_on_next"], next_before)

    def test_attention_only_update_preserves_stored_lists(self):
        org, wid = fixture()
        initial_done = ["step 1"]
        initial_next = ["step 2"]
        org.work_update(
            "owner-a", wid,
            done_so_far=initial_done,
            working_on_next=initial_next,
        )

        res = org.work_update(
            "owner-a", wid,
            attention=True,
            attention_reason="A critical architectural decision is required",
        )
        stored = item(org, wid)
        self.assertTrue(stored["manual_attention"])
        self.assertEqual(stored["manual_attention"]["reason"], "A critical architectural decision is required")
        self.assertEqual(stored["done_so_far"], initial_done)
        self.assertEqual(stored["working_on_next"], initial_next)
        self.assertEqual(res["done_so_far"], initial_done)
        self.assertEqual(res["working_on_next"], initial_next)

    def test_substantive_fields_without_progress_preserve_stored_lists(self):
        org, wid = fixture()
        initial_done = ["step 1"]
        initial_next = ["step 2"]
        org.work_update(
            "owner-a", wid,
            done_so_far=initial_done,
            working_on_next=initial_next,
        )

        # Title update only
        res = org.work_update("owner-a", wid, title="New Title")
        self.assertEqual(item(org, wid)["title"], "New Title")
        self.assertEqual(item(org, wid)["done_so_far"], initial_done)
        self.assertEqual(item(org, wid)["working_on_next"], initial_next)

        # Blocked reason update
        res = org.work_update("owner-a", wid, status="blocked", blocked_reason="waiting on PR")
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(item(org, wid)["done_so_far"], initial_done)
        self.assertEqual(item(org, wid)["working_on_next"], initial_next)

    def test_no_progress_and_no_substantive_change_is_still_refused(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["work done"],
            working_on_next=["work next"],
        )
        # Empty update with no fields changed
        with self.assertRaises(LedgerError) as cm:
            org.work_update("owner-a", wid)
        self.assertIn("nothing the user can read", str(cm.exception))

    # ─────────────────────────────────────────────────────────────────
    # 3. Empty stored lists preservation and keep
    # ─────────────────────────────────────────────────────────────────

    def test_empty_item_keep_both_stored_lists_accepted(self):
        org, wid = fixture()
        # Item created with empty progress lists
        stored = item(org, wid)
        self.assertEqual(stored["done_so_far"], [])
        self.assertEqual(stored["working_on_next"], [])
        rev = stored["rev"]

        # keep_done=True, keep_next=True on empty lists
        res = org.work_update(
            "owner-a", wid,
            expected_rev=rev,
            keep_done=True,
            keep_next=True,
        )
        self.assertEqual(res["done_so_far"], [])
        self.assertEqual(res["working_on_next"], [])
        self.assertEqual(item(org, wid)["done_so_far"], [])
        self.assertEqual(item(org, wid)["working_on_next"], [])

    def test_empty_item_status_only_update_accepted(self):
        org, wid = fixture()
        stored = item(org, wid)
        self.assertEqual(stored["done_so_far"], [])
        self.assertEqual(stored["working_on_next"], [])

        # status-only update on an empty item
        res = org.work_update(
            "owner-a", wid,
            status="in_progress",
        )
        self.assertEqual(res["status"], "in_progress")
        self.assertEqual(res["done_so_far"], [])
        self.assertEqual(res["working_on_next"], [])
        self.assertEqual(item(org, wid)["status"], "in_progress")
        self.assertEqual(item(org, wid)["done_so_far"], [])
        self.assertEqual(item(org, wid)["working_on_next"], [])

    def test_explicit_empty_lists_still_refused(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["done"],
            working_on_next=["next"],
        )
        # Explicitly sending empty lists [] and [] says nothing readable
        with self.assertRaises(LedgerError) as cm:
            org.work_update(
                "owner-a", wid,
                done_so_far=[],
                working_on_next=[],
            )
        self.assertIn("nothing the user can read", str(cm.exception))

    # ─────────────────────────────────────────────────────────────────
    # 4. Replacement semantics when a list is explicitly passed
    # ─────────────────────────────────────────────────────────────────

    def test_explicit_list_replaces_and_omitted_clears(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["first done"],
            working_on_next=["first next"],
        )

        # Providing done_so_far replaces done_so_far and clears working_on_next
        res = org.work_update(
            "owner-a", wid,
            done_so_far=["new done item"],
        )
        self.assertEqual(res["done_so_far"], ["new done item"])
        self.assertEqual(res["working_on_next"], [])
        self.assertEqual(item(org, wid)["done_so_far"], ["new done item"])
        self.assertEqual(item(org, wid)["working_on_next"], [])

    def test_explicit_working_on_next_replaces_and_clears_done(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["first done"],
            working_on_next=["first next"],
        )

        # Providing working_on_next replaces working_on_next and clears done_so_far
        res = org.work_update(
            "owner-a", wid,
            working_on_next=["only next item"],
        )
        self.assertEqual(res["done_so_far"], [])
        self.assertEqual(res["working_on_next"], ["only next item"])
        self.assertEqual(item(org, wid)["done_so_far"], [])
        self.assertEqual(item(org, wid)["working_on_next"], ["only next item"])

    # ─────────────────────────────────────────────────────────────────
    # 5. Stored list is always complete, never a fragment
    # ─────────────────────────────────────────────────────────────────

    def test_stored_list_is_never_a_fragment(self):
        org, wid = fixture()
        org.work_update(
            "owner-a", wid,
            done_so_far=["item 1", "item 2"],
            working_on_next=["item 3"],
        )
        rev = item(org, wid)["rev"]

        # Append item 2.5
        org.work_update(
            "owner-a", wid,
            expected_rev=rev,
            keep_done=True,
            done_append=["item 2.5"],
            keep_next=True,
        )

        stored = item(org, wid)["done_so_far"]
        self.assertEqual(len(stored), 3)
        self.assertEqual(stored, ["item 1", "item 2", "item 2.5"])
        # Ensure it's not just the appended fragment
        self.assertNotEqual(stored, ["item 2.5"])


if __name__ == "__main__":
    unittest.main()
