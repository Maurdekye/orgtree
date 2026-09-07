# pyright: strict
"""Secret-free provider usage evidence for dynamic agent turn envelopes.

This module only reads caches and durable local routing state.  It never
fetches provider usage, opens a CLI, or sees a credential.  The rendered text
belongs in a user event; it must never be folded into the managed identity,
tool schema, argv, environment, session id, or warm-process hash.
"""

from __future__ import annotations

import datetime as _dt
import math
import threading
import time
from typing import Any, Final, cast

from . import accounts, antigravity_limits, codex_limits, limits
from .ledger import Org

OPEN: Final = "[PROVIDER USAGE"
CLOSE: Final = "[END PROVIDER USAGE]"

_PROVIDER_ORDER: Final = {"claude": 0, "codex": 1, "antigravity": 2}
_WINDOW_ORDER: Final = {
    "session": 0,
    "weekly_all": 1,
    "weekly_scoped": 2,
    "codex_window": 3,
    "provider_window": 4,
    "usage": 5,
}
_SAFE_MODELS: Final = {
    "fable", "opus", "sonnet", "haiku",
    "gpt-reserve", "sol", "terra", "luna", "flash", "pro",
}


def _iso(epoch: float) -> str:
    # ROUND, don't truncate. `timespec="seconds"` floors, so an upstream
    # deadline of …08:59:59.98 printed as `08:59:59Z` — a second early, and on
    # the next poll the same fixed boundary printed `09:00:00Z`. The Anthropic
    # usage endpoint recomputes `resets_at` per response with microsecond
    # jitter around the boundary (measured 2026-09-04: two windows carrying
    # fractions 20µs apart), so a FIXED weekly reset appeared to move by a
    # second — which is what made a genuine early reset look like a bug and
    # cost an investigation. Rounding puts both sides of the jitter on the
    # boundary they actually mean.
    try:
        return (_dt.datetime.fromtimestamp(round(epoch), _dt.timezone.utc)
                .isoformat(timespec="seconds").replace("+00:00", "Z"))
    except (OverflowError, OSError, ValueError):
        return "-"


def _epoch(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    try:
        number = parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _countdown(epoch: float, now: float) -> str:
    delta = epoch - now
    sign = "+" if delta >= 0 else "-"
    seconds = int(abs(delta))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        body = f"{days}d{hours}h"
    elif hours:
        body = f"{hours}h{minutes}m"
    elif minutes:
        body = f"{minutes}m"
    else:
        body = "<1m"
    return sign + body


def _reset_cell(value: Any, now: float) -> str:
    epoch = _epoch(value)
    return "-" if epoch is None else f"{_iso(epoch)} ({_countdown(epoch, now)})"


def _percent(value: Any) -> tuple[float | None, str]:
    if isinstance(value, bool):
        return None, "unavailable"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None, "unavailable"
    if not math.isfinite(number) or not 0.0 <= number <= 100.0:
        return None, "unavailable"
    shown = f"{number:.1f}".rstrip("0").rstrip(".")
    return number, shown + "%"


def _window(limit: dict[str, Any]) -> str:
    raw = str(limit.get("kind") or "")
    kind = raw if raw in _WINDOW_ORDER else "provider_window"
    model = str(limit.get("model") or "").strip().lower()
    if model in _SAFE_MODELS:
        return f"{kind}:{model}"
    return kind


def _seen(snapshot: dict[str, Any], now: float) -> tuple[str, bool]:
    observed = _epoch(snapshot.get("observed_at"))
    age_raw = snapshot.get("age")
    try:
        age = float(age_raw) if age_raw is not None else None
    except (TypeError, ValueError):
        age = None
    if age is not None and (not math.isfinite(age) or age < 0):
        age = None
    if observed is None and age is not None:
        observed = max(1.0, now - age)
    stale = bool(snapshot.get("stale"))
    if observed is None:
        return "-", stale
    age_text = "?" if age is None else f"{int(age)}s"
    freshness = "stale" if stale else "fresh"
    return f"{_iso(observed)} ({age_text},{freshness})", stale


#: STRUCTURED ROW RECORDS (design family context_change, `context.provider_usage`).
#: `_line` is the ONE place a board row is rendered, so it is the one place its
#: facts exist un-rendered: it records them here keyed by the EXACT line it
#: returned, and `board_rows` maps the rendered lines back by identity — a dict
#: lookup on the whole string, never a parse of it. Thread-local because boards
#: for different turns render concurrently; `board` clears it at the start.
_tl = threading.local()


def _recs() -> dict[str, dict[str, Any]]:
    d = getattr(_tl, "recs", None)
    if d is None:
        d = _tl.recs = {}
    return d


def _line(provider: str, lane: str, window: str, used: str,
          amount: str, reset: str, observed: str, state: str,
          *, selected: bool = False) -> str:
    marker = "*" if selected else ""
    line = (f"{provider}/{lane}{marker} | {window} | {used} | {amount} | "
            f"{reset} | {observed} | {state}")
    try:
        pct = float(used[:-1]) if used.endswith("%") else None
    except ValueError:
        pct = None
    _recs()[line] = {"provider": provider, "lane": lane, "window": window,
                     "used_pct": (float(pct) if pct is not None else None),
                     "amount": (None if amount in ("", "-") else amount),
                     "reset_at": (None if reset in ("", "-") else reset),
                     "observed_at": (None if observed in ("", "-") else observed),
                     "state": state}
    return line


def board_rows(text: str) -> list[dict[str, Any]]:
    """The UsageRow records of a board rendered ON THIS THREAD by the last
    `board(...)` call, in the board's own order. Lines the recorder never
    produced (the header, the footer, a failure block) are simply absent;
    nothing is parsed."""
    recs = _recs()
    return [dict(recs[ln]) for ln in text.splitlines() if ln in recs]


def _row_order(item: tuple[tuple[Any, ...], str]) -> tuple[Any, ...]:
    """Provider order plus Claude's semantic account priority.

    Lexical order would put ``fallback-1`` before ``primary``.  The account
    registry's priority is the fact agents need: primary, fallback ordinal,
    then this org's API-key lane.
    """
    key = item[0]
    provider_rank = int(cast(int, key[0]))
    lane = str(key[1])
    lane_rank = 0
    if provider_rank == _PROVIDER_ORDER["claude"]:
        if lane == "primary":
            lane_rank = 0
        elif lane.startswith("fallback-"):
            try:
                lane_rank = int(lane.split("-", 1)[1])
            except ValueError:
                lane_rank = 90
        elif lane == "fallbacks":
            lane_rank = 90
        elif lane == "org-api-key":
            lane_rank = 100
        else:
            lane_rank = 99
    return (provider_rank, lane_rank, lane, *key[2:])


def _cached_rows(snapshot: dict[str, Any], provider: str, lane: str,
                 now: float, selected: bool, frozen: bool,
                 freeze_reset: Any = None) -> list[tuple[tuple[Any, ...], str]]:
    observed, stale = _seen(snapshot, now)
    raw_limits = snapshot.get("limits")
    limits_list = ([cast("dict[str, Any]", x) for x in raw_limits
                    if isinstance(x, dict)]
                   if isinstance(raw_limits, list) else [])
    if not snapshot.get("available") or not limits_list:
        reason = ("unavailable(stale)" if stale else
                  "unavailable(no-cache)")
        state = "frozen" if selected and frozen else (
            "stale" if stale else "unavailable")
        line = _line(provider, lane, "usage", reason, "-",
                     _reset_cell(freeze_reset, now) if frozen else "-",
                     observed, state, selected=selected)
        return [((_PROVIDER_ORDER[provider], lane, 99, "", 0), line)]

    normalized: list[tuple[str, float | None, str, str, bool]] = []
    for limit in limits_list:
        window = _window(limit)
        pct, shown = _percent(limit.get("percent"))
        reset = _reset_cell(limit.get("resets_at"), now)
        normalized.append((window, pct, shown, reset,
                           bool(limit.get("is_active"))))
    normalized.sort(key=lambda row: (
        _WINDOW_ORDER.get(row[0].split(":", 1)[0], 98), row[0],
        row[3], -1.0 if row[1] is None else row[1], row[4]))
    # ⭐ D-223. Two limits with the same window, percentage, reset AND active
    # flag are the same limit reported twice — the `#N` disambiguation below
    # would otherwise render them as `weekly_scoped` and `weekly_scoped#2`,
    # two byte-different rows carrying one fact. Live-caught 2026-09-01 on this
    # org's own codex board, where it cost ~110 characters of every turn.
    # Dedupe BEFORE numbering: after it, the rows are no longer identical and
    # nothing downstream can tell they were.
    normalized = list(dict.fromkeys(normalized))
    counts: dict[str, int] = {}
    out: list[tuple[tuple[Any, ...], str]] = []
    for window, pct, shown, reset, active in normalized:
        counts[window] = counts.get(window, 0) + 1
        display = window if counts[window] == 1 else f"{window}#{counts[window]}"
        if selected and frozen:
            state = "frozen"
            reset = _reset_cell(freeze_reset, now) if freeze_reset else reset
        elif stale:
            state = "stale"
        elif active or (pct is not None and pct >= 100.0):
            state = "limit-active"
        else:
            state = "ready"
        base = display.split(":", 1)[0].split("#", 1)[0]
        key = (_PROVIDER_ORDER[provider], lane,
               _WINDOW_ORDER.get(base, 98), display,
               -1.0 if pct is None else pct)
        out.append((key, _line(provider, lane, display, shown, "-", reset,
                               observed, state, selected=selected)))
    return out


def _fallback_rows(now: float, selected_lane: str,
                   frozen: bool, freeze_reset: Any) -> list[tuple[tuple[Any, ...], str]]:
    try:
        doc = accounts.load()
    except Exception:  # noqa: BLE001 - one telemetry source cannot block a turn
        return [((0, "fallbacks", 99, "", 0),
                 _line("claude", "fallbacks", "usage",
                       "unavailable(telemetry-error)", "-", "-", "-",
                       "unavailable"))]
    rows: list[tuple[tuple[Any, ...], str]] = []
    keys = doc.get("keys")
    for ordinal, raw in enumerate(keys if isinstance(keys, list) else [], 1):
        if not isinstance(raw, dict):
            continue
        account = str(raw.get("id") or "")
        lane = f"fallback-{ordinal}"
        liveness = accounts.key_liveness(doc, account)
        try:
            standings = accounts.tier_standing(doc, account, now)
        except Exception:  # noqa: BLE001
            standings = []
        grouped: dict[tuple[tuple[str, ...], bool, str], None] = {}
        for standing in standings:
            tier = str(standing.get("tier") or "")
            pool_raw = standing.get("pool")
            pool = tuple(str(x) for x in pool_raw) \
                if isinstance(pool_raw, list) else (tier,)
            pool = tuple(x for x in pool if x in _SAFE_MODELS)
            if not pool:
                pool = ("usage",)
            grouped[(pool, bool(standing.get("available")),
                     str(standing.get("refresh_at") or ""))] = None
        if not grouped:
            grouped[(('usage',), False, "")] = None
        for pool, available, refresh in sorted(grouped, key=lambda x: x[0]):
            selected = lane == selected_lane
            state = ("credential-rejected" if liveness == "dead" else
                     "frozen" if selected and frozen else
                     "ready" if available else "cooldown")
            reset_value: Any = freeze_reset if selected and frozen else refresh
            window = "+".join(pool)
            line = _line(
                "claude", lane, window,
                ("unavailable(authentication-rejected)" if liveness == "dead"
                 else "unavailable(unsupported)"), "-",
                _reset_cell(reset_value, now), f"{_iso(now)} (live)", state,
                selected=selected)
            rows.append(((0, lane, 10, window, 0), line))
    return rows


def _cells(line: str) -> list[str]:
    """One rendered row, split back into its columns.

    Parsing our OWN output is safe here in a way it would not be generally:
    `_line` is the single producer of every row in this module, and both the
    producer and these readers live in this file. A test pins the round trip.
    """
    return [c.strip() for c in line.split("|")]


def _band(used: str) -> str:
    """Coarse usage band. A percentage that ticks 16→17 is not news; crossing a
    quarter of the budget is. Only the BOARD's re-send is gated on this — the
    compact line below always carries the selected lane's exact numbers, so no
    agent ever loses sight of its own real usage."""
    text = used.rstrip("%")
    try:
        pct = float(text)
    except ValueError:
        return used                       # "unavailable(...)" — compare as-is
    band = 0
    for edge in (0, 25, 50, 75, 90, 95, 100):
        if pct >= edge:
            band = edge
    return f"b{band}"


def _reset_bucket(reset: str) -> str:
    """A reset instant, rounded to the nearest 5 minutes.

    ⚠ ROUNDED, NOT TRUNCATED, and that is not fussiness. Providers jitter the
    reported reset by a second or so, and this org's own boards were measured
    reporting the same window as 23:00:00Z on one turn and 22:59:59Z on the
    next (2026-09-01). Truncation puts those two in different buckets — they
    straddle a minute boundary — so a whole board was being re-sent because a
    clock wobbled backwards by one second. Rounding lands both on 23:00.

    Any quantisation still has boundaries; with ~1s of jitter this one is
    straddled about once in 300 comparisons, and the cost of that is one extra
    full board. That is the right direction to be wrong in.
    """
    stamp = _epoch(reset.split(" ", 1)[0]) if reset and reset != "-" else None
    if stamp is None:
        return "-"
    return str(int(round(stamp / 300.0)))


def material_key(lines: list[str]) -> str:
    """The board's MEANING, as a comparable string.

    Everything that moves every single turn without telling an agent anything
    it can act on — the countdown, the observation age, the exact percentage —
    is reduced or dropped. What survives is what would change a decision: which
    lanes exist, which one is selected, roughly how used each is, when its
    window resets, whether the reading is stale, and its state.
    """
    keys: list[str] = []
    for line in lines:
        if line.count("|") < 6:
            continue
        lane, window, used, _amount, reset, observed, state = _cells(line)[:7]
        fresh = "stale" if "stale" in observed else "fresh"
        keys.append(f"{lane}|{window}|{_band(used)}|"
                    f"{_reset_bucket(reset)}|{fresh}|{state}")
    return "\n".join(sorted(keys))


def compact(lines: list[str], seq: int) -> str:
    """The one-line stand-in for an unchanged board.

    It carries the SELECTED lane in full — exact percentages, and the reset
    countdown for anything not plainly ready — because that is the lane this
    turn actually runs on and the one an agent throttles itself against. The
    other lanes are the ones being pointed at rather than repeated, and any
    material move in them brings the whole board straight back.
    """
    bits: list[str] = []
    for line in lines:
        if line.count("|") < 6:
            continue
        cells = _cells(line)
        lane, window, used, _amount, reset, _observed, state = cells[:7]
        if not lane.endswith("*"):
            continue
        note = f"{window} {used} {state}"
        if state != "ready" and reset != "-" and "(" in reset:
            note += f" ({reset.split('(', 1)[1].rstrip(')')})"
        bits.append(note)
    body = " · ".join(bits) if bits else "no selected lane"
    return (f"{OPEN} #{seq} — {body}. Other lanes unchanged since #{seq}; "
            f"the full board returns on any material change.]")


def failure_block(now: float | None = None) -> str:
    """Fixed, secret-free last resort when even formatting fails."""
    now = time.time() if now is None else now
    lines = [
        _line("claude", "accounts", "usage",
              "unavailable(telemetry-error)", "-", "-", "-", "unavailable"),
        _line("codex", "account", "usage",
              "unavailable(telemetry-error)", "-", "-", "-", "unavailable"),
        _line("antigravity", "account", "usage",
              "unavailable(unsupported)", "-", "-", "-", "unsupported"),
    ]
    return (f"{OPEN} — current as of {_iso(now)}; dynamic/cache-only]\n"
            "provider/lane | window | used | amount | reset (countdown) | "
            "observed (age,freshness) | state\n"
            + "\n".join(lines)
            + "\n* selected for this turn; - = not authoritatively reported.\n"
            + CLOSE)


def number(text: str, seq: int) -> str:
    """Stamp a rendered board with its snapshot number, so a later suppressed
    turn can cite it. Separate from `board` on purpose: the number depends on
    whether the board turned out to be a CHANGE, which is only known after the
    material key exists — and the key comes from the rendered rows."""
    return text.replace(OPEN, f"{OPEN} #{seq}", 1)


def board(org: Org, nid: str, *, selected_provider: str = "",
          selected_lane: str = "", now: float | None = None
          ) -> tuple[str, str]:
    """Render one deterministic provider/account board; never raise.

    Returns (text, material_key). The key is what D-223's suppression compares
    turn over turn — see `material_key`.

    Provider order is Claude, Codex, Antigravity.  Claude accounts are primary,
    fallback ordinal, then this org's API-key lane.  Window order is session,
    weekly-all, weekly-scoped, then provider-specific.  Raw provider errors,
    account ids, emails, model labels and groups never enter the text.

    Side effect: the rendered rows' structured records are recorded for
    `board_rows` (thread-local, cleared here).
    """
    _recs().clear()
    now = time.time() if now is None else now
    try:
        node = org.node(nid)
        freeze = node.get("frozen")
        freeze = freeze if isinstance(freeze, dict) else {}
        frozen = bool(freeze.get("limit") or node.get("limit_locked"))
        freeze_reset = freeze.get("until_ts")
        rows: list[tuple[tuple[Any, ...], str]] = []

        try:
            claude = limits.snapshot(now)
            rows += _cached_rows(
                claude, "claude", "primary", now,
                selected_provider == "claude" and selected_lane == "primary",
                frozen, freeze_reset)
        except Exception:  # noqa: BLE001
            rows.append(((0, "primary", 99, "", 0),
                         _line("claude", "primary", "usage",
                               "unavailable(telemetry-error)", "-", "-", "-",
                               "unavailable",
                               selected=(selected_provider == "claude"
                                         and selected_lane == "primary"))))

        rows += _fallback_rows(now, selected_lane if selected_provider == "claude" else "",
                               frozen, freeze_reset)

        if bool(org.d.get("api_key")) or (
                selected_provider == "claude" and selected_lane == "org-api-key"):
            selected = selected_provider == "claude" and selected_lane == "org-api-key"
            fallback_until = org.d.get("api_fallback_until")
            reset_value = freeze_reset if selected and frozen else fallback_until
            state = ("frozen" if selected and frozen else
                     "active" if selected else "standby")
            rows.append(((0, "org-api-key", 99, "", 0),
                         _line("claude", "org-api-key", "usage",
                               "unavailable(unsupported)", "-",
                               _reset_cell(reset_value, now),
                               f"{_iso(now)} (live)", state,
                               selected=selected)))

        try:
            codex = codex_limits.snapshot(now)
            rows += _cached_rows(
                codex, "codex", "account", now,
                selected_provider == "openai", frozen, freeze_reset)
        except Exception:  # noqa: BLE001
            rows.append(((1, "account", 99, "", 0),
                         _line("codex", "account", "usage",
                               "unavailable(telemetry-error)", "-", "-", "-",
                               "unavailable", selected=selected_provider == "openai")))

        # The Antigravity lane has no readout to cache: its evidence is the
        # last wall a turn hit — 100%, reset parsed from the CLI's own
        # message — standing until that reset passes or a turn succeeds.
        # With nothing observed the explicit unsupported row stands, byte-
        # identical to before, so a machine that never hit a wall sees no
        # D-223 re-send.
        try:
            agy = antigravity_limits.snapshot(now)
            if agy.get("available") and not agy.get("unsupported"):
                rows += _cached_rows(
                    agy, "antigravity", "account", now,
                    selected_provider == "google", frozen, freeze_reset)
            else:
                rows.append(((2, "account", 99, "", 0),
                             _line("antigravity", "account", "usage",
                                   "unavailable(unsupported)", "-", "-", "-",
                                   "unsupported",
                                   selected=selected_provider == "google")))
        except Exception:  # noqa: BLE001
            rows.append(((2, "account", 99, "", 0),
                         _line("antigravity", "account", "usage",
                               "unavailable(telemetry-error)", "-", "-", "-",
                               "unavailable",
                               selected=selected_provider == "google")))

        rows.sort(key=_row_order)
        lines = [line for _key, line in rows]
        key = material_key(lines)
        return ((f"{OPEN} — current as of {_iso(now)}; "
                 f"dynamic/cache-only]\n"
                 "provider/lane | window | used | amount | reset (countdown) | "
                 "observed (age,freshness) | state\n"
                 + "\n".join(lines)
                 + "\n* selected for this turn; - = not authoritatively "
                   "reported.\n"
                 + CLOSE), key)
    except Exception:  # noqa: BLE001 - telemetry is never an admission gate
        # ⚠ A DISTINCT KEY, not "". Two failures in a row are not evidence that
        # the board is unchanged — the board is unknown. Keying failure to its
        # own constant makes the next successful render read as a change and
        # re-send in full, which is the only honest recovery.
        return failure_block(now), "telemetry-failure"


def render(org: Org, nid: str, *, selected_provider: str = "",
           selected_lane: str = "", now: float | None = None) -> str:
    """The board's text alone — the pre-D-223 entry point, unchanged for every
    caller that just wants to read it (tests, and any non-turn surface)."""
    return board(org, nid, selected_provider=selected_provider,
                 selected_lane=selected_lane, now=now)[0]
