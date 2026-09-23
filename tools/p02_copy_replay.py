"""P02 isolated-copy census replay harness (plan r3, sha256 df422356...).

Runs private v3 against a DISPOSABLE COPY of Orgtree data, inside a process
whose every process spawn, kill/PID probe, network egress, registry write,
agent wake, protected-root read and out-of-copy write is refused and counted
(``tests/isolation_guards.py``). Nothing here starts the real engine: each arm
is ``load_app()`` + ``TestClient`` WITHOUT lifespan, so startup recovery, the
warm pool, the net client, the mail hub and every watchdog stay off.

Subcommands (the operator runs the unprefixed ones; ``_``-prefixed ones are
the guarded children those spawn):

``snapshot``   copy the org databases and the five sidecars from a PROTECTED
               source root, by the product importer's byte-copy-with-digest
               method: no SQLite connection is ever opened on a source file.
``arm``        run one replay arm (A/B/C) of the scripted workload in a guarded
               child against one fixture copy, and write its result JSON.
``controls``   deliberately attempt every refused effect and prove each one
               was refused AND counted (a control that did not fire fails).
``gate``       the pre-copy proof on SYNTHETIC data only (plan §4 steps 1-5);
               it also writes each arm's expected-refusal file.
``replay``     the real A/B/C rounds (plan §8) on fresh copies of the master,
               each arm held to its expected-refusal file from the gate.
``privacy-check`` grep every retained output for identifiers from the copy.

It reads no real data unless an operator runs ``snapshot`` against the live
root, which the user authorizes separately (plan U7). It deletes nothing.

⚠ The harness runs whatever tree it is pointed at, but it runs FROM its own
checkout: guard code is loaded from this file's ``tests/`` by path, so an arm
tree older than the harness (the ``66b46bf`` baseline) is still guarded.
Provenance is refused, not trusted: every arm records the commit read from the
tree's own git metadata, each product module's ``__file__`` (which must sit in
that tree), the interpreter and its ``._pth`` contents (review A6).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

HARNESS_ROOT = Path(__file__).resolve().parents[1]
TOOL_VERSION = 1
SIDECARS = {  # file name -> class label (source: each module's own path line)
    "transcript-records.sqlite3": "transcript_records",
    "reply-events.sqlite3": "reply_events",
    "chat-window-index.sqlite3": "chat_window_index",
    "tool-waits.db": "tool_waits",
    "file-deliveries.db": "file_deliveries",
}
ORG_DB = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}\.db$")
SCHEMA_VERSION = "1"  # store._SCHEMA_VERSION in v3 and stable 0008ccb
EXIT_REFUSED = 3
EXIT_FAILED = 4
#: Replay classes and their weights (percent). Reads 70, writes 30 (plan §7).
READ_CLASSES = {"org": 10, "node_detail": 8, "history": 8, "chat": 10,
                "reply_events": 8, "node_inbox": 6, "agent_chart": 8,
                "agent_work_list": 6, "agent_watchdog_list": 6}
WRITE_CLASSES = {"agent_status": 12, "agent_work_update": 8,
                 "agent_work_evidence": 5, "agent_notice": 5}
#: Environment kept from the operator's shell; everything else is rebuilt.
KEEP_ENV = ("SystemRoot", "windir", "SystemDrive", "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE", "OS", "PATHEXT")


def _load(name: str) -> Any:
    """Load a stdlib-only helper from THIS checkout's tests/ by path."""
    if name in sys.modules:
        return sys.modules[name]
    path = HARNESS_ROOT / "tests" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _write_json(path: Path, doc: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _emit(doc: dict[str, Any], code: int) -> int:
    print(json.dumps(doc, sort_keys=True), flush=True)
    return code


def _refusal(stage: str, reason: str, **extra: Any) -> int:
    return _emit({"refused": True, "stage": stage, "reason": reason, **extra}, EXIT_REFUSED)


def _protected_from_env(ig: Any, extra: list[str]) -> tuple[dict[str, Any], list[str]]:
    pinned = ig.pinned_protected_roots(os.environ)
    return pinned, ig.all_protected(pinned, extra)


def _child_protected(ig: Any) -> list[str]:
    """Protected roots for an INTERNAL child (``_arm-child``, ``_fixture-child``,
    ``_writer``). Its APPDATA and USERPROFILE are already redirected into the
    run, so it cannot re-pin from them: the live root must arrive as an
    absolute ``ORGTREE_AGENT_PARENT_DATA`` (the orchestrator pinned it before
    redirecting), else the child refuses (review B1). Raises RefuseToRun."""
    live = os.environ.get("ORGTREE_AGENT_PARENT_DATA", "").strip()
    if not live or not os.path.isabs(live):
        raise ig.RefuseToRun("cannot establish the live root: ORGTREE_AGENT_PARENT_DATA "
                             "is not set to an absolute path")
    try:
        passed = json.loads(os.environ.get("P02_PROTECTED") or "[]")
    except ValueError:
        raise ig.RefuseToRun("P02_PROTECTED is not JSON") from None
    legacy = os.environ.get("ORGTREE_AGENT_LEGACY_DATA", "").strip()
    return ig.all_protected({"live": [live], "legacy": [legacy] if legacy else []}, passed)


# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------

def _git_dir(tree: Path) -> tuple[Path, Path] | None:
    dotgit = tree / ".git"
    if dotgit.is_dir():
        return dotgit, dotgit
    if dotgit.is_file():
        text = dotgit.read_text(encoding="utf-8").strip()
        if text.startswith("gitdir:"):
            gitdir = Path(text[7:].strip())
            if not gitdir.is_absolute():
                gitdir = (tree / gitdir).resolve()
            common = gitdir
            cfile = gitdir / "commondir"
            if cfile.is_file():
                common = (gitdir / cfile.read_text(encoding="utf-8").strip()).resolve()
            return gitdir, common
    return None


def tree_commit(tree: Path) -> str | None:
    """The commit checked out in ``tree``, read from git's files (a guarded
    child cannot run git)."""
    dirs = _git_dir(tree)
    if dirs is None:
        return None
    gitdir, common = dirs
    head = (gitdir / "HEAD").read_text(encoding="utf-8").strip()
    if re.fullmatch(r"[0-9a-f]{40}", head):
        return head
    if not head.startswith("ref:"):
        return None
    ref = head[4:].strip()
    for base in (gitdir, common):
        candidate = base / ref
        if candidate.is_file():
            value = candidate.read_text(encoding="utf-8").strip()
            return value if re.fullmatch(r"[0-9a-f]{40}", value) else None
    packed = common / "packed-refs"
    if packed.is_file():
        for line in packed.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] == ref:
                return parts[0]
    return None


def interpreter_receipt() -> dict[str, Any]:
    exe = Path(sys.executable)
    pth = {}
    for path in sorted(exe.parent.glob("*._pth")):
        pth[path.name] = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"python_version": sys.version.split()[0], "executable_name": exe.name,
            "pth": pth, "flags_isolated": bool(sys.flags.isolated),
            "dont_write_bytecode": bool(sys.dont_write_bytecode)}


PROVENANCE_MODULES = ("engine.launch", "orgtree.api", "orgtree.store",
                      "orgtree.census", "orgtree.supervisor")


def module_provenance(ig: Any, tree: Path) -> tuple[dict[str, str], list[str]]:
    root = ig.normal(tree)
    files: dict[str, str] = {}
    foreign: list[str] = []
    for name in PROVENANCE_MODULES:
        module = sys.modules.get(name)
        origin = getattr(module, "__file__", None) if module else None
        if not origin:
            foreign.append(name)
            continue
        norm = ig.normal(origin)
        if not ig.within(norm, root):
            foreign.append(name)
            continue
        files[name] = os.path.relpath(norm, root).replace("\\", "/")
    return files, foreign


# ---------------------------------------------------------------------------
# snapshot: the copy step (plan §5)
# ---------------------------------------------------------------------------

def _open_shared(path: str, hook: Any) -> Any:
    """Read-only, sharing read, write AND delete (review A2), so the live
    engine can still delete a sidecar ``-wal`` while we hold it. The guard's
    own read check runs first: CreateFileW raises no ``open`` audit event."""
    hook._check_read("open", path)
    if os.name != "nt":
        return open(path, "rb")
    import ctypes
    import msvcrt
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create = k32.CreateFileW
    create.restype = wintypes.HANDLE
    create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    handle = create(path, 0x80000000, 0x1 | 0x2 | 0x4, None, 3, 0x80, None)
    if handle in (None, wintypes.HANDLE(-1).value):
        raise OSError(ctypes.get_last_error(), "CreateFileW failed")
    fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    return os.fdopen(fd, "rb")


def _digest(path: str, hook: Any) -> str | None:
    if not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with _open_shared(path, hook) as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _copy_bytes(src: str, dst: Path, hook: Any) -> int:
    n = 0
    with _open_shared(src, hook) as f, open(dst, "wb") as out:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            out.write(chunk)
            n += len(chunk)
    return n


def copy_one(src: str, rel: str, stage: Path, master: Path, hook: Any,
             tries: int, wait: float, is_org: bool) -> dict[str, Any]:
    """Copy ONE database like desktop_import._read_document: digest db+wal,
    byte-copy, digest again, retry if anything moved; then back up the
    PRIVATE copy into the master. ``-shm`` is never copied."""
    import sqlite3
    wal, journal = src + "-wal", src + "-journal"
    outcome: dict[str, Any] = {"retries": 0, "status": "skipped", "reason": None}
    stage.mkdir(parents=True, exist_ok=True)
    staged = stage / "snapshot-source.db"
    staged_wal = stage / "snapshot-source.db-wal"
    for attempt in range(tries):
        if attempt:
            outcome["retries"] += 1
            time.sleep(wait)
        for leftover in (staged, staged_wal, stage / "snapshot-source.db-shm"):
            if leftover.exists():
                os.remove(leftover)
        if os.path.exists(journal):
            outcome["reason"] = "journal"
            continue
        try:
            wal_before = os.path.exists(wal)
            before = (_digest(src, hook), _digest(wal, hook) if wal_before else None)
            size = _copy_bytes(src, staged, hook)
            if wal_before:
                size += _copy_bytes(wal, staged_wal, hook)
            wal_after = os.path.exists(wal)
            after = (_digest(src, hook), _digest(wal, hook) if wal_after else None)
        except FileNotFoundError:
            # the live engine deleted its -wal between our check and our open
            # (a per-call connection's last close does exactly that)
            outcome["reason"] = "changed"
            continue
        if before != after or wal_before != wal_after or os.path.exists(journal):
            outcome["reason"] = "changed"
            continue
        dest = master / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            raise RuntimeError("destination already exists; refusing to overwrite")
        with sqlite3.connect(staged) as private, sqlite3.connect(dest) as target:
            private.backup(target)
        private.close()
        target.close()
        for leftover in (staged, staged_wal, stage / "snapshot-source.db-shm"):
            if leftover.exists():
                os.remove(leftover)
        conn = sqlite3.connect(dest)
        try:
            ok = conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            schema_ok = True
            if is_org:
                row = conn.execute(
                    "SELECT val FROM meta WHERE key='schema_version'").fetchone()
                schema_ok = row == (SCHEMA_VERSION,)
        finally:
            conn.close()
        if not ok or not schema_ok:
            os.remove(dest)
            outcome.update(status="skipped", reason="integrity" if not ok else "schema")
            return outcome
        outcome.update(status="copied", reason=None, bytes=size)
        return outcome
    return outcome


def cmd_snapshot(args: argparse.Namespace) -> int:
    ig = _load("isolation_guards")
    try:
        pinned, protected = _protected_from_env(ig, args.protect)
    except ig.RefuseToRun as exc:
        return _refusal("snapshot", str(exc))
    source = ig.normal(args.source)
    run = ig.normal(args.run)
    if source not in protected:
        return _refusal("snapshot", "the source must be a protected root "
                        "(the live root, or a synthetic source passed with --protect)")
    try:
        ig.refuse_overlap("run", run, protected)
    except ig.RefuseToRun as exc:
        return _refusal("snapshot", str(exc))
    run_p = Path(run)
    stage, master = run_p / "stage", run_p / "master" / "data"
    if master.exists():
        return _refusal("snapshot", "the master copy already exists")
    for d in (run_p / "logs", run_p / "out", run_p / "master", stage):
        d.mkdir(parents=True, exist_ok=True)
    orgs_dir = os.path.join(source, "orgs")
    # ctypes_symbols={"CreateFileW"} lets ANY CreateFileW call in this process
    # through, write access included (review N6). Acceptable only because no
    # product code is ever imported here: the one caller is _open_shared,
    # which read-checks the path itself and opens GENERIC_READ, OPEN_EXISTING.
    policy = ig.Policy(write_roots=[str(stage), str(run_p / "master"), str(run_p / "logs"),
                                    str(run_p / "out")],
                       protected_roots=protected, list_exceptions={orgs_dir},
                       ctypes_symbols={"CreateFileW"})
    report = ig.Report()
    hook = ig.install_audit_guards(policy, report)
    selected = None if args.orgs == "all" else set(args.orgs.split(","))
    names = sorted(n for n in (os.listdir(orgs_dir) if os.path.isdir(orgs_dir) else [])
                   if ORG_DB.match(n) and (selected is None or n[:-3] in selected))
    files = [(os.path.join(orgs_dir, n), f"orgs/{n}", "org_db", True) for n in names]
    files += [(os.path.join(source, n), n, label, False) for n, label in SIDECARS.items()
              if os.path.exists(os.path.join(source, n))]
    for src, _rel, _label, _org in files:
        policy.read_exceptions.update(ig.normal(p) for p in (src, src + "-wal"))
    classes: dict[str, dict[str, Any]] = {}
    salt = secrets.token_bytes(16)
    names_log = []
    for src, rel, label, is_org in files:
        report.route = "snapshot"
        outcome = copy_one(src, rel, stage, master, hook, args.tries, args.wait, is_org)
        c = classes.setdefault(label, {"files": 0, "copied": 0, "bytes": 0, "skipped": 0,
                                       "retries": 0, "skipped_reasons": {}})
        c["files"] += 1
        c["retries"] += outcome["retries"]
        if outcome["status"] == "copied":
            c["copied"] += 1
            c["bytes"] += outcome.get("bytes", 0)
        else:
            c["skipped"] += 1
            reason = outcome.get("reason") or "unknown"
            c["skipped_reasons"][reason] = c["skipped_reasons"].get(reason, 0) + 1
        names_log.append({"name_sha256": hashlib.sha256(salt + rel.encode()).hexdigest(),
                          "class": label, **outcome})
    del salt
    manifest = {"tool_version": TOOL_VERSION, "classes": classes,
                "guards": report.as_json()}
    _write_json(run_p / "out" / "copy-manifest.json", manifest)
    _write_json(run_p / "logs" / "copy-log.json", names_log)
    failed = report.total() != 0
    return _emit({"snapshot": "failed" if failed else "done", "classes": classes,
                  "refused_total": report.total()}, EXIT_FAILED if failed else 0)


# ---------------------------------------------------------------------------
# the guarded arm child
# ---------------------------------------------------------------------------

class _AccessTap:
    """Collects `[orgtree.access] ... handler=Xms total=Yms` lines (api.py)."""

    PATTERN = re.compile(r"\[orgtree\.access\] \S+ \S+ \S+ \d+ handler=(\d+)ms total=(\d+)ms")

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.lock = threading.Lock()
        self.lines: list[tuple[int, int]] = []
        self._buf = ""

    def write(self, text: str) -> int:
        with self.lock:
            self._buf += text
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                m = self.PATTERN.search(line)
                if m:
                    self.lines.append((int(m.group(1)), int(m.group(2))))
        return self.inner.write(text)

    def flush(self) -> None:
        self.inner.flush()

    def take(self) -> list[tuple[int, int]]:
        with self.lock:
            out, self.lines = self.lines, []
            return out


def _plan_script(n: int, seed: int) -> list[str]:
    import random
    weights = {**READ_CLASSES, **WRITE_CLASSES}
    counts = {k: (n * w) // 100 for k, w in weights.items()}
    order = sorted(weights, key=lambda k: -((n * weights[k]) % 100))
    i = 0
    while sum(counts.values()) < n:
        counts[order[i % len(order)]] += 1
        i += 1
    script = [k for k, c in counts.items() for _ in range(c)]
    random.Random(seed).shuffle(script)
    return script


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def cmd_arm_child(args: argparse.Namespace) -> int:
    t_begin = time.perf_counter()
    result: dict[str, Any] = {"tool_version": TOOL_VERSION, "arm": args.arm,
                              "round": args.round, "capture": args.arm == "C",
                              "load_app_called": False}
    ig = _load("isolation_guards")
    try:
        protected = _child_protected(ig)
    except ig.RefuseToRun as exc:
        return _refusal("arm", str(exc), load_app_called=False)
    run, data, tree = ig.normal(args.run), ig.normal(args.data), ig.normal(args.tree)
    try:
        if not ig.within(data, run) or data == run:
            raise ig.RefuseToRun("the data root must be inside the run folder")
        ig.refuse_overlap("run", run, protected)
        ig.refuse_overlap("data root", data, protected)
        ig.refuse_overlap("tree", tree, protected)
        if ig.normal(os.environ.get("ORGTREE_DATA", "")) != data:
            raise ig.RefuseToRun("ORGTREE_DATA does not name the arm's data root")
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR",
                    "ORGTREE_LOCAL_HUB_ADDRESS"):
            if os.environ.get(key):
                raise ig.RefuseToRun(f"{key} is set in the arm environment")
    except ig.RefuseToRun as exc:
        return _refusal("arm", str(exc), load_app_called=False)
    run_p = Path(run)
    write_roots = [data, str(run_p / "tmp"), str(run_p / "out"), str(run_p / "logs")]
    report = ig.Report()
    try:
        policy = ig.Policy(write_roots=write_roots, protected_roots=protected)
        hook = ig.install_audit_guards(policy, report)
        result["native_blocked"] = ig.block_native_process_modules()
    except ig.RefuseToRun as exc:
        return _refusal("arm", str(exc), load_app_called=False)
    ig.force_selector_loop()
    ig.block_proactor_connect(report)
    hub = _load("hub_isolation")
    hub.scrub_inherited_hub(os.environ)
    hub_hits: list[str] = []
    report.route = "setup"
    hub.isolate_data_root(Path(data))
    hub.install_transport_guard(hub_hits.append)
    tap = _AccessTap(sys.stdout)
    sys.stdout = tap  # type: ignore[assignment]
    sys.path[:0] = [tree]
    threads_before = {t.ident for t in threading.enumerate()}
    token = os.environ.get("ORGTREE_V2_TOKEN", "")
    from engine.launch import load_app  # noqa: E402  (guards are installed)
    result["load_app_called"] = True
    app, *_rest = load_app()
    files, foreign = module_provenance(ig, Path(tree))
    commit = tree_commit(Path(tree))
    result["provenance"] = {"commit": commit, "modules": files, "foreign": foreign,
                            "interpreter": interpreter_receipt(),
                            "harness_commit": tree_commit(HARNESS_ROOT)}
    if foreign or not commit:
        sys.stdout = tap.inner
        return _refusal("arm", "provenance incomplete: a product module is not from "
                        "the arm tree, or its commit cannot be read", foreign=foreign,
                        load_app_called=True)
    from fastapi.testclient import TestClient
    from orgtree import store, supervisor
    from orgtree import startup
    wrapped = ig.install_wake_guard(supervisor, report)
    result["wake_guard_wrapped"] = wrapped
    result["wake_guard_missing"] = [n for n in ig.WAKE_ENTRY_POINTS if n not in wrapped]
    # An explicit non-hub port: TestClient never touches the network, but
    # hub_isolation reads a port-less http URL as the hub default 7370.
    client = TestClient(app, base_url="http://testserver:18080",
                        raise_server_exceptions=False)
    headers = {"X-Orgtree-Desktop-Token": token}

    # ---- the workload: live seats only, orgs chosen by size ------------------
    report.route = "select"
    orgs = []
    identifiers: set[str] = set()
    for row in store.cached_list():
        slug = row.get("slug")
        if not slug:
            continue
        org = store.load_org(slug)
        identifiers.add(str(slug))
        identifiers.update(str(nid) for nid in org.nodes)
        identifiers.update(str(n.get("name")) for n in org.nodes.values() if n.get("name"))
        seats = [nid for nid, n in org.nodes.items()
                 if not nid.startswith("@") and n.get("state") == "live"
                 and not n.get("successor")]
        if seats:
            orgs.append((len(seats), slug, sorted(seats)))
    orgs.sort(key=lambda x: (-x[0], x[1]))
    orgs = orgs[:args.max_orgs]
    # logs\ only: the privacy check greps out\ for these and they never leave
    _write_json(run_p / "logs" / f"identifiers-{args.arm}-{args.round}.json",
                sorted(identifiers))
    if not orgs:
        sys.stdout = tap.inner
        return _refusal("arm", "no organisation with a live seat in the copy",
                        load_app_called=True)
    import random
    rng = random.Random(args.seed)
    targets = [(slug, nid) for _n, slug, seats in orgs for nid in seats[:args.max_seats]]
    writers = [(slug, seats[0]) for _n, slug, seats in orgs]
    peers = {slug: seats for _n, slug, seats in orgs}

    def agent(slug: str, nid: str, tool: str, a: dict[str, Any]) -> Any:
        return client.post("/api/agent", headers=headers,
                           json={"org": slug, "node": nid, "tool": tool, "args": a})

    wake_violations = 0

    def check_quiet(resp: Any) -> None:
        nonlocal wake_violations
        try:
            body = resp.json()
        except ValueError:
            return
        if isinstance(body, dict) and (body.get("notified_nodes") or body.get("notified")
                                       or body.get("reported_to")):
            wake_violations += 1

    items: dict[tuple[str, str], str] = {}
    report.route = "setup-items"
    for slug, nid in writers:
        resp = agent(slug, nid, "orgtree_work", {
            "action": "create", "title": "p02 replay scratch item",
            "objective": "Synthetic scratch item for the P02 replay window. "
                         "Self-owned, no reviewer, no participants."})
        check_quiet(resp)
        if resp.status_code == 200 and isinstance(resp.json(), dict) and resp.json().get("item"):
            items[(slug, nid)] = resp.json()["item"]

    def attempt(kind: str) -> Any:
        slug, nid = rng.choice(targets)
        if kind in WRITE_CLASSES:
            slug, nid = rng.choice(writers)
        base = f"/api/orgs/{slug}"
        if kind == "org":
            return client.get(base, headers=headers)
        if kind == "node_detail":
            return client.get(f"{base}/nodes/{nid}/detail", headers=headers)
        if kind == "history":
            return client.get(f"{base}/nodes/{nid}/history?last=40", headers=headers)
        if kind == "chat":
            return client.get(f"{base}/nodes/{nid}/chat?last=50", headers=headers)
        if kind == "reply_events":
            return client.get(f"{base}/nodes/{nid}/reply-events", headers=headers)
        if kind == "node_inbox":
            return client.get(f"{base}/nodes/{nid}/inbox", headers=headers)
        if kind == "agent_chart":
            return agent(slug, nid, "orgtree_chart", {})
        if kind == "agent_work_list":
            return agent(slug, nid, "orgtree_work", {"action": "list"})
        if kind == "agent_watchdog_list":
            return agent(slug, nid, "orgtree_watchdog", {"action": "list"})
        if kind == "agent_status":
            return agent(slug, nid, "orgtree_status", {
                "status": rng.choice(("working", "idle")), "summary": "p02 replay"})
        item = items.get((slug, nid))
        if kind == "agent_work_update" and item:
            return agent(slug, nid, "orgtree_work", {
                "action": "update", "slug": item, "done_so_far": ["replay step"],
                "working_on_next": ["next replay step"]})
        if kind == "agent_work_evidence" and item:
            return agent(slug, nid, "orgtree_work", {
                "action": "evidence", "slug": item, "kind": "note",
                "ref": "p02-replay", "note": "synthetic replay evidence"})
        if kind == "agent_notice":
            peer = next((p for p in peers[slug] if p != nid), None)
            if peer:
                return agent(slug, nid, "orgtree_send_notice",
                             {"to": peer, "body": "p02 replay notice"})
        return agent(slug, nid, "orgtree_status", {"status": "working",
                                                    "summary": "p02 replay"})

    def census(path: str, **kw: Any) -> dict[str, Any]:
        report.route = "census"
        resp = (client.post(path, headers=headers, **kw) if kw or path.endswith("reset")
                else client.get(path, headers=headers))
        if resp.status_code != 200:
            raise RuntimeError(f"census call {path} answered {resp.status_code}")
        return resp.json()

    script = _plan_script(args.n, args.seed)
    census("/api/diagnostics/operation-census/reset")
    census("/api/diagnostics/operation-census", json={"enabled": args.arm == "C"})
    s0 = census("/api/diagnostics/operation-census?n=0")
    polls = []
    per_class: dict[str, dict[str, Any]] = {}
    raw: dict[str, list[float]] = {}
    access: dict[str, list[list[int]]] = {}
    exceptions: dict[str, int] = {}
    tap.take()
    for i, kind in enumerate(script, 1):
        report.route = kind
        t0 = time.perf_counter()
        try:
            resp = attempt(kind)
            status = resp.status_code
            if kind in WRITE_CLASSES:
                check_quiet(resp)
        except Exception as exc:  # noqa: BLE001 - recorded by class, never swallowed silently
            status = -1
            exceptions[type(exc).__name__] = exceptions.get(type(exc).__name__, 0) + 1
        ms = (time.perf_counter() - t0) * 1000.0
        c = per_class.setdefault(kind, {"n": 0, "status": {}})
        c["n"] += 1
        c["status"][str(status)] = c["status"].get(str(status), 0) + 1
        raw.setdefault(kind, []).append(round(ms, 3))
        access.setdefault(kind, []).extend([list(x) for x in tap.take()])
        if i % 500 == 0:
            snap = census("/api/diagnostics/operation-census?n=0")
            polls.append({k: snap.get(k) for k in ("instance", "window_generation", "newest_seq")}
                         | {"observed": snap["counters"].get("observed")})
            tap.take()
    s1 = census("/api/diagnostics/operation-census?n=0")
    census("/api/diagnostics/operation-census", json={"enabled": False})
    final = census("/api/diagnostics/operation-census?n=20000")

    # ---- post-window controls on the REAL supervisor and liveness -----------
    controls = {}
    report.route = "post-control"
    before = report.total("wake")
    try:
        supervisor.send_message(orgs[0][1], orgs[0][2][0], "p02 wake control")
        controls["wake_send_message"] = {"refused": False}
    except ig.GuardRefused:
        controls["wake_send_message"] = {"refused": True}
    controls["wake_send_message"]["delta"] = report.total("wake") - before
    if args.decoy_pid:
        from orgtree import liveness
        before = report.total("kill")
        reason = liveness._observe_pid(int(args.decoy_pid))
        controls["liveness_probe"] = {"reason": reason,
                                      "delta": report.total("kill") - before}

    sys.stdout = tap.inner
    counters0, counters1 = s0.get("counters", {}), s1.get("counters", {})
    # `observed` counts the census's own read doors too (each one is also
    # counted in `skipped_self`), so the denominator is observed minus self
    # `observed` counts every census read inside [s0, s1] as well — as
    # `skipped_self` with capture on, as `skipped_disabled` with it off — and
    # the harness knows exactly how many it made: the polls plus s1.
    observed_raw = counters1.get("observed", 0) - counters0.get("observed", 0)
    self_reads = counters1.get("skipped_self", 0) - counters0.get("skipped_self", 0)
    disabled = counters1.get("skipped_disabled", 0) - counters0.get("skipped_disabled", 0)
    census_reads = len(polls) + 1
    observed = observed_raw - census_reads
    recorded = counters1.get("recorded", 0) - counters0.get("recorded", 0)
    new_threads = [t for t in threading.enumerate() if t.ident not in threads_before]
    guard = report.as_json()
    try:
        expected = {tuple(x) for x in json.loads(Path(args.expect).read_text(encoding="utf-8"))} \
            if args.expect else set()
    except (OSError, ValueError):
        return _refusal("arm", "the expected-refusal file cannot be read", load_app_called=True)
    refused_keys = {(r["guard"], r["event"], r["route"]) for r in guard["refused"]
                    if r["route"] not in ("post-control",)}
    unexpected = sorted(refused_keys - expected)
    gates = {
        "denominator": observed == args.n,
        "self_reads_consistent": ((self_reads == census_reads and disabled == 0)
                                  if args.arm == "C" else
                                  (self_reads == 0 and disabled == observed_raw)),
        "same_instance": (s0.get("instance") == s1.get("instance") == final.get("instance")
                          and s0.get("window_generation") == s1.get("window_generation")
                          == final.get("window_generation")),
        "polls_monotonic": all(p["instance"] == s0.get("instance")
                               and p["window_generation"] == s0.get("window_generation")
                               for p in polls),
        "recorded": (recorded == args.n) if args.arm == "C" else (recorded == 0),
        "no_loss": all(counters1.get(k, 0) == 0 for k in (
            "rejected", "dropped_stale_window", "dropped_capture_off", "evicted",
            "db_observe_failed", "db_self_recursion")),
        "no_unexpected_refusal": not unexpected,
        "no_wake": wake_violations == 0 and report.total("wake") == controls[
            "wake_send_message"]["delta"],
        "wake_control_fired": controls["wake_send_message"]["refused"]
        and controls["wake_send_message"]["delta"] == 1,
        "startup_not_run": startup.recovery.task is None,
        # still unimportable after the replay: nothing restored it
        "native_process_modules_blocked": all(sys.modules.get(m, 0) is None
                                              for m in ig.NATIVE_PROCESS_MODULES),
        "hub_guard_quiet": not hub_hits,
        "no_request_exception": not exceptions,
        "all_wake_points_wrapped": not result["wake_guard_missing"],
    }
    if args.decoy_pid:
        gates["liveness_probe_refused"] = (controls["liveness_probe"]["reason"] != "still-active"
                                           and controls["liveness_probe"]["delta"] >= 1)
    result.update({
        "guards": guard, "unexpected_refusals": [list(x) for x in unexpected],
        "hub_guard_hits": len(hub_hits),
        "startup": {"recovery_task_none": startup.recovery.task is None,
                    "new_thread_count": len(new_threads)},
        "native_extensions": sorted(
            name for name, m in sys.modules.items()
            if str(getattr(m, "__file__", "") or "").lower().endswith(".pyd")),
        "script": {"n": args.n, "seed": args.seed, "per_class": per_class,
                   "writers": len(writers), "targets": len(targets),
                   "orgs": len(orgs), "wake_violations": wake_violations,
                   "exceptions": exceptions},
        "census": {"schema_version": final.get("schema_version"),
                   "observed_in_window": observed, "recorded_in_window": recorded,
                   "observed_raw_in_window": observed_raw, "self_reads_in_window": self_reads,
                   "census_reads_in_window": census_reads, "skipped_disabled_in_window": disabled,
                   "counters_end": counters1, "polls": polls},
        "timing": {"per_class": {k: {"n": len(v), "median_ms": statistics.median(v),
                                     "p90_ms": _pct(v, 0.9)} for k, v in raw.items()},
                   "raw_ms": raw, "access_handler_total_ms": access},
        "controls": controls, "gates": gates,
        "verdict": "measured" if all(gates.values()) else "failed",
        "elapsed_s": round(time.perf_counter() - t_begin, 3),
    })
    tag = f"{args.arm}-{args.round}"
    _write_json(Path(args.out), result)
    _write_json(run_p / "out" / f"census-{tag}.json", final)
    print(json.dumps({"verdict": result["verdict"], "gates": gates}), flush=True)
    return 0 if result["verdict"] == "measured" else EXIT_FAILED


def child_env(pinned: dict[str, Any], protected: list[str], run: Path, data: Path,
              python: Path) -> dict[str, str]:
    env = {k: os.environ[k] for k in KEEP_ENV if os.environ.get(k)}
    home = run / "home"
    env.update({
        "PATH": str(python.parent), "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "TEMP": str(run / "tmp"), "TMP": str(run / "tmp"),
        "ORGTREE_DATA": str(data), "ORGTREE_V2_TOKEN": secrets.token_urlsafe(24),
        "ORGTREE_AGENT_PARENT_DATA": pinned["live"][0],
        "P02_PROTECTED": json.dumps(protected),
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
    })
    if pinned.get("legacy"):
        env["ORGTREE_AGENT_LEGACY_DATA"] = pinned["legacy"][0]
    return env


def _child(python: Path, sub: str, argv: list[str], env: dict[str, str], log: Path,
           timeout: float) -> tuple[int, dict[str, Any] | None]:
    cmd = [str(python), "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()), sub, *argv]
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "w", encoding="utf-8") as out:
        proc = subprocess.run(cmd, env=env, stdout=out, stderr=subprocess.STDOUT,
                              timeout=timeout, cwd=str(log.parent))
    last = None
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                last = json.loads(line)
            except ValueError:
                pass
    return proc.returncode, last


def cmd_arm(args: argparse.Namespace) -> int:
    ig = _load("isolation_guards")
    try:
        pinned, protected = _protected_from_env(ig, args.protect)
        run, data = Path(ig.normal(args.run)), Path(ig.normal(args.data))
        ig.refuse_overlap("run", str(run), protected)
        ig.refuse_overlap("data root", str(data), protected)
        ig.refuse_overlap("tree", ig.normal(args.tree), protected)
    except ig.RefuseToRun as exc:
        return _refusal("arm", str(exc), load_app_called=False)
    if not data.is_dir():
        return _refusal("arm", "the data root does not exist", load_app_called=False)
    for d in ("home", "tmp", "out", "logs"):
        (run / d).mkdir(parents=True, exist_ok=True)
    python = Path(args.python or sys.executable)
    env = child_env(pinned, protected, run, data, python)
    tag = f"{args.arm}-{args.round}"
    out = run / "out" / f"arm-{tag}.json"
    argv = ["--tree", args.tree, "--arm", args.arm, "--round", str(args.round),
            "--run", str(run), "--data", str(data), "--n", str(args.n),
            "--seed", str(args.seed), "--out", str(out),
            "--max-orgs", str(args.max_orgs), "--max-seats", str(args.max_seats)]
    if args.expect:
        argv += ["--expect", args.expect]
    if args.decoy_pid:
        argv += ["--decoy-pid", str(args.decoy_pid)]
    code, last = _child(python, "_arm-child", argv, env, run / "logs" / f"arm-{tag}.log",
                        args.timeout)
    return _emit({"arm": args.arm, "round": args.round, "exit": code, "child": last,
                  "result": str(out) if out.exists() else None}, code)


# ---------------------------------------------------------------------------
# negative controls (plan §4 step 2)
# ---------------------------------------------------------------------------

#: Every control that must have RUN for a green verdict: one that silently
#: did not run (an import that failed, a branch not taken) is a failure, not
#: a pass. The second set is Windows-only.
REQUIRED_CONTROLS = frozenset({
    "write_outside", "os_open_outside", "replace_outside", "unlink_outside", "mkdir_outside",
    "rmtree_protected", "read_protected", "listdir_protected", "copy_from_protected",
    "sqlite_protected", "sqlite_outside", "popen", "os_system", "os_spawn", "os_startfile",
    "os_kill", "tcp_connect", "tcp_connect_loopback", "udp_connect", "getaddrinfo",
    "bind_non_loopback", "httpx_sync", "httpx_async", "asyncio_default_loop",
    "wake_send_message", "wake_drive_account_unpark", "wake_drive_auth_thaw",
    "wake_resume_frozen", "wake_deliver_org_inbox", "wake_drive_unfrozen_nonempty",
    "write_inside", "socketpair", "bind_loopback", "read_unprotected", "wake_notice_passes",
    "wake_drive_unfrozen_empty"})
REQUIRED_CONTROLS_NT = frozenset({
    "winapi_createprocess", "winapi_openprocess", "ctypes_openprocess",
    "ctypes_network_library", "ctypes_createfile", "ctypes_registry_write",
    "asyncio_proactor_loop", "winreg_create", "winreg_open_write"})
#: How each negative control stays harmless if the guard in front of it FAILS
#: (a bug, or a deliberate mutant). A control attempts a forbidden action on
#: purpose, so without this a broken guard becomes a real host change — which
#: happened once: a mutant let ``winreg_create`` make a real HKCU key.
#:
#: - ``fails``: the audit event fires with a realistic forbidden target, but
#:   the OS call behind it cannot succeed (a CLOSED socket, registry handle 0,
#:   an executable that does not exist, a file that does not exist).
#:   ``os_startfile`` rests on ShellExecuteW failing for a missing file
#:   WITHOUT showing a window — UNVERIFIED on Windows (review N4);
#: - ``local``: it may succeed, but touches only this run's folder, the
#:   control's OWN child process or OWN loopback listener, or makes no call at
#:   all (a symbol lookup, a system DLL load, a numeric-only address lookup);
#: - ``content``: it may start a process, and that process does nothing
#:   (``os.system("exit 0")``; COMSPEC and PATH are pointed at a missing
#:   folder first, which SHOULD stop cmd.exe from being found — UNVERIFIED).
CONTAINMENT = {
    "write_outside": "local", "os_open_outside": "local", "replace_outside": "fails",
    # unlink_outside is local, not fails: with the guards off, write_outside
    # has just created that in-run file, so the unlink succeeds (caught by the
    # first ContainmentWhenGuardsFail execution, 2026-09-23)
    "unlink_outside": "local", "mkdir_outside": "local", "rmtree_protected": "local",
    "read_protected": "local", "listdir_protected": "local", "copy_from_protected": "local",
    "sqlite_protected": "local", "sqlite_outside": "local", "popen": "fails",
    "os_system": "content", "os_spawn": "fails", "os_startfile": "fails",
    "winapi_createprocess": "fails", "os_kill": "local", "winapi_openprocess": "local",
    "ctypes_openprocess": "local", "ctypes_network_library": "local",
    "ctypes_createfile": "local", "ctypes_registry_write": "local", "tcp_connect": "fails",
    "tcp_connect_loopback": "local", "udp_connect": "fails", "getaddrinfo": "local",
    "bind_non_loopback": "fails", "httpx_sync": "local", "httpx_async": "local",
    "asyncio_default_loop": "local", "asyncio_proactor_loop": "local",
    "winreg_create": "fails", "winreg_open_write": "fails", "wake_send_message": "local",
    "wake_drive_account_unpark": "local", "wake_drive_auth_thaw": "local",
    "wake_resume_frozen": "local", "wake_deliver_org_inbox": "local",
    "wake_drive_unfrozen_nonempty": "local",
}
#: Controls with two possible refusing layers, and the one each must be
#: refused by: the default loop proves the FORCED SELECTOR policy (its
#: connect is an audited socket.connect), the explicit Proactor loop proves
#: the ConnectEx backstop.
EXPECTED_REFUSING_EVENT = {
    "asyncio_default_loop": "socket.connect",
    "asyncio_proactor_loop": "IocpProactor.connect",
}
#: A registry path no product uses; checked (read-only) after the controls.
REGISTRY_CANARY = r"Software\orgtree-p02-decoy"


def cmd_controls(args: argparse.Namespace) -> int:
    """Plan §4 step 2: every guard route attempted once and refused.

    Nothing here acts on a caller-supplied path or PID. The decoy folder, the
    "outside" folder, the process to kill and the listener to connect to are
    all created by this command inside ``--run`` (or as its own child), so a
    guard that fails can only touch this run. ``--protect`` adds protected
    roots; nothing is done to them."""
    ig = _load("isolation_guards")
    try:
        pinned, protected = _protected_from_env(ig, args.protect)
        run = Path(ig.normal(args.run))
        ig.refuse_overlap("run", str(run), protected)
    except ig.RefuseToRun as exc:
        return _refusal("controls", str(exc))
    if run.exists() and any(run.iterdir()):
        return _refusal("controls", "the controls run folder must be new or empty")
    for d in ("tmp", "out", "logs", "not-allowed"):
        (run / d).mkdir(parents=True, exist_ok=True)
    decoy = run / "decoy-protected"
    decoy.mkdir()
    secret = decoy / "secret.txt"
    secret.write_text("decoy secret", encoding="utf-8")
    absent = run / "absent"  # never created: every path under it is missing
    missing_exe = absent / "p02-no-such-program.exe"
    outside = run / "not-allowed" / f"p02-control-outside-{secrets.token_hex(4)}.txt"
    # os.system: the CRT runs %COMSPEC%, then falls back to cmd.exe searched
    # on PATH. Both point into the missing folder; UNVERIFIED that this
    # stops the spawn, so the control's command is also a no-op.
    os.environ["COMSPEC"] = str(absent / "cmd.exe")
    os.environ["PATH"] = str(absent)
    # the process a kill control aims at: our own child, started BEFORE the
    # guards, which exits by itself when its stdin closes
    own_child = subprocess.Popen([sys.executable, "-I", "-c", "import sys; sys.stdin.read()"],
                                 stdin=subprocess.PIPE)
    import socket
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    listener.setblocking(False)
    own_address = listener.getsockname()
    report = ig.Report()
    policy = ig.Policy(write_roots=[str(run / "tmp"), str(run / "out"), str(run / "logs")],
                       protected_roots=protected + [ig.normal(decoy)])
    ig.install_audit_guards(policy, report)
    ig.force_selector_loop()
    ig.block_proactor_connect(report)
    results: dict[str, dict[str, Any]] = {}

    def control(name: str, guard: str, action: Any, effect_absent: Any = None) -> None:
        report.route = f"control:{name}"
        before = report.total(guard)
        outcome: dict[str, Any] = {"guard": guard, "attempted": True,
                                   "containment": CONTAINMENT.get(name)}
        try:
            action()
            outcome["refused"] = False
        except ig.GuardRefused:
            outcome["refused"] = True
        except Exception as exc:  # noqa: BLE001 - the refusal may arrive wrapped
            chain, seen = exc, 0
            while chain is not None and not isinstance(chain, ig.GuardRefused) and seen < 16:
                chain = chain.__cause__ or chain.__context__
                seen += 1
            outcome["refused"] = isinstance(chain, ig.GuardRefused)
            outcome["exception"] = type(exc).__name__
        outcome["delta"] = report.total(guard) - before
        outcome["events"] = sorted(e for (_g, e, r) in report.refused if r == report.route)
        if effect_absent is not None:
            outcome["effect_absent"] = bool(effect_absent())
        # where two layers could refuse, the control must be refused by the
        # layer it exists to prove (mutation run on e1d4d14: with the
        # selector policy not forced, the Proactor backstop refused instead)
        expected = EXPECTED_REFUSING_EVENT.get(name)
        outcome["passed"] = (outcome["refused"] and outcome["delta"] >= 1
                             and outcome.get("effect_absent", True)
                             and outcome["containment"] is not None
                             and (expected is None or expected in outcome["events"]))
        results[name] = outcome

    def positive(name: str, guard: str, action: Any) -> None:
        report.route = f"positive:{name}"
        before_ok = report.allowed.get(guard, 0)
        before = report.total()
        try:
            action()
            ok = True
        except Exception as exc:  # noqa: BLE001
            ok = False
            results[name] = {"positive": True, "passed": False, "exception": type(exc).__name__}
            return
        results[name] = {"positive": True, "allowed_delta": report.allowed.get(guard, 0) - before_ok,
                         "refused_delta": report.total() - before,
                         "passed": ok and report.total() == before
                         and report.allowed.get(guard, 0) > before_ok}

    def nothing_accepted() -> bool:
        try:
            listener.accept()[0].close()
            return False
        except BlockingIOError:
            return True

    def closed(kind: int = socket.SOCK_STREAM) -> socket.socket:
        # CPython raises the socket.connect/sendto/bind audit event after
        # parsing the address and BEFORE the OS call; on a closed socket that
        # call then fails (no descriptor), so nothing can leave the machine
        s = socket.socket(socket.AF_INET, kind)
        s.close()
        return s

    import sqlite3
    import asyncio
    # --- write / read (all inside this run) ---------------------------------
    control("write_outside", "write", lambda: open(outside, "w").close(),
            lambda: not outside.exists())
    control("os_open_outside", "write",
            lambda: os.close(os.open(str(outside), os.O_WRONLY | os.O_CREAT)),
            lambda: not outside.exists())
    control("replace_outside", "write",
            lambda: os.replace(str(run / "tmp" / "nothing"), str(outside)),
            lambda: not outside.exists())
    control("unlink_outside", "write", lambda: os.unlink(str(outside)))
    control("mkdir_outside", "write", lambda: os.mkdir(str(outside) + ".d"),
            lambda: not Path(str(outside) + ".d").exists())
    control("rmtree_protected", "write", lambda: shutil.rmtree(str(decoy)),
            lambda: secret.exists())
    control("read_protected", "read", lambda: open(secret, "rb").read())
    control("listdir_protected", "read", lambda: os.listdir(str(decoy)))
    control("copy_from_protected", "read",
            lambda: shutil.copyfile(str(secret), str(run / "tmp" / "stolen.txt")),
            lambda: not (run / "tmp" / "stolen.txt").exists())
    control("sqlite_protected", "read", lambda: sqlite3.connect(str(decoy / "x.db")),
            lambda: not (decoy / "x.db").exists())
    control("sqlite_outside", "write", lambda: sqlite3.connect(str(outside) + ".db"),
            lambda: not Path(str(outside) + ".db").exists())
    # --- process / kill (missing programs; our own child) ------------------
    control("popen", "process", lambda: subprocess.Popen([str(missing_exe)]))
    control("os_system", "process", lambda: os.system("exit 0"))
    control("os_spawn", "process",
            lambda: os.spawnv(os.P_NOWAIT, str(missing_exe), [str(missing_exe)]))
    control("os_startfile", "process",
            lambda: os.startfile(str(absent / "missing.txt")) if os.name == "nt"
            else os.system("true"))
    if os.name == "nt":
        import _winapi
        control("winapi_createprocess", "process", lambda: _winapi.CreateProcess(
            str(missing_exe), f'"{missing_exe}"', None, None, False, 0, None, None, None))
    import signal
    control("os_kill", "kill", lambda: os.kill(own_child.pid, signal.SIGTERM),
            lambda: own_child.poll() is None)
    if os.name == "nt":
        import ctypes
        # 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION: a handle that can read
        # a little about our own child and change nothing
        control("winapi_openprocess", "kill",
                lambda: _winapi.CloseHandle(_winapi.OpenProcess(0x1000, False, own_child.pid)))
        # the symbol LOOKUP is the audited step; nothing is called
        control("ctypes_openprocess", "kill", lambda: ctypes.WinDLL("kernel32").OpenProcess)
        control("ctypes_network_library", "kill", lambda: ctypes.WinDLL("ws2_32"))
        control("ctypes_createfile", "write", lambda: ctypes.WinDLL("kernel32").CreateFileW)
        control("ctypes_registry_write", "registry",
                lambda: ctypes.WinDLL("advapi32").RegSetValueExW)
    # --- egress (closed sockets, or our own loopback listener) --------------
    unroutable = ("192.0.2.1", 9)  # TEST-NET-1, and aimed only at closed sockets
    control("tcp_connect", "egress", lambda: closed().connect(unroutable))
    def tcp_loopback() -> None:
        # a plain connect (create_connection would be refused earlier, at
        # getaddrinfo, and leave the connect rule unexercised)
        s = socket.socket()
        s.settimeout(1)
        try:
            s.connect(own_address)
        finally:
            s.close()

    control("tcp_connect_loopback", "egress", tcp_loopback, nothing_accepted)
    control("udp_connect", "egress", lambda: closed(socket.SOCK_DGRAM).connect(("8.8.8.8", 53)))
    # numeric-only: the audit event fires, and no resolver is ever asked
    control("getaddrinfo", "egress", lambda: socket.getaddrinfo(
        unroutable[0], 80, 0, 0, 0, socket.AI_NUMERICHOST))
    control("bind_non_loopback", "egress", lambda: closed().bind(("0.0.0.0", 0)))
    own_url = f"http://{own_address[0]}:{own_address[1]}/"
    try:
        import httpx
    except ImportError:
        httpx = None
    if httpx is not None:
        control("httpx_sync", "egress",
                lambda: httpx.Client(timeout=1, trust_env=False).get(own_url), nothing_accepted)

        async def async_get() -> None:
            # trust_env=False: no system or environment proxy, so even with the
            # guards off the request can only reach our own listener (review N1)
            async with httpx.AsyncClient(timeout=1, trust_env=False) as c:
                await c.get(own_url)

        control("httpx_async", "egress", lambda: asyncio.run(async_get()), nothing_accepted)

    async def open_conn() -> None:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(*own_address), 1)
        writer.close()

    control("asyncio_default_loop", "egress", lambda: asyncio.run(open_conn()),
            nothing_accepted)
    if os.name == "nt":
        def proactor() -> None:
            loop = asyncio.ProactorEventLoop()
            try:
                loop.run_until_complete(open_conn())
            finally:
                loop.close()
        control("asyncio_proactor_loop", "egress", proactor, nothing_accepted)
    # --- registry (handle 0: the audit event fires, the call cannot) --------
    if os.name == "nt":
        import winreg

        def canary_absent() -> bool:
            try:
                winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_CANARY))
                return False
            except OSError:
                return True
        control("winreg_create", "registry",
                lambda: winreg.CreateKey(0, REGISTRY_CANARY), canary_absent)
        control("winreg_open_write", "registry",
                lambda: winreg.OpenKey(0, "Software", 0, winreg.KEY_SET_VALUE))
    # --- wake (a stand-in supervisor; the arm proves the real one) ----------
    import types
    stub_calls: list[str] = []
    stub = types.SimpleNamespace(**{name: (lambda *a, _n=name, **k: stub_calls.append(_n))
                                    for name in ig.WAKE_ENTRY_POINTS})
    ig.install_wake_guard(stub, report)
    control("wake_send_message", "wake", lambda: stub.send_message("s", "n", "x"))
    control("wake_drive_account_unpark", "wake", lambda: stub.drive_account_unpark("s", "n"))
    control("wake_drive_auth_thaw", "wake", lambda: stub.drive_auth_thaw("s", "n"))
    control("wake_resume_frozen", "wake", lambda: stub.resume_frozen("s"))
    control("wake_deliver_org_inbox", "wake", lambda: stub.deliver_org_inbox("s", "p", "b"))
    control("wake_drive_unfrozen_nonempty", "wake",
            lambda: stub.drive_unfrozen_by_switch("s", ["n"]))
    # --- positive controls: the guard is not simply refusing everything ------
    positive("write_inside", "write", lambda: (run / "tmp" / "ok.txt").write_text("ok"))
    positive("socketpair", "egress", lambda: [s.close() for s in socket.socketpair()])
    positive("bind_loopback", "egress", lambda: socket.socket().bind(("127.0.0.1", 0)))
    positive("read_unprotected", "read", lambda: open(__file__, "rb").read(16))
    positive("wake_notice_passes", "wake", lambda: stub.send_message("s", "n", "x", wake=False))
    positive("wake_drive_unfrozen_empty", "wake",
             lambda: stub.drive_unfrozen_by_switch("s", []))
    listener.close()
    own_child_alive = own_child.poll() is None
    own_child.stdin.close()  # our child exits on its own; nothing is killed
    stub_leaks = [n for n in stub_calls if n != "send_message"]
    required = set(REQUIRED_CONTROLS) | (set(REQUIRED_CONTROLS_NT) if os.name == "nt" else set())
    missing = sorted(required - set(results))
    undeclared = sorted(n for n, r in results.items()
                        if not r.get("positive") and r.get("containment") is None)
    verdict = (all(r["passed"] for r in results.values()) and not stub_leaks and not missing
               and not undeclared and own_child_alive)
    doc = {"tool_version": TOOL_VERSION, "controls": results, "stub_leaks": stub_leaks,
           "missing": missing, "undeclared_containment": undeclared,
           "own_child_alive": own_child_alive, "guards": report.as_json(),
           "verdict": "passed" if verdict else "failed", "control_count": len(results)}
    _write_json(run / "out" / "controls.json", doc)
    return _emit({"controls": doc["verdict"], "count": len(results), "missing": missing,
                  "failed": [k for k, r in results.items() if not r["passed"]]},
                 0 if verdict else EXIT_FAILED)


# ---------------------------------------------------------------------------
# synthetic fixture and writer (gate only; never real data)
# ---------------------------------------------------------------------------

def cmd_fixture_child(args: argparse.Namespace) -> int:
    ig = _load("isolation_guards")
    data = ig.normal(args.data)
    try:
        protected = _child_protected(ig)
        if ig.normal(os.environ.get("ORGTREE_DATA", "")) != data:
            raise ig.RefuseToRun("ORGTREE_DATA does not name the fixture's data root")
        ig.refuse_overlap("fixture", data, protected)
        ig.refuse_overlap("fixture run", ig.normal(args.run), protected)
        report = ig.Report()
        ig.install_audit_guards(ig.Policy(write_roots=[data, ig.normal(args.run)],
                                          protected_roots=protected), report)
        ig.block_native_process_modules()
    except ig.RefuseToRun as exc:
        return _refusal("fixture", str(exc))
    ig.force_selector_loop()
    sys.path[:0] = [ig.normal(args.tree), os.path.join(ig.normal(args.tree), "engine", "backend")]
    from orgtree import store, ledger, supervisor
    ig.install_wake_guard(supervisor, report)
    user = ledger.USER
    decoy_profile = os.path.join(args.decoy, "claude-profile")
    registry = {"version": 1, "aliases": {}, "id_counters": {}, "tint_counters": {},
                "accounts": [{"id": "decoy-account", "provider": "claude", "harness": "claude",
                              "credential": {"kind": "managed", "path": decoy_profile}}]}
    Path(data, "accounts-registry.json").write_text(json.dumps(registry), encoding="utf-8")
    a = store.create_org("p02-fixture-alpha")
    a.hire(user, None, "haiku", 0, "boss", charter="synthetic boss")
    a.hire(user, "boss", "haiku", 0, "kid", charter="synthetic kid")
    a.hire(user, "boss", "haiku", 0, "gone", charter="archived seat")
    a.retire(user, "gone")
    a.post_mail(user, "boss", "queued synthetic mail", "message")
    a.post_mail("boss", "kid", "queued synthetic mail two", "message")
    if args.decoy_pid:
        a.node("boss")["remote_controlled"] = {"pid": int(args.decoy_pid)}
    a.node("kid")["account"] = "decoy-account"
    # a session id makes the chat read look for the transcript under the
    # account's (decoy, protected) profile root, through product code
    a.node("kid")["session_id"] = "0d5e1c9a-p02-decoy-session"
    store.save_org(a)
    b = store.create_org("p02-fixture-beta")
    b.hire(user, None, "haiku", 0, "lead", charter="synthetic lead")
    b.hire(user, "lead", "haiku", 0, "helper", charter="synthetic helper")
    store.save_org(b)
    # THE REALISTIC LIVE-PATH VECTOR. The copied transcript-records sidecar
    # retains each source's ABSOLUTE transcript path; on a real copy those
    # point into the live profiles. Here one points into the decoy protected
    # folder, so the replay's chat read reaches it through product code.
    from orgtree import transcript_records, chat_window
    decoy_transcript = os.path.join(args.decoy, "claude-profile", "projects", "p",
                                    "decoy.jsonl")
    with transcript_records.database() as conn:
        conn.execute("INSERT OR REPLACE INTO transcript_sources VALUES (?,?,?,?,?,?)",
                     (chat_window.source_key(store.load_org("p02-fixture-alpha"), "boss"),
                      decoy_transcript, 0, None, 0, 0))
        conn.commit()
    for slug in ("p02-fixture-alpha", "p02-fixture-beta"):
        store._POOL.close_all(slug)
    return _emit({"fixture": "built", "orgs": 2, "refused_total": report.total(),
                  "refused": report.as_json()["refused"]}, 0)


def cmd_writer(args: argparse.Namespace) -> int:
    """A synthetic live writer for the copy proof (review A2): per-call
    connections on a sidecar (the live engine's pattern that deletes -wal on
    last close) and one pooled connection on an org database.

    ``synchronous=OFF`` is a deliberate stress, not the product's setting
    (its sidecars use FULL): on a slow disk a FULL writer manages about five
    commits a second, which almost never lands inside a copy that takes a
    few milliseconds, so change detection would go unexercised."""
    ig = _load("isolation_guards")
    target = ig.normal(args.target)
    report = ig.Report()
    try:
        protected = _child_protected(ig)
        ig.refuse_overlap("writer target", target, protected)
        ig.install_audit_guards(ig.Policy(write_roots=[target], protected_roots=protected),
                                report)
    except ig.RefuseToRun as exc:
        return _refusal("writer", str(exc))
    import sqlite3
    sidecar = os.path.join(target, "tool-waits.db")
    org_db = os.path.join(target, "orgs", args.org_db)
    pooled = sqlite3.connect(org_db, timeout=10)
    pooled.execute("PRAGMA journal_mode=WAL")
    pooled.execute("PRAGMA synchronous=OFF")
    pooled.execute("CREATE TABLE IF NOT EXISTS p02_writer (i INTEGER, pad BLOB)")
    deadline = time.monotonic() + args.seconds
    writes = 0
    while time.monotonic() < deadline:
        conn = sqlite3.connect(sidecar, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("CREATE TABLE IF NOT EXISTS p02_writer (i INTEGER, pad BLOB)")
        conn.execute("INSERT INTO p02_writer VALUES (?, ?)", (writes, os.urandom(4096)))
        conn.commit()
        conn.close()
        pooled.execute("INSERT INTO p02_writer VALUES (?, ?)", (writes, os.urandom(4096)))
        pooled.commit()
        writes += 1
        time.sleep(args.interval)
    pooled.close()
    return _emit({"writer": "done", "writes": writes, "refused_total": report.total()}, 0)


# ---------------------------------------------------------------------------
# gate: the pre-copy proof on synthetic data (plan §4)
# ---------------------------------------------------------------------------

def _listing(root: Path) -> dict[str, list[int]]:
    out = {}
    if not root.exists():
        return out
    for path in sorted(root.rglob("*")):
        if path.is_file():
            st = path.stat()
            out[str(path.relative_to(root))] = [st.st_size, st.st_mtime_ns]
    return out


def _git_status(tree: str) -> str:
    # --no-optional-locks: status must not refresh the arm tree's index (N3)
    return subprocess.run(["git", "--no-optional-locks", "-C", tree, "status", "--porcelain"],
                          capture_output=True,
                          text=True, check=True).stdout


def cmd_gate(args: argparse.Namespace) -> int:
    ig = _load("isolation_guards")
    run = Path(ig.normal(args.run))
    try:
        pinned, protected = _protected_from_env(ig, [])
        ig.refuse_overlap("gate run", str(run), protected)
    except ig.RefuseToRun as exc:
        return _refusal("gate", str(exc))
    if run.exists() and any(run.iterdir()):
        return _refusal("gate", "the gate run folder must be new or empty")
    python = Path(args.python or sys.executable)
    decoy = run / "decoy-live"
    (decoy / "claude-profile" / "projects").mkdir(parents=True)
    (decoy / "secret.txt").write_text("decoy secret", encoding="utf-8")
    # an EXISTING transcript, as a live one would be (product code stats the
    # file first, which no audit event sees, and only then opens it)
    (decoy / "claude-profile" / "projects" / "p").mkdir(parents=True)
    (decoy / "claude-profile" / "projects" / "p" / "decoy.jsonl").write_text(
        json.dumps({"type": "user", "uuid": "decoy-1", "timestamp": "2026-09-23T00:00:00Z",
                    "message": {"role": "user", "content": "decoy transcript"}}) + chr(10),
        encoding="utf-8")
    source = run / "source" / "data"
    source.mkdir(parents=True)
    (run / "logs").mkdir()
    (run / "out").mkdir()
    checks: dict[str, Any] = {}
    trees = {"B": args.tree}
    if args.tree_a:
        trees["A"] = args.tree_a
    git_before = {k: _git_status(t) for k, t in trees.items()}
    decoy_proc = subprocess.Popen([str(python), "-I", "-c", "import time; time.sleep(3600)"])
    try:
        base_protected = protected + [ig.normal(decoy)]
        env = child_env(pinned, base_protected, run, source, python)
        code, last = _child(python, "_fixture-child",
                            ["--tree", args.tree, "--data", str(source), "--run", str(run / "logs"),
                             "--decoy", str(decoy), "--decoy-pid", str(decoy_proc.pid)],
                            env, run / "logs" / "fixture.log", args.timeout)
        checks["fixture"] = {"exit": code, "child": last, "passed": code == 0}
        decoy_listing = _listing(decoy)
        # ---- step 4: the copy tool against a live synthetic writer -----------
        org_db = "p02-fixture-alpha.db"
        writer_env = child_env(pinned, base_protected, run, source, python)
        snap_argv = ["--source", str(source), "--protect", str(source), "--protect", str(decoy),
                     "--tries", "3", "--wait", "0.5"]
        # A race by nature, so up to three attempts, EVERY one recorded; the
        # check needs change detection to fire at least once and every
        # attempt to finish with zero guard refusals.
        busy_attempts = []
        for n_try in range(1, 4):
            writer = subprocess.Popen(
                [str(python), "-I", "-B", str(Path(__file__).resolve()), "_writer",
                 "--target", str(source), "--org-db", org_db, "--seconds", "8",
                 "--interval", "0"], env=writer_env, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True)
            time.sleep(1.0)
            busy_code, busy = _child(python, "snapshot",
                                     snap_argv + ["--run", str(run / f"copy-busy-{n_try}")],
                                     dict(os.environ), run / "logs" / f"snapshot-busy-{n_try}.log",
                                     args.timeout)
            writer_out = writer.communicate(timeout=120)[0]
            busy_classes = (busy or {}).get("classes", {})
            moved = sum(c.get("retries", 0) + c.get("skipped", 0) for c in busy_classes.values())
            busy_attempts.append({"exit": busy_code, "classes": busy_classes, "moved": moved,
                                  "refused_total": (busy or {}).get("refused_total"),
                                  "writer": writer_out.strip().splitlines()[-1:]})
            if moved:
                break
        checks["copy_busy"] = {"attempts": busy_attempts,
                               "change_detection_fired": any(a["moved"] for a in busy_attempts),
                               "passed": any(a["moved"] for a in busy_attempts)
                               and all(a["exit"] == 0 and a["refused_total"] == 0
                                       for a in busy_attempts)}
        before = _listing(source)
        quiet_code, quiet = _child(python, "snapshot", snap_argv + ["--run", str(run / "copy")],
                                   dict(os.environ), run / "logs" / "snapshot.log", args.timeout)
        after = _listing(source)
        quiet_classes = (quiet or {}).get("classes", {})
        checks["copy_quiet"] = {
            "exit": quiet_code, "classes": quiet_classes,
            "source_unchanged": before == after,
            "no_wal_shm_created": not any(k.endswith(("-shm",)) for k in set(after) - set(before)),
            "passed": quiet_code == 0 and before == after
            and all(c["skipped"] == 0 for c in quiet_classes.values())
            and quiet_classes.get("org_db", {}).get("copied", 0) == 2}
        journal = source / "orgs" / "p02-fixture-beta.db-journal"
        journal.write_bytes(b"")
        j_code, j = _child(python, "snapshot", snap_argv + ["--run", str(run / "copy-journal")],
                           dict(os.environ), run / "logs" / "snapshot-journal.log", args.timeout)
        journal.unlink()
        reasons = (j or {}).get("classes", {}).get("org_db", {}).get("skipped_reasons", {})
        checks["copy_journal"] = {"exit": j_code, "reasons": reasons,
                                  "passed": j_code == 0 and reasons.get("journal") == 1}
        master = run / "copy" / "master" / "data"
        # ---- step 1 + 5: replay arms on fresh copies of the master ----------
        arms = [("A", trees["A"])] if "A" in trees else []
        arms += [("B", args.tree), ("C", args.tree)]
        arm_results = {}
        # the arms get their OWN run folder: the harness refuses a run folder
        # that contains a protected location, and the decoy lives in `run`
        replay = run / "replay"

        def run_arm(arm: str, tree: str, rnd: int, expect: Path | None) -> dict[str, Any]:
            fixture = replay / "arms" / f"{rnd}-{arm}" / "data"
            shutil.copytree(master, fixture)
            argv = ["arm", "--tree", tree, "--arm", arm, "--round", str(rnd), "--run",
                    str(replay), "--data", str(fixture), "--n", str(args.n), "--seed", "7",
                    "--protect", str(decoy), "--decoy-pid", str(decoy_proc.pid),
                    "--timeout", str(args.timeout)]
            if expect is not None:
                argv += ["--expect", str(expect)]
            if args.python:
                argv += ["--python", args.python]
            proc = subprocess.run([str(python), "-I", "-B", str(Path(__file__).resolve()), *argv],
                                  capture_output=True, text=True, timeout=args.timeout + 60)
            doc_path = replay / "out" / f"arm-{arm}-{rnd}.json"
            doc = json.loads(doc_path.read_text(encoding="utf-8")) if doc_path.exists() else {}
            return {"exit": proc.returncode, "verdict": doc.get("verdict"),
                    "gates": doc.get("gates"),
                    "refused": doc.get("guards", {}).get("refused"),
                    "refusal_details": doc.get("guards", {}).get("details"),
                    "provenance": doc.get("provenance"),
                    "native_blocked": doc.get("native_blocked"),
                    "observed": doc.get("census", {}).get("observed_in_window"),
                    "orchestrator_tail": proc.stdout[-600:]}

        # Pass 1 DISCOVERS what the product refuses on synthetic data (every
        # refusal is named by its product function for review); pass 2 must
        # then be `measured` with exactly that set expected. The real run
        # passes the same per-arm file, so a refusal the synthetic data never
        # produced stops it.
        for arm, tree in arms:
            first = run_arm(arm, tree, 1, None)
            discovered = sorted({(r["guard"], r["event"], r["route"])
                                 for r in (first["refused"] or [])
                                 if r["route"] != "post-control"})
            expect_file = run / "out" / f"expected-refusals-{arm}.json"
            _write_json(expect_file, [list(x) for x in discovered])
            second = run_arm(arm, tree, 2, expect_file)
            other_gates = {k: v for k, v in (first["gates"] or {}).items()
                           if k != "no_unexpected_refusal"}
            second_keys = sorted({(r["guard"], r["event"], r["route"])
                                  for r in (second["refused"] or [])
                                  if r["route"] != "post-control"})
            arm_results[arm] = {
                "discovery": first, "confirm": second,
                "expected_refusals": [list(x) for x in discovered],
                "repeatable": second_keys == discovered,
                "passed": bool(other_gates) and all(other_gates.values())
                and second["exit"] == 0 and second["verdict"] == "measured"
                and second_keys == discovered}
        checks["arms"] = arm_results
        c_found = arm_results.get("C", {}).get("expected_refusals", [])
        checks["decoy_path_read_refused"] = {
            "passed": any(g == "read" and r == "chat" for g, _e, r in c_found),
            "note": "a copied account names a transcript root inside the decoy protected "
                    "folder; the chat read must reach it through product code and be refused"}
        # ---- step 2: negative controls ---------------------------------------
        c_code, c_last = _child(python, "controls",
                                ["--run", str(run / "controls"), "--protect", str(decoy)],
                                dict(os.environ), run / "logs" / "controls.log", args.timeout)
        checks["controls"] = {"exit": c_code, "child": c_last, "passed": c_code == 0}
        # ---- step 3: root pinning --------------------------------------------
        inside = decoy / "data"
        inside.mkdir()
        a_code, a_last = _child(python, "arm", ["--tree", args.tree, "--arm", "C", "--run",
                                                str(decoy), "--data", str(inside), "--protect",
                                                str(decoy)],
                                dict(os.environ), run / "logs" / "pin-a.log", args.timeout)
        checks["pin_harness_refuses"] = {"exit": a_code, "child": a_last,
                                         "passed": a_code == EXIT_REFUSED
                                         and (a_last or {}).get("load_app_called") is False}
        # the guarded child refuses on its own too, from ORGTREE_AGENT_PARENT_DATA
        env_b = child_env({"live": [str(decoy)], "legacy": []}, [], run, inside, python)
        b_code, b_last = _child(python, "_arm-child",
                                ["--tree", args.tree, "--arm", "C", "--run", str(decoy),
                                 "--data", str(inside), "--out", str(run / "out" / "pin-b.json")],
                                env_b, run / "logs" / "pin-child.log", args.timeout)
        checks["pin_child_refuses"] = {"exit": b_code, "child": b_last,
                                       "passed": b_code == EXIT_REFUSED
                                       and (b_last or {}).get("load_app_called") is False}
        fake_appdata = run / "fake-appdata"
        fake_live = fake_appdata / "Orgtree v2" / "data"
        (fake_live / "x").mkdir(parents=True)
        env_c = {k: v for k, v in os.environ.items()
                 if k not in ("ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA")}
        env_c["APPDATA"] = str(fake_appdata)
        c3_code, c3_last = _child(python, "arm", ["--tree", args.tree, "--arm", "C", "--run",
                                                  str(fake_live), "--data", str(fake_live / "x")],
                                  env_c, run / "logs" / "pin-c.log", args.timeout)
        checks["pin_without_variables"] = {"exit": c3_code, "child": c3_last,
                                           "passed": c3_code == EXIT_REFUSED}
        # ---- containment evidence --------------------------------------------
        checks["decoy_alive"] = {"passed": decoy_proc.poll() is None}
        checks["decoy_unchanged"] = {"passed": _listing(decoy) == decoy_listing}
        checks["home_empty"] = {"passed": (replay / "home").is_dir()
                                and not any((replay / "home").rglob("*"))}
        checks["trees_unchanged"] = {"passed": {k: _git_status(t) for k, t in trees.items()}
                                     == git_before}
        privacy = privacy_scan(replay, [str(decoy), str(source), str(run)])
        checks["privacy_clean"] = {"scan": privacy, "passed": privacy["verdict"] == "clean"
                                   and privacy["files_checked"] > 0
                                   and privacy["identifiers"] > 0}
    finally:
        decoy_proc.kill()
        decoy_proc.wait(timeout=30)
    verdict = all(v.get("passed") for k, v in checks.items() if k != "arms") and all(
        a["passed"] for a in checks["arms"].values())
    doc = {"tool_version": TOOL_VERSION, "verdict": "passed" if verdict else "failed",
           "checks": checks, "harness_commit": tree_commit(HARNESS_ROOT),
           "not_checked": ["operator %TEMP% listing: other processes on this machine write "
                           "there continuously; the arm's TEMP is inside the run and the "
                           "write guard's outside-allowlist count is the evidence instead"]}
    _write_json(run / "out" / "gate-verdict.json", doc)
    return _emit({"gate": doc["verdict"],
                  "failed": [k for k, v in checks.items() if k != "arms" and not v.get("passed")]
                  + [f"arm-{k}" for k, a in checks["arms"].items() if not a["passed"]]},
                 0 if verdict else EXIT_FAILED)


# ---------------------------------------------------------------------------
# privacy check (plan §3)
# ---------------------------------------------------------------------------

SECRET_SHAPES = re.compile(r"sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[abp]-|Bearer\s+\S+"
                           r"|[A-Za-z0-9+/]{60,}={0,2}|[0-9a-f]{64,}")


def privacy_scan(run: Path, extra_paths: list[str]) -> dict[str, Any]:
    """Grep every file under ``run/out`` for the copy's identifiers (slugs,
    node ids, node names — read from ``run/logs``, which never leaves), for
    the given paths in both slash forms, for ``@``-addresses and for common
    secret shapes. Identifiers match as WHOLE tokens; JSON's doubled
    backslashes are undone first so an escaped path still matches."""
    identifiers: set[str] = set()
    for path in (run / "logs").glob("identifiers-*.json"):
        identifiers.update(str(x) for x in json.loads(path.read_text(encoding="utf-8")))
    words = sorted({x.lower() for x in identifiers if len(x) >= 3}, key=len, reverse=True)
    pattern = (re.compile(r"(?<![a-z0-9_-])(?:" + "|".join(re.escape(w) for w in words)
                          + r")(?![a-z0-9_-])") if words else None)
    path_needles = set()
    for value in [str(run), *extra_paths]:
        for form in (value, value.replace("\\", "/")):
            if len(form) >= 6:
                path_needles.add(form.lower())
    files = [p for p in sorted((run / "out").rglob("*")) if p.is_file()]
    hits: dict[str, dict[str, int]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        flat = text.replace("\\\\", "\\").lower()
        kinds: dict[str, int] = {}
        if pattern is not None:
            found = pattern.findall(flat)
            if found:
                kinds["identifier"] = len(found)
        n = sum(1 for needle in path_needles if needle in flat)
        if n:
            kinds["path"] = n
        at = re.findall(r"@[a-z0-9][a-z0-9-]*", flat)
        if at:
            kinds["address"] = len(at)
        secrets_found = SECRET_SHAPES.findall(text)
        if secrets_found:
            kinds["secret_shape"] = len(secrets_found)
        if kinds:
            hits[path.name] = kinds
    return {"files_checked": len(files), "identifiers": len(words),
            "paths": len(path_needles), "hits": hits,
            "verdict": "clean" if not hits else "hits"}


def cmd_privacy(args: argparse.Namespace) -> int:
    """Plan §3: run before anything leaves ``out``. The pinned live and
    legacy roots are always searched for, in addition to ``--path``."""
    ig = _load("isolation_guards")
    extra = list(args.path or [])
    try:
        pinned = ig.pinned_protected_roots(os.environ)
        extra += list(pinned["live"]) + list(pinned["legacy"])
    except ig.RefuseToRun as exc:
        return _refusal("privacy-check", str(exc))
    doc = privacy_scan(Path(args.run), extra)
    if doc["identifiers"] == 0:
        return _refusal("privacy-check", "no identifier list in logs: the check would "
                        "search for nothing, so it refuses to call the output clean")
    print(json.dumps(doc), flush=True)
    return 0 if doc["verdict"] == "clean" else EXIT_FAILED


# ---------------------------------------------------------------------------
# replay: the real A/B/C rounds (plan §8), after the gate and the copy
# ---------------------------------------------------------------------------

def _baseline_suite_running() -> bool:
    """The standing concurrency rule: never overlap a test-baseline run."""
    if os.name != "nt":
        return False
    query = ("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object "
             "{ $_.CommandLine -like '*test-baseline*' } | Measure-Object | "
             "Select-Object -ExpandProperty Count")
    proc = subprocess.run(["powershell", "-NoProfile", "-Command", query],
                          capture_output=True, text=True, timeout=120)
    try:
        return int(proc.stdout.strip() or "0") > 0
    except ValueError:
        return True  # unknown is treated as busy


def cmd_replay(args: argparse.Namespace) -> int:
    ig = _load("isolation_guards")
    try:
        pinned, protected = _protected_from_env(ig, args.protect)
        run, master = Path(ig.normal(args.run)), Path(ig.normal(args.master))
        ig.refuse_overlap("run", str(run), protected)
        if not ig.within(str(master), str(run)):
            raise ig.RefuseToRun("the master copy must be inside the run folder")
    except ig.RefuseToRun as exc:
        return _refusal("replay", str(exc))
    expect = {arm: Path(args.expect_dir) / f"expected-refusals-{arm}.json" for arm in "ABC"}
    missing = [arm for arm, path in expect.items() if not path.is_file()]
    if missing or not master.is_dir():
        return _refusal("replay", "the master copy or an arm's expected-refusal file "
                        "(from the passing synthetic gate) is missing", missing=missing)
    trees = {"A": args.tree_a, "B": args.tree, "C": args.tree}
    python = args.python or sys.executable
    runs: list[dict[str, Any]] = []
    stopped = None
    for rnd in range(1, args.rounds + 1):
        order = ["A", "B", "C"][(rnd - 1) % 3:] + ["A", "B", "C"][:(rnd - 1) % 3]
        for arm in order:
            waited = 0.0
            while _baseline_suite_running():
                if waited >= args.wait_limit:
                    stopped = f"a test-baseline run kept the machine busy for {waited:.0f}s"
                    break
                time.sleep(60)
                waited += 60
            if stopped:
                break
            fixture = run / "arms" / f"{rnd}-{arm}" / "data"
            shutil.copytree(master, fixture)
            argv = ["arm", "--tree", trees[arm], "--arm", arm, "--round", str(rnd),
                    "--run", str(run), "--data", str(fixture), "--n", str(args.n),
                    "--seed", str(args.seed), "--expect", str(expect[arm]),
                    "--timeout", str(args.timeout), "--python", python]
            for extra in args.protect:
                argv += ["--protect", extra]
            proc = subprocess.run([python, "-I", "-B", str(Path(__file__).resolve()), *argv],
                                  capture_output=True, text=True, timeout=args.timeout + 120)
            doc_path = run / "out" / f"arm-{arm}-{rnd}.json"
            doc = json.loads(doc_path.read_text(encoding="utf-8")) if doc_path.exists() else {}
            runs.append({"round": rnd, "arm": arm, "exit": proc.returncode,
                         "verdict": doc.get("verdict"), "waited_s": waited})
            if proc.returncode != 0 or doc.get("verdict") != "measured":
                stopped = f"round {rnd} arm {arm} did not measure (stop condition)"
                break
        if stopped:
            break
    summary = _ab_summary(run, runs) if not stopped else {}
    doc = {"tool_version": TOOL_VERSION, "runs": runs, "stopped": stopped,
           "rounds": args.rounds, "n": args.n, "summary": summary,
           "label": "representative copied-data / replayed-workload measurement, "
                    "in-process without a server and under audit hooks; not observed "
                    "live behaviour and not product overhead"}
    _write_json(run / "out" / "ab-summary.json", doc)
    return _emit({"replay": "stopped" if stopped else "done", "stopped": stopped,
                  "runs": len(runs)}, EXIT_FAILED if stopped else 0)


def _ab_summary(run: Path, runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-arm medians/p90 per class, round 1 discarded (cold cache), and an
    equal-work check: every arm must have done the same attempts with the
    same outcomes, or its latencies are not comparable (charter rule)."""
    per_arm: dict[str, dict[str, list[float]]] = {}
    handler: dict[str, dict[str, list[float]]] = {}
    work: dict[str, set[str]] = {}
    for r in runs:
        doc = json.loads((run / "out" / f"arm-{r['arm']}-{r['round']}.json")
                         .read_text(encoding="utf-8"))
        work.setdefault(r["arm"], set()).add(json.dumps(doc["script"]["per_class"],
                                                        sort_keys=True))
        if r["round"] == 1:
            continue
        for cls, values in doc["timing"]["raw_ms"].items():
            per_arm.setdefault(r["arm"], {}).setdefault(cls, []).extend(values)
        for cls, pairs in doc["timing"]["access_handler_total_ms"].items():
            handler.setdefault(r["arm"], {}).setdefault(cls, []).extend(p[0] for p in pairs)
    table = {arm: {cls: {"n": len(v), "median_ms": statistics.median(v),
                         "p90_ms": _pct(v, 0.9),
                         "handler_median_ms": (statistics.median(handler[arm][cls])
                                               if handler.get(arm, {}).get(cls) else None)}
                   for cls, v in sorted(classes.items())}
             for arm, classes in sorted(per_arm.items())}
    all_work = set().union(*work.values()) if work else set()
    return {"per_arm": table, "equal_work": len(all_work) == 1,
            "rounds_discarded": [1]}


# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    sys.dont_write_bytecode = True
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--source", required=True)
    s.add_argument("--run", required=True)
    s.add_argument("--orgs", default="all")
    s.add_argument("--protect", action="append", default=[])
    s.add_argument("--tries", type=int, default=3)
    s.add_argument("--wait", type=float, default=2.0)
    for name in ("arm", "_arm-child"):
        a = sub.add_parser(name)
        a.add_argument("--tree", required=True)
        a.add_argument("--arm", choices=("A", "B", "C"), required=True)
        a.add_argument("--round", type=int, default=1)
        a.add_argument("--run", required=True)
        a.add_argument("--data", required=True)
        a.add_argument("--n", type=int, default=2000)
        a.add_argument("--seed", type=int, default=20260923)
        a.add_argument("--max-orgs", type=int, default=8)
        a.add_argument("--max-seats", type=int, default=6)
        a.add_argument("--expect")
        a.add_argument("--decoy-pid", type=int)
        if name == "arm":
            a.add_argument("--protect", action="append", default=[])
            a.add_argument("--python")
            a.add_argument("--timeout", type=float, default=3600)
        else:
            a.add_argument("--out", required=True)
    c = sub.add_parser("controls")
    c.add_argument("--run", required=True)
    c.add_argument("--protect", action="append", default=[])
    f = sub.add_parser("_fixture-child")
    f.add_argument("--tree", required=True)
    f.add_argument("--data", required=True)
    f.add_argument("--run", required=True)
    f.add_argument("--decoy", required=True)
    f.add_argument("--decoy-pid", type=int)
    w = sub.add_parser("_writer")
    w.add_argument("--target", required=True)
    w.add_argument("--org-db", required=True)
    w.add_argument("--seconds", type=float, default=30)
    w.add_argument("--interval", type=float, default=0.01)
    g = sub.add_parser("gate")
    g.add_argument("--run", required=True)
    g.add_argument("--tree", required=True)
    g.add_argument("--tree-a")
    g.add_argument("--n", type=int, default=200)
    g.add_argument("--python")
    g.add_argument("--timeout", type=float, default=900)
    r = sub.add_parser("replay")
    r.add_argument("--master", required=True)
    r.add_argument("--run", required=True)
    r.add_argument("--tree", required=True)
    r.add_argument("--tree-a", required=True)
    r.add_argument("--expect-dir", required=True)
    r.add_argument("--rounds", type=int, default=5)
    r.add_argument("--n", type=int, default=2000)
    r.add_argument("--seed", type=int, default=20260923)
    r.add_argument("--protect", action="append", default=[])
    r.add_argument("--python")
    r.add_argument("--timeout", type=float, default=3600)
    r.add_argument("--wait-limit", type=float, default=7200)
    pc = sub.add_parser("privacy-check")
    pc.add_argument("--run", required=True)
    pc.add_argument("--path", action="append")
    args = p.parse_args(argv)
    # children run in other folders, so a relative tree would name a
    # different checkout there and fail the provenance check
    for attr in ("tree", "tree_a"):
        if getattr(args, attr, None):
            setattr(args, attr, os.path.abspath(getattr(args, attr)))
    handler ={"snapshot": cmd_snapshot, "arm": cmd_arm, "_arm-child": cmd_arm_child,
               "controls": cmd_controls, "_fixture-child": cmd_fixture_child,
               "_writer": cmd_writer, "gate": cmd_gate, "privacy-check": cmd_privacy,
               "replay": cmd_replay}[args.cmd]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
