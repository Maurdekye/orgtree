"""Validate source-bound P01 operation contracts without running the backend.

Structural validity is not semantic completeness, runtime coverage or authority
to convert. --require-complete refuses every unresolved entry/facet/witness.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sys

# The shipped Python uses an isolated ._pth, so a sibling import must not
# depend on the script directory being implicitly added to sys.path.
_SPEC = importlib.util.spec_from_file_location(
    "state_operation_inventory", Path(__file__).with_name("state_operation_inventory.py"))
assert _SPEC and _SPEC.loader
inventory = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(inventory)

SCHEMA = "orgtree.state-operation-contracts/v1"
DIMENSIONS = ("authority", "reads", "writes", "predicates", "conflicts",
              "wire", "receipt", "effects", "instrumentation")
GATES = {"runtime_census": False, "conversion_authorized": False}
GROUPS = {"entries": "registrations", "dispatch": "dispatch_selectors",
          "storage": "connection_sites"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def witness_id(group, row):
    return row["site_id"] if group == "entries" else digest([group, row])


def load(path):
    def pairs(rows):
        obj = {}
        for key, value in rows:
            if key in obj:
                raise ValueError(f"duplicate JSON key: {key}")
            obj[key] = value
        return obj

    def invalid_constant(value):
        raise ValueError(f"non-finite JSON number: {value}")

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs,
                      parse_constant=invalid_constant)


def condition_matches(condition, args):
    """Small language-neutral selector DSL, never eval/exec caller expressions."""
    if isinstance(condition, dict) and set(condition) == {"always"} and condition["always"] is True:
        return True
    if not isinstance(condition, dict) or len(condition) != 1:
        raise ValueError("condition must contain one supported operator")
    if "not" in condition:
        return not condition_matches(condition["not"], args)
    if "non_null_any" in condition:
        keys = condition["non_null_any"]
        if not isinstance(keys, list) or not keys or any(not isinstance(k, str) or not k for k in keys):
            raise ValueError("non_null_any requires nonempty keys")
        return any(args.get(key) is not None for key in keys)
    if "truthy_text" in condition:
        key = condition["truthy_text"]
        if not isinstance(key, str) or not key:
            raise ValueError("truthy_text requires a key")
        # Exact reservation selector semantics, not a generic wire validator.
        return bool(str(args.get(key) or "").strip())
    raise ValueError("unknown condition operator")


def select(document, entry_id, args):
    """Select within one source entry; argument normalization is contract data."""
    def action_matches(contract):
        if contract["action"] is None:
            return True
        value = args.get("action")
        mode = contract["action_normalization"]
        if mode == "str_or_empty_strip_lower":
            value = str(value or "").strip().lower()
        elif mode == "str_or_empty":
            value = str(value or "")
        return value == contract["action"]

    return [key for key, contract in document["contracts"].items()
            if entry_id in contract["entry_ids"] and action_matches(contract)
            and condition_matches(contract["when"], args)]


def validate(document, source, repo):
    """Return independent validity/completeness flags, with all gaps retained."""
    errors, pending = [], []

    def require(ok, message):
        if not ok:
            errors.append(message)
        return ok

    def text(value):
        return isinstance(value, str) and bool(value.strip())

    def keys(value, required, where):
        return require(isinstance(value, dict) and set(value) == set(required),
                       where + ": missing or unknown fields")

    def strings(value, where, nonempty=True):
        return require(isinstance(value, list) and (bool(value) or not nonempty)
                       and all(text(v) for v in value) and len(value) == len(set(value)),
                       where + ": expected unique nonblank strings")

    expected_top = {"schema", "source_inventory_sha256", "qualification", "entries",
                    "dispatch", "storage", "facets", "contracts", "wire_cases", "limits"}
    if not keys(document, expected_top, "document"):
        return {"valid": False, "errors": errors, "contract_coverage_complete": False,
                "qualification": dict(GATES)}
    require(document["schema"] == SCHEMA, "unsupported contract schema")
    require(isinstance(document["qualification"], dict) and
            set(document["qualification"]) == set(GATES) and
            all(value is False for value in document["qualification"].values()),
            "qualification cannot be elevated by a P01 document")
    require(document["source_inventory_sha256"] == digest(source), "source inventory binding is stale")
    strings(document["limits"], "limits")
    modules = {m["path"]: m["normalized_source_sha256"] for m in source["modules"]}
    entry_sites = {r["site_id"]: r for r in source["registrations"]}
    lines = {}

    def refs(value, where):
        if not require(isinstance(value, list) and bool(value), where + ": source evidence required"):
            return
        for ref in value:
            if not keys(ref, {"path", "start", "end", "sha256"}, where + ".ref"):
                continue
            path = ref["path"]
            if not require(isinstance(path, str) and path in modules and
                           PurePosixPath(path).as_posix() == path, where + ": unpinned source path"):
                continue
            if path not in lines:
                lines[path] = (repo / path).read_text(encoding="utf-8-sig").splitlines(keepends=True)
            start, end = ref["start"], ref["end"]
            if not require(type(start) is int and type(end) is int and
                           1 <= start <= end <= len(lines[path]), where + ": invalid source span"):
                continue
            actual = hashlib.sha256("".join(lines[path][start-1:end]).encode("utf-8")).hexdigest()
            require(ref["sha256"] == actual, where + ": stale source span")

    facets = document["facets"]
    contracts = document["contracts"]
    if not require(isinstance(facets, dict) and isinstance(contracts, dict), "facets/contracts must be objects"):
        return {"valid": False, "errors": errors, "contract_coverage_complete": False,
                "qualification": dict(GATES)}
    for name, facet in facets.items():
        where = "facet " + name
        if not keys(facet, {"dimension", "status", "facts", "source_refs", "open_questions"}, where):
            continue
        require(facet["dimension"] in DIMENSIONS, where + ": unknown dimension")
        require(facet["status"] in {"specified", "unresolved"}, where + ": unknown status")
        strings(facet["facts"], where + ".facts")
        strings(facet["open_questions"], where + ".open_questions", nonempty=False)
        refs(facet["source_refs"], where)
        if facet["status"] == "specified":
            require(facet["open_questions"] == [], where + ": specified facet has open questions")
        else:
            require(bool(facet["open_questions"]), where + ": unresolved facet needs a concrete question")
    used_facets = set()
    for name, contract in contracts.items():
        where = "contract " + name
        if not keys(contract, {"entry_ids", "tools", "action", "action_normalization",
                               "when", "dimensions", "source_refs", "domain_mode"}, where):
            continue
        if strings(contract["entry_ids"], where + ".entry_ids"):
            require(set(contract["entry_ids"]) <= set(entry_sites), where + ": unknown entry binding")
            bound_sites = [entry_sites[k] for k in contract["entry_ids"] if k in entry_sites]
            expected_names = {n for r in bound_sites if r["kind"] == "tool" for n in (r.get("names") or [])}
            require(set(contract["tools"]) == expected_names, where + ": entry/tool binding mismatch")
        strings(contract["tools"], where + ".tools", nonempty=False)
        require(contract["action"] is None or text(contract["action"]), where + ": action must be null or text")
        require(contract["action_normalization"] in {"identity", "str_or_empty", "str_or_empty_strip_lower"},
                where + ": unknown action normalization")
        require(contract["domain_mode"] in {"read", "write", "conditional_write"}, where + ": invalid domain mode")
        refs(contract["source_refs"], where)
        try:
            condition_matches(contract["when"], {})
        except ValueError as exc:
            errors.append(where + ": " + str(exc))
        if not keys(contract["dimensions"], DIMENSIONS, where + ".dimensions"):
            continue
        for dimension, names in contract["dimensions"].items():
            if not strings(names, where + "." + dimension):
                continue
            for facet_name in names:
                used_facets.add(facet_name)
                facet = facets.get(facet_name)
                if not require(isinstance(facet, dict) and facet.get("dimension") == dimension,
                               where + ": missing/wrong-dimension facet " + facet_name):
                    continue
                if facet.get("status") != "specified":
                    pending.append({"kind": "dimension", "id": name, "dimension": dimension,
                                    "facet": facet_name})
    require(set(facets) == used_facets, "orphan facets or unresolved facet references")

    used_contracts = set()
    summary = {}
    for group, field in GROUPS.items():
        expected = {witness_id(group, row): row for row in source[field]}
        rows = document[group]
        if not require(isinstance(rows, list), group + ": expected list"):
            continue
        observed = set()
        counts = {"total": len(expected), "mapped": 0, "excluded": 0, "pending": 0}
        for row in rows:
            if not keys(row, {"id", "disposition", "contracts", "reason", "source_refs"}, group):
                continue
            identity = row["id"]
            if not require(isinstance(identity, str) and identity in expected, group + ": unknown witness"):
                continue
            require(identity not in observed, group + ": duplicate witness " + identity)
            observed.add(identity)
            where = group + " " + identity
            disposition = row["disposition"]
            require(disposition in {"mapped", "excluded", "pending"}, where + ": invalid disposition")
            require(text(row["reason"]), where + ": reason required")
            if not strings(row["contracts"], where + ".contracts", nonempty=False):
                continue
            require(set(row["contracts"]) <= set(contracts), where + ": unknown contract")
            if disposition in {"mapped", "excluded"}:
                site = expected[identity]["source"]
                require(any(isinstance(r, dict) and r.get("path") == site["path"] and
                            type(r.get("start")) is int and type(r.get("end")) is int and
                            r["start"] <= site["line"] <= site["end_line"] <= r["end"]
                            for r in row["source_refs"]) if isinstance(row["source_refs"], list) else False,
                        where + ": evidence does not cover the witness")
            if disposition == "mapped":
                require(bool(row["contracts"]), where + ": mapped witness has no contract")
                refs(row["source_refs"], where)
                used_contracts.update(row["contracts"])
                if group == "entries":
                    bindings = {key for key, c in contracts.items() if identity in c.get("entry_ids", [])}
                    require(set(row["contracts"]) == bindings, where + ": entry binding missing or unrelated")
                if group == "entries" and expected[identity]["kind"] == "tool":
                    card = expected[identity]
                    bound = [contracts[c] for c in row["contracts"] if c in contracts]
                    names = set(card.get("names") or [])
                    require(all(names & set(c.get("tools", [])) for c in bound), where + ": wrong tool binding")
                    if card.get("actions") is not None:
                        require(set(card["actions"]) == {c.get("action") for c in bound}, where + ": action coverage drift")
            elif disposition == "excluded":
                require(row["contracts"] == [], where + ": excluded witness cannot bind contracts")
                refs(row["source_refs"], where)
                # A static literal HTTP/tool registration is an obligation; it
                # cannot disappear by being relabelled as a false positive.
                if group == "entries":
                    require(expected[identity]["kind"] not in {"http", "websocket", "tool"},
                            where + ": concrete entry cannot be excluded")
            else:
                require(row["contracts"] == [] and row["source_refs"] == [],
                        where + ": pending witness must not pretend to have coverage")
                pending.append({"kind": group, "id": identity})
            if disposition in counts:
                counts[disposition] += 1
        require(observed == set(expected), group + ": missing witnesses")
        summary[group] = counts
    require(used_contracts == set(contracts), "orphan contracts")

    cases = document["wire_cases"]
    seen_cases, exercised, exercised_entries = set(), set(), set()
    if require(isinstance(cases, list), "wire_cases must be a list"):
        for case in cases:
            if not keys(case, {"name", "entry_id", "args", "contract", "domain_mode"}, "wire case"):
                continue
            if not require(text(case["name"]) and case["name"] not in seen_cases, "duplicate/blank wire case"):
                continue
            seen_cases.add(case["name"])
            if not require(isinstance(case["args"], dict), "wire args must be object"):
                continue
            try:
                selected = select(document, case["entry_id"], case["args"])
                require(selected == [case["contract"]], "wire case selects zero/multiple/wrong contracts: " + case["name"])
                if case["contract"] in contracts:
                    exercised.add(case["contract"])
                    exercised_entries.add((case["contract"], case["entry_id"]))
                    require(case["domain_mode"] == contracts[case["contract"]]["domain_mode"],
                            "wire case domain-mode mismatch: " + case["name"])
            except (ValueError, KeyError, TypeError) as exc:
                errors.append("malformed wire case: " + str(exc))
    require(exercised == set(contracts), "contracts missing executable selector cases")
    require(exercised_entries == {(key, entry) for key, c in contracts.items() for entry in c.get("entry_ids", [])},
            "contract/entry pairs missing executable selector cases")
    return {"valid": not errors, "errors": errors, "contract_coverage_complete": not errors and not pending,
            "qualification": dict(GATES), "summary": summary, "contracts": len(contracts),
            "selector_cases": len(seen_cases), "pending": pending,
            "limits": ["Selector cases do not prove wire-result or transitive-contact parity.",
                       "Source assertions require review; this validator does not infer effects."]}


def check(repo, contracts_path, inventory_path):
    current = inventory.scan(repo)
    snapshot = load(inventory_path)
    source_check = inventory.compare(snapshot, current)
    result = validate(load(contracts_path), current, repo)
    if not source_check["matches"]:
        result["valid"] = False
        result["contract_coverage_complete"] = False
        result["errors"].append("committed source inventory drift: " + ", ".join(source_check["changed_sections"]))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--contracts", type=Path, default=Path("docs/state-system/operation-contracts.json"))
    parser.add_argument("--inventory", type=Path, default=Path("docs/state-system/operation-inventory.json"))
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--details", action="store_true", help="include every unresolved obligation")
    args = parser.parse_args(argv)
    try:
        result = check(args.repo.resolve(), args.repo / args.contracts, args.repo / args.inventory)
        result["pending_count"] = len(result["pending"])
        if not args.details:
            result.pop("pending")
        print(json.dumps(result, indent=2))
        return 1 if not result["valid"] else 3 if args.require_complete and not result["contract_coverage_complete"] else 0
    except (OSError, ValueError, SyntaxError, KeyError, TypeError) as exc:
        print(json.dumps({"valid": False, "error": str(exc), "qualification": dict(GATES)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
