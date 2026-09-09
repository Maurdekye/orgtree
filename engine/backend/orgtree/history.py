"""Bounded browsing of retained v2 records, separate from graph snapshots.

SQLite pages use the existing row sequence, so equal timestamps and identical
messages remain separate. A cursor whose anchor was removed/reordered expires
explicitly. JSON rollback documents and embedded node records use an index plus
content digest with the same restart-on-change rule.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from . import store, turnread
from .ledger import LedgerError

router = APIRouter()
SECTIONS = {
    "chat": ("chat", "Chat transcript", True),
    "node-mail": ("mail_log", "Agent mail", True),
    "user-mail": ("user_mail_log", "Read user mail", False),
    "user-sent": ("user_outbox", "User sent mail", False),
    "org-mail": ("org_inbox", "Organization mail", False),
    "notices": ("notice_log", "Notices", False),
    "documents": ("documents", "Presented documents", False),
    "events": ("events", "Organization events", False),
    "steered": ("steered_log", "Mid-turn messages and receipts", True),
    "errors": ("turn_error_log", "Turn errors", True),
    "watchdogs": ("watchdog_history", "Watchdog events", False),
    "turns": ("turns", "Turn usage history", True),
    "oracle": ("oracle_exchanges", "Oracle exchanges", True),
    "turn-records": ("turn-records", "Turn diagnostic records", True),
}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":")).encode()).hexdigest()[:24]


def _encode(value: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def _decode(cursor: str, section: str, node: str) -> dict[str, Any]:
    try:
        if len(cursor) > 2048:
            raise ValueError()
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if value["section"] != section or value["node"] != node:
            raise ValueError()
        if type(value["before"]) is not int or value["before"] < 0:
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, "Invalid history cursor") from None


def _expired() -> None:
    raise HTTPException(409, "History changed while browsing. Refresh to start again.")


def _list_page(rows: list[Any], state: dict[str, Any], limit: int) -> tuple[list[Any], int, dict[str, Any] | None]:
    before = state.get("before", len(rows))
    if state:
        if state.get("kind") != "list" or before >= len(rows) or _digest(rows[before]) != state.get("anchor"):
            _expired()
    start = max(0, before - limit)
    items = list(reversed(rows[start:before]))
    cursor = {"kind": "list", "before": start, "anchor": _digest(rows[start])} if start else None
    return items, len(rows), cursor


def history_page(slug: str, section: str, node: str = "", cursor: str = "", limit: int = 50, request: Request | None = None) -> dict[str, Any]:
    profile = (getattr(request.state, "profile_timing", None)
               if request is not None else None)
    if section not in SECTIONS:
        raise HTTPException(404, "Unknown history collection")
    field, _, needs_node = SECTIONS[section]
    limit = max(1, min(limit, 100))
    if not needs_node:
        node = ""
    state = _decode(cursor, section, node) if cursor else {}
    try:
        # Use the canonical loader first: backend mismatch/migration guards and
        # node validation apply equally to new pages and ordinary product reads.
        _lock_stage = time.perf_counter()
        with store.DOC_LOCK:
            if profile is not None:
                profile["lock_wait_ms"] = (time.perf_counter() - _lock_stage) * 1000.0
            _work_stage = time.perf_counter()
            org = store.load_org(slug)
            if profile is not None:
                profile["org_load_ms"] = (time.perf_counter() - _work_stage) * 1000.0
            _work_stage = time.perf_counter()
            if needs_node:
                org.node(node)
            if section == "chat":
                from . import supervisor
                _read_stage = time.perf_counter()
                messages = supervisor.read_chat(org, node, last=None, hold_back=False)["messages"]
                if profile is not None:
                    profile["chat_read_ms"] = (time.perf_counter() - _read_stage) * 1000.0
                items, total, nxt = _list_page(messages, state, limit)
            elif section == "turn-records":
                paths = turnread.list_records(store.DATA_ROOT, slug, node)
                names = [Path(p).name for p in paths]
                selected, total, nxt = _list_page(names, state, limit)
                by_name = {Path(p).name: p for p in paths}
                items = [{"file": name, **turnread.load(by_name[name])} for name in selected]
            elif section in ("turns", "oracle"):
                items, total, nxt = _list_page(org.node(node).get(field) or [], state, limit)
            elif store.STORE_BACKEND == "sqlite":
                with store._POOL.acquire(slug) as conn:
                    conn.execute("BEGIN")
                    try:
                        # Imported older documents may still hold a log as a
                        # doc blob. First normal save moves it into row storage.
                        blob = conn.execute("SELECT val FROM doc WHERE key=?", (field,)).fetchone()
                        if blob:
                            rows = json.loads(blob[0])
                            if needs_node:
                                rows = (rows or {}).get(node, [])
                            items, total, nxt = _list_page(rows or [], state, limit)
                        else:
                            table = "log_d" if needs_node else "log_l"
                            where = "sect=?" + (" AND owner=?" if needs_node else "")
                            args = (field, node) if needs_node else (field,)
                            if state:
                                anchor = conn.execute(f"SELECT val FROM {table} WHERE {where} AND seq=?",
                                                      (*args, state["before"])).fetchone()
                                if state.get("kind") != "sql" or not anchor or _digest(json.loads(anchor[0])) != state.get("anchor"):
                                    _expired()
                            total = conn.execute(f"SELECT count(*) FROM {table} WHERE {where}", args).fetchone()[0]
                            boundary = " AND seq<?" if state else ""
                            page_args = (*args, state["before"]) if state else args
                            rows = conn.execute(f"SELECT seq,val FROM {table} WHERE {where}{boundary} ORDER BY seq DESC LIMIT ?",
                                                (*page_args, limit + 1)).fetchall()
                            items = [json.loads(row[1]) for row in rows[:limit]]
                            nxt = ({"kind": "sql", "before": rows[limit - 1][0], "anchor": _digest(items[-1])}
                                   if len(rows) > limit else None)
                    finally:
                        conn.rollback()
            else:
                rows = org.d.get(field) or ([] if not needs_node else {})
                if needs_node:
                    rows = rows.get(node) or []
                items, total, nxt = _list_page(rows, state, limit)
            if profile is not None:
                profile["history_work_ms"] = (time.perf_counter() - _work_stage) * 1000.0
    except LedgerError as exc:
        raise HTTPException(404, str(exc)) from exc
    if nxt:
        nxt.update(section=section, node=node)
    return {"items": items, "total": total, "next_cursor": _encode(nxt) if nxt else None}


@router.get("/api/orgs/{slug}/history")
def history_sources(slug: str) -> dict[str, Any]:
    try:
        org = store.load_org(slug)
    except LedgerError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"collections": [{"id": key, "label": label, "needs_node": needs_node}
                            for key, (_, label, needs_node) in SECTIONS.items()],
            "nodes": [{"id": nid, "state": node.get("state"), "generation": node.get("generation", 0)}
                      for nid, node in org.nodes.items()]}


@router.get("/api/orgs/{slug}/history/{section}")
def history_entries(slug: str, section: str, request: Request, node: str = "", cursor: str = "", limit: int = 50) -> dict[str, Any]:
    return history_page(slug, section, node, cursor, limit, request=request)
