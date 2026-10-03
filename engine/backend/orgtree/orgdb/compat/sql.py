"""store.py's own SQL, answered from an org database (the compatibility view's registry).

Every statement store.py issues against the five legacy tables is listed here by its exact
text (whitespace collapsed; a variable ``IN (?,?,...)`` list written ``IN (?*)``), with the
handler that answers it from ``rows``. Handlers return what the legacy statement returned:
the same columns in the same order, the same rowcount for a write, the new seq as
``lastrowid`` for a log insert.

Three kinds of statement besides the ordinary ones:

* PASS: plain server calls with no legacy table in them (advisory locks, the snapshot text,
  the server's identity); they run as they are on the org database.
* DECLINED: a reader whose guard asks whether a section is still stored as a pre-row blob,
  answered "yes" so the reader takes its whole-org load path. None is declined now: the
  bounded window readers (presentations, a node's history, the inbox tails) are served
  (piece A6), because their load path cost 0.9-1.5 s per window on the live org's copy.
* UNREACHABLE in this mode: SQLite-only, migration-only and receipt-row statements; and the
  mail-archive append door, whose bound the projection never hands out (the caller takes its
  ordinary path). They raise if reached.

A statement that is not listed raises ``UnknownStatement``: the view never guesses.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Callable, Sequence

from .. import codec
from . import rows as R
from .rows import CompatError, Names

_WS = re.compile(r"\s+")
_IN_LIST = re.compile(r"IN \(\?(?:\s*,\s*\?)*\)")


class UnknownStatement(CompatError):
    """store.py issued a statement this view does not serve."""


def normalize(sql: str) -> str:
    s = _WS.sub(" ", sql).strip().rstrip(";").strip()
    return _IN_LIST.sub("IN (?*)", s)


class Result:
    """The cursor store.py reads (pgstore._Cursor's surface)."""
    __slots__ = ("_rows", "_i", "rowcount", "lastrowid", "is_write")

    def __init__(self, rows: Sequence[tuple[Any, ...]] = (), rowcount: int = -1,
                 lastrowid: int | None = None, *, write: bool = False) -> None:
        self._rows = list(rows)
        self._i = 0
        self.rowcount = rowcount if rowcount != -1 else (len(self._rows) if not write else -1)
        self.lastrowid = lastrowid
        self.is_write = write

    def fetchone(self) -> tuple[Any, ...] | None:
        if self._i >= len(self._rows):
            return None
        r = self._rows[self._i]
        self._i += 1
        return r

    def fetchall(self) -> list[tuple[Any, ...]]:
        r = self._rows[self._i:]
        self._i = len(self._rows)
        return r

    def __iter__(self):
        while True:
            r = self.fetchone()
            if r is None:
                return
            yield r


def _w(n: int, lastrowid: int | None = None) -> Result:
    return Result((), n, lastrowid, write=True)


Handler = Callable[[Any, Sequence[Any]], Result]
HANDLERS: dict[str, Handler] = {}
PATTERNS: list[tuple[re.Pattern[str], Callable[[Any, Sequence[Any], re.Match[str]], Result]]] = []
PASS: set[str] = set()
DECLINED: set[str] = set()
UNREACHABLE: dict[str, str] = {}


def stmt(*texts: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        for t in texts:
            n = normalize(t)
            if n in HANDLERS:
                raise RuntimeError(f"statement registered twice: {n}")
            HANDLERS[n] = fn
        return fn
    return deco


def _m() -> R.Model:
    return R.model()


def _names(conn: Any) -> Names:
    return Names(conn.raw)


def _log(table: str, sect: str) -> R.LogSect | None:
    ls = _m().logs.get(sect)
    return ls if ls is not None and ls.log == table else None


def _need_log(table: str, sect: str) -> R.LogSect:
    ls = _log(table, sect)
    if ls is None:
        raise CompatError(f"{table} has no section {sect!r}")
    return ls


# ----------------------------------------------------------------- doc rows

@stmt("SELECT val FROM doc WHERE key=?", "SELECT val FROM doc WHERE key='user_inbox'")
def _doc_val(conn: Any, p: Sequence[Any]) -> Result:
    key = p[0] if p else "user_inbox"
    got = R.doc_get(conn.raw, key)
    return Result([] if got is None else [(got[1],)])


@stmt("SELECT key, val, xmin::text FROM doc WHERE key = ?")
def _doc_val_xmin(conn: Any, p: Sequence[Any]) -> Result:
    got = R.doc_get(conn.raw, p[0])
    return Result([] if got is None else [(p[0], got[1], got[0].split(":", 1)[0])])


@stmt("SELECT val, xmin::text, ctid::text, tableoid::text FROM doc WHERE key=?")
def _item_versioned(conn: Any, p: Sequence[Any]) -> Result:
    kind, _, slug = R.kind_of(p[0])
    if kind != "item":
        raise CompatError(f"versioned doc read of {p[0]!r}: only docket items are versioned")
    got = R.item(conn.raw, slug)
    return Result([] if got is None else [(got[1], *got[0])])


@stmt("SELECT key, val, xmin::text, ctid::text, tableoid::text FROM doc WHERE key = ANY(?)")
def _items_versioned(conn: Any, p: Sequence[Any]) -> Result:
    m = _m()
    slugs = []
    for key in p[0]:
        kind, _, slug = R.kind_of(key)
        if kind != "item":
            raise CompatError(f"versioned doc read of {key!r}: only docket items are versioned")
        slugs.append(slug)
    got = R.items(conn.raw, slugs)
    return Result([(m.workrows.PREFIX + s, text, *version.split(":"))
                   for s, (version, text) in got.items()])


def _listing(conn: Any, prefix: str) -> tuple[Any, Any, Any, Any]:
    if prefix != _m().workrows.PREFIX:
        raise CompatError(f"version listing of {prefix!r}: only the docket is listed")
    pairs = sorted((_m().workrows.PREFIX + s, v) for s, v in R.active_items(conn.raw))
    if not pairs:
        return (None, None, None, None)
    return ([k for k, _ in pairs], [v[0] for _, v in pairs], [v[1] for _, v in pairs],
            [v[2] for _, v in pairs])


@stmt("SELECT array_agg(key ORDER BY key), array_agg(xmin::text ORDER BY key), "
      "array_agg(ctid::text ORDER BY key), array_agg(tableoid::text ORDER BY key) "
      "FROM doc WHERE starts_with(key, ?)")
def _work_listing(conn: Any, p: Sequence[Any]) -> Result:
    return Result([_listing(conn, p[0])])


@stmt("SELECT (SELECT val FROM doc WHERE key = ?), array_agg(key ORDER BY key), "
      "array_agg(xmin::text ORDER BY key), array_agg(ctid::text ORDER BY key), "
      "array_agg(tableoid::text ORDER BY key) FROM doc WHERE starts_with(key, ?)")
def _work_header_listing(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        got = R.doc_get(conn.raw, p[0])
        return Result([(None if got is None else got[1], *_listing(conn, p[1]))])


@stmt("SELECT key, val FROM doc WHERE key = ? OR starts_with(key, ?)")
def _work_whole(conn: Any, p: Sequence[Any]) -> Result:
    m = _m()
    with conn.atomic():
        out = []
        got = R.doc_get(conn.raw, p[0])
        if got is not None:
            out.append((p[0], got[1]))
        if p[1] != m.workrows.PREFIX:
            raise CompatError(f"prefix read of {p[1]!r}")
        out += [(m.workrows.PREFIX + s, text) for s, (_, text) in R.items(conn.raw).items()]
        return Result(out)


def _prefix_rows(conn: Any, prefix: str, *, versions: bool = False) -> list[tuple[Any, ...]]:
    m = _m()
    sect, sep, rest = prefix.partition(R.SEP)
    if not sep or rest:
        raise CompatError(f"prefix read of {prefix!r}")
    if sect in m.split:
        got = R.owner_rows(conn.raw, sect)
        return [((prefix + o, t, v.split(":", 1)[0]) if versions else (prefix + o, t))
                for o, (v, t) in got.items()]
    if sect == m.workrows.SECTION:
        got = R.items(conn.raw)
        return [((prefix + s, t, v.split(":", 1)[0]) if versions else (prefix + s, t))
                for s, (v, t) in got.items()]
    raise CompatError(f"prefix read of {prefix!r}")


@stmt("SELECT key, val FROM doc WHERE substr(key, 1, ?) = ?")
def _doc_prefix(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result(_prefix_rows(conn, p[1]))


@stmt("SELECT key, val, xmin::text FROM doc WHERE substr(key, 1, ?) = ?")
def _doc_prefix_x(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result(_prefix_rows(conn, p[1], versions=True))


@stmt("SELECT 1 FROM doc WHERE substr(key, 1, ?) = ? LIMIT 1")
def _doc_prefix_any(conn: Any, p: Sequence[Any]) -> Result:
    m = _m()
    sect = p[1].partition(R.SEP)[0]
    c = conn.raw
    if sect in m.split:
        hit = c.execute("SELECT EXISTS (SELECT 1 FROM orgtree.org_section_owners WHERE section = %s "
                        "AND state = 'l')", (sect,)).fetchone()[0]
    elif sect == m.workrows.SECTION:
        hit = c.execute("SELECT EXISTS (SELECT 1 FROM orgtree.work_items WHERE list_key = 'active')"
                        ).fetchone()[0]
    else:
        raise CompatError(f"prefix probe of {p[1]!r}")
    return Result([(1,)] if hit else [])


@stmt("SELECT key, val, xmin::text FROM doc WHERE key = ANY(?)")
def _doc_any_x(conn: Any, p: Sequence[Any]) -> Result:
    out = []
    with conn.atomic():
        names = _names(conn)
        by_sect: dict[str, list[str]] = {}
        for key in p[0]:
            kind, sect, rest = R.kind_of(key)
            if kind == "owner":
                by_sect.setdefault(sect, []).append(rest)
            else:
                got = R.doc_get(conn.raw, key, names=names)
                if got is not None:
                    out.append((key, got[1], got[0].split(":", 1)[0]))
        for sect, owners in by_sect.items():
            for o, (v, t) in R.owner_rows(conn.raw, sect, owners, names=names).items():
                out.append((sect + R.SEP + o, t, v.split(":", 1)[0]))
    return Result(out)


def _doc_in(conn: Any, keys: Sequence[str]) -> list[tuple[str, str]]:
    out = []
    with conn.atomic():
        names = _names(conn)
        for key in dict.fromkeys(keys):
            got = R.doc_get(conn.raw, key, names=names)
            if got is not None:
                out.append((key, got[1]))
    return out


@stmt("SELECT key,val FROM doc WHERE key IN (?*)")
def _doc_in_params(conn: Any, p: Sequence[Any]) -> Result:
    return Result(_doc_in(conn, list(p)))


@stmt("SELECT key, val FROM doc WHERE key IN ('slug','net_identity')")
def _doc_in_net(conn: Any, p: Sequence[Any]) -> Result:
    return Result(_doc_in(conn, ("slug", "net_identity")))


@stmt("SELECT key,val FROM doc WHERE key IN ('user_inbox','user_mail_log','user_outbox')")
def _doc_in_user(conn: Any, p: Sequence[Any]) -> Result:
    return Result(_doc_in(conn, ("user_inbox", "user_mail_log", "user_outbox")))


@stmt("SELECT key, val FROM doc WHERE strpos(key, ?) = 0")
def _doc_plain(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(k, t) for k, (_, t) in R.doc_rows(conn.raw).items()])


@stmt("SELECT key, CASE WHEN key = ANY(?) THEN NULL ELSE val END FROM doc WHERE strpos(key, ?) = 0")
def _doc_eager(conn: Any, p: Sequence[Any]) -> Result:
    deferred = set(p[0])
    with conn.atomic():
        return Result([(k, None if k in deferred else t)
                       for k, (_, t) in R.doc_rows(conn.raw).items()])


def eager_versioned(conn: Any, deferred: Sequence[str], held: Sequence[str]) -> list[tuple[Any, ...]]:
    """(key, version, text or NULL) of the plain doc rows: NULL for a deferred key and for a
    row whose ``key|version`` the caller holds."""
    deferred_set, held_set = set(deferred), set(held)
    names = _names(conn)
    out = []
    for key, _, state, version in R.sections_rows(conn.raw):
        if key in deferred_set or f"{key}|{version}" in held_set:
            if R.key_has_row(key, state):
                out.append((key, version, None))
            continue
        text = R.key_text(conn.raw, key, state, names)
        if text is not None:
            out.append((key, version, text))
    return out


def _eager_sql() -> str:
    from ... import store   # noqa: PLC0415
    return (f"SELECT key, {store._ROW_VERSION}, {store._EAGER_DOC_VAL} "
            "FROM doc WHERE strpos(key, ?) = 0")


@stmt("SELECT key, val FROM doc WHERE NOT starts_with(key, ?)")
def _doc_not_items(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(k, t) for k, (_, t) in R.doc_rows(conn.raw, with_items=True).items()
                       if not k.startswith(p[0])])


@stmt("SELECT key, val FROM doc")
def _doc_all(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(k, t) for k, (_, t) in R.doc_rows(conn.raw, with_items=True).items()])


@stmt("SELECT key FROM doc")
def _doc_keys(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(k,) for k in R.doc_rows(conn.raw, with_items=True)])


@stmt("SELECT 1 FROM doc WHERE key='nodes'")
def _nodes_blob(conn: Any, p: Sequence[Any]) -> Result:
    row = R.section_row(conn.raw, "nodes")
    return Result([(1,)] if row is not None and row[1] == "n" else [])


@stmt("SELECT 1 FROM doc WHERE key='events'")
def _events_blob(conn: Any, p: Sequence[Any]) -> Result:
    row = R.section_row(conn.raw, "events")
    return Result([(1,)] if row is not None and row[1] == "n" else [])


def _blobs(conn: Any, keys: Sequence[str]) -> list[str]:
    """Of ``keys``, the sections held whole as one value (a doc row), in ``keys`` order."""
    out = []
    for k in keys:
        row = R.section_row(conn.raw, k)
        if row is not None and row[1] == "n":
            out.append(k)
    return out


# the bounded window readers' guards (piece A6): "is a section still held as a blob?" They
# used to be declined (answered yes), so the readers loaded the whole org instead: 0.9-1.5 s
# per window on the live org's copy, against 5-165 ms. Now they answer from the org's
# sections, and the readers' own statements are served below ("bounded window readers")
@stmt("SELECT key FROM doc WHERE key IN ('documents','events','nodes') LIMIT 1")
def _document_blobs(conn: Any, p: Sequence[Any]) -> Result:
    got = _blobs(conn, ("documents", "events", "nodes"))
    return Result([(got[0],)] if got else [])


@stmt("SELECT 1 FROM doc WHERE key IN ('events','notice_log') LIMIT 1")
def _history_blobs(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(1,)] if _blobs(conn, ("events", "notice_log")) else [])


@stmt("SELECT 1 FROM doc WHERE key IN ('mail_log','user_mail_log') LIMIT 1")
def _mail_blobs(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(1,)] if _blobs(conn, ("mail_log", "user_mail_log")) else [])


@stmt("UPDATE doc SET val=? WHERE key=? AND val=?")
def _doc_cas(conn: Any, p: Sequence[Any]) -> Result:
    text, key, expected = p
    c = conn.raw
    names = _names(conn)
    with conn.atomic(write=True):
        R.fence(c, key, creating=False)
        got = R.doc_get(c, key, names=names, lock=True)
        if got is None or not R.same(got[1], expected):
            return _w(0)
        R.doc_put(c, conn.tx, key, text, names)
        return _w(1)


@stmt("INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO NOTHING")
def _doc_insert_absent(conn: Any, p: Sequence[Any]) -> Result:
    key, text = p
    c = conn.raw
    names = _names(conn)
    with conn.atomic(write=True):
        kind, sect, rest = R.kind_of(key)
        if kind == "owner":
            aid = names.id(rest, mint=True)
            n = c.execute("INSERT INTO orgtree.org_section_owners (section, agent_id, ord, state) "
                          "SELECT %s, %s, coalesce(max(ord), -1) + 1, 'l' "
                          "FROM orgtree.org_section_owners WHERE section = %s "
                          "ON CONFLICT (section, agent_id) DO NOTHING", (sect, aid, sect)).rowcount
            if not n:
                return _w(0)
        else:
            # the absent decision and the insert are one step (review f21): a second writer
            # of this key (another such insert, or an upsert) waits at the key's fence for
            # the first's transaction, then sees its row, as the legacy statement waited on
            # the uncommitted row
            R.fence(c, key, creating=True)
            if R.doc_get(c, key, names=names, lock=True) is not None:
                return _w(0)
        R.doc_put(c, conn.tx, key, text, names)
        return _w(1)


@stmt("INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val")
def _doc_upsert(conn: Any, p: Sequence[Any]) -> Result:
    key, text = p
    with conn.atomic(write=True):
        # the same fence as the insert above (review f21): an upsert of a key another
        # transaction is inserting or upserting waits for it, then replaces its value whole,
        # as the legacy upsert waited on the row and then updated it
        R.fence(conn.raw, key, creating=True)
        R.doc_put(conn.raw, conn.tx, key, text, _names(conn))
        return _w(1)


@stmt("DELETE FROM doc WHERE key=? AND val=?")
def _doc_cas_delete(conn: Any, p: Sequence[Any]) -> Result:
    key, expected = p
    names = _names(conn)
    with conn.atomic(write=True):
        R.fence(conn.raw, key, creating=False)
        got = R.doc_get(conn.raw, key, names=names, lock=True)
        if got is None or not R.same(got[1], expected):
            return _w(0)
        return _w(R.doc_delete(conn.raw, key, names))


@stmt("DELETE FROM doc WHERE key=?")
def _doc_delete(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic(write=True):
        R.fence(conn.raw, p[0], creating=False)
        return _w(R.doc_delete(conn.raw, p[0], _names(conn)))


# ----------------------------------------------------------------- nodes

@stmt("SELECT id, val, xmin::text FROM nodes WHERE id = ANY(?)")
def _nodes_any_x(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result(R.nodes(conn.raw, list(p[0])))


@stmt("SELECT id, val, xmin::text FROM nodes ORDER BY ord")
def _nodes_all_x(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result(R.nodes(conn.raw))


@stmt("SELECT id, val FROM nodes ORDER BY ord")
def _nodes_all(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(n, t) for n, t, _ in R.nodes(conn.raw)])


@stmt("SELECT id, val FROM nodes WHERE id = ANY(?)")
def _nodes_any(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(n, t) for n, t, _ in R.nodes(conn.raw, list(p[0]))])


@stmt("SELECT val FROM nodes WHERE id=?")
def _node_val(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(t,) for _, t, _ in R.nodes(conn.raw, [p[0]])])


@stmt("SELECT 1 FROM nodes WHERE id=?")
def _node_exists(conn: Any, p: Sequence[Any]) -> Result:
    hit = conn.raw.execute("SELECT EXISTS (SELECT 1 FROM orgtree.agents WHERE name = %s "
                           "AND NOT tombstone)", (p[0],)).fetchone()[0]
    return Result([(1,)] if hit else [])


@stmt("SELECT 1 FROM nodes LIMIT 1")
def _nodes_any_row(conn: Any, p: Sequence[Any]) -> Result:
    hit = conn.raw.execute("SELECT EXISTS (SELECT 1 FROM orgtree.agents WHERE NOT tombstone)"
                           ).fetchone()[0]
    return Result([(1,)] if hit else [])


@stmt("SELECT id FROM nodes", "SELECT id FROM nodes ORDER BY ord")
def _node_ids(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(n,) for n in R.node_ids(conn.raw)])


@stmt("SELECT COALESCE(MAX(ord), -1) FROM nodes")
def _nodes_max_ord(conn: Any, p: Sequence[Any]) -> Result:
    return Result(conn.raw.execute("SELECT coalesce(max(ord), -1) FROM orgtree.agents "
                                   "WHERE NOT tombstone").fetchall())


@stmt("UPDATE nodes SET val=? WHERE id=?")
def _node_update(conn: Any, p: Sequence[Any]) -> Result:
    text, name = p
    with conn.atomic(write=True):
        if not R.nodes(conn.raw, [name], lock=True):
            return _w(0)
        R.node_put(conn.raw, name, json.loads(text), _names(conn))
        return _w(1)


@stmt("UPDATE nodes SET val=? WHERE id=? AND val=?")
def _node_cas(conn: Any, p: Sequence[Any]) -> Result:
    text, name, expected = p
    with conn.atomic(write=True):
        got = R.nodes(conn.raw, [name], lock=True)
        if not got or not R.same(got[0][1], expected):
            return _w(0)
        R.node_put(conn.raw, name, json.loads(text), _names(conn))
        return _w(1)


@stmt("UPDATE nodes AS n SET val = u.val FROM unnest(?::text[], ?::text[], ?::text[]) "
      "AS u(id, val, old) WHERE n.id = u.id AND n.val = u.old RETURNING n.id")
def _nodes_cas_batch(conn: Any, p: Sequence[Any]) -> Result:
    ids, vals, olds = p
    done = []
    with conn.atomic(write=True):
        names = _names(conn)
        current = {n: t for n, t, _ in R.nodes(conn.raw, list(ids), lock=True)}
        for name, text, old in zip(ids, vals, olds):
            if name in current and R.same(current[name], old):
                R.node_put(conn.raw, name, json.loads(text), names)
                done.append((name,))
    return Result(done, len(done), write=True)


@stmt("INSERT INTO nodes(id, ord, val) VALUES(?,?,?)")
def _node_insert(conn: Any, p: Sequence[Any]) -> Result:
    name, _ord, text = p
    with conn.atomic(write=True):
        names = _names(conn)
        # the name's lock comes BEFORE the absent check (review f21): a second inserter waits
        # for the first's transaction, then finds its node and is refused as the legacy
        # primary key refused it; an insert never takes node_put's existing-node branch
        names.lock(name)
        if R.nodes(conn.raw, [name]):
            err = sqlite3.IntegrityError(
                f'postgres 23505: duplicate key value violates unique constraint "nodes_pkey" '
                f'(node {name!r})')
            setattr(err, "sqlstate", "23505")
            raise err
        R.node_put(conn.raw, name, json.loads(text), names)
        return _w(1)


@stmt("DELETE FROM nodes WHERE id=?")
def _node_delete(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic(write=True):
        return _w(R.node_delete(conn.raw, p[0]))


@stmt("DELETE FROM nodes WHERE id=? AND val=?")
def _node_cas_delete(conn: Any, p: Sequence[Any]) -> Result:
    name, expected = p
    with conn.atomic(write=True):
        got = R.nodes(conn.raw, [name], lock=True)
        if not got or not R.same(got[0][1], expected):
            return _w(0)
        return _w(R.node_delete(conn.raw, name))


@stmt("DELETE FROM nodes")
def _nodes_delete_all(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic(write=True):
        return _w(sum(R.node_delete(conn.raw, n) for n in R.node_ids(conn.raw)))


# --------------------------------------------------- node projections (no row decode)

_STATE_LIVE = "(a.state = 'live' OR a.state IS NULL)"


@stmt("SELECT id FROM nodes WHERE strpos(val, ?) > 0 AND jsonb_typeof((val::jsonb)->'frozen') "
      "IS NOT NULL AND jsonb_typeof((val::jsonb)->'frozen') <> 'null' AND "
      "coalesce((val::jsonb)->>'state', 'live') = 'live' ORDER BY ord")
def _frozen_live(conn: Any, p: Sequence[Any]) -> Result:
    # a superset, as the caller requires: is_frozen is bool(frozen), and the caller keeps
    # only a truthy freeze of a live node
    return Result(conn.raw.execute(
        f"SELECT a.name FROM orgtree.agents a WHERE NOT a.tombstone AND a.is_frozen "
        f"AND {_STATE_LIVE} ORDER BY a.ord, a.id").fetchall())


@stmt("SELECT id FROM nodes WHERE id IN (SELECT id FROM node_index WHERE meta->>'state' = 'live') "
      "ORDER BY ord")
def _live_ids(conn: Any, p: Sequence[Any]) -> Result:
    return Result(conn.raw.execute(
        f"SELECT a.name FROM orgtree.agents a WHERE NOT a.tombstone AND {_STATE_LIVE} "
        "ORDER BY a.ord, a.id").fetchall())


@stmt("SELECT id FROM nodes WHERE id IN (SELECT id FROM node_index WHERE meta->>'parent' = ANY(?)) "
      "ORDER BY ord")
def _children(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(n,) for n in R.children_ids(conn.raw, list(p[0]))])


@stmt("SELECT id FROM nodes WHERE id IN (SELECT id FROM node_index WHERE meta->>'parent' = ANY(?) "
      "AND meta->>'state' <> 'archived') ORDER BY ord")
def _live_children(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(n,) for n in R.children_ids(conn.raw, list(p[0]), live_only=True)])


@stmt("SELECT id FROM nodes WHERE strpos(val, ?) > 0 AND jsonb_typeof((val::jsonb)->?) IS NOT NULL "
      "AND jsonb_typeof((val::jsonb)->?) <> 'null' ORDER BY ord")
def _ids_with(conn: Any, p: Sequence[Any]) -> Result:
    where = R.node_key_present_sql(p[1])
    return Result(conn.raw.execute(
        f"SELECT a.name FROM orgtree.agents a WHERE NOT a.tombstone AND ({where}) "
        "ORDER BY a.ord, a.id").fetchall())


@stmt("SELECT DISTINCT (val::jsonb)->>? FROM nodes WHERE strpos(val, ?) > 0 AND "
      "jsonb_typeof((val::jsonb)->?) = 'string'")
def _field_values(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(v,) for v in sorted(R.node_string_values(conn.raw, p[0]))])


@stmt("SELECT id, ((val::json)->'cost_usd')::text FROM nodes ORDER BY ord")
def _node_costs(conn: Any, p: Sequence[Any]) -> Result:
    return Result(R.node_field_texts(conn.raw, "cost_usd"))


@stmt("SELECT count(*), count(*) FILTER (WHERE meta->>'state' = 'live') FROM node_index")
def _node_counts(conn: Any, p: Sequence[Any]) -> Result:
    return Result(conn.raw.execute(
        f"SELECT count(*), count(*) FILTER (WHERE {_STATE_LIVE}) FROM orgtree.agents a "
        "WHERE NOT a.tombstone").fetchall())


@stmt("SELECT id,json_extract(val,'$.state') FROM nodes WHERE id>? ORDER BY id LIMIT ?")
def _transcript_page(conn: Any, p: Sequence[Any]) -> Result:
    rows = conn.raw.execute(
        "SELECT a.name, a.state, a.extra FROM orgtree.agents a WHERE NOT a.tombstone "
        "AND a.name > %s ORDER BY a.name LIMIT %s", (p[0], p[1])).fetchall()
    return Result([(n, R.json_extract_text(R.scalar_field(st, ex, "state"))) for n, st, ex in rows])


@stmt("SELECT id,ord FROM node_index WHERE meta->>'state'<>'archived' ORDER BY ord,id LIMIT ?")
def _active_page(conn: Any, p: Sequence[Any]) -> Result:
    return Result(conn.raw.execute(
        "SELECT a.name, a.ord FROM orgtree.agents a WHERE NOT a.tombstone "
        "AND a.state IS DISTINCT FROM 'archived' ORDER BY a.ord, a.name LIMIT %s", (p[0],)).fetchall())


@stmt("SELECT id,ord FROM node_index WHERE meta->>'state'<>'archived' AND (ord,id)>(?,?) "
      "ORDER BY ord,id LIMIT ?")
def _active_page_after(conn: Any, p: Sequence[Any]) -> Result:
    return Result(conn.raw.execute(
        "SELECT a.name, a.ord FROM orgtree.agents a WHERE NOT a.tombstone "
        "AND a.state IS DISTINCT FROM 'archived' AND (a.ord, a.name) > (%s, %s) "
        "ORDER BY a.ord, a.name LIMIT %s", (p[0], p[1], p[2])).fetchall())


@stmt("SELECT json_extract(val,'$.state','$.generation','$.seat_id') FROM nodes WHERE id=?")
def _node_credential(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        got = R.nodes(conn.raw, [p[0]])
        if not got:
            return Result([])
        node = json.loads(got[0][1])
        return Result([(json.dumps([node.get(k) for k in ("state", "generation", "seat_id")]),)])


@stmt("SELECT (SELECT val FROM doc WHERE key='reply_incarnation'), json_extract(val,"
      "'$.reply_incarnation','$.generation','$.transcript_incarnation','$.session_id'), "
      "EXISTS(SELECT 1 FROM doc WHERE key='nodes') FROM nodes WHERE id=?")
def _stream_identity(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        got = R.nodes(conn.raw, [p[0]])
        if not got:
            return Result([])
        node = json.loads(got[0][1])
        reply = R.doc_get(conn.raw, "reply_incarnation")
        blob = R.section_row(conn.raw, "nodes")
        fields = [node.get(k) for k in ("reply_incarnation", "generation",
                                        "transcript_incarnation", "session_id")]
        return Result([(None if reply is None else reply[1], json.dumps(fields),
                        blob is not None and blob[1] == "n")])


@stmt("SELECT '__runtime_node', val FROM nodes WHERE id=? UNION ALL SELECT key, val FROM doc "
      "WHERE key IN (?*)")
def _runtime_node(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        out = [("__runtime_node", t) for _, t, _ in R.nodes(conn.raw, [p[0]])]
        return Result(out + _doc_in(conn, list(p[1:])))


def _transcript_source(conn: Any, p: Sequence[Any], with_revision: bool) -> Result:
    from ... import store   # noqa: PLC0415
    with conn.atomic():
        out: list[tuple[Any, ...]] = []
        got = R.nodes(conn.raw, [p[0]])
        if got:
            node = json.loads(got[0][1])
            out.append(("__source_node",
                        json.dumps([node.get(k) for k in store._TRANSCRIPT_NODE_FIELDS])))
            out.append(("__desktop_present", "1" if "desktop_import" in node else "0"))
        out += _doc_in(conn, ("nodes", "reply_incarnation"))
        if with_revision:
            out.append(("__source_revision", str(conn.revision())))
        return Result(out)


def _transcript_source_sqls() -> tuple[str, str]:
    from ... import store   # noqa: PLC0415
    paths = ",".join("'$." + field + "'" for field in store._TRANSCRIPT_NODE_FIELDS)
    base = ("SELECT '__source_node', json_extract(val," + paths + ") "
            "FROM nodes WHERE id=? UNION ALL SELECT '__desktop_present', "
            "CASE WHEN jsonb_exists(val::jsonb, 'desktop_import') THEN '1' ELSE '0' END "
            "FROM nodes WHERE id=? UNION ALL SELECT key,val FROM doc "
            "WHERE key IN ('nodes','reply_incarnation')")
    return base, base + " UNION ALL SELECT '__source_revision',revision::text FROM public.orgs WHERE org_id=?"


# ----------------------------------------------------------------- logs

@stmt("SELECT seq, val FROM log_d WHERE sect=? AND owner=? ORDER BY seq")
def _dlog_owner(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_d", p[0])
    if ls is None:
        return Result([])
    with conn.atomic():
        names = _names(conn)
        aid = names.id(p[1], mint=False)
        if aid is None:
            return Result([])
        return Result([(s, t) for s, _, _, t in R.log_rows(conn.raw, ls, owner_id=aid, names=names)])


@stmt("SELECT owner, seq, val FROM log_d WHERE sect BETWEEN ? AND ? ORDER BY seq")
def _dlog_section(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_d", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    with conn.atomic():
        return Result([(o, s, t) for s, o, _, t in R.log_rows(conn.raw, ls)])


@stmt("SELECT seq, val FROM log_l WHERE sect BETWEEN ? AND ? ORDER BY seq")
def _llog_section(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_l", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    with conn.atomic():
        return Result([(s, t) for s, _, _, t in R.log_rows(conn.raw, ls)])


@stmt("SELECT owner FROM log_d WHERE sect BETWEEN ? AND ? GROUP BY owner ORDER BY MIN(seq)")
def _dlog_owners(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_d", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    return Result([(o,) for o in R.log_owners_by_first(conn.raw, ls)])


@stmt("SELECT sect FROM log_d WHERE sect>=? ORDER BY sect LIMIT 1")
def _dlog_has(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_d", p[0])
    return Result([(p[0],)] if ls is not None and R.log_has(conn.raw, ls) else [])


@stmt("SELECT sect FROM log_l WHERE sect>=? ORDER BY sect LIMIT 1")
def _llog_has(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_l", p[0])
    return Result([(p[0],)] if ls is not None and R.log_has(conn.raw, ls) else [])


def _insert(conn: Any, table: str, sect: str, owner: str | None, text: str) -> Result:
    ls = _need_log(table, sect)
    with conn.atomic(write=True):
        seq = R.log_insert(conn.raw, ls, owner, text, _names(conn))
    return _w(1, seq)


@stmt("INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)",
      "INSERT INTO log_d(sect,owner,at,val) VALUES(?,?,?,?)")
def _dlog_insert(conn: Any, p: Sequence[Any]) -> Result:
    return _insert(conn, "log_d", p[0], p[1], p[3])


@stmt("INSERT INTO log_l(sect, at, val) VALUES(?,?,?)")
def _llog_insert(conn: Any, p: Sequence[Any]) -> Result:
    return _insert(conn, "log_l", p[0], None, p[2])


def _replace(conn: Any, table: str, p: Sequence[Any], *, cas: bool) -> Result:
    _at, text, seq = p[0], p[1], p[2]
    ls, rid = R.by_seq(table, seq)
    with conn.atomic(write=True):
        return _w(R.log_replace(conn.raw, ls, rid, text, expected=p[3] if cas else None))


for _table in ("log_d", "log_l"):
    stmt(f"UPDATE {_table} SET at=?, val=? WHERE seq=?")(
        lambda conn, p, _t=_table: _replace(conn, _t, p, cas=False))
    stmt(f"UPDATE {_table} SET at=?, val=? WHERE seq=? AND val=?")(
        lambda conn, p, _t=_table: _replace(conn, _t, p, cas=True))


def _delete_seq(conn: Any, table: str, p: Sequence[Any], *, cas: bool) -> Result:
    if cas:
        ls, rid = R.by_seq(table, p[0])
        with conn.atomic(write=True):
            return _w(R.log_delete(conn.raw, ls, [rid], expected=p[1]))
    groups: dict[str, tuple[R.LogSect, list[int]]] = {}
    for seq in p:
        ls, rid = R.by_seq(table, seq)
        groups.setdefault(ls.name, (ls, []))[1].append(rid)
    with conn.atomic(write=True):
        return _w(sum(R.log_delete(conn.raw, ls, rids) for ls, rids in groups.values()))


for _table in ("log_d", "log_l"):
    stmt(f"DELETE FROM {_table} WHERE seq=? AND val=?")(
        lambda conn, p, _t=_table: _delete_seq(conn, _t, p, cas=True))
    stmt(f"DELETE FROM {_table} WHERE seq IN (?*)")(
        lambda conn, p, _t=_table: _delete_seq(conn, _t, p, cas=False))


@stmt("SELECT COUNT(*) FROM log_d WHERE sect=? AND owner=?")
def _dlog_count_owner(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_d", p[0])
    aid = _names(conn).id(p[1], mint=False)
    return Result([(0 if aid is None else R.log_count(conn.raw, ls, aid),)])


@stmt("SELECT COUNT(*) FROM log_l WHERE sect BETWEEN ? AND ?")
def _llog_count_range(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_l", p[0])
    return Result([(R.log_count(conn.raw, ls),)])


@stmt("SELECT COUNT(*) FROM log_l WHERE sect='events'")
def _events_count(conn: Any, p: Sequence[Any]) -> Result:
    return Result([(R.log_count(conn.raw, _need_log("log_l", "events")),)])


@stmt("DELETE FROM log_d WHERE sect=? AND owner=?")
def _dlog_delete_owner(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_d", p[0])
    with conn.atomic(write=True):
        aid = _names(conn).id(p[1], mint=False)
        return _w(0 if aid is None else R.log_scope_delete(conn.raw, ls, aid))


@stmt("DELETE FROM log_d WHERE sect BETWEEN ? AND ?")
def _dlog_delete_section(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_d", p[0])
    with conn.atomic(write=True):
        return _w(R.log_scope_delete(conn.raw, ls))


@stmt("DELETE FROM log_l WHERE sect BETWEEN ? AND ?")
def _llog_delete_section(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_l", p[0])
    with conn.atomic(write=True):
        return _w(R.log_scope_delete(conn.raw, ls))


@stmt("SELECT val FROM log_l WHERE sect='events' ORDER BY seq DESC LIMIT ?")
def _events_newest(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        rows = R.log_rows_page(conn.raw, _need_log("log_l", "events"), newest=int(p[0]))
        return Result([(t,) for _, _, _, t in reversed(rows)])


@stmt("SELECT val FROM log_l WHERE sect='events' ORDER BY seq LIMIT -1 OFFSET ?")
def _events_from(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        rows = R.log_rows_page(conn.raw, _need_log("log_l", "events"), offset=int(p[0]))
        return Result([(t,) for _, _, _, t in rows])


@stmt("SELECT val FROM log_l WHERE sect BETWEEN ? AND ? ORDER BY sect DESC, seq DESC LIMIT 50")
def _llog_newest50(conn: Any, p: Sequence[Any]) -> Result:
    ls = _log("log_l", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    with conn.atomic():
        rows = R.log_rows_page(conn.raw, ls, newest=50)
        return Result([(t,) for _, _, _, t in reversed(rows)])


def _owner_tail(conn: Any, p: Sequence[Any], sect: str) -> Result:
    ls = _need_log("log_d", sect)
    with conn.atomic():
        names = _names(conn)
        aid = names.id(p[0], mint=False)
        if aid is None:
            return Result([])
        rows = R.log_owner_tail(conn.raw, ls, aid, int(p[1]), names)
        return Result([(s, t) for s, _, _, t in rows])


@stmt("SELECT version,nrows,assigned_max FROM mail_archive_bounds WHERE owner=? AND format=1 "
      "AND unknown_rows=0 AND nrows>=0 AND assigned_max>=0")
def _mail_bounds(conn: Any, p: Sequence[Any]) -> Result:
    # no bound: mail_archive_max answers None and its caller takes the ordinary path
    return Result([])


UNREACHABLE[normalize(
    "SELECT version,nrows,assigned_max FROM mail_archive_bounds WHERE owner=? AND format=1 "
    "AND unknown_rows=0 FOR UPDATE")] = "the mail append door: no bound is ever handed out here"


def _project(conn: Any, p: Sequence[Any], m: re.Match[str]) -> Result:
    fields = re.findall(r"'\$\.([A-Za-z0-9_]+)'", m.group(1))
    ls = _log("log_l", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    with conn.atomic():
        out = []
        for _, _, _, text in R.log_rows(conn.raw, ls):
            v = json.loads(text)
            out.append((json.dumps([v.get(f) if isinstance(v, dict) else None for f in fields]),))
        return Result(out)


PATTERNS.append((re.compile(r"^SELECT json_extract\(val,((?:'\$\.[A-Za-z0-9_]+',?)+)\) FROM log_l "
                            r"WHERE sect BETWEEN \? AND \? ORDER BY seq$"), _project))


# ----------------------------------------------------------------- bounded window readers
# (piece A6.) A node's inbox window (store._mail_tails), its history (_pg_node_history_rows),
# the presentations gallery (_pg_document_gallery) and one presentation (read_document): each
# reads a few rows out of a large log. They are answered from the typed columns that select and
# order them; only the rows returned are decoded. A record whose selecting or ordering field is
# not in its typed column (a value of another shape, kept in ``extra``) is decided from that
# value with the legacy text rule, so no record is missed or misplaced.

def _extra_text(key_sql: str) -> str:
    """SQL for the legacy json_extract / ``->>`` text of a field kept in ``extra`` (a value of
    another shape than its column's), computed by PostgreSQL exactly as the legacy store did
    (pg_migrations/0001's json_extract over jsonb): a string as itself, JSON null as NULL,
    anything else as its jsonb text (key order, number form and unescaped characters
    included, which a Python rendering would not reproduce)."""
    v = f"(extra->{key_sql})::jsonb"
    return (f"CASE jsonb_typeof({v}) WHEN 'string' THEN {v} #>> '{{}}' WHEN 'null' THEN NULL "
            f"ELSE {v}::text END")


def _at_text(at: Any, at_text: Any, extra_at: str | None) -> str:
    """COALESCE(json_extract(val,'$.at'),'') from a record's columns: the typed timestamp's
    stored text, else the legacy text of a value of another shape kept in extra, else ''."""
    if at is not None:
        return str(at_text) if at_text is not None else codec.canonical_ts(at)
    return "" if extra_at is None else str(extra_at)


def _matching(c: Any, ls: R.LogSect, col: str, value: str, test: str = "",
              test_params: Sequence[Any] = ()) -> list[tuple[int, int | None, str]]:
    """(id, agent_id or None, at text) of ``ls``'s records whose text field ``col`` is
    ``value`` (in its typed column, or as the text of a value of another shape kept in
    extra), or that ``test`` matches (more ``OR`` conditions on the record's columns)."""
    t = ls.table.spec.table
    agent = "agent_id" if ls.kind in ("agent", "agent_map") else "NULL::bigint"
    qc = codec.quote(col)
    hit = f"({qc} = %s{test})"
    at_other, col_other = _extra_text("'at'"), _extra_text("%s")
    q = (f"SELECT id, {agent}, at, at_text, {at_other}, coalesce({hit}, false), {col_other} "
         f"FROM orgtree.{t} WHERE {R._scope(ls)} AND ({hit} OR ({qc} IS NULL AND extra->%s IS NOT NULL))")
    params = (value, *test_params, col, col, col, value, *test_params, col)
    out = []
    for rid, aid, at, att, ate, is_hit, other in c.execute(q, params).fetchall():
        if is_hit or other == value:
            out.append((int(rid), None if aid is None else int(aid), _at_text(at, att, ate)))
    return out


def _decoded(c: Any, ls: R.LogSect, ids: Sequence[int], names: Names | None = None
             ) -> dict[int, tuple[str | None, str]]:
    """{id: (owner, text)} of those records of ``ls``."""
    if not ids:
        return {}
    return {seq // R.SLOTS: (owner, text)
            for seq, owner, _, text in R.log_rows(c, ls, ids=ids, names=names)}


def _newest(rows: list[tuple[Any, ...]], cap: int) -> list[tuple[Any, ...]]:
    """The first ``cap`` of ``rows`` by their keys descending (Python's string order, which is
    the legacy ``COLLATE "C"`` order)."""
    return sorted(rows, reverse=True)[:max(0, cap)]


@stmt("SELECT val FROM log_d WHERE sect='mail_log' AND owner=? ORDER BY seq DESC LIMIT ?")
def _mail_owner_newest(conn: Any, p: Sequence[Any]) -> Result:
    ls = _need_log("log_d", "mail_log")
    with conn.atomic():
        aid = _names(conn).id(p[0], mint=False)
        if aid is None:
            return Result([])
        rows, ch = R.fetch(conn.raw, ls.table, "agent_id = %s", (aid,), order="id DESC",
                           limit=max(0, int(p[1])))
        return Result([(R.dumps(R.entry_of(ls, r, ch)),) for r in rows])


@stmt("WITH tail AS MATERIALIZED (SELECT seq,sent_at,owner_pos FROM mail_sent "
      "WHERE sender=? ORDER BY sent_at DESC,owner_pos DESC,seq DESC LIMIT ?) "
      "SELECT l.owner,l.val FROM tail CROSS JOIN LATERAL "
      "(SELECT owner,val FROM log_d WHERE seq=tail.seq LIMIT 1) l "
      "ORDER BY tail.sent_at DESC,tail.owner_pos DESC,tail.seq DESC")
def _mail_sent_tail(conn: Any, p: Sequence[Any]) -> Result:
    """A sender's newest mail in every recipient's archive, in the legacy index's order: the
    entry's ``at`` text, then its recipient's first archive row (the dict order owners load
    in), then the row, all descending."""
    ls = _need_log("log_d", "mail_log")
    sender, cap = str(p[0]), int(p[1])
    with conn.atomic():
        c = conn.raw
        found = _matching(c, ls, "from", sender)
        if not found or cap <= 0:
            return Result([])
        owners = sorted({aid for _, aid, _ in found if aid is not None})
        first = {int(a): int(m) for a, m in c.execute(
            f"SELECT agent_id, min(id) FROM orgtree.{ls.table.spec.table} "
            "WHERE agent_id = ANY(%s) GROUP BY agent_id", (owners,)).fetchall()}
        pick = _newest([(at, first[aid], rid) for rid, aid, at in found], cap)
        names = _names(conn)
        got = _decoded(c, ls, [rid for _, _, rid in pick], names)
        return Result([got[rid] for _, _, rid in pick])


def _list_tail(conn: Any, sect: str, col: str, value: str, cap: int, test: str = "",
               test_params: Sequence[Any] = ()) -> Result:
    """A list log's newest ``cap`` records matching (by ``at`` text, then position),
    newest first, as (text,) rows."""
    ls = _need_log("log_l", sect)
    with conn.atomic():
        c = conn.raw
        found = _matching(c, ls, col, value, test, test_params)
        pick = _newest([(at, rid) for rid, _, at in found], cap)
        got = _decoded(c, ls, [rid for _, rid in pick])
        return Result([(got[rid][1],) for _, rid in pick])


@stmt("SELECT val FROM log_l WHERE sect='user_mail_log' AND json_extract(val,'$.from')=? "
      "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC LIMIT ?")
def _user_mail_from(conn: Any, p: Sequence[Any]) -> Result:
    return _list_tail(conn, "user_mail_log", "from", str(p[0]), int(p[1]))


@stmt("SELECT val FROM (SELECT val, seq, val::jsonb AS j FROM log_l WHERE sect='notice_log' "
      "OFFSET 0) r WHERE j->>'node'=? ORDER BY COALESCE(j->>'at','') COLLATE \"C\" DESC, seq DESC "
      "LIMIT ?")
def _notices_of(conn: Any, p: Sequence[Any]) -> Result:
    return _list_tail(conn, "notice_log", "node", str(p[0]), int(p[1]))


@stmt("SELECT val FROM (SELECT val, seq, val::jsonb AS j FROM log_l WHERE sect='events' "
      "OFFSET 0) r WHERE j#>>'{detail,node}'=? OR j#>>'{detail,to}'=? OR j->>'actor'=? OR "
      "j#>>'{detail,grantee}'=? OR j#>>'{detail,from}'=? "
      "ORDER BY COALESCE(j->>'at','') COLLATE \"C\" DESC, seq DESC LIMIT ?")
def _events_touching(conn: Any, p: Sequence[Any]) -> Result:
    """The node's newest events: its actor, or the node, recipient, grantee or sender in the
    event's detail (``detail`` is a JSON column, read with the same ``->>`` text rule)."""
    nid = str(p[0])
    test = (" OR detail->>'node' = %s OR detail->>'to' = %s OR detail->>'grantee' = %s "
            "OR detail->>'from' = %s")
    return _list_tail(conn, "events", "actor", nid, int(p[5]), test, (nid, nid, nid, nid))


@stmt("SELECT (val::jsonb - 'body')::text FROM log_l WHERE sect BETWEEN ? AND ? ORDER BY seq")
def _list_without_body(conn: Any, p: Sequence[Any]) -> Result:
    """Every record of a list log without its ``body``: the body column is never read (review
    A6 f1), and a body of another shape kept in extra is dropped after decoding, as
    ``val::jsonb - 'body'`` drops either."""
    ls = _log("log_l", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    with conn.atomic():
        rows, ch = R.fetch(conn.raw, ls.table, R._scope(ls), order="id", exclude=("body",))
        out = []
        for r in rows:
            v = R.entry_of(ls, r, ch)
            if isinstance(v, dict):
                v.pop("body", None)
            out.append((json.dumps(v),))
        return Result(out)


@stmt("SELECT seq, val FROM log_l WHERE sect='events' AND strpos(val, 'present_evicted') > 0 "
      "ORDER BY seq")
def _evictions(conn: Any, p: Sequence[Any]) -> Result:
    """The events whose op is present_evicted (the caller keeps exactly those of the text
    prefilter's rows), with their legacy seq."""
    ls = _need_log("log_l", "events")
    with conn.atomic():
        ids = [int(r[0]) for r in conn.raw.execute(
            f"SELECT id FROM orgtree.{ls.table.spec.table} WHERE op = 'present_evicted' "
            "ORDER BY id").fetchall()]
        return Result([(seq, text) for seq, _, _, text in R.log_rows(conn.raw, ls, ids=ids)]
                      if ids else [])


@stmt("SELECT seq, n FROM (SELECT seq, row_number() OVER (ORDER BY seq) - 1 AS n FROM log_l "
      "WHERE sect BETWEEN ? AND ? AND seq <= ?) q WHERE seq = ANY(?)")
def _list_positions(conn: Any, p: Sequence[Any]) -> Result:
    """Each given row's index in its list log (rows up to ``seq <= ?``)."""
    ls = _log("log_l", p[0]) if p[0] == p[1] else None
    if ls is None:
        return Result([])
    want: dict[int, int] = {}
    for s in p[3]:
        at, rid = R.by_seq("log_l", int(s))
        if at is ls:
            want[rid] = int(s)
    top_ls, top = R.by_seq("log_l", int(p[2]))
    if not want or top_ls is not ls:
        return Result([])
    with conn.atomic():
        rows = conn.raw.execute(
            f"SELECT id, n FROM (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n "
            f"FROM orgtree.{ls.table.spec.table} WHERE {R._scope(ls)} AND id <= %s) q "
            "WHERE id = ANY(%s)", (top, list(want))).fetchall()
        return Result([(want[int(rid)], int(n)) for rid, n in rows])


@stmt("SELECT id, jsonb_build_object('state', v->'state', 'model', v->'model')::text "
      "FROM (SELECT id, val::jsonb AS v FROM nodes WHERE id = ANY(?)) q")
def _node_state_model(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        out = []
        for nid, text, _ in R.nodes(conn.raw, list(p[0])):
            v = json.loads(text)
            v = v if isinstance(v, dict) else {}
            # jsonb_build_object's text: keys in jsonb order (model before state), nulls kept
            out.append((nid, json.dumps({"model": v.get("model"), "state": v.get("state")})))
        return Result(out)


@stmt("SELECT val FROM log_l WHERE sect BETWEEN ? AND ? AND strpos(val, ?) > 0 ORDER BY seq")
def _document_by_id(conn: Any, p: Sequence[Any]) -> Result:
    """read_document's prefilter: the documents whose id is the one asked for (the caller
    keeps the first whose id equals it; a text match elsewhere in a row never would be)."""
    if not (p[0] == p[1] == "documents"):
        raise CompatError("this text search is served for read_document's documents only")
    ls = _need_log("log_l", "documents")
    with conn.atomic():
        ids = [int(r[0]) for r in conn.raw.execute(
            f"SELECT id FROM orgtree.{ls.table.spec.table} WHERE public_id = %s ORDER BY id",
            (str(p[2]),)).fetchall()]
        return Result([(text,) for _, _, _, text in R.log_rows(conn.raw, ls, ids=ids)]
                      if ids else [])


for _t in ("SELECT l.owner, l.val FROM log_d l JOIN (SELECT owner, MIN(seq) AS pos FROM log_d "
           "WHERE sect='mail_log' GROUP BY owner) o ON o.owner=l.owner WHERE l.sect='mail_log' "
           "AND json_extract(l.val,'$.from')=? ORDER BY COALESCE(json_extract(l.val,'$.at'),'') "
           "DESC, o.pos DESC, l.seq DESC LIMIT ?",
           "SELECT val FROM log_l WHERE sect='events' AND (json_extract(val,'$.detail.node')=? OR "
           "json_extract(val,'$.detail.to')=? OR json_extract(val,'$.actor')=? OR "
           "json_extract(val,'$.detail.grantee')=? OR json_extract(val,'$.detail.from')=?) "
           "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC LIMIT ?",
           "SELECT val FROM log_l WHERE sect='notice_log' AND json_extract(val,'$.node')=? "
           "ORDER BY COALESCE(json_extract(val,'$.at'),'') DESC, seq DESC LIMIT ?"):
    UNREACHABLE[normalize(_t)] = "the SQLite branch of a bounded window reader"


# ----------------------------------------------------------------- meta

@stmt("SELECT val FROM meta WHERE key=?")
def _meta_val(conn: Any, p: Sequence[Any]) -> Result:
    got = R.meta_get(conn.raw, p[0])
    return Result([] if got is None else [(got[1],)])


@stmt("SELECT 1 FROM meta WHERE key=?")
def _meta_exists(conn: Any, p: Sequence[Any]) -> Result:
    return Result([] if R.meta_get(conn.raw, p[0]) is None else [(1,)])


@stmt("SELECT xmin::text || ':' || ctid::text, CASE WHEN xmin::text || ':' || ctid::text = ? "
      "THEN NULL ELSE val END FROM meta WHERE key=?")
def _meta_reuse(conn: Any, p: Sequence[Any]) -> Result:
    got = R.meta_get(conn.raw, p[1])
    if got is None:
        return Result([])
    version, text = got
    return Result([(version, None if version and version == p[0] else text)])


@stmt("INSERT INTO meta(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val",
      "INSERT INTO meta(key, val) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET val = excluded.val")
def _meta_set(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic(write=True):
        R.meta_put(conn.raw, p[0], p[1], _names(conn))
        return _w(1)


@stmt("DELETE FROM meta WHERE key=?")
def _meta_delete(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic(write=True):
        return _w(R.meta_delete(conn.raw, p[0]))


# ----------------------------------------------------------------- the load statements

def _meta_probes(conn: Any, owner_keys: Sequence[str], keys: Sequence[str]) -> list[tuple[Any, Any]]:
    out = []
    blank = set(owner_keys)
    for key in keys:
        got = R.meta_get(conn.raw, key)
        if got is not None:
            out.append((key, "" if key in blank else got[1]))
    return out


def _presence(conn: Any) -> list[int]:
    from ... import store   # noqa: PLC0415
    return [i for i, sect in enumerate(store._PROBE_SECTS) if R.log_has(conn.raw, _m().logs[sect])]


def _load_meta(conn: Any, p: Sequence[Any]) -> Result:
    from ... import store   # noqa: PLC0415
    n = len(store._LOAD_OWNER_KEYS)
    with conn.atomic():
        return Result(_meta_probes(conn, p[:n], p[n:]))


def _load_presence(conn: Any, p: Sequence[Any]) -> Result:
    with conn.atomic():
        return Result([(i,) for i in _presence(conn)])


def _load_one(conn: Any, p: Sequence[Any]) -> Result:
    from ... import store   # noqa: PLC0415
    nm = len(store._LOAD_META_PARAMS)
    npr = len(store._PROBE_PARAMS)
    meta_p = p[:nm]
    deferred, held, _sep = p[nm + npr:nm + npr + 3]
    prefix = p[nm + npr + 3]
    null4 = (None, None, None, None)
    with conn.atomic():
        n_owner = len(store._LOAD_OWNER_KEYS)
        out: list[tuple[Any, ...]] = [(0, k, None, v, *null4)
                                      for k, v in _meta_probes(conn, meta_p[:n_owner], meta_p[n_owner:])]
        out += [(1, str(i), None, None, *null4) for i in _presence(conn)]
        out += [(2, k, v, t, *null4) for k, v, t in eager_versioned(conn, deferred, held)]
        out.append((3, None, None, None, *_listing(conn, prefix)))
        snap = conn.raw.execute("SELECT pg_current_snapshot()::text").fetchone()[0]
        out.append((4, snap, None, None, *null4))
        return Result(out)


# ----------------------------------------------------------------- the registry

def _passthrough(conn: Any, sql: str, p: Sequence[Any]) -> Result:
    from ... import pgstore   # noqa: PLC0415
    st = pgstore.translate(sql)
    cur = conn.raw.execute(st.sql, tuple(p) if p else None)
    rows = cur.fetchall() if cur.description else []
    return Result(rows)


for _t in ("SELECT pg_try_advisory_xact_lock(?, hashtext(?))",
           "SELECT pg_advisory_xact_lock(hashtext(?),hashtext(?))",
           "SELECT pg_postmaster_start_time()::text || ' ' || current_database()",
           "SELECT pg_current_snapshot()::text"):
    PASS.add(normalize(_t))


@stmt("SELECT revision FROM public.orgs WHERE org_id=?")
def _revision(conn: Any, p: Sequence[Any]) -> Result:
    if int(p[0]) != int(conn.org_id):
        raise CompatError("revision of another org")
    return Result([(conn.revision(),)])


_DYNAMIC: list[str] = []


def _register_dynamic() -> None:
    """Statements store.py builds from its own constants, registered from those constants so
    they cannot drift apart."""
    if _DYNAMIC:
        return
    from ... import store   # noqa: PLC0415
    _DYNAMIC.append("done")
    stmt(store._LOAD_META_SQL)(_load_meta)
    stmt(store._PRESENCE_SQL)(_load_presence)
    stmt(store._LOAD_ONE_SQL)(_load_one)
    stmt(_eager_sql())(lambda conn, p: Result(_eager_with(conn, p)))
    stmt(store._LOG_TAIL_SQLS["steered_log"])(lambda conn, p: _owner_tail(conn, p, "steered_log"))
    stmt(store._LOG_TAIL_SQLS["turn_error_log"])(lambda conn, p: _owner_tail(conn, p, "turn_error_log"))
    plain, revised = _transcript_source_sqls()
    stmt(plain)(lambda conn, p: _transcript_source(conn, p, False))
    stmt(revised)(lambda conn, p: _transcript_source(conn, p, True))
    for t in ("SELECT 1 FROM receipt_format WHERE singleton",
              "SELECT format, present FROM receipt_format WHERE singleton",
              "SELECT owner, nrows, version FROM receipt_owners ORDER BY ord"):
        UNREACHABLE[normalize(t)] = "custody receipts as rows (ORGTREE_RECEIPT_ROWS) are not served"


def _eager_with(conn: Any, p: Sequence[Any]) -> list[tuple[Any, ...]]:
    deferred, held, _sep = p
    with conn.atomic():
        return eager_versioned(conn, deferred, held)


def run(conn: Any, sql: str, params: Sequence[Any]) -> Result:
    """Answer one store.py statement on ``conn`` (an OrgDbConn)."""
    _register_dynamic()
    n = normalize(sql)
    fn = HANDLERS.get(n)
    if fn is not None:
        return fn(conn, params)
    if n in PASS:
        return _passthrough(conn, sql, params)
    if n in DECLINED:
        return Result([(1,)])
    if n in UNREACHABLE:
        raise CompatError(f"not served by the compatibility view ({UNREACHABLE[n]}): {n[:200]}")
    for pat, pfn in PATTERNS:
        mt = pat.match(n)
        if mt is not None:
            return pfn(conn, params, mt)
    raise UnknownStatement(f"the compatibility view does not serve this statement: {n[:300]}")


def known(sql: str) -> str | None:
    """How ``sql`` is served ('handler', 'pass', 'declined', 'unreachable', 'pattern'), or None."""
    _register_dynamic()
    n = normalize(sql)
    if n in HANDLERS:
        return "handler"
    if n in PASS:
        return "pass"
    if n in DECLINED:
        return "declined"
    if n in UNREACHABLE:
        return "unreachable"
    if any(p.match(n) for p, _ in PATTERNS):
        return "pattern"
    return None
