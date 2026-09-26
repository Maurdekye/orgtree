"""P01 F7 legacy boundary contracts for the org administration routes (org-admin.*).

Disposable SQLite only; the app's lifecycle is not started. Every case builds a fresh org under this test's temporary
data root. Hub, net, sandbox, container and docker calls are spies; the org disk module's command runner (disk._run,
which shells out to WSL) is a recorded fake WSL, and a mounted org disk is a temp folder (disk.windows_path, with
disk.usage and disk.is_mounted answered by spies and disk.subtree_files walking the folder). The routes, the ledger,
the store's create and delete, the defaults file, the workspace files and the host folders the sweep removes are
real. Each case's observation is normalized (one NORM block) and compared with
docs/state-system/org-admin-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (org-admin.*).

This module launches no process. An audit hook installed before anything else is imported refuses and records any
process launch for the whole run (imports, the app's construction, every case), and the module fails at teardown if
one was recorded.
"""
from __future__ import annotations

import sys

# ---- the no-process guard, first: any process launch is refused (before the child exists) and recorded.
# _winapi.CreateProcess is the Windows launch that bypasses subprocess.Popen (multiprocessing's spawn uses it)
LAUNCH_EVENTS = ('subprocess.Popen', '_winapi.CreateProcess', 'os.system', 'os.posix_spawn', 'os.spawn',
                 'os.startfile', 'os.exec')
GUARD = {'on': True}
LAUNCHES: list = []


def _no_process(event, args):
    if GUARD['on'] and event in LAUNCH_EVENTS:
        LAUNCHES.append((event, repr(args)[:200]))
        raise RuntimeError('real process launch refused by the boundary test guard: ' + event)


sys.addaudithook(_no_process)

import copy  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts  # noqa: E402

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-org-admin-boundary-')
_data = Path(_temp) / 'data'
_home = Path(_temp) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: E402,F401  (also drops the running engine's inherited hub address)
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, deployment, disk, ledger, net, sandbox, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'
assert os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1', 'the desktop-managed profile is the app under test'
assert LAUNCHES == [], LAUNCHES      # nothing above (the imports, the app's construction) tried to launch a process

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'legacy_defects', 'scope'}
SEQ = [0]
CUR: dict = {}
DISKS = Path(_temp) / 'disks'
DISKS.mkdir()
LEGACY = Path(_temp) / 'legacy'
LEGACY.mkdir()
EXTRA = Path(_temp) / 'extra-dir'
EXTRA.mkdir()


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/org-admin-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.org-admin-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('org-admin.')}:
        raise ValueError('every org-admin contract is required')
    return d


# ---- NORM (verbatim from the P01 F7 probe's f7/norm.py) ------------------------------------------------------------
def norm(c, cur):
    slugs = sorted({cur["slug"], *cur.get("created", [])}, key=len, reverse=True)

    def text(v):
        if isinstance(v, str):
            for s in slugs:
                v = v.replace(s, "{slug}")
        return v
    born = list(c["born"].values())
    return {
        "status": c["status"],
        "ctype": c["ctype"],
        "keys": c["keys"],
        "detail": text(c["detail"]),
        "sections": c["changed"],
        "orgs": [c["orgs_created"], c["orgs_removed"]],
        "born": born[0] if len(born) == 1 else None,
        "files": {"added": c["files_added"], "removed": c["files_removed"], "changed": c["files_changed"]},
        "spies": dict(sorted((c.get("spies") or {}).items())),
    }


# ---- harness (verbatim from the P01 F7 probe) ------------------------------------------------------------
def fake_wsl(args, timeout=60):
    """disk._run on a machine with a docker-desktop distro and a writable mount root; nothing else succeeds."""
    CUR.setdefault("wsl", []).append(list(args))
    script = args[-1] if args[:1] == ["wsl"] and "-c" in args else ""
    ok = args == ["wsl", "-l", "-q"] or script.startswith("mkdir -p ")
    return subprocess.CompletedProcess(args, 0 if ok else 1, "docker-desktop\n" if args[1:2] == ["-l"] else "", "")


def walk(slug, rel, max_age=15.0):
    """disk.subtree_files over the temp disk folder (the product walks inside the distro)."""
    root = DISKS / slug
    return sorted((p.relative_to(root).as_posix(), p.stat().st_size) for p in (root / rel).rglob("*") if p.is_file())


class DockerOnly:
    """api's view of the subprocess module: docker calls go to a spy, everything else is the real module."""
    def __init__(self, spy):
        self.run = spy

    def __getattr__(self, name):
        return getattr(subprocess, name)


def fresh(kiosk=False):
    SEQ[0] += 1
    org = store.create_org(f"p01-f7-{SEQ[0]}")
    slug = str(org.d["slug"])
    org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
    org.hire("top", "top", "haiku", 6, "mid", **SCOPE)
    org.d["mail"] = {}
    if kiosk:
        org.d["kiosk"] = {"enabled": True, "credits": 0, "spend_limit": 0.0, "storage_limit_mb": 0,
                          "token": "kiosk-token-fixture", "auto_raise": False,
                          "max_scope": {"tools": NO_TOOLS, "add_dirs": [], "org_visibility": "team",
                                        "permission_mode": "acceptEdits"}}
    store.save_org(org)
    CUR["slug"] = slug
    CUR["tokens"] = {n: agentauth.child_env(slug, n)["ORGTREE_AGENT_TOKEN"] for n in ("top", "mid")}


def durable(slug):
    store._invalidate_snapshot(slug)
    store._POOL.close_all(slug)
    try:
        return json.loads(json.dumps(store.load_org(slug).d))
    except ledger.LedgerError:
        return None


def changed(b, a):
    if b is None or a is None:
        return None if b is a else ("<removed>" if a is None else "<created>")
    return sorted(k for k in set(b) | set(a) if b.get(k) != a.get(k))


def slugs():
    return sorted(o["slug"] for o in store.list_orgs())


def files():
    """Data-root files outside the org stores. diagnostics/ is excluded: the slow-request trace
    (diagnostics/slow-requests.jsonl) is written by any request that crosses a latency threshold, i.e. by load."""
    out = {}
    for p in _data.rglob("*"):
        if p.is_file() and p.relative_to(_data).parts[0] not in ("orgs", "diagnostics"):
            rel = p.relative_to(_data).as_posix()
            try:
                out[rel] = p.stat().st_size, p.stat().st_mtime_ns
            except OSError:
                pass
    return out


def norm_path(rel):
    import re
    for s in sorted(set(slugs() + [CUR.get("slug", "")]), key=len, reverse=True):
        if s:
            rel = rel.replace(s, "{slug}")
    return re.sub(r"\d{8}T\d{6}", "{ts}", rel)


class Spies:
    def __enter__(self):
        self.ps, self.s = [], {}

        def add(target, name, **kw):
            p = patch.object(target, name, **kw)
            self.s[name] = p.start()
            self.ps.append(p)
        add(supervisor, "send_message", return_value={"delivered": True})
        add(supervisor, "notify")
        add(supervisor, "maybe_storage_check")
        add(supervisor, "storage_check", return_value=None)
        add(supervisor, "forget_state")
        add(supervisor, "remote_reap")
        add(api, "hub_changed")
        add(api, "mail_notify")
        add(api.hub, "changed", new_callable=AsyncMock)
        add(net, "kick")
        add(net, "unregister_org", return_value={"unregistered": []})
        add(sandbox, "warm")
        add(sandbox, "remove")
        add(sandbox, "stop_container")
        add(sandbox, "try_apply_pending_resize", return_value=CUR.get("resize_note"))
        add(sandbox, "sandbox_volumes_bytes", return_value=0)
        add(sandbox, "sandbox_root", side_effect=lambda slug: str(LEGACY / slug))
        add(sandbox, "container_auth", return_value=None)
        add(disk, "windows_path", side_effect=lambda slug: str(DISKS / slug))
        add(disk, "usage", return_value=(1048576, 4096 * 1048576))
        add(disk, "is_mounted", return_value=CUR.get("mounted", True))
        add(disk, "invalidate")
        add(disk, "grow")
        add(disk, "_run", side_effect=fake_wsl)
        add(disk, "subtree_files", side_effect=walk)
        self.s["docker"] = MagicMock(side_effect=self.docker)
        add(api, "subprocess", new=DockerOnly(self.s["docker"]))
        self.s.pop("subprocess")
        for cache, empty in (("_distro_cache", None), ("_mount_root_cache", None), ("_usage_cache", {}),
                             ("_tree_cache", {})):
            p = patch.object(disk, cache, new=empty)
            p.start()
            self.ps.append(p)
        CUR["wsl"] = []
        return self

    @staticmethod
    def docker(args, **kw):
        class R:
            returncode = 1 if args[:3] == ["docker", "volume", "inspect"] else 0
            stdout = stderr = ""
        return R()

    def calls(self):
        quiet = ("maybe_storage_check", "sandbox_root", "windows_path", "usage", "is_mounted", "container_auth",
                 "sandbox_volumes_bytes", "_run", "subtree_files")
        return {k: len(m.call_args_list) for k, m in self.s.items() if m.call_count and k not in quiet}

    def __exit__(self, *e):
        for p in reversed(self.ps):
            p.stop()


# ---- helpers -----------------------------------------------------------------------------------------------------
def op(method, path, **kw):
    def go(c):
        return c.request(method, path.format(slug=CUR["slug"]), headers=OP, **kw)
    return go


def frozen(req):
    def go(c):
        with patch.object(api.deployment, "current_policy", return_value=deployment.FROZEN):
            loop = TestClient(app, raise_server_exceptions=False, client=("127.0.0.1", 50000))
            return req(loop)
    return go


def standard(req):
    """The request under the standard (not desktop-managed) profile: desktop_policy.validate admits kiosk/sandbox."""
    def go(c):
        saved = os.environ.pop("ORGTREE_DESKTOP_MANAGED")
        try:
            return req(c)
        finally:
            os.environ["ORGTREE_DESKTOP_MANAGED"] = saved
    return go


def then(*steps):
    def go(c):
        for step in steps:
            step(c)
    return go


def defaults(d):
    def go(c):
        (_data / "defaults.json").write_text(json.dumps(d), encoding="utf-8")
    return go


def no_defaults(c):
    try:
        (_data / "defaults.json").unlink()
    except FileNotFoundError:
        pass


def workspace(c):
    org = store.load_org(CUR["slug"])
    Path(org.d["workspace"]).mkdir(parents=True, exist_ok=True)


def no_workspace(c):
    org = store.load_org(CUR["slug"])
    org.d["workspace"] = None
    store.save_org(org)


def fake_disk(pending=None, files_=("home/a.txt", "home/sub/b.txt", "usr/bin/x")):
    def go(c):
        org = store.load_org(CUR["slug"])
        org.d["disk"] = {"size_mb": 8192, **({"pending_size_mb": pending} if pending else {})}
        store.save_org(org)
        root = DISKS / CUR["slug"]
        for f in files_:
            p = root / f
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("x", encoding="utf-8")
    return go


def legacy_dirs(c):
    (LEGACY / CUR["slug"] / "home").mkdir(parents=True, exist_ok=True)
    (LEGACY / CUR["slug"] / "home" / "old.txt").write_text("old", encoding="utf-8")


def disk_listing():
    root = DISKS / CUR["slug"]
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()) if root.exists() else None


def legacy_state():
    return {"legacy": (LEGACY / CUR["slug"]).exists(),
            "workspace": os.path.isdir(store.workspace_dir(CUR["slug"])),
            "scratch": os.path.isdir(store.scratch_root(CUR["slug"]))}


def add_extra_dir(c):
    org = store.load_org(CUR["slug"])
    org.d["dirs"] = list(org.d["dirs"]) + [{"path": str(EXTRA), "mode": "rw"}]
    org.nodes["mid"]["scope"]["add_dirs"] = [{"path": str(EXTRA), "mode": "rw"}]
    store.save_org(org)


def fable_lock(c):
    import time
    org = store.load_org(CUR["slug"])
    org.d["fable_lock"] = {"at": "2026-09-25T00:00:00Z", "reason": "fixture", "until_ts": time.time() + 3600}
    org.nodes["mid"]["limit_locked"] = True
    store.save_org(org)


def lenient_policies(c):
    org = store.load_org(CUR["slug"])
    org.d["fable_limit_policy"] = "opus"
    org.d["fable_filter_policy"] = "opus"
    store.save_org(org)


def spool(c):
    org = store.load_org(CUR["slug"])
    org.d["net_hubs"] = [{"id": "old1", "address": "http://10.0.0.1:7370", "enabled": True}]
    org.d["net_spool"] = {"old1": [{"id": "m1"}]}
    store.save_org(org)


def env(**kw):
    return kw


S = "/api/orgs/{slug}/settings"
CASES = [
    # create
    ("create", op("POST", "/api/orgs", json={"name": "p01-f7-born"}), no_defaults, False,
     env(born_watch=("net_autoconnect", "net_hubs", "kiosk", "sandbox", "default_top_grant"))),
    ("create_defaults", op("POST", "/api/orgs", json={"name": "p01-f7-born-d"}),
     defaults({"compact_at": 0.7, "net_hub_address": "http://10.9.9.9:7370", "prefer_reserve": False}), False,
     env(born_watch=("compact_at", "net_hub_address", "prefer_reserve", "net_hubs"))),
    ("create_no_autoconnect", op("POST", "/api/orgs", json={"name": "p01-f7-born-n", "net_autoconnect": False,
                                                            "net_hubs": ["10.1.1.1"]}), no_defaults, False,
     env(born_watch=("net_autoconnect", "net_hubs"))),
    ("create_kiosk", op("POST", "/api/orgs", json={"name": "p01-f7-born-k", "kiosk": {"sandbox": False}}),
     no_defaults, False, env(born_watch=("default_top_grant", "net_identity", "net_hubs"))),
    ("create_kiosk_bad_scope", op("POST", "/api/orgs", json={"name": "p01-f7-born-kb",
                                                             "kiosk": {"sandbox": False, "max_scope": {"tools": 7}}}),
     no_defaults, False, None),
    ("create_kiosk_small_disk", op("POST", "/api/orgs", json={"name": "p01-f7-born-ks",
                                                              "kiosk": {"sandbox": True, "storage_limit_mb": 1024}}),
     no_defaults, False, None),
    ("create_sandbox", op("POST", "/api/orgs", json={"name": "p01-f7-born-s", "sandbox": True, "disk_mb": 4096}),
     no_defaults, False, env(born_watch=("net_autoconnect",))),
    ("create_sandbox_small", op("POST", "/api/orgs", json={"name": "p01-f7-born-ss", "sandbox": True,
                                                           "disk_mb": 1024}), no_defaults, False, None),
    ("create_kiosk_std", standard(op("POST", "/api/orgs", json={"name": "p01-f7-born-k2", "kiosk": {"sandbox": False}})),
     no_defaults, False, env(born_watch=("default_top_grant", "net_identity", "net_hubs"))),
    ("create_kiosk_sandbox_std", standard(op("POST", "/api/orgs", json={"name": "p01-f7-born-k3", "kiosk": {}})),
     no_defaults, False, env(born_watch=("default_top_grant",))),
    ("create_kiosk_bad_scope_std", standard(op("POST", "/api/orgs", json={
        "name": "p01-f7-born-kb2", "kiosk": {"sandbox": False, "max_scope": {"tools": 7}}})), no_defaults, False, None),
    ("create_kiosk_small_disk_std", standard(op("POST", "/api/orgs", json={
        "name": "p01-f7-born-ks2", "kiosk": {"sandbox": True, "storage_limit_mb": 1024}})), no_defaults, False, None),
    ("create_sandbox_std", standard(op("POST", "/api/orgs", json={"name": "p01-f7-born-s2", "sandbox": True,
                                                                  "disk_mb": 4096})), no_defaults, False,
     env(born_watch=("net_autoconnect",))),
    ("create_sandbox_small_std", standard(op("POST", "/api/orgs", json={"name": "p01-f7-born-ss2", "sandbox": True,
                                                                        "disk_mb": 1024})), no_defaults, False, None),
    ("create_duplicate", op("POST", "/api/orgs", json={"name": "p01-f7-dup"}),
     then(no_defaults, op("POST", "/api/orgs", json={"name": "p01-f7-dup"})), False, None),
    ("create_bad_name", op("POST", "/api/orgs", json={"name": ""}), no_defaults, False, None),
    ("create_frozen_unsandboxed", frozen(op("POST", "/api/orgs", json={"name": "p01-f7-born-f"})), no_defaults,
     False, None),
    # delete
    ("delete", op("DELETE", "/api/orgs/{slug}"), None, False, None),
    ("delete_missing", op("DELETE", "/api/orgs/nope-org"), None, False, None),
    ("delete_twice", op("DELETE", "/api/orgs/{slug}"), op("DELETE", "/api/orgs/{slug}"), False, None),
    # bridge credential rotate
    ("rotate_standard", op("POST", "/api/orgs/{slug}/bridge-credential/rotate"), None, False, None),
    ("rotate_frozen", frozen(op("POST", "/api/orgs/{slug}/bridge-credential/rotate")), None, False, None),
    ("rotate_frozen_no_org", frozen(op("POST", "/api/orgs/nope-org/bridge-credential/rotate")), None, False, None),
    # settings
    ("settings_caps", op("POST", S, json={"max_top_grant": 10, "default_top_grant": 3, "compact_at": 99}), None,
     False, env(watch=("max_top_grant", "default_top_grant", "compact_at"))),
    ("settings_refused_after_edits", op("POST", S, json={"max_top_grant": 10, "compact_at": 60,
                                                        "fable_filter_model": "fable"}), None, False,
     env(watch=("max_top_grant", "compact_at"))),
    ("settings_unknown_model", op("POST", S, json={"fable_filter_model": "no-such-tier"}), None, False, None),
    ("settings_org_dirs_remove", op("POST", S, json={"org_dirs": []}), add_extra_dir, False, env(watch=("dirs",))),
    ("settings_org_dirs_bad", op("POST", S, json={"org_dirs": [None]}), None, False, None),
    ("settings_refused_after_revoke", op("POST", S, json={"org_dirs": [], "fable_filter_model": "fable"}),
     add_extra_dir, False, env(watch=("dirs",))),
    ("settings_clear_fable_lock", op("POST", S, json={"clear_fable_lock": True}), fable_lock, False,
     env(watch=("fable_lock",))),
    ("settings_refused_after_lock_clear", op("POST", S, json={"clear_fable_lock": True,
                                                             "fable_filter_model": "fable"}), fable_lock, False,
     env(watch=("fable_lock",))),
    ("settings_headless_lenient", op("POST", S, json={"headless": True}), lenient_policies, False,
     env(watch=("headless", "auto_resume"))),
    ("settings_hire_defaults", op("POST", S, json={"default_visibility": "subtree", "default_effort": "low"}), None,
     False, env(watch=("default_visibility", "default_effort"))),
    ("settings_headless", op("POST", S, json={"headless": True}), None, False,
     env(watch=("headless", "auto_resume"))),
    ("settings_headless_kiosk", op("POST", S, json={"headless": True}), None, True, None),
    ("settings_net_hubs", op("POST", S, json={"net_hubs": [{"address": "10.2.2.2"}]}), spool, False,
     env(watch=("net_hubs", "net_spool", "net_autoconnect"))),
    ("settings_net_hubs_bad", op("POST", S, json={"net_hubs": ["nope"]}), None, False, None),
    ("settings_net_kiosk", op("POST", S, json={"net_autoconnect": True}), None, True, None),
    ("settings_empty", op("POST", S, json={}), None, False, None),
    ("settings_no_org", op("POST", "/api/orgs/nope-org/settings", json={}), None, False, None),
    # hire defaults
    ("defaults", op("POST", "/api/orgs/{slug}/defaults", json={"default_visibility": "subtree"}), None, False, None),
    ("defaults_bad", op("POST", "/api/orgs/{slug}/defaults", json={"default_visibility": "bogus"}), None, False,
     None),
    ("defaults_no_org", op("POST", "/api/orgs/nope-org/defaults", json={}), None, False, None),
    # org.md
    ("orgmd_put", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "# charter"}), None, False, None),
    ("orgmd_put_unicode", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "é" * 10}), None, False, None),
    ("orgmd_put_long", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "x" * 70000}), None, False, None),
    ("orgmd_put_no_workspace", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "x"}), no_workspace, False,
     None),
    ("orgmd_put_no_org", op("PUT", "/api/orgs/nope-org/orgmd", json={"content": "x"}), None, False, None),
    # disk
    ("disk_delete_none", op("POST", "/api/orgs/{slug}/disk/delete", json={"paths": ["home/a.txt"]}), None, False,
     None),
    ("disk_delete", op("POST", "/api/orgs/{slug}/disk/delete",
                       json={"paths": ["home/a.txt", "usr/bin/x", "../x", "home/sub", "home/none"]}),
     fake_disk(), False, env(extra_fn=disk_listing)),
    ("disk_resize_none", op("POST", "/api/orgs/{slug}/disk/resize", json={"size_mb": 9000}), None, False, None),
    ("disk_resize_grow", op("POST", "/api/orgs/{slug}/disk/resize", json={"size_mb": 9000}), fake_disk(5000),
     False, env(watch=("disk",))),
    ("disk_resize_shrink", op("POST", "/api/orgs/{slug}/disk/resize", json={"size_mb": 5000}), fake_disk(), False,
     env(watch=("disk",))),
    ("disk_resize_floor", op("POST", "/api/orgs/{slug}/disk/resize", json={"size_mb": 1000}), fake_disk(), False,
     None),
    ("disk_resize_same", op("POST", "/api/orgs/{slug}/disk/resize", json={"size_mb": 8192}), fake_disk(5000),
     False, env(watch=("disk",))),
    ("disk_resize_cancel", op("POST", "/api/orgs/{slug}/disk/resize", json={"cancel": True}), fake_disk(5000),
     False, env(watch=("disk",))),
    ("disk_resize_missing", op("POST", "/api/orgs/{slug}/disk/resize", json={}), fake_disk(), False, None),
    ("disk_apply_none_pending", op("POST", "/api/orgs/{slug}/disk/resize/apply"), fake_disk(), False, None),
    ("disk_apply", op("POST", "/api/orgs/{slug}/disk/resize/apply"), fake_disk(5000), False, env(watch=("disk",))),
    ("disk_apply_kept", op("POST", "/api/orgs/{slug}/disk/resize/apply"), fake_disk(5000), False,
     env(resize_note="free 10 MB first")),
    ("disk_apply_no_disk", op("POST", "/api/orgs/{slug}/disk/resize/apply"), None, False, None),
    # the legacy sweep
    ("sweep_preview_unmounted", op("GET", "/api/orgs/{slug}/sweep-legacy"), fake_disk(), False,
     env(mounted=False)),
    ("sweep_preview", op("GET", "/api/orgs/{slug}/sweep-legacy"), then(fake_disk(), legacy_dirs), False, None),
    ("sweep_unmounted", op("POST", "/api/orgs/{slug}/sweep-legacy"), then(fake_disk(), legacy_dirs), False,
     env(mounted=False, extra_fn=legacy_state)),
    ("sweep", op("POST", "/api/orgs/{slug}/sweep-legacy"), then(fake_disk(), legacy_dirs, workspace), False,
     env(extra_fn=legacy_state)),
    ("sweep_no_disk", op("POST", "/api/orgs/{slug}/sweep-legacy"), None, False, None),
    # the gate
    ("agent_token", lambda c: c.post(f"/api/orgs/{CUR['slug']}/settings", json={},
                                     headers={"X-Orgtree-Agent-Token": CUR["tokens"]["mid"]}), None, False, None),
]


CASES = {n: (r, p, k, e) for n, r, p, k, e in CASES}


def observe(name):
    """Run one fixtured case on a fresh org and return its normalized observation, the body and the case record."""
    request, pre, kiosk, e = CASES[name]
    fresh(kiosk)
    CUR.update(e or {})
    client = TestClient(app, raise_server_exceptions=False)
    try:
        with Spies() as sp:
            if pre:
                pre(client)
                for m in sp.s.values():
                    m.reset_mock()
                CUR['wsl'].clear()
            b, bs, bf = durable(CUR['slug']), slugs(), files()
            r = request(client)
            a, as_, af = durable(CUR['slug']), slugs(), files()
            ctype = r.headers.get('content-type', '')
            body = r.json() if 'json' in ctype else None
            created = sorted(set(as_) - set(bs))
            raw = {'status': r.status_code, 'ctype': ctype.split(';')[0],
                   'keys': sorted(body) if isinstance(body, dict) else ('list' if isinstance(body, list) else None),
                   'detail': body.get('detail') if isinstance(body, dict) else None,
                   'changed': changed(b, a),
                   'orgs_created': len(created), 'orgs_removed': len(set(bs) - set(as_)),
                   'born': {s: sorted((durable(s) or {}).keys()) for s in created},
                   'files_added': sorted(norm_path(p) for p in set(af) - set(bf)),
                   'files_removed': sorted(norm_path(p) for p in set(bf) - set(af)),
                   'files_changed': sorted(norm_path(p) for p in set(af) & set(bf) if af[p] != bf[p]),
                   'spies': sp.calls()}
            cur = {'slug': CUR['slug'], 'created': created, 'wsl': list(CUR['wsl']),
                   'doc_after': {k: a.get(k) for k in CUR.get('watch', ())} if a else None,
                   'born_doc': {k: (durable(created[0]) or {}).get(k) for k in CUR.get('born_watch', ())}
                   if len(created) == 1 else None,
                   'extra': CUR['extra_fn']() if CUR.get('extra_fn') else None}
            return norm(raw, cur), body, cur
    finally:
        for k in ('watch', 'born_watch', 'mounted', 'resize_note', 'extra_fn'):
            CUR.pop(k, None)


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 11)
        self.assertEqual(set(spec['cases']), set(CASES))
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry['facets']['org-admin.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)
        modes = {k: c['domain_mode'] for k, c in registry['contracts'].items() if k.startswith('org-admin.')}
        self.assertEqual({k for k, m in modes.items() if m != 'write'}, {'org-admin.sweep-preview'})

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('org-admin.settings'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_every_entry_selects_exactly_its_contract_and_is_mapped(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        entries = {r['id']: r for r in registry['entries']}
        bound = {}
        for name, c in registry['contracts'].items():
            if name.startswith('org-admin.'):
                for e in c['entry_ids']:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 11)
        for e, names in bound.items():
            self.assertEqual((entries[e]['disposition'], entries[e]['contracts']), ('mapped', names))


class OrgAdminBoundary(unittest.TestCase):
    def setUp(self):
        self.spec = boundary()

    def check(self, *names):
        out = {}
        for name in names:
            with self.subTest(case=name):
                seen, body, cur = observe(name)
                self.assertEqual(seen, self.spec['cases'][name], name)
                out[name] = (seen, body, cur)
        return out

    def test_create_and_the_org_it_is_born_as(self):
        got = self.check('create', 'create_defaults', 'create_no_autoconnect', 'create_kiosk_std',
                         'create_kiosk_sandbox_std', 'create_sandbox_std', 'create_kiosk_bad_scope_std',
                         'create_kiosk_small_disk_std', 'create_sandbox_small_std', 'create_kiosk',
                         'create_kiosk_bad_scope', 'create_kiosk_small_disk', 'create_sandbox', 'create_sandbox_small',
                         'create_duplicate', 'create_bad_name', 'create_frozen_unsandboxed')
        born = got['create'][2]['born_doc']
        # a throwaway data root never points a new org at the operator's real hub
        self.assertEqual((born['net_autoconnect'], born['net_hubs'], born['kiosk'], born['default_top_grant']),
                         (True, [{'id': 'local', 'address': net.UNROUTABLE_HUB_ADDRESS, 'enabled': True}], None, 50))
        # the global defaults are written into the org, except the two that are not org settings
        d = got['create_defaults'][2]['born_doc']
        self.assertEqual((d['compact_at'], d['net_hub_address'], d['prefer_reserve'], d['net_hubs'][0]['address']),
                         (0.7, None, None, 'http://10.9.9.9:7370'))
        n = got['create_no_autoconnect'][2]['born_doc']
        self.assertEqual((n['net_autoconnect'], [h['address'] for h in n['net_hubs']]), (False, ['10.1.1.1']))
        k = got['create_kiosk_std'][2]['born_doc']
        self.assertEqual((k['default_top_grant'], k['net_identity'], k['net_hubs']), (0, None, None))
        # the kiosk whose ceiling cannot be normalized is refused BEFORE its one creating save (PG-3f: the org is
        # born whole in create_org's prepare hook): no store is written, so nothing is renamed away or unregistered
        refused = got['create_kiosk_bad_scope_std'][0]
        self.assertEqual((refused['status'], refused['orgs'], refused['spies']), (422, [0, 0], {}))
        self.assertEqual(refused['files'], {'added': [], 'removed': [], 'changed': []})
        for name in ('create_kiosk', 'create_sandbox'):
            self.assertTrue(got[name][0]['detail'].startswith('Not available in desktop MVP: '))

    def test_delete_renames_the_store_away_and_tears_down_its_runtime(self):
        got = self.check('delete', 'delete_missing', 'delete_twice')
        self.assertEqual(got['delete'][0]['files']['added'], ['deleted/{slug}-{ts}.db'])
        self.assertEqual(got['delete'][1], {'ok': True, 'net': {'unregistered': []}})

    def test_the_bridge_rotation_per_deployment_profile(self):
        self.check('rotate_standard', 'rotate_frozen', 'rotate_frozen_no_org')

    def test_settings_write_what_they_name_and_a_refusal_writes_nothing(self):
        got = self.check('settings_caps', 'settings_refused_after_edits', 'settings_unknown_model',
                         'settings_org_dirs_remove', 'settings_org_dirs_bad', 'settings_refused_after_revoke',
                         'settings_clear_fable_lock', 'settings_refused_after_lock_clear', 'settings_headless_lenient',
                         'settings_hire_defaults', 'settings_headless', 'settings_headless_kiosk', 'settings_net_hubs',
                         'settings_net_hubs_bad', 'settings_net_kiosk', 'settings_empty', 'settings_no_org')
        self.assertEqual(got['settings_caps'][2]['doc_after'],
                         {'max_top_grant': 10, 'default_top_grant': 3, 'compact_at': 0.95})   # 99 clamps to 95
        # applied to the cached document, then refused: the lock release discards all of it
        refused = got['settings_refused_after_edits'][2]['doc_after']
        self.assertNotEqual((refused['max_top_grant'], refused['compact_at']), (10, 0.6))
        self.assertIn(str(EXTRA), [x['path'] for x in got['settings_refused_after_revoke'][2]['doc_after']['dirs']])
        self.assertIsNotNone(got['settings_refused_after_lock_clear'][2]['doc_after']['fable_lock'])
        self.assertNotIn(str(EXTRA), [x['path'] for x in got['settings_org_dirs_remove'][2]['doc_after']['dirs']])
        self.assertIsNone(got['settings_clear_fable_lock'][2]['doc_after']['fable_lock'])
        self.assertEqual(got['settings_headless_lenient'][2]['doc_after'], {'headless': True, 'auto_resume': True})
        hubs = got['settings_net_hubs'][2]['doc_after']
        self.assertEqual((hubs['net_autoconnect'], hubs['net_spool']), (False, {hubs['net_hubs'][0]['id']: [{'id': 'm1'}]}))

    def test_hire_defaults_and_the_orgmd_write(self):
        got = self.check('defaults', 'defaults_bad', 'defaults_no_org', 'orgmd_put', 'orgmd_put_unicode',
                         'orgmd_put_long', 'orgmd_put_no_workspace', 'orgmd_put_no_org')
        self.assertEqual(Path(got['orgmd_put'][1]['path']).read_text(encoding='utf-8'), '# charter')
        # recorded legacy defect: `bytes` is the character count
        u = got['orgmd_put_unicode'][1]
        self.assertEqual((u['bytes'], u['chars'], len(('é' * 10).encode('utf-8'))), (10, 10, 20))
        long_ = got['orgmd_put_long'][1]
        self.assertEqual((long_['chars'], long_['prompt_truncated'], len(long_['warnings'])), (70000, True, 1))

    def test_the_disk_routes(self):
        got = self.check('disk_delete_none', 'disk_delete', 'disk_resize_none', 'disk_resize_grow',
                         'disk_resize_shrink', 'disk_resize_floor', 'disk_resize_same', 'disk_resize_cancel',
                         'disk_resize_missing', 'disk_apply_none_pending', 'disk_apply', 'disk_apply_kept',
                         'disk_apply_no_disk')
        results = {x['path']: x for x in got['disk_delete'][1]['results']}
        self.assertEqual([results[p]['ok'] for p in ('home/a.txt', 'usr/bin/x', '../x', 'home/sub', 'home/none')],
                         [True, False, False, True, False])
        self.assertEqual((results['usr/bin/x']['error'], results['../x']['error']),
                         ('system seed — the image\'s own files', 'path escapes the org disk'))
        self.assertEqual(got['disk_delete'][2]['extra'], ['usr/bin/x'])        # what is left on the disk
        # recorded legacy defect: the raw OSError text carries the host path (quoted by repr, the temp root's name in it)
        self.assertIn(Path(_temp).name, results['home/none']['error'])
        self.assertTrue(results['home/none']['error'].startswith('[WinError 2]' if os.name == 'nt' else '[Errno 2]'))
        self.assertEqual([got[n][2]['doc_after'] for n in ('disk_resize_grow', 'disk_resize_shrink', 'disk_resize_same',
                                                           'disk_resize_cancel')],
                         [{'disk': {'size_mb': 9000}}, {'disk': {'size_mb': 8192, 'pending_size_mb': 5000}},
                          {'disk': {'size_mb': 8192}}, {'disk': {'size_mb': 8192}}])

    def test_the_legacy_sweep_deletes_the_host_workspace(self):
        got = self.check('sweep_preview_unmounted', 'sweep_preview', 'sweep_unmounted', 'sweep', 'sweep_no_disk')
        self.assertEqual(got['sweep'][2]['extra'], {'legacy': False, 'workspace': False, 'scratch': False})
        self.assertEqual(got['sweep_unmounted'][2]['extra'], {'legacy': True, 'workspace': True, 'scratch': False})
        self.assertEqual((got['sweep_preview'][1]['volumes'], len(got['sweep_preview'][1]['host_dirs'])), ([], 2))

    def test_an_agent_credential_is_refused(self):
        self.check('agent_token')


class NoProcess(unittest.TestCase):
    def test_the_guard_refuses_a_real_launch_before_it_happens(self):
        before = len(LAUNCHES)
        self.assertTrue(GUARD['on'])         # on for the whole module, never switched off
        with self.assertRaises(RuntimeError):
            subprocess.run([sys.executable, '-c', 'raise SystemExit(7)'], capture_output=True)
        self.assertEqual([e for e, _ in LAUNCHES[before:]], ['subprocess.Popen'])
        del LAUNCHES[before:]

    @unittest.skipUnless(os.name == 'nt', 'the Windows launch path')
    def test_the_guard_refuses_a_multiprocessing_spawn_child(self):
        import multiprocessing
        before = len(LAUNCHES)
        with self.assertRaises(RuntimeError):
            multiprocessing.get_context('spawn').Process(target=os.getpid).start()
        self.assertEqual([e for e, _ in LAUNCHES[before:]], ['_winapi.CreateProcess'])
        del LAUNCHES[before:]


def tearDownModule():
    # a launch the product caught and swallowed fails no case; it still fails the module. The hook cannot be
    # removed, so it is switched off here: a single-process discover run's later modules do not inherit it.
    try:
        assert LAUNCHES == [], LAUNCHES
    finally:
        GUARD['on'] = False


if __name__ == '__main__':
    unittest.main()
