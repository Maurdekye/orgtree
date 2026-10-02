"""The two side files that move into each org's own database (design §2.10, §5.2 step 4).

  reply-events.sqlite3  events(org, agent, generation, id, text, scope): the immutable reply
                        snapshots a quoted reply resolves (reply_events.py). Rows move by their
                        org slug. A row whose slug is not an org converted now stays in the old
                        file, and the report counts it.
  file-deliveries.db    deliveries(id, fingerprint, result): retryable file-delivery receipts
                        (filedelivery.py), with NO org column. A row moves into an org only on
                        evidence that names the calling org (``assign_deliveries``, rev 7.1).
                        Every other row stays in the old file, untouched, and nothing consults it
                        any more (decision 18, option X).

Both files are read once, through SQLite's backup API into memory, without writing the file or
its companions (``snapshot_sqlite``). The old files are never written, moved or deleted (§5.3).

Every value is kept exactly: rows go through the codec, so a value no column holds (a quote
holding U+0000, 7 rows on the live copy; a generation that is not an integer) is kept in the
row's ``extra`` JSON (§3.0). The Sections here own no document key (``keys=()``). The converter
lists them after the mappers' sections, so the agents exist when they name one, and the
tombstones they mint for names no node carries get their agent rows
(``sections.encode_document``). ``check_reply_events`` and ``check_file_deliveries`` compare the
rows read back with the source rows: counts and an order-free sha256 over each row's canonical
JSON (``rows_digest``).

``side_inputs(data_root)`` wires all of this, and the org-restricted accounts
(``accounts.OrgAccounts``), into the converter's run (``run.SideInputs``).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from ... import sqlitesnap
from .. import codec
from ..codec import Field, Rows, ShapeError, Spec
from ..sections import Context, Section, Table, check, table

REPLY_EVENTS_FILE = "reply-events.sqlite3"
DELIVERIES_FILE = "file-deliveries.db"

# ---------------------------------------------------------------- reading SQLite, read-only

#: The old files are read as of their last committed state without writing them or any
#: file beside them: a hot rollback journal or a WAL are replayed on a private copy
#: (orgtree.sqlitesnap, shared with the 2.1.14 first-launch import).
snapshot_sqlite = sqlitesnap.snapshot_sqlite


def _text_or_bytes(raw: bytes) -> str | bytes:
    """SQLite text as str; text that is not UTF-8 stays bytes, which the section owning the
    row refuses (ShapeError), so one bad row costs its own org only."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw


def _select(mem: sqlite3.Connection, table_name: str, cols: tuple[str, ...]) -> list[tuple[Any, ...]]:
    """Every row of ``table_name`` in insertion (rowid) order; [] when there is no such table."""
    if mem.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                   (table_name,)).fetchone() is None:
        return []
    mem.text_factory = _text_or_bytes
    sel = ", ".join(f'"{c}"' for c in cols)
    try:
        return mem.execute(f'SELECT {sel} FROM "{table_name}" ORDER BY rowid').fetchall()
    except sqlite3.OperationalError:            # a WITHOUT ROWID table: its key order
        return mem.execute(f'SELECT {sel} FROM "{table_name}"').fetchall()


def read_reply_events(db_path: str | os.PathLike[str]) -> dict[Any, list[dict[str, Any]]]:
    """``reply-events.sqlite3``'s rows grouped by their org slug, each {agent, generation, id,
    text, scope} with the values exactly as stored; {} when there is no file or no table."""
    mem = snapshot_sqlite(db_path)
    if mem is None:
        return {}
    try:
        out: dict[Any, list[dict[str, Any]]] = {}
        for org, agent, generation, eid, text, scope in _select(
                mem, "events", ("org", "agent", "generation", "id", "text", "scope")):
            out.setdefault(org, []).append({"agent": agent, "generation": generation, "id": eid,
                                            "text": text, "scope": scope})
        return out
    finally:
        mem.close()


def read_deliveries(db_path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    """``file-deliveries.db``'s rows, each {id, fingerprint, result} exactly as stored (result
    None for a receipt whose copy never finished); [] when there is no file or no table."""
    mem = snapshot_sqlite(db_path)
    if mem is None:
        return []
    try:
        return [{"id": i, "fingerprint": fp, "result": res}
                for i, fp, res in _select(mem, "deliveries", ("id", "fingerprint", "result"))]
    finally:
        mem.close()


# ---------------------------------------------------------------- comparing rows

def _canon_default(v: Any) -> Any:
    if isinstance(v, (bytes, bytearray)):
        return {"$bytes": bytes(v).hex()}
    raise TypeError(f"not JSON: {type(v).__name__}")


def rows_digest(rows: Iterable[Mapping[str, Any]], fields: tuple[str, ...]) -> dict[str, Any]:
    """{"count": n, "sha256": hex}: an order-free digest of ``rows``, each taken as the canonical
    JSON (exact types) of its ``fields`` in that order. Equal multisets of rows give equal
    digests, whatever order either side reads them in."""
    hashes = []
    for r in rows:
        line = json.dumps([r.get(f) for f in fields], ensure_ascii=False, separators=(",", ":"),
                          default=_canon_default)
        hashes.append(hashlib.sha256(line.encode("utf-8")).hexdigest())
    hashes.sort()
    return {"count": len(hashes), "sha256": hashlib.sha256("\n".join(hashes).encode()).hexdigest()}


def _compare(path: str, want: list[Mapping[str, Any]], got: list[Mapping[str, Any]],
             fields: tuple[str, ...], key: tuple[str, ...]) -> list[dict[str, Any]]:
    """[] when ``got`` holds exactly ``want``'s rows; else one mismatch naming both digests and
    up to five rows on each side the other lacks (by ``key``)."""
    a, b = rows_digest(want, fields), rows_digest(got, fields)
    if a == b:
        return []

    def line(r: Mapping[str, Any]) -> str:
        return json.dumps([r.get(f) for f in fields], sort_keys=True, ensure_ascii=False,
                          default=_canon_default)

    left = {line(r): r for r in want}
    right = {line(r): r for r in got}
    only_want = [{k: r.get(k) for k in key} for s, r in left.items() if s not in right][:5]
    only_got = [{k: r.get(k) for k in key} for s, r in right.items() if s not in left][:5]
    return [{"path": path, "want": a, "got": b, "missing": only_want, "unexpected": only_got}]


def _agent_names(rows: Mapping[str, list[Mapping[str, Any]]]) -> dict[int, str]:
    """{agent row id: name} from the read-back agents rows, tombstones included."""
    return {r["id"]: r["name"] for r in rows.get("agents", [])}


# a field a decoded row lacks: never equal to any stored value, a null included
ABSENT = {"$absent": True}


def _name(names: Mapping[int, str], agent_id: int) -> Any:
    return names[agent_id] if agent_id in names else {"$agent_row": agent_id}


def _refuse_blobs(where: str, values: Iterable[Any]) -> None:
    for v in values:
        if isinstance(v, (bytes, bytearray)):
            raise ShapeError(f"{where}: a value that is not text (a BLOB, or text that is not UTF-8)")


# ---------------------------------------------------------------- reply events

EVENT_FIELDS = ("agent", "generation", "id", "text", "scope")

REPLY_EVENT = Spec("reply_events", (
    Field("generation", "int"),
    Field("id", "text", col="public_id"),
    Field("text", "text"),
    Field("scope", "text"),
))

REPLY_EVENTS = table(
    REPLY_EVENT, child_key="reply_event_id",
    placement=(("agent_id", "bigint",
                "agent_id bigint NOT NULL REFERENCES orgtree.agents (id) ON DELETE CASCADE"),),
    indexes=('CREATE UNIQUE INDEX reply_events_key ON orgtree.reply_events '
             '(agent_id, "generation", "public_id")',))


class ReplyEvents(Section):
    """One org's ``reply-events.sqlite3`` rows ({agent, generation, id, text, scope}, as
    ``read_reply_events`` gives them for its slug) into ``reply_events``: the agent by row id,
    a name no node carries pointing at a tombstone (§3.0). ``decode`` leaves the rows it reads
    back in ``read_back``."""
    keys: tuple[str, ...] = ()
    tables = (REPLY_EVENTS,)

    def __init__(self, rows: Iterable[Mapping[str, Any]] = ()) -> None:
        self.rows = list(rows)
        self.read_back: list[dict[str, Any]] = []

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        n = len(out.get(REPLY_EVENT.table, []))
        for r in self.rows:
            agent = r["agent"]
            if not codec.fits("text", agent):
                raise ShapeError("reply_events: an agent name no text column can hold")
            _refuse_blobs("reply_events", (r[k] for k in EVENT_FIELDS))
            n += 1
            codec.encode(REPLY_EVENT, {k: r[k] for k in ("generation", "id", "text", "scope")},
                         {"id": n, "agent_id": ctx.agent(agent)}, out, link=REPLY_EVENTS.link)

    def decode(self, rows, ctx, present, doc) -> None:
        self.read_back = decode_reply_events(rows, ctx.names)


def decode_reply_events(rows: Mapping[str, list[Mapping[str, Any]]],
                        names: Mapping[int, str]) -> list[dict[str, Any]]:
    """The source rows {agent, generation, id, text, scope} back from ``reply_events`` rows, in
    the order they were written. ``names`` maps agent row ids to names (a Context's ``names``)."""
    out = []
    for r in sorted(rows.get(REPLY_EVENT.table, []), key=lambda r: r["id"]):
        rec = codec.decode(REPLY_EVENT, r, None, (r["id"],))
        out.append({"agent": _name(names, r["agent_id"]),
                    **{k: rec.get(k, ABSENT) for k in EVENT_FIELDS[1:]}})
    return out


def check_reply_events(source: list[Mapping[str, Any]],
                       rows: Mapping[str, list[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """[] when the org database's ``reply_events`` (``rows`` as rowio.read gives them) hold
    exactly ``source``; else the mismatch (counts, digests, example keys)."""
    return _compare("side/reply_events", source, decode_reply_events(rows, _agent_names(rows)),
                    EVENT_FIELDS, ("agent", "generation", "id"))


# ---------------------------------------------------------------- file deliveries: evidence

SNAPSHOT = "snapshot"       # evidence 1: the receipt's snapshot folder, in one org only
KEY = "key"                 # evidence 2: a delivery key that recomputes the receipt's id

_KEY_RE = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")      # filedelivery.snapshot's delivery_id rule
_SEND_FILE = "orgtree_send_file"
_FOLDER_PREFIX = "delivery-"


@dataclass(frozen=True)
class OrgEvidenceInput:
    """What ``assign_deliveries`` needs about one org of this machine.

    scratch_roots  the org's scratch roots (``<data>/scratch/<slug>``): every folder an agent's
                   scratch folder sits in. Pass every org whose folders exist, converting or
                   not: a snapshot folder proves its org only when no other org's root holds it.
    lineage        {agent name: lineage_born (the node's seat_id)} of every node of the org,
                   archived ones included: the org's lineage tokens, and who holds each.
    transcripts    (agent name, transcript path) pairs of the org's agents
                   (``supervisor.transcript_path_for_node``), or a callable returning them. It is
                   only called, and the files only read, when evidence 1 leaves rows.
    converting     False for an org that is not converted now (unavailable, or not converted at
                   all): its roots still count against the others, but no row is assigned to it.
    slug           the slug its receipts were minted under; the dict key when None.
    """
    scratch_roots: tuple[str, ...] = ()
    lineage: Mapping[str, str] = field(default_factory=dict)
    transcripts: Any = ()
    converting: bool = True
    slug: str | None = None


@dataclass(frozen=True)
class _Folder:
    path: str                   # as found under a scratch root
    real: str                   # links resolved
    key: str                    # ``real`` case-folded as the platform compares paths
    agent: str                  # the agent folder it sits in, under its owning root
    owners: frozenset[str]      # every org whose (resolved) scratch root holds it


def _names_in(path: str, unreadable: list[str]) -> list[str]:
    """The entry names of a folder; [] for a folder that is not there. A folder that exists
    but cannot be listed is recorded in ``unreadable``."""
    try:
        return os.listdir(path)
    except (FileNotFoundError, NotADirectoryError):
        return []
    except OSError:
        unreadable.append(path)
        return []


def _delivery_folders(orgs: Mapping[str, OrgEvidenceInput]
                      ) -> tuple[dict[str, list[_Folder]], list[str]]:
    """{receipt id: every ``<root>/<agent>/outbox/delivery-<id>`` folder under any org's scratch
    root}, and the locations that could not be read."""
    unreadable: list[str] = []
    roots: list[tuple[str, str, str]] = []           # (normcased real root, real root, org)
    for org, inp in orgs.items():
        for root in inp.scratch_roots:
            real = os.path.realpath(root)
            roots.append((os.path.normcase(real).rstrip("\\/"), real, org))
    found: dict[str, list[_Folder]] = {}
    for inp in orgs.values():
        for root in inp.scratch_roots:
            for agent in _names_in(root, unreadable):
                outbox = os.path.join(root, agent, "outbox")
                for name in _names_in(outbox, unreadable):
                    path = os.path.join(outbox, name)
                    if not name.startswith(_FOLDER_PREFIX) or not os.path.isdir(path):
                        continue
                    real = os.path.realpath(path)
                    key = os.path.normcase(real)
                    owning = [(rk, rr, o) for rk, rr, o in roots
                              if key == rk or key.startswith(rk + os.sep)]
                    owner_agent = (os.path.relpath(real, owning[0][1]).split(os.sep)[0]
                                   if owning else agent)
                    found.setdefault(name[len(_FOLDER_PREFIX):], []).append(
                        _Folder(path, real, key, owner_agent, frozenset(o for _, _, o in owning)))
    return found, unreadable


def _saved_result(result: Any) -> dict[str, Any] | None:
    """The saved result's {name, bytes, sha256}, or None when they cannot be read from it."""
    try:
        sent = json.loads(result)
    except (TypeError, ValueError):
        return None
    if not isinstance(sent, dict):
        return None
    name, size, digest = sent.get("name"), sent.get("bytes"), sent.get("sha256")
    if (not isinstance(name, str) or name in ("", ".", "..") or "/" in name or "\\" in name
            or "\x00" in name or type(size) is not int or size < 0 or not isinstance(digest, str)):
        return None
    return {"name": name, "bytes": size, "sha256": digest}


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_matches(folder: str, sent: Mapping[str, Any]) -> bool:
    """The snapshot folder holds the saved result's file: its name, size and SHA-256. A file the
    converter cannot read gives no evidence."""
    target = os.path.join(folder, sent["name"])
    try:
        return (os.path.isfile(target) and os.path.getsize(target) == sent["bytes"]
                and _sha256_file(target) == sent["sha256"])
    except OSError:
        return False


def _snapshot_verdict(row: Mapping[str, Any], folders: list[_Folder],
                      matches: dict[tuple[str, str, int, str], bool]
                      ) -> tuple[str, str | None, str] | str | None:
    """Evidence 1 for one receipt: (org, agent or None, folder) when exactly one org's scratch
    root holds its snapshot folder (links resolved) and, for a completed receipt, the file in it
    matches the saved result; a reason when folders exist but prove nothing; None when there is
    no folder at all. ``matches`` remembers file checks already made."""
    if not folders:
        return None
    physical = list({f.key: f for f in folders}.values())
    outside = [f.path for f in physical if not f.owners]
    if outside:
        return f"a snapshot folder resolves outside every scratch root: {outside[0]}"
    owners = frozenset().union(*(f.owners for f in physical))
    if len(owners) > 1:
        return f"its snapshot folder is under more than one org's scratch root: {sorted(owners)}"
    (org,) = owners
    if row["result"] is None:
        matched = physical
    else:
        sent = _saved_result(row["result"])
        if sent is None:
            return "its saved result does not name a file (name, bytes, sha256)"
        matched = []
        for f in physical:
            memo = (f.key, sent["name"], sent["bytes"], sent["sha256"])
            if memo not in matches:
                matches[memo] = _file_matches(f.real, sent)
            if matches[memo]:
                matched.append(f)
        if not matched:
            return "the file in its snapshot folder does not match the saved result"
    agents = {f.agent for f in matched}
    return org, (agents.pop() if len(agents) == 1 else None), matched[0].path


def _send_file_call(name: Any) -> bool:
    """``orgtree_send_file`` as Claude names it (``mcp__orgtree__orgtree_send_file``) or as the
    Codex and Antigravity journals do (bare)."""
    return isinstance(name, str) and name.rsplit("__", 1)[-1] == _SEND_FILE


def _result_texts(content: Any) -> list[str]:
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [b["text"] for b in content
                if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
    return []


def transcript_keys(path: str) -> set[str]:
    """The delivery keys one transcript holds: the ``delivery_id`` argument of each
    ``orgtree_send_file`` call, and the ``delivery_id`` of each answer to one (the key the
    bridge returns with a lost or unsent answer, mcptool.call_api). Nothing else is read: lines
    naming neither are skipped unparsed. Raises OSError when the file cannot be read."""
    keys: set[str] = set()
    calls: set[str] = set()

    def add(v: Any) -> None:
        if isinstance(v, str) and _KEY_RE.match(v):
            keys.add(v)

    with open(path, "rb") as f:
        for raw in f:
            if b"orgtree_send_file" not in raw and not (b"tool_result" in raw
                                                         and b"delivery_id" in raw):
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            msg = rec.get("message") if isinstance(rec, dict) else None
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and _send_file_call(block.get("name")):
                    if isinstance(block.get("id"), str):
                        calls.add(block["id"])
                    if isinstance(block.get("input"), dict):
                        add(block["input"].get("delivery_id"))
                elif block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
                    for text in _result_texts(block.get("content")):
                        try:
                            answer = json.loads(text)
                        except ValueError:
                            continue
                        if isinstance(answer, dict):
                            add(answer.get("delivery_id"))
    return keys


def receipt_id(slug: str, lineage_born: str, key: str) -> str:
    """A receipt's id, exactly as filedelivery.snapshot computes it."""
    return hashlib.sha256(f"{slug}:{lineage_born}:{key}".encode()).hexdigest()


def _key_matches(left: set[str], orgs: Mapping[str, OrgEvidenceInput], rep: dict[str, Any]
                 ) -> dict[str, list[tuple[str, str | None, str]]]:
    """Evidence 2: {receipt id: [(org, agent or None, transcript)]} for every key found in an
    org's transcripts that recomputes a left receipt's id with that org's slug and one of its
    lineage tokens."""
    out: dict[str, list[tuple[str, str | None, str]]] = {}
    for org, inp in orgs.items():
        tokens: dict[str, list[str]] = {}
        for name, born in inp.lineage.items():
            if isinstance(born, str) and born:
                tokens.setdefault(born, []).append(name)
        if not tokens:
            continue
        source = inp.transcripts() if callable(inp.transcripts) else inp.transcripts
        holders: dict[str, dict[str, str]] = {}          # key -> {agent: transcript}
        for agent, path in source or ():
            try:
                found = transcript_keys(path)
            except OSError:
                rep["transcripts"]["unreadable"].append(str(path))
                continue
            rep["transcripts"]["read"] += 1
            for k in found:
                holders.setdefault(k, {}).setdefault(agent, str(path))
        slug = inp.slug if inp.slug is not None else org
        for k, by_agent in holders.items():
            for born, names in tokens.items():
                rid = receipt_id(slug, born, k)
                if rid not in left:
                    continue
                own = [n for n in names if n in by_agent]
                agent = own[0] if len(own) == 1 else (names[0] if len(names) == 1 else None)
                where = by_agent[agent] if agent in by_agent else next(iter(by_agent.values()))
                out.setdefault(rid, []).append((org, agent, where))
    return out


def _source_path(fingerprint: Any) -> Any:
    """The source path a fingerprint records (never its caption), for the report only: a
    source path is never evidence (rev 7, review round 4)."""
    try:
        fp = json.loads(fingerprint)
    except (TypeError, ValueError):
        return None
    return fp[0] if isinstance(fp, list) and fp and isinstance(fp[0], str) else None


def assign_deliveries(rows: Iterable[Mapping[str, Any]], orgs: Mapping[str, OrgEvidenceInput], *,
                      report: dict[str, Any] | None = None,
                      file_checks: dict[tuple[str, str, int, str], bool] | None = None
                      ) -> dict[str, tuple[str, str, str | None]]:
    """{receipt id: (org, evidence, agent name or None)} for every receipt of ``rows``
    (``read_deliveries``) that evidence assigns to an org being converted (design §5.2, rev 7.1).

    Evidence, in this order:
      1. ``snapshot``: the receipt's ``outbox/delivery-<id>/`` folder exists under exactly one
         org's scratch root and under no other (links resolved, every org of ``orgs`` counted,
         converting or not), and for a completed receipt the file in it matches the saved
         result: name, size and SHA-256. A location that cannot be read makes "no other"
         unprovable, so evidence 1 then assigns nothing.
      2. ``key``: for the receipts evidence 1 left, a delivery key K found in an org's
         transcripts (``transcript_keys``) with sha256(f"{slug}:{lineage_born}:{K}") equal to
         the id, for that org's slug and one of its lineage tokens. The hash holds the calling
         org's slug, so a key another org's agent merely read cannot move the row there.
    A source path is never evidence. A receipt with no evidence, or with evidence for more than
    one org, is absent: it stays in the old file, untouched (option X). So is one whose
    evidence names an org that is not converting now; it moves at that org's retry.

    ``report``, when given, is filled with: the counts; ``moved`` {org: {evidence: n}};
    ``evidence`` {id: {org, kind, agent, where}} for every receipt evidence placed (moved or
    waiting); ``waiting`` (evidence names an org not converted now); ``left`` [{id, why,
    source}] (the source path only, never the caption); ``unreadable`` locations; and the
    transcripts read. ``file_checks`` lets several calls share the snapshot files' checks."""
    rep: dict[str, Any] = report if report is not None else {}
    rows = list(rows)
    rep.update({"rows": len(rows), "completed": sum(1 for r in rows if r.get("result") is not None),
                "moved": {}, "evidence": {}, "waiting": [], "left": [], "unreadable": [],
                "transcripts": {"read": 0, "unreadable": []}})
    by_id = {r["id"]: r for r in rows if codec.fits("text", r.get("id"))}
    folders, unreadable = _delivery_folders(orgs)
    rep["unreadable"] = unreadable
    checks = file_checks if file_checks is not None else {}
    placed: dict[str, tuple[str, str, str | None, str]] = {}
    why: dict[str, str] = {}
    for rid, row in by_id.items():
        if unreadable:
            why[rid] = ("scratch locations could not be read, so its snapshot folder cannot be "
                        "proved to be in one org only" if folders.get(rid) else
                        "no snapshot folder in the scratch locations that could be read")
            continue
        verdict = _snapshot_verdict(row, folders.get(rid, []), checks)
        if isinstance(verdict, tuple):
            org, agent, where = verdict
            placed[rid] = (org, SNAPSHOT, agent, where)
        elif isinstance(verdict, str):
            why[rid] = verdict
    left = {rid for rid in by_id if rid not in placed}
    if left:
        for rid, hits in _key_matches(left, orgs, rep).items():
            named = {org for org, _, _ in hits}
            if len(named) > 1:
                why[rid] = f"its key recomputes its id in more than one org: {sorted(named)}"
                continue
            org, agent, where = hits[0]
            agents = {a for _, a, _ in hits}
            placed[rid] = (org, KEY, agent if len(agents) == 1 else None, where)
    out: dict[str, tuple[str, str, str | None]] = {}
    for rid, (org, kind, agent, where) in placed.items():
        rep["evidence"][rid] = {"org": org, "kind": kind, "agent": agent, "where": where}
        if orgs[org].converting:
            out[rid] = (org, kind, agent)
            moved = rep["moved"].setdefault(org, {SNAPSHOT: 0, KEY: 0})
            moved[kind] += 1
        else:
            rep["waiting"].append({"id": rid, "org": org, "evidence": kind})
    for r in rows:
        rid = r.get("id")
        if not codec.fits("text", rid):
            rep["left"].append({"id": repr(rid), "why": "an id that is not text",
                                "source": _source_path(r.get("fingerprint"))})
        elif rid not in placed:
            rep["left"].append({"id": rid,
                                "why": why.get(rid, "no snapshot folder and no delivery key"),
                                "source": _source_path(r.get("fingerprint"))})
    return out


# ---------------------------------------------------------------- file deliveries: rows

DELIVERY_FIELDS = ("id", "fingerprint", "result")

FILE_DELIVERY = Spec("file_deliveries", (Field("fingerprint", "text"), Field("result", "text")))

FILE_DELIVERIES = Table(
    FILE_DELIVERY, (("id", "text"), ("agent_id", "bigint"), ("evidence", "text")),
    {"id": "delivery_id"},
    ("id text PRIMARY KEY",
     "agent_id bigint REFERENCES orgtree.agents (id) ON DELETE SET NULL",
     f"evidence text CHECK (evidence IN ('{SNAPSHOT}', '{KEY}'))"),
    ("CREATE INDEX file_deliveries_agent ON orgtree.file_deliveries (agent_id)",))
check(FILE_DELIVERIES)


class FileDeliveries(Section):
    """The receipts ``assigned`` (``assign_deliveries``) gives org ``org`` into
    ``file_deliveries``: id, the agent the evidence names (None when it names none), the
    evidence, and fingerprint and result exactly as stored (result NULL while the copy never
    finished). ``decode`` leaves the rows it reads back in ``read_back``."""
    keys: tuple[str, ...] = ()
    tables = (FILE_DELIVERIES,)

    def __init__(self, org: str, rows: Iterable[Mapping[str, Any]],
                 assigned: Mapping[str, tuple[str, str, str | None]]) -> None:
        self.org = org
        self.assigned = {rid: a for rid, a in assigned.items() if a[0] == org}
        self.rows = [r for r in rows if isinstance(r.get("id"), str) and r["id"] in self.assigned]
        self.read_back: list[dict[str, Any]] = []

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        for r in self.rows:
            rid = r["id"]
            if not codec.fits("text", rid):
                raise ShapeError("file_deliveries: a receipt id no text column can hold")
            _refuse_blobs("file_deliveries", (r[k] for k in DELIVERY_FIELDS))
            _, kind, agent = self.assigned[rid]
            if agent is not None and not codec.fits("text", agent):
                raise ShapeError("file_deliveries: an agent name no text column can hold")
            rec = {"fingerprint": r["fingerprint"]}
            if r["result"] is not None:
                rec["result"] = r["result"]
            codec.encode(FILE_DELIVERY, rec,
                         {"id": rid, "agent_id": None if agent is None else ctx.agent(agent),
                          "evidence": kind}, out, link=FILE_DELIVERIES.link)

    def decode(self, rows, ctx, present, doc) -> None:
        self.read_back = decode_file_deliveries(rows, ctx.names)


def decode_file_deliveries(rows: Mapping[str, list[Mapping[str, Any]]],
                           names: Mapping[int, str]) -> list[dict[str, Any]]:
    """{id, fingerprint, result, evidence, agent} back from ``file_deliveries`` rows, by id."""
    out = []
    for r in sorted(rows.get(FILE_DELIVERY.table, []), key=lambda r: r["id"]):
        rec = codec.decode(FILE_DELIVERY, r, None, (r["id"],))
        # result NULL is a receipt whose copy never finished (the source column's NULL)
        out.append({"id": r["id"], "fingerprint": rec.get("fingerprint", ABSENT),
                    "result": rec.get("result"), "evidence": r["evidence"],
                    "agent": None if r["agent_id"] is None else _name(names, r["agent_id"])})
    return out


def check_file_deliveries(source: list[Mapping[str, Any]],
                          rows: Mapping[str, list[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """[] when ``file_deliveries`` hold exactly the receipts ``source`` (the org's assigned rows,
    {id, fingerprint, result}); else the mismatch."""
    return _compare("side/file_deliveries", source,
                    decode_file_deliveries(rows, _agent_names(rows)), DELIVERY_FIELDS, ("id",))


# ---------------------------------------------------------------- the converter's inputs

def transcript_index(roots: Iterable[str]) -> dict[str, str]:
    """{session id: transcript path} over each root's ``projects/*/<session>.jsonl``: the layout
    of the Claude store and of Orgtree's own journals (supervisor.transcript_index). A session
    id is its file's name, so the first root holding it wins."""
    out: dict[str, str] = {}
    scratch: list[str] = []
    for root in roots:
        proj = os.path.join(root, "projects")
        for d in _names_in(proj, scratch):
            if d.startswith("."):
                continue
            for f in _names_in(os.path.join(proj, d), scratch):
                if f.endswith(".jsonl"):
                    out.setdefault(f[:-len(".jsonl")], os.path.join(proj, d, f))
    return out


_TRASH_MARKER = re.compile(r"(?P<slug>.+)-[0-9]{8}T[0-9]{6}(-[0-9]+)?\.pg\Z")


class SideFiles:
    """The side files and the org-restricted accounts of one data root, for the converter's run
    (``run.SideInputs``). Each file is read once, on first use; nothing under the data root is
    written. Per org (``key(org)``: a trashed org may share its slug with a live one),
    ``sources`` keeps the rows its Sections were given and ``reports`` its side report (rows
    moved, by which evidence, and the rows left)."""

    def __init__(self, data_root: str, *, transcript_roots: Iterable[str] | None = None) -> None:
        self.data_root = data_root
        self._transcript_roots = None if transcript_roots is None else list(transcript_roots)
        self._events: dict[Any, list[dict[str, Any]]] | None = None
        self._deliveries: list[dict[str, Any]] | None = None
        self._restricted: dict[str, dict[str, Any]] | None = None
        self._profiles: list[str] = []
        self._index: dict[str, str] | None = None
        self._file_checks: dict[tuple[str, str, int, str], bool] = {}
        self.sources: dict[str, dict[str, Any]] = {}
        self.reports: dict[str, dict[str, Any]] = {}

    @staticmethod
    def key(org: Any) -> str:
        return f"{org.slug}#{org.org_id}"

    # -- inputs, read once
    def events(self) -> dict[Any, list[dict[str, Any]]]:
        if self._events is None:
            self._events = read_reply_events(os.path.join(self.data_root, REPLY_EVENTS_FILE))
        return self._events

    def deliveries(self) -> list[dict[str, Any]]:
        if self._deliveries is None:
            self._deliveries = read_deliveries(os.path.join(self.data_root, DELIVERIES_FILE))
        return self._deliveries

    def restricted(self) -> dict[str, dict[str, Any]]:
        """{org slug: its part of the accounts registry} (``accounts.split_registry``)."""
        if self._restricted is None:
            from . import accounts                  # noqa: PLC0415
            doc = accounts.read_registry(os.path.join(self.data_root, accounts.REGISTRY_FILE))
            parts = accounts.split_registry(doc) if doc is not None else None
            self._restricted = parts[1] if parts is not None else {}
            self._profiles = accounts.claude_profiles(doc) if doc is not None else []
        return self._restricted

    def transcripts(self, doc: Mapping[str, Any]) -> list[tuple[str, str]]:
        """(node, transcript) for every node of ``doc`` whose session has a transcript in the
        Claude stores this machine uses (each Claude account's profile, ``~/.claude``) or in
        Orgtree's own journals."""
        if self._index is None:
            self.restricted()
            roots = (self._transcript_roots if self._transcript_roots is not None else
                     [*self._profiles, os.path.expanduser("~/.claude"),
                      os.path.join(self.data_root, "journals")])
            self._index = transcript_index(roots)
        nodes = doc.get("nodes") if isinstance(doc.get("nodes"), dict) else {}
        out = []
        for nid, node in nodes.items():
            sid = node.get("session_id") if isinstance(node, dict) else None
            if isinstance(sid, str) and sid in self._index:
                out.append((nid, self._index[sid]))
        return out

    def _orgs_named(self, slug: str) -> int:
        """How many legacy orgs carry ``slug``: a live marker, and every trash marker (a delete
        leaves the scratch folder where it is, so these orgs share one scratch root)."""
        n = int(os.path.exists(os.path.join(self.data_root, "orgs", f"{slug}.pg")))
        for name in _names_in(os.path.join(self.data_root, "deleted"), []):
            m = _TRASH_MARKER.match(name)
            n += bool(m and m.group("slug") == slug)
        return n

    # -- run.SideInputs
    def sections_for(self, org: Any, doc: Mapping[str, Any]) -> list[Section]:
        """The side Sections of one legacy org (``legacy.LegacyOrg``) and its loaded document."""
        from .accounts import OrgAccounts           # noqa: PLC0415
        slug, trashed = org.slug, org.status == "trashed"
        shared = self._orgs_named(slug) > 1
        # a delete clears the org's reply events (store.delete_org): a trashed org has none,
        # and its slug's rows are the live org's
        events = [] if trashed else self.events().get(slug, [])
        scratch = os.path.join(self.data_root, "scratch")
        orgs: dict[str, OrgEvidenceInput] = {}
        for name in _names_in(scratch, []):
            if name != slug and os.path.isdir(os.path.join(scratch, name)):
                orgs[name] = OrgEvidenceInput(scratch_roots=(os.path.join(scratch, name),),
                                              converting=False)
        nodes = doc.get("nodes") if isinstance(doc.get("nodes"), dict) else {}
        lineage = {nid: n.get("seat_id") for nid, n in nodes.items()
                   if isinstance(n, dict) and isinstance(n.get("seat_id"), str)}
        own = (os.path.join(scratch, slug),)
        orgs[slug] = OrgEvidenceInput(scratch_roots=own, lineage=lineage,
                                      transcripts=lambda: self.transcripts(doc))
        if shared:
            # another org of the same name holds this root too: a folder in it names no
            # single org (evidence 1 cannot place it), while a key still recomputes its id
            orgs[f"{slug} (another org of this name)"] = OrgEvidenceInput(
                scratch_roots=own, converting=False)
        report: dict[str, Any] = {}
        rows = self.deliveries()
        assigned = assign_deliveries(rows, orgs, report=report, file_checks=self._file_checks)
        part = self.restricted().get(slug)
        if trashed and os.path.exists(os.path.join(self.data_root, "orgs", f"{slug}.pg")):
            part = None               # the live org of this name is the one that binds them
        accounts = OrgAccounts(part)
        delivered = [r for r in rows if r.get("id") in assigned]
        self.sources[self.key(org)] = {"slug": slug, "reply_events": events,
                                       "file_deliveries": delivered, "org_accounts": accounts.part}
        self.reports[self.key(org)] = {"reply_events": len(events), "file_deliveries": report,
                                       "org_accounts": len(accounts.part["accounts"]),
                                       "org_account_aliases": len(accounts.part["aliases"]),
                                       "org_account_mark_audit": len(accounts.part["mark_audit"])}
        return [ReplyEvents(events), FileDeliveries(slug, rows, assigned), accounts]

    def check(self, org: Any, rows: Mapping[str, list[Mapping[str, Any]]]) -> list[dict[str, Any]]:
        """Mismatches between the side rows read back and their sources ([] when exact)."""
        from .accounts import check_org_accounts    # noqa: PLC0415
        src = self.sources.get(self.key(org), {"reply_events": [], "file_deliveries": [],
                                               "org_accounts": None})
        return (check_reply_events(src["reply_events"], rows)
                + check_file_deliveries(src["file_deliveries"], rows)
                + check_org_accounts(src["org_accounts"], rows))

    def left_over(self, published: Iterable[str]) -> dict[str, Any]:
        """What stays in the old files once the orgs ``published`` (``key(org)`` of each org that
        converted) are in: the reply-event rows by org slug no published org took, and the ids
        of the receipts none took (design §5.2: counted in the report; §5.3: the cleanup
        release keeps a file while it holds such a row)."""
        done = [self.sources[k] for k in published if k in self.sources]
        took_events = {s["slug"] for s in done if s["reply_events"]}
        events = {str(k): len(v) for k, v in self.events().items() if k not in took_events}
        taken = {r["id"] for s in done for r in s["file_deliveries"]}
        return {"reply_events": events,
                "file_deliveries": [r.get("id") for r in self.deliveries()
                                    if r.get("id") not in taken]}


def side_inputs(data_root: str) -> Any:
    """The converter's ``run.SideInputs`` for one data root (``SideFiles``)."""
    from .run import SideInputs                     # noqa: PLC0415
    sf = SideFiles(data_root)
    return SideInputs(sections_for=sf.sections_for, check=sf.check,
                      report_for=lambda org: sf.reports.get(sf.key(org), {}),
                      left_over=lambda orgs: sf.left_over([sf.key(o) for o in orgs]))
