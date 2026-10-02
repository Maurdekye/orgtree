"""One-shot migration into the provider-agnostic account registry (S2).

Design v2-accounts-design.md D2a/D2e, user rulings 18:38Z. What it does, in
evidence order, and what it deliberately does not:

  · AMBIENT ROWS — one imported row per provider whose machine login is
    OBSERVED (a directory that exists). Migration never invents a row (N5).
    The claude ambient row also becomes the `primary` alias, retiring the
    sentinel without breaking legacy readers.
  · LEGACY KEY ROWS — every accounts.py key row becomes a token-kind row
    (token_ref = the legacy row id; key material stays in the token store).
    Compatibility only (Q1): new setup never mints these.
  · ORG KEYS, EVIDENCE-BASED (18:11Z/18:38Z rulings): an org whose key use is
    UNCONDITIONAL (api_key set, api_fallback flag OFF — the key IS the lane,
    supervisor.spawn_env returns on it) gets an org-scoped token row and its
    claude-lane nodes bind to it. An org with CONDITIONAL use (api_fallback
    ON — the key is a spare) is the HELD case: nodes bind to their normal
    ambient lane, the key mints nothing, and the report documents the org for
    a decision. Ambiguity is never inferred as a fallback switch.
  · UNIVERSAL BINDINGS — every node of every org gets an explicit
    `account` binding: its provider's ambient row id, or the literal
    sentinel `missing:<provider>` when that provider has no observed login —
    a deliberate, visible fleet-park listed in the report, resolvable by
    registering an account and reassigning. OpenRouter nodes take NO
    binding (D6: that lane is not an account).
  · INERT DECLARATION — with nothing to observe and nothing to migrate the
    report SAYS it was inert rather than passing quietly.

Pure engine: org documents come in as dicts and are mutated in place; the
caller (startup wiring, a later stage) persists the ones this returns as
changed. The registry writes are real, and RESUMABLE: every mint goes
through credential-evidence reuse (`_reuse_or_create`), so a rerun after a
partial failure returns the rows a prior attempt minted instead of
duplicating them, and nodes already bound are never re-bound. COMPLETION IS
THE CALLER'S: the engine reads `migrated_at` (an already-complete migration
answers inert) but never writes it — the startup adapter marks it only
after every changed org has saved AND the report has landed, so a partial
save failure holds the marker and the next startup finishes the remainder
rather than skipping it as done.
"""
from __future__ import annotations

import os
import time
from typing import Any

from . import accounts, providers, registry


#: THE CUTOVER FLAG. Migration binds every live node and ACTIVATES the whole
#: account system's placement semantics — it runs at startup ONLY when the
#: operator sets this, never implicitly (coordinator/user: commit the wiring
#: behind explicit activation, no live cutover). The report lands beside the
#: registry for the operator to read.
CUTOVER_ENV = "ORGTREE_ACCOUNTS_CUTOVER"
REPORT_NAME = "accounts-migration-report.json"


class MigrationIncomplete(RuntimeError):
    """The startup migration did NOT finish: some changed org failed to save
    or the report failed to land. `migrated_at` was deliberately NOT set, so
    the next startup with the flag resumes — reusing already-minted rows and
    already-written bindings — instead of skipping a half-done fleet as
    complete. Carries the truthful report on `.report`."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def mark_migrated(now: float | None = None) -> None:
    """Set the completion marker. The CALLER's act, never the engine's:
    call it only once every changed org and the report have persisted."""
    d = registry.load(strict=True)
    d["migrated_at"] = time.time() if now is None else now
    registry.save(d)


def _write_report(report: dict[str, Any], data_root: str) -> str | None:
    """Land the report beside the registry; the error string on failure
    (report state is part of completion, so the caller must see it fail)."""
    import json as _json
    try:
        with open(os.path.join(data_root, REPORT_NAME), "w",
                  encoding="utf-8") as f:
            _json.dump(report, f, indent=1)
        return None
    except OSError as e:
        return str(e)


def run_startup_migration() -> dict[str, Any] | None:
    """The startup adapter: gated on CUTOVER_ENV=1, loads every org doc,
    runs the pure engine, persists exactly the orgs the engine changed,
    writes the report, and marks completion ONLY when all of that
    succeeded — an unloadable org (or an unlistable orgs dir) holds
    completion too, since its nodes missed placement. Any partial failure
    raises MigrationIncomplete with the truthful report — minted rows and
    saved bindings stay, the marker does not, and the next startup with
    the flag finishes the remainder.
    Returns the report, or None when the gate is closed."""
    from . import store
    if os.environ.get(CUTOVER_ENV) != "1":
        return None
    with store.DOC_LOCK:
        slugs: list[str] = []
        seen: set[str] = set()
        try:
            names = sorted(os.listdir(store._orgs_dir()))
        except OSError as e:
            # an unreadable orgs dir must never read as an empty fleet
            # migrated to completion — hold, truthfully
            raise MigrationIncomplete(
                f"cannot list the orgs directory: {e}",
                {"completed": False, "inert": False,
                 "error": f"orgs directory unreadable: {e}"}) from None
        for f in names:
            slug = f[:-5] if f.endswith(".json") else (
                f[:-len(store.db_ext())] if f.endswith(store.db_ext()) else "")
            if slug and slug not in seen and not f.endswith(".premigration"):
                seen.add(slug)
                slugs.append(slug)
        orgs = []
        unloadable: dict[str, str] = {}
        for slug in slugs:
            try:
                orgs.append(store.load_org(slug))
            except Exception as e:                           # noqa: BLE001
                # an unloadable org is reported AND holds completion: its
                # nodes missed placement, so the fleet is not migrated
                unloadable[slug] = f"{type(e).__name__}: {e}"
        docs = [o.d for o in orgs]
        report = run_migration(docs)
        if report.get("reason") == "already migrated":
            # complete on a prior startup: change nothing, and keep that
            # run's report on disk rather than overwriting it with this stub
            print("[orgtree] accounts cutover migration already complete "
                  f"(migrated_at={report.get('migrated_at')})")
            return report
        changed = set(report.get("changed_orgs") or [])
        saved: list[str] = []
        save_failures: dict[str, str] = {}
        for o in orgs:
            slug = str(o.d.get("slug") or "")
            if slug not in changed:
                continue
            try:
                store.save_org(o)
            except Exception as e:                           # noqa: BLE001
                # keep going: every org that CAN persist does, so the rerun
                # has less to redo — but completion is now off the table
                save_failures[slug] = f"{type(e).__name__}: {e}"
            else:
                saved.append(slug)
    report["skipped_unloadable"] = sorted(unloadable)
    report["unloadable_errors"] = unloadable
    report["saved_orgs"] = saved
    report["save_failures"] = save_failures
    report["completed"] = not save_failures and not unloadable
    write_err = _write_report(report, store.DATA_ROOT)
    if save_failures or unloadable or write_err:
        report["completed"] = False
        if write_err:
            report["report_write_error"] = write_err
        raise MigrationIncomplete(
            f"saved {len(saved)}/{len(changed)} changed orgs"
            + (f", save failures: {save_failures}" if save_failures else "")
            + (f", unloadable orgs missed placement: {unloadable}"
               if unloadable else "")
            + (f", report write failed: {write_err}" if write_err else ""),
            report)
    mark_migrated()
    print(f"[orgtree] accounts cutover migration ran: "
          f"{report.get('bound_nodes', 0)} nodes bound, "
          f"held={report.get('org_key_held')}, "
          f"missing={len(report.get('missing_bindings') or [])}, "
          f"inert={report.get('inert')}")
    return report


def observe_ambient() -> dict[str, str | None]:
    """The machine logins that exist RIGHT NOW, by directory presence.
    Antigravity has no established ambient config dir in this codebase, so
    `google` is observed only via ORGTREE_AGY_HOME (explicit operator
    signal); otherwise absent — migration invents nothing (N5)."""
    claude = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    codex = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    agy = os.environ.get("ORGTREE_AGY_HOME") or ""
    return {"claude": claude if os.path.isdir(claude) else None,
            "openai": codex if os.path.isdir(codex) else None,
            "google": agy if agy and os.path.isdir(agy) else None}


#: the org-document fields the API-key cutover converts or removes
_CUTOVER_FIELDS = ("api_key", "api_fallback", "fable_api_fallback",
                   "api_fallback_until", "api_fallback_since")


def _node_provider(node: dict[str, Any]) -> str:
    return providers.provider_of(str(node.get("model") or ""))


def _claude_default_config(path: str) -> bool:
    """Measured CLI semantics (root, 2026-09-10): with NO selector the CLI
    writes HOME/.claude.json — identity BESIDE the config dir — so the
    unredirected machine login is a DEFAULT-CONFIG row. An explicit
    CLAUDE_CONFIG_DIR, even pointing at that same directory, writes
    <dir>/.claude.json and must stay a redirected row. Hence: default only
    when the selector is unset AND the path canonically IS ~/.claude."""
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        return False
    default = os.path.expanduser("~/.claude")
    return (os.path.normcase(os.path.realpath(path))
            == os.path.normcase(os.path.realpath(default)))


def _same_path(a: Any, b: Any) -> bool:
    a, b = str(a or ""), str(b or "")
    if not a or not b:
        return False
    return (os.path.normcase(os.path.abspath(a))
            == os.path.normcase(os.path.abspath(b)))


def _reuse_or_create(provider: str, label: str, credential: dict[str, Any],
                     *, origin_org: str | None = None,
                     registered_from: str = "") -> dict[str, Any]:
    """Resumability's core: a rerun (after a partial startup failure, or
    with rows the operator already registered for the same credential) must
    return the EXISTING row, never mint a duplicate — the credential
    evidence (imported path / token ref) IS the row's identity here, so
    already-written `account` bindings keep pointing at a live id."""
    row = _find_row(provider, credential)
    if row is not None:
        return row
    return registry.create_account(provider, label, credential,
                                   origin_org=origin_org,
                                   registered_from=registered_from)


def _find_row(provider: str, credential: dict[str, Any]
              ) -> dict[str, Any] | None:
    """The existing row for this credential evidence, or None."""
    kind = str(credential.get("kind") or "")
    for row in registry.load(strict=True)["accounts"]:
        c = row.get("credential") or {}
        if row.get("provider") != provider or c.get("kind") != kind:
            continue
        if kind == "token":
            if str(c.get("token_ref") or "") == str(
                    credential.get("token_ref") or ""):
                return row
        elif (_same_path(c.get("path"), credential.get("path"))
              and bool(c.get("default_config")) == bool(credential.get("default_config"))):
            # The same directory with/without CLAUDE_CONFIG_DIR selects
            # different metadata, so those are different account identities.
            return row
    return None


def run_migration(org_docs: list[dict[str, Any]],
                  ambient: dict[str, str | None] | None = None
                  ) -> dict[str, Any]:
    """Returns the migration report; mutates org docs in place and returns
    the changed slugs inside it (`changed_orgs`) for the caller to persist.
    Never writes `migrated_at` — that is the caller's completion marker,
    set only after those persists succeed (mark_migrated). Rerunnable:
    rows come back by credential evidence, bound nodes are left alone."""
    ambient = observe_ambient() if ambient is None else ambient
    doc = registry.load(strict=True)
    if doc.get("migrated_at"):
        return {"inert": True, "reason": "already migrated",
                "migrated_at": doc["migrated_at"], "changed_orgs": []}

    report: dict[str, Any] = {
        "inert": False, "ambient_rows": {}, "key_rows": [],
        "org_key_rows": {}, "org_key_held": [], "missing_bindings": [],
        "skipped_openrouter": [],
        "bound_nodes": 0, "changed_orgs": [],
    }

    # 1. ambient rows (observed only), claude → primary alias
    ambient_ids: dict[str, str] = {}
    for provider, path in ambient.items():
        if not path:
            continue
        cred: dict[str, Any] = {"kind": "imported", "path": path}
        if provider == "claude" and _claude_default_config(path):
            # persisted by registry validation (root's half of the split);
            # the injector reads it to leave the selector UNSET for spawns
            cred["default_config"] = True
        row = _reuse_or_create(
            provider, f"{provider} (machine login)", cred,
            registered_from="migration:ambient")
        ambient_ids[provider] = row["id"]
        report["ambient_rows"][provider] = row["id"]
    if "claude" in ambient_ids:
        d2 = registry.load(strict=True)
        d2["aliases"]["primary"] = ambient_ids["claude"]
        registry.save(d2)

    # 2. legacy key rows → token-kind rows (compatibility, Q1)
    for k in accounts.load().get("keys", []):
        row = _reuse_or_create(
            "claude", f"key {k['id'][:8]}",
            {"kind": "token", "token_ref": str(k["id"])},
            registered_from="migration:legacy-key")
        report["key_rows"].append(row["id"])

    # 3 + 4. org keys by durable-config evidence, then universal bindings
    for org in org_docs:
        slug = str(org.get("slug") or "")
        org_key_id: str | None = None
        if str(org.get("api_key") or ""):
            if org.get("api_fallback"):
                # conditional spare: the HELD case — documented, not guessed
                report["org_key_held"].append(slug)
            else:
                row = _reuse_or_create(
                    "claude", f"org key ({slug})",
                    {"kind": "token", "token_ref": f"org-api-key:{slug}"},
                    origin_org=slug,
                    registered_from="migration:org-key")
                org_key_id = row["id"]
                report["org_key_rows"][slug] = org_key_id
        changed = False
        for nid, node in (org.get("nodes") or {}).items():
            if (not isinstance(node, dict) or node.get("account")
                    or node.get("account_primary")):
                continue
            provider = _node_provider(node)
            if provider == "openrouter":
                report["skipped_openrouter"].append(f"{slug}/{nid}")
                continue
            if provider == "claude" and org_key_id:
                node["account"] = org_key_id       # evidence: the key IS the lane
            elif provider in ambient_ids:
                node["account"] = ambient_ids[provider]
            else:
                node["account"] = f"missing:{provider}"
                report["missing_bindings"].append(f"{slug}/{nid}")
            report["bound_nodes"] += 1
            changed = True
        if changed:
            report["changed_orgs"].append(slug)

    if (not report["ambient_rows"] and not report["key_rows"]
            and not report["org_key_rows"] and not report["org_key_held"]
            and report["bound_nodes"] == 0):
        # nothing observed, nothing migrated: say so rather than pass quietly
        report["inert"] = True
        report["reason"] = "no ambient logins, keys, org keys or nodes found"
    return report


# ── the V2 API-key ACCOUNT cutover (user redesign 2026-09-12) ───────────────
APIKEY_CUTOVER_REPORT = "apikey-cutover-report.json"


def apikey_cutover_done() -> bool:
    return bool(registry.load().get("apikey_cutover_at"))


def run_apikey_cutover() -> dict[str, Any] | None:
    """Every V1 org key becomes an ordinary org-scoped API-key ACCOUNT, and
    the org documents drop the V1 fields — the migration half of "completely
    replace the V1 path; do not retain competing systems".

    Unconditional at startup (no env gate: the code that served org.d
    api_key is gone, so an unmigrated key is a stranded key), idempotent
    (marker in the registry document; a partial failure leaves the marker
    unset and the next boot finishes the remainder), and it NEVER raises —
    the app must come up; failures are printed and land in the report.

      · a row {kind: token, token_ref: org-api-key:<slug>} whose org still
        holds its key is REWRITTEN IN PLACE — same id, so existing node
        bindings survive — to {kind: apikey, token_ref} with the secret
        moved into the machine token store, store-first;
      · an org holding a key with NO row (the S2 "held" api_fallback case)
        mints a fresh org-scoped apikey row. Its nodes are NOT bound to it
        (a spare never was the lane) and the machine fallback toggle stays
        OFF — the ticket's default — with the org named in
        `fallback_was_on` so the operator can re-enable deliberately;
      · an orphaned org-key row (org gone, or loaded and keyless) is marked
        unauthenticated and reported: its secret no longer exists anywhere,
        which is a fact to surface, not a repair to invent;
      · every org drops api_key / api_fallback /
        fable_api_fallback / api_fallback_until / api_fallback_since."""
    from . import apikey_accounts, store, tokens
    if apikey_cutover_done():
        return None
    report: dict[str, Any] = {"converted_rows": {}, "minted_rows": {},
                              "fallback_was_on": [], "orphaned_rows": [],
                              "cleaned_orgs": [],
                              "errors": {}}
    with store.DOC_LOCK:
        try:
            doc = registry.load(strict=True)
        except registry.RegistryUnreadable as e:
            print(f"[orgtree] apikey cutover held: {e}")
            return None
        by_slug: dict[str, str] = {}
        for row in doc["accounts"]:
            cred = row.get("credential") or {}
            ref = str(cred.get("token_ref") or "")
            if cred.get("kind") == "token" and ref.startswith("org-api-key:"):
                by_slug[ref.split(":", 1)[1]] = str(row["id"])
        try:
            names = sorted(os.listdir(store._orgs_dir()))
        except OSError as e:
            print(f"[orgtree] apikey cutover held: orgs dir unreadable: {e}")
            return None
        slugs: list[str] = []
        seen: set[str] = set()
        for f in names:
            slug = f[:-5] if f.endswith(".json") else (
                f[:-len(store.db_ext())] if f.endswith(store.db_ext()) else "")
            if slug and slug not in seen and not f.endswith(".premigration"):
                seen.add(slug)
                slugs.append(slug)
        clean = True
        loaded: set[str] = set()
        for slug in slugs:
            try:
                if store.STORE_BACKEND == "postgres":
                    # the settings keys first (no node row decoded): an org
                    # with none of the fields this pass converts or removes
                    # needs no whole load and no save (engine-startup-cost-
                    # must-not-grow-with-retired-h). Same outcome as the walk
                    # below: a keyless org counts as loaded.
                    view = store.doc_keys_view(slug)
                    if not any(f in view for f in _CUTOVER_FIELDS):
                        loaded.add(slug)
                        continue
                org = store.load_org(slug)
            except Exception as e:                           # noqa: BLE001
                report["errors"][slug] = f"{type(e).__name__}: {e}"
                clean = False
                continue
            loaded.add(slug)
            d = org.d
            key = str(d.get("api_key") or "")
            if key:
                kid = apikey_accounts._key_row_id(key)
                tokens.put(kid, key)          # durable before anything else
                rid = by_slug.get(slug)
                try:
                    if rid:
                        d2 = registry.load(strict=True)
                        for row in d2["accounts"]:
                            if row["id"] == rid:
                                row["credential"] = {"kind": "apikey",
                                                     "token_ref": kid}
                                row["mode"] = "apikey"
                                row.setdefault("enabled", True)
                        registry.save(d2)
                        report["converted_rows"][slug] = rid
                    else:
                        row = registry.create_account(
                            "claude", f"org key ({slug})",
                            {"kind": "apikey", "token_ref": kid},
                            origin_org=slug, mode="apikey",
                            registered_from="migration:apikey-cutover")
                        report["minted_rows"][slug] = row["id"]
                except Exception as e:                       # noqa: BLE001
                    # the org keeps its fields; the next boot retries it
                    report["errors"][slug] = f"{type(e).__name__}: {e}"
                    clean = False
                    continue
                if d.get("api_fallback"):
                    report["fallback_was_on"].append(slug)
            changed = False
            for field in _CUTOVER_FIELDS:
                if field in d:
                    d.pop(field, None)
                    changed = True
            if changed:
                try:
                    store.save_org(org)
                    report["cleaned_orgs"].append(slug)
                except Exception as e:                       # noqa: BLE001
                    report["errors"][slug] = f"{type(e).__name__}: {e}"
                    clean = False
        for slug, rid in by_slug.items():
            if slug in report["converted_rows"] or slug in report["errors"]:
                continue
            if slug in loaded or slug not in seen:
                # loaded-and-keyless, or the org file is gone: the secret
                # this row pointed at no longer exists anywhere
                try:
                    registry.set_auth(rid, "unauthenticated")
                except Exception:                            # noqa: BLE001
                    pass
                report["orphaned_rows"].append(rid)
        if clean:
            try:
                d3 = registry.load(strict=True)
                d3["apikey_cutover_at"] = time.time()
                registry.save(d3)
            except Exception as e:                           # noqa: BLE001
                print(f"[orgtree] apikey cutover: marker write failed: {e}")
    try:
        import json as _json
        with open(os.path.join(store.DATA_ROOT, APIKEY_CUTOVER_REPORT),
                  "w", encoding="utf-8") as f:
            _json.dump(report, f, indent=1)
    except OSError:
        pass
    print(f"[orgtree] apikey cutover: "
          f"converted={len(report['converted_rows'])} "
          f"minted={len(report['minted_rows'])} "
          f"orphaned={len(report['orphaned_rows'])} "
          f"fallback_was_on={report['fallback_was_on']} "
          f"errors={len(report['errors'])}")
    return report


# ── catch-up for orgs the two cutovers skipped while sandboxed ──────────────
#: Both cutovers above used to skip a sandboxed org whole (its container held
#: its own credential) and still set their completion markers. The sandbox is
#: gone (v3-remove-the-per-org-docker-sandbox-feature), so those orgs now run
#: on the host, but a finished cutover never revisits them. This one-time
#: pass gives exactly those orgs (the ones still storing the ignored legacy
#: `sandbox` key) what each FINISHED cutover would have given them.
FORMER_SANDBOX_MARKER = "former_sandbox_catchup_at"
FORMER_SANDBOX_REPORT = "former-sandbox-catchup-report.json"


def _org_slugs() -> list[str]:
    from . import store
    slugs: list[str] = []
    seen: set[str] = set()
    for f in sorted(os.listdir(store._orgs_dir())):
        slug = f[:-5] if f.endswith(".json") else (
            f[:-len(store.db_ext())] if f.endswith(store.db_ext()) else "")
        if slug and slug not in seen and not f.endswith(".premigration"):
            seen.add(slug)
            slugs.append(slug)
    return slugs


def run_former_sandbox_catchup(ambient: dict[str, str | None] | None = None
                               ) -> dict[str, Any] | None:
    """For every org still storing a legacy `sandbox` key:

      · when the registry cutover is complete (`migrated_at`): unbound nodes
        get the binding run_migration gives — the org's key row when its key
        was the lane (api_key set, api_fallback off), else the provider's
        EXISTING machine-login row, else `missing:<provider>`. Nodes already
        bound (or primary-pinned) are never touched; no ambient row is
        minted and no alias moves.
      · when the API-key cutover is complete (`apikey_cutover_at`): a stored
        key moves into the token store FIRST, then becomes an org-scoped
        apikey row (an existing row for the same key or the org's S2 token
        row is reused, never duplicated) and the org drops the V1 fields.

    A cutover that is NOT complete yet is left to do its own work (its skip
    branch is gone). Idempotent: rows come back by evidence and bound nodes
    are left alone; the marker is set only after a clean pass. Never raises
    (the app must come up); the report lands beside the registry.
    Returns the report, or None when there is nothing to do."""
    from . import apikey_accounts, store, tokens
    try:
        reg = registry.load(strict=True)
    except registry.RegistryUnreadable as e:
        print(f"[orgtree] former-sandbox catch-up held: {e}")
        return None
    if reg.get(FORMER_SANDBOX_MARKER):
        return None
    bind = bool(reg.get("migrated_at"))
    keys = bool(reg.get("apikey_cutover_at"))
    if not bind and not keys:
        return None
    report: dict[str, Any] = {"orgs": [], "bound_nodes": 0,
                              "missing_bindings": [], "org_key_rows": {},
                              "fallback_was_on": [], "cleaned_orgs": [],
                              "errors": {}}
    clean = True
    with store.DOC_LOCK:
        ambient_ids: dict[str, str] = {}
        if bind:
            ambient = observe_ambient() if ambient is None else ambient
            for provider, path in ambient.items():
                if not path:
                    continue
                cred: dict[str, Any] = {"kind": "imported", "path": path}
                if provider == "claude" and _claude_default_config(path):
                    cred["default_config"] = True
                found = _find_row(provider, cred)
                if found is not None:
                    ambient_ids[provider] = str(found["id"])
        try:
            slugs = _org_slugs()
        except OSError as e:
            print(f"[orgtree] former-sandbox catch-up held: "
                  f"orgs dir unreadable: {e}")
            return None
        for slug in slugs:
            try:
                if store.STORE_BACKEND == "postgres":
                    # settings keys only: an org that never was sandboxed
                    # costs no whole load
                    if not store.doc_keys_view(slug).get("sandbox"):
                        continue
                org = store.load_org(slug)
            except Exception as e:                           # noqa: BLE001
                report["errors"][slug] = f"{type(e).__name__}: {e}"
                clean = False
                continue
            d = org.d
            if not d.get("sandbox"):
                continue
            report["orgs"].append(slug)
            changed = False
            try:
                key = str(d.get("api_key") or "")
                key_row: str | None = None
                if key and keys:
                    kid = apikey_accounts._key_row_id(key)
                    tokens.put(kid, key)      # durable before anything else
                    row = (_find_row("claude", {"kind": "apikey",
                                                "token_ref": kid})
                           or _find_row("claude", {
                               "kind": "token",
                               "token_ref": f"org-api-key:{slug}"}))
                    if row is None:
                        row = registry.create_account(
                            "claude", f"org key ({slug})",
                            {"kind": "apikey", "token_ref": kid},
                            origin_org=slug, mode="apikey",
                            registered_from="migration:former-sandbox")
                    elif (row.get("credential") or {}).get("kind") == "token":
                        d2 = registry.load(strict=True)
                        for r in d2["accounts"]:
                            if r["id"] == row["id"]:
                                r["credential"] = {"kind": "apikey",
                                                   "token_ref": kid}
                                r["mode"] = "apikey"
                                r.setdefault("enabled", True)
                        registry.save(d2)
                    key_row = str(row["id"])
                elif key and bind and not d.get("api_fallback"):
                    # the API-key cutover has not run yet: an S2 token row,
                    # which that cutover converts in place later
                    key_row = str(_reuse_or_create(
                        "claude", f"org key ({slug})",
                        {"kind": "token", "token_ref": f"org-api-key:{slug}"},
                        origin_org=slug,
                        registered_from="migration:former-sandbox")["id"])
                if key_row:
                    report["org_key_rows"][slug] = key_row
                # a spare (api_fallback on) never was the lane: bind nobody
                lane = key_row if (key and not d.get("api_fallback")) else None
                if bind:
                    for nid, node in (d.get("nodes") or {}).items():
                        if (not isinstance(node, dict) or node.get("account")
                                or node.get("account_primary")):
                            continue
                        provider = _node_provider(node)
                        if provider == "openrouter":
                            continue
                        if provider == "claude" and lane:
                            node["account"] = lane
                        elif provider in ambient_ids:
                            node["account"] = ambient_ids[provider]
                        else:
                            node["account"] = f"missing:{provider}"
                            report["missing_bindings"].append(f"{slug}/{nid}")
                        report["bound_nodes"] += 1
                        changed = True
                if keys:
                    if key and d.get("api_fallback"):
                        report["fallback_was_on"].append(slug)
                    for field in _CUTOVER_FIELDS:
                        if field in d:
                            d.pop(field, None)
                            changed = True
            except Exception as e:                           # noqa: BLE001
                report["errors"][slug] = f"{type(e).__name__}: {e}"
                clean = False
                continue
            if changed:
                try:
                    store.save_org(org)
                    report["cleaned_orgs"].append(slug)
                except Exception as e:                       # noqa: BLE001
                    report["errors"][slug] = f"{type(e).__name__}: {e}"
                    clean = False
        if clean:
            try:
                d3 = registry.load(strict=True)
                d3[FORMER_SANDBOX_MARKER] = time.time()
                registry.save(d3)
            except Exception as e:                           # noqa: BLE001
                print(f"[orgtree] former-sandbox catch-up: marker write "
                      f"failed: {e}")
    try:
        import json as _json
        with open(os.path.join(store.DATA_ROOT, FORMER_SANDBOX_REPORT),
                  "w", encoding="utf-8") as f:
            _json.dump(report, f, indent=1)
    except OSError:
        pass
    print(f"[orgtree] former-sandbox catch-up: orgs={report['orgs']} "
          f"bound={report['bound_nodes']} "
          f"key_rows={len(report['org_key_rows'])} "
          f"errors={len(report['errors'])}")
    return report
