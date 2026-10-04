"""The exact codec between legacy JSON records and typed columns (design §3.0).

A record (a JSON object) is described by a ``Spec``: its table and an ordered
tuple of ``Field``s. ``encode`` turns one record into a row of typed columns
plus rows for its child tables; ``decode`` turns them back. The round trip is
exact for any record, because whatever a column cannot hold exactly goes to
the row's ``extra`` JSON instead:

* a value of another type than the column's (a float in an int column, a bool
  where an int is expected, a list where an object is expected);
* a string holding U+0000 or a lone UTF-16 surrogate (PostgreSQL text cannot store
  either: the second cannot even be encoded as UTF-8);
* a timestamp that does not parse, an int beyond bigint, ``-0.0`` in numeric;
* a present ``null`` in a field that has no ``<col>_null`` flag;
* a key the spec does not name.
* a text value outside a field's declared ``values`` set.

``extra`` mirrors the record's shape. A key whose field did not fit, or that
the spec does not know, appears at the top; a misfit inside a flattened object
appears inside that object's key. decode() builds the typed part and then
merges ``extra`` over it, so the result equals the input as canonical JSON
(sorted keys, exact types). Key order inside a record is not kept, and
canonical equality does not depend on it.

A value no JSON column can hold (a NaN or an infinity, which only Python's
non-standard JSON writes) raises ``ShapeError``, as does a record that is not
an object: shapes the mappers did not foresee. The converter then makes that
org unavailable with the reason (design §7, "a legacy shape the mapper did not
foresee"); it never drops data.

Field kinds:

  text   text              a str without U+0000 or a lone surrogate
  int    bigint            an int (never a bool) within bigint
  float  double precision  a finite float (ints stay out, so 5 and 5.0 keep
                           their types)
  num    numeric           an int or a finite float other than -0.0; a float
                           is written with at least one fraction digit and an
                           int with none, so each reads back as its own type
                           (design §3.0, "Numbers")
  bool   boolean
  ts     timestamptz       an ISO-8601 string with an offset or Z, kept in
         + <col>_text      microseconds; the original text is kept too when it
                           is not the engine's canonical ``...SS.mmmZ`` form
  json   json              any JSON value but a bare null, which is stored like
                           any scalar's null (flag or extra): a reader cannot
                           tell a JSON null column from SQL NULL. json, not
                           jsonb, keeps U+0000 escapes
  obj    <col>_is char(1)  a fixed-shape object flattened into this row as
                           ``<col>_<sub>`` columns; NULL absent, 'n' null,
                           'o' object, 'x' kept whole in extra
  list   <col>_is char(1)  a list stored as rows of a child table, keyed by
                           the parent's keys plus its position; NULL absent,
                           'n' null, 'l' list, 'x' kept whole in extra. Any
                           element that does not fit sends the whole list to
                           extra, so positions never have holes. A list of
                           records names its child table in its element spec;
                           a list of scalars names it in ``table`` and stores
                           ``value`` (plus ``value_text`` for timestamps)
  sum    typed tag, integer or float/compensation columns; the ledger's exact
         running-sum list, with a null/missing/misfit marker
  principal  typed recorded name/generation/born/deleted columns and kind;
         an exact string or object, with aliases for existing actor headers.
         Resolving a current-holder foreign key is the mapper/writer's job.
  turn_usage  the turn model-usage object, flattened as model_usage columns;
         a supported older bare list uses the same keys child table. Other
         shapes stay exact in extra, with distinct object/list/null markers.
  membership  a record-list shape marker without owned payload children;
         the owning mapper must supply its shared-table membership records.

A scalar's present ``null`` is stored in a ``<col>_null`` boolean when the
field is ``nullable`` (fields stored both ways on real data), else in extra.
Text fields can declare ``values``. Their later CHECK constraints allow SQL
NULL, so a legacy misfit converts without losing its value or failing a CHECK.
"""

from __future__ import annotations

import datetime as _dt
import functools
import math
import re
from dataclasses import dataclass
from decimal import Context, Decimal
from typing import Any, Iterable, Iterator, Mapping

MISSING: Any = object()

SCALARS = ("text", "int", "float", "num", "bool", "ts", "json")
KINDS = SCALARS + ("obj", "list", "sum", "principal", "turn_usage", "membership")
SHAPE_NULL, SHAPE_OBJECT, SHAPE_LIST, SHAPE_EXTRA = 'n', 'o', 'l', 'x'
MARKER_VALUES = {'obj': (SHAPE_NULL, SHAPE_OBJECT, SHAPE_EXTRA),
                 'list': (SHAPE_NULL, SHAPE_LIST, SHAPE_EXTRA),
                 'sum': (SHAPE_NULL, SHAPE_LIST, SHAPE_EXTRA),
                 'principal': (SHAPE_NULL, SHAPE_OBJECT, 's', SHAPE_EXTRA),
                 'turn_usage': (SHAPE_NULL, SHAPE_OBJECT, SHAPE_LIST, SHAPE_EXTRA),
                 'membership': (SHAPE_NULL, SHAPE_LIST, SHAPE_EXTRA)}
SQL_TYPES = {"text": "text", "int": "bigint", "float": "double precision", "num": "numeric",
             "bool": "boolean", "ts": "timestamptz", "json": "json"}
_INT_MIN, _INT_MAX = -(2 ** 63), 2 ** 63 - 1
_UTC = _dt.timezone.utc
_WIDE = Context(prec=1000)      # every finite double, written out in full


class ShapeError(ValueError):
    """A shape the mappers did not foresee (see the module docstring)."""


@dataclass(frozen=True)
class Spec:
    """A record's fields. ``table`` is empty for an object flattened into its
    parent row."""
    table: str
    fields: tuple["Field", ...]
    extra: bool = True

    def field(self, key: str) -> "Field | None":
        return _field_index(self).get(key)


@dataclass(frozen=True)
class Field:
    key: str
    kind: str
    col: str = ""
    nullable: bool = False
    spec: Spec | None = None        # obj: its flattened fields; list: the element record
    item: str = ""                  # list of scalars: the element kind
    table: str = ""                 # list of scalars: the child table
    values: tuple[str, ...] = ()    # text enum; unsupported values stay in extra
    principal_aliases: tuple[tuple[str, str], ...] = ()  # absolute physical column names

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"{self.key}: unknown kind {self.kind!r}")
        if not self.col:
            object.__setattr__(self, "col", self.key)
        if self.kind in ("obj", "turn_usage") and (self.spec is None or self.spec.table):
            raise ValueError(f"{self.key}: an obj field needs a table-less spec")
        if self.kind == "list":
            if self.spec is not None:
                if self.item or self.table or not self.spec.table:
                    raise ValueError(f"{self.key}: a list of records names its table in its spec")
            elif self.item not in SCALARS or not self.table:
                raise ValueError(f"{self.key}: a list of scalars needs item and table")
        elif self.item or self.table:
            raise ValueError(f"{self.key}: item/table are for lists of scalars")
        if self.nullable and self.kind not in SCALARS:
            raise ValueError(f"{self.key}: only scalars take a null flag")
        if not isinstance(self.values, tuple) or (self.values and (self.kind != "text"
                            or any(not isinstance(v, str) or "\x00" in v for v in self.values)
                            or len(set(self.values)) != len(self.values))):
            raise ValueError(f"{self.key}: values must be a tuple of distinct text enum members")
        if (not isinstance(self.principal_aliases, tuple)
                or (self.principal_aliases and self.kind != 'principal')
                or any(not isinstance(pair, tuple) or len(pair) != 2
                       or pair[0] not in ('node', 'generation', 'born', 'deleted')
                       or not isinstance(pair[1], str) or not pair[1]
                       for pair in self.principal_aliases)
                or len({pair[0] for pair in self.principal_aliases}) != len(self.principal_aliases)):
            raise ValueError(f'{self.key}: invalid principal column aliases')

    @property
    def child_table(self) -> str:
        return self.spec.table if self.spec is not None else self.table


@functools.lru_cache(maxsize=None)
def _field_index(spec: Spec) -> dict[str, Field]:
    return {f.key: f for f in spec.fields}


# ---------------------------------------------------------------- scalars

def canonical_ts(d: _dt.datetime) -> str:
    """The engine's own form (ledger.now): UTC, milliseconds, ``Z``."""
    d = d.astimezone(_UTC)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def parse_ts(s: Any) -> _dt.datetime | None:
    """An aware datetime for an ISO-8601 string with an offset or Z, else None."""
    if not isinstance(s, str) or len(s) < 16 or "\x00" in s:
        return None
    try:
        d = _dt.datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s)
    except ValueError:
        return None
    return d if d.tzinfo is not None else None


def ts_text(v: str) -> str | None:
    """The text to keep beside a timestamp, or None when it is canonical."""
    d = parse_ts(v)
    return None if d is not None and canonical_ts(d) == v else v


def num_to_decimal(v: int | float) -> Decimal:
    if isinstance(v, int):
        return Decimal(v)
    d = Decimal(repr(v))
    if d.as_tuple().exponent >= 0:            # 1e20 or 5.0's integral cousins: keep a
        d = d.quantize(Decimal("0.1"), context=_WIDE)   # fraction digit, so it stays a float
    return d


def decimal_to_num(d: Decimal) -> int | float:
    return int(d) if d.as_tuple().exponent == 0 else float(d)


def _json_ok(v: Any) -> bool:
    """Whether a JSON column can hold ``v``: no NaN or infinity anywhere."""
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, float):
            if not math.isfinite(x):
                return False
        elif isinstance(x, dict):
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
    return True


#: a code point PostgreSQL text cannot hold besides U+0000: half of a UTF-16 pair, alone (a
#: str holds a character beyond the BMP as one code point, so a whole pair never matches)
_LONE_SURROGATE = re.compile('[\ud800-\udfff]')


def fits(kind: str, v: Any) -> bool:
    """Whether a present, non-null value can be stored exactly in ``kind``."""
    if kind == "text":
        return isinstance(v, str) and "\x00" not in v and _LONE_SURROGATE.search(v) is None
    if kind == "int":
        return isinstance(v, int) and not isinstance(v, bool) and _INT_MIN <= v <= _INT_MAX
    if kind == "float":
        return isinstance(v, float) and math.isfinite(v)
    if kind == "num":
        if isinstance(v, bool):
            return False
        if isinstance(v, int):
            return True
        return (isinstance(v, float) and math.isfinite(v)
                and not (v == 0.0 and math.copysign(1.0, v) < 0))
    if kind == "bool":
        return isinstance(v, bool)
    if kind == "ts":
        return parse_ts(v) is not None
    if kind == "json":
        return v is not None and _json_ok(v)
    raise ValueError(kind)


def to_column(kind: str, v: Any) -> Any:
    """The column value for a fitting value (see fits)."""
    if kind == "num":
        return num_to_decimal(v)
    if kind == "ts":
        return parse_ts(v)
    if kind == "json":
        from psycopg.types.json import Json   # noqa: PLC0415
        return Json(v)
    return v


def from_column(kind: str, v: Any, text: Any = None) -> Any:
    if kind == "num":
        return decimal_to_num(v if isinstance(v, Decimal) else Decimal(str(v)))
    if kind == "ts":
        return text if text is not None else canonical_ts(v)
    if kind == "float":
        return float(v)
    if kind == "json" and hasattr(v, "obj"):     # an unsent Json wrapper (in-memory round trip)
        return v.obj
    return v


# ---------------------------------------------------------------- layout

def pos_col(depth: int) -> str:
    return "pos" if depth == 1 else f"pos_{depth}"


@functools.lru_cache(maxsize=None)
def columns(spec: Spec, prefix: str = "") -> tuple[tuple[str, str], ...]:
    """(column, SQL type) of one row of ``spec``, flattened objects included,
    in a stable order. Key columns and ``extra`` are not included."""
    out: list[tuple[str, str]] = []
    for f in spec.fields:
        c = prefix + f.col
        if f.kind == 'sum':
            from . import estimate_columns
            out.extend(estimate_columns.columns(c))
        elif f.kind == 'turn_usage':
            assert f.spec is not None
            out.append((c + '_is', 'char(1)'))
            out.extend(columns(f.spec, c.removesuffix('_key') + '_'))
        elif f.kind == 'principal':
            from . import principal_columns
            out.extend(principal_columns.columns(c, dict(f.principal_aliases)))
        elif f.kind in SCALARS:
            out.append((c, SQL_TYPES[f.kind]))
            if f.kind == "ts":
                out.append((c + "_text", "text"))
            if f.nullable:
                out.append((c + "_null", "boolean"))
        else:
            out.append((c + "_is", "char(1)"))
            if f.kind == "obj":
                assert f.spec is not None
                out.extend(columns(f.spec, c + "_"))
    names = [c for c, _ in out]
    if len(set(names)) != len(names):
        dup = sorted({c for c in names if names.count(c) > 1})
        raise ValueError(f"{spec.table or prefix}: column names collide: {dup}")
    return tuple(out)


def _lists(spec: Spec) -> Iterator[Field]:
    """The list fields of one row of ``spec``, inside flattened objects too."""
    for f in spec.fields:
        if f.kind == "list":
            yield f
        elif f.kind in ("obj", "turn_usage"):
            assert f.spec is not None
            yield from _lists(f.spec)


def enumerated(spec: Spec, prefix: str = "", path: tuple[str, ...] = ()
               ) -> Iterator[tuple[str, tuple[str, ...], tuple[str, ...]]]:
    """Enum columns, record-local JSON paths and sets; child specs have their own rows.

    CHECKs live in a later migration, so the original generated DDL is unchanged.
    """
    for f in spec.fields:
        if f.values:
            yield prefix + f.col, path + (f.key,), f.values
        elif f.kind in ("obj", "turn_usage"):
            assert f.spec is not None
            sub = (prefix + f.col).removesuffix('_key') if f.kind == 'turn_usage' else prefix + f.col
            yield from enumerated(f.spec, sub + "_", path + (f.key,))


def markers(spec: Spec, prefix: str = "", path: tuple[str, ...] = ()
            ) -> Iterator[tuple[str, tuple[str, ...], tuple[str, ...]]]:
    """Derived shape markers of this row; list children have their own specs."""
    for f in spec.fields:
        if f.kind in MARKER_VALUES:
            yield prefix + f.col + '_is', path + (f.key,), MARKER_VALUES[f.kind]
            if f.kind in ('obj', 'turn_usage'):
                assert f.spec is not None
                sub = (prefix + f.col).removesuffix('_key') if f.kind == 'turn_usage' else prefix + f.col
                yield from markers(f.spec, sub + '_', path + (f.key,))


def _linked(keys: Mapping[str, Any], link: Mapping[str, str] | None) -> dict[str, Any]:
    """A record's key values under the names its children use. Without
    ``link`` the children carry every key column under its own name. With it
    they carry only the columns ``link`` names, renamed (e.g. {"id":
    "agent_id"}): a record table placed by more columns than its key (an
    owner, an order) is still referenced by its key alone."""
    if link is None:
        return dict(keys)
    return {new: keys[old] for old, new in link.items()}


def layout(spec: Spec, keys: tuple[tuple[str, str], ...],
           link: Mapping[str, str] | None = None) -> dict[str, dict[str, Any]]:
    """Every table one record of ``spec`` writes: ``{table: {"keys": ((col,
    type), ...), "parent_table": str, "parent_cols": (col, ...) (in this
    table), "ref_cols": (col, ...) (in the parent), "pos": col, "columns":
    ((col, type), ...), "extra": bool, "spec": Spec | None, "item": kind}}``.
    ``keys`` are the record table's own key columns; ``link`` renames them for
    its children (e.g. {"id": "agent_id"})."""
    out: dict[str, dict[str, Any]] = {}
    out[spec.table] = {"keys": keys, "parent_table": "", "parent_cols": (), "ref_cols": (),
                       "pos": "", "columns": columns(spec), "extra": spec.extra, "spec": spec,
                       "item": ""}

    def walk(s: Spec, own: tuple[tuple[str, str], ...], as_parent: tuple[tuple[str, str], ...],
             depth: int) -> None:
        for f in _lists(s):
            child = as_parent + ((pos_col(depth), "integer"),)
            entry = {"keys": child, "parent_table": s.table,
                     "parent_cols": tuple(c for c, _ in as_parent),
                     "ref_cols": tuple(c for c, _ in own), "pos": pos_col(depth)}
            if f.child_table in out:
                raise ValueError(f"{spec.table}: child table {f.child_table} is used twice")
            if f.spec is not None:
                out[f.child_table] = {**entry, "columns": columns(f.spec), "extra": f.spec.extra,
                                      "spec": f.spec, "item": ""}
                walk(f.spec, child, child, depth + 1)
            else:
                cols: tuple[tuple[str, str], ...] = (("value", SQL_TYPES[f.item]),)
                if f.item == "ts":
                    cols += (("value_text", "text"),)
                out[f.child_table] = {**entry, "columns": cols, "extra": False, "spec": None,
                                      "item": f.item}

    if link is None:
        own, as_parent = keys, keys
    else:
        types = dict(keys)
        own = tuple((old, types[old]) for old in link)
        as_parent = tuple((new, types[old]) for old, new in link.items())
    walk(spec, own, as_parent, 1)
    return out


def quote(name: str) -> str:
    """A column name quoted for SQL: legacy keys include reserved words
    (``grant``, ``order``, ``user``), and every name here is lower case, so
    quoting never changes which column is meant."""
    return '"' + name.replace('"', '""') + '"'


def quoted(names: Iterable[str]) -> str:
    return ", ".join(quote(n) for n in names)


def ddl(spec: Spec, keys: tuple[tuple[str, str], ...], *, link: Mapping[str, str] | None = None,
        schema: str = "orgtree", record_columns: tuple[str, ...] = ()) -> list[str]:
    """CREATE TABLE statements for ``spec``'s tables (the record table first).
    ``record_columns`` are column definitions placed first in the record table
    (its surrogate key, columns the mapper derives, row_version ...), written
    as given; a key column they define is not repeated."""
    stmts = []
    for i, (table, t) in enumerate(layout(spec, keys, link).items()):
        defs: list[str] = []
        if i == 0:
            defs.extend(record_columns)
            given = {rc.split()[0].strip('"') for rc in record_columns}
            defs.extend(f"{quote(c)} {typ} NOT NULL" for c, typ in t["keys"] if c not in given)
        else:
            defs.extend(f"{quote(c)} {typ} NOT NULL" for c, typ in t["keys"])
        defs.extend(f"{quote(c)} {typ}" for c, typ in t["columns"])
        if t["extra"]:
            defs.append('"extra" json')
        if i > 0:
            defs.append(f"PRIMARY KEY ({quoted(c for c, _ in t['keys'])})")
            defs.append(f"FOREIGN KEY ({quoted(t['parent_cols'])}) REFERENCES "
                        f"{schema}.{t['parent_table']} ({quoted(t['ref_cols'])}) "
                        "ON DELETE CASCADE")
        body = ",\n  ".join(defs)
        stmts.append(f"CREATE TABLE {schema}.{table} (\n  {body}\n);")
    return stmts


# ---------------------------------------------------------------- encode

Rows = dict[str, list[dict[str, Any]]]


def encode(spec: Spec, record: Any, keys: Mapping[str, Any], out: Rows, *,
           link: Mapping[str, str] | None = None, depth: int = 1) -> None:
    """Append ``record``'s row (``keys`` + columns + extra) to
    ``out[spec.table]`` and its child rows to their tables. ``link`` renames
    the record's keys for its children (see layout)."""
    if not isinstance(record, dict):
        raise ShapeError(f"{spec.table}: expected an object, got {type(record).__name__}")
    row: dict[str, Any] = dict(keys)
    extra: dict[str, Any] = {}
    _fill(spec, record, row, extra, "", _linked(keys, link), out, depth)
    if extra:
        if not spec.extra:
            raise ShapeError(f"{spec.table}: no extra column for {sorted(extra)}")
        if not _json_ok(extra):
            raise ShapeError(f"{spec.table}: a NaN or infinity no JSON column can hold")
        row["extra"] = to_column("json", extra)
    elif spec.extra:
        row["extra"] = None
    out.setdefault(spec.table, []).append(row)


def _fill(spec: Spec, record: dict[str, Any], row: dict[str, Any], extra: dict[str, Any],
          prefix: str, keys: Mapping[str, Any], out: Rows, depth: int) -> None:
    index = _field_index(spec)
    for f in spec.fields:
        c = prefix + f.col
        v = record.get(f.key, MISSING)
        if f.kind in ('sum', 'principal'):
            # The adapters use physical names. Extra remains at this record's
            # original JSON path, including when a parent object is flattened.
            if f.kind == 'sum':
                from . import estimate_columns
                typed, remaining = estimate_columns.encode(c, v)
            else:
                from . import principal_columns
                typed, remaining = principal_columns.encode(
                    c, v, aliases=dict(f.principal_aliases))
            row.update(typed)
            if c in remaining:
                extra[f.key] = remaining[c]
        elif f.kind in SCALARS:
            row[c] = None
            if f.kind == "ts":
                row[c + "_text"] = None
            if f.nullable:
                row[c + "_null"] = None
            if v is MISSING:
                continue
            if v is None:
                if f.nullable:
                    row[c + "_null"] = True
                else:
                    extra[f.key] = None
            elif fits(f.kind, v) and (not f.values or v in f.values):
                row[c] = to_column(f.kind, v)
                if f.kind == "ts":
                    row[c + "_text"] = ts_text(v)
            else:
                extra[f.key] = v
        elif f.kind == 'membership':
            # Membership payloads live in their shared table. The owning mapper
            # supplies them; the node row holds only the original container shape.
            if v is MISSING:
                row[c + '_is'] = None
            elif v is None:
                row[c + '_is'] = SHAPE_NULL
            elif isinstance(v, list) and all(isinstance(x, dict) for x in v):
                row[c + '_is'] = SHAPE_LIST
            else:
                row[c + '_is'] = SHAPE_EXTRA
                extra[f.key] = v
        elif f.kind in ("obj", "turn_usage"):
            assert f.spec is not None
            sub_prefix = (c.removesuffix('_key') if f.kind == 'turn_usage' else c) + '_'
            for sc, _ in columns(f.spec, sub_prefix):
                row[sc] = None
            if v is MISSING:
                row[c + "_is"] = None
            elif v is None:
                row[c + "_is"] = SHAPE_NULL
            elif isinstance(v, dict):
                row[c + "_is"] = SHAPE_OBJECT
                sub: dict[str, Any] = {}
                _fill(f.spec, v, row, sub, sub_prefix, keys, out, depth)
                if sub:
                    extra[f.key] = sub
            elif f.kind == 'turn_usage' and isinstance(v, list) and all(fits('text', x) for x in v):
                row[c + '_is'] = SHAPE_LIST
                _fill(f.spec, {'keys': v}, row, {}, sub_prefix, keys, out, depth)
            else:
                row[c + "_is"] = SHAPE_EXTRA
                extra[f.key] = v
        else:
            if v is MISSING:
                row[c + "_is"] = None
            elif v is None:
                row[c + "_is"] = SHAPE_NULL
            elif isinstance(v, list) and _list_fits(f, v):
                row[c + "_is"] = SHAPE_LIST
                _encode_list(f, v, keys, out, depth)
            else:
                row[c + "_is"] = SHAPE_EXTRA
                extra[f.key] = v
    for k, v in record.items():
        if k not in index:
            extra[k] = v


def _list_fits(f: Field, items: list[Any]) -> bool:
    if f.spec is None:
        return all(x is not None and fits(f.item, x) for x in items)
    return all(isinstance(x, dict) for x in items)


def _encode_list(f: Field, items: list[Any], keys: Mapping[str, Any], out: Rows, depth: int) -> None:
    pc = pos_col(depth)
    if f.spec is None:
        rows = out.setdefault(f.table, [])
        for i, x in enumerate(items):
            r = dict(keys)
            r[pc] = i
            r["value"] = to_column(f.item, x)
            if f.item == "ts":
                r["value_text"] = ts_text(x)
            rows.append(r)
        return
    for i, x in enumerate(items):
        child = dict(keys)
        child[pc] = i
        encode(f.spec, x, child, out, depth=depth + 1)


# ---------------------------------------------------------------- decode

class Children:
    """Child rows grouped by table and parent key, each group in position
    order: ``Children(rows_by_table, layout)`` with ``layout`` from layout()."""

    def __init__(self, tables: Mapping[str, Iterable[Mapping[str, Any]]],
                 lay: Mapping[str, Mapping[str, Any]]) -> None:
        self._groups: dict[str, dict[tuple[Any, ...], list[Mapping[str, Any]]]] = {}
        for table, rows in tables.items():
            t = lay.get(table)
            if t is None or not t["pos"]:
                continue
            parent, pc = t["parent_cols"], t["pos"]
            groups: dict[tuple[Any, ...], list[Mapping[str, Any]]] = {}
            for r in rows:
                groups.setdefault(tuple(r[k] for k in parent), []).append(r)
            for g in groups.values():
                g.sort(key=lambda r: r[pc])
            self._groups[table] = groups

    def of(self, table: str, parent: tuple[Any, ...]) -> list[Mapping[str, Any]]:
        return self._groups.get(table, {}).get(parent, [])


def decode(spec: Spec, row: Mapping[str, Any], children: Children | None,
           parent: tuple[Any, ...] = (), *, depth: int = 1) -> dict[str, Any]:
    """The record ``encode`` was given. ``parent`` is this row's own key
    values in key-column order (the prefix of its children's keys)."""
    out = _read(spec, row, children, parent, "", depth)
    extra = row.get("extra") if spec.extra else None
    if extra is not None:
        if hasattr(extra, "obj"):          # an unsent Json wrapper (in-memory round trip)
            extra = extra.obj
        _merge(spec, out, extra)
    return out


def _read(spec: Spec, row: Mapping[str, Any], children: Children | None,
          parent: tuple[Any, ...], prefix: str, depth: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in spec.fields:
        c = prefix + f.col
        if f.kind in ('sum', 'principal'):
            # Exceptional shapes come from extra during the same merge used by
            # every other field. Typed objects merge their individual misfits.
            if row.get(c + '_is') == SHAPE_EXTRA:
                continue
            if f.kind == 'sum':
                from . import estimate_columns
                value = estimate_columns.decode(c, row, {})
            else:
                from . import principal_columns
                value = principal_columns.decode(c, row, {}, aliases=dict(f.principal_aliases))
            if value is not MISSING:
                out[f.key] = value
            continue
        if f.kind in SCALARS:
            v = row.get(c)
            if v is not None:
                out[f.key] = from_column(f.kind, v, row.get(c + "_text") if f.kind == "ts" else None)
            elif f.nullable and row.get(c + "_null"):
                out[f.key] = None
            continue
        state = row.get(c + "_is")
        if f.kind == 'membership' and state == SHAPE_LIST:
            raise ValueError(f'{f.key}: the membership reader must supply the records')
        if state == SHAPE_NULL:
            out[f.key] = None
        elif state == SHAPE_OBJECT:
            assert f.spec is not None
            sub_prefix = (c.removesuffix('_key') if f.kind == 'turn_usage' else c) + '_'
            out[f.key] = _read(f.spec, row, children, parent, sub_prefix, depth)
        elif state == SHAPE_LIST:
            if f.kind == 'turn_usage':
                assert f.spec is not None
                keys_field = f.spec.field('keys')
                assert keys_field is not None
                out[f.key] = _read_list(keys_field, children, parent, depth)
            else:
                out[f.key] = _read_list(f, children, parent, depth)
    return out


def _read_list(f: Field, children: Children | None, parent: tuple[Any, ...],
               depth: int) -> list[Any]:
    if children is None:
        raise ValueError(f"{f.key}: child rows needed")
    rows = children.of(f.child_table, parent)
    if f.spec is None:
        return [from_column(f.item, r["value"], r.get("value_text") if f.item == "ts" else None)
                for r in rows]
    pc = pos_col(depth)
    return [decode(f.spec, r, children, parent + (r[pc],), depth=depth + 1) for r in rows]


def _merge(spec: Spec | None, out: dict[str, Any], extra: Mapping[str, Any]) -> None:
    """Merge ``extra`` over a decoded record: into a flattened object that is
    present, recursively; everything else replaces."""
    for k, v in extra.items():
        f = spec.field(k) if spec is not None else None
        if (f is not None and f.kind in ("obj", "principal", "turn_usage") and isinstance(out.get(k), dict)
                and isinstance(v, dict)):
            _merge(f.spec, out[k], v)
        else:
            out[k] = v
