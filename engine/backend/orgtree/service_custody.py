"""Conservative credential custody decisions for the private v3 boot service.

This is a policy boundary, not a credential reader. A caller running under the
service's filtered operator identity supplies whether its exact credential
carrier is readable. Unknown provider custody never becomes a boot-safe turn
merely because a login worked on the desktop once. Unknown Git custody is
allowed for a service-safe provider under the user ruling of 2026-09-23,
with prompts disabled and no automatic whole-turn replay.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Literal, Mapping, Any


Custody = Literal["file", "session", "unknown"]
Decision = Literal["service", "bridge", "unavailable"]

WAITING_FOR_SIGN_IN = (
    "Waiting for sign-in: this account's credentials live in Windows' protected store"
)


@dataclass(frozen=True)
class Admission:
    decision: Decision
    reason: str


def provider_custody(account: Mapping[str, Any]) -> Custody:
    """Classify the selected account's known credential carrier.

    Profile and token-store rows are ordinary local files. The Google CLI's
    subscription OAuth login uses the OS keyring. An ambient account must be
    resolved by its provider-specific file probe before it can be trusted.
    """
    provider = account.get("provider")
    credential = account.get("credential")
    kind = credential.get("kind") if isinstance(credential, dict) else None
    mode = account.get("mode", "subscription")
    if kind in ("apikey", "token") and provider in ("claude", "openai", "google"):
        return "file"
    if kind in ("managed", "imported") and provider in ("claude", "openai"):
        return "file"
    if kind == "ambient" and provider in ("claude", "openai"):
        return "file"
    if provider == "google" and mode == "subscription":
        return "session"
    return "unknown"


def probe_provider_file(account: Mapping[str, Any], *, home: Path,
                        has_token: Any) -> bool:
    """Check only this account's known carrier under the current OS identity.

    ``has_token`` is the existing token-store lookup (``tokens.has`` in the
    engine). This returns no path, token, account name or exception text that
    could expose credential material through a status panel.
    """
    if provider_custody(account) != "file":
        return False
    credential = account.get("credential")
    if not isinstance(credential, dict):
        return False
    kind = credential.get("kind")
    if kind in ("apikey", "token"):
        ref = credential.get("token_ref")
        return isinstance(ref, str) and bool(ref) and bool(has_token(ref))
    provider = account.get("provider")
    if kind == "ambient":
        root = home / (".claude" if provider == "claude" else ".codex")
    else:
        path = credential.get("path")
        if not isinstance(path, str) or not Path(path).is_absolute():
            return False
        root = Path(path)
    name = ".credentials.json" if provider == "claude" else "auth.json"
    try:
        with (root / name).open(encoding="utf-8") as stream:
            document = json.load(stream)
    except (OSError, ValueError):
        return False
    if not isinstance(document, dict):
        return False
    if provider == "claude":
        oauth = document.get("claudeAiOauth")
        return isinstance(oauth, dict) and isinstance(oauth.get("accessToken"), str) \
            and bool(oauth["accessToken"])
    tokens = document.get("tokens")
    return (isinstance(document.get("OPENAI_API_KEY"), str)
            and bool(document["OPENAI_API_KEY"])) or (isinstance(tokens, dict)
            and isinstance(tokens.get("access_token"), str)
            and bool(tokens["access_token"]))


def decide(account: Mapping[str, Any], *, provider_file_readable: bool,
           git_custody: Custody, bridge_on: bool) -> Admission:
    """Return the identity permitted to run a provider-backed agent turn.

    The provider probe must inspect the selected account's exact profile or
    token-store carrier under the service identity. Git custody must likewise
    be established independently when known. Unknown Git custody does not
    suppress a service-safe provider turn: Git prompts are disabled by the
    service process environment, and a remote operation needing a protected
    credential fails for the agent to retry after a real sign-in. A missing
    declared provider file never falls back to another account.
    """
    provider = provider_custody(account)
    if provider == "file" and not provider_file_readable:
        return Admission("unavailable", "Selected account credential file is unavailable")
    if provider == "unknown":
        return Admission("unavailable", "Credential custody could not be verified")
    if provider == "session" or git_custody == "session":
        if bridge_on:
            return Admission("bridge", "Signed-in-user bridge is available")
        return Admission("unavailable", WAITING_FOR_SIGN_IN)
    if git_custody == "unknown":
        return Admission("service", "Provider is service-safe; Git prompts are disabled")
    return Admission("service", "Selected provider and Git credentials are service-safe")
