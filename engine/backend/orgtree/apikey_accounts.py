"""API-key account registration — the metered half of the account registry.

User redesign 2026-09-12 (ticket redesign-api-key-inference-accounts): API
keys are ordinary accounts beside subscriptions, replacing the V1 per-org key
path. This module owns HOW a pasted key becomes a registry row and how its
secret is disposed of on removal; routing, injection and spend accounting
live in registry.py, and nothing here relaxes the secrets discipline:

  · claude — the key goes to the machine token store (tokens.py: separate
    file, store-first, never serialized back out) and the row references it
    as {kind: "apikey", token_ref}. Spawns inject ANTHROPIC_API_KEY through
    registry.inject_binding, the one injector.
  · openai — the SAME rule, deliberately. Codex's native key-auth form is
    an auth.json holding the raw key, and the first cut of this module wrote
    one: a second durable home for a secret, which the docket's
    token-store-only rule forbids outright. The key now goes to the token
    store exactly as claude's does and the row carries only a token_ref;
    spawns inject OPENAI_API_KEY through registry.inject_binding. The codex
    process still needs a CODEX_HOME, so one is DERIVED per row at spawn
    (`codex_key_home`) — it isolates the spawn from the ambient login and
    holds no credential of any kind.
  · google — refused; no API-key login exists (measured 1.1.24).

Registration performs no provider-side validation beyond non-emptiness: the
ticket left provider validation unspecified, a wrong key fails loudly at its
first turn, and the row's auth standing records what was observed. Idempotent
on the VALUE for both providers — re-pasting a stored key lands on its
existing row instead of minting a twin that would route twice.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from typing import Any

from . import managed_profiles, registry, store, tokens

PROVIDERS = ("claude", "openai")
AUTH_FILE = "auth.json"


def normalize_key(value: str) -> str:
    """Outer trim always; internal whitespace removed only for the positively
    identified `sk-` families (both providers'), where a wrapped-terminal
    paste inserts CR/LF that turns into an upstream 401 indistinguishable
    from revocation — accounts.normalize_setup_token's lesson, applied to
    the same alphabet."""
    key = str(value or "").strip()
    return re.sub(r"\s+", "", key) if key.startswith("sk-") else key


def _key_row_id(key: str) -> str:
    """Deterministic from the value, like accounts.register_key's ids — the
    id IS a hash of the key, which is what makes re-pasting idempotent."""
    return "ak" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def _profiles_base() -> str:
    base = os.path.join(store.DATA_ROOT, "profiles")
    os.makedirs(base, exist_ok=True)
    return base


def codex_key_home(row: dict[str, Any]) -> str:
    """The CODEX_HOME a metered openai spawn runs in — derived, never stored.

    ⚠ IT HOLDS NO SECRET. The key rides the environment from the token store
    (registry.inject_binding); this directory exists so the spawn does not
    inherit the ambient ~/.codex, whose auth.json would put the turn back on
    the subscription login the operator was trying not to use. Created on
    demand with the same private ACL as any managed profile, and removed
    with the row."""
    base = os.path.join(_profiles_base(), f"openai-key-{row['id']}")
    if not os.path.isdir(base):
        managed_profiles.create_profile_at(base)
    return base


def register(provider: str, key: str, *,
             label: str = "") -> tuple[dict[str, Any], bool]:
    """A pasted provider API key becomes (or re-finds) a registry account row.

    Returns `(row, created)`. STORE FIRST on the claude path — the token
    write precedes row creation so a registry failure can never discard the
    secret the user just handed over."""
    provider = str(provider or "")
    if provider not in PROVIDERS:
        raise ValueError(
            f"{provider or 'that provider'} has no API-key account form — "
            f"API-key accounts exist for claude and openai (google offers "
            f"no API-key login)")
    key = normalize_key(key)
    if not key:
        raise ValueError("refusing to register an empty API key")
    # ONE PATH FOR BOTH PROVIDERS. The row is a token_ref and nothing else;
    # idempotence is on the ref, which is a hash of the value, so re-pasting
    # a stored key lands on its existing row for either provider.
    kid = _key_row_id(key)
    tokens.put(kid, key)              # ← durable before anything can object
    for row in registry.list_accounts():
        cred = row.get("credential") or {}
        if (row.get("provider") == provider
                and cred.get("kind") == "apikey"
                and cred.get("token_ref") == kid):
            return row, False
    row = registry.create_account(
        provider, label or "API key",
        {"kind": "apikey", "token_ref": kid}, mode="apikey")
    return row, True


def forget_credentials(row: dict[str, Any]) -> None:
    """Dispose of a REMOVED apikey row's secret material, best-effort.

    Both providers forget their token-store entry — that is where the key
    lives. An openai row may also leave behind the DERIVED codex home, which
    holds no credential but should not outlive its row; it is removed only
    when it sits inside the engine's own profiles base, so a mislabelled row
    can never take out a login directory the user imported. Subscription
    rows are untouched entirely: their directories are logins, not material
    this module minted."""
    if registry.account_mode(row) != "apikey":
        return
    cred = row.get("credential") or {}
    if cred.get("kind") == "apikey":
        tokens.forget(str(cred.get("token_ref") or ""))
        if row.get("provider") == "openai":
            derived = os.path.join(_profiles_base(),
                                   f"openai-key-{row.get('id')}")
            if os.path.isdir(derived):
                shutil.rmtree(derived, ignore_errors=True)
        return
    if cred.get("kind") != "managed":
        return
    path = os.path.abspath(str(cred.get("path") or ""))
    base = os.path.abspath(_profiles_base())
    try:
        inside = os.path.commonpath([path, base]) == base and path != base
    except ValueError:                       # different drives on Windows
        inside = False
    if inside and os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
