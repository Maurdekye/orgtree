"""The unsafe-control registry and its verdict rule (r7 §8.1, S3 §7, P03 gate G3).

An unsafe (negative) control is a deliberately broken variant: a named build
feature or configuration switch. It proves something only if it RAN and the
schedule's pass condition then FAILED. "A control that 'passes' without
evidence that it ran is a failed control."

So a control is accepted only when all three hold:
1. its run is complete-contact (every stream clean; ``trace.stream_health``);
2. at least one ``control_executed`` record names it, emitted at the exact code
   site where the unsafe behaviour runs (not at startup, not by the harness);
3. the schedule's pass condition failed in that run.
Anything else is a FAILED control, whatever the schedule reported.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Control:
    #: e.g. "Q-ST4.control"
    control_id: str
    #: the schedule it must break, e.g. "Q-ST4"
    schedule: str
    #: how it is switched on: a cargo feature or a runtime configuration key
    switch: str
    #: the code site that emits ``control_executed`` (for the reviewer)
    site: str
    #: the design's own words for what the control does
    wording: str


class Registry:
    def __init__(self) -> None:
        self._controls: dict[str, Control] = {}

    def register(self, control: Control) -> Control:
        if control.control_id in self._controls:
            raise ValueError(f"control {control.control_id} registered twice")
        for field in ("schedule", "switch", "site", "wording"):
            if not str(getattr(control, field)).strip():
                raise ValueError(f"control {control.control_id}: empty {field}")
        self._controls[control.control_id] = control
        return control

    def get(self, control_id: str) -> Control:
        try:
            return self._controls[control_id]
        except KeyError:
            raise KeyError(f"unregistered control {control_id!r}") from None

    def for_schedule(self, schedule: str) -> list[Control]:
        return [c for c in self._controls.values() if c.schedule == schedule]

    def __len__(self) -> int:
        return len(self._controls)


PASS_FAILED = "the schedule's pass condition failed"


def control_verdict(control: Control, result: Any) -> dict[str, Any]:
    """ACCEPTED only if the control provably ran, in the intended interleaving, on a
    complete-contact run, and the schedule's pass condition then FAILED.

    ``result`` is a ``schedule.RunResult`` from ``run_order`` on a build with the
    control switched on. Its pass condition is evaluated only when the run was
    structurally clean, so ``pass_condition_held is None`` means "never judged",
    which is never an acceptance."""
    records = result.records
    executed = [r for r in records if r.get("kind") == "control_executed"
                and r.get("control_id") == control.control_id]
    reasons = []
    if result.schedule_id != control.schedule:
        reasons.append(f"run is of {result.schedule_id}, the control breaks {control.schedule}")
    if result.verdict == "REFUSED":
        reasons.append("the run was refused: " + "; ".join(result.reasons))
    structural = [r for r in result.reasons if r != PASS_FAILED]
    if result.verdict != "REFUSED" and structural:
        reasons.append("not a valid control run: " + "; ".join(structural[:3]))
    if not executed:
        reasons.append("control did not run: no control_executed record")
    if result.pass_condition_held is None and not structural and result.verdict != "REFUSED":
        reasons.append("the pass condition was never judged")
    if result.pass_condition_held:
        reasons.append("the schedule's pass condition still held: the control did not break it")
    return {"control_id": control.control_id, "schedule": control.schedule,
            "order": result.order, "verdict": "ACCEPTED" if not reasons else "FAILED",
            "executed_records": len(executed), "reasons": reasons}
