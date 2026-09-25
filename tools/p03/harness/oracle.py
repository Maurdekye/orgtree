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
  (``pg_stat_xact_user_tables`` read just before COMMIT; ADOPTED, decision 4). A
  relation with scans is a read, one with inserted/updated/deleted tuples is a
  write; scan TYPE is never evidence. It catches a trigger, function or nested
  adapter the executor's own statement map does not name (PROFILING:19);
- ``xact_locks`` records: the backend's own relation locks before COMMIT. The
  server shows ``RowShareLock`` for every FOR mode (measured), so it confirms
  the lock FAMILY only; the exact mode is the executor's, and the server-side
  exact mode is ``unknown`` unless a schedule samples ``pgrowlocks`` (decision 4);
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
- FAIL, LOCK FAMILY (when ``xact_locks`` is present): a relation the executor
  row-locks with no RowShareLock-or-stronger lock server-side; a RowShareLock
  on a relation for which no row-lock mode is declared (an undeclared lock);
  a committed attempt whose required row lock the server does not show. If an
  operation declares row-lock modes and a committed attempt has NO
  ``xact_locks``, the lock family is unverified: FAIL, never a default pass;
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
#: relation locks at least as strong as the RowShareLock every FOR clause takes
ROW_LOCK_FAMILY = {"RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareLock",
                   "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"}


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
                        "server_locks": None,   # None: the server's lock view never arrived
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
        elif k == "xact_locks":
            s = slot(r)
            if s["server_locks"] is None:
                s["server_locks"] = defaultdict(set)
            for lk in r.get("locks") or []:
                s["server_locks"][lk["relname"]].add(lk["mode"])
    return ops


def lock_family_failures(where: str, s: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    """The server-side lock-FAMILY cross-check (lead ruling, decision 4)."""
    declares_locks = any(set(r["modes"]) & set(LOCK_MODES) for r in spec.values())
    server = s["server_locks"]
    if server is None:
        if declares_locks and s["committed"]:
            return [f"{where}: row-lock family unverified: no server lock view (xact_locks) for a "
                    f"committed attempt of an operation that declares row locks"]
        return []
    out = []
    claimed = {rel for rel, modes in s["executor"].items() if modes & set(LOCK_MODES)}
    for rel in sorted(claimed):
        if not server.get(rel, set()) & ROW_LOCK_FAMILY:
            out.append(f"{where}: the executor row-locks {rel} but the server shows no "
                       f"RowShareLock-or-stronger lock on it")
    for rel, modes in sorted(server.items()):
        if "RowShareLock" in modes and rel not in claimed:
            declared = set(spec.get(rel, {}).get("modes", ())) & set(LOCK_MODES)
            if not declared:
                out.append(f"{where}: the server shows a row lock on {rel} that is declared "
                           f"nowhere (undeclared lock)")
    if s["committed"]:
        for rel, r in sorted(spec.items()):
            if r["required"] and set(r["modes"]) & set(LOCK_MODES) \
                    and not server.get(rel, set()) & ROW_LOCK_FAMILY:
                out.append(f"{where}: committed without the server showing its required row "
                           f"lock on {rel} (omitted anchor)")
    return out


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
        failures += lock_family_failures(where, s, spec)
        # the server confirms a lock FAMILY only: every exact row-lock mode it did not
        # sample (pgrowlocks) stays unknown server-side, and is reported as such
        server_exact = sorted(rel for rel, modes in s["executor"].items()
                              if modes & set(LOCK_MODES))
        if s["unknown_modes"] or server_exact:
            unknown_modes[where] = sorted(set(s["unknown_modes"]) | set(server_exact))
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
