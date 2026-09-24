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
import collections
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
import uuid
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
            ("mail.message:mcp", "m-top", "@mcp:peer1", {}),
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
        self.build_human()
        for slug in ((self.dslug, self.hslug) if json_backend else
                     (self.rslug, self.mslug, self.dslug, self.pslug, self.sslug,
                      self.stslug, self.ovslug, self.mlslug, self.hslug, self.fslug,
                      self.stfslug, self.opslug, self.qsslug, self.wrslug, self.rlslug)):
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
