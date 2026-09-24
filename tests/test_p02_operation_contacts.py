"""P02: the per-operation contact probe for the four P01 tool families.

Runs ``tools/p02_operation_contacts.py`` once, on its own synthetic root, and
checks the record it writes: every P01 contract variant is present cold and
warm, every recorded attempt's harness statement count equals the census's
(the per-operation attribution check), the named refusal rows carry their
statuses and pre-storage refusals carry no contacts, the hidden-contact
negative control is seen by the census and nothing else is hidden, the
window loses nothing, every connection site is classified, and the two r5
residuals (db_unbound, unclassified_action) are reproduced and attributed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "p02_operation_contacts.py"
BASE_TMP = os.environ.get("P02_HARNESS_TMP") or None

RESERVATION = ("list-read", "list-scope", "landing", "acquire", "overlap", "renew",
               "recover", "invalidate", "release", "release-notify", "land")
ALIASES = ("orgtree_reservation", "orgtree_resource_reservation")
PREVIEW = ("reallocate", "move", "swap", "swap_seats", "self_subjugate", "subjugate",
           "retool", "set_scope", "retire", "dissolve", "revoke_dir", "switch_model",
           "audience")
CONTRACTS = {f"reservation.{v}" for v in RESERVATION} | {
    "material.scratch", "material.transcript", "diagnostic.inspect",
    "diagnostic.capabilities", "preview.agent"}


class OperationContacts(unittest.TestCase):
    doc: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="p02-op-contacts-", dir=BASE_TMP)
        out = Path(cls._tmp.name) / "out"
        proc = subprocess.run([sys.executable, "-I", "-B", str(TOOL), "--out", str(out)],
                              capture_output=True, text=True, timeout=1200)
        if proc.returncode != 0:
            raise AssertionError(f"probe exited {proc.returncode}: {proc.stderr[-3000:]}")
        cls.doc = json.loads((out / "operation-contacts.json").read_text(encoding="utf-8"))
        cls.md = (out / "operation-contacts.md").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def rows(self, **match):
        return [r for r in self.doc["rows"] if all(r.get(k) == v for k, v in match.items())]

    def test_provenance_is_this_checkout(self):
        prov = self.doc["provenance"]
        self.assertTrue(prov["orgtree_under_tree"], prov)
        self.assertRegex(prov["commit"] or "", r"^[0-9a-f]{40}$")
        self.assertEqual(prov["native_blocked"], ["psutil"])

    def test_every_contract_and_variant_runs_cold_and_warm(self):
        self.assertEqual({r["contract"] for r in self.doc["rows"]}, CONTRACTS)
        for alias in ALIASES:
            for short in RESERVATION:
                for condition in ("cold", "warm"):
                    with self.subTest(alias=alias, variant=short, condition=condition):
                        got = self.rows(variant=f"{alias}:reservation.{short}", condition=condition)
                        self.assertEqual(len(got), 1)
                        self.assertEqual(got[0]["alias"], alias)
                        self.assertEqual(got[0]["http_status"], 200, got[0]["detail"])
        for op in PREVIEW:
            for condition in ("cold", "warm"):
                with self.subTest(preview=op, condition=condition):
                    self.assertEqual(len(self.rows(variant=f"preview.{op}", condition=condition)), 1)
        for contract in ("material.scratch", "material.transcript", "diagnostic.inspect",
                         "diagnostic.capabilities"):
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    got = self.rows(variant=contract, condition=condition)
                    self.assertEqual(len(got), 1)
                    self.assertEqual(got[0]["http_status"], 200, got[0]["detail"])

    def test_each_recorded_attempt_is_attributed_to_its_own_operation(self):
        recorded = [r for r in self.doc["rows"] if r["census"]["records"]]
        self.assertGreater(len(recorded), 90)
        for r in recorded:
            with self.subTest(contract=r["contract"], variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["census"]["records"], 1)
                self.assertTrue(r["census"]["db_present"])
                self.assertIs(r["harness"]["matches_census"], True)
                self.assertLessEqual(r["harness"]["distinct_tallies"], 1)
                self.assertEqual(r["harness"]["statements_unbound"], 0)

    def test_rows_name_tables_kinds_checkouts_and_transactions(self):
        catalogue = set(self.doc["table_catalogue"])
        self.assertIn("doc", catalogue)
        acquire = self.rows(variant="orgtree_reservation:reservation.acquire", condition="cold")[0]
        primary = acquire["harness"]["stores"]["primary"]
        self.assertIn("doc", primary["tables_written"])
        self.assertIn("select", acquire["census"]["kinds"])
        self.assertGreaterEqual(acquire["census"]["checkouts"], 1)
        self.assertEqual(acquire["census"]["connects"], 1, "a cold attempt opens its connection")
        warm = self.rows(variant="orgtree_reservation:reservation.acquire", condition="warm")[0]
        self.assertEqual(warm["census"]["connects"], 0, "a warm attempt reuses the pool")
        self.assertTrue(acquire["harness"]["all_writes_in_transaction"])
        for r in self.doc["rows"]:
            for store in r["harness"]["stores"].values():
                for name in store["tables_read"] + store["tables_written"]:
                    self.assertTrue(name in catalogue or name == "other", name)
        transcript = self.rows(variant="material.transcript", condition="cold")[0]
        self.assertEqual(set(transcript["harness"]["sidecars_touched"]),
                         {"transcript_records", "chat_window_index", "reply_events"})

    def test_named_refusals_and_zero_contact_before_storage(self):
        want = {"refusal:unauthenticated": 401, "refusal:identity-mismatch": 403,
                "refusal:halted": 409, "refusal:killswitch": 409,
                "refusal:unaddressable-successor": 422, "refusal:keyed-conflict": 409,
                "refusal:stale-epoch": 422, "refusal:retained-row-cap": 422,
                "refusal:path-escape": 422}
        for variant, status in want.items():
            with self.subTest(variant=variant):
                got = self.rows(variant=variant)
                self.assertTrue(got)
                self.assertTrue(all(r["http_status"] == status for r in got), got)
                self.assertTrue(all(r["refusal"] for r in got))
        for r in self.rows(variant="refusal:unauthenticated") + self.rows(
                variant="refusal:identity-mismatch"):
            self.assertEqual(r["harness"]["statements_attributed"], 0)
            self.assertEqual(r["census"]["statements"], 0)
        unauth = self.rows(variant="refusal:unauthenticated")[0]
        self.assertEqual(unauth["census"]["records"], 0)
        self.assertIsNone(unauth["harness"]["matches_census"])
        replay = self.rows(variant="keyed:replay")[0]
        self.assertEqual(replay["http_status"], 200)

    def test_hidden_contact_control_is_seen_and_nothing_else_is_hidden(self):
        control = self.rows(variant="control:hidden-contact")
        self.assertEqual(len(control), 1)
        self.assertGreaterEqual(control[0]["census"]["hidden_steps"], 1)
        for r in self.doc["rows"]:
            if r["variant"] != "control:hidden-contact":
                self.assertEqual(r["census"]["hidden_steps"], 0, r["variant"])

    def test_org_locality_control_fires_and_no_operation_touches_another_org(self):
        control = self.rows(variant="control:foreign-org-contact")
        self.assertEqual(len(control), 1)
        self.assertTrue(any(k.startswith("data:org-db:foreign")
                            for k in control[0]["audit"].get("sqlite_connect", {})),
                        control[0]["audit"])
        for r in self.doc["rows"]:
            if r["variant"] == "control:foreign-org-contact":
                continue
            for group, keys in r["audit"].items():
                with self.subTest(variant=r["variant"], condition=r["condition"], group=group):
                    self.assertFalse([k for k in keys if "org-db:foreign" in k])
        # the notify effect's mail lands in the releasing org's own store
        notify = self.rows(variant="orgtree_reservation:reservation.release-notify",
                           condition="cold")[0]
        self.assertTrue(any(k.startswith("data:org-db:own")
                            for k in notify["audit"].get("sqlite_connect", {})))

    def test_recorded_rows_carry_profile_and_lock_wait_numbers(self):
        for r in self.doc["rows"]:
            if r["census"]["records"]:
                with self.subTest(variant=r["variant"], condition=r["condition"]):
                    self.assertIn("handler_ms", r["census"]["profile"])
        acquire = self.rows(variant="orgtree_reservation:reservation.acquire", condition="cold")[0]
        self.assertIn("lock_wait_ms", acquire["census"]["profile"])

    def test_every_connect_is_one_the_census_saw_and_no_uninstrumented_site_ran(self):
        """The argument for leaving the four readers uninstrumented (review
        B1): every sqlite3.connect the audit hook saw during an operation is
        one the census counted, and no connect ever came from an
        uninstrumented site's module."""
        for r in self.doc["rows"]:
            if not r["census"]["records"]:
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                audited = sum(r["audit"].get("sqlite_connect", {}).values())
                census = r["census"]["connects"] + sum(
                    (v.get("connects") or 0) for v in r["census"]["secondary"].values())
                self.assertEqual(audited, census)
        keys = set(self.doc["between_operations"].get("sqlite_connect", {}))
        for r in self.doc["rows"]:
            keys |= set(r["audit"].get("sqlite_connect", {}))
        for site in ("antigravity_provenance", "desktop_import", "mailhub"):
            self.assertFalse([k for k in keys if site in k], site)

    def test_nothing_outside_the_synthetic_root_and_the_code_is_read(self):
        for r in self.doc["rows"]:
            for group in ("file_read", "file_write", "dir_list", "sqlite_connect", "fs_mutation"):
                with self.subTest(variant=r["variant"], condition=r["condition"], group=group):
                    self.assertFalse([k for k in r["audit"].get(group, {})
                                      if "outside" in k.split("@", 1)[0]])

    def test_keyed_replay_answers_from_the_receipt_without_the_helper(self):
        fresh = self.rows(variant="keyed:fresh")[0]
        replay = self.rows(variant="keyed:replay")[0]
        self.assertGreater(fresh["harness"]["writes"], 0)
        self.assertEqual(replay["harness"]["writes"], 0)
        self.assertLess(replay["census"]["statements"], fresh["census"]["statements"])

    def test_primary_store_is_autocommit_so_writes_in_tx_are_explicit(self):
        acquire = self.rows(variant="orgtree_reservation:reservation.acquire", condition="cold")[0]
        self.assertIs(acquire["harness"]["stores"]["primary"]["autocommit"], True)

    # -- agent-to-agent mail locality (p02-observe-agent-to-agent-mail-locality-in-the)
    CONTROL = "control:third-agent-mail"

    def test_every_row_records_which_agents_it_touched(self):
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                agents = r["agents"]
                self.assertTrue(agents["actor"])
                for key in ("targets", "physical", "physical_nodes", "logical",
                            "mail_producing", "third_agent_mail", "third_agent_rows_written"):
                    self.assertIn(key, agents)

    def test_release_notify_mail_reaches_only_the_named_successor(self):
        """P01 `contacts`: release-notify's mail contacts are limited to the
        sender and the named successor, and never self-only."""
        for alias in ALIASES:
            for condition in ("cold", "warm"):
                with self.subTest(alias=alias, condition=condition):
                    r = self.rows(variant=f"{alias}:reservation.release-notify",
                                  condition=condition)[0]
                    agents = r["agents"]
                    self.assertTrue(agents["mail_producing"])
                    self.assertEqual(agents["targets"], ["peer"])
                    self.assertEqual(agents["logical"]["mail"], {"peer": "target"})
                    roles = {role for sect in agents["logical"].values() for role in sect.values()}
                    self.assertLessEqual(roles, {"actor", "target"})
                    self.assertIn("target", roles, "never self-only")
                    self.assertEqual(agents["physical_nodes"].get("peer"), "target")
                    self.assertEqual(agents["third_agent_mail"], 0)
                    self.assertEqual(agents["third_agent_rows_written"], 0)

    def test_no_operation_touches_a_third_agents_mail_or_rows(self):
        producing = set()
        for r in self.doc["rows"]:
            if r["variant"] == self.CONTROL:
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["agents"]["third_agent_mail"], 0)
                self.assertEqual(r["agents"]["third_agent_rows_written"], 0)
            if r["agents"]["mail_producing"]:
                producing.add(r["contract"])
        self.assertEqual(producing, {"reservation.release-notify"})

    def test_third_agent_mail_control_is_flagged(self):
        control = self.rows(variant=self.CONTROL)
        self.assertEqual(len(control), 1)
        agents = control[0]["agents"]
        self.assertEqual(control[0]["http_status"], 200)
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertEqual(agents["logical"]["mail"].get("child"), "third")
        self.assertEqual(agents["logical"]["mail"].get("peer"), "target")
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertEqual(agents["physical_nodes"].get("child"), "third")

    def test_window_loses_nothing(self):
        window = self.doc["window"]
        self.assertTrue(window["same_window"])
        for key in ("rejected", "dropped_stale_window", "dropped_capture_off", "evicted",
                    "db_late", "db_observe_failed", "db_self_recursion",
                    "db_hidden_unattributed"):
            self.assertEqual(window["counters"][key], 0, key)

    def test_notify_effect_is_counted_not_delivered(self):
        for alias in ALIASES:
            for condition in ("cold", "warm"):
                r = self.rows(variant=f"{alias}:reservation.release-notify", condition=condition)[0]
                self.assertEqual(r["wakes"]["send_message"], 1)
        self.assertEqual(self.rows(variant="orgtree_reservation:reservation.list-read",
                                   condition="warm")[0]["wakes"]["send_message"], 0)

    def test_no_guard_refusal_and_no_product_process_or_network(self):
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["guard_refusals"], {})
                self.assertNotIn("process", r["audit"])
                self.assertNotIn("network", r["audit"])

    def test_every_connection_site_is_classified_with_a_reason(self):
        sites = self.doc["connection_sites"]
        self.assertEqual(len(sites), 15)
        self.assertEqual(sum(s["status"] == "instrumented" for s in sites), 7)
        for s in sites:
            self.assertIn(s["status"], ("instrumented", "uninstrumented"))
            self.assertTrue(s["reason"])
            self.assertNotIn("NOT in census_contacts", s["reason"])

    def test_r5_residuals_are_reproduced_and_attributed(self):
        res = self.doc["residuals"]
        enable = res["enable_call"]
        self.assertEqual(enable["db_unbound_delta"], 1)
        self.assertEqual([r["op"] for r in enable["records"]],
                         ["POST /api/diagnostics/operation-census"])
        self.assertFalse(enable["records"][0]["db_present"])
        tools = res["action_less_tools"]
        self.assertEqual(tools["orgtree_chart"]["unclassified_action_delta"], 1)
        self.assertEqual(tools["orgtree_send_notice"]["unclassified_action_delta"], 1)
        for tool in ("orgtree_status", "orgtree_work", "orgtree_watchdog"):
            self.assertEqual(tools[tool]["unclassified_action_delta"], 0, tool)

    def test_markdown_lists_every_row(self):
        self.assertEqual(self.md.count("\n| "), len(self.doc["rows"]) + 1)


if __name__ == "__main__":
    unittest.main()
