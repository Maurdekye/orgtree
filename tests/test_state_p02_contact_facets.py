"""P01 S2b: the `contacts` and `wrapper-reads` facts, pinned to P02 contact rows.

The registry specifies `wrapper-reads` and records observed facts on the still
unresolved `contacts` facet, both from per-operation contacts
(docs/state-system/p02-operation-contacts.md). This module runs the same probe
on its own synthetic root and asserts each claim those facts make, so a product
or probe change that falsifies one fails here instead of leaving stale prose in
the registry. Synthetic data only; nothing live is touched.
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
ALIASES = ("orgtree_reservation", "orgtree_resource_reservation")
READ_ONLY = ("list-read", "landing", "overlap")
DOC_WRITERS = ("list-scope", "acquire", "renew", "recover", "invalidate", "release", "land")
VARIANTS = READ_ONLY + DOC_WRITERS + ("release-notify",)
COLD_READS = ["doc", "log_d", "log_l", "meta", "nodes"]
WARM_READS = ["doc", "meta", "nodes"]
QUIET_COUNTERS = {"observed", "recorded", "skipped_self", "unclassified_action"}


class ContactFacets(unittest.TestCase):
    doc: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="p01-contact-facets-",
                                               dir=os.environ.get("P02_HARNESS_TMP") or None)
        out = Path(cls._tmp.name) / "out"
        proc = subprocess.run([sys.executable, "-I", "-B", str(TOOL), "--out", str(out)],
                              capture_output=True, text=True, timeout=1200)
        if proc.returncode != 0:
            raise AssertionError(f"probe exited {proc.returncode}: {proc.stderr[-3000:]}")
        cls.doc = json.loads((out / "operation-contacts.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def row(self, variant, condition="warm"):
        # reservation family only: refusal/control labels recur in other families
        [found] = [r for r in self.doc["rows"] if r["variant"] == variant and r["condition"] == condition
                   and r["contract"].startswith("reservation.")]
        return found

    def reservation_rows(self):
        return [r for r in self.doc["rows"] if r["contract"].startswith("reservation.")]

    @staticmethod
    def primary(r):
        return r["harness"]["stores"].get("primary", {"tables_read": [], "tables_written": [], "statements": 0})

    @staticmethod
    def org_db(r):
        return {k.split("@")[0] for k in r["audit"].get("sqlite_connect", {})}

    # -- contacts: an observed contact set per variant, both aliases, cold and warm
    def test_every_variant_alias_and_condition_has_an_attributed_contact_set(self):
        for alias in ALIASES:
            for short in VARIANTS:
                for condition in ("cold", "warm"):
                    with self.subTest(alias=alias, variant=short, condition=condition):
                        r = self.row(f"{alias}:reservation.{short}", condition)
                        self.assertEqual(r["http_status"], 200)
                        self.assertTrue(r["census"]["db_present"])
                        self.assertIs(r["harness"]["matches_census"], True)
                        self.assertEqual(r["harness"]["statements_unbound"], 0)
                        self.assertTrue(r["harness"]["all_writes_in_transaction"])
                        self.assertEqual(r["harness"]["sidecars_touched"], {})
                        self.assertEqual(set(r["harness"]["stores"]), {"primary"})
                        self.assertLessEqual(set(r["census"]["counter_deltas"]), QUIET_COUNTERS)
                        self.assertEqual(r["guard_refusals"], {})
                        self.assertNotIn("process", r["audit"])
                        self.assertNotIn("network", r["audit"])
                        self.assertLessEqual(self.org_db(r), {"data:org-db:own"})
                        # no file read, write or listing: only the orgs-dir mkdir, the store connect
                        # and the in-process test client's loopback socketpair
                        self.assertLessEqual(set(r["audit"]), {"fs_mutation", "sqlite_connect", "harness_event_loop"})
                        self.assertEqual(r["census"]["connects"], 1 if condition == "cold" else 0)
                        p = self.primary(r)
                        self.assertEqual(p["tables_read"], COLD_READS if condition == "cold" else WARM_READS)
                        written = (["doc", "log_d", "log_l", "nodes"] if short == "release-notify"
                                   else ["doc"] if short in DOC_WRITERS else [])
                        self.assertEqual(p["tables_written"], written)
                        # callback probes: only the release with a successor drives anyone
                        wakes = (1 if short == "release-notify" else 0)
                        self.assertEqual(r["wakes"], {"mail_notify": wakes, "send_message": wakes})

    def test_refusals_and_keyed_paths_have_bounded_contacts(self):
        unauth = self.row("refusal:unauthenticated")
        self.assertEqual((unauth["http_status"], unauth["census"]["records"], unauth["harness"]["matches_census"]), (401, 0, None))
        self.assertEqual(unauth["harness"]["statements_attributed"] + unauth["harness"]["statements_unbound"], 0)
        self.assertEqual((self.row("refusal:identity-mismatch")["http_status"],
                          self.row("refusal:identity-mismatch")["census"]["statements"]), (403, 0))
        for name, status in (("refusal:halted", 409), ("refusal:killswitch", 409),
                             ("refusal:unaddressable-successor", 422), ("refusal:retained-row-cap", 422),
                             ("refusal:keyed-conflict", 409), ("refusal:stale-epoch", 422), ("keyed:replay", 200)):
            with self.subTest(name=name):
                r = self.row(name)
                self.assertEqual(r["http_status"], status)
                self.assertEqual(self.primary(r)["tables_written"], [])     # a refusal or replay writes nothing
                self.assertEqual(r["wakes"], {"mail_notify": 0, "send_message": 0})
        halted = self.row("refusal:halted")
        self.assertEqual((self.primary(halted)["tables_read"], halted["census"]["statements"]), (WARM_READS, 5))
        self.assertEqual(self.primary(self.row("keyed:replay"))["tables_read"], ["doc", "log_l", "meta"])
        self.assertEqual(self.primary(self.row("keyed:fresh"))["tables_read"], ["meta", "nodes"])
        fresh = self.row("keyed:fresh")
        self.assertEqual(self.primary(fresh)["tables_written"], ["doc", "log_l", "meta"])   # the receipt
        self.assertTrue(fresh["harness"]["all_writes_in_transaction"])

    def test_hidden_contact_and_org_locality_controls_fire_only_on_their_rows(self):
        # org-STORE locality only: control:foreign-org-contact sends no mail, so it is
        # not the agent-level mail-locality control `contacts` still lacks (S2b R1)
        hidden = self.row("control:hidden-contact")
        self.assertGreaterEqual(hidden["census"]["hidden_steps"], 1)
        foreign = self.row("control:foreign-org-contact")
        self.assertIn("data:org-db:foreign", self.org_db(foreign))
        for r in self.reservation_rows():
            if r["variant"].startswith("control:"):
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((r.get("census") or {}).get("hidden_steps", 0), 0)
                self.assertNotIn("data:org-db:foreign", self.org_db(r))

    # -- agent-level mail locality (the clause S2b ruling R1 left open)
    def test_release_notify_mail_touches_only_the_named_successor(self):
        for alias in ALIASES:
            for condition in ("cold", "warm"):
                with self.subTest(alias=alias, condition=condition):
                    agents = self.row(f"{alias}:reservation.release-notify", condition)["agents"]
                    successor = agents["targets"]
                    self.assertEqual(len(successor), 1)
                    [peer] = successor
                    self.assertNotEqual(peer, agents["actor"])
                    self.assertTrue(agents["mail_producing"])
                    # logical: every changed mail entry belongs to the successor, none to the
                    # sender (so never self-only) and none to a third agent
                    self.assertEqual(agents["logical"], {"mail": {peer: "target"}, "mail_log": {peer: "target"}})
                    # physical: the only agent rows written are the successor's
                    self.assertEqual(agents["physical_nodes"], {peer: "target"})
                    self.assertTrue(all(k.endswith(":target") for k in agents["physical"]))
                    self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]), (0, 0))
        # S2c finding f1: a successor reached only through an audience the user granted
        agents = self.row("audience-successor:reservation.release-notify", "warm")["agents"]
        [peer] = agents["targets"]
        self.assertEqual(agents["logical"], {"mail": {peer: "target"}, "mail_log": {peer: "target"}})
        self.assertEqual(agents["physical_nodes"], {peer: "target"})
        self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]), (0, 0))

    def test_third_agent_mail_control_fires_and_nothing_else_touches_a_third_agent(self):
        control = self.row("control:third-agent-mail")["agents"]
        self.assertGreaterEqual(control["third_agent_mail"], 1)
        self.assertGreaterEqual(control["third_agent_rows_written"], 1)
        self.assertIn("third", set(control["logical"]["mail"].values()))
        for r in self.reservation_rows():
            if r["variant"] == "control:third-agent-mail" or not r.get("agents"):
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual((r["agents"]["third_agent_mail"], r["agents"]["third_agent_rows_written"]), (0, 0))
                # only release-notify produces mail in the reservation family
                self.assertEqual(r["agents"]["mail_producing"], r["variant"].endswith("release-notify"))

    def test_loss_accounting_per_row_and_window(self):
        window = self.doc["window"]
        self.assertTrue(window["same_window"])
        for key in ("rejected", "dropped_stale_window", "dropped_capture_off", "evicted", "db_late",
                    "db_observe_failed", "db_self_recursion", "db_hidden_unattributed"):
            self.assertEqual(window["counters"][key], 0, key)
        for r in self.doc["rows"]:
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                deltas = (r.get("census") or {}).get("counter_deltas", {})
                self.assertEqual(deltas.get("db_unattributed", 0), 0)
                self.assertEqual(deltas.get("db_late", 0), 0)
                self.assertEqual(r["harness"]["statements_unbound"], 0)

    # -- S2d: the facets the probe now covers ----------------------------------
    def rows_of(self, contract_prefix, variant_prefix=""):
        return [r for r in self.doc["rows"] if r["contract"].startswith(contract_prefix)
                and r["variant"].startswith(variant_prefix)]

    def one(self, contract_prefix, variant, condition):
        [r] = [r for r in self.doc["rows"] if r["contract"].startswith(contract_prefix)
               and r["variant"] == variant and r["condition"] == condition]
        return r

    @staticmethod
    def written(r):
        return (r["harness"].get("stores") or {}).get("primary", {}).get("tables_written") or []

    @staticmethod
    def read(r):
        return (r["harness"].get("stores") or {}).get("primary", {}).get("tables_read")

    def test_diagnostic_reads_on_the_json_backend_and_over_malformed_state(self):
        for contract in ("diagnostic.inspect", "diagnostic.capabilities"):
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    r = self.one(contract, "json:" + contract, condition)
                    self.assertEqual((r["backend"], r["http_status"], r["census"]["statements"]), ("json", 200, 0))
                    self.assertIn("file_read:data:org-db:own", r["contact_classes"])
                    self.assertEqual(r["unknown_contacts"], [])
            self.assertEqual(self.one(contract, "json:refusal:killswitch", "warm")["http_status"], 409)
        fail500 = {'generation="x"', 'generation=[1]', 'grant="x"', 'grant=null', 'model=5', 'model=null',
                   'scope="bad"', 'scope.tools="bad"'}
        target422 = {'parent="ghost"', 'state="weird"'}
        sqlite = {r["variant"][len("malformed:"):]: r for r in self.rows_of("diagnostic.inspect", "malformed:")}
        json_rows = {r["variant"][len("json:malformed:"):]: r for r in self.rows_of("diagnostic.inspect", "json:malformed:")}
        self.assertEqual(len(sqlite), 36)
        self.assertEqual(set(sqlite), set(json_rows))
        for key, r in sqlite.items():
            corruption, role = key.rsplit(":", 1)
            want = 500 if corruption in fail500 else 422 if (corruption in target422 and role == "node") else 200
            with self.subTest(corruption=corruption, role=role):
                self.assertEqual((r["http_status"], json_rows[key]["http_status"]), (want, want))
                self.assertEqual(json_rows[key]["census"]["statements"], 0)
                self.assertEqual(r["unknown_contacts"], [])

    def test_migration_paths_write_and_fail_as_recorded(self):
        for contract in ("diagnostic.inspect", "preview.agent", "chart.read"):
            with self.subTest(contract=contract):
                refused = self.one(contract, "migration:refused", "cold")
                self.assertEqual((refused["http_status"], refused["census"]["statements"], self.written(refused)), (500, 0, []))
                self.assertTrue(refused["detail"].startswith("MigrationRefused"))
                cold = self.one(contract, "migration:legacy-json", "cold")
                self.assertEqual((cold["http_status"], self.written(cold)), (200, ["doc", "log_d", "log_l", "meta", "nodes"]))
                mut = cold["audit"]["fs_mutation"]
                self.assertTrue(any(k.startswith("os.rename:data:org-db:own@orgtree.store:migrate_org") for k in mut))
                self.assertEqual(self.written(self.one(contract, "migration:legacy-json", "warm")), [])
        bad = self.one("diagnostic.inspect", "migration:malformed-json", "cold")
        self.assertEqual((bad["http_status"], bad["census"]["statements"]), (500, 0))
        self.assertTrue(bad["detail"].startswith("MigrationError"))
        done = self.one("diagnostic.inspect", "migration:interrupted", "cold")
        self.assertEqual((done["http_status"], self.written(done)), (200, []))
        self.assertEqual({k: v for k, v in done["audit"]["fs_mutation"].items() if not k.startswith("os.mkdir")},
                         {"os.rename:data:org-db:own@orgtree.store:_finish_interrupted_migration": 1})
        for r in self.rows_of("diagnostic."):
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(r["guard_refusals"], {})
                self.assertNotIn("process", r.get("audit") or {})
                self.assertNotIn("network", r.get("audit") or {})

    def test_preview_writes_only_inside_its_clone(self):
        for r in self.rows_of("preview.agent"):
            if r["variant"] == "migration:legacy-json" and r["condition"] == "cold":
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                self.assertEqual(self.written(r), [])
                if r["variant"].startswith("preview.") and r["condition"] == "warm":
                    self.assertTrue(r["clone"] and r["clone"]["sections"], r["variant"])
        move = self.one("preview.agent", "preview.move", "warm")["clone"]["sections"]
        self.assertEqual(set(move), {"events", "nodes", "notice_log", "notices"})

    def test_provider_failure_modes_refuse_422_and_their_contacts_are_guarded(self):
        guarded = {"provider:codex-not-signed-in": {"process/subprocess.Popen": 1},
                   "provider:legacy-tier": {"process/subprocess.Popen": 1},
                   "provider:openrouter-network-refused": {"egress/urllib.Request": 1}}
        rows = self.rows_of("preview.agent", "provider:")
        self.assertEqual(len(rows), 10)
        for r in rows:
            with self.subTest(variant=r["variant"]):
                self.assertEqual((r["http_status"], self.written(r)), (422, []))
                self.assertEqual(r["guard_refusals"], guarded.get(r["variant"], {}))

    def test_status_reads_per_outcome_and_its_locality_control(self):
        full = ["doc", "log_d", "log_l", "meta", "nodes"]
        quiet = ("status.report:working", "status.report:idle", "status.report:unvalidated",
                 "status.report:done-top-level", "status.report:blocked-top-level")
        for r in self.rows_of("status.report"):
            if r["variant"].startswith("control:"):
                continue
            with self.subTest(variant=r["variant"], condition=r["condition"]):
                if r["variant"].startswith("refusal:"):
                    if r["condition"] == "warm":
                        self.assertEqual(r["census"]["statements"], 0)
                    continue
                if r["condition"] == "cold":
                    self.assertEqual((self.read(r), r["census"]["connects"]), (full, 1))
                else:
                    self.assertEqual(self.read(r), ["meta", "nodes"] if r["variant"] in quiet else full)
                if r["variant"] in quiet:
                    self.assertEqual(self.written(r), ["nodes"])
                if r["variant"] == "status.report:keyed-replay":
                    self.assertEqual(self.written(r), [])
                self.assertEqual((r["agents"]["third_agent_mail"], r["agents"]["third_agent_rows_written"]), (0, 0))
        control = self.one("status.report", "control:status-third-agent-mail", "warm")["agents"]
        self.assertGreaterEqual(control["third_agent_mail"], 1)

    def test_chart_reads_nothing_warm_writes_nothing_and_discloses_by_level(self):
        full = ["doc", "log_d", "log_l", "meta", "nodes"]
        base = {"st-chief", "st-deep", "st-worker"}
        disclosed = {"self": base, "team": base | {"st-sibling"}, "subtree": base | {"st-sibling"},
                     "full": base | {"st-sibling"}}
        for level, ids in disclosed.items():
            for archived in (False, True):
                variant = f"chart.read:{level}" + ("+archived" if archived else "")
                want = ids | ({"st-retired"} if archived and level in ("subtree", "full") else set())
                for condition in ("cold", "warm"):
                    with self.subTest(variant=variant, condition=condition):
                        r = self.one("chart.read", variant, condition)
                        self.assertEqual(set(r["disclosed"]), want)
                        self.assertEqual(self.written(r), [])
                        if condition == "cold":
                            self.assertEqual(self.read(r), full)
                        else:
                            self.assertEqual(r["census"]["statements"], 0)
                        self.assertIn("file_read:home:provider", r["contact_classes"])

    # -- S2e: org view, org feed, agent mail, human mail and inbox --------------
    def exact(self, contract, variant, condition):
        [r] = [r for r in self.doc["rows"] if r["contract"] == contract
               and r["variant"] == variant and r["condition"] == condition]
        return r

    FULL = ["doc", "log_d", "log_l", "meta", "nodes"]

    @staticmethod
    def foreign(r):
        return r["harness"]["statement_stores"].get("data:org-db:foreign", 0)

    def test_org_view_reads_and_the_admin_tree_cross_org_read(self):
        admin = ("org.tree", "org.node-detail", "org.node-detail:archived")
        public = ("org.tree:public", "org.node-detail:public")
        for variant in admin + public:
            contract = "org.tree" if variant.startswith("org.tree") else "org.node-detail"
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.exact(contract, variant, condition)
                    self.assertEqual((r["http_status"], self.written(r), r["unknown_contacts"]), (200, [], []))
                    if contract == "org.tree":
                        self.assertIn("ov-gone", r["disclosed"])
                    if condition == "cold":
                        self.assertEqual(r["harness"]["statement_stores"].get("data:org-db:own", 0) > 0, True)
                        self.assertEqual(self.read(r), self.FULL)
                    if variant == "org.tree":
                        # every admin tree build reads the other orgs' doc rows, cold and warm
                        n = self.foreign(r)
                        self.assertGreater(n, 0)
                        self.assertEqual(r["harness"]["foreign_statement_sites"], {"orgtree.store:local_net_slugs": n})
                        if condition == "warm":
                            self.assertEqual(r["harness"]["statement_stores"], {"data:org-db:foreign": n})
                    else:
                        self.assertEqual(self.foreign(r), 0)
                        if condition == "warm":
                            self.assertEqual(r["census"]["statements"], 0)
                    if variant in admin:
                        self.assertIn("file_read:home:provider", r["contact_classes"])
        cold, warm = self.exact("org.tree", "org.tree", "cold"), self.exact("org.tree", "org.tree", "warm")
        self.assertEqual(self.foreign(cold), self.foreign(warm))
        for variant, status, records in (("refusal:tree-no-token", 401, 0), ("refusal:tree-bad-kiosk-token", 404, 0),
                                         ("refusal:tree-admin-on-kiosk-org", 500, 1)):
            with self.subTest(variant=variant):
                r = self.exact("org.tree", variant, "warm")
                self.assertEqual((r["http_status"], r["census"]["statements"], r["census"]["records"]), (status, 0, records))
        r = self.exact("org.node-detail", "refusal:detail-unknown-node", "warm")
        self.assertEqual((r["http_status"], r["census"]["statements"]), (404, 0))
        scan = self.doc["kiosk_token_scan"]
        self.assertEqual(scan["statements_unbound"], scan["statements"])
        self.assertGreater(scan["statements"], 0)
        self.assertEqual(scan["recorded_delta"], 0)
        self.assertGreater(scan["db_unattributed_delta"], 0)

    def test_migration_rows_write_and_one_write_is_outside_a_transaction(self):
        routes = ("org.tree", "mail.user-inbox", "mail.user-inbox-read", "mail.node-inbox")
        for contract in routes + ("diagnostic.inspect", "preview.agent", "chart.read"):
            with self.subTest(contract=contract):
                cold = self.exact(contract, "migration:legacy-json", "cold")
                h = cold["harness"]
                self.assertEqual((h["writes"], h["writes"] - h["writes_in_transaction"]), (68, 1))
        for contract in routes:
            with self.subTest(contract=contract):
                refused = self.exact(contract, "migration:refused", "cold")
                self.assertEqual((refused["http_status"], refused["census"]["statements"], self.written(refused)), (500, 0, []))
                self.assertTrue(refused["detail"].startswith("MigrationRefused"))
                cold = self.exact(contract, "migration:legacy-json", "cold")
                self.assertEqual((cold["http_status"], self.written(cold)), (200, self.FULL))
                self.assertTrue(any(k.startswith("os.rename:data:org-db:own@orgtree.store:migrate_org")
                                    for k in cold["audit"]["fs_mutation"]))
                self.assertEqual(self.written(self.exact(contract, "migration:legacy-json", "warm")), [])

    def test_org_feed_records_subscriptions_and_fanout(self):
        for variant, public in (("org.feed", 0), ("org.feed:public", 1)):
            kind = "public" if public else "admin"
            for condition in ("cold", "warm"):
                with self.subTest(variant=variant, condition=condition):
                    r = self.exact("org.feed", variant, condition)
                    self.assertEqual(r["feed"], {"frames": {kind: 1}, "public_in_room": public, "subscribers": 1})
                    self.assertEqual((r["census"].get("statements", 0), r["census"].get("records", 0)), (0, 0))
        fan = self.exact("org.feed", "org.feed:fanout", "warm")["feed"]
        self.assertEqual(fan, {"frames": {"admin": 2, "public": 2}, "public_in_room": 1, "subscribers": 2})
        refused = self.exact("org.feed", "refusal:feed-no-token", "warm")
        self.assertEqual((refused["http_status"], refused["feed"]), (4401, {"close_code": 4401, "refused": True}))

    def mail_rows(self, *prefixes):
        return [r for r in self.doc["rows"] if r["contract"] in prefixes]

    def test_agent_mail_reads_by_recipient_class(self):
        classes = {"mail.message": ("", ":deep", ":archived", ":user", ":org", ":mcp", ":keyed-fresh", ":keyed-replay"),
                   "mail.notice": ("", ":deep", ":archived", ":keyed-fresh", ":keyed-replay")}
        for contract, suffixes in classes.items():
            for suffix in suffixes:
                for condition in ("cold", "warm"):
                    with self.subTest(variant=contract + suffix, condition=condition):
                        r = self.exact(contract, contract + suffix, condition)
                        self.assertEqual((r["http_status"], r["unknown_contacts"]), (200, []))
                        if condition == "cold":
                            self.assertEqual(self.read(r), self.FULL)
                        if suffix == ":keyed-replay":
                            self.assertEqual(self.written(r), [])
        for condition in ("cold", "warm"):
            with self.subTest(variant="bare-unknown-name", condition=condition):
                r = self.exact("mail.message", "mail.message:bare-unknown-name", condition)
                self.assertEqual((r["http_status"], self.written(r)), (422, []))
                self.assertTrue(r["detail"].startswith("NOT DELIVERED"))
                self.assertGreaterEqual(self.foreign(r), 100)
        org = self.exact("mail.message", "mail.message:org", "cold")
        self.assertIn("sqlite_connect:data:org-db:foreign", org["contact_classes"])
        self.assertIn("orgtree.store:_save_sqlite", org["harness"]["foreign_statement_sites"])
        for contract, variant in (("mail.notice", "refusal:notice-to-org"), ("mail.notice", "refusal:notice-to-user"),
                                  ("mail.message", "refusal:mail-halted")):
            with self.subTest(variant=variant):
                r = self.exact(contract, variant, "warm")
                self.assertEqual((r["http_status"] in (409, 422), self.written(r)), (True, []))
        self.assertEqual(self.read(self.exact("mail.message", "refusal:mail-halted", "warm")), ["meta", "nodes"])

    def test_mail_locality_and_its_controls(self):
        for contract, control in (("mail.message", "control:mail-third-agent"),
                                  ("mail.notice", None),
                                  ("mail.human-send", "control:human-send-third-agent")):
            for r in self.mail_rows(contract):
                with self.subTest(contract=contract, variant=r["variant"], condition=r["condition"]):
                    agents = r["agents"]
                    if r["variant"] == control:
                        self.assertGreaterEqual(agents["third_agent_mail"], 1)
                        self.assertIn("third", set(agents["logical"]["mail"].values()))
                        continue
                    self.assertEqual((agents["third_agent_mail"], agents["third_agent_rows_written"]), (0, 0))
                    for section in ("mail", "mail_log", "notices"):
                        for who, role in agents["logical"].get(section, {}).items():
                            self.assertEqual(role, "target", (section, who))
                            self.assertIn(who, agents["targets"])
                    if r["variant"].startswith("refusal:") or ":user" in r["variant"] or ":org" in r["variant"] \
                            or ":mcp" in r["variant"]:
                        self.assertEqual(agents["logical"].get("mail", {}), {})
        # a first deep send grants the audience between sender and recipient, cold only
        self.assertEqual(self.exact("mail.message", "mail.message:deep", "cold")["agents"]["logical"]["audiences"],
                         {"m-deep": "target", "m-mid": "actor"})
        self.assertNotIn("audiences", self.exact("mail.message", "mail.message:deep", "warm")["agents"]["logical"])
        # an explicit notice keeps the reply grant too (retraction of the landed N2 sentence)
        self.assertEqual(self.exact("mail.notice", "mail.notice:deep", "cold")["agents"]["logical"]["audiences"],
                         {"m-kid": "target", "m-top": "actor"})
        self.assertNotIn("audiences", self.exact("mail.notice", "mail.notice:deep", "warm")["agents"]["logical"])
        # a session command changes no mail, only the chain's notice
        cmd = self.exact("mail.human-send", "mail.human-send:session-command", "cold")["agents"]["logical"]
        self.assertEqual(cmd, {"notices": {"h-top": "target"}})
        deep = self.exact("mail.human-send", "mail.human-send:deep", "cold")["agents"]["logical"]
        self.assertEqual((deep["notices"], deep["audiences"]),
                         ({"h-mid": "target", "h-top": "target"}, {"@user": "actor", "h-deep": "target"}))

    def test_human_send_reads_by_class(self):
        suffixes = ("", ":deep", ":archived", ":notice", ":session-command", ":attachment",
                    ":reply-to-chat-event", ":reply-target")
        for suffix in suffixes:
            for condition in ("cold", "warm"):
                with self.subTest(variant=suffix, condition=condition):
                    r = self.exact("mail.human-send", "mail.human-send" + suffix, condition)
                    self.assertEqual((r["http_status"], r["unknown_contacts"]), (200, []))
                    want = self.FULL if condition == "cold" or suffix == ":attachment" else ["meta", "nodes"]
                    self.assertEqual(self.read(r), want)
                    if suffix == ":attachment":
                        self.assertTrue(r["audit"].get("stat"))
                    if suffix == ":reply-to-chat-event":
                        h = r["harness"]
                        self.assertEqual(h["sidecars_touched"], {"reply_events": "write", "transcript_records": "read"})
                        self.assertEqual(r["audit"]["sqlite_connect"].get("data:sidecar-db@orgtree.census_contacts:__init__"), 4)
                        self.assertEqual(h["writes"] - h["writes_in_transaction"], 1)
                    else:
                        self.assertTrue(r["harness"]["all_writes_in_transaction"])
        unknown = self.exact("mail.human-send", "refusal:human-unknown-node", "warm")
        self.assertEqual((unknown["http_status"], self.written(unknown)), (422, []))
        self.assertGreaterEqual(self.foreign(unknown), 100)
        for variant in ("refusal:human-empty", "refusal:human-target-and-reply", "refusal:human-command-archived"):
            with self.subTest(variant=variant):
                self.assertEqual(self.exact("mail.human-send", variant, "warm")["census"]["statements"], 0)

    def test_human_send_effects_observed_so_far(self):
        for condition in ("cold", "warm"):
            r = self.exact("mail.human-send", "mail.human-send:session-command", condition)
            self.assertEqual((r["immediate_command"], r["wakes"]), (1, {"mail_notify": 0, "send_message": 1}))
        compact = self.exact("mail.human-send", "refusal:compact-no-conversation", "warm")
        self.assertEqual(compact["http_status"], 422)
        self.assertEqual(compact["agents"]["logical"], {"notices": {"h-top": "target"}})   # the chain was told
        self.assertIn("doc", self.written(compact))

    def test_inbox_reads_and_writes_on_both_backends(self):
        sqlite_reads = {"mail.user-inbox": ["doc", "log_l", "meta"], "mail.user-inbox-read": self.FULL,
                        "mail.node-inbox": self.FULL}
        sqlite_writes = {("mail.user-inbox-read", "cold"): ["doc", "log_l", "meta"],
                         ("mail.user-inbox-read", "warm"): ["doc", "log_l"]}
        for contract, reads in sqlite_reads.items():
            for condition in ("cold", "warm"):
                with self.subTest(contract=contract, condition=condition):
                    r = self.exact(contract, contract, condition)
                    self.assertEqual((r["http_status"], r["unknown_contacts"], self.read(r)), (200, [], reads))
                    self.assertEqual(self.written(r), sqlite_writes.get((contract, condition), []))
                    j = self.exact(contract, "json:" + contract, condition)
                    self.assertEqual((j["backend"], j["http_status"], j["census"]["statements"]), ("json", 200, 0))
                    self.assertIn("file_read:data:org-db:own", j["contact_classes"])
                    mut = j["audit"].get("fs_mutation", {})
                    self.assertTrue(any(k.startswith("os.mkdir:data:other@orgtree.store:_orgs_dir") for k in mut))
                    renamed = "os.rename:data:org-db:own@orgtree.store:_save_json" in mut
                    self.assertEqual(renamed, contract == "mail.user-inbox-read")
                    self.assertEqual("file_write:data:org-db:temp" in j["contact_classes"], renamed)
        for condition, reads in (("cold", self.FULL), ("warm", None)):
            r = self.exact("mail.user-inbox-read", "mail.user-inbox-read:nothing-read", condition)
            self.assertEqual((self.read(r), self.written(r)), (reads, []))
            j = self.exact("mail.user-inbox-read", "json:mail.user-inbox-read:nothing-read", condition)
            self.assertNotIn("os.rename:data:org-db:own@orgtree.store:_save_json", j["audit"].get("fs_mutation", {}))
        for variant in ("refusal:inbox-no-token", "json:refusal:inbox-no-token"):
            r = self.exact("mail.user-inbox", variant, "warm")
            self.assertEqual((r["http_status"], r["census"]["records"], r["census"]["statements"]), (401, 0, 0))
        r = self.exact("mail.node-inbox", "refusal:node-inbox-unknown-node", "warm")
        self.assertEqual((r["http_status"], self.read(r), self.written(r)), (404, self.FULL, []))
        self.assertEqual(self.exact("mail.node-inbox", "json:refusal:node-inbox-unknown-node", "warm")["http_status"], 404)

    def test_no_token_rows_are_the_only_rows_without_a_census_record(self):
        # a loss-accounted record for every S2e row but the ones refused before any attempt
        unrecorded = {"refusal:tree-no-token", "refusal:tree-bad-kiosk-token", "refusal:inbox-no-token",
                      "json:refusal:inbox-no-token"}
        for r in self.doc["rows"]:
            if not r["contract"].startswith(("org.tree", "org.node-detail", "mail.")):
                continue
            with self.subTest(contract=r["contract"], variant=r["variant"], condition=r["condition"]):
                if r["variant"] in unrecorded:
                    self.assertIsNone(r["harness"]["matches_census"])
                else:
                    self.assertIs(r["harness"]["matches_census"], True)
                    self.assertEqual(r["census"]["records"], 1)


if __name__ == "__main__":
    unittest.main()
