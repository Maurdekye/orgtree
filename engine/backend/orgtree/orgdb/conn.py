"""Connections to a named database of the new layout.

The engine is given ONE base conninfo for the runtime role (today's
``ORGTREE_PG_CONNINFO``, or ``ORGTREE_PG_URL`` in tests and dev), and reaches
each database by overriding only its name. The base is a libpq keyword string
or a URL; either way the password stays in the passfile it names, never here.

This module never reads the admin conninfo. Only ``lifecycle`` does (design
§2.11, Q10), and a source scan test enforces it.
"""

from __future__ import annotations

from typing import Any

from .. import pgstore


def runtime_base() -> str:
    """The runtime role's base conninfo, exactly as the engine is given it."""
    return pgstore.url()


def with_db(base: str, dbname: str, *, application_name: str | None = None) -> str:
    """``base`` aimed at ``dbname`` (keyword form)."""
    from psycopg.conninfo import make_conninfo   # noqa: PLC0415
    extra: dict[str, Any] = {"dbname": dbname}
    if application_name:
        extra["application_name"] = application_name
    return make_conninfo(base, **extra)


def role_of(base: str) -> str:
    """The role a base conninfo logs in as (empty when it names none)."""
    from psycopg.conninfo import conninfo_to_dict   # noqa: PLC0415
    return str(conninfo_to_dict(base).get("user") or "")


def connect(base: str, dbname: str, *, autocommit: bool = True,
            application_name: str | None = None) -> Any:
    """A psycopg connection to ``dbname``. From an agent context, never the
    live cluster (``pgstore.refuse_live_cluster``)."""
    import psycopg   # noqa: PLC0415  only when this storage runs
    target = with_db(base, dbname, application_name=application_name)
    pgstore.refuse_live_cluster(target)
    return psycopg.connect(target, autocommit=autocommit)
