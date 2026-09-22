"""Report-side checks. These inspect observations, never implement product rules."""
from __future__ import annotations

import copy
import math
from collections import Counter


def distribution(values):
    values = sorted(values)
    if not values:
        return {"n": 0, "p50_ms": None, "p95_ms": None, "p99_ms": None, "max_ms": None}
    return {"n": len(values), **{
        name: round(values[max(0, math.ceil(len(values) * q) - 1)], 3)
        for name, q in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99), ("max_ms", 1))}}


def check_append(observed):
    errors = []
    expected = observed["expected_refs"]
    if not expected or len(set(expected)) != len(expected):
        errors.append("invalid expected operation denominator")
    if observed["completed"] != len(expected) or observed["failed"]:
        errors.append("not every offered operation completed successfully")
    if Counter(observed["actual_refs"]) != Counter(expected):
        errors.append("lost or duplicated committed evidence")
    if observed["final_rev"] - observed["initial_rev"] != len(expected):
        errors.append("committed revision delta differs from expected effects")
    return errors


def check_control(observed):
    errors = check_refusals(observed.get("refusal_snapshots",[]),
                            ["changed-payload","stale-revision","stale-authorization"])
    if observed["retry_effects"] != 1 or observed["replayed_attempts"] != observed["retry_attempts"]-1:
        errors.append("same-key retry applied other than one effect")
    if observed["changed_payload_status"] != 409 or "op_key conflict" not in observed["changed_payload_detail"]:
        errors.append("same-key changed payload was not refused")
    if observed["stale_authorization_status"] != 403 or "stale" not in observed["stale_authorization_detail"] or observed["revoked_effects"] != 0:
        errors.append("stale authority was accepted or caused an effect")
    if observed["fresh_authorization_status"] != 200:
        errors.append("fresh credential positive control failed")
    if observed["ordered_values"] != ["first", "second"]:
        errors.append("sequential read-after-write ordering failed")
    if observed["stale_revision_status"] != 422 or "rev" not in observed["stale_revision_detail"].lower() or observed["value_after_stale"] != "second":
        errors.append("stale revision overwrote current state")
    if observed["actual_control_rev"] != observed["expected_control_rev"]:
        errors.append("refused control mutated item revision")
    return errors


def check_recovery(observed):
    errors = check_refusals(observed.get("refusal_snapshots",[]),["old-epoch"])
    if observed["before_pid"] == observed["after_pid"]:
        errors.append("reopen did not use a new process")
    if observed["actual_refs"] != observed["expected_refs"] or observed["actual_rev"] != observed["expected_rev"]:
        errors.append("acknowledged state did not survive process reopen")
    if observed["receipt_state"] != "applied":
        errors.append("committed original-key receipt was not recovered")
    if observed["unknown_old_epoch_status"] != 422 or "epoch" not in observed["unknown_old_epoch_detail"].lower():
        errors.append("new execution under the prior process epoch was not refused")
    if observed["refs_after_refusal"] != observed["expected_refs"] or observed["rev_after_refusal"] != observed["expected_rev"]:
        errors.append("prior-epoch refusal caused a mutation")
    return errors


def check_refusals(rows, expected):
    errors = []
    if Counter(r["id"] for r in rows) != Counter(expected):
        errors.append("missing, unexpected or duplicate refusal snapshots")
    for row in rows:
        if row["before_rev"] != row["after_rev"] or row["before_sha256"] != row["after_sha256"]:
            errors.append(f"{row['id']} refusal changed the public item state")
    return errors


def negative_controls(append, control, recovery):
    """Corrupt observations to prove checker sensitivity, NOT product fault injection."""
    cases = [
        ("lost-update", append, check_append, lambda d: d["actual_refs"].pop()),
        ("duplicate-effect", append, check_append, lambda d: d["actual_refs"].append(d["actual_refs"][0])),
        ("missing-completion", append, check_append, lambda d: d.update(completed=0)),
        ("retry-duplicate", control, check_control, lambda d: d.update(retry_effects=2)),
        ("stale-authorization", control, check_control, lambda d: d.update(stale_authorization_status=200)),
        ("ordering", control, check_control, lambda d: d.update(ordered_values=["second", "first"])),
        ("stale-revision", control, check_control, lambda d: d.update(value_after_stale="stale")),
        ("recovery-loss", recovery, check_recovery, lambda d: d.update(actual_refs=[])),
        ("receipt-loss", recovery, check_recovery, lambda d: d.update(receipt_state="unknown")),
    ]
    rows = []
    for name, baseline, check, mutate in cases:
        good = not check(baseline)
        bad = copy.deepcopy(baseline)
        mutate(bad)
        errors = check(bad)
        rows.append({"id": name, "level": "component", "mechanism": "observation mutation",
                     "baseline_passed": good, "detected": bool(errors),
                     "classification": "expected_negative" if good and errors else "failed",
                     "errors": errors})
    return rows
