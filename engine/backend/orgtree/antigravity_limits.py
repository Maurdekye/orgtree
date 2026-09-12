# pyright: strict
"""Antigravity subscription usage from the CLI's local ``/usage`` command.

Current Antigravity CLI builds expose a read-only command through print mode:

    agy --print /usage --output-format json

The result contains structured quota groups and buckets, including each
bucket's remaining fraction and reset time. A real usage result also proves
that no model call was made: ``conversation_id`` is empty, ``num_turns`` is
zero, and every token counter is zero. This module requires those markers so
an upstream behavior change cannot quietly turn the usage poll into a billed
model turn.

The normalized shape matches ``limits`` and ``codex_limits`` so the modal,
header glow, freeze diagnostics, and dynamic turn envelope share a renderer.
Successful reads are cached for the polling cadence. Refresh failures may show
the last good board with an explicit error, but stale data never drives the
warning glow.

Quota-wall prose is still parsed at the turn boundary because it is immediate
reset evidence for freezing that turn. It is not used to estimate usage and is
never presented as the account's usage board.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import subprocess
import threading
import time
from typing import Any, Final, cast

from . import providers

PROVIDER: Final = "Antigravity"
ACCOUNT: Final = "antigravity"
CACHE_TTL: Final = 30.0
MAX_EVIDENCE_AGE: Final = 900.0
FETCH_TIMEOUT: Final = 20.0
MIN_USAGE_VERSION: Final = (1, 2, 0)

_UNIT_RE: Final = (r"(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)"
                   r"(?![a-z])")
_RESET_IN_RE: Final = re.compile(
    r"\bresets?\s+in\s+((?:\d+\s*" + _UNIT_RE
    + r"\s*,?\s*(?:and\s+)?)+)", re.IGNORECASE)
_PART_RE: Final = re.compile(r"(\d+)\s*" + _UNIT_RE, re.IGNORECASE)
_UNIT: Final = {"d": 86400.0, "h": 3600.0, "m": 60.0, "s": 1.0}

_lock = threading.Lock()
_fetch_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "data": None, "account": None}


def reset_in_seconds(text: str) -> float | None:
    """Seconds until a quota-wall message's ``Resets in ...`` deadline."""
    match = _RESET_IN_RE.search(text or "")
    if not match:
        return None
    total = 0.0
    for number, unit in _PART_RE.findall(match.group(1)):
        total += int(number) * _UNIT[unit[0].lower()]
    return total if total > 0 else None


def reset_at(text: str, now: float | None = None) -> float | None:
    """The absolute reset time named by quota-wall prose, if present."""
    seconds = reset_in_seconds(text)
    if seconds is None:
        return None
    return (time.time() if now is None else now) + seconds


def _iso(epoch: float) -> str | None:
    if epoch <= 0:
        return None
    try:
        return (_dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc)
                .isoformat().replace("+00:00", "Z"))
    except (OverflowError, OSError, ValueError):
        return None


def _reset_time(value: object) -> str | None:
    """Validate and normalize a provider reset timestamp without guessing."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    parse = raw[:-1] + "+00:00" if raw.endswith(("Z", "z")) else raw
    try:
        stamp = _dt.datetime.fromisoformat(parse)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    try:
        return stamp.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _severity(percent: float) -> str:
    if percent >= 90:
        return "critical"
    if percent >= 75:
        return "warning"
    return "normal"


def _window_kind(value: object) -> str:
    window = str(value or "").strip().lower()
    if window in {"5h", "5hr", "5-hour", "five-hour"}:
        return "session"
    if window in {"weekly", "week", "7d", "7-day"}:
        return "weekly_scoped"
    return "antigravity_window"


def _bucket_label(value: object) -> str:
    """Name a used-percent bar without preserving a misleading suffix."""
    raw = str(value or "usage limit").strip()
    label = re.sub(r"\s+limit\s+remaining\s*$", "", raw,
                   flags=re.IGNORECASE).strip()
    return label or "usage limit"


def _supports_usage(version: object) -> bool:
    """Only call /usage on CLI builds whose read-only behavior was verified."""
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", str(version or ""))
    if not match:
        return False
    return tuple(int(part) for part in match.groups()) >= MIN_USAGE_VERSION


def _account_key(status: dict[str, Any]) -> str | None:
    """Stable identity for cache isolation; never display or persist it."""
    if not status.get("installed") or not status.get("connected"):
        return None
    email = status.get("email")
    if not isinstance(email, str) or not email.strip():
        return None
    kind = str(status.get("kind") or "oauth").strip().casefold()
    return f"{kind}:{email.strip().casefold()}"


def _clear_unlocked() -> None:
    _cache.update(at=0.0, data=None, account=None)


def _reconcile_unlocked(account: str | None) -> dict[str, Any] | None:
    """Return cached data only when it belongs to this exact account."""
    cached = _cache.get("data")
    if isinstance(cached, dict) and _cache.get("account") == account \
            and account is not None:
        return cached
    if cached is not None:
        _clear_unlocked()
    return None


def _reconcile_observed_status_unlocked() -> dict[str, Any] | None:
    """Reconcile with status another surface observed, without a CLI call."""
    status = providers.antigravity_cached_status()
    if status is not None:
        _reconcile_unlocked(_account_key(status))
    return status


def _read_only(result: dict[str, Any]) -> bool:
    """Require the measured zero-turn/zero-token contract."""
    if result.get("conversation_id") != "":
        return False
    if result.get("num_turns") != 0:
        return False
    usage_any = result.get("usage")
    if not isinstance(usage_any, dict):
        return False
    usage = cast("dict[str, Any]", usage_any)
    token_fields = ("input_tokens", "output_tokens", "thinking_tokens",
                    "cache_read_tokens", "total_tokens")
    try:
        return all(float(usage.get(field, -1)) == 0 for field in token_fields)
    except (TypeError, ValueError):
        return False


def _normalize(result: dict[str, Any], observed_at: float) -> dict[str, Any]:
    """Normalize the structured ``/usage`` result into shared usage bars."""
    if str(result.get("status") or "").upper() != "SUCCESS":
        raise ValueError("Antigravity /usage did not report success")
    if not _read_only(result):
        raise ValueError("Antigravity /usage was not verified as a zero-token command")
    command_any = result.get("command")
    if not isinstance(command_any, dict) or command_any.get("name") != "usage":
        raise ValueError("Antigravity returned no structured /usage command result")
    data_any = command_any.get("data")
    if not isinstance(data_any, dict):
        raise ValueError("Antigravity returned no structured /usage data")
    groups_any = data_any.get("groups")
    if not isinstance(groups_any, list):
        raise ValueError("Antigravity returned no usage groups")

    limits: list[dict[str, Any]] = []
    for group_any in groups_any:
        if not isinstance(group_any, dict):
            continue
        group = cast("dict[str, Any]", group_any)
        group_name = str(group.get("name") or "Antigravity models").strip()
        buckets_any = group.get("buckets")
        if not isinstance(buckets_any, list):
            continue
        for bucket_any in buckets_any:
            if not isinstance(bucket_any, dict):
                continue
            bucket = cast("dict[str, Any]", bucket_any)
            try:
                remaining = float(bucket.get("remaining_fraction"))
            except (TypeError, ValueError):
                continue
            # Out-of-contract values are not percentages we can honestly
            # display. Skip them rather than inventing provider data.
            if not 0.0 <= remaining <= 1.0:
                continue
            percent = round((1.0 - remaining) * 100.0, 6)
            bucket_name = _bucket_label(bucket.get("name"))
            bucket_id = str(bucket.get("id") or bucket_name).strip()
            limits.append({
                "kind": _window_kind(bucket.get("window")),
                "group": bucket_id,
                "percent": percent,
                "severity": _severity(percent),
                "resets_at": _reset_time(bucket.get("reset_time")),
                "is_active": percent >= 100.0,
                "model": group_name,
                "label": f"{group_name} · {bucket_name}",
                "observed_at": observed_at,
            })
    return {"available": bool(limits), "limits": limits,
            "observed_at": _iso(observed_at)}


def _decode(stdout: str) -> dict[str, Any]:
    """Read JSON even if a future CLI prints a banner before the result."""
    lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            parsed: Any = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return cast("dict[str, Any]", parsed)
    raise ValueError("Antigravity /usage returned no JSON result")


def _run_usage(exe: str) -> dict[str, Any]:
    log_dir = providers.antigravity_probe_dir()
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "usage-probe.log")
    argv = providers.antigravity_argv(exe) + [
        "--log-file", log_path,
        "--print", "/usage",
        "--output-format", "json",
        "--print-timeout", "20s",
    ]
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=FETCH_TIMEOUT,
        cwd=log_dir, stdin=subprocess.DEVNULL,
        env=providers.antigravity_env(),
        creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                       if os.name == "nt" else 0))
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(
            f"Antigravity /usage exited {result.returncode}"
            + (f": {detail[:300]}" if detail else ""))
    return _decode(result.stdout)


def _account(data: dict[str, Any], status: dict[str, Any]) -> dict[str, Any]:
    return {
        "account": ACCOUNT,
        "label": status.get("email") or "signed-in account",
        "email": status.get("email") or None,
        "provider": PROVIDER,
        **data,
    }


def fetch(force: bool = False) -> dict[str, Any]:
    """Fetch the ambient signed-in account's real usage board."""
    now = time.time()
    status = providers.antigravity_status(force=force)
    account = _account_key(status)
    with _lock:
        cached = _reconcile_unlocked(account)

    if not status.get("installed"):
        with _lock:
            _clear_unlocked()
        return _account({"available": False,
                         "error": "Antigravity CLI is not installed"}, status)
    if not status.get("connected"):
        with _lock:
            _clear_unlocked()
        return _account({
            "available": False,
            "error": "Antigravity CLI is not signed in",
            "reauth_required": True,
            "reauth_evidence": "not_connected",
        }, status)
    if not _supports_usage(status.get("version")):
        with _lock:
            _clear_unlocked()
        return _account({
            "available": False,
            "unsupported": True,
            "error": ("Antigravity usage requires CLI 1.2.0 or newer; "
                      "update the Antigravity CLI to enable it"),
        }, status)
    if (not force and isinstance(cached, dict)
            and now - float(_cache.get("at") or 0) <= CACHE_TTL):
        return _account(dict(cached), status)

    with _fetch_lock:
        now = time.time()
        with _lock:
            cached = _reconcile_unlocked(account)
            if (not force and isinstance(cached, dict)
                    and now - float(_cache.get("at") or 0) <= CACHE_TTL):
                return _account(dict(cached), status)
        exe = status.get("path")
        if not isinstance(exe, str) or not exe:
            return _account({"available": False,
                             "error": "Antigravity CLI is not installed"}, status)
        try:
            raw = _run_usage(exe)
            observed = time.time()
            data = _normalize(raw, observed)
            if not data["available"]:
                data["error"] = "Antigravity reported no usage-limit windows"
            after = providers.antigravity_status(force=True)
            after_account = _account_key(after)
            if after_account is None or after_account != account:
                with _lock:
                    _clear_unlocked()
                return _account({
                    "available": False,
                    "error": ("Antigravity account changed during the usage "
                              "read; the result was not cached"),
                }, after)
            with _lock:
                _cache.update(at=observed, data=data, account=account)
            return _account(dict(data), after)
        except Exception as error:  # noqa: BLE001 - provider failures degrade the panel
            try:
                after = providers.antigravity_status(force=True)
            except Exception as status_error:  # noqa: BLE001 - refuse unverified fallback
                with _lock:
                    _clear_unlocked()
                return _account({
                    "available": False,
                    "error": ("Antigravity usage refresh failed: "
                              f"{error}; account recheck failed: {status_error}"),
                }, status)
            after_account = _account_key(after)
            with _lock:
                stale = _reconcile_unlocked(after_account)
            message = f"Antigravity usage refresh failed: {error}"
            if after_account == account and isinstance(stale, dict):
                return _account({**stale, "error": message}, after)
            return _account({"available": False, "error": message}, after)


def peek() -> dict[str, Any]:
    """Cache-only read for the always-on header warning glow."""
    with _lock:
        _reconcile_observed_status_unlocked()
        raw = _cache.get("data")
        age = time.time() - float(_cache.get("at") or 0)
        data = dict(raw) if isinstance(raw, dict) else None
    if data is None or not data.get("available"):
        return {"available": False, "provider": PROVIDER}
    if age > MAX_EVIDENCE_AGE:
        return {"available": False, "provider": PROVIDER,
                "error": "Antigravity usage readout is stale"}
    return {"available": True, "provider": PROVIDER,
            "limits": data.get("limits") or [], "age": round(age, 1)}


def snapshot(now: float | None = None) -> dict[str, Any]:
    """Cache-only timestamped evidence for dynamic turn envelopes."""
    now = time.time() if now is None else now
    with _lock:
        _reconcile_observed_status_unlocked()
        raw = _cache.get("data")
        observed = float(_cache.get("at") or 0.0)
        if not isinstance(raw, dict):
            return {"available": False, "provider": PROVIDER, "limits": [],
                    "observed_at": None, "age": None, "stale": False}
        data = dict(raw)
        data["limits"] = [dict(item) for item in raw.get("limits") or []
                          if isinstance(item, dict)]
    age = max(0.0, now - observed) if observed > 0 else None
    data.update(provider=PROVIDER, observed_at=_iso(observed), age=age,
                stale=bool(age is not None and age > MAX_EVIDENCE_AGE))
    return data


def observe_wall(message: str, *, tier: str = "",
                 now: float | None = None) -> float | None:
    """Return immediate freeze evidence from the failed turn's own prose."""
    del tier
    return reset_at(message, now)


def invalidate() -> None:
    """Clear cached usage evidence; the next modal/warm pass re-fetches it."""
    with _lock:
        _clear_unlocked()
