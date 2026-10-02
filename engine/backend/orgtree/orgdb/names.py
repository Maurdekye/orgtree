"""Database names of the new layout, all from one prefix (design §2.10, §2.13).

  <p>app                   the app database: registry, machine-wide accounts,
                           turn queue
  <p>org_<n>               org n's database. n is the registry's org_id, so
                           renaming an org never renames its database
  <p>stage_<n>_<epoch>     a create, conversion, retry or import still being
                           built, named by the claim that builds it, so a
                           stale cleanup can only ever drop its own attempt
  <p>trash_<n>_<stamp>     a trashed org's database

The product prefix is ``orgtree_``. Tests and rehearsals set their own through
``ORGTREE_ORGDB_PREFIX``, so several of them can share one cluster without
touching each other's databases or an install's. Today's legacy database is
named ``orgtree``, which matches none of the patterns: nothing here can name it.
"""

from __future__ import annotations

import os
import re

PREFIX_ENV = "ORGTREE_ORGDB_PREFIX"
PRODUCT_PREFIX = "orgtree_"

_PREFIX_RE = re.compile(r"[a-z][a-z0-9_]{0,23}_\Z")
_MAX_IDENT = 63          # PostgreSQL's identifier limit (NAMEDATALEN - 1)
_STAMP_RE = re.compile(r"[0-9]{8}t[0-9]{6}\Z")


def prefix() -> str:
    """The prefix in force: ``ORGTREE_ORGDB_PREFIX``, else the product's."""
    p = os.environ.get(PREFIX_ENV, "").strip() or PRODUCT_PREFIX
    if not _PREFIX_RE.match(p):
        raise ValueError(f"{PREFIX_ENV} must match {_PREFIX_RE.pattern!r}, got {p!r}")
    return p


def _checked(name: str) -> str:
    if len(name.encode("utf-8")) > _MAX_IDENT:
        raise ValueError(f"database name longer than {_MAX_IDENT} bytes: {name}")
    return name


def _n(value: int, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{what} must be a non-negative int, got {value!r}")
    return value


def app(p: str | None = None) -> str:
    return _checked(f"{p or prefix()}app")


def org(org_id: int, p: str | None = None) -> str:
    return _checked(f"{p or prefix()}org_{_n(org_id, 'org_id')}")


def stage(org_id: int, epoch: int, p: str | None = None) -> str:
    return _checked(f"{p or prefix()}stage_{_n(org_id, 'org_id')}_{_n(epoch, 'epoch')}")


def trash(org_id: int, stamp: str, p: str | None = None) -> str:
    """``stamp`` is ``YYYYMMDDtHHMMSS`` (UTC), lower case."""
    if not _STAMP_RE.match(stamp):
        raise ValueError(f"trash stamp must look like 20261002t154800, got {stamp!r}")
    return _checked(f"{p or prefix()}trash_{_n(org_id, 'org_id')}_{stamp}")


def kind(name: str, p: str | None = None) -> str | None:
    """'app', 'org', 'stage' or 'trash' for a name of this prefix, else None."""
    pre = p or prefix()
    if not name.startswith(pre):
        return None
    rest = name[len(pre):]
    if rest == "app":
        return "app"
    if re.fullmatch(r"org_[0-9]+", rest):
        return "org"
    if re.fullmatch(r"stage_[0-9]+_[0-9]+", rest):
        return "stage"
    if re.fullmatch(r"trash_[0-9]+_[0-9]{8}t[0-9]{6}", rest):
        return "trash"
    return None
