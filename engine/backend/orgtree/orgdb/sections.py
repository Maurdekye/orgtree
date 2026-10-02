"""Section mappers: the legacy org document <-> an org database's rows (design §5.2 step 3).

Today's loader gives one org as a dict of top-level sections. Every key the engine can write is
registered in ``ledger.NODE_KEYED_SECTIONS``; ``ledger.IGNORED_LEGACY_KEYS`` lists the removed
features' keys (kiosk, spend freeze), which are not converted (decision 17) and stay in the
untouched legacy data. A ``Section`` owns some registered keys and moves them to and from rows,
using the exact codec (``codec``) for every record. A key outside both lists is kept exactly in
``org_extra``, so an unregistered key never costs an org (design §5.2).

Two tables are the framework's own:

  org_sections        one row per top-level key the document has: its position (key order is
                      kept) and whether its value is null ('n') or held by its section ('v').
                      An empty list is therefore never confused with an absent key.
  org_section_owners  for the per-agent sections (``mail``, ``turn_log`` ...: a dict keyed by
                      agent name): one row per agent key, its position and whether its value is
                      a list ('l'), an object ('o') or null ('n').

Agents are rows, and every other section refers to them by id. ``Context`` maps names to ids:
the nodes come first; a name no node carries (a key an earlier delete left behind) gets a
tombstone row (design §3.0, Q6), so its records keep an owner and still read back under the
same name.

A section's container of an unforeseen type (a dict where a list of records is expected, a
record that is not an object) raises ``codec.ShapeError``: the converter then makes the org
unavailable with that reason (design §7) instead of converting it partly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from . import codec
from .codec import Rows, ShapeError, Spec

ID = ("id", "bigint")
ID_COLUMN = "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY"


@dataclass(frozen=True)
class Table:
    """One record table (and its child tables) as one Spec describes it.

    ``keys`` are the record table's placement columns, the first being its surrogate ``id``;
    ``link`` names what its children carry (always the id, renamed, e.g. {"id": "mail_id"}).
    ``record_columns`` are DDL fragments placed first in the record table; ``indexes`` are
    statements run after it."""
    spec: Spec
    keys: tuple[tuple[str, str], ...]
    link: Mapping[str, str]
    record_columns: tuple[str, ...]
    indexes: tuple[str, ...] = ()

    def layout(self) -> dict[str, dict[str, Any]]:
        return codec.layout(self.spec, self.keys, self.link)

    def ddl(self, schema: str = "orgtree") -> list[str]:
        return codec.ddl(self.spec, self.keys, link=self.link, schema=schema,
                         record_columns=self.record_columns) + list(self.indexes)


RESERVED = frozenset({"id", "extra", "row_version"})


def table(spec: Spec, *, child_key: str, placement: tuple[tuple[str, str, str], ...] = (),
          indexes: tuple[str, ...] = (), derived: tuple[str, ...] = ()) -> Table:
    """A record table with a surrogate id, referenced by its children as ``child_key``.
    ``placement`` adds (column, type, DDL) placement columns such as an owner or a position;
    ``derived`` adds DDL-only columns (generated ones) that are never written or read as data.
    A spec column that collides with them, or a child column with its keys, refuses here."""
    keys = (ID,) + tuple((c, t) for c, t, _ in placement)
    cols = (ID_COLUMN,) + tuple(ddl for _, _, ddl in placement) + derived
    t = Table(spec, keys, {"id": child_key}, cols, indexes)
    check(t)
    return t


def check(t: Table) -> None:
    """No column name twice in any table of ``t``."""
    for name, lay in t.layout().items():
        keys = {c for c, _ in lay["keys"]}
        if name == t.spec.table:
            keys |= RESERVED
        clash = keys & {c for c, _ in lay["columns"]}
        if clash:
            raise ValueError(f"{name}: columns {sorted(clash)} collide with its keys")


class Context:
    """Agent ids by name, shared by the sections of one org.

    Encode: ``add_node`` gives each node, in document order, the next id; ``agent`` gives any
    other name a tombstone row. Decode: ``name`` reads them back."""

    def __init__(self) -> None:
        self.ids: dict[str, int] = {}
        self.names: dict[int, str] = {}
        self.tombstones: list[str] = []
        self._next = 1

    def add_node(self, name: str) -> int:
        if name in self.ids:
            raise ShapeError(f"node {name!r} twice")
        i = self._next
        self._next += 1
        self.ids[name] = i
        self.names[i] = name
        return i

    def agent(self, name: str) -> int:
        """The id of the row carrying ``name``, minting a tombstone for a name no node has."""
        i = self.ids.get(name)
        if i is None:
            i = self._next
            self._next += 1
            self.ids[name] = i
            self.names[i] = name
            self.tombstones.append(name)
        return i

    def name(self, agent_id: int) -> str:
        return self.names[agent_id]


class Section:
    """Owns ``keys`` of the document. ``encode`` reads ``doc[k]`` for the keys present (the
    framework has recorded presence and order already) and appends rows; ``decode`` sets
    ``doc[k]`` for the keys ``present`` lists (null ones are the framework's)."""
    keys: tuple[str, ...] = ()
    tables: tuple[Table, ...] = ()

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        raise NotImplementedError

    def decode(self, rows: Mapping[str, list[Mapping[str, Any]]], ctx: Context,
               present: Iterable[str], doc: dict[str, Any]) -> None:
        raise NotImplementedError

    # helpers shared by the kinds below
    def _children(self, rows: Mapping[str, list[Mapping[str, Any]]], t: Table) -> codec.Children:
        lay = t.layout()
        return codec.Children({n: rows.get(n, []) for n in lay if n != t.spec.table}, lay)


def _records(key: str, value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not all(isinstance(x, dict) for x in value):
        raise ShapeError(f"{key}: expected a list of objects, got {type(value).__name__}")
    return value


class RecordList(Section):
    """``doc[key]`` is a list of records: one row each, in order (``ord``)."""

    def __init__(self, key: str, spec: Spec, *, indexes: tuple[str, ...] = ()) -> None:
        self.keys = (key,)
        self.key = key
        self.t = table(spec, child_key=f"{spec.table}_id",
                       placement=(("ord", "bigint", "ord bigint NOT NULL"),),
                       indexes=(f"CREATE UNIQUE INDEX {spec.table}_ord ON orgtree.{spec.table} (ord)",)
                       + indexes)
        self.tables = (self.t,)

    def encode(self, doc: Mapping[str, Any], ctx: Context, out: Rows) -> None:
        if self.key not in doc or doc[self.key] is None:
            return
        base = len(out.get(self.t.spec.table, []))
        for i, rec in enumerate(_records(self.key, doc[self.key])):
            codec.encode(self.t.spec, rec, {"id": base + i + 1, "ord": i}, out, link=self.t.link)

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key not in present:
            return
        ch = self._children(rows, self.t)
        recs = sorted(rows.get(self.t.spec.table, []), key=lambda r: r["ord"])
        doc[self.key] = [codec.decode(self.t.spec, r, ch, (r["id"],)) for r in recs]


class StrList(Section):
    """``doc[key]`` is a list of strings: one row each, in order."""

    def __init__(self, key: str, table_name: str) -> None:
        self.keys = (key,)
        self.key = key
        spec = Spec(table_name, (codec.Field("value", "text"),), extra=False)
        self.t = Table(spec, (("ord", "bigint"),), {"ord": "ord"},
                       ("ord bigint PRIMARY KEY",))
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        if self.key not in doc or doc[self.key] is None:
            return
        v = doc[self.key]
        if not isinstance(v, list) or not all(codec.fits("text", x) for x in v):
            raise ShapeError(f"{self.key}: expected a list of strings")
        rows = out.setdefault(self.t.spec.table, [])
        for i, x in enumerate(v):
            rows.append({"ord": i, "value": x})

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key in present:
            doc[self.key] = [r["value"] for r in sorted(rows.get(self.t.spec.table, []),
                                                         key=lambda r: r["ord"])]


class ByAgentLists(Section):
    """``doc[key]`` is {agent name: [records]}: one row per record, by owner and position."""

    def __init__(self, key: str, spec: Spec, *, indexes: tuple[str, ...] = ()) -> None:
        self.keys = (key,)
        self.key = key
        t = spec.table
        self.t = table(spec, child_key=f"{t}_id",
                       placement=(("agent_id", "bigint",
                                   "agent_id bigint NOT NULL REFERENCES orgtree.agents (id) ON DELETE CASCADE"),
                                  ("idx", "integer", "idx integer NOT NULL")),
                       indexes=(f"CREATE UNIQUE INDEX {t}_owner ON orgtree.{t} (agent_id, idx)",)
                       + indexes)
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        v = doc.get(self.key)
        if v is None:
            return
        if not isinstance(v, dict):
            raise ShapeError(f"{self.key}: expected an object keyed by agent")
        owners = out.setdefault("org_section_owners", [])
        rows = out.get(self.t.spec.table, [])
        n = len(rows)
        for o, (name, recs) in enumerate(v.items()):
            aid = ctx.agent(name)
            if recs is None:
                owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "n"})
                continue
            owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "l"})
            for i, rec in enumerate(_records(f"{self.key}[{name}]", recs)):
                n += 1
                codec.encode(self.t.spec, rec, {"id": n, "agent_id": aid, "idx": i}, out,
                             link=self.t.link)

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key not in present:
            return
        ch = self._children(rows, self.t)
        by_owner: dict[int, list[Mapping[str, Any]]] = {}
        for r in rows.get(self.t.spec.table, []):
            by_owner.setdefault(r["agent_id"], []).append(r)
        out: dict[str, Any] = {}
        for o in sorted((r for r in rows.get("org_section_owners", []) if r["section"] == self.key),
                        key=lambda r: r["ord"]):
            name = ctx.name(o["agent_id"])
            if o["state"] == "n":
                out[name] = None
            else:
                recs = sorted(by_owner.get(o["agent_id"], []), key=lambda r: r["idx"])
                out[name] = [codec.decode(self.t.spec, r, ch, (r["id"],)) for r in recs]
        doc[self.key] = out


class ByAgentRecords(Section):
    """``doc[key]`` is {agent name: record}: one row per agent."""

    def __init__(self, key: str, spec: Spec) -> None:
        self.keys = (key,)
        self.key = key
        t = spec.table
        self.t = table(spec, child_key=f"{t}_id",
                       placement=(("agent_id", "bigint",
                                   "agent_id bigint NOT NULL UNIQUE REFERENCES orgtree.agents (id) "
                                   "ON DELETE CASCADE"),))
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        v = doc.get(self.key)
        if v is None:
            return
        if not isinstance(v, dict):
            raise ShapeError(f"{self.key}: expected an object keyed by agent")
        owners = out.setdefault("org_section_owners", [])
        n = len(out.get(self.t.spec.table, []))
        for o, (name, rec) in enumerate(v.items()):
            aid = ctx.agent(name)
            if rec is None:
                owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "n"})
                continue
            if not isinstance(rec, dict):
                raise ShapeError(f"{self.key}[{name}]: expected an object")
            owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "o"})
            n += 1
            codec.encode(self.t.spec, rec, {"id": n, "agent_id": aid}, out, link=self.t.link)

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key not in present:
            return
        ch = self._children(rows, self.t)
        by_owner = {r["agent_id"]: r for r in rows.get(self.t.spec.table, [])}
        out: dict[str, Any] = {}
        for o in sorted((r for r in rows.get("org_section_owners", []) if r["section"] == self.key),
                        key=lambda r: r["ord"]):
            name = ctx.name(o["agent_id"])
            if o["state"] == "n":
                out[name] = None
            else:
                r = by_owner[o["agent_id"]]
                out[name] = codec.decode(self.t.spec, r, ch, (r["id"],))
        doc[self.key] = out


class ByAgentMaps(Section):
    """``doc[key]`` is {agent name: {string: record}}: one row per record, by owner and key."""

    def __init__(self, key: str, spec: Spec) -> None:
        self.keys = (key,)
        self.key = key
        t = spec.table
        self.t = table(spec, child_key=f"{t}_id",
                       placement=(("agent_id", "bigint",
                                   "agent_id bigint NOT NULL REFERENCES orgtree.agents (id) ON DELETE CASCADE"),
                                  ("idx", "integer", "idx integer NOT NULL"),
                                  ("key", "text", '"key" text NOT NULL')),
                       indexes=(f'CREATE UNIQUE INDEX {t}_owner ON orgtree.{t} (agent_id, "key")',))
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        v = doc.get(self.key)
        if v is None:
            return
        if not isinstance(v, dict):
            raise ShapeError(f"{self.key}: expected an object keyed by agent")
        owners = out.setdefault("org_section_owners", [])
        n = len(out.get(self.t.spec.table, []))
        for o, (name, recs) in enumerate(v.items()):
            aid = ctx.agent(name)
            if recs is None:
                owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "n"})
                continue
            if not isinstance(recs, dict):
                raise ShapeError(f"{self.key}[{name}]: expected an object")
            owners.append({"section": self.key, "agent_id": aid, "ord": o, "state": "o"})
            for i, (k, rec) in enumerate(recs.items()):
                if not isinstance(rec, dict) or not codec.fits("text", k):
                    raise ShapeError(f"{self.key}[{name}][{k!r}]: expected an object")
                n += 1
                codec.encode(self.t.spec, rec, {"id": n, "agent_id": aid, "idx": i, "key": k},
                             out, link=self.t.link)

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key not in present:
            return
        ch = self._children(rows, self.t)
        by_owner: dict[int, list[Mapping[str, Any]]] = {}
        for r in rows.get(self.t.spec.table, []):
            by_owner.setdefault(r["agent_id"], []).append(r)
        out: dict[str, Any] = {}
        for o in sorted((r for r in rows.get("org_section_owners", []) if r["section"] == self.key),
                        key=lambda r: r["ord"]):
            name = ctx.name(o["agent_id"])
            if o["state"] == "n":
                out[name] = None
                continue
            recs = sorted(by_owner.get(o["agent_id"], []), key=lambda r: r["idx"])
            out[name] = {r["key"]: codec.decode(self.t.spec, r, ch, (r["id"],)) for r in recs}
        doc[self.key] = out


class Map(Section):
    """``doc[key]`` is {string: value}: one row per entry, in order. The value is a record
    (``spec``) or a scalar of kind ``item``."""

    def __init__(self, key: str, table_name: str, *, spec: Spec | None = None,
                 item: str = "") -> None:
        if (spec is None) == (not item):
            raise ValueError(f"{key}: a map needs exactly one of spec or item")
        self.keys = (key,)
        self.key = key
        self.item = item
        fields = (codec.Field("value", item),) if item else ()
        spec = spec if spec is not None else Spec(table_name, fields)
        if spec.table != table_name:
            raise ValueError(f"{key}: spec table {spec.table} is not {table_name}")
        self.t = table(spec, child_key=f"{table_name}_id",
                       placement=(("ord", "bigint", "ord bigint NOT NULL"),
                                  ("key", "text", '"key" text NOT NULL UNIQUE')))
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        v = doc.get(self.key)
        if v is None:
            return
        if not isinstance(v, dict):
            raise ShapeError(f"{self.key}: expected an object")
        n = len(out.get(self.t.spec.table, []))
        for i, (k, val) in enumerate(v.items()):
            if not codec.fits("text", k):
                raise ShapeError(f"{self.key}: a key no text column can hold")
            rec = {"value": val} if self.item else val
            if not self.item and not isinstance(rec, dict):
                raise ShapeError(f"{self.key}[{k}]: expected an object")
            n += 1
            codec.encode(self.t.spec, rec, {"id": n, "ord": i, "key": k}, out, link=self.t.link)

    def decode(self, rows, ctx, present, doc) -> None:
        if self.key not in present:
            return
        ch = self._children(rows, self.t)
        out: dict[str, Any] = {}
        for r in sorted(rows.get(self.t.spec.table, []), key=lambda r: r["ord"]):
            rec = codec.decode(self.t.spec, r, ch, (r["id"],))
            if self.item:
                if "value" not in rec or len(rec) != 1:
                    raise ShapeError(f"{self.key}[{r['key']}]: value lost")
                out[r["key"]] = rec["value"]
            else:
                out[r["key"]] = rec
        doc[self.key] = out


class Settings(Section):
    """Scalar and fixed-shape settings: one row of ``spec`` (its fields are top-level keys)."""

    def __init__(self, spec: Spec) -> None:
        self.keys = tuple(f.key for f in spec.fields)
        self.spec = spec
        self.t = Table(spec, (("singleton", "boolean"),), {"singleton": "singleton"},
                       ("singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)",))
        self.tables = (self.t,)

    def encode(self, doc, ctx, out) -> None:
        part = {k: doc[k] for k in self.keys if k in doc}
        codec.encode(self.spec, part, {"singleton": True}, out, link=self.t.link)
        # a settings key's null is the codec's (flag or extra), never org_sections' 'n'

    def decode(self, rows, ctx, present, doc) -> None:
        (row,) = rows.get(self.spec.table) or [{}]
        if not row:
            return
        rec = codec.decode(self.spec, row, self._children(rows, self.t), (True,))
        for k in self.keys:
            if k in rec:
                doc[k] = rec[k]


# ---------------------------------------------------------------- the whole document

FRAMEWORK_DDL = (
    """CREATE TABLE orgtree.org_sections (
  "key" text PRIMARY KEY,
  ord integer NOT NULL UNIQUE,
  state char(1) NOT NULL CHECK (state IN ('v', 'n'))
);""",
    """CREATE TABLE orgtree.org_section_owners (
  section text NOT NULL,
  agent_id bigint NOT NULL REFERENCES orgtree.agents (id) ON DELETE CASCADE,
  ord integer NOT NULL,
  state char(1) NOT NULL CHECK (state IN ('l', 'o', 'n')),
  PRIMARY KEY (section, agent_id),
  UNIQUE (section, ord)
);""",
)


def encode_document(doc: Mapping[str, Any], sections: Iterable[Section], *,
                    ignored: Iterable[str] = ()) -> tuple[Rows, Context, dict[str, Any]]:
    """Rows for one org document. Returns (rows by table, the agent Context, a report:
    {"ignored": {key: non-null?}, "extra_keys": [...]})."""
    sections = list(sections)
    owner: dict[str, Section] = {}
    for s in sections:
        for k in s.keys:
            if k in owner:
                raise ValueError(f"{k} is owned twice")
            owner[k] = s
    ignored = set(ignored)
    out: Rows = {"org_sections": [], "org_extra": [], "org_section_owners": []}
    report: dict[str, Any] = {"ignored": {}, "extra_keys": []}
    ord_ = 0
    for k, v in doc.items():
        if k in ignored:
            report["ignored"][k] = v is not None
            continue
        if k not in owner:
            if not codec.fits("json", v) and v is not None:
                raise ShapeError(f"{k}: a value no JSON column can hold")
            out["org_extra"].append({"key": k, "val": codec.to_column("json", v) if v is not None
                                     else codec.to_column("json", None)})
            report["extra_keys"].append(k)
        state = "n" if v is None and not isinstance(owner.get(k), Settings) else "v"
        out["org_sections"].append({"key": k, "ord": ord_, "state": state})
        ord_ += 1
    ctx = Context()
    for s in sections:          # nodes before any section that names agents (caller's order)
        s.encode(doc, ctx, out)
    for s in sections:          # then the tombstones those sections minted
        finish = getattr(s, "finish", None)
        if finish is not None:
            finish(ctx, out)
    return out, ctx, report


def decode_document(rows: Mapping[str, list[Mapping[str, Any]]], sections: Iterable[Section],
                    ctx: Context) -> dict[str, Any]:
    """The document ``encode_document`` was given, minus ignored keys, in its key order."""
    present = {r["key"]: r for r in rows.get("org_sections", [])}
    got: dict[str, Any] = {}
    for s in sections:
        mine = [k for k in s.keys if k in present and present[k]["state"] == "v"]
        s.decode(rows, ctx, mine, got)
    for r in rows.get("org_extra", []):
        got[r["key"]] = codec.from_column("json", r["val"])
    doc: dict[str, Any] = {}
    for r in sorted(present.values(), key=lambda r: r["ord"]):
        k = r["key"]
        if r["state"] == "n":
            doc[k] = None
        elif k in got:
            doc[k] = got[k]
        else:
            raise ShapeError(f"{k}: present but no section gave it back")
    return doc
