# pyright: strict
"""Proxied-subscription auth for sandboxed kiosks (user spec).

The sandbox never holds a credential: the in-container CLI points its
ANTHROPIC_BASE_URL at the bridge, and the HOST attaches the subscription
OAuth token to each upstream request (api.BridgeGateway gates who may ask;
api.anthropic_proxy does the attach). This module owns the token: it reads
the host's own Claude Code credentials file and refreshes the OAuth token
in place when it nears expiry — writing back ATOMICALLY so the host CLI and
the proxy share one copy and never drift.

⚠ Semi-documented surface: the refresh endpoint, the public client id, and
OAuth-over-API acceptance (`anthropic-beta: oauth-2025-04-20` + Bearer) are
what Claude Code itself does, not a published contract — expect an
occasional patch when the CLI/API move. Two such drifts are why this module
answered every refresh with a bare `403 Forbidden`: see TOKEN_URL and
USER_AGENT. They are the same mistake twice — a fact the product had already
learned elsewhere and did not carry here.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from typing import Any, cast

CREDS = os.path.expanduser("~/.claude/.credentials.json")
# ⚠ THE HOST MOVED AND THE OLD ONE STILL ANSWERS — which is why this went
# unnoticed. MEASURED 2026-09-11, credential-free, with a deliberately invalid
# refresh token:
#     POST https://console.anthropic.com/v1/oauth/token → 404 not_found_error
#     POST https://platform.claude.com/v1/oauth/token   → 400 invalid_grant
# The old host still resolves, terminates TLS and serves; it simply no longer
# has this path. Both installed Claude Code builds (2.1.241, and 2.1.258 which
# is the build this app launches) carry TOKEN_URL
# "https://platform.claude.com/v1/oauth/token" and contain the string
# "console.anthropic.com" ZERO times.
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"   # Claude Code's public client
# ⚠ NOT COSMETIC — THIS HEADER IS LOAD-BEARING. The OAuth token host sits
# behind an edge that answers urllib's DEFAULT User-Agent with `403 Forbidden`
# and the body `error code: 1010` (a Cloudflare browser-signature ban). It
# arrives BEFORE the OAuth server sees the request, so nothing has looked at
# the refresh token and that "403" says nothing whatsoever about the login.
#
# ⚠ HOW WELL THIS IS ESTABLISHED, precisely: the body of the ORIGINAL live
# failure was never captured — the old code read it and threw it away, which
# is why `_http_failure` keeps it now. What follows is a REPRODUCTION of the
# same request shape from the same machine, sufficient to explain a bare 403
# and not a recording of the incident itself.
#
# MEASURED the same second against the same URL, one variable: no UA → 403
# `error code: 1010`; `axios/1.7.9` → 400 invalid_grant; `orgtree-subproxy/
# 2.0.4` → 400 invalid_grant; and a nonsense `zzqqxx/0.0.1` → 400 invalid_grant
# too. So the edge BLOCKLISTS a known scripting signature rather than
# allowlisting known clients: any honest identifier gets through, and this one
# does not have to impersonate the CLI. The exact string is free to change;
# having one at all is not.
#
# `accounts.py` hit this in its own call and fixed it there. The lesson never
# reached this module, and that omission IS the 403 — so there is one constant
# now, and the next caller inherits the answer instead of rediscovering it.
USER_AGENT = "orgtree/2.0.4"
_lock = threading.Lock()

#: What the modal says when the failure is RECOVERABLE — nothing is wrong with
#: the login, the readout just is not available right now, and an ordinary turn
#: on this account makes the CLI mint a fresh token (user wording, 2026-09-11).
#: ⚠ It must never be shown for a genuinely rejected credential: telling
#: someone to "start a turn" when they are signed out sends them at a wall.
RECOVERABLE_MESSAGE = ("Usage unavailable. Starting a turn on this account "
                       "may refresh it.")
#: …and when the credential really was refused, which a turn CANNOT fix.
SIGNED_OUT_MESSAGE = ("This account is signed out. Sign in again with the "
                      "Claude CLI to see usage.")

#: Markers meaning SOMETHING IN FRONT OF the OAuth server refused to pass the
#: request along — an edge block or a throttle. A response carrying one of
#: these is not an opinion about the credential, however authoritative its
#: status code looks. (limits.py keeps a near-identical pattern for throttle
#: WINDOWS; the two are deliberately left separate — that one decides how long
#: to stand down, this one decides whether anything judged the token.)
_EDGE_REFUSAL = re.compile(
    r"error code: *101[0-9]"      # Cloudflare WAF block page (1010 & neighbours)
    r"|cf-error|cloudflare"
    r"|rate[_ -]?limit|too many requests",
    re.I)

#: The ONLY evidence that the credential itself was refused. ⚠ A BARE STATUS
#: CODE IS NOT ON THIS LIST, deliberately (root review of 2024af5): a 401 or
#: 403 with nothing in it is an UNKNOWN refusal, and this module exists
#: because an unknown refusal was being reported as a known one. Measured, a
#: dead refresh token at this endpoint answers `400 {"error":"invalid_grant"}`
#: — an explicit answer — so requiring one costs nothing real. Being too
#: strict shows "usage unavailable" to someone who is genuinely signed out;
#: being too loose sends someone who is signed in to a sign-in screen that
#: cannot help them. The first is a worse readout, the second is the bug.
_CREDENTIAL_REJECTION = re.compile(
    r"invalid_grant"              # RFC 6749: the refresh token is dead
    r"|invalid_client|unauthorized_client"
    r"|authentication_error",     # Anthropic's own
    re.I)

#: How much of a failure body we will read at all, and how much may ever be
#: shown. Kept apart on purpose — redaction happens on the WHOLE read, and
#: truncation only afterwards (see `_redact`).
_MAX_BODY = 8192
_SNIPPET = 300


class RefreshError(RuntimeError):
    """A refresh that produced no token, WITH its evidence still attached.

    Subclasses `RuntimeError` on purpose: every existing caller catches that
    and keeps working unchanged. What is new is that the failure now carries
    its HTTP status and response body — the 403 this module reported was
    diagnosed blind, because the body said `error code: 1010` the entire time
    and nothing kept it.

    `evidence` is the ONE fact a sign-in prompt may be keyed off, and it is
    None for an edge block, a throttle, a moved endpoint or any transport
    failure, because none of those looked at the token. `user_message` is what
    a person reads; `str(self)` is the technical line and stays out of the
    panel's headline (user ruling 2026-09-11).
    """

    def __init__(self, message: str, *, status: int | None = None,
                 body: str = "",
                 evidence: str | None = None,
                 user_message: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.evidence = evidence
        self.user_message = user_message or (
            SIGNED_OUT_MESSAGE if evidence else RECOVERABLE_MESSAGE)

    @property
    def credential_rejected(self) -> bool:
        return self.evidence is not None


def _judged_credential(status: int, body: str,
                       headers: Any = None) -> bool:
    """Did the endpoint form an opinion about THIS REFRESH TOKEN?

    ⚠ THE DISCRIMINATION IS THE WHOLE POINT, and it is what makes the status
    honest. Signing in again fixes a rejected token and fixes nothing else —
    so when the truth is "a WAF bounced us" or "we asked a host that no longer
    serves this path", saying "sign in again" sends the user through a ritual
    that cannot work and hides the real defect behind their apparent mistake.
    That is exactly what this module did.

    An OAuth `invalid_grant` is the endpoint answering about the token — it is
    what this endpoint returns for a dead refresh token (measured). A BARE
    401/403 IS NOT: nothing in it says the credential was examined, and an
    edge in front of the server answers with exactly those codes. Everything
    else — a 404, a 5xx, a 400 that names no rejection, anything an edge
    stamped — is not either.
    """
    if _EDGE_REFUSAL.search(body):
        return False
    # ⚠ headers as well as body: Cloudflare's challenge can come back with an
    # EMPTY body and only `cf-mitigated` to say so, and a body-only check
    # would read that silence as a rejected credential. `Retry-After` says the
    # same thing about a throttle. (limits.py makes the same two checks.)
    try:
        if headers is not None:
            if headers.get("cf-mitigated") is not None:
                return False
            if str(headers.get("Retry-After") or "").strip():
                return False
    except (AttributeError, TypeError):
        pass
    if status not in (400, 401, 403):
        return False
    return bool(_CREDENTIAL_REJECTION.search(body))


def available() -> bool:
    return os.path.isfile(CREDS)


def _write(doc: dict[str, Any], creds_path: str = CREDS) -> None:
    """Atomic in-place replace — the host CLI and this proxy share one copy
    (per credentials file: the ambient one, or a profile directory's own).
    A failed write must leave neither a half-file nor a stray temp beside the
    real credentials, and it must surface as the RuntimeError every caller
    of get_access_token expects."""
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds_path),
                                   suffix=".tmp")
    except OSError as e:
        raise RuntimeError(f"cannot write Claude credentials at {creds_path}: {e}")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.replace(tmp, creds_path)
    except (OSError, TypeError, ValueError) as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"cannot write Claude credentials at {creds_path}: {e}")


def get_access_token() -> str:
    """The current subscription access token, refreshed in place when it has
    under 5 minutes left. Raises RuntimeError with an actionable message."""
    return _access_token_at(CREDS)


def profile_access_token(profile_dir: str) -> str:
    """multi-account (per-account usage reads): the SAME read+refresh logic
    against a PROFILE DIRECTORY'S own credentials file — a real CLI login in
    that profile holds the same scopes as the ambient one, which is exactly
    the token fetch_for_token's docstring anticipates. Never the ambient
    file: a profile read must not refresh or describe another account."""
    return _access_token_at(os.path.join(profile_dir, ".credentials.json"))


def _redact(raw: str, secret: str) -> str:
    """Take the credential out of a response body — BEFORE anything truncates
    it (root review of 2024af5).

    ⚠ THE ORDER IS THE WHOLE GUARD. Truncating first and replacing second
    fails exactly when it matters: an echoed token straddling the cutoff is no
    longer present to match, `replace` finds nothing, and what is left on
    screen is a PARTIAL CREDENTIAL. So redact the full read first — and then
    handle the same straddle against our own read limit, because a token cut
    by `_MAX_BODY` leaves a prefix at the very end of `raw` that `replace`
    cannot see either. Eight characters is short enough to catch any real
    remnant and long enough not to fire on coincidence.
    """
    if not secret:
        return raw
    raw = raw.replace(secret, "<redacted>")
    for n in range(min(len(secret), len(raw)), 7, -1):
        if raw.endswith(secret[:n]):
            return raw[:-n] + "<redacted>"
    return raw


def _safe_detail(raw: str) -> str:
    """What may be shown of a failure body: the structured OAuth fields when
    there are any, the text otherwise (a WAF block page is not JSON, and
    `error code: 1010` is the most useful thing in it). Second layer only —
    `_redact` has already run on the whole body, so this narrows what is
    displayed rather than being what makes it safe."""
    try:
        doc: Any = json.loads(raw)
    except (ValueError, TypeError):
        doc = None
    if isinstance(doc, dict):
        parts: list[str] = []
        for k in ("error", "error_description", "error_uri"):
            v: Any = cast("dict[str, Any]", doc).get(k)
            if isinstance(v, str) and v:
                parts.append(f"{k}={v}")
            elif isinstance(v, dict):        # {"error":{"type":…,"message":…}}
                for inner in ("type", "message"):
                    iv: Any = cast("dict[str, Any]", v).get(inner)
                    if isinstance(iv, str) and iv:
                        parts.append(f"{k}.{inner}={iv}")
        if parts:
            return " ".join(" ".join(parts).split())[:_SNIPPET]
    return " ".join(raw.split())[:_SNIPPET]


def _http_failure(e: urllib.error.HTTPError, refresh_token: str) -> RefreshError:
    """Turn a refused refresh into an error that still carries its evidence.

    ⚠ The body is read HERE and nowhere else, and only on the FAILURE path — a
    successful token response is the one body that holds secrets. Even so the
    refresh token is redacted out of what we keep, so an endpoint that echoes
    the credential back at us cannot put it into a log line or a UI panel.
    """
    try:
        raw = e.read(_MAX_BODY).decode("utf-8", "replace")
    except Exception:                                # noqa: BLE001
        raw = ""
    detail = _safe_detail(_redact(raw, refresh_token))
    rejected = _judged_credential(e.code, detail, getattr(e, "headers", None))
    msg = f"subscription token refresh failed: HTTP {e.code}"
    if detail:
        msg += f" — {detail}"
    return RefreshError(
        msg, status=e.code, body=detail,
        evidence="measured_refresh_rejected" if rejected else None)


def _access_token_at(creds_path: str) -> str:
    with _lock:
        try:
            # `with`, not a bare open(): the un-closed handle leaked one file
            # object per refresh and this runs on a warm loop.
            with open(creds_path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            # A profile with no readable credentials has never completed a
            # sign-in (or had it removed) — a LOCAL observation, the same kind
            # Codex/Antigravity report as `not_connected`, never a measured
            # server answer. Distinct on purpose: see types.ts.
            raise RefreshError(
                f"no readable Claude credentials at {creds_path}: {e}",
                evidence="not_connected")
        o: dict[str, Any] = doc.get("claudeAiOauth") or {}
        if not o.get("accessToken"):
            raise RefreshError("credentials file has no OAuth access token — "
                               "log in with the Claude Code CLI first",
                               evidence="not_connected")
        if o.get("expiresAt", 0) / 1000 - time.time() > 300:
            return o["accessToken"]
        if not o.get("refreshToken"):
            raise RefreshError("subscription token expired and no refresh "
                               "token present — re-login with the CLI",
                               evidence="not_connected")
        payload: dict[str, Any] = {"grant_type": "refresh_token",
                                   "refresh_token": o["refreshToken"],
                                   "client_id": CLIENT_ID}
        # The CLI names the scope it is renewing. Take it from what THIS FILE
        # records as granted rather than from a list hard-coded here: a refresh
        # may never ask for more than was granted, and a fixed list would
        # quietly over-request for any account holding fewer scopes. Absent or
        # unreadable → omit the parameter, which RFC 6749 §6 defines as "the
        # scope originally granted" — the same thing we wanted.
        scopes = cast("list[Any]", o["scopes"]) if isinstance(
            o.get("scopes"), list) else []
        granted = " ".join(s for s in scopes if isinstance(s, str) and s)
        if granted:
            payload["scope"] = granted
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            TOKEN_URL, data=body,
            headers={"Content-Type": "application/json",
                     "User-Agent": USER_AGENT}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)
        except urllib.error.HTTPError as e:
            raise _http_failure(e, str(o["refreshToken"]))
        except Exception as e:                       # noqa: BLE001
            # transport, TLS, timeout, unparseable success body: nothing
            # judged the credential, so this must never read as a login
            # problem. `evidence=None` is what keeps the sign-in button away.
            raise RefreshError(f"subscription token refresh failed: {e}")
        try:
            access: str = res["access_token"]
        except (KeyError, TypeError) as e:
            raise RefreshError(f"subscription token refresh returned no "
                               f"access token: {e}")
        old_refresh = o["refreshToken"]
        o["accessToken"] = access
        o["refreshToken"] = res.get("refresh_token", old_refresh)
        o["expiresAt"] = int((time.time() + res.get("expires_in", 3600)) * 1000)
        # ⚠ `refreshTokenExpiresAt` is a REAL field of this file (the CLI
        # writes it) and nothing here used to touch it. After a rotation it
        # then described a refresh token that no longer exists, drifting
        # further into the past with every refresh — and both the CLI and
        # this proxy read the one shared copy. Three honest cases:
        #   • the endpoint reports a lifetime → record it
        #   • the refresh token ROTATED and no lifetime came back → the old
        #     value belongs to the replaced token; drop it rather than lie
        #     (absent = unknown, which is what it now is)
        #   • the refresh token did NOT rotate → its expiry is still its own
        rt_in = res.get("refresh_token_expires_in",
                        res.get("refreshTokenExpiresIn"))
        if isinstance(rt_in, (int, float)) and rt_in > 0:
            o["refreshTokenExpiresAt"] = int((time.time() + rt_in) * 1000)
        elif o["refreshToken"] != old_refresh:
            o.pop("refreshTokenExpiresAt", None)
        doc["claudeAiOauth"] = o
        _write(doc, creds_path)
        return o["accessToken"]
