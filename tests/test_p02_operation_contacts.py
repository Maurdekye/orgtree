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
    "org.tree", "org.node-detail", "org.feed", "mail.message", "mail.notice",
    "mail.human-send", "mail.user-inbox", "mail.user-inbox-read", "mail.node-inbox",
    "credits.request", "credits.reallocate", "credits.decide",
    "staffing.hire", "staffing.staff-create", "staffing.staff-update",
    "operator.hire", "operator.reallocate",
    "quick-staff.options", "quick-staff.options-refresh", "quick-staff.preview",
    "quick-staff.select", "work.item-list", "work.item-get", "receipt.lookup"} | {
    f"lifecycle.{v}" for v in (
        "rename", "retool", "retire", "dissolve", "cheap-compact", "rehire", "move", "swap",
        "self-subjugate", "switch-model", "account-assign", "reorder", "compact",
        "dissolve-all", "lineage-recover", "lineage-drop-phantom", "repair-rename")} | {
    "catalogue.list-orgs", "catalogue.list-tiers"} | {
    f"operator.{v}" for v in (
        "rename", "retire", "rescind", "cheap-compact", "rehire", "dissolve", "delete",
        "switch-model", "promote", "demote", "move", "reseed", "revoke-dir", "preview")} | {
    f"asks.{v}" for v in ("ask", "withdraw", "present", "submit-report", "request-scope",
                          "answer", "batch-resolve")} | {
    f"watchdogs.{v}" for v in ("create", "list", "pause", "resume", "remove", "supersede",
                               "operator-action")} | {
    f"audiences.{v}" for v in ("request", "forward", "grant", "deny", "revoke", "operator-action",
                               "list")} | {"lifecycle.operator-scope"} | {
    f"control.{v}" for v in (
        "interrupt", "unstick", "continue-on", "halt", "unhalt", "self-restart",
        "prime-restart-arm", "prime-restart-cancel", "prime-restart-status", "restart-wake-arm",
        "restart-wake-cancel", "restart-wake-status", "op-interrupt", "op-unstick",
        "op-continue-on", "op-halt", "op-unhalt", "op-process", "killswitch",
        "killswitch-release", "resume", "remote-control", "steer-claim", "steer-ack",
        "steer-state", "kiosk")} | {
    f"exchange.{v}" for v in (
        "orgs-list", "extern-send", "extern-read", "extern-wait", "org-inbox-list", "mail-item",
        "org-inbox-read", "org-inbox-upload", "org-inbox-send", "inbox-clear", "node-upload",
        "reply-events-count", "reply-events-clear", "mail-retract", "send-file")}
#: the managed-wait tools (mcptool.MANAGED_WAIT_TOOLS) among the probed ones
MANAGED_WAIT = {"orgtree_hire", "orgtree_staff", "orgtree_rehire", "orgtree_retire",
                "orgtree_dissolve", "orgtree_cheap_compact", "orgtree_watchdog",
                "orgtree_continue_on"}


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
        # checked before the app loaded, in this process and in the JSON child:
        # each module's own __file__ is exactly this tree's
        want = {"engine": ROOT / "engine" / "__init__.py",
                "orgtree": ROOT / "engine" / "backend" / "orgtree" / "__init__.py"}
        for doc in (prov, self.doc["json_backend"]["provenance"]):
            got = doc["imports_checked"]
            self.assertEqual(set(got), set(want))
            for name, path in want.items():
                self.assertEqual(os.path.normcase(os.path.realpath(got[name])),
                                 os.path.normcase(os.path.realpath(path)), name)

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
            for group in ("file_read", "file_write", "dir_list", "sqlite_connect", "fs_mutation",
                          "stat"):
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
                            "mail_producing", "third_agent_mail", "third_agent_rows_written",
                            "third_sites", "physical_written"):
                    self.assertIn(key, agents)
                self.assertLessEqual(set(agents["physical_written"]), set(agents["physical_nodes"]))
                # every physical touch of a third agent's row names its product step
                self.assertEqual(sum(agents["third_sites"].values()),
                                 sum(n for k, n in agents["physical"].items()
                                     if k.endswith(":third")))
                self.assertFalse([s for s in agents["third_sites"] if s.endswith("@?")])

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
            if r["variant"] in (self.CONTROL, self.STATUS_CONTROL, self.MAIL_CONTROL,
                                self.HUMAN_CONTROL, self.FUNDING_CONTROL,
                                self.STAFFING_CONTROL, self.OPERATOR_CONTROL,
                                self.QS_CONTROL, self.RL_CONTROL, self.LC_CONTROL,
                                self.VX_CONTROL, self.RQ_CONTROL, self.CT_CONTROL,
                                self.EX_CONTROL):
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["agents"]["third_agent_mail"], 0)
                # a migration transcodes the WHOLE document, every node row
                # (test_migration_paths_write_and_fail_inside_the_operation)
                # and the F2 unhalt carry-over, pinned exactly by
                # test_control_rows_reach_only_the_declared_set
                if not (r["variant"] == "migration:legacy-json" and r["condition"] == "cold") \
                        and not (r["variant"] in self.CT_UNHALT_CARRY and r["condition"] == "warm"):
                    self.assertEqual(r["agents"]["third_agent_rows_written"], 0)
            if r["agents"]["mail_producing"]:
                producing.add(r["contract"])
        self.assertEqual(producing, {"reservation.release-notify", "status.report",
                                     "mail.message", "mail.notice", "mail.human-send",
                                     "credits.reallocate", "credits.decide", "staffing.hire",
                                     "staffing.staff-create", "staffing.staff-update",
                                     "operator.hire", "operator.reallocate",
                                     "quick-staff.select"} | {
                                         f"lifecycle.{v}" for v in (
                                             "rename", "retool", "retire", "dissolve",
                                             "cheap-compact", "rehire", "move", "swap",
                                             "self-subjugate", "switch-model",
                                             "dissolve-all")} | {
                                         f"operator.{v}" for v in (
                                             "rename", "retire", "rescind", "cheap-compact",
                                             "rehire", "dissolve", "delete", "switch-model",
                                             "promote", "demote", "move", "reseed")} | {
                                         "asks.answer", "asks.ask", "asks.batch-resolve",
                                         "asks.request-scope", "asks.submit-report",
                                         "audiences.deny", "audiences.forward", "audiences.grant",
                                         "audiences.operator-action", "audiences.request",
                                         "audiences.revoke", "control.op-unstick",
                                         "control.unstick", "lifecycle.operator-scope",
                                         "exchange.extern-send", "exchange.mail-retract"})

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
        self.assertEqual(len(sites), 18)
        self.assertEqual(sum(s["status"] == "instrumented" for s in sites), 7)
        for s in sites:
            self.assertIn(s["status"], ("instrumented", "uninstrumented"))
            self.assertTrue(s["reason"])
            self.assertNotIn("NOT in census_contacts", s["reason"])
            # a named reason, never the fallback for a file nobody described
            self.assertNotEqual(s["reason"], "not listed by census_contacts", s["path"])
        hub = [s for s in sites if s["path"] == "engine/mailhub_runtime.py"]
        self.assertEqual(len(hub), 3)
        for s in hub:
            self.assertEqual(s["status"], "uninstrumented")
            self.assertIn("mail hub store", s["reason"])

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
        if variant in ("control:foreign-org-contact", "control:work-read-foreign-org"):
            return sorted([self.F_CONN, self.F_STMT])
        if variant in ("mail.message:org", "mail.message:bare-unknown-name"):
            return sorted([self.F_STMT] + ([self.F_CONN] if condition == "cold" else []))
        if variant == "refusal:human-unknown-node":
            return [self.F_STMT]      # the name is looked up in EVERY other org
        if contract == "org.tree" and variant in ("org.tree", "migration:legacy-json"):
            return [self.F_STMT]      # store.local_net_slugs: a doc row of EVERY org
        if variant == "catalogue.list-orgs":
            return [self.F_STMT]      # the catalogue loads EVERY org (pooled stores)
        if variant in self.EX_FOREIGN:
            return [self.F_STMT]      # F4: the org list, the extern scans, an @org: send
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
            "org.tree", "migration:legacy-json", "refusal:human-unknown-node",
            "control:work-read-foreign-org", "catalogue.list-orgs"} | self.EX_FOREIGN)

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
            # the operator door's preview runs the same simulation (F1b)
            if r["contract"] not in ("preview.agent", "operator.preview"):
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
        # the org-view kiosk and F4's sealed kiosk (F2's kiosk orgs hold no token)
        self.assertEqual(scan["kiosk_orgs_mapped"], 2)
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

    # -- P01 S3 F2, the human side: mail.human-send and the inbox routes -------------
    HUMAN_CONTROL = "control:human-send-third-agent"
    #: class -> (node, its notified superior chain)
    HUMAN = {"mail.human-send": ("h-top", []),
             "mail.human-send:deep": ("h-deep", ["h-mid", "h-top"]),
             "mail.human-send:archived": ("h-gone", ["h-top"]),
             "mail.human-send:notice": ("h-mid", ["h-top"]),
             "mail.human-send:session-command": ("h-mid", ["h-top"]),
             "mail.human-send:attachment": ("h-top", []),
             "mail.human-send:reply-to-chat-event": ("h-top", []),
             "mail.human-send:reply-target": ("h-top", [])}

    def test_human_send_by_class_reaches_only_the_node_and_its_chain(self):
        """human-mail.reads/instrumentation: the operator's send by class, cold
        and warm, loss-accounted, with agent-level locality: only the node
        (mail) and its superior chain (deep-reach notices) are touched."""
        for variant, (node, chain) in self.HUMAN.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="mail.human-send", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    agents = r["agents"]
                    self.assertEqual(agents["actor"], "@user")
                    self.assertEqual(agents["targets"], sorted([node] + chain))
                    logical = agents["logical"]
                    command = variant.endswith("session-command")
                    self.assertEqual(logical.get("mail"), None if command else {node: "target"})
                    self.assertEqual(logical.get("notices", {}),
                                     {n: "target" for n in chain})
                    roles = {role for sect in logical.values() for role in sect.values()}
                    self.assertLessEqual(roles, {"actor", "target"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    if not variant.endswith("chat-event"):      # its sidecar DDL, below
                        self.assertTrue(r["harness"]["all_writes_in_transaction"])
                    wakes = r["wakes"]
                    self.assertEqual(r["immediate_command"], int(command))
                    self.assertEqual(wakes["mail_notify"], int(not command))
                    # an archived recipient is deferred: sparked, never pinged
                    self.assertEqual(wakes["send_message"], int(not variant.endswith("archived")))
        # the first contact with a non-top node grants a user audience; warm, none
        for variant in ("mail.human-send:deep", "mail.human-send:archived",
                        "mail.human-send:notice"):
            node = self.HUMAN[variant][0]
            cold = self.rows(variant=variant, condition="cold")[0]
            warm = self.rows(variant=variant, condition="warm")[0]
            self.assertEqual(cold["agents"]["logical"].get("audiences"),
                             {node: "target", "@user": "actor"})
            self.assertNotIn("audiences", warm["agents"]["logical"])
        # the reply forms: a chat event is resolved through the chat sidecars
        for condition in ("cold", "warm"):
            chat = self.rows(variant="mail.human-send:reply-to-chat-event", condition=condition)[0]
            self.assertGreater(chat["harness"]["statement_stores"].get("data:sidecar-db", 0), 0)
            typed = self.rows(variant="mail.human-send:reply-target", condition=condition)[0]
            self.assertNotIn("data:sidecar-db", typed["harness"]["statement_stores"])
            # the chat-event reply reaches four sidecar connections, and the
            # reply_events sidecar re-runs its DDL outside a transaction per call
            h = chat["harness"]
            ddl = h["stores"]["reply_events"]["kinds"].get("ddl", 0)
            self.assertEqual(ddl, 1)
            self.assertEqual(h["writes"] - h["writes_in_transaction"], ddl)
            self.assertEqual(chat["census"]["connects"] + sum(
                (v.get("connects") or 0) for v in chat["census"]["secondary"].values()),
                5 if condition == "cold" else 4)
            # the attachment check stats h-top's working folder: two isfile
            # (one per attachment), one getsize (the file that exists)
            att = self.rows(variant="mail.human-send:attachment", condition=condition)[0]
            self.assertEqual(att["audit"].get("stat"),
                             {"data:scratch@orgtree.api:node_message": 3})
        for r in self.doc["rows"]:
            if r["variant"] != "mail.human-send:attachment":
                self.assertNotIn("stat", r["audit"], r["variant"])

    def test_human_send_refusals_and_the_every_org_name_lookup(self):
        refusals = {"refusal:human-empty": 422, "refusal:human-target-and-reply": 422,
                    "refusal:human-unknown-node": 422, "refusal:human-command-archived": 409}
        for variant, status in refusals.items():
            with self.subTest(variant=variant):
                r = self.rows(contract="mail.human-send", variant=variant)[0]
                self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
                self.assertEqual(sum(r["wakes"].values()), 0)
        unknown = self.rows(variant="refusal:human-unknown-node")[0]
        self.assertGreater(unknown["harness"]["statement_stores"]["data:org-db:foreign"], 100)
        # /compact with no conversation is refused before any compaction starts,
        # but only after the deep-reach notice to the chain is saved
        compact = self.rows(variant="refusal:compact-no-conversation")[0]
        self.assertEqual(compact["http_status"], 422)
        self.assertIn("no conversation yet", compact["detail"])
        self.assertEqual(compact["agents"]["logical"], {"notices": {"h-top": "target"}})
        self.assertEqual((sum(compact["wakes"].values()), compact["immediate_command"]), (0, 0))
        # the immediate path is reached by the session-command rows only
        self.assertEqual({r["variant"] for r in self.doc["rows"] if r["immediate_command"]},
                         {"mail.human-send:session-command"})

    def test_human_send_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.HUMAN_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"h-mid": "target", "h-sib": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)

    INBOX = {"mail.user-inbox": ("mail.user-inbox", False),
             "mail.user-inbox-read": ("mail.user-inbox-read", True),
             "mail.user-inbox-read:nothing-read": ("mail.user-inbox-read", False),
             "mail.node-inbox": ("mail.node-inbox", False)}

    def test_inbox_routes_on_both_backends_cold_and_warm(self):
        """inbox.reads/instrumentation: the three routes on both store backends,
        cold and warm, loss-accounted; only a read mark that matched writes,
        and it writes the org's own store (on JSON through a temp file renamed
        onto the org's own document)."""
        for prefix in ("", "json:"):
            for variant, (contract, writes) in self.INBOX.items():
                for condition in ("cold", "warm"):
                    with self.subTest(backend=prefix or "sqlite", variant=variant,
                                      condition=condition):
                        r = self.rows(contract=contract, variant=prefix + variant,
                                      condition=condition)[0]
                        self.assertEqual(r["http_status"], 200, r["detail"])
                        self.assertEqual(r["census"]["records"], 1)
                        self.assertEqual(sum(r["wakes"].values()), 0)
                        self.assertFalse(r["agents"]["mail_producing"])
                        if prefix:
                            self.assertEqual(r["census"]["statements"], 0)
                            wrote = [k for k in r["audit"].get("fs_mutation", {})
                                     if k.startswith("os.rename:")]
                            self.assertEqual(bool(wrote), writes)
                            for k in wrote:
                                self.assertTrue(k.startswith("os.rename:data:org-db:own@"), k)
                        else:
                            self.assertEqual(r["harness"]["writes"] > 0, writes)
                            self.assertTrue(r["harness"]["all_writes_in_transaction"])
            for variant, status in (("refusal:inbox-no-token", 401),
                                    ("refusal:node-inbox-unknown-node", 404)):
                with self.subTest(backend=prefix or "sqlite", refusal=variant):
                    r = self.rows(variant=prefix + variant)[0]
                    self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
        self.assertEqual(self.rows(variant="refusal:inbox-no-token")[0]["census"]["records"], 0)

    def test_inbox_migration_paths_write_inside_the_route(self):
        """inbox.writes: a legacy .json org met by each route is refused
        without ORGTREE_MIGRATE and migrated with it, inside the route."""
        for contract in ("mail.user-inbox", "mail.user-inbox-read", "mail.node-inbox"):
            with self.subTest(contract=contract):
                refused = self.rows(contract=contract, variant="migration:refused")[0]
                self.assertEqual((refused["http_status"], refused["harness"]["writes"]), (500, 0))
                self.assertTrue(refused["detail"].startswith("MigrationRefused"))
                cold = self.rows(contract=contract, variant="migration:legacy-json",
                                 condition="cold")[0]
                self.assertEqual(cold["http_status"], 200, cold["detail"])
                self.assertGreater(cold["harness"]["writes"], 0)
                self.assertIn("os.rename:data:org-db:own@orgtree.store:migrate_org",
                              cold["audit"]["fs_mutation"])
                warm = self.rows(contract=contract, variant="migration:legacy-json",
                                 condition="warm")[0]
                self.assertEqual((warm["http_status"], warm["harness"]["writes"]), (200, 0))

    # -- P01 S3 F3: credits.request, credits.reallocate, credits.decide -------------
    FUNDING_CONTROL = "control:funding-third-agent"

    def test_credit_requests_touch_only_the_caller(self):
        """funding.reads/instrumentation, credits.request: new, amend and
        withdraw, cold and warm; no other agent is read or written."""
        for variant in ("credits.request", "credits.request:amend", "credits.request:withdraw",
                        "credits.request:keyed-fresh"):
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="credits.request", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertGreater(r["harness"]["writes"], 0)
                    self.assertTrue(r["harness"]["all_writes_in_transaction"])
                    agents = r["agents"]
                    self.assertEqual((agents["targets"], agents["logical"],
                                      agents["physical_nodes"]), ([], {}, {}))
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
        noop = self.rows(variant="credits.request:nothing-to-request")[0]
        self.assertEqual((noop["http_status"], noop["harness"]["writes"]), (200, 0))
        for variant in ("refusal:request-no-reason", "refusal:request-not-a-number",
                        "refusal:request-not-top-level"):
            r = self.rows(variant=variant)[0]
            self.assertEqual((r["http_status"], r["harness"]["writes"]), (422, 0), variant)

    def test_reallocation_reaches_the_target_and_its_parent_only(self):
        """credits.reallocate up/down/deep, cold and warm: the grant notice
        goes to the target (and, for a grandchild, its parent). Besides them
        the only agent row touched is READ: a warm raise to f-mid reads its
        child f-kid's row (in the agent door's identity check, per
        third_sites), and nothing of it is written."""
        cases = {"credits.reallocate": ["f-mid"], "credits.reallocate:down": ["f-mid"],
                 "credits.reallocate:deep": ["f-kid", "f-mid"],
                 "credits.reallocate:keyed-fresh": ["f-mid"]}
        for variant, noticed in cases.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="credits.reallocate", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertTrue(r["harness"]["all_writes_in_transaction"])
                    agents = r["agents"]
                    self.assertEqual(agents["targets"], noticed)
                    self.assertEqual(agents["logical"], {"notices": {n: "target" for n in noticed}})
                    third = {n for n, role in agents["physical_nodes"].items() if role == "third"}
                    self.assertLessEqual(third, {"f-kid"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
        raise_warm = self.rows(variant="credits.reallocate", condition="warm")[0]["agents"]
        self.assertEqual(raise_warm["physical_nodes"].get("f-kid"), "third")
        # the product step behind that read is recorded (review N1 on b78c6ca)
        self.assertEqual(raise_warm["third_sites"], {"nodes:read@orgtree.api:_agent_identity": 1})
        zero = self.rows(variant="credits.reallocate:zero")[0]
        self.assertEqual((zero["http_status"], zero["harness"]["writes"], zero["agents"]["logical"]),
                         (200, 1, {}))                 # the 'reallocate' event only
        frac = self.rows(variant="credits.reallocate:fractional")[0]
        self.assertEqual(frac["agents"]["logical"], {"notices": {"f-mid": "target"}})
        for variant in ("refusal:reallocate-committed-floor", "refusal:reallocate-upward",
                        "refusal:reallocate-self", "refusal:reallocate-not-a-number"):
            r = self.rows(variant=variant)[0]
            self.assertEqual((r["http_status"], r["harness"]["writes"]), (422, 0), variant)
        for contract in ("credits.request", "credits.reallocate"):
            for condition in ("cold", "warm"):
                replay = self.rows(variant=f"{contract}:keyed-replay", condition=condition)[0]
                self.assertEqual((replay["http_status"], replay["harness"]["writes"]), (200, 0))

    def test_credit_decisions_reach_only_the_requester(self):
        """credits.decide approve/counter/deny/moot/dry, cold and warm: a
        decision is user mail to the requester (plus the grant notice when
        the grant changes) and one ping; moot and dry send nothing."""
        cases = {"credits.decide": ("f-top", True, True), "credits.decide:counter": ("f-top", True, True),
                 "credits.decide:deny": ("f-top2", True, False),
                 "credits.decide:moot": ("f-top2", False, False),
                 "credits.decide:dry": ("f-top", False, False)}
        for variant, (node, mailed, granted) in cases.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract="credits.decide", variant=variant,
                                  condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    agents = r["agents"]
                    self.assertEqual(agents["targets"], [node])
                    want = ({"mail": {node: "target"}, "mail_log": {node: "target"}}
                            if mailed else {})
                    if granted:
                        want["notices"] = {node: "target"}
                    self.assertEqual(agents["logical"], want)
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    self.assertEqual(r["wakes"], {"send_message": int(mailed),
                                                  "mail_notify": int(mailed)})
        for condition in ("cold", "warm"):
            dry = self.rows(variant="credits.decide:dry", condition=condition)[0]
            self.assertEqual(dry["harness"]["writes"], 0)
        for variant, status in (("refusal:decide-dry-without-granted", 422),
                                ("refusal:decide-bad-action", 422),
                                ("refusal:decide-agent-token", 401),
                                ("refusal:decide-not-pending", 422)):
            r = self.rows(variant=variant)[0]
            self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0), variant)
        self.assertEqual(self.rows(variant="refusal:decide-agent-token")[0]["census"]["records"], 0)

    # -- P01 S3 F3b: staffing.hire, staffing.staff-create, staffing.staff-update ---
    STAFFING_CONTROL = "control:staffing-third-agent"
    #: variant -> (contract, new or rehired seat stem, started, sparked)
    STAFFING = {"staffing.hire": ("staffing.hire", "hs-plain", False, False),
                "staffing.hire:kickoff": ("staffing.hire", "hs-kickoff", True, True),
                "staffing.hire:target": ("staffing.hire", "hs-target", False, False),
                "staffing.hire:superior": ("staffing.hire", "hs-superior", False, False),
                "staffing.hire:audiences": ("staffing.hire", "hs-audiences", True, False),
                "staffing.hire:work-item": ("staffing.hire", "hs-work-item", True, True),
                "staffing.staff-create": ("staffing.staff-create", "ss-create", True, True),
                "staffing.staff-update": ("staffing.staff-update", "ss-update", True, True),
                "staffing.staff-create:rehire": ("staffing.staff-create", "s-gone", True, True)}

    def test_staffing_by_class_reaches_only_the_declared_set(self):
        """staffing.reads/instrumentation: hire by class and staff by mode,
        cold and warm, loss-accounted. Locality: nothing outside the caller,
        the destination chain, the new seat, a moved item's previous owner
        AND the new seat's parent and peers (a hire tells every peer:
        ledger.hire lifecycle.hired, not named by P01's clause) is written."""
        for variant, (contract, stem, started, sparked) in self.STAFFING.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract=contract, variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    agents = r["agents"]
                    self.assertIn(f"{stem}-{condition}", agents["targets"])
                    roles = {role for sect in agents["logical"].values() for role in sect.values()}
                    self.assertLessEqual(roles, {"actor", "target"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    self.assertEqual(r["wakes"], {"send_message": int(started),
                                                  "mail_notify": int(sparked)})
        # the peer fan-out: warm, s-mid's earlier reports are told of the new peer
        warm = self.rows(variant="staffing.hire", condition="warm")[0]["agents"]["logical"]
        self.assertIn("hs-plain-cold", warm["notices"])
        # a superior insertion also tells the anchor's own reports
        sup = self.rows(variant="staffing.hire:superior", condition="warm")[0]["agents"]["logical"]
        self.assertIn("hs-plain-cold", sup["notices"])
        # staff update tells the item's previous owner
        for condition in ("cold", "warm"):
            upd = self.rows(variant="staffing.staff-update", condition=condition)[0]
            self.assertEqual(upd["agents"]["logical"]["mail"].get("s-mid"), "target")
        def primary_written(r):
            return r["harness"]["stores"].get("primary", {}).get("tables_written", [])
        for variant in ("refusal:hire-outside-subtree", "refusal:hire-no-credits",
                        "refusal:hire-unknown-tier", "refusal:staff-bad-action",
                        "refusal:staff-no-title"):
            r = self.rows(variant=variant)[0]
            self.assertEqual((r["http_status"], primary_written(r)), (422, []), variant)
        for contract in ("staffing.hire", "staffing.staff-create"):
            for condition in ("cold", "warm"):
                fresh = self.rows(variant=f"{contract}:keyed-fresh", condition=condition)[0]
                replay = self.rows(variant=f"{contract}:keyed-replay", condition=condition)[0]
                self.assertEqual(fresh["http_status"], 200, fresh["detail"])
                self.assertEqual((replay["http_status"], primary_written(replay),
                                  sum(replay["wakes"].values())), (200, [], 0))

    def test_managed_wait_calls_journal_in_the_tool_waits_sidecar(self):
        """hire, staff, rehire, retire, dissolve and cheap_compact are
        managed-wait tools (mcptool.MANAGED_WAIT_TOOLS): EVERY call, refused
        or replayed too, journals in the tool_waits sidecar, re-running its
        DDL outside a transaction. No other row touches that sidecar."""
        seen = set()
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                managed = r["tool"] in MANAGED_WAIT
                self.assertEqual("tool_waits" in r["harness"]["sidecars_touched"], managed)
                if managed:
                    seen.add(r["tool"])
                    self.assertEqual(r["harness"]["sidecars_touched"], {"tool_waits": "write"})
                    tw = r["harness"]["stores"]["tool_waits"]
                    self.assertEqual(tw["kinds"].get("ddl"), 8)
                    self.assertEqual(set(tw["tables_written"]), {"dead_letters", "operations"})
        self.assertEqual(seen, MANAGED_WAIT)

    def test_staffing_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.STAFFING_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"s-sib": "third", "hs-control-warm": "target"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertTrue(agents["third_sites"])

    # -- P01 S3 F3c: operator.hire, operator.reallocate (the operator ops door) --
    OPERATOR_CONTROL = "control:operator-third-agent"
    #: variant -> (contract, new seat stem or None)
    OPERATOR = {"operator.hire": ("operator.hire", "oh-top"),
                "operator.hire:under": ("operator.hire", "oh-under"),
                "operator.hire:above": ("operator.hire", "oh-above"),
                "operator.reallocate": ("operator.reallocate", None),
                "operator.reallocate:down": ("operator.reallocate", None),
                "operator.reallocate:top-level": ("operator.reallocate", None)}

    def test_operator_ops_by_class_reach_only_the_declared_set(self):
        """operator-ops.reads/instrumentation: operator hire (top level, under
        a parent, above) and reallocate (up, down, top level), cold and warm,
        loss-accounted, as @user. Locality: nothing outside the target, its
        chain, and the new seat's parent and peers is touched; the door drives
        nobody and sparks nothing."""
        for variant, (contract, stem) in self.OPERATOR.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(contract=contract, variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    agents = r["agents"]
                    self.assertEqual(agents["actor"], "@user")
                    if stem:
                        self.assertIn(f"{stem}-{condition}", agents["targets"])
                    roles = {role for sect in agents["logical"].values() for role in sect.values()}
                    self.assertEqual(roles, {"target"})
                    self.assertEqual(set(agents["logical"]), {"notices"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    self.assertFalse(agents["third_sites"])
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
        # a top-level hire tells EVERY live top-level seat (its peers)
        top = self.rows(variant="operator.hire", condition="warm")[0]["agents"]["logical"]
        self.assertEqual(set(top["notices"]), {"oh-top-cold", "op-top", "op-top2"})
        # an above-hire also tells the anchor's own reports
        above = self.rows(variant="operator.hire:above", condition="cold")[0]["agents"]["logical"]
        self.assertIn("op-kid", above["notices"])
        # a raise bubbles up the chain: the up rows WRITE the grandparent's row
        # (declared: the target's chain), the down rows do not
        for condition in ("cold", "warm"):
            up = self.rows(variant="operator.reallocate", condition=condition)[0]["agents"]
            self.assertEqual(up["physical_nodes"].get("oh-above-cold"), "target")
            # every link of the chain is WRITTEN, the grandparent included
            self.assertLessEqual({"op-mid", "oh-above-warm", "oh-above-cold"},
                                 set(up["physical_written"]))
            down = self.rows(variant="operator.reallocate:down", condition=condition)[0]["agents"]
            self.assertNotIn("oh-above-cold", down["physical_nodes"])
            self.assertNotIn("oh-above-cold", down["physical_written"])
        frac = self.rows(variant="operator.reallocate:fractional")[0]
        self.assertEqual((frac["http_status"], frac["agents"]["third_agent_rows_written"]), (200, 0))

    def test_operator_ops_refusals_write_nothing(self):
        def primary_written(r):
            return r["harness"]["stores"].get("primary", {}).get("tables_written", [])
        for variant, status in (("refusal:op-hire-no-name", 422),
                                ("refusal:op-hire-unknown-tier", 422),
                                ("refusal:op-hire-above-not-a-report", 422),
                                ("refusal:op-hire-agent-token", 401),
                                ("refusal:op-reallocate-no-delta", 422),
                                ("refusal:op-reallocate-committed-floor", 422),
                                ("refusal:op-reallocate-no-authority", 422)):
            with self.subTest(variant=variant):
                r = self.rows(variant=variant)[0]
                self.assertEqual((r["http_status"], primary_written(r), r["harness"]["writes"]),
                                 (status, [], 0))
                self.assertEqual(r["agents"]["logical"], {})
        # the agent credential is refused before any attempt is recorded
        self.assertEqual(self.rows(variant="refusal:op-hire-agent-token")[0]["census"]["records"], 0)
        self.assertEqual(self.rows(variant="refusal:op-reallocate-no-authority")[0]["agents"]["actor"],
                         "op-mid")

    def test_operator_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.OPERATOR_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"op-sib": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertTrue(agents["third_sites"])

    # -- P01 S3 F3d: quick-staff (the staffing chooser) --------------------------
    QS_CONTROL = "control:quick-staff-third-agent"
    #: select variant -> (new seat stem or None, mail_notify sparks)
    QS_SELECT = {"quick-staff.select": (None, 1),
                 "quick-staff.select:under-assignee": ("qs-under", 2),
                 "quick-staff.select:top-level": ("qs-top", 2)}

    def test_quick_staff_by_mode_reaches_only_the_declared_set(self):
        """quick-staff.reads/instrumentation: staffing-options and its refresh,
        the preview in each mode and the commit in each mode with its replay,
        cold and warm, loss-accounted. Reads write nothing; a commit writes
        only the assignee's row and, immediate, the new seat's; nothing
        outside the assignee, the new seat and its parent and live peers is
        told (the hire's deliberate peer fan-out)."""
        def primary_written(r):
            return r["harness"]["stores"].get("primary", {}).get("tables_written", [])
        reads = ["quick-staff.options", "quick-staff.options-refresh", "quick-staff.preview",
                 "quick-staff.preview:under-assignee", "quick-staff.preview:top-level"]
        reads += [f"{v}:replay" for v in self.QS_SELECT]
        for condition in ("cold", "warm"):
            for variant in reads:
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertEqual((primary_written(r), r["harness"]["writes"],
                                      r["agents"]["logical"], r["agents"]["physical_written"]),
                                     ([], 0, {}, []))
                    # a replay is answered from the ticket's receipt: a 200 with
                    # no write, no mail and no wake (a re-run would post again)
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
            for variant, (stem, sparks) in self.QS_SELECT.items():
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    agents = r["agents"]
                    seat = {f"{stem}-{condition}"} if stem else set()
                    self.assertEqual(set(agents["physical_written"]), {"qs-mgr"} | seat)
                    roles = {role for sect in agents["logical"].values() for role in sect.values()}
                    self.assertEqual(roles, {"target"})
                    self.assertEqual((agents["third_agent_mail"],
                                      agents["third_agent_rows_written"]), (0, 0))
                    self.assertFalse(agents["third_sites"])
                    self.assertEqual(r["wakes"], {"send_message": 1, "mail_notify": sparks})
                    self.assertEqual(set(agents["logical"]["mail"]), {"qs-mgr"} | seat)
        # the immediate modes' peer fan-out: under the assignee its report
        # qs-kid is told; at the top level every live top-level seat is
        under = self.rows(variant="quick-staff.select:under-assignee", condition="cold")[0]
        self.assertIn("qs-kid", under["agents"]["logical"]["notices"])
        top = self.rows(variant="quick-staff.select:top-level", condition="cold")[0]
        self.assertIn("qs-other", top["agents"]["logical"]["notices"])
        # the refresh never touches an org store
        for condition in ("cold", "warm"):
            refresh = self.rows(variant="quick-staff.options-refresh", condition=condition)[0]
            self.assertEqual(refresh["census"]["statements"], 0)
        # warm, every read and replay is served from the resident document: no
        # statement at all; cold, the options read and the previews do read
        for variant in reads:
            with self.subTest(variant=variant):
                warm = self.rows(variant=variant, condition="warm")[0]
                self.assertEqual((warm["census"]["statements"], len(warm["harness"]["stores"])),
                                 (0, 0))
        for variant in ("quick-staff.options", "quick-staff.preview"):
            self.assertGreater(self.rows(variant=variant, condition="cold")[0]
                               ["census"]["statements"], 0)

    def test_quick_staff_refusals_write_nothing(self):
        for variant, status in (("refusal:qs-options-agent-token", 401),
                                ("refusal:qs-stale-selection", 422),
                                ("refusal:qs-effort-without-tier", 422),
                                ("refusal:qs-account-in-request-mode", 422),
                                ("refusal:qs-agent-token", 401),
                                ("refusal:qs-immediate-without-tier", 422),
                                ("refusal:qs-preview-not-backlogged", 422)):
            with self.subTest(variant=variant):
                r = self.rows(variant=variant)[0]
                self.assertEqual((r["http_status"], r["harness"]["writes"], r["agents"]["logical"],
                                  sum(r["wakes"].values())), (status, 0, {}, 0))
                self.assertEqual(r["census"]["records"], 0 if status == 401 else 1)

    def test_quick_staff_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.QS_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"qs-kid": "third", "qs-mgr": "target"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertTrue(agents["third_sites"])

    # -- P01 S3 F4: work-read (the operator's docket reads) and receipt-lookup ---
    WORK_READS = ["work.item-list", "work.item-list:archived", "work.item-list:backlogged",
                  "work.item-list:compact", "work.item-get", "work.item-get:compact"]

    def test_work_reads_touch_only_this_orgs_records(self):
        """work-read.reads/instrumentation: the list (plain, archived,
        backlogged, compact) and the item read, cold and warm, loss-
        accounted; org-level locality: every statement runs on THIS org's
        store, nothing is written, nobody is told or woken."""
        for variant in self.WORK_READS:
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertGreater(r["census"]["statements"], 0)
                    self.assertEqual(set(r["harness"]["statement_stores"]), {"data:org-db:own"})
                    self.assertEqual((r["harness"]["writes"], r["agents"]["logical"],
                                      r["agents"]["physical_written"], r["guard_refusals"]),
                                     (0, {}, [], {}))
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
        for variant, status in (("refusal:wr-unknown-item", 404),
                                ("refusal:wr-list-agent-token", 401),
                                ("refusal:wr-get-agent-token", 401),
                                ("refusal:wr-legacy-identity", 409)):
            with self.subTest(variant=variant):
                r = self.rows(variant=variant)[0]
                self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
                self.assertEqual(r["census"]["records"], 0 if status == 401 else 1)
        # the org-level control: the other org's store shows as foreign
        control = self.rows(variant="control:work-read-foreign-org")[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        self.assertGreater(control["harness"]["statement_stores"].get("data:org-db:foreign", 0), 0)

    RL_CONTROL = "control:receipt-lookup-third-agent"
    #: variant -> (answer state, receipt rows added per agent)
    LOOKUPS = {"receipt.lookup:not-applied": ("not_applied", {"rl-top": 1}),
               "receipt.lookup:fenced-again": ("not_applied", {}),
               "receipt.lookup:applied": ("applied", {}),
               "receipt.lookup:conflict": ("conflict", {}),
               "receipt.lookup:epoch-rotated": ("unknown", {})}

    def test_receipt_lookups_stay_in_the_callers_namespace(self):
        """receipt-lookup.reads/instrumentation: each answer (not_applied with
        a fence, applied, conflict, epoch-rotated) and a lookup answered from
        the fence, cold and warm, loss-accounted; agent-level locality: the
        only receipt rows written are the caller's own fence, and no other
        agent's row is read or written."""
        for variant, (state, namespace) in self.LOOKUPS.items():
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.rows(variant=variant, condition=condition)[0]
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertEqual(r["answer"]["state"], state)
                    self.assertEqual(r["receipt_namespace"], namespace)
                    agents = r["agents"]
                    self.assertLessEqual(set(agents["physical_nodes"]), {"rl-top"})
                    self.assertEqual((agents["logical"], agents["third_sites"]), ({}, {}))
                    self.assertEqual(r["wakes"], {"send_message": 0, "mail_notify": 0})
                    if state != "not_applied" or namespace == {}:
                        self.assertEqual(r["harness"]["writes"], 0)
        rotated = self.rows(variant="receipt.lookup:epoch-rotated", condition="cold")[0]
        self.assertEqual((rotated["answer"]["reason"], rotated["answer"]["fenced"]),
                         ("epoch_rotated", False))
        # another agent asking about rl-top's key fences it in ITS OWN namespace
        other = self.rows(variant="receipt.lookup:other-agents-key")[0]
        self.assertEqual((other["answer"]["state"], other["receipt_namespace"]),
                         ("not_applied", {"rl-mid": 1}))
        self.assertLessEqual(set(other["agents"]["physical_nodes"]), {"rl-mid"})
        for variant, status in (("refusal:rl-halted", 409), ("refusal:rl-no-key", 422),
                                ("refusal:rl-no-tool", 422), ("refusal:rl-bad-token", 401)):
            with self.subTest(variant=variant):
                r = self.rows(variant=variant)[0]
                self.assertEqual((r["http_status"], r["harness"]["writes"]), (status, 0))
                self.assertEqual(r["census"]["records"], 0 if status == 401 else 1)
        self.assertEqual(self.rows(variant="refusal:rl-halted")[0]["receipt_namespace"], {})

    def test_receipt_lookup_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.RL_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"rl-sib": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertTrue(agents["third_sites"])

    def test_funding_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.FUNDING_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"f-sib": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)

    # -- P01 F1: the org lifecycle and catalogue entry points ---------------------
    LC_CONTROL = "control:lifecycle-third-agent"
    #: contract -> (the variant run cold and warm, its status, the cell roles it
    #: tells). A cell is `lc-<cell>-<cond>-<role>` (tools/p02_operation_contacts.py
    #: build_lifecycle). The last three have no synthetic success path: refusal rows.
    LC_MAIN = {
        "lifecycle.rename": ("rename", "lifecycle.rename", 200, ("k2",)),
        "lifecycle.retool": ("retool", "lifecycle.retool", 200, ("k",)),
        "lifecycle.retire": ("retire", "lifecycle.retire", 200, ()),
        "lifecycle.dissolve": ("dissolve", "lifecycle.dissolve", 200, ("s",)),
        "lifecycle.cheap-compact": ("cc", "lifecycle.cheap-compact", 200, ("m",)),
        "lifecycle.rehire": ("rehire", "lifecycle.rehire", 200, ("k",)),
        "lifecycle.move": ("move", "lifecycle.move", 200, ("k", "m", "s")),
        "lifecycle.swap": ("swap", "lifecycle.swap", 200, ("k", "m", "s")),
        "lifecycle.self-subjugate": ("subj", "lifecycle.self-subjugate", 200, ("k", "p", "s")),
        "lifecycle.switch-model": ("switch", "lifecycle.switch-model", 200, ("k",)),
        "catalogue.list-orgs": (None, "catalogue.list-orgs", 200, ()),
        "catalogue.list-tiers": (None, "catalogue.list-tiers", 200, ()),
        "lifecycle.reorder": ("reorder", "lifecycle.reorder", 200, ()),
        "lifecycle.compact": ("compact", "lifecycle.compact", 200, ()),
        "lifecycle.repair-rename": ("repair", "lifecycle.repair-rename", 200, ()),
        "lifecycle.dissolve-all": (None, "lifecycle.dissolve-all", 200, ()),
        "lifecycle.account-assign": (None, "refusal:account-unknown", 422, ()),
        "lifecycle.lineage-recover": (None, "refusal:lineage-not-lost", 422, ()),
        "lifecycle.lineage-drop-phantom": (None, "refusal:lineage-not-phantom", 422, ()),
    }

    def lc_rows(self):
        return [r for r in self.doc["rows"] if r["contract"].startswith(("lifecycle.", "catalogue."))
                and r["contract"] != "lifecycle.operator-scope" and r["variant"] != self.LC_CONTROL]

    def test_lifecycle_contracts_run_cold_and_warm_and_tell_the_pinned_set(self):
        """lifecycle.instrumentation: every F1 contract, cold and warm,
        loss-accounted (one census record whose statements the harness
        matches). Who is told is P01's pinned `told`, per cell role."""
        for contract, (cell, variant, status, told) in self.LC_MAIN.items():
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    [r] = self.rows(contract=contract, variant=variant, condition=condition)
                    self.assertEqual(r["http_status"], status, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertIs(r["harness"]["matches_census"], True)
                    notices = set(r["agents"]["logical"].get("notices", {}))
                    if contract == "lifecycle.dissolve-all":
                        # recorded legacy: the later top-level seat is told that an
                        # earlier one was dissolved, then dissolved in the same save
                        self.assertEqual(notices, {f"da-{condition}-top2"})
                    else:
                        self.assertEqual(notices, {f"lc-{cell}-{condition}-{role}" for role in told})

    def test_lifecycle_rows_reach_only_the_declared_set(self):
        """No F1 row writes an agent outside its actor, its named targets and
        what it declares (a new name, a bearer, the subtree it archives, the
        agents it tells), tells an undeclared agent, or touches lc-third. A
        third agent's row is only ever READ, at the carry-over read of the row
        the previous operation changed (api._agent_identity, halt)."""
        rows = self.lc_rows()
        self.assertGreater(len(rows), 60)
        for r in rows:
            agents = r["agents"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]),
                                 (0, 0))
                self.assertLessEqual(set(agents["physical_written"]),
                                     {agents["actor"]} | set(agents["targets"]))
                roles = {role for sect in agents["logical"].values() for role in sect.values()}
                self.assertLessEqual(roles, {"actor", "target"})
                self.assertNotIn("lc-third", agents["physical_nodes"])
                self.assertFalse([s for s in agents["third_sites"] if ":read@" not in s])
                self.assertEqual(r["wakes"]["send_message"],
                                 int(r["variant"] == "lifecycle.rehire:mail"))
        # a warm row re-reads the rows the previous operation changed
        self.assertTrue([r for r in rows if r["agents"]["third_sites"]])

    def test_lifecycle_effects_and_pinned_legacy_behaviour(self):
        def one(variant, condition="warm"):
            [r] = self.rows(variant=variant, condition=condition)
            return r

        def primary_written(r):
            return r["harness"]["stores"].get("primary", {}).get("tables_written", [])
        for condition in ("cold", "warm"):
            # rename broadcasts through notify only: no hub_changed, and no
            # remote reap although the post-save reap names rename (legacy)
            self.assertEqual(one("lifecycle.rename", condition)["spies"], {"notify": 1})
            self.assertEqual(one("lifecycle.retire", condition)["spies"],
                             {"hub_changed": 1, "interrupt_before_archive": 1, "remote_reap": 1})
            self.assertEqual(one("lifecycle.cheap-compact", condition)["spies"].get(
                "export_predecessor_transcript"), 1)
            compact = one("lifecycle.compact", condition)
            self.assertEqual((compact["spies"], compact["harness"]["writes"]),
                             ({"manual_compact": 1}, 0))
            # a read that takes the write lock and broadcasts, writing nothing
            listed = one("catalogue.list-orgs", condition)
            self.assertEqual((listed["spies"], primary_written(listed)), ({"hub_changed": 1}, []))
            everyone = one("lifecycle.dissolve-all", condition)
            self.assertEqual(set(everyone["agents"]["physical_written"]),
                             {f"da-{condition}-{n}" for n in ("top", "kid", "top2")})
        # the interrupt runs before the refusal of a self-retire with live
        # reports and of a malformed key; the authority pre-guard refuses first
        self.assertEqual(one("refusal:retire-self-with-reports")["spies"],
                         {"interrupt_before_archive": 1})
        self.assertEqual(one("refusal:retire-keyed-malformed-key")["spies"],
                         {"interrupt_before_archive": 1})
        self.assertEqual(one("refusal:retire-no-authority")["spies"], {})
        # a same-parent move by an unrelated caller: accepted, writes nothing,
        # still broadcasts (lifecycle-tool-receipts-and-admission-keyed-rena #6)
        noop = one("lifecycle.move:noop-unrelated-caller")
        self.assertEqual((noop["http_status"], noop["agents"]["actor"], noop["harness"]["writes"],
                          noop["spies"]), (200, "lc-top2", 0, {"hub_changed": 1}))
        # a keyed rename skips admission: a malformed key is executed, and it
        # writes no `meta` row where the keyed move's receipt goes (observed)
        keyed = one("lifecycle.rename:keyed-malformed-key")
        self.assertEqual(keyed["http_status"], 200, keyed["detail"])
        self.assertNotIn("meta", primary_written(keyed))
        self.assertIn("meta", primary_written(one("lifecycle.move:keyed-fresh")))
        replay = one("lifecycle.move:keyed-replay")
        self.assertEqual((replay["http_status"], replay["harness"]["writes"], replay["spies"]),
                         (200, 0, {}))
        self.assertEqual(one("lifecycle.rehire:live")["agents"]["physical_written"], [])
        # already on the tier: no write, still a broadcast
        same = one("lifecycle.switch-model:no-op")
        self.assertEqual((same["http_status"], same["harness"]["writes"], same["spies"]),
                         (200, 0, {"hub_changed": 1}))

    def test_lifecycle_refusals_write_nothing_to_the_org(self):
        refusals = [r for r in self.lc_rows() if r["variant"].startswith("refusal:")]
        # 3 refusal-only contracts x cold/warm, 14 tool refusals, the keyed
        # malformed retire and 4 route refusals
        self.assertEqual(len(refusals), 25)
        for r in refusals:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertGreaterEqual(r["http_status"], 400)
                self.assertEqual(r["harness"]["stores"].get("primary", {}).get("tables_written", []),
                                 [])
                self.assertEqual(r["agents"]["logical"], {})
        # the agent credential is refused before any attempt is recorded
        self.assertEqual(self.rows(variant="refusal:route-agent-token")[0]["census"]["records"], 0)

    def test_list_orgs_reads_every_orgs_store(self):
        for condition in ("cold", "warm"):
            [r] = self.rows(variant="catalogue.list-orgs", condition=condition)
            self.assertIn(self.F_STMT, r["expected_unknown"])
            self.assertGreater(r["harness"]["statement_stores"].get("data:org-db:foreign", 0), 0)
            self.assertEqual(set(r["harness"]["foreign_statement_sites"]),
                             {"orgtree.store:_load_lazy", "orgtree.store:_meta_get"})

    def test_lifecycle_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.LC_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"lc-third": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertIn("lc-third", agents["physical_written"])

    # -- P01 F1b: the operator ops door's remaining operations and its preview -----
    VX_CONTROL = "control:op-variants-third-agent"
    #: contract -> (cell, the cell roles P01 pins as told). A cell is
    #: `vx-<cell>-<cond>-<role>` (build_opvariants); promote also tells every
    #: live top-level seat
    VX_MAIN = {
        "operator.rename": ("rename", ("k2",)),
        "operator.retire": ("retire", ("m",)),
        "operator.rescind": ("rescind", ("m",)),
        "operator.cheap-compact": ("cc", ("m", "p")),
        "operator.rehire": ("rehire", ("k", "m")),
        "operator.dissolve": ("dissolve", ("p", "s")),
        "operator.delete": ("delete", ("m",)),
        "operator.switch-model": ("switch", ("k", "m")),
        "operator.promote": ("promote", ("k", "m")),
        "operator.demote": ("demote", ("k", "m", "p", "s")),
        "operator.move": ("move", ("k", "m", "s")),
        "operator.reseed": ("reseed", ("m", "p")),
        "operator.revoke-dir": ("revoke", ()),
        "operator.preview": ("preview", ()),
    }

    def vx_rows(self):
        return [r for r in self.doc["rows"] if r["contract"] in self.VX_MAIN
                and r["variant"] != self.VX_CONTROL]

    def test_op_variants_run_cold_and_warm_and_tell_the_pinned_set(self):
        """operator-ops.variant-instrumentation: every F1b operation and the
        preview, cold and warm, as @user, loss-accounted. Who is told is
        P01's pinned `told`, per cell role."""
        for contract, (cell, told) in self.VX_MAIN.items():
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    [r] = self.rows(contract=contract, variant=contract, condition=condition)
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertIs(r["harness"]["matches_census"], True)
                    self.assertEqual(r["agents"]["actor"], "@user")
                    want = {f"vx-{cell}-{condition}-{role}" for role in told}
                    if contract == "operator.promote":
                        # the new top-level peers: the cold row's promoted seat
                        # is one of them by the warm row
                        want |= {"vx-top", "vx-top2"} | (
                            {"vx-promote-cold-k"} if condition == "warm" else set())
                    self.assertEqual(set(r["agents"]["logical"].get("notices", {})), want)

    def test_op_variants_reach_only_the_declared_set(self):
        """No F1b row writes an agent outside the actor, its named targets and
        what it declares, tells an undeclared agent, or touches vx-third; a
        third agent's row is only ever read (the carry-over read)."""
        rows = self.vx_rows()
        self.assertGreater(len(rows), 45)
        for r in rows:
            agents = r["agents"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]),
                                 (0, 0))
                self.assertLessEqual(set(agents["physical_written"]),
                                     {agents["actor"]} | set(agents["targets"]))
                roles = {role for sect in agents["logical"].values() for role in sect.values()}
                self.assertLessEqual(roles, {"actor", "target"})
                self.assertNotIn("vx-third", agents["physical_nodes"])
                self.assertFalse([s for s in agents["third_sites"] if ":read@" not in s])
                self.assertEqual(r["wakes"]["send_message"],
                                 int(r["variant"] == "operator.rehire:mail"))

    def test_op_variants_effects_and_pinned_legacy_behaviour(self):
        def one(variant, condition="warm"):
            [r] = self.rows(variant=variant, condition=condition)
            return r
        archive = {"hub_changed": 1, "interrupt_before_archive": 1, "remote_reap": 1}
        for condition in ("cold", "warm"):
            # the operator door's rename reaps and broadcasts; the agent door's
            # does neither
            self.assertEqual(one("operator.rename", condition)["spies"],
                             {"hub_changed": 1, "notify": 1, "remote_reap": 1})
            for variant in ("operator.retire", "operator.dissolve", "operator.rescind"):
                self.assertEqual(one(variant, condition)["spies"], archive, variant)
            # delete takes no pre-archive interrupt
            self.assertEqual(one("operator.delete", condition)["spies"],
                             {"forget": 1, "hub_changed": 1, "remote_reap": 1})
            # a promotion to the top level releases the seat up the WHOLE old
            # chain (ledger._move's LCA credit path): the old grandparent's row
            # is written although P01's told set does not name it
            promote = one("operator.promote", condition)["agents"]
            self.assertLessEqual({f"vx-promote-{condition}-{n}" for n in ("k", "m", "p")}
                                 | {"vx-top"}, set(promote["physical_written"]))
            preview = one("operator.preview", condition)
            self.assertEqual((preview["harness"]["writes"], preview["spies"]), (0, {}))
            self.assertIsNotNone(preview["clone"])
        for variant in ("operator.preview:delete", "operator.preview:reallocate",
                        "operator.preview:switch-model", "operator.preview:retire-agent-actor"):
            r = one(variant)
            self.assertEqual((r["http_status"], r["harness"]["writes"], r["spies"]), (200, 0, {}),
                             variant)
            self.assertIsNotNone(r["clone"], variant)
        self.assertEqual(one("operator.preview:retire-agent-actor")["agents"]["actor"],
                         "vx-ref-warm-m")
        noop = one("operator.reseed:no-op")
        self.assertEqual((noop["http_status"], noop["harness"]["writes"], noop["spies"]),
                         (200, 0, {"hub_changed": 1}))
        # refused after the pre-archive interrupt (the agent door's legacy
        # defect holds here too); the authority pre-guard refuses before it
        for variant in ("refusal:op-rescind-agent-actor", "refusal:op-retire-self-with-reports"):
            self.assertEqual(one(variant)["spies"], {"interrupt_before_archive": 1}, variant)
        self.assertEqual(one("refusal:op-retire-no-authority")["spies"], {})

    def test_op_variant_refusals_write_nothing(self):
        refusals = [r for r in self.vx_rows() if r["variant"].startswith("refusal:")]
        self.assertEqual(len(refusals), 16)
        for r in refusals:
            with self.subTest(variant=r["variant"]):
                self.assertGreaterEqual(r["http_status"], 400)
                self.assertEqual(r["harness"]["writes"], 0)
                self.assertEqual(r["agents"]["logical"], {})
        self.assertEqual(self.rows(variant="refusal:op-agent-token")[0]["census"]["records"], 0)

    def test_op_variants_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.VX_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"vx-third": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)
        self.assertIn("vx-third", agents["physical_written"])

    # -- P01 F3: asks, reports, scope requests, watchdogs, audiences -------------------
    RQ_CONTROL = "control:requests-third-agent"
    #: contract -> (cell, the cell roles P01 pins as mailed, as told). A cell is
    #: `rq-<cell>-<cond>-<role>` (build_requests)
    RQ_MAIN = {
        "asks.ask": ("ask", (), ()), "asks.withdraw": ("withdraw", (), ()),
        "asks.present": ("present", (), ()), "asks.submit-report": ("report", ("m",), ()),
        "asks.request-scope": ("scope", (), ()), "watchdogs.create": ("wdcreate", (), ()),
        "watchdogs.list": ("wdlist", (), ()), "watchdogs.pause": ("wdpause", (), ()),
        "watchdogs.resume": ("wdresume", (), ()), "watchdogs.remove": ("wdremove", (), ()),
        "watchdogs.supersede": ("wdsupersede", (), ()),
        "audiences.request": ("audreq", ("m",), ()), "audiences.forward": ("audfwd", ("p",), ()),
        "audiences.grant": ("audgrant", ("k",), ()), "audiences.deny": ("auddeny", ("k",), ()),
        "audiences.revoke": ("audrevoke", (), ("k",)), "asks.answer": ("answer", ("p",), ()),
        "asks.batch-resolve": ("batch", ("p",), ()),
        "lifecycle.operator-scope": ("opscope", (), ("k",)),
        "watchdogs.operator-action": ("wdop", (), ()),
        "audiences.operator-action": ("audop", (), ("k", "p")),
        "audiences.list": ("audlist", (), ()),
    }

    def rq_rows(self):
        return [r for r in self.doc["rows"] if r["contract"] in self.RQ_MAIN
                and r["variant"] != self.RQ_CONTROL]

    def test_requests_contracts_run_cold_and_warm_and_reach_the_pinned_parties(self):
        """asks/watchdogs/audiences.instrumentation and lifecycle.operator-scope:
        every F3 contract, cold and warm, loss-accounted; who is mailed and told
        is P01's pinned case, per cell role."""
        for contract, (cell, mailed, told) in self.RQ_MAIN.items():
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    [r] = self.rows(contract=contract, variant=contract, condition=condition)
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertIs(r["harness"]["matches_census"], True)
                    logical = r["agents"]["logical"]
                    self.assertEqual(set(logical.get("mail", {})),
                                     {f"rq-{cell}-{condition}-{x}" for x in mailed})
                    self.assertEqual(set(logical.get("notices", {})),
                                     {f"rq-{cell}-{condition}-{x}" for x in told})

    def test_requests_rows_reach_only_the_declared_set(self):
        rows = self.rq_rows()
        self.assertGreater(len(rows), 60)
        for r in rows:
            agents = r["agents"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]),
                                 (0, 0))
                self.assertLessEqual(set(agents["physical_written"]),
                                     {agents["actor"]} | set(agents["targets"]))
                roles = {role for sect in agents["logical"].values() for role in sect.values()}
                self.assertLessEqual(roles, {"actor", "target"})
                self.assertNotIn("rq-third", agents["physical_nodes"])
                self.assertFalse([s for s in agents["third_sites"] if ":read@" not in s])

    def test_requests_effects_and_pinned_legacy_behaviour(self):
        def one(variant, condition="warm"):
            [r] = self.rows(variant=variant, condition=condition)
            return r
        for condition in ("cold", "warm"):
            # a forwarded report mails the superior and drives nobody (legacy)
            self.assertEqual(one("asks.submit-report", condition)["wakes"]["send_message"], 0)
            # the operator audience grant tells both by notice, posts no mail,
            # and still drives the grantee (legacy)
            grant = one("audiences.operator-action", condition)
            self.assertEqual((grant["wakes"]["send_message"], "mail" in grant["agents"]["logical"]),
                             (1, False))
            # an answer drives the asker once and sparks the user's mail notify
            self.assertEqual(one("asks.answer", condition)["wakes"],
                             {"send_message": 1, "mail_notify": 1})
            self.assertEqual(one("watchdogs.create", condition)["spies"],
                             {"hub_changed": 1, "wd_smoke": 1})
            # the operator scope route broadcasts nothing itself
            self.assertEqual(one("lifecycle.operator-scope", condition)["spies"], {})
            # a list is a read that goes through the write cycle and broadcasts
            listed = one("watchdogs.list", condition)
            self.assertEqual((listed["spies"],
                              listed["harness"]["stores"]["primary"]["tables_written"]),
                             ({"hub_changed": 1}, []))
        # a routed ask and scope request mail and drive the superior once
        for variant in ("asks.ask:routed", "asks.request-scope:routed"):
            r = one(variant)
            self.assertEqual((set(r["agents"]["logical"]["mail"]), r["wakes"]["send_message"]),
                             ({"rq-routed-warm-m"}, 1), variant)
        # a keyed list files a receipt (meta); its replay writes nothing to the org
        self.assertIn("meta", one("watchdogs.list:keyed-fresh")["harness"]["stores"]["primary"]
                      ["tables_written"])
        self.assertEqual(one("watchdogs.list:keyed-replay")["harness"]["stores"]["primary"]
                         ["tables_written"], [])
        for variant in ("asks.withdraw:no-open-ask", "audiences.request:already-reachable"):
            r = one(variant)
            self.assertEqual((r["http_status"], r["harness"]["writes"], r["spies"]),
                             (200, 0, {"hub_changed": 1}), variant)

    def test_requests_refusals_write_nothing_to_the_org(self):
        refusals = [r for r in self.rq_rows() if r["variant"].startswith("refusal:")]
        self.assertEqual(len(refusals), 17)
        for r in refusals:
            with self.subTest(variant=r["variant"]):
                self.assertGreaterEqual(r["http_status"], 400)
                self.assertEqual(r["harness"]["stores"].get("primary", {}).get("tables_written", []),
                                 [])
                self.assertEqual(r["agents"]["logical"], {})
        self.assertEqual(self.rows(variant="refusal:aud-list-agent-token")[0]["census"]["records"], 0)

    def test_requests_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.RQ_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"rq-third": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)

    # -- P01 F2: run control, per product profile ------------------------------------
    CT_CONTROL = "control:control-third-agent"
    #: contract -> (cell, the variant run cold and warm, its status, the cell roles
    #: told). A cell is `ct-<cell>-<cond>-<role>` (build_control); None: the
    #: killswitch orgs
    CT_MAIN = {
        "control.interrupt": ("interrupt", "control.interrupt", 200, ()),
        "control.unstick": ("unstick", "control.unstick", 200, ("m",)),
        "control.continue-on": ("continue", "control.continue-on", 200, ()),
        "control.halt": ("halt", "control.halt", 200, ()),
        "control.unhalt": ("unhalt", "control.unhalt", 200, ()),
        "control.restart-wake-arm": ("wake", "control.restart-wake-arm", 200, ()),
        "control.restart-wake-status": ("wake", "control.restart-wake-status", 200, ()),
        "control.restart-wake-cancel": ("wake", "control.restart-wake-cancel", 200, ()),
        "control.self-restart": ("restart", "control.self-restart:non-desktop", 200, ()),
        "control.prime-restart-arm": ("prime", "control.prime-restart-arm:non-desktop", 200, ()),
        "control.prime-restart-status": ("prime", "control.prime-restart-status:non-desktop", 200,
                                         ()),
        "control.prime-restart-cancel": ("prime", "control.prime-restart-cancel:non-desktop", 200,
                                         ()),
        "control.op-interrupt": ("opinterrupt", "control.op-interrupt", 200, ()),
        "control.op-unstick": ("opunstick", "control.op-unstick", 200, ("m",)),
        "control.op-continue-on": ("opcontinue", "control.op-continue-on", 200, ()),
        "control.op-halt": ("ophalt", "control.op-halt", 200, ()),
        "control.op-unhalt": ("opunhalt", "control.op-unhalt", 200, ()),
        "control.op-process": ("opprocess", "control.op-process", 200, ()),
        "control.remote-control": ("remote", "control.remote-control", 200, ()),
        "control.steer-claim": ("steer", "control.steer-claim", 200, ()),
        "control.steer-ack": ("steer", "control.steer-ack", 200, ()),
        "control.steer-state": ("steer", "control.steer-state", 200, ()),
        "control.kiosk": ("kiosk", "control.kiosk:desktop-stripped", 404, ()),
        "control.killswitch": (None, "control.killswitch", 200, ()),
        "control.killswitch-release": (None, "control.killswitch-release", 200, ()),
        "control.resume": (None, "control.resume", 200, ()),
    }
    #: the warm rows whose saves re-write a log_d row naming the manager the
    #: agent door unhalted earlier (an empty steer_attempts entry that
    #: scan_steer_records set on the shared document), up to the operator unhalt
    CT_UNHALT_CARRY = {"control.restart-wake-arm", "control.restart-wake-status",
                       "control.restart-wake-cancel", "control.self-restart:non-desktop",
                       "control.prime-restart-arm:non-desktop",
                       "control.prime-restart-status:non-desktop",
                       "control.prime-restart-cancel:non-desktop", "control.op-unstick",
                       "control.op-halt", "control.op-unhalt"}

    def ct_rows(self):
        return [r for r in self.doc["rows"] if r["contract"] in self.CT_MAIN
                and r["variant"] != self.CT_CONTROL]

    def test_control_contracts_run_cold_and_warm_per_profile(self):
        """control.instrumentation: every F2 contract, cold and warm,
        loss-accounted; the restart tools in BOTH profiles (refused on the
        desktop, served otherwise); the kiosk route stripped on the desktop."""
        for contract, (cell, variant, status, told) in self.CT_MAIN.items():
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    [r] = self.rows(contract=contract, variant=variant, condition=condition)
                    self.assertEqual(r["http_status"], status, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertIs(r["harness"]["matches_census"], True)
                    self.assertEqual(set(r["agents"]["logical"].get("notices", {})),
                                     {f"ct-{cell}-{condition}-{x}" for x in told})
                    if variant.endswith(":non-desktop"):
                        self.assertIn("ORGTREE_DESKTOP_MANAGED", r["env"])
                        [desk] = self.rows(contract=contract,
                                           variant=variant.replace(":non-desktop", ":desktop"),
                                           condition=condition)
                        self.assertEqual(desk["http_status"], 422)
                        self.assertIn("desktop-managed V2 renamed", desk["detail"])
                        self.assertEqual((desk["spies"], desk["harness"]["writes"]), ({}, 0))
        # the kiosk route: stripped in the desktop profile (above), and the
        # non-desktop handler, mounted at its own path for these rows only,
        # configures a kiosk org, cold and warm, loss-accounted
        for condition in ("cold", "warm"):
            with self.subTest(kiosk=condition):
                [r] = self.rows(contract="control.kiosk", variant="control.kiosk:non-desktop",
                                condition=condition)
                self.assertEqual((r["http_status"], r["census"]["records"]), (200, 1), r["detail"])
                self.assertIs(r["harness"]["matches_census"], True)
                self.assertIn("ORGTREE_DESKTOP_MANAGED", r["env"])
                self.assertIn("doc", r["harness"]["stores"]["primary"]["tables_written"])
        [refused] = self.rows(variant="refusal:kiosk-not-a-kiosk-org")
        self.assertEqual(refused["http_status"], 422)
        self.assertIn("not a kiosk org", refused["detail"])
        self.assertIn("ORGTREE_DESKTOP_MANAGED", refused["env"])

    def test_control_rows_reach_only_the_declared_set(self):
        rows = self.ct_rows()
        self.assertGreater(len(rows), 70)
        carried = set()
        for r in rows:
            agents = r["agents"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(agents["third_agent_mail"], 0)
                written = set(agents["physical_written"]) - {agents["actor"]} - set(agents["targets"])
                third_writes = [s for s in agents["third_sites"] if ":write@" in s]
                if written:
                    # only the unhalt carry-over: log_d rows naming the manager
                    # the agent door unhalted, in the warm rows after it
                    self.assertEqual(written, {"ct-unhalt-warm-m"})
                    self.assertTrue(third_writes)
                    self.assertFalse([s for s in third_writes if not s.startswith("log_d:write@")])
                    self.assertEqual(r["condition"], "warm")
                    carried.add(r["variant"])
                else:
                    self.assertEqual(agents["third_agent_rows_written"], 0)
                    self.assertFalse(third_writes)
                roles = {role for sect in agents["logical"].values() for role in sect.values()}
                self.assertLessEqual(roles, {"actor", "target"})
                self.assertNotIn("ct-third", agents["physical_nodes"])
        self.assertEqual(carried, self.CT_UNHALT_CARRY)

    def test_control_effects_are_spies_and_pinned_behaviour(self):
        def one(variant, condition="warm"):
            [r] = self.rows(variant=variant, condition=condition)
            return r
        for condition in ("cold", "warm"):
            self.assertEqual(one("control.halt", condition)["spies"],
                             {"halt_cut": 1, "notify": 2})
            self.assertEqual(one("control.unhalt", condition)["spies"], {"notify": 1})
            self.assertEqual(one("control.interrupt", condition)["spies"],
                             {"hub_changed": 1, "interrupt_turn": 1})
            self.assertEqual(one("control.op-interrupt", condition)["spies"],
                             {"interrupt_turn": 1})
            self.assertEqual(one("control.killswitch", condition)["spies"], {"interrupt_all": 1})
            self.assertEqual(one("control.op-process", condition)["spies"], {"process_control": 1})
            self.assertEqual(one("control.continue-on", condition)["spies"],
                             {"continue_on_account": 1})
            self.assertEqual(one("control.self-restart:non-desktop", condition)["spies"],
                             {"hub_changed": 1, "launch_self_restart": 1})
            self.assertEqual(one("control.remote-control", condition)["spies"],
                             {"hub_changed": 1, "remote_control_start": 1})
        # a batch halt cuts every target before halting each
        batch = one("control.halt:batch")
        self.assertGreaterEqual(batch["spies"]["halt_cut"], 2)
        self.assertEqual(set(batch["agents"]["physical_written"]),
                         {"ct-batch-warm-m", "ct-batch-warm-s"})
        # one target outside the subtree refuses the whole batch; nothing is cut
        self.assertEqual(one("refusal:halt-batch-partly-outside")["spies"], {})
        for variant in ("control.unstick:no-op", "control.op-unhalt:not-halted",
                        "control.killswitch-release:not-latched"):
            self.assertEqual(one(variant)["harness"]["writes"], 0, variant)
        self.assertEqual(one("refusal:resume-while-latched")["http_status"], 409)

    def test_control_refusals_write_nothing_to_the_org(self):
        refusals = [r for r in self.ct_rows() if r["variant"].startswith("refusal:")]
        # 13 tool refusals, 3 route refusals, resume while latched, and the
        # non-desktop kiosk handler on an org that is not a kiosk
        self.assertEqual(len(refusals), 18)
        for r in refusals:
            with self.subTest(variant=r["variant"]):
                self.assertGreaterEqual(r["http_status"], 400)
                self.assertEqual(r["harness"]["stores"].get("primary", {}).get("tables_written", []),
                                 [])
                self.assertEqual(r["agents"]["logical"], {})
        [token] = self.rows(variant="refusal:route-agent-token", contract="control.killswitch")
        self.assertEqual(token["census"]["records"], 0)

    def test_control_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.CT_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"ct-third": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)

    # -- P01 F4: the exchange routes and tools --------------------------------------
    EX_CONTROL = "control:exchange-third-agent"
    EX_MAIN = ("exchange.orgs-list", "exchange.extern-send", "exchange.extern-read",
               "exchange.extern-wait", "exchange.org-inbox-list", "exchange.mail-item",
               "exchange.org-inbox-read", "exchange.org-inbox-upload", "exchange.org-inbox-send",
               "exchange.inbox-clear", "exchange.node-upload", "exchange.reply-events-count",
               "exchange.reply-events-clear", "exchange.mail-retract", "exchange.send-file")
    #: the rows that run statements on OTHER orgs' stores, as found: the org list
    #: and the external-chat scans (every org), and an @org: send (the other org)
    EX_FOREIGN = {"exchange.orgs-list", "exchange.extern-read", "exchange.extern-wait",
                  "exchange.extern-read:org-filter", "exchange.extern-wait:timeout",
                  "exchange.org-inbox-send:org", "exchange.org-inbox-send:org-kiosk",
                  "exchange.org-inbox-send:org-attachment"}

    def ex_rows(self):
        return [r for r in self.doc["rows"] if r["contract"].startswith("exchange.")
                and r["variant"] != self.EX_CONTROL]

    def test_exchange_contracts_run_cold_and_warm(self):
        """exchange.instrumentation: every F4 contract, cold and warm,
        loss-accounted (one census record whose statements the harness
        matches)."""
        self.assertEqual({r["contract"] for r in self.ex_rows()}, set(self.EX_MAIN))
        for contract in self.EX_MAIN:
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    [r] = self.rows(contract=contract, variant=contract, condition=condition)
                    self.assertEqual(r["http_status"], 200, r["detail"])
                    self.assertEqual(r["census"]["records"], 1)
                    self.assertIs(r["harness"]["matches_census"], True)

    def test_exchange_org_level_locality_as_found(self):
        """The org list and the external-chat scans read EVERY org's document
        (docket external-chat-messages-and-wait-read-every-org-u), and an
        org FILTER on the read does not stop that: the scan lists every org
        through store.list_orgs before it filters. An @org: send writes the
        other org's store; to a sealed kiosk it reads the other store and
        only warns. Nothing else leaves the org."""
        for r in self.ex_rows():
            foreign = r["harness"]["statement_stores"].get("data:org-db:foreign", 0)
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(foreign > 0, r["variant"] in self.EX_FOREIGN)
        for variant in ("exchange.extern-read", "exchange.extern-read:org-filter",
                        "exchange.orgs-list"):
            [r] = self.rows(variant=variant, condition="warm")
            self.assertLessEqual({"orgtree.store:_load_lazy", "orgtree.store:_meta_get"},
                                 set(r["harness"]["foreign_statement_sites"]), variant)
            self.assertGreater(r["harness"]["statement_stores"]["data:org-db:foreign"], 100, variant)
        sent = self.rows(variant="exchange.org-inbox-send:org")[0]["harness"]["foreign_statement_sites"]
        self.assertIn("orgtree.store:_save_sqlite", sent)
        sealed = self.rows(variant="exchange.org-inbox-send:org-kiosk")[0]
        self.assertNotIn("orgtree.store:_save_sqlite", sealed["harness"]["foreign_statement_sites"])

    def test_exchange_rows_reach_only_the_declared_set(self):
        rows = self.ex_rows()
        self.assertGreater(len(rows), 70)
        for r in rows:
            agents = r["agents"]
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]),
                                 (0, 0))
                self.assertLessEqual(set(agents["physical_written"]),
                                     {agents["actor"]} | set(agents["targets"]))
                # (an outside peer's audience grant is logged under @extern)
                roles = {role for sect in agents["logical"].values() for role in sect.values()}
                self.assertLessEqual(roles, {"actor", "target", "user-or-org"})
                self.assertNotIn("ex-third", agents["physical_nodes"])
                self.assertFalse([s for s in agents["third_sites"] if ":read@" not in s])
        # an outside message lands in the org inbox and reaches the org's
        # external-mail recipients (Org.extern_recipients_preview): ex-top
        for condition in ("cold", "warm"):
            [r] = self.rows(variant="exchange.extern-send", condition=condition)
            self.assertEqual(set(r["agents"]["logical"]["mail"]), {"ex-top"})
            self.assertEqual(r["agents"]["targets"], ["ex-top"])

    def test_exchange_effects_and_pinned_legacy_behaviour(self):
        def one(variant, condition="warm"):
            [r] = [x for x in self.rows(variant=variant, condition=condition)
                   if x["contract"].startswith("exchange.")]
            return r

        def sighting(r):
            return any("_peers_write" in k for k in r["audit"].get("file_write", {}))
        # extern send records the peer's sighting before it validates the body,
        # the org or the attachments; not before a bad peer id
        for variant in ("exchange.extern-send", "refusal:extern-send-empty",
                        "refusal:extern-send-no-org", "refusal:extern-send-kiosk",
                        "refusal:extern-send-attachment-missing"):
            self.assertTrue(sighting(one(variant)), variant)
        self.assertFalse(sighting(one("refusal:extern-send-bad-peer")))
        # a sealed kiosk answers exactly like a missing org
        self.assertEqual(one("refusal:extern-send-kiosk")["http_status"],
                         one("refusal:extern-send-no-org")["http_status"])
        # the reply-events routes answer a raw 500 for an unknown org or node
        for variant in ("refusal:reply-events-ghost-node", "refusal:reply-events-no-org",
                        "refusal:reply-events-clear-ghost"):
            self.assertEqual(one(variant)["http_status"], 500, variant)
        # send_file touches the filesystem and the deliveries sidecar only: no
        # call writes the org's store, and a keyed call files no receipt
        for r in self.rows(contract="exchange.send-file"):
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["harness"]["stores"].get("primary", {}).get("tables_written", []),
                                 [])
        # the external-chat MCP server's client sends no credential: 401 at the
        # gate, before any attempt is recorded
        ext = one("refusal:externtool-no-credential")
        self.assertEqual((ext["http_status"], ext["census"]["records"]), (401, 0))
        for variant in ("refusal:route-no-token", "refusal:route-agent-token",
                        "refusal:extern-no-token"):
            self.assertEqual((one(variant)["http_status"], one(variant)["census"]["records"]),
                             (401, 0), variant)
        # an @org: send sparks the other org's recipient; a sealed kiosk does not
        self.assertEqual(one("exchange.org-inbox-send:org")["spies"].get("mail_spark"), 1)
        self.assertNotIn("mail_spark", one("exchange.org-inbox-send:org-kiosk")["spies"])

    def test_exchange_refusals_write_nothing_to_the_org(self):
        refusals = [r for r in self.ex_rows() if r["variant"].startswith("refusal:")]
        # 24 route refusals, the attachment on an @mcp: send (a text-only
        # transport), 7 send_file refusals and the tokenless externtool call
        self.assertEqual(len(refusals), 33)
        for r in refusals:
            with self.subTest(variant=r["variant"]):
                self.assertGreaterEqual(r["http_status"], 400)
                self.assertEqual(r["harness"]["stores"].get("primary", {}).get("tables_written", []),
                                 [])
                self.assertEqual(r["agents"]["logical"], {})

    def test_exchange_third_agent_control_is_flagged(self):
        control = self.rows(variant=self.EX_CONTROL)[0]
        self.assertEqual(control["http_status"], 200, control["detail"])
        agents = control["agents"]
        self.assertEqual(agents["logical"]["mail"], {"ex-third": "third"})
        self.assertGreaterEqual(agents["third_agent_mail"], 1)
        self.assertGreaterEqual(agents["third_agent_rows_written"], 1)


if __name__ == "__main__":
    unittest.main()
