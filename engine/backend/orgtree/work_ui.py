"""Desktop docket transport: light rows, content validators and bounded deltas.

The legacy work-list/get contract remains full. Only the desktop list opts in;
an opened item uses work_get. Cache entries never retain evidence/history bodies.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import weakref
from collections import OrderedDict
from typing import Any

from . import refs, store
from .ledger import USER, LedgerError

# Every field consumed by list rows, search, grouping, references and Attention.
# Full descriptions/progress are searchable; authored history is detail-only.
FIELDS = frozenset("""slug ref rev kind title objective status owner reviewer
created_by at updated_at done_so_far working_on_next docket_at last_updater
manual_attention next_action objective_notice post_completion status_at
superseded_by parent parent_visible legacy_status blocked_reason waiting_reason
dropped_reason participants reply_recipients archived archived_at owner_current
owner_state questions superseded_by_visible effective_attention attention_sources
dependencies scope_archive_summary""".split())
GROUPS = ("items", "archived", "backlogged", "attention")
MAX_ORGS = 8
MAX_VERSIONS = 3
MAX_BYTES = 32 * 1024 * 1024
IDLE_S = 60.0
_lock = threading.RLock()
_cache: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
_sweeper: threading.Timer | None = None
_build_locks: weakref.WeakValueDictionary = weakref.WeakValueDictionary()


class IdentityMigrationRequired(LedgerError):
    pass


def _sweep() -> None:
    global _sweeper
    with _lock:
        now = time.monotonic()
        for key, entry in list(_cache.items()):
            if now - entry["used"] >= IDLE_S:
                del _cache[key]
        _sweeper = None
        if _cache:
            _arm_sweep()


def _arm_sweep() -> None:
    global _sweeper
    if _sweeper is None:
        _sweeper = threading.Timer(IDLE_S, _sweep)
        _sweeper.daemon = True
        _sweeper.start()


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      sort_keys=True).encode("utf-8")


def _hash(value: Any) -> str:
    return hashlib.sha256(_json(value)).hexdigest()[:32]


def _dependencies(conn: Any) -> list[Any]:
    """Committed fields only; status text, transcripts and mail are not inputs.

    Node parent participates in the deploy recipient; state/incarnation in the
    owner/reviewer projection. Reading these rows also catches external commits
    before the change-feed invalidates a resident Org.
    """
    docs = conn.execute("SELECT key,val FROM doc WHERE key IN "
                        "('asks','work_identity','nodes','release') ORDER BY key").fetchall()
    if hasattr(conn, "raw"):
        # The compatibility json_extract parses the entire node once per
        # requested field. PG's record projection parses it once and returns
        # only these four fields, not charters/status/transcript metadata.
        nodes = conn.raw.execute(
            f"SELECT id,json_build_array(n.state,n.generation,n.seat_id,n.parent)::text "
            f"FROM org_{int(conn.org_id)}.nodes CROSS JOIN LATERAL "
            "json_to_record(val::json) AS n(state json,generation json,seat_id json,parent json) "
            "ORDER BY id").fetchall()
    else:
        nodes = conn.execute(
            "SELECT id,json_extract(val,'$.state','$.generation','$.seat_id','$.parent') "
            "FROM nodes ORDER BY id").fetchall()
    return [list(map(list, docs)), list(map(list, nodes))]


def stamp(slug: str) -> str:
    """Use PG's committed docket revision; legacy stores hash docket sections.

    The fallback is deliberately read-only. It costs a scan on SQLite/JSON but
    preserves the same content semantics without changing their fence settings.
    """
    reader = getattr(store, "read_work_items_rows", None)
    header = reader(slug, []) if reader else None

    def read(conn: Any) -> Any:
        deps = _dependencies(conn)
        if header is not None and "work_revision" in header:
            return [getattr(conn, "org_id", None), header["work_revision"], deps]
        docs = conn.execute("SELECT key,val FROM doc WHERE key IN "
                            "('work_items','work_items_archive','work_scope_log') "
                            "ORDER BY key").fetchall()
        logs = conn.execute("SELECT sect,seq,val FROM log_l WHERE sect IN "
                            "('work_items_archive','work_scope_log') ORDER BY sect,seq").fetchall()
        return [list(map(list, docs)), list(map(list, logs)), deps]

    value = store._bounded_read(slug, read)
    if value is None:
        org = store.load_org(slug)
        value = [{k: org.d.get(k) for k in
                  ("work_items", "work_items_archive", "work_scope_log", "asks",
                   "work_identity", "release")},
                 [(nid, *(node.get(k) for k in ("state", "generation", "seat_id", "parent")))
                  for nid, node in sorted(org.nodes.items())]]
    # The clock can archive an item without a save. Content tokens below remain
    # stable when a clock check finds no actual change.
    return _hash([value, int(time.time() // 30)])


def project(payload: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"counts": payload["counts"], "now": payload["now"]}
    refs: list[dict[str, Any]] = []
    attention: list[dict[str, Any]] = []
    for group in GROUPS[:3]:
        rows = []
        for full in payload.get(group, []):
            row = {k: v for k, v in full.items() if k in FIELDS}
            row["view"] = "list"
            row["view_revision"] = _hash(row)
            rows.append(row)
            refs.append({k: row.get(k) for k in
                         ("slug", "title", "parent", "archived", "status", "rev", "view_revision")})
            if row.get("manual_attention"):
                attention.append(row)
        out[group] = rows
    out["references"] = refs
    out["attention"] = attention
    return out


def _build(slug: str) -> dict[str, Any]:
    org = store.load_org(slug)
    if org.work_identity_state() != "slug":
        raise IdentityMigrationRequired("work identity migration required")
    payload = org.work_list(USER, include_archived=True, include_backlogged=True)
    for group in GROUPS[:3]:
        for item in payload.get(group, []):
            item["ref"] = refs.item(slug, item["slug"])
    return project(payload)


def _selected(all_rows: dict[str, Any], archived: bool, backlogged: bool) -> dict[str, Any]:
    return {k: v for k, v in all_rows.items()
            if (k != "archived" or archived) and (k != "backlogged" or backlogged)}


def delta(old: dict[str, Any], new: dict[str, Any], base: str) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    for group in GROUPS:
        if group not in new:
            continue
        before = {row["slug"]: row for row in old.get(group, [])}
        after = new[group]
        changes[group] = {
            "order": [row["slug"] for row in after],
            "upsert": [row for row in after if before.get(row["slug"]) != row],
        }
    return {"base": base, "revision": new["revision"], "delta": changes,
            **{k: v for k, v in new.items() if k not in GROUPS and k != "revision"
               and (k != "references" or old.get(k) != v)}}


def read(slug: str, archived: bool = False, backlogged: bool = False,
         since: str = "") -> tuple[str, dict[str, Any] | None]:
    """None is a 304. Unknown/evicted bases receive a complete *light* snapshot.

    Input stamp is captured BEFORE the committed build. A concurrent write can
    cause an extra rebuild, never stamp an old body with a newer revision.
    """
    key = (str(store.DATA_ROOT), slug)
    with _lock:
        build_lock = _build_locks.setdefault(key, threading.RLock())
    # Coalesce only this org's builders. Never hold the global cache mutex
    # across database reads or serialize another org behind a large docket.
    with build_lock:
        now = time.monotonic()
        with _lock:
            entry = _cache.get(key)
            if entry and now - entry["used"] > IDLE_S:
                entry = None
        current = stamp(slug)
        if entry is None or entry["stamp"] != current:
            body = _build(slug)
            encoded = _json({k: v for k, v in body.items() if k != "now"})
            token = hashlib.sha256(encoded).hexdigest()[:32]
            versions = entry["versions"] if entry else OrderedDict()
            sizes = entry["sizes"] if entry else {}
            # Keep the earlier object's time when only unrelated inputs moved.
            if token not in versions:
                versions[token] = {**body, "revision": token}
                sizes[token] = len(encoded)
            while len(versions) > MAX_VERSIONS:
                removed, _ = versions.popitem(last=False)
                sizes.pop(removed)
            entry = {"stamp": current, "token": token, "versions": versions,
                     "sizes": sizes, "used": now, "bytes": sum(sizes.values())}
        entry["used"] = now
        with _lock:
            _cache[key] = entry
            _cache.move_to_end(key)
            while len(_cache) > MAX_ORGS or sum(e["bytes"] for e in _cache.values()) > MAX_BYTES:
                _cache.popitem(last=False)
            if _cache:
                _arm_sweep()
        flags = ("a" if archived else "n") + ("b" if backlogged else "n")
        token = entry["token"] + flags
        if since == token:
            return token, None
        body = {**_selected(entry["versions"][entry["token"]], archived, backlogged),
                "revision": token}
        old = entry["versions"].get(since[:-2]) if since.endswith(flags) else None
        if old is not None:
            return token, delta(_selected(old, archived, backlogged), body, since)
        return token, body
