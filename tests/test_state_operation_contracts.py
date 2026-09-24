"""Source contract checks and unsafe-control refusals; no live state or PG."""
from __future__ import annotations

import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import state_operation_contracts as contracts


class ContractCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        cls.source = contracts.inventory.scan(ROOT)

    def validate(self, document=None):
        return contracts.validate(self.document if document is None else document, self.source, ROOT)

    def rejects(self, edit, fragment):
        document = copy.deepcopy(self.document)
        edit(document)
        result = self.validate(document)
        self.assertFalse(result["valid"], result)
        self.assertFalse(result["contract_coverage_complete"])
        self.assertTrue(any(fragment in error for error in result["errors"]), result["errors"])
        self.assertEqual(result["qualification"], contracts.GATES)

    def test_repository_contracts_are_valid_but_not_complete(self):
        result = self.validate()
        self.assertTrue(result["valid"], result["errors"])
        self.assertFalse(result["contract_coverage_complete"])
        self.assertGreater(result["summary"]["entries"]["pending"], 0)
        self.assertGreater(result["summary"]["storage"]["pending"], 0)
        # THE one registry-wide tripwire (review of S3 candidate 1): every candidate
        # that maps a witness or adds a contract moves these numbers here, and only here.
        self.assertEqual(result["contracts"], 27)
        self.assertEqual((result["summary"]["entries"]["mapped"], result["summary"]["dispatch"]["mapped"],
                          result["summary"]["storage"]["mapped"]), (18, 36, 0))
        self.assertEqual(len(result["pending"]), 599)
        self.assertEqual(result["qualification"], {"runtime_census": False, "conversion_authorized": False})

    # S2 decision 1 (strict): a facet P01 cannot close carries its owner, the
    # evidence that would close it, and why the available evidence does not.
    # The wire facets get theirs with their legacy-parity fixtures.
    ANNOTATION_PENDING: set[str] = set()

    def test_every_unresolved_facet_names_its_owner_and_closing_evidence(self):
        unresolved = {k for k, f in self.document["facets"].items() if f["status"] == "unresolved"}
        self.assertLessEqual(self.ANNOTATION_PENDING, unresolved)
        for name in sorted(unresolved - self.ANNOTATION_PENDING):
            with self.subTest(facet=name):
                notes = [q for q in self.document["facets"][name]["open_questions"] if q.startswith("Owner: ")]
                self.assertEqual(len(notes), 1)
                self.assertIn(". Closes with: ", notes[0])
                self.assertIn(". Not coverable at P01 from available evidence: ", notes[0])
                self.assertGreater(len(self.document["facets"][name]["open_questions"]), 1)

    def test_contacts_is_specified_only_with_agent_level_mail_locality(self):
        # S2b ruling R1: org-store locality is not mail locality. contacts became
        # specified only once P02 observed agent-level mail locality (6721cad); the
        # fact that carries it, and its org-wide-row limit, must stay.
        facet = self.document["facets"]["contacts"]
        self.assertEqual((facet["status"], facet["open_questions"]), ("specified", []))
        self.assertTrue(any(f.startswith("Agent-level mail-locality negative control") for f in facet["facts"]))
        self.assertTrue(any(f.startswith("Limit of that control: the legacy mail QUEUE") for f in facet["facts"]))
        self.assertEqual(self.document["facets"]["wrapper-reads"]["status"], "specified")

    def test_material_wire_legacy_projector_clause_is_closed(self):
        # S2 decision 2 (option b) split the legacy projector clause out to
        # p01-transcript-projector-legacy-fixtures; that item fixtured it, so only
        # the native/Rust clause may remain open on material.wire.
        questions = self.document["facets"]["material.wire"]["open_questions"]
        self.assertFalse([q for q in questions if q.startswith("Fixture the legacy transcript projector")])
        [note] = [q for q in questions if q.startswith("Owner: ")]
        self.assertTrue(note.startswith("Owner: the native/Rust conversion"), note)
        self.assertIn("including the transcript projector (p01-transcript-projector-legacy-fixtures), is fixtured", note)

    # A mapped shared tool selector must not drop the obligation of a tool it admits
    # that has no contract yet (review of S3 candidate 1): every value an In/Eq
    # tool selector admits must be a tool of one of the contracts it maps to.
    # dd72cf1a (widened by P02-A1 with orgtree_operation_census) was the one older
    # exception; S3 decision 3 returned it to pending, so there are none.
    EARLY_MAPPED: dict[str, set[str]] = {}

    def uncontracted_selector_values(self, document):
        selectors = {contracts.witness_id("dispatch", r): r for r in self.source["dispatch_selectors"]}
        gaps = {}
        for row in document["dispatch"]:
            site = selectors[row["id"]]
            if row["disposition"] != "mapped" or site["kind"] != "tool" or site["operator"] not in ("In", "Eq"):
                continue
            tools = {t for c in row["contracts"] for t in document["contracts"][c]["tools"]}
            missing = set(site["values"]) - tools
            if missing:
                gaps[row["id"]] = missing
        return gaps

    def test_mapped_shared_tool_selectors_admit_only_contracted_tools(self):
        self.assertEqual(self.uncontracted_selector_values(self.document), self.EARLY_MAPPED)

    def test_mapping_a_shared_selector_early_is_caught(self):
        # the three shared selectors S3 candidate 1 keeps pending
        document = copy.deepcopy(self.document)
        row = next(r for r in document["dispatch"] if r["id"].startswith("c477bfda"))
        self.assertEqual(row["disposition"], "pending")
        row.update(disposition="mapped", contracts=["chart.read"], reason="early",
                   source_refs=document["contracts"]["chart.read"]["source_refs"][1:])
        self.assertTrue(self.validate(document)["valid"])     # the validator alone does not see it
        self.assertIn(row["id"], self.uncontracted_selector_values(document))

    def test_each_required_dimension_is_enforced(self):
        for dimension in contracts.DIMENSIONS:
            with self.subTest(dimension=dimension):
                self.rejects(lambda d: d["contracts"]["reservation.acquire"]["dimensions"].pop(dimension),
                             "missing or unknown fields")

    def test_omitted_entry_is_not_covered_by_family(self):
        self.rejects(lambda d: d["entries"].pop(), "missing witnesses")

    def test_omitted_action_witness_refuses(self):
        self.rejects(lambda d: d["dispatch"].pop(), "missing witnesses")

    def test_omitted_storage_factory_refuses(self):
        self.rejects(lambda d: d["storage"].pop(), "missing witnesses")

    def test_duplicate_entry_cannot_pad_coverage(self):
        self.rejects(lambda d: d["entries"].append(d["entries"][0]), "duplicate witness")

    def test_unknown_entry_cannot_replace_real_one(self):
        self.rejects(lambda d: d["entries"][0].update(id="fabricated"), "unknown witness")

    def test_no_concrete_route_exclusion_escape(self):
        identity = next(r["site_id"] for r in self.source["registrations"] if r["kind"] == "http")
        def edit(d):
            row = next(r for r in d["entries"] if r["id"] == identity)
            row.update(disposition="excluded", reason="claim it is not a route",
                       source_refs=d["contracts"]["reservation.acquire"]["source_refs"])
        self.rejects(edit, "concrete entry cannot be excluded")

    def test_mapping_unrelated_entry_to_reservation_is_not_coverage(self):
        def edit(d):
            row = next(r for r in d["entries"] if r["disposition"] == "pending")
            row.update(disposition="mapped", contracts=["reservation.acquire"],
                       source_refs=d["contracts"]["reservation.acquire"]["source_refs"])
        self.rejects(edit, "entry binding missing or unrelated")

    def test_tool_binding_is_checked_against_source(self):
        self.rejects(lambda d: d["contracts"]["reservation.acquire"].update(tools=["orgtree_move"]),
                     "entry/tool binding mismatch")

    def test_declared_action_cannot_disappear(self):
        def edit(d):
            for c in d["contracts"].values():
                if c["action"] == "acquire":
                    c["action"] = "unexpected"
        self.rejects(edit, "action coverage drift")

    def test_wrong_facet_dimension_refuses(self):
        self.rejects(lambda d: d["contracts"]["reservation.acquire"]["dimensions"].update(reads=["legacy-lock"]),
                     "wrong-dimension facet")

    def test_erased_unknown_does_not_create_specified_contract(self):
        self.rejects(lambda d: d["facets"]["legacy-lock"].update(status="specified"),
                     "specified facet has open questions")

    def test_unknown_without_question_refuses(self):
        self.rejects(lambda d: d["facets"]["legacy-lock"].update(open_questions=[]),
                     "unresolved facet needs a concrete question")

    def test_pending_entry_cannot_pretend_to_have_contract(self):
        def edit(d):
            next(r for r in d["entries"] if r["disposition"] == "pending")["contracts"] = ["reservation.acquire"]
        self.rejects(edit, "pending witness must not pretend")

    def test_old_source_pin_refuses(self):
        self.rejects(lambda d: d.update(source_inventory_sha256="0" * 64), "binding is stale")

    def test_anchor_digest_refuses(self):
        self.rejects(lambda d: d["facets"]["actor"]["source_refs"][0].update(sha256="0" * 64),
                     "stale source span")

    def test_unpinned_path_and_invalid_span_refuse(self):
        self.rejects(lambda d: d["facets"]["actor"]["source_refs"][0].update(path="../../escape.py"),
                     "unpinned source path")
        self.rejects(lambda d: d["facets"]["actor"]["source_refs"][0].update(start=0),
                     "invalid source span")

    def test_fabricated_qualification_refuses(self):
        for gate in contracts.GATES:
            with self.subTest(gate=gate):
                self.rejects(lambda d: d["qualification"].update({gate: True}), "cannot be elevated")

    def test_orphan_contract_and_facet_refuse(self):
        self.rejects(lambda d: d["contracts"].update(orphan=copy.deepcopy(d["contracts"]["reservation.acquire"])),
                     "orphan contracts")
        self.rejects(lambda d: d["facets"].update(orphan=copy.deepcopy(d["facets"]["actor"])), "orphan facets")

    def test_unsafe_conditional_list_becomes_ambiguous(self):
        self.rejects(lambda d: d["contracts"]["reservation.list-read"].update(when={"always": True}),
                     "zero/multiple/wrong contracts")

    def test_conditional_domain_write_cannot_be_labelled_read(self):
        self.rejects(lambda d: d["contracts"]["reservation.list-scope"].update(domain_mode="read"),
                     "domain-mode mismatch")

    def test_missing_alias_selector_case_refuses(self):
        alias = next(r["site_id"] for r in self.source["registrations"]
                     if r.get("names") == ["orgtree_resource_reservation"])
        def edit(d):
            d["wire_cases"] = [r for r in d["wire_cases"] if r["entry_id"] != alias]
        self.rejects(edit, "contract/entry pairs missing")

    def test_conditions_are_data_not_python_code(self):
        self.rejects(lambda d: d["contracts"]["reservation.acquire"].update(when={"eval": "raise SystemExit"}),
                     "unknown condition")

    def test_complete_cli_refuses_current_registry(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = contracts.main(["--repo", str(ROOT), "--require-complete"])
        self.assertEqual(code, 3)
        self.assertFalse(json.loads(output.getvalue())["contract_coverage_complete"])

    def test_cli_refuses_any_interpreter_but_the_provisioned_minor_version(self):
        self.assertIsNone(contracts.interpreter_refusal((3, 13, 0)))
        self.assertIn("requires Python 3.13", contracts.interpreter_refusal((3, 10, 11)))
        self.assertIsNotNone(contracts.interpreter_refusal((3, 14, 0)))
        # Negative control: pretend the provisioned runtime is another version.
        # The CLI must refuse with 4 before checking anything, not report drift.
        original = contracts.REQUIRED_PYTHON
        contracts.REQUIRED_PYTHON = (3, 99)
        try:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = contracts.main(["--repo", str(ROOT), "--require-complete"])
        finally:
            contracts.REQUIRED_PYTHON = original
        self.assertEqual(code, 4)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("requires Python 3.99", json.loads(err.getvalue())["error"])

    def test_real_cli_works_with_the_provisioned_isolated_interpreter(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "tools/state_operation_contracts.py"),
                                 "--repo", str(ROOT), "--require-complete"],
                                cwd=ROOT, capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertTrue(json.loads(result.stdout)["valid"])

    def test_read_only_cli_does_not_refresh_stale_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "contracts.json"
            path.write_text('{"schema": "broken"}', encoding="utf-8")
            before = path.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = contracts.main(["--repo", str(ROOT), "--contracts", str(path)])
            self.assertIn(code, (1, 2))
            self.assertEqual(before, path.read_bytes())

    def test_json_duplicate_keys_and_nonfinite_numbers_refuse(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "duplicate.json"
            for text in ('{"a":1,"a":2}', '{"a":NaN}'):
                path.write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    contracts.load(path)


class SourceInvalidation(unittest.TestCase):
    def test_complete_synthetic_contract_still_cannot_authorize_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backend = root / "engine/backend"
            backend.mkdir(parents=True)
            text = '@app.get("/fixture")\ndef read():\n    return {}\n'
            (backend / "api.py").write_text(text, encoding="utf-8")
            source = contracts.inventory.scan(root)
            identity = source["registrations"][0]["site_id"]
            span = {"path": "engine/backend/api.py", "start": 1, "end": 3,
                    "sha256": contracts.inventory.fingerprint(text)}
            facets = {d: {"dimension": d, "status": "specified", "facts": ["Synthetic assertion."],
                          "source_refs": [span], "open_questions": []} for d in contracts.DIMENSIONS}
            doc = {"schema": contracts.SCHEMA, "source_inventory_sha256": contracts.digest(source),
                   "qualification": dict(contracts.GATES), "entries": [
                       {"id": identity, "disposition": "mapped", "contracts": ["fixture"],
                        "reason": "Synthetic route.", "source_refs": [span]}],
                   "dispatch": [], "storage": [], "facets": facets,
                   "contracts": {"fixture": {"entry_ids": [identity], "tools": [], "action": None,
                       "action_normalization": "identity", "when": {"always": True}, "domain_mode": "read",
                       "dimensions": {d: [d] for d in contracts.DIMENSIONS}, "source_refs": [span]}},
                   "wire_cases": [{"name": "fixture", "entry_id": identity, "args": {},
                                   "contract": "fixture", "domain_mode": "read"}],
                   "limits": ["Synthetic schema fixture, not a real semantic claim."]}
            result = contracts.validate(doc, source, root)
            self.assertTrue(result["valid"], result["errors"])
            self.assertTrue(result["contract_coverage_complete"])
            self.assertEqual(result["qualification"], contracts.GATES)

    def test_refreshing_inventory_alone_does_not_reapprove_contract(self):
        # A helper's new write does not need to be a recognized registration.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backend = root / "engine/backend"
            backend.mkdir(parents=True)
            file = backend / "worker.py"
            file.write_text("def helper():\n    return 1\n", encoding="utf-8")
            old = contracts.inventory.scan(root)
            doc = {"schema": contracts.SCHEMA, "source_inventory_sha256": contracts.digest(old),
                   "qualification": dict(contracts.GATES), "entries": [], "dispatch": [], "storage": [],
                   "facets": {}, "contracts": {}, "wire_cases": [], "limits": ["Synthetic schema fixture only."]}
            file.write_text("def helper():\n    global value\n    value = 2\n", encoding="utf-8")
            fresh = contracts.inventory.scan(root)
            result = contracts.validate(doc, fresh, root)
            self.assertFalse(result["valid"])
            self.assertIn("source inventory binding is stale", result["errors"])

    def test_unknown_registration_never_imports_backend(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backend = root / "engine/backend"
            backend.mkdir(parents=True)
            (backend / "factory.py").write_text("raise RuntimeError('must not execute')\ninstall_hidden_factory()\n", encoding="utf-8")
            result = contracts.inventory.scan(root)
            self.assertEqual(result["summary"]["modules"], 1)


class ReservationSelectorConformance(unittest.TestCase):
    """Call only the existing pure document helper on synthetic data."""
    @classmethod
    def setUpClass(cls):
        import import_provenance  # noqa: F401
        from orgtree import opreceipts, reservations
        cls.reservations, cls.receipts = reservations, opreceipts
        cls.document = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        cls.entry = cls.document["contracts"]["reservation.list-read"]["entry_ids"][0]

    def test_list_read_and_scope_write_follow_actual_helper(self):
        d = {}
        r = self.reservations
        r.execute(d, "owner", {"action": "acquire", "resource": "fixture", "candidate": "a"*40,
                             "base": "b"*40, "lease_s": 1, "stale_s": 1}, now_ts=100)
        before = copy.deepcopy(d)
        args = {"action": "list", "candidate": None, "base": None}
        self.assertEqual(contracts.select(self.document, self.entry, args), ["reservation.list-read"])
        r.execute(d, "owner", args, now_ts=105)
        self.assertEqual(d, before)
        args.update(candidate="c"*40, base="b"*40)
        self.assertEqual(contracts.select(self.document, self.entry, args), ["reservation.list-scope"])
        result = r.execute(d, "owner", args, now_ts=105)
        self.assertEqual(d["reservations"][0]["state"], "stale")
        self.assertEqual(len(result["stale"]), 1)

    def test_empty_candidate_is_write_branch_even_when_it_refuses(self):
        args = {"action": "list", "candidate": ""}
        self.assertEqual(contracts.select(self.document, self.entry, args), ["reservation.list-scope"])
        with self.assertRaises(self.reservations.ReservationError):
            self.reservations.execute({}, "owner", args, now_ts=100)

    def test_domain_reads_are_still_receipt_capable(self):
        for tool in ("orgtree_reservation", "orgtree_resource_reservation"):
            for action in ("list", "landing", "overlap"):
                self.assertEqual(self.receipts.coverage(tool, {"action": action}), self.receipts.TX_POST)


if __name__ == "__main__":
    unittest.main()
