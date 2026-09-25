"""P01 F8 legacy boundary contracts for the git workspace routes (git-workspace.*).

Disposable SQLite and disposable git repositories only; the app's lifecycle is not started. Every case builds a fresh
org and a fresh repository set inside this test's temporary root: a working clone with a linked worktree and a LOCAL
bare remote. The routes run REAL git, confined by the coordinator's ruling (decision 1 on
p01-f8-contracts-for-the-git-workspace-routes-21):
- an audit hook installed before anything else is imported allows a process launch only when it is `git`, its cwd is
  inside the temp root, its environment is the isolated one below, and no argument carries a URL scheme; it refuses
  and records anything else, records every launch, and the module fails at teardown if anything was refused or if
  the cases ran without a single git launch being seen;
- every git launch runs with GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL, HOME and USERPROFILE inside the root, an empty
  GIT_ASKPASS, and a global config with no credential helper and an empty hooks directory, so the user's system and
  global config, credential manager and hooks never run. The hook sees only Python's own launches, not git's child
  processes: the isolated configuration is what covers those;
- GIT_CEILING_DIRECTORIES is the temp root's PARENT, so git run in a folder that is not a repository (register's
  refusal, discover over plain folders, or the root itself) stops searching upward at the root instead of finding an
  enclosing repository outside it. The parent, not the root: git never applies a ceiling to its own starting folder,
  so a ceiling AT the root would not stop a search that starts at the root. Controls show both behaviours with this
  git, with ceilings given in the same path form.
The standard profile is gitapi.router served on its own app, as orgtree.api mounts it. The desktop profile is the real
load_app app, whose desktop_policy.install_routes is meant to strip every /git/ route but keeps the router (recorded
legacy defect, docket the-desktop-app-still-serves-the-git-workspace-r). Each case's observation is normalized (one
NORM block) and compared with docs/state-system/git-workspace-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (git-workspace.*). Pins that depend on git's output format say so; the
fixture records the git version they were taken with.
"""
from __future__ import annotations

import sys

# ---- the confined-git guard, first ---------------------------------------------------------------------------------
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import shlex  # noqa: E402
import tempfile  # noqa: E402

_temp = Path(tempfile.mkdtemp(prefix="p01-git-workspace-boundary-")).resolve()
LAUNCH_EVENTS = ("subprocess.Popen", "_winapi.CreateProcess", "os.system", "os.posix_spawn", "os.spawn",
                 "os.startfile", "os.exec")
GUARD = {"on": True}
LAUNCHES: list = []      # every Popen: (allowed, program, cwd, argv tail)
REFUSED: list = []
CASE_RUNS = {"cases": 0, "git": 0}     # fixtured cases run and the allowed git launches they made (never pruned)


def _inside(path) -> bool:
    try:
        return Path(str(path)).resolve().is_relative_to(_temp)
    except (OSError, ValueError):
        return False


def _isolated(env) -> bool:
    env = env if env is not None else os.environ
    return (env.get("GIT_CONFIG_NOSYSTEM") == "1" and _inside(env.get("GIT_CONFIG_GLOBAL", ""))
            and _inside(env.get("HOME", "")) and _inside(env.get("USERPROFILE", "")) and env.get("GIT_ASKPASS") == ""
            and _ceiling(env))


def _ceiling(env) -> bool:
    # git searches upward from a non-repository cwd and stops before entering a ceiling, but never treats its own
    # starting folder as one. The root's parent must be a ceiling (so a search from anywhere in the root, the root
    # included, stops at the root); any further entry must be inside the root, where it only stops a search sooner
    # (an empty entry only changes symlink handling in git and is skipped here)
    dirs = [d for d in env.get("GIT_CEILING_DIRECTORIES", "").split(os.pathsep) if d]
    return any(_is_parent(d) for d in dirs) and all(_is_parent(d) or _inside(d) for d in dirs)


def _is_parent(path) -> bool:
    try:
        return Path(str(path)).resolve() == _temp.parent
    except (OSError, ValueError):
        return False


def _guard(event, args):
    if not GUARD["on"] or event not in LAUNCH_EVENTS:
        return
    if event == "subprocess.Popen":
        executable, argv, cwd, env = args
        # on Windows the audit event carries the command line already flattened to ONE string (list2cmdline)
        if isinstance(argv, bytes):
            argv = argv.decode("utf-8", "replace")
        argv = [a.strip('"') for a in shlex.split(argv, posix=False)] if isinstance(argv, str) else list(argv or [])
        prog = os.path.basename(str(executable or (argv[0] if argv else ""))).lower()
        ok = prog in ("git", "git.exe") and cwd is not None and _inside(cwd) and _isolated(env) \
            and not any("://" in str(a) for a in argv)
        LAUNCHES.append((ok, prog, str(cwd), [str(a) for a in argv[1:]][:24]))
        if ok:
            GUARD["paired"] = True        # the CreateProcess event that follows this Popen belongs to it
            return
    elif event == "_winapi.CreateProcess" and GUARD.pop("paired", False):
        # on Windows every subprocess.Popen is followed by this event, whose arguments carry no command line (measured:
        # (None, '\x02', None)); it is allowed only as the partner of an allowed Popen just before it. A CreateProcess
        # with no allowed Popen before it (multiprocessing's spawn) is refused.
        return
    GUARD.pop("paired", None)
    REFUSED.append((event, repr(args)[:300]))
    raise RuntimeError("process launch refused by the F8 confined-git guard: " + event)


sys.addaudithook(_guard)

# ---- the isolated git environment ----------------------------------------------------------------------------------
_data, _home = _temp / "data", _temp / "home"
_data.mkdir()
_home.mkdir()
NOHOOKS = _temp / "nohooks"
NOHOOKS.mkdir()
GITCONFIG = _temp / "gitconfig"
GITCONFIG.write_text("[user]\n\tname = P01 Probe\n\temail = p01-probe@example.invalid\n"
                     "[credential]\n\thelper =\n[core]\n\thooksPath = " + NOHOOKS.as_posix() + "\n\tautocrlf = false\n"
                     "[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n", encoding="utf-8")
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN="operator", ORGTREE_STORE_BACKEND="sqlite",
                  GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=str(GITCONFIG), GIT_ASKPASS="", GIT_TERMINAL_PROMPT="0",
                  GIT_CEILING_DIRECTORIES=str(_temp.parent))
for _k in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG",
           "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
           "GIT_NAMESPACE", "SSH_ASKPASS"):
    os.environ.pop(_k, None)

from collections import Counter  # noqa: E402
import copy  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import unittest  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import state_operation_contracts as contracts  # noqa: E402
import import_provenance  # noqa: E402,F401  (also drops the running engine's inherited hub address)
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, gitapi, gitworkspace as gw, ledger, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), "this process would have written to the live root"
assert os.environ.get("ORGTREE_DESKTOP_MANAGED") == "1", "the desktop-managed profile is the app under test"
assert REFUSED == [] and all(ok for ok, *_ in LAUNCHES), (REFUSED, LAUNCHES)   # imports and app build launched nothing
STD = FastAPI()
STD.include_router(gitapi.router)      # the standard profile: the router as orgtree.api mounts it
OP = {"X-Orgtree-Desktop-Token": "operator"}
FIELDS = {"schema", "source_contract_sha256", "qualification", "contracts", "git", "cases", "legacy_defects", "scope"}
SEQ = [0]
CUR: dict = {}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / "docs/state-system/git-workspace-boundary.json")
    registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
    if set(d) != FIELDS:
        raise ValueError("boundary fields")
    if d["schema"] != "orgtree.git-workspace-boundary/v1":
        raise ValueError("boundary schema")
    if d["source_contract_sha256"] != contracts.digest(registry):
        raise ValueError("stale boundary binding")
    if set(d["qualification"]) != set(contracts.GATES) or any(v is not False for v in d["qualification"].values()):
        raise ValueError("boundary cannot qualify conversion")
    if set(d["contracts"]) != {k for k in registry["contracts"] if k.startswith("git-workspace.")}:
        raise ValueError("every git-workspace contract is required")
    return d


# ---- NORM (verbatim from the P01 F8 probe's f8/norm.py) ------------------------------------------------------------
def norm(c, cur):
    def text(v):
        if not isinstance(v, str):
            return v
        v = re.sub(r"[A-Za-z]:[\\/][^'\"\s)]*", "<path>", v)
        return v.replace(cur["slug"], "{slug}")
    return {
        "status": c["status"],
        "keys": c["keys"],
        "detail": text(c["detail"]),
        "org_changed": c["org_changed"],
        "registry_changed": c["settings_changed"],
        "remote_refs_moved": c["remote_moved"],
        "repo_refs_moved": c["repo_refs_moved"],
        "git": dict(sorted(Counter(c["git"]).items())),
    }


# ---- harness (verbatim from the P01 F8 probe) ------------------------------------------------------------
def sh(cwd, *args):
    r = subprocess.run(["git", *args], cwd=str(cwd), env=os.environ.copy(), capture_output=True, text=True)
    assert r.returncode == 0, (args, r.stderr)
    return r.stdout.strip()


def fresh():
    SEQ[0] += 1
    n = SEQ[0]
    org = store.create_org(f"p01-f8-{n}")
    slug = str(org.d["slug"])
    org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
    base = _temp / f"r{n}"
    base.mkdir()
    remote, repo, wt, other = base / "remote.git", base / "repo", base / "wt", base / "other"
    sh(base, "init", "--bare", "-b", "main", str(remote))
    sh(base, "init", "-b", "main", str(repo))
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    sh(repo, "add", "a.txt")
    sh(repo, "commit", "-m", "first")
    sh(repo, "remote", "add", "origin", str(remote))
    sh(repo, "push", "-u", "origin", "main")
    sh(repo, "worktree", "add", "-b", "feature", str(wt))
    org.d["dirs"] = list(org.d["dirs"]) + [{"path": str(base), "mode": "rw"}]
    org.d["work_items"] = [{"slug": "f8-item", "title": "F8 fixture item", "status": "open",
                            "owner": {"node": "top", "generation": 0}}]
    store.save_org(org)
    try:
        os.unlink(os.path.join(store.DATA_ROOT, "git-workspace.json"))
    except FileNotFoundError:
        pass
    CUR.update(slug=slug, base=base, remote=remote, repo=repo, wt=wt, other=other, rid=None, n=n)
    CUR["token"] = agentauth.child_env(slug, "top")["ORGTREE_AGENT_TOKEN"]


def settings_doc():
    p = Path(store.DATA_ROOT) / "git-workspace.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def durable(slug):
    store._invalidate_snapshot(slug)
    store._POOL.close_all(slug)
    try:
        return json.loads(json.dumps(store.load_org(slug).d))
    except ledger.LedgerError:
        return None


def changed(b, a):
    if b is None or a is None:
        return None
    return sorted(k for k in set(b) | set(a) if b.get(k) != a.get(k))


def refs_of(path):
    return sh(path, "for-each-ref", "--format=%(refname) %(objectname)")


def subcommands(since, until=None):
    """The git subcommand of each launch in [since, until): the product's own calls, not the harness's."""
    out = []
    for ok, prog, cwd, argv in LAUNCHES[since:until]:
        rest = [a for a in argv if a not in ("--no-pager",)]
        i = 0
        while i < len(rest) and rest[i] == "-c":
            i += 2
        out.append((rest[i] if i < len(rest) else "") if ok else "REFUSED:" + prog)
    return out


# ---- setup steps ---------------------------------------------------------------------------------------------------
def std(method, path, **kw):
    def go(c_std, c_real):
        return c_std.request(method, path.format(**{k: CUR.get(k) for k in ("slug", "rid", "wid")}), headers=OP, **kw)
    return go


def real(method, path, **kw):
    def go(c_std, c_real):
        return c_real.request(method, path.format(slug=CUR["slug"], rid=CUR.get("rid") or "x"), headers=OP, **kw)
    return go


def registered(c_std, c_real):
    r = c_std.post(f"/api/orgs/{CUR['slug']}/git/repositories", json={"path": str(CUR["repo"])})
    assert r.status_code == 200, r.text
    CUR["rid"] = r.json()["id"]


def settings_saved(c_std, c_real):
    registered(c_std, c_real)
    rev = c_std.get(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/settings").json()["revision"]
    r = c_std.patch(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/settings",
                    json={"revision": rev, "values": {"remote": "origin", "trunk": "refs/heads/main"}})
    assert r.status_code == 200, r.text


def with_wid(c_std, c_real):
    settings_saved(c_std, c_real)
    inv = c_std.get(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/inventory").json()
    CUR["wid"] = next(w["id"] for w in gw.worktrees(gw.repository(CUR["slug"], CUR["rid"]))
                      if Path(w["path"]).resolve() == Path(CUR["wt"]).resolve())
    CUR["inventory"] = inv


def dirty_wt(c_std, c_real):
    with_wid(c_std, c_real)
    (Path(CUR["wt"]) / "a.txt").write_text("one\nchanged\n", encoding="utf-8")
    (Path(CUR["wt"]) / "new.txt").write_text("fresh\n", encoding="utf-8")


def ahead(c_std, c_real):
    settings_saved(c_std, c_real)
    (Path(CUR["repo"]) / "b.txt").write_text("two\n", encoding="utf-8")
    sh(CUR["repo"], "add", "b.txt")
    sh(CUR["repo"], "commit", "-m", "second")
    snap = c_std.get(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/snapshot").json()
    CUR["snapshot"] = snap["token"]


def behind(c_std, c_real):
    settings_saved(c_std, c_real)
    sh(CUR["base"], "clone", str(CUR["remote"]), str(CUR["other"]))
    (Path(CUR["other"]) / "c.txt").write_text("three\n", encoding="utf-8")
    sh(CUR["other"], "add", "c.txt")
    sh(CUR["other"], "commit", "-m", "third")
    sh(CUR["other"], "push", "origin", "main")
    sh(CUR["repo"], "fetch", "origin")
    snap = c_std.get(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/snapshot").json()
    CUR["snapshot"] = snap["token"]


def snapshotted(c_std, c_real):
    settings_saved(c_std, c_real)
    snap = c_std.get(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/snapshot").json()
    CUR["snapshot"] = snap["token"]
    CUR["cursor"] = snap.get("history", {}).get("next_cursor") or snap.get("cursor")


def then(*steps):
    def go(c_std, c_real):
        for s in steps:
            s(c_std, c_real)
    return go


def body_fn(fn):
    """A request whose JSON body is computed after the setup steps ran."""
    def go(c_std, c_real):
        method, path, body = fn()
        return c_std.request(method, path.format(slug=CUR["slug"], rid=CUR["rid"], wid=CUR.get("wid")),
                             headers=OP, json=body)
    return go


G = "/api/orgs/{slug}/git"
CASES = [
    # repositories and discovery
    ("repositories_none", std("GET", G + "/repositories"), None),
    ("discover_roots", std("POST", G + "/discover", json={}), None),
    ("discover_scan", body_fn(lambda: ("POST", G + "/discover", {"path": str(CUR["base"])})), None),
    ("discover_outside", body_fn(lambda: ("POST", G + "/discover", {"path": str(_home)})), None),
    ("register", body_fn(lambda: ("POST", G + "/repositories", {"path": str(CUR["repo"])})), None),
    ("register_again", body_fn(lambda: ("POST", G + "/repositories", {"path": str(CUR["repo"])})), registered),
    ("register_not_repo", body_fn(lambda: ("POST", G + "/repositories", {"path": str(_home)})), None),
    ("register_missing", std("POST", G + "/repositories", json={"path": "Z:/nope/nowhere"}), None),
    ("register_no_org", body_fn(lambda: ("POST", "/api/orgs/nope-org/git/repositories", {"path": str(CUR["repo"])})),
     None),
    ("repositories", std("GET", G + "/repositories"), registered),
    ("forget", std("DELETE", G + "/{rid}/registration"), registered),
    ("forget_unknown", std("DELETE", G + "/nope/registration"), None),
    ("select", std("POST", G + "/{rid}/selection"), registered),
    ("select_unknown", std("POST", G + "/nope/selection"), None),
    # observation, inventory, setup
    ("observation", std("GET", G + "/{rid}/observation"), settings_saved),
    ("inventory", std("GET", G + "/{rid}/inventory"), settings_saved),
    ("setup", body_fn(lambda: ("POST", G + "/{rid}/setup", {"path": str(CUR["wt"])})), registered),
    ("setup_link_refused", body_fn(lambda: ("POST", G + "/{rid}/setup",
                                            {"path": str(CUR["wt"]), "dependency_source": str(CUR["base"]),
                                             "apply": True})), registered),
    ("setup_not_dir", body_fn(lambda: ("POST", G + "/{rid}/setup", {"path": str(CUR["base"] / "nope")})), registered),
    ("setup_other_repo", body_fn(lambda: ("POST", G + "/{rid}/setup", {"path": str(CUR["remote"])})), registered),
    # cleanup
    ("cleanup_preview", body_fn(lambda: ("POST", G + "/{rid}/cleanup-preview",
                                         {"root": str(CUR["wt"]), "candidates": [str(CUR["wt"] / "a.txt")]})),
     registered),
    ("cleanup_preview_not_worktree", body_fn(lambda: ("POST", G + "/{rid}/cleanup-preview",
                                                      {"root": str(CUR["base"]), "candidates": ["x"]})), registered),
    ("cleanup_unlink_no_preview", body_fn(lambda: ("POST", G + "/{rid}/cleanup-unlink",
                                                   {"root": str(CUR["wt"]), "candidates": ["x"]})), registered),
    ("cleanup_unlink_other_root", body_fn(lambda: ("POST", G + "/{rid}/cleanup-unlink",
                                                   {"root": str(CUR["wt"]), "candidates": ["x"],
                                                    "preview": {"root": str(CUR["repo"]), "targets": []}})),
     registered),
    # settings and links
    ("settings", std("GET", G + "/{rid}/settings"), registered),
    ("settings_patch", body_fn(lambda: ("PATCH", G + "/{rid}/settings",
                                        {"revision": 1, "values": {"remote": "origin", "trunk": "refs/heads/main"}})),
     registered),
    ("settings_patch_stale", body_fn(lambda: ("PATCH", G + "/{rid}/settings",
                                              {"revision": 0, "values": {"remote": "origin"}})), registered),
    ("settings_patch_bad_key", body_fn(lambda: ("PATCH", G + "/{rid}/settings",
                                                {"revision": 1, "values": {"auto_fetch": True}})), registered),
    ("settings_patch_bad_remote", body_fn(lambda: ("PATCH", G + "/{rid}/settings",
                                                   {"revision": 1, "values": {"remote": "nope"}})), registered),
    ("link", body_fn(lambda: ("POST", G + "/{rid}/links", {"branch": "refs/heads/main", "item": "f8-item"})),
     registered),
    ("link_unknown_item", body_fn(lambda: ("POST", G + "/{rid}/links", {"branch": "refs/heads/main", "item": "nope"})),
     registered),
    ("link_unknown_branch", body_fn(lambda: ("POST", G + "/{rid}/links",
                                             {"branch": "refs/heads/nope", "item": "f8-item"})), registered),
    ("unlink", body_fn(lambda: ("DELETE", G + "/{rid}/links", {"branch": "refs/heads/main", "item": "f8-item"})),
     then(registered, lambda a, b: a.post(f"/api/orgs/{CUR['slug']}/git/{CUR['rid']}/links",
                                          json={"branch": "refs/heads/main", "item": "f8-item"}))),
    # snapshot, history, changes
    ("snapshot", std("GET", G + "/{rid}/snapshot"), settings_saved),
    ("snapshot_bad_branches", std("GET", G + "/{rid}/snapshot", params={"branches": "{}"}), settings_saved),
    ("history_bad_cursor", std("GET", G + "/{rid}/history", params={"cursor": "a.0.b"}), settings_saved),
    ("changes_clean", std("GET", G + "/{rid}/worktrees/{wid}/changes"), with_wid),
    ("changes_dirty", std("GET", G + "/{rid}/worktrees/{wid}/changes"), dirty_wt),
    ("changes_unknown", std("GET", G + "/{rid}/worktrees/nope/changes"), settings_saved),
    # remote operations
    ("fetch", std("POST", G + "/{rid}/fetch"), settings_saved),
    ("fetch_no_remote", std("POST", G + "/{rid}/fetch"),
     then(registered, lambda a, b: sh(CUR["repo"], "remote", "remove", "origin"))),
    ("watch", std("POST", G + "/{rid}/watch"), settings_saved),
    ("push", body_fn(lambda: ("POST", G + "/{rid}/push", {"snapshot": CUR["snapshot"], "branch": "refs/heads/main"})),
     ahead),
    ("push_not_ahead", body_fn(lambda: ("POST", G + "/{rid}/push",
                                        {"snapshot": CUR["snapshot"], "branch": "refs/heads/main"})), snapshotted),
    ("push_bad_snapshot", body_fn(lambda: ("POST", G + "/{rid}/push", {"snapshot": "nope", "branch": "refs/heads/main"})),
     settings_saved),
    ("pull", body_fn(lambda: ("POST", G + "/{rid}/pull", {"snapshot": CUR["snapshot"], "branch": "refs/heads/main"})),
     behind),
    # the desktop-managed profile: the real load_app app still serves the routes (recorded legacy defect)
    ("desktop_serves_list", real("GET", G + "/repositories"), None),
    ("desktop_serves_register", real("POST", G + "/repositories", json={"path": "x"}), None),
]


CASES = {n: (r, p) for n, r, p in CASES}


def observe(name):
    """Run one fixtured case on a fresh org and repository set; return the normalized observation, body and record."""
    request, pre = CASES[name]
    fresh()
    c_std = TestClient(STD, raise_server_exceptions=False)
    c_real = TestClient(app, raise_server_exceptions=False)
    if pre:
        pre(c_std, c_real)
    b_org, b_set = durable(CUR["slug"]), settings_doc()
    b_remote, b_repo = refs_of(CUR["remote"]), refs_of(CUR["repo"])
    since = len(LAUNCHES)
    r = request(c_std, c_real)
    until = len(LAUNCHES)
    a_org, a_set = durable(CUR["slug"]), settings_doc()
    a_remote, a_repo = refs_of(CUR["remote"]), refs_of(CUR["repo"])
    ctype = r.headers.get("content-type", "")
    body = r.json() if "json" in ctype else None
    raw = {"status": r.status_code, "keys": sorted(body) if isinstance(body, dict) else None,
           "detail": body.get("detail") if isinstance(body, dict) else None,
           "org_changed": changed(b_org, a_org),
           "settings_changed": None if b_set == a_set else sorted(
               k for k in set(b_set or {}) | set(a_set or {}) if (b_set or {}).get(k) != (a_set or {}).get(k)),
           "remote_moved": b_remote != a_remote, "repo_refs_moved": b_repo != a_repo,
           "git": subcommands(since, until)}
    cur = {"slug": CUR["slug"], "rid": CUR.get("rid"), "settings_after": a_set, "launches": LAUNCHES[since:until]}
    return norm(raw, cur), body, cur


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result["valid"], result["errors"])
        self.assertEqual(len(spec["contracts"]), 21)
        self.assertEqual(set(spec["cases"]), set(CASES))
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry["facets"]["git-workspace." + d]["status"],
                             "unresolved" if d in ("conflicts", "wire", "instrumentation") else "specified", d)
        modes = {k: c["domain_mode"] for k, c in registry["contracts"].items() if k.startswith("git-workspace.")}
        self.assertEqual({k for k, m in modes.items() if m == "conditional_write"}, {"git-workspace.watch"})
        self.assertEqual({k.split(".", 1)[1] for k, m in modes.items() if m == "write"},
                         {"register", "forget", "select", "cleanup-unlink", "settings-write", "link", "unlink", "fetch",
                          "push", "pull"})

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d["contracts"].pop("git-workspace.push"), lambda d: d.update(covered=True),
                     lambda d: d["qualification"].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256="0" * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_every_entry_selects_exactly_its_contract_and_the_branches_are_mapped(self):
        registry = contracts.load(ROOT / "docs/state-system/operation-contracts.json")
        source = contracts.inventory.scan(ROOT)
        entries = {r["id"]: r for r in registry["entries"]}
        bound = {}
        for name, c in registry["contracts"].items():
            if name.startswith("git-workspace."):
                for e in c["entry_ids"]:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 21)
        for e, names in bound.items():
            self.assertEqual((entries[e]["disposition"], entries[e]["contracts"]), ("mapped", names))
        # the four gitworkspace branches only these routes reach (rule 1)
        dispatch = {r["id"]: r for r in registry["dispatch"]}
        mapped = {(s["source"]["symbol"], tuple(s["values"])): dispatch[contracts.witness_id("dispatch", s)]["contracts"]
                  for s in source["dispatch_selectors"] if s["source"]["path"].endswith("gitworkspace.py")}
        self.assertEqual(mapped, {("unlink_validated_reparse_point", ("unlink",)): ["git-workspace.cleanup-unlink"],
                                  ("operate", ("push", "pull")): ["git-workspace.push", "git-workspace.pull"],
                                  ("operate", ("push",)): ["git-workspace.push"]})


class GitWorkspaceBoundary(unittest.TestCase):
    def setUp(self):
        self.spec = boundary()

    def check(self, *names):
        out = {}
        for name in names:
            with self.subTest(case=name):
                seen, body, cur = observe(name)
                CASE_RUNS["cases"] += 1
                CASE_RUNS["git"] += sum(1 for ok, prog, *_ in cur["launches"] if ok and prog in ("git", "git.exe"))
                self.assertEqual(seen, self.spec["cases"][name], name)
                out[name] = (seen, body, cur)
        return out

    def test_repositories_discovery_and_registration(self):
        got = self.check("repositories_none", "discover_roots", "discover_scan", "discover_outside", "register",
                         "register_again", "register_not_repo", "register_missing", "register_no_org", "repositories",
                         "forget", "forget_unknown", "select", "select_unknown")
        after = got["register"][2]["settings_after"]
        [record] = after["repositories"].values()
        self.assertEqual((record["orgs"], record["remote"], record["trunk"], record["auto_fetch"]),
                         ([got["register"][2]["slug"]], None, None, False))
        self.assertEqual(after["selected_by_org"], {got["register"][2]["slug"]: record["id"]})
        # one candidate per common directory: the bare remote, and the clone and its linked worktree collapsed into
        # one, named after whichever the scan reached last (scan order is the filesystem's)
        names = sorted(c["name"] for c in got["discover_scan"][1]["candidates"])
        self.assertEqual((len(names), names[0], names[1] in ("repo", "wt")), (2, "remote.git", True))
        # no route writes the org document
        self.assertTrue(all(s["org_changed"] == [] for s, _, _ in got.values()))

    def test_observation_inventory_setup_and_cleanup_plans(self):
        got = self.check("observation", "inventory", "setup", "setup_link_refused", "setup_not_dir",
                         "setup_other_repo", "cleanup_preview", "cleanup_preview_not_worktree",
                         "cleanup_unlink_no_preview", "cleanup_unlink_other_root")
        self.assertEqual({k: got["setup"][1][k] for k in ("command", "ready", "git_metadata_write")},
                         {"command": None, "ready": False, "git_metadata_write": False})
        self.assertTrue(got["setup_link_refused"][0]["detail"].startswith("Refusing to link node_modules without an"))
        self.assertEqual((got["cleanup_preview"][1]["preserved"], got["cleanup_preview"][1]["unlinkable"]), (1, 0))
        self.assertEqual(got["inventory"][1]["total"], 2)

    def test_settings_and_ticket_links(self):
        got = self.check("settings", "settings_patch", "settings_patch_stale", "settings_patch_bad_key",
                         "settings_patch_bad_remote", "link", "link_unknown_item", "link_unknown_branch", "unlink")
        self.assertEqual((got["settings"][1]["remote"], got["settings"][1]["saved_remote"]), ("origin", None))
        [record] = got["settings_patch"][2]["settings_after"]["repositories"].values()
        self.assertEqual((record["remote"], record["trunk"]), ("origin", "refs/heads/main"))
        self.assertEqual(got["link"][2]["settings_after"]["links"],
                         [{"repository_id": got["link"][2]["rid"], "branch_ref": "refs/heads/main",
                           "org_slug": got["link"][2]["slug"], "item_slug": "f8-item"}])
        self.assertEqual(got["unlink"][2]["settings_after"]["links"], [])

    def test_snapshot_history_and_changes(self):
        got = self.check("snapshot", "snapshot_bad_branches", "history_bad_cursor", "changes_clean", "changes_dirty",
                         "changes_unknown")
        files = {f["path"]: f["xy"] for f in got["changes_dirty"][1]["files"]}
        self.assertEqual((files, got["changes_dirty"][1]["state"]), ({"a.txt": ".M", "new.txt": "??"}, "dirty"))
        self.assertEqual(got["changes_clean"][1]["state"], "clean")

    def test_fetch_push_pull_and_watch(self):
        got = self.check("fetch", "fetch_no_remote", "watch", "push", "push_not_ahead", "push_bad_snapshot", "pull")
        push, pull = got["push"][1], got["pull"][1]
        self.assertEqual((push["state"], push["after"] == push["target"], push["before"] != push["after"]),
                         ("success", True, True))
        self.assertEqual((pull["state"], pull["after"] == pull["target"], pull["changes"]["state"]),
                         ("success", True, "clean"))
        self.assertEqual(got["watch"][1], {"started": False})         # periodic fetch is off by default
        # a refused fetch still records the failed attempt in the registry's observations
        [record] = got["fetch_no_remote"][2]["settings_after"]["repositories"].values()
        self.assertTrue(any(o.get("error") for o in record["observations"].values()))

    def test_the_desktop_app_still_serves_the_routes(self):
        # recorded legacy defect (docket the-desktop-app-still-serves-the-git-workspace-r): install_routes filters
        # route paths for '/git/', but the included git router is one _IncludedRouter entry with no path
        got = self.check("desktop_serves_list", "desktop_serves_register")
        self.assertEqual(got["desktop_serves_list"][1], {"repositories": [], "selected": None})
        from orgtree import api
        self.assertFalse(any("/git/" in str(getattr(r, "path", "")) for r in api.app.router.routes))
        self.assertIn("_IncludedRouter", {type(r).__name__ for r in api.app.router.routes})


class ConfinedGit(unittest.TestCase):
    def refused(self, fn):
        before, before_l = len(REFUSED), len(LAUNCHES)
        with self.assertRaises(RuntimeError):
            fn()
        got = REFUSED[before:]
        del REFUSED[before:]
        del LAUNCHES[before_l:]
        return got

    def test_a_non_git_launch_is_refused(self):
        got = self.refused(lambda: subprocess.run([sys.executable, "-c", "0"], cwd=str(_temp), env=os.environ.copy()))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    def test_a_git_launch_outside_the_root_is_refused(self):
        got = self.refused(lambda: subprocess.run(["git", "--version"], cwd=str(ROOT), env=os.environ.copy()))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    def test_a_git_launch_without_the_isolated_config_is_refused(self):
        env = {k: v for k, v in os.environ.items() if k != "GIT_CONFIG_NOSYSTEM"}
        got = self.refused(lambda: subprocess.run(["git", "--version"], cwd=str(_temp), env=env))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    def test_a_git_launch_without_the_ceiling_above_the_root_is_refused(self):
        missing = {k: v for k, v in os.environ.items() if k != "GIT_CEILING_DIRECTORIES"}
        at_root = dict(os.environ, GIT_CEILING_DIRECTORIES=str(_temp))
        too_high = dict(os.environ, GIT_CEILING_DIRECTORIES=str(_temp.parent.parent))
        stray = dict(os.environ, GIT_CEILING_DIRECTORIES=os.pathsep.join([str(_temp.parent), str(ROOT)]))
        for name, env in (("missing", missing), ("at the root only", at_root), ("above the root's parent", too_high),
                          ("an extra entry outside the root", stray)):
            with self.subTest(ceiling=name):
                got = self.refused(lambda: subprocess.run(["git", "--version"], cwd=str(_temp), env=env))
                self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    def test_the_ceiling_stops_the_upward_search_for_a_repository(self):
        # an enclosing repository with a plain start folder below it, all inside the root, standing in for an
        # enclosing repository around the root. A ceiling AT the start folder does not stop git (it never applies a
        # ceiling to where it starts), so it finds the enclosing repository: this control can see an escape. A ceiling
        # at the start folder's PARENT, as the module's is at the root's parent, stops it: no repository. Then the
        # same from a folder two levels down. Ceilings are given in the same path form as the module's.
        outer = _temp / "ceiling-control"
        start = outer / "start"
        deeper = start / "plain" / "deeper"
        deeper.mkdir(parents=True)
        sh(outer, "init", "-q")

        def toplevel(cwd, *ceilings):
            env = dict(os.environ, GIT_CEILING_DIRECTORIES=os.pathsep.join([*map(str, ceilings), str(_temp.parent)]))
            return subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(cwd), env=env, capture_output=True,
                                  text=True)

        for cwd in (start, deeper):
            with self.subTest(cwd=cwd.name):
                r = toplevel(cwd)
                self.assertEqual((r.returncode, Path(r.stdout.strip()).resolve()), (0, outer.resolve()), r.stderr)
                r = toplevel(cwd, cwd)
                self.assertEqual((r.returncode, Path(r.stdout.strip()).resolve()), (0, outer.resolve()), r.stderr)
                r = toplevel(cwd, cwd.parent)
                self.assertEqual(r.returncode, 128, r.stdout)
                self.assertIn("not a git repository", r.stderr)
        # the module's own ceiling is the root's parent, and from the root itself git finds no repository
        self.assertEqual(os.environ["GIT_CEILING_DIRECTORIES"], str(_temp.parent))
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(_temp), env=os.environ.copy(),
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 128, r.stdout)

    def test_a_git_url_remote_is_refused(self):
        got = self.refused(lambda: subprocess.run(["git", "ls-remote", "https://example.invalid/r.git"],
                                                  cwd=str(_temp), env=os.environ.copy()))
        self.assertEqual([e for e, _ in got], ["subprocess.Popen"])

    @unittest.skipUnless(os.name == "nt", "the Windows launch path")
    def test_a_multiprocessing_spawn_is_refused(self):
        import multiprocessing
        got = self.refused(lambda: multiprocessing.get_context("spawn").Process(target=os.getpid).start())
        self.assertEqual([e for e, _ in got], ["_winapi.CreateProcess"])

    def test_the_git_version_is_the_one_the_fixture_was_taken_with(self):
        # pins that depend on git's output format (boundary()["git"]["output_format_dependent_cases"]) hold for this
        # version; a different git needs the F8 probe re-run
        self.assertEqual(sh(_temp, "--version"), boundary()["git"]["version"])


def tearDownModule():
    # the module-wide check, run after every case (unittest orders the classes alphabetically, so no test inside a
    # class can see the cases' launches). A refused launch the product caught and swallowed fails no case; it still
    # fails the module. If cases ran, the hook must have seen their git: an empty log means it saw nothing. The hook
    # cannot be removed, so it is switched off here: a single-process discover run's later modules do not inherit it.
    try:
        assert REFUSED == [], REFUSED
        assert all(ok and prog in ("git", "git.exe") and _inside(cwd) for ok, prog, cwd, _ in LAUNCHES), \
            [x for x in LAUNCHES if not x[0]]
        assert not CASE_RUNS["cases"] or CASE_RUNS["git"] > 0, CASE_RUNS
        assert CASE_RUNS["git"] <= len(LAUNCHES), (CASE_RUNS, len(LAUNCHES))
    finally:
        GUARD["on"] = False


if __name__ == "__main__":
    unittest.main()
