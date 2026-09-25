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
import base64
import collections
import contextlib
import copy
import gc
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import warnings
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
KNOWN_CATEGORIES = ("code", "descriptor", "data:org-db:own", "data:org-db:temp",
                    "data:sidecar-db", "data:scratch", "data:sandbox", "data:other",
                    "home:provider", "run:other")
KNOWN_GROUPS = ("file_read", "file_write", "dir_list", "fs_mutation", "sqlite_connect", "stat")
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
#: (category, where) of the installed audit counter, for `Probe.observe_stats`
_AUDIT: Any = None


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


def store_class(path: Any, data: Path, own: "str | None") -> str:
    """The store a connection's database file belongs to: the operation's own
    org store, ANOTHER org's store, a sidecar under the data root, or other.
    Only the class is kept, never the path."""
    p = str(path or "").split("?", 1)[0].replace("/", "\\").lower()
    if p.startswith("file:"):
        p = p[5:]
    p = p.lstrip("\\")
    root = str(data).replace("/", "\\").lower().lstrip("\\")
    if not p.startswith(root):
        return "other"
    rest = p[len(root):].lstrip("\\")
    if rest.startswith("orgs\\"):
        stem = rest[5:].split("\\", 1)[0].split(".", 1)[0]
        return "data:org-db:own" if own and stem == own.lower() else "data:org-db:foreign"
    return "data:sidecar-db"


def product_frame() -> str:
    """The innermost engine/backend/orgtree frame outside census_contacts, as
    `orgtree.<module>:<function>` (code names only, never data)."""
    frame = sys._getframe(2)
    while frame is not None:
        name = frame.f_code.co_filename.replace("\\", "/")
        at = name.find("/engine/backend/orgtree/")
        if at >= 0 and not name.endswith("census_contacts.py"):
            module = name[at + 24:].removesuffix(".py").replace("/", ".")
            return "orgtree." + module + ":" + frame.f_code.co_name
        frame = frame.f_back
    return "?"


def caller_frame() -> str:
    """Like `product_frame`, but the innermost frame outside the store layer
    too (census_contacts.py, store.py): the product STEP that asked for the
    rows (a ledger or api function), not the loader that fetched them."""
    frame = sys._getframe(2)
    while frame is not None:
        name = frame.f_code.co_filename.replace("\\", "/")
        at = name.find("/engine/backend/orgtree/")
        if at >= 0 and not name.endswith(("census_contacts.py", "/store.py")):
            module = name[at + 24:].removesuffix(".py").replace("/", ".")
            return "orgtree." + module + ":" + frame.f_code.co_name
        frame = frame.f_back
    return "?"


def install_sql_observer(contacts: Any, data: Path) -> Callable[[], None]:
    """Wrap ``census_contacts._run`` (a module global every observed cursor
    and connection method calls) so the harness sees each statement's SQL and
    store label. The statement runs exactly as before.

    Every observed connection's database file is also recorded when the
    connection is CREATED (``ObservedConnection.__init__``, which the sidecar
    classes inherit), so each statement is classified by the store it ran on:
    a read on an already-pooled FOREIGN org store is visible even though no
    connect happens. Nothing extra is executed on the connection."""
    original = contacts._run
    cursor = contacts.ObservedCursor
    original_execute, original_many = cursor.execute, cursor.executemany
    connection = contacts.ObservedConnection
    original_init = connection.__init__
    paths: dict[int, str] = {}

    def init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        paths[id(self)] = str(args[0] if args else kwargs.get("database", ""))

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
        db = (store_class(paths[id(conn)], data, target.slug)
              if id(conn) in paths else "unmapped")
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
                # where the product ran a statement naming node ids, so a
                # third agent's row is attributed to a product step
                "agent_at": caller_frame() if agent_rows else None,
                "db": db,
                "db_at": product_frame() if db == "data:org-db:foreign" else None,
                "tally": id(tally) if tally is not None else None})

    contacts._run = observed
    cursor.execute, cursor.executemany = execute, executemany
    connection.__init__ = init

    def restore() -> None:
        contacts._run = original
        cursor.execute, cursor.executemany = original_execute, original_many
        connection.__init__ = original_init
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
    # a statement on another org's store (or on a connection whose file is
    # unknown) is a contact class of its own, visible warm or cold
    out.update(f"statement:{cls}" for cls in row["harness"].get("statement_stores", {})
               if cls not in ("data:org-db:own", "data:sidecar-db"))
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
                name = rest[5:].split("\\", 1)[0]
                if re.fullmatch(r"tmp[a-z0-9_]+\.tmp", name):
                    # an unnamed tempfile.mkstemp file (the JSON store's save):
                    # it names no org; the rename that lands it names the
                    # destination (see the fs_mutation branch of the hook)
                    return "data:org-db:temp"
                # org-store locality: the operation's own org, or another one
                stem = name.split(".", 1)[0]
                if own is None:
                    return "data:org-db"
                return "data:org-db:own" if stem == own.lower() else "data:org-db:foreign"
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
                module = name[at + 24:].removesuffix(".py").replace("/", ".")
                return "orgtree." + module + ":" + frame.f_code.co_name
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
                cat = category(args[0] if args else None, target.slug)
                if cat == "data:org-db:temp" and event == "os.rename" and len(args) > 1:
                    # a temp file renamed into place (os.replace audits as
                    # os.rename): classified by the store it lands on
                    cat = category(args[1], target.slug)
                target.count("fs_mutation", event + ":" + cat + "@" + where())
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

    global _AUDIT
    _AUDIT = (category, where)
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


PROVENANCE_REFUSED = "P02 PROBE PROVENANCE REFUSED"


class ProbeProvenanceError(RuntimeError):
    """The probe imported code that is not the tree it was asked to measure."""


def expected_imports(root: Path) -> dict[str, Path]:
    return {"engine": root / "engine" / "__init__.py",
            "orgtree": root / "engine" / "backend" / "orgtree" / "__init__.py"}


def _same_file(a: "str | Path", b: "str | Path") -> bool:
    return (os.path.normcase(os.path.realpath(str(a)))
            == os.path.normcase(os.path.realpath(str(b))))


def assert_probe_imports(root: Path) -> dict[str, str]:
    """Import `engine` and `orgtree` and refuse unless each module's own
    `__file__` is exactly this tree's (tools/assert_repo_import.py's rule:
    only the imported module's `__file__` settles it). The refusal names the
    path that was actually loaded; it is raised before any row exists, so a
    refused run writes no output. It must run BEFORE the app loads: once
    `engine.launch` is imported, whatever code answered has already run, so a
    late check refuses too."""
    if "engine.launch" in sys.modules:
        raise ProbeProvenanceError(
            f"{PROVENANCE_REFUSED}: the import check ran after the app was loaded "
            f"(engine.launch from {getattr(sys.modules['engine.launch'], '__file__', None)}); "
            f"it must run before any code under test does. No rows were produced.")
    loaded: dict[str, str] = {}
    for name, want in expected_imports(root).items():
        try:
            module = importlib.import_module(name)
        except ImportError as exc:
            raise ProbeProvenanceError(
                f"{PROVENANCE_REFUSED}: {name} could not be imported at all "
                f"(expected {want}): {exc}") from exc
        got = getattr(module, "__file__", None)
        if not got or not _same_file(got, want):
            raise ProbeProvenanceError(
                f"{PROVENANCE_REFUSED}: {name} was imported from {got}, not from the "
                f"tree under test ({want}). The root is not importable here (missing, "
                f"or in a guarded folder), and the interpreter fell back to other code. "
                f"No rows were produced.")
        loaded[name] = str(Path(got).resolve())
    return loaded


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
        # BEFORE the app loads and before any row: the code under test must be
        # THIS tree's. A root the interpreter cannot import from (missing, or
        # guarded so the read raises) does not fail the import; the runtime's
        # `._pth` fallback answers with another checkout's orgtree instead.
        self.imported = assert_probe_imports(ROOT)
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
            # checked, not only recorded (assert_probe_imports, before load_app)
            "imports_checked": dict(self.imported),
            "python": sys.version.split()[0], "native_blocked": self.native_blocked,
            "store_backend": store.STORE_BACKEND}
        self.client = TestClient(self.app, raise_server_exceptions=False,
                                 client=("127.0.0.1", 43000))
        self.restore_sql = install_sql_observer(census_contacts, self.data)
        self.restore_clone = install_clone_observer(statepreview)
        # spies: delivery is counted, never executed (as in the P01 boundary tests)
        self.wakes = {"send_message": 0, "mail_notify": 0}
        self.immediate = [0]     # its own row field: `wakes` keeps P01's two keys

        def send_message(*_a: Any, **_k: Any) -> dict[str, Any]:
            self.wakes["send_message"] += 1
            return {"delivered": True}

        def mail_notify(*_a: Any, **_k: Any) -> None:
            self.wakes["mail_notify"] += 1

        def immediate_command(*_a: Any, **_k: Any) -> bool:
            # a human session command's immediate path (a throwaway session
            # fork in the product): counted, never run, and declined so the
            # route takes its command delivery (send_message, spied)
            self.immediate[0] += 1
            return False

        # the boot build identity the app freezes at startup
        # (restart_wake.on_backend_startup, which the probe never runs): left
        # unset, the first docket read would compute it and start `git`
        from orgtree import restart_wake
        restart_wake._reset_boot_build_info_for_tests({
            "commit": self.commit, "commit_short": self.commit[:7], "dirty": False,
            "branch": "p02-probe", "backend_pid": os.getpid(), "started_at": "probe"})
        supervisor.send_message = send_message
        supervisor.immediate_command = immediate_command
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
                        val = json.loads(row[0]) if row else None
                        if isinstance(val, dict):
                            # PG-3d per-owner split (store.SPLIT_SECTIONS):
                            # `key` is a container, each owner's list its own
                            # row keyed `key\x1fowner`
                            pre = key + "\x1f"
                            for k, v in c.execute(
                                    "SELECT key, val FROM doc WHERE substr(key, 1, ?) = ?",
                                    (len(pre), pre)):
                                val[k[len(pre):]] = json.loads(v)
                        snap[key] = val
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
        third_sites: dict[str, int] = {}
        written: set[str] = set()
        third_rows_written = 0
        for st in c.statements:
            table = (st["written"] or st["read"] or ["other"])[0]
            rw = "write" if st["kind"] in WRITE_KINDS else "read"
            for ids in st.get("agent_rows") or []:
                for nid in ids:
                    r = self.role(nid, actor, targets)
                    nodes[nid] = r
                    if rw == "write":
                        written.add(nid)
                    key = f"{table}:{rw}:{r}"
                    physical[key] = physical.get(key, 0) + 1
                    if r == "third":
                        site = f"{table}:{rw}@{st.get('agent_at') or '?'}"
                        third_sites[site] = third_sites.get(site, 0) + 1
                        if rw == "write":
                            third_rows_written += 1
        logical = {sect: {nid: self.role(nid, actor, targets) for nid in ids}
                   for sect, ids in changes.items()}
        return {
            "actor": actor, "targets": targets,
            "physical": dict(sorted(physical.items())),
            "physical_nodes": dict(sorted(nodes.items())),
            # the agents whose rows a statement WROTE (a subset of physical_nodes)
            "physical_written": sorted(written),
            "logical": logical,
            "mail_producing": bool(changes),
            "third_agent_mail": sum(1 for sect in logical.values()
                                    for r in sect.values() if r == "third"),
            "third_agent_rows_written": third_rows_written,
            # the product step behind each physical touch of a third agent's row
            "third_sites": dict(sorted(third_sites.items())),
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
            implied: "tuple[str, ...]" = (), disclose: bool = False,
            call: "Callable[[], tuple[int, Any]] | None" = None) -> dict[str, Any]:
        """One operation. `env` is applied for this call only (None removes a
        variable); `expected_unknown` declares the contact classes outside the
        known set that this row provokes on purpose; `implied` names counterparties
        the operation reaches without naming them (see `agents`); `disclose` records
        which of the org's synthetic node ids appear in the answer (`disclosed`).
        `call` replaces the agent door for routes that are not `/api/agent` (an
        HTTP GET, a websocket): it returns (status, payload) and runs inside
        the same window, census baseline and collector."""
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
        immediate0 = self.immediate[0]
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
            if call is not None:
                status, payload = call()
            else:
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
        row["immediate_command"] = self.immediate[0] - immediate0
        row["disclosed"] = None
        if disclose:
            text = json.dumps(payload) if payload is not None else ""
            row["disclosed"] = sorted(
                n for n in _NODES.get(slug, ())
                if re.search(r"(?<![\w-])" + re.escape(n) + r"(?![\w-])", text))
        row["feed"] = (payload.get("feed") if call is not None and isinstance(payload, dict)
                       else None)
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
                # by the store each statement ran on (own org, ANOTHER org, a
                # sidecar), from the connection's file recorded at creation
                "statement_stores": dict(sorted(collections.Counter(
                    s.get("db", "unmapped") for s in c.statements).items())),
                # where the product ran each statement on ANOTHER org's store
                "foreign_statement_sites": dict(sorted(collections.Counter(
                    s["db_at"] for s in c.statements if s.get("db_at")).items())),
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
                 expected_unknown=("sqlite_connect:data:org-db:foreign",
                                   "statement:data:org-db:foreign"))
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

    # -- P01 S3 F1b: org.tree, org.node-detail, org.feed --------------------------
    KIOSK = "p02kioskTOKEN77"
    OPERATOR = {"X-Orgtree-Desktop-Token": "operator"}

    def build_org_view(self) -> None:
        """tests/test_state_org_view_boundary.py's org (with an archived
        node), kiosk-enabled so the public side exists. Distinctive `ov-*`
        ids, so `disclosed` cannot match ordinary words."""
        store, ledger, api = self.m["store"], self.m["ledger"], self.m["api"]
        org = store.create_org("p02-contacts-orgview")
        self.ovslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 10, "ov-boss")
        org.hire(ledger.USER, "ov-boss", "haiku", 4, "ov-worker")
        org.hire(ledger.USER, "ov-boss", "haiku", 0, "ov-gone")
        org.retire(ledger.USER, "ov-gone")
        store.save_org(org)
        from fastapi.testclient import TestClient
        self.public = TestClient(api.PublicGateway(api.app), raise_server_exceptions=False,
                                 client=("127.0.0.1", 43001))

    def measure_kiosk_scan(self) -> dict[str, Any]:
        """The public gateway's kiosk token-map rebuild (api._kiosk_token_map,
        cache forced stale), measured OUTSIDE any operation row because no
        census attempt exists when it runs: its statements, how many of them
        the census could not attribute, its connects, and the orgs it read."""
        global _CURRENT
        api = self.m["api"]
        api._token_cache["at"] = 0.0
        collector = Collector("kiosk-token-scan", self.ovslug)
        before = self.census_state()
        _CURRENT = collector
        try:
            mapped = api._kiosk_token_map()
        finally:
            _CURRENT = None
        after = self.census_state()
        c0, c1 = before.get("counters", {}), after.get("counters", {})
        return {
            "statements": len(collector.statements),
            "statements_unbound": sum(1 for st in collector.statements if st["tally"] is None),
            "db_unattributed_delta": c1.get("db_unattributed", 0) - c0.get("db_unattributed", 0),
            "recorded_delta": c1.get("recorded", 0) - c0.get("recorded", 0),
            "sqlite_connect": sum(collector.audit.get("sqlite_connect", {}).values()),
            "orgs_listed": len(list(self.data.joinpath("orgs").glob("*.db"))),
            "kiosk_orgs_mapped": len(mapped),
        }

    @staticmethod
    def observe_stats() -> "list[tuple[Any, str, Any]]":
        """Row patches that count os.path.isfile / os.path.getsize calls as
        `stat` contacts (path category and product frame, like the audit
        hook). A stat raises no audit event, so without them a human send's
        attachment check would be invisible; applied to the attachment rows
        only."""
        category, where = _AUDIT

        def wrap(fn: Callable[..., Any]) -> Callable[..., Any]:
            def observed(path: Any, *a: Any, **k: Any) -> Any:
                target = _CURRENT or _BETWEEN
                target.count("stat", category(path, target.slug) + "@" + where())
                return fn(path, *a, **k)
            return observed
        return [(os.path, name, wrap(getattr(os.path, name))) for name in ("isfile", "getsize")]

    @staticmethod
    def http(client: Any, path: str, headers: "dict[str, str] | None" = None,
             body: Any = None) -> Callable[[], tuple[int, Any]]:
        """A GET, or a POST of `body` when one is given."""
        def call() -> tuple[int, Any]:
            if body is None:
                resp = client.get(path, headers=headers or {})
            else:
                resp = client.post(path, json=body, headers=headers or {})
            try:
                payload = resp.json()
            except ValueError:
                payload = None
            return resp.status_code, payload
        return call

    def feed(self, subscribers: "list[tuple[str, Any, str, dict[str, str]]]", frames: int
             ) -> Callable[[], tuple[int, Any]]:
        """Open one websocket per subscriber (label, client, path, headers),
        publish `frames` 'changed' broadcasts through the hub, and return how
        many frames each subscriber received and whether the hub holds it as
        public. A refused socket answers its close code."""
        api = self.m["api"]
        slug = self.ovslug

        def call() -> tuple[int, Any]:
            from starlette.websockets import WebSocketDisconnect
            try:
                return connected()
            except WebSocketDisconnect as exc:
                return exc.code, {"feed": {"refused": True, "close_code": exc.code}}

        def connected() -> tuple[int, Any]:
            with contextlib.ExitStack() as stack:
                sockets = []
                for label, client, path, headers in subscribers:
                    sockets.append((label, stack.enter_context(
                        client.websocket_connect(path, headers=headers))))
                room = set(api.hub.rooms.get(slug) or ())
                got = {label: 0 for label, _ in sockets}
                for _ in range(frames):
                    sockets[0][1].portal.call(api.hub.changed, slug)
                    for label, ws in sockets:
                        if ws.receive_json().get("type") == "changed":
                            got[label] += 1
                return 101, {"feed": {"subscribers": len(room), "frames": got,
                                      "public_in_room": len(room & api.hub.public)}}
        return call

    def org_view(self) -> None:
        s, op = self.ovslug, self.OPERATOR
        admin, public = self.client, self.public
        tree, kiosk = f"/api/orgs/{s}", f"/k/{self.KIOSK}"

        def get(contract: str, variant: str, condition: str, client: Any, path: str,
                headers: "dict[str, str] | None" = None, **kw: Any) -> None:
            self.run(contract, variant, condition, s, "ov-boss", f"GET {contract}", {},
                     call=self.http(client, path, headers), disclose=True, **kw)

        # admin side, on the org before its kiosk is enabled (a kiosk-enabled
        # org's admin tree is the desktop-mode 500 P01 pinned, recorded below)
        for condition in ("cold", "warm"):
            # the admin tree reads one doc row from EVERY other org
            # (store.local_net_slugs, marking hub peers that are local orgs)
            get("org.tree", "org.tree", condition, admin, tree, op,
                expected_unknown=("statement:data:org-db:foreign",))
            get("org.node-detail", "org.node-detail", condition, admin,
                f"{tree}/nodes/ov-worker/detail", op)
            get("org.node-detail", "org.node-detail:archived", condition, admin,
                f"{tree}/nodes/ov-gone/detail", op)
        get("org.tree", "refusal:tree-no-token", "warm", admin, tree, {},
            refusal="401 without the desktop token")
        get("org.node-detail", "refusal:detail-unknown-node", "warm", admin,
            f"{tree}/nodes/nobody/detail", op, refusal="404 unknown node")

        # public side: enable the kiosk, then measure the gateway's token-map
        # rebuild ON ITS OWN. It runs in the ASGI wrapper before the app, so
        # before any census attempt exists, and reads every org's document.
        # The public rows below run with the map PINNED fresh (its timestamp
        # set far ahead, so the real lookup answers from the built map however
        # long a row takes): they carry only their own request's contacts,
        # independent of the 5 s cache. In the product, any public request
        # made after the cache expired carries the every-org read as well.
        def kiosk_on(o: Any) -> None:
            o.d["kiosk"] = {"enabled": True, "token": self.KIOSK,
                            "max_scope": o.default_kiosk_ceiling()}
        self.mutate(s, kiosk_on)
        self.kiosk_scan = self.measure_kiosk_scan()
        api = self.m["api"]
        api._token_cache["at"] = time.time() + 1e9     # pinned until the feed rows end
        for condition in ("cold", "warm"):
            get("org.tree", "org.tree:public", condition, public, kiosk + tree)
            get("org.node-detail", "org.node-detail:public", condition, public,
                f"{kiosk}{tree}/nodes/ov-worker/detail")
        get("org.tree", "refusal:tree-bad-kiosk-token", "warm", public,
            f"/k/nopenopenope/api/orgs/{s}", refusal="404 unknown kiosk token")
        get("org.tree", "refusal:tree-admin-on-kiosk-org", "warm", admin, tree, op,
            refusal="desktop-mode 500 on a kiosk-enabled org (legacy defect pinned by P01)")
        # org-view.writes: a snapshot miss falls through cached_org to
        # load_org and _ensure_migrated, so a legacy org migrates in a GET
        legacy = self.legacy_org("p02-contacts-legacy-orgview", (), "json")
        for variant, condition, env in (("migration:refused", "cold", {"ORGTREE_MIGRATE": None}),
                                        ("migration:legacy-json", "cold", {"ORGTREE_MIGRATE": "1"}),
                                        ("migration:legacy-json", "warm", None)):
            self.run("org.tree", variant, condition, legacy, "boss", "GET org.tree", {},
                     call=self.http(admin, f"/api/orgs/{legacy}", op), env=env,
                     expected_unknown=(("statement:data:org-db:foreign",)
                                       if variant == "migration:legacy-json" else ()),
                     refusal=("legacy .json without ORGTREE_MIGRATE: MigrationRefused"
                              if variant == "migration:refused" else None))

        # org.feed: subscriptions and the frame fan-out, admin and public
        ws = f"{tree}/ws"
        adm = ("admin", admin, ws, op)
        pub = ("public", public, kiosk + ws, {})
        for condition in ("cold", "warm"):
            self.run("org.feed", "org.feed", condition, s, "ov-boss", "WS org.feed", {},
                     call=self.feed([adm], 1))
            self.run("org.feed", "org.feed:public", condition, s, "ov-boss", "WS org.feed", {},
                     call=self.feed([pub], 1))
        self.run("org.feed", "org.feed:fanout", "warm", s, "ov-boss", "WS org.feed", {},
                 call=self.feed([adm, pub], 2))
        self.run("org.feed", "refusal:feed-no-token", "warm", s, "ov-boss", "WS org.feed", {},
                 call=self.feed([("admin", admin, ws, {})], 0),
                 refusal="socket without the desktop token closed")
        self.m["api"]._token_cache["at"] = 0.0          # unpin the kiosk token map

    # -- P01 S3 F2: mail.message, mail.notice ---------------------------------------
    def build_mail(self) -> None:
        """tests/test_state_agent_mail_boundary.py's org (distinctive `m-*`
        ids) and a second, destination org for @org: mail."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-mail")
        self.mlslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 10, "m-top")
        org.hire(ledger.USER, "m-top", "haiku", 6, "m-mid")
        org.hire(ledger.USER, "m-top", "haiku", 0, "m-sib")
        org.hire(ledger.USER, "m-mid", "haiku", 2, "m-kid")
        org.hire(ledger.USER, "m-kid", "haiku", 0, "m-deep")
        org.hire(ledger.USER, "m-sib", "haiku", 0, "m-cousin")
        org.hire(ledger.USER, "m-top", "haiku", 0, "m-gone")
        org.retire(ledger.USER, "m-gone")
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for n in ("m-top", "m-mid", "m-sib"):
            self.tokens[(self.mlslug, n)] = self.m["agentauth"].child_env(
                self.mlslug, n)["ORGTREE_AGENT_TOKEN"]
        self.mldest = str(store.create_org("p02-contacts-mail-dest").d["slug"])

    def mail(self) -> None:
        s, dest, opreceipts = self.mlslug, self.mldest, self.m["opreceipts"]
        supervisor, store = self.m["supervisor"], self.m["store"]
        msg, note = "orgtree_message", "orgtree_send_notice"

        def send(contract: str, variant: str, condition: str, tool: str, actor: str, to: str,
                 **kw: Any) -> None:
            extra = kw.pop("extra", {})
            self.run(contract, variant, condition, s, actor, tool,
                     dict(to=to, body="fixture", **extra), **kw)

        both = ("cold", "warm")
        # mail.message by recipient class (P01 agent-mail.reads), cold and warm.
        # The cold deep/@org: rows are the FIRST send (grant); warm, the second.
        # Two rows reach OTHER orgs' stores: @org: delivers into the
        # destination org (supervisor.interorg_send, unstubbed), and a bare
        # unknown name is looked up across every org. Their statements on the
        # foreign store are declared cold AND warm; cold, the foreign store is
        # closed too, so its connect is observed (declared on the cold row)
        cases = [
            ("mail.message", "m-mid", "m-top", {}),
            ("mail.message:deep", "m-mid", "m-deep", {}),
            ("mail.message:archived", "m-top", "m-gone", {}),
            ("mail.message:user", "m-top", "user", {}),
            ("mail.message:org", "m-top", f"@org:{dest}", {"cross_org": True}),
            # @mcp: was retired on 2026-09-25 (ledger.MCP_RETIRED)
            ("refusal:mail-message-mcp-retired", "m-top", "@mcp:peer1",
             {"refusal": "the @mcp: address form is retired"}),
            ("mail.message:bare-unknown-name", "m-mid", "nobody-here",
             {"refusal": "422 NOT DELIVERED: a bare name that is no agent here",
              "cross_org": True}),
        ]
        for variant, actor, to, kw in cases:
            kw = dict(kw)
            cross_org = kw.pop("cross_org", False)
            for condition in both:
                declared: tuple[str, ...] = ()
                if cross_org:
                    declared = ("statement:data:org-db:foreign",)
                    if condition == "cold":
                        self.cold((dest,))
                        declared += ("sqlite_connect:data:org-db:foreign",)
                send("mail.message", variant, condition, msg, actor, to,
                     expected_unknown=declared, **kw)
        for variant, actor, to, kw in [
                ("mail.notice", "m-mid", "m-sib", {}),
                ("mail.notice:deep", "m-top", "m-kid", {}),
                ("mail.notice:archived", "m-top", "m-gone", {})]:
            for condition in both:
                send("mail.notice", variant, condition, note, actor, to, **kw)
        send("mail.notice", "refusal:notice-to-org", "warm", note, "m-top", f"@org:{dest}",
             refusal="422 notices are for agents in this org")
        send("mail.notice", "refusal:notice-to-user", "warm", note, "m-top", "user",
             refusal="422 notices are for agents in this org")
        epoch = self.client.post("/api/agent",
                                 json=self.agent_body(s, "m-mid", opreceipts.OP_EPOCH, {}),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, "m-mid")]}
                                 ).json()["epoch"]
        for contract, tool, to in (("mail.message", msg, "m-top"), ("mail.notice", note, "m-sib")):
            for condition in both:
                key = opreceipts.mint_key()
                send(contract, f"{contract}:keyed-fresh", condition, tool, "m-mid", to,
                     key=key, epoch=epoch)
                send(contract, f"{contract}:keyed-replay", condition, tool, "m-mid", to,
                     key=key, epoch=epoch,
                     refusal="keyed replay (answered from the receipt, no effect)")
        self.mutate(s, lambda o: o.node("m-sib").update(halt={"at": "fixture"}))
        send("mail.message", "refusal:mail-halted", "warm", msg, "m-sib", "m-top",
             refusal="409 halted")
        self.mutate(s, lambda o: o.node("m-sib").pop("halt", None))

        # agent-level locality control: a send to the addressed recipient
        # whose delivery step ALSO posts mail to a third agent ('m-sib', from
        # 'm-top', which may address it)
        def notify_and_mail_third(*_a: Any, **_k: Any) -> dict[str, Any]:
            with store.write_org(s) as org:
                org.post_mail("m-top", "m-sib", "p02 control: mail to a third agent")
                store.save_org(org)
            return {"delivered": True}
        send("mail.message", "control:mail-third-agent", "warm", msg, "m-mid", "m-top",
             refusal="negative control (not a product path)",
             patches=[(supervisor, "send_message", notify_and_mail_third)])

    # -- P01 S3 F2, the human side: mail.human-send and the three inbox routes -----
    def build_human(self) -> None:
        """tests/test_state_human_mail_boundary.py's org (distinctive `h-*`
        ids) plus a third agent ('h-sib'), a staged attachment in h-top's
        working folder, four user-inbox rows from h-top and one mail h-top
        sent to its report."""
        store, ledger, supervisor = self.m["store"], self.m["ledger"], self.m["supervisor"]
        org = store.create_org("p02-contacts-human")
        self.hslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 10, "h-top")
        org.hire(ledger.USER, "h-top", "haiku", 6, "h-mid")
        org.hire(ledger.USER, "h-mid", "haiku", 0, "h-deep")
        org.hire(ledger.USER, "h-top", "haiku", 0, "h-sib")
        org.hire(ledger.USER, "h-top", "haiku", 0, "h-gone")
        org.retire(ledger.USER, "h-gone")
        org.d["mail"], org.d["audiences"] = {}, []
        for i in range(4):
            org.post_mail("h-top", "user", f"report {i} for you")
        org.post_mail("h-top", "h-mid", "to my report")
        store.save_org(org)
        base = Path(supervisor.scratch_dir(self.hslug, "h-top"))
        (base / "brief.txt").write_text("synthetic attachment", encoding="utf-8")
        self.user_mail = [str(m["id"]) for m in store.read_user_inbox(self.hslug)["pending"]]

    def human(self) -> None:
        """mail.human-send by class (top-level, deep, archived, notice, session
        command, attachment, both reply forms), cold and warm, as the operator
        (@user). `implied`: the superior chain a deep-reach notice reaches."""
        s, store, supervisor = self.hslug, self.m["store"], self.m["supervisor"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")

        def send(variant: str, condition: str, nid: str, body: dict[str, Any],
                 **kw: Any) -> None:
            self.run("mail.human-send", variant, condition, s, user, "POST mail.human-send",
                     {"to": nid}, call=self.http(self.client,
                                                 f"/api/orgs/{s}/nodes/{nid}/message", op, body),
                     **kw)

        text = {"text": "fixture"}
        cases = [
            ("mail.human-send", "h-top", text, ()),
            ("mail.human-send:deep", "h-deep", text, ("h-mid", "h-top")),
            ("mail.human-send:archived", "h-gone", text, ("h-top",)),
            ("mail.human-send:notice", "h-mid", {"text": "fyi", "notice": True}, ("h-top",)),
            ("mail.human-send:session-command", "h-mid", {"text": "/model sonnet"}, ("h-top",)),
            ("mail.human-send:attachment", "h-top",
             {"text": "see file", "attachments": ["brief.txt", "nope.txt"]}, ()),
        ]
        for variant, nid, body, implied in cases:
            for condition in both:
                send(variant, condition, nid, body, implied=implied,
                     patches=(self.observe_stats() if variant.endswith("attachment") else None))
        # the two reply forms: a chat event of h-top's (its mailbox row, through
        # supervisor.resolve_chat_event) and a typed target (a user-inbox mail)
        org = store.load_org(s)
        mid = str(org.d["mail"]["h-top"][-1]["id"])
        ref = {"org": s, "agent": "h-top", "eventId": f"mail:{s}:h-top:{mid}",
               "generation": int(org.node("h-top").get("generation") or 0)}
        target = {"kind": "mail", "org": s, "box": "user", "id": self.user_mail[-1]}
        for condition in both:
            send("mail.human-send:reply-to-chat-event", condition, "h-top",
                 {"text": "re", "reply_to": {"source_event_ref": ref}})
            send("mail.human-send:reply-target", condition, "h-top",
                 {"text": "re", "target": target})
        for variant, nid, body, refusal in (
                ("refusal:human-empty", "h-top", {"text": "   "}, "422 empty message"),
                ("refusal:human-target-and-reply", "h-top",
                 {"text": "x", "target": {"kind": "mail"}, "reply_to": {}},
                 "422 send one of target, reply_to"),
                ("refusal:human-unknown-node", "nobody", text, "422 NOT DELIVERED"),
                ("refusal:human-command-archived", "h-gone", {"text": "/model sonnet"},
                 "409 a session command runs nothing on an archived node")):
            # a name that is no node here is looked up in EVERY other org
            # before the refusal (as for an agent's bare unknown name)
            send(variant, "warm", nid, body, refusal=refusal,
                 expected_unknown=(("statement:data:org-db:foreign",)
                                   if variant == "refusal:human-unknown-node" else ()))
        # /compact on a node with no conversation: refused BEFORE any
        # compaction thread starts (P08 owns the compaction itself), but only
        # after the deep-reach notice to the chain is saved
        send("refusal:compact-no-conversation", "warm", "h-mid", {"text": "/compact"},
             implied=("h-top",), refusal="422 no conversation yet (no compaction started)")

        # agent-level locality control: a human send whose delivery step ALSO
        # posts mail to a third agent ('h-sib', from 'h-top')
        def notify_and_mail_third(*_a: Any, **_k: Any) -> dict[str, Any]:
            with store.write_org(s) as o:
                o.post_mail("h-top", "h-sib", "p02 control: mail to a third agent")
                store.save_org(o)
            return {"delivered": True}
        send("control:human-send-third-agent", "warm", "h-mid", text, implied=("h-top",),
             refusal="negative control (not a product path)",
             patches=[(supervisor, "send_message", notify_and_mail_third)])

    def inbox(self) -> None:
        """The three inbox routes, cold and warm, on either backend; on SQLite
        also their migration paths (a legacy .json org met by the route)."""
        s, user, op = self.hslug, self.m["ledger"].USER, self.OPERATOR

        def call(contract: str, variant: str, condition: str, path: str,
                 body: Any = None, slug: "str | None" = None, headers: Any = op,
                 **kw: Any) -> None:
            method = "GET" if body is None else "POST"
            self.run(contract, variant, condition, slug or s, user, f"{method} {contract}", {},
                     call=self.http(self.client, path, headers, body), **kw)

        for i, condition in enumerate(("cold", "warm")):
            call("mail.user-inbox", "mail.user-inbox", condition, f"/api/orgs/{s}/inbox")
            call("mail.user-inbox-read", "mail.user-inbox-read", condition,
                 f"/api/orgs/{s}/inbox/read", {"ids": [self.user_mail[i]]})
            call("mail.user-inbox-read", "mail.user-inbox-read:nothing-read", condition,
                 f"/api/orgs/{s}/inbox/read", {"ids": ["nope"]})
            call("mail.node-inbox", "mail.node-inbox", condition,
                 f"/api/orgs/{s}/nodes/h-top/inbox")
        call("mail.user-inbox", "refusal:inbox-no-token", "warm", f"/api/orgs/{s}/inbox",
             headers={}, refusal="401 without the desktop token")
        call("mail.node-inbox", "refusal:node-inbox-unknown-node", "warm",
             f"/api/orgs/{s}/nodes/nobody/inbox", refusal="404 unknown node")
        if self.backend != "sqlite":
            return
        # inbox.writes: a legacy .json org met by each route (one org per
        # route, since the first migrating call converts it)
        for contract, short, path, body in (
                ("mail.user-inbox", "userinbox", "/api/orgs/{}/inbox", None),
                ("mail.user-inbox-read", "inboxread", "/api/orgs/{}/inbox/read", {"ids": ["nope"]}),
                ("mail.node-inbox", "nodeinbox", "/api/orgs/{}/nodes/boss/inbox", None)):
            legacy = self.legacy_org(f"p02-contacts-legacy-{short}", (), "json")
            for variant, condition, env in (
                    ("migration:refused", "cold", {"ORGTREE_MIGRATE": None}),
                    ("migration:legacy-json", "cold", {"ORGTREE_MIGRATE": "1"}),
                    ("migration:legacy-json", "warm", None)):
                call(contract, variant, condition, path.format(legacy), body, slug=legacy,
                     env=env, refusal=("legacy .json without ORGTREE_MIGRATE"
                                       if variant == "migration:refused" else None))

    # -- P01 S3 F3: credits.request, credits.reallocate, credits.decide -------------
    def build_funding(self) -> None:
        """tests/test_state_funding_boundary.py's org (distinctive `f-*` ids)
        plus a third agent, 'f-sib', for the locality control."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-funding")
        self.fslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 20, "f-top")
        org.hire(ledger.USER, "f-top", "haiku", 6, "f-mid")
        org.hire(ledger.USER, "f-mid", "haiku", 2, "f-kid")
        org.hire(ledger.USER, "f-top", "haiku", 1, "f-sib")
        org.hire(ledger.USER, None, "haiku", 5, "f-top2")
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for n in ("f-top", "f-mid", "f-top2"):
            self.tokens[(self.fslug, n)] = self.m["agentauth"].child_env(
                self.fslug, n)["ORGTREE_AGENT_TOKEN"]

    def funding(self) -> None:
        """Every funding outcome P01's clause names, cold and warm: request
        new/amend/withdraw, reallocate up/down/deep, decide approve/counter/
        deny/moot/dry; plus refusals, keyed paths and a locality control."""
        s, store, api, opreceipts = self.fslug, self.m["store"], self.m["api"], self.m["opreceipts"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        rc, ra = "orgtree_request_credits", "orgtree_reallocate"

        def agent(contract: str, variant: str, condition: str, actor: str, tool: str,
                  args: dict[str, Any], **kw: Any) -> None:
            self.run(contract, variant, condition, s, actor, tool, args, **kw)

        # credits.request: a new request, an amendment (35.2 rounds UP to 36),
        # a withdrawal (a limit at the current grant); the warm new request is
        # a fresh one after the cold withdrawal
        for condition in both:
            for variant, limit in (("credits.request", 30), ("credits.request:amend", 35.2),
                                   ("credits.request:withdraw", 20)):
                agent("credits.request", variant, condition, "f-top", rc,
                      {"new_limit": limit, "reason": "fixture"})
        agent("credits.request", "credits.request:nothing-to-request", "warm", "f-top2", rc,
              {"new_limit": 5, "reason": "fixture"})
        for variant, actor, args, refusal in (
                ("refusal:request-no-reason", "f-top2", {"new_limit": 40},
                 "422 a reason is required"),
                ("refusal:request-not-a-number", "f-top2", {"new_limit": "lots", "reason": "x"},
                 "422 new_limit must be a number"),
                ("refusal:request-not-top-level", "f-mid", {"new_limit": 40, "reason": "x"},
                 "422 only top-level agents")):
            agent("credits.request", variant, "warm", actor, rc, args, refusal=refusal)

        # credits.reallocate: up, down and deep (a grandchild: its grant notice
        # also reaches its parent, f-mid), cold and warm; zero and fractional
        for condition in both:
            agent("credits.reallocate", "credits.reallocate", condition, "f-top", ra,
                  {"node": "f-mid", "delta": 2})
            agent("credits.reallocate", "credits.reallocate:down", condition, "f-top", ra,
                  {"node": "f-mid", "delta": -1})
            agent("credits.reallocate", "credits.reallocate:deep", condition, "f-top", ra,
                  {"node": "f-kid", "delta": 1}, implied=("f-mid",))
        agent("credits.reallocate", "credits.reallocate:zero", "warm", "f-top", ra,
              {"node": "f-mid", "delta": 0})
        agent("credits.reallocate", "credits.reallocate:fractional", "warm", "f-top", ra,
              {"node": "f-mid", "delta": 0.3})
        for variant, actor, args, refusal in (
                ("refusal:reallocate-committed-floor", "f-top", {"node": "f-mid", "delta": -100},
                 "422 below the committed floor"),
                ("refusal:reallocate-upward", "f-mid", {"node": "f-top", "delta": 1},
                 "422 no authority over a superior"),
                ("refusal:reallocate-self", "f-mid", {"node": "f-mid", "delta": 1},
                 "422 no authority over itself"),
                ("refusal:reallocate-not-a-number", "f-top", {"node": "f-mid", "delta": "x"},
                 "422 delta must be a number")):
            agent("credits.reallocate", variant, "warm", actor, ra, args, refusal=refusal)

        # keyed fresh and replay, both agent tools, cold and warm
        epoch = self.client.post("/api/agent",
                                 json=self.agent_body(s, "f-top", opreceipts.OP_EPOCH, {}),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, "f-top")]}
                                 ).json()["epoch"]
        for contract, tool, args in (("credits.reallocate", ra, {"node": "f-mid", "delta": 1}),
                                     ("credits.request", rc, {"new_limit": 90, "reason": "k"})):
            for condition in both:
                key = opreceipts.mint_key()
                agent(contract, f"{contract}:keyed-fresh", condition, "f-top", tool, args,
                      key=key, epoch=epoch)
                agent(contract, f"{contract}:keyed-replay", condition, "f-top", tool, args,
                      key=key, epoch=epoch,
                      refusal="keyed replay (answered from the receipt, no effect)")

        # credits.decide (operator POST /credit-requests). Each row decides a
        # request made just before it, OUTSIDE the row, by the requester
        def pending(requester: str) -> str:
            grant = int(store.load_org(s).node(requester)["grant"])
            r = self.client.post("/api/agent", json=self.agent_body(
                s, requester, rc, {"new_limit": grant + 2, "reason": "fixture"}),
                headers={"X-Orgtree-Agent-Token": self.tokens[(s, requester)]})
            if r.status_code != 200:
                raise RuntimeError(f"fixture credit request answered {r.status_code}: {r.text[:200]}")
            return next(str(q["id"]) for q in store.load_org(s).d.get("credit_requests") or []
                        if q.get("node") == requester and q.get("status") == "pending")

        def decide(variant: str, condition: str, requester: str, body: dict[str, Any],
                   headers: Any = op, **kw: Any) -> None:
            self.run("credits.decide", variant, condition, s, user, "POST credits.decide",
                     {"node": requester, **body},
                     call=self.http(self.client, f"/api/orgs/{s}/credit-requests", headers, body),
                     **kw)

        def archive(o: Any) -> None:
            saved["state"] = o.node("f-top2")["state"]
            o.node("f-top2")["state"] = "archived"
        saved: dict[str, Any] = {}
        for condition in both:
            grant = int(store.load_org(s).node("f-top")["grant"])
            decide("credits.decide", condition, "f-top",
                   {"id": pending("f-top"), "action": "approve"})
            decide("credits.decide:counter", condition, "f-top",
                   {"id": pending("f-top"), "action": "approve", "granted": grant + 3})
            decide("credits.decide:deny", condition, "f-top2",
                   {"id": pending("f-top2"), "action": "deny"})
            rid = pending("f-top2")
            self.mutate(s, archive)
            decide("credits.decide:moot", condition, "f-top2", {"id": rid, "action": "approve"})
            self.mutate(s, lambda o: o.node("f-top2").update(state=saved["state"]))
            decide("credits.decide:dry", condition, "f-top",
                   {"id": pending("f-top"), "action": "approve",
                    "granted": int(store.load_org(s).node("f-top")["grant"]) + 1, "dry": True})
        rid = pending("f-top")
        for variant, body, headers, refusal in (
                ("refusal:decide-dry-without-granted", {"id": rid, "action": "approve", "dry": True},
                 op, "422 dry run needs `granted`"),
                ("refusal:decide-bad-action", {"id": rid, "action": "maybe"}, op,
                 "422 action must be approve|deny"),
                ("refusal:decide-agent-token", {"id": rid, "action": "approve"},
                 {"X-Orgtree-Agent-Token": self.tokens[(s, "f-top")]},
                 "401 an agent credential is refused here"),
                ("refusal:decide-not-pending", {"id": "cr1", "action": "approve"}, op,
                 "422 no pending credit request")):
            decide(variant, "warm", "f-top", body, headers=headers, refusal=refusal)

        # agent-level locality control: a reallocation whose closing tree
        # broadcast (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            with store.write_org(s) as o:
                o.post_mail("f-top", "f-sib", "p02 control: mail to a third agent")
                store.save_org(o)
        agent("credits.reallocate", "control:funding-third-agent", "warm", "f-top", ra,
              {"node": "f-mid", "delta": 1}, refusal="negative control (not a product path)",
              patches=[(api, "hub_changed", mail_third)])

    # -- P01 S3 F3b: staffing.hire, staffing.staff-create, staffing.staff-update ---
    NO_TOOLS = {"bash": False, "web": False, "edit": False, "subagents": False, "mcp": []}
    SCOPE = {"add_dirs": [], "tools": NO_TOOLS, "org_visibility": "team", "charter": "fixture"}

    def build_staffing(self) -> None:
        """tests/test_state_staffing_boundary.py's org (distinctive `s-*` ids):
        s-top and s-top2 top-level, s-mid and s-sib (the third agent) under
        s-top, and two archived seats for the rehire mode."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-staffing")
        self.stfslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 200, "s-top", add_dirs=[], tools={}, charter="fixture")
        org.hire("s-top", "s-top", "haiku", 60, "s-mid", **self.SCOPE)
        org.hire("s-top", "s-top", "haiku", 0, "s-sib", **self.SCOPE)
        org.hire(ledger.USER, None, "haiku", 5, "s-top2", add_dirs=[], tools={}, charter="fixture")
        for gone in ("s-gone-cold", "s-gone-warm"):
            org.hire("s-top", "s-top", "haiku", 0, gone, **self.SCOPE)
            org.retire("s-top", gone)
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for n in ("s-top", "s-mid", "s-top2"):
            self.tokens[(self.stfslug, n)] = self.m["agentauth"].child_env(
                self.stfslug, n)["ORGTREE_AGENT_TOKEN"]

    def staffing(self) -> None:
        """hire by class (plain, kickoff, target, superior, audiences,
        work_item) and staff by mode (create, update, rehire), cold and warm.
        The new seats' names are known up front and registered as fixture
        nodes, so their rows are recognised; `implied` names the new seat,
        the destination chain and a moved item's previous owner."""
        s, store, api, opreceipts = self.stfslug, self.m["store"], self.m["api"], self.m["opreceipts"]
        supervisor = self.m["supervisor"]
        hi, st, both = "orgtree_hire", "orgtree_staff", ("cold", "warm")
        gate = [(api, "provider_hire_gate", lambda *_a, **_k: None)]
        classes = ("plain", "kickoff", "target", "superior", "audiences", "work-item",
                   "keyed", "control")
        _NODES[s] |= {f"hs-{c}-{cond}" for c in classes for cond in both} | {
            f"ss-{m}-{cond}" for m in ("create", "update", "keyed") for cond in both}

        def run(contract: str, variant: str, condition: str, actor: str, tool: str,
                args: dict[str, Any], **kw: Any) -> None:
            kw["patches"] = gate + list(kw.pop("patches", None) or [])
            self.run(contract, variant, condition, s, actor, tool, args, **kw)

        def item(owner: str, status: str = "open") -> str:
            r = self.client.post("/api/agent", json=self.agent_body(s, "s-top", "orgtree_work", dict(
                action="create", title="Fixture item", objective="Problem. Fix.", owner=owner,
                status=status)), headers={"X-Orgtree-Agent-Token": self.tokens[(s, "s-top")]})
            if r.status_code != 200:
                raise RuntimeError(f"fixture work item answered {r.status_code}: {r.text[:200]}")
            return str(r.json()["created"])

        def told(parent: str, *extra: str) -> tuple[str, ...]:
            """The declared counterparties: the new seat(s)/moved-item owner in
            `extra`, its parent and the parent's live children. A hire tells
            the new seat's parent and EVERY peer (ledger.hire, lifecycle.hired
            relations report/peer), which P01's staffing clause does not name;
            they are read from the stored org before the row."""
            org = store.load_org(s)
            peers = {k for k, v in org.nodes.items()
                     if v.get("parent") == parent and v.get("state") != "archived"}
            return tuple(sorted(peers | {parent} | set(extra)))

        seat = {"tier": "haiku", "grant": 0, **self.SCOPE}
        for cond in both:
            run("staffing.hire", "staffing.hire", cond, "s-mid", hi,
                {"name": f"hs-plain-{cond}", **seat}, implied=told("s-mid", f"hs-plain-{cond}"))
            run("staffing.hire", "staffing.hire:kickoff", cond, "s-mid", hi,
                {"name": f"hs-kickoff-{cond}", "kickoff": "go", **seat},
                implied=told("s-mid", f"hs-kickoff-{cond}"))
            run("staffing.hire", "staffing.hire:target", cond, "s-top", hi,
                {"name": f"hs-target-{cond}", "target": "s-mid", **seat},
                implied=told("s-mid", f"hs-target-{cond}"))
            # inserted ABOVE s-mid, under s-mid's current superior; the anchor's
            # own reports are told too (their chain changes)
            above = str(store.load_org(s).node("s-mid")["parent"])
            run("staffing.hire", "staffing.hire:superior", cond, "s-top", hi,
                {"name": f"hs-superior-{cond}", "tier": "haiku", "grant": 0, "target": "s-mid",
                 "hire_type": "superior", "charter": "fixture"},
                implied=tuple(sorted(set(told(above, f"hs-superior-{cond}"))
                                     | set(told("s-mid")))))
            run("staffing.hire", "staffing.hire:audiences", cond, "s-mid", hi,
                {"name": f"hs-audiences-{cond}", "audiences": ["s-mid"], **seat},
                implied=told("s-mid", f"hs-audiences-{cond}"))
            wid = item("s-top", status="backlogged")
            run("staffing.hire", "staffing.hire:work-item", cond, "s-top", hi,
                {"name": f"hs-work-item-{cond}", "work_item": wid, **seat},
                implied=told("s-top", f"hs-work-item-{cond}"))
            run("staffing.staff-create", "staffing.staff-create", cond, "s-top", st,
                {"title": "Staffed", "objective": "Problem. Fix.", "name": f"ss-create-{cond}",
                 **seat}, implied=told("s-top", f"ss-create-{cond}"))
            wid = item("s-mid")
            run("staffing.staff-update", "staffing.staff-update", cond, "s-top", st,
                {"action": "update", "slug": wid, "name": f"ss-update-{cond}", **seat},
                implied=told("s-top", f"ss-update-{cond}", "s-mid"))
            run("staffing.staff-create", "staffing.staff-create:rehire", cond, "s-top", st,
                {"node": f"s-gone-{cond}", "title": "Back", "objective": "Problem. Fix."},
                implied=told("s-top"))
        for contract, variant, actor, tool, args, refusal in (
                ("staffing.hire", "refusal:hire-outside-subtree", "s-top", hi,
                 {"name": "x", "target": "s-top2", **seat}, "422 outside your subtree"),
                ("staffing.hire", "refusal:hire-no-credits", "s-mid", hi,
                 {"name": "x", **seat, "grant": 500}, "422 not enough free credits on the chain"),
                ("staffing.hire", "refusal:hire-unknown-tier", "s-mid", hi,
                 {"name": "x", **seat, "tier": "nope"}, "422 unknown tier"),
                ("staffing.staff-create", "refusal:staff-bad-action", "s-top", st,
                 {"action": "delete", "name": "x", **seat}, "422 action must be create or update"),
                ("staffing.staff-create", "refusal:staff-no-title", "s-top", st,
                 {"title": "", "objective": "", "name": "x", **seat},
                 "422 a work item needs a title (the seat goes with the unsaved document)")):
            run(contract, variant, "warm", actor, tool, args, refusal=refusal)
        epoch = self.client.post("/api/agent",
                                 json=self.agent_body(s, "s-top", opreceipts.OP_EPOCH, {}),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, "s-top")]}
                                 ).json()["epoch"]
        for contract, tool, name, extra in (
                ("staffing.hire", hi, "hs-keyed", {}),
                ("staffing.staff-create", st, "ss-keyed", {"title": "Keyed", "objective": "P. F."})):
            for cond in both:
                key = opreceipts.mint_key()
                args = {"name": f"{name}-{cond}", **seat, **extra}
                implied = told("s-top", f"{name}-{cond}")
                run(contract, f"{contract}:keyed-fresh", cond, "s-top", tool, args, key=key,
                    epoch=epoch, implied=implied)
                run(contract, f"{contract}:keyed-replay", cond, "s-top", tool, args, key=key,
                    epoch=epoch, implied=implied,
                    refusal="keyed replay (answered from the receipt, no effect)")

        # agent-level locality control: a kickoff hire whose first-turn drive
        # ALSO posts mail to a third agent ('s-sib', from 's-top')
        def drive_and_mail_third(*_a: Any, **_k: Any) -> dict[str, Any]:
            with store.write_org(s) as o:
                o.post_mail("s-top", "s-sib", "p02 control: mail to a third agent")
                store.save_org(o)
            return {"delivered": True}
        run("staffing.hire", "control:staffing-third-agent", "warm", "s-mid", hi,
            {"name": "hs-control-warm", "kickoff": "go", **seat},
            implied=told("s-mid", "hs-control-warm"),
            refusal="negative control (not a product path)",
            patches=[(supervisor, "send_message", drive_and_mail_third)])

    # -- P01 S3 F3c: operator.hire, operator.reallocate (POST /api/orgs/{slug}/ops) ---
    def build_operator(self) -> None:
        """tests/test_state_operator_ops_boundary.py's shape (distinctive `op-*`
        ids): op-top and op-top2 top-level, op-mid and op-sib (the third agent)
        under op-top, op-kid under op-mid."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-operator")
        self.opslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 40, "op-top", add_dirs=[], tools={}, charter="fixture")
        org.hire("op-top", "op-top", "haiku", 6, "op-mid", **self.SCOPE)
        org.hire("op-top", "op-top", "haiku", 0, "op-sib", **self.SCOPE)
        org.hire("op-top", "op-mid", "haiku", 0, "op-kid", **self.SCOPE)
        org.hire(ledger.USER, None, "haiku", 5, "op-top2", add_dirs=[], tools={}, charter="fixture")
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        self.tokens[(self.opslug, "op-top")] = self.m["agentauth"].child_env(
            self.opslug, "op-top")["ORGTREE_AGENT_TOKEN"]

    def operator_ops(self) -> None:
        """operator hire (top level, under a parent, above) and reallocate (up,
        down, top level), cold and warm, as the operator (@user) on the desktop
        token; refusals and a locality control. The door keeps no receipts, so
        there are no keyed rows (P01 pins that a repeated hire seats a second
        agent). `implied` is the new seat's parent and live peers (a hire tells
        them: ledger.hire lifecycle.hired), an above-hire's anchor and its
        reports, and a reallocation target's chain (every ancestor: a raise's
        shortfall bubbles up it, and the grant notice reaches the parent)."""
        s, store, api = self.opslug, self.m["store"], self.m["api"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        gate = [(api, "provider_hire_gate", lambda *_a, **_k: None)]
        _NODES[s] |= {f"oh-{c}-{cond}" for c in ("top", "under", "above") for cond in both}

        def run(contract: str, variant: str, condition: str, body: dict[str, Any],
                actor: str = user, headers: Any = op, **kw: Any) -> None:
            if body.get("op") == "hire":
                kw["patches"] = gate + list(kw.pop("patches", None) or [])
            args = {k: v for k, v in body.items() if k in ("node", "parent", "above")}
            self.run(contract, variant, condition, s, actor, f"POST {contract}", args,
                     call=self.http(self.client, f"/api/orgs/{s}/ops", headers,
                                    {**body, "actor": actor}), **kw)

        def told(parent: "str | None", *extra: str) -> tuple[str, ...]:
            """The new seat's parent and the parent's live children (every top-
            level seat for a top-level hire), read from the stored org before
            the row, plus `extra`."""
            org = store.load_org(s)
            peers = {k for k, v in org.nodes.items()
                     if v.get("parent") == parent and v.get("state") != "archived"}
            return tuple(sorted(peers | ({parent} if parent else set()) | set(extra)))

        def parent_of(nid: str) -> "str | None":
            p = store.load_org(s).node(nid)["parent"]
            return str(p) if p else None

        def chain(nid: str) -> tuple[str, ...]:
            """Every ancestor of `nid`: a raise bubbles its shortfall up the
            chain to the operator (ledger._chain_acquire, grants inflating on
            the way), and the grant notice reaches the parent."""
            up, p = [], parent_of(nid)
            while p:
                up.append(p)
                p = parent_of(p)
            return tuple(up)

        hire = {"op": "hire", "tier": "haiku", "charter": "fixture"}
        for cond in both:
            run("operator.hire", "operator.hire", cond, {**hire, "name": f"oh-top-{cond}",
                                                         "grant": 1},
                implied=told(None, f"oh-top-{cond}"))
            run("operator.hire", "operator.hire:under", cond,
                {**hire, "name": f"oh-under-{cond}", "parent": "op-mid"},
                implied=told("op-mid", f"oh-under-{cond}"))
            # inserted ABOVE op-mid, under op-mid's current parent (op-top cold;
            # the cold insertion warm); the anchor's own reports are told too
            above = parent_of("op-mid")
            run("operator.hire", "operator.hire:above", cond,
                {**hire, "name": f"oh-above-{cond}", "parent": above, "above": "op-mid"},
                implied=tuple(sorted(set(told(above, f"oh-above-{cond}"))
                                     | set(told("op-mid")))))
        for cond in both:
            run("operator.reallocate", "operator.reallocate", cond,
                {"op": "reallocate", "node": "op-mid", "delta": 2}, implied=chain("op-mid"))
            run("operator.reallocate", "operator.reallocate:down", cond,
                {"op": "reallocate", "node": "op-mid", "delta": -1},
                implied=chain("op-mid"))
            run("operator.reallocate", "operator.reallocate:top-level", cond,
                {"op": "reallocate", "node": "op-top", "delta": 1})
        run("operator.reallocate", "operator.reallocate:fractional", "warm",
            {"op": "reallocate", "node": "op-mid", "delta": 0.5}, implied=chain("op-mid"))
        agent = {"X-Orgtree-Agent-Token": self.tokens[(s, "op-top")]}
        for contract, variant, body, actor, headers, refusal in (
                ("operator.hire", "refusal:op-hire-no-name", {"op": "hire", "tier": "haiku"},
                 user, op, "422 hire needs tier and name"),
                ("operator.hire", "refusal:op-hire-unknown-tier",
                 {"op": "hire", "tier": "nope", "name": "x"}, user, op, "422 unknown tier"),
                ("operator.hire", "refusal:op-hire-above-not-a-report",
                 {**hire, "name": "x", "parent": None, "above": "op-mid"}, user, op,
                 "422 insert-superior: the anchor does not report to the named parent"),
                ("operator.hire", "refusal:op-hire-agent-token",
                 {**hire, "name": "x"}, user, agent, "401 an agent credential is refused here"),
                ("operator.reallocate", "refusal:op-reallocate-no-delta",
                 {"op": "reallocate", "node": "op-mid"}, user, op, "422 reallocate needs delta"),
                ("operator.reallocate", "refusal:op-reallocate-committed-floor",
                 {"op": "reallocate", "node": "op-mid", "delta": -100}, user, op,
                 "422 below the committed floor"),
                ("operator.reallocate", "refusal:op-reallocate-no-authority",
                 {"op": "reallocate", "node": "op-top", "delta": 1}, "op-mid", op,
                 "422 the named actor has no authority over its superior")):
            run(contract, variant, "warm", body, actor=actor, headers=headers, refusal=refusal)

        # agent-level locality control: a reallocation whose closing tree
        # broadcast (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            with store.write_org(s) as o:
                o.post_mail("op-top", "op-sib", "p02 control: mail to a third agent")
                store.save_org(o)
        run("operator.reallocate", "control:operator-third-agent", "warm",
            {"op": "reallocate", "node": "op-mid", "delta": 1}, implied=chain("op-mid"),
            refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

    # -- P01 S3 F3d: quick-staff.options, -options-refresh, -preview, -select ---
    #: tests/test_state_quick_staff_boundary.py's fixed provider offer
    QS_OFFER = {"providers": [
        {"id": "claude", "hire_enabled": True, "tiers": [{"tier": "haiku", "seat": 1}]},
        {"id": "openai", "hire_enabled": True, "tiers": [{"tier": "luna", "seat": .2}]}]}
    QS_MODES = {"request": "request", "under": "under_assignee", "top": "top_level"}

    def build_quickstaff(self) -> None:
        """The P01 quick-staff fixture's shape (distinctive `qs-*` ids): qs-mgr
        top-level (the tickets' assignee), qs-kid under it (the third agent of
        the request-mode control), qs-other top-level."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-quickstaff")
        self.qsslug = str(org.d["slug"])
        org.d["tiers"] = {"haiku": 1, "luna": .2}
        org.hire(ledger.USER, None, "haiku", 20, "qs-mgr", add_dirs=[], tools=self.NO_TOOLS,
                 org_visibility="self", charter="fixture")
        org.hire("qs-mgr", "qs-mgr", "haiku", 0, "qs-kid",
                 **{**self.SCOPE, "org_visibility": "self"})
        org.hire(ledger.USER, None, "haiku", 0, "qs-other", add_dirs=[], tools={},
                 charter="fixture")
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        self.tokens[(self.qsslug, "qs-mgr")] = self.m["agentauth"].child_env(
            self.qsslug, "qs-mgr")["ORGTREE_AGENT_TOKEN"]

    def quick_staff(self) -> None:
        """staffing-options and its refresh, the preview in each mode and the
        commit in each mode with its replay, cold and warm, as @user on the
        desktop token; refusals and a locality control. Machine state is
        patched for the whole family as in the P01 fixture: provider
        discovery (a fixed offer), the provider gate, account reasons,
        advertised efforts, and `staffcache.read` recomputes the snapshot on
        EVERY read (so there is no warm staffcache; cold/warm is the org
        store's). The kickoff spy answers `accepted` (the route undoes a
        request whose kickoff is not accepted). The seat an immediate commit
        creates is named from the ticket title, so it is known in advance."""
        from orgtree import quickstaff, staffcache
        s, store, api = self.qsslug, self.m["store"], self.m["api"]
        supervisor, appsettings = self.m["supervisor"], self.m["appsettings"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        base = f"/api/orgs/{s}"
        _NODES[s] |= {f"qs-{m}-{cond}" for m in self.QS_MODES for cond in both}

        def kickoff(*_a: Any, **_k: Any) -> dict[str, Any]:
            self.wakes["send_message"] += 1
            return {"accepted": True, "queued": 0}
        family = [(api, "provider_hire_gate", lambda *_a, **_k: None),
                  (quickstaff, "account_reason", lambda *_a, **_k: None),
                  (quickstaff, "supported_efforts", lambda *_a, **_k: ["low", "high"]),
                  (api, "_providers_payload", lambda *_a, **_k: copy.deepcopy(self.QS_OFFER)),
                  (staffcache, "read", lambda **_k: staffcache._compute()),
                  (staffcache, "warm", lambda *_a, **_k: None),
                  (supervisor, "send_message", kickoff)]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        # the app settings this family changes, restored to what they were
        settings = (appsettings.quick_staff_behavior(), appsettings.quick_staff_request_accounts())
        staffcache.reset_for_tests()
        appsettings.set_quick_staff_request_accounts(False)
        try:
            self._quick_staff_rows(s, base, store, api, appsettings, user, op, both)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)
            staffcache.reset_for_tests()
            appsettings.set_quick_staff_behavior(settings[0])
            appsettings.set_quick_staff_request_accounts(settings[1])

    def _quick_staff_rows(self, s: str, base: str, store: Any, api: Any, appsettings: Any,
                          user: str, op: dict[str, str], both: tuple[str, str]) -> None:
        def run(contract: str, variant: str, condition: str, method: str, path: str,
                body: Any = None, headers: Any = op, **kw: Any) -> None:
            self.run(contract, variant, condition, s, user, f"{method} {contract}", {},
                     call=self.http(self.client, base + path, headers, body), **kw)

        def ticket(title: str) -> str:
            out: dict[str, str] = {}
            self.mutate(s, lambda o: out.update(wid=str(o.work_create(
                "qs-mgr", title, "Problem. Fix.", status="backlogged", owner="qs-mgr")["slug"])))
            return out["wid"]

        def selection(wid: str, **extra: Any) -> dict[str, Any]:
            p = self.client.get(f"{base}/work-items/{wid}/quick-staff", headers=op).json()
            return {**{k: p[k] for k in ("mode", "configured_mode", "owner")},
                    "request_id": str(uuid.uuid4()), **extra}

        def told(parent: "str | None", *extra: str) -> tuple[str, ...]:
            """The new seat's parent and the parent's live children (every
            top-level seat, at the top level), read before the row."""
            org = store.load_org(s)
            peers = {k for k, v in org.nodes.items()
                     if v.get("parent") == parent and v.get("state") != "archived"}
            return tuple(sorted(peers | ({parent} if parent else set()) | set(extra)))

        for cond in both:
            run("quick-staff.options", "quick-staff.options", cond, "GET", "/staffing-options")
            run("quick-staff.options-refresh", "quick-staff.options-refresh", cond, "POST",
                "/staffing-options/refresh", {})
            for short, mode in self.QS_MODES.items():
                appsettings.set_quick_staff_behavior(mode)
                wid = ticket(f"qs-{short}-{cond}")
                path = f"/work-items/{wid}/quick-staff"
                variant = "" if short == "request" else f":{mode.replace('_', '-')}"
                run("quick-staff.preview", f"quick-staff.preview{variant}", cond, "GET", path,
                    implied=("qs-mgr",))
                body = selection(wid, **({} if short == "request" else {"tier": "haiku"}))
                # the assignee (the request's recipient, or the item's previous
                # owner), the new seat, and the seat's parent and live peers
                implied = (("qs-mgr",) if short == "request" else
                           told("qs-mgr", wid) if short == "under" else
                           tuple(sorted(set(told(None, wid)) | {"qs-mgr"})))
                run("quick-staff.select", f"quick-staff.select{variant}", cond, "POST", path,
                    body, implied=implied)
                run("quick-staff.select", f"quick-staff.select{variant}:replay", cond, "POST",
                    path, body, implied=implied,
                    refusal="replay (answered from the ticket's receipt, no effect)")
        appsettings.set_quick_staff_behavior("request")
        wid = ticket("qs-refusals")
        path = f"/work-items/{wid}/quick-staff"
        body = selection(wid)
        agent = {"X-Orgtree-Agent-Token": self.tokens[(s, "qs-mgr")]}
        # the agent-credential commit gets a ticket of its own: were the gate
        # ever to let it through, its effect must not disturb the other rows
        token_wid = ticket("qs-refusal-token")
        token_path, token_body = f"/work-items/{token_wid}/quick-staff", selection(token_wid)
        for contract, variant, method, p, b, headers, refusal in (
                ("quick-staff.options", "refusal:qs-options-agent-token", "GET",
                 "/staffing-options", None, agent, "401 an agent credential is refused here"),
                ("quick-staff.select", "refusal:qs-stale-selection", "POST", path,
                 {**body, "mode": "top_level"}, op, "422 the staffing behavior changed"),
                ("quick-staff.select", "refusal:qs-effort-without-tier", "POST", path,
                 {**body, "effort": "high"}, op, "422 an effort needs a model"),
                ("quick-staff.select", "refusal:qs-account-in-request-mode", "POST", path,
                 {**body, "tier": "haiku", "account": "claude/primary"}, op,
                 "422 request staffing cannot pin an account"),
                ("quick-staff.select", "refusal:qs-agent-token", "POST", token_path,
                 {**token_body, "tier": "haiku"}, agent,
                 "401 an agent credential is refused here")):
            run(contract, variant, "warm", method, p, b, headers=headers, refusal=refusal)
        appsettings.set_quick_staff_behavior("under_assignee")
        run("quick-staff.select", "refusal:qs-immediate-without-tier", "warm", "POST", path,
            selection(wid), refusal="422 immediate staffing needs a model")
        appsettings.set_quick_staff_behavior("request")
        self.mutate(s, lambda o: o.work_update("qs-mgr", wid, ["x"], ["y"], status="open"))
        run("quick-staff.preview", "refusal:qs-preview-not-backlogged", "warm", "GET", path,
            refusal="422 quick staff needs a backlogged ticket")

        # agent-level locality control: a request-mode commit whose closing
        # tree broadcast (api.hub_changed) ALSO posts mail to a third agent
        wid = ticket("qs-control")
        body = selection(wid)

        def mail_third(*_a: Any, **_k: Any) -> None:
            with store.write_org(s) as o:
                o.post_mail("qs-mgr", "qs-kid", "p02 control: mail to a third agent")
                store.save_org(o)
        run("quick-staff.select", "control:quick-staff-third-agent", "warm", "POST",
            f"/work-items/{wid}/quick-staff", body, implied=("qs-mgr",),
            refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

    # -- P01 S3 F4: work.item-list, work.item-get (the operator's docket reads) --
    def build_workread(self) -> None:
        """tests/test_state_work_read_boundary.py's org (distinctive `wr-*`
        ids): wr-mgr owns an open, a backlogged and a done item; the done
        item's docket update is two hours old, so it derives archived."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-workread")
        self.wrslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 4, "wr-mgr", add_dirs=[], tools={}, charter="fixture")
        self.wr_open = str(org.work_create("wr-mgr", "Open item", "P. F.", status="open",
                                           owner="wr-mgr")["slug"])
        self.wr_back = str(org.work_create("wr-mgr", "Backlog item", "P. F.",
                                           status="backlogged", owner="wr-mgr")["slug"])
        self.wr_done = str(org.work_create("wr-mgr", "Done item", "P. F.", status="open",
                                           owner="wr-mgr")["slug"])
        org.work_update("wr-mgr", self.wr_done, ["finished"], [], status="done")
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7200))
        item = org._work_find(self.wr_done)[0]
        item["docket_at"] = item["updated_at"] = old
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        self.tokens[(self.wrslug, "wr-mgr")] = self.m["agentauth"].child_env(
            self.wrslug, "wr-mgr")["ORGTREE_AGENT_TOKEN"]

    def work_read(self) -> None:
        """The list (plain, archived, backlogged, compact) and the item read
        (plain, compact), cold and warm, as @user on the desktop token;
        refusals; an org-level locality control (the read also loads ANOTHER
        org's store, which must show as foreign)."""
        s, store, api = self.wrslug, self.m["store"], self.m["api"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        base = f"/api/orgs/{s}/work-items"

        def get(contract: str, variant: str, condition: str, path: str,
                headers: Any = op, **kw: Any) -> None:
            self.run(contract, variant, condition, s, user, f"GET {contract}", {},
                     call=self.http(self.client, base + path, headers), **kw)

        for cond in both:
            for variant, query in (("work.item-list", ""), ("work.item-list:archived", "?archived=1"),
                                   ("work.item-list:backlogged", "?backlogged=1"),
                                   ("work.item-list:compact", "?compact=1")):
                get("work.item-list", variant, cond, query)
            get("work.item-get", "work.item-get", cond, f"/{self.wr_open}")
            get("work.item-get", "work.item-get:compact", cond, f"/{self.wr_open}?compact=1")
        agent = {"X-Orgtree-Agent-Token": self.tokens[(s, "wr-mgr")]}
        get("work.item-get", "refusal:wr-unknown-item", "warm", "/nope",
            refusal="404 no such item")
        get("work.item-list", "refusal:wr-list-agent-token", "warm", "", agent,
            refusal="401 an agent credential is refused here")
        get("work.item-get", "refusal:wr-get-agent-token", "warm", f"/{self.wr_open}", agent,
            refusal="401 an agent credential is refused here")
        # a document with an unnamed item is legacy identity: refused, never
        # served or converted (restored outside the row)
        saved: dict[str, Any] = {}
        self.mutate(s, lambda o: saved.update(slug=o._work_find(self.wr_back)[0].pop("slug")))
        get("work.item-list", "refusal:wr-legacy-identity", "warm", "",
            refusal="409 legacy work identity (migrate-work-identity)")
        self.mutate(s, lambda o: next(w for w in o.d["work_items"] if "slug" not in w).update(
            slug=saved["slug"]))

        # org-level locality control: the identity guard ALSO loads another
        # org's store cold, so the read's statements must show it as foreign
        foreign, guard = self.mslug, api._work_identity_guard

        def guard_and_load_foreign(org: Any) -> None:
            store._invalidate_snapshot(foreign)
            store._POOL.close_all(foreign)
            store.load_org(foreign)
            guard(org)
        get("work.item-get", "control:work-read-foreign-org", "warm", f"/{self.wr_open}",
            refusal="negative control (not a product path)",
            patches=[(api, "_work_identity_guard", guard_and_load_foreign)],
            expected_unknown=("sqlite_connect:data:org-db:foreign",
                              "statement:data:org-db:foreign"))

    # -- P01 S3 F4: receipt.lookup (orgtree_op_lookup) ---------------------------
    def build_receipts(self) -> None:
        """tests/test_state_receipt_lookup_boundary.py's org (distinctive
        `rl-*` ids): rl-top, rl-mid under it (the reallocation target the
        looked-up call names), rl-sib (the third agent of the control)."""
        store, ledger = self.m["store"], self.m["ledger"]
        org = store.create_org("p02-contacts-receipts")
        self.rlslug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 40, "rl-top", add_dirs=[], tools={}, charter="fixture")
        org.hire("rl-top", "rl-top", "haiku", 4, "rl-mid", **self.SCOPE)
        org.hire("rl-top", "rl-top", "haiku", 0, "rl-sib", **self.SCOPE)
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for n in ("rl-top", "rl-mid"):
            self.tokens[(self.rlslug, n)] = self.m["agentauth"].child_env(
                self.rlslug, n)["ORGTREE_AGENT_TOKEN"]

    def receipt_namespaces(self, slug: str) -> dict[str, int]:
        """Receipt rows per owning agent (`log_l` rows of section
        `op_receipts`), read with a plain read-only connection OUTSIDE any
        operation window."""
        path = self.data / "orgs" / f"{slug}.db"
        with contextlib.closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as c:
            return {str(n): int(k) for n, k in c.execute(
                "SELECT json_extract(val, '$.node'), count(*) FROM log_l "
                "WHERE sect = 'op_receipts' GROUP BY 1").fetchall()}

    def receipts(self) -> None:
        """Each lookup answer P01's clause names (not_applied with a fence,
        applied, conflict, epoch-rotated), plus a lookup answered from the
        fence, cold and warm; another agent asking about the same key;
        refusals and a locality control. `receipt_namespace` is each row's
        change in receipt rows per owning agent (read outside the window).
        Setup calls are followed by a snapshot refresh OUTSIDE the row, so a
        warm row does not carry the setup's changed-row re-read (see F3)."""
        s, store, api, opreceipts = self.rlslug, self.m["store"], self.m["api"], self.m["opreceipts"]
        supervisor, both = self.m["supervisor"], ("cold", "warm")
        ra, args = "orgtree_reallocate", {"node": "rl-mid", "delta": 1}

        def post(actor: str, tool: str, body: dict[str, Any]) -> Any:
            return self.client.post("/api/agent", json=self.agent_body(s, actor, tool, body),
                                    headers={"X-Orgtree-Agent-Token": self.tokens[(s, actor)]})
        epoch = post("rl-top", opreceipts.OP_EPOCH, {}).json()["epoch"]

        def lookup(variant: str, condition: str, key: str, actor: str = "rl-top",
                   for_args: "dict[str, Any] | None" = None, ep: "str | None" = None,
                   **kw: Any) -> dict[str, Any]:
            body = {"op_key": key, "op_epoch": epoch if ep is None else ep, "for_tool": ra,
                    "for_args": args if for_args is None else for_args}
            answer: dict[str, Any] = {}

            def call() -> tuple[int, Any]:
                # the agent door itself, so the answer can be kept on the row
                r = post(actor, opreceipts.OP_LOOKUP, body)
                try:
                    payload = r.json()
                except ValueError:
                    payload = None
                answer["payload"] = payload
                return r.status_code, payload
            before = self.receipt_namespaces(s)
            row = self.run("receipt.lookup", variant, condition, s, actor, opreceipts.OP_LOOKUP,
                           body, call=call, **kw)
            after = self.receipt_namespaces(s)
            got = answer.get("payload")
            row["answer"] = ({k: got.get(k) for k in ("state", "reason", "fenced")}
                             if isinstance(got, dict) and "state" in got else None)
            row["receipt_namespace"] = {n: after.get(n, 0) - before.get(n, 0)
                                        for n in sorted(set(before) | set(after))
                                        if after.get(n, 0) != before.get(n, 0)}
            return row

        def applied_key() -> str:
            key = opreceipts.mint_key()
            r = post("rl-top", opreceipts.OP_CALL, {"tool": ra, "args": args, "op_key": key,
                                                    "op_epoch": epoch})
            if r.status_code != 200:
                raise RuntimeError(f"fixture keyed call answered {r.status_code}: {r.text[:200]}")
            store.cached_org(s)       # drain the setup's changed rows outside the row
            return key

        for cond in both:
            key = opreceipts.mint_key()
            lookup("receipt.lookup:not-applied", cond, key)
            lookup("receipt.lookup:fenced-again", cond, key)
            key = applied_key()
            lookup("receipt.lookup:applied", cond, key)
            lookup("receipt.lookup:conflict", cond, key, for_args={"node": "rl-mid", "delta": 2})
            lookup("receipt.lookup:epoch-rotated", cond, opreceipts.mint_key(), ep="rotated")
        # another agent asking about rl-top's applied key finds nothing in ITS
        # namespace and fences it there
        key = applied_key()
        lookup("receipt.lookup:other-agents-key", "warm", key, actor="rl-mid")
        halted = [(supervisor.halt, "blocked", lambda *_a, **_k: "halt")]
        lookup("refusal:rl-halted", "warm", key, refusal="409 the agent is halted",
               patches=halted)
        for variant, body, token, refusal in (
                ("refusal:rl-no-key", {"op_epoch": epoch, "for_tool": ra, "for_args": args},
                 None, "422 a lookup needs the op_key"),
                ("refusal:rl-no-tool", {"op_key": opreceipts.mint_key(), "op_epoch": epoch,
                                        "for_args": args}, None, "422 a lookup needs for_tool"),
                ("refusal:rl-bad-token", {"op_key": key}, "nope", "401 bad agent token")):
            self.run("receipt.lookup", variant, "warm", s, "rl-top", opreceipts.OP_LOOKUP, body,
                     token=token, refusal=refusal)

        # agent-level locality control: a lookup whose answer is followed by
        # mail to a third agent
        original = api._op_lookup_call

        def lookup_and_mail_third(*a: Any, **k: Any) -> Any:
            out = original(*a, **k)
            with store.write_org(s) as o:
                o.post_mail("rl-top", "rl-sib", "p02 control: mail to a third agent")
                store.save_org(o)
            return out
        lookup("control:receipt-lookup-third-agent", "warm", opreceipts.mint_key(),
               refusal="negative control (not a product path)",
               patches=[(api, "_op_lookup_call", lookup_and_mail_third)])

    # -- P01 F6: the org and agent reads (org-read.*) ---------------------------------
    OR_TRANSCRIPT_NODES = ("or-chat-cold", "or-chat-warm", "or-hist-cold", "or-hist-warm",
                           "or-cursor", "or-img")
    OR_PNG = b"\x89PNG fixture bytes"

    def build_orgreads(self) -> None:
        """tests/test_state_org_read_boundary.py's shape (distinctive `or-*` ids):
        or-top top-level; or-mid under it with scratch files; one node per
        FIRST read (a chat read mints the node's reply and transcript-record
        incarnations on the first read only, so each first-read row reads a
        node never read before), each with a fixture transcript of its own
        (or-noimg's has no image); or-leaf has none; or-third is never named.
        The main org has a workspace with a CLAUDE.md. Separate orgs: two
        for the /net identity backfill (it writes on an org's first reveal),
        a kiosk, a bare org (no workspace) and one with an unmounted disk."""
        store, ledger = self.m["store"], self.m["ledger"]
        user = ledger.USER
        org = store.create_org("p02-contacts-orgread")
        self.orslug = s = str(org.d["slug"])
        org.hire(user, None, "haiku", 30, "or-top", add_dirs=[], tools={}, charter="fixture")
        for nid in ("or-mid", "or-leaf", "or-noimg", "or-third") + self.OR_TRANSCRIPT_NODES:
            org.hire("or-top", "or-top", "haiku", 0, nid, **self.SCOPE)
        self.or_transcripts: dict[str, str] = {}
        tdir = self.root / "or-transcripts"
        tdir.mkdir()
        for i, nid in enumerate(self.OR_TRANSCRIPT_NODES + ("or-noimg",)):
            sid = f"00000000-0000-4000-8000-{i:012d}"
            org.node(nid)["session_id"] = sid
            path = tdir / f"{nid}.jsonl"
            image = nid != "or-noimg"
            png = base64.b64encode(self.OR_PNG).decode()
            rows = [{"type": "user", "uuid": "u-1", "timestamp": "2026-09-10T12:00:00Z",
                     "message": {"role": "user", "content": "hello"}},
                    {"type": "assistant", "uuid": "a-1", "timestamp": "2026-09-10T12:00:01Z",
                     "message": {"id": "m-1", "role": "assistant", "content": [
                         {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {}}]}},
                    {"type": "user", "uuid": "u-2", "timestamp": "2026-09-10T12:00:02Z",
                     "message": {"role": "user", "content": [
                         {"type": "tool_result", "tool_use_id": "toolu_1", "content": (
                             [{"type": "image", "source": {"type": "base64",
                                                           "media_type": "image/png",
                                                           "data": png}}]
                             if image else "text only")}]}},
                    {"type": "assistant", "uuid": "a-2", "timestamp": "2026-09-10T12:00:03Z",
                     "message": {"id": "m-2", "role": "assistant", "content": "done"}}]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            self.or_transcripts[sid] = str(path)
        ws = self.root / "or-workspace"
        ws.mkdir()
        (ws / "CLAUDE.md").write_text("x" * 10, encoding="utf-8")
        org.d["workspace"] = str(ws)
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        self.tokens[(s, "or-mid")] = self.m["agentauth"].child_env(s, "or-mid")["ORGTREE_AGENT_TOKEN"]
        scratch = Path(self.m["supervisor"].scratch_dir(s, "or-mid"))
        (scratch / "sub").mkdir(parents=True, exist_ok=True)
        (scratch / "notes.txt").write_text("notes", encoding="utf-8")
        (scratch / "sub" / "deep.txt").write_text("deep", encoding="utf-8")
        self.or_other: dict[str, str] = {}
        for role in ("net-cold", "net-warm", "kiosk", "bare", "disk"):
            org = store.create_org(f"p02-contacts-orgread-{role}")
            self.or_other[role] = str(org.d["slug"])
            org.hire(user, None, "haiku", 2, f"or{role[0]}{role[-1]}-top", add_dirs=[], tools={},
                     charter="fixture")
            if role == "kiosk":
                org.d["kiosk"] = {"enabled": True, "credits": 0, "spend_limit": 0.0,
                                  "storage_limit_mb": 0, "token": "kiosk-token-orgread",
                                  "auto_raise": False,
                                  "max_scope": {"tools": self.NO_TOOLS, "add_dirs": [],
                                                "org_visibility": "team",
                                                "permission_mode": "acceptEdits"}}
            if role == "disk":
                org.d["disk"] = {"size_mb": 1024}
            org.d["mail"], org.d["audiences"] = {}, []
            store.save_org(org)

    def org_reads(self) -> None:
        """Every F6 read, cold and warm. As in the P01 fixture, a node's
        transcript is a fixture file (supervisor.transcript_path and
        transcript_path_for_node resolve the node's session id to it), and
        notify, the storage check and turn delivery are spies; hub_changed is
        real and counted. Reads that WRITE (the chat mint, the history chat
        section, the /net identity backfill) have a first-read row and a
        repeat row. Each row also records `resource_warnings`: the
        ResourceWarnings raised while it ran, after a garbage collection, so a
        file the handler opened and never closed is counted against the row."""
        s, api, supervisor = self.orslug, self.m["api"], self.m["supervisor"]
        spies: collections.Counter = collections.Counter()
        paths = self.or_transcripts

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return answer
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)

        def by_session(session_id: str, root: "str | None" = None) -> "str | None":
            return paths.get(str(session_id))

        def by_node(org: Any, nid: str) -> "str | None":
            return paths.get(str((org.nodes.get(nid) or {}).get("session_id") or ""))
        family = [(api, "hub_changed", hub_counted),
                  (supervisor, "notify", spy("notify")),
                  (supervisor, "maybe_storage_check", spy("maybe_storage_check")),
                  (supervisor, "transcript_path", by_session),
                  (supervisor, "transcript_path_for_node", by_node)]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._org_read_rows(s, api, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _org_read_rows(self, s: str, api: Any, spies: collections.Counter) -> None:
        from orgtree import deployment
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        o = self.or_other
        frozen = [(api.deployment, "current_policy", lambda *_a, **_k: deployment.FROZEN)]

        def route(contract: str, variant: str, condition: str, path: str,
                  params: Any = None, slug: str = s, headers: Any = op,
                  args: "dict[str, Any] | None" = None, **kw: Any) -> dict[str, Any]:
            def call() -> tuple[int, Any]:
                resp = self.client.get(path, params=params, headers=headers)
                try:
                    return resp.status_code, resp.json()
                except ValueError:
                    return resp.status_code, {"ctype": resp.headers.get("content-type", "")
                                              .split(";")[0], "bytes": len(resp.content)}
            n0 = dict(spies)
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always", ResourceWarning)
                row = self.run(contract, variant, condition, slug, user, f"GET {contract}",
                               args or {}, call=call, **kw)
                gc.collect()
            row["resource_warnings"] = sum(1 for w in caught
                                           if issubclass(w.category, ResourceWarning)
                                           and str(w.message).startswith("unclosed file"))
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        base = f"/api/orgs/{s}"
        for cond in both:
            chat = f"or-chat-{cond}"
            route("org-read.chat", "org-read.chat", cond, f"{base}/nodes/{chat}/chat",
                  args={"node": chat})
            route("org-read.file", "org-read.file", cond, f"{base}/nodes/or-mid/file",
                  params={"path": "notes.txt"}, args={"node": "or-mid"})
            route("org-read.scratch", "org-read.scratch", cond, f"{base}/nodes/or-mid/scratch",
                  args={"node": "or-mid"})
            route("org-read.tool-image", "org-read.tool-image", cond,
                  f"{base}/nodes/or-img/toolimg/toolu_1", args={"node": "or-img"})
            route("org-read.node-history", "org-read.node-history", cond,
                  f"{base}/nodes/or-mid/history", args={"node": "or-mid"})
            route("org-read.history-sources", "org-read.history-sources", cond, f"{base}/history")
            route("org-read.history-entries", "org-read.history-entries", cond,
                  f"{base}/history/events")
            hist = f"or-hist-{cond}"
            route("org-read.history-entries", "org-read.history-entries:chat-first", cond,
                  f"{base}/history/chat", params={"node": hist}, args={"node": hist})
            route("org-read.events", "org-read.events", cond, f"{base}/events")
            route("org-read.orgmd", "org-read.orgmd", cond, f"{base}/orgmd")
            net = o[f"net-{cond}"]
            if cond == "warm":
                self.m["store"].load_org(net)
            route("org-read.net", "org-read.net", cond, f"/api/orgs/{net}/net", slug=net)
            route("org-read.aggregates", "org-read.aggregates", cond,
                  f"{base}/diagnostics/aggregates")
            # no sandboxed org and no virtual disk here: these answer their
            # refusal in the standard profile (their success paths need a
            # sandbox, which a synthetic root does not have)
            route("org-read.bridge-credential", "refusal:bridge-standard-profile", cond,
                  f"{base}/bridge-credential",
                  refusal="409 rotatable credentials are active only in the frozen profile")
            route("org-read.bridge-credential", "refusal:bridge-frozen-not-sandboxed", cond,
                  f"{base}/bridge-credential", patches=frozen,
                  refusal="503 frozen profile: the org is not sandboxed")
            route("org-read.disk-list", "refusal:disk-list-no-disk", cond, f"{base}/disk",
                  refusal="409 no virtual disk")
            route("org-read.disk-dir", "refusal:disk-dir-no-disk", cond, f"{base}/disk/dir",
                  refusal="409 no virtual disk")
            route("org-read.disk-file", "refusal:disk-file-no-disk", cond, f"{base}/disk/file",
                  params={"path": "home/x"}, refusal="409 no virtual disk")

        # the second read of a node / an org: nothing left to mint
        route("org-read.chat", "org-read.chat:repeat", "warm", f"{base}/nodes/or-chat-warm/chat",
              args={"node": "or-chat-warm"})
        route("org-read.chat", "org-read.chat:no-transcript", "warm",
              f"{base}/nodes/or-leaf/chat", args={"node": "or-leaf"})
        route("org-read.history-entries", "org-read.history-entries:chat-repeat", "warm",
              f"{base}/history/chat", params={"node": "or-hist-warm"},
              args={"node": "or-hist-warm"})
        route("org-read.net", "org-read.net:repeat", "warm", f"/api/orgs/{o['net-warm']}/net",
              slug=o["net-warm"])
        route("org-read.net", "org-read.net:kiosk", "warm", f"/api/orgs/{o['kiosk']}/net",
              slug=o["kiosk"])
        route("org-read.scratch", "org-read.scratch:file", "warm", f"{base}/nodes/or-mid/scratch",
              params={"path": "sub/deep.txt"}, args={"node": "or-mid"})
        route("org-read.events", "org-read.events:last", "warm", f"{base}/events",
              params={"last": 2})
        route("org-read.aggregates", "org-read.aggregates:one", "warm",
              f"{base}/diagnostics/aggregates", params={"collections": "events"})
        route("org-read.orgmd", "org-read.orgmd:none", "warm", f"/api/orgs/{o['bare']}/orgmd",
              slug=o["bare"])
        (self.root / "or-workspace" / "CLAUDE.md").write_text("x" * 70000, encoding="utf-8")
        route("org-read.orgmd", "org-read.orgmd:long", "warm", f"{base}/orgmd")
        # an org whose disk is configured but not mounted: the read shells out
        # to WSL (disk._run: `wsl -l -q`, `wsl -d <distro> -e sh -c ...`) to find
        # the mount, so a GET starts a process; the guard refuses it (500 here)
        disk = o["disk"]
        wsl = dict(expected_unknown=("guard:process/subprocess.Popen",),
                   refusal="the read starts wsl.exe (disk._run): refused by the guard, 500 here")
        route("org-read.disk-list", "refusal:disk-list-unmounted", "warm", f"/api/orgs/{disk}/disk",
              slug=disk, **wsl)
        route("org-read.disk-dir", "refusal:disk-dir-unmounted", "warm",
              f"/api/orgs/{disk}/disk/dir", slug=disk, **wsl)
        # recorded legacy: the chat mint runs before the cursor check, so a
        # read refused 422 still writes (a node never read before)
        route("org-read.chat", "refusal:chat-bad-cursor", "warm", f"{base}/nodes/or-cursor/chat",
              params={"before": "garbage"}, args={"node": "or-cursor"},
              refusal="422 invalid cursor (legacy: after the mint, which writes)")
        # ... and the repeat: the node is minted, so the same refusal writes nothing
        route("org-read.chat", "refusal:chat-bad-cursor:repeat", "warm",
              f"{base}/nodes/or-cursor/chat", params={"before": "garbage"},
              args={"node": "or-cursor"}, refusal="422 invalid cursor (the node is already minted)")
        for contract, variant, path, params, slug, refusal in (
                ("org-read.chat", "refusal:chat-ghost", f"{base}/nodes/ghost/chat", None, s,
                 "404 no such node"),
                ("org-read.file", "refusal:file-missing", f"{base}/nodes/or-mid/file",
                 {"path": "nope.txt"}, s, "404 no such file"),
                ("org-read.file", "refusal:file-escape", f"{base}/nodes/or-mid/file",
                 {"path": "../../x"}, s, "422 escapes the scratch space"),
                ("org-read.file", "refusal:file-ghost", f"{base}/nodes/ghost/file", {"path": "x"}, s,
                 "404 no such node"),
                ("org-read.scratch", "refusal:scratch-missing", f"{base}/nodes/or-mid/scratch",
                 {"path": "nope"}, s, "404 no such path"),
                ("org-read.scratch", "refusal:scratch-escape", f"{base}/nodes/or-mid/scratch",
                 {"path": "../.."}, s, "422 escapes the scratch space"),
                ("org-read.scratch", "refusal:scratch-ghost", f"{base}/nodes/ghost/scratch", None, s,
                 "404 no such node"),
                ("org-read.tool-image", "refusal:toolimg-no-image",
                 f"{base}/nodes/or-noimg/toolimg/toolu_1", None, s, "404 no image"),
                ("org-read.tool-image", "refusal:toolimg-no-transcript",
                 f"{base}/nodes/or-leaf/toolimg/toolu_1", None, s, "404 no transcript"),
                ("org-read.tool-image", "refusal:toolimg-ghost", f"{base}/nodes/ghost/toolimg/toolu_1",
                 None, s, "404 no such node"),
                ("org-read.node-history", "refusal:node-history-ghost", f"{base}/nodes/ghost/history",
                 None, s, "404 no such node"),
                ("org-read.node-history", "refusal:node-history-no-org",
                 "/api/orgs/nope-org/nodes/or-mid/history", None, s, "404 no such org"),
                ("org-read.history-sources", "refusal:history-sources-no-org",
                 "/api/orgs/nope-org/history", None, s, "404 no such org"),
                ("org-read.history-entries", "refusal:history-node-missing",
                 f"{base}/history/node-mail", None, s, "404 no node named"),
                ("org-read.history-entries", "refusal:history-unknown", f"{base}/history/bogus", None,
                 s, "404 unknown collection"),
                ("org-read.history-entries", "refusal:history-bad-cursor", f"{base}/history/events",
                 {"cursor": "garbage"}, s, "422 invalid cursor"),
                ("org-read.events", "refusal:events-no-org", "/api/orgs/nope-org/events", None, s,
                 "404 no such org"),
                ("org-read.orgmd", "refusal:orgmd-no-org", "/api/orgs/nope-org/orgmd", None, s,
                 "404 no such org"),
                ("org-read.net", "refusal:net-no-org", "/api/orgs/nope-org/net", None, s,
                 "404 no such org"),
                ("org-read.aggregates", "refusal:aggregates-bad", f"{base}/diagnostics/aggregates",
                 {"collections": "bogus"}, s, "422 unsupported collection"),
                ("org-read.aggregates", "refusal:aggregates-no-org",
                 "/api/orgs/nope-org/diagnostics/aggregates", None, s, "404 no such org"),
                ("org-read.disk-list", "refusal:disk-no-org", "/api/orgs/nope-org/disk", None, s,
                 "404 no such org"),
                ("org-read.disk-dir", "refusal:disk-dir-escape", f"/api/orgs/{disk}/disk/dir",
                 {"path": "../x"}, disk, "422 escapes the org disk"),
                ("org-read.disk-file", "refusal:disk-file-escape", f"/api/orgs/{disk}/disk/file",
                 {"path": "../x"}, disk, "422 escapes the org disk"),
                ("org-read.disk-file", "refusal:disk-file-missing", f"/api/orgs/{disk}/disk/file",
                 {"path": "home/none.txt"}, disk, "the read starts wsl.exe (disk._run): refused by "
                 "the guard, 500 here")):
            route(contract, variant, "warm", path, params=params, slug=slug, refusal=refusal,
                  expected_unknown=(("guard:process/subprocess.Popen",)
                                    if variant == "refusal:disk-file-missing" else ()))
        route("org-read.bridge-credential", "refusal:bridge-frozen-no-org", "warm",
              "/api/orgs/nope-org/bridge-credential", patches=frozen, refusal="404 no such org")
        route("org-read.events", "refusal:org-read-agent-token", "warm", f"{base}/events",
              headers={"X-Orgtree-Agent-Token": self.tokens[(s, "or-mid")]},
              refusal="401 an agent credential is refused here")

        # agent-level locality control: an events read whose bounded reader
        # (store.read_events_page) ALSO posts mail to a third agent
        def mail_third() -> None:
            with self.m["store"].write_org(s) as org:
                org.post_mail("or-top", "or-third", "p02 control: mail to a third agent")
                self.m["store"].save_org(org)
        store = self.m["store"]
        route("org-read.events", "control:org-read-third-agent", "warm", f"{base}/events",
              refusal="negative control (not a product path)",
              patches=[(store, "read_events_page", self._wrap_then(store.read_events_page,
                                                                    mail_third))])

    @staticmethod
    def _wrap_then(fn: Callable[..., Any], after: Callable[..., Any]) -> Callable[..., Any]:
        def wrapped(*a: Any, **k: Any) -> Any:
            out = fn(*a, **k)
            after()
            return out
        return wrapped

    # -- P01 F4: the exchange routes and tools (mail, inbox, files) ------------------
    def build_exchange(self) -> None:
        """tests/test_state_exchange_boundary.py's shape (distinctive `ex-*` ids):
        the main org (ex-top and ex-top2 top-level, ex-mid under ex-top, ex-leaf
        under ex-mid, ex-third under ex-top and never named), the OTHER org an
        @org: send reaches, a sealed KIOSK org (a ceiling set, as P01's fixture
        does, so a cold load mints no ceiling notice), and a STORAGE-BLOCKED org
        (the flag is org-wide) for the blocked upload and send_file refusals."""
        store, ledger = self.m["store"], self.m["ledger"]
        user = ledger.USER
        self.ex: dict[str, str] = {}
        for role in ("main", "other", "kiosk", "blocked"):
            org = store.create_org(f"p02-contacts-exchange-{role}")
            slug = str(org.d["slug"])
            self.ex[role] = slug
            x = "ex" if role == "main" else f"ex{role[0]}"
            org.hire(user, None, "haiku", 20, f"{x}-top", add_dirs=[], tools={}, charter="fixture")
            org.hire(f"{x}-top", f"{x}-top", "haiku", 6, f"{x}-mid", **self.SCOPE)
            org.hire(f"{x}-top", f"{x}-mid", "haiku", 2, f"{x}-leaf", **self.SCOPE)
            org.hire(user, None, "haiku", 5, f"{x}-top2", add_dirs=[], tools={}, charter="fixture")
            if role == "main":
                org.hire("ex-top", "ex-top", "haiku", 0, "ex-third", **self.SCOPE)
            if role == "kiosk":
                org.d["kiosk"] = {"enabled": True, "credits": 0, "spend_limit": 0.0,
                                  "storage_limit_mb": 0, "token": "kiosk-token-fixture",
                                  "auto_raise": False,
                                  "max_scope": {"tools": self.NO_TOOLS, "add_dirs": [],
                                                "org_visibility": "team",
                                                "permission_mode": "acceptEdits"}}
            if role == "blocked":
                org.d["storage_blocked"] = True
            org.d["mail"], org.d["audiences"] = {}, []
            store.save_org(org)
            if role in ("main", "blocked"):
                self.tokens[(slug, f"{x}-mid")] = self.m["agentauth"].child_env(
                    slug, f"{x}-mid")["ORGTREE_AGENT_TOKEN"]
                scratch = Path(self.m["supervisor"].scratch_dir(slug, f"{x}-mid"))
                scratch.mkdir(parents=True, exist_ok=True)
                (scratch / "report.txt").write_text("report", encoding="utf-8")
                (scratch / "other.txt").write_text("other", encoding="utf-8")

    def exchange(self) -> None:
        """Every F4 contract, cold and warm. As in the P01 fixture, turn
        delivery, the mail spark, supervisor.notify, the storage check, the
        workspace usage read and the mail-hub kick are counting spies
        (`spies`); hub_changed is real and counted. The external-chat routes
        (/api/extern/*), their MCP server (externtool) and @mcp: sends were
        retired on 2026-09-25: an @mcp: send is now a refusal row, and the
        org inbox's peer entries are written directly, from `@net:p02x.<n>`
        peers."""
        s, api, supervisor = self.ex["main"], self.m["api"], self.m["supervisor"]
        spies: collections.Counter = collections.Counter()

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return answer
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)
        family = [(api, "hub_changed", hub_counted),
                  (supervisor, "mail_spark", spy("mail_spark")),
                  (supervisor, "notify", spy("notify")),
                  (supervisor, "maybe_storage_check", spy("maybe_storage_check")),
                  (supervisor, "workspace_usage_cached", spy("workspace_usage_cached")),
                  (api.net, "kick", spy("net_kick"))]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._exchange_rows(s, api, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _exchange_rows(self, s: str, api: Any, spies: collections.Counter) -> None:
        store, opreceipts = self.m["store"], self.m["opreceipts"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        other, kiosk, blocked = self.ex["other"], self.ex["kiosk"], self.ex["blocked"]
        peers = iter(range(1, 1000))
        stmt = ("statement:data:org-db:foreign",)

        def peer() -> str:
            return f"p02x.{next(peers)}"

        def counted(row_of: Callable[[], dict[str, Any]]) -> dict[str, Any]:
            n0 = dict(spies)
            row = row_of()
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        def route(contract: str, variant: str, condition: str, method: str, path: str,
                  headers: Any = op, args: "dict[str, Any] | None" = None, slug: str = s,
                  json_body: Any = None, params: Any = None, content: "bytes | None" = None,
                  **kw: Any) -> dict[str, Any]:
            def call() -> tuple[int, Any]:
                extra: dict[str, Any] = {}
                if json_body is not None:
                    extra["json"] = json_body
                if params is not None:
                    extra["params"] = params
                if content is not None:
                    extra["content"] = content
                resp = self.client.request(method, path, headers=headers, **extra)
                try:
                    return resp.status_code, resp.json()
                except ValueError:
                    return resp.status_code, None
            return counted(lambda: self.run(contract, variant, condition, slug, user,
                                            f"{method} {contract}", args or {}, call=call, **kw))

        def run(contract: str, variant: str, condition: str, actor: str, tool: str,
                args: dict[str, Any], slug: str = s, **kw: Any) -> dict[str, Any]:
            return counted(lambda: self.run(contract, variant, condition, slug, actor, tool,
                                            args, **kw))

        def req(method: str, path: str, **kw: Any) -> Any:
            """A setup call on the desktop token, outside any row."""
            r = self.client.request(method, path, headers=op, **kw)
            if r.status_code != 200:
                raise RuntimeError(f"setup {path} answered {r.status_code}: {r.text[:200]}")
            return r.json()

        def org_reply(p: str, slug: str = s) -> None:
            """A mail-hub peer asks, the org answers: an 'in' and an 'out' entry."""
            def log(o: Any) -> None:
                o._org_inbox_log("in", f"@net:{p}", "question one")
                o._org_inbox_log("out", f"@net:{p}", "answer one", by="ex-top")
            self.mutate(slug, log)

        def user_mail() -> str:
            self.mutate(s, lambda o: o.post_mail("ex-top", user, "hello user"))
            return str(store.load_org(s).d["user_inbox"][-1]["id"])

        def pending_mail() -> str:
            self.mutate(s, lambda o: o.post_mail("ex-top", "ex-mid", "pending for mid"))
            return str(store.load_org(s).d["mail"]["ex-mid"][-1]["id"])

        def staged() -> str:
            return str(req("POST", f"/api/orgs/{s}/org_inbox/upload", params={"name": "note.txt"},
                           content=b"staged bytes")["id"])

        base = f"/api/orgs/{s}"
        for cond in both:
            route("exchange.orgs-list", "exchange.orgs-list", cond, "GET", "/api/orgs",
                  expected_unknown=stmt)
            org_reply(peer())
            route("exchange.org-inbox-list", "exchange.org-inbox-list", cond, "GET",
                  f"{base}/org_inbox")
            mid = user_mail()
            route("exchange.mail-item", "exchange.mail-item", cond, "GET", f"{base}/mail/user/{mid}")
            org_reply(peer())
            route("exchange.org-inbox-read", "exchange.org-inbox-read", cond, "POST",
                  f"{base}/org_inbox/read")
            route("exchange.org-inbox-upload", "exchange.org-inbox-upload", cond, "POST",
                  f"{base}/org_inbox/upload", params={"name": "a b?.txt"}, content=b"bytes")
            # the delivered send: to another local org (@mcp: is retired, and
            # @net: needs a mail hub), so it writes the OTHER org's document
            route("exchange.org-inbox-send", "exchange.org-inbox-send", cond, "POST",
                  f"{base}/org_inbox/send", json_body={"to": f"@org:{other}", "body": "hi"},
                  expected_unknown=stmt)
            user_mail()
            route("exchange.inbox-clear", "exchange.inbox-clear", cond, "POST", f"{base}/inbox/clear")
            route("exchange.node-upload", "exchange.node-upload", cond, "POST",
                  f"{base}/nodes/ex-mid/upload", params={"name": f"a-{cond}.txt"},
                  content=b"one", args={"node": "ex-mid"})
            route("exchange.reply-events-count", "exchange.reply-events-count", cond, "GET",
                  f"{base}/nodes/ex-mid/reply-events", args={"node": "ex-mid"})
            route("exchange.reply-events-clear", "exchange.reply-events-clear", cond, "DELETE",
                  f"{base}/nodes/ex-mid/reply-events", args={"node": "ex-mid"})
            mid = pending_mail()
            route("exchange.mail-retract", "exchange.mail-retract", cond, "DELETE",
                  f"{base}/nodes/ex-mid/mail/{mid}", args={"node": "ex-mid"})
            run("exchange.send-file", "exchange.send-file", cond, "ex-mid", "orgtree_send_file",
                {"path": "report.txt", "note": "the report"})

        # variants (warm)
        route("exchange.mail-item", "exchange.mail-item:user-missing", "warm", "GET",
              f"{base}/mail/user/nope")
        mid = pending_mail()
        route("exchange.mail-item", "exchange.mail-item:node", "warm", "GET",
              f"{base}/mail/node/{mid}", params={"node": "ex-mid"}, args={"node": "ex-mid"})
        org_reply(peer())
        oid = str(store.load_org(s).d["org_inbox"][-1]["id"])
        route("exchange.mail-item", "exchange.mail-item:org", "warm", "GET", f"{base}/mail/org/{oid}")
        # an @org: send writes the OTHER org's document; to a sealed kiosk or a
        # missing org it only warns
        for variant, to, extra in (
                ("exchange.org-inbox-send:org", f"@org:{other}", {}),
                ("exchange.org-inbox-send:org-kiosk", f"@org:{kiosk}", {}),
                ("exchange.org-inbox-send:org-missing", "@org:nope-org", {}),
                ("exchange.org-inbox-send:org-attachment", f"@org:{other}",
                 {"attachments": [staged()]})):
            route("exchange.org-inbox-send", variant, "warm", "POST", f"{base}/org_inbox/send",
                  json_body={"to": to, "body": "hi", **extra},
                  expected_unknown=(stmt if ":org" in variant and "missing" not in variant
                                    else ()))
        # @mcp: is retired: refused 422 before anything else, the attachment
        # check included
        route("exchange.org-inbox-send", "refusal:org-send-mcp-retired", "warm", "POST",
              f"{base}/org_inbox/send", json_body={"to": f"@mcp:{peer()}", "body": "hi"},
              refusal="422 the @mcp: address form is retired")
        route("exchange.org-inbox-send", "refusal:org-send-mcp-retired-attachment", "warm", "POST",
              f"{base}/org_inbox/send",
              json_body={"to": f"@mcp:{peer()}", "body": "hi", "attachments": [staged()]},
              refusal="422 the @mcp: address form is retired (before the attachment check)")
        route("exchange.node-upload", "exchange.node-upload:duplicate", "warm", "POST",
              f"{base}/nodes/ex-mid/upload", params={"name": "a-warm.txt"}, content=b"one",
              args={"node": "ex-mid"})
        did = "p02-delivery-0001"
        for variant, tool, args in (
                ("exchange.send-file:delivery", "orgtree_send_file",
                 {"path": "report.txt", "delivery_id": did}),
                ("exchange.send-file:delivery-replay", "orgtree_send_file",
                 {"path": "report.txt", "delivery_id": did}),
                ("exchange.send-file:once", "orgtree_send_file_once",
                 {"path": "report.txt", "delivery_id": "p02-delivery-0002"})):
            run("exchange.send-file", variant, "warm", "ex-mid", tool, args)
        ep = str(self.client.post(
            "/api/agent", json=self.agent_body(s, "ex-mid", opreceipts.OP_EPOCH, {}),
            headers={"X-Orgtree-Agent-Token": self.tokens[(s, "ex-mid")]}).json()["epoch"])
        run("exchange.send-file", "exchange.send-file:keyed", "warm", "ex-mid", "orgtree_send_file",
            {"path": "report.txt"}, key=opreceipts.mint_key(), epoch=ep)

        # refusals (warm): the routes
        agent = {"X-Orgtree-Agent-Token": self.tokens[(s, "ex-mid")]}
        for contract, variant, method, path, kw, refusal in (
                ("exchange.org-inbox-list", "refusal:org-inbox-no-org", "GET",
                 "/api/orgs/nope-org/org_inbox", {}, "404 no org"),
                ("exchange.mail-item", "refusal:mail-node-unknown", "GET", f"{base}/mail/node/x",
                 {"params": {"node": "ghost"}}, "404 unknown node"),
                ("exchange.mail-item", "refusal:mail-bad-box", "GET", f"{base}/mail/bogus/x", {},
                 "422 bad box"),
                ("exchange.org-inbox-read", "refusal:org-inbox-read-no-org", "POST",
                 "/api/orgs/nope-org/org_inbox/read", {}, "404 no org"),
                ("exchange.org-inbox-send", "refusal:org-send-ext", "POST", f"{base}/org_inbox/send",
                 {"json_body": {"to": "@ext:x", "body": "x"}}, "422 @ext: is not a channel"),
                ("exchange.org-inbox-send", "refusal:org-send-bad-to", "POST",
                 f"{base}/org_inbox/send", {"json_body": {"to": "bob", "body": "x"}},
                 "422 bad recipient"),
                ("exchange.org-inbox-send", "refusal:org-send-bad-stage", "POST",
                 f"{base}/org_inbox/send",
                 {"json_body": {"to": f"@org:{other}", "body": "x", "attachments": ["nope"]}},
                 "422 unknown stage id"),
                ("exchange.org-inbox-send", "refusal:org-send-net-no-hub", "POST",
                 f"{base}/org_inbox/send", {"json_body": {"to": "@net:elsewhere", "body": "x"}},
                 "422 no mailserver is configured (no enabled hub)"),
                ("exchange.inbox-clear", "refusal:inbox-clear-no-org", "POST",
                 "/api/orgs/nope-org/inbox/clear", {}, "404 no org"),
                ("exchange.node-upload", "refusal:node-upload-empty", "POST",
                 f"{base}/nodes/ex-mid/upload", {"params": {"name": "a.txt"}, "content": b""},
                 "422 empty upload"),
                ("exchange.node-upload", "refusal:node-upload-ghost", "POST",
                 f"{base}/nodes/ghost/upload", {"content": b"x"}, "404 unknown node"),
                ("exchange.node-upload", "refusal:node-upload-blocked", "POST",
                 f"/api/orgs/{blocked}/nodes/exb-mid/upload", {"content": b"x", "slug": blocked},
                 "storage blocked"),
                ("exchange.reply-events-count", "refusal:reply-events-ghost-node", "GET",
                 f"{base}/nodes/ghost/reply-events", {}, "500 legacy: raw LedgerError"),
                ("exchange.reply-events-count", "refusal:reply-events-no-org", "GET",
                 "/api/orgs/nope-org/nodes/ex-mid/reply-events", {}, "500 legacy: raw LedgerError"),
                ("exchange.reply-events-clear", "refusal:reply-events-clear-ghost", "DELETE",
                 f"{base}/nodes/ghost/reply-events", {}, "500 legacy: raw LedgerError"),
                ("exchange.mail-retract", "refusal:retract-gone", "DELETE",
                 f"{base}/nodes/ex-mid/mail/nope", {}, "the mail is gone"),
                ("exchange.orgs-list", "refusal:route-no-token", "GET", "/api/orgs",
                 {"headers": {}}, "401 no credential"),
                ("exchange.org-inbox-list", "refusal:route-agent-token", "GET", f"{base}/org_inbox",
                 {"headers": agent}, "401 an agent credential is refused here")):
            route(contract, variant, "warm", method, path, refusal=refusal, **kw)
        # refusals (warm): the agent tools
        for variant, tool, args, slug, actor in (
                ("refusal:send-file-missing", "orgtree_send_file", {"path": "nope.txt"}, s, "ex-mid"),
                ("refusal:send-file-no-path", "orgtree_send_file", {}, s, "ex-mid"),
                ("refusal:send-file-escape", "orgtree_send_file", {"path": "../../x.txt"}, s,
                 "ex-mid"),
                ("refusal:send-file-bad-delivery-id", "orgtree_send_file",
                 {"path": "report.txt", "delivery_id": "short"}, s, "ex-mid"),
                ("refusal:send-file-once-no-id", "orgtree_send_file_once", {"path": "report.txt"},
                 s, "ex-mid"),
                ("refusal:send-file-delivery-conflict", "orgtree_send_file",
                 {"path": "other.txt", "delivery_id": did}, s, "ex-mid"),
                ("refusal:send-file-blocked", "orgtree_send_file",
                 {"path": "report.txt", "delivery_id": "p02-delivery-0003"}, blocked, "exb-mid")):
            run("exchange.send-file", variant, "warm", actor, tool, args, slug=slug,
                refusal="refused")

        # agent-level locality control: an org-inbox read whose closing tree
        # broadcast (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            spies["hub_changed"] += 1
            with store.write_org(s) as o:
                o.post_mail("ex-top", "ex-third", "p02 control: mail to a third agent")
                store.save_org(o)
        org_reply(peer())
        route("exchange.org-inbox-read", "control:exchange-third-agent", "warm", "POST",
              f"{base}/org_inbox/read", refusal="negative control (not a product path)",
              patches=[(api, "hub_changed", mail_third)])

    # -- P01 F3: asks, reports, scope requests, watchdogs, audiences -------------
    RQ_CELLS = ("ask", "withdraw", "present", "report", "scope", "wdcreate", "wdlist", "wdpause",
                "wdresume", "wdremove", "wdsupersede", "audreq", "audfwd", "audgrant", "auddeny",
                "audrevoke", "answer", "batch", "opscope", "wdop", "audop", "audlist")
    #: warm-only cells: variants, keyed calls, the refusals and the control
    RQ_EXTRA = ("routed", "reporttop", "noask", "dismiss", "keyed", "ref", "ctl")
    RQ_OPTIONS = [{"label": "yes", "description": "go"}, {"label": "no", "description": "stop"}]
    RQ_DOG = {"action": "create", "kind": "file", "target": "notes.txt", "pattern": "done",
              "interval_s": 60}

    def build_requests(self) -> None:
        """tests/test_state_requests_boundary.py's shape, one cell per row
        (distinctive `rq-*` ids): `rq-<cell>-<cond>-<role>`, p TOP-LEVEL (the
        P01 fixture's top: its asks and presentations go to the user), m p's
        report (mid), k m's report (leaf), s m's peer (sib). rq-third sits
        under the ref cell's head, never named."""
        store, ledger = self.m["store"], self.m["ledger"]
        user, both = ledger.USER, ("cold", "warm")
        org = store.create_org("p02-contacts-requests")
        self.rqslug = str(org.d["slug"])
        for cell in [f"{c}-{cond}" for c in self.RQ_CELLS for cond in both] + [
                f"{c}-warm" for c in self.RQ_EXTRA]:
            p, m = f"rq-{cell}-p", f"rq-{cell}-m"
            org.hire(user, None, "haiku", 10, p, add_dirs=[], tools={}, charter="fixture")
            org.hire(p, p, "haiku", 0, m, **self.SCOPE)
            org.hire(p, m, "haiku", 0, f"rq-{cell}-k", **self.SCOPE)
            org.hire(p, p, "haiku", 0, f"rq-{cell}-s", **self.SCOPE)
        org.hire("rq-ref-warm-p", "rq-ref-warm-p", "haiku", 0, "rq-third", **self.SCOPE)
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for nid in org.nodes:
            if nid != "rq-third":
                self.tokens[(self.rqslug, nid)] = self.m["agentauth"].child_env(
                    self.rqslug, nid)["ORGTREE_AGENT_TOKEN"]

    def requests(self) -> None:
        """Every F3 contract and lifecycle.operator-scope, cold and warm. As
        in the P01 fixture, the watchdog smoke run and live effort delivery
        are counting spies (`spies`); turn delivery is the probe's global
        spy (`wakes`); hub_changed is real and counted. Setups (an open ask,
        a watchdog, an audience request or grant) run through the door just
        before the row, outside its window. `implied` is P01's pinned mail
        and notices per cell role."""
        s, api, supervisor = self.rqslug, self.m["api"], self.m["supervisor"]
        spies: collections.Counter = collections.Counter()

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return answer
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)
        family = [(api, "hub_changed", hub_counted),
                  (supervisor, "wd_smoke", spy("wd_smoke", {"ok": True})),
                  (supervisor, "send_live_effort", spy("send_live_effort", "sent"))]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._request_rows(s, api, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _request_rows(self, s: str, api: Any, spies: collections.Counter) -> None:
        store, opreceipts = self.m["store"], self.m["opreceipts"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")

        def counted(row_of: Callable[[], dict[str, Any]]) -> dict[str, Any]:
            n0 = dict(spies)
            row = row_of()
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        def run(contract: str, variant: str, condition: str, actor: str, tool: str,
                args: dict[str, Any], **kw: Any) -> dict[str, Any]:
            return counted(lambda: self.run(contract, variant, condition, s, actor, tool,
                                            args, **kw))

        def route(contract: str, variant: str, condition: str, method: str, path: str,
                  body: Any = None, args: "dict[str, Any] | None" = None, headers: Any = op,
                  **kw: Any) -> dict[str, Any]:
            def call() -> tuple[int, Any]:
                resp = self.client.request(method, f"/api/orgs/{s}{path}", json=body,
                                           headers=headers)
                try:
                    return resp.status_code, resp.json()
                except ValueError:
                    return resp.status_code, None
            return counted(lambda: self.run(contract, variant, condition, s, user,
                                            f"{method} {contract}", args or {}, call=call, **kw))

        def door(actor: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
            """A setup call through the agent door, outside any row."""
            r = self.client.post("/api/agent", json=self.agent_body(s, actor, tool, args),
                                 headers={"X-Orgtree-Agent-Token": self.tokens[(s, actor)]})
            if r.status_code != 200:
                raise RuntimeError(f"setup {tool} answered {r.status_code}: {r.text[:200]}")
            return r.json()

        def ask(p: str) -> tuple[str, int]:
            door(p, "orgtree_ask", {"question": "Proceed?", "options": self.RQ_OPTIONS})
            a = next(a for a in store.load_org(s).d["asks"]
                     if a["node"] == p and a["status"] == "open")
            return str(a["id"]), int(a.get("rev") or 1)

        def dog(m: str, once: bool = False, paused: bool = False) -> str:
            wid = str(door(m, "orgtree_watchdog", {**self.RQ_DOG, "name": "d1",
                                                   **({"once": True} if once else {})})["id"])
            if paused:
                door(m, "orgtree_watchdog", {"action": "pause", "id": wid})
            return wid

        def aud_request(k: str, p: str) -> None:
            door(k, "orgtree_audience", {"action": "request", "target": p, "reason": "need"})

        wd = "orgtree_watchdog"
        for cond in both:
            def c(cell: str, role: str) -> str:
                return f"rq-{cell}-{cond}-{role}"
            run("asks.ask", "asks.ask", cond, c("ask", "p"), "orgtree_ask",
                {"question": "Proceed?"})
            ask(c("withdraw", "p"))
            run("asks.withdraw", "asks.withdraw", cond, c("withdraw", "p"), "orgtree_withdraw_ask",
                {})
            run("asks.present", "asks.present", cond, c("present", "p"), "orgtree_present",
                {"title": "Plan", "body": "# plan"})
            run("asks.submit-report", "asks.submit-report", cond, c("report", "k"),
                "orgtree_submit_report", {"title": "Report", "body": "# r"},
                implied=(c("report", "m"),))
            run("asks.request-scope", "asks.request-scope", cond, c("scope", "p"),
                "orgtree_request_scope", {"items": [{"kind": "dir", "path": "C:/x"}],
                                          "reason": "need"})
            run("watchdogs.create", "watchdogs.create", cond, c("wdcreate", "m"), wd,
                {**self.RQ_DOG, "name": "d1"})
            dog(c("wdlist", "m"))
            run("watchdogs.list", "watchdogs.list", cond, c("wdlist", "m"), wd, {"action": "list"})
            wid = dog(c("wdpause", "m"))
            run("watchdogs.pause", "watchdogs.pause", cond, c("wdpause", "m"), wd,
                {"action": "pause", "id": wid})
            wid = dog(c("wdresume", "m"), paused=True)
            run("watchdogs.resume", "watchdogs.resume", cond, c("wdresume", "m"), wd,
                {"action": "resume", "id": wid})
            wid = dog(c("wdremove", "m"))
            run("watchdogs.remove", "watchdogs.remove", cond, c("wdremove", "m"), wd,
                {"action": "remove", "id": wid})
            wid = dog(c("wdsupersede", "m"), once=True)
            run("watchdogs.supersede", "watchdogs.supersede", cond, c("wdsupersede", "m"), wd,
                {"action": "supersede", "id": wid, "reason": "obsolete"})
            # an audience request climbs the chain: it mails the requester's superior
            run("audiences.request", "audiences.request", cond, c("audreq", "k"),
                "orgtree_audience", {"action": "request", "target": c("audreq", "p"),
                                     "reason": "need"}, implied=(c("audreq", "m"),))
            aud_request(c("audfwd", "k"), c("audfwd", "p"))
            run("audiences.forward", "audiences.forward", cond, c("audfwd", "m"),
                "orgtree_audience", {"action": "forward", "from": c("audfwd", "k"),
                                     "target": c("audfwd", "p")})
            aud_request(c("audgrant", "k"), c("audgrant", "p"))
            run("audiences.grant", "audiences.grant", cond, c("audgrant", "p"), "orgtree_audience",
                {"action": "grant", "from": c("audgrant", "k")})
            aud_request(c("auddeny", "k"), c("auddeny", "p"))
            run("audiences.deny", "audiences.deny", cond, c("auddeny", "m"), "orgtree_audience",
                {"action": "deny", "from": c("auddeny", "k"), "target": c("auddeny", "p")})
            aud_request(c("audrevoke", "k"), c("audrevoke", "p"))
            door(c("audrevoke", "p"), "orgtree_audience",
                 {"action": "grant", "from": c("audrevoke", "k")})
            run("audiences.revoke", "audiences.revoke", cond, c("audrevoke", "p"),
                "orgtree_audience", {"action": "revoke", "grantee": c("audrevoke", "k")})
            # the operator routes (@user on the desktop token)
            aid, rev = ask(c("answer", "p"))
            route("asks.answer", "asks.answer", cond, "POST", f"/asks/{aid}/answer",
                  {"selected": ["yes"], "rev": rev}, implied=(c("answer", "p"),))
            aid, rev = ask(c("batch", "p"))
            route("asks.batch-resolve", "asks.batch-resolve", cond, "POST",
                  f"/nodes/{c('batch', 'p')}/batch", {"revs": {"ask": rev}, "answers": ["yes"]},
                  args={"node": c("batch", "p")})
            route("lifecycle.operator-scope", "lifecycle.operator-scope", cond, "POST",
                  f"/nodes/{c('opscope', 'k')}/scope", {"charter": "op charter"},
                  args={"node": c("opscope", "k")})
            wid = dog(c("wdop", "m"))
            route("watchdogs.operator-action", "watchdogs.operator-action", cond, "POST",
                  "/watchdogs", {"id": wid, "action": "pause"}, implied=(c("wdop", "m"),))
            aud_request(c("audop", "k"), c("audop", "p"))
            route("audiences.operator-action", "audiences.operator-action", cond, "POST",
                  "/audiences", {"action": "grant", "node": c("audop", "k"),
                                 "target": c("audop", "p")},
                  args={"node": c("audop", "k"), "target": c("audop", "p")})
            aud_request(c("audlist", "k"), c("audlist", "p"))
            door(c("audlist", "p"), "orgtree_audience",
                 {"action": "grant", "from": c("audlist", "k")})
            route("audiences.list", "audiences.list", cond, "GET", "/audiences")

        def w(cell: str, role: str) -> str:
            return f"rq-{cell}-warm-{role}"
        # a non-top-level ask and scope request are routed to the superior
        # (mailed, and it is driven once)
        run("asks.ask", "asks.ask:routed", "warm", w("routed", "k"), "orgtree_ask",
            {"question": "Proceed?"}, implied=(w("routed", "m"),))
        run("asks.request-scope", "asks.request-scope:routed", "warm", w("routed", "k"),
            "orgtree_request_scope", {"items": [{"kind": "dir", "path": "C:/x"}], "reason": "r"},
            implied=(w("routed", "m"),))
        # a top-level report presents to the user instead
        run("asks.submit-report", "asks.submit-report:top", "warm", w("reporttop", "p"),
            "orgtree_submit_report", {"title": "R", "body": "b"})
        run("asks.withdraw", "asks.withdraw:no-open-ask", "warm", w("noask", "p"),
            "orgtree_withdraw_ask", {})
        aid, rev = ask(w("dismiss", "p"))
        route("asks.answer", "asks.answer:dismiss", "warm", "POST", f"/asks/{aid}/answer",
              {"dismiss": True}, implied=(w("dismiss", "p"),))
        # an ancestor of the owner sees its descendants' dogs; a list by an
        # agent outside the chain sees none
        run("watchdogs.list", "watchdogs.list:ancestor", "warm", w("wdlist", "p"), wd,
            {"action": "list"})
        run("audiences.request", "audiences.request:already-reachable", "warm", w("ref", "k"),
            "orgtree_audience", {"action": "request", "target": w("ref", "m")})
        # keyed: a keyed watchdog list files a receipt (legacy), and its replay
        ep = str(self.client.post(
            "/api/agent", json=self.agent_body(s, w("keyed", "m"), opreceipts.OP_EPOCH, {}),
            headers={"X-Orgtree-Agent-Token": self.tokens[(s, w("keyed", "m"))]}).json()["epoch"])
        dog(w("keyed", "m"))
        key = opreceipts.mint_key()
        for variant, refusal in (("watchdogs.list:keyed-fresh", None),
                                 ("watchdogs.list:keyed-replay",
                                  "keyed replay (answered from the receipt, no effect)")):
            run("watchdogs.list", variant, "warm", w("keyed", "m"), wd, {"action": "list"},
                key=key, epoch=ep, refusal=refusal)

        def r(role: str) -> str:
            return f"rq-ref-warm-{role}"
        refdog = dog(r("m"))
        for contract, variant, actor, tool, args, refusal in (
                ("asks.ask", "refusal:ask-no-question", r("p"), "orgtree_ask", {"question": ""},
                 "422 a question is required"),
                ("asks.request-scope", "refusal:scope-no-items", r("p"), "orgtree_request_scope",
                 {"items": [], "reason": "r"}, "422 items must be a non-empty list"),
                ("asks.present", "refusal:present-not-top-level", r("k"), "orgtree_present",
                 {"title": "P", "body": "b"}, "422 presenting needs a direct user audience"),
                ("watchdogs.create", "refusal:wd-command-without-bash", r("m"), wd,
                 {**self.RQ_DOG, "name": "x", "kind": "command", "target": "echo hi"},
                 "422 it needs the bash you do not hold"),
                ("watchdogs.create", "refusal:wd-target-outside-folder", r("m"), wd,
                 {**self.RQ_DOG, "name": "x", "target": "C:/Windows/win.ini"},
                 "422 only files in your working folder"),
                ("watchdogs.create", "refusal:wd-unknown-kind", r("m"), wd,
                 {**self.RQ_DOG, "name": "x", "kind": "nope"}, "422 kind must be one of"),
                ("watchdogs.pause", "refusal:wd-pause-no-authority", r("s"), wd,
                 {"action": "pause", "id": refdog}, "422 no authority over the owner"),
                ("watchdogs.supersede", "refusal:wd-supersede-not-one-shot", r("m"), wd,
                 {"action": "supersede", "id": refdog, "reason": "x"},
                 "422 only a one-shot watchdog can be superseded"),
                ("audiences.request", "refusal:aud-request-off-chain", r("k"), "orgtree_audience",
                 {"action": "request", "target": r("s")},
                 "422 audience requests climb your own chain"),
                ("audiences.request", "refusal:aud-bad-action", r("p"), "orgtree_audience",
                 {"action": "nope"}, "422 action must be request|forward|grant|deny|revoke")):
            run(contract, variant, "warm", actor, tool, args, refusal=refusal)
        for contract, variant, method, path, body, refusal in (
                ("asks.batch-resolve", "refusal:batch-none-open", "POST",
                 f"/nodes/{r('p')}/batch", {"revs": {}}, "422 no open request batch"),
                ("watchdogs.operator-action", "refusal:wd-op-unknown-id", "POST", "/watchdogs",
                 {"id": "nope", "action": "pause"}, "422 no watchdog 'nope'"),
                ("audiences.operator-action", "refusal:aud-op-bad-action", "POST", "/audiences",
                 {"action": "nope", "node": r("k")}, "422 action must be grant|deny|revoke"),
                ("lifecycle.operator-scope", "refusal:op-scope-bad-visibility", "POST",
                 f"/nodes/{r('k')}/scope", {"org_visibility": "bogus"},
                 "422 org_visibility must be one of")):
            route(contract, variant, "warm", method, path, body, refusal=refusal)
        aid, rev = ask(r("p"))
        route("asks.answer", "refusal:answer-stale-rev", "warm", "POST", f"/asks/{aid}/answer",
              {"selected": ["yes"], "rev": rev + 98}, refusal="422 the card changed after it rendered")
        route("asks.batch-resolve", "refusal:batch-stale-rev", "warm", "POST",
              f"/nodes/{r('p')}/batch", {"revs": {"ask": rev + 98}, "answers": ["yes"]},
              refusal="422 a request was appended or amended")
        route("audiences.list", "refusal:aud-list-agent-token", "warm", "GET", "/audiences",
              headers={"X-Orgtree-Agent-Token": self.tokens[(s, r("p"))]},
              refusal="401 an agent credential is refused here")

        # agent-level locality control: a watchdog pause whose closing tree
        # broadcast (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            spies["hub_changed"] += 1
            with store.write_org(s) as o:
                o.post_mail("rq-ref-warm-p", "rq-third", "p02 control: mail to a third agent")
                store.save_org(o)
        wid = dog(w("ctl", "m"))
        run("watchdogs.pause", "control:requests-third-agent", "warm", w("ctl", "m"), wd,
            {"action": "pause", "id": wid}, refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

    # -- P01 F2: run control, per product profile -------------------------------
    CT_CELLS = ("interrupt", "unstick", "continue", "halt", "unhalt", "wake", "restart",
                "prime", "opinterrupt", "opunstick", "opcontinue", "ophalt", "opunhalt",
                "opprocess", "remote", "steer", "kiosk")
    #: warm-only cells: variants, the refusals and the control
    CT_EXTRA = ("unsticknoop", "batch", "ref", "ctl")
    CT_FROZEN = {"limit": "weekly", "at": "2026-01-01T00:00:00Z", "reason": "fixture"}

    def build_control(self) -> None:
        """tests/test_state_control_boundary.py's shape, one cell per row
        (distinctive `ct-*` ids): `ct-<cell>-<cond>-<role>`, p TOP-LEVEL (the
        P01 fixture's top), m p's report (mid), k m's report (leaf), s m's
        peer (sib); ct-third under the ref cell's head, never named. The
        unstick cells' managers are frozen and the unhalt cells' managers are
        halted before the workload. The killswitch latches a whole org, so it
        runs on two orgs of its own (`ks-*`)."""
        store, ledger = self.m["store"], self.m["ledger"]
        user, both = ledger.USER, ("cold", "warm")
        org = store.create_org("p02-contacts-control")
        self.ctslug = str(org.d["slug"])
        for cell in [f"{c}-{cond}" for c in self.CT_CELLS for cond in both] + [
                f"{c}-warm" for c in self.CT_EXTRA]:
            p, m = f"ct-{cell}-p", f"ct-{cell}-m"
            org.hire(user, None, "haiku", 10, p, add_dirs=[], tools={}, charter="fixture")
            org.hire(p, p, "haiku", 0, m, **self.SCOPE)
            org.hire(p, m, "haiku", 0, f"ct-{cell}-k", **self.SCOPE)
            org.hire(p, p, "haiku", 0, f"ct-{cell}-s", **self.SCOPE)
        org.hire("ct-ref-warm-p", "ct-ref-warm-p", "haiku", 0, "ct-third", **self.SCOPE)
        for cond in both:
            for cell in ("unstick", "opunstick"):
                org.node(f"ct-{cell}-{cond}-m")["frozen"] = dict(self.CT_FROZEN)
        org.d["mail"], org.d["audiences"] = {}, []
        store.save_org(org)
        for nid in org.nodes:
            if nid != "ct-third":
                self.tokens[(self.ctslug, nid)] = self.m["agentauth"].child_env(
                    self.ctslug, nid)["ORGTREE_AGENT_TOKEN"]
        self.ks: dict[str, str] = {}
        for cond in both:
            org = store.create_org(f"p02-contacts-killswitch-{cond}")
            self.ks[cond] = str(org.d["slug"])
            org.hire(user, None, "haiku", 6, f"ks-{cond}-top", add_dirs=[], tools={},
                     charter="fixture")
            org.hire(f"ks-{cond}-top", f"ks-{cond}-top", "haiku", 0, f"ks-{cond}-kid",
                     **self.SCOPE)
            org.d["mail"], org.d["audiences"] = {}, []
            store.save_org(org)
        # the non-desktop kiosk handler configures a kiosk org (a creation-
        # time type): one per condition, disabled, as P01's fixture shapes it
        self.kx: dict[str, str] = {}
        for cond in both:
            org = store.create_org(f"p02-contacts-kiosk-{cond}")
            self.kx[cond] = str(org.d["slug"])
            org.hire(user, None, "haiku", 2, f"kx-{cond}-top", add_dirs=[], tools={},
                     charter="fixture")
            org.d["kiosk"] = {"enabled": False, "credits": 0, "spend_limit": 0.0,
                              "storage_limit_mb": 0}
            org.d["mail"], org.d["audiences"] = {}, []
            store.save_org(org)

    def control(self) -> None:
        """Every F2 contract, cold and warm, in the desktop-managed profile
        (the app's own: engine.launch sets ORGTREE_DESKTOP_MANAGED=1), and in
        the non-desktop profile (the flag cleared for the call) where
        desktop_policy changes the behaviour: self-restart and prime-restart
        (refused on the desktop, served otherwise) and the kiosk route
        (stripped from the desktop app). EVERY process effect is a counting
        spy (`spies`), as in the P01 fixture: halt's process cut, turn
        interrupts, the killswitch sweep, the warm-pool process control,
        remote control, the restart launch, the prime arm/cancel, continue-
        on's live provider read, the storage check. The probe never halts,
        restarts or kills a real process; the guards refuse any process
        start in any case."""
        from orgtree import halt
        s, api, supervisor = self.ctslug, self.m["api"], self.m["supervisor"]
        spies: collections.Counter = collections.Counter()

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return copy.deepcopy(answer)
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)
        family = [(api, "hub_changed", hub_counted),
                  (supervisor, "notify", spy("notify")),
                  (supervisor, "launch_self_restart", spy("launch_self_restart",
                                                          {"launched": "spy"})),
                  (supervisor, "arm_prime_restart", spy("arm_prime_restart", {"armed": True})),
                  (supervisor, "cancel_prime_restart", spy("cancel_prime_restart",
                                                           {"cancelled": True})),
                  (supervisor, "primed_restart", lambda *_a, **_k: None),
                  (supervisor, "remote_control_start", spy("remote_control_start",
                                                           {"started": True})),
                  (supervisor, "remote_control_stop", spy("remote_control_stop",
                                                          {"stopped": True})),
                  (supervisor, "interrupt_turn", spy("interrupt_turn",
                                                     {"interrupted": False, "reason": "spy"})),
                  (supervisor, "interrupt_all", spy("interrupt_all", {"interrupted": []})),
                  (supervisor, "maybe_storage_check", spy("maybe_storage_check")),
                  (api, "_continue_on_account", spy("continue_on_account", {"switched": True})),
                  (api.warmpool, "process_control", spy("process_control", {"process": "spy"})),
                  (halt, "_cut", spy("halt_cut"))]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._control_rows(s, api, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _control_rows(self, s: str, api: Any, spies: collections.Counter) -> None:
        store = self.m["store"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        nd = {"ORGTREE_DESKTOP_MANAGED": None}      # the non-desktop profile, for the call

        def counted(row_of: Callable[[], dict[str, Any]]) -> dict[str, Any]:
            n0 = dict(spies)
            row = row_of()
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        def run(contract: str, variant: str, condition: str, actor: str, tool: str,
                args: dict[str, Any], **kw: Any) -> dict[str, Any]:
            return counted(lambda: self.run(contract, variant, condition, s, actor, tool,
                                            args, **kw))

        def route(contract: str, variant: str, condition: str, method: str, path: str,
                  body: Any = None, args: "dict[str, Any] | None" = None, headers: Any = op,
                  slug: str = s, **kw: Any) -> dict[str, Any]:
            def call() -> tuple[int, Any]:
                resp = self.client.request(method, f"/api/orgs/{slug}{path}", json=body,
                                           headers=headers)
                try:
                    return resp.status_code, resp.json()
                except ValueError:
                    return resp.status_code, None
            return counted(lambda: self.run(contract, variant, condition, slug, user,
                                            f"{method} {contract}", args or {}, call=call, **kw))

        def halted(m: str) -> None:
            """Setup: the operator halts `m` (outside any row)."""
            r = self.client.post(f"/api/orgs/{s}/nodes/{m}/halt", headers=op)
            if r.status_code != 200:
                raise RuntimeError(f"setup halt answered {r.status_code}: {r.text[:200]}")

        desktop = {"orgtree_self_restart": "422 desktop-managed V2 renamed the tool",
                   "orgtree_prime_restart": "422 desktop-managed V2 renamed the tool"}
        for cond in both:
            def c(cell: str, role: str) -> str:
                return f"ct-{cell}-{cond}-{role}"
            run("control.interrupt", "control.interrupt", cond, c("interrupt", "p"),
                "orgtree_interrupt", {"node": c("interrupt", "m")})
            run("control.unstick", "control.unstick", cond, c("unstick", "p"), "orgtree_unstick",
                {"node": c("unstick", "m")})
            run("control.continue-on", "control.continue-on", cond, c("continue", "p"),
                "orgtree_continue_on", {"node": c("continue", "m"), "account": "acct-x"})
            run("control.halt", "control.halt", cond, c("halt", "p"), "orgtree_halt",
                {"node": c("halt", "m")})
            halted(c("unhalt", "m"))
            run("control.unhalt", "control.unhalt", cond, c("unhalt", "p"), "orgtree_unhalt",
                {"node": c("unhalt", "m")})
            for action in ("arm", "status", "cancel"):
                run(f"control.restart-wake-{action}", f"control.restart-wake-{action}", cond,
                    c("wake", "m"), "orgtree_restart_wake",
                    {"action": action, **({"reason": "r"} if action == "arm" else {})})
            # desktop profile: the standard restart tools are refused (renamed)
            run("control.self-restart", "control.self-restart:desktop", cond, c("restart", "p"),
                "orgtree_self_restart", {}, refusal=desktop["orgtree_self_restart"])
            run("control.self-restart", "control.self-restart:non-desktop", cond,
                c("restart", "p"), "orgtree_self_restart", {}, env=nd)
            for action in ("arm", "status", "cancel"):
                contract = f"control.prime-restart-{action}"
                run(contract, f"{contract}:desktop", cond, c("prime", "p"), "orgtree_prime_restart",
                    {"action": action}, refusal=desktop["orgtree_prime_restart"])
                run(contract, f"{contract}:non-desktop", cond, c("prime", "p"),
                    "orgtree_prime_restart",
                    {"action": action, **({"reason": "r"} if action == "arm" else {})}, env=nd)
            # the operator routes (@user on the desktop token)
            base = "/nodes/{}"
            route("control.op-interrupt", "control.op-interrupt", cond, "POST",
                  base.format(c("opinterrupt", "m")) + "/interrupt",
                  args={"node": c("opinterrupt", "m")})
            route("control.op-unstick", "control.op-unstick", cond, "POST",
                  base.format(c("opunstick", "m")) + "/unstick",
                  args={"node": c("opunstick", "m")})
            route("control.op-continue-on", "control.op-continue-on", cond, "POST",
                  base.format(c("opcontinue", "m")) + "/continue-on", {"account": "acct-x"},
                  args={"node": c("opcontinue", "m")})
            route("control.op-halt", "control.op-halt", cond, "POST",
                  base.format(c("ophalt", "m")) + "/halt", args={"node": c("ophalt", "m")})
            halted(c("opunhalt", "m"))
            route("control.op-unhalt", "control.op-unhalt", cond, "POST",
                  base.format(c("opunhalt", "m")) + "/unhalt", args={"node": c("opunhalt", "m")})
            route("control.op-process", "control.op-process", cond, "POST",
                  base.format(c("opprocess", "m")) + "/process", {"action": "stop"},
                  args={"node": c("opprocess", "m")})
            route("control.remote-control", "control.remote-control", cond, "POST",
                  base.format(c("remote", "m")) + "/remote-control", {"action": "start"},
                  args={"node": c("remote", "m")})
            route("control.steer-claim", "control.steer-claim", cond, "POST",
                  base.format(c("steer", "m")) + "/steer", {}, args={"node": c("steer", "m")})
            route("control.steer-ack", "control.steer-ack", cond, "POST",
                  base.format(c("steer", "m")) + "/steer/ack",
                  {"delivery_id": "d", "tool_use_id": "t"}, args={"node": c("steer", "m")})
            route("control.steer-state", "control.steer-state", cond, "GET",
                  base.format(c("steer", "m")) + "/steer-state", args={"node": c("steer", "m")})
            # the kiosk route is stripped from the desktop-built app
            # (desktop_policy drops every route whose path has /kiosk); the
            # non-desktop handler is not mounted here, so it has no row.
            # Observed 404 (P01 pins 405)
            route("control.kiosk", "control.kiosk:desktop-stripped", cond, "POST", "/kiosk",
                  {"enabled": True}, refusal="the route is stripped in the desktop profile")
            # the killswitch latches the whole org: its own org per condition
            ks = self.ks[cond]
            if cond == "warm":
                store.load_org(ks)
            kids = tuple(sorted(_NODES[ks]))
            route("control.killswitch", "control.killswitch", cond, "POST", "/killswitch",
                  slug=ks, implied=kids)
            if cond == "warm":
                route("control.resume", "refusal:resume-while-latched", cond, "POST", "/resume",
                      slug=ks, refusal="409 release the killswitch before resuming")
            route("control.killswitch-release", "control.killswitch-release", cond, "POST",
                  "/killswitch/release", slug=ks, implied=kids)
            route("control.resume", "control.resume", cond, "POST", "/resume", slug=ks,
                  implied=kids)

        def w(cell: str, role: str) -> str:
            return f"ct-{cell}-warm-{role}"
        # the NON-DESKTOP kiosk handler: desktop_policy.install_routes strips
        # every /kiosk route from the desktop-built app, so the real handler
        # (api.org_kiosk) is mounted at its own path for these rows only, as a
        # non-desktop build mounts it, and the desktop flag is cleared for the
        # call. Through the mounted route the call is a census-recorded,
        # loss-accounted attempt like every other row; the route is removed
        # afterwards (the desktop rows above ran without it).
        kiosk_route = "/api/orgs/{slug}/kiosk"
        api.app.add_api_route(kiosk_route, api.org_kiosk, methods=["POST"])
        mounted = api.app.router.routes[-1]
        try:
            for cond in both:
                kx = self.kx[cond]
                if cond == "warm":
                    store.load_org(kx)
                route("control.kiosk", "control.kiosk:non-desktop", cond, "POST", "/kiosk",
                      {"enabled": True}, slug=kx, env=nd)
            route("control.kiosk", "refusal:kiosk-not-a-kiosk-org", "warm", "POST", "/kiosk",
                  {"enabled": True}, env=nd,
                  refusal="422 non-desktop: not a kiosk org (a creation-time type)")
        finally:
            api.app.router.routes.remove(mounted)
        run("control.unstick", "control.unstick:no-op", "warm", w("unsticknoop", "p"),
            "orgtree_unstick", {"node": w("unsticknoop", "m")})
        run("control.halt", "control.halt:batch", "warm", w("batch", "p"), "orgtree_halt",
            {"nodes": [w("batch", "m"), w("batch", "s")]},
            implied=(w("batch", "m"), w("batch", "s")))
        # the op-halt cell's manager is halted now: interrupt it, then unhalt
        # the op-interrupt cell's manager, which is not halted (a no-op)
        route("control.op-interrupt", "control.op-interrupt:halted", "warm", "POST",
              f"/nodes/{w('ophalt', 'm')}/interrupt", args={"node": w("ophalt", "m")})
        route("control.op-unhalt", "control.op-unhalt:not-halted", "warm", "POST",
              f"/nodes/{w('opinterrupt', 'm')}/unhalt", args={"node": w("opinterrupt", "m")})
        run("control.restart-wake-arm", "control.restart-wake-arm:subordinate", "warm",
            w("wake", "m"), "orgtree_restart_wake", {"action": "arm", "target": w("wake", "k")})
        route("control.killswitch-release", "control.killswitch-release:not-latched", "warm",
              "POST", "/killswitch/release", slug=self.ks["warm"],
              implied=tuple(sorted(_NODES[self.ks["warm"]])))

        def r(role: str) -> str:
            return f"ct-ref-warm-{role}"
        for contract, variant, actor, tool, args, env, refusal in (
                ("control.interrupt", "refusal:interrupt-self", r("m"), "orgtree_interrupt",
                 {"node": r("m")}, None, "422 no authority over itself"),
                ("control.interrupt", "refusal:interrupt-up", r("m"), "orgtree_interrupt",
                 {"node": r("p")}, None, "422 no authority over its superior"),
                ("control.unstick", "refusal:unstick-up", r("m"), "orgtree_unstick",
                 {"node": r("p")}, None, "422 no authority over its superior"),
                ("control.continue-on", "refusal:continue-own-account", r("m"),
                 "orgtree_continue_on", {"node": r("m"), "account": "a"}, None,
                 "403 you cannot choose your own account"),
                ("control.continue-on", "refusal:continue-up", r("m"), "orgtree_continue_on",
                 {"node": r("p"), "account": "a"}, None, "422 no authority over its superior"),
                ("control.halt", "refusal:halt-up", r("m"), "orgtree_halt", {"node": r("p")},
                 None, "422 no authority over its superior"),
                ("control.halt", "refusal:halt-batch-partly-outside", r("m"), "orgtree_halt",
                 {"nodes": [r("k"), r("p")]}, None,
                 "422 one target outside the subtree refuses the whole batch; nothing is cut"),
                ("control.self-restart", "refusal:self-restart-not-top-level", r("k"),
                 "orgtree_self_restart", {}, nd, "422 non-desktop: a self-restart needs top level"),
                ("control.prime-restart-arm", "refusal:prime-arm-not-top-level", r("k"),
                 "orgtree_prime_restart", {"action": "arm"}, nd,
                 "422 non-desktop: a primed restart needs top level"),
                ("control.prime-restart-arm", "refusal:prime-bad-action", r("p"),
                 "orgtree_prime_restart", {"action": "nope"}, nd,
                 "422 non-desktop: action must be arm|cancel|status"),
                ("control.restart-wake-arm", "refusal:wake-target-up", r("m"),
                 "orgtree_restart_wake", {"action": "arm", "target": r("p")}, None,
                 "403 only for yourself or your subordinates"),
                ("control.restart-wake-arm", "refusal:wake-mode-every", r("m"),
                 "orgtree_restart_wake", {"action": "arm", "mode": "every"}, None,
                 "422 only one-shot restart wakes are supported"),
                ("control.restart-wake-arm", "refusal:wake-bad-action", r("m"),
                 "orgtree_restart_wake", {"action": "nope"}, None,
                 "422 action must be arm|cancel|status")):
            run(contract, variant, "warm", actor, tool, args, env=env, refusal=refusal)
        for contract, variant, path, body, headers, refusal in (
                ("control.op-process", "refusal:process-unknown-node", "/nodes/nobody/process",
                 {"action": "stop"}, op, "404 no such node"),
                ("control.remote-control", "refusal:remote-bad-action",
                 f"/nodes/{r('m')}/remote-control", {"action": "nope"}, op,
                 "422 action must be start or stop"),
                ("control.killswitch", "refusal:route-agent-token", "/killswitch", None,
                 {"X-Orgtree-Agent-Token": self.tokens[(s, r("p"))]},
                 "401 an agent credential is refused here")):
            route(contract, variant, "warm", "POST", path, body, headers=headers, refusal=refusal)

        # agent-level locality control: an interrupt whose closing tree
        # broadcast (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            spies["hub_changed"] += 1
            with store.write_org(s) as o:
                o.post_mail("ct-ref-warm-p", "ct-third", "p02 control: mail to a third agent")
                store.save_org(o)
        run("control.interrupt", "control:control-third-agent", "warm", w("ctl", "p"),
            "orgtree_interrupt", {"node": w("ctl", "m")},
            refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

    # -- P01 F1b: the operator ops door's remaining operations and its preview ---
    VX_CELLS = ("rename", "retire", "rescind", "cc", "rehire", "dissolve", "delete", "switch",
                "promote", "demote", "move", "reseed", "revoke", "preview")
    #: warm-only cells: the waiting-mail rehire, the refusals, an archived seat
    #: for the cheap-compact refusal, and the control
    VX_EXTRA = ("rehmail", "ref", "refarch", "ctl")
    VX_DIR = "C:/fixture-dir"

    def build_opvariants(self) -> None:
        """tests/test_state_operator_variants_boundary.py's shape, one cell per
        row (distinctive `vx-*` ids): `vx-<cell>-<cond>-<role>`, p the cell's
        head under vx-top (the P01 fixture's top), m p's report (mid), k m's
        report (leaf), s m's peer (sib). vx-top2 is top-level; vx-third sits
        under vx-top, never named. Pre-states: the rehire cells' leaves are
        archived (one with waiting mail), the reseed cells' managers are
        unrecoverable, the revoke cells' manager and leaf hold the fixture
        directory, and refarch's leaf is archived."""
        store, ledger = self.m["store"], self.m["ledger"]
        user, both = ledger.USER, ("cold", "warm")
        org = store.create_org("p02-contacts-opvariants")
        self.vxslug = str(org.d["slug"])
        org.hire(user, None, "haiku", 400, "vx-top", add_dirs=[], tools={}, charter="fixture")
        org.hire(user, None, "haiku", 5, "vx-top2", add_dirs=[], tools={}, charter="fixture")
        org.hire("vx-top", "vx-top", "haiku", 0, "vx-third", **self.SCOPE)
        for cell in [f"{c}-{cond}" for c in self.VX_CELLS for cond in both] + [
                f"{c}-warm" for c in self.VX_EXTRA]:
            p, m = f"vx-{cell}-p", f"vx-{cell}-m"
            org.hire("vx-top", "vx-top", "haiku", 6, p, **self.SCOPE)
            org.hire("vx-top", p, "haiku", 0, m, **self.SCOPE)
            org.hire("vx-top", m, "haiku", 0, f"vx-{cell}-k", **self.SCOPE)
            org.hire("vx-top", p, "haiku", 0, f"vx-{cell}-s", **self.SCOPE)
        for cell in ("rehire-cold", "rehire-warm", "rehmail-warm", "refarch-warm"):
            org.retire(f"vx-{cell}-m", f"vx-{cell}-k")
        org.post_mail("vx-rehmail-warm-m", "vx-rehmail-warm-k", "waiting work")
        for cond in both:
            org.node(f"vx-reseed-{cond}-m")["state"] = "unrecoverable"
            for role in ("m", "k"):
                org.node(f"vx-revoke-{cond}-{role}")["scope"]["add_dirs"] = [
                    {"path": self.VX_DIR, "mode": "rw"}]
        org.d["mail"] = {"vx-rehmail-warm-k": org.d["mail"].get("vx-rehmail-warm-k", [])}
        org.d["audiences"] = []
        store.save_org(org)
        self.tokens[(self.vxslug, "vx-top")] = self.m["agentauth"].child_env(
            self.vxslug, "vx-top")["ORGTREE_AGENT_TOKEN"]

    def op_variants(self) -> None:
        """Every F1b operation on POST /api/orgs/{slug}/ops, cold and warm, as
        the operator (@user) on the desktop token, plus the preview's
        variants, a waiting-mail rehire, a no-op reseed, refusals (agent
        actors named in the body among them) and a locality control. As in
        the P01 fixture, the provider gate, the pre-archive interrupt, the
        remote reap, the transcript copy, supervisor.forget and
        supervisor.notify are counting spies (`spies`); hub_changed is real
        and counted. `implied` is P01's pinned `told` per cell role, plus a
        new name, a bearer, the subtree an operation archives or rescopes, and,
        for a promotion to the top level, every live top-level seat."""
        s, store, api = self.vxslug, self.m["store"], self.m["api"]
        supervisor = self.m["supervisor"]
        both = ("cold", "warm")
        _NODES[s] |= {f"vx-rename-{c}-k2" for c in both} | {f"vx-cc-{c}-m@0" for c in both}
        spies: collections.Counter = collections.Counter()

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return answer
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)
        family = [(api, "provider_hire_gate", lambda *_a, **_k: None),
                  (api, "hub_changed", hub_counted),
                  (supervisor, "interrupt_before_archive", spy("interrupt_before_archive", [])),
                  (supervisor, "remote_reap", spy("remote_reap")),
                  (supervisor, "export_predecessor_transcript",
                   spy("export_predecessor_transcript")),
                  (supervisor, "forget", spy("forget")),
                  (supervisor, "notify", spy("notify"))]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._op_variant_rows(s, store, api, both, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _op_variant_rows(self, s: str, store: Any, api: Any, both: tuple[str, str],
                         spies: collections.Counter) -> None:
        user, op = self.m["ledger"].USER, self.OPERATOR

        def run(contract: str, variant: str, condition: str, body: dict[str, Any],
                actor: str = user, headers: Any = op, **kw: Any) -> dict[str, Any]:
            args = {k: v for k, v in body.items() if k in ("node", "new_parent", "name")}
            n0 = dict(spies)
            row = self.run(contract, variant, condition, s, actor, f"POST {contract}", args,
                           call=self.http(self.client, f"/api/orgs/{s}/ops", headers,
                                          {**body, "actor": actor}), **kw)
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        def top_level() -> set[str]:
            org = store.load_org(s)
            return {k for k, v in org.nodes.items()
                    if v.get("parent") is None and v.get("state") != "archived"}

        def chain(nid: str) -> set[str]:
            """Every ancestor of `nid`: a promotion to the top level releases
            the seat's credits from the old parent up to the lowest common
            ancestor, @user (ledger._move's LCA credit path), writing each."""
            org, up = store.load_org(s), set()
            p = org.node(nid)["parent"]
            while p:
                up.add(str(p))
                p = org.node(p)["parent"]
            return up

        for cond in both:
            def c(cell: str, role: str) -> str:
                return f"vx-{cell}-{cond}-{role}"
            run("operator.rename", "operator.rename", cond,
                {"op": "rename", "node": c("rename", "k"), "name": c("rename", "k2")},
                implied=(c("rename", "k2"),))
            run("operator.retire", "operator.retire", cond,
                {"op": "retire", "node": c("retire", "k")}, implied=(c("retire", "m"),))
            run("operator.rescind", "operator.rescind", cond,
                {"op": "rescind", "node": c("rescind", "k")}, implied=(c("rescind", "m"),))
            run("operator.cheap-compact", "operator.cheap-compact", cond,
                {"op": "cheap_compact", "node": c("cc", "m")},
                implied=(c("cc", "m") + "@0", c("cc", "p")))
            run("operator.rehire", "operator.rehire", cond,
                {"op": "rehire", "node": c("rehire", "k")}, implied=(c("rehire", "m"),))
            run("operator.dissolve", "operator.dissolve", cond,
                {"op": "dissolve", "node": c("dissolve", "m")},
                implied=(c("dissolve", "k"), c("dissolve", "p"), c("dissolve", "s")))
            run("operator.delete", "operator.delete", cond,
                {"op": "delete", "node": c("delete", "k")}, implied=(c("delete", "m"),))
            run("operator.switch-model", "operator.switch-model", cond,
                {"op": "switch_model", "node": c("switch", "k"), "tier": "sonnet"},
                implied=(c("switch", "m"),))
            run("operator.promote", "operator.promote", cond,
                {"op": "promote", "node": c("promote", "k"), "new_parent": None},
                implied=tuple(sorted(top_level() | chain(c("promote", "k")))))
            run("operator.demote", "operator.demote", cond,
                {"op": "demote", "node": c("demote", "s"), "new_parent": c("demote", "m")},
                implied=(c("demote", "k"), c("demote", "p")))
            run("operator.move", "operator.move", cond,
                {"op": "move", "node": c("move", "k"), "new_parent": c("move", "s")},
                implied=(c("move", "m"),))
            run("operator.reseed", "operator.reseed", cond,
                {"op": "reseed", "node": c("reseed", "m")}, implied=(c("reseed", "p"),))
            run("operator.revoke-dir", "operator.revoke-dir", cond,
                {"op": "revoke_dir", "node": c("revoke", "m"), "dir": self.VX_DIR},
                implied=(c("revoke", "k"),))
            run("operator.preview", "operator.preview", cond,
                {"op": "retire", "node": c("preview", "m"), "preview": True},
                implied=(c("preview", "k"),))

        def w(cell: str, role: str) -> str:
            return f"vx-{cell}-warm-{role}"

        def r(role: str) -> str:
            return f"vx-ref-warm-{role}"
        for variant, body, actor in (
                ("operator.preview:delete", {"op": "delete", "node": r("k")}, user),
                ("operator.preview:reallocate", {"op": "reallocate", "node": r("m"), "delta": 1},
                 user),
                ("operator.preview:switch-model",
                 {"op": "switch_model", "node": r("k"), "tier": "sonnet"}, user),
                ("operator.preview:retire-agent-actor", {"op": "retire", "node": r("k")},
                 r("m"))):
            run("operator.preview", variant, "warm", {**body, "preview": True}, actor=actor)
        run("operator.rehire", "operator.rehire:mail", "warm",
            {"op": "rehire", "node": w("rehmail", "k")}, implied=(w("rehmail", "m"),))
        # a live seat: nothing to re-seed, still a broadcast
        run("operator.reseed", "operator.reseed:no-op", "warm", {"op": "reseed", "node": r("m")})
        agent = {"X-Orgtree-Agent-Token": self.tokens[(s, "vx-top")]}
        for contract, variant, body, actor, headers, refusal in (
                ("operator.rename", "refusal:op-rename-no-name", {"op": "rename", "node": r("k")},
                 user, op, "422 rename needs node and name"),
                ("operator.rename", "refusal:op-rename-taken",
                 {"op": "rename", "node": r("k"), "name": r("s")}, user, op,
                 "422 the name is already taken"),
                ("operator.rename", "refusal:op-rename-no-authority",
                 {"op": "rename", "node": r("p"), "name": "x"}, r("m"), op,
                 "422 the named actor has no authority over its superior"),
                ("operator.delete", "refusal:op-delete-agent-actor",
                 {"op": "delete", "node": r("k")}, r("m"), op, "422 only the user may delete agents"),
                ("operator.switch-model", "refusal:op-switch-no-tier",
                 {"op": "switch_model", "node": r("k")}, user, op, "422 switch_model needs tier"),
                ("operator.promote", "refusal:op-promote-agent-actor",
                 {"op": "promote", "node": r("k"), "new_parent": None}, r("p"), op,
                 "422 only the user promotes agents to top level"),
                ("operator.demote", "refusal:op-demote-no-parent", {"op": "demote", "node": r("s")},
                 user, op, "422 demote needs new_parent"),
                ("operator.revoke-dir", "refusal:op-revoke-no-dir",
                 {"op": "revoke_dir", "node": r("m")}, user, op, "422 revoke_dir needs dir"),
                ("operator.preview", "refusal:op-unknown-op", {"op": "frobnicate", "node": r("m")},
                 user, op, "422 unknown op"),
                ("operator.rename", "refusal:op-preview-rename",
                 {"op": "rename", "node": r("k"), "name": "x", "preview": True}, user, op,
                 "422 preview does not support rename"),
                ("operator.rehire", "refusal:op-preview-rehire",
                 {"op": "rehire", "node": r("k"), "preview": True}, user, op,
                 "422 preview does not support rehire"),
                ("operator.retire", "refusal:op-agent-token", {"op": "retire", "node": r("k")},
                 user, agent, "401 an agent credential is refused here"),
                ("operator.cheap-compact", "refusal:op-cheap-compact-archived",
                 {"op": "cheap_compact", "node": "vx-refarch-warm-k"}, user, op,
                 "422 cheap compact replaces a LIVE agent's session"),
                # recorded legacy: refused AFTER the pre-archive interrupt
                ("operator.rescind", "refusal:op-rescind-agent-actor",
                 {"op": "rescind", "node": r("k")}, r("m"), op,
                 "422 only the user may rescind (legacy: after the interrupt)"),
                ("operator.retire", "refusal:op-retire-self-with-reports",
                 {"op": "retire", "node": r("m")}, r("m"), op,
                 "422 live reports (legacy: after the interrupt)"),
                ("operator.retire", "refusal:op-retire-no-authority",
                 {"op": "retire", "node": r("m")}, r("k"), op,
                 "422 no authority (the pre-guard, before the interrupt)")):
            run(contract, variant, "warm", body, actor=actor, headers=headers, refusal=refusal)

        # agent-level locality control: a move whose closing tree broadcast
        # (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            spies["hub_changed"] += 1
            with store.write_org(s) as o:
                o.post_mail("vx-top", "vx-third", "p02 control: mail to a third agent")
                store.save_org(o)
        run("operator.move", "control:op-variants-third-agent", "warm",
            {"op": "move", "node": w("ctl", "k"), "new_parent": w("ctl", "s")},
            implied=(w("ctl", "m"),), refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

    # -- P01 F1: the org lifecycle and catalogue entry points -------------------
    #: one small team (a cell) per operation and condition, so every row acts
    #: on a fresh target whose peers are known: `lc-<cell>-<cond>-<role>`, p the
    #: cell's head under lc-top, m p's report, k m's report, s m's peer
    LC_CELLS = ("rename", "retool", "retire", "dissolve", "cc", "rehire", "move", "swap",
                "subj", "switch", "reorder", "compact", "repair")
    #: warm-only cells: variants, keyed calls, the refusals and the control
    LC_EXTRA = ("retself", "retkids", "rehname", "rehmail", "movekey", "keyren", "ref", "ctl")

    def build_lifecycle(self) -> None:
        """tests/test_state_lifecycle_boundary.py's shape, one cell per row
        (distinctive `lc-*` ids), under lc-top; lc-top2 top-level; lc-third
        under lc-top, never named (the third agent). The cells' heads hold a
        grant, so a seat cost is covered at the head. Pre-states: the rehire
        cells' reports are archived (one with waiting mail), the compact cells'
        managers have a conversation, and each repair cell has a rename that
        stranded a presented document under the old id. dissolve-all runs on
        two orgs of its own (it archives every seat)."""
        store, ledger = self.m["store"], self.m["ledger"]
        user, both = ledger.USER, ("cold", "warm")
        org = store.create_org("p02-contacts-lifecycle")
        self.lcslug = str(org.d["slug"])
        org.hire(user, None, "haiku", 400, "lc-top", add_dirs=[], tools={}, charter="fixture")
        org.hire(user, None, "haiku", 5, "lc-top2", add_dirs=[], tools={}, charter="fixture")
        org.hire("lc-top", "lc-top", "haiku", 0, "lc-third", **self.SCOPE)
        cells = [f"{c}-{cond}" for c in self.LC_CELLS for cond in both] + [
            f"{c}-warm" for c in self.LC_EXTRA]
        for cell in cells:
            p, m = f"lc-{cell}-p", f"lc-{cell}-m"
            org.hire("lc-top", "lc-top", "haiku", 6, p, **self.SCOPE)
            # a model switch's seat cost is drawn from the chain up to the
            # ACTOR (ledger._chain_acquire), so the switching manager holds it
            org.hire("lc-top", p, "haiku", 2 if cell.startswith("switch") else 0, m,
                     **self.SCOPE)
            org.hire("lc-top", m, "haiku", 0, f"lc-{cell}-k", **self.SCOPE)
            org.hire("lc-top", p, "haiku", 0, f"lc-{cell}-s", **self.SCOPE)
        for cell in ("rehire-cold", "rehire-warm", "rehname-warm", "rehmail-warm"):
            org.retire(f"lc-{cell}-m", f"lc-{cell}-k")
        org.post_mail("lc-rehmail-warm-m", "lc-rehmail-warm-k", "waiting work")
        for cond in both:
            org.node(f"lc-compact-{cond}-m")["occupancy"] = {"used": 1000, "window": 200000}
        self.lc_repair_at: dict[str, str] = {}
        for cond in both:
            k = f"lc-repair-{cond}-k"
            if self.lc_repair_at:
                time.sleep(1.05)          # each rename event needs its own `at`
            org.rename(f"lc-repair-{cond}-m", k, k + "2")
            self.lc_repair_at[cond] = str([
                e for e in org.d["events"] if e.get("op") == "rename"
                and (e.get("detail") or {}).get("node") == k][-1]["at"])
            org.d.setdefault("documents", []).append({"id": f"lc-repair-{cond}-doc", "node": k})
        org.d["mail"] = {"lc-rehmail-warm-k": org.d["mail"].get("lc-rehmail-warm-k", [])}
        org.d["audiences"] = []
        store.save_org(org)
        for nid, n in org.nodes.items():
            if n.get("state") == "live" and not nid.endswith(("-s", "lc-third")):
                self.tokens[(self.lcslug, nid)] = self.m["agentauth"].child_env(
                    self.lcslug, nid)["ORGTREE_AGENT_TOKEN"]
        self.lc_all: dict[str, str] = {}
        for cond in both:
            org = store.create_org(f"p02-contacts-lc-all-{cond}")
            self.lc_all[cond] = str(org.d["slug"])
            org.hire(user, None, "haiku", 6, f"da-{cond}-top", add_dirs=[], tools={},
                     charter="fixture")
            org.hire(f"da-{cond}-top", f"da-{cond}-top", "haiku", 0, f"da-{cond}-kid",
                     **self.SCOPE)
            org.hire(user, None, "haiku", 2, f"da-{cond}-top2", add_dirs=[], tools={},
                     charter="fixture")
            org.d["mail"], org.d["audiences"] = {}, []
            store.save_org(org)

    def lifecycle(self) -> None:
        """Every F1 contract, cold and warm: the ten lifecycle tools and the
        two catalogue reads on the agent door, the seven operator routes;
        variants, keyed calls, refusals and a locality control. As in the P01
        fixture, the provider gate, the pre-archive interrupt, the remote
        reap, the transcript copy, manual compaction, supervisor.notify, tier
        discovery and the mail hub roster are counting spies (each row carries
        `spies`, its calls); hub_changed is real and counted. `implied` names
        what each operation reaches without naming it in its arguments: a new
        name, a bearer, the subtree it archives and the agents it tells
        (P01's pinned `told`: a dissolved seat's peers, a move's old parent, a
        swap's reports, a subjugation's new parent and peer)."""
        s, store, api = self.lcslug, self.m["store"], self.m["api"]
        opreceipts, supervisor = self.m["opreceipts"], self.m["supervisor"]
        user, op, both = self.m["ledger"].USER, self.OPERATOR, ("cold", "warm")
        _NODES[s] |= ({f"lc-rename-{c}-k2" for c in both} | {f"lc-cc-{c}-m@0" for c in both}
                      | {"lc-rehname-warm-k2", "lc-keyren-warm-k2"})
        spies: collections.Counter = collections.Counter()

        def spy(name: str, answer: Any = None) -> Callable[..., Any]:
            def call(*_a: Any, **_k: Any) -> Any:
                spies[name] += 1
                return answer
            return call
        hub = api.hub_changed

        def hub_counted(*a: Any, **k: Any) -> Any:
            spies["hub_changed"] += 1
            return hub(*a, **k)
        family = [(api, "provider_hire_gate", lambda *_a, **_k: None),
                  (api, "hub_changed", hub_counted),
                  (supervisor, "interrupt_before_archive", spy("interrupt_before_archive", [])),
                  (supervisor, "remote_reap", spy("remote_reap")),
                  (supervisor, "export_predecessor_transcript",
                   spy("export_predecessor_transcript")),
                  (supervisor, "manual_compact", spy("manual_compact")),
                  (supervisor, "notify", spy("notify")),
                  (api, "_tier_discovery_payload", lambda *_a, **_k: {"tiers": ["fixture"]}),
                  (api.net, "remote_peers", lambda *_a, **_k: [])]
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in family]
        for obj, name, value in family:
            setattr(obj, name, value)
        try:
            self._lifecycle_rows(s, store, api, opreceipts, user, op, both, spies)
        finally:
            for obj, name, value in reversed(saved):
                setattr(obj, name, value)

    def _lifecycle_rows(self, s: str, store: Any, api: Any, opreceipts: Any, user: str,
                        op: dict[str, str], both: tuple[str, str],
                        spies: collections.Counter) -> None:
        def counted(row_of: Callable[[], dict[str, Any]]) -> dict[str, Any]:
            n0 = dict(spies)
            row = row_of()
            row["spies"] = {k: v - n0.get(k, 0) for k, v in sorted(spies.items())
                            if v - n0.get(k, 0)}
            return row

        def run(contract: str, variant: str, condition: str, actor: str, tool: str,
                args: dict[str, Any], **kw: Any) -> dict[str, Any]:
            return counted(lambda: self.run(contract, variant, condition, s, actor, tool,
                                            args, **kw))

        def route(contract: str, variant: str, condition: str, path: str, body: Any = None,
                  headers: Any = op, slug: str = s, args: "dict[str, Any] | None" = None,
                  call: "Callable[[], tuple[int, Any]] | None" = None,
                  **kw: Any) -> dict[str, Any]:
            call = call or self.http(self.client, path, headers, {} if body is None else body)
            return counted(lambda: self.run(contract, variant, condition, slug, user,
                                            f"POST {contract}", args or {}, call=call, **kw))

        def compact(path: str) -> Callable[[], tuple[int, Any]]:
            """The route starts manual compaction on a thread and answers at
            once; the call waits (up to 5 s) for the spy, so the effect is
            counted inside the row's window."""
            post = self.http(self.client, path, op, {})

            def call() -> tuple[int, Any]:
                n = spies["manual_compact"]
                status, payload = post()
                deadline = time.monotonic() + 5
                while status == 200 and spies["manual_compact"] == n and \
                        time.monotonic() < deadline:
                    time.sleep(0.01)
                return status, payload
            return call

        def epoch(actor: str) -> str:
            return str(self.client.post(
                "/api/agent", json=self.agent_body(s, actor, opreceipts.OP_EPOCH, {}),
                headers={"X-Orgtree-Agent-Token": self.tokens[(s, actor)]}).json()["epoch"])

        base = f"/api/orgs/{s}"
        for cond in both:
            def c(cell: str, role: str) -> str:
                return f"lc-{cell}-{cond}-{role}"
            run("lifecycle.rename", "lifecycle.rename", cond, c("rename", "m"), "orgtree_rename",
                {"node": c("rename", "k"), "name": c("rename", "k2")},
                implied=(c("rename", "k2"),))
            run("lifecycle.retool", "lifecycle.retool", cond, c("retool", "m"), "orgtree_retool",
                {"node": c("retool", "k"), "charter": "new charter"})
            run("lifecycle.retire", "lifecycle.retire", cond, c("retire", "m"), "orgtree_retire",
                {"node": c("retire", "k")})
            run("lifecycle.dissolve", "lifecycle.dissolve", cond, c("dissolve", "p"),
                "orgtree_dissolve", {"node": c("dissolve", "m")},
                implied=(c("dissolve", "k"), c("dissolve", "s")))
            run("lifecycle.cheap-compact", "lifecycle.cheap-compact", cond, c("cc", "p"),
                "orgtree_cheap_compact", {"node": c("cc", "m")}, implied=(c("cc", "m") + "@0",))
            run("lifecycle.rehire", "lifecycle.rehire", cond, c("rehire", "m"), "orgtree_rehire",
                {"node": c("rehire", "k")})
            run("lifecycle.move", "lifecycle.move", cond, c("move", "p"), "orgtree_move",
                {"node": c("move", "k"), "new_parent": c("move", "s")},
                implied=(c("move", "m"),))
            run("lifecycle.swap", "lifecycle.swap", cond, c("swap", "p"), "orgtree_swap",
                {"a": c("swap", "m"), "b": c("swap", "s")}, implied=(c("swap", "k"),))
            run("lifecycle.self-subjugate", "lifecycle.self-subjugate", cond, c("subj", "m"),
                "orgtree_self_subjugate", {"target": c("subj", "k")},
                implied=(c("subj", "p"), c("subj", "s")))
            run("lifecycle.switch-model", "lifecycle.switch-model", cond, c("switch", "m"),
                "orgtree_switch_model", {"node": c("switch", "k"), "tier": "sonnet"})
            # the catalogue loads EVERY org in the data root (their stores are
            # pooled, so the statements show without a connect)
            run("catalogue.list-orgs", "catalogue.list-orgs", cond, "lc-top2", "orgtree_list_orgs",
                {}, expected_unknown=("statement:data:org-db:foreign",))
            run("catalogue.list-tiers", "catalogue.list-tiers", cond, "lc-top2",
                "orgtree_list_tiers", {})
            # the operator routes (@user on the desktop token)
            route("lifecycle.reorder", "lifecycle.reorder", cond,
                  f"{base}/nodes/{c('reorder', 's')}/reorder", {"before": c("reorder", "m")},
                  args={"node": c("reorder", "s")}, implied=(c("reorder", "m"),))
            route("lifecycle.compact", "lifecycle.compact", cond, "", args={"node": c("compact", "m")},
                  call=compact(f"{base}/nodes/{c('compact', 'm')}/compact"))
            route("lifecycle.repair-rename", "lifecycle.repair-rename", cond,
                  f"{base}/repair-rename",
                  {"actor": user, "rename_at": self.lc_repair_at[cond],
                   "documents": [f"lc-repair-{cond}-doc"], "work_items": []},
                  args={"node": c("repair", "k2")})
            # success needs a registered account (machine state) or a lost /
            # phantom lineage generation (a real session file): refusal rows
            route("lifecycle.account-assign", "refusal:account-unknown", cond,
                  f"{base}/nodes/lc-top2/account", {"account": "nope"}, args={"node": "lc-top2"},
                  refusal="422 no account 'nope' is registered")
            route("lifecycle.lineage-recover", "refusal:lineage-not-lost", cond,
                  f"{base}/lineage/lc-top2/recover", args={"node": "lc-top2"},
                  refusal="422 not a lost generation")
            route("lifecycle.lineage-drop-phantom", "refusal:lineage-not-phantom", cond,
                  f"{base}/lineage/lc-top2/drop-phantom", args={"node": "lc-top2"},
                  refusal="422 not a LOST generation")
            everyone = self.lc_all[cond]
            if cond == "warm":
                store.load_org(everyone)
            route("lifecycle.dissolve-all", "lifecycle.dissolve-all", cond,
                  f"/api/orgs/{everyone}/dissolve-all", slug=everyone,
                  implied=tuple(sorted(_NODES[everyone])))

        def w(cell: str, role: str) -> str:
            return f"lc-{cell}-warm-{role}"
        run("lifecycle.retool", "lifecycle.retool:self-team", "warm", w("retool", "m"),
            "orgtree_retool", {"node": w("retool", "m"), "team_charter": "tc"})
        run("lifecycle.retire", "lifecycle.retire:self", "warm", w("retself", "k"),
            "orgtree_retire", {"node": w("retself", "k")}, implied=(w("retself", "m"),))
        run("lifecycle.retire", "lifecycle.retire:with-reports", "warm", w("retkids", "p"),
            "orgtree_retire", {"node": w("retkids", "m")},
            implied=(w("retkids", "k"), w("retkids", "s")))
        run("lifecycle.rehire", "lifecycle.rehire:name", "warm", w("rehname", "m"),
            "orgtree_rehire", {"node": w("rehname", "k"), "name": w("rehname", "k2")},
            implied=(w("rehname", "k2"),))
        run("lifecycle.rehire", "lifecycle.rehire:mail", "warm", w("rehmail", "m"),
            "orgtree_rehire", {"node": w("rehmail", "k")})
        # already live after the warm rehire row: a no-op that still broadcasts
        run("lifecycle.rehire", "lifecycle.rehire:live", "warm", w("rehire", "m"),
            "orgtree_rehire", {"node": w("rehire", "k")})
        # back under m after the warm move row
        run("lifecycle.move", "lifecycle.move:batch", "warm", w("move", "p"), "orgtree_move",
            {"moves": [{"node": w("move", "k"), "new_parent": w("move", "m")}]},
            implied=(w("move", "k"), w("move", "m"), w("move", "s")))
        # recorded legacy defect: a same-parent move answers its no-op before
        # any authority check, so an unrelated caller gets an accepted cycle
        run("lifecycle.move", "lifecycle.move:noop-unrelated-caller", "warm", "lc-top2",
            "orgtree_move", {"node": w("move", "k"), "new_parent": w("move", "m")})
        run("lifecycle.switch-model", "lifecycle.switch-model:no-op", "warm", w("switch", "m"),
            "orgtree_switch_model", {"node": w("switch", "k"), "tier": "sonnet"})
        key, args = opreceipts.mint_key(), {"node": w("movekey", "k"),
                                            "new_parent": w("movekey", "s")}
        ep = epoch(w("movekey", "p"))
        run("lifecycle.move", "lifecycle.move:keyed-fresh", "warm", w("movekey", "p"),
            "orgtree_move", args, key=key, epoch=ep, implied=(w("movekey", "m"),))
        run("lifecycle.move", "lifecycle.move:keyed-replay", "warm", w("movekey", "p"),
            "orgtree_move", args, key=key, epoch=ep, implied=(w("movekey", "m"),),
            refusal="keyed replay (answered from the receipt, no effect)")
        # recorded legacy: a keyed rename skips admission (a malformed key is
        # executed, and no receipt is filed)
        run("lifecycle.rename", "lifecycle.rename:keyed-malformed-key", "warm", w("keyren", "m"),
            "orgtree_rename", {"node": w("keyren", "k"), "name": w("keyren", "k2")},
            key="not-a-key", epoch=epoch(w("keyren", "m")), implied=(w("keyren", "k2"),))

        def r(role: str) -> str:
            return f"lc-ref-warm-{role}"
        for contract, variant, actor, tool, args, refusal in (
                ("lifecycle.rename", "refusal:rename-no-authority", r("m"), "orgtree_rename",
                 {"node": r("p"), "name": "x"}, "422 no authority over its superior"),
                ("lifecycle.rename", "refusal:rename-taken", r("p"), "orgtree_rename",
                 {"node": r("k"), "name": r("s")}, "422 the name is already taken"),
                ("lifecycle.retool", "refusal:retool-own-charter", r("m"), "orgtree_retool",
                 {"node": r("m"), "charter": "x"}, "422 an agent may not rewrite its own charter"),
                ("lifecycle.retire", "refusal:retire-self-with-reports", r("m"), "orgtree_retire",
                 {"node": r("m")}, "422 live reports (legacy: after the interrupt)"),
                ("lifecycle.retire", "refusal:retire-no-authority", r("k"), "orgtree_retire",
                 {"node": r("m")}, "422 no authority (the pre-guard, before the interrupt)"),
                ("lifecycle.dissolve", "refusal:dissolve-self", r("m"), "orgtree_dissolve",
                 {"node": r("m")}, "422 no authority over itself"),
                ("lifecycle.cheap-compact", "refusal:cheap-compact-self", r("m"),
                 "orgtree_cheap_compact", {"node": r("m")}, "422 no authority over itself"),
                ("lifecycle.move", "refusal:move-batch-not-object", r("p"), "orgtree_move",
                 {"moves": [r("k")]}, "422 moves[0] must be an object"),
                ("lifecycle.move", "refusal:move-no-authority", r("m"), "orgtree_move",
                 {"node": r("k"), "new_parent": r("s")}, "422 no authority over the new parent"),
                ("lifecycle.swap", "refusal:swap-same-agent", r("p"), "orgtree_swap",
                 {"a": r("m"), "b": r("m")}, "422 a seat swap needs two different agents"),
                ("lifecycle.swap", "refusal:swap-top-level", "lc-top", "orgtree_swap",
                 {"a": "lc-top", "b": r("p")}, "422 only the user reseats the top level"),
                ("lifecycle.self-subjugate", "refusal:subjugate-not-descendant", r("m"),
                 "orgtree_self_subjugate", {"target": r("s")}, "422 not a live descendant"),
                ("lifecycle.switch-model", "refusal:switch-own-model", r("m"),
                 "orgtree_switch_model", {"node": r("m"), "tier": "sonnet"},
                 "422 an agent cannot switch its own model"),
                ("lifecycle.switch-model", "refusal:switch-unknown-tier", r("m"),
                 "orgtree_switch_model", {"node": r("k"), "tier": "nope"}, "422 unknown tier")):
            run(contract, variant, "warm", actor, tool, args, refusal=refusal)
        # recorded legacy defect: the interrupt runs before admission refuses a
        # malformed key
        run("lifecycle.retire", "refusal:retire-keyed-malformed-key", "warm", r("m"),
            "orgtree_retire", {"node": r("k")}, key="not-a-key", epoch=epoch(r("m")),
            refusal="422 op_key refused (legacy: after the interrupt)")
        route("lifecycle.reorder", "refusal:reorder-no-sibling", "warm",
              f"{base}/nodes/{r('k')}/reorder", {"before": None, "after": None},
              args={"node": r("k")}, refusal="422 reorder needs a sibling")
        route("lifecycle.compact", "refusal:compact-no-conversation", "warm",
              f"{base}/nodes/{r('m')}/compact", args={"node": r("m")},
              refusal="422 no conversation yet")
        route("lifecycle.repair-rename", "refusal:repair-no-records", "warm",
              f"{base}/repair-rename", {"rename_at": "t", "documents": [], "work_items": []},
              refusal="422 name the records to repair")
        route("lifecycle.dissolve-all", "refusal:route-agent-token", "warm",
              f"{base}/dissolve-all", headers={"X-Orgtree-Agent-Token": self.tokens[(s, "lc-top")]},
              refusal="401 an agent credential is refused here")

        # agent-level locality control: a retool whose closing tree broadcast
        # (api.hub_changed) ALSO posts mail to a third agent
        def mail_third(*_a: Any, **_k: Any) -> None:
            spies["hub_changed"] += 1
            with store.write_org(s) as o:
                o.post_mail("lc-top", "lc-third", "p02 control: mail to a third agent")
                store.save_org(o)
        run("lifecycle.retool", "control:lifecycle-third-agent", "warm", w("ctl", "m"),
            "orgtree_retool", {"node": w("ctl", "k"), "charter": "control"},
            refusal="negative control (not a product path)",
            patches=[(api, "hub_changed", mail_third)])

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
            "mailhub_runtime.py": "one-time migration of the superseded V2 mail hub "
            "store into the hub's own store when the hub starts (engine/mailhub_runtime.py, "
            "outside the backend package); the hub's store, not Orgtree's, and not "
            "reached by any of the families",
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
        diagnostic family and the three inbox routes, the families whose P01
        clauses name the JSON backend."""
        self.prepare()
        json_backend = self.backend == "json"
        self.build()
        if not json_backend:
            self.build_sandbox()
            self.build_status()
            self.build_org_view()
            self.build_mail()
            self.build_funding()
            self.build_staffing()
            self.build_operator()
            self.build_quickstaff()
            self.build_workread()
            self.build_receipts()
            self.build_lifecycle()
            self.build_opvariants()
            self.build_requests()
            self.build_control()
            self.build_exchange()
            self.build_orgreads()
        self.build_human()
        for slug in ((self.dslug, self.hslug) if json_backend else
                     (self.rslug, self.mslug, self.dslug, self.pslug, self.sslug,
                      self.stslug, self.ovslug, self.mlslug, self.hslug, self.fslug,
                      self.stfslug, self.opslug, self.qsslug, self.wrslug, self.rlslug,
                      self.lcslug, *self.lc_all.values(), self.vxslug,
                      self.rqslug, self.ctslug, *self.ks.values(),
                      *self.kx.values(), *self.ex.values(), self.orslug,
                      *self.or_other.values())):
            _NODES[slug] = {str(n) for n in self.m["store"].load_org(slug).nodes}
        self.operator("post", "/api/diagnostics/operation-census/reset")
        self.operator("post", "/api/diagnostics/operation-census", json={"enabled": True})
        w0 = self.census_state()
        if json_backend:
            self.diagnostic()
            self.inbox()
        else:
            self.reservation()
            self.material()
            self.sandboxed()
            self.diagnostic()
            self.migration()
            self.preview()
            self.provider()
            self.status_chart()
            self.org_view()
            self.mail()
            self.human()
            self.inbox()
            self.funding()
            self.staffing()
            self.operator_ops()
            self.quick_staff()
            self.work_read()
            self.receipts()
            self.lifecycle()
            self.op_variants()
            self.requests()
            self.control()
            self.exchange()
            self.org_reads()
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
            "kiosk_token_scan": getattr(self, "kiosk_scan", None),
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
                   help="the primary store backend (json: diagnostic and inbox rows only)")
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
    try:
        doc = probe.execute()
    except ProbeProvenanceError as exc:
        print(str(exc), file=sys.stderr, flush=True)
        return 3
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
