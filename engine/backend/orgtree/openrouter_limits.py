# pyright: strict
"""OpenRouter credit standing, reshaped into the shared usage-board contract.

OpenRouter is a REST gateway on a PREPAID CREDIT BALANCE, not a subscription
with rolling percentage windows — there is no session/weekly lane to report.
`GET /api/v1/key` answers with cumulative USD spend on this key, an OPTIONAL
per-key spend cap (`limit`), and a cadence word for when that cap renews
(`limit_reset`, e.g. `"monthly"`). In addition, `GET /api/v1/credits` provides
the prepaid account balance (`total_credits` − `total_usage`), verified against
the live API on standard API keys.

This module never invents a `resets_at`: when a per-key cap exists, the limit
entry carries a percentage (spend ÷ cap); when drawing against the account's
prepaid balance, `percent` stays `None` and the honest credit usage and remaining
balance ride the label (`$X.XX credits used · $Y.YY remaining balance`), matching
the existing styling without fabricating rolling quota percentages or reset dates.

The fetch, its 60s cache and the key/network handling all live in
`openrouter` (`key_status`) — this module only reshapes that cache into the
`{available, limits[], plan}` shape `turnusage`/the modal already speak, and
adds the cache-only reads (`peek`, `snapshot`) the header glow and dynamic
turn envelope need, via `openrouter.cached_key_status`/`key_status_age` so
neither ever spends a request of its own.
"""

from __future__ import annotations

import datetime as _dt
import math
import time
from typing import Any, Final

from . import openrouter

PROVIDER: Final = "OpenRouter"
ACCOUNT: Final = "openrouter"
#: the codex/antigravity lanes' own threshold — a readout this old is a
#: memory, not a measurement, for the header glow and the turn board alike
MAX_EVIDENCE_AGE: Final = 900.0


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


def _f(value: Any) -> float | None:
    """A JSON number (never a bool) as a finite float, else None."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _severity(percent: float) -> str:
    if percent >= 90:
        return "critical"
    if percent >= 75:
        return "warning"
    return "normal"


def _limits(ks: dict[str, Any]) -> list[dict[str, Any]]:
    """One `usage` entry from a connected `/api/v1/key` and `/api/v1/credits`
    answer, or [] when it carries no usable spend figure at all.
    OpenRouter is a prepaid credit balance, not a rolling percentage window.
    An honest row shows credits used and remaining balance without inventing
    a reset window."""
    usage = _f(ks.get("usage"))
    if usage is None:
        return []
    total_credits = _f(ks.get("total_credits"))
    total_usage = _f(ks.get("total_usage"))
    balance: float | None = None
    if total_credits is not None and total_usage is not None:
        balance = max(0.0, total_credits - total_usage)
    limit = _f(ks.get("limit"))
    limit_remaining = _f(ks.get("limit_remaining"))

    # 1. Per-key spend cap (if configured on the API key)
    if limit is not None and limit > 0:
        percent = max(0.0, min(100.0, usage / limit * 100.0))
        label = f"${usage:.2f} of ${limit:.2f} spend cap"
        if balance is not None:
            label += f" · ${balance:.2f} balance"
        elif limit_remaining is not None:
            label += f" · ${limit_remaining:.2f} remaining"
        cadence = str(ks.get("limit_reset") or "").strip()
        if cadence:
            label += f" · renews {cadence}"
        is_active = percent >= 100.0 or (balance is not None and balance <= 0.0)
        sev = "critical" if is_active else _severity(percent)
        return [{"kind": "usage", "group": "credits", "percent": percent,
                 "severity": sev, "resets_at": None,
                 "is_active": is_active, "model": None,
                 "label": label}]

    # 2. Account prepaid balance (no per-key cap) — authoritative balance from /api/v1/credits
    if balance is not None:
        is_active = balance <= 0.0
        sev = "critical" if is_active else ("warning" if balance <= 1.0 else "normal")
        label = f"${usage:.2f} credits used · ${balance:.2f} remaining balance"
        return [{"kind": "usage", "group": "credits", "percent": None,
                 "severity": sev, "resets_at": None,
                 "is_active": is_active, "model": None,
                 "label": label}]

    # 3. Fallback when /api/v1/credits is unavailable:
    # report what the key CAN answer honestly rather than fabricate a percentage of nothing.
    return [{"kind": "usage", "group": "credits", "percent": None,
             "severity": "normal", "resets_at": None, "is_active": False,
             "model": None, "label": f"${usage:.2f} spent · no spend cap"}]


def _account(data: dict[str, Any], label: str | None = None) -> dict[str, Any]:
    return {"account": ACCOUNT, "label": label or "OpenRouter API key",
            "provider": PROVIDER, **data}


def _connected(ks: dict[str, Any]) -> bool:
    return ks.get("connected") is True


def fetch(force: bool = False) -> dict[str, Any]:
    """The header modal's section. `openrouter.key_status` owns the fetch and
    its 60s cache; this only reshapes the answer, the same split
    `codex_limits`/`antigravity_limits` keep from their own transports."""
    ks = openrouter.key_status(force=force)
    if not ks.get("key_set"):
        return _account({"available": False,
                         "error": ks.get("reason")
                         or "no API key — add one in App settings → "
                            "Providers"})
    if not _connected(ks):
        return _account({"available": False,
                         "error": ks.get("reason")
                         or "OpenRouter usage check failed"},
                        label=ks.get("label"))
    return _account({"available": True, "limits": _limits(ks),
                     "plan": "free tier" if ks.get("is_free_tier") else None},
                    label=ks.get("label"))


def peek() -> dict[str, Any]:
    """Cache-only read for the always-on header warning glow — never fetches
    (`openrouter.cached_key_status`)."""
    ks = openrouter.cached_key_status()
    if ks is None or not _connected(ks):
        return {"available": False, "provider": PROVIDER}
    age = openrouter.key_status_age()
    if age is None or age > MAX_EVIDENCE_AGE:
        return {"available": False, "provider": PROVIDER,
                "error": "OpenRouter usage readout is stale"}
    return {"available": True, "provider": PROVIDER, "limits": _limits(ks),
            "age": round(age, 1)}


def snapshot(now: float | None = None) -> dict[str, Any]:
    """Cache-only, timestamped OpenRouter evidence for dynamic turn
    envelopes — never fetches, matching `codex_limits.snapshot`."""
    now = time.time() if now is None else now
    ks = openrouter.cached_key_status()
    if ks is None or not _connected(ks):
        return {"available": False, "provider": PROVIDER, "limits": [],
                "observed_at": None, "age": None, "stale": False}
    raw_age = openrouter.key_status_age()
    age = max(0.0, raw_age) if raw_age is not None else None
    observed = max(1.0, now - age) if age is not None else None
    return {"available": True, "provider": PROVIDER, "limits": _limits(ks),
            "observed_at": _iso(observed) if observed else None,
            "age": age,
            "stale": bool(age is not None and age > MAX_EVIDENCE_AGE)}


def invalidate() -> None:
    """Tests only: forget the cached `/api/v1/key` answer."""
    openrouter.forget_key_status()
