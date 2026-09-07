# pyright: strict
"""What ORGTREE spent on the Antigravity lane, read off the receipts it
already writes.

`antigravity_limits` can say WHEN a window opened and when a wall closed it.
It cannot say what was spent in between - deliberately: `estimate()` takes a
`tokens_between` callable so the arithmetic can be driven with known numbers
in a test.  This module is the real one, and it reads nothing new: every
Antigravity turn already ends by journalling a synthetic usage record beside
the transcript, and those records are the only receipts that exist.

WHERE THE RECEIPTS ARE.  ``journals/projects/<org>/<session>.jsonl`` (the
supervisor's provider-neutral journal store).  The turn's last record is an
assistant row whose message id is ``agy-<turn>-usage``, carrying
``usage.{input_tokens, cache_read_input_tokens, output_tokens}``.

WARNING - THE TRAP, AND WHY MOST OF THIS FILE IS ABOUT IT.  Rows written
before 2026-09-04 hold SESSION-CUMULATIVE usage, not per-turn usage - the same
hazard `occupancy_of` documents at its ``agy-`` branch.  Summing them
overcounts wildly, and it does it QUIETLY: in the operator's live journals two
consecutive rows 40 seconds apart read 487,941 then 511,084 input tokens, so a
naive sum bills the first turn twice.  The marker that separates the two eras
is the ``last_prompt_tokens`` field, which only the new rows carry.

So this module counts ONLY marked rows, and it does NOT silently drop the
rest: an unmarked row inside the interval is returned as
``unsummable_receipts``.  A number that quietly skipped them would read as a
complete measurement of an interval it had only partly measured - the exact
shape of failure this codebase calls "present, plausible and inert".  The
caller is expected to degrade its confidence when that count is non-zero.

No network, no subprocess, no provider call: this is a read of local files.
"""

from __future__ import annotations

import datetime as _dt
import glob
import json
import os
from typing import Any, Final

#: every line is gated on these two byte substrings before it is parsed -
#: 222 MB of journals scan in a quarter of a second that way.  The gate is
#: NECESSARY BUT NOT SUFFICIENT: on the operator's live journals it admits 66
#: lines of which 65 are real receipts, so the parse below re-checks the id
#: rather than trusting the substring.
_GATE_A: Final = b'"agy-'
_GATE_B: Final = b'-usage"'


def _projects_root() -> str:
    # imported here, not at module scope: `supervisor` imports the antigravity
    # lane, so a module-level import would close the cycle.  The path is asked
    # of `journal_store()` rather than rebuilt from DATA_ROOT so that moving
    # the journal store moves this reader with it.
    from . import supervisor
    return os.path.join(supervisor.journal_store(), "projects")


def _epoch(stamp: object) -> float | None:
    """The journal's ISO instant as epoch seconds, or None."""
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.timestamp()


def _int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        return int(value)
    except (OverflowError, ValueError):
        return 0


def _is_per_turn(message: dict[str, Any]) -> bool:
    """Does this receipt hold THIS TURN's usage, or the session's running
    total?  The same question `occupancy_of` asks, answered the same way: only
    the post-2026-09-04 rows carry a numeric `last_prompt_tokens`, and only
    those rows are safe to add up.  A present-but-null value counts as
    unmarked, so such a receipt is reported as unsummable rather than
    trusted."""
    seen = message.get("last_prompt_tokens")
    return isinstance(seen, (int, float)) and not isinstance(seen, bool)


def _blank() -> dict[str, Any]:
    return {"tokens": 0, "input": 0, "cached": 0, "output": 0,
            "receipts": 0, "unsummable_receipts": 0, "sessions": 0,
            "scanned_files": 0}


def receipts_between(start: float, end: float) -> dict[str, Any]:
    """Antigravity token receipts stamped within ``[start, end)``.

    Returns the summable total AND the count of receipts that could not be
    summed, so a caller can tell a measured interval from a partly measured
    one.  `tokens` is input + cache-read + output: every token the requests
    carried.  Which of those the provider quota actually charges is NOT
    published anywhere orgtree can read, so this does not pretend to know -
    the components are returned separately for a caller that later learns.
    """
    tally = _blank()
    if not (end > start):
        return tally
    try:
        paths = glob.glob(os.path.join(_projects_root(), "*", "*.jsonl"))
    except (OSError, ImportError):
        return tally
    sessions: set[str] = set()
    for path in paths:
        try:
            # an append-only journal last written BEFORE the interval opened
            # cannot hold a row inside it.  This only ever skips files, never
            # rows: a file touched for any other reason is still read.
            if os.path.getmtime(path) < start:
                continue
        except OSError:
            continue
        tally["scanned_files"] += 1
        try:
            with open(path, "rb") as fh:
                for raw in fh:
                    if _GATE_A not in raw or _GATE_B not in raw:
                        continue
                    try:
                        row: object = json.loads(raw.decode("utf-8", "replace"))
                    except ValueError:
                        continue          # a torn line is not a reason to stop
                    if not isinstance(row, dict):
                        continue
                    rec: dict[str, Any] = {
                        str(k): v for k, v in row.items()}   # type: ignore[misc]
                    if rec.get("type") != "assistant":
                        continue
                    msg_raw = rec.get("message")
                    if not isinstance(msg_raw, dict):
                        continue
                    msg: dict[str, Any] = {
                        str(k): v for k, v in msg_raw.items()}   # type: ignore[misc]
                    mid = msg.get("id")
                    if not (isinstance(mid, str) and mid.startswith("agy-")
                            and mid.endswith("-usage")):
                        continue
                    at = _epoch(rec.get("timestamp"))
                    if at is None or at < start or at >= end:
                        continue
                    if not _is_per_turn(msg):
                        tally["unsummable_receipts"] += 1
                        continue
                    usage_raw = msg.get("usage")
                    usage: dict[str, Any] = (
                        {str(k): v for k, v in usage_raw.items()}   # type: ignore[misc]
                        if isinstance(usage_raw, dict) else {})
                    got_in = _int(usage.get("input_tokens"))
                    got_cached = _int(usage.get("cache_read_input_tokens"))
                    got_out = _int(usage.get("output_tokens"))
                    tally["input"] += got_in
                    tally["cached"] += got_cached
                    tally["output"] += got_out
                    tally["tokens"] += got_in + got_cached + got_out
                    tally["receipts"] += 1
                    sessions.add(os.path.basename(path))
        except OSError:
            continue
    tally["sessions"] = len(sessions)
    return tally


def tokens_between(start: float, end: float) -> dict[str, Any]:
    """The shape `antigravity_limits.estimate` wants: the same tally, passed
    through whole so the estimate can report its coverage instead of being
    handed a bare number that hides it."""
    return receipts_between(start, end)
