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
        out = {"kind": kind, "path": path}
        if credential.get("default_config") is True:
            if kind != "imported":
                raise ValueError("default config is only valid for imported profiles")
            out["default_config"] = True
        return out
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
    if credential.get("default_config") and provider != "claude":
        raise ValueError("default config selector is Claude-only")
    with _lock:
        doc = load(strict=True)
        n = int(doc["id_counters"].get(provider, 0)) + 1
        doc["id_counters"][provider] = n
        t = int(doc["tint_counters"].get(provider, 0)) + 1
        doc["tint_counters"][provider] = t
        # The immutable ID is the public name. Retain label only as ignored
        # legacy storage for old registries/clients; never allocate a second
        # sequence of display names or renumber surviving accounts.
        row = {
            "id": f"{provider}-{n}",
            "provider": provider,
            "harness": harness or DEFAULT_HARNESS[provider],
            "label": str(label or f"{provider}-{n}"),
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


# ------------------------------------------------------------------ standing
def standing_of(row: dict[str, Any],
                now: float | None = None) -> dict[str, Any]:
    """The account's live standing for boards (design D3): its ACTIVE marks
    per pool, each carrying its own provenance and native window label —
    nothing is summed or collapsed across providers, and an inferred mark is
    never presented as a measurement. `auth` rides along (authenticated /
    unauthenticated / unobserved — the third state gates nothing and renders
    as itself, never as ready)."""
    now = time.time() if now is None else now
    marks = {k: dict(m) for k, m in (row.get("marks") or {}).items()
             if float(m.get("until", 0)) > now}
    return {"auth": row.get("auth", "unobserved"),
            "state": "limited" if marks else "ready",
            "marks": marks}


# --------------------------------------------------------- binding validator
class BindingRefused(ValueError):
    """A binding the validator refuses — the reason names both sides."""


def primary_name(provider: str) -> str:
    """The public name of a provider's ambient account, even without a row."""
    return f"{provider}/primary"


def account_name(row: dict[str, Any]) -> str:
    from . import accountusage
    from .registry_migration import observe_ambient
    return accountusage.canonical_name(row, resolve_alias("primary"), observe_ambient())


def validate_selection(org_slug: str, tier: str,
                       account: str) -> dict[str, Any]:
    """Resolve a public account selection without changing registry or org.

    Registered names are immutable row IDs. Labels and emails are metadata:
    changing either cannot redirect an existing selector. `primary` is the
    provider-relative shorthand; the qualified spelling is safe to copy from
    a board containing several providers. Empty remains a hire-only legacy
    spelling, handled by the ledger, never a silent retool no-op.
    """
    from . import providers
    want = str(account).strip()
    provider = providers.provider_of(str(tier or ""))
    if want == "primary" or want in {primary_name(p) for p in PROVIDERS}:
        if provider not in PROVIDERS:
            raise BindingRefused("an OpenRouter-tier node has no account binding")
        if want != "primary" and want != primary_name(provider):
            raise BindingRefused(
                f"account {want!r} does not match the node's provider {provider}")
        return {"id": "", "name": primary_name(provider),
                "label": primary_name(provider), "provider": provider,
                "credential": {"kind": "ambient"},
                "auth": "unobserved", "marks": {}}
    if not want:
        raise BindingRefused("name an account, or use 'primary' to return to the ambient account")
    row = validate_binding(org_slug, tier, want)
    return {**row, "name": account_name(row)}


def validate_binding(org_slug: str, tier: str,
                     account_id: str) -> dict[str, Any]:
    """THE one binding validator (design D2d: one rule, every surface — the
    operator endpoint and account_assign both call this, so neither door can
    pass what the other refuses, and being the user does not bypass it).

    Three checks, in refusal order:
      1. the account exists;
      2. AVAILABILITY — an org-key row (origin_org) is bindable only within
         its origin org (user ruling 18:38Z, the declared exception);
      3. PROVIDER COMPATIBILITY — the account's provider must equal
         providers.provider_of(tier) (D-196, the one axis): a claude-tier
         node on a Codex account is a spawn that authenticates as nothing
         useful, so it never comes into existence.
    """
    from . import providers
    try:
        row = get_account(account_id)
    except UnknownAccount:
        raise BindingRefused(
            f"no account {account_id!r} is registered") from None
    scope = str(row.get("origin_org") or "")
    if scope and scope != org_slug:
        raise BindingRefused(
            f"account {row['id']} is an org key restricted to its origin "
            f"organization {scope!r} — org {org_slug!r} cannot bind it "
            f"(user ruling: legacy org keys keep their org restriction)")
    if (row["credential"]["kind"] in ("managed", "imported")
            and row["provider"] not in PROFILE_VAR):
        raise BindingRefused(
            f"{row['provider']} does not support selecting a separate account for a turn")
    node_provider = providers.provider_of(str(tier or ""))
    if node_provider == "openrouter":
        raise BindingRefused(
            f"an OpenRouter-tier node has no account binding — that lane "
            f"is not an account (design D6)")
    if row["provider"] != node_provider:
        raise BindingRefused(
            f"account {row['id']} is a {row['provider']} account but the "
            f"node's tier {tier!r} runs on {node_provider} — a binding "
            f"must match the tier's provider")
    return row


# ------------------------------------------------------------------ the seam
#: the provider's profile-credential variable — the ONE mapping the injector
#: and the identity cross-check both read, so they cannot disagree.
PROFILE_VAR = {"claude": "CLAUDE_CONFIG_DIR", "openai": "CODEX_HOME"}

#: the marker every bound spawn carries. Stripped by clean_env and re-injected
#: here only — an inherited value can never survive into a spawn.
MARKER = "ORGTREE_ACCOUNT_ID"


def inject_binding(env: dict[str, str], row: dict[str, Any], *,
                   secret_resolver: Any = None) -> dict[str, str]:
    """THE single injector (design N2): the marker and its credential are
    written together, by this function only, so no code path can set one
    without the other and `identity_in_env`'s cross-check has a pair to check.

    Profile rows set the provider's profile var to the row's path. Token rows
    need the caller's `secret_resolver(token_ref) -> str` (key material lives
    outside the registry): an org-key ref (`org-api-key:<slug>`) injects
    ANTHROPIC_API_KEY — the same lane that credential always billed — and a
    legacy ref injects CLAUDE_CODE_OAUTH_TOKEN, the retained key lane. A
    resolver miss RAISES: a spawn with a binding it cannot honor must fail
    loudly at build time, never run half-bound (the admission gate, not this
    seam, owns "account cannot run" waits)."""
    cred = row["credential"]
    kind = cred["kind"]
    if kind in ("imported", "managed"):
        var = PROFILE_VAR.get(row["provider"])
        if not var:
            raise RuntimeError(
                f"no spawn binding lane exists yet for provider "
                f"{row['provider']!r} (account {row['id']})")
        if cred.get("default_config"):
            # Setting CLAUDE_CONFIG_DIR even to ~/.claude moves the CLI's
            # metadata from ~/.claude.json to ~/.claude/.claude.json.
            env.pop(var, None)
            home = os.path.dirname(os.path.abspath(cred["path"]))
            env["HOME"] = home
            env["USERPROFILE"] = home
        else:
            env[var] = cred["path"]
    else:
        if secret_resolver is None:
            raise RuntimeError(
                f"token account {row['id']} needs a secret resolver")
        secret = secret_resolver(cred["token_ref"])
        if not secret:
            raise RuntimeError(
                f"token account {row['id']}: credential "
                f"{cred['token_ref']!r} did not resolve — refusing a "
                f"half-bound spawn")
        if str(cred["token_ref"]).startswith("org-api-key:"):
            env["ANTHROPIC_API_KEY"] = secret
        else:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = secret
    env[MARKER] = row["id"]
    return env


def identity_mismatch(env: dict[str, str]) -> str | None:
    """The N2 cross-check, shared by identity_in_env and the spawn assertion:
    a marker naming a profile-kind row must travel with exactly that row's
    profile var. Answers the named mismatch, or None when the pair is sound
    (or no marker is present)."""
    marker = env.get(MARKER)
    if not marker:
        return None
    try:
        row = get_account(marker)
    except UnknownAccount:
        return f"account-env-mismatch:{marker}"
    cred = row["credential"]
    if cred["kind"] in ("imported", "managed"):
        var = PROFILE_VAR.get(row["provider"], "")
        if cred.get("default_config"):
            home = os.path.normcase(os.path.dirname(os.path.abspath(cred["path"])))
            if (env.get(var) or any(os.path.normcase(os.path.abspath(env.get(k) or ".")) != home
                                    for k in ("HOME", "USERPROFILE"))):
                return f"account-env-mismatch:{marker}"
        elif not var or env.get(var) != cred["path"]:
            return f"account-env-mismatch:{marker}"
        return None
    # TOKEN rows carry the same hazard (Opus S3 finding: an exempted kind
    # would answer a marker travelling with the WRONG token as authoritative
    # — the confident-wrong-attribution N2 exists to prevent). A legacy ref
    # is verified by value: key_for_token maps the injected token back to its
    # row id, marker says B and the token says A ⇒ mismatch. An org-key ref
    # is verified by LANE PRESENCE only — value verification would mean
    # comparing secrets the registry never holds, so the pair check is that
    # the key lane is populated at all; attribution of a wrong org key is the
    # api-key sentinel's existing territory.
    ref = str(cred["token_ref"])
    if ref.startswith("org-api-key:"):
        if not env.get("ANTHROPIC_API_KEY"):
            return f"account-env-mismatch:{marker}"
    else:
        from .accounts import key_for_token
        if key_for_token(env.get("CLAUDE_CODE_OAUTH_TOKEN", "")) != ref:
            return f"account-env-mismatch:{marker}"
    return None


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
        new = {"until": float(until), "window": str(window),
               "observed_at": now, "provenance": provenance}
        # TWO-DIMENSIONAL SUPERSESSION (accounts.record_limit's never-shorten
        # invariant, carried over — under wait semantics a shortened mark is a
        # wait not honoured: the node admits into a wall somebody already
        # measured, and can flap between two windows reporting on one pool.
        # Plus the provenance axis): a MEASUREMENT replaces a GUESS outright,
        # even when shorter; a guess never replaces a measurement; between
        # marks of the SAME provenance the later `until` is the one still
        # known to be true, so the entry with it is kept whole.
        existing = row["marks"].get(key)
        if existing is None:
            row["marks"][key] = new
        elif existing["provenance"] == "inferred" and provenance == "observed":
            row["marks"][key] = new
        elif existing["provenance"] == provenance \
                and float(existing["until"]) < new["until"]:
            row["marks"][key] = new
        # else: keep the existing mark whole (observed over inferred, or the
        # later same-provenance horizon)
        if key == "pooled" and FABLE not in row["marks"]:
            row["marks"][FABLE] = {"until": float(until),
                                   "window": str(window), "observed_at": now,
                                   "provenance": "inferred"}
        save(doc)
        return True


def correct_mark(account_id: str, tier: str, expected_until: float | None,
                 until: float, *, provenance: str) -> bool:
    """Replace only the exact mark whose background lookup we own."""
    if provenance not in PROVENANCE or until <= time.time():
        return False
    with _lock:
        doc = load(strict=True)
        try:
            row = get_account(account_id, doc)
        except UnknownAccount:
            return False
        key = pool_key(tier)
        mark = row['marks'].get(key)
        if mark is None or mark['until'] != expected_until:
            return False
        now = time.time()
        row['marks'][key] = {**mark, 'until': float(until), 'provenance': provenance,
                             'observed_at': now}
        if key == 'pooled':
            sibling = row['marks'].get(FABLE)
            # Carry forward only this pool's inferred companion. An independent
            # or observed Fable deadline must survive a pooled correction.
            if (sibling is None or float(sibling.get('until', 0)) <= now
                    or (sibling.get('provenance') == 'inferred'
                        and sibling.get('until') == expected_until)):
                row['marks'][FABLE] = {**mark, 'until': float(until),
                                      'provenance': 'inferred', 'observed_at': now}
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
