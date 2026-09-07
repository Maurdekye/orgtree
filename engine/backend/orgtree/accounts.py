"""Machine-local account routing — WHERE each model's prompts go on this machine.

The user's 2026-08-25 redesign, replacing the D-144 registry/pin/selection
stack wholesale. Two facts and nothing else:

  · the key list       — the SECONDARY accounts this machine may bill, as
                         pasted `claude setup-token` keys, in priority order
  · usage_refreshes    — `[account][tier] = refresh-at | absent`, the TOTAL
                         routing state: an entry exists iff that account's
                         capacity for that tier is used up, and holds the
                         epoch when it refreshes

The PRIMARY account is not stored here at all: it is whoever Claude Code is
signed in as on this machine, read live from the CLI's own config. It is not
switchable from any UI — logging in/out with the CLI is the only mover.

Routing is per MODEL TIER and machine-global: a tier runs on the highest-
priority account (primary first, then keys in list order) whose capacity for
it is not used up. There is no per-org selection, no pin, no adopted-identity
registry — everything that was not this machine's own routing state is gone
(user ruling 2026-08-25: "all other state not related to this machine is to
be dropped from the internal system").

⚠ THE INVARIANT CARRIED OVER FROM THE OLD REGISTRY: **this file's document
stores IDENTITY AND STATE, never CREDENTIALS.** Key material lives in the
token store (`tokens.py`, its own file); `accounts.json` holds opaque row ids
(a short hash), account uuids, and timestamps. `_reject_secrets` still runs
on every write and raises rather than redacting.

A key row carries the `account_uuid` its token resolved to (one profile call
at registration, best-effort, lazily retried). It is IDENTITY for the panel to
display and nothing more.

⚠ DUPLICATE-OF-PRIMARY DETECTION IS GONE (user ruling 2026-08-25, second
ruling of the day, and it RETIRES the first). A key that resolved to the same
account as the login used to be excluded from routing and greyed in the panel,
because failing over to it re-spends the identical limit (measured live
2026-08-24 21:20Z: the re-driven turn hit the same session limit 4.2 s later).
The observation stands; the DETECTION does not. D-147 established that a
`claude setup-token` key is inference-only, and the profile endpoint wants the
same `user:profile` scope the usage endpoint does — so `account_uuid` never
resolves for a key registered from now on, and the check could only ever fire
for rows carried over from a v1 registry. A guard that fires for one row in a
hundred is worse than none: it makes the panel's behaviour unexplainable. Do
not reintroduce it without a way to learn a key's account that actually works.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from typing import Any

from . import limits, store, tokens

REGISTRY_NAME = "accounts.json"
VERSION = 2
_lock = threading.RLock()

#: the sentinel id of the signed-in account. Not a stored row — `readout` and
#: `resolve` synthesize it from the live CLI config on every call.
PRIMARY = "primary"

#: the four model tiers, in display order. Routing state is keyed on these;
#: an unknown tier simply never acquires a mark and so always resolves to the
#: first account in priority order, which is the right degradation.
TIERS = ("haiku", "sonnet", "opus", "fable")

#: haiku, sonnet and opus all bill against ONE subscription usage pool, so
#: running out on any of them is running out on all three (user ruling
#: 2026-08-25). `fable` is deliberately NOT in it — the user named exactly
#: these three, and fable's own lane is billed separately. ⚠ That is still
#: true and still means what it says — but do not read it as "fable is never
#: marked with them": `record_limit` gives fable a RIDE-ALONG mark under a
#: different, one-directional, absent-only rule (D-152). Membership of the
#: bucket and moving at the same time are two different things here.
POOLED = ("haiku", "sonnet", "opus")

#: the tier that bills its own lane. Named, not spelled inline, because two
#: separate rules turn on it (`_pool_of` excludes it; `record_limit`
#: piggybacks onto it) and a typo in either is silent.
FABLE = "fable"

# The probe shares the existing paced usage-warm loop, but this durable claim
# makes the cap survive a backend restart and prevents two callers from
# spending the same fallback account twice in an hour.
FALLBACK_PROBE_INTERVAL_S = 3600.0
_LIVENESS = "key_liveness"


def _pool_of(tier: str) -> tuple[str, ...]:
    """The tiers that share `tier`'s usage pool, `tier` itself included. An
    unpooled or unknown tier is a pool of one, so callers never special-case."""
    return POOLED if tier in POOLED else (str(tier or ""),)

PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
OAUTH_BETA = "oauth-2025-04-20"
# console/api hosts sit behind a WAF that 403s a default urllib UA (Cloudflare
# 1010). Identifying as the CLI is what this client id legitimately is.
USER_AGENT = "claude-cli (external, cli)"


# Resolved per call, never captured at import: `store.DATA_ROOT` is what the
# rest of the backend actually uses, and a module-level constant would freeze
# whatever the value was at import time — which is how a test that sets the
# data root ends up asserting against the developer's real ~/orgtree.
def registry_path() -> str:
    return os.path.join(store.DATA_ROOT, REGISTRY_NAME)


# --------------------------------------------------------------- the invariant
# Deliberately broader than "starts with sk-ant-": a future credential shape
# this pattern does not know about is exactly the one that would slip through,
# so anything long and opaque is refused too. False positives are a caller bug
# worth failing on; a token in this file is not recoverable once written.
_SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]+"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}"),                 # JWT-ish
    re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}\b"),          # long opaque run
)
# keys whose NAME alone means a caller is handing us the wrong thing
_SECRET_KEYS = {"accesstoken", "access_token", "refreshtoken", "refresh_token",
                "token", "authorization", "api_key", "apikey", "secret",
                "credentials", "bearer", "id_token"}


class SecretInRegistry(ValueError):
    """Raised when a write would put credential material in the registry."""


def _reject_secrets(node: Any, path: str = "") -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if str(k).replace("-", "_").lower() in _SECRET_KEYS:
                raise SecretInRegistry(
                    f"refusing to write credential-shaped key {path}/{k!r} "
                    f"into {REGISTRY_NAME} — the registry holds identity only")
            _reject_secrets(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _reject_secrets(v, f"{path}[{i}]")
    elif isinstance(node, str):
        for pat in _SECRET_PATTERNS:
            if pat.search(node):
                raise SecretInRegistry(
                    f"refusing to write credential-shaped VALUE at {path} "
                    f"into {REGISTRY_NAME} — the registry holds identity only")


# ------------------------------------------------------------------ the record
def _blank() -> dict[str, Any]:
    return {"version": VERSION, "keys": [], "usage_refreshes": {},
            _LIVENESS: {}}


class RegistryUnreadable(RuntimeError):
    """The registry file exists but could not be understood."""


def _migrate_v1(doc: dict[str, Any]) -> dict[str, Any]:
    """The D-144 registry → this shape, WITHOUT touching disk.

    The old document's adopted identities, labels and pins are dropped on the
    floor by design. What survives is the one thing the user cannot re-create
    by hand: rows for keys already pasted into the token store ("you won't be
    able to see it again" — deleting those would force a re-mint). Old rows
    were keyed on account uuid and the token store keyed on the same, so the
    old uuid simply BECOMES the row id, and — usefully — it is also the row's
    resolved `account_uuid`, so a migrated row shows its identity in the panel
    with no network call. (It is ONLY migrated rows that ever do: see the
    module docstring on why a freshly registered key never resolves.)

    Deterministic from (v1 doc, token store), so readers can migrate in
    memory on every load; the first WRITE persists version 2. Reads never
    write.
    """
    stored = set(tokens.load()["tokens"])
    order = [str(u) for u in (doc.get("order") or []) if isinstance(u, str)]
    ids = [u for u in order if u in stored]
    ids += sorted(u for u in stored if u not in ids)
    return {"version": VERSION,
            "keys": [{"id": u, "account_uuid": u} for u in ids],
            "usage_refreshes": {}, _LIVENESS: {}}


def load(*, strict: bool = False) -> dict[str, Any]:
    """The registry, or a blank one.

    A corrupt file reads as blank for READERS: taking the panel down over it
    is a worse failure than showing nothing. `strict=True` — which every
    read-modify-WRITE cycle uses — raises instead, so a mutation can never
    silently replace an unreadable file with an empty registry (the data-loss
    shape the 2026-08-24 review fixed; the unreadable file stays on disk for
    hand recovery). A version-1 document is not corrupt: it migrates in
    memory on every load, for readers and writers alike.
    """
    try:
        with open(registry_path(), encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return _blank()                        # genuinely absent: not corrupt
    except (OSError, json.JSONDecodeError) as e:
        if strict:
            raise RegistryUnreadable(
                f"{registry_path()} exists but could not be read ({e}) — "
                f"refusing to overwrite it with a blank registry") from None
        return _blank()
    if not isinstance(doc, dict):
        if strict:
            raise RegistryUnreadable(
                f"{registry_path()} is not an object — refusing to overwrite "
                f"it; recover or remove it first")
        return _blank()
    if doc.get("version") == 1:
        return _migrate_v1(doc)
    if doc.get("version") != VERSION:
        if strict:
            raise RegistryUnreadable(
                f"{registry_path()} is version {doc.get('version')!r}, not "
                f"{VERSION} — refusing to overwrite it; migrate it first")
        return _blank()
    if not isinstance(doc.get("keys"), list):
        doc["keys"] = []
    doc["keys"] = [k for k in doc["keys"]
                   if isinstance(k, dict) and k.get("id")]
    if not isinstance(doc.get("usage_refreshes"), dict):
        doc["usage_refreshes"] = {}
    if not isinstance(doc.get(_LIVENESS), dict):
        doc[_LIVENESS] = {}
    return doc


def save(doc: dict[str, Any]) -> None:
    """Atomic tmp+replace, mirroring store.save_org — including the fsync,
    because a half-written registry reads as 'no keys registered' and the
    rows are not re-creatable from anywhere else."""
    _reject_secrets(doc)                       # before anything touches disk
    doc["version"] = VERSION
    blob = json.dumps(doc, indent=2).encode("utf-8")
    p = registry_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        for i in range(20):                    # Windows: see store._IOLatch
            try:
                os.replace(tmp, p)
                tmp = ""
                break
            except PermissionError:
                if i == 19:
                    raise
                time.sleep(0.01 * (i + 1))
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


# ------------------------------------------------------- the primary identity
# The CLI's own config, holding identity METADATA (`oauthAccount`) and no
# credential at all. Module level so a test can point it at a fixture without
# going near a real login.
LIVE_CONFIG = os.path.expanduser("~/.claude.json")


def live_identity() -> dict[str, str]:
    """WHO this machine is signed in as — `{"uuid", "email"}`, both "" when
    nobody is (missing/unreadable config, or no `oauthAccount`).

    Read from the CLI's CONFIG, never from the credentials store: this must
    stay a metadata read, cheap enough for every readout and every spawn, and
    incapable of touching a token. The uuid is the discriminator (identical
    across a token refresh, different between accounts — the old probe
    battery's one durable finding); the email is display only.
    """
    try:
        with open(LIVE_CONFIG, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return {"uuid": "", "email": ""}
    if not isinstance(doc, dict):
        return {"uuid": "", "email": ""}
    acct = doc.get("oauthAccount")
    if not isinstance(acct, dict):
        return {"uuid": "", "email": ""}
    return {"uuid": str(acct.get("accountUuid") or ""),
            "email": str(acct.get("emailAddress") or "")}


# ------------------------------------------------------------------- key rows
def key_for_token(token: str) -> str:
    """The row id a raw token belongs to, or "". The reverse lookup exists so
    attribution (`supervisor.identity_in_env`) can read the RESOLVED spawn
    env — the dict the process actually holds — rather than trusting intent.
    Takes the secret, returns a label; keeps nothing."""
    if not token:
        return ""
    for kid, tok in tokens.load()["tokens"].items():
        if tok == token:
            return str(kid)
    return ""


def _resolve_via_profile(access_token: str) -> dict[str, Any]:
    """The only network call in this module. Isolated so tests inject instead
    of reaching the internet, and so the one place that handles a live token
    is a single short function that returns identity and keeps nothing."""
    import urllib.request
    req = urllib.request.Request(
        PROFILE_URL,
        headers={"Authorization": f"Bearer {access_token}",
                 "anthropic-beta": OAUTH_BETA,
                 "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def _uuid_from_profile(profile: Any) -> str:
    if not isinstance(profile, dict):
        return ""
    acct = profile.get("account")
    if not isinstance(acct, dict):
        return ""
    return str(acct.get("uuid") or "")


def _set_key_uuid(kid: str, uuid: str) -> None:
    with _lock:
        doc = load(strict=True)
        for k in doc["keys"]:
            if k["id"] == kid:
                k["account_uuid"] = uuid
                save(doc)
                return


def resolve_key_identity(kid: str) -> str:
    """Best-effort: which account does this key belong to? Fetches the
    profile with the key's own token and records the uuid on the row.
    Returns the uuid, or "" (offline, expired, unknown row — none are
    errors; the row simply stays unattributed and routes as a distinct
    account until a later call succeeds)."""
    tok = tokens.get(kid)
    if not tok:
        return ""
    try:
        uuid = _uuid_from_profile(_resolve_via_profile(tok))
    except Exception:                          # noqa: BLE001 — offline/expired/429
        return ""
    if uuid:
        _set_key_uuid(kid, uuid)
    return uuid


def _optional_mint_config_dir(value: str | None) -> str | None:
    """An operator assertion about the external mint session, or absent.

    The key was minted before this backend saw it. A field named for that
    event therefore must be supplied by the operator, be optional, and remain
    absent when unknown — never inferred from this process's own config.
    """
    value = str(value or "").strip()
    if not value:
        return None
    # Validate this non-secret adjunct BEFORE storing the one-copy token. A
    # malformed provenance value must not leave a token durable but unrowed.
    _reject_secrets({"mint_config_dir": value})
    return value


def _registered_from_config_dir() -> str:
    """The backend's config directory at registration — not mint provenance."""
    value = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.abspath(os.path.expanduser(value))


def normalize_setup_token(value: str) -> str:
    """Canonicalize a pasted setup-token without inspecting its secret bytes.

    Claude's token alphabet contains no whitespace, but copying the long value
    from a wrapped terminal can insert CR/LF or spaces. Passing those bytes on
    produces an upstream 401 that is indistinguishable from revocation. Only
    the positively identified ``sk-ant-oat`` family gets internal whitespace
    removal; unknown future credential shapes retain their bytes apart from
    the established outer trim.
    """
    token = str(value or "").strip()
    return re.sub(r"\s+", "", token) if token.startswith("sk-ant-oat") else token


def register_key(token: str, mint_config_dir: str | None = None) -> dict[str, Any]:
    """Register a pasted `claude setup-token` key as a secondary account row.

    ⚠ STORE FIRST, RESOLVE AFTER — the ordering is the user's standing
    ruling, not a preference. The CLI shows a minted token EXACTLY ONCE
    ("you won't be able to see it again"), so the write to the token store
    happens before anything can form an opinion about the value; the identity
    lookup runs afterwards, against a token that is already durable, and its
    failure costs nothing but the uuid shown beside the row (which is in
    practice always — a setup-token key cannot read its own profile).

    Idempotent on the VALUE: re-pasting a key that is already stored lands on
    its existing row (same id — the id IS a hash of the token) and keeps its
    place in the order. Returns `{"id", "created", "account_uuid"}`.
    """
    token = normalize_setup_token(token)
    if not token:
        raise ValueError("refusing to register an empty key")
    mint_config_dir = _optional_mint_config_dir(mint_config_dir)
    kid = key_for_token(token) or (
        "k" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:12])
    tokens.put(kid, token)                     # ← durable before anything else
    created = False
    with _lock:
        doc = load(strict=True)
        if not any(k["id"] == kid for k in doc["keys"]):
            # `registered_at`, deliberately not `created_at`: this backend
            # cannot observe when a CLI elsewhere minted the token. The same
            # distinction is why mint_config_dir is optional operator input,
            # while registered_from_config_dir names the fact we can observe.
            row: dict[str, Any] = {
                "id": kid,
                "account_uuid": None,
                "registered_at": _iso(time.time()),
                "registered_from_config_dir": _registered_from_config_dir(),
            }
            if mint_config_dir is not None:
                row["mint_config_dir"] = mint_config_dir
            doc["keys"].append(row)
            created = True
            save(doc)
    # the identity lookup, OUTSIDE the lock (it is a network call) and after
    # durability. `resolve_key_identity` re-reads the token it just stored.
    uuid = resolve_key_identity(kid)
    return {"id": kid, "created": created, "account_uuid": uuid or None}


def remove_key(kid: str) -> bool:
    """Delete a secondary account row AND its stored key. ⚠ Irreversible from
    orgtree's side — the CLI cannot show a token again, so re-adding means
    re-minting. Routing state for the row goes with it: a mark against a key
    that no longer exists is not this machine's state."""
    kid = str(kid or "")
    with _lock:
        doc = load(strict=True)
        keep = [k for k in doc["keys"] if k["id"] != kid]
        existed = len(keep) != len(doc["keys"])
        if existed:
            doc["keys"] = keep
            doc["usage_refreshes"].pop(kid, None)
            doc[_LIVENESS].pop(kid, None)
            save(doc)
    forgot = tokens.forget(kid)
    return existed or forgot


def set_key_order(ids: list[str]) -> list[str]:
    """The secondary priority order. Unknown ids are dropped and known ones
    missing from the request are appended — a stale panel must not be able to
    delete a row by omitting it, and the order must stay a PERMUTATION of the
    known set (`dict.fromkeys` dedupes a double-submitted POST)."""
    with _lock:
        doc = load(strict=True)
        by_id = {k["id"]: k for k in doc["keys"]}
        new = list(dict.fromkeys(str(i) for i in ids if str(i) in by_id))
        new += [i for i in by_id if i not in new]
        doc["keys"] = [by_id[i] for i in new]
        save(doc)
        return new


def _liveness_record(doc: dict[str, Any], kid: str) -> dict[str, Any]:
    value = (doc.get(_LIVENESS) or {}).get(kid)
    return dict(value) if isinstance(value, dict) else {}


def _liveness_state(doc: dict[str, Any], kid: str) -> str | None:
    state = _liveness_record(doc, kid).get("state")
    return str(state) if state in {"alive", "limited", "dead"} else None


def key_liveness(doc: dict[str, Any], kid: str) -> str | None:
    """The credential-only probe verdict for a stored row, if decisive.

    Public because both routing and the provider-usage serializer must answer
    from the same verdict. It never reads or returns credential material.
    """
    return _liveness_state(doc, str(kid or ""))


def _claim_probe(kid: str, now: float) -> bool:
    """Atomically reserve this key's once-hourly probe slot.

    A schedule claim is not a liveness verdict. It is persisted even when the
    coming attempt is UNKNOWN so ambiguity cannot retry itself into a verdict
    on every warm-loop pass (or after a process restart).
    """
    with _lock:
        doc = load(strict=True)
        if not any(k["id"] == kid for k in doc["keys"]):
            return False
        rec = _liveness_record(doc, kid)
        try:
            last = float(rec.get("checked_at") or 0.0)
        except (TypeError, ValueError):
            last = 0.0
        if now - last < FALLBACK_PROBE_INTERVAL_S:
            return False
        rec["checked_at"] = now
        doc[_LIVENESS][kid] = rec
        save(doc)
        return True


def probe_fallback_keys(now: float | None = None, probe: Any = None) -> list[dict[str, str]]:
    """Run each due fallback-key probe, never from a turn path.

    This function does not log raw CLI output or tokens. ``unknown`` preserves
    the prior liveness verdict; its sole durable effect is the scheduler claim
    above, which prevents automatic retries for one hour. A confirmed dead key
    is retained for the operator to inspect but the shared resolver stops
    routing new turns to it.
    """
    now = time.time() if now is None else float(now)
    results: list[dict[str, str]] = []
    for row in list(load().get("keys") or []):
        kid = str(row.get("id") or "")
        if not kid or not _claim_probe(kid, now):
            continue
        token = tokens.get(kid)
        state = "unknown"
        try:
            if token:
                if probe is None:
                    # Delayed imports avoid the accounts ↔ supervisor import
                    # cycle. `_claude_argv` is the exact resolved agent CLI:
                    # override, private pin, then PATH — never a hand-written
                    # path that can silently probe a different binary.
                    from . import fallback_probe, supervisor
                    state = fallback_probe.probe(token, supervisor._claude_argv())
                else:
                    state = str(probe(token))
        except Exception:  # noqa: BLE001 — ambiguity must stay a non-verdict
            state = "unknown"
        if state not in {"alive", "limited", "dead", "unknown"}:
            state = "unknown"
        if state != "unknown":
            with _lock:
                doc = load(strict=True)
                if any(k["id"] == kid for k in doc["keys"]):
                    rec = _liveness_record(doc, kid)
                    rec["state"] = state
                    doc[_LIVENESS][kid] = rec
                    save(doc)
        results.append({"id": kid, "state": state})
    return results


# ------------------------------------------------------------- routing state
def _prune_expired(doc: dict[str, Any], now: float) -> None:
    """An expired mark IS capacity — readers already treat it so; writers
    physically drop it so the file states only what is currently true. Also
    sweeps marks for rows that no longer exist (`primary` always exists)."""
    known = {PRIMARY} | {k["id"] for k in doc["keys"]}
    ref = doc["usage_refreshes"]
    for acct in list(ref):
        if acct not in known or not isinstance(ref[acct], dict):
            del ref[acct]
            continue
        for tier in list(ref[acct]):
            try:
                if float(ref[acct][tier]) <= now:
                    del ref[acct][tier]
            except (TypeError, ValueError):
                del ref[acct][tier]
        if not ref[acct]:
            del ref[acct]


def record_limit(account: str, tier: str, refresh_at: float) -> bool:
    """The ONLY writer of routing state: this account's capacity for this
    tier is used up until `refresh_at`. Unknown accounts and unknown tiers
    are refused as no-ops returning False — a stale attribution (a row
    deleted mid-turn, an `api-key` lane, `key:unattributed`) must not be able
    to resurrect or invent a row.

    ⚠ THE MARK LANDS ON THE WHOLE POOL, not just the tier that hit the wall
    (user ruling 2026-08-25): haiku, sonnet and opus share one subscription
    bucket, so a sonnet limit on this account IS an opus limit on it. Before
    this, an opus turn would fail over correctly and the very next haiku turn
    would walk straight back into the same exhausted account, because its own
    tier carried no mark — one wasted spawn per sibling tier, every time.

    The mirror NEVER SHORTENS an existing mark: if a sibling is already parked
    later than `refresh_at`, that later time is the one still known to be
    true, and lowering it would hand back capacity nobody watched return.

    ⚠ AND FABLE RIDES ALONG WHEN IT HAS NOTHING OF ITS OWN (user feature
    2026-08-26, amending D-148 — see D-152). A limit on any NON-fable tier
    also parks THIS ACCOUNT's fable, at the same time, **but only when fable
    carries no live refresh time already**. Three properties, and each one is
    load-bearing:

      · ONE-DIRECTIONAL — a fable limit still spreads to nobody. Fable's own
        wall is weekly and says nothing about the subscription bucket.
      · ABSENT-ONLY, not `max()` like the pool mirror — a fable mark that is
        already there was put there by a real fable limit (or by an earlier
        ride-along), and it is neither raised nor lowered. This is also what
        makes the feature testable at all: an implementation that simply
        marked every tier in `TIERS` would be indistinguishable from this one
        without it.
      · PER-ACCOUNT — `usage_refreshes` is `[account][tier]`, so the account
        whose subscription ran out is the only one whose fable is parked.
        Parking fable everywhere because one account hit a wall would be a
        different (and wrong) feature.

    Nothing is BLOCKED by the extra mark: with every account marked,
    `_resolve_in` still names the soonest-refreshing one and a spawn goes
    there, re-marking itself if it fails. The cost of being wrong here is one
    probing spawn; the cost of being right is not burning a fable turn — the
    most expensive tier there is — on an account that has just proven it has
    nothing left."""
    account, tier = str(account or ""), str(tier or "").lower()
    if tier not in TIERS:
        return False
    with _lock:
        doc = load(strict=True)
        if account != PRIMARY and not any(
                k["id"] == account for k in doc["keys"]):
            return False
        now = time.time()
        _prune_expired(doc, now)
        ts = float(refresh_at)
        if ts <= now:
            return False                       # already refreshed: not a mark
        marks = doc["usage_refreshes"].setdefault(account, {})
        for t in _pool_of(tier):
            # `_prune_expired` ran just above, so anything still in `marks` is
            # a live float — a survivor later than `ts` outranks the mirror.
            prev = marks.get(t)
            marks[t] = (max(ts, float(prev))
                        if isinstance(prev, (int, float)) else ts)
        # the ride-along. `_prune_expired` ran above, so "not in marks" is
        # exactly "fable has no LIVE refresh time" — an expired one is
        # capacity, and capacity is what this rule is allowed to spend.
        if tier != FABLE and FABLE not in marks:
            marks[FABLE] = ts
        save(doc)
        return True


def _routing_order(doc: dict[str, Any], live_uuid: str) -> list[str]:
    """Priority order: the signed-in account first (skipped entirely when
    nobody is signed in — an ambient spawn with no login authenticates as
    nothing), then EVERY key row in list order.

    ⚠ No duplicate-of-primary exclusion any more (user ruling 2026-08-25 —
    see the module docstring). `live_uuid` is still taken because "is anyone
    signed in at all" decides whether `primary` is a lane; it no longer
    filters keys."""
    order: list[str] = [PRIMARY] if live_uuid else []
    # A confirmed dead key is neither removed nor silently retried: removal is
    # destructive (the CLI cannot show it again), but routing a known corpse
    # recreates the silent-primary-rebilling failure this probe exists to find.
    order += [str(k["id"]) for k in doc["keys"]
              if _liveness_state(doc, str(k["id"])) != "dead"]
    return order


def _resolve_in(doc: dict[str, Any], live_uuid: str, tier: str,
                now: float) -> dict[str, Any]:
    tier = str(tier or "").lower()
    order = _routing_order(doc, live_uuid)
    ref = doc["usage_refreshes"]

    def mark(acct: str) -> float | None:
        try:
            ts = float((ref.get(acct) or {}).get(tier))
        except (TypeError, ValueError):
            return None
        return ts if ts > now else None        # expired reads as capacity

    for acct in order:
        if mark(acct) is None:
            return {"account": acct, "available": True, "refresh_at": None}
    # nowhere has capacity: name the account that refreshes SOONEST — that is
    # where capacity next appears, where the dimmed chip sits, and where a
    # probing spawn goes (if it fails it re-marks itself; self-bounding)
    if order:
        best = min(order, key=lambda a: mark(a) or float("inf"))
        return {"account": best, "available": False, "refresh_at": mark(best)}
    return {"account": None, "available": False, "refresh_at": None}


def resolve(tier: str, now: float | None = None) -> dict[str, Any]:
    """WHERE prompts for this tier go, right now:
    `{"account": id|None, "available": bool, "refresh_at": epoch|None}`.
    The single rule every consumer shares — the spawn seam injects the token
    of exactly this answer, and the panel draws the tier's chip beside exactly
    this row, so the two cannot disagree."""
    now = time.time() if now is None else now
    return _resolve_in(load(), live_identity()["uuid"], tier, now)


def _iso(epoch: Any) -> str | None:
    if not isinstance(epoch, (int, float)):
        return None
    return (_dt.datetime.fromtimestamp(epoch, _dt.timezone.utc)
            .isoformat().replace("+00:00", "Z"))


def could_be_a_key_row(account: str) -> bool:
    """Could this identifier POSSIBLY name a key row? Answerable without the
    registry, which is the only reason it is a function of its own.

    Split out of `fallback_ordinal` so that `serving_label` can decline the
    registry read without restating the test — the repo's standing objection
    to two expressions of one rule applies here exactly: a second copy is a
    second thing to disagree, and this one would disagree by silently
    reintroducing a per-node file read."""
    return bool(account) and account != PRIMARY


def fallback_ordinal(doc: dict[str, Any], account: str) -> int | None:
    """This row's 1-based position among the key rows, or None if `account`
    is not a key row (the primary login, `api-key`, `key:unattributed`, an
    unknown id). ONE definition of "fallback N", shared by the panel, the
    per-row usage modal and the serving label — three surfaces that would
    otherwise each count for themselves and disagree the moment a row is
    deleted."""
    if not could_be_a_key_row(account):
        return None
    for i, k in enumerate(doc["keys"]):
        if k["id"] == account:
            return i + 1
    return None


def serving_label(account: str, *, with_uuid: bool = True) -> str | None:
    """"fallback 2 · <account uuid>" for a turn served by a key row, else None
    (user ruling 2026-08-25: cite the fallback's NUMBER alongside its uuid,
    and only when an agent is actually running off a fallback — the primary
    login and the api-key lane say nothing here).

    ⚠ `with_uuid=False` for anything a KIOSK visitor can reach. D-145 keeps
    account identity off the public side by freezing `/api/accounts` whole,
    but the node payload this label rides on is reachable from a kiosk, so
    the uuid is dropped there rather than the whole label. The ordinal is
    positional and says nothing about who the account is.

    Degrades to the bare ordinal when identity has not resolved yet: "fallback
    2" is still true, and a row whose profile lookup failed must not vanish
    from the readout that explains a running turn.

    ⚠ THE REGISTRY READ IS GATED, because this is called once PER NODE by the
    tree render's `annotate` — and `annotate` runs for every node in the
    document, on a 6 s heartbeat and on every `save_org`. Unconditionally
    loading here opened and JSON-parsed `accounts.json` once per seat:
    MEASURED 2026-09-03, 41 `open()` calls for a 41-node org, one per node,
    scaling 1:1 with the org (8 opens at 5 nodes, 130 at 125). That is the
    per-node filesystem work D-239 forbids, in a second place, found by the
    syscall-scaling guard that ruling asked for.
    `could_be_a_key_row` is the SAME test `fallback_ordinal` applies first, so
    every account this declines to look up would have returned None anyway —
    the answer is unchanged for every input, only the read is skipped. Almost
    every seat is such an account: `ran_as` is empty unless a turn is in
    flight on a key row."""
    if not could_be_a_key_row(account):
        return None
    doc = load()
    n = fallback_ordinal(doc, account)
    if n is None:
        return None
    if not with_uuid:
        return f"fallback {n}"
    row = next((k for k in doc["keys"] if k["id"] == account), None)
    uuid = str((row or {}).get("account_uuid") or "")
    return f"fallback {n} · {uuid}" if uuid else f"fallback {n}"


def readout() -> dict[str, Any]:
    """What the panel renders. One load, one live read, so the rows and the
    chip assignments are a consistent snapshot."""
    doc = load()
    live = live_identity()
    now = time.time()
    assignments = {}
    for tier in TIERS:
        r = _resolve_in(doc, live["uuid"], tier, now)
        assignments[tier] = {"account": r["account"],
                             "available": r["available"],
                             "refresh_at": _iso(r["refresh_at"])}
    return {
        "version": VERSION,
        "primary": {"signed_in": bool(live["uuid"]),
                    "email": live["email"] or None},
        # `account_uuid` is IDENTITY, never credential (user ruling
        # 2026-08-25: render each registered key's uuid in the list), and
        # `/api/accounts` is frozen whole for kiosk visitors, so this adds no
        # public surface. `ordinal` rides along so the panel's "fallback N"
        # and the desk's serving label come from ONE count rather than two.
        # (No `duplicate` flag: that feature is retired — module docstring.)
        "keys": [{
            "id": k["id"],
            "ordinal": i + 1,
            "account_uuid": str(k.get("account_uuid") or "") or None,
            # Registration facts, explicitly not claims about the external
            # mint. Legacy rows predate these observations and answer null.
            "registered_at": str(k.get("registered_at") or "") or None,
            "mint_config_dir": str(k.get("mint_config_dir") or "") or None,
            "registered_from_config_dir": str(
                k.get("registered_from_config_dir") or "") or None,
            "liveness": _liveness_state(doc, str(k["id"])),
            "liveness_checked_at": _iso(
                _liveness_record(doc, str(k["id"])).get("checked_at")),
        } for i, k in enumerate(doc["keys"])],
        "assignments": assignments,
    }


def tier_standing(doc: dict[str, Any], account: str,
                  now: float | None = None) -> list[dict[str, Any]]:
    """THIS ACCOUNT's own capacity, tier by tier — what the key rows' usage
    view shows in place of usage percentages (user ruling 2026-08-25: "show
    the information from the internal multi-account state per that key: which
    models have capacity on it, and which ones are waiting to refresh, and
    until when"). It is a straight read of `usage_refreshes[account]`, the
    same dict `_resolve_in` routes off, so the view cannot describe a state
    the router does not hold.

    ⚠ `available` here means "THIS ACCOUNT has capacity for this tier", NOT
    "this tier runs here" — the panel's gutter chips answer that second
    question and the two legitimately differ: a fallback can have capacity for
    opus while opus still runs on the primary above it. Say "has capacity",
    never "is serving".

    `pool` lists the tiers whose capacity is the same capacity, this one
    included, and is `None` for a tier that stands alone. ⚠ `None` is NOT "is
    never marked with the others": since D-152 fable rides along with a
    subscription limit and can show as waiting at the same instant as the
    bucket while still standing alone. `pool` answers "whose capacity is this
    capacity", not "what moves together". ⚠ NOTHING RENDERS IT
    TODAY — it fed a "these three share one bucket" footnote that the user
    removed the same day (the table stands alone). It stays in the payload
    because it is the only thing that explains why three tiers carry one
    identical timestamp: without it, a reader of this response would have to
    re-derive the grouping, and re-deriving it wrongly is exactly the bug
    `POOLED` exists to prevent. Do not re-add the footnote."""
    now = time.time() if now is None else now
    ref = (doc["usage_refreshes"].get(account) or {})
    out: list[dict[str, Any]] = []
    for tier in TIERS:
        try:
            ts = float(ref.get(tier))          # type: ignore[arg-type]
        except (TypeError, ValueError):
            ts = 0.0
        marked = ts > now                      # expired reads as capacity
        siblings = _pool_of(tier)
        out.append({"tier": tier,
                    "available": not marked,
                    "refresh_at": _iso(ts) if marked else None,
                    "pool": list(siblings) if len(siblings) > 1 else None})
    return out


# ------------------------------------------------------------ per-account usage
def account_usage(account: str) -> dict[str, Any]:
    """One account's usage-limit standing, for the panel's per-row button and
    the header modal's list.

    `primary` reads the host subscription through the shared `limits` cache —
    a refreshed OAuth access token with the `user:profile` scope, which is why
    that half works at all.

    ⚠ A KEY ROW MAKES NO NETWORK CALL AT ALL (D-147). `claude setup-token`
    keys are inference-only and can never read usage, so the row answers
    `unsupported` from local state. Was. two round-trips per click — the usage
    fetch, plus a lazy `resolve_key_identity` retry justified by "the user is
    already spending a network round-trip on this click". That justification
    died with the round-trip, and the retry was itself a forbidden request:
    the profile endpoint wants the same scope the usage endpoint does.

    ⚠ AND A KEY ROW ANSWERS WITH SOMETHING USEFUL INSTEAD (user ruling
    2026-08-25): `tiers`, this account's own routing standing. Percentages are
    unobtainable, but which models this account still has capacity for — and
    when the exhausted ones come back — is state we already hold, and it is
    what the button was being clicked to find out."""
    account = str(account or "")
    live = live_identity()
    if account == PRIMARY:
        data = limits.fetch()
        return {"account": PRIMARY,
                "label": live["email"] or "signed-in account",
                **{k: v for k, v in data.items() if k != "account"}}
    doc = load()
    row = next((k for k in doc["keys"] if k["id"] == account), None)
    if row is None:
        return {"account": account, "label": account,
                "available": False, "error": "no such key"}
    tok = tokens.get(account)
    if not tok:
        return {"account": account, "label": account,
                "available": False, "error": "no stored key for this row"}
    ordinal = fallback_ordinal(doc, account)      # the one count, shared
    label = f"fallback {ordinal}" if ordinal else "fallback"
    if key_liveness(doc, account) == "dead":
        # This is not the D-147 capability gap below. The usage endpoint is
        # unsupported for every setup-token, but this row has an independent,
        # isolated inference probe proving that its credential was rejected.
        # Returning the ordinary standing table here used to say both "has
        # capacity" and "authentication: dead" on the same settings row.
        return {
            "account": account, "label": label, "available": False,
            "error": "the isolated authentication probe rejected this stored "
                     "`claude setup-token` credential, so it is not routed. "
                     "Run `claude setup-token` while signed in to the intended "
                     "fallback account, paste the fresh token as a new "
                     "fallback row, and remove this rejected row only after "
                     "the new row reports authentication alive or limited.",
        }
    # ⚠ WE DO NOT ASK. A `claude setup-token` key is INFERENCE-ONLY and the
    # usage endpoint needs the `user:profile` scope it will never carry, so
    # every such request was forbidden before it left this machine — see
    # D-147 for the evidence out of the CLI's own binary. This used to call
    # `limits.fetch_for_token`, which is how one key row earned an hour-long
    # rate-limit window by being politely asked the same forbidden question
    # on every panel open. Backoff would have been the wrong shape: the fix
    # for a request that must never be made is not to make it.
    return {"account": account, "label": label,
            "available": False, "unsupported": True,
            "tiers": tier_standing(doc, account),
            "error": "usage limits can't be read for a `claude setup-token` "
                     "key — these are inference-only, and the usage endpoint "
                     "needs a permission they are never granted. Nothing is "
                     "wrong with this key; re-minting it would not help."}


def usage_all() -> dict[str, Any]:
    """Every account's standing, primary first then keys in priority order —
    the header usage modal's list (user ruling 2026-08-25: the overall usage
    button shows every registered account, fallbacks included)."""
    doc = load()
    out = [account_usage(PRIMARY)]
    out += [account_usage(k["id"]) for k in doc["keys"]]
    return {"accounts": out}
