"""Migrations of the app database and of every org database (design §2.12).

Two folders, each applied to its own kind of database:

  pg_migrations/app/   the app database
  pg_migrations/org/   every org database, each recording its own level

The rules are today's (``pgstore.migrate``), applied per database:

* each file runs in its own transaction, and its ``schema_migrations`` row
  commits with it, so a database is always at exactly one level. A crash
  between files, or between orgs, leaves a set of databases at N and N+1, and
  the next start finishes the rest;
* an advisory lock serializes migrators of the same database (advisory lock
  keys are scoped to the current database, so orgs never block each other);
* a file edited after it was applied is drift and refuses;
* a database holding a migration this build does not know was written by a
  newer Orgtree (``NewerDatabase``). For the app database that refuses the
  start; for an org the caller marks that org unavailable (§2.12).

Unlike the legacy chain, the bookkeeping table lives in schema ``orgtree``,
like every other table of the new layout (§3.0, f14).
"""

from __future__ import annotations

import pathlib
import re
from typing import Any

from .. import pgstore

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "pg_migrations"
APP_DIR = MIGRATIONS / "app"
ORG_DIR = MIGRATIONS / "org"

_FILE_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
# 'orgtapp1' and 'orgtorg1' as 64-bit advisory lock keys
APP_LOCK = int.from_bytes(b"orgtapp1", "big") & 0x7FFFFFFFFFFFFFFF
ORG_LOCK = int.from_bytes(b"orgtorg1", "big") & 0x7FFFFFFFFFFFFFFF

MigrationDrift = pgstore.MigrationDrift


class NewerDatabase(MigrationDrift):
    """The database holds migrations this build does not know."""


def files(folder: pathlib.Path) -> list[pathlib.Path]:
    found = sorted(p for p in folder.iterdir() if p.is_file() and _FILE_RE.match(p.name))
    nums = [p.name[:4] for p in found]
    if len(set(nums)) != len(nums):
        raise MigrationDrift(f"duplicate migration numbers in {folder}")
    return found


def applied(conn: Any) -> dict[str, str]:
    """{name: sha256} of what this database has applied ({} for a fresh one)."""
    if conn.execute("SELECT to_regclass('orgtree.schema_migrations')").fetchone()[0] is None:
        return {}
    return {str(n): str(s) for n, s in conn.execute(
        "SELECT name, sha256 FROM orgtree.schema_migrations").fetchall()}


def state(conn: Any, folder: pathlib.Path) -> dict[str, Any]:
    """Compare a database with a folder without changing anything:
    {"pending": [...], "ahead": [...], "drift": [...]}."""
    done = applied(conn)
    known = {p.name: pgstore._sha(p.read_bytes()) for p in files(folder)}
    return {"pending": sorted(set(known) - set(done)),
            "ahead": sorted(set(done) - set(known)),
            "drift": sorted(n for n in set(done) & set(known) if done[n] != known[n])}


def migrate(conn: Any, folder: pathlib.Path, lock_key: int) -> dict[str, Any]:
    """Apply every pending file of ``folder`` to the database ``conn`` is
    connected to. ``conn`` must be in autocommit mode, as the database's owner.
    Returns {"applied": [names applied now], "current": [every known name]}."""
    conn.execute("SELECT pg_advisory_lock(%s)", (lock_key,))
    try:
        conn.execute("CREATE SCHEMA IF NOT EXISTS orgtree")
        conn.execute("CREATE TABLE IF NOT EXISTS orgtree.schema_migrations ("
                     "name text PRIMARY KEY, sha256 text NOT NULL, "
                     "applied_at timestamptz NOT NULL DEFAULT now())")
        done = applied(conn)
        found = files(folder)
        known = {p.name for p in found}
        ahead = sorted(set(done) - known)
        if ahead:
            raise NewerDatabase(f"database has migrations this build does not: {ahead}")
        now: list[str] = []
        for p in found:
            data = p.read_bytes()
            sha = pgstore._sha(data)
            if p.name in done:
                if done[p.name] != sha:
                    raise MigrationDrift(f"{p.name} changed after it was applied")
                continue
            with conn.transaction():
                if p.name == '0016_schema_conformance.sql':
                    # The backfill updates work_items before altering its columns.
                    # Populated current pointers queue deferred FK trigger events
                    # (their kind columns are generated), which block that DDL.
                    # Check these existing links immediately in this transaction;
                    # do not change their schema defaults or the shipped SQL hash.
                    conn.execute('SET CONSTRAINTS orgtree.current_verdict_event_id_fk, '
                                 'orgtree.current_review_packet_event_id_fk IMMEDIATE')
                conn.execute(data.decode("utf-8"))
                conn.execute("INSERT INTO orgtree.schema_migrations(name, sha256) VALUES (%s, %s)",
                             (p.name, sha))
            now.append(p.name)
        return {"applied": now, "current": sorted(known)}
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
