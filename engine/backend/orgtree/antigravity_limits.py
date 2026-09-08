# pyright: strict
"""Antigravity account standing, OBSERVED from the wire — never fetched.

The Antigravity CLI publishes no usage readout orgtree can read headlessly.
Its changelog says the read-only slash commands (`/quota`, `/usage`,
`/credits`) answer in print mode "without spending quota", but measured
(1.1.24, 2026-09-03, walled Google account) each of them went to the MODEL
and came back with the wall itself as the error — so there is no cheap,
side-effect-free door this module could open, and it opens none: no process
is ever spawned here.

What it holds instead is the evidence the turns already carry:

  · A WALL. The ERROR result's message, measured 2026-09-03 02:36 local:
    "Individual quota reached. Please upgrade your subscription to increase
    your limits. Resets in 165h21m54s."  The leg folds it here as ONE window
    at 100% with the reset parsed out of "Resets in …" — the same instant the
    D-209 freeze then thaws on, instead of the blind 5-minute probe floor.
  · A SUCCESS. A completed turn after a wall means the wall is down (the
    reset passed, or the plan changed); the standing clears.

The normalized shape deliberately matches `codex_limits`/`limits` — one
renderer, one severity rule, one board formatter (`turnusage`).  The standing
survives a backend restart in a small JSON beside the provider's probe logs,
because unlike the other lanes nothing can re-fetch it.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import threading
import uuid
import time
from typing import Any, Final, TypedDict

from . import providers

PROVIDER: Final = "Antigravity"
ACCOUNT: Final = "antigravity"
#: a wall with NO parseable reset stays evidence this long (the codex lane's
#: evidence age); a wall WITH a reset stays until that instant passes.
MAX_EVIDENCE_AGE: Final = 900.0
#: the CLI phrases its reset as a duration — "Resets in 165h21m54s", also
#: "Resets in 2m", "in 45s", and defensively the worded forms ("in 2 hours 5
#: minutes", "in 1 day").  Anchored on the verb so "165h" inside a model name
#: or a path can never read as a reset.
#: ⚠ `(?![a-z])`, not `\b`, after the unit: in the CLI's compact form the
#: next digit follows the unit letter directly ("165h21m54s"), and there is
#: no word boundary between "h" and "2" — a `\b` read the measured specimen
#: as no reset at all.
_UNIT_RE: Final = (r"(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)"
                   r"(?![a-z])")
_RESET_IN_RE: Final = re.compile(
    r"\bresets?\s+in\s+((?:\d+\s*" + _UNIT_RE + r"\s*,?\s*(?:and\s+)?)+)",
    re.IGNORECASE)
_PART_RE: Final = re.compile(r"(\d+)\s*" + _UNIT_RE, re.IGNORECASE)
_UNIT: Final = {"d": 86400.0, "h": 3600.0, "m": 60.0, "s": 1.0}
#: the fake/legacy wording names its metric — surface it as the bar label
_METRIC_RE: Final = re.compile(r"limit\s+'([^']{1,60})'", re.IGNORECASE)


class _Wall(TypedDict):
    """One observed wall: the CLI's words, when, and the reset they named."""
    message: str
    observed_at: float
    resets_at: float | None
    tier: str
    id: str


_lock = threading.Lock()
_wall: _Wall | None = None
_ok_at: float | None = None
_loaded = False


def reset_in_seconds(text: str) -> float | None:
    """Seconds until the wall lifts, read from "Resets in …"; None when the
    text carries no such duration (or a zero one, which is not a reset)."""
    m = _RESET_IN_RE.search(text or "")
    if not m:
        return None
    total = 0.0
    for num, unit in _PART_RE.findall(m.group(1)):
        total += int(num) * _UNIT[unit[0].lower()]
    return total if total > 0 else None


def reset_at(text: str, now: float | None = None) -> float | None:
    """The reset instant behind the CLI's duration, against `now`."""
    secs = reset_in_seconds(text)
    if secs is None:
        return None
    return (time.time() if now is None else now) + secs


def _iso(epoch: Any) -> str | None:
    try:
        value = float(epoch)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    try:
        return _dt.datetime.fromtimestamp(
            value, tz=_dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _label(message: str) -> str:
    m = _METRIC_RE.search(message or "")
    if m:
        return m.group(1).strip().lower()
    return "individual quota"


def _number(value: object) -> float | None:
    """A JSON number (never a bool) as a float, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


# ── durability ──────────────────────────────────────────────────────────

def _path() -> str:
    return os.path.join(providers.antigravity_probe_dir(), "standing.json")


def _load_unlocked() -> None:
    global _wall, _ok_at, _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(_path(), encoding="utf-8") as f:
            raw: object = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(raw, dict):
        return
    doc: dict[str, object] = {str(k): v for k, v in raw.items()}  # type: ignore[misc]
    wall_raw = doc.get("wall")
    if isinstance(wall_raw, dict):
        fields: dict[str, object] = {
            str(k): v for k, v in wall_raw.items()}  # type: ignore[misc]
        observed = _number(fields.get("observed_at"))
        if observed is not None:
            _wall = {"message": str(fields.get("message") or "")[:300],
                     "observed_at": observed,
                     "resets_at": _number(fields.get("resets_at")),
                     "tier": str(fields.get("tier") or ""),
                     "id": str(fields.get("id") or "")}
    _ok_at = _number(doc.get("ok_at"))


def _save_unlocked() -> None:
    try:
        path = _path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"wall": _wall, "ok_at": _ok_at}, f)
        os.replace(tmp, path)
    except OSError:
        pass          # the in-memory standing still serves this process


def forget_memory() -> None:
    """Drop the in-process copy only — what a backend restart does. The file
    stays, and the next reader loads from it. A test hook, public so the
    restart proof does not have to reach into module state."""
    global _wall, _ok_at, _loaded
    with _lock:
        _wall, _ok_at, _loaded = None, None, False


# ── observed windows: the append-only record the estimator needs ────────
#
# WHY THIS FILE EXISTS AT ALL. `standing.json` holds the CURRENT wall and
# nothing else: `observe_wall` REPLACES it and `observe_clear` sets it to
# None, so the moment a turn succeeds the wall that stood is gone. That is
# right for the standing (a lifted wall must not keep glowing) and useless
# for measurement — you cannot calibrate a window you no longer have. So
# every observation is ALSO appended here, where nothing overwrites it.
#
# ⚠ BOUNDED, NOT UNLIMITED. An append-only file that only grows is a disk
# leak with a nice name. Two generations, capped by lines and bytes; the
# older generation is dropped, and the estimator says how many samples it
# actually had rather than pretending the record is complete.
#
# ⚠ NO SECRETS. The account is identified by a NAMESPACE HASH of the signed-in
# address, never the address: enough to notice "these observations are all the
# same account" or "the account changed under us", not enough to leak who it
# is into a file that gets pasted into bug reports.
#
# ⚠ NO ASSUMPTION OF ONE CEILING, AND NO ASSUMPTION OF TWO. Three different
# countdowns have now been observed on one account (165h21m54s on 2026-09-03,
# 3h20m48s on 2026-09-04, 3h36m14s on 2026-09-05). That is not evidence of
# three limits, or of two, or of one. The CLI states the time REMAINING until
# a reset, not the length of the window: two hits on the SAME limit print
# different durations whenever they land at different points in it, and two
# hits on DIFFERENT limits can print the same one. So each event stores its
# countdown as evidence and nothing here ever reads a countdown as proof that
# two observations share a ceiling. What this record can establish is
# DIFFERENCE - a different account, tier or named metric - and `_differs` says
# only that; the absence of a difference stays UNKNOWN.
MAX_EVENTS: Final = 400
MAX_EVENT_BYTES: Final = 262144


def _events_path() -> str:
    return os.path.join(providers.antigravity_probe_dir(), "windows.ndjson")


def _account_ns() -> str:
    """A stable, non-identifying handle for the signed-in account."""
    try:
        email = str(providers.antigravity_status().get("email") or "")
    except Exception:                                        # noqa: BLE001
        email = ""
    if not email:
        return ""
    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:12]


def _rotate_unlocked(path: str) -> None:
    """Keep the record bounded: one older generation, then drop."""
    try:
        if not os.path.exists(path):
            return
        if os.path.getsize(path) < MAX_EVENT_BYTES:
            with open(path, encoding="utf-8") as f:
                if sum(1 for _ in f) < MAX_EVENTS:
                    return
        os.replace(path, path + ".1")
    except OSError:
        pass


def _append_event(event: dict[str, Any]) -> None:
    """One observation, durably, best effort — never a reason a turn fails."""
    try:
        path = _events_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _rotate_unlocked(path)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except (OSError, TypeError, ValueError) as e:
        print(f"[orgtree] antigravity: window journal write failed: {e!r}")


def read_events() -> list[dict[str, Any]]:
    """Every retained observation, oldest first, across both generations."""
    out: list[dict[str, Any]] = []
    base = _events_path()
    for path in (base + ".1", base):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row: object = json.loads(line)
                    except ValueError:
                        continue          # a torn line, not a reason to stop
                    if isinstance(row, dict) and _number(row.get("at")):
                        out.append({str(k): v for k, v in row.items()})  # type: ignore[misc]
        except OSError:
            continue
    out.sort(key=lambda r: _number(r.get("at")) or 0.0)
    return out


def note_boot(now: float | None = None) -> None:
    """Mark that this process began observing.

    A gap between the previous event and a boot is a period in which orgtree
    was not watching. That is NOT the same as missing receipts — orgtree spent
    no tokens while it was down, so its own accounting is intact across a
    restart — but it IS a period in which a wall could have come and gone
    unseen, and a window whose start we inferred across one is worth less.
    Recorded so the estimator can say which, instead of averaging over it.

    Nothing is recorded on a machine that does not have the CLI: a boot marker
    for a lane that can never produce an observation is noise in a bounded
    record. Asking that question costs a status probe (a subprocess on a cold
    cache), which is why the caller runs this OFF the startup path.
    """
    try:
        installed = bool(providers.antigravity_status().get("installed"))
    except Exception:                                        # noqa: BLE001
        installed = False
    if not installed:
        return
    _append_event({"v": 1, "kind": "boot",
                   "at": time.time() if now is None else now,
                   "account_ns": _account_ns()})


def _window_event(kind: str, now: float, *, tier: str = "", message: str = "",
                  resets_at: float | None = None,
                  wall_id: str = "", after_wall: str = "") -> dict[str, Any]:
    event: dict[str, Any] = {
        "v": 1, "kind": kind, "at": now, "account_ns": _account_ns(),
        "tier": str(tier or ""),
        # the tier IS the model selector on this lane; recorded under its own
        # key so a future model split does not have to reinterpret `tier`
        "model": str(tier or "") or None,
    }
    if message:
        event["message"] = str(message)[:300]
        event["label"] = _label(message)
    if resets_at is not None:
        event["resets_at"] = resets_at
        # the DURATION the CLI actually named, which is what distinguishes one
        # limit from another; `resets_at` alone cannot, since it moves with now
        event["reset_seconds"] = round(resets_at - now, 3)
    if wall_id:
        event["wall_id"] = wall_id
    if after_wall:
        event["after_wall"] = after_wall
    return event


# ── intervals and the estimate ──────────────────────────────────────────
#
# THE ONE MEASURABLE QUANTITY: between an observed reset instant and a later
# wall, orgtree spent this many tokens. Nothing here is a provider-reported
# limit — that CLI publishes no readout — and the figure is a LOWER BOUND,
# since the same account is spendable in the Antigravity IDE, which orgtree
# cannot see. So any remaining-budget reading from it is optimistic, and that
# warning travels on the answer.


class Window(TypedDict):
    """One recorded INTERVAL: an observed reset instant, and a later wall.

    ⚠ NOT "one limit window". That name would assert two things nothing here
    records: that windows abut, so one limit's reset opens the next; and that
    the wall at the far end belongs to the same limit as the reset at the near
    end. `boundary` says how much of that is actually known.
    """
    # the metric the CLI named ON THE CLOSING WALL, EMPTY when it named
    # none. ⚠ No default here: a filled-in metric would manufacture agreement
    # at a boundary out of a fallback. The reading fallback lives in
    # `estimate`, where it is displayed and never compared.
    limit: str
    tier: str
    started_at: float | None   # when the interval opened, if we can tell
    start_kind: str            # how we know: "reset" | "boot" | "unknown"
    opened_by: dict[str, str]  # the identity that named the opening reset
    walled_at: float
    resets_at: float | None
    reset_seconds: float | None
    wall_id: str
    account_ns: str
    gap_before_s: float        # orgtree not observing, inside this interval
    reset_to_wall: bool        # an OBSERVED RESET at one end, a wall at the
    #                            other. That is the whole claim
    boundary: str              # "consistent" | "unknown" | "mismatch"
    boundary_differs: str | None   # what proved it: account | tier | metric


def _identity_differs(a: dict[str, str], b: dict[str, str]) -> str | None:
    """The first way two recorded identities are DEMONSTRABLY different, else
    None.

    ⚠ None means UNKNOWN, NOT "the same", and no caller may read it as licence
    to average or to certify continuity. A field EMPTY at either end decides
    nothing: it is a field that was not recorded, not a field that agreed. The
    countdown is not consulted in either direction - it is time REMAINING, so
    it moves with when the wall was hit.
    """
    for field, name in (("account_ns", "account"), ("tier", "tier"),
                        ("limit", "metric")):
        x, y = a.get(field) or "", b.get(field) or ""
        if x and y and x != y:
            return name
    return None


def _boundary(opened: dict[str, str],
              closed: dict[str, str]) -> tuple[str, str | None]:
    """How much is known about whether ONE limit spans an interval.

    "mismatch" - the reset that opened it and the wall that closed it are
    demonstrably different things, so the interval measures neither of them.
    "consistent" - account, tier and metric are recorded at BOTH ends and
    agree; that is agreement in the record, not continuity the provider
    stated. "unknown" - something was not recorded at one end, which proves
    nothing either way and is carried as unknown rather than settled.
    """
    differs = _identity_differs(opened, closed)
    if differs:
        return "mismatch", differs
    if all((opened.get(k) or "") and (closed.get(k) or "")
           for k in ("account_ns", "tier", "limit")):
        return "consistent", None
    return "unknown", None


def _differs(a: Window, b: Window) -> str | None:
    """The first way two recorded intervals are DEMONSTRABLY different, else
    None - which means UNKNOWN, never "the same". See `_identity_differs`."""
    return _identity_differs(
        {"account_ns": a["account_ns"], "tier": a["tier"],
         "limit": a["limit"]},
        {"account_ns": b["account_ns"], "tier": b["tier"],
         "limit": b["limit"]})


def windows(events: list[dict[str, Any]] | None = None) -> list[Window]:
    """Reconstruct the intervals the record supports.

    An interval ENDS at a wall - the only unambiguous event this lane
    produces. It BEGINS at the reset instant a previous wall named, else at
    the boot after which orgtree began watching, else unknown.

    ⚠ A RESET IS NOT A START CONTRACT FOR THE NEXT WALL. The CLI names when
    the wall it just reported lifts. It does not say that the next wall will
    be the same limit, and it does not say windows abut - so the reset is used
    as the near end of an INTERVAL, and `boundary` carries what is known about
    the two ends being one thing. Same tier is not an exception: a tier is not
    a limit identity either.
    """
    rows = read_events() if events is None else sorted(
        events, key=lambda r: _number(r.get("at")) or 0.0)
    out: list[Window] = []
    open_from: float | None = None          # when the interval began
    open_kind = "unknown"
    open_ident: dict[str, str] = {}         # who named the opening reset
    open_account = ""
    last_seen: float | None = None          # last moment we were observing
    gap = 0.0
    for row in rows:
        at = _number(row.get("at"))
        if at is None:
            continue
        account = str(row.get("account_ns") or "")
        # ⚠ AN INTERVAL DOES NOT SURVIVE A PROVEN ACCOUNT CHANGE: it would
        # time one account's spending from another account's refill. An EMPTY
        # handle is "could not tell", which is not evidence of a different
        # account - it does not break the interval, it leaves `boundary`
        # unknown, which is the honest record of not knowing.
        if open_account and account and account != open_account:
            open_from, open_kind, open_account, gap = None, "unknown", "", 0.0
            open_ident = {}
        kind = str(row.get("kind") or "")
        if kind == "boot":
            # time orgtree was not watching. It does NOT mean receipts are
            # missing - orgtree spends nothing while it is down - but a wall
            # could have passed unseen, so it rides on the interval.
            if last_seen is not None:
                gap += max(0.0, at - last_seen)
            if open_from is None:
                open_from, open_kind, open_ident = at, "boot", {}
                open_account = account or open_account
            last_seen = at
            continue
        last_seen = at
        if kind != "wall":
            continue
        resets = _number(row.get("resets_at"))
        closing = {"account_ns": account,
                   "tier": str(row.get("tier") or ""),
                   # ⚠ EMPTY WHEN UNRECORDED. Defaulting it here would let two
                   # rows that never named a metric read as agreeing on one.
                   "limit": str(row.get("label") or "")}
        # ⚠ ONLY A RESET IS A DEFENSIBLE NEAR END. A boot marks when orgtree
        # began WATCHING and can fall anywhere inside a window already
        # running, so timing from it measures a fraction and reports it as the
        # whole. Such an interval is still RECORDED, with its boot start.
        reset_to_wall = (open_kind == "reset" and open_from is not None
                         and open_from < at)
        boundary, differs = (_boundary(open_ident, closing)
                             if reset_to_wall else ("unknown", None))
        out.append({
            "limit": closing["limit"],
            "tier": closing["tier"],
            "started_at": open_from,
            "start_kind": open_kind if open_from is not None else "unknown",
            "opened_by": dict(open_ident),
            "walled_at": at,
            "resets_at": resets,
            "reset_seconds": _number(row.get("reset_seconds")),
            "wall_id": str(row.get("wall_id") or ""),
            "account_ns": account,
            "gap_before_s": round(gap, 3),
            "reset_to_wall": reset_to_wall,
            "boundary": boundary,
            "boundary_differs": differs,
        })
        # the next interval opens when THIS wall lifts. That instant is a
        # statement about THIS wall's limit and account, so it is carried with
        # them - the next wall is compared against it rather than assumed to
        # match it.
        open_from, open_kind, gap = resets, "reset", 0.0
        open_ident = dict(closing)
        open_account = account or open_account
    return out


def _receipt(value: Any) -> dict[str, Any] | None:
    """A `tokens_between` answer, normalized, or None when it is not one.

    A bare NUMBER is the whole answer and claims to have counted everything in
    the interval. A MAPPING may also report what it could NOT count, under
    `unsummable_receipts`; the real collector does, because Antigravity
    receipts written before 2026-09-04 hold session-cumulative usage and
    cannot be added up. Keeping that count is the whole point: a total that
    quietly dropped them would read as a complete measurement of an interval
    it had only partly measured.
    """
    tokens = _number(value)
    if tokens is not None:
        return {"tokens": int(tokens)}
    if isinstance(value, dict):
        fields: dict[str, Any] = {
            str(k): v for k, v in value.items()}          # type: ignore[misc]
        tokens = _number(fields.get("tokens"))
        if tokens is None:
            return None
        return {**fields, "tokens": int(tokens)}
    return None


_CONTINUITY_NOTE = {
    "consistent": ("the account, tier and named metric recorded at the reset "
                   "that opened this interval match those on the wall that "
                   "closed it - agreement in the record, not a continuity the "
                   "provider stated"),
    "unknown": ("whether ONE limit spans this interval is unknown: something "
                "was not recorded at one of its two ends, which neither "
                "establishes continuity nor disproves it"),
}


def estimate(events: list[dict[str, Any]] | None = None,
             tokens_between: Any = None,
             now: float | None = None) -> dict[str, Any]:
    """What the observed windows support, and nothing beyond it.

    `tokens_between(start, end)` returns the tokens ORGTREE spent in an
    interval — injected rather than imported so this stays a pure function of
    its evidence, and so a test can drive it with known numbers.

    A number is the whole answer; the real collector instead returns a MAPPING
    that also says what it could NOT count, and that shortfall is carried into
    `coverage` and caps the confidence (see `_receipt`).

    ⚠ ONE OBSERVATION, NEVER AN AVERAGE. This reports the LATEST interval
    that runs from an observed reset to a later wall, and only that one.
    Combining several would assert they describe one ceiling, which nothing
    recorded here can establish (`_differs`), and an average of two unrelated
    limits describes neither. `comparability` says "unknown" on every answer,
    and `limit_continuity` says whether even the two ENDS of the reported
    interval are known to be one limit.

    With no such interval it returns a refusal with a reason and NO number:
    one wall tells you a wall exists, not what it costs, and printing the
    first computable figure is how an inference becomes a ceiling nobody
    checks.
    """
    now = time.time() if now is None else now
    recorded = windows(events)
    # ⚠ A PROVEN MISMATCH IS NOT MEASURABLE. An interval opened by one limit's
    # reset and closed by a demonstrably different limit's wall measures
    # NEITHER of them, so it is dropped here rather than reported with a
    # caveat. An UNKNOWN boundary is kept and labelled: not knowing is not the
    # same as knowing they differ, and discarding it would throw away the only
    # evidence there is.
    measurable = [w for w in recorded
                  if w["reset_to_wall"] and w["boundary"] != "mismatch"]
    if not measurable:
        why = ("measuring needs an interval running from an OBSERVED RESET to "
               "a later wall, and the record holds none")
        boots = [w for w in recorded if w["start_kind"] == "boot"]
        if boots:
            why += (f"; {len(boots)} recorded interval(s) begin only at a "
                    "boot, which marks when orgtree began watching and can "
                    "fall anywhere inside a window already running")
        crossed = [w for w in recorded
                   if w["reset_to_wall"] and w["boundary"] == "mismatch"]
        if crossed:
            fields = sorted({str(w["boundary_differs"]) for w in crossed})
            n = len(crossed)
            why += (f"; {n} interval{'' if n == 1 else 's'} "
                    f"{'was' if n == 1 else 'were'} opened by one limit's "
                    f"reset and closed by a demonstrably different wall "
                    f"({', '.join(fields)}), which measures neither")
        return {"available": False, "samples": 0, "reason": why,
                "comparability": "unknown", "estimate": None}
    if tokens_between is None:
        return {"available": False, "samples": len(measurable),
                "reason": "no token receipts were supplied to measure with",
                "comparability": "unknown", "estimate": None}
    # ⚠ THE LATEST MEASURABLE INTERVAL, AND ONLY IT. Grouping and averaging
    # would assert the members share a ceiling, which nothing recorded here
    # establishes (`_differs`). One interval, measured, labelled as one.
    chosen = measurable[-1]
    start, end = chosen["started_at"], chosen["walled_at"]
    receipt: dict[str, Any] | None = None
    if start is not None:
        try:
            receipt = _receipt(tokens_between(start, end))
        except Exception:                                    # noqa: BLE001
            receipt = None
    if receipt is None:
        return {"available": False, "samples": 1,
                "reason": "no receipts could be read for that interval",
                "comparability": "unknown", "estimate": None}
    unsummable = int(_number(receipt.get("unsummable_receipts")) or 0)
    receipts_read = int(_number(receipt.get("receipts")) or 0)
    # A zero total is meaningful only when at least one receipt actually
    # contributed to the interval.  The collector's empty tally is also
    # ``tokens: 0``; treating that as a measured zero is the false ~0 reading
    # seen when a reset-to-wall interval contains no readable turns.
    if "receipts" in receipt and receipts_read <= 0:
        return {"available": False, "samples": 1,
                "reason": "no receipts could be read for that interval",
                "comparability": "unknown", "estimate": None}
    others = measurable[:-1]
    different = [w for w in others if _differs(chosen, w)]
    measured = [{"tokens": int(receipt["tokens"]),
                 "receipts": receipts_read,
                 "unsummable_receipts": unsummable,
                 "walled_at": chosen["walled_at"],
                 "gap_before_s": chosen["gap_before_s"],
                 "covered": chosen["gap_before_s"] <= 0.0,
                 # a window holding receipts we could not add up is measured
                 # IN PART, and the difference between a number and a number
                 # that lies is saying so
                 "partial": unsummable > 0}]
    uncovered = [m for m in measured if not m["covered"]]
    partial = [m for m in measured if m["partial"]]
    return {
        "available": True,
        # "observation", not "estimate": one window that was measured, not a
        # figure averaged over several assumed to describe the same thing
        "kind": "observation",
        # the reading fallback, applied HERE and only here: the comparison
        # above ran on what was actually recorded
        "limit": chosen["limit"] or "individual quota",
        "tier": chosen["tier"],
        "account_ns": chosen["account_ns"],
        "samples": 1,
        # a window measured only in part cannot read as a clean observation
        "confidence": "low" if partial else "experimental",
        # stated on every answer, so nobody has to infer it from a count
        "comparability": "unknown",
        # whether the reset that opened THIS interval and the wall that closed
        # it are even one limit: "consistent" (recorded and agreeing at both
        # ends) or "unknown" (something was not recorded at one end). Never
        # "mismatch" - those are refused above, not reported with a caveat.
        "limit_continuity": chosen["boundary"],
        "limit_continuity_note": _CONTINUITY_NOTE[chosen["boundary"]],
        "opened_by": chosen["opened_by"],
        "estimate": {"tokens": int(receipt["tokens"])},
        "reset_seconds": chosen["reset_seconds"],
        "observations": measured,
        "other_intervals": {
            "reset_to_wall": len(others),
            "demonstrably_different": len(different),
            "note": ("other recorded intervals are NOT combined with this "
                     "one: a different account, tier or named metric proves "
                     "some of them different, and nothing proves any of them "
                     "the same, so none corroborates this number"),
        },
        "comparability_note": (
            "the CLI states the time REMAINING until a reset, not the "
            "window's length, so two observations of one limit routinely "
            "print different durations and two observations of different "
            "limits can print the same one; countdown similarity is never "
            "read here as evidence that two windows share a ceiling"),
        # said on the face of it, every time, in the caller's words if it likes
        "basis": ("tokens ORGTREE spent between an observed reset and the "
                  "wall that followed it; the provider publishes no usage "
                  "readout, so this is an inference from observed walls, not "
                  "a reported limit"),
        "warning": ("a LOWER BOUND: the same account can be spent in the "
                    "Antigravity IDE, which orgtree cannot observe, so any "
                    "remaining-budget reading from this is optimistic"),
        "coverage": {
            "windows_with_unobserved_gaps": len(uncovered),
            "windows_partly_measured": len(partial),
            "receipts": sum(int(m["receipts"]) for m in measured),
            "unsummable_receipts": sum(
                int(m["unsummable_receipts"]) for m in measured),
            "note": ("a gap means orgtree was not running for part of the "
                     "interval, so a wall could have passed unseen; its own "
                     "receipts are still whole for the time it ran"),
            "unsummable_note": (
                "receipts orgtree holds for this interval but cannot add up: "
                "rows written before 2026-09-04 carry session-cumulative "
                "usage, not the turn's, so summing them would multiply the "
                "same tokens. They are counted, not hidden, and any window "
                "holding one is reported as measured in part"),
        },
    }


# ── observation (the leg's two calls) ───────────────────────────────────

def standing_estimate(now: float | None = None) -> dict[str, Any]:
    """`estimate()` wired to the REAL receipts: the one call a surface makes.

    The collector is imported here rather than at module scope so `estimate`
    itself stays a pure function of the evidence handed to it (that is what
    lets a test drive its arithmetic with known numbers), and so this module
    goes on not importing the supervisor.
    """
    from . import antigravity_receipts
    return estimate(None, antigravity_receipts.tokens_between, now)


def observe_wall(message: str, *, tier: str = "",
                 now: float | None = None) -> float | None:
    """A turn ended on a usage wall.  Records it and returns the reset
    instant parsed from the message, or None when it names none — the
    caller's freeze then falls to its own prose parse / probe floor."""
    global _wall
    now = time.time() if now is None else now
    ts = reset_at(message, now)
    wall_id = uuid.uuid4().hex[:12]
    with _lock:
        _load_unlocked()
        _wall = {"message": str(message or "")[:300], "observed_at": now,
                 "resets_at": ts, "tier": str(tier or ""), "id": wall_id}
        _save_unlocked()
    # the standing above is overwritten by the next observation; this is not
    _append_event(_window_event("wall", now, tier=tier, message=message,
                                resets_at=ts, wall_id=wall_id))
    return ts


def observe_clear(now: float | None = None) -> None:
    """A turn completed: whatever wall stood is down."""
    global _wall, _ok_at
    now = time.time() if now is None else now
    with _lock:
        _load_unlocked()
        changed = _wall is not None
        after = str((_wall or {}).get("id") or "") if changed else ""
        tier = str((_wall or {}).get("tier") or "") if changed else ""
        _wall = None
        _ok_at = now
        if changed:
            _save_unlocked()
    # only a clear that ENDED a wall closes a window; a successful turn with
    # nothing standing is not an observation about any limit
    if changed:
        _append_event(_window_event("clear", now, tier=tier, after_wall=after))


def _current(now: float) -> tuple[_Wall | None, bool]:
    """(the standing wall or None, stale?) — a wall whose reset has passed
    is presumed lifted; one that never named a reset ages out."""
    _load_unlocked()
    wall = _wall
    if wall is None:
        return None, False
    # the record itself, never a copy: observations REPLACE `_wall`, nothing
    # mutates one in place, so readers can hold it without a defensive copy
    resets = wall["resets_at"]
    if resets is not None:
        return (wall, False) if now < resets else (None, False)
    return wall, now - wall["observed_at"] > MAX_EVIDENCE_AGE


def _limits(wall: _Wall) -> list[dict[str, Any]]:
    return [{
        # the CLI states remaining time, never the window's length, so the
        # kind is the provider-specific one — a 165-hour reset is not proof
        # of a weekly lane, and `session` would be a guess in the other
        # direction
        "kind": "provider_window",
        "group": ACCOUNT,
        "percent": 100.0,
        "severity": "critical",
        "resets_at": _iso(wall["resets_at"]),
        "is_active": True,
        "model": None,
        "label": _label(wall["message"]),
    }]


def _account(data: dict[str, Any]) -> dict[str, Any]:
    status = providers.antigravity_status()
    return {"account": ACCOUNT,
            "label": status.get("email") or "signed-in account",
            "provider": PROVIDER, **data}


# ── readers (modal, glow, turn envelope) ────────────────────────────────

def fetch(force: bool = False) -> dict[str, Any]:
    """The header modal's section.  Cache-only by construction (see the
    module docstring); `force` exists for signature parity and does nothing
    more than a plain read."""
    del force
    status = providers.antigravity_status()
    if not status.get("installed"):
        return _account({"available": False,
                         "error": "Antigravity CLI is not installed"})
    if not status.get("connected"):
        return _account({"available": False,
                         "error": "Antigravity CLI is not signed in"})
    now = time.time()
    with _lock:
        wall, stale = _current(now)
        ok_at = _ok_at
    if wall is None:
        last_ok = _iso(ok_at) if ok_at else None
        return _account({
            "available": False,
            # a settled fact, not an outage: the CLI exposes no readout
            "unsupported": True,
            "error": ("Antigravity publishes no usage readout; a quota wall "
                      "appears here when a turn hits one, with its reset"
                      + (f" — last successful turn {last_ok}" if last_ok
                         else "")),
        })
    data: dict[str, Any] = {"available": True, "limits": _limits(wall),
                            "observed_at": _iso(wall["observed_at"])}
    if stale:
        data["error"] = "the last observed wall named no reset and is old"
    return _account(data)


def peek() -> dict[str, Any]:
    """Cache-only read for the always-on header warning glow."""
    now = time.time()
    with _lock:
        wall, stale = _current(now)
    if wall is None or stale:
        return {"available": False, "provider": PROVIDER}
    return {"available": True, "provider": PROVIDER,
            "limits": _limits(wall),
            "age": round(now - wall["observed_at"], 1)}


def snapshot(now: float | None = None) -> dict[str, Any]:
    """Timestamped evidence for the dynamic turn envelope (`turnusage`).

    `unsupported: True` marks "nothing was ever observed" — the board keeps
    its explicit unsupported row for that, so a machine that never hit a wall
    renders byte-identical to before this module existed."""
    now = time.time() if now is None else now
    with _lock:
        wall, stale = _current(now)
        observed = _wall is not None
    if wall is None:
        return {"available": False, "provider": PROVIDER, "limits": [],
                "observed_at": None, "age": None, "stale": False,
                "unsupported": not observed}
    at = wall["observed_at"]
    return {"available": True, "provider": PROVIDER, "limits": _limits(wall),
            "observed_at": _iso(at), "age": max(0.0, now - at),
            "stale": stale, "unsupported": False}


def invalidate() -> None:
    """Forget everything, in memory AND on disk (tests, and a sign-out)."""
    global _wall, _ok_at, _loaded
    with _lock:
        _wall, _ok_at, _loaded = None, None, True
        try:
            os.remove(_path())
        except OSError:
            pass
