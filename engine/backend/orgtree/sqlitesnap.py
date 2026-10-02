"""A SQLite database as of its last committed state, read without writing it (orgdb design §5.3).

The 2.1.14 first-launch import (tools/pypg/pgimport.py), its Retry of a held-back org, and the
conversion's side files read old SQLite files that must stay exactly as they are. A plain
``mode=ro`` open is not enough (measured, SQLite 3.50): for a WAL database it rewrites the
``-shm`` index, and creates ``-wal`` and ``-shm`` when they are missing. And an ``immutable=1``
open of a file a writer left mid-transaction reads the pages that transaction had already
spilled into the main file, which only its hot rollback journal can undo (review f20).

``snapshot_into(path, dst)`` copies the database into ``dst`` through the backup API:

* a hot rollback journal (an interrupted transaction), or a ``-wal`` without its ``-shm``: every
  open that honours them writes (it rolls the journal back, or rebuilds the index). The main
  file and its ``-wal``/``-journal`` are copied into a private temporary folder and opened
  there, so SQLite recovers the COPY exactly as the old build would recover the original at
  its next open;
* ``-wal`` and ``-shm`` present: ``mode=ro&readonly_shm=1`` reads the WAL, committed frames not
  yet checkpointed included, and writes neither file;
* otherwise the file alone is the whole database: ``mode=ro&immutable=1`` reads it without
  creating anything.

The caller makes sure no writer runs meanwhile (the engine is stopped, or the data root's owner
lock is held).
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from pathlib import Path

#: The first 8 bytes of a rollback journal that holds a transaction to roll back. A journal
#: whose header is zeroed (PERSIST) or that is empty (TRUNCATE) holds nothing.
HOT_JOURNAL_MAGIC = bytes.fromhex("d9d505f920a163d7")


def hot_journal(journal: str | os.PathLike[str]) -> bool:
    """A rollback journal a writer left behind mid-transaction."""
    try:
        with open(journal, "rb") as f:
            return f.read(8) == HOT_JOURNAL_MAGIC
    except FileNotFoundError:
        return False


def _backup(uri: str, dst: sqlite3.Connection) -> None:
    src = sqlite3.connect(uri, uri=True)
    try:
        src.backup(dst)
    finally:
        src.close()


def snapshot_into(path: str | os.PathLike[str], dst: sqlite3.Connection) -> bool:
    """Copy the SQLite database at ``path`` into ``dst`` as of its last committed state,
    writing neither the file nor any file beside it (see the module docstring). False when
    there is no file."""
    p = Path(path)
    if not p.is_file():
        return False
    wal, shm, journal = (Path(f"{p}{suffix}") for suffix in ("-wal", "-shm", "-journal"))
    if hot_journal(journal) or (wal.exists() and not shm.exists()):
        with tempfile.TemporaryDirectory(prefix="orgtree-sqlite-") as tmp:
            copy = Path(tmp) / p.name
            shutil.copyfile(p, copy)
            for side in (wal, journal):
                if side.exists():
                    shutil.copyfile(side, Path(f"{copy}{side.name[len(p.name):]}"))
            _backup(copy.as_uri(), dst)
    elif wal.exists():
        _backup(p.resolve().as_uri() + "?mode=ro&readonly_shm=1", dst)
    else:
        _backup(p.resolve().as_uri() + "?mode=ro&immutable=1", dst)
    return True


def snapshot_sqlite(path: str | os.PathLike[str]) -> sqlite3.Connection | None:
    """An in-memory copy of the SQLite database at ``path`` (``snapshot_into``); None when there
    is no file."""
    mem = sqlite3.connect(":memory:")
    try:
        if not snapshot_into(path, mem):
            mem.close()
            return None
    except BaseException:
        mem.close()
        raise
    return mem
