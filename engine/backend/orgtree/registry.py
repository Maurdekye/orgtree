"""The provider-agnostic account registry — WHO can be billed on this machine.

The symmetric multi-account system's document (design: v2-accounts-design.md,
user authorization 2026-09-09, docs/v2-user-decisions.md dated entry). One row
per account, machine-global, every provider together:

  · id            — stable slug, allocated once, never reused. THE identity
                    domain for attribution, limit marks and warm-pool claims.
  · provider      — claude | openai | google. OpenRouter is NOT an account
                    (its lane is a bearer key with no profile dir; see design
                    D6) and is refused here rather than half-represented.
  · harness       — stored, not inferred: provider and harness genuinely
                    diverge (the OpenRouter lane runs the claude-code harness
                    against a foreign endpoint), so the axis is explicit.
  · credential    — {kind: imported|managed, path} for profile-directory
                    accounts, or {kind: token, token_ref} for the retained
                    legacy key rows (compatibility only — new setup never
                    mints these). NEVER key material: token_ref is the legacy
                    store's row id, the path is a directory name.
  · marks         — [pool] = {until, window, observed_at, provenance}: this
                    account's capacity for that pool is used up until `until`.
                    `provenance` is observed|inferred and every consumer that
                    shows a mark shows which it is — an inference is never
                    presented as a measurement (coordinator ruling 18:18Z).
  · tint_ordinal  — allocated once per provider, never reused or reindexed:
                    removing a row repaints nobody (design A(h)).
  · origin_org    — org-key rows only: the account is bindable ONLY within
                    this org (user ruling 18:38Z — legacy org keys keep their
                    org restriction; the declared exception to the
                    all-accounts-all-orgs rule).

Same storage discipline as accounts.py, deliberately: strict loads for every
read-modify-write so a mutation can never replace an unreadable file with a
blank one, and `_reject_secrets` on every save — this file holds identity and
state, never credentials.

This module is S1 of the staged implementation: rows, marks and allocation.
Migration (ambient rows, universal bindings, org-key evidence) is S2; the
spawn/identity seam is S3; admission is S4. accounts.py's legacy machinery is
NOT modified here — non-placement consumers keep working (Q3 ruling), and the
PRIMARY sentinel is bridged via the alias map the S2 migration writes.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from typing import Any

from . import store
from .accounts import POOLED, FABLE, _reject_secrets

REGISTRY2_NAME = "accounts-registry.json"
VERSION = 1
_lock = threading.RLock()
_log = logging.getLogger("orgtree.registry")

PROVIDERS = ("claude", "openai", "google")
#: the harness each provider's accounts authenticate through today. Stored on
#: the row (not derived) so the axis survives a future divergence.
DEFAULT_HARNESS = {"claude": "claude-code", "openai": "codex-cli",
                   "google": "agy"}
CREDENTIAL_KINDS = ("imported", "managed", "token")
AUTH_STATES = ("authenticated", "unauthenticated", "unobserved")
PROVENANCE = ("observed", "inferred")

#: canonical mark key for a tier: the three pooled tiers share one entry.
def pool_key(tier: str) -> str:
    return "pooled" if tier in POOLED else str(tier or "")


class RegistryUnreadable(RuntimeError):
    """The registry file exists but could not be understood."""


class UnknownAccount(KeyError):
    """A caller named an account id this registry has no row for."""


def registry_path() -> str:
    # resolved per call, never captured at import — store.DATA_ROOT is what
    # the rest of the backend actually uses (same rule as accounts.py).
    return os.path.join(store.DATA_ROOT, REGISTRY2_NAME)


def _blank() -> dict[str, Any]:
    return {"version": VERSION, "accounts": [], "aliases": {},
            "id_counters": {}, "tint_counters": {}}


def load(*, strict: bool = False) -> dict[str, Any]:
    """The registry, or a blank one. Corrupt files read as blank for READERS;
    strict=True (every read-modify-write) raises instead, so a mutation can
    never silently replace an unreadable file with an empty registry."""
    try:
        with open(registry_path(), encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return _blank()
    except (OSError, json.JSONDecodeError) as e:
        if strict:
            raise RegistryUnreadable(
                f"{registry_path()} exists but could not be read ({e}) — "
                f"refusing to overwrite it with a blank registry") from None
        return _blank()
    if not isinstance(doc, dict) or doc.get("version") != VERSION:
        if strict:
            raise RegistryUnreadable(
                f"{registry_path()} is version "
                f"{doc.get('version') if isinstance(doc, dict) else '?'!r}, "
                f"not {VERSION} — refusing to overwrite it")
        return _blank()
    if not isinstance(doc.get("accounts"), list):
        doc["accounts"] = []
    doc["accounts"] = [a for a in doc["accounts"]
                       if isinstance(a, dict) and a.get("id")]
    for field in ("aliases", "id_counters", "tint_counters"):
        if not isinstance(doc.get(field), dict):
            doc[field] = {}
    return doc


def save(doc: dict[str, Any]) -> None:
    _reject_secrets(doc)
    path = registry_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


# ------------------------------------------------------------------- accounts
def _validate_credential(credential: Any) -> dict[str, Any]:
    if not isinstance(credential, dict):
        raise ValueError("credential must be an object")
    kind = credential.get("kind")
    if kind not in CREDENTIAL_KINDS:
        raise ValueError(f"unknown credential kind {kind!r}")
    if kind in ("imported", "managed"):
        path = credential.get("path")
        if not path or not isinstance(path, str):
            raise ValueError(f"a {kind} credential needs a profile path")
        return {"kind": kind, "path": path}
    ref = credential.get("token_ref")
    if not ref or not isinstance(ref, str):
        raise ValueError("a token credential needs the legacy store row id")
    return {"kind": "token", "token_ref": ref}


def create_account(provider: str, label: str, credential: dict[str, Any], *,
                   harness: str | None = None, origin_org: str | None = None,
                   registered_from: str = "") -> dict[str, Any]:
    """Mint a row. Ids and tint ordinals are counters that only go up, so
    neither is ever reused — removal repaints and re-identifies nobody."""
    if provider not in PROVIDERS:
        raise ValueError(
            f"unknown provider {provider!r} — the account model covers "
            f"harness-authenticated providers only (design D6)")
    credential = _validate_credential(credential)
    with _lock:
        doc = load(strict=True)
        n = int(doc["id_counters"].get(provider, 0)) + 1
        doc["id_counters"][provider] = n
        t = int(doc["tint_counters"].get(provider, 0)) + 1
        doc["tint_counters"][provider] = t
        row = {
            "id": f"{provider}-{n}",
            "provider": provider,
            "harness": harness or DEFAULT_HARNESS[provider],
            "label": str(label or f"{provider} account {n}"),
            "credential": credential,
            "identity": {},
            "auth": "unobserved",
            "marks": {},
            "tint_ordinal": t,
            "created_at": time.time(),
            "registered_from": str(registered_from or ""),
        }
        if origin_org:
            row["origin_org"] = str(origin_org)
        doc["accounts"].append(row)
        save(doc)
        return dict(row)


def get_account(account_id: str,
                doc: dict[str, Any] | None = None) -> dict[str, Any]:
    doc = doc if doc is not None else load()
    resolved = doc["aliases"].get(account_id, account_id)
    for row in doc["accounts"]:
        if row["id"] == resolved:
            return row
    raise UnknownAccount(account_id)


def resolve_alias(account_id: str) -> str:
    doc = load()
    return str(doc["aliases"].get(account_id, account_id))


def list_accounts(org: str | None = None) -> list[dict[str, Any]]:
    """Every account, or the accounts AVAILABLE to `org`: the whole registry
    minus org-key rows scoped to a DIFFERENT origin org (user ruling 18:38Z —
    the one declared exception to all-accounts-all-orgs)."""
    rows = load()["accounts"]
    if org is None:
        return [dict(r) for r in rows]
    return [dict(r) for r in rows
            if not r.get("origin_org") or r["origin_org"] == org]


def set_auth(account_id: str, state: str) -> None:
    if state not in AUTH_STATES:
        raise ValueError(f"unknown auth state {state!r}")
    with _lock:
        doc = load(strict=True)
        get_account(account_id, doc)["auth"] = state
        save(doc)


def set_identity(account_id: str, identity: dict[str, Any]) -> None:
    with _lock:
        doc = load(strict=True)
        get_account(account_id, doc)["identity"] = dict(identity or {})
        save(doc)


def remove_account(account_id: str) -> bool:
    """Raw removal. Binding checks (refuse while agents are bound) live at
    the API layer where org documents are reachable — S5, not here."""
    with _lock:
        doc = load(strict=True)
        before = len(doc["accounts"])
        doc["accounts"] = [r for r in doc["accounts"]
                           if r["id"] != account_id]
        doc["aliases"] = {k: v for k, v in doc["aliases"].items()
                          if v != account_id}
        if len(doc["accounts"]) == before:
            return False
        save(doc)
        return True


# ---------------------------------------------------------------------- marks
def record_mark(account_id: str, tier: str, until: float, *,
                window: str = "", provenance: str = "observed",
                now: float | None = None) -> bool:
    """The ONLY writer of (account, pool) capacity marks.

    The identity domain is registry ids (design finding 2): an unknown id is
    refused as a no-op — a stale attribution must not resurrect or invent a
    row — but LOGGED, never silent, so a discarded observation is visible.

    D-152 ride-along, kept by explicit ruling (18:18Z): a limit observed on
    the pooled big-tier bucket ALSO marks fable — same account only, one
    directional, ABSENT-ONLY (a live fable mark of any provenance is never
    altered), the source pool's horizon, and provenance "inferred" so no
    surface can present the guess as a measurement. There is no reverse:
    a fable limit marks fable alone.
    """
    if provenance not in PROVENANCE:
        raise ValueError(f"unknown provenance {provenance!r}")
    now = time.time() if now is None else now
    if until <= now:
        return False
    with _lock:
        doc = load(strict=True)
        try:
            row = get_account(account_id, doc)
        except UnknownAccount:
            _log.warning(
                "discarding limit mark for unknown account %r (tier %r) — "
                "unknown ids never mint rows", account_id, tier)
            return False
        _prune(row, now)
        key = pool_key(tier)
        row["marks"][key] = {"until": float(until), "window": str(window),
                             "observed_at": now, "provenance": provenance}
        if key == "pooled" and FABLE not in row["marks"]:
            row["marks"][FABLE] = {"until": float(until),
                                   "window": str(window), "observed_at": now,
                                   "provenance": "inferred"}
        save(doc)
        return True


def active_mark(account_id: str, tier: str,
                now: float | None = None) -> dict[str, Any] | None:
    """The live mark gating `tier` on this account, or None. Stateless over
    the durable document by design (N1): the admission gate calls this on
    every attempt and holds nothing in memory."""
    now = time.time() if now is None else now
    try:
        row = get_account(account_id)
    except UnknownAccount:
        return None
    mark = row["marks"].get(pool_key(tier))
    if not mark or float(mark.get("until", 0)) <= now:
        return None
    return dict(mark)


def clear_expired(now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _lock:
        doc = load(strict=True)
        for row in doc["accounts"]:
            _prune(row, now)
        save(doc)


def _prune(row: dict[str, Any], now: float) -> None:
    row["marks"] = {k: m for k, m in row["marks"].items()
                    if float(m.get("until", 0)) > now}
