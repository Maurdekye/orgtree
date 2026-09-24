"""P02: per-operation contact records for the four P01 tool families.

Runs every P01 contract variant of the reservation, material-read,
structural-diagnostic and isolated-preview families ONCE COLD AND ONCE WARM
through the real ``/api/agent`` door, with the operation census on, and
writes one record per operation: which tables were read and written, which
statement kinds ran, connection checkouts and connects, transaction
membership of every write, sidecar stores touched, hidden/late/unattributed
steps, file-system, process and network contacts, and the HTTP outcome.

SYNTHETIC DATA ONLY. Every organization, credential, transcript and scratch
file is created here, under a fresh temporary root; HOME/USERPROFILE point
inside it. The live and legacy Orgtree roots are pinned from the environment
BEFORE that redirect and are protected by the isolation audit guards
(``tests/isolation_guards.py``), which also refuse every process start and
network connect — a refused attempt is itself recorded as the operation's
contact, and the row says whether the refusal changed the outcome. The app's
lifespan is never started; wakes and mail delivery are spies (counted, not
run), as in the P01 boundary tests.

WHERE EACH NUMBER COMES FROM, so a reader knows which is observation:
  census    the product's own operation census (``census.py``/
            ``census_contacts.py``): the attempt record's ``db`` block —
            statement kinds, checkouts, connects, engine/hidden steps and the
            per-sidecar breakdown. Product code, unchanged.
  harness   a wrapper around ``census_contacts._run`` installed IN THIS
            PROCESS ONLY: it sees each observed statement's SQL text, keeps
            nothing of it but the table names that appear in the closed set
            read from the stores' own ``sqlite_master`` (anything else is
            ``other``), and reads ``in_transaction`` after every write. Its
            statement count must equal the census's for the same attempt —
            that equality is checked per row (``harness_matches_census``).
  audit     an audit hook in this process counting file opens/listings/
            creations/removals, ``sqlite3.connect`` (EVERY connect, including
            sites the census does not instrument), process starts and
            socket calls, attributed to the operation that was running.
  guards    ``isolation_guards`` refusals, attributed the same way.

LIMITS, carried into the output: statements only (no rows, pages, IO or
lock wait); SQLite's own file IO is native and invisible to audit hooks
(its connects are not); one synthetic fixture per family; one process, one
machine; the census is the product's, the table map and audit counts are the
harness's. This does not claim complete coverage of any contract.

usage: python -I -B tools/p02_operation_contacts.py --out <dir> [--work <dir>]
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
TOOL_VERSION = 1
SCHEMA = "orgtree.p02-operation-contacts/v1"
RESERVATION_TOOLS = ("orgtree_reservation", "orgtree_resource_reservation")
WRITE_KINDS = {"insert", "update", "delete", "replace", "ddl"}
READ_KINDS = {"select", "with"}
TX_KINDS = {"begin", "commit", "rollback", "savepoint", "release"}
LIMITS = [
    "Statements only: no rows examined, pages, physical IO or lock wait is measured.",
    "Tables come from the harness's SQL-text map onto the stores' own sqlite_master "
    "names; a name outside that set is reported as 'other'.",
    "SQLite's own file IO is native and not seen by audit hooks; every "
    "sqlite3.connect is.",
    "Process starts and network connects are REFUSED by the isolation guards "
    "and recorded as attempted contacts; their real effect is not executed.",
    "Wakes and mail delivery are spies: a call is counted, never delivered.",
    "audit.harness_event_loop is the in-process test client's loopback socketpair "
    "(one per request); it is harness plumbing, not a product network contact.",
    "Transaction membership: on an autocommit connection (store.autocommit true, the "
    "primary store) in_transaction after a write means an explicit BEGIN; on a "
    "connection with Python's default isolation (autocommit false) a DML statement "
    "opens an implicit transaction, so it reads as 'in a transaction' either way.",
    "The table map reads names after FROM/JOIN/INTO/UPDATE/TABLE/DELETE FROM/REPLACE "
    "INTO: CREATE INDEX ... ON t yields no table, and a WITH ... INSERT is classified "
    "'with', so its target is listed as read.",
    "File-system and connect counts are attributed by time window: work a "
    "background thread does while an operation runs is credited to it.",
    "Synthetic fixtures, one per family, one process, one machine. Not a "
    "complete coverage claim for any contract.",
]


# ---------------------------------------------------------------------------
# harness observers
# ---------------------------------------------------------------------------

_TABLE_RE = re.compile(
    r"\b(?:from|join|into|update|table(?:\s+if\s+(?:not\s+)?exists)?|"
    r"delete\s+from|replace\s+into)\s+[\"`\[]?([A-Za-z_][A-Za-z0-9_]*)", re.I)
_STRIP_RE = re.compile(r"'(?:[^']|'')*'|--[^\n]*|/\*.*?\*/", re.S)


class Collector:
    """Everything the harness sees for ONE operation. Shared by the SQL
    wrapper and the audit hook; the harness swaps it per operation."""

    def __init__(self, label: str, slug: "str | None" = None) -> None:
        self.label = label
        self.slug = slug
        self.lock = threading.Lock()
        self.statements: list[dict[str, Any]] = []
        self.audit: dict[str, dict[str, int]] = {}
        self.tallies: set[int] = set()
        self.unbound_statements = 0

    def statement(self, row: dict[str, Any]) -> None:
        with self.lock:
            self.statements.append(row)

    def count(self, group: str, key: str) -> None:
        with self.lock:
            bucket = self.audit.setdefault(group, {})
            bucket[key] = bucket.get(key, 0) + 1


_CURRENT: "Collector | None" = None
_BETWEEN = Collector("between-operations")
_TABLES: set[str] = set()


def tables_in(sql: Any, kind: str) -> tuple[list[str], list[str]]:
    """(read, written) table names from one statement, mapped onto the closed
    ``_TABLES`` set; anything else becomes ``other``. The target of an
    insert/update/delete/replace/ddl is written; every other name is read."""
    if not isinstance(sql, str):
        return [], []
    text = _STRIP_RE.sub(" ", sql)
    names = []
    for m in _TABLE_RE.finditer(text):
        name = m.group(1).lower()
        if name in ("select", "values", "set", "where"):
            continue
        names.append(name)
    if not names:
        return [], []
    if kind in WRITE_KINDS:
        return sorted(set(names[1:]) - {names[0]}), [names[0]]
    return sorted(set(names)), []


def install_sql_observer(contacts: Any) -> Callable[[], None]:
    """Wrap ``census_contacts._run`` (a module global every observed cursor
    and connection method calls) so the harness sees each statement's SQL and
    store label. The statement runs exactly as before."""
    original = contacts._run

    def observed(conn: Any, sql: Any, call: Callable[[], Any]) -> Any:
        target = _CURRENT
        if target is None or not contacts._capture_on():
            return original(conn, sql, call)
        kind = contacts.kind_of(sql)
        read, written = tables_in(sql, kind)
        tally = contacts.current()
        failed = False
        try:
            return original(conn, sql, call)
        except BaseException:
            failed = True
            raise
        finally:
            try:
                in_tx = bool(conn.in_transaction)
            except Exception:                                   # noqa: BLE001
                in_tx = None
            try:
                autocommit = conn.isolation_level is None
            except Exception:                                   # noqa: BLE001
                autocommit = None
            target.statement({
                "autocommit": autocommit,
                "store": getattr(conn, "_census_label", None) or "primary",
                "kind": kind, "read": read, "written": written, "failed": failed,
                "in_transaction_after": in_tx if kind in WRITE_KINDS else None,
                "tally": id(tally) if tally is not None else None})

    contacts._run = observed
    return lambda: setattr(contacts, "_run", original)


def install_audit_counter(root: Path, data: Path, home: Path) -> None:
    """Count file, connect, process and socket events for the running
    operation. Paths are reduced to a closed category; nothing else kept."""
    root_s, data_s, home_s = (str(p).lower() for p in (root, data, home))
    code_roots = tuple({str(ROOT).lower(), sys.prefix.lower(), sys.base_prefix.lower()})

    def category(path: Any, own: "str | None" = None) -> str:
        if isinstance(path, (bytes, bytearray)):
            path = path.decode("utf-8", "replace")
        if isinstance(path, int) or path is None:
            return "descriptor"
        p = str(path).replace("/", "\\").lower()
        if p.startswith("file:"):
            p = p[5:].lstrip("\\")
        if p.startswith(data_s):
            rest = p[len(data_s):].lstrip("\\")
            if rest.startswith("orgs\\"):
                # org-store locality: the operation's own org, or another one
                stem = rest[5:].split("\\", 1)[0].split(".", 1)[0]
                return "data:org-db" if own is None else                     ("data:org-db:own" if stem == own.lower() else "data:org-db:foreign")
            if rest.startswith("scratch\\"):
                return "data:scratch"
            head = rest.split("\\", 1)[0]
            if head.endswith((".sqlite3", ".db", "-wal", "-shm", "-journal")):
                return "data:sidecar-db"
            return "data:other"
        if p.startswith(home_s):
            rest = p[len(home_s):].lstrip("\\")
            return "home:provider" if rest.startswith((".claude", ".codex", ".gemini")) \
                else "home:other"
        if p.startswith(root_s):
            return "run:other"
        if p.endswith((".py", ".pyc", ".pyd", ".dll", ".pth", ".zip")) or p.startswith(code_roots):
            return "code"
        return "outside"

    def where() -> str:
        """The first product frame (orgtree module:function) on the stack,
        else the first non-harness frame. Code names only, never data."""
        frame = sys._getframe(2)
        fallback = None
        while frame is not None:
            name = frame.f_code.co_filename.replace("\\", "/")
            at = name.find("/engine/backend/orgtree/")
            if at >= 0:
                return "orgtree." + name[at + 24:].removesuffix(".py").replace("/", ".") +                     ":" + frame.f_code.co_name
            if fallback is None and not name.endswith(("p02_operation_contacts.py",
                                                        "isolation_guards.py")):
                fallback = name.rsplit("/", 1)[-1].removesuffix(".py") + ":" + frame.f_code.co_name
            frame = frame.f_back
        return fallback or "?"

    def hook(event: str, args: tuple) -> None:
        target = _CURRENT or _BETWEEN
        try:
            if event == "open":
                path, mode = args[0], args[1]
                flags = args[2] if len(args) > 2 else 0
                write = (isinstance(mode, str) and any(c in mode for c in "wax+")) or \
                    (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
                cat = category(path, target.slug)
                if write:
                    target.count("file_write", cat + "@" + where())
                elif cat != "code":
                    target.count("file_read", cat + "@" + where())
                else:
                    target.count("file_read", cat)
            elif event in ("os.listdir", "os.scandir"):
                target.count("dir_list", category(args[0] if args else None) + "@" + where())
            elif event in ("os.mkdir", "os.remove", "os.rmdir", "os.rename", "os.replace",
                           "os.chmod", "os.utime", "shutil.rmtree", "shutil.copyfile",
                           "shutil.move", "os.symlink", "os.link", "os.truncate"):
                target.count("fs_mutation", event + ":" + category(args[0] if args else None)
                             + "@" + where())
            elif event == "sqlite3.connect":
                target.count("sqlite_connect", category(args[0] if args else None, target.slug)
                             + "@" + where())
            elif event in ("subprocess.Popen", "os.system", "os.startfile", "os.spawn",
                           "os.exec", "os.posix_spawn", "_winapi.CreateProcess"):
                target.count("process", event + "@" + where())
            elif event.startswith("socket.") and event in (
                    "socket.connect", "socket.getaddrinfo", "socket.bind", "socket.sendto",
                    "socket.sendmsg", "socket.gethostbyname"):
                at = where()
                # the in-process test client's event loop builds a loopback
                # socketpair per request: harness plumbing, not a product contact
                target.count("harness_event_loop" if at.startswith("socket:_fallback_socketpair")
                             else "network", event + "@" + at)
        except Exception:                                       # noqa: BLE001
            target.count("audit_error", event)

    sys.addaudithook(hook)


# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------

def tree_commit(tree: Path) -> "str | None":
    """The checked-out commit, read from git's files (no subprocess)."""
    git = tree / ".git"
    try:
        if git.is_file():
            gitdir = Path(git.read_text(encoding="utf-8").split(":", 1)[1].strip())
            gitdir = gitdir if gitdir.is_absolute() else (tree / gitdir).resolve()
        else:
            gitdir = git
        head = (gitdir / "HEAD").read_text(encoding="utf-8").strip()
        if re.fullmatch(r"[0-9a-f]{40}", head):
            return head
        ref = head.split(" ", 1)[1].strip()
        common = gitdir
        if (gitdir / "commondir").exists():
            common = (gitdir / (gitdir / "commondir").read_text(encoding="utf-8").strip()).resolve()
        for base in (gitdir, common):
            if (base / ref).exists():
                return (base / ref).read_text(encoding="utf-8").strip()
        packed = common / "packed-refs"
        if packed.exists():
            for line in packed.read_text(encoding="utf-8").splitlines():
                if line.endswith(" " + ref):
                    return line.split(" ", 1)[0]
    except (OSError, IndexError, ValueError):
        return None
    return None


def _load_guards() -> Any:
    path = ROOT / "tests" / "isolation_guards.py"
    spec = importlib.util.spec_from_file_location("isolation_guards", path)
    module = importlib.util.module_from_spec(spec)          # type: ignore[arg-type]
    sys.modules["isolation_guards"] = module
    spec.loader.exec_module(module)                          # type: ignore[union-attr]
    return module


# ---------------------------------------------------------------------------
# the probe
# ---------------------------------------------------------------------------

class Probe:
    def __init__(self, work: Path, out: Path) -> None:
        self.work = work
        self.out = out
        self.rows: list[dict[str, Any]] = []
        self.warnings: list[str] = []

    # -- environment -------------------------------------------------------
    def prepare(self) -> None:
        self.ig = _load_guards()
        pinned = self.ig.pinned_protected_roots(os.environ)   # BEFORE any redirect
        protected = self.ig.all_protected(pinned)
        # checked BEFORE anything is created (review N1)
        self.ig.refuse_overlap("work folder", str(self.work), protected)
        self.ig.refuse_overlap("output", str(self.out), protected)
        self.root = Path(tempfile.mkdtemp(prefix="p02-contacts-", dir=str(self.work)))
        self.ig.refuse_overlap("probe root", str(self.root), protected)
        self.data, self.home = self.root / "data", self.root / "home"
        tmp = self.root / "tmp"
        for d in (self.data, self.home, tmp):
            d.mkdir()
        for key in [k for k in os.environ if k.startswith("ORGTREE_")]:
            if key not in ("ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA"):
                os.environ.pop(key)
        for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
                    "GEMINI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XDG_CONFIG_HOME",
                    "XDG_DATA_HOME", "OPENROUTER_API_KEY"):
            os.environ.pop(key, None)
        roaming, local = self.home / "AppData" / "Roaming", self.home / "AppData" / "Local"
        roaming.mkdir(parents=True)
        local.mkdir(parents=True)
        # APPDATA/LOCALAPPDATA too (review N2), so no provider lookup reads the
        # real machine; the pinned roots above were taken before this
        os.environ.update(ORGTREE_DATA=str(self.data), HOME=str(self.home),
                          USERPROFILE=str(self.home), APPDATA=str(roaming),
                          LOCALAPPDATA=str(local), ORGTREE_V2_TOKEN="operator",
                          ORGTREE_STORE_BACKEND="sqlite", TEMP=str(tmp), TMP=str(tmp))
        tempfile.tempdir = str(tmp)
        self.report = self.ig.Report()
        self.ig.refuse_overlap("output", str(self.out), protected)
        policy = self.ig.Policy(write_roots=[str(self.root), str(self.out)],
                                protected_roots=protected)
        self.ig.install_audit_guards(policy, self.report)
        self.native_blocked = self.ig.block_native_process_modules()
        self.ig.force_selector_loop()
        self.ig.block_proactor_connect(self.report)
        install_audit_counter(self.root, self.data, self.home)
        self.commit = tree_commit(ROOT)
        sys.path[:0] = [str(ROOT), str(ROOT / "engine" / "backend")]
        from engine.launch import load_app
        self.app, *_ = load_app()
        from fastapi.testclient import TestClient
        from orgtree import (agentauth, api, census, census_contacts, ledger, opreceipts,
                             reservations, store, supervisor)
        self.m = dict(agentauth=agentauth, api=api, census=census, contacts=census_contacts,
                      ledger=ledger, opreceipts=opreceipts, reservations=reservations,
                      store=store, supervisor=supervisor)
        import orgtree
        self.provenance = {
            "commit": self.commit, "orgtree_file": str(Path(orgtree.__file__).resolve()),
            "orgtree_under_tree": Path(orgtree.__file__).resolve().is_relative_to(ROOT),
            "python": sys.version.split()[0], "native_blocked": self.native_blocked}
        self.client = TestClient(self.app, raise_server_exceptions=False,
                                 client=("127.0.0.1", 43000))
        self.restore_sql = install_sql_observer(census_contacts)
        # spies: delivery is counted, never executed (as in the P01 boundary tests)
        self.wakes = {"send_message": 0, "mail_notify": 0}

        def send_message(*_a: Any, **_k: Any) -> dict[str, Any]:
            self.wakes["send_message"] += 1
            return {"delivered": True}

        def mail_notify(*_a: Any, **_k: Any) -> None:
            self.wakes["mail_notify"] += 1

        supervisor.send_message = send_message
        supervisor.delivery_note = lambda *_a, **_k: "fixture carrier accepted; read unknown"
        api.mail_notify = mail_notify
        self.clock = [100.0]
        reservations._now = lambda *_a, **_k: self.clock[0]

    # -- census plumbing ---------------------------------------------------
    def operator(self, method: str, path: str, **kw: Any) -> Any:
        headers = {"X-Orgtree-Desktop-Token": "operator"}
        resp = getattr(self.client, method)(path, headers=headers, **kw)
        if resp.status_code != 200:
            raise RuntimeError(f"operator call {path} answered {resp.status_code}")
        return resp.json()

    def census_state(self) -> dict[str, Any]:
        """Counters plus `newest_seq` (a snapshot of n=0 carries no row, so
        its newest_seq is empty; n=1 carries exactly the newest)."""
        return self.operator("get", "/api/diagnostics/operation-census?n=1")

    def census_since(self, seq: int) -> list[dict[str, Any]]:
        snap = self.operator("get", "/api/diagnostics/operation-census?n=64")
        return sorted((r for r in snap.get("records", []) if r.get("seq", 0) > seq),
                      key=lambda r: r["seq"])

    def load_table_catalogue(self) -> None:
        """The closed table set: every name in the stores' own sqlite_master,
        read with a plain (unobserved) connection AFTER the workload, when
        every lazily created sidecar exists. Raw names never leave memory:
        `map_tables` rewrites every row onto this set before output."""
        names: set[str] = set()
        for path in list(self.data.glob("*.sqlite3")) + list(self.data.glob("*.db")) + \
                list((self.data / "orgs").glob("*.db")):
            try:
                with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as c:
                    names.update(r[0].lower() for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type IN ('table','view')"))
            except sqlite3.Error:
                continue
        names.add("sqlite_master")
        _TABLES.clear()
        _TABLES.update(names)

    def map_tables(self) -> None:
        """Rewrite every row's table names onto the closed catalogue; any
        name outside it becomes `other`, so no free text reaches output."""
        def closed(names: list[str]) -> list[str]:
            return sorted({n if n in _TABLES else "other" for n in names})
        for row in self.rows:
            for st in row["harness"]["stores"].values():
                st["tables_read"] = closed(st["tables_read"])
                st["tables_written"] = closed(st["tables_written"])

    # -- fixtures ------------------------------------------------------------
    def build(self) -> None:
        store, ledger, agentauth = self.m["store"], self.m["ledger"], self.m["agentauth"]
        supervisor = self.m["supervisor"]
        self.tokens: dict[tuple[str, str], str] = {}

        def tok(slug: str, names: tuple[str, ...]) -> None:
            for n in names:
                self.tokens[(slug, n)] = agentauth.child_env(slug, n)["ORGTREE_AGENT_TOKEN"]

        # reservation (tests/test_state_reservation_boundary.py)
        org = store.create_org("p02-contacts-reservation")
        self.rslug = str(org.d["slug"])
        for name in ("owner", "peer", "outsider"):
            org.hire(ledger.USER, None, "haiku", 10, name)
        org.hire(ledger.USER, "owner", "haiku", 4, "child")
        org.hire(ledger.USER, "child", "haiku", 0, "deep")
        org.hire(ledger.USER, "outsider", "haiku", 0, "cousin")
        self.item = org.work_create("owner", "Contacts scope", "Fixture scope", owner="owner",
                                    participants=["peer", "deep", "cousin"])["slug"]
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        tok(self.rslug, ("owner", "peer", "outsider", "child", "deep", "cousin"))

        # material (tests/test_state_material_reads.py) + a real transcript file
        org = store.create_org("p02-contacts-material")
        self.mslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 20, "boss")
        for name in ("first", "reader", "peer", "outsider"):
            org.hire(ledger.USER, "boss", "haiku", 2, name)
        org.hire(ledger.USER, "first", "haiku", 0, "deep")
        self.mitem = org.work_create(ledger.USER, "Material contract", "Preserve handover",
                                     owner="first")["slug"]
        org.work_assign(ledger.USER, self.mitem, "reader")
        org.work_participants(ledger.USER, self.mitem, add=["peer"])
        org.d["mail"] = {}
        store.save_org(org)
        tok(self.mslug, ("boss", "first", "reader", "peer", "outsider", "deep"))
        sid = str(store.load_org(self.mslug).node("first").get("session_id") or "")
        if sid:
            tdir = self.home / ".claude" / "projects" / "p02-fixture"
            tdir.mkdir(parents=True, exist_ok=True)
            with open(tdir / (sid + ".jsonl"), "w", encoding="utf-8") as f:
                for i in range(1, 7):
                    role = "user" if i % 2 else "assistant"
                    f.write(json.dumps({"type": role, "uuid": f"id-{i}",
                                        "timestamp": f"2026-09-24T08:00:{i:02d}Z",
                                        "message": {"id": f"m-{i}", "role": role,
                                                    "content": f"synthetic message {i}"}}) + "\n")
        else:
            self.warnings.append("material fixture node has no session_id; transcript "
                                 "variants take the missing-source path")
        self.scratch_base = Path(supervisor.scratch_dir(self.mslug, "first"))
        (self.scratch_base / "notes.txt").write_text("synthetic handover material",
                                                     encoding="utf-8")

        # diagnostic (tests/test_state_diagnostic_boundary.py)
        org = store.create_org("p02-contacts-diagnostic")
        self.dslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 30, "boss")
        org.hire(ledger.USER, "boss", "haiku", 8, "reader")
        org.hire(ledger.USER, "boss", "haiku", 1, "peer")
        org.hire(ledger.USER, "reader", "haiku", 1, "deep")
        org.hire(ledger.USER, "deep", "haiku", 0, "leaf")
        org.hire(ledger.USER, "reader", "haiku", 0, "old")
        org.hire(ledger.USER, None, "haiku", 3, "outside")
        org.retire(ledger.USER, "old")
        org.node("reader")["scope"]["org_visibility"] = "subtree"
        org.d["mail"] = {}
        store.save_org(org)
        tok(self.dslug, ("reader", "peer"))

        # preview (tests/test_state_preview_boundary.py)
        org = store.create_org("p02-contacts-preview")
        self.pslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 40, "actor")
        org.hire(ledger.USER, "actor", "haiku", 8, "a")
        org.hire(ledger.USER, "a", "haiku", 0, "leaf")
        org.hire(ledger.USER, "actor", "haiku", 2, "b")
        org.hire(ledger.USER, "actor", "haiku", 0, "old")
        org.hire(ledger.USER, None, "haiku", 5, "foreign")
        org.retire(ledger.USER, "old")
        org.node("actor")["scope"]["org_visibility"] = "full"
        org.d["mail"] = {}
        store.save_org(org)
        tok(self.pslug, ("actor",))

    def mutate(self, slug: str, change: Callable[[Any], Any]) -> None:
        store = self.m["store"]
        with store.write_org(slug) as org:
            change(org)
            store.save_org(org)

    def cold(self, slugs: "tuple[str, ...]") -> None:
        store = self.m["store"]
        for slug in slugs:
            store._invalidate_snapshot(slug)
            store._POOL.close_all(slug)

    # -- one operation ---------------------------------------------------------
    def agent_body(self, slug: str, actor: str, tool: str, args: dict[str, Any],
                   key: "str | None" = None, epoch: "str | None" = None,
                   envelope: "dict[str, Any] | None" = None) -> dict[str, Any]:
        body: dict[str, Any] = dict(org=slug, node=actor, tool=tool, args=args)
        if key is not None:
            body.update(tool=self.m["opreceipts"].OP_CALL,
                        args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch))
        if envelope:
            body.update(envelope)
        return body

    def run(self, contract: str, variant: str, condition: str, slug: str, actor: str,
            tool: str, args: dict[str, Any], *, key: "str | None" = None,
            epoch: "str | None" = None, envelope: "dict[str, Any] | None" = None,
            token: "str | None" = None, refusal: "str | None" = None,
            patches: "list[tuple[Any, str, Any]] | None" = None) -> dict[str, Any]:
        global _CURRENT
        if condition == "cold":
            self.cold((slug,))
        body = self.agent_body(slug, actor, tool, args, key, epoch, envelope)
        headers = {"X-Orgtree-Agent-Token": token if token is not None
                   else self.tokens.get((slug, actor), "")}
        before = self.census_state()
        seq0 = before.get("newest_seq") or 0
        wakes0 = dict(self.wakes)
        refused0 = dict(self.report.refused)
        collector = Collector(f"{contract}/{variant}/{condition}", slug)
        saved = []
        for obj, name, value in patches or []:
            saved.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)
        label = f"{contract}:{variant}:{condition}"
        self.report.route = label
        _CURRENT = collector
        t0 = time.perf_counter()
        try:
            resp = self.client.post("/api/agent", json=body, headers=headers)
            status = resp.status_code
            try:
                payload = resp.json()
            except ValueError:
                payload = None
        finally:
            elapsed = (time.perf_counter() - t0) * 1000.0
            _CURRENT = None
            self.report.route = "-"
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)
        after = self.census_state()
        records = [r for r in self.census_since(seq0) if not r.get("diagnostic")]
        row = self.row(contract, variant, condition, tool, args, body, status, payload,
                       records, collector, before, after, wakes0, refused0, refusal, elapsed)
        self.rows.append(row)
        return row

    def row(self, contract: str, variant: str, condition: str, tool: str,
            args: dict[str, Any], body: dict[str, Any], status: int, payload: Any,
            records: list[dict[str, Any]], c: Collector, before: dict[str, Any],
            after: dict[str, Any], wakes0: dict[str, int], refused0: dict[Any, int],
            refusal: "str | None", elapsed: float) -> dict[str, Any]:
        record = records[0] if len(records) == 1 else None
        db = (record or {}).get("db") or {}
        stores: dict[str, dict[str, Any]] = {}
        writes = writes_in_tx = 0
        tx: dict[str, int] = {}
        attributed = unbound = 0
        for s in c.statements:
            st = stores.setdefault(s["store"], {"tables_read": set(), "tables_written": set(),
                                                 "kinds": {}, "statements": 0, "failed": 0,
                                                 "autocommit": set()})
            st["autocommit"].add(s.get("autocommit"))
            st["statements"] += 1
            st["kinds"][s["kind"]] = st["kinds"].get(s["kind"], 0) + 1
            st["tables_read"].update(s["read"])
            st["tables_written"].update(s["written"])
            st["failed"] += int(s["failed"])
            if s["kind"] in TX_KINDS:
                tx[s["kind"]] = tx.get(s["kind"], 0) + 1
            if s["kind"] in WRITE_KINDS:
                writes += 1
                writes_in_tx += int(bool(s["in_transaction_after"]))
            if s["tally"] is None:
                unbound += 1
            else:
                attributed += 1
                c.tallies.add(s["tally"])
        for st in stores.values():
            # True: autocommit connection, so "in transaction" means an explicit
            # BEGIN; False: Python's implicit BEGIN before DML (review N3)
            modes = st["autocommit"] - {None}
            st["autocommit"] = modes.pop() if len(modes) == 1 else sorted(modes) or None
            st["tables_read"] = sorted(st["tables_read"])
            st["tables_written"] = sorted(st["tables_written"])
        census_statements = db.get("statements", 0) + sum(
            v.get("statements", 0) for v in (db.get("secondary") or {}).values())
        c0, c1 = before.get("counters", {}), after.get("counters", {})
        deltas = {k: c1.get(k, 0) - c0.get(k, 0) for k in sorted(set(c1) | set(c0))
                  if isinstance(c1.get(k, 0), int) and c1.get(k, 0) != c0.get(k, 0)}
        refused = {f"{g}/{e}": n - refused0.get((g, e, r), 0)
                   for (g, e, r), n in self.report.refused.items()
                   if r == f"{contract}:{variant}:{condition}"
                   and n - refused0.get((g, e, r), 0) > 0}
        sidecar_rw = {}
        for label, st in stores.items():
            if label == "primary":
                continue
            kinds = set(st["kinds"])
            sidecar_rw[label] = ("write" if kinds & WRITE_KINDS else
                                 "read" if kinds & READ_KINDS else "other")
        return {
            "contract": contract, "variant": variant, "condition": condition,
            "tool": tool, "alias": tool if tool in RESERVATION_TOOLS else None,
            "args": args, "request": body if body.get("tool") != tool else None,
            "refusal": refusal,
            "http_status": status,
            "detail": (payload.get("detail") if isinstance(payload, dict) and
                       isinstance(payload.get("detail"), str) and status >= 400 else None),
            "census": {
                "records": len(records),
                "op": (record or {}).get("op"), "outcome": (record or {}).get("outcome"),
                "rw": (record or {}).get("rw"), "scope": (record or {}).get("scope"),
                "action": (record or {}).get("action"),
                "db_present": bool(db),
                "checkouts": db.get("checkouts", 0), "connects": db.get("connects", 0),
                "statements": db.get("statements", 0), "engine_steps": db.get("engine_steps", 0),
                "hidden_steps": db.get("hidden_steps", 0),
                "linked_threads": db.get("linked_threads", 0),
                "kinds": db.get("kinds", {}), "kind_failed": db.get("kind_failed", {}),
                "secondary": {k: {kk: v.get(kk) for kk in ("connects", "statements",
                                                           "engine_steps", "hidden_steps", "kinds")}
                              for k, v in (db.get("secondary") or {}).items()},
                "counter_deltas": deltas,
                # the record's own timing and document-lock numbers (census
                # _NUMERIC_FIELDS): profile and wait evidence, not DB waits
                "profile": {k: v for k, v in (record or {}).items()
                            if k not in ("v", "seq", "status", "bytes", "inflight", "targets",
                                         "t_ms") and isinstance(v, (int, float))
                            and not isinstance(v, bool)},
            },
            "harness": {
                "stores": stores, "sidecars_touched": sidecar_rw,
                "writes": writes, "writes_in_transaction": writes_in_tx,
                "all_writes_in_transaction": writes == writes_in_tx,
                "transaction_statements": tx,
                "statements_attributed": attributed, "statements_unbound": unbound,
                "distinct_tallies": len(c.tallies),
                # None: no census record exists for this attempt (refused before
                # the census middleware); never counted as a match
                "matches_census": (attributed == census_statements) if record is not None
                else None,
            },
            "audit": {k: dict(sorted(v.items())) for k, v in sorted(c.audit.items())},
            "guard_refusals": refused,
            "wakes": {k: self.wakes[k] - wakes0[k] for k in self.wakes},
            "elapsed_ms": round(elapsed, 3),
        }

    # -- the workload -----------------------------------------------------------
    def reservation(self) -> None:
        opreceipts = self.m["opreceipts"]
        s, item = self.rslug, self.item

        def acquire(tool: str, resource: str) -> dict[str, Any]:
            self.clock[0] = 100.0
            r = self.client.post("/api/agent", json=self.agent_body(s, "owner", tool, dict(
                action="acquire", resource=resource, item=item, candidate="a" * 40,
                base="b" * 40, paths=["engine/api.py"], lease_s=1, stale_s=1)),
                headers={"X-Orgtree-Agent-Token": self.tokens[(s, "owner")]})
            if r.status_code != 200:
                raise RuntimeError(f"fixture acquire answered {r.status_code}: {r.text[:200]}")
            return r.json()["reservation"]

        variants = ["list-read", "list-scope", "landing", "acquire", "overlap", "renew",
                    "recover", "invalidate", "release", "release-notify", "land"]
        actions = {"list-read": "list", "list-scope": "list", "landing": "landing",
                   "acquire": "acquire", "overlap": "overlap", "renew": "renew",
                   "recover": "recover", "invalidate": "invalidate", "release": "release",
                   "release-notify": "release", "land": "land"}
        for tool in RESERVATION_TOOLS:
            for short in variants:
                for condition in ("cold", "warm"):
                    resource = f"{tool}:{short}:{condition}"
                    row = None if short == "acquire" else acquire(tool, resource)
                    args: dict[str, Any] = dict(action=actions[short], resource=resource, item=item)
                    if row:
                        args["reservation"] = row["id"]
                    self.clock[0] = 100.0
                    if short == "acquire":
                        args.update(candidate="a" * 40, base="b" * 40, paths=["engine/api.py"])
                    elif short in ("list-scope", "invalidate"):
                        self.clock[0] = 105.0
                        args.update(candidate="c" * 40, base="b" * 40)
                    elif short == "recover":
                        self.clock[0] = 105.0
                    elif short == "landing":
                        self.client.post("/api/agent", json=self.agent_body(
                            s, "owner", tool, dict(action="land", reservation=row["id"])),
                            headers={"X-Orgtree-Agent-Token": self.tokens[(s, "owner")]})
                    elif short == "overlap":
                        args["paths"] = ["engine"]
                    elif short == "release-notify":
                        args["successor"] = "peer"
                    self.run("reservation." + short, f"{tool}:reservation.{short}", condition,
                             s, "owner", tool, args)

        tool = RESERVATION_TOOLS[0]
        # refusal rows ------------------------------------------------------
        self.run("reservation.list-read", "refusal:unauthenticated", "warm", s, "owner", tool,
                 dict(action="list"), token="not-a-token",
                 refusal="401 unauthenticated (refused by the token gate, before the census)")
        self.run("reservation.list-read", "refusal:identity-mismatch", "warm", s, "peer", tool,
                 dict(action="list"), token=self.tokens[(s, "owner")],
                 refusal="403 identity mismatch")
        self.mutate(s, lambda o: o.node("owner").update(halt={"state": "halted"}))
        self.run("reservation.list-read", "refusal:halted", "warm", s, "owner", tool,
                 dict(action="list"), refusal="409 halted (before the lock)")
        self.mutate(s, lambda o: o.node("owner").pop("halt", None))
        self.mutate(s, lambda o: o.d.update(killswitch={"at": "fixture"}))
        self.run("reservation.list-read", "refusal:killswitch", "warm", s, "owner", tool,
                 dict(action="list"), refusal="409 killswitch (before the lock)")
        self.mutate(s, lambda o: o.d.pop("killswitch", None))
        row = acquire(tool, "refusal:domain")
        self.run("reservation.release-notify", "refusal:unaddressable-successor", "warm", s,
                 "owner", tool, dict(action="release", reservation=row["id"],
                                     resource="refusal:domain", item=item, successor="cousin"),
                 refusal="422 domain refusal inside the lock")
        # keyed: fresh, replay (no helper), conflict, stale epoch
        epoch = self.client.post("/api/agent", json=self.agent_body(s, "owner", opreceipts.OP_EPOCH, {}),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, "owner")]}).json()["epoch"]
        key = opreceipts.mint_key()
        self.run("reservation.list-read", "keyed:fresh", "warm", s, "owner", tool,
                 dict(action="list"), key=key, epoch=epoch)
        self.run("reservation.list-read", "keyed:replay", "warm", s, "owner", tool,
                 dict(action="list"), key=key, epoch=epoch,
                 refusal="keyed replay (answered from the receipt, no helper)")
        self.run("reservation.list-read", "refusal:keyed-conflict", "warm", s, "owner",
                 RESERVATION_TOOLS[1], dict(action="list"), key=key, epoch=epoch,
                 refusal="409 op_key conflict")
        stale_key = opreceipts.mint_key()
        opreceipts.forget_custody(str(self.m["store"].DATA_ROOT), s)
        self.run("reservation.list-read", "refusal:stale-epoch", "warm", s, "owner", tool,
                 dict(action="list"), key=stale_key, epoch=epoch, refusal="stale_epoch")
        # negative control: one statement through a plain sqlite3.Cursor on a
        # pooled connection, inside the operation — outside every observed
        # method, so ONLY the census's trace callback can see it (hidden_steps)
        store = self.m["store"]

        def hidden_now(*_a: Any, **_k: Any) -> float:
            with store._POOL.acquire(s) as conn:
                conn.cursor(sqlite3.Cursor).execute("SELECT 1").fetchall()
            return self.clock[0]
        self.run("reservation.list-read", "control:hidden-contact", "warm", s, "owner", tool,
                 dict(action="list"), refusal="negative control (not a product path)",
                 patches=[(self.m["reservations"], "_now", hidden_now)])
        # negative control: the operation loads ANOTHER organization's store
        # cold, so its connect must be classified foreign — proving the
        # locality classification can fire; every normal row must show none
        foreign = self.mslug

        def foreign_now(*_a: Any, **_k: Any) -> float:
            store._invalidate_snapshot(foreign)
            store._POOL.close_all(foreign)
            store.load_org(foreign)
            return self.clock[0]
        self.run("reservation.list-read", "control:foreign-org-contact", "warm", s, "owner", tool,
                 dict(action="list"), refusal="negative control (not a product path)",
                 patches=[(self.m["reservations"], "_now", foreign_now)])
        # the retained-row cap
        template = acquire(tool, "cap:template")

        def fill(o: Any) -> None:
            rows = o.d.setdefault("reservations", [])
            base = copy.deepcopy(next(r for r in rows if r["id"] == template["id"]))
            base["state"] = "released"
            while len(rows) < self.m["reservations"].MAX_RESERVATIONS:
                clone = copy.deepcopy(base)
                clone["id"] = "fixture-" + hashlib.sha256(str(len(rows)).encode()).hexdigest()[:16]
                clone["resource"] = f"cap:{len(rows)}"
                rows.append(clone)
        self.mutate(s, fill)
        self.run("reservation.acquire", "refusal:retained-row-cap", "warm", s, "owner", tool,
                 dict(action="acquire", resource="cap:over", item=item, candidate="a" * 40,
                      base="b" * 40, paths=["engine/api.py"]),
                 refusal="512 retained-row cap reached")

    def material(self) -> None:
        s = self.mslug
        tools = {"orgtree_read_scratch": "material.scratch",
                 "orgtree_read_transcript": "material.transcript"}
        for tool, contract in tools.items():
            for condition in ("cold", "warm"):
                self.run(contract, contract, condition, s, "reader", tool,
                         {"node": "first", "path": "notes.txt"})
            if tool == "orgtree_read_scratch":
                for condition in ("cold", "warm"):
                    self.run(contract, "scratch:directory", condition, s, "reader", tool,
                             {"node": "first", "path": ""})
                self.run(contract, "scratch:missing", "warm", s, "reader", tool,
                         {"node": "first", "path": "absent.txt"})
                self.run(contract, "refusal:path-escape", "warm", s, "reader", tool,
                         {"node": "first", "path": "../../outside.txt"},
                         refusal="path escape")
            self.run(contract, "refusal:identity-mismatch", "warm", s, "peer", tool,
                     {"node": "first", "path": "notes.txt"}, token=self.tokens[(s, "reader")],
                     refusal="403 identity mismatch")
            self.mutate(s, lambda o: o.node("reader").update(halt={"state": "halted"}))
            self.run(contract, "refusal:halted", "warm", s, "reader", tool,
                     {"node": "first", "path": "notes.txt"}, refusal="409 halted")
            self.mutate(s, lambda o: o.node("reader").pop("halt", None))
            self.run(contract, "refusal:outsider", "warm", s, "outsider", tool,
                     {"node": "first", "path": "notes.txt"}, refusal="no access route")

    def diagnostic(self) -> None:
        s = self.dslug
        for tool, contract in (("orgtree_state_inspect", "diagnostic.inspect"),
                               ("orgtree_capabilities", "diagnostic.capabilities")):
            for condition in ("cold", "warm"):
                self.run(contract, contract, condition, s, "reader", tool, {})
            self.mutate(s, lambda o: o.d.update(killswitch={"at": "fixture"}))
            self.run(contract, "refusal:killswitch", "warm", s, "reader", tool, {},
                     refusal="409 killswitch")
            self.mutate(s, lambda o: o.d.pop("killswitch", None))

    PREVIEW = {
        "reallocate": {"node": "b", "delta": 1}, "move": {"node": "leaf", "new_parent": "b"},
        "swap": {"a": "a", "b": "b"}, "swap_seats": {"a": "a", "b": "b"},
        "self_subjugate": {"target": "a"}, "subjugate": {"target": "a"},
        "retool": {"node": "a", "org_visibility": "self"},
        "set_scope": {"node": "a", "org_visibility": "self"},
        "retire": {"node": "b"}, "dissolve": {"node": "a"},
        "revoke_dir": {"node": "a", "dir": "fixture-unheld"},
        "switch_model": {"node": "b", "tier": "sonnet"},
        "audience": {"action": "grant", "from": "leaf"},
    }

    def preview(self) -> None:
        s, api = self.pslug, self.m["api"]
        for op, args in self.PREVIEW.items():
            outer = {"operation": op, "args": args}
            # the provider preflight UNSTUBBED: whatever it attempts is observed
            # (and refused by the guards if it is a process or a socket)
            self.run("preview.agent", f"preview.{op}", "cold", s, "actor", "orgtree_preview",
                     outer)
            # then with the preflight stubbed, so the simulation itself runs
            self.run("preview.agent", f"preview.{op}", "warm", s, "actor", "orgtree_preview",
                     outer, patches=[(api, "provider_hire_gate", lambda *_a, **_k: None)])

    # -- the r5 residuals ----------------------------------------------------
    def residuals(self) -> dict[str, Any]:
        """db_unbound and unclassified_action, reproduced: which records carry
        them, on a fresh window with the r5 workload's action-less tools."""
        out: dict[str, Any] = {}
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": False})
        self.operator("post", "/api/diagnostics/operation-census/reset")
        s0 = self.census_state()
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": True})
        s1 = self.census_state()
        recs = self.census_since(0)
        out["enable_call"] = {
            "db_unbound_delta": s1["counters"].get("db_unbound", 0) - s0["counters"].get("db_unbound", 0),
            "recorded_delta": s1["counters"].get("recorded", 0) - s0["counters"].get("recorded", 0),
            "records": [{k: r.get(k) for k in ("op", "route", "method", "diagnostic")} | {
                "db_present": "db" in r} for r in recs],
        }
        tools = [("orgtree_chart", {}), ("orgtree_status", {"status": "working", "summary": "x"}),
                 ("orgtree_send_notice", {"to": "a", "body": "x"}),
                 ("orgtree_work", {"action": "list"}), ("orgtree_watchdog", {"action": "list"})]
        per_tool = {}
        for tool, args in tools:
            c0 = self.census_state()
            self.client.post("/api/agent", json=self.agent_body(self.pslug, "actor", tool, args),
                             headers={"X-Orgtree-Agent-Token": self.tokens[(self.pslug, "actor")]})
            c1 = self.census_state()
            got = [r for r in self.census_since(c0.get("newest_seq") or 0) if not r.get("diagnostic")]
            per_tool[tool] = {
                "unclassified_action_delta": c1["counters"].get("unclassified_action", 0)
                - c0["counters"].get("unclassified_action", 0),
                "record_action": [r.get("action") for r in got]}
        out["action_less_tools"] = per_tool
        return out

    # -- connection sites ------------------------------------------------------
    def connection_sites(self) -> list[dict[str, Any]]:
        inv = json.loads((ROOT / "docs/state-system/operation-inventory.json").read_text("utf-8"))
        contacts = self.m["contacts"]
        instrumented = {(p, s) for p, s in contacts.INSTRUMENTED}
        sidecars = {(p, s): label for p, s, label in contacts.SIDECARS}
        uninstrumented = {(p, s) for p, s in contacts.UNINSTRUMENTED}
        reasons = {
            "antigravity_provenance.py": "reads a foreign application's (Antigravity) "
            "read-only provenance database for import; not an Orgtree store and not "
            "reached by any of the four families",
            "desktop_import.py": "desktop import of a stable-build document into a "
            "private candidate before adoption; runs only in an import job, not in "
            "the four families",
            "api.py": "UDP connect to 8.8.8.8 to discover the LAN address for a share "
            "URL; a socket, not a store; refused by the egress guard here",
            "liveness.py": "loopback TCP port probe of a provider process; a socket, "
            "not a store; refused by the egress guard here",
        }
        out = []
        for site in inv["connection_sites"]:
            src = site["source"]
            key = (src["path"], src["symbol"])
            name = src["path"].rsplit("/", 1)[-1]
            if key in instrumented:
                status, reason = "instrumented", "primary store (census db fields)"
            elif key in sidecars:
                status, reason = "instrumented", f"sidecar '{sidecars[key]}' (census db.secondary)"
            else:
                status = "uninstrumented"
                reason = reasons.get(name, "not listed by census_contacts")
                if key not in uninstrumented and site["classification"] == "database_factory":
                    reason += " (NOT in census_contacts.UNINSTRUMENTED)"
            out.append({"path": src["path"], "symbol": src["symbol"], "line": src["line"],
                        "factory": site["factory"], "classification": site["classification"],
                        "status": status, "reason": reason})
        return out

    # -- orchestration -----------------------------------------------------------
    def execute(self) -> dict[str, Any]:
        self.prepare()
        self.build()
        self.operator("post", "/api/diagnostics/operation-census/reset")
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": True})
        w0 = self.census_state()
        self.reservation()
        self.material()
        self.diagnostic()
        self.preview()
        w1 = self.census_state()
        self.load_table_catalogue()
        self.map_tables()
        residuals = self.residuals()
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": False})
        self.restore_sql()
        loss = {k: w1["counters"].get(k, 0) - w0["counters"].get(k, 0)
                for k in ("observed", "recorded", "rejected", "dropped_stale_window",
                          "dropped_capture_off", "evicted", "db_unbound", "db_late",
                          "db_unattributed", "db_hidden_unattributed", "db_observe_failed",
                          "db_self_recursion", "skipped_self", "unclassified_action")}
        return {
            "schema": SCHEMA, "tool_version": TOOL_VERSION, "provenance": self.provenance,
            "limits": LIMITS, "warnings": self.warnings,
            "table_catalogue": sorted(_TABLES),
            "window": {"instance": w1.get("instance"),
                       "same_window": w0.get("window_generation") == w1.get("window_generation"),
                       "counters": loss},
            "between_operations": {k: dict(v) for k, v in _BETWEEN.audit.items()},
            "connection_sites": self.connection_sites(),
            "residuals": residuals,
            "rows": self.rows,
        }


def markdown(doc: dict[str, Any]) -> str:
    def cell(values: Any) -> str:
        if isinstance(values, dict):
            return ", ".join(f"{k} {v}" for k, v in values.items()) or "-"
        return ", ".join(values) or "-"
    lines = ["# P02 per-operation contacts (synthetic)", "",
             f"Commit `{doc['provenance']['commit']}`, orgtree from "
             f"`{doc['provenance']['orgtree_file']}`, Python {doc['provenance']['python']}.", "",
             "| contract | variant | cond | status | primary tables R | primary tables W | "
             "kinds | checkouts | connects | sidecars | writes in tx | files | process | net | "
             "census=harness |",
             "|---|---|---|---:|---|---|---|---:|---:|---|---|---|---|---|---|"]
    for r in doc["rows"]:
        p = r["harness"]["stores"].get("primary", {})
        h = r["harness"]
        files = {k: sum(v.values()) for k, v in r["audit"].items()
                 if k in ("file_read", "file_write", "dir_list", "fs_mutation")}
        lines.append("| " + " | ".join([
            r["contract"], r["variant"], r["condition"], str(r["http_status"]),
            cell(p.get("tables_read", [])), cell(p.get("tables_written", [])),
            cell(r["census"]["kinds"]), str(r["census"]["checkouts"]),
            str(r["census"]["connects"]), cell(h["sidecars_touched"]),
            f"{h['writes_in_transaction']}/{h['writes']}", cell(files),
            cell(r["audit"].get("process", {})), cell(r["audit"].get("network", {})),
            {True: "yes", False: "NO", None: "no record"}[h["matches_census"]]]) + " |")
    lines += ["", "## Limits", ""] + [f"- {x}" for x in doc["limits"]]
    return "\n".join(lines) + "\n"


def main(argv: "list[str] | None" = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--out", required=True)
    p.add_argument("--work", help="parent folder for the temporary synthetic root")
    args = p.parse_args(argv)
    out = Path(args.out).resolve()
    work = Path(args.work).resolve() if args.work else out
    ig = _load_guards()
    protected = ig.all_protected(ig.pinned_protected_roots(os.environ))
    for label, path in (("output", out), ("work folder", work)):
        ig.refuse_overlap(label, str(path), protected)   # before any mkdir (review N1)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    probe = Probe(work, out)
    doc = probe.execute()
    (out / "operation-contacts.json").write_text(json.dumps(doc, indent=1, sort_keys=True),
                                                 encoding="utf-8")
    (out / "operation-contacts.md").write_text(markdown(doc), encoding="utf-8")
    print(json.dumps({"rows": len(doc["rows"]), "out": str(out),
                      "all_match": all(r["harness"]["matches_census"] for r in doc["rows"])}),
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
