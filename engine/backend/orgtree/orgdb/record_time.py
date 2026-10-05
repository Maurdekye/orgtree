"""Clock crossings for Python record bodies, without changing persisted state.

The host supplies decoded source rows on its database transaction. These
functions compute candidate crossings; body builders still own display rules.
Panel extensions may add their own candidates to the same Plan. A durable
watermark (rather than the host's boot time) will delimit published crossings.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math


UTC = timezone.utc
Record = tuple[str, str]


@dataclass(frozen=True)
class Boundary:
    at: datetime
    records: frozenset[Record]

    def __post_init__(self):
        if self.at.tzinfo is None or not self.records:
            raise ValueError('a boundary needs an aware time and record keys')


def instant(value):
    """A finite persisted epoch, with datetime's actual clock precision."""
    try:
        value = float(value)
        return datetime.fromtimestamp(value, UTC) if math.isfinite(value) else None
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def ask_expiry(stamp):
    """Match node_ask's whole-second, lexical cutoff, including old stamps.

    It compares the wall prefix, not the parsed UTC offset. Fractional stamps
    sort BEFORE the same second's Z cutoff; a legacy whole-second Z stamp
    sorts equal and survives one more second. Imported malformed dates still
    have lexical crossings (2026-99 expires when the cutoff reaches 2027).
    """
    if not isinstance(stamp, str):
        return None
    try:
        wall = datetime.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=UTC)
        if wall.isoformat(timespec='seconds')[:19] == stamp[:19]:
            return wall + timedelta(seconds=900 + int(stamp[19:] >= 'Z'))
    except (ValueError, OverflowError):
        pass
    # Only rare, noncanonical prefixes need this search. The cutoff text is
    # monotonic over integral seconds, so find its first value > the source
    # string. Date arithmetic works for old dates on Windows too.
    origin = datetime(1,1,1,tzinfo=UTC)
    high = int((datetime(9999,12,31,23,59,59,tzinfo=UTC)-origin).total_seconds())
    low = 0
    def cutoff(second):
        return (origin+timedelta(seconds=second)).isoformat(timespec='seconds')[:19]+'Z'
    if cutoff(high) <= stamp:
        return None
    while low < high:
        middle = (low+high)//2
        if cutoff(middle) > stamp:
            high = middle
        else:
            low = middle+1
    try:
        return origin+timedelta(seconds=low+900)
    except OverflowError:
        return None


def asks(rows, agent_ids, session_began):
    """Latest resolved desk card per agent; open batches suppress its linger.

    Rows carry kind=ask|credits|scope and decoded original timestamp strings.
    Inputs contain the same three request pools as node_ask; keys are database
    IDs, while node names only select their request records.
    """
    grouped = {}
    for row in rows:
        grouped.setdefault(row['node'], []).append(row)
    result = []
    for name, pool in grouped.items():
        key = agent_ids.get(name)
        if key is None or any(r['status'] == ('open' if r['kind'] == 'ask' else 'pending')
                              for r in pool):
            continue
        eligible = [r for r in pool if r['kind'] == 'ask' or r['status'] != 'withdrawn']
        if not eligible:
            continue
        best = max(eligible, key=lambda r: str(r.get('resolved_at') or r['at']))
        stamp = best.get('resolved_at') or best['at']
        if not isinstance(stamp, str) or stamp < str(session_began.get(name) or ''):
            continue
        at = ask_expiry(stamp)
        if at is not None:
            result.append(Boundary(at, frozenset((('agent',str(key)),))))
    return result


def tombs(rows):
    """Future tombs enter at spent_at; visible tombs leave strictly after TTL."""
    from ..ledger import Org  # noqa: PLC0415
    result = []
    for row in rows:
        try:
            at = datetime.strptime(str(row.get('spent_at'))[:23],
                                   '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=UTC)
            end = at + timedelta(seconds=Org.WATCHDOG_TOMB_TTL_S, microseconds=1)
        except (TypeError, ValueError, OverflowError):
            continue
        keys = frozenset((('org','watchdogs'),))
        result.extend((Boundary(at,keys), Boundary(end,keys)))
    return result


def docket(deadlines):
    """The indexed docket predicate is deadline < now, with attention gating.

    The reader supplies only active, non-attention rows. Naming work_item also
    lets the panel extension route a departure after it has left its window.
    """
    return [Boundary(at + timedelta(microseconds=1),
                     frozenset((('org','work_summary'), ('work_item',str(key)))))
            for key,at in deadlines if at is not None and at.year > 1 and at.year < 9999]


def fable(lock):
    if not lock or lock.get('no_reset') or not lock.get('until_ts'):
        return []
    at = instant(lock['until_ts'])
    return [] if at is None else [Boundary(at,frozenset((('org','foreground'),('agent','*'))))]


def freezes(rows):
    """Name only actual clock changes in the existing record-only ranking.

    Passing a promised wake does not by itself change its displayed deadline.
    An own deadline entering MAX_HORIZON can change the rank. Consult the
    shared rule on either side; never release or rewrite a frozen agent here.
    """
    from .. import limits, supervisor  # noqa: PLC0415
    result = []
    for key,freeze in rows:
        if not isinstance(freeze,dict):
            continue
        own = instant(freeze.get('until_ts'))
        if own is None:
            continue
        try:
            at = own - timedelta(seconds=limits.MAX_HORIZON)
            before = supervisor.effective_freeze_deadline(freeze,None,
                (at-timedelta(microseconds=1)).timestamp())
            after = supervisor.effective_freeze_deadline(freeze,None,at.timestamp())
        except (ValueError, TypeError, OverflowError):
            continue
        if before != after:
            result.append(Boundary(at,frozenset((('agent',str(key)),))))
    return result


class Plan:
    """Deduplicate simultaneous candidates and delimit a durable clock span."""
    def __init__(self, candidates):
        grouped = {}
        for boundary in candidates:
            grouped.setdefault(boundary.at,set()).update(boundary.records)
        self.boundaries = tuple(Boundary(at,frozenset(keys))
                                for at,keys in sorted(grouped.items()))

    def due(self, watermark, now):
        if now < watermark:
            return frozenset()
        return frozenset(key for boundary in self.boundaries
                         if watermark < boundary.at <= now for key in boundary.records)

    def next(self, now):
        return next((b.at for b in self.boundaries if b.at > now),None)
