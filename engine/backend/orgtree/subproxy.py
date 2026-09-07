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
occasional patch when the CLI/API move.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import urllib.request
from typing import Any

CREDS = os.path.expanduser("~/.claude/.credentials.json")
TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"   # Claude Code's public client
_lock = threading.Lock()


def available() -> bool:
    return os.path.isfile(CREDS)


def _write(doc: dict[str, Any]) -> None:
    """Atomic in-place replace — the host CLI and this proxy share one copy.
    A failed write must leave neither a half-file nor a stray temp beside the
    real credentials (the directory is the user's ~/.claude), and it must
    surface as the RuntimeError every caller of get_access_token expects."""
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(CREDS), suffix=".tmp")
    except OSError as e:
        raise RuntimeError(f"cannot write Claude credentials at {CREDS}: {e}")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.replace(tmp, CREDS)
    except (OSError, TypeError, ValueError) as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"cannot write Claude credentials at {CREDS}: {e}")


def get_access_token() -> str:
    """The current subscription access token, refreshed in place when it has
    under 5 minutes left. Raises RuntimeError with an actionable message."""
    with _lock:
        try:
            doc = json.load(open(CREDS, encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(f"no readable Claude credentials at {CREDS}: {e}")
        o: dict[str, Any] = doc.get("claudeAiOauth") or {}
        if not o.get("accessToken"):
            raise RuntimeError("credentials file has no OAuth access token — "
                               "log in with the Claude Code CLI first")
        if o.get("expiresAt", 0) / 1000 - time.time() > 300:
            return o["accessToken"]
        if not o.get("refreshToken"):
            raise RuntimeError("subscription token expired and no refresh "
                               "token present — re-login with the CLI")
        body = json.dumps({"grant_type": "refresh_token",
                           "refresh_token": o["refreshToken"],
                           "client_id": CLIENT_ID}).encode()
        req = urllib.request.Request(
            TOKEN_URL, data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)
        except Exception as e:                       # noqa: BLE001
            raise RuntimeError(f"subscription token refresh failed: {e}")
        try:
            access: str = res["access_token"]
        except (KeyError, TypeError) as e:
            raise RuntimeError(f"subscription token refresh returned no "
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
        _write(doc)
        return o["accessToken"]
