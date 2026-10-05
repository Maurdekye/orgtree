"""Incremental chat responses, fenced by conversation and ordering identity.

The ordinary tail remains the source of current runtime and pending-mail fields.
Only a burst beyond that tail needs older pages, stopping at the caller's indexed
ordering anchor. No inactive history is read to establish whether a cursor exists.
"""
import base64
import json
import math
import hashlib


def _scope(out, owner):
    return [owner, out.get('conversation_id'), out.get('assistant_scope'),
            out.get('order_epoch', 0)]


def _identity(row):
    return row.get('row_id') or row.get('event_id')


def _assistant_hash(rows):
    # Assistant rows can acquire a new revision without becoming a new message.
    # A fixed-size fingerprint keeps the cursor bounded even after scrollback.
    values = [[_identity(row), row.get('assistant_revision'), row.get('assistant_pending')]
              for row in rows if row.get('assistant_id')]
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


def prepare(out, after, owner, read_page, valid_anchor):
    """Expand only the new interval, before pending-mail evidence is computed.

Return the inclusive old boundary, or None for a full baseline. A missing or
replaced anchor explicitly resets the client; malformed cursors are rejected.
"""
    if not after:
        return out, None
    if not isinstance(after, str) or len(after) > 8192:
        raise ValueError('Invalid transcript after cursor')
    try:
        value = json.loads(base64.b64decode(after, altchars=b'-_', validate=True))
        scope, identity, rank = value['scope'], value['id'], value['seq']
        if not isinstance(identity, str) or not identity or type(rank) not in (int, float) or not math.isfinite(rank):
            raise ValueError('Invalid anchor')
    except (ValueError, TypeError, KeyError, UnicodeError) as error:
        raise ValueError('Invalid transcript after cursor') from error
    if scope != _scope(out, owner) or not valid_anchor(identity, rank, out.get('order_epoch', 0)):
        return dict(out, after_reset=True), None
    rows = list(out.get('messages') or [])
    cursor, visited = out.get('before'), set()
    while cursor and rows and rows[0].get('seq', rank) > rank:
        if cursor in visited:
            raise ValueError('Transcript cursor did not advance')
        visited.add(cursor)
        page = read_page(cursor)
        if page.get('order_epoch', 0) != out.get('order_epoch', 0):
            raise ValueError('Transcript order changed during incremental read')
        held = {_identity(row) for row in rows}
        older = [row for row in page.get('messages', []) if _identity(row) not in held]
        if not older or older[0].get('seq', rank) >= rows[0].get('seq', rank):
            raise ValueError('Transcript cursor did not advance')
        rows = older + rows
        cursor = page.get('before')
    updates = [row for row in rows if row.get('assistant_id') and row.get('seq', rank) <= rank]
    changed = _assistant_hash(updates) != value.get('assistants')
    return dict(out, messages=rows, incremental=True,
                message_updates=updates if changed else []), rank


def finish(out, boundary, owner):
    """Stamp the last held message and send only messages after the boundary."""
    rows = out.get('messages') or []
    if rows:
        row = rows[-1]
        rank, identity = row.get('seq'), _identity(row)
        if identity and type(rank) in (int, float) and math.isfinite(rank):
            value = {'scope': _scope(out, owner), 'id': identity, 'seq': rank,
                     'assistants': _assistant_hash(rows)}
            out['after'] = base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode()
    if boundary is not None:
        out['messages'] = [row for row in rows if row.get('seq', boundary) > boundary]
    return out
