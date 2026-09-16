"""The docket serves what it was asked for, once, and says what it left out.

W10. `orgtree_work get` and `list` returned payloads sixteen agents could not
read — 52 KB to 594,877 characters, on one line — and the largest single
contributor was the record duplicated against itself. These tests pin the four
properties that fix is made of:

  * a byte-identical duplicate is served ONCE and the second site names the
    first, so nothing is dropped and nothing is silent;
  * `fields` returns the requested fields and refuses an unknown name rather
    than serving a payload quietly missing it;
  * every projection declares what it omitted AND the call that returns it;
  * a `list` states the size of the archive and backlog groups, and the
    argument that serves them, in the HEAD of the payload — which is the half
    a truncating reader actually sees.
"""
import json
import os
import tempfile
import unittest

_data = tempfile.TemporaryDirectory(prefix="w10-payload-")
os.environ["ORGTREE_DATA"] = _data.name
os.environ["HOME"] = _data.name
os.environ["USERPROFILE"] = _data.name

from orgtree import ledger, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

LONG = ("a long acceptance note of the kind an agent really writes " * 20)


def _size(obj: object) -> int:
    return len(json.dumps(obj, default=str))


class WorkPayloadProjections(unittest.TestCase):
    def setUp(self) -> None:
        self.org = ledger.Org.create("w10-payload-fixture")
        self.assertTrue(str(store.DATA_ROOT).startswith(_data.name),
                        "the fixture must not touch a live docket")
        self.owner = str(self.org.hire(ledger.USER, None, "haiku", 0,
                                       "owner")["node"])
        self.objective = ("The problem. " * 50) + "\n\nThe solution. " * 50
        made = self.org.work_create(
            self.owner, "A worked item", self.objective,
            acceptance=["condition one", "condition two"])
        self.wid = str(made["created"])
        for i in (0, 1):
            self.org.work_check(self.owner, self.wid, i,
                                evidence_ref=f"tests/run-{i}.log", note=LONG)
        self.org.work_update(self.owner, self.wid, ["a step"], ["another"],
                             objective=self.objective + "\n\nMore scope.")
        for i in range(4):
            self.org.work_create(self.owner, f"Plain item {i}", "do it")
        for i in range(5):
            self.org.work_create(self.owner, f"Unstarted item {i}",
                                 "not approached", status="backlogged")

    # ---- duplicates are served once, and the second site names the first

    def test_newest_check_is_served_once_and_names_where_it_lives(self) -> None:
        cond = self.org.work_get(self.owner, self.wid)["acceptance"][0]
        self.assertEqual(cond["checked"]["note"], LONG.strip())
        self.assertEqual(cond["check_history"], [])
        self.assertEqual(cond["check_history_count"], 1)
        self.assertEqual(cond["check_history_newest_same_as"],
                         "acceptance[0].checked")

    def test_earlier_checks_are_still_served_whole(self) -> None:
        self.org.work_check(self.owner, self.wid, 0,
                            evidence_ref="tests/rerun.log", note="second look")
        cond = self.org.work_get(self.owner, self.wid)["acceptance"][0]
        self.assertEqual(cond["check_history_count"], 2)
        self.assertEqual(len(cond["check_history"]), 1)
        self.assertEqual(cond["check_history"][0]["note"], LONG.strip())
        self.assertEqual(cond["checked"]["note"], "second look")

    def test_newest_description_scope_row_points_at_the_objective(self) -> None:
        view = self.org.work_get(self.owner, self.wid)
        rows = [r for r in view["scope"] if r.get("kind") == "objective"]
        self.assertTrue(rows)
        self.assertIsNone(rows[-1]["after"])
        self.assertEqual(rows[-1]["after_same_as"], "objective")
        self.assertEqual(rows[-1]["after_chars"], len(view["objective"]))
        # the BEFORE of that same row is text no other field holds, and stays
        self.assertEqual(rows[-1]["before"], self.objective.strip())

    def test_folded_is_listed_at_the_head_with_a_sentence(self) -> None:
        view = self.org.work_get(self.owner, self.wid)
        keys = list(view)
        self.assertLess(keys.index("folded"), keys.index("objective"),
                        "the disclosure must precede the bulk it describes")
        sites = {row["at"] for row in view["folded"]}
        self.assertIn("acceptance[0].check_history[-1]", sites)
        self.assertIn("acceptance[1].check_history[-1]", sites)
        self.assertIn("same_as", view["folded_how"])

    def test_compact_requested_scope_is_a_grouping_not_a_second_copy(self) -> None:
        compact = self.org.work_get(self.owner, self.wid, projection="compact")
        self.assertIsNone(compact["requested_scope"]["objective"])
        self.assertEqual(compact["requested_scope"]["objective_same_as"],
                         "objective")
        self.assertIsNone(compact["requested_scope"]["acceptance"])
        self.assertEqual(compact["requested_scope"]["acceptance_same_as"],
                         "acceptance")
        self.assertEqual(compact["requested_scope"]["title"], "A worked item")
        self.assertEqual(compact["objective"], self.objective + "\n\nMore scope.")

    def test_a_projection_serves_no_string_twice(self) -> None:
        # the property, stated directly: no unbounded value appears at two
        # places in one payload
        for projection in ("full", "compact"):
            view = self.org.work_get(self.owner, self.wid,
                                     projection=projection)
            blob = json.dumps(view, default=str)
            self.assertEqual(blob.count(json.dumps(LONG.strip())[1:-1]), 2,
                             f"{projection}: one note per condition, no more")

    # ---- the fields selector

    def test_fields_returns_only_what_was_asked_for(self) -> None:
        view = self.org.work_get(self.owner, self.wid,
                                 fields=["title", "status", "owner"])
        self.assertEqual(sorted(k for k in view if not k.startswith("omi")),
                         ["owner", "slug", "status", "title"])
        self.assertEqual(view["title"], "A worked item")
        self.assertNotIn("objective", view)

    def test_fields_accepts_a_comma_separated_string(self) -> None:
        view = self.org.work_get(self.owner, self.wid, fields="title,status")
        self.assertEqual(view["title"], "A worked item")
        self.assertEqual(sorted(k for k in view if not k.startswith("omi")),
                         ["slug", "status", "title"])

    def test_fields_selects_from_the_whole_item_whatever_the_projection(self) -> None:
        # `summary` does not carry the description; asking for it by name
        # must still return it rather than a payload silently missing it
        view = self.org.work_get(self.owner, self.wid, projection="summary",
                                 fields=["objective"])
        self.assertEqual(view["objective"], self.objective + "\n\nMore scope.")

    def test_an_unknown_field_name_refuses_the_call_and_lists_the_real_ones(self) -> None:
        with self.assertRaises(LedgerError) as caught:
            self.org.work_get(self.owner, self.wid, fields=["state"])
        msg = str(caught.exception)
        self.assertIn("state", msg)
        self.assertIn("status", msg)
        self.assertIn("NOTHING WAS RETURNED", msg)

    def test_an_unknown_projection_is_refused(self) -> None:
        with self.assertRaises(LedgerError):
            self.org.work_get(self.owner, self.wid, projection="tiny")

    # ---- nothing is omitted silently

    def test_every_projection_says_what_it_left_out_and_how_to_get_it(self) -> None:
        for kwargs in ({"projection": "compact"}, {"projection": "summary"},
                       {"fields": ["title"]}):
            view = self.org.work_get(self.owner, self.wid, **kwargs)
            how = view["omissions_how"]
            self.assertTrue(how, kwargs)
            self.assertIn("orgtree_work", how, kwargs)
            self.assertIn("fields", how, kwargs)

    def test_compact_keeps_the_existing_omission_counts(self) -> None:
        view = self.org.work_get(self.owner, self.wid, projection="compact")
        full = self.org.work_get(self.owner, self.wid)
        self.assertEqual(view["omitted_history_count"], len(full["history"]))
        self.assertEqual(view["omissions"]["evidence"], len(full["evidence"]))

    def test_summary_names_every_field_it_dropped(self) -> None:
        view = self.org.work_get(self.owner, self.wid, projection="summary")
        self.assertIn("objective", view["omitted_fields"])
        self.assertIn("evidence", view["omitted_fields"])
        self.assertEqual(view["title"], "A worked item")

    # ---- the list, its groups, and the backlog

    def test_include_backlogged_returns_the_backlogged_items(self) -> None:
        out = self.org.work_list(self.owner, include_backlogged=True)
        names = {r["slug"] for r in out["backlogged"]}
        self.assertEqual(len(names), 5)
        self.assertTrue(all(n.startswith("unstarted-item") for n in names))
        self.assertEqual(out["counts"]["backlogged"], 5)

    def test_the_backlog_group_is_declared_in_the_head_either_way(self) -> None:
        for flag in (False, True):
            out = self.org.work_list(self.owner, include_backlogged=flag)
            keys = list(out)
            self.assertLess(keys.index("groups"), keys.index("items"),
                            "a reader that only got the head must still learn "
                            "the group exists")
            group = out["groups"]["backlogged"]
            self.assertEqual(group["count"], 5)
            self.assertIs(group["included"], flag)
            self.assertIn("backlogged", group["how"])
            if not flag:
                self.assertIn("include_backlogged", group["how"])

    def test_the_archive_group_is_declared_the_same_way(self) -> None:
        out = self.org.work_list(self.owner)
        self.assertIn("include_archived", out["groups"]["archived"]["how"])
        self.assertFalse(out["groups"]["archived"]["included"])

    def test_a_list_declares_its_projection_once_not_once_per_row(self) -> None:
        out = self.org.work_list(self.owner, projection="summary")
        self.assertEqual(out["projection"], "summary")
        self.assertIn("omissions_how", out)
        for row in out["items"]:
            self.assertNotIn("omissions_how", row)
            self.assertNotIn("omitted_fields", row)

    def test_a_narrowed_list_returns_the_same_items_as_a_full_one(self) -> None:
        full = self.org.work_list(self.owner, projection="full")
        thin = self.org.work_list(self.owner, fields=["slug"])
        self.assertEqual([r["slug"] for r in thin["items"]],
                         [r["slug"] for r in full["items"]])
        self.assertEqual(thin["counts"], full["counts"])

    # ---- the measurement the ticket asks for

    def test_narrowing_actually_makes_the_payload_smaller(self) -> None:
        full_get = _size(self.org.work_get(self.owner, self.wid))
        summary_get = _size(self.org.work_get(self.owner, self.wid,
                                              projection="summary"))
        full_list = _size(self.org.work_list(self.owner, projection="full"))
        plate = _size(self.org.work_list(
            self.owner, fields=["slug", "title", "status", "owner"]))
        self.assertLess(summary_get * 4, full_get)
        self.assertLess(plate * 4, full_list)


if __name__ == "__main__":
    unittest.main()
