# pyright: strict
"""ONE per-account usage resolver — the Usage modal and the turn envelope.

⚠ WHY THIS MODULE EXISTS. The header Usage modal already answers "what is the
standing of every account signed in on this machine", and it answers it well:
one card per host provider lane, one card per registered account beyond them,
each with its own windows, reset instants, freshness and honest unavailability
text. The agent turn envelope answered a NARROWER question — the host lanes
plus a name-only row per legacy fallback key — so an agent could not see what
the user could see, and the user's ruling of 2026-09-12 is exactly that it
should: "i want you to be able to see the same information i see in the current
usage modal".

The wrong way to close that gap is a second reader that interprets the same
caches its own way. Two readers drift, and the drift shows up as an agent and
its operator disagreeing about whether an account has room. So the per-account
resolution that used to sit inline in `api.accounts_usage` lives HERE, once,
and both surfaces call it:

    api.accounts_usage   → view(row, allow_fetch=True)    (the modal: may spend
                                                           an upstream request)
    turnusage.board      → view(row, allow_fetch=False)   (the envelope: cache
                                                           and local state only)

`ambient_covered` is the same story for the OTHER half of the modal's
composition — which rows the host provider lanes already serve — so the board
and the modal cannot disagree about whether an account is listed twice or not
at all. `api._ambient_covered` is now a thin delegate to it.

⚠ `allow_fetch=False` IS A HARD PROMISE, not an optimisation. A turn envelope
is rendered on every turn of every agent; if it could fetch, the org would
issue one provider request per agent per turn and rate-limit itself. So the
cache-only path calls only `snapshot`-family readers (`limits.snapshot`,
`limits.snapshot_for_key`, `codex_limits.snapshot`,
`codex_limits.snapshot_for_key`) — never `fetch`, never an app-server process,
and never the credential reads (`subproxy.profile_access_token`,
`providers._codex_account`) that exist to feed one. It opens no process, no
socket and no credentials file.

⚠ AND IT CARRIES NO CREDENTIAL MATERIAL. `view` returns the same secret-free
payload the modal already renders — account id, label, provider, the identity
email the registry already stored, auth standing, marks and normalized limit
windows. Token refs, key material and credential PATHS stay on this side of
the wall: a path is the operator's business and tells an agent nothing it can
act on.
"""
from __future__ import annotations

import os
import time
from typing import Any, Final, cast

from . import accounts, codex_limits, limits, registry

#: Provider order, the modal's own: Claude, Codex, Antigravity.
PROVIDER_ORDER: Final[dict[str, int]] = {"claude": 0, "openai": 1, "google": 2}


def ambient_covered(row: dict[str, Any], primary: str,
                    ambient_paths: dict[str, str | None]) -> bool:
    """Whether this row's usage is ALREADY the host board a provider lane of
    the usage modal serves — decided the same way `view` routes, so the two
    surfaces cannot disagree: the claude row the `primary` alias names answers
    with the Claude Code lane's own board, and an imported/managed row whose
    profile directory IS the ambient home answers with that provider's ambient
    board. Everything else has its own lane.

    Lifted here from `api._ambient_covered` (which now delegates) so the turn
    envelope decides "is this account already on the board" by the identical
    rule the modal decides "have I already drawn this account".
    """
    if row["provider"] == "claude":
        return row["id"] == primary
    cred = row.get("credential") or {}
    if cred.get("kind") not in ("imported", "managed"):
        return False
    home = ambient_paths.get(row["provider"])
    path = cred.get("path")
    if not home or not path:
        return False
    return (os.path.normcase(os.path.normpath(path))
            == os.path.normcase(os.path.normpath(home)))


def canonical_name(row: dict[str, Any], primary: str,
                   ambient_paths: dict[str, str | None]) -> str:
    """Canonical API selector; UI primary is `default`, managed is this ID.

    Legacy name/label fields never choose billing or change public identity.
    """
    return (registry.primary_name(row["provider"])
            if ambient_covered(row, primary, ambient_paths) else str(row["id"]))


def _claude_view(row: dict[str, Any], out: dict[str, Any], *,
                 allow_fetch: bool, now: float) -> dict[str, Any]:
    """A claude PROFILE row — the ambient login, or a redirected profile."""
    cred = cast("dict[str, Any]", row["credential"])
    if registry.resolve_alias("primary") == row["id"]:
        out.update(limits.fetch() if allow_fetch else limits.snapshot(now))
        return out
    cache_key = f"acct:{row['id']}"
    if not allow_fetch:
        # ⚠ NO CREDENTIAL READ ON THIS PATH. The fetch branch below resolves an
        # access token to ask upstream; cache-only has nothing to ask, so it
        # reads the per-account readout this same cache_key was populated
        # under and says so honestly when it is empty. Opening the profile
        # directory here would be a credentials read per agent per turn for an
        # answer that is already either cached or absent.
        out.update(limits.snapshot_for_key(cache_key, now))
        return out
    from . import subproxy                          # noqa: PLC0415 — one lane
    try:
        token = subproxy.profile_access_token(cred["path"])
    except RuntimeError as e:
        # ⚠ THE ROW SAYS `authenticated` BECAUSE A DIRECTORY HOLDS AN ACCOUNT
        # UUID — a fact about a FILE, which stays true long after the login
        # behind it stops working, and which a failure here is not
        # automatically entitled to contradict. So report what was actually
        # observed: a plain sentence the user can act on, the technical line
        # beside it for diagnosis, and a sign-in prompt ONLY when something
        # genuinely judged the credential. An edge 403 or a moved endpoint is
        # NOT that — and it was precisely that failure, dressed up as a login
        # problem, that had this account being sent after a sign-in it never
        # needed.
        out.update(available=False,
                   error=getattr(e, "user_message",
                                 subproxy.RECOVERABLE_MESSAGE),
                   detail=str(e))
        evidence = getattr(e, "evidence", None)
        if evidence:
            out["reauth_required"] = True
            out["reauth_evidence"] = evidence
        return out
    out.update(limits.fetch_for_token(token, cache_key))
    # The subscription tier, from THIS row's own credentials file. It is added
    # here rather than inside `fetch_for_token` on purpose: that function's
    # cache holds the provider-native readout, one entry per account, and the
    # tier is a property of the login rather than of the usage window it
    # caches. Empty means the provider reported none — omitted, never
    # defaulted, so the panel simply shows no tier line.
    plan = limits.profile_plan(cred["path"])
    if plan:
        out["plan"] = plan
    return out


def _codex_view(row: dict[str, Any], out: dict[str, Any], *,
                allow_fetch: bool, now: float) -> dict[str, Any]:
    """An openai profile row: the ambient-home row serves the rich shared
    board; any OTHER home gets its OWN read (isolated cache, pinned home)."""
    from .registry_migration import observe_ambient   # noqa: PLC0415
    cred = cast("dict[str, Any]", row["credential"])
    try:
        ambient = str(observe_ambient().get("openai") or "")
    except Exception:                                          # noqa: BLE001
        ambient = ""
    if ambient and os.path.normcase(os.path.normpath(cred["path"])) \
            == os.path.normcase(os.path.normpath(ambient)):
        out.update(codex_limits.fetch() if allow_fetch
                   else codex_limits.snapshot(now))
        return out
    cache_key = f"acct:{row['id']}"
    out.update(codex_limits.fetch_for_home(cred["path"], cache_key)
               if allow_fetch
               else codex_limits.snapshot_for_key(cache_key, now))
    return out


def view(row: dict[str, Any], *, allow_fetch: bool = True,
         now: float | None = None) -> dict[str, Any]:
    """ONE registered account's usage payload — the modal's own shape.

    `{account, provider, standing, available, error?, unsupported?, limits?[],
      plan?, tiers?[], detail?, reauth_required?, reauth_evidence?}`

    Support matrix, honest: claude profile rows read their own credentials
    file (same scopes as the ambient login); the aliased AMBIENT claude row
    serves the rich host board. Codex: the ambient-home row serves the real
    board; another codex profile gets its own pinned-home read. Antigravity
    stays explicitly unsupported — no usage surface exists to read, and no
    environment selector is invented. Token rows: legacy key rows answer from
    local routing state; an org-key row bills an API key and has no
    subscription windows.
    """
    now = time.time() if now is None else now
    standing = registry.standing_of(row, now)
    cred = cast("dict[str, Any]", row["credential"])
    out: dict[str, Any] = {"account": row["id"],
                           "provider": row["provider"],
                           "standing": standing}
    if row["provider"] == "google":
        out.update(available=False, unsupported=True,
                   error="Antigravity exposes no usage surface")
        return out
    if cred["kind"] == "token":
        ref = str(cred.get("token_ref") or "")
        if ref.startswith("org-api-key:"):
            out.update(available=False,
                       error="API-key billing — no subscription windows")
        elif not allow_fetch and ref == accounts.PRIMARY:
            # `accounts.account_usage("primary")` reaches the host subscription
            # through a fetch. Nothing on the envelope path may fetch, so the
            # same standing is read from its cache instead.
            out.update(limits.snapshot(now))
        else:
            out.update(accounts.account_usage(ref))
        return out
    if row["provider"] == "claude":
        return _claude_view(row, out, allow_fetch=allow_fetch, now=now)
    return _codex_view(row, out, allow_fetch=allow_fetch, now=now)


# ------------------------------------------------------------- board ordering
def _row_rank(row: dict[str, Any]) -> tuple[int, str]:
    """Provider order, then immutable ID; ignored legacy labels cannot reorder
    a board whose byte-stability decides whether a turn re-sends it."""
    return (PROVIDER_ORDER.get(str(row.get("provider") or ""), 90),
            str(row.get("id") or ""))


def identity_of(row: dict[str, Any]) -> dict[str, str]:
    """Public canonical name plus already-observed identity metadata.

    Labels are mutable and may collide with another row's immutable ID, so
    they never become public selectors. No credentials are read here.
    """
    ident = row.get("identity")
    ident = ident if isinstance(ident, dict) else {}
    return {"id": str(row.get("id") or ""),
            "name": str(row.get("id") or ""),
            "label": str(row.get("id") or ""),
            "email": str(ident.get("email") or ""),
            "auth": str(row.get("auth") or "unobserved"),
            "provider": str(row.get("provider") or "")}


def ambient_identities(org: str | None = None) -> list[dict[str, str]]:
    """The IDENTITIES of the registry rows the HOST lanes already serve.

    ⚠ WHY THE IDENTITY TRAVELS WHEN THE USAGE DOES NOT. `registered_views`
    deliberately drops these rows: their usage IS the host board, and drawing
    them a second time would have an agent believe this machine holds two
    accounts where it holds one. But dropping the row dropped its NAME too,
    and the name is the half an agent has to be able to act on — the
    load-balancing rule it is given says "place this work on the account with
    room", and placing work on an account means naming that account's registry
    id to `orgtree_hire`. In the commonest multi-account setup on this machine
    — the ambient sign-in plus one more — the ambient one is exactly the
    account whose id was missing, so HALF the board was unnameable and
    "balance across them" could not be carried out.

    So: the usage stays on the host lane (once), and the id rides the board's
    roster beside it. Decided by the same `ambient_covered` rule, from the same
    module, so the set this returns and the set `registered_views` skips are
    complements by construction rather than by coincidence.
    """
    try:
        rows = registry.list_accounts(org)
        primary = registry.resolve_alias("primary")
        from .registry_migration import observe_ambient   # noqa: PLC0415
        ambient_paths = observe_ambient()
    except Exception:                                          # noqa: BLE001
        return []
    out: list[dict[str, str]] = []
    for row in sorted(rows, key=_row_rank):
        try:
            if ambient_covered(row, primary, ambient_paths):
                identity = identity_of(row)
                identity["name"] = identity["label"] = registry.primary_name(row["provider"])
                out.append(identity)
        except Exception:                                      # noqa: BLE001
            continue                 # one unreadable row never costs the rest
    return out


def registered_views(*, allow_fetch: bool = False, now: float | None = None,
                     org: str | None = None,
                     include_ambient: bool = False,
                     skip_token_refs: set[str] | None = None,
                     ) -> list[dict[str, Any]]:
    """Every registered account BEYOND the host lanes, resolved and ordered.

    The same list the Usage modal builds: `GET /api/accounts` minus the rows
    `ambient_covered` says a provider lane already serves. `org` scopes out
    another org's API-key rows exactly as `registry.list_accounts` does, so an
    agent is never shown an account its org may not bill.

    `skip_token_refs` drops token rows whose `token_ref` the caller has
    ALREADY rendered by another route — the turn board's legacy `fallback-N`
    lanes are the case that matters: one `claude setup-token` key is both an
    `accounts.json` key and a registry row, and listing it twice would have an
    agent believe this machine holds two accounts where it holds one.

    Each entry is `{"row": <identity>, "usage": <view payload>}`. One failing
    account degrades to an unavailable entry and never takes the board down:
    telemetry is context, never an admission gate.
    """
    now = time.time() if now is None else now
    skip = skip_token_refs or set()
    try:
        rows = registry.list_accounts(org)
        primary = registry.resolve_alias("primary")
        from .registry_migration import observe_ambient   # noqa: PLC0415
        ambient_paths = observe_ambient()
    except Exception:                                          # noqa: BLE001
        return []
    out: list[dict[str, Any]] = []
    for row in sorted(rows, key=_row_rank):
        try:
            if not include_ambient and ambient_covered(row, primary,
                                                       ambient_paths):
                continue
            cred = row.get("credential") or {}
            if skip and cred.get("kind") == "token" \
                    and str(cred.get("token_ref") or "") in skip:
                continue
            usage = view(row, allow_fetch=allow_fetch, now=now)
        except Exception as e:                                 # noqa: BLE001
            usage = {"account": row.get("id"), "provider": row.get("provider"),
                     "available": False,
                     "error": f"usage unavailable: {type(e).__name__}",
                     "standing": {"auth": row.get("auth", "unobserved"),
                                  "state": "ready", "marks": {}}}
        out.append({"row": identity_of(row), "usage": usage})
    return out
