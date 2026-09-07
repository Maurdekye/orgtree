# pyright: strict
"""Codex subscription rate-limit usage, read through the local app-server.

Codex owns the signed-in account and its refreshed credentials.  Orgtree asks
the CLI's documented app-server protocol (`account/rateLimits/read`) and never
reads or copies auth material.  The normalized output deliberately matches the
Claude usage-bar shape so the frontend has one renderer and one severity rule.

The same board answers a second question — `grants()` below — because a model
whose pool is granted to this account gets a rate-limit window of its own here,
and a model whose pool has been withdrawn simply has none.  That is the only
local signal that MOVES with an OpenAI grant; see the note above `grants`.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import threading
import time
from typing import Any, Final

from . import cachecontinuity, codex_route, codexrun, providers

CACHE_TTL: Final = 30.0
FETCH_TIMEOUT: Final = 15.0
#: ONE evidence age — the resolver ages windows by the same number the
#: glow/snapshot calls a board stale by
MAX_EVIDENCE_AGE: Final = codex_route.EVIDENCE_MAX_AGE

_lock = threading.Lock()
_fetch_lock = threading.Lock()
#: `complete_at` — when the board was last filled by a COMPLETE
#: `account/rateLimits/read`, as opposed to patched by a turn's sparse
#: `account/rateLimits/updated` notifications.  The distinction decides what
#: an ABSENT bucket means: a complete read that carries no `gpt-reserve`
#: bucket is a withdrawn grant; a sparse notification that happens not to
#: mention it says nothing at all (`observe` merges, never removes).
#: `codex_route.resolve` reads `snapshot()["complete"]` before it will call a
#: grant withdrawn.
#: `account` — the codex ACCOUNT NAMESPACE the board describes, stamped at
#: every fill (`account_namespace()`, the same digest the cache-continuity
#: namespace uses). A board is evidence about one login: after `codex login`
#: as someone else the cached windows describe the OLD account's pools, so
#: `fetch` re-reads when the namespace moved and `snapshot` carries it for
#: readers that scope their own records (`codex_route`) to compare against.
_cache: dict[str, Any] = {"at": 0.0, "data": None, "complete_at": 0.0,
                          "account": None}
# Full snapshots by limit id.  Rolling notifications are sparse, so they merge
# into this board rather than replacing it and accidentally erasing a window.
_snapshots: dict[str, dict[str, Any]] = {}
#: WHEN EACH WINDOW WAS LAST OBSERVED, by limit id THEN slot (`primary` /
#: `secondary`). A sparse notification refreshes the slots it CARRIES and no
#: other — a notification that brings a new `primary` and retains the
#: bucket's old `secondary` (`_merge_sparse`) leaves the secondary's age
#: where it was — so "how fresh is the evidence about THIS window" is
#: answerable per window. That is what lets `codex_route` age evidence per
#: pool (parent review 2026-09-05: a plan-only notification used to refresh
#: the whole board's `stale` flag while reserve's own numbers were >900 s
#: old) and lets a positive observation outrank a node's rejection mark only
#: when it is genuinely newer than the rejection. A full read stamps every
#: slot it carries.
_observed: dict[str, dict[str, float]] = {}
#: notifications REFUSED because they belonged to another account than the
#: board (see `observe`); a counter so a test can prove the refusal happened
#: rather than infer it from an unchanged board
_refused: dict[str, int] = {"foreign": 0, "race": 0}


def account_namespace() -> str:
    """The codex account the board evidence belongs to — a private, stable
    digest of the provider's own account id (or the API key), never the
    credential. The ONE implementation; `supervisor._cache_codex_account_
    namespace` delegates here so a route mark, a cache row and a board
    stamp scope alike."""
    return _account_namespace()[0]


def _account_namespace(home: str | None = None) -> tuple[str, str]:
    """(namespace, auth lane). See `account_namespace`. Refresh/access tokens
    and their timestamps are deliberately excluded: rotating credentials for
    the same account is not an account change.

    ``home`` is the effective CODEX_HOME of a captured process launch. When
    supplied it is authoritative: an older record without account_id must not
    fall through to `providers._codex_account()`, which reads the ambient
    home and could attribute this launch to a different account.
    """
    ambient_home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    resolved_home = home if home is not None else ambient_home
    try:
        with open(os.path.join(resolved_home, "auth.json"),
                  encoding="utf-8") as f:
            loaded: Any = json.load(f)
    except (OSError, json.JSONDecodeError):
        return "unobserved", "unobserved"
    if not isinstance(loaded, dict):
        return "unobserved", "unobserved"
    doc: dict[str, Any] = loaded
    key = doc.get("OPENAI_API_KEY")
    if isinstance(key, str) and key:
        return ("codex-api-key:" + cachecontinuity.digest(
            {"credential": key}, 16), "api_key")
    tokens_row = doc.get("tokens")
    tokens: dict[str, Any] = tokens_row if isinstance(tokens_row, dict) else {}
    account_id = tokens.get("account_id")
    if isinstance(account_id, str) and account_id:
        return ("codex-chatgpt:" + cachecontinuity.digest(
            {"account": account_id}, 16), "subscription")
    # Older auth records may omit account_id while the display identity is
    # still locally observable in the id-token claims.
    # The status helper has no home parameter. It is safe only when it would
    # read the same effective home as this resolver; otherwise unknown stays
    # unknown instead of borrowing identity from ambient credentials.
    same_as_ambient = (os.path.normcase(os.path.abspath(resolved_home))
                       == os.path.normcase(os.path.abspath(ambient_home)))
    if home is not None and not same_as_ambient:
        return "codex-account-unobserved", "unobserved"
    status = providers._codex_account()  # pyright: ignore[reportPrivateUsage]
    email = status.get("email")
    if isinstance(email, str) and email:
        return ("codex-chatgpt:" + cachecontinuity.digest(
            {"account": email}, 16), "subscription")
    return "codex-account-unobserved", "unobserved"


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


def _duration(minutes: Any) -> str:
    try:
        value = int(minutes)
    except (TypeError, ValueError):
        return "usage window"
    if value > 0 and value % 1440 == 0:
        days = value // 1440
        return f"{days} day" + ("s" if days != 1 else "")
    if value > 0 and value % 60 == 0:
        hours = value // 60
        return f"{hours} hour" + ("s" if hours != 1 else "")
    return f"{value} min" if value > 0 else "usage window"


def _window_kind(minutes: Any, scoped: bool) -> str:
    try:
        value = int(minutes)
    except (TypeError, ValueError):
        return "codex_window"
    if value <= 6 * 60:
        return "session"
    if value >= 6 * 24 * 60:
        return "weekly_scoped" if scoped else "weekly_all"
    return "codex_window"


def _severity(percent: float) -> str:
    if percent >= 90:
        return "critical"
    if percent >= 75:
        return "warning"
    return "normal"


def _snapshots_of(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Canonical bucket first, then any additional named/model buckets."""
    primary = raw.get("rateLimits")
    by_id = raw.get("rateLimitsByLimitId")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(primary, dict):
        out.append(primary)
        seen.add(str(primary.get("limitId") or "codex"))
    if isinstance(by_id, dict):
        for key, value in by_id.items():
            if not isinstance(value, dict):
                continue
            limit_id = str(value.get("limitId") or key)
            if limit_id in seen:
                continue
            out.append(value)
            seen.add(limit_id)
    return out


def _normalize(raw: dict[str, Any],
               observed: dict[str, dict[str, float]] | None = None
               ) -> dict[str, Any]:
    snapshots = _snapshots_of(raw)
    limits: list[dict[str, Any]] = []
    plan: str | None = None
    for snapshot in snapshots:
        limit_id = str(snapshot.get("limitId") or "codex")
        seen_slots = (observed or {}).get(limit_id) or {}
        limit_name_raw = snapshot.get("limitName")
        limit_name = (str(limit_name_raw).strip()
                      if limit_name_raw is not None else "")
        raw_plan = snapshot.get("planType")
        if not plan and isinstance(raw_plan, str) and raw_plan:
            plan = raw_plan.replace("_", " ").replace("prolite", "pro lite").title()
        reached = bool(snapshot.get("rateLimitReachedType"))
        for slot in ("primary", "secondary"):
            window = snapshot.get(slot)
            if not isinstance(window, dict):
                continue
            try:
                percent = max(0.0, min(100.0,
                    float(window.get("usedPercent") or 0)))
            except (TypeError, ValueError):
                continue
            duration = window.get("windowDurationMins")
            limits.append({
                "kind": _window_kind(duration, bool(limit_name)),
                "group": limit_id,
                "percent": percent,
                "severity": _severity(percent),
                "resets_at": _iso(window.get("resetsAt")),
                "is_active": reached or percent >= 100,
                "model": limit_name or None,
                "label": ((limit_name + " · ") if limit_name else "")
                         + _duration(duration),
                # when THIS window (bucket + slot) was last observed
                # (epoch); None on a board normalized without the ledger
                "observed_at": seen_slots.get(slot),
            })
    return {"available": bool(limits), "limits": limits, "plan": plan}


def _account(data: dict[str, Any]) -> dict[str, Any]:
    status = providers.codex_status()
    return {
        "account": "codex",
        "label": status.get("email") or "signed-in account",
        "provider": "Codex",
        **data,
    }


def fetch(force: bool = False) -> dict[str, Any]:
    """Read Codex usage, cached for the modal's polling cadence."""
    now = time.time()
    acct = account_namespace()
    with _lock:
        cached = _cache.get("data")
        # a cached board describes ONE login: if the account moved under it
        # (`codex login` as someone else), it is not this account's evidence
        # and is dropped rather than served
        if cached is not None and _cache.get("account") not in (None, acct):
            _cache.update(at=0.0, data=None, complete_at=0.0, account=None)
            _snapshots.clear()
            _observed.clear()
            cached = None
        if not force and cached is not None and now - float(_cache["at"]) <= CACHE_TTL:
            return _account(dict(cached))
    status = providers.codex_status()
    if not status.get("installed"):
        return _account({"available": False, "error": "Codex CLI is not installed"})
    if not status.get("connected"):
        return _account({"available": False, "error": "Codex CLI is not signed in"})
    if status.get("kind") == "api-key":
        return _account({
            "available": False,
            "error": "subscription usage is not available for an API-key login",
        })

    with _fetch_lock:
        now = time.time()
        with _lock:
            cached = _cache.get("data")
            if (not force and cached is not None
                    and now - float(_cache["at"]) <= CACHE_TTL):
                return _account(dict(cached))
        exe, _source = providers.codex_path()
        if not exe:
            return _account({"available": False, "error": "Codex CLI is not installed"})
        client: codexrun.AppServerClient | None = None
        try:
            client = codexrun.AppServerClient(
                providers.codex_argv(exe),
                codex_home=str(status.get("codex_home") or "") or None)
            client.initialize()
            # ⚠ THE ACCOUNT IS CAPTURED ON BOTH SIDES OF THE READ. The
            # app-server answers for whoever auth.json named when IT
            # started; if `codex login` moved the namespace while the read
            # was in flight, the answer is one account's numbers and the
            # stamp would be the other's — a board that lies about whose it
            # is. Such a read is served once, uncached, and stamps nothing
            # (parent review 2026-09-05, "completion race").
            acct_before = account_namespace()
            raw = client.request("account/rateLimits/read", {}, FETCH_TIMEOUT)
            _now = time.time()
            acct_after = account_namespace()
            if acct_before != acct_after or acct_before != acct:
                with _lock:
                    _refused["race"] += 1
                data = _normalize(raw, None)
                data["error"] = ("Codex account changed during the usage "
                                 "read; not cached")
                return _account(dict(data))
            with _lock:
                _snapshots.clear()
                _observed.clear()
                for snapshot in _snapshots_of(raw):
                    limit_id = str(snapshot.get("limitId") or "codex")
                    _snapshots[limit_id] = dict(snapshot)
                    # a full read sees every window it carries
                    _observed[limit_id] = {
                        slot: _now for slot in ("primary", "secondary")
                        if isinstance(snapshot.get(slot), dict)}
                data = _normalize(raw, _observed)
                if not data["available"]:
                    data["error"] = "Codex reported no usage-limit windows"
                _cache.update(at=_now, data=data, complete_at=_now,
                              account=acct_after)
            return _account(dict(data))
        except Exception as e:  # noqa: BLE001 — protocol failures degrade the panel
            with _lock:
                stale = _cache.get("data")
            if isinstance(stale, dict):
                return _account({**stale, "error": f"Codex usage refresh failed: {e}"})
            return _account({"available": False,
                             "error": f"Codex usage fetch failed: {e}"})
        finally:
            if client is not None:
                client.close()


def _merge_sparse(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    merged = dict(old)
    for key, value in new.items():
        if value is None:
            continue
        if key in ("primary", "secondary") and isinstance(value, dict):
            prior = merged.get(key)
            merged[key] = {**(prior if isinstance(prior, dict) else {}), **value}
        else:
            merged[key] = value
    return merged


#: the reserve pool's model name — the ONLY name a reserve bucket wears on a
#: full board read (`limitName`), and the name `observe` gives an unnamed
#: per-turn notification from a reserve turn. Mirrors ledger.MODELS.
RESERVE_LIMIT_NAME: Final = "gpt-reserve"


def observe(snapshot: Any, pool_hint: str | None = None,
            account: str | None = None) -> bool:
    """Fold a turn's sparse `account/rateLimits/updated` notification.
    → True when merged, False when refused (see `account`).

    ⚠ `account` — THE ACCOUNT THE TURN RAN AS, captured by the caller when
    the turn STARTED (`supervisor._codex_leg_attempt` carries it on the
    route), not read here at delivery time. A turn's app-server answers for
    the login it was spawned under, and a turn can outlive a `codex login`
    as someone else: by the time its last notification lands, the board may
    describe account B while the notification is A's numbers. Merging it
    would make B's board say what A's pools look like — and the other way
    round, a B notification landing on a board still stamped A would send
    A's next luna to a pool A does not have (parent review 2026-09-05,
    reproduced). So: a board stamped with a DIFFERENT account than the
    notification's origin REFUSES the merge (`_refused["foreign"]`), a
    board stamped with no account yet adopts the origin, and a board of the
    same account merges. `None` falls back to the namespace as of now —
    right only for a caller with no captured origin.

    ⚠ `pool_hint` — WHICH POOL THE TURN WAS SENT TO, from the route. MEASURED
    2026-09-05T01:20Z (codex-cli 0.153.0, live control, two turns on one
    thread): the per-turn notification carries `limitId: "codex"` and NO
    `limitName` whichever pool served the turn — the reserve turn's window
    (27%, resetsAt = the reserve weekly's) and the direct turn's (36%,
    resetsAt = the plan weekly's) both arrived under the same unnamed id.
    Only the full `account/rateLimits/read` names the reserve bucket. So an
    unnamed notification from a RESERVE turn is folded into the reserve
    bucket (named, so `codex_route.pool_of_window` attributes it right) and
    never into the plan bucket, where it would overwrite the plan's numbers
    with reserve's. A named notification is filed by its name regardless.
    """
    if not isinstance(snapshot, dict):
        return False
    origin = account or account_namespace()
    snap: dict[str, Any] = dict(snapshot)
    limit_id = str(snap.get("limitId") or "codex")
    if pool_hint == "reserve" and not str(snap.get("limitName") or "").strip():
        snap["limitName"] = RESERVE_LIMIT_NAME
        with _lock:
            existing = [k for k, v in _snapshots.items()
                        if str(v.get("limitName") or "").strip()
                        == RESERVE_LIMIT_NAME]
        # the reserve bucket's own id when the board already has one
        # (`base_model_inference` on the measured board — read, never
        # hard-coded), else a key that cannot collide with the plan bucket
        limit_id = existing[0] if existing else f"{limit_id}:{RESERVE_LIMIT_NAME}"
        snap["limitId"] = limit_id
    now = time.time()
    with _lock:
        board_acct = _cache.get("account")
        if board_acct is not None and str(board_acct) != origin:
            _refused["foreign"] += 1          # another login's numbers
            return False
        _snapshots[limit_id] = _merge_sparse(_snapshots.get(limit_id, {}), snap)
        # ONLY the windows this notification CARRIES are observed now; a
        # retained slot and every other bucket keep the time they were
        # last seen (see `_observed`)
        slots = _observed.setdefault(limit_id, {})
        for slot in ("primary", "secondary"):
            if isinstance(snap.get(slot), dict):
                slots[slot] = now
        ordered = list(_snapshots.values())
        if not ordered:
            return False
        raw = {"rateLimits": _snapshots.get("codex", ordered[0]),
               "rateLimitsByLimitId": dict(_snapshots)}
        _cache.update(at=now, data=_normalize(raw, _observed))
        if board_acct is None:
            _cache["account"] = origin
    return True


def refusals() -> dict[str, int]:
    """How many notifications / reads were refused as another account's
    (`foreign`) or as ambiguous about their account (`race`). Cumulative
    per process; cleared by `invalidate`."""
    with _lock:
        return dict(_refused)


def peek() -> dict[str, Any]:
    """Cache-only read for the always-on header warning glow."""
    with _lock:
        data = _cache.get("data")
        age = time.time() - float(_cache.get("at") or 0)
        copied = dict(data) if isinstance(data, dict) else None
    if copied is None or not copied.get("available"):
        return {"available": False, "provider": "Codex"}
    if age > MAX_EVIDENCE_AGE:
        return {"available": False, "provider": "Codex",
                "error": "Codex usage readout is stale"}
    return {"available": True, "provider": "Codex",
            "limits": copied.get("limits") or [], "age": round(age, 1)}


def snapshot(now: float | None = None) -> dict[str, Any]:
    """Cache-only, timestamped Codex evidence for dynamic turn envelopes.

    A stale board remains visible with an explicit stale marker; no app-server
    process is started here.  The returned records are copies so formatting a
    turn can never mutate the modal/glow cache.
    """
    now = time.time() if now is None else now
    with _lock:
        raw = _cache.get("data")
        observed = float(_cache.get("at") or 0.0)
        complete_at = float(_cache.get("complete_at") or 0.0)
        acct = _cache.get("account")
        if not isinstance(raw, dict):
            return {"available": False, "provider": "Codex", "limits": [],
                    "observed_at": None, "age": None, "stale": False,
                    "complete": False, "complete_age": None,
                    "account": None}
        data = dict(raw)
        data["limits"] = [dict(x) for x in raw.get("limits") or []
                          if isinstance(x, dict)]
    age = max(0.0, now - observed) if observed > 0 else None
    complete_age = (max(0.0, now - complete_at) if complete_at > 0
                    else None)
    data.update(provider="Codex", observed_at=_iso(observed), age=age,
                stale=bool(age is not None and age > MAX_EVIDENCE_AGE),
                # a board whose EVERY bucket was read at once, recently
                # enough to trust an absence — see the note on `_cache`
                complete=bool(complete_age is not None
                              and complete_age <= MAX_EVIDENCE_AGE),
                complete_age=complete_age,
                # whose board this is — a reader scoped to a different
                # account must treat it as no evidence
                account=acct)
    return data


#: The reserve pool's window is named after the MODEL, not after a limit id.
#: Measured 2026-09-03T00:03Z on the reporting machine, while the account's
#: own plan window sat spent at 100%:
#:
#:     rateLimitsByLimitId["base_model_inference"] = {
#:         "limitName": "gpt-reserve",
#:         "primary": {"usedPercent": 8, "windowDurationMins": 10080,
#:                     "resetsAt": 1788960413},          # 2026-09-09T13:26:53Z
#:         "rateLimitReachedType": None}
#:
#: `base_model_inference` is an internal id and not something to hard-code;
#: `limitName` is the model, and `_normalize` already carries it through as
#: each window's `model`.  So the question below is asked by model name.


def grants(model: str) -> bool | None:
    """Does this account currently hold a rate-limit window of its OWN for
    `model` — i.e. is the pool granted to it right now?

    THIS IS A PRESENCE QUESTION, NOT A FULLNESS ONE.  A granted-but-spent
    reserve window still answers True, because a spent window prepares an
    agent rather than refusing one (the ruling above `providers.RESERVE_TIER`).
    What moves is whether the bucket EXISTS at all: measured on the reporting
    machine, reserve turns at 16:06-16:38Z billed to this window as it went
    2% -> 8%, and by 19:15Z — grant withdrawn — the CLI reported `limit_id
    "premium"` with no windows at all and failed `usage_limit_exceeded`.

    `None` is "no fresh evidence either way" and is NEVER a refusal: a board
    that could not be read, or one older than `MAX_EVIDENCE_AGE`, leaves the
    tier alone and lets the CLI refuse the turn loudly on its own.

    `fetch` is asked first so a cold cache is filled, then `snapshot` for the
    age the fetch does not report; both are cheap once the 30s cache is warm,
    and the usage panel keeps it warm anyway.
    """
    fetch()
    board = snapshot()
    if not board.get("available") or board.get("stale"):
        return None
    return any(str(window.get("model") or "") == model
               for window in board.get("limits") or [])


def invalidate() -> None:
    with _lock:
        _cache.update(at=0.0, data=None, complete_at=0.0, account=None)
        _snapshots.clear()
        _observed.clear()
        _refused.update(foreign=0, race=0)
