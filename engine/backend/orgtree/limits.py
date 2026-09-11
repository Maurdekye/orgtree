# pyright: strict
"""The host subscription's usage limits, as ground truth for freeze timing.

User ruling 2026-08-18: *every* usage freeze must carry a reset timestamp,
and when the CLI's error prose does not spell one out, the time has to be
looked up rather than guessed — "via the same method the usage limit modal
presents it". This module is that lookup, and it is the single owner of the
readout the modal renders (`api.claude_usage` delegates here, so both share
one cache and one parser).

Why it matters beyond a nicer label: `api_fallback` bills the org's own API
key for the length of the window it opens at freeze time, and that window is
stamped from the freeze's timestamp. A guessed or mis-parsed reset is
therefore money — a bogus epoch scraped out of an error string would keep the
key lane open long after the subscription recovered.

Source: `GET /api/oauth/usage` on the host's subscription OAuth token
(`subproxy` owns the token and its refresh). The payload's `limits[]` carries
one entry per lane — `session` (5 h), `weekly_all` (7 d), `weekly_scoped`
(a model's own weekly pool, e.g. Fable) — each with a minute-exact ISO-8601
`resets_at` and an `is_active` flag marking the lane that is actually
throttling the account right now.

⚠ Semi-documented surface, like `subproxy`: the endpoint is what Claude Code
itself reads for `/usage`, not a published contract. Everything here fails
OPEN — an unavailable or reshaped readout returns "no idea", and the caller
keeps its own conservative floor.
"""

from __future__ import annotations

import datetime as _dt
import email.utils as _eut
import http.client
import json
import math
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any, cast

from . import subproxy

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CACHE_TTL = 30.0        # the modal polls; the upstream is a per-account readout
FETCH_TIMEOUT = 15.0
# how stale a readout may be when a freeze RE-asks (see fetch's `max_age`)
REREAD_MAX_AGE = 5.0
# …and how stale one may be before it stops being evidence AT ALL. Redteam
# 2026-08-18: `fetch` serves the last good payload forever on a broken
# upstream and never refreshes `_cache["at"]`, so an unbounded-age readout was
# still pricing key-billing windows hours after it stopped being true. The
# modal may keep showing yesterday's bars; a freeze may not spend on them.
MAX_EVIDENCE_AGE = 900.0

# A reset further out than this is not a reset — it is a number that happened
# to sit where a timestamp goes. The longest real lane is the 7-day weekly.
MAX_HORIZON = 8 * 86400.0

# Lane wall-clock lengths, used only to sanity-bound a lane's own reset.
LANE_SECONDS = {"session": 18000.0, "weekly_all": 604800.0,
                "weekly_scoped": 604800.0}

_lock = threading.Lock()
# one request at a time (redteam 2026-08-18): N nodes freezing together used
# to mean N concurrent GETs at a semi-documented endpoint, each serializing on
# subproxy's token lock behind them, and a 429 from that herd put every one of
# them on the stale path. Waiters re-check the cache and take the winner's
# answer.
_fetch_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "data": None}
# per-KEY readouts (the machine-local account rows — accounts.py), each its
# own {at, data} under the same TTL. Kept apart from `_cache` deliberately:
# everything below that reasons about freezes, pressure and the warm loop
# reads the HOST subscription's standing, and a fallback key's bars leaking
# into that would time freezes off someone else's quota.
_key_cache: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------- rate-limit cooldowns
# ⚠ A 429 IS AN INSTRUCTION, NOT MERELY AN ERROR — and until 2026-08-25 this
# module threw the instruction away. Only SUCCESS was ever cached; a failure
# cached nothing, so the very next caller re-asked at full rate while the
# upstream was explicitly saying "wait". The user's report was "constant 429
# errors" on a key row, and constant is exactly what the code guaranteed.
#
# MEASURED, that day, against the key that was failing (two back-to-back calls,
# no retries): `HTTP 429, Retry-After: 1032, server: cloudflare`, body
# `{"type":"rate_limit_error"}` — and the SAME 1032 both times, i.e. a fixed
# window with a real deadline rather than a per-request penalty. Meanwhile the
# host readout answered 200, so the limit was scoped to that one account and
# nothing about the endpoint, the network or the token was broken.
#
# So: honour it. The cooldown GATES THE REQUEST, not just the message — a fix
# that only prettied up the error string would still have hammered.
DEFAULT_RETRY_AFTER = 60.0    # a 429 with no usable Retry-After still earns a pause
# ⚠ THE PENALTY ESCALATES, MEASURED. The same account answered `Retry-After:
# 1032` at 11:30 and `Retry-After: 3600` twelve minutes later, after a handful
# of further asks — asking inside the window lengthens it. So the clamp is a
# guard against an absurd or hostile value, NOT a policy about how long we are
# willing to wait: set it near 1032 or 3600 and a real escalation gets clamped,
# we ask early, and we earn a longer one. Six hours is far above anything
# observed and still bounded. Waiting too long costs a stale panel; waiting too
# little costs the window itself.
MAX_RETRY_AFTER = 6 * 3600.0
#: cache_key -> epoch before which we must not ask again. Keyed exactly like the
#: readouts it guards, so the host's window and a key row's are independent.
_cooldown: dict[str, float] = {}
#: the host's cooldown slot. A NUL byte cannot collide with a key row id (those
#: are hex hashes), so the two namespaces share this dict safely.
HOST_COOLDOWN_KEY = "\x00host"


def _retry_after_seconds(err: urllib.error.HTTPError, now: float) -> float:
    """How long the response told us to wait. RFC 9110 allows Retry-After to be
    either delta-seconds or an HTTP-date and both occur in the wild, so parse
    both; anything absent, malformed or non-positive falls back to
    `DEFAULT_RETRY_AFTER` rather than to zero. Zero would be a hammer loop
    authorised by a header — the one outcome this whole mechanism exists to
    prevent."""
    raw = ""
    try:
        raw = str(err.headers.get("Retry-After") or "").strip()
    except (AttributeError, TypeError):     # a response without usable headers
        raw = ""
    secs: float | None = None
    if raw:
        try:
            secs = float(int(raw))
        except ValueError:
            try:
                when = _eut.parsedate_to_datetime(raw)
            except (TypeError, ValueError, IndexError):
                when = None
            if when is not None:
                if when.tzinfo is None:     # an HTTP-date is GMT by definition
                    when = when.replace(tzinfo=_dt.timezone.utc)
                secs = when.timestamp() - now
    if secs is None or secs <= 0:
        secs = DEFAULT_RETRY_AFTER
    return min(secs, MAX_RETRY_AFTER)


def _is_credential_rejection(e: Exception) -> bool:
    """Is `e` a genuine "this login is no good" answer — the ONE condition
    under which the usage panel may offer a sign-in button (D-231 expansion).

    ⚠ NOT every 403 qualifies — `_throttle_window` has ALREADY run by the
    time a caller reaches this (see `fetch`'s except block) and reclassifies
    a 403 that carries throttle evidence (`Retry-After`, `cf-mitigated`, a
    rate-limit body) as a cooldown, never a login failure. Only a 403/401
    that survived that filter — no throttle evidence at all — reaches here,
    which is exactly the discrimination `_plain_error` already made for its
    message; this reuses the SAME predicate rather than re-deriving it, so
    the button and the sentence describing it can never disagree."""
    return isinstance(e, urllib.error.HTTPError) and e.code in (401, 403)


def _plain_error(e: Exception) -> str:
    """The message for a failure that did NOT open a window.

    ⚠ Was. "re-mint it with `claude setup-token` and paste it again", shipped
    2026-08-25 and WRONG — a token's scopes are fixed when it is minted and a
    refresh preserves them, so re-minting a `setup-token` key produces another
    inference-only key that is refused identically (D-147). Instructing the
    user to perform a ritual that cannot work is worse than saying nothing:
    when it fails they conclude their key is broken. Key rows no longer reach
    this endpoint at all, so a 401/403 here is the HOST subscription login,
    and the CLI is what fixes that."""
    if _is_credential_rejection(e):
        code = cast("urllib.error.HTTPError", e).code
        return (f"the host login was refused ({code}) — this is a sign-in "
                "problem, not a usage limit. Sign in again with the Claude "
                "CLI (`claude auth login`).")
    return f"usage fetch failed: {e}"


def _cooldown_error(until: float, now: float) -> dict[str, Any]:
    """What the panel shows instead of a raw `HTTPError` repr. Names the wait,
    because "rate limited" with no horizon reads as broken and invites the
    clicking that caused this."""
    left = max(0.0, until - now)
    when = (f"{round(left / 60)}m" if left >= 90 else f"{int(left)}s")
    return {"available": False,
            "error": f"rate limited by the API — retry in {when}"}


#: markers that make a 403 a THROTTLE rather than a rejected credential. The
#: edge in front of this API escalates: a client that keeps asking through a
#: 429 starts getting 403s instead (user report 2026-08-25, "im getting a 403
#: forbidden now on the usage check for secondary keys as opposed to a 429" —
#: same key, same machine, while the host readout kept answering 200).
_THROTTLE_BODY = re.compile(
    r"rate[_ -]?limit"          # Anthropic's own {"type":"rate_limit_error"}
    r"|too many requests"
    r"|error code: *101[0-9]"   # Cloudflare WAF block page (1010 & neighbours)
    r"|cf-error|cloudflare",
    re.I)


def _throttle_window(err: urllib.error.HTTPError, now: float) -> float | None:
    """Seconds to stand down for, or None if this response is not a throttle.

    ⚠ THE DISCRIMINATION IS THE POINT, in BOTH directions.
      · A 429 is always a throttle.
      · A 403 is one ONLY on evidence — a `Retry-After`, or a body/headers that
        name rate limiting or a WAF block. The edge really does answer 403 for
        a client it is already throttling, and hammering through the escalated
        form is the exact harm the 429 window exists to prevent.
      · Any OTHER 403 — `permission_error`, `authentication_error`, a revoked
        or mistyped key — must stay instantly retryable. That is a thing the
        user fixes by pasting a new key, and a cooldown would swallow the fix
        and make it look like it had not taken.
    Anything we cannot read, we treat as NOT a throttle: failing open costs one
    extra request, failing closed hides a broken credential behind an hour."""
    if err.code == 429:
        return _retry_after_seconds(err, now)
    if err.code != 403:
        return None
    try:
        if str(err.headers.get("Retry-After") or "").strip():
            return _retry_after_seconds(err, now)
    except (AttributeError, TypeError):
        pass
    try:
        # `cf-mitigated` is present ONLY when the edge is actively mitigating
        # this request. Its VALUE ("challenge", …) names the flavour and is not
        # worth matching on — presence is the signal. (Caught by the suite: a
        # first draft grepped the value against the body markers below and
        # concluded a mitigated request was a bad credential.)
        if err.headers.get("cf-mitigated") is not None:
            return _retry_after_seconds(err, now)
    except (AttributeError, TypeError):
        pass
    try:
        # bounded: a WAF block page can be large, and the markers are near the
        # top. `.read()` on an HTTPError is safe — nothing else consumes it.
        blob = err.read(2048).decode("utf-8", "replace")
    except (AttributeError, TypeError, ValueError, OSError,
            http.client.HTTPException):
        return None
    if _THROTTLE_BODY.search(blob):
        return _retry_after_seconds(err, now)   # no header ⇒ the default pause
    return None


def _note_rate_limit(cache_key: str, secs: float, now: float) -> float:
    """Record the window a throttling response opened; returns its closing
    epoch."""
    until = now + secs
    with _lock:
        _cooldown[cache_key] = until
    return until


def _cooling(cache_key: str, now: float) -> float | None:
    """The epoch this key may next be asked, or None if it may be asked now.
    Expired windows are dropped so the dict cannot grow without bound."""
    with _lock:
        until = _cooldown.get(cache_key)
        if until is None:
            return None
        if until <= now:
            del _cooldown[cache_key]
            return None
        return until


# --------------------------------------------------------------- the readout
def _iso_to_epoch(value: Any) -> float | None:
    """ISO-8601 (`2026-08-18T15:30:00Z` / `…+00:00`) → epoch seconds.
    `fromisoformat` only learned the `Z` suffix in 3.11 — normalize first so
    a 3.10 host does not silently lose every reset time."""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:                 # naive readings are UTC upstream
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.timestamp()


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


def _normalize(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """`limits[]` is the modern shape; the flat `five_hour`/`seven_day` pair is
    its ancestor, kept so an older upstream still yields the two unscoped
    bars. Unknown keys are ignored rather than rejected — the upstream churns
    codename fields and this must not start failing when it does."""
    out: list[dict[str, Any]] = []
    lims_any = raw.get("limits")
    # ⚠ `cast` is a runtime no-op: a reshaped upstream answering `"limits": 3`
    # made this raise TypeError out of a function whose contract is "never
    # raises", 500-ing the usage modal (redteam 2026-08-18)
    for lim_any in (cast("list[Any]", lims_any)
                    if isinstance(lims_any, list) else []):
        if not isinstance(lim_any, dict):
            continue
        lim = cast("dict[str, Any]", lim_any)
        model: Any = None
        scope_any = lim.get("scope")
        if isinstance(scope_any, dict):
            model_any = cast("dict[str, Any]", scope_any).get("model")
            if isinstance(model_any, dict):
                model = cast("dict[str, Any]", model_any).get("display_name")
        out.append({"kind": lim.get("kind"), "group": lim.get("group"),
                    "percent": lim.get("percent"),
                    "severity": lim.get("severity"),
                    "resets_at": lim.get("resets_at"),
                    "is_active": bool(lim.get("is_active")),
                    "model": model})
    if out:
        return out
    for key, kind in (("five_hour", "session"), ("seven_day", "weekly_all")):
        w_any = raw.get(key)
        if not isinstance(w_any, dict):
            continue
        w = cast("dict[str, Any]", w_any)
        if w.get("utilization") is not None:
            out.append({"kind": kind, "group": kind,
                        "percent": w["utilization"], "severity": "normal",
                        "resets_at": w.get("resets_at"),
                        "is_active": False, "model": None})
    return out


def _plan() -> str:
    try:
        doc_any: Any = json.load(open(subproxy.CREDS, encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    if not isinstance(doc_any, dict):
        return ""
    oauth_any = cast("dict[str, Any]", doc_any).get("claudeAiOauth")
    if not isinstance(oauth_any, dict):
        return ""
    return str(cast("dict[str, Any]", oauth_any).get("subscriptionType") or "")


def _identity() -> dict[str, str]:
    """`{"uuid", "email"}` of whoever is signed in right now — the same
    metadata `providers_payload`/`_providers_payload` already trust for
    "connected", never the credentials store `_plan` reads above (that file
    carries the subscription tier, not an identity — `accounts.live_identity`
    is the one place this codebase reads `~/.claude.json`'s `oauthAccount`).
    Both empty strings when nobody is signed in.

    Deferred import: `accounts` already imports `limits` (for the host
    readout it composes into account rows), so a top-level import here would
    cycle."""
    from . import accounts                       # noqa: PLC0415 — cycle seam
    return accounts.live_identity()


def fetch(force: bool = False, max_age: float | None = None) -> dict[str, Any]:
    """The normalized readout: `{available, limits[], plan, email}`, or
    `{available: False, error}`. `email` (added for show-the-claude-
    account-email-in-usage) is the signed-in profile's address, empty when
    unknown — the usage panel already shows this for Codex/Antigravity via
    their own `label`; Claude's was the one section missing it. Cached
    `CACHE_TTL`, and STALE-ON-ERROR — a blip must show the last good bars
    rather than an error box, and must not make a freeze forget a reset time
    it already knew.

    `max_age` tightens the cache for one call. The freeze-correction pass
    needs it: a limit that just fired CHANGED the standing, and an entry the
    warm loop filled a moment earlier predates the event — served from the
    ordinary 30 s cache, the correction would "re-ask" and get back the very
    number the freeze already stamped from. A few seconds still coalesces a
    storm of freezes into one request.

    Synchronous on purpose: the freeze path is a worker thread, and the modal
    route hands it to a threadpool. Never raises.

    ⚠ ACCOUNT-SCOPED (root's review of 3b4c589): `_cache` used to answer for
    whoever was cached, not whoever is signed in NOW — after a `claude auth
    login` as a different account, a cooldown or a transient network error
    could still serve the PREVIOUS account's email and usage numbers,
    because the stale-on-error path never asked whose data it was about to
    hand back. `acct` is read once here and every stale/fresh check below
    compares against it; a cache written under a different account reads as
    absent, the same rule `codex_limits.fetch` already applies to its own
    board via `_cache.get("account")`."""
    ttl = CACHE_TTL if max_age is None else max(0.0, max_age)
    # read ONCE and reused for the whole call — the email that lands in a
    # successful `data` below must be the SAME identity `acct` was compared
    # against, not a second, possibly-different read taken moments later.
    identity = _identity()
    acct = identity.get("uuid") or ""

    def _fresh_enough() -> dict[str, Any] | None:
        with _lock:
            hit = cast("dict[str, Any] | None", _cache["data"])
            if (hit is not None
                    and _cache.get("account") == acct
                    and time.time() - float(cast(float, _cache["at"])) < ttl):
                return hit
        return None

    def _stale_for_this_account() -> dict[str, Any] | None:
        """Like the public `cached()`, but refuses to hand back a readout
        stamped for a DIFFERENT account — `cached()` itself stays as-is
        (pressure/peek/the freeze path read it and were not part of this
        finding; narrowing it would be a wider change than what was asked)."""
        with _lock:
            hit = cast("dict[str, Any] | None", _cache["data"])
            if hit is not None and _cache.get("account") == acct:
                return hit
        return None

    hit = None if force else _fresh_enough()
    if hit is not None:
        return hit
    if not subproxy.available():
        return {"available": False,
                "error": "no Claude Code credentials on this host"}
    # the host has the same hole the key rows had: nothing cached a failure, so
    # a 429 here re-asked on every freeze and every modal open. `force=True`
    # does NOT punch through — the freeze-correction pass is precisely the
    # caller that would turn one rate limit into a storm of them.
    cool = _cooling(HOST_COOLDOWN_KEY, time.time())
    if cool is not None:
        stale = _stale_for_this_account()
        return stale if stale is not None else _cooldown_error(cool, time.time())
    with _fetch_lock:
        # the winner of the herd has just filled the cache — take its answer
        # rather than asking the same question again
        hit = None if force else _fresh_enough()
        if hit is not None:
            return hit
        try:
            token = subproxy.get_access_token()
        except RuntimeError as e:
            return {"available": False, "error": str(e)}
        try:
            req = urllib.request.Request(USAGE_URL, headers={
                "Authorization": "Bearer " + token,
                "anthropic-beta": "oauth-2025-04-20",
                "accept": "application/json"})
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                raw_any: Any = json.load(resp)
        except (urllib.error.URLError, OSError, ValueError,
                # ⚠ http.client's own family is NOT an OSError: a truncated
                # chunked body raises IncompleteRead out of `json.load`,
                # escaping a function whose contract is "never raises" and
                # 500-ing the modal instead of serving the stale bars
                # (redteam 2026-08-18)
                http.client.HTTPException) as e:
            rl, until, _n = False, 0.0, time.time()
            if isinstance(e, urllib.error.HTTPError):
                secs = _throttle_window(e, _n)
                if secs is not None:
                    rl, until = True, _note_rate_limit(HOST_COOLDOWN_KEY,
                                                       secs, _n)
            # ⚠ a genuine credential rejection (coordinator review, measured)
            # must surface immediately, never be masked by an older good
            # readout for the SAME account: `_stale_for_this_account` exists
            # for a network blip ("a blip must show the last good bars"),
            # but a revoked/expired token is not a blip — it is an
            # authoritative "you are signed out" answer, and the usage
            # panel's sign-in button must appear the moment it happens, not
            # only once the last-known-good cache eventually ages out past
            # MAX_EVIDENCE_AGE. `rl` above has ALREADY reclassified a
            # throttled 403 away from this branch, so nothing here can
            # mistake an edge-mitigated request for a login failure.
            if not rl and _is_credential_rejection(e):
                out: dict[str, Any] = {"available": False, "error": _plain_error(e)}
                # D-231 expansion: the ONE structured signal the usage panel
                # may key a sign-in button off — never string-matched from
                # `error`, which can be reworded without notice.
                # `reauth_evidence` names WHICH fact produced
                # `reauth_required`: root's review ruling — a MEASURED
                # 403/401 (this provider) and Codex/Antigravity's
                # locally-observed "installed but not connected" are
                # DISTINCT auth states and must stay distinguishable, never
                # flattened into one undifferentiated boolean as if they
                # were the same kind of evidence (codex_limits.py /
                # antigravity_limits.py carry "not_connected" for their own
                # branch).
                out["reauth_required"] = True
                out["reauth_evidence"] = "measured_403"
                return out
            stale = _stale_for_this_account()
            if stale is not None:
                return stale
            if rl:
                return _cooldown_error(until, _n)
            return {"available": False, "error": _plain_error(e)}
        raw: dict[str, Any] = (cast("dict[str, Any]", raw_any)
                               if isinstance(raw_any, dict) else {})
        observed_at = time.time()
        data: dict[str, Any] = {"available": True, "limits": _normalize(raw),
                                "plan": _plan(), "email": identity.get("email") or "",
                                "observed_at": _iso(observed_at)}
        with _lock:
            # stamped when the answer ARRIVED, not when it was asked for: a
            # 14-second response is already 14 seconds stale (redteam).
            # `account=acct` (root's review of 3b4c589) is what lets a LATER
            # call recognize this readout as belonging to a since-replaced
            # identity and refuse to serve it as fresh or stale.
            _cache.update(at=observed_at, data=data, account=acct)
        return data


_profile_fetch_locks: dict[str, Any] = {}


def fetch_for_token(token: str, cache_key: str, *, force: bool = False) -> dict[str, Any]:
    """Single flight per profile across UI refreshes and freeze corrections."""
    with _lock:
        gate = _profile_fetch_locks.setdefault(cache_key, threading.Lock())
    with gate:
        return _fetch_for_token(token, cache_key, force=force)


def _fetch_for_token(token: str, cache_key: str, *, force: bool = False) -> dict[str, Any]:
    """Read a profile OAuth token's usage with a per-account cache/cooldown.

    This requires the profile scope of a full CLI login; inference-only
    setup-token keys must not call it. The public wrapper serializes requests
    for the same account, so simultaneous UI and freeze refreshes share the
    result. Errors retain the last good board without refreshing its age.
    The host subscription cache remains separate.
    """
    if not str(token or ""):
        return {"available": False, "error": "no key stored for this row"}
    now = time.time()
    with _lock:
        ent = _key_cache.get(cache_key)
        if not force and ent and ent.get("data") is not None \
                and now - float(ent.get("at") or 0) < CACHE_TTL:
            return cast("dict[str, Any]", ent["data"])
    # ⚠ BEFORE the request, not after: an open 429 window means we must not ask
    # at all. Stale bars still beat an error box, but either way no packet goes.
    cool = _cooling(cache_key, now)
    if cool is not None:
        with _lock:
            stale = _key_cache.get(cache_key, {}).get("data")
        if stale is not None:
            return cast("dict[str, Any]", stale)
        return _cooldown_error(cool, now)
    try:
        req = urllib.request.Request(USAGE_URL, headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw_any: Any = json.load(resp)
    except (urllib.error.URLError, OSError, ValueError,
            http.client.HTTPException) as e:
        # a 429 opens a window; every OTHER failure stays retryable on the next
        # call, deliberately — a blip, an expired token the user is about to
        # re-paste, or a 401 they can fix must not be hidden behind a cooldown
        rl, until = False, 0.0
        if isinstance(e, urllib.error.HTTPError):
            secs = _throttle_window(e, now)
            if secs is not None:
                rl, until = True, _note_rate_limit(cache_key, secs, now)
        with _lock:
            stale = _key_cache.get(cache_key, {}).get("data")
        if stale is not None:
            return cast("dict[str, Any]", stale)
        if rl:
            return _cooldown_error(until, now)
        return {"available": False, "error": _plain_error(e)}
    raw: dict[str, Any] = (cast("dict[str, Any]", raw_any)
                           if isinstance(raw_any, dict) else {})
    data: dict[str, Any] = {"available": True, "limits": _normalize(raw)}
    with _lock:
        _key_cache[cache_key] = {"at": time.time(), "data": data}
    return data


def account_readout(account: str, *, allow_fetch: bool = False):
    """Read only this registered Claude profile's board, never another login.

    The synchronous freeze path is cache-only. Credential refresh and HTTPS
    are confined to the existing background correction/warm passes.
    """
    from . import registry
    try:
        row = registry.get_account(account)
    except registry.UnknownAccount:
        return None, float('inf')
    cred = row['credential']
    if row['provider'] != 'claude' or cred['kind'] not in ('managed', 'imported'):
        return None, float('inf')
    key = f'acct:{row["id"]}'
    if allow_fetch:
        token = subproxy.profile_access_token(cred['path'])
        fetch_for_token(token, key)
    with _lock:
        entry = _key_cache.get(key) or {}
        return entry.get('data'), max(0.0, time.time() - float(entry.get('at') or 0))


def available() -> bool:
    """Is there a subscription to read lanes from at all? (An API-key-only
    host has none — the warm loop stays silent rather than logging a failure
    every few minutes.)"""
    return subproxy.available()


def cache_age() -> float:
    """Seconds since the cached readout was fetched (`inf` when there is
    none). The readout ages into worthlessness — see MAX_EVIDENCE_AGE."""
    with _lock:
        if _cache["data"] is None:
            return float("inf")
        return time.time() - float(cast(float, _cache["at"]))


def cached() -> dict[str, Any] | None:
    """The last good readout, or None — NEVER a fetch. The freeze path runs
    under the document lock and the endpoint routinely takes over a second
    (user report 2026-08-18): a freeze stamps what is already known and a
    background pass corrects it. `warm()` keeps this fresh enough to be worth
    reading."""
    with _lock:
        return cast("dict[str, Any] | None", _cache["data"])


def pressure(data: dict[str, Any] | None = None) -> float:
    """The highest lane utilization in the cached readout, 0..100 (0 when
    nothing is cached). The warm loop paces itself on it — a lane at 99% is
    minutes from freezing something, and a stamp is only as good as the
    readout behind it."""
    data = cached() if data is None else data
    if not data or not data.get("available"):
        return 0.0
    top = 0.0
    for x_any in cast("list[Any]", data.get("limits") or []):
        if not isinstance(x_any, dict):
            continue
        x = cast("dict[str, Any]", x_any)
        try:
            pct = float(cast(Any, x.get("percent")) or 0)
        except (TypeError, ValueError):
            continue
        if str(x.get("severity") or "") == "critical":
            pct = max(pct, 95.0)
        top = max(top, pct)
    return top


def next_reset(now: float | None = None, data: dict[str, Any] | None = None) -> float | None:
    """The soonest FUTURE reset on the cached board, or None — cache-only.

    This is a clock, not a price. Where `reset_for` bands a candidate by the
    lane it is supposed to belong to (a wrong lane there bills the org's key
    for six days), the only thing riding on this one is when a background
    read happens, so it takes every lane at face value and only refuses the
    absurd — a reset already past, or one beyond `MAX_HORIZON`.

    Serves `supervisor.start_usage_warm_loop`, which cuts its sleep short to
    land just after this boundary: the moment a lane rolls over is the moment
    the cached readout stops being true, and it is knowable in advance.
    """
    now = time.time() if now is None else now
    data = cached() if data is None else data
    if not data or not data.get("available"):
        return None
    soonest: float | None = None
    for x_any in cast("list[Any]", data.get("limits") or []):
        if not isinstance(x_any, dict):
            continue
        ts = _iso_to_epoch(cast("dict[str, Any]", x_any).get("resets_at"))
        if ts is None or not now < ts <= now + MAX_HORIZON:
            continue
        soonest = ts if soonest is None else min(soonest, ts)
    return soonest


def peek() -> dict[str, Any]:
    """The cached standing for the header GLOW — cache-only, never a fetch.

    The glow polls whether or not anyone opened the modal, so it must not be
    able to add a single upstream request; `/api/usage` (the modal) is the
    only reader allowed to spend one. The warm loop
    (`supervisor.start_usage_warm_loop`) is what keeps this worth reading.

    A readout older than MAX_EVIDENCE_AGE reports unavailable for the same
    reason the freeze path refuses to price on one: a glow is a claim about
    NOW, and an amber ring standing on a two-hour-old number is worse than no
    ring at all. `available: False` simply means "do not glow" — the modal
    still shows the stale bars, where they are labelled and dated.

    Shape (frontend UsagePeek): `{available, error?, limits?[], age?}` —
    the same `limits` entries `fetch` normalizes, so one severity rule in the
    UI serves both the bars and the button."""
    data = cached()
    age = cache_age()
    if data is None or not data.get("available"):
        return {"available": False}
    if age > MAX_EVIDENCE_AGE:
        return {"available": False, "error": "usage readout is stale"}
    return {"available": True, "limits": data.get("limits") or [],
            "age": round(age, 1)}


def snapshot(now: float | None = None) -> dict[str, Any]:
    """Cache-only usage evidence for dynamic turn envelopes.

    Unlike :func:`peek`, this keeps a stale board (labelled ``stale``) so an
    agent can distinguish "the last observation is old" from "this provider
    has never reported usage".  It never fetches and never returns credential
    material.  Callers receive copies, not the mutable cache records.
    """
    now = time.time() if now is None else now
    with _lock:
        raw = cast("dict[str, Any] | None", _cache.get("data"))
        observed = float(cast(float, _cache.get("at") or 0.0))
        if raw is None:
            return {"available": False, "limits": [], "observed_at": None,
                    "age": None, "stale": False}
        data = dict(raw)
        data["limits"] = [dict(x) for x in cast("list[Any]", raw.get("limits") or [])
                          if isinstance(x, dict)]
    age = max(0.0, now - observed) if observed > 0 else None
    seen = None
    if observed > 0:
        try:
            seen = (_dt.datetime.fromtimestamp(observed, _dt.timezone.utc)
                    .isoformat().replace("+00:00", "Z"))
        except (OverflowError, OSError, ValueError):
            pass
    data.update(observed_at=seen, age=age,
                stale=bool(age is not None and age > MAX_EVIDENCE_AGE))
    return data


def invalidate() -> None:
    """Drop the cache. Tests only: a caller that just learned the standing
    changed wants `fetch(max_age=REREAD_MAX_AGE)`, which re-reads without
    throwing away an answer the next caller may still need.

    Clears the key readouts and the rate-limit windows too. Module state that
    `invalidate()` does NOT reset is state that leaks between tests, and a
    cooldown left standing makes the next test's fetch return a cached refusal
    without touching the transport — which looks exactly like a pass."""
    with _lock:
        _cache.update(at=0.0, data=None)
        _key_cache.clear()
        _cooldown.clear()


# ------------------------------------------------------------ classification
# "your Fable 5 limit" — a TIER limit names the model as the thing you ran out
# OF. Raw CLI/API error text echoes model ids for other reasons entirely
# ("model claude-opus-4-1", "switch models with /model (sonnet, haiku)"), and
# reading those as the model's WEEKLY pool widened a five-hour session limit
# into a seven-day key-billing window (redteam 2026-08-18). Anchored on the
# possessive-ish shape, and never inside a hyphenated model id.
_TIER_RE = re.compile(
    r"(?<![\w-])(?:your|the)\s+(fable|opus|sonnet|haiku)\b(?![-\w])"
    r"[^.\n]{0,32}?\blimit\b", re.IGNORECASE)


_RATE_RE = re.compile(
    # ⚠ `429` is the one marker every rate limit carries, and the separator is
    # not fixed: the first cut matched `rate_limit` and `rate limit` but not
    # `rate-limit` — while its own neighbour `per[- ]minute` accepted the
    # hyphen — and missed `RateLimitError`, the SDK class name that shows up in
    # tracebacks (`err_blob` is the last three stderr lines). One hyphen was
    # the difference between a 15-minute window and a six-day one (redteam
    # round 10). The lookbehind keeps `corporate limit` out.
    r"(?<![\w-])(?:429\b|rate[-_ ]?limits?\b|ratelimit|per[-_ ]minute"
    r"|requests? per (?:minute|second)|tpm\b|rpm\b|too many requests)",
    re.IGNORECASE)


# The CLI's subscription walls use a possessive sentence shape: “You've hit
# your weekly limit” and “You've hit your Opus limit”.  This is deliberately
# structural rather than a list of lane adjectives, and deliberately narrower
# than a bare ``limit``: “401 invalid token (see your organisation limit
# policy)” must remain a credential rejection, not proof of life.
_POSSESSIVE_LIMIT_RE = re.compile(
    r"\b(?:hit|reached|exceeded)\s+(?:your|the)\s+[^.\n]{0,24}?\blimit\b",
    re.IGNORECASE,
)


def is_rate_limit(blob: str) -> bool:
    """A short-window RATE limit (429, per-minute tokens) rather than a
    subscription usage LANE. `supervisor._looks_like_usage_limit` matches both
    on purpose — any wall should freeze the agent — but only the lanes are
    described by this readout, and answering a per-minute 429 with the session
    lane's reset parks the node for hours (redteam 2026-08-18)."""
    return bool(_RATE_RE.search(blob))


def is_limit_message(blob: str) -> bool:
    """Does CLI prose establish an authenticated usage/rate refusal?

    This shared predicate combines rate shapes, the model-tier possessive
    form, and the general possessive CLI sentence rather than teaching each
    consumer an ever-growing private list of replies it happened to observe.
    """
    return bool(_RATE_RE.search(blob) or _TIER_RE.search(blob)
                or _POSSESSIVE_LIMIT_RE.search(blob))


def classify(blob: str) -> tuple[str | None, str | None]:
    """Which lane does this limit error name? → `(kind, model)`, both None
    when the prose does not say.

    `session` is tested FIRST and wins outright, mirroring
    `supervisor._looks_like_fable_tier_limit`: a session limit that happens to
    mention a model ("session limit for Fable 5") is a session limit, and
    reading it as the model's weekly pool is the FABLE-1 bug in another
    costume — here it would stamp a 7-day key-billing window for a wall that
    lifts in the hour."""
    b = blob.lower()
    if "session" in b:
        return "session", None
    tier = _TIER_RE.search(blob)
    if re.search(r"\bweekly\b|\b7[- ]day\b|\bseven[- ]day\b", b):
        return (("weekly_scoped", tier.group(1).lower()) if tier
                else ("weekly_all", None))
    if tier:
        # "You've reached your Fable 5 limit." — the real model-tier wording
        # carries the model name and no window word at all.
        return "weekly_scoped", tier.group(1).lower()
    return None, None


def lane_horizon(kind: str | None) -> float:
    """How far out a reset for this lane may plausibly sit — the lane's own
    length plus an hour of slack, or the whole horizon when the lane is
    unknown. Callers band candidate timestamps with it: a "session limit"
    that claims to lift in 23 hours is not a session limit's reset."""
    # ⚠ an unrecognized lane takes the SHORTEST length, not the longest
    # (redteam 2026-08-18). Everywhere else in this module the unknown case
    # defaults short because the answer bounds a bill; a renamed or brand-new
    # upstream lane inheriting the 8-day band was the one place it failed open.
    return min(LANE_SECONDS.get(kind or "", LANE_SECONDS["session"]) + 3600.0,
               MAX_HORIZON)


def _candidate(lim: dict[str, Any], now: float) -> float | None:
    ts = _iso_to_epoch(lim.get("resets_at"))
    if ts is None or not now < ts <= now + lane_horizon(
            str(lim.get("kind") or "")):
        return None
    return ts


def recovery_deadline(tier: str, data: Mapping[str, Any] | None,
                      evidence_age: float | None, *,
                      now: float | None = None) -> float | None:
    """Latest active HOST-subscription constraint applicable to ``tier``.

    ⚠ NO LONGER A SCHEDULING INPUT (user ruling 2026-09-07 14:56Z, coordinator
    decision 15:03Z). Until then the freeze stamp, the off-lock correction
    pass and the roster mark all took this value OVER the time parsed from
    the limit message (`_rts = _recovery_ts or _billing_ts`), and for an
    unnamed limit type it answered with the LATEST active lane where the
    2026-08-18 ruling says the shortest. Both are the inversion the user
    ruled against. It is kept as a read-only projection (its own tests still
    hold) and nothing in `supervisor` consults it for a wake time any more.

    This is deliberately separate from :func:`reset_for`.  ``reset_for`` is
    the short, conservative key-billing bound; this answer is the first time
    every observed active constraint could have cleared.  It is cache-only
    and fail-closed: an absent, stale or malformed applicable reset is not
    evidence of recovery.

    Haiku/Sonnet/Opus share ``session`` + ``weekly_all`` and their matching
    scoped lane.  Fable has its own ``session`` + Fable-scoped pool; the
    unrelated all-model weekly lane must not park it.  This is only a latest
    observed deadline, never a promise that capacity will exist then.
    """
    now = time.time() if now is None else now
    if tier not in (*("haiku", "sonnet", "opus"), "fable"):
        return None
    if (not isinstance(data, Mapping) or not data.get("available")
            or not isinstance(evidence_age, (int, float))
            or isinstance(evidence_age, bool)
            or not math.isfinite(float(evidence_age))
            or evidence_age < 0 or evidence_age > MAX_EVIDENCE_AGE):
        return None
    raw = data.get("limits")
    if not isinstance(raw, list):
        return None
    applicable: list[dict[str, Any]] = []
    for value in raw:
        if not isinstance(value, dict) or not bool(value.get("is_active")):
            continue
        kind = str(value.get("kind") or "")
        model = str(value.get("model") or "").lower()
        if kind == "session":
            applicable.append(value)
        elif tier == "fable":
            if kind == "weekly_scoped" and "fable" in model:
                applicable.append(value)
        elif kind == "weekly_all" or (
                kind == "weekly_scoped" and tier in model):
            applicable.append(value)
    if not applicable:
        return None
    resets = [_candidate(value, now) for value in applicable]
    if any(value is None for value in resets):
        return None
    return max(cast("list[float]", resets))


#: the tiers this readout can describe — `accounts.TIERS`, restated here
#: because `accounts` imports this module (the value is pinned by a test)
CLAUDE_TIERS = ("haiku", "sonnet", "opus", "fable")


def lane_applies(lim: Mapping[str, Any], tier: str) -> bool:
    """Does this readout lane describe `tier`'s quota at all? — the MODEL half
    of the user's matching rule (2026-09-07: cached usage is consulted only
    when the message carries no time, and then "matched to model, account
    lane and limit type").

    `session` is shared by every Claude tier. `weekly_all` is the pooled
    haiku/sonnet/opus bucket and says nothing about Fable's own weekly pool;
    a `weekly_scoped` lane belongs to the model it names.

    ⚠ CLAUDE TIERS ONLY (coordinator decision 2026-09-07 15:36Z). This
    readout describes the host's CLAUDE subscription; a codex, antigravity
    or OpenRouter tier is never answered from it, however the lane is
    named — lending the Claude weekly lane to a non-Claude wall is the
    wrong-account parking bug with a new provider on the front. An EMPTY
    tier applies no filter: that is the shape of a caller that does not
    know the node's model, and every product caller now passes one (the
    freeze stamp, the roster mark, the correction pass); the empty form is
    kept for the pure-function tests and is documented rather than trusted.
    """
    tier = str(tier or "").lower()
    if not tier:
        return True
    if tier not in CLAUDE_TIERS:
        return False
    kind = str(lim.get("kind") or "")
    model = str(lim.get("model") or "").lower()
    if kind == "session":
        return True
    if kind == "weekly_all":
        return tier != "fable"
    if kind == "weekly_scoped":
        return tier in model
    # an unrecognized lane: nothing here can say whose quota it is, and the
    # bands below already refuse it a long horizon
    return True


def reset_for(blob: str, now: float | None = None,
              allow_fetch: bool = False,
              trust_lane: bool = True,
              tier: str = "", account: str = "", require_exhausted: bool = False) -> tuple[float | None, str]:
    """The authoritative reset for the limit this error is about →
    `(epoch, "usage:<lane>")`; `(None, "")` when the readout cannot answer.

    ⚠ THIS IS THE CACHED-USAGE HALF ONLY. User ruling 2026-09-07 14:56Z: an
    agent's refresh time comes from the time IN THE LIMIT MESSAGE first, for
    every provider; this readout is consulted only when the message carries
    no time, and then matched to model (`tier`, see `lane_applies`), account
    lane (the caller's `subscription` gate) and limit type (rule 1 below).
    The caller (`supervisor._limit_reset_ts`) enforces that order; nothing
    here may outrank a parsed message time.

    Two rules, and the second is the user's ruling of 2026-08-18 ("if the
    type of limit is not known, default to the shortest one, so that it can
    be checked sooner"):

      1. if the prose names a lane, THAT LANE ANSWERS OR NOTHING DOES —
         scoped lanes matched on the model name. Until 2026-09-07 a named
         lane with no believable entry fell through to another lane inside
         its reach ("a stale named lane falls through to a believable one");
         the user's matching rule — cached usage matched to the limit TYPE
         the message named — forbids that borrowing, even labelled as an
         estimate (coordinator decision 15:32Z, literal). The caller then
         takes its bounded probe floor, which re-asks in minutes.
      2. otherwise take the SOONEST reset on the board, `is_active` or not,
         and never one further out than the SESSION lane. Being active makes a
         lane the likely culprit but does not earn a longer window: this
         number bounds key-billing, and guessing short costs one re-freeze
         while guessing long costs money. The same ruling decided (2026-09-07)
         that an UNNAMED type keeps this shortest-eligible answer rather than
         the latest active constraint.

    `tier` filters the board to the lanes that describe this model's quota
    (`lane_applies`): a Fable node is never answered from the pooled weekly
    lane, and a pooled node never from Fable's scoped pool. Empty = no filter.

    A candidate must land in the future and inside its own lane's length, so
    a stale or absurd `resets_at` is declined rather than believed — which is
    also what keeps a STALE cache honest: an expired reset simply stops being
    a candidate instead of answering with a time that has already passed.

    `allow_fetch` is off by default: the freeze path must never block on the
    network (see `cached`). The background correction pass turns it on.

    ⚠ `trust_lane=False` ignores rule 1 entirely and treats the error as
    unnamed. The lane comes out of the blob's own wording, so a blob nobody
    vouches for — an agent's final answer promoted by the clean-result limit
    gate — would otherwise select its own band by typing the word "weekly",
    and be answered from a lane seven days out for a wall that does not exist
    (redteam 2026-08-18)."""
    now = time.time() if now is None else now
    if account:
        data, age = account_readout(account, allow_fetch=allow_fetch)
    else:
        data = fetch(max_age=REREAD_MAX_AGE) if allow_fetch else cached()
        age = cache_age()
    if not data or not data.get("available"):
        return None, ""
    if age > MAX_EVIDENCE_AGE:
        # a readout this old is a memory, not a measurement — and a broken
        # upstream serves one indefinitely (redteam). Decline, and let the
        # caller's 5-minute probe floor have it.
        return None, ""
    lims = [cast("dict[str, Any]", x)
            for x in cast("list[Any]", data.get("limits") or [])
            if isinstance(x, dict)
            and lane_applies(cast("dict[str, Any]", x), tier)]
    # A generic 429 can describe subscription exhaustion or a short throttle.
    # Only actual exhaustion on an applicable lane permits the usage fallback;
    # the existing unnamed-lane shortest/session-capped policy still applies.
    if require_exhausted and not any(
            isinstance(x.get('percent'), (int, float)) and x['percent'] >= 100
            and _candidate(x, now) is not None for x in lims):
        return None, ''
    def _within(pool: list[dict[str, Any]], at: float,
                lane: str | None) -> list[dict[str, Any]]:
        """The entries whose reset lands inside `lane`'s own length."""
        return [x for x in pool
                if (c := _candidate(x, at)) is not None
                and c <= at + lane_horizon(lane)]

    def _soonest(pool: list[dict[str, Any]]) -> tuple[float, str] | None:
        picked = sorted((t, str(x.get("kind") or "?"))
                        for x in pool if (t := _candidate(x, now)))
        return picked[0] if picked else None

    kind, model = classify(blob) if trust_lane else (None, None)
    hit = None
    if kind:
        hit = _soonest([x for x in lims if str(x.get("kind") or "") == kind
                        and (model is None
                             or model in str(x.get("model") or "").lower())])
        # ⚠ NO FALL-THROUGH (2026-09-07). The older cut borrowed another
        # lane inside the named lane's reach when the named entry was
        # absent or stale — capped, so the 2026-08-18 six-day key-billing
        # window could not recur — but the user's rule matches the cache to
        # the named TYPE, and a lane of another type is not that evidence.
        # `None` here is the honest answer; the caller's probe floor re-asks
        # in minutes, and the correction pass re-reads the board.
    else:
        # ⚠ and the SAME cap on the unnamed branch, which is the one ruling ③
        # is actually about. Capping only the named fall-through left the
        # canonical wording ("Claude AI usage limit reached", no lane word) to
        # answer from a weekly lane six days out — six days of key billing for
        # a wall that may lift in five hours (redteam 2026-08-18). A board
        # that has lost its session entry, or an upstream shape carrying only
        # the weekly one, reaches this with no stale cache involved.
        hit = _soonest(_within(lims, now, "session"))
    if hit is None:
        return None, ""
    ts, lane = hit
    return ts, f"usage:{lane}"
