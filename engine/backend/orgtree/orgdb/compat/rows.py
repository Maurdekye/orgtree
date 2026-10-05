"""The five legacy tables, served from an org database (design §6.2 item 3).

store.py thinks in rows of five tables. Here each is a view over the new tables, read and
written through the section mappers and the exact codec:

  doc(key, val)        one row per present top-level key that is not a log or ``nodes``:
                       a settings key (its ``org_settings`` column group), a whole section
                       (asks, audiences, tiers, ...), a key outside the registry
                       (``org_extra``); a split section's container (``"{}"``) and one row per
                       owner (``mail\\x1fowner``); the docket header (``work_items``) and one
                       row per active item (``work_items\\x1f<slug>``). A key whose value is
                       null is the row ``"null"``.
  nodes(id, ord, val)  one row per ``agents`` row that is not a tombstone, by name.
  log_d / log_l        one row per record of a log section. The legacy ``seq`` is
                       ``id * SLOTS + slot``: record ids are per table here, while one legacy
                       seq names one row of a whole legacy table, so the slot (the section's
                       position in store.DICT_LOGS or store.LIST_LOGS) makes it unique.
                       Within a section it orders as the ids do (allocation order, exactly
                       what the legacy sequence gave). ``steer_attempts`` rows are the
                       ``[key, entry]`` pairs of store.KEYED_DICT_LOGS.
  meta(key, val)       ``key_order`` (``org_sections`` by ``ord``), ``owners:<log>``
                       (``org_section_owners``), ``schema_version`` ("1" once the org
                       holds anything; no row for a database nothing has filled, which
                       store refuses as it refuses an empty SQLite file), anything else
                       in ``compat_meta`` (the heal epoch).

Exactness. A row's text is ``store._dumps`` of the decoded value: the same value the legacy
row held (the codec is exact), with an object's keys in spec order. So text is compared as
canonical JSON (sorted keys), never byte for byte: an engine-written text and the text read
back can differ in key order only. ``same()`` is that comparison.

Versions. A doc row's version is the ``org_sections`` row of its key (``xmin:ctid``): every
write of a key here updates that row, so the version changes whenever the text can. A docket
item's version is its ``work_items`` row's ``(xmin, ctid, tableoid)``: every item write
rewrites that row. Nothing else is versioned (store.py versions nothing else).

Positions. A log record appended here takes its own id as its position (``ord``/``idx``):
ids come from a sequence, so concurrent appends never collide on the position indexes,
exactly as the legacy sequence never made two appends conflict.

Concurrency. Every compare-and-set locks the rows it decides on (``FOR UPDATE``) before it
reads them, so a concurrent writer of the same row waits and then compares with the committed
value, as the legacy ``UPDATE ... WHERE val=?`` did. Names become agent ids under a per-name
advisory lock, so one name never gets two rows. An insert that needs its key or node absent
takes that key's (or name's) advisory lock BEFORE it looks, so a second inserter waits for the
first's transaction and then sees its row: nothing (doc) or a duplicate-key refusal (nodes),
as the legacy insert that waited on the uncommitted row got.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

from .. import codec, current_refs, docket_events, mappers
from . import mailboxes as M
from ..codec import Rows, ShapeError
from ..mappers import agents as A
from ..mappers import docket as D
from ..sections import (ByAgentLists, ByAgentMaps, ByAgentRecords, Context, Map, RecordList,
                        Section, Settings, StrList, Table)

SEP = "\x1f"
SLOTS = 64
_INT4_MAX = 2 ** 31 - 1


def dumps(v: Any) -> str:
    """store._dumps."""
    return json.dumps(v, separators=(",", ":"))


def canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def same(a: str | None, b: str | None) -> bool:
    """Do two row texts hold the same value (key order aside)?"""
    if a is None or b is None:
        return a is b
    if a == b:
        return True
    try:
        return canon(json.loads(a)) == canon(json.loads(b))
    except ValueError:
        return False


class CompatError(RuntimeError):
    """A legacy write this view cannot represent (never a silent partial write)."""


def _turns():
    from .. import turns
    return turns


# ----------------------------------------------------------------- the model

@dataclass(frozen=True)
class LogSect:
    name: str
    log: str                 # 'log_d' or 'log_l'
    slot: int
    section: Section
    table: Table
    kind: str                # 'list', 'agent', 'agent_map' or 'archive'


class Model:
    """Which mapper section owns each legacy key, and the log sections' slots."""

    def __init__(self) -> None:
        from ... import store, workrows   # noqa: PLC0415  (compat runs inside the engine)
        self.store = store
        self.workrows = workrows
        self.sections = mappers.sections()
        self.owner: dict[str, Section] = {k: s for s in self.sections for k in s.keys}
        self.settings: Settings = next(s for s in self.sections if isinstance(s, Settings))
        self.settings_keys = frozenset(self.settings.keys)
        self.lazy = frozenset(store.LAZY_SECTIONS)
        self.split = frozenset(store.SPLIT_SECTIONS)
        self.dict_logs = tuple(store.DICT_LOGS)
        self.list_logs = tuple(store.LIST_LOGS)
        self.logs: dict[str, LogSect] = {}
        for log, sects in (("log_d", self.dict_logs), ("log_l", self.list_logs)):
            if len(sects) > SLOTS:
                raise CompatError(f"{log}: more sections than sequence slots")
            for slot, name in enumerate(sects):
                sec = self.owner.get(name)
                if name == "work_items_archive" and isinstance(sec, D.Docket):
                    ls = LogSect(name, log, slot, sec, D.WORK_ITEMS, "archive")
                elif log == "log_l" and isinstance(sec, RecordList):
                    ls = LogSect(name, log, slot, sec, sec.t, "list")
                elif log == "log_d" and isinstance(sec, ByAgentLists) \
                        and name not in store.KEYED_DICT_LOGS:
                    ls = LogSect(name, log, slot, sec, sec.t, "agent")
                elif log == "log_d" and isinstance(sec, ByAgentMaps) \
                        and name in store.KEYED_DICT_LOGS:
                    ls = LogSect(name, log, slot, sec, sec.t, "agent_map")
                else:
                    raise CompatError(f"log section {name!r} has no mapper the view can serve")
                self.logs[name] = ls
        self.by_slot = {(ls.log, ls.slot): ls for ls in self.logs.values()}
        for name in self.split:
            if not isinstance(self.owner.get(name), ByAgentLists):
                raise CompatError(f"split section {name!r} is not a by-agent list section")


_MODEL: list[Model] = []


def model() -> Model:
    if not _MODEL:
        _MODEL.append(Model())
    return _MODEL[0]


_LAYOUTS: dict[int, dict[str, dict[str, Any]]] = {}


def lay(t: Table) -> dict[str, dict[str, Any]]:
    got = _LAYOUTS.get(id(t))
    if got is None:
        got = _LAYOUTS[id(t)] = t.layout()
    return got


# ----------------------------------------------------------------- SQL helpers

def dict_rows(c: Any, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    from psycopg.rows import dict_row   # noqa: PLC0415
    with c.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


_COLUMNS: dict[str, list[str]] = {}


def _columns(c: Any, table: str) -> list[str]:
    """A table's columns, in order (cached: the schema is fixed for the process)."""
    got = _COLUMNS.get(table)
    if got is None:
        got = [str(r[0]) for r in c.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'orgtree' "
            "AND table_name = %s ORDER BY ordinal_position", (table,)).fetchall()]
        _COLUMNS[table] = got
    return got


def fetch(c: Any, t: Table, where: str = "true", params: Sequence[Any] = (), *,
          order: str = "id", lock: bool = False, limit: int | None = None,
          offset: int = 0, exclude: Sequence[str] = ()) -> tuple[list[dict[str, Any]], codec.Children]:
    """The record rows of ``t`` that ``where`` selects, with every descendant row. Columns named
    in ``exclude`` are not read at all (their fields decode as absent)."""
    layout = lay(t)
    main = t.spec.table
    page = (f" LIMIT {int(limit)}" if limit is not None else "") + (
        f" OFFSET {int(offset)}" if offset else "")
    if not exclude:
        pick = "*"
    else:
        # an excluded field of another shape is kept in extra: it is removed there too, by the
        # server, so its value never travels either (the names are code's own field keys)
        cols = [col for col in _columns(c, main) if col not in set(exclude)]
        keys = ", ".join("'" + k.replace("'", "''") + "'" for k in exclude)
        pick = ", ".join(f"(extra::jsonb - ARRAY[{keys}]::text[])::json AS extra" if col == "extra"
                         else codec.quote(col) for col in cols)
    rows = dict_rows(c, f"SELECT {pick}, xmin::text AS _xmin, ctid::text AS _ctid, "
                        f"tableoid::text AS _tableoid FROM orgtree.{main} WHERE {where} "
                        f"ORDER BY {order}{page}{' FOR UPDATE' if lock else ''}", params)
    children: dict[str, list[dict[str, Any]]] = {}
    if rows and len(layout) > 1:
        ((old, new),) = t.link.items()
        keys = [r[old] for r in rows]
        for name in layout:
            if name != main:
                children[name] = dict_rows(
                    c, f"SELECT * FROM orgtree.{name} WHERE {codec.quote(new)} = ANY(%s)", (keys,))
    return rows, codec.Children(children, layout)


def insert(c: Any, table: str, rows: list[dict[str, Any]], *, override: bool = False) -> None:
    if not rows:
        return
    cols = list(rows[0])
    colset = set(cols)
    for r in rows:
        if set(r) != colset:
            raise CompatError(f"{table}: rows with different columns")
    ov = "OVERRIDING SYSTEM VALUE " if override else ""
    sql = (f"INSERT INTO orgtree.{table} ({codec.quoted(cols)}) {ov}"
           f"VALUES ({', '.join(['%s'] * len(cols))})")
    with c.cursor() as cur:
        cur.executemany(sql, [tuple(r[k] for k in cols) for r in rows])


_SEQS: dict[str, str] = {}


def new_ids(c: Any, table: str, n: int) -> list[int]:
    if n <= 0:
        return []
    seq = _SEQS.get(table)
    if seq is None:
        seq = c.execute("SELECT pg_get_serial_sequence(%s, 'id')", (f"orgtree.{table}",)).fetchone()[0]
        if seq is None:
            raise CompatError(f"{table} has no id sequence")
        _SEQS[table] = seq
    return [int(r[0]) for r in c.execute("SELECT nextval(%s) FROM generate_series(1, %s)",
                                         (seq, n)).fetchall()]


def store_encoded(c: Any, t: Table, out: Rows, *, ids: Sequence[int] | None = None,
                  place: Callable[[dict[str, Any], int], None] | None = None) -> list[int]:
    """Insert ``t``'s rows from ``out`` (codec.encode output, provisional ids) under fresh
    ids (or ``ids``); ``place(row, id)`` may set placement columns from the final id."""
    main = t.spec.table
    mrows = out.get(main, [])
    final = list(ids) if ids is not None else new_ids(c, main, len(mrows))
    ((old, new),) = t.link.items()
    remap: dict[Any, Any] = {}
    for r, nid in zip(mrows, final):
        remap[r[old]] = nid
        r[old] = nid
        if place is not None:
            place(r, nid)
    insert(c, main, mrows, override=True)
    id_maps = {main: remap}
    for name in lay(t):
        if name == main:
            continue
        rs = out.get(name, [])
        for r in rs:
            r[new] = remap[r[new]]
        entry = lay(t)[name]
        for parent_column, reference_column in zip(entry['parent_cols'], entry['ref_cols']):
            if parent_column != new and reference_column == 'id':
                parent_map = id_maps.get(entry['parent_table'])
                if parent_map is not None:
                    for r in rs:
                        r[parent_column] = parent_map[r[parent_column]]
        # Normalized item children have their own surrogate identity. Whole
        # section replacement allocates it in the database's global sequence.
        if rs and 'id' in rs[0]:
            child_map = id_maps[name] = {}
            for r, child_id in zip(rs, new_ids(c, name, len(rs))):
                child_map[r['id']] = child_id
                r['id'] = child_id
        insert(c, name, rs, override=bool(rs and 'id' in rs[0]))
    return final


def savepoint_retry(c: Any, fn: Callable[[], Any], *, tries: int = 6) -> Any:
    """``fn`` inside a savepoint, retried on a unique violation (a concurrent writer took the
    position this one computed; the retry sees its commit)."""
    import psycopg   # noqa: PLC0415
    for i in range(tries):
        try:
            with c.transaction():
                return fn()
        except psycopg.errors.UniqueViolation:
            if i == tries - 1:
                raise


# ----------------------------------------------------------------- agent names

class Names:
    """Agent ids and names for one statement (one transaction), and that statement's memo
    of values several of its rows share (the settings row)."""

    def __init__(self, c: Any) -> None:
        self.c = c
        self.by_name: dict[str, int] = {}
        self.by_id: dict[int, str] = {}
        self.memo: dict[str, Any] = {}

    def _find(self, name: str) -> int | None:
        row = self.c.execute("SELECT id FROM orgtree.agents WHERE name = %s "
                             "ORDER BY tombstone, id LIMIT 1", (name,)).fetchone()
        return None if row is None else int(row[0])

    def lock(self, name: str) -> None:
        self.c.execute("SELECT pg_advisory_xact_lock(hashtext('orgdb-agent-name'), hashtext(%s))",
                       (name,))

    def id(self, name: str, *, mint: bool = True) -> int | None:
        got = self.by_name.get(name)
        if got is not None:
            return got
        aid = self._find(name)
        if aid is None and mint:
            if not codec.fits("text", name):
                raise ShapeError(f"an agent name no text column can hold: {name!r}")
            self.lock(name)
            aid = self._find(name)
            if aid is None:
                aid = int(self.c.execute("INSERT INTO orgtree.agents (name, tombstone) "
                                         "VALUES (%s, true) RETURNING id", (name,)).fetchone()[0])
                from .. import docket_locks
                docket_locks.created(self.c, aid)
        if aid is None:
            return None
        self.by_name[name] = aid
        self.by_id[aid] = name
        return aid

    def load(self, ids: Iterable[Any]) -> None:
        want = sorted({int(i) for i in ids if i is not None and int(i) not in self.by_id})
        if want:
            for i, n in self.c.execute("SELECT id, name FROM orgtree.agents WHERE id = ANY(%s)",
                                       (want,)).fetchall():
                self.by_id[int(i)] = str(n)
                self.by_name.setdefault(str(n), int(i))

    def name(self, aid: int) -> str:
        if aid not in self.by_id:
            self.load((aid,))
        return self.by_id[aid]

    def current_record(self, name: str) -> Mapping[str, Any] | None:
        rows = dict_rows(self.c, 'SELECT id,name,tombstone,lineage_born,generation,extra '
                                'FROM orgtree.agents WHERE name=%s AND NOT tombstone', (name,))
        return agent_identity(rows[0]) if rows else None

    def current_tombstone(self, ref: current_refs.Reference) -> int:
        def find():
            return self.c.execute("SELECT id FROM orgtree.agents WHERE name=%s AND tombstone "
                                  "AND state='deleted' AND lineage_born=%s AND generation=%s "
                                  "ORDER BY id LIMIT 1", ref.stamp).fetchone()
        row = find()
        if row is not None:
            return int(row[0])
        self.lock(ref.name)
        row = find()
        if row is not None:
            return int(row[0])
        aid = new_ids(self.c, 'agents', 1)[0]
        out: Rows = {}
        A.encode_tombstone(ref.name, aid, ref.tombstone_record(), out)
        insert(self.c, 'agents', out['agents'])
        from .. import docket_locks
        docket_locks.created(self.c, aid)
        self.by_id[aid] = ref.name
        return aid

    def current(self, value: Any, previous: Any = codec.MISSING,
                previous_id: int | None = None) -> int | None:
        return current_refs.Resolver(self.current_record, self.current_tombstone)(value, previous, previous_id)


def agent_identity(row: Mapping[str, Any]) -> dict[str, Any]:
    """Decode the selected identity header, including exceptional original values."""
    spec = codec.Spec('agents', tuple(A.HOT.field(k) for k in ('seat_id', 'generation')))
    extra = codec.from_column('json', row['extra']) if row.get('extra') is not None else {}
    selected = dict(row, extra=codec.to_column('json', {k: extra[k] for k in ('seat_id', 'generation') if k in extra}))
    return dict(codec.decode(spec, selected, None), id=row['id'], name=row.get('name'),
                tombstone=row.get('tombstone', False))


class DbContext(Context):
    """A mapper Context whose names are the org database's agent rows."""

    def __init__(self, names: Names) -> None:
        super().__init__()
        self._names = names

    def agent(self, name: str) -> int:
        aid = self._names.id(name, mint=True)
        assert aid is not None
        return aid

    def name(self, agent_id: int) -> str:
        return self._names.name(agent_id)

    def current(self, value: Any, previous: Any = codec.MISSING,
                previous_id: int | None = None) -> int | None:
        return self._names.current(value, previous, previous_id)


@dataclass
class Tx:
    """Per-transaction state of one connection (cleared at COMMIT and ROLLBACK)."""
    #: docket header positions of items not inserted yet: {slug: ord}
    item_ord: dict[str, int] = field(default_factory=dict)
    docket_touched: bool = False
    # Explicit save handoff: validated once before in-place agent-name updates.
    rename_checked: dict[str, str] = field(default_factory=dict)
    rename_nodes: set[str] = field(default_factory=set)


def docket_pending(c: Any) -> dict[str, Any]:
    """Savepoint-aware state for this transaction's transitional docket moves.

    PostgreSQL restores a local setting on savepoint/full rollback. A Python
    dict alone would retain a delete from a savepoint the caller rolled back.
    """
    text = c.execute("SELECT current_setting('orgtree.compat_docket_pending',true)").fetchone()[0]
    return json.loads(text) if text else {'deleted':[], 'moved':{}}


def _docket_pending_put(c: Any, tx: Tx, value: Mapping[str, Any]) -> None:
    tx.docket_touched = True
    c.execute("SELECT set_config('orgtree.compat_docket_pending',%s,true)", (dumps(value),))


def docket_finish(c: Any, tx: Tx) -> None:
    """Apply unmatched permanent deletes, in the same commit as every move."""
    if not tx.docket_touched:
        return
    state = docket_pending(c)
    if state['deleted']:
        c.execute("DELETE FROM orgtree.work_items WHERE id=ANY(%s)", (state['deleted'],))
    if state['moved']:
        raise CompatError('docket reopen left its original archive row unremoved')
    _docket_pending_put(c,tx,{'deleted':[], 'moved':{}})


# ----------------------------------------------------------------- org_sections

def sections_rows(c: Any) -> list[tuple[str, int, str, str]]:
    """(key, ord, state, version) of every present top-level key, in order."""
    return [(str(k), int(o), str(s), str(v)) for k, o, s, v in c.execute(
        "SELECT key, ord, state, xmin::text || ':' || ctid::text FROM orgtree.org_sections "
        "ORDER BY ord").fetchall()]


def section_row(c: Any, key: str, *, lock: bool = False) -> tuple[int, str, str] | None:
    row = c.execute("SELECT ord, state, xmin::text || ':' || ctid::text FROM orgtree.org_sections "
                    f"WHERE key = %s{' FOR UPDATE' if lock else ''}", (key,)).fetchone()
    return None if row is None else (int(row[0]), str(row[1]), str(row[2]))


def ensure_section(c: Any, key: str, state: str = "v", *, touch: bool = True) -> None:
    """The key is present (appended at the end when new). ``touch`` rewrites an existing row,
    so its version changes; a log append passes False, so appenders never queue on it."""
    if touch:
        n = c.execute("UPDATE orgtree.org_sections SET state = %s WHERE key = %s",
                      (state, key)).rowcount
        if n:
            return

    def add() -> None:
        c.execute("INSERT INTO orgtree.org_sections (key, ord, state) SELECT %s, "
                  "coalesce(max(ord), -1) + 1, %s FROM orgtree.org_sections "
                  "ON CONFLICT (key) DO NOTHING", (key, state))
    savepoint_retry(c, add)


def drop_section(c: Any, key: str) -> None:
    c.execute("DELETE FROM orgtree.org_sections WHERE key = %s", (key,))


def has_data(c: Any, key: str) -> bool:
    m = model()
    if key == "nodes":
        return c.execute("SELECT EXISTS (SELECT 1 FROM orgtree.agents WHERE NOT tombstone)"
                         ).fetchone()[0]
    ls = m.logs.get(key)
    if ls is None:
        return True
    return log_has(c, ls) or bool(c.execute(
        "SELECT EXISTS (SELECT 1 FROM orgtree.org_section_owners WHERE section = %s)",
        (key,)).fetchone()[0])


def key_order_text(c: Any) -> str:
    """meta ``key_order``: as the engine last wrote it, else (a converted org nobody has
    saved yet) the converted order."""
    row = c.execute("SELECT val FROM orgtree.compat_meta WHERE key = 'key_order'").fetchone()
    if row is not None:
        return str(row[0])
    return dumps([k for k, _, _, _ in sections_rows(c)])


def set_key_order(c: Any, text: str) -> None:
    """meta ``key_order`` written. Like the legacy meta row it is one value, kept as written
    (serialized by an advisory lock, never by locking every key's row, which concurrent
    saves of single keys hold). Presence follows the legacy loader: a log section or
    ``nodes`` it names is present, an empty one included; one it leaves out stays present
    only while it holds rows. Any other key is present exactly while its doc row is."""
    m = model()
    order = json.loads(text)
    if not isinstance(order, list) or not all(isinstance(k, str) for k in order):
        raise CompatError("meta key_order is not a list of keys")
    c.execute("SELECT pg_advisory_xact_lock(hashtext('orgdb-key-order'))")
    c.execute("INSERT INTO orgtree.compat_meta (key, val) VALUES ('key_order', %s) "
              "ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val", (text,))
    lazyish = m.lazy | {"nodes"}
    present = {k for k, _, _, _ in sections_rows(c)}
    listed = set(order)
    for k in order:
        if k in lazyish and k not in present:
            ensure_section(c, k, touch=False)
    for k in sorted(present - listed):
        if k in lazyish and not has_data(c, k):
            drop_section(c, k)


# ----------------------------------------------------------------- whole sections

def _section_tables(sec: Section) -> list[str]:
    out: list[str] = []
    for t in sec.tables:
        out.extend(lay(t))
    return out


def section_value(c: Any, sec: Section, key: str, names: Names) -> Any:
    """The decoded value of ``key``, a whole-section key (a record list, a map, a by-agent
    doc section, a string list)."""
    rows: dict[str, list[dict[str, Any]]] = {}
    for name in _section_tables(sec):
        rows[name] = dict_rows(c, f"SELECT * FROM orgtree.{name}")
    if isinstance(sec, (ByAgentLists, ByAgentRecords, ByAgentMaps)):
        rows["org_section_owners"] = dict_rows(
            c, "SELECT * FROM orgtree.org_section_owners WHERE section = %s", (key,))
        names.load(r["agent_id"] for r in rows["org_section_owners"])
    out: dict[str, Any] = {}
    sec.decode(rows, DbContext(names), [key], out)
    return out.get(key)


def section_clear(c: Any, sec: Section, key: str, *, tx: Tx | None = None) -> None:
    if isinstance(sec,D.Docket):
        _docket_section_put(c,key,[],tx)
        return
    if key == 'turn_log':
        ids = [r[0] for r in c.execute('SELECT id FROM orgtree.agent_turns '
                                       'WHERE idx IS NOT NULL').fetchall()]
        _turns().remove_log(c, ids)
        c.execute('DELETE FROM orgtree.org_section_owners WHERE section=%s', (key,))
        return
    for t in sec.tables:
        c.execute(f"DELETE FROM orgtree.{t.spec.table}")      # children cascade
    if isinstance(sec, (ByAgentLists, ByAgentRecords, ByAgentMaps)):
        c.execute("DELETE FROM orgtree.org_section_owners WHERE section = %s", (key,))


def section_put(c: Any, sec: Section, key: str, value: Any, names: Names,
                *, tx: Tx | None = None) -> None:
    """Replace a whole-section key's records with ``value``'s."""
    if isinstance(sec,D.Docket):
        _docket_section_put(c,key,value,tx)
        return
    if key == 'turn_log':
        _turn_section_put(c, value, names)
        return
    section_clear(c, sec, key)
    if value is None:
        return
    out: Rows = {"org_section_owners": []}
    sec.encode({key: value}, DbContext(names), out)
    for t in sec.tables:
        if "id" in dict(t.keys):
            store_encoded(c, t, out)
        else:
            for name in lay(t):
                insert(c, name, out.get(name, []))
    insert(c, "org_section_owners", out.get("org_section_owners", []))


def _turn_section_put(c: Any, value: Any, names: Names) -> None:
    """Whole-log replacement changes only log membership, including null owners."""
    if value is not None and (not isinstance(value, dict) or any(records is not None and
            (not isinstance(records, list) or not all(isinstance(r, dict) for r in records))
            for records in value.values())):
        raise ShapeError('turn_log: expected an object of record lists or nulls')
    ls = model().logs['turn_log']
    aids = [names.id(owner, mint=True) for owner in value or {}]
    aids += [row[0] for row in c.execute('SELECT DISTINCT agent_id FROM orgtree.agent_turns '
                                        'WHERE idx IS NOT NULL').fetchall()]
    _turns().lock_agents(c, aids)
    section_clear(c, ls.section, ls.name)
    for position, (owner, records) in enumerate((value or {}).items()):
        aid = names.id(owner, mint=True)
        c.execute('INSERT INTO orgtree.org_section_owners(section,agent_id,ord,state) '
                  'VALUES (%s,%s,%s,%s)', ('turn_log', aid, position, 'n' if records is None else 'l'))
        for record in records or []:
            log_insert(c, ls, owner, dumps(record), names)


# ----------------------------------------------------------------- settings

def settings_record(c: Any, *, lock: bool = False) -> dict[str, Any] | None:
    m = model()
    rows = dict_rows(c, f"SELECT * FROM orgtree.org_settings{' FOR UPDATE' if lock else ''}")
    if not rows:
        return None
    return codec.decode(m.settings.spec, rows[0], None, (True,))


def settings_put(c: Any, key: str, value: Any, *, delete: bool = False) -> None:
    """Set (or remove) one settings key, read-modify-write under the row's lock."""
    m = model()
    rec = settings_record(c, lock=True)
    exists = rec is not None
    rec = dict(rec or {})
    if delete:
        rec.pop(key, None)
    else:
        rec[key] = value
    out: Rows = {}
    codec.encode(m.settings.spec, rec, {"singleton": True}, out, link=m.settings.t.link)
    row = out[m.settings.spec.table][0]
    if exists:
        cols = [k for k in row if k != "singleton"]
        c.execute(f"UPDATE orgtree.org_settings SET ({codec.quoted(cols)}) = ROW("
                  f"{', '.join(['%s'] * len(cols))})", [row[k] for k in cols])
    else:
        insert(c, m.settings.spec.table, [row])


# ----------------------------------------------------------------- doc keys

def kind_of(key: str) -> tuple[str, str, str]:
    """('key', key, '') | ('owner', section, owner) | ('item', 'work_items', slug)."""
    m = model()
    sect, sep, rest = key.partition(SEP)
    if not sep:
        return "key", key, ""
    if sect in m.split:
        return "owner", sect, rest
    if sect == m.workrows.SECTION:
        return "item", sect, rest
    raise CompatError(f"doc row {key!r}: no such row form in this view")


def key_has_row(key: str, state: str) -> bool:
    """Does a present plain key have a doc row (without reading its value)?"""
    return state == "n" or (key != "nodes" and key not in model().lazy)


def key_text(c: Any, key: str, state: str, names: Names) -> str | None:
    """The doc row of plain key ``key`` (present, with ``state``), or None when the key has
    no doc row (a log section or ``nodes``, held as rows)."""
    m = model()
    if state == "n":
        return "null"
    if key == "nodes" or key in m.lazy:
        return None
    if key in m.split:
        st = {s for (s,) in c.execute("SELECT DISTINCT state FROM orgtree.org_section_owners "
                                      "WHERE section = %s", (key,)).fetchall()}
        if st <= {"l"}:
            return "{}"
        return dumps(section_value(c, m.owner[key], key, names))
    if key == m.workrows.SECTION:
        return m.workrows.header([s for s, _ in active_items(c)])
    sec = m.owner.get(key)
    if sec is None:
        row = c.execute("SELECT val FROM orgtree.org_extra WHERE key = %s", (key,)).fetchone()
        return None if row is None else dumps(row[0])
    if sec is m.settings:
        # every settings key is one column group of the same row: decode it once per statement
        if "settings" not in names.memo:
            names.memo["settings"] = settings_record(c) or {}
        rec = names.memo["settings"]
        return dumps(rec[key]) if key in rec else None
    return dumps(section_value(c, sec, key, names))


def doc_rows(c: Any, keys: Iterable[str] | None = None, *, names: Names | None = None,
             with_items: bool = False) -> dict[str, tuple[str, str]]:
    """{doc key: (version, text)} of the plain keys (all, or ``keys``); with ``with_items``
    also every owner row and docket item row."""
    names = names or Names(c)
    want = None if keys is None else set(keys)
    out: dict[str, tuple[str, str]] = {}
    for key, _, state, version in sections_rows(c):
        if want is not None and key not in want:
            continue
        text = key_text(c, key, state, names)
        if text is not None:
            out[key] = (version, text)
    if with_items:
        for sect in model().split:
            for owner, (version, text) in owner_rows(c, sect, names=names).items():
                out[sect + SEP + owner] = (version, text)
        for slug, (version, text) in items(c).items():
            out[model().workrows.PREFIX + slug] = (version, text)
    return out


def lock_doc_key(c: Any, key: str) -> None:
    """Serialise the writers of one doc key until the transaction ends (an advisory lock:
    a key that is absent has no row to lock)."""
    c.execute("SELECT pg_advisory_xact_lock(hashtext('orgdb-doc-key'), hashtext(%s))", (key,))


#: the one fence of every settings key: they share one row (org_settings), so a fence per key
#: would let two writers take each other's keys in opposite orders around that row. It starts
#: with SEP, which no plain key does, and holds no NUL (PostgreSQL text cannot)
SETTINGS_FENCE = "\x1fsettings"


def fence_key(key: str, *, creating: bool) -> str | None:
    """The advisory fence a writer of doc key ``key`` takes first, or None (review f21).

    A legacy doc key is one row, so every writer that can create it (an insert that does
    nothing on conflict, an upsert) waited for the other on that row's unique key. Here a
    key's value is many rows, so those writers take this fence before they decide the key is
    absent or write it, and the second one sees the first's commit. A split owner's fence is
    its ``org_section_owners`` row, which ``owner_put`` claims first: None. A settings key's
    fence is SETTINGS_FENCE, taken by its every writer, since they all lock the one settings
    row after it. A writer that cannot create a key (a compare-and-set update or delete)
    takes no fence for other keys: it locks the key's existing rows, as the legacy statement
    locked its row (a docket header write locks every item row, so an item fence taken after
    that by a compare-and-set could deadlock)."""
    kind, _, _ = kind_of(key)
    if kind == "owner":
        return None
    if kind == "key" and model().owner.get(key) is model().settings:
        return SETTINGS_FENCE
    return key if creating else None


def fence(c: Any, key: str, *, creating: bool) -> None:
    got = fence_key(key, creating=creating)
    if got is not None:
        lock_doc_key(c, got)


def doc_get(c: Any, key: str, *, names: Names | None = None,
            lock: bool = False) -> tuple[str, str] | None:
    """(version, text) of one doc row, or None."""
    names = names or Names(c)
    kind, sect, rest = kind_of(key)
    if kind == "owner":
        return owner_row(c, sect, rest, names=names, lock=lock)
    if kind == "item":
        got = item(c, rest, lock=lock)
        return None if got is None else (":".join(got[0]), got[1])
    row = section_row(c, key, lock=lock)
    if row is None:
        return None
    text = key_text(c, key, row[1], names)
    return None if text is None else (row[2], text)


def doc_put(c: Any, tx: Tx, key: str, text: str, names: Names) -> None:
    """Write one doc row (insert or replace), no comparison.

    A plain key's ``org_sections`` row is written FIRST, before its records: it is the row
    an org_tx's lock plan and every compare-and-set lock for that key, so a writer that
    finds it locked waits there holding nothing else, as the legacy writer waited on the one
    doc row (writing the records first could hold them while waiting, and deadlock)."""
    m = model()
    docket_prepare_doc(c, key, text)
    kind, sect, rest = kind_of(key)
    value = json.loads(text)
    if kind == "owner":
        owner_put(c, sect, rest, value, names)
        return
    if kind == "item":
        item_put(c, tx, rest, value)
        return
    if key == "nodes" or key in m.lazy:
        if value is not None:
            raise CompatError(f"{key!r} as one value of the wrong shape: the org database "
                              "holds it only as rows")
        ensure_section(c, key, "n")
        return
    if key in m.split:
        if isinstance(value, dict) and all(isinstance(v, list) for v in value.values()):
            if value:
                raise CompatError(f"{key!r}: a container row with owners in it")
            ensure_section(c, key, "v")          # the split form's container
            return
        ensure_section(c, key, "n" if value is None else "v")
        section_put(c, m.owner[key], key, value, names)
        return
    if key == m.workrows.SECTION:
        ensure_section(c, key, "v")
        header_put(c, tx, text)
        return
    sec = m.owner.get(key)
    if sec is m.settings:
        ensure_section(c, key, "v")
        settings_put(c, key, value)
    elif sec is None:
        if value is not None and not codec.fits("json", value):
            raise ShapeError(f"{key}: a value no JSON column can hold")
        ensure_section(c, key, "n" if value is None else "v")
        if value is None:
            c.execute("DELETE FROM orgtree.org_extra WHERE key = %s", (key,))
        else:
            c.execute("INSERT INTO orgtree.org_extra (key, val) VALUES (%s, %s) "
                      "ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val",
                      (key, codec.to_column("json", value)))
    else:
        ensure_section(c, key, "n" if value is None else "v")
        section_put(c, sec, key, value, names)


def doc_delete(c: Any, key: str, names: Names, *, tx: Tx | None = None) -> int:
    """Delete one doc row; the number of rows deleted (0 or 1)."""
    m = model()
    kind, sect, rest = kind_of(key)
    if kind == "owner":
        aid = names.id(rest, mint=False)
        if aid is None:
            return 0
        n = c.execute("DELETE FROM orgtree.org_section_owners WHERE section = %s AND agent_id = %s "
                      "AND state = 'l'", (sect, aid)).rowcount
        if n:
            c.execute(f"DELETE FROM orgtree.{m.owner[sect].t.spec.table} WHERE agent_id = %s", (aid,))
        return int(n)
    if kind == "item":
        assert tx is not None
        state = docket_pending(c)
        row = c.execute("SELECT id FROM orgtree.work_items WHERE slug=%s AND list_key='active' "
                        "FOR UPDATE", (rest,)).fetchone()
        if row is None or row[0] in state['deleted']:
            return 0
        state['deleted'].append(row[0])
        _docket_pending_put(c,tx,state)
        return 1
    row = section_row(c, key, lock=True)
    if row is None:
        return 0
    if key == "nodes" or key in m.lazy:
        if row[1] != "n":
            return 0                     # held as rows: there is no doc row to delete
        c.execute("UPDATE orgtree.org_sections SET state = 'v' WHERE key = %s", (key,))
        return 1
    if key in m.split or key == m.workrows.SECTION:
        # the container or the header only: each owner or item row is deleted by its own
        # statement (an owner left behind has no container and is not loaded)
        drop_section(c, key)
        return 1
    sec = m.owner.get(key)
    if sec is m.settings:
        settings_put(c, key, None, delete=True)
    elif sec is None:
        c.execute("DELETE FROM orgtree.org_extra WHERE key = %s", (key,))
    else:
        section_clear(c, sec, key)
    drop_section(c, key)
    return 1


# ----------------------------------------------------------------- split owners

def _owner_table(sect: str) -> Table:
    sec = model().owner[sect]
    assert isinstance(sec, ByAgentLists)
    return sec.t


def owner_rows(c: Any, sect: str, owners: Iterable[str] | None = None, *,
               names: Names | None = None, lock: bool = False) -> dict[str, tuple[str, str]]:
    """{owner: (version, text)} of a split section's owner rows (all, or ``owners``)."""
    names = names or Names(c)
    t = _owner_table(sect)
    params: list[Any] = [sect]
    where = ""
    if owners is not None:
        ids = [i for i in (names.id(o, mint=False) for o in owners) if i is not None]
        if not ids:
            return {}
        where = " AND agent_id = ANY(%s)"
        params.append(ids)
    heads = c.execute("SELECT agent_id, xmin::text || ':' || ctid::text FROM "
                      f"orgtree.org_section_owners WHERE section = %s AND state = 'l'{where}"
                      f"{' FOR UPDATE' if lock else ''}", params).fetchall()
    if not heads:
        return {}
    ids = [int(a) for a, _ in heads]
    names.load(ids)
    rows, ch = fetch(c, t, "agent_id = ANY(%s)" +
                    (' AND idx IS NOT NULL' if sect == 'turn_log' else ''),
                    (ids,), order="agent_id, idx")
    by: dict[int, list[Any]] = {i: [] for i in ids}
    for r in rows:
        by[int(r["agent_id"])].append(codec.decode(t.spec, r, ch, (r["id"],)))
    return {names.name(a): (v, dumps(by[int(a)])) for a, v in heads}


def owner_row(c: Any, sect: str, owner: str, *, names: Names | None = None,
              lock: bool = False) -> tuple[str, str] | None:
    return owner_rows(c, sect, (owner,), names=names, lock=lock).get(owner)


def owner_put(c: Any, sect: str, owner: str, value: Any, names: Names) -> None:
    if not isinstance(value, list):
        raise CompatError(f"{sect}[{owner!r}] as an owner row must be a list")
    t = _owner_table(sect)
    aid = names.id(owner, mint=True)
    if sect == 'turn_log':
        _turns().lock_agents(c, [aid])
        c.execute("INSERT INTO orgtree.org_section_owners (section,agent_id,ord,state) "
                  "SELECT %s,%s,coalesce(max(ord),-1)+1,'l' FROM orgtree.org_section_owners "
                  "WHERE section=%s ON CONFLICT(section,agent_id) DO UPDATE SET state='l'",
                  (sect, aid, sect))
        ls = model().logs[sect]
        log_scope_delete(c, ls, aid)
        for record in value:
            log_insert(c, ls, owner, dumps(record), names)
        return
    out: Rows = {}
    for i, rec in enumerate(value):
        if not isinstance(rec, dict):
            raise ShapeError(f"{sect}[{owner!r}][{i}]: expected an object")
        codec.encode(t.spec, rec, {"id": i + 1, "agent_id": aid, "idx": i}, out, link=t.link)

    def add() -> None:
        c.execute("INSERT INTO orgtree.org_section_owners (section, agent_id, ord, state) "
                  "SELECT %s, %s, coalesce(max(ord), -1) + 1, 'l' FROM orgtree.org_section_owners "
                  "WHERE section = %s ON CONFLICT (section, agent_id) DO UPDATE SET state = 'l'",
                  (sect, aid, sect))
    # the owner row first: it is this key's fence (review f21). A concurrent writer of the
    # same owner, an upsert or an insert that does nothing on conflict, waits here for this
    # transaction, and its own records' delete then sees this one's commit, as the legacy
    # writers waited on the one doc row
    savepoint_retry(c, add)
    c.execute(f"DELETE FROM orgtree.{t.spec.table} WHERE agent_id = %s", (aid,))
    store_encoded(c, t, out)


# ----------------------------------------------------------------- the docket

def docket_prepare_doc(c: Any, key: str, text: str | None = None) -> None:
    """Agent tier before an item CAS, fence or whole archive section write."""
    from .. import docket_locks
    kind, _, slug = kind_of(key)
    if kind == 'item':
        docket_locks.prepare(c, [json.loads(text)] if text is not None else (), slugs=(slug,))
    elif key == 'work_items_archive':
        value = json.loads(text) if text is not None else None
        docket_locks.prepare(c, value if isinstance(value, list) else (), list_key='archive')
    elif key == 'work_items' and docket_locks.plan(c) is None:
        # A standalone header can lock item rows before later item statements.
        # Managed saves already installed their complete set of changed roles.
        docket_locks.prepare(c, list_key='active')


def _docket_section_put(c: Any, key: str, value: Any, tx: Tx | None) -> None:
    """A whole docket list still uses stable parent/event writers.

    The normal store dispatches the active header/items and archive log rows
    separately. This section boundary also keeps a mapper-level replacement
    from deleting every parent (including the other list) and recreating it.
    """
    records = [] if value is None else value
    if not isinstance(records,list) or not all(isinstance(r,dict) for r in records):
        raise ShapeError(f"{key}: expected a list of objects")
    slugs = [model().workrows.slug_of(record) for record in records]
    if len(slugs)!=len(set(slugs)):
        raise ShapeError(f"{key}: duplicate work-item slug")
    from .. import docket_locks
    docket_locks.prepare(c, records, list_key='archive' if key=='work_items_archive' else 'active')
    own_tx = tx is None
    tx = tx or Tx()
    if key=='work_items_archive':
        archive = model().logs[key]
        log_scope_delete(c,archive,tx=tx)
        for record in records:
            log_insert(c,archive,None,dumps(record),Names(c),tx=tx)
    else:
        rows = c.execute("SELECT id,slug FROM orgtree.work_items WHERE list_key='active' FOR UPDATE").fetchall()
        state = docket_pending(c)
        state['deleted'] = list(set(state['deleted']) | {rid for rid,slug in rows if slug not in slugs})
        _docket_pending_put(c,tx,state)
        header_put(c,tx,model().workrows.header(slugs))
        for record in records:
            item_put(c,tx,record['slug'],record)
    if own_tx:
        docket_finish(c,tx)


def active_items(c: Any) -> list[tuple[str, tuple[str, str, str]]]:
    """(slug, (xmin, ctid, tableoid)) of the active items, in docket order."""
    deleted = docket_pending(c)['deleted']
    return [(str(s), (str(x), str(t), str(o))) for s, x, t, o in c.execute(
        "SELECT slug, xmin::text, ctid::text, tableoid::text FROM orgtree.work_items "
        "WHERE list_key = 'active' AND id<>ALL(%s::bigint[]) ORDER BY ord", (deleted,)).fetchall()]


def items(c: Any, slugs: Iterable[str] | None = None, *,
          lock: bool = False) -> dict[str, tuple[str, str]]:
    """{slug: ("xmin:ctid:tableoid", text)} of the active items (all, or ``slugs``)."""
    where, params = "list_key = 'active'", []
    if slugs is not None:
        where += " AND slug = ANY(%s)"
        params.append(list(slugs))
    rows, ch = fetch(c, D.WORK_ITEMS, where, params, order="ord", lock=lock)
    deleted = docket_pending(c)['deleted']
    events = _item_events(c,[r['id'] for r in rows])
    return {str(r["slug"]): (f"{r['_xmin']}:{r['_ctid']}:{r['_tableoid']}",
                             dumps(docket_events.decode_item(r,ch,events.get(r['id'],[]))))
            for r in rows if r['id'] not in deleted}


def item(c: Any, slug: str, *, lock: bool = False) -> tuple[tuple[str, str, str], str] | None:
    if lock:
        from .. import docket_locks
        docket_locks.prepare(c, slugs=(slug,))
    rows, ch = fetch(c, D.WORK_ITEMS, "list_key = 'active' AND slug = %s", (slug,), lock=lock)
    if not rows or rows[0]['id'] in docket_pending(c)['deleted']:
        return None
    r = rows[0]
    return ((r["_xmin"], r["_ctid"], r["_tableoid"]),
            dumps(docket_events.decode_item(r,ch,_item_events(c,[r['id']]).get(r['id'],[]))))


def _item_events(c: Any, ids: Sequence[int]) -> dict[int, list[dict[str, Any]]]:
    out: dict[int, list[dict[str, Any]]] = {}
    if ids:
        for row in dict_rows(c,"SELECT * FROM orgtree.work_item_events WHERE item_id=ANY(%s) ORDER BY seq",(list(ids),)):
            out.setdefault(row['item_id'],[]).append(row)
    return out


def _update_row(c: Any, table: str, row: Mapping[str, Any]) -> None:
    columns = [key for key in row if key!='id']
    c.execute(f"UPDATE orgtree.{table} SET "+', '.join(codec.quote(key)+'=%s' for key in columns)+
              ' WHERE id=%s', tuple(row[key] for key in columns)+(row['id'],))


def _docket_write(c: Any, record: Mapping[str, Any], keys: Mapping[str, Any],
                  previous: Mapping[str, Any] | None) -> None:
    from .. import docket_locks
    rid = keys['id']
    old = _item_events(c,[rid]).get(rid,[]) if previous is not None else []
    events, removed, rewritten = docket_events.difference(
        record,old,item_id=rid,allocate=lambda:new_ids(c,'work_item_events',1)[0])
    protected = {previous.get(col) for col in D.CURRENT_POINTERS.values()} if previous else set()
    if protected.intersection(removed):
        raise ShapeError(f"work item {record.get('slug')!r}: removed a current event")
    out: Rows = {}
    from .. import docket_relations as R
    previous_children = {table: dict_rows(c, f'SELECT * FROM orgtree.{table} WHERE item_id=%s', (rid,))
                         for table in (R.DELIVERY.table, R.SEAT.table, R.ARTIFACT_TABLE, R.GRANT.table,
                                       'work_item_holders')
                         } if previous is not None else {}
    docket_events.encode_current(record, keys, events, out,
                                 previous_relations=previous_children.get(R.DELIVERY.table, ()),
                                 previous_children=previous_children,
                                 allocate_relation=lambda table: new_ids(c, table, 1)[0],
                                 previous_item=previous, resolve_current=docket_locks.resolver(c))
    if previous is None:
        insert(c,'work_items',out['work_items'],override=True)
    else:
        _update_row(c,'work_items',out['work_items'][0])
        for table_ in lay(D.WORK_ITEMS):
            if table_!='work_items':
                c.execute(f"DELETE FROM orgtree.{table_} WHERE item_id=%s", (rid,))
    for table_ in lay(D.WORK_ITEMS):
        if table_!='work_items':
            child_rows = out.get(table_, [])
            insert(c, table_, child_rows, override=bool(child_rows and 'id' in child_rows[0]))
    old_ids = {row['id'] for row in old}
    for row in events:
        if row['id'] in rewritten:
            _update_row(c,'work_item_events',row)
    insert(c,'work_item_events',[row for row in events if row['id'] not in old_ids],override=True)
    if removed:
        c.execute("DELETE FROM orgtree.work_item_events WHERE id=ANY(%s)", (removed,))


def item_put(c: Any, tx: Tx, slug: str, value: Any) -> None:
    m = model()
    if m.workrows.slug_of(value) != slug:
        raise CompatError(f"work item row {slug!r} holds another slug")
    from .. import docket_locks
    docket_locks.prepare(c, (value,), slugs=(slug,))
    rows, ch = fetch(c,D.WORK_ITEMS,'slug=%s',(slug,),lock=True)
    row = rows[0] if rows else None
    state = docket_pending(c)
    if row is not None:
        rid = row['id']
        planned = tx.item_ord.pop(slug,None)
        if row['list_key']=='archive':
            state['moved'][str(row['archive_seq'])] = dict(id=rid,text=dumps(
                docket_events.decode_item(row,ch,_item_events(c,[rid]).get(rid,[]))))
            ord_ = planned
        else:
            ord_ = row['ord'] if planned is None else planned
        if rid in state['deleted']:
            state['deleted'].remove(rid)
    else:
        rid = new_ids(c, "work_items", 1)[0]
        ord_ = tx.item_ord.pop(slug, None)
    if ord_ is None:
        ord_ = int(c.execute("SELECT coalesce(max(ord), -1) + 1 FROM orgtree.work_items "
                            "WHERE list_key='active'").fetchone()[0])
    _docket_write(c,value,D.row_keys(value,id=rid,list_key='active',ord=ord_),row)
    _docket_pending_put(c,tx,state)


def header_put(c: Any, tx: Tx, text: str) -> None:
    """The docket header written: the active items' order. An item it names that has no
    row yet takes its position when it is written (later in the same save).

    Positions only order the rows; they need not be consecutive. So an item removed leaves
    a gap, and items added after the last existing one take the positions after the
    highest: neither rewrites another item's row, whose version would move with it (the
    legacy header row never touched its items' rows, and a save may still compare an
    unread item's version after writing the header). Only a real reorder, or an item added
    before an existing one, renumbers every row; the engine does neither today."""
    m = model()
    ids = m.workrows.ids_from_header(text)
    cur = [(str(s), int(o)) for s, o in c.execute(
        "SELECT slug, ord FROM orgtree.work_items WHERE list_key='active' "
        "AND id<>ALL(%s::bigint[]) ORDER BY ord", (docket_pending(c)['deleted'],)).fetchall()]
    have = {s for s, _ in cur}
    named = set(ids)
    if [s for s in ids if s in have] == [s for s, _ in cur if s in named]:
        last = max((i for i, s in enumerate(ids) if s in have), default=-1)
        new = [s for s in ids if s not in have]
        if all(i > last for i, s in enumerate(ids) if s not in have):
            top = max((o for _, o in cur), default=-1)
            tx.item_ord.update((s, top + 1 + k) for k, s in enumerate(new))
            return
    c.execute("UPDATE orgtree.work_items SET ord = -ord - 1 WHERE list_key = 'active'")
    known = [(s, i) for i, s in enumerate(ids) if s in have]
    if known:
        c.execute("UPDATE orgtree.work_items w SET ord = u.o FROM unnest(%s::text[], %s::bigint[]) "
                  "AS u(s, o) WHERE w.slug = u.s AND w.list_key = 'active'",
                  ([s for s, _ in known], [i for _, i in known]))
    tx.item_ord.update((s, i) for i, s in enumerate(ids) if s not in have)


# ----------------------------------------------------------------- nodes

def _node_children(c: Any, ids: list[int]) -> tuple[codec.Children, codec.Children,
                                                   dict[int, dict[str, Any]],
                                                   dict[int, dict[str, Any]],
                                                   dict[int, list[dict[str, Any]]]]:
    hot_lay = lay(A.AGENTS)
    rt_lay = lay(A.RUNTIME_T)
    hot: dict[str, list[dict[str, Any]]] = {}
    for name in hot_lay:
        if name != "agents":
            hot[name] = dict_rows(c, f"SELECT * FROM orgtree.{name} WHERE agent_id = ANY(%s)", (ids,))
    rt: dict[str, list[dict[str, Any]]] = {}
    for name in rt_lay:
        if name != "agent_runtime":
            rt[name] = dict_rows(c, f"SELECT * FROM orgtree.{name} WHERE agent_id = ANY(%s)", (ids,))
    texts = {int(r["agent_id"]): r for r in dict_rows(
        c, "SELECT * FROM orgtree.agent_texts WHERE agent_id = ANY(%s)", (ids,))}
    runtime = {int(r["agent_id"]): r for r in dict_rows(
        c, "SELECT * FROM orgtree.agent_runtime WHERE agent_id = ANY(%s)", (ids,))}
    return (codec.Children(hot, hot_lay), codec.Children(rt, rt_lay), texts, runtime,
            _turns().read_recent(c, ids))


def nodes(c: Any, wanted: Iterable[str] | None = None, *, names: Names | None = None,
          lock: bool = False) -> list[tuple[str, str, str]]:
    """(name, text, xmin) of the nodes (all, or ``wanted``), in ``ord`` order.

    A node's text is cached by its ``agents`` row version (``xmin:ctid``), within the
    database's incarnation. Structural references decode joined names, so the cache token
    includes those names too: an in-place rename changes their text without changing the
    referencing row. Only changed texts are decoded."""
    names = names or Names(c)
    where, params = "NOT a.tombstone", []
    if wanted is not None:
        where += " AND a.name = ANY(%s)"
        params.append(list(wanted))
    heads = c.execute("SELECT a.id, a.name, a.xmin::text, a.ctid::text, p.name, b.name, s.name "
                      "FROM orgtree.agents a LEFT JOIN orgtree.agents p ON p.id=a.parent_id "
                      "LEFT JOIN orgtree.agents b ON b.id=a.predecessor_id "
                      "LEFT JOIN orgtree.agents s ON s.id=a.successor_id "
                      f"WHERE {where} ORDER BY a.ord, a.id"
                      f"{' FOR UPDATE OF a' if lock else ''}", params).fetchall()
    if not heads:
        return []
    slot = _node_slot(c)
    held = _NODE_TEXTS.get(slot, {})
    texts_by_id: dict[int, str] = {}
    misses = []
    versions = {}
    for aid, _, xmin, ctid, parent, predecessor, successor in heads:
        versions[int(aid)] = dumps([xmin, ctid, parent, predecessor, successor])
        hit = held.get(int(aid))
        if hit is not None and hit[0] == versions[int(aid)]:
            texts_by_id[int(aid)] = hit[1]
        else:
            misses.append(int(aid))
    if misses:
        rows = dict_rows(c, "SELECT *, xmin::text AS _xmin, ctid::text AS _ctid "
                            "FROM orgtree.agents WHERE id = ANY(%s)", (misses,))
        ch_hot, ch_rt, texts, runtime, recent = _node_children(c, misses)
        lists = sorted({int(r["tool_list_id"]) for r in rows if r["tool_list_id"] is not None})
        tool_lists: dict[int, list[tuple[int, str]]] = {}
        if lists:
            for lid, pos, tool in c.execute("SELECT list_id, pos, tool FROM orgtree.tool_list_items "
                                            "WHERE list_id = ANY(%s)", (lists,)).fetchall():
                tool_lists.setdefault(int(lid), []).append((int(pos), str(tool)))
        names.load(r[f"{ref}_id"] for r in rows for ref in A.REFS)
        fresh: dict[int, tuple[str, str]] = {}
        for r in rows:
            rec = A.decode_node(r, ch_hot, ch_rt, texts.get(int(r["id"]), {}),
                                runtime.get(int(r["id"]), {}), tool_lists, names.name,
                                recent=recent.get(int(r['id']), []))
            text = dumps(rec)
            texts_by_id[int(r["id"])] = text
            version = dumps([r['_xmin'], r['_ctid'],
                             *(names.name(r[f'{ref}_id']) if r[f'{ref}_id'] is not None else None
                               for ref in A.REFS)])
            fresh[int(r["id"])] = (version, text)
        _keep_nodes(slot, fresh)
    return [(str(name), texts_by_id[int(aid)], str(xmin)) for aid, name, xmin, *_ in heads]


#: decoded node texts by row version: {(server, database, incarnation): {agent id: (version,
#: text)}}. Bounded; a full slot starts over.
_NODE_TEXTS: dict[tuple[str, str, str], dict[int, tuple[str, str]]] = {}
_NODE_TEXTS_CAP = 20000


def _node_slot(c: Any) -> tuple[str, str, str]:
    """The cache slot of the database ``c`` reads: the server (its start time), the database
    and its incarnation (a restored or imported copy is a new incarnation, design §2.5), read
    once per connection."""
    slot = getattr(c, "_orgdb_node_slot", None)
    if slot is None:
        row = c.execute("SELECT pg_postmaster_start_time()::text, current_database(), "
                        "(SELECT incarnation::text FROM orgtree.org_identity)").fetchone()
        slot = (str(row[0]), str(row[1]), str(row[2]))
        c._orgdb_node_slot = slot
    return slot


def _keep_nodes(slot: tuple[str, str, str], fresh: dict[int, tuple[str, str]]) -> None:
    held = _NODE_TEXTS.setdefault(slot, {})
    if len(held) + len(fresh) > _NODE_TEXTS_CAP:
        held.clear()
    held.update(fresh)


def node_ids(c: Any) -> list[str]:
    return [str(n) for (n,) in c.execute(
        "SELECT name FROM orgtree.agents WHERE NOT tombstone ORDER BY ord, id").fetchall()]


# node fields without decoding a row: the projections store.py runs over the node table

def _node_field(key: str) -> tuple[str, codec.Field | None]:
    """Where top-level node field ``key`` lives: ('ref' | 'tools' | 'hot' | 'texts' |
    'runtime' | 'extra', its Field)."""
    if key in A.REFS:
        return "ref", None
    if key == A.TOOL_KEY:
        return "tools", None
    for kind, spec in (("texts", A.TEXTS), ("runtime", A.RUNTIME), ("hot", A.HOT)):
        f = spec.field(key)
        if f is not None:
            return kind, f
    return "extra", None


def _present(alias: str, f: codec.Field) -> str:
    if f.kind in codec.SCALARS:
        return f"{alias}.{codec.quote(f.col)} IS NOT NULL"
    return f"{alias}.{codec.quote(f.col + '_is')} IN ('o', 'l', 'x')"


def node_key_present_sql(key: str) -> str:
    """SQL over ``agents a``, true for every node whose row may hold ``key`` with a non-null
    value: a superset (a value kept in ``extra`` counts), as store's callers require."""
    kind, f = _node_field(key)
    extra = "a.extra IS NOT NULL"
    if kind == "ref":
        return f"a.{key}_id IS NOT NULL OR {extra}"
    if kind == "tools":
        return f"a.tool_list_id IS NOT NULL OR {extra}"
    if kind == "hot":
        assert f is not None
        return f"{_present('a', f)} OR {extra}"
    if kind in ("texts", "runtime"):
        assert f is not None
        t = "agent_texts" if kind == "texts" else "agent_runtime"
        return (f"EXISTS (SELECT 1 FROM orgtree.{t} x WHERE x.agent_id = a.id "
                f"AND ({_present('x', f)} OR x.extra IS NOT NULL))")
    return extra


def node_string_values(c: Any, key: str) -> set[str]:
    """The distinct string values of top-level field ``key`` over every node (any state)."""
    kind, f = _node_field(key)
    out: set[str] = set()
    if kind == "ref":
        out |= {str(n) for (n,) in c.execute(
            f"SELECT DISTINCT p.name FROM orgtree.agents a JOIN orgtree.agents p "
            f"ON p.id = a.{key}_id WHERE NOT a.tombstone").fetchall()}
    elif kind == "hot" and f is not None and f.kind == "text":
        out |= {str(v) for (v,) in c.execute(
            f"SELECT DISTINCT {codec.quote(f.col)} FROM orgtree.agents WHERE NOT tombstone "
            f"AND {codec.quote(f.col)} IS NOT NULL").fetchall()}
    elif kind != "extra":
        for _, text, _ in nodes(c):
            v = json.loads(text).get(key)
            if isinstance(v, str):
                out.add(v)
        return out
    for (ex,) in c.execute("SELECT extra FROM orgtree.agents WHERE NOT tombstone "
                           "AND extra IS NOT NULL").fetchall():
        v = ex.get(key) if isinstance(ex, dict) else None
        if isinstance(v, str):
            out.add(v)
    return out


def scalar_field(value: Any, extra: Any, key: str) -> Any:
    """A scalar node field from its column and the row's extra (codec.MISSING if absent)."""
    if value is not None:
        return value
    if isinstance(extra, dict) and key in extra:
        return extra[key]
    return codec.MISSING


def json_extract_text(v: Any) -> str | None:
    """The legacy one-path ``json_extract``: a string as itself, JSON null or a missing key
    as NULL, any other value as its JSON text."""
    if v is codec.MISSING or v is None:
        return None
    if isinstance(v, str):
        return v
    return dumps(v)


def node_field_texts(c: Any, key: str) -> list[tuple[str, str | None]]:
    """(name, JSON text of ``key`` or NULL when absent) for every node, in table order: the
    legacy ``((val::json)->key)::text``. A scalar HOT column only."""
    kind, f = _node_field(key)
    if kind != "hot" or f is None or f.kind not in codec.SCALARS or f.kind in ("ts", "json"):
        raise CompatError(f"node field {key!r} is not a plain scalar column")
    col = codec.quote(f.col)
    null = f", {codec.quote(f.col + '_null')}" if f.nullable else ", false"
    out = []
    for name, v, isnull, ex in c.execute(
            f"SELECT name, {col}{null}, extra FROM orgtree.agents WHERE NOT tombstone "
            "ORDER BY ord, id").fetchall():
        if v is not None:
            out.append((str(name), dumps(codec.from_column(f.kind, v))))
        elif isnull:
            out.append((str(name), "null"))
        elif isinstance(ex, dict) and key in ex:
            out.append((str(name), dumps(ex[key])))
        else:
            out.append((str(name), None))
    return out


def children_ids(c: Any, parents: Sequence[str], live_only: bool = False) -> list[str]:
    """Candidates whose stored parent is one of ``parents`` ('' = the top level), in table
    order: a superset (a row whose parent field is kept in extra counts). ``live_only``
    leaves out every row whose state COLUMN is 'archived': the column, when set, is the
    node's state (``scalar_field``), so retained extra never makes an archived row a
    candidate. A row whose state is kept in extra (column NULL) still counts."""
    live = " AND a.state IS DISTINCT FROM 'archived'" if live_only else ""
    return [str(n) for (n,) in c.execute(
        "SELECT a.name FROM orgtree.agents a LEFT JOIN orgtree.agents p ON p.id = a.parent_id "
        "WHERE NOT a.tombstone AND (coalesce(p.name, '') = ANY(%s) OR a.extra IS NOT NULL)"
        + live + " ORDER BY a.ord, a.id", (list(parents),)).fetchall()]


def _tool_list(c: Any) -> Callable[[str, list[str], Rows], int]:
    def list_id(sha: str, tools: list[str], out: Rows) -> int:
        row = c.execute("SELECT id FROM orgtree.tool_lists WHERE sha256 = %s", (sha,)).fetchone()
        if row is not None:
            return int(row[0])
        row = c.execute("INSERT INTO orgtree.tool_lists (sha256) VALUES (%s) "
                        "ON CONFLICT (sha256) DO NOTHING RETURNING id", (sha,)).fetchone()
        if row is None:
            return int(c.execute("SELECT id FROM orgtree.tool_lists WHERE sha256 = %s",
                                 (sha,)).fetchone()[0])
        lid = int(row[0])
        insert(c, "tool_list_items", [{"list_id": lid, "pos": p, "tool": t}
                                      for p, t in enumerate(tools)])
        return lid
    return list_id


def _clear_node_rows(c: Any, aid: int) -> None:
    for name in lay(A.AGENTS):
        if name != "agents":
            c.execute(f"DELETE FROM orgtree.{name} WHERE agent_id = %s", (aid,))
    c.execute("DELETE FROM orgtree.agent_texts WHERE agent_id = %s", (aid,))
    c.execute("DELETE FROM orgtree.agent_runtime WHERE agent_id = %s", (aid,))   # cascades


def _update_agent(c: Any, aid: int, row: dict[str, Any]) -> None:
    cols = [k for k in row if k != "id"]
    c.execute(f"UPDATE orgtree.agents SET ({codec.quoted(cols)}) = ROW({', '.join(['%s'] * len(cols))}), "
              "row_version = row_version + 1 WHERE id = %s", [row[k] for k in cols] + [aid])


def node_put(c: Any, name: str, value: Any, names: Names) -> None:
    """Write one node; only a name-only placeholder may become a new live node."""
    if not isinstance(value, dict):
        raise CompatError(f"node {name!r} is not an object")
    if not codec.fits("text", name):
        raise ShapeError(f"a node id no text column can hold: {name!r}")
    def current() -> Any:
        return c.execute("SELECT id, tombstone, ord FROM orgtree.agents WHERE name = %s "
                         "AND (NOT tombstone OR state IS DISTINCT FROM 'deleted') "
                         "ORDER BY tombstone, id LIMIT 1 FOR UPDATE", (name,)).fetchone()
    row = current()
    if row is None or row[1]:
        # a new or revived name: its creators are serialised by the name's lock (an
        # existing node's writers by its row lock, taken first everywhere)
        names.lock(name)
        row = current()
    ensure_section(c, "nodes", touch=False)

    def write() -> None:
        if row is not None and not row[1]:
            aid, ord_ = int(row[0]), int(row[2])
        else:
            ord_ = int(c.execute("SELECT coalesce(max(ord), -1) + 1 FROM orgtree.agents "
                                 "WHERE NOT tombstone").fetchone()[0])
            aid = int(row[0]) if row is not None else int(c.execute(
                "SELECT nextval(pg_get_serial_sequence('orgtree.agents', 'id'))").fetchone()[0])
        names.by_name[name] = aid
        names.by_id[aid] = name
        out: Rows = {}
        context = DbContext(names)
        A.encode_node(name, aid, ord_, value, context, out, _tool_list(c))
        arow = out["agents"][0]
        if row is None:
            insert(c, "agents", [arow])
            from .. import docket_locks
            docket_locks.created(c, aid)
        else:
            _clear_node_rows(c, aid)
            _update_agent(c, aid, arow)
        _turns().reconcile_recent(c, aid, context.recent_turns.get(aid, []))
        for name_ in lay(A.AGENTS):
            if name_ != "agents":
                insert(c, name_, out.get(name_, []))
        insert(c, "agent_texts", out.get("agent_texts", []))
        insert(c, "agent_runtime", out.get("agent_runtime", []))
        for name_ in lay(A.RUNTIME_T):
            if name_ != "agent_runtime":
                insert(c, name_, out.get(name_, []))
    savepoint_retry(c, write)


def node_delete(c: Any, name: str) -> int:
    """A node removed: its row becomes a tombstone (records of other sections keep it)."""
    selected = dict_rows(c, "SELECT id,lineage_born,generation,extra FROM orgtree.agents "
                           "WHERE name=%s AND NOT tombstone FOR UPDATE", (name,))
    if not selected:
        return 0
    row = selected[0]
    aid = int(row['id'])
    identity = agent_identity(row)
    record = {k: identity[k] for k in ('seat_id', 'generation') if k in identity}
    record['state'] = 'deleted'
    out: Rows = {}
    A.encode_tombstone(name, aid, record, out)
    arow = out["agents"][0]
    _clear_node_rows(c, aid)
    _turns().clear_recent(c, aid)
    _update_agent(c, aid, arow)
    return 1


# ----------------------------------------------------------------- logs

def seq_of(ls: LogSect, rid: int) -> int:
    return rid * SLOTS + ls.slot


def by_seq(log: str, seq: int) -> tuple[LogSect, int]:
    ls = model().by_slot.get((log, int(seq) % SLOTS))
    if ls is None:
        raise CompatError(f"{log} seq {seq} names no section")
    return ls, int(seq) // SLOTS


def _scope(ls: LogSect, extra: str = "") -> str:
    base = ("list_key = 'archive'" if ls.kind == "archive" else
            'idx IS NOT NULL' if ls.name == 'turn_log' else "true")
    return base + extra


def log_has(c: Any, ls: LogSect) -> bool:
    if ls.name == "mail_log":
        return bool(c.execute("SELECT EXISTS (SELECT 1 FROM orgtree.mailboxes WHERE nrows > 0)")
                    .fetchone()[0])
    if ls.kind=='archive':
        state = docket_pending(c)
        return bool(state['moved']) or bool(c.execute("SELECT EXISTS(SELECT 1 FROM orgtree.work_items "
            "WHERE list_key='archive' AND id<>ALL(%s::bigint[]))",(state['deleted'],)).fetchone()[0])
    return bool(c.execute(f"SELECT EXISTS (SELECT 1 FROM orgtree.{ls.table.spec.table} "
                          f"WHERE {_scope(ls)})").fetchone()[0])


def entry_of(ls: LogSect, r: Mapping[str, Any], ch: codec.Children,
             events: Sequence[Mapping[str, Any]] = ()) -> Any:
    if ls.kind=='archive':
        return docket_events.decode_item(r,ch,events)
    rec = codec.decode(ls.table.spec, r, ch, (r["id"],))
    return [r["key"], rec] if ls.kind == "agent_map" else rec


def at_of(entry: Any) -> str | None:
    """store._at_of."""
    if isinstance(entry, dict):
        at = entry.get("at")
        if isinstance(at, str):
            return at
    return None


def log_rows(c: Any, ls: LogSect, *, owner_id: int | None = None, ids: Sequence[int] | None = None,
             names: Names | None = None, lock: bool = False
             ) -> list[tuple[int, str | None, str | None, str]]:
    """(seq, owner, at, text) of a log section's rows, in seq order."""
    where, params = _scope(ls), []
    if owner_id is not None:
        where += " AND agent_id = %s"
        params.append(owner_id)
    if ids is not None:
        where += " AND "+('archive_seq' if ls.kind=='archive' else 'id')+" = ANY(%s)"
        params.append(list(ids))
    deleted = docket_pending(c)['deleted'] if ls.kind=='archive' else []
    if deleted:
        where += ' AND id<>ALL(%s::bigint[])'
        params.append(deleted)
    rows, ch = fetch(c, ls.table, where, params, order='archive_seq' if ls.kind=='archive' else 'id', lock=lock)
    events = _item_events(c,[r['id'] for r in rows]) if ls.kind=='archive' else {}
    names = names or Names(c)
    agent = ls.kind in ("agent", "agent_map")
    if agent:
        names.load(r["agent_id"] for r in rows)
    out = []
    for r in rows:
        entry = entry_of(ls, r, ch,events.get(r['id'],[]))
        out.append((seq_of(ls, int(r['archive_seq'] if ls.kind=='archive' else r["id"])), names.name(int(r["agent_id"])) if agent else None,
                    at_of(entry), dumps(entry)))
    if ls.kind=='archive':
        for seq, value in docket_pending(c)['moved'].items():
            if ids is None or int(seq) in ids:
                text = value['text']
                out.append((seq_of(ls,int(seq)),None,at_of(json.loads(text)),text))
        out.sort(key=lambda row:row[0])
    return out


def log_rows_page(c: Any, ls: LogSect, *, newest: int | None = None,
                  offset: int = 0) -> list[tuple[int, str | None, str | None, str]]:
    """The ``newest`` rows of a section, or every row from position ``offset``; ascending."""
    if ls.kind=='archive':
        state = docket_pending(c)
        if newest is not None and newest<=0:
            return []
        skipped = max(0,offset-len(state['moved'])) if newest is None else 0
        rows,ch = fetch(c,D.WORK_ITEMS,"list_key='archive' AND id<>ALL(%s::bigint[])",
                        (state['deleted'],),order='archive_seq DESC' if newest is not None else 'archive_seq',
                        limit=newest+len(state['moved']) if newest is not None else None,offset=skipped)
        events = _item_events(c,[r['id'] for r in rows])
        out = []
        for row in rows:
            record = entry_of(ls,row,ch,events.get(row['id'],[]))
            out.append((seq_of(ls,row['archive_seq']),None,at_of(record),dumps(record)))
        for position,move in state['moved'].items():
            out.append((seq_of(ls,int(position)),None,at_of(json.loads(move['text'])),move['text']))
        out.sort(key=lambda row:row[0])
        return out[-newest:] if newest is not None else out[max(0,offset-skipped):]
    names = Names(c)
    if newest is not None:
        rows, ch = fetch(c, ls.table, _scope(ls), order="id DESC", limit=max(0, newest))
        rows.reverse()
    else:
        rows, ch = fetch(c, ls.table, _scope(ls), order="id", offset=max(0, offset))
    agent = ls.kind in ("agent", "agent_map")
    if agent:
        names.load(r["agent_id"] for r in rows)
    out = []
    for r in rows:
        entry = entry_of(ls, r, ch)
        out.append((seq_of(ls, int(r["id"])), names.name(int(r["agent_id"])) if agent else None,
                    at_of(entry), dumps(entry)))
    return out


def log_owner_tail(c: Any, ls: LogSect, aid: int, limit: int, names: Names
                   ) -> list[tuple[int, str | None, str | None, str]]:
    """The legacy owner tail: one owner's rows by (``at`` as text, C order) descending, then
    seq descending, the first ``limit``. ``at`` is the entry's ``at`` when it is a string,
    else ''. Org migration 0008 keeps that text as ``win_at`` (orgtree.owner_at) and indexes
    (agent_id, win_at, id), so only the rows returned are read (A6 round 2)."""
    f = ls.table.spec.field("at")
    if f is None or f.kind != "ts":
        raise CompatError(f"{ls.name}: no timestamp column to order a tail by")
    if limit <= 0:
        return []
    pick = [int(r[0]) for r in c.execute(
        f"SELECT id FROM orgtree.{ls.table.spec.table} WHERE agent_id = %s "
        + ('AND idx IS NOT NULL ' if ls.name == 'turn_log' else '') +
        "ORDER BY win_at DESC, id DESC LIMIT %s", (aid, limit)).fetchall()]
    if not pick:
        return []
    got = {s: row for row in log_rows(c, ls, ids=pick, names=names) for s in (row[0],)}
    return [got[seq_of(ls, rid)] for rid in pick if seq_of(ls, rid) in got]


def log_insert(c: Any, ls: LogSect, owner: str | None, text: str, names: Names,
               *, tx: Tx | None = None) -> int:
    """Append one row; its legacy seq."""
    entry = json.loads(text)
    rec, key = entry, None
    if ls.kind == "agent_map":
        if not (isinstance(entry, list) and len(entry) == 2 and isinstance(entry[0], str)
                and isinstance(entry[1], dict)):
            raise CompatError(f"{ls.name}: a row that is not an [id, entry] pair")
        key, rec = entry
    if not isinstance(rec, dict):
        raise ShapeError(f"{ls.name}: a log entry that is not an object")
    if ls.kind=='archive':
        assert tx is not None
        from .. import docket_locks
        docket_locks.prepare(c, (rec,))
        rows,_ = fetch(c,D.WORK_ITEMS,'slug=%s',(rec.get('slug'),),lock=True)
        row = rows[0] if rows else None
        state = docket_pending(c)
        if row is not None and row['id'] not in state['deleted']:
            from psycopg.errors import UniqueViolation  # noqa: PLC0415
            # Keep the legacy integrity-error surface when a slug is present in
            # both lists. The valid delete-then-archive move reuses this row.
            raise UniqueViolation(f"work item {rec.get('slug')!r}: archive append did not remove its previous row")
        position = new_ids(c,'work_items',1)[0]
        rid = row['id'] if row is not None else position
        keys = D.row_keys(rec,id=rid,list_key='archive',ord=position,archive_seq=position)
        _docket_write(c,rec,keys,row)
        if rid in state['deleted']:
            state['deleted'].remove(rid)
        _docket_pending_put(c,tx,state)
        ensure_section(c,ls.name,touch=False)
        return seq_of(ls,position)
    rid = new_ids(c, ls.table.spec.table, 1)[0]
    if rid > _INT4_MAX and ls.kind in ("agent", "agent_map"):
        raise CompatError(f"{ls.name}: record id {rid} exceeds the position column")
    keys: dict[str, Any] = {"id": rid}
    if ls.kind == "list":
        keys["ord"] = rid
    else:
        if owner is None:
            raise CompatError(f"{ls.name}: a row without an owner")
        keys.update(agent_id=names.id(owner, mint=True), idx=rid)
        if key is not None:
            keys["key"] = key
    if ls.name == "mail_log":
        M.lock(c, keys["agent_id"])
    if ls.name == 'turn_log':
        _turns().attach_log(c, keys['agent_id'], rid, keys['idx'], rec)
        ensure_section(c, ls.name, touch=False)
        return seq_of(ls, rid)
    out: Rows = {}
    codec.encode(ls.table.spec, rec, keys, out, link=ls.table.link)
    store_encoded(c, ls.table, out, ids=[rid])
    if ls.name == "mail_log":
        M.advance(c, keys["agent_id"], rec.get("recv_seq"))
    ensure_section(c, ls.name, touch=False)
    return seq_of(ls, rid)


def log_replace(c: Any, ls: LogSect, rid: int, text: str, *, expected: str | None,
                tx: Tx | None = None) -> int:
    """Rewrite the row ``rid`` (compare-and-set when ``expected`` is given); 0 or 1."""
    if ls.kind == 'archive':
        from .. import docket_locks
        docket_locks.prepare(c, (json.loads(text),), archive_ids=(rid,))
    if ls.name == 'turn_log':
        _turns().lock_log_ids(c, [rid])
    if ls.name == "mail_log":
        owners = [int(r[0]) for r in c.execute(
            "SELECT agent_id FROM orgtree.mail_log WHERE id=%s", (rid,)).fetchall()]
        M.lock_many(c, owners)
    column = 'archive_seq' if ls.kind=='archive' else 'id'
    rows, ch = fetch(c, ls.table, _scope(ls, f" AND {column} = %s"), (rid,), lock=True)
    if not rows:
        return 0
    r = rows[0]
    events = _item_events(c,[r['id']]).get(r['id'],[]) if ls.kind=='archive' else []
    if expected is not None and not same(dumps(entry_of(ls, r, ch,events)), expected):
        return 0
    entry = json.loads(text)
    if ls.kind=='archive':
        assert tx is not None
        if r['id'] in docket_pending(c)['deleted']:
            return 0
        keys = D.row_keys(entry,id=r['id'],list_key='archive',ord=r['ord'],archive_seq=r['archive_seq'])
        _docket_write(c,entry,keys,r)
        return 1
    if ls.name == 'turn_log':
        if not isinstance(entry, dict):
            raise ShapeError('turn_log: a log entry that is not an object')
        _turns().rewrite_log(c, r, entry_of(ls, r, ch), entry)
        return 1
    rec, key = entry, r.get("key")
    if ls.kind == "agent_map":
        if not (isinstance(entry, list) and len(entry) == 2 and isinstance(entry[0], str)
                and isinstance(entry[1], dict)):
            raise CompatError(f"{ls.name}: a row that is not an [id, entry] pair")
        key, rec = entry
    keys: dict[str, Any] = {"id": rid}
    for col, _ in ls.table.keys:
        if col != "id":
            keys[col] = r[col]
    if key is not None and ls.kind == "agent_map":
        keys["key"] = key
    c.execute(f"DELETE FROM orgtree.{ls.table.spec.table} WHERE id = %s", (rid,))
    out: Rows = {}
    codec.encode(ls.table.spec, rec, keys, out, link=ls.table.link)
    store_encoded(c, ls.table, out, ids=[rid])
    if ls.name == "mail_log":
        M.recount(c, owners)
    return 1


def log_delete(c: Any, ls: LogSect, rids: Sequence[int], *, expected: str | None = None,
               tx: Tx | None = None) -> int:
    """Delete rows by id (compare-and-set for one row when ``expected`` is given)."""
    if ls.name == 'turn_log':
        _turns().lock_log_ids(c, list(rids))
    if ls.name == "mail_log":
        owners = [int(r[0]) for r in c.execute(
            "SELECT DISTINCT agent_id FROM orgtree.mail_log WHERE id=ANY(%s)", (list(rids),)).fetchall()]
        M.lock_many(c, owners)
    if ls.kind=='archive':
        assert tx is not None
        state = docket_pending(c)
        rows,ch = fetch(c,D.WORK_ITEMS,"list_key='archive' AND archive_seq=ANY(%s)",(list(rids),),lock=True)
        events = _item_events(c,[r['id'] for r in rows])
        by_seq_ = {r['archive_seq']:r for r in rows if r['id'] not in state['deleted']}
        count = 0
        for position in rids:
            moved = state['moved'].get(str(position))
            row = by_seq_.get(position)
            if moved is None and row is None:
                continue
            text = moved['text'] if moved is not None else dumps(entry_of(ls,row,ch,events.get(row['id'],[])))
            if expected is not None and not same(text,expected):
                continue
            if moved is not None:
                del state['moved'][str(position)]
            else:
                state['deleted'].append(row['id'])
            count += 1
        _docket_pending_put(c,tx,state)
        return count
    if expected is not None:
        rows, ch = fetch(c, ls.table, _scope(ls, " AND id = %s"), (rids[0],), lock=True)
        if not rows or not same(dumps(entry_of(ls, rows[0], ch)), expected):
            return 0
    if ls.name == 'turn_log':
        return _turns().remove_log(c, list(rids))
    n = int(c.execute(f"DELETE FROM orgtree.{ls.table.spec.table} WHERE {_scope(ls)} "
                      "AND id = ANY(%s)", (list(rids),)).rowcount)
    if n and ls.name == "mail_log":
        M.recount(c, owners)
    return n


def log_scope_delete(c: Any, ls: LogSect, owner_id: int | None = None,
                     *, tx: Tx | None = None) -> int:
    if ls.kind=='archive':
        positions = [r[0] for r in c.execute("SELECT archive_seq FROM orgtree.work_items WHERE list_key='archive'").fetchall()]
        positions.extend(int(seq) for seq in docket_pending(c)['moved'])
        return log_delete(c,ls,positions,tx=tx)
    where = _scope(ls)
    params: list[Any] = []
    if owner_id is not None:
        where += " AND agent_id = %s"
        params.append(owner_id)
    if ls.name == 'turn_log':
        ids = [r[0] for r in c.execute(f'SELECT id FROM orgtree.agent_turns WHERE {where}',
                                       params).fetchall()]
        return _turns().remove_log(c, ids)
    if ls.name == "mail_log":
        owners = [owner_id] if owner_id is not None else [int(r[0]) for r in c.execute(
            "SELECT DISTINCT agent_id FROM orgtree.mail_log").fetchall()]
        M.lock_many(c, owners)
    n = int(c.execute(f"DELETE FROM orgtree.{ls.table.spec.table} WHERE {where}", params).rowcount)
    if n and ls.name == "mail_log":
        M.recount(c, owners)
    return n


def log_count(c: Any, ls: LogSect, owner_id: int | None = None) -> int:
    if ls.kind=='archive':
        deleted = docket_pending(c)
        return int(c.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='archive' "
                             "AND id<>ALL(%s::bigint[])",(deleted['deleted'],)).fetchone()[0])+len(deleted['moved'])
    where = _scope(ls)
    params: list[Any] = []
    if owner_id is not None:
        where += " AND agent_id = %s"
        params.append(owner_id)
    return int(c.execute(f"SELECT count(*) FROM orgtree.{ls.table.spec.table} WHERE {where}",
                         params).fetchone()[0])


def log_owners_by_first(c: Any, ls: LogSect) -> list[str]:
    """The owners of a dict log's rows, by each one's first row (store._owners_of)."""
    return [str(n) for (n,) in c.execute(
        f"SELECT a.name FROM orgtree.{ls.table.spec.table} t JOIN orgtree.agents a "
        "ON a.id = t.agent_id " + ('WHERE t.idx IS NOT NULL ' if ls.name == 'turn_log' else '') +
        "GROUP BY a.id, a.name ORDER BY min(t.id)").fetchall()]


# ----------------------------------------------------------------- meta

def owners(c: Any, sect: str) -> list[str]:
    return [str(n) for (n,) in c.execute(
        "SELECT a.name FROM orgtree.org_section_owners o JOIN orgtree.agents a ON a.id = o.agent_id "
        "WHERE o.section = %s ORDER BY o.ord", (sect,)).fetchall()]


def meta_get(c: Any, key: str) -> tuple[str, str] | None:
    """(version, text) of one meta row, or None."""
    m = model()
    if key == "key_order":
        return ("", key_order_text(c))
    if key == "schema_version":
        # an intact org: a converted one has sections; one created here has the row its
        # first save wrote. A database nothing has filled is not an org (store refuses it,
        # as it refuses an empty SQLite file)
        filled = c.execute("SELECT EXISTS (SELECT 1 FROM orgtree.org_sections) OR EXISTS "
                           "(SELECT 1 FROM orgtree.compat_meta WHERE key = 'schema_version')"
                           ).fetchone()[0]
        return ("", "1") if filled else None
    if key == "receipt_rows":
        return None
    if key.startswith("owners:") and key[len("owners:"):] in m.dict_logs:
        sect = key[len("owners:"):]
        row = section_row(c, sect)
        if row is None or row[1] != "v":
            return None
        text = dumps(owners(c, sect))
        # Owner names are joined agent fields. A rename can change them while
        # the section marker stays unchanged; the reuse token must change too.
        return (row[2] + ':' + text, text)
    row = c.execute("SELECT xmin::text || ':' || ctid::text, val FROM orgtree.compat_meta "
                    "WHERE key = %s", (key,)).fetchone()
    return None if row is None else (str(row[0]), str(row[1]))


def meta_put(c: Any, key: str, text: str, names: Names) -> None:
    m = model()
    if key == "key_order":
        set_key_order(c, text)
        return
    if key == "schema_version":
        if text != "1":
            raise CompatError(f"schema_version {text!r}: this view serves version 1 only")
        c.execute("INSERT INTO orgtree.compat_meta (key, val) VALUES ('schema_version', '1') "
                  "ON CONFLICT (key) DO NOTHING")
        return
    if key == "receipt_rows":
        raise CompatError("custody receipts as rows (ORGTREE_RECEIPT_ROWS) are not served by "
                          "the compatibility view")
    if key.startswith("owners:") and key[len("owners:"):] in m.dict_logs:
        sect = key[len("owners:"):]
        names_ = json.loads(text)
        if not isinstance(names_, list) or not all(isinstance(n, str) for n in names_):
            raise CompatError(f"meta {key} is not a list of names")
        ensure_section(c, sect, "v")
        c.execute("DELETE FROM orgtree.org_section_owners WHERE section = %s", (sect,))
        rows = []
        seen: set[int] = set()
        for i, n in enumerate(names_):
            aid = names.id(n, mint=True)
            assert aid is not None
            if aid in seen:
                continue
            seen.add(aid)
            rows.append({"section": sect, "agent_id": aid, "ord": i, "state": "l"})
        insert(c, "org_section_owners", rows)
        return
    c.execute("INSERT INTO orgtree.compat_meta (key, val) VALUES (%s, %s) "
              "ON CONFLICT (key) DO UPDATE SET val = EXCLUDED.val", (key, text))


def meta_delete(c: Any, key: str) -> int:
    m = model()
    if key.startswith("owners:") and key[len("owners:"):] in m.dict_logs:
        sect = key[len("owners:"):]
        n = c.execute("DELETE FROM orgtree.org_section_owners WHERE section = %s", (sect,)).rowcount
        c.execute("UPDATE orgtree.org_sections SET state = state WHERE key = %s", (sect,))
        return int(n)
    if key in ("key_order", "schema_version", "receipt_rows"):
        raise CompatError(f"meta {key} cannot be deleted in this view")
    return int(c.execute("DELETE FROM orgtree.compat_meta WHERE key = %s", (key,)).rowcount)
