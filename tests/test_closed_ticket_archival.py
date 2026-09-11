import os
import tempfile
import unittest


class ClosedTicketArchivalTests(unittest.TestCase):
    """The archive rules for closed work, and the one thing that overrides
    them.

    ⚠ TWO TESTS HERE ASSERTED THE OPPOSITE UNTIL 2026-09-11, and that is the
    point of this note. d7fb84f made `superseded` age out like `done` — the
    change its title describes and the first test below still pins — but it
    also deleted the attention clause from `_work_sweep` and gave
    `_work_archived` a `WORK_CLOSED` shortcut past it, then wrote these tests
    around the result. From then on a done or dropped row holding a manual
    flag or an open attached question was swept into the archive while
    `work_counts` went on counting it, so the docket badge pointed at a row
    the main list did not hold. The rule the clause came from was never
    withdrawn — the class docstring in ledger.py still carried it — so it is
    restored here rather than re-argued (Astra 2026-09-05, coordinator
    qualification 2026-09-07).
    """

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-closed-archive-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import ledger, store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger = ledger

    def _org(self):
        org = self.ledger.Org.create("closed-archive")
        org.nodes["root"] = {"state": "live", "parent": None, "generation": 1}
        item = org.work_create("root", "Ticket", "test", owner="root")
        return org, org._work_active()[0]

    @staticmethod
    def _ask(org, wid):
        """An OPEN ask with one tab attached to `wid` — the shape
        `_work_questions` actually reads. The `work_item` sits on the QUESTION,
        not on the ask; a fixture that puts it on the ask produces no
        attention source at all and every assertion downstream passes by
        having nothing to look at."""
        org.d.setdefault("asks", []).append({
            "id": "ask-1", "node": "root", "status": "open", "rev": 1,
            "at": "1970-01-01T00:00:00Z",
            "questions": [{"question": "confirm?", "work_item": wid}]})

    def test_superseded_strict_one_hour_boundary_and_existing_link(self):
        org, item = self._org()
        item["status"] = "superseded"
        item["superseded_by"] = "replacement"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        self.assertFalse(org._work_archived(item, False, 3600.0))
        self.assertTrue(org._work_archived(item, False, 3600.001))
        moved = org._work_sweep(now_ts=3600.001)
        self.assertEqual(moved, [item["slug"]])
        archived = org.d["work_items_archive"][0]
        self.assertEqual(archived["status"], "superseded")
        self.assertEqual(archived["superseded_by"], "replacement")

    def test_closed_attention_is_held_out_of_the_archive(self):
        """A closed row that still needs the user is not archived, and the
        control beside it proves the clock is otherwise working."""
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        item["manual_attention"] = True
        self.assertEqual(org._work_attention(item), ["manual"])
        self.assertFalse(org._work_archived(item, False, 3600.001))
        self.assertEqual(org._work_sweep(now_ts=3600.001), [])
        self.assertEqual(org.d.get("work_items_archive", []), [])
        # THE CONTROL, in the same org and the same tick: clear the flag and
        # the identical row ages out normally. Without this the assertions
        # above are satisfied by an item that was never eligible.
        item["manual_attention"] = False
        self.assertTrue(org._work_archived(item, False, 3600.001))
        self.assertEqual(org._work_sweep(now_ts=3600.001), [item["slug"]])
        self.assertEqual(org.d["work_items_archive"][0]["status"], "done")

    def test_an_open_question_holds_a_closed_row_exactly_as_a_flag_does(self):
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        self.assertEqual(org._work_attention(item), [])      # anti-vacuity
        self._ask(org, item["slug"])
        self.assertEqual(org._work_attention(item), ["question"])
        self.assertEqual(org._work_sweep(now_ts=3600.001), [])
        self.assertFalse(org._work_archived(item, False, 3600.001))
        org.d["asks"][0]["status"] = "answered"
        self.assertEqual(org._work_sweep(now_ts=3600.001), [item["slug"]])

    def test_dropped_is_immediate_but_attention_still_holds_it(self):
        org, dropped = self._org()
        dropped["status"] = "dropped"
        self.assertTrue(org._work_archived(dropped, False, 0.0))   # no clock
        dropped["manual_attention"] = True
        self.assertFalse(org._work_archived(dropped, False, 0.0))
        self.assertEqual(org._work_sweep(now_ts=0.0), [])
        org2, open_item = self._org()
        open_item["docket_at"] = "1970-01-01T00:00:00Z"
        self.assertFalse(org2._work_archived(open_item, False, 100000.0))

    def test_manual_archive_refuses_while_attention_stands(self):
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        item["manual_attention"] = True
        with self.assertRaises(self.ledger.LedgerError) as caught:
            org.work_archive_now(self.ledger.USER, item["slug"])
        self.assertIn("still holds attention", str(caught.exception))
        # ⚠ AND IT IS THE GUARD THAT REFUSED, NOT THE PERMISSION CHECK ABOVE
        # IT. Until this was reordered, `work_archive_now` ran `_work_sweep()`
        # first, so the row was already in the archive by the time its own
        # attention check looked and the call returned `already: True`.
        self.assertEqual(org.d.get("work_items_archive", []), [])
        item["manual_attention"] = False
        self.assertEqual(org.work_archive_now(self.ledger.USER,
                                              item["slug"])["archived"],
                         item["slug"])

    def test_manual_archive_refuses_a_row_already_stranded_in_the_archive(self):
        """The half of the guard the ordinary case cannot reach.

        With the sweep restored, a flagged row is never in the archive when
        `work_archive_now` looks — so moving the attention check back below
        the already-archived shortcut breaks nothing any other test here can
        see (measured: that mutation was INERT until this existed). A row
        stranded by a document written before the restoration is the case
        that tells them apart: it is SERVED on the main list, so answering
        `already: True` would deny what the user is looking at."""
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        org._work_active().remove(item)
        org.d.setdefault("work_items_archive", []).append(item)
        item["manual_attention"] = True
        self.assertFalse(org._work_archived(item, True, 3600.001))
        with self.assertRaises(self.ledger.LedgerError) as caught:
            org.work_archive_now(self.ledger.USER, item["slug"])
        self.assertIn("still holds attention", str(caught.exception))
        # the control: cleared, the same call is the no-op it should be
        item["manual_attention"] = False
        self.assertEqual(org.work_archive_now(self.ledger.USER, item["slug"]),
                         {"archived": item["slug"], "already": True})

    def test_the_badge_never_counts_a_row_only_the_archive_holds(self):
        """The user-visible defect, stated as the invariant it breaks: every
        item in the attention count is reachable from the MAIN list.

        The row is put into the archive list by hand, the way the sweep did
        before the attention clause was restored, so this keeps holding even
        for documents written while the defect was live and for any future
        path that moves a row without asking."""
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        org._work_active().remove(item)
        org.d.setdefault("work_items_archive", []).append(item)
        item["manual_attention"] = True

        listing = org.work_list(self.ledger.USER, include_archived=True,
                                now_ts=3600.001)
        main = [v["slug"] for v in listing["items"]]
        arch = [v["slug"] for v in listing["archived"]]
        counts = listing["counts"]
        self.assertEqual(counts["attention"], 1)
        self.assertEqual(main, [item["slug"]], "the badge points into the archive")
        self.assertEqual(arch, [])
        self.assertEqual(counts["archived"], 0)
        # it never left the archive LIST — being served on the main list is a
        # read-side answer, so nothing had to be migrated to make the badge
        # honest
        self.assertEqual([i["slug"] for i in org._work_archive()], [item["slug"]])
        # …and when the attention clears it is already where it belongs
        item["manual_attention"] = False
        listing = org.work_list(self.ledger.USER, include_archived=True,
                                now_ts=3600.001)
        self.assertEqual([v["slug"] for v in listing["items"]], [])
        self.assertEqual([v["slug"] for v in listing["archived"]], [item["slug"]])
        self.assertEqual(listing["counts"]["attention"], 0)


    def test_delete_takes_the_row_and_its_count_together(self):
        """DELETE is not archival and must not be given the archive's guard.

        Holding a flagged row out of the archive exists so the badge opens
        onto something; deletion removes the row AND the count in one act, so
        there is nothing left to point at and nothing to strand. The check
        that matters is that the two move together. An open attached question
        is the one thing that does block it, and that guard is older than this
        work — it is pinned here because it now sits beside the archive guard
        and the two read the same `_work_questions`."""
        org, item = self._org()
        item["status"] = "done"
        item["docket_at"] = "1970-01-01T00:00:00Z"
        item["manual_attention"] = True
        self.assertEqual(org.work_counts(now_ts=3600.001)["attention"], 1)
        org.work_delete(self.ledger.USER, item["slug"])
        self.assertEqual(org.work_counts(now_ts=3600.001)["attention"], 0)
        self.assertEqual(org._work_active(), [])
        self.assertEqual(org._work_archive(), [])

        org2, other = self._org()
        other["status"] = "done"
        other["docket_at"] = "1970-01-01T00:00:00Z"
        self._ask(org2, other["slug"])
        with self.assertRaises(self.ledger.LedgerError) as caught:
            org2.work_delete(self.ledger.USER, other["slug"])
        self.assertIn("open attached question", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
