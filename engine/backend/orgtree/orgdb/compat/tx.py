"""org_tx on one database per org (the compatibility view's ``orgtx`` backend).

``orgtx.PgBackend`` runs every org a call names in ONE transaction on one server connection.
With a database per org that cannot be (design §2.1: no transaction spans two databases), so
here each org has its own connection and transaction. Everything else is PgBackend's:

* the same lock plan (``orgtx._lock_plan``), in the same order, as one DO block per org: the
  same advisory keys (they are per database, so orgs never collide), then the rows themselves
  ``FOR UPDATE`` / ``FOR SHARE`` so a save outside org_tx waits for them, as the legacy rows
  made it wait. A node is its ``agents`` row; a plain section its ``org_sections`` row; a
  split owner its ``org_section_owners`` row; a docket item its ``work_items`` row; a
  (dict log, owner) the owner's records of that log. Those are exactly the rows the view's
  compare-and-set writes lock (``rows``);
* operation receipts (``op_key``) in the org's own ``tx_receipts``, today's
  ``public.receipts`` (design §2.1 "Idempotency");
* loads and saves pinned to the transaction's connection, the heal check and stamp, and the
  revision bump + NOTIFY of each org's save.

Several orgs: every org's save runs and is checked before any org commits, so a refused or
failing write in any org rolls them all back, as PgBackend's one transaction does. Then the
last org's save commits (inside the save, as PgBackend's one COMMIT), and the others commit
after it, in org_id order. Only a failure during those commits leaves some orgs committed and
others not; the callers are idempotent per org (design §2.1). The only multi-org caller
today is account_removal.
"""

from __future__ import annotations

import contextlib
import json
import secrets
from typing import Any, Iterator

from ... import orgtx, profiling, store, txlog
from ...stateprobe import SaveChanges
from .. import registry as _reg
from . import conn as C
from . import rows as R


def _writes_settings(tx: orgtx.OrgTx) -> bool:
    """May this transaction write a settings key (one it locks FOR UPDATE)?"""
    return any(R.SEP not in name and R.fence_key(name, creating=False) == R.SETTINGS_FENCE
               for name in tx.lock_sections)


def _lock_rows(raw: Any, org_id: int, entries: list[tuple[str, str, bool]]) -> str | None:
    """``orgtx._lock_block`` for an org database: one DO block, entries in plan order."""
    if not entries:
        return None
    from psycopg import sql   # noqa: PLC0415
    m = R.model()
    lines: list[str] = []

    def lit(v: Any) -> str:
        return sql.Literal(v).as_string(raw)

    for kind, name, exclusive in entries:
        fn = "pg_advisory_xact_lock" if exclusive else "pg_advisory_xact_lock_shared"
        how = " FOR UPDATE" if exclusive else " FOR SHARE"
        if kind == "section" and name.startswith(orgtx._RECEIPT_OWNER):    # pyright: ignore[reportPrivateUsage]
            lines.append(f"PERFORM {fn}(hashtext({lit(f'org_{int(org_id)}')}), "
                         f"hashtext({lit('receipt-owner:' + name[len(orgtx._RECEIPT_OWNER):])}));")   # pyright: ignore[reportPrivateUsage]
            continue
        lines.append(f"PERFORM {fn}({int(org_id)}, hashtext({lit(f'{kind}:{name}')}));")
        if name == orgtx._ALL_NODES_KEY:                                # pyright: ignore[reportPrivateUsage]
            continue
        if kind == "node":
            lines.append(f"PERFORM 1 FROM orgtree.agents WHERE name = {lit(name)} "
                         f"AND NOT tombstone{how};")
        elif kind == "section":
            sect, sep, rest = name.partition(R.SEP)
            if not sep:
                lines.append(f"PERFORM 1 FROM orgtree.org_sections WHERE key = {lit(name)}{how};")
            elif sect in m.split:
                lines.append("PERFORM 1 FROM orgtree.org_section_owners o JOIN orgtree.agents a "
                             f"ON a.id = o.agent_id WHERE o.section = {lit(sect)} "
                             f"AND a.name = {lit(rest)}{how} OF o;")
            elif sect == m.workrows.SECTION:
                lines.append(f"PERFORM 1 FROM orgtree.work_items WHERE slug = {lit(rest)} "
                             f"AND list_key = 'active'{how};")
            else:
                raise R.CompatError(f"lock of section row {name!r}: no such row form")
        elif kind == "log":
            sect, owner = json.loads(name)
            ls = m.logs.get(sect)
            if ls is None or ls.kind not in ("agent", "agent_map"):
                raise R.CompatError(f"lock of log row {name!r}: not a dict log")
            lines.append(f"PERFORM 1 FROM orgtree.{ls.table.spec.table} t JOIN orgtree.agents a "
                         f"ON a.id = t.agent_id WHERE a.name = {lit(owner)}{how} OF t;")
        else:
            raise R.CompatError(f"lock plan entry of kind {kind!r}")
    if any(kind == "section" and exclusive and R.SEP not in name
           and R.fence_key(name, creating=False) == R.SETTINGS_FENCE
           for kind, name, exclusive in entries):
        # a plan that may write a settings key takes the settings fence before ANY row, as
        # every other settings writer does (rows.fence_key, reviews f21 and f24): its rows
        # include settings rows it only reads, which a writer holding the fence may need
        lines.insert(0, "PERFORM pg_advisory_xact_lock(hashtext('orgdb-doc-key'), "
                        f"hashtext({lit(R.SETTINGS_FENCE)}));")
    body = "BEGIN\n" + "\n".join(lines) + "\nEND"
    while True:
        tag = "$orgtx_" + secrets.token_hex(6) + "$"
        if tag not in body:
            return f"DO {tag}{body}{tag}"


def _whole(raw: Any) -> tuple[list[str], list[tuple[str, str]]]:
    """Every doc row name (locked FOR UPDATE) and every (dict log, owner) pair."""
    m = R.model()
    keys = [str(k) for (k,) in raw.execute(
        "SELECT key FROM orgtree.org_sections ORDER BY key FOR UPDATE").fetchall()]
    for sect, owner in raw.execute(
            "SELECT o.section, a.name FROM orgtree.org_section_owners o JOIN orgtree.agents a "
            "ON a.id = o.agent_id WHERE o.section = ANY(%s) AND o.state = 'l' "
            "ORDER BY o.section, a.name FOR UPDATE OF o", (sorted(m.split),)).fetchall():
        keys.append(f"{sect}{R.SEP}{owner}")
    keys += [m.workrows.PREFIX + str(s) for (s,) in raw.execute(
        "SELECT slug FROM orgtree.work_items WHERE list_key = 'active' ORDER BY slug "
        "FOR UPDATE").fetchall()]
    pairs: list[tuple[str, str]] = []
    for ls in m.logs.values():
        if ls.kind in ("agent", "agent_map"):
            pairs += [(ls.name, str(n)) for (n,) in raw.execute(
                f"SELECT DISTINCT a.name FROM orgtree.{ls.table.spec.table} t "
                "JOIN orgtree.agents a ON a.id = t.agent_id").fetchall()]
    return keys, pairs


class OrgDbBackend:
    """org_tx with the storage switch on (module docstring)."""

    def transaction(self, tx: orgtx.OrgTx, lock_timeout: float) -> contextlib.AbstractContextManager[None]:
        return self.transaction_many([tx], lock_timeout)

    @contextlib.contextmanager
    def transaction_many(self, txs: list[orgtx.OrgTx], lock_timeout: float) -> Iterator[None]:
        from ...ledger import LedgerError   # noqa: PLC0415
        found: dict[str, tuple[int, str, str, str]] = {}
        for tx in txs:
            row = _reg.lookup(tx.slug)
            if row is None or row[2] != "active":
                raise LedgerError(f"no such org: {tx.slug!r}")
            found[tx.slug] = row
        order = sorted(txs, key=lambda t: found[t.slug][0])
        conns: dict[str, C.OrgDbConn] = {}
        loc = store._orgtx_local                                       # pyright: ignore[reportPrivateUsage]
        try:
            for tx in order:
                org_id, database, _, org_uuid = found[tx.slug]
                conns[tx.slug] = C.OrgDbConn(_reg.checkout(tx.slug, database, org_uuid),
                                             tx.slug, org_id, database)
            for tx in order:
                orgtx._pause("before_lock", tx)                         # pyright: ignore[reportPrivateUsage]
            try:
                for tx in order:
                    conn = conns[tx.slug]
                    raw = conn.raw
                    raw.execute(f"BEGIN; "
                                f"SET LOCAL lock_timeout = '{max(1, int(lock_timeout * 1000))}ms'; "
                                f"SET LOCAL idle_in_transaction_session_timeout = "
                                f"'{int(orgtx.IDLE_IN_TX_TIMEOUT_S * 1000)}ms'; "
                                f"SET LOCAL application_name = {txlog.app_name(tx)}")
                    raw.execute("SELECT pg_advisory_xact_lock" + ("" if tx.whole else "_shared")
                                + "(%s, hashtext(%s))", (conn.org_id, f"org:{orgtx._ORG_KEY}"))   # pyright: ignore[reportPrivateUsage]
                    # the registry row was read before this lock: an org trashed meanwhile
                    # is not written
                    again = _reg.lookup(tx.slug)
                    if again is None or again[0] != conn.org_id or again[2] != "active":
                        raise LedgerError(f"no such org: {tx.slug!r}")
                    orgtx._receipt_scope(tx, False)                     # pyright: ignore[reportPrivateUsage]
                    if tx.whole or (tx.all_nodes and _writes_settings(tx)):
                        # a whole-org transaction (every row, settings rows included), and one
                        # over ALL nodes that may write a settings key (it locks every agent row
                        # below, before its plan's block): the settings fence first, before
                        # any row, as every other settings writer takes it (rows.fence_key,
                        # review f24; settingstx.whole_org_tx is such a caller)
                        raw.execute("SELECT pg_advisory_xact_lock(hashtext('orgdb-doc-key'), "
                                    "hashtext(%s))", (R.SETTINGS_FENCE,))
                    ids: list[str] = []
                    if tx.all_nodes:
                        if not tx.whole:
                            raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                                        (conn.org_id, f"node:{orgtx._ALL_NODES_KEY}"))   # pyright: ignore[reportPrivateUsage]
                        ids = [str(r[0]) for r in raw.execute(
                            "SELECT name FROM orgtree.agents WHERE NOT tombstone ORDER BY name "
                            "FOR UPDATE").fetchall()]
                        tx.lock_nodes = frozenset(ids)
                        if tx.whole:
                            orgtx._whole_rows(tx, *_whole(raw))         # pyright: ignore[reportPrivateUsage]
                    block = _lock_rows(raw, conn.org_id, [
                        e for e in orgtx._lock_plan(tx, ids)            # pyright: ignore[reportPrivateUsage]
                        if not (e[0] == "org" or (tx.all_nodes and e[0] == "node"))])
                    if block is not None:
                        raw.execute(block)
            except Exception as e:
                raise orgtx._pg_error(e) from e                         # pyright: ignore[reportPrivateUsage]
            for tx in order:
                orgtx._pause("after_lock", tx)                          # pyright: ignore[reportPrivateUsage]
            for tx in order:
                if tx.op_key is None:
                    continue
                raw = conns[tx.slug].raw
                try:
                    raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                                (conns[tx.slug].org_id, "receipt:" + tx.op_key))
                except Exception as e:
                    raise orgtx._pg_error(e) from e                     # pyright: ignore[reportPrivateUsage]
                row = raw.execute("SELECT fingerprint, result FROM orgtree.tx_receipts "
                                  "WHERE op_key = %s", (tx.op_key,)).fetchone()
                if row is not None:
                    if row[0] != tx.fingerprint:
                        raise orgtx.ReceiptConflict(
                            f"op_key {tx.op_key!r} was used with another fingerprint")
                    tx.replayed = True
                    tx.result = None if row[1] is None else json.loads(row[1])
            orgtx._refuse_mixed_replay(order)                           # pyright: ignore[reportPrivateUsage]
            for c in conns.values():
                c.pinned = True
            loc.pinned = dict(conns)
            gots: dict[str, list[SaveChanges]] = {}
            try:
                for tx in order:
                    with profiling.stage("org_load_ms"):
                        tx.org = store._load_sqlite_org(tx.slug, lazy_work=True)   # pyright: ignore[reportPrivateUsage]
                    orgtx._check_heal(tx)                               # pyright: ignore[reportPrivateUsage]
                    store.stamp_heal_epoch(tx.org)
                    if not tx.all_nodes:
                        store.prefetch_nodes(tx.org, tx.lock_nodes | tx.share_nodes)
                yield
                if any(tx.replayed for tx in order):
                    for tx in order:
                        conns[tx.slug].raw.execute("ROLLBACK")
                        tx.revision = conns[tx.slug].revision()
                    return
                for tx in order:
                    orgtx._pause("before_commit", tx)                   # pyright: ignore[reportPrivateUsage]
                for i, tx in enumerate(order):
                    conn = conns[tx.slug]
                    last = i == len(order) - 1
                    got: list[SaveChanges] = []
                    gots[tx.slug] = got

                    def guard(changes: SaveChanges, tx: orgtx.OrgTx = tx,
                              conn: C.OrgDbConn = conn, last: bool = last) -> None:
                        orgtx._check(tx, changes)                       # pyright: ignore[reportPrivateUsage]
                        if tx.op_key is not None:
                            conn.raw.execute(
                                "INSERT INTO orgtree.tx_receipts (op_key, fingerprint, result) "
                                "VALUES (%s, %s, %s)", (tx.op_key, tx.fingerprint,
                                                        json.dumps(tx.result)))
                            if changes.is_empty():
                                conn.on_save_commit(True)
                        # only the LAST org's save commits inside the save, as PgBackend's
                        # one COMMIT; the others commit once every save has passed (below)
                        conn.commit_armed = last

                    loc.guard, loc.on_commit = guard, got.append
                    loc.defer_hooks = tx.deferred_hooks
                    try:
                        orgtx._billed_save(tx.org, got, tx.op_key is not None)   # pyright: ignore[reportPrivateUsage]
                    except Exception as e:
                        for done in order[:i + 1]:
                            store._publish_changes_unknown(done.slug, "orgtx_failed")   # pyright: ignore[reportPrivateUsage]
                            store._bump_org_seq(done.slug)              # pyright: ignore[reportPrivateUsage]
                        raise orgtx._pg_error(e) from e                 # pyright: ignore[reportPrivateUsage]
                    finally:
                        loc.guard = loc.on_commit = loc.defer_hooks = None
            finally:
                loc.pinned = None
                for c in conns.values():
                    c.pinned = False
            if len(order) > 1:
                try:
                    # every org's save passed (a refused write anywhere rolled them all
                    # back): commit the others, in order. A failure here leaves the later
                    # orgs committed (module docstring)
                    for tx in order[:-1]:
                        try:
                            conns[tx.slug]._finish(commit=True)         # pyright: ignore[reportPrivateUsage]
                        except Exception as e:
                            raise orgtx._pg_error(e) from e             # pyright: ignore[reportPrivateUsage]
                finally:
                    # their saves published their change sets before these COMMITs, as
                    # PgBackend's earlier orgs do before its one COMMIT
                    for tx in order[:-1]:
                        store._publish_changes_unknown(tx.slug, "orgtx_multi_org")   # pyright: ignore[reportPrivateUsage]
                        store._bump_org_seq(tx.slug)                    # pyright: ignore[reportPrivateUsage]
            for tx in order:
                conn = conns[tx.slug]
                got = gots[tx.slug]
                tx.revision = (conn.last_revision if conn.last_revision is not None
                               else conn.revision())
                tx.committed = orgtx.Committed(tx.slug, tx.revision,
                                               got[0] if got else SaveChanges(), tx.op_key)
            from ... import receiptcommit   # noqa: PLC0415
            receiptcommit.committed(conns.values())
            for tx in order:
                orgtx._pause("after_commit", tx)                        # pyright: ignore[reportPrivateUsage]
        finally:
            from ... import receiptcommit   # noqa: PLC0415
            receiptcommit.discard(conns.values())
            for c in conns.values():
                with contextlib.suppress(Exception):
                    if c.in_transaction:
                        c.raw.execute("ROLLBACK")
                with contextlib.suppress(Exception):
                    c.close()

    def read(self, slug: str, sections: tuple[str, ...]) -> Any:
        return store.load_org_snapshot(slug, sections)

    @contextlib.contextmanager
    def exclusive(self, slug: str, lock_timeout: float) -> Iterator[None]:
        """``org_exclusive``: the org pseudo-row's advisory lock, exclusive, in a short
        transaction on the org's database that reads and writes nothing."""
        from ...ledger import LedgerError   # noqa: PLC0415
        row = _reg.lookup(slug)
        if row is None or row[2] != "active":
            raise LedgerError(f"no such org: {slug!r}")
        org_id, database, _, org_uuid = row
        raw = _reg.checkout(slug, database, org_uuid)
        try:
            try:
                raw.execute("BEGIN")
                raw.execute(f"SET LOCAL lock_timeout = '{max(1, int(lock_timeout * 1000))}ms'")
                raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))",
                            (org_id, f"org:{orgtx._ORG_KEY}"))         # pyright: ignore[reportPrivateUsage]
            except Exception as e:
                raise orgtx._pg_error(e) from e                         # pyright: ignore[reportPrivateUsage]
            yield
        finally:
            with contextlib.suppress(Exception):
                raw.execute("ROLLBACK")
            _reg.release(raw, database)
