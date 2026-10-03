"""Rows in and out of an org database: COPY in, SELECT out (design §5.2 steps 3 and 5).

``tables()`` is every table the sections write, parents before children, in the order the
org migration creates them. ``write`` copies a converted document's rows into a staging
database in that order, so every foreign key already has its row. ``read`` returns every row
of those tables, for the read-back comparison and the compatibility load.

The converter assigns surrogate ids itself; moving each id sequence past them is the
lifecycle's (``Lifecycle.mark_filled``), because the runtime role may not reset sequences.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .. import codec, mappers
from ..sections import Section

FRAMEWORK = ("org_sections", "org_section_owners", "org_extra")


def tables(sections: Iterable[Section] | None = None) -> list[str]:
    secs = list(sections) if sections is not None else mappers.sections()
    out = ["tool_lists", "tool_list_items"]
    nodes = [s for s in secs if s.keys == ("nodes",)]
    for s in nodes:
        for t in s.tables:
            out.extend(t.layout())
    out.extend(FRAMEWORK)
    for s in secs:
        if s in nodes:
            continue
        for t in s.tables:
            out.extend(t.layout())
    seen: set[str] = set()
    return [t for t in out if not (t in seen or seen.add(t))]


def write(conn: Any, rows: Mapping[str, list[dict[str, Any]]], *,
          order: list[str] | None = None) -> dict[str, int]:
    """COPY every table's rows; returns {table: rows written}. ``conn`` is a psycopg
    connection; the caller owns the transaction."""
    order = order or tables()
    unknown = set(t for t, rs in rows.items() if rs) - set(order)
    if unknown:
        raise ValueError(f"rows for tables no section declares: {sorted(unknown)}")
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        for table in order:
            rs = rows.get(table) or []
            if not rs:
                continue
            cols = list(rs[0])
            colset = set(cols)
            with cur.copy(f"COPY orgtree.{table} ({codec.quoted(cols)}) FROM STDIN") as cp:
                for r in rs:
                    if len(r) != len(cols) or set(r) != colset:
                        raise ValueError(f"{table}: rows with different columns")
                    cp.write_row([r[c] for c in cols])
            counts[table] = len(rs)
    return counts


def write_receipts(conn: Any, rows: list[tuple[Any, ...]]) -> int:
    """COPY an org's operation receipts (``legacy.receipts`` rows) into its ``tx_receipts``;
    returns the rows written. The caller owns the transaction."""
    if rows:
        with conn.cursor() as cur:
            with cur.copy("COPY orgtree.tx_receipts (op_key, fingerprint, result, at) "
                          "FROM STDIN") as cp:
                for r in rows:
                    cp.write_row(r)
    return len(rows)


def read_receipts(conn: Any) -> list[tuple[Any, ...]]:
    """The org's ``tx_receipts`` rows, in ``legacy.receipts``'s form and order."""
    return [tuple(r) for r in conn.execute(
        "SELECT op_key, fingerprint, result, at FROM orgtree.tx_receipts "
        "ORDER BY op_key COLLATE \"C\"").fetchall()]


def read(conn: Any, *, order: list[str] | None = None) -> dict[str, list[dict[str, Any]]]:
    """Every row of every section table, as dicts keyed by column name."""
    from psycopg.rows import dict_row   # noqa: PLC0415
    out: dict[str, list[dict[str, Any]]] = {}
    with conn.cursor(row_factory=dict_row) as cur:
        for table in order or tables():
            out[table] = cur.execute(f"SELECT * FROM orgtree.{table}").fetchall()
    return out
