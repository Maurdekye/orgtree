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
    "diagnostic.capabilities", "preview.agent", "status.report", "chart.read",
    "org.tree", "org.node-detail", "org.feed", "mail.message", "mail.notice"}


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
            if "sqlite_connect:data:org-db:foreign" in r["expected_unknown"]:
                # declared cross-org rows (the control, @org: delivery, the
                # bare-name lookup): they must SHOW the foreign contact
                self.assertTrue(any(k.startswith("data:org-db:foreign")
                                    for k in r["audit"].get("sqlite_connect", {})), r["variant"])
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
                    # an exception that escapes the handler (a recorded 500)
                    # leaves the request's total time but no handler time
                    self.assertIn("handler_ms" if r["http_status"] != 500 else "total_ms",
                                  r["census"]["profile"])
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
            if r["variant"] in (self.CONTROL, self.STATUS_CONTROL, self.MAIL_CONTROL):
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["agents"]["third_agent_mail"], 0)
                # a migration transcodes the WHOLE document, every node row
                # (test_migration_paths_write_and_fail_inside_the_operation)
                if not (r["variant"] == "migration:legacy-json" and r["condition"] == "cold"):
                    self.assertEqual(r["agents"]["third_agent_rows_written"], 0)
            if r["agents"]["mail_producing"]:
                producing.add(r["contract"])
        self.assertEqual(producing, {"reservation.release-notify", "status.report",
                                     "mail.message", "mail.notice"})

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
        """Only the rows that provoke a process or egress ON PURPOSE (and
        declare it) meet a guard, and each of them meets exactly the declared
        one; no row's process or socket ever gets past the guards."""
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                declared = {c.removeprefix("guard:") for c in r["expected_unknown"]
                            if c.startswith("guard:")}
                self.assertEqual(set(r["guard_refusals"]), declared)
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

    # -- the P01 read/effect clauses (p02-extend-the-contact-probe-to-the-p01-read-eff)
    LOSS = ("db_unbound", "db_late", "db_unattributed", "db_hidden_unattributed",
            "db_observe_failed", "db_self_recursion", "rejected", "dropped_stale_window",
            "dropped_capture_off", "evicted")
    #: rows that make an unknown-class contact ON PURPOSE, and exactly which
    DECLARED = {
        "sandbox:chown-new-dir": ["guard:process/subprocess.Popen"],
        "sandbox:on-disk": ["guard:process/subprocess.Popen"],
        "provider:codex-not-signed-in": ["guard:process/subprocess.Popen"],
        "provider:legacy-tier": ["guard:process/subprocess.Popen"],
        "provider:openrouter-network-refused": ["guard:egress/urllib.Request"],
    }
    F_CONN, F_STMT = "sqlite_connect:data:org-db:foreign", "statement:data:org-db:foreign"

    def declared_for(self, r):
        """The unknown classes a row provokes on purpose. Cross-org rows run
        statements on another org's store (warm and cold); cold, that store
        is closed first, so its connect shows too."""
        variant, condition, contract = r["variant"], r["condition"], r["contract"]
        if variant == "control:foreign-org-contact":
            return sorted([self.F_CONN, self.F_STMT])
        if variant in ("mail.message:org", "mail.message:bare-unknown-name"):
            return sorted([self.F_STMT] + ([self.F_CONN] if condition == "cold" else []))
        if contract == "org.tree" and variant in ("org.tree", "migration:legacy-json"):
            return [self.F_STMT]      # store.local_net_slugs: a doc row of EVERY org
        return self.DECLARED.get(variant, [])

    def test_every_row_loses_nothing(self):
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                deltas = r["census"]["counter_deltas"]
                self.assertEqual({k: deltas[k] for k in self.LOSS if deltas.get(k)}, {})
                self.assertEqual(r["harness"]["statements_unbound"], 0)
        # the JSON child's window too (db_unattributed there, as in the SQLite
        # window, counts statements BETWEEN operations: fixture writes)
        window = self.doc["json_backend"]["window"]["counters"]
        for key in self.LOSS:
            if key != "db_unattributed":
                self.assertEqual(window.get(key, 0), 0, key)

    def test_unknown_contacts_are_refused_unless_declared(self):
        """The probe-level drift refusal: a contact outside the closed set of
        known classes is refused unless the row declares it, and a declared
        one that does not occur is refused too."""
        seen = set()
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["unknown_contacts"], [])
                self.assertEqual(r["expected_unknown_missing"], [])
                want = self.declared_for(r)
                self.assertEqual(r["unknown_observed"], want)
                self.assertEqual(r["expected_unknown"], want)
                if want:
                    seen.add(r["variant"])
        self.assertEqual(seen, set(self.DECLARED) | {
            "control:foreign-org-contact", "mail.message:org", "mail.message:bare-unknown-name",
            "org.tree", "migration:legacy-json"})

    def test_sandboxed_org_reads_come_from_the_sandbox_placement(self):
        """material.reads: a SANDBOXED org's transcript is read from the
        sandbox home; with disk-backed placement the path resolution itself
        starts wsl (refused here) before any read."""
        for condition in ("cold", "warm"):
            with self.subTest(condition=condition):
                t = self.rows(contract="material.transcript", variant="sandbox:host-placed",
                              condition=condition)[0]
                self.assertEqual(t["http_status"], 200, t["detail"])
                self.assertIn("file_read:data:sandbox", t["contact_classes"])
                self.assertNotIn("file_read:home:provider", t["contact_classes"])
                sc = self.rows(contract="material.scratch", variant="sandbox:host-placed",
                               condition=condition)[0]
                self.assertEqual(sc["http_status"], 200, sc["detail"])
                self.assertIn("file_read:data:scratch", sc["contact_classes"])
        for contract in ("material.scratch", "material.transcript"):
            with self.subTest(on_disk=contract):
                r = self.rows(contract=contract, variant="sandbox:on-disk")[0]
                self.assertEqual(r["http_status"], 500)
                self.assertIn("GuardRefused", r["detail"])
                self.assertEqual(r["guard_refusals"], {"process/subprocess.Popen": 1})
                self.assertFalse([c for c in r["contact_classes"]
                                  if c.endswith(("data:sandbox", "data:scratch"))])

    def test_sandbox_chown_effect_is_attempted_and_its_failure_swallowed(self):
        """material.effects: minting a node's scratch dir in a sandboxed org
        hands it to the container user (docker exec); refused, the product
        swallows the failure and the read still answers."""
        r = self.rows(variant="sandbox:chown-new-dir")[0]
        self.assertEqual(r["http_status"], 200, r["detail"])
        self.assertEqual(r["guard_refusals"], {"process/subprocess.Popen": 1})
        self.assertIn("fs_mutation:data:scratch", r["contact_classes"])

    def test_json_backend_diagnostic_contacts(self):
        """diagnostic.reads on the JSON store backend: a child process of the
        probe, same checkout, reading the org's .json document."""
        prov = self.doc["json_backend"]["provenance"]
        self.assertEqual(prov["store_backend"], "json")
        self.assertEqual(prov["commit"], self.doc["provenance"]["commit"])
        self.assertTrue(prov["orgtree_under_tree"])
        for contract in ("diagnostic.inspect", "diagnostic.capabilities"):
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    r = self.rows(variant=f"json:{contract}", condition=condition)[0]
                    self.assertEqual(r["backend"], "json")
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertEqual(r["census"]["statements"], 0)
                    self.assertNotIn("primary", r["harness"]["stores"])
            killed = self.rows(variant="json:refusal:killswitch", contract=contract)
            self.assertEqual([r["http_status"] for r in killed], [409])
        cold = self.rows(variant="json:diagnostic.inspect", condition="cold")[0]
        self.assertIn("file_read:data:org-db:own", cold["contact_classes"])
        self.assertEqual({r["backend"] for r in self.doc["rows"]
                          if not r["variant"].startswith("json:")}, {"sqlite"})

    #: P01's legacy outcomes (tests/test_state_diagnostic_boundary.py
    #: CORRUPT_NODE): status for node=deep, status for the whole org
    MALFORMED = {
        'generation="x"': (500, 500), "generation=[1]": (500, 500),
        "generation=null": (200, 200), 'grant="x"': (500, 500), "grant=null": (500, 500),
        "grant=-5": (200, 200), "model=null": (500, 500), "model=5": (500, 500),
        'scope="bad"': (500, 500), 'scope.tools="bad"': (500, 500),
        "scope.org_visibility=5": (200, 200), 'state="weird"': (422, 200),
        'parent="ghost"': (422, 200), 'frozen="bad"': (200, 200), "frozen=[1]": (200, 200),
        'pending_switch="bad"': (200, 200), 'last_status="bad"': (200, 200),
        "title=5": (200, 200),
    }

    def test_malformed_stored_state_contacts_on_both_backends(self):
        for prefix in ("", "json:"):
            for key, (one, whole) in self.MALFORMED.items():
                with self.subTest(backend=prefix or "sqlite", corrupt=key):
                    node = self.rows(variant=f"{prefix}malformed:{key}:node")
                    org = self.rows(variant=f"{prefix}malformed:{key}:org")
                    self.assertEqual([r["http_status"] for r in node], [one])
                    self.assertEqual([r["http_status"] for r in org], [whole])
                    for r in node + org:
                        self.assertEqual(r["census"]["records"], 1)
                        self.assertEqual(r["harness"]["writes"], 0)

    def test_migration_paths_write_and_fail_inside_the_operation(self):
        """diagnostic.writes/effects and preview.writes: a legacy .json met by
        an operation is refused without ORGTREE_MIGRATE, migrated with it
        (the migration's writes and renames are the operation's contacts),
        refused as MigrationError when it is not JSON, and an interrupted
        migration is finished by a rename."""
        for contract in ("diagnostic.inspect", "preview.agent", "chart.read"):
            with self.subTest(contract=contract):
                refused = self.rows(contract=contract, variant="migration:refused")[0]
                self.assertEqual(refused["http_status"], 500)
                self.assertTrue(refused["detail"].startswith("MigrationRefused"))
                self.assertEqual(refused["harness"]["writes"], 0)
                cold = self.rows(contract=contract, variant="migration:legacy-json",
                                 condition="cold")[0]
                self.assertEqual(cold["http_status"], 200, cold["detail"])
                self.assertGreater(cold["harness"]["writes"], 0)
                # the one write outside a transaction is the candidate's schema
                # DDL, run before migrate_org's BEGIN IMMEDIATE
                h = cold["harness"]
                self.assertEqual(h["writes"] - h["writes_in_transaction"],
                                 h["stores"]["primary"]["kinds"].get("ddl"))
                renames = cold["audit"]["fs_mutation"]
                self.assertIn("os.rename:data:org-db:own@orgtree.store:migrate_org", renames)
                self.assertIn("file_read:data:org-db:own", cold["contact_classes"])
                # the transcode writes every agent's node row, and no mail
                self.assertEqual(set(cold["agents"]["physical_nodes"]),
                                 {"boss", "reader", "deep", "b"})
                self.assertFalse(cold["agents"]["mail_producing"])
                warm = self.rows(contract=contract, variant="migration:legacy-json",
                                 condition="warm")[0]
                self.assertEqual(warm["harness"]["writes"], 0)
                self.assertNotIn("fs_mutation:data:org-db:own", warm["contact_classes"])
        bad = self.rows(variant="migration:malformed-json")[0]
        self.assertEqual(bad["http_status"], 500)
        self.assertTrue(bad["detail"].startswith("MigrationError"))
        self.assertEqual(bad["harness"]["writes"], 0)
        interrupted = self.rows(variant="migration:interrupted")[0]
        self.assertEqual(interrupted["http_status"], 200, interrupted["detail"])
        self.assertEqual(interrupted["harness"]["writes"], 0)
        self.assertIn("os.rename:data:org-db:own@orgtree.store:_finish_interrupted_migration",
                      interrupted["audit"]["fs_mutation"])

    def test_preview_clone_effects_are_recorded_and_the_store_is_not_written(self):
        """preview.writes: the mutator's effects inside the simulation clone,
        per variant; the store itself is never written by a preview."""
        for op in PREVIEW:
            with self.subTest(op=op):
                warm = self.rows(variant=f"preview.{op}", condition="warm")[0]
                self.assertEqual(warm["http_status"], 200, warm["detail"])
                self.assertIsNotNone(warm["clone"])
                self.assertGreater(warm["clone"]["paths"], 0)
                self.assertIn("events", warm["clone"]["sections"])
                self.assertEqual(warm["harness"]["writes"], 0)
        realloc = self.rows(variant="preview.reallocate", condition="warm")[0]
        self.assertEqual(realloc["clone"]["nodes"], {"b": "target"})
        for r in self.doc["rows"]:
            if r["contract"] != "preview.agent":
                self.assertIsNone(r["clone"], r["variant"])

    #: the unstubbed provider preflight, one failure mode each
    PROVIDER = {
        "disabled": "is turned off in App settings",
        "claude-not-installed": "the Claude Code CLI is not installed",
        "claude-not-signed-in": "Claude is not signed in",
        "registry-unknown-account": "no account 'p02-absent-account' is registered",
        "codex-not-installed": "the Codex CLI is not installed",
        "codex-not-signed-in": "Codex is not signed in",
        "legacy-tier": "is no longer hireable",
        "antigravity-not-installed": "the Antigravity CLI is not installed",
        "openrouter-no-key": "no OpenRouter API key is set",
        "openrouter-network-refused": "openrouter.ai did not accept the stored key",
    }

    def test_provider_failure_modes_without_stubbed_preflights(self):
        """preview.effects: each provider failure mode the gate names, with
        the preflight UNSTUBBED; the outcome and every attempted process or
        egress are recorded."""
        for mode, text in self.PROVIDER.items():
            with self.subTest(mode=mode):
                rows = self.rows(variant=f"provider:{mode}")
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["http_status"], 422)
                self.assertIn(text, rows[0]["detail"])
                self.assertEqual(rows[0]["harness"]["writes"], 0)

    def test_release_notify_to_an_audience_reached_successor(self):
        """P01 contacts review f1: a successor who is not a sibling and not
        in the sender's line, reached through a held audience; its mail
        reaches only that successor."""
        r = self.rows(variant="audience-successor:reservation.release-notify")[0]
        self.assertEqual(r["http_status"], 200, r["detail"])
        agents = r["agents"]
        self.assertEqual(agents["targets"], ["cousin"])
        self.assertEqual(agents["logical"]["mail"], {"cousin": "target"})
        self.assertEqual(agents["physical_nodes"], {"cousin": "target"})
        self.assertEqual(agents["third_agent_mail"], 0)
        self.assertEqual(r["wakes"]["send_message"], 1)
        refused = self.rows(variant="refusal:unaddressable-successor")[0]
        self.assertEqual(refused["http_status"], 422)

    # -- P01 S3 F1: status.report and chart.read (phase 2) -----------------------
    STATUS_CONTROL = "control:status-third-agent-mail"
    PARENT = "st-chief"

    def test_status_outcomes_and_the_parent_report(self):
        """status.reads/instrumentation: EVERY outcome the clause names (done
        and blocked with and without a parent, working, idle, unvalidated,
        keyed, replay, refusals), each cold AND warm, loss-accounted. With a
        parent, done/blocked reach ONLY that parent (an implied target read
        from the stored node) with one wake; every other outcome writes only
        the caller's node row."""
        both = ("cold", "warm")
        reporting = ["status.report", "status.report:blocked-with-parent",
                     "status.report:keyed-fresh"]
        local = ["status.report:working", "status.report:idle", "status.report:unvalidated",
                 "status.report:done-top-level", "status.report:blocked-top-level"]
        for variant in reporting:
            for condition in both:
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="status.report", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    agents = r["agents"]
                    self.assertEqual(agents["targets"], [self.PARENT])
                    self.assertEqual(agents["logical"], {"mail": {self.PARENT: "target"},
                                                         "mail_log": {self.PARENT: "target"}})
                    self.assertEqual(agents["physical_nodes"],
                                     {self.PARENT: "target", "st-worker": "actor"})
                    self.assertEqual(r["wakes"]["send_message"], 1)
                    self.assertTrue(r["harness"]["all_writes_in_transaction"])
        for variant in local:
            for condition in both:
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="status.report", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertFalse(r["agents"]["mail_producing"])
                    self.assertEqual(r["wakes"]["send_message"], 0)
                    self.assertEqual(r["harness"]["stores"]["primary"]["tables_written"],
                                     ["nodes"])
                    self.assertEqual(r["harness"]["writes"], 1)
        top_level = (self.rows(contract="status.report", variant="status.report:done-top-level")
                     + self.rows(contract="status.report",
                                 variant="status.report:blocked-top-level"))
        for r in top_level:
            self.assertEqual(r["agents"]["targets"], [])
        for condition in both:
            with self.subTest(replay=condition):
                replay = self.rows(variant="status.report:keyed-replay", condition=condition)[0]
                self.assertEqual((replay["http_status"], replay["harness"]["writes"],
                                  replay["wakes"]["send_message"]), (200, 0, 0))
                self.assertFalse(replay["agents"]["mail_producing"])
            for variant, status in (("refusal:status-bad-value", 422),
                                    ("refusal:status-halted", 409)):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
        self.assertEqual(len(self.rows(contract="status.report")), 23)

    def test_status_third_agent_mail_control_is_flagged(self):
        control = self.rows(variant=self.STATUS_CONTROL)[0]
        agents = control["agents"]
        self.assertEqual(control["http_status"], 200)
        self.assertEqual(agents["logical"]["mail"],
                         {self.PARENT: "target", "st-sibling": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)

    #: what each visibility level disclosed, as OBSERVED (the chart always
    #: names the caller's superior; archived rows appear from subtree up)
    CHART = {
        "self": ["st-chief", "st-deep", "st-worker"],
        "team": ["st-chief", "st-deep", "st-sibling", "st-worker"],
        "subtree": ["st-chief", "st-deep", "st-sibling", "st-worker"],
        "full": ["st-chief", "st-deep", "st-sibling", "st-worker"],
    }

    def test_chart_contacts_at_every_visibility_level(self):
        """chart.reads/instrumentation: each level, with and without archived
        rows, cold and warm; a read that writes nothing and signals nothing.
        `disclosed` proves each level took effect."""
        for level, shown in self.CHART.items():
            for archived in (False, True):
                for condition in ("cold", "warm"):
                    variant = f"chart.read:{level}" + ("+archived" if archived else "")
                    with self.subTest(variant=variant, condition=condition):
                        r = self.rows(variant=variant, condition=condition)[0]
                        self.assertEqual(r["http_status"], 200, r["detail"])
                        self.assertEqual(r["harness"]["writes"], 0)
                        self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
                        want = shown + (["st-retired"] if archived and level in ("subtree", "full")
                                        else [])
                        self.assertEqual(r["disclosed"], sorted(want))
                        if condition == "cold":
                            self.assertEqual(r["census"]["connects"], 1)
                            self.assertGreater(r["census"]["statements"], 0)
        for r in self.doc["rows"]:
            if r["contract"] not in ("chart.read", "org.tree", "org.node-detail"):
                self.assertIsNone(r["disclosed"], r["variant"])


    # -- P01 S3 F1b: org.tree, org.node-detail, org.feed ---------------------------
    OV_ALL = ["ov-boss", "ov-gone", "ov-worker"]

    def test_org_tree_and_detail_admin_and_public_cold_and_warm(self):
        """org-view.reads/instrumentation: the tree and detail routes, admin
        and public, cold and warm, with an archived node present; each a read
        that writes nothing; `disclosed` shows the archived node is in the
        tree and that each detail row answers for its own node."""
        cases = {"org.tree": ("org.tree", self.OV_ALL),
                 "org.tree:public": ("org.tree", self.OV_ALL),
                 "org.node-detail": ("org.node-detail", ["ov-worker"]),
                 "org.node-detail:archived": ("org.node-detail", ["ov-gone"]),
                 "org.node-detail:public": ("org.node-detail", ["ov-worker"])}
        for variant, (contract, shown) in cases.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract=contract, variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertEqual(r["harness"]["writes"], 0)
                    self.assertEqual(r["disclosed"], shown)
                    if condition == "cold":
                        self.assertGreater(r["census"]["statements"], 0)
        refusals = {"refusal:tree-no-token": 401, "refusal:detail-unknown-node": 404,
                    "refusal:tree-bad-kiosk-token": 404,
                    "refusal:tree-admin-on-kiosk-org": 500}
        for variant, status in refusals.items():
            with self.subTest(variant=variant):
                r = self.rows(variant=variant)[0]
                self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
        self.assertIn("Not available in desktop MVP: kiosk",
                      self.rows(variant="refusal:tree-admin-on-kiosk-org")[0]["detail"])

    def test_org_tree_migration_path_through_cached_org(self):
        """org-view.writes: the cold and migration paths reached through
        cached_org."""
        refused = self.rows(contract="org.tree", variant="migration:refused")[0]
        self.assertEqual((refused["http_status"], refused["harness"]["writes"]), (500, 0))
        cold = self.rows(contract="org.tree", variant="migration:legacy-json", condition="cold")[0]
        self.assertEqual(cold["http_status"], 200, cold["detail"])
        self.assertGreater(cold["harness"]["writes"], 0)
        self.assertIn("os.rename:data:org-db:own@orgtree.store:migrate_org",
                      cold["audit"]["fs_mutation"])
        warm = self.rows(contract="org.tree", variant="migration:legacy-json", condition="warm")[0]
        self.assertEqual(warm["harness"]["writes"], 0)

    def test_org_feed_subscriptions_and_fan_out(self):
        """org-feed.instrumentation: subscriptions and frame fan-out per slug,
        admin and public. The census records no websocket attempt (census
        records 0), and a subscription runs no statement."""
        for variant, label, public in (("org.feed", "admin", 0), ("org.feed:public", "public", 1)):
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="org.feed", variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 101)
                    self.assertEqual(r["feed"], {"subscribers": 1, "frames": {label: 1},
                                                 "public_in_room": public})
                    self.assertEqual(r["census"]["records"], 0)
                    self.assertEqual(r["harness"]["statements_attributed"]
                                     + r["harness"]["statements_unbound"], 0)
        fan = self.rows(variant="org.feed:fanout")[0]
        self.assertEqual(fan["feed"], {"subscribers": 2, "frames": {"admin": 2, "public": 2},
                                       "public_in_room": 1})
        refused = self.rows(variant="refusal:feed-no-token")[0]
        self.assertEqual((refused["http_status"], refused["feed"]),
                         (4401, {"refused": True, "close_code": 4401}))

    def test_kiosk_token_scan_is_measured_outside_the_rows(self):
        """The public gateway's token-map rebuild runs before any census
        attempt and reads every org's document: none of its statements can be
        attributed. Measured on its own so the public rows carry only their
        own request."""
        scan = self.doc["kiosk_token_scan"]
        self.assertGreater(scan["statements"], 0)
        self.assertEqual(scan["statements_unbound"], scan["statements"])
        self.assertGreater(scan["db_unattributed_delta"], 0)
        self.assertEqual(scan["recorded_delta"], 0)
        self.assertEqual(scan["kiosk_orgs_mapped"], 1)
        self.assertGreater(scan["orgs_listed"], 1)


    # -- P01 S3 F2: mail.message, mail.notice ---------------------------------------
    MAIL_CONTROL = "control:mail-third-agent"

    def test_mail_by_recipient_class_reaches_only_the_named_recipient(self):
        """agent-mail.reads/instrumentation: both mail tools by recipient class,
        cold and warm, loss-accounted, with agent-level locality: only the
        sender and the named recipient are touched."""
        in_org = {"mail.message": ("mail.message", "m-top"),
                  "mail.message:deep": ("mail.message", "m-deep"),
                  "mail.message:archived": ("mail.message", "m-gone"),
                  "mail.notice": ("mail.notice", "m-sib"),
                  "mail.notice:deep": ("mail.notice", "m-kid"),
                  "mail.notice:archived": ("mail.notice", "m-gone")}
        for variant, (contract, to) in in_org.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract=contract, variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    agents = r["agents"]
                    self.assertEqual(agents["targets"], [to])
                    self.assertEqual({k: v for k, v in agents["logical"].items()
                                      if k in ("mail", "mail_log")},
                                     {"mail": {to: "target"}, "mail_log": {to: "target"}})
                    roles = {role for sect in agents["logical"].values() for role in sect.values()}
                    self.assertLessEqual(roles, {"actor", "target"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
        # the first send down past a direct report grants a reply audience
        for variant, pair in (("mail.message:deep", {"m-deep": "target", "m-mid": "actor"}),
                              ("mail.notice:deep", {"m-kid": "target", "m-top": "actor"})):
            cold = self.rows(variant=variant, condition="cold")[0]
            warm = self.rows(variant=variant, condition="warm")[0]
            self.assertEqual(cold["agents"]["logical"].get("audiences"), pair)
            self.assertNotIn("audiences", warm["agents"]["logical"])
        for variant in ("mail.message:user", "mail.message:org", "mail.message:mcp"):
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertNotIn("mail", r["agents"]["logical"])
                    self.assertEqual(r["agents"]["third_agent_mail"], 0)
        refusals = {"mail.message:bare-unknown-name": 422, "refusal:notice-to-org": 422,
                    "refusal:notice-to-user": 422, "refusal:mail-halted": 409}
        for variant, status in refusals.items():
            for r in self.rows(variant=variant):
                with self.subTest(variant=variant, condition=r["condition"]):
                    self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
        for contract in ("mail.message", "mail.notice"):
            for condition in ("cold", "warm"):
                replay = self.rows(variant=f"{contract}:keyed-replay", condition=condition)[0]
                self.assertEqual((replay["http_status"], replay["harness"]["writes"],
                                  replay["wakes"]["send_message"]), (200, 0, 0))

    def test_cross_org_mail_contacts_are_observed_and_declared(self):
        """agent-mail.effects (P02 observing): @org: mail writes into ANOTHER
        org's store (interorg_send, unstubbed) and a bare unknown name is
        looked up across every org; cold, each shows the foreign store."""
        org = self.rows(variant="mail.message:org", condition="cold")[0]
        self.assertEqual(org["agents"]["logical"].get("audiences"),
                         {"@extern": "user-or-org", "m-top": "actor"})
        for variant in ("mail.message:org", "mail.message:bare-unknown-name"):
            cold = self.rows(variant=variant, condition="cold")[0]
            self.assertIn("sqlite_connect:data:org-db:foreign", cold["contact_classes"])
        bare = self.rows(variant="mail.message:bare-unknown-name", condition="warm")[0]
        self.assertGreater(bare["census"]["statements"], 100)
        # WARM, the foreign store is pooled (no connect), yet each statement is
        # classified by its connection's file: the cross-org reads still show
        for variant in ("mail.message:org", "mail.message:bare-unknown-name"):
            warm = self.rows(variant=variant, condition="warm")[0]
            self.assertNotIn(self.F_CONN, warm["contact_classes"])
            self.assertGreater(warm["harness"]["statement_stores"].get("data:org-db:foreign", 0), 0)
        warm_org = self.rows(variant="mail.message:org", condition="warm")[0]
        self.assertIn("orgtree.store:_write_doc", warm_org["harness"]["foreign_statement_sites"])

    def test_statements_are_classified_by_the_store_they_ran_on(self):
        """Every statement carries its connection's store class; no statement
        runs on an unmapped connection, and only the declared cross-org rows
        run any on another org's store (with the product site named)."""
        for r in self.doc["rows"]:
            stores = r["harness"]["statement_stores"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertNotIn("unmapped", stores)
                self.assertEqual(sum(stores.values()),
                                 r["harness"]["statements_attributed"]
                                 + r["harness"]["statements_unbound"])
                foreign = stores.get("data:org-db:foreign", 0)
                self.assertEqual(foreign > 0, self.F_STMT in self.declared_for(r))
                self.assertEqual(sum(r["harness"]["foreign_statement_sites"].values()), foreign)
        for condition in ("cold", "warm"):
            tree = self.rows(contract="org.tree", variant="org.tree", condition=condition)[0]
            self.assertEqual(set(tree["harness"]["foreign_statement_sites"]),
                             {"orgtree.store:local_net_slugs"})

    def test_mail_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.MAIL_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"m-top": "target", "m-sib": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)


if __name__ == "__main__":
    unittest.main()
