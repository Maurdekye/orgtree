"""Archive bounds, maintained by writers in their transaction (design A.4)."""
from __future__ import annotations

import json
from typing import Any, Iterable


def ordinal(value: Any) -> int:
    """The legacy Org._recv_ordinal domain, without narrowing large integers."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else 0


def lock(c: Any, aid: int) -> tuple[int, int, int]:
    """Agent first, mailbox second; caller must take these before archive rows."""
    return lock_many(c, [aid])[aid]


def lock_many(c: Any, aids: Iterable[int]) -> dict[int, tuple[int, int, int]]:
    ids = sorted(set(aids))
    if not ids:
        return {}
    c.execute("SELECT id FROM orgtree.agents WHERE id=ANY(%s) ORDER BY id FOR UPDATE", (ids,))
    out = {}
    for aid in ids:
        c.execute("INSERT INTO orgtree.mailboxes(agent_id) VALUES (%s) ON CONFLICT DO NOTHING", (aid,))
        row = c.execute("SELECT version,nrows,next_recv_seq-1 FROM orgtree.mailboxes "
                        "WHERE agent_id = %s FOR UPDATE", (aid,)).fetchone()
        out[aid] = tuple(int(v) for v in row)
    return out


def advance(c: Any, aid: int, value: Any) -> None:
    """One append, with no archive read. The row was locked before the append."""
    c.execute("UPDATE orgtree.mailboxes SET next_recv_seq=greatest(next_recv_seq,%s), "
              "nrows=nrows+1, version=version+1 WHERE agent_id=%s", (ordinal(value)+1, aid))


def maxima(rows: Iterable[Any]) -> dict[int, tuple[int, int]]:
    """Cold conversion/rewrite: (row count, exact maximum) for each owner."""
    out: dict[int, tuple[int, int]] = {}
    for aid, seq, extra in rows:
        extra = json.loads(extra) if isinstance(extra, str) else extra
        value = extra['recv_seq'] if isinstance(extra, dict) and 'recv_seq' in extra else seq
        n, high = out.get(int(aid), (0, 0))
        out[int(aid)] = (n+1, max(high, ordinal(value)))
    return out


def recount(c: Any, aids: Iterable[int]) -> None:
    """Cold edits/removals may lower the archive floor; bump even if it stays equal."""
    for aid in sorted(set(aids)):
        rows = c.execute("SELECT agent_id,recv_seq,extra FROM orgtree.mail_log "
                         "WHERE agent_id=%s", (aid,)).fetchall()
        n, high = maxima(rows).get(aid, (0, 0))
        c.execute("UPDATE orgtree.mailboxes SET nrows=%s,next_recv_seq=%s,version=version+1 "
                  "WHERE agent_id=%s", (n, high+1, aid))


def converted(c: Any) -> int:
    """COPY's exclusive staging database: fill bounds before publishing it."""
    bounds = maxima(c.execute("SELECT agent_id,recv_seq,extra FROM orgtree.mail_log"))
    for aid in sorted(bounds):
        lock(c, aid)
        n, high = bounds[aid]
        c.execute("UPDATE orgtree.mailboxes SET nrows=%s,next_recv_seq=%s,version=version+1 "
                  "WHERE agent_id=%s", (n, high+1, aid))
    return len(bounds)
