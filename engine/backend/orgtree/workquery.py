"""Bounded docket selection inside one committed PostgreSQL snapshot.

These are internal rows, not the public ledger wire view. Callers must apply
the existing projection and must fall back as a whole on CompatibilityRequired.
No mutable Org, source list or connection is retained here.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import logging
import math
import secrets

from . import workindex, workread

log = logging.getLogger(__name__)
MAX_PAGE = 100
CURSOR_SECONDS = 60
_CURSOR_KEY = secrets.token_bytes(32)
_ORDER = "coalesce(nullif(i.summary->>'docket_at',''),i.summary->>'updated_at','') COLLATE \"C\""
_UNSUPPORTED = """summary->'_query'->>'format' IS DISTINCT FROM 'orgtree.work-query/v1'
 OR summary->'_query'->>'legacy_identity' IS DISTINCT FROM 'false'
 OR summary->'_query'->>'order_supported' IS DISTINCT FROM 'true'"""


class CompatibilityRequired(RuntimeError):
    """Use the entire exact reader; never replace unavailable data with []."""


class CursorReset(ValueError):
    """The caller must restart archive paging from the first page."""


@dataclass(frozen=True)
class Row:
    summary: dict
    physical_archive: bool
    questions: list
    source_key: str
    body_sha256: bytes


def _row(values):
    summary, location, questions, source_key, digest = values
    return Row({k: v for k, v in summary.items() if k != '_query'},
               location == 'archive', questions or [], source_key, bytes(digest))


def _encode(payload):
    data = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()
    signature = hmac.digest(_CURSOR_KEY, data, 'sha256')
    return base64.urlsafe_b64encode(signature + data).decode().rstrip('=')


def _decode(token):
    try:
        if not isinstance(token, str) or not token or len(token) > 4096:
            raise ValueError('size')
        packed = base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_', validate=True)
        signature, data = packed[:32], packed[32:]
        if not hmac.compare_digest(signature, hmac.digest(_CURSOR_KEY, data, 'sha256')):
            raise ValueError('signature')
        return json.loads(data)
    except (ValueError, TypeError, UnicodeError) as exc:
        raise CursorReset('invalid archive cursor; restart paging') from exc


class Snapshot:
    """Caller owns an open REPEATABLE READ READ ONLY transaction throughout.

    Health, authority, selected summaries and exact bodies share that snapshot.
    A cursor binds org/viewer/catalog, page size and classification clock, and
    expires after 60 seconds. Restart/process changes fail closed with reset.
    """
    def __init__(self, raw, org_id: int, *, viewer: str, now_ts: float):
        if not isinstance(viewer, str) or not viewer:
            raise ValueError('viewer is required')
        if not math.isfinite(now_ts):
            raise ValueError('finite clock is required')
        if raw.execute('SHOW transaction_isolation').fetchone()[0] != 'repeatable read' or \
                raw.execute('SHOW transaction_read_only').fetchone()[0] != 'on':
            raise ValueError('docket query requires repeatable-read read-only transaction')
        self.raw, self.org_id, self.viewer, self.now = raw, int(org_id), viewer, now_ts
        self.schema = f'org_{self.org_id}'
        if not workindex.ready(raw, org_id) or not workread._installed(raw, self.schema):
            raise CompatibilityRequired('docket index unavailable')
        state = raw.execute(f"SELECT revision FROM {self.schema}.work_read_state WHERE singleton "
            f"AND ready AND initialized AND NOT questions_dirty AND format='orgtree.work-access/v1' "
            f"AND NOT EXISTS(SELECT 1 FROM {self.schema}.work_read_dirty)").fetchone()
        if not state:
            raise CompatibilityRequired('docket access metadata unavailable')
        # Partial index contains only unsupported rows, not all historical names.
        if raw.execute(f'SELECT 1 FROM {self.schema}.work_index WHERE {_UNSUPPORTED} LIMIT 1').fetchone():
            raise CompatibilityRequired('docket identity/order metadata requires exact reader')
        revision = raw.execute(f'SELECT revision FROM {self.schema}.work_index_state WHERE singleton').fetchone()[0]
        self.catalog = [int(revision), int(state[0])]

    def _select(self):
        s = self.schema
        return f"""SELECT i.summary,i.location,q.questions,i.source_key,i.body_sha256
          FROM {s}.work_index i JOIN {s}.work_read_access a ON a.slug=i.slug AND a.viewer=%s
          LEFT JOIN {s}.work_read_questions q ON q.slug=i.slug"""

    def lookup(self, slug: str) -> Row | None:
        """Exact slug first, including names shaped like retired opaque IDs.

        Missing and unreadable references are deliberately indistinguishable.
        This does not call or replace Org._work_find, which returns mutable rows.
        """
        row = self.raw.execute(self._select() + ' WHERE i.slug=%s', (self.viewer, slug)).fetchone()
        return None if row is None else _row(row)

    def lookup_many(self, slugs: list[str]) -> list[Row]:
        """Bounded exact identities from visible prose; never a history search."""
        if len(slugs) > 128 or any(not isinstance(s, str) or not s or len(s) > 256 for s in slugs):
            raise ValueError('reference lookup requires at most 128 names of 1..256 characters')
        if not slugs:
            return []
        return [_row(row) for row in self.raw.execute(
            self._select() + ' WHERE i.slug=ANY(%s)', (self.viewer, slugs))]

    def detail(self, slug: str) -> tuple[dict, bool] | None:
        """Decode precisely one authorized body, regardless of archive size."""
        row = self.lookup(slug)
        if row is None:
            return None
        if row.physical_archive:
            found = self.raw.execute(f"SELECT val FROM {self.schema}.log_l WHERE sect='work_items_archive' AND seq=%s",
                                     (int(row.source_key),)).fetchone()
        else:
            found = self.raw.execute(f'SELECT val FROM {self.schema}.doc WHERE key=%s', (row.source_key,)).fetchone()
        if found is None or hashlib.sha256(found[0].encode()).digest() != row.body_sha256:
            log.error('Docket exact-body/index mismatch for org %s; use exact reader', self.org_id)
            raise CompatibilityRequired('docket body/index mismatch')
        body = json.loads(found[0])
        if body.get('slug') != slug:
            raise CompatibilityRequired('docket body identity mismatch')
        return body, row.physical_archive

    def foreground(self, *, include_backlogged: bool = False) -> list[Row]:
        s = self.schema
        candidates = f"""WITH candidates AS (
          SELECT slug FROM {s}.work_read_policy WHERE location='active' AND deadline IS NULL
          UNION SELECT slug FROM {s}.work_read_policy WHERE location='active' AND deadline >= %s
          UNION SELECT slug FROM {s}.work_read_policy WHERE manual
          UNION SELECT slug FROM {s}.work_read_questions) """
        query = candidates + self._select() + f' JOIN candidates c ON c.slug=i.slug ORDER BY {_ORDER} DESC,i.slug COLLATE "C" DESC'
        policy = workread._Policy(None)
        result = []
        for values in self.raw.execute(query, (self.now, self.viewer)):
            row = _row(values)
            policy.questions = {row.summary['slug']: row.questions}
            if policy._work_archived(row.summary, row.physical_archive, self.now):
                continue
            if not include_backlogged and policy._work_backlogged(row.summary):
                continue
            result.append(row)
        return result

    def archive(self, *, limit: int = 50, cursor: str = '') -> tuple[list[Row], str | None]:
        if type(limit) is not int or not 1 <= limit <= MAX_PAGE:
            raise ValueError(f'archive limit must be 1..{MAX_PAGE}')
        clock, after = self.now, None
        if cursor:
            value = _decode(cursor)
            if not isinstance(value, dict) or value.get('binding') != [self.org_id, self.viewer, self.catalog, limit]:
                raise CursorReset('archive catalog or viewer changed; restart paging')
            clock, after = value.get('clock'), value.get('after')
            if type(clock) not in (int, float) or not math.isfinite(clock) or not 0 <= self.now-clock <= CURSOR_SECONDS:
                raise CursorReset('archive cursor expired; restart paging')
            if not isinstance(after, list) or len(after) != 2 or any(not isinstance(v, str) for v in after):
                raise CursorReset('invalid archive position; restart paging')
        # Projection of later pages must use the same classification clock as
        # selection, including a closed row crossing the grace-period edge.
        self.now = clock
        # These hints are maintained by the exact ledger predicates. Attention
        # always wins over location/age. Strict deadline preserves the 1h edge.
        query = self._select() + f" JOIN {self.schema}.work_read_policy p ON p.slug=i.slug WHERE NOT p.manual AND q.slug IS NULL AND (p.location='archive' OR p.deadline < %s)"
        args = [self.viewer, clock]
        if after is not None:
            query += f' AND ({_ORDER},i.slug COLLATE "C") < (%s COLLATE "C",%s COLLATE "C")'
            args.extend(after)
        query += f' ORDER BY {_ORDER} DESC,i.slug COLLATE "C" DESC LIMIT %s'
        args.append(limit+1)
        rows = [_row(values) for values in self.raw.execute(query, args)]
        more = len(rows) > limit
        rows = rows[:limit]
        token = None
        if more:
            last = rows[-1].summary
            token = _encode(dict(binding=[self.org_id, self.viewer, self.catalog, limit], clock=clock,
                after=[last.get('docket_at') or last.get('updated_at') or '', last['slug']]))
        return rows, token
