"""Sparse watchdog settings and the persisted silence clock.

All new storage keys live here so the typed store can map them directly.
Timestamps use ledger.now()'s canonical UTC text, supplied by the caller.
"""
from datetime import datetime
from typing import Any, Mapping, MutableMapping


def epoch(stamp: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def silence(w: Mapping[str, Any]) -> bool:
    return w.get('fire_mode', 'event') == 'silence'


def settings(mode: Any, period: Any, stamp: str) -> dict[str, Any]:
    mode = 'event' if mode is None else mode
    if mode not in ('event', 'silence'):
        raise ValueError('fire_mode must be event or silence')
    if mode == 'event':
        if period is not None:
            raise ValueError('quiet_period_s is only for fire_mode=silence')
        return {}
    if isinstance(period, bool) or not isinstance(period, int) or period <= 0:
        raise ValueError('silence mode needs a positive integer quiet_period_s')
    return {'fire_mode': 'silence', 'quiet_period_s': period,
            'silence_since': stamp}


def reset(w: MutableMapping[str, Any], stamp: str) -> None:
    if silence(w):
        current = epoch(w.get('silence_since') or w.get('at'))
        incoming = epoch(stamp)
        if incoming is not None and (current is None or incoming >= current):
            w['silence_since'] = stamp


def due(w: Mapping[str, Any], now_t: float) -> bool:
    if not silence(w) or w.get('state') != 'armed':
        return False
    since = epoch(w.get('silence_since') or w.get('at'))
    period = w.get('quiet_period_s')
    return (since is not None and isinstance(period, int) and period > 0
            and now_t - since >= period)


def projection(w: Mapping[str, Any]) -> dict[str, Any]:
    return {'fire_mode': w.get('fire_mode', 'event'),
            **{key: w[key] for key in ('quiet_period_s', 'silence_since')
               if key in w}}
