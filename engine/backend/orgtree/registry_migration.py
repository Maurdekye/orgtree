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
  · UNIVERSAL BINDINGS — every node of every NON-SANDBOXED org gets an
    explicit `account` binding: its provider's ambient row id, or the literal
    sentinel `missing:<provider>` when that provider has no observed login —
    a deliberate, visible fleet-park listed in the report, resolvable by
    registering an account and reassigning. Sandboxed orgs take NO binding
    (declared exemption: the container env owns the credential). OpenRouter
    nodes take NO binding (D6: that lane is not an account).
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
    succeeded. A partial failure raises MigrationIncomplete with the
    truthful report — minted rows and saved bindings stay, the marker does
    not, and the next startup with the flag finishes the remainder.
    Returns the report, or None when the gate is closed."""
    from . import store
    if os.environ.get(CUTOVER_ENV) != "1":
        return None
    with store.DOC_LOCK:
        slugs: list[str] = []
        seen: set[str] = set()
        try:
            names = sorted(os.listdir(store._orgs_dir()))
        except OSError:
            names = []
        for f in names:
            slug = f[:-5] if f.endswith(".json") else (
                f[:-3] if f.endswith(".db") else "")
            if slug and slug not in seen and not f.endswith(".premigration"):
                seen.add(slug)
                slugs.append(slug)
        orgs = []
        for slug in slugs:
            try:
                orgs.append(store.load_org(slug))
            except Exception:                                # noqa: BLE001
                # an unloadable org is reported, never guessed at
                continue
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
    report["skipped_unloadable"] = sorted(set(slugs)
                                          - {str(o.d.get("slug") or "")
                                             for o in orgs})
    report["saved_orgs"] = saved
    report["save_failures"] = save_failures
    report["completed"] = not save_failures
    write_err = _write_report(report, store.DATA_ROOT)
    if save_failures or write_err:
        report["completed"] = False
        if write_err:
            report["report_write_error"] = write_err
        raise MigrationIncomplete(
            f"saved {len(saved)}/{len(changed)} changed orgs"
            + (f", save failures: {save_failures}" if save_failures else "")
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


def _sandboxed(doc: dict[str, Any]) -> bool:
    # sandbox._cfg's fields, readable off the raw doc (kiosk sandbox or a
    # top-level sandbox config); no Org construction needed here.
    if (doc.get("kiosk") or {}).get("sandbox"):
        return True
    return bool(doc.get("sandbox") or {})


def _node_provider(node: dict[str, Any]) -> str:
    return providers.provider_of(str(node.get("model") or ""))


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
    kind = str(credential.get("kind") or "")
    for row in registry.load(strict=True)["accounts"]:
        c = row.get("credential") or {}
        if row.get("provider") != provider or c.get("kind") != kind:
            continue
        if kind == "token":
            if str(c.get("token_ref") or "") == str(
                    credential.get("token_ref") or ""):
                return row
        elif _same_path(c.get("path"), credential.get("path")):
            return row
    return registry.create_account(provider, label, credential,
                                   origin_org=origin_org,
                                   registered_from=registered_from)


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
        "skipped_sandboxed": [], "skipped_openrouter": [],
        "bound_nodes": 0, "changed_orgs": [],
    }

    # 1. ambient rows (observed only), claude → primary alias
    ambient_ids: dict[str, str] = {}
    for provider, path in ambient.items():
        if not path:
            continue
        row = _reuse_or_create(
            provider, f"{provider} (machine login)",
            {"kind": "imported", "path": path},
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
        if _sandboxed(org):
            report["skipped_sandboxed"].append(slug)
            continue
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
            if not isinstance(node, dict) or node.get("account"):
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
