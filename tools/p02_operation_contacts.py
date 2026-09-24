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
import subprocess
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
#: census counters that mean a contact was LOST or misattributed; every row's
#: own delta of each must be zero
LOSS_KEYS = ("db_unbound", "db_late", "db_unattributed", "db_hidden_unattributed",
             "db_observe_failed", "db_self_recursion", "rejected", "dropped_stale_window",
             "dropped_capture_off", "evicted")
#: the closed set of contact classes an operation of the four families may
#: make on synthetic data (``contact_classes``). Anything else is an UNKNOWN
#: contact: a row that makes one must declare it in ``expected_unknown`` (the
#: deliberate provocations and the negative controls), and a declared class
#: that does not occur is reported too — the probe-level drift refusal.
KNOWN_CATEGORIES = ("code", "descriptor", "data:org-db:own", "data:sidecar-db",
                    "data:scratch", "data:sandbox", "data:other", "home:provider", "run:other")
KNOWN_GROUPS = ("file_read", "file_write", "dir_list", "fs_mutation", "sqlite_connect")
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
    "The unknown-contact refusal is probe-level and its known classes are broad: "
    "data:other (the rest of the synthetic data root) and run:other (the probe root "
    "outside data and HOME) are known, so contacts within them are not told apart "
    "by it; the code location in audit.* does. It is not a product drift policy.",
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
        #: preview only: what the simulation's mutator changed in its clone
        self.clone: "dict[str, Any] | None" = None

    def statement(self, row: dict[str, Any]) -> None:
        with self.lock:
            self.statements.append(row)

    def count(self, group: str, key: str) -> None:
        with self.lock:
            bucket = self.audit.setdefault(group, {})
            bucket[key] = bucket.get(key, 0) + 1


_CURRENT: "Collector | None" = None
#: node ids per synthetic org, for mapping statement parameters to agents
_NODES: dict[str, set[str]] = {}
#: the parameters of the statement about to run, handed from the cursor
#: wrapper to the `_run` wrapper on the same thread
_PARAMS = threading.local()
#: sections whose change is agent-to-agent mail traffic (the doc blobs are one
#: row per org; mail_log is one log_d row per owner and entry)
MAIL_DOC_KEYS = ("mail", "notices", "delivering", "audiences")
MAIL_LOG_SECTS = ("mail_log",)
#: argument names that name the OTHER party of an operation
TARGET_ARGS = ("successor", "to", "node", "target", "a", "b", "from", "new_parent", "grantee")
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
    cursor = contacts.ObservedCursor
    original_execute, original_many = cursor.execute, cursor.executemany

    def execute(self: Any, sql: str, parameters: Any = (), /) -> Any:
        _PARAMS.value = [parameters]
        return original_execute(self, sql, parameters)

    def executemany(self: Any, sql: str, seq_of_parameters: Any, /) -> Any:
        rows = list(seq_of_parameters)
        _PARAMS.value = rows
        return original_many(self, sql, rows)

    def agents_in(params: Any, slug: "str | None") -> list[list[str]]:
        """Node ids among the parameters, per parameter row. Only ids of the
        operation's own synthetic org are recognised; nothing else is kept."""
        nodes = _NODES.get(slug or "") or set()
        out = []
        for row in params or ():
            values = row.values() if isinstance(row, dict) else \
                (row if isinstance(row, (list, tuple)) else ())
            ids = [v for v in values if isinstance(v, str) and v in nodes]
            if ids:
                out.append(ids)
        return out

    def observed(conn: Any, sql: Any, call: Callable[[], Any]) -> Any:
        params = getattr(_PARAMS, "value", None)
        _PARAMS.value = None
        target = _CURRENT
        if target is None or not contacts._capture_on():
            return original(conn, sql, call)
        kind = contacts.kind_of(sql)
        agent_rows = agents_in(params, target.slug)
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
                "agent_rows": agent_rows,
                "tally": id(tally) if tally is not None else None})

    contacts._run = observed
    cursor.execute, cursor.executemany = execute, executemany

    def restore() -> None:
        contacts._run = original
        cursor.execute, cursor.executemany = original_execute, original_many
    return restore


_SECTION_RE = re.compile(r"^([^.\[]+)(?:\.([^.\[]+))?")


def install_clone_observer(statepreview: Any) -> Callable[[], None]:
    """Wrap ``statepreview._apply`` (the mutator a preview runs on its
    isolated clone) and record, for the running operation, WHICH parts of the
    clone the mutator changed: changed-path counts per top-level document
    section and the node ids (of the operation's own synthetic org) whose
    entries changed. No value is kept. The clone is not a store, so the
    census cannot see these effects; this is the only record of them."""
    original = statepreview._apply

    def observed(org: Any, *args: Any, **kwargs: Any) -> Any:
        target = _CURRENT
        if target is None:
            return original(org, *args, **kwargs)
        before = json.loads(json.dumps(org.d, default=str))
        try:
            return original(org, *args, **kwargs)
        finally:
            after = json.loads(json.dumps(org.d, default=str))
            nodes = _NODES.get(target.slug or "") or set()
            sections: dict[str, int] = {}
            touched: set[str] = set()
            paths = statepreview._diff(before, after)
            for change in paths:
                m = _SECTION_RE.match(str(change.get("path") or ""))
                section = m.group(1) if m else "?"
                sections[section] = sections.get(section, 0) + 1
                if section == "nodes" and m and m.group(2) in nodes:
                    touched.add(m.group(2))
            target.clone = {"paths": len(paths), "sections": dict(sorted(sections.items())),
                            "nodes": sorted(touched)}

    statepreview._apply = observed
    return lambda: setattr(statepreview, "_apply", original)


def contact_classes(row: dict[str, Any]) -> list[str]:
    """The row's contacts as closed classes: ``<audit group>:<path category>``
    (the code location dropped), plus ``guard:<group>/<event>`` for every
    isolation-guard refusal. The in-process test client's loopback pair is
    harness plumbing and is left out."""
    out: set[str] = set()
    for group, keys in row["audit"].items():
        if group == "harness_event_loop":
            continue
        for key in keys:
            head = key.split("@", 1)[0]
            if group == "fs_mutation":
                head = head.split(":", 1)[1] if ":" in head else head
            out.add(f"{group}:{head}")
    out.update(f"guard:{k}" for k in row["guard_refusals"])
    return sorted(out)


def unknown_classes(classes: list[str]) -> list[str]:
    """The classes outside the known set (``KNOWN_GROUPS`` x
    ``KNOWN_CATEGORIES``; a foreign org store, anything outside the synthetic
    root, a process, a socket or a guard refusal is never known)."""
    return sorted(c for c in classes
                  if c.split(":", 1)[0] not in KNOWN_GROUPS
                  or c.split(":", 1)[1] not in KNOWN_CATEGORIES)


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
            if rest.startswith("sandboxes\\"):
                return "data:sandbox"
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
                target.count("fs_mutation", event + ":" + category(args[0] if args else None,
                                                                   target.slug)
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
    def __init__(self, work: Path, out: Path, backend: str = "sqlite") -> None:
        self.work = work
        self.out = out
        self.backend = backend
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
        # provider executables: synthetic, so no provider check reads this
        # machine's PATH. Claude "installed" (an empty file that is never run),
        # Codex and Antigravity absent; the provider rows vary these per call
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "claude.exe").write_bytes(b"")
        os.environ.update(ORGTREE_STORE=self.backend,
                          ORGTREE_CLAUDE=str(self.bin / "claude.exe"),
                          ORGTREE_CODEX=str(self.bin / "codex-absent.exe"),
                          ORGTREE_ANTIGRAVITY=str(self.bin / "agy-absent.exe"))
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
        from orgtree import (agentauth, api, appsettings, census, census_contacts, ledger,
                             opreceipts, openrouter, providers, reservations, sandbox,
                             statepreview, store, supervisor)
        self.m = dict(agentauth=agentauth, api=api, appsettings=appsettings, census=census,
                      contacts=census_contacts, ledger=ledger, opreceipts=opreceipts,
                      openrouter=openrouter, providers=providers, reservations=reservations,
                      sandbox=sandbox, statepreview=statepreview, store=store,
                      supervisor=supervisor)
        if store.STORE_BACKEND != self.backend:
            raise RuntimeError(f"store backend is {store.STORE_BACKEND!r}, not {self.backend!r}")
        import orgtree
        self.provenance = {
            "commit": self.commit, "orgtree_file": str(Path(orgtree.__file__).resolve()),
            "orgtree_under_tree": Path(orgtree.__file__).resolve().is_relative_to(ROOT),
            "python": sys.version.split()[0], "native_blocked": self.native_blocked,
            "store_backend": store.STORE_BACKEND}
        self.client = TestClient(self.app, raise_server_exceptions=False,
                                 client=("127.0.0.1", 43000))
        self.restore_sql = install_sql_observer(census_contacts)
        self.restore_clone = install_clone_observer(statepreview)
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

    # -- agent-to-agent mail locality -------------------------------------------
    def mail_snapshot(self, slug: str) -> dict[str, Any]:
        """The org's mail-related sections, read with a plain read-only
        connection OUTSIDE any operation window: the doc blobs by key and
        mail_log row counts per owner. The org's document wherever it
        currently lives: its database, else an interrupted migration's
        verified candidate, else a legacy (or JSON-backend) `.json` — so an
        operation that migrates the org compares like with like."""
        orgs = self.data / "orgs"
        snap: dict[str, Any] = {}
        try:
            for path in (orgs / f"{slug}.db", orgs / f"{slug}.db.migrating"):
                if not path.exists():
                    continue
                with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro",
                                                        uri=True)) as c:
                    for key in MAIL_DOC_KEYS:
                        row = c.execute("SELECT val FROM doc WHERE key=?", (key,)).fetchone()
                        snap[key] = json.loads(row[0]) if row else None
                    for sect in MAIL_LOG_SECTS:
                        snap[sect] = {o: n for o, n in c.execute(
                            "SELECT owner, COUNT(*) FROM log_d WHERE sect=? GROUP BY owner",
                            (sect,))}
                return snap
            doc = json.loads((orgs / f"{slug}.json").read_text(encoding="utf-8"))
            for key in MAIL_DOC_KEYS:
                snap[key] = doc.get(key)
            for sect in MAIL_LOG_SECTS:
                snap[sect] = {o: len(v) for o, v in (doc.get(sect) or {}).items() if v}
        except (sqlite3.Error, OSError, ValueError, AttributeError) as exc:
            snap = {"error": type(exc).__name__}
        return snap

    @staticmethod
    def mail_changes(before: dict[str, Any], after: dict[str, Any]) -> dict[str, list[str]]:
        """Which agents' entries each mail section changed by: for the
        per-agent dict blobs the keys whose value changed, for audiences the
        grantee/grantor of every added or removed grant, for mail_log the
        owners whose row count moved."""
        out: dict[str, list[str]] = {}
        for key in ("mail", "notices", "delivering"):
            b, a = before.get(key), after.get(key)
            if b == a:
                continue
            if isinstance(b or {}, dict) and isinstance(a or {}, dict):
                b, a = b or {}, a or {}
                changed = sorted(str(n) for n in set(b) | set(a) if b.get(n) != a.get(n))
                if changed:
                    out[key] = changed
            else:
                out[key] = ["*"]
        b = {json.dumps(x, sort_keys=True) for x in (before.get("audiences") or [])}
        a = {json.dumps(x, sort_keys=True) for x in (after.get("audiences") or [])}
        named = set()
        for grant in (json.loads(x) for x in b ^ a):
            for field in ("grantee", "grantor"):
                if isinstance(grant, dict) and isinstance(grant.get(field), str):
                    named.add(grant[field])
        if named:
            out["audiences"] = sorted(named)
        for sect in MAIL_LOG_SECTS:
            b, a = before.get(sect) or {}, after.get(sect) or {}
            moved = sorted(str(o) for o in set(b) | set(a) if b.get(o) != a.get(o))
            if moved:
                out[sect] = moved
        return out

    @staticmethod
    def parties(actor: str, args: dict[str, Any]) -> list[str]:
        """The operation's named counterparties: TARGET_ARGS values, also one
        level down (preview's inner `args`)."""
        found = []
        inner = args.get("args") if isinstance(args.get("args"), dict) else {}
        for scope in (args, inner):
            for name in TARGET_ARGS:
                value = scope.get(name)
                if isinstance(value, str) and value and value != actor:
                    found.append(value)
        return sorted(set(found))

    @staticmethod
    def role(node: str, actor: str, targets: list[str]) -> str:
        if node == actor:
            return "actor"
        if node in targets:
            return "target"
        if node == "USER" or node.startswith("@") or node == "*":
            return "user-or-org"
        return "third"

    def agents(self, actor: str, args: dict[str, Any], c: Collector,
               changes: dict[str, list[str]], implied: "tuple[str, ...]" = ()) -> dict[str, Any]:
        """`implied`: counterparties the operation reaches without naming them
        in its arguments (a status report's parent), declared by the row."""
        targets = sorted(set(self.parties(actor, args)) | set(implied))
        physical: dict[str, int] = {}
        nodes: dict[str, str] = {}
        third_rows_written = 0
        for st in c.statements:
            table = (st["written"] or st["read"] or ["other"])[0]
            rw = "write" if st["kind"] in WRITE_KINDS else "read"
            for ids in st.get("agent_rows") or []:
                for nid in ids:
                    r = self.role(nid, actor, targets)
                    nodes[nid] = r
                    key = f"{table}:{rw}:{r}"
                    physical[key] = physical.get(key, 0) + 1
                    if r == "third" and rw == "write":
                        third_rows_written += 1
        logical = {sect: {nid: self.role(nid, actor, targets) for nid in ids}
                   for sect, ids in changes.items()}
        return {
            "actor": actor, "targets": targets,
            "physical": dict(sorted(physical.items())),
            "physical_nodes": dict(sorted(nodes.items())),
            "logical": logical,
            "mail_producing": bool(changes),
            "third_agent_mail": sum(1 for sect in logical.values()
                                    for r in sect.values() if r == "third"),
            "third_agent_rows_written": third_rows_written,
        }

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
            patches: "list[tuple[Any, str, Any]] | None" = None,
            env: "dict[str, str | None] | None" = None,
            expected_unknown: "tuple[str, ...]" = (),
            implied: "tuple[str, ...]" = (), disclose: bool = False) -> dict[str, Any]:
        """One operation. `env` is applied for this call only (None removes a
        variable); `expected_unknown` declares the contact classes outside the
        known set that this row provokes on purpose; `implied` names counterparties
        the operation reaches without naming them (see `agents`); `disclose` records
        which of the org's synthetic node ids appear in the answer (`disclosed`)."""
        global _CURRENT
        if self.backend != "sqlite":
            variant = f"{self.backend}:{variant}"
        if condition == "cold":
            self.cold((slug,))
        saved_env = {k: os.environ.get(k) for k in (env or {})}
        for k, v in (env or {}).items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        body = self.agent_body(slug, actor, tool, args, key, epoch, envelope)
        headers = {"X-Orgtree-Agent-Token": token if token is not None
                   else self.tokens.get((slug, actor), "")}
        mail0 = self.mail_snapshot(slug)
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
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        after = self.census_state()
        mail1 = self.mail_snapshot(slug)
        records = [r for r in self.census_since(seq0) if not r.get("diagnostic")]
        row = self.row(contract, variant, condition, tool, args, body, status, payload,
                       records, collector, before, after, wakes0, refused0, refusal, elapsed)
        row["agents"] = self.agents(actor, args, collector, self.mail_changes(mail0, mail1),
                                    implied)
        row["backend"] = self.backend
        row["disclosed"] = None
        if disclose:
            text = json.dumps(payload) if payload is not None else ""
            row["disclosed"] = sorted(
                n for n in _NODES.get(slug, ())
                if re.search(r"(?<![\w-])" + re.escape(n) + r"(?![\w-])", text))
        row["env"] = sorted(env or {})
        row["clone"] = None if collector.clone is None else dict(
            collector.clone, nodes={n: self.role(n, actor, row["agents"]["targets"])
                                    for n in collector.clone["nodes"]})
        classes = contact_classes(row)
        unknown = unknown_classes(classes)
        row["contact_classes"] = classes
        row["unknown_observed"] = unknown
        row["expected_unknown"] = sorted(expected_unknown)
        row["unknown_contacts"] = sorted(set(unknown) - set(expected_unknown))
        row["expected_unknown_missing"] = sorted(set(expected_unknown) - set(classes))
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
        # the same successor made addressable by a HELD AUDIENCE (the user
        # grants 'owner' an audience with 'cousin'): release-notify's mail then
        # reaches a successor that is neither a sibling nor in the sender's
        # line (P01 contacts review f1)
        ledger = self.m["ledger"]
        self.mutate(s, lambda o: o.audience_grant(ledger.USER, "owner", "cousin"))
        row = acquire(tool, "audience:successor")
        self.run("reservation.release-notify", "audience-successor:reservation.release-notify",
                 "warm", s, "owner", tool, dict(action="release", reservation=row["id"],
                                     resource="audience:successor", item=item,
                                     successor="cousin"))
        self.mutate(s, lambda o: o.d.update(audiences=[]))
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
        # negative control: a release to the addressed successor ('peer') whose
        # notify step ALSO posts mail to a third agent ('child') inside the
        # operation; the agent-locality observation must flag 'child' as third
        store = self.m["store"]
        supervisor = self.m["supervisor"]
        third = acquire(tool, "control:third-agent")

        def notify_and_mail_third(*_a: Any, **_k: Any) -> dict[str, Any]:
            with store.write_org(s) as org:
                org.post_mail("owner", "child", "p02 control: mail to a third agent")
                store.save_org(org)
            return {"delivered": True}
        self.run("reservation.release-notify", "control:third-agent-mail", "warm", s, "owner",
                 tool, dict(action="release", reservation=third["id"],
                            resource="control:third-agent", item=item, successor="peer"),
                 refusal="negative control (not a product path)",
                 patches=[(supervisor, "send_message", notify_and_mail_third)])
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
                 patches=[(self.m["reservations"], "_now", foreign_now)],
                 expected_unknown=("sqlite_connect:data:org-db:foreign",))
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
        self.malformed()

    #: P01's legacy malformed stored-state matrix (tests/test_state_diagnostic_
    #: boundary.py CORRUPT_NODE): one field of node 'deep' holds a malformed
    #: value; inspected by node and for the whole org
    CORRUPT_NODE = (
        ("generation", "x"), ("generation", [1]), ("generation", None),
        ("grant", "x"), ("grant", None), ("grant", -5),
        ("model", None), ("model", 5),
        ("scope", "bad"), ("scope.tools", "bad"), ("scope.org_visibility", 5),
        ("state", "weird"), ("parent", "ghost"),
        ("frozen", "bad"), ("frozen", [1]), ("pending_switch", "bad"),
        ("last_status", "bad"), ("title", 5),
    )

    def malformed(self) -> None:
        """diagnostic.reads: the contacts of an inspection over MALFORMED
        stored state. Each corruption is written, inspected (the one node,
        then the whole org), and the node restored."""
        s = self.dslug
        for path, value in self.CORRUPT_NODE:
            saved: dict[str, Any] = {}

            def corrupt(org: Any, path: str = path, value: Any = value) -> None:
                node = org.node("deep")
                saved["node"] = copy.deepcopy(dict(node))
                *parents, leaf = path.split(".")
                target = node
                for part in parents:
                    target = target[part]
                target[leaf] = value

            def restore(org: Any) -> None:
                node = org.node("deep")
                node.clear()
                node.update(saved["node"])
            # the JSON backend parses (and normalizes) the WHOLE document on
            # load, so some corruptions make the org unloadable even for the
            # restore; there the document's bytes are put back directly
            doc_file = self.data / "orgs" / f"{s}.json"
            raw = doc_file.read_bytes() if self.backend == "json" else None
            self.mutate(s, corrupt)
            label = f"malformed:{path}={json.dumps(value)}"
            try:
                self.run("diagnostic.inspect", label + ":node", "warm", s, "reader",
                         "orgtree_state_inspect", {"node": "deep"},
                         refusal="malformed stored state (legacy outcome recorded)")
                self.run("diagnostic.inspect", label + ":org", "warm", s, "reader",
                         "orgtree_state_inspect", {},
                         refusal="malformed stored state (legacy outcome recorded)")
            finally:
                if raw is not None:
                    doc_file.write_bytes(raw)
                    self.m["store"]._invalidate_snapshot(s)
                else:
                    self.mutate(s, restore)

    # -- sandboxed organization (material.reads / material.effects) -------------
    def build_sandbox(self) -> None:
        """A synthetic SANDBOXED organization (``d.sandbox.enabled``): its
        transcript store is the sandbox home under the data root, its scratch
        the ordinary scratch root until ``d.disk`` moves it onto the org's
        virtual disk. Nothing here starts a container: every docker/wsl
        process the product attempts is refused by the guards."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-sandbox")
        self.sslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 20, "boss")
        for name in ("first", "reader", "second"):
            org.hire(ledger.USER, "boss", "haiku", 2, name)
        item = org.work_create(ledger.USER, "Sandbox material", "Preserve handover",
                               owner="first")["slug"]
        org.work_assign(ledger.USER, item, "reader")
        org.d["mail"] = {}
        org.d["sandbox"] = {"enabled": True, "secret": "p02-fixture"}
        store.save_org(org)
        for n in ("boss", "reader"):
            self.tokens[(self.sslug, n)] = self.m["agentauth"].child_env(
                self.sslug, n)["ORGTREE_AGENT_TOKEN"]
        # scratch made directly (scratch_dir would try the chown at build time)
        first = Path(store.scratch_root(self.sslug)) / "first"
        first.mkdir(parents=True, exist_ok=True)
        (first / "notes.txt").write_text("synthetic sandboxed material", encoding="utf-8")
        sid = str(store.load_org(self.sslug).node("first").get("session_id") or "")
        home = Path(self.m["sandbox"].sandbox_root(self.sslug)) / "home"
        tdir = home / ".claude" / "projects" / "p02-fixture"
        tdir.mkdir(parents=True, exist_ok=True)
        if sid:
            with open(tdir / (sid + ".jsonl"), "w", encoding="utf-8") as f:
                for i in range(1, 5):
                    role = "user" if i % 2 else "assistant"
                    f.write(json.dumps({"type": role, "uuid": f"sb-{i}",
                                        "timestamp": f"2026-09-24T09:00:{i:02d}Z",
                                        "message": {"id": f"sb-m-{i}", "role": role,
                                                    "content": f"sandboxed message {i}"}}) + "\n")
        else:
            self.warnings.append("sandbox fixture node has no session_id")

    def sandboxed(self) -> None:
        s, sandbox = self.sslug, self.m["sandbox"]
        read = {"orgtree_read_scratch": "material.scratch",
                "orgtree_read_transcript": "material.transcript"}
        # host-placed sandbox: transcript from the sandbox home, scratch as usual
        for tool, contract in read.items():
            for condition in ("cold", "warm"):
                self.run(contract, "sandbox:host-placed", condition, s, "reader", tool,
                         {"node": "first", "path": "notes.txt"})
        # material.effects: a read that mints a node's scratch directory hands it
        # to the container user (sandbox.chown_agent -> docker exec); the guard
        # refuses the process and the product swallows the failure by design
        self.run("material.scratch", "sandbox:chown-new-dir", "warm", s, "boss",
                 "orgtree_read_scratch", {"node": "second", "path": ""},
                 refusal="sandbox chown_agent refused (best-effort by design)",
                 expected_unknown=("guard:process/subprocess.Popen",))
        # disk-backed placement: scratch and transcript resolve through the
        # org's virtual disk (disk.windows_path -> `wsl -l -q`), refused here
        self.mutate(s, lambda o: o.d.update(disk=True))
        sandbox._disk_flag.pop(s, None)
        try:
            for tool, contract in read.items():
                self.run(contract, "sandbox:on-disk", "warm", s, "reader", tool,
                         {"node": "first", "path": "notes.txt"},
                         refusal="disk-backed sandbox path resolution (wsl refused)",
                         expected_unknown=("guard:process/subprocess.Popen",))
        finally:
            self.mutate(s, lambda o: o.d.pop("disk", None))
            sandbox._disk_flag.pop(s, None)

    # -- legacy JSON migration (diagnostic.writes/effects, preview.writes) -------
    def legacy_org(self, slug: str, actors: tuple[str, ...], state: str) -> str:
        """A synthetic org left in a legacy on-disk state for the SQLite
        backend. Built as an ordinary org (so its agent tokens exist), then:
        `json`: only `<slug>.json` (a restored pre-migration document);
        `bad-json`: only `<slug>.json`, holding invalid JSON;
        `interrupted`: a verified `<slug>.db.migrating` beside its
        `<slug>.json.premigration`, no `.json` and no `.db` (a crash between
        migrate_org's two renames)."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org(slug)
        slug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 30, "boss")
        org.hire(ledger.USER, "boss", "haiku", 8, "reader")
        org.hire(ledger.USER, "reader", "haiku", 0, "deep")
        org.hire(ledger.USER, "boss", "haiku", 2, "b")
        org.node("reader")["scope"]["org_visibility"] = "full"
        org.d["mail"] = {}
        store.save_org(org)
        for n in actors:
            self.tokens[(slug, n)] = self.m["agentauth"].child_env(slug, n)["ORGTREE_AGENT_TOKEN"]
        _NODES[slug] = {str(n) for n in store.load_org(slug).nodes}
        orgs = self.data / "orgs"
        db = orgs / f"{slug}.db"
        store.export_json(slug, dest=str(orgs / f"{slug}.json.export"))
        store._invalidate_snapshot(slug)
        store._POOL.close_all(slug)
        with contextlib.closing(sqlite3.connect(str(db))) as c:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if state == "interrupted":
            for suffix in ("-wal", "-shm"):
                (orgs / f"{slug}.db{suffix}").unlink(missing_ok=True)
            os.replace(db, orgs / f"{slug}.db.migrating")
            os.replace(orgs / f"{slug}.json.export", orgs / f"{slug}.json.premigration")
            return slug
        store._remove_db_files(str(db))
        os.replace(orgs / f"{slug}.json.export", orgs / f"{slug}.json")
        if state == "bad-json":
            (orgs / f"{slug}.json").write_text("{ not json", encoding="utf-8")
        return slug

    def migration(self) -> None:
        """Operations that meet a legacy on-disk state and migrate it (or are
        refused) inside the operation: the migration's writes and file
        effects are the operation's contacts. ORGTREE_MIGRATE is set for the
        one call that is meant to migrate; this process never claimed the
        data root, so without it the product refuses."""
        inspect = ("diagnostic.inspect", "orgtree_state_inspect", {})
        preview = ("preview.agent", "orgtree_preview",
                   {"operation": "reallocate", "args": {"node": "deep", "delta": 1}})
        for (contract, tool, args), family in ((inspect, "diagnostic"), (preview, "preview")):
            slug = self.legacy_org(f"p02-contacts-legacy-{family}", ("reader",), "json")
            self.run(contract, "migration:refused", "cold", slug, "reader", tool, args,
                     refusal="legacy .json without ORGTREE_MIGRATE: MigrationRefused",
                     env={"ORGTREE_MIGRATE": None})
            self.run(contract, "migration:legacy-json", "cold", slug, "reader", tool, args,
                     env={"ORGTREE_MIGRATE": "1"})
            self.run(contract, "migration:legacy-json", "warm", slug, "reader", tool, args)
        slug = self.legacy_org("p02-contacts-legacy-bad", ("reader",), "bad-json")
        self.run("diagnostic.inspect", "migration:malformed-json", "cold", slug, "reader",
                 "orgtree_state_inspect", {}, env={"ORGTREE_MIGRATE": "1"},
                 refusal="legacy .json that is not JSON: MigrationError")
        slug = self.legacy_org("p02-contacts-legacy-interrupted", ("reader",), "interrupted")
        self.run("diagnostic.inspect", "migration:interrupted", "cold", slug, "reader",
                 "orgtree_state_inspect", {}, env={"ORGTREE_MIGRATE": None})

    # -- unstubbed provider preflights (preview.effects) -------------------------
    def reset_provider_caches(self) -> None:
        sup, prov, orr = self.m["supervisor"], self.m["providers"], self.m["openrouter"]
        sup._claude_install_cache = None
        prov._status_cache = None
        prov._antigravity_status_cache = None
        orr.forget_key_status()

    def provider(self) -> None:
        """switch_model previews through the UNSTUBBED provider preflight, one
        per failure mode the gate names. Every provider condition is synthetic
        (executables, sign-in files and keys under the redirected HOME and
        data root); what the gate attempts beyond them is refused by the
        guards and recorded."""
        s, appsettings, openrouter = self.pslug, self.m["appsettings"], self.m["openrouter"]
        accounts_config = Path(os.path.expanduser("~/.claude.json"))
        codex_dir = self.bin.joinpath(*"abcdef")        # 6 levels: the package.json
        codex_dir.mkdir(parents=True, exist_ok=True)     # walk stays in the root
        codex = codex_dir / "codex.exe"
        codex.write_bytes(b"")
        codex_home = Path(os.path.expanduser("~/.codex"))

        def switch(variant: str, tier: str, refusal: str, *, account: "str | None" = None,
                   env: "dict[str, str | None] | None" = None,
                   expected_unknown: "tuple[str, ...]" = ()) -> None:
            self.reset_provider_caches()
            args: dict[str, Any] = {"node": "b", "tier": tier}
            if account:
                args["account"] = account
            self.run("preview.agent", f"provider:{variant}", "cold", s, "actor",
                     "orgtree_preview", {"operation": "switch_model", "args": args},
                     refusal=refusal, env=env, expected_unknown=expected_unknown)

        appsettings.set_provider_enabled("claude", False)
        try:
            switch("disabled", "sonnet", "provider turned off in app settings")
        finally:
            appsettings.set_provider_enabled("claude", True)
        switch("claude-not-installed", "sonnet", "Claude CLI not installed",
               env={"ORGTREE_CLAUDE": str(self.bin / "claude-absent.exe")})
        switch("claude-not-signed-in", "sonnet", "Claude not signed in")
        accounts_config.write_text(json.dumps({"oauthAccount": {
            "accountUuid": "00000000-0000-4000-8000-000000000002",
            "emailAddress": "fixture@example.invalid"}}), encoding="utf-8")
        try:
            switch("registry-unknown-account", "sonnet", "account not in the registry",
                   account="p02-absent-account")
        finally:
            accounts_config.unlink()
        switch("codex-not-installed", "luna", "Codex CLI not installed")
        switch("codex-not-signed-in", "luna", "Codex not signed in (version probe refused)",
               env={"ORGTREE_CODEX": str(codex)},
               expected_unknown=("guard:process/subprocess.Popen",))
        codex_home.mkdir(parents=True, exist_ok=True)
        (codex_home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "p02-fixture"}),
                                              encoding="utf-8")
        try:
            switch("legacy-tier", "gpt-reserve", "legacy tier refused by the tier registry",
                   env={"ORGTREE_CODEX": str(codex)},
                   expected_unknown=("guard:process/subprocess.Popen",))
        finally:
            (codex_home / "auth.json").unlink()
        ag_tier = sorted(self.m["providers"].ANTIGRAVITY_TIERS)[0]
        switch("antigravity-not-installed", ag_tier, "Antigravity CLI not installed")
        or_tier = openrouter.tier_id("anthropic/claude-sonnet-5")
        switch("openrouter-no-key", or_tier, "no OpenRouter key")
        openrouter.set_key("p02-fixture-key")
        try:
            switch("openrouter-network-refused", or_tier,
                   "OpenRouter key check: network refused by the guards",
                   expected_unknown=("guard:egress/urllib.Request",))
        finally:
            openrouter.set_key("")
            self.reset_provider_caches()

    # -- P01 S3 F1: status.report and chart.read ---------------------------------
    def build_status(self) -> None:
        """tests/test_state_status_chart_boundary.py's org shape, plus an archived
        node for the chart's include_archived rows. Node ids are distinctive
        (`st-*`) so the chart's `disclosed` set cannot match ordinary words."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-status")
        self.stslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 10, "st-chief")
        org.hire(ledger.USER, "st-chief", "haiku", 4, "st-worker")
        org.hire(ledger.USER, "st-chief", "haiku", 0, "st-sibling")
        org.hire(ledger.USER, "st-worker", "haiku", 0, "st-deep")
        org.hire(ledger.USER, "st-worker", "haiku", 0, "st-retired")
        org.retire(ledger.USER, "st-retired")
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for n in ("st-chief", "st-worker", "st-sibling"):
            self.tokens[(self.stslug, n)] = self.m["agentauth"].child_env(
                self.stslug, n)["ORGTREE_AGENT_TOKEN"]

    def status_chart(self) -> None:
        s, opreceipts = self.stslug, self.m["opreceipts"]
        supervisor, store = self.m["supervisor"], self.m["store"]

        def status(variant: str, condition: str, args: dict[str, Any], actor: str = "st-worker",
                   **kw: Any) -> None:
            # the report's parent is its implied counterparty, read from the
            # actor's STORED parent (not a literal), outside the window
            parent = store.load_org(s).node(actor).get("parent")
            implied = (str(parent),) if parent in _NODES.get(s, ()) else ()
            self.run("status.report", variant, condition, s, actor, "orgtree_status", args,
                     implied=implied, **kw)

        # every outcome the clause names, cold and warm; the wire case (done
        # to the parent) keeps its bare name
        outcomes = [
            ("status.report", {"status": "done", "summary": "fixture"}, "st-worker", None),
            ("status.report:working", {"status": "working", "summary": "w"}, "st-worker", None),
            ("status.report:idle", {"status": "idle", "summary": "i"}, "st-worker", None),
            ("status.report:unvalidated", {"status": "weird-state", "summary": "u"},
             "st-worker", None),
            ("status.report:blocked-with-parent", {"status": "blocked", "summary": "b"},
             "st-worker", None),
            ("status.report:done-top-level", {"status": "done", "summary": "top"},
             "st-chief", None),
            ("status.report:blocked-top-level", {"status": "blocked", "summary": "top"},
             "st-chief", None),
            ("refusal:status-bad-value", {"status": ["done"], "summary": "x"}, "st-worker",
             "non-scalar status value refused"),
        ]
        for variant, args, actor, refusal in outcomes:
            for condition in ("cold", "warm"):
                status(variant, condition, args, actor=actor, refusal=refusal)
        epoch = self.client.post("/api/agent",
                                 json=self.agent_body(s, "st-worker", opreceipts.OP_EPOCH, {}),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, "st-worker")]}
                                 ).json()["epoch"]
        for condition in ("cold", "warm"):
            key = opreceipts.mint_key()
            status("status.report:keyed-fresh", condition, {"status": "done", "summary": "k"},
                   key=key, epoch=epoch)
            status("status.report:keyed-replay", condition, {"status": "done", "summary": "k"},
                   key=key, epoch=epoch,
                   refusal="keyed replay (answered from the receipt, no effect)")
        self.mutate(s, lambda o: o.node("st-sibling").update(halt={"at": "fixture"}))
        for condition in ("cold", "warm"):
            status("refusal:status-halted", condition, {"status": "done", "summary": "x"},
                   actor="st-sibling", refusal="409 halted")
        self.mutate(s, lambda o: o.node("st-sibling").pop("halt", None))

        # agent-level locality control: a done report whose delivery step ALSO
        # posts mail to a third agent ('st-sibling') inside the operation
        def notify_and_mail_third(*_a: Any, **_k: Any) -> dict[str, Any]:
            with store.write_org(s) as org:
                org.post_mail("st-worker", "st-sibling", "p02 control: mail to a third agent")
                store.save_org(org)
            return {"delivered": True}
        status("control:status-third-agent-mail", "warm", {"status": "done", "summary": "c"},
               refusal="negative control (not a product path)",
               patches=[(supervisor, "send_message", notify_and_mail_third)])

        # chart.read: the wire case, then every visibility level with and
        # without archived rows, cold and warm
        for condition in ("cold", "warm"):
            self.run("chart.read", "chart.read", condition, s, "st-worker", "orgtree_chart", {},
                     disclose=True)
        for level in ("self", "team", "subtree", "full"):
            self.mutate(s, lambda o, level=level: o.node("st-worker")["scope"].update(
                org_visibility=level))
            for archived in (False, True):
                args = {"include_archived": True} if archived else {}
                for condition in ("cold", "warm"):
                    variant = f"chart.read:{level}" + ("+archived" if archived else "")
                    self.run("chart.read", variant,
                             condition, s, "st-worker", "orgtree_chart", args, disclose=True)
        # chart.writes: a snapshot miss falls through to load_org and
        # _ensure_migrated, so a legacy org is migrated by a chart read
        slug = self.legacy_org("p02-contacts-legacy-chart", ("reader",), "json")
        self.run("chart.read", "migration:refused", "cold", slug, "reader", "orgtree_chart", {},
                 refusal="legacy .json without ORGTREE_MIGRATE: MigrationRefused",
                 env={"ORGTREE_MIGRATE": None})
        self.run("chart.read", "migration:legacy-json", "cold", slug, "reader", "orgtree_chart", {},
                 env={"ORGTREE_MIGRATE": "1"})
        self.run("chart.read", "migration:legacy-json", "warm", slug, "reader", "orgtree_chart", {})

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
        """The whole workload on the SQLite backend; on the JSON backend
        (``--store json``, run as a child process by ``main``) the structural
        diagnostic family only, which is what the JSON clause names."""
        self.prepare()
        json_backend = self.backend == "json"
        self.build()
        if not json_backend:
            self.build_sandbox()
            self.build_status()
        for slug in ((self.dslug,) if json_backend else
                     (self.rslug, self.mslug, self.dslug, self.pslug, self.sslug,
                      self.stslug)):
            _NODES[slug] = {str(n) for n in self.m["store"].load_org(slug).nodes}
        self.operator("post", "/api/diagnostics/operation-census/reset")
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": True})
        w0 = self.census_state()
        if json_backend:
            self.diagnostic()
        else:
            self.reservation()
            self.material()
            self.sandboxed()
            self.diagnostic()
            self.migration()
            self.preview()
            self.provider()
            self.status_chart()
        w1 = self.census_state()
        self.load_table_catalogue()
        self.map_tables()
        residuals = None if json_backend else self.residuals()
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": False})
        self.restore_sql()
        self.restore_clone()
        loss = {k: w1["counters"].get(k, 0) - w0["counters"].get(k, 0)
                for k in ("observed", "recorded", "rejected", "dropped_stale_window",
                          "dropped_capture_off", "evicted", "db_unbound", "db_late",
                          "db_unattributed", "db_hidden_unattributed", "db_observe_failed",
                          "db_self_recursion", "skipped_self", "unclassified_action")}
        return {
            "schema": SCHEMA, "tool_version": TOOL_VERSION, "provenance": self.provenance,
            "backend": self.backend, "limits": LIMITS, "warnings": self.warnings,
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
    p.add_argument("--store", choices=("sqlite", "json"), default="sqlite",
                   help="the primary store backend (json: the diagnostic family only)")
    p.add_argument("--no-json-child", action="store_true",
                   help="do not run the JSON-backend child (sqlite run only)")
    args = p.parse_args(argv)
    out = Path(args.out).resolve()
    work = Path(args.work).resolve() if args.work else out
    ig = _load_guards()
    protected = ig.all_protected(ig.pinned_protected_roots(os.environ))
    for label, path in (("output", out), ("work folder", work)):
        ig.refuse_overlap(label, str(path), protected)   # before any mkdir (review N1)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    child_doc = None
    if args.store == "sqlite" and not args.no_json_child:
        # The store backend is fixed at import, so the JSON backend needs its
        # own process. It is started HERE, before this process installs any
        # guard (the guards refuse every process start); the child is itself
        # fully guarded and writes under this run's output folder.
        child_out = out / "json-backend"
        proc = subprocess.run(
            [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--store", "json",
             "--out", str(child_out), "--work", str(work)],
            capture_output=True, text=True, timeout=1200)
        if proc.returncode != 0:
            raise SystemExit(f"JSON-backend child exited {proc.returncode}: {proc.stderr[-3000:]}")
        child_doc = json.loads((child_out / "operation-contacts.json").read_text(encoding="utf-8"))
    probe = Probe(work, out, backend=args.store)
    doc = probe.execute()
    if child_doc is not None:
        doc["rows"].extend(child_doc["rows"])
        doc["json_backend"] = {k: child_doc[k] for k in ("provenance", "warnings", "window",
                                                         "between_operations")}
    (out / "operation-contacts.json").write_text(json.dumps(doc, indent=1, sort_keys=True),
                                                 encoding="utf-8")
    (out / "operation-contacts.md").write_text(markdown(doc), encoding="utf-8")
    print(json.dumps({"rows": len(doc["rows"]), "out": str(out),
                      "all_match": all(r["harness"]["matches_census"] for r in doc["rows"])}),
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
