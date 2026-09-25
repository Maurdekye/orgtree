"""The Q-C5 contact oracle: observed relations equal declared relations (r7 Q-C5,
S3 §7.1 extended; v6 PROFILING-AND-CONTACTS §"Contact and transaction records").

DECLARED side (p03-lead ruling 2026-09-25 08:08Z, M1 addendum; CONTRACT-M1 §5 r4):
each family exports a static table, reported in the harness handshake as
``declared``::

    {"<family>.<verb>": {
        "relations": {"<relation>": {"modes": ["read", "write", "for_share", ...],
                                     "required": true | false}},
        "p01_contract": "<contract id>" | None,
        "source": "r7 §x / S3 §y"}}

``required: true`` marks what the design makes mandatory on EVERY attempt that
reaches COMMIT (C3 caller and authority anchors, C2a version-row bumps, the E1.3
P8 head lock, the E7 receipt claim, the E8 kiosk-pool lock, the restriction_epoch
FOR SHARE of narrowing writers). ``store_schema::DECLARED_SERVER_SIDE`` entries
(triggers and CHECK functions) are merged into the declared set of every verb
that touches their table BEFORE it reaches this oracle.

OBSERVED side, from the trace (``trace.py``), per operation attempt:
- ``stmt`` records: the executor's labelled relations and mode (``read``/``write``),
  plus ``lock_mode`` when the statement takes a row lock;
- ``xact_stats`` records: the SERVER's per-transaction relation activity
  (``pg_stat_xact_user_tables`` read just before COMMIT; M1 §3, provisional). A
  relation with scans is a read, one with inserted/updated/deleted tuples is a
  write. It catches a trigger, function or nested adapter the executor's own
  statement map does not name (PROFILING:19);
- ``tx_end`` records: which attempts COMMITTED;
- ``conn_activity`` records, one per physical backend at run end: the server's
  own transaction count for that pid and the factory that opened it.

Verdicts:
- FAIL: an operation kind with no declared table;
- FAIL: an observed relation not declared, or a mode not declared for it;
- FAIL: a ``required: true`` relation not observed on an attempt that committed
  (the "omitted invariant read" control, v6 MIGRATION-AND-QUALIFICATION:66);
- FAIL: an operation that ends with ``contacts: 0`` (a pre-storage refusal) but
  has statements or transactions in the trace;
- FAIL, HIDDEN ACCESS: a backend whose server-side transaction count exceeds the
  transactions the trace attributes to it, a backend opened by an unregistered
  factory, or no ``conn_activity`` at all (M1 §4 amendment 6);
- REPORT only: a ``required: false`` relation never observed in the run.
A lock mode the trace marks ``unknown`` is not a pass: it is reported under
``unknown_modes`` and the run cannot claim that mode was checked.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

LOCK_MODES = ("for_key_share", "for_share", "for_no_key_update", "for_update")
MODES = ("read", "write") + LOCK_MODES
UNKNOWN = "unknown"


def declared_errors(declared: dict[str, Any]) -> list[str]:
    """Shape errors in a declared table (the handshake's ``declared``)."""
    errors = []
    if not isinstance(declared, dict) or not declared:
        return ["declared: must be a non-empty object"]
    for kind, spec in declared.items():
        rels = spec.get("relations") if isinstance(spec, dict) else None
        if not isinstance(rels, dict) or not rels:
            errors.append(f"declared {kind}: relations must be a non-empty object")
            continue
        for rel, r in rels.items():
            if not isinstance(r, dict) or not isinstance(r.get("required"), bool):
                errors.append(f"declared {kind}.{rel}: needs modes and a boolean required")
                continue
            modes = r.get("modes")
            if not isinstance(modes, list) or not modes or set(modes) - set(MODES):
                errors.append(f"declared {kind}.{rel}: modes must be a non-empty subset of {MODES}")
        if "p01_contract" not in spec or not str(spec.get("source") or "").strip():
            errors.append(f"declared {kind}: needs p01_contract (id or null) and a source")
    return errors


def _xact_modes(table: dict[str, Any]) -> set[str]:
    modes = set()
    if any(int(table.get(k) or 0) for k in ("seq_scan", "idx_scan", "seq_tup_read",
                                           "idx_tup_fetch")):
        modes.add("read")
    if any(int(table.get(k) or 0) for k in ("n_tup_ins", "n_tup_upd", "n_tup_del",
                                           "n_tup_hot_upd")):
        modes.add("write")
    return modes


def observed_contacts(records: Iterable[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
    """(operation_id, attempt) -> what the trace shows that attempt touched."""
    records = list(records)
    kind_of: dict[str, str] = {}
    contacts: dict[str, Any] = {}
    for r in records:
        if r.get("kind") == "op_begin":
            kind_of[r["operation_id"]] = r["op_kind"]
        elif r.get("kind") == "op_end":
            contacts[r["operation_id"]] = r.get("contacts")
    ops: dict[tuple[str, int], dict[str, Any]] = {}

    def slot(r: dict[str, Any]) -> dict[str, Any]:
        key = (r["operation_id"], int(r.get("attempt") or 1))
        if key not in ops:
            ops[key] = {"op_kind": kind_of.get(r["operation_id"]),
                        "executor": defaultdict(set), "server": defaultdict(set),
                        "stmts": 0, "txs": 0, "committed": False, "unknown_modes": set(),
                        "unresolved": set(), "contacts": contacts.get(r["operation_id"])}
        return ops[key]

    for r in records:
        k = r.get("kind")
        if k == "op_begin":
            slot(r)
        elif k == "tx_begin":
            slot(r)["txs"] += 1
        elif k == "tx_end":
            if r.get("outcome") == "commit":
                slot(r)["committed"] = True
        elif k == "stmt":
            s = slot(r)
            if r.get("infrastructure"):
                continue        # the executor's own trace.*/exec.* statements (system views)
            s["stmts"] += 1
            for name in r.get("unresolved") or []:
                s["unresolved"].add(name)
            rels = r.get("relations")
            if rels == UNKNOWN:
                s["executor"]["<unknown relations>"].add(r.get("mode"))
                continue
            per_rel = r.get("relation_modes")
            if isinstance(per_rel, dict):
                # the collector's derivation (store-trace sqlmap): modes per relation
                for rel, modes in per_rel.items():
                    s["executor"][rel].update(modes)
                continue
            for rel in rels or []:
                s["executor"][rel].add(r.get("mode"))
                lock = r.get("lock_mode")
                if lock == UNKNOWN:
                    s["unknown_modes"].add(rel)
                elif lock:
                    s["executor"][rel].add(lock)
        elif k == "xact_stats":
            s = slot(r)
            for t in r.get("tables") or []:
                for m in _xact_modes(t):
                    s["server"][t["relname"]].add(m)
    return ops


def q_c5(declared: dict[str, dict[str, Any]], records: list[dict[str, Any]],
         factories: Iterable[str]) -> dict[str, Any]:
    """The oracle's verdict over one run's trace."""
    failures = [f"invalid declared table: {e}" for e in declared_errors(declared)]
    if failures:
        return {"verdict": "FAILED", "failures": failures, "over_declared": {},
                "unknown_modes": {}, "operations": 0}
    seen: dict[str, set[str]] = defaultdict(set)
    unknown_modes: dict[str, list[str]] = {}
    ops = observed_contacts(records)
    for (op_id, attempt), s in sorted(ops.items()):
        kind = s["op_kind"]
        where = f"{kind or '?'} {op_id}#{attempt}"
        if kind not in declared:
            failures.append(f"{where}: operation kind has no declared contacts")
            continue
        spec = declared[kind]["relations"]
        touched = set()
        for source in ("executor", "server"):
            for rel, modes in s[source].items():
                modes = {m for m in modes if m}
                touched.add(rel)
                seen[kind].add(rel)
                if rel not in spec:
                    failures.append(f"{where}: {source} observed undeclared relation {rel} "
                                    f"({', '.join(sorted(modes))})")
                    continue
                extra = modes - set(spec[rel]["modes"])
                if extra:
                    failures.append(f"{where}: {source} observed {rel} as "
                                    f"{', '.join(sorted(extra))}, declared "
                                    f"{', '.join(sorted(spec[rel]['modes']))}")
        if s["unresolved"]:
            failures.append(f"{where}: statements name relations the deriver could not resolve: "
                            f"{', '.join(sorted(s['unresolved']))}")
        if s["committed"]:
            missing = sorted(rel for rel, r in spec.items() if r["required"] and rel not in touched)
            if missing:
                failures.append(f"{where}: committed without its required "
                                f"{', '.join(missing)} (omitted invariant)")
        if s["unknown_modes"]:
            unknown_modes[where] = sorted(s["unknown_modes"])
        if s["contacts"] == 0 and (s["stmts"] or s["txs"]):
            failures.append(f"{where}: reports zero contacts but has {s['stmts']} statements "
                            f"and {s['txs']} transactions")
    over_declared = {}
    for kind, spec in declared.items():
        if kind in seen:
            never = sorted(rel for rel, r in spec["relations"].items() if not r["required"]
                           and rel not in seen[kind])
            if never:
                over_declared[kind] = never
    # hidden access: the server's own per-backend transaction counts
    traced_tx: dict[int, int] = defaultdict(int)
    for r in records:
        if r.get("kind") == "tx_begin" and isinstance(r.get("backend_pid"), int):
            traced_tx[r["backend_pid"]] += 1
    registered = set(factories)
    activity = [r for r in records if r.get("kind") == "conn_activity"]
    if not activity:
        failures.append("no conn_activity records: hidden access cannot be ruled out")
    for a in activity:
        pid = a["backend_pid"]
        if a.get("factory") not in registered:
            failures.append(f"backend {pid}: opened by unregistered factory {a.get('factory')!r}")
        server = a.get("transactions")
        if not isinstance(server, int):
            failures.append(f"backend {pid}: server transaction count unknown")
        elif server > traced_tx.get(pid, 0):
            failures.append(f"backend {pid}: hidden access: the server saw {server} transactions, "
                            f"the trace attributes {traced_tx.get(pid, 0)}")
    return {"verdict": "PASSED" if not failures else "FAILED", "failures": failures,
            "over_declared": over_declared, "unknown_modes": unknown_modes,
            "operations": len(ops)}
