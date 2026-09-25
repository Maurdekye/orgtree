"""Account and startup specification shared by Antigravity turns and prewarm."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from . import agentauth, appsettings, managed_profiles, providers, registry, store, tokens


def key_home(row: dict[str, Any]) -> str:
    """A settings-only profile. Keys remain exclusively in the token store."""
    home = os.path.join(store.DATA_ROOT, "profiles", f"google-key-{row['id']}")
    managed_profiles.create_profile_at(home)
    config = os.path.join(home, ".gemini", "antigravity-cli")
    os.makedirs(config, exist_ok=True)
    path = os.path.join(config, "settings.json")
    body = '{"modelProvider":"gemini"}\n'
    try:
        with open(path, encoding="utf-8") as f:
            current = f.read()
    except FileNotFoundError:
        current = ""
    if current != body:
        fd, temporary = tempfile.mkstemp(dir=config, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(body)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
    return home


def selected_account(org: Any, nid: str) -> dict[str, Any] | None:
    from . import supervisor as sup
    n = org.node(nid)
    bound = str(n.get("account") or "")
    if bound:
        return registry.validate_binding(org.d["slug"], n["model"], bound)
    return sup.apikey_route_for(n["model"])


def environment(org: Any, nid: str, row: dict[str, Any] | None) -> dict[str, str]:
    from . import supervisor as sup
    env = providers.antigravity_env(sup.clean_env())
    slug = org.d["slug"]
    env.update(agentauth.child_env(slug, nid))
    env.update(ORGTREE_ORG=slug, ORGTREE_NODE=nid,
               ORGTREE_PORT=os.environ.get("ORGTREE_PORT", "7360"))
    if row is not None:
        if registry.account_mode(row) != "apikey":
            raise RuntimeError("Antigravity cannot isolate a secondary subscription account")
        registry.inject_binding(env, row, secret_resolver=tokens.get)
        home = key_home(row)
        env.update(HOME=home, USERPROFILE=home)
    elif not appsettings.subscription_inference_enabled("google"):
        raise RuntimeError("Antigravity subscription inference is disabled and no API-key account is available")
    return env


def specification(org: Any, nid: str, *, write: bool = False) -> dict[str, Any]:
    from . import antigravityrun, deployment, supervisor as sup
    n = org.node(nid)
    row = selected_account(org, nid)
    status = providers.antigravity_status()
    exe = str(status.get("path") or "")
    if not status.get("installed") or not exe:
        raise RuntimeError("Antigravity CLI is not installed")
    if row is None and not status.get("connected"):
        raise RuntimeError("Antigravity CLI is not signed in; sign in or select a Gemini API-key account")
    env = environment(org, nid, row)
    model = org.model_for(nid)
    if row is not None and not model.startswith("gemini-"):
        raise RuntimeError("Antigravity Gemini API-key accounts require a Gemini model")
    cwd = sup.scratch_dir(org.d["slug"], nid)
    identity = sup.identity_prompt(org, nid)
    servers, _ = sup.antigravity_mcp_grant(org, nid)
    servers = dict(servers)
    servers["orgtree"] = {
        "command": sup.sys.executable, "args": ["-m", "orgtree.mcptool"],
        "env": {**agentauth.child_env(org.d["slug"], nid),
                "ORGTREE_ORG": org.d["slug"], "ORGTREE_NODE": nid,
                "ORGTREE_PORT": env["ORGTREE_PORT"], "PYTHONPATH": sup.BACKEND_DIR,
                deployment.PROFILE_ENV: deployment.current_policy().name},
    }
    sc = n["scope"]
    tools = sc.get("tools", {})
    rights = {"bash": bool(tools.get("bash", True)), "edit": sup._codex_may_write(sc),
              "web": bool(tools.get("web", True)), "subagents": bool(tools.get("subagents", True))}
    if write:
        antigravityrun.write_workspace(cwd, identity=identity, mcp_servers=servers, rights=rights)
        antigravityrun.install_steering(cwd)
    resume = (str(n.get("session_id") or "") if not n.get("session_unrun")
              and n.get("session_id") == n.get("antigravity_conversation") else None)
    log_dir = os.path.join(providers.antigravity_probe_dir(), "logs", org.d["slug"])
    if write:
        os.makedirs(log_dir, exist_ok=True)
    return {"argv_head": providers.antigravity_argv(exe), "cwd": cwd, "model": model,
            "effort": providers.antigravity_effort(n["model"], org.effective_effort(nid)),
            "conversation_id": resume, "env_extra": env, "yolo": True,
            "log_file": os.path.join(log_dir, f"{nid}.log"), "turn_timeout": sup.TURN_TIMEOUT,
            "identity": identity, "servers": servers, "rights": rights,
            "generation": n.get("generation", 1),
            "account": str(row["id"]) if row else sup._cache_antigravity_account_namespace()}


#: PG-3r: what a lineage cut writes besides the seat and its bearer row
#: (mirrors PG-3e-B's `_ASSIGN_SECTIONS` / `_ASSIGN_LOGS` in supervisor.py).
_LINEAGE_SECTIONS = ("asks", "credit_requests", "scope_requests", "notices", "work_items")
_LINEAGE_LOGS = ("events", "notice_log")


def prepare_lineage(org: Any, nid: str, spec: dict[str, Any]) -> bool:
    """Automatic billing-route changes also preserve the old session."""
    from . import supervisor as sup
    n = org.node(nid)
    previous = n.get("antigravity_account") or sup._cache_antigravity_account_namespace()
    if not spec["conversation_id"] or previous == spec["account"]:
        return False
    # PG-3r: the lineage cut is one row transaction over the seat, the
    # `nid@<gen>` bearer row the archive inserts, and what the cut writes
    # besides (asks mooting with the requests and work items it touches,
    # the notice fold, the handoff notice). The same rows as PG-3e-B's
    # account rebind (supervisor._assign_tx); keep the two sets together.
    # The generation is read before the lock and re-checked under it.
    from . import orgtx
    slug = org.d["slug"]
    gen = orgtx.org_read(slug).node(nid).get("generation", 0)
    with orgtx.org_tx(slug, nodes=[nid, f"{nid}@{gen}"], sections=_LINEAGE_SECTIONS,
                      logs=_LINEAGE_LOGS) as tx:
        current = tx.org
        if current.node(nid).get("generation", 0) != gen:
            raise RuntimeError(f"{nid} changed generation while its billing route "
                               f"change was prepared; nothing was changed")
        predecessor, old_sid = current._archive_session_in_place(nid)
        sup.export_predecessor_transcript(current, nid, old_sid=old_sid, reason="account_route")
        current._moot_asks(nid, "the provider billing account changed; its successor starts fresh")
        current._fold_notices(nid)
        current.node(nid).pop("antigravity_conversation", None)
        current.node(nid).pop("antigravity_account", None)
    org.d = current.d
    sup._log_turn_error(org.d["slug"], nid,
        f"Antigravity billing account changed. This session starts fresh; the previous conversation is preserved as {predecessor}.")
    return True


def startup_files(spec: dict[str, Any]) -> dict[str, str]:
    """Content fingerprints for local rules and plugin/hook definitions."""
    cwd = Path(spec["cwd"])
    home = Path(spec["env_extra"].get("USERPROFILE") or spec["env_extra"].get("HOME") or Path.home())
    paths = [cwd / "AGENTS.md", home / ".gemini/GEMINI.md",
             home / ".gemini/antigravity-cli/settings.json"]
    for root in (cwd / ".agents", home / ".agents"):
        if root.is_dir():
            for folder, dirs, files in os.walk(root, followlinks=False):
                dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "__pycache__")]
                paths.extend(Path(folder) / f for f in files
                             if Path(f).suffix in (".md", ".json", ".py", ".cmd", ".sh"))
    manifest = {}
    for path in paths:
        try:
            manifest[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        except FileNotFoundError:
            pass
    return manifest


def process_identity(spec: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """Never publish credentials: all process inputs become component hashes."""
    env = spec["env_extra"]
    raw = {"prompt": [spec["identity"], startup_files(spec)],
           "argv": [spec["argv_head"], spec["model"], spec["effort"], spec["cwd"],
                    spec["servers"], spec["rights"], spec.get("generation")],
           "cred": [spec["account"], env.get("GEMINI_API_KEY", ""), env.get("USERPROFILE", "")],
           "envov": {k: v for k, v in env.items() if not k.startswith("ORGTREE_AGENT_")}}
    parts = {k: hashlib.sha256(json.dumps(v, sort_keys=True).encode()).hexdigest()[:32]
             for k, v in raw.items()}
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:32], parts


def client_args(spec: dict[str, Any]) -> dict[str, Any]:
    return {k: spec[k] for k in ("cwd", "model", "effort", "conversation_id", "env_extra",
                                "yolo", "log_file", "turn_timeout")}
