"""Engine-local MCP credentials; the signing key never enters child environments."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from typing import Any

_key: bytes | None = None


def enable() -> None:
    global _key
    _key = secrets.token_bytes(32)


def child_env(slug: str, nid: str, *, generation: int | None = None,
              seat_id: str | None = None) -> dict[str, str]:
    """Sign `[slug, nid, generation, seat_id]` (P04a-2). The seat is the
    principal: a same-name successor on a freed key gets a new `seat_id`, so a
    deleted seat's token can never be byte-identical to its namesake's. The
    key stays in the payload because lineage predecessors (`nid@g`) share the
    live seat's `seat_id`."""
    if _key is None:
        return {}
    # Callers holding an Org snapshot already know its generation and seat.
    # Reusing them avoids reloading the whole organization once per forecasted
    # agent. The HTTP authorization path still validates both against live state.
    if generation is None or seat_id is None:
        from . import orgtx, store
        # PG-3r: a caller still inside a legacy DOC_LOCK hold may have changed
        # this node (a new generation) without saving yet; only the resident
        # document it holds shows that, so keep the old read there. Everyone
        # else reads the committed row lock-free. A caller inside an org_tx
        # must pass generation and seat_id: org_read cannot see its changes.
        if getattr(store.DOC_LOCK, "_is_owned", lambda: False)():
            node = store.load_org(slug).node(nid)
        else:
            # scale (hot-paths-off-full-org-reads): ONE committed node row,
            # not a whole-org snapshot per spawn (~0.4 s each at N=100). The
            # same lock-free committed read as org_read. Fall back to it when
            # the row cannot answer: no cheap row read (JSON store, `nodes`
            # stored as a blob), an unknown node (org_read raises the error
            # callers already see), or a stored row with no `seat_id` (a
            # pre-P04a document; `Org.__init__` backfills it from lineage).
            row = store.read_node(slug, nid)
            node = (row if row is not None and row.get('seat_id')
                    else orgtx.org_read(slug).node(nid))
        if generation is None:
            generation = int(node.get('generation', 0))
        if seat_id is None:
            seat_id = str(node.get('seat_id') or '')
    if type(generation) is not int or generation < 0:
        raise ValueError('Invalid agent generation')
    if type(seat_id) is not str or not seat_id:
        raise ValueError('Invalid agent seat')
    payload = json.dumps([slug, nid, generation, seat_id], separators=(',', ':')).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip('=')
    signature = hmac.new(_key, encoded.encode(), hashlib.sha256).hexdigest()
    return {'ORGTREE_AGENT_TOKEN': encoded + '.' + signature}


def node_env(slug: str, nid: str, node: dict[str, Any]) -> dict[str, str]:
    """`child_env` for a caller already holding the node's record."""
    return child_env(slug, nid, generation=int(node.get('generation', 0)),
                     seat_id=str(node.get('seat_id') or ''))


def verify(token: str) -> tuple[str, str, int, str] | None:
    if not _key or not token:
        return None
    try:
        encoded, signature = token.split('.', 1)
        expected = hmac.new(_key, encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        slug, nid, generation, seat_id = json.loads(base64.urlsafe_b64decode(
            encoded + '=' * (-len(encoded) % 4)))
        if not isinstance(slug, str) or not isinstance(nid, str) or type(generation) is not int:
            return None
        if not isinstance(seat_id, str) or not seat_id:
            return None
        return slug, nid, generation, seat_id
    except (ValueError, TypeError):
        return None
