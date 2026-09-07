# pyright: strict
"""One fixture per leaf, derived from the table so no leaf can be forgotten.

Values are DISTINCT per path (`<leaf>·<path>`), which makes the B16 walk the harshest
possible: a public string that the renderer does not print cannot hide behind a value
that happens to occur elsewhere in the text. A few leaves need coherent combinations
(a single-question answer, a terminal stall addressed to a superior); those are
overridden below. Step 3 replaces these with rows captured from the REAL producers
(design B16: fixture evidence is over actual producer fixtures); until then these are
the generator's own test data and nothing more.
"""

from __future__ import annotations

from typing import Any

from . import events_table as T
from .events import parse_type


def _value(t: dict[str, Any], path: str, leaf: str) -> Any:
    k = t["k"]
    if k == "str":
        return f"{leaf}·{path}"
    if k == "int":
        return 3
    if k == "float":
        return 2.5
    if k == "bool":
        return False
    if k == "lit":
        return t["vals"][0]
    if k == "list":
        return [_value(t["of"], f"{path}[0]", leaf)]
    if k == "ref":
        return _record(T.REFS[t["name"]], path, leaf)
    if k == "rec":
        fields = T.ACTOR if t["name"] == "Actor" else T.RECORDS[t["name"]]
        return _record(fields, path, leaf)
    if k == "union":
        return _record(T.RECORDS[T.UNIONS[t["name"]][0]], path, leaf)
    if k == "event":
        return None   # filled by the override below (context.notice_digest)
    raise ValueError(k)


def _record(fields: dict[str, dict[str, Any]], path: str, leaf: str) -> dict[str, Any]:
    return {n: _value(parse_type(str(f["t"])), f"{path}.{n}" if path else n, leaf)
            for n, f in fields.items()}


def _fixture(variant: str) -> dict[str, Any]:
    spec = T.LEAVES[variant]
    obj = spec["object"]
    return {
        "actor": {"kind": "agent", "id": f"{variant}·actor"},
        "object": _record(T.REFS[obj], "object", variant) if obj else None,
        "fields": {n: _value(parse_type(str(f["t"])), n, variant)
                   for n, f in spec["fields"].items()},
    }


FIXTURES: dict[str, dict[str, Any]] = {v: _fixture(v) for v in T.LEAVES}

# ---- coherent overrides (only where a leaf's renderer needs a valid combination)
_o: dict[str, Any] = FIXTURES["answer.ask"]["fields"]
_o.update(single=True, dismissed=False, text="answer.ask·text",
          questions=[{"label": None, "question": "answer.ask·q", "selected": ["answer.ask·sel"]}])
FIXTURES["answer.batch"]["fields"]["sections"] = [
    {"kind": "ask", "ask_id": "a1", "questions": [
        {"label": "Q1", "question": "answer.batch·q1", "answer": "answer.batch·a1"},
        {"label": "Q2", "question": "answer.batch·q2", "answer": None}]},
    {"kind": "credit", "outcome": "counter", "old": 2.0, "asked": 10.0, "granted": 5.0,
     "now": 5.0},
    {"kind": "scope", "lines": ["answer.batch·scope-line"],
     "decisions": [{"label": "answer.batch·dlabel", "decision": "approve"}]},
    {"kind": "skipped", "ask_id": "a2", "question": "answer.batch·skipped-q"},
]
FIXTURES["decision.credit"]["fields"].update(outcome="counter", old=2.0, asked=10.0,
                                             granted=5.0, now=5.0)
FIXTURES["decision.audience"]["fields"].update(granted=False, decided_by="decision.audience·by")
FIXTURES["access.audience_requested"]["fields"]["stage"] = "initial"
FIXTURES["access.audience_changed"]["fields"].update(outcome="audience_with")
FIXTURES["access.grant_changed"]["fields"]["relation"] = "self"
FIXTURES["lifecycle.hired"]["fields"].update(relation="report", grant=4.0)
FIXTURES["lifecycle.retired"]["fields"]["relation"] = "report"
FIXTURES["lifecycle.rehired"]["fields"]["relation"] = "report"
FIXTURES["lifecycle.dissolved"]["fields"]["relation"] = "report"
FIXTURES["lifecycle.deleted"]["fields"].update(relation="report", extra=2)
FIXTURES["lifecycle.compacted"]["fields"].update(relation="report", auto=True, lost=False,
                                                 size_note="; ~12k tokens summarized")
FIXTURES["lifecycle.cheap_compacted"]["fields"].update(relation="report")
FIXTURES["lifecycle.reseeded"]["fields"].update(relation="report")
FIXTURES["lifecycle.model_switched"]["fields"].update(
    relation="self", queued=True, crossed=True, old_provider="claude", new_provider="codex",
    predecessor="lifecycle.model_switched·pred")
FIXTURES["lifecycle.seat_swapped"]["fields"].update(
    role="a", nested=False, reports_to_after="lifecycle.seat_swapped·rta",
    grant_after="7", audience_note=" You keep a standing audience with \"b\".")
FIXTURES["lifecycle.moved"]["fields"].update(role="old_parent")
FIXTURES["lifecycle.inserted"]["fields"].update(role="self", grant_new="9", committed="4",
                                                grant_target="4")
FIXTURES["lifecycle.seat_swapped"]["fields"]["b"] = "b"
FIXTURES["policy.fable_flagged"]["fields"].update(audience="parent", outcome="autopsy")
FIXTURES["policy.weekly_limit"]["fields"].update(relation="report", outcome="dissolved",
                                                 nodes=2, freed="6")
FIXTURES["policy.unlocked"]["fields"]["relation"] = "report"
FIXTURES["policy.limit_reset"]["fields"].update(relation="report")
FIXTURES["monitor.watchdog_fired"]["fields"].update(count=1)
FIXTURES["runtime.report_stalled"]["fields"].update(cause="terminal", audience="superior")
FIXTURES["runtime.report_parked"]["fields"]["audience"] = "superior"
FIXTURES["runtime.report_limited"]["fields"]["audience"] = "superior"
FIXTURES["runtime.subagent_died"]["fields"].update(count=1)
FIXTURES["runtime.storage"]["fields"].update(level="over", scope="disk", used_mb=920.0,
                                             cap_mb=1000.0)
FIXTURES["runtime.delivery_unread"]["fields"]["boundary_for"] = "4s"
FIXTURES["reminder.idle_docket"]["fields"]["more"] = 1
FIXTURES["context.deep_reach"]["fields"]["kind"] = "message"
FIXTURES["context.notice_digest"]["fields"] = {
    "groups": [{"variant": "lifecycle.retired", "object_kind": "node",
                "members": [{"at": "2026-09-06T00:00:00Z",
                             "event": {"v": T.EVENT_V, "variant": "lifecycle.retired",
                                       "actor": {"kind": "user", "id": "@user"},
                                       "object": FIXTURES["lifecycle.retired"]["object"],
                                       "engine_authored": False,
                                       **FIXTURES["lifecycle.retired"]["fields"]}}]}],
    "untyped": 0,
}
for _v, _fx in FIXTURES.items():
    if _v.startswith(("runtime.", "reminder.", "context.", "monitor.")) \
            and _v not in ("context.command",):
        _fx["actor"] = {"kind": "system", "id": "@system"}
