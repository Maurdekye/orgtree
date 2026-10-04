"""Independent destination verifier for the one-database-per-org conversion. READS ONLY.

Design docs/state-system/pg-data-model-design.md §5.4 check 1 (finding f16): a separate verifier
reads the new org database's relational values with plain SELECTs and compares them, entity by
entity, with values it derives itself from the source document, so a mapper error that is
consistent in both directions cannot verify itself.

INDEPENDENCE. This module imports nothing from ``orgtree`` at all (only the standard library and
psycopg), and in particular nothing from ``orgtree.orgdb`` or the converter;
tests/test_orgdb_verify_static.py enforces that by a source scan. Its field correspondence below
was written from the design (§3.0 conventions, Appendix A), the destination schema
(pg_migrations/org/0001_core.sql, 0002_document.sql, information_schema), the field profiles of
the real documents and the engine code that writes the legacy records.

    verify(source_doc, dest_conninfo) -> list of problems (empty = verified)
    verify_report(...)                -> {'problems', 'notes', 'stats'}: stats count what was
                                         compared (records, typed values, nulls, values held
                                         in extra, links, tool lists), so a pass is not vacuous
    manifest([path, ...])             -> {file: sha256} for the legacy-files-unchanged check
    manifest_changes(before, after)   -> each path added, removed or changed

    python tools/orgdb_verify.py --source <doc.json> --dest <conninfo> [--json-output out.json]
    python tools/orgdb_verify.py --manifest <path> [<path> ...] [--json-output out.json]
    python tools/orgdb_verify.py --compare-manifests <before.json> <after.json>

``source_doc`` is the org document as today's loader gives it: plain JSON, a dict of top-level
sections. The CLI prints counts only (no values, no names) unless --show-values is given.
Exit 0 = verified, 1 = problems, 2 = could not run.

THE DESTINATION FORMAT, as this verifier reads it
-------------------------------------------------
* Every top-level key except the ignored ones has an ``org_sections`` row: its document order
  (``ord``) and ``state`` 'n' (null) or 'v'. A null collection is state 'n' with no rows; a null
  setting may also be state 'v' with the null kept in ``org_settings``.
* A scalar field is a typed column named as the legacy key (renames are explicit below). A
  present null is ``<col>_null = true``; absent is every column NULL. A timestamp is a
  ``timestamptz`` compared as an INSTANT; when the source text is not the canonical
  ``YYYY-MM-DDTHH:MM:SS.mmmZ`` the original text must be in ``<col>_text``. ``numeric`` keeps
  int versus float by its scale (``5`` versus ``5.0``). JSON columns are compared as JSON with
  exact types (int, float and bool are different values); object key order is not compared.
* A nested object is flattened into ``<prefix>_<field>`` columns with a code ``<prefix>_is``; a
  list is a child table (positions 0..n-1) with a code ``<field>_is``. Codes: 'o' object,
  'l' list, 'n' null, 'x' the value is in ``extra``, NULL absent.
* ``extra`` (one JSON object per row) keeps exactly what no typed column can hold: a value of
  another type, a string with U+0000, an unparseable or offset-less timestamp, a null where the
  column has no null flag, an unknown field, or an out-of-set enum member. Nested parts nest: an unknown ``scope.tools`` key
  is ``extra.scope.tools.<key>``. A field must be in exactly one place: never in both its column
  and ``extra``, never in neither, and a value its column CAN hold exactly must be in the column.
* Links resolve to natural keys: ``agents.parent_id``/``predecessor_id``/``successor_id`` point
  at the row whose ``name`` is the node's ``parent``/``predecessor``/``successor``; a name that is
  no node is a tombstone row (``tombstone``, no data). Per-agent rows' ``agent_id`` is the agent
  whose name keyed the source dict. ``tool_list_id`` names a ``tool_lists`` row whose items are
  the node's ``last_turn_mcp_tools``. Docket links (parent, superseded_by, dependencies) are slugs.
* Current item owners/reviewers/holders, review seats and artifact recipients resolve separately
  by birth stamp, otherwise directional generation. A replaced/deleted identity has a stamped
  tombstone. Historical actors stay authored values and acquire no current-agent link.
* Recent turns and turn_log share one payload only for exact ordered matches. Recent positions
  may have gaps; log-only and recent-only rows remain distinct memberships. Both ordered text
  child lists of a turn, and the fixed model-usage fields, are compared independently.
* Integer estimates and compensated float estimates retain their type and each component.
  Docket policy/list/scope projections are deliberate copies, explicitly derived from the
  legacy source and compared; changing a source column and its copy together does not pass.
* The presence flags (``is_frozen``, ``is_halted``, ``is_inflight``, ``is_remote_controlled``,
  ``has_pending_switch``) answer what the engine asks of the payload: ``bool(node.get(x))``.

WHAT IT DOES NOT COVER: rows outside the document (org_identity, org_revision, conversion_runs,
schema_migrations, side-file and account tables: listed as notes when present); the
tool_lists.sha256 value itself (its items are compared); row_version; the generated anchor_name;
key order INSIDE JSON objects and inside records (the top-level, per-agent and dict-of-records
orders are compared).
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import datetime as _dt
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable

SCHEMA = 'orgtree'
#: The removed features' top-level keys, which the converter must NOT carry (decision 17 and the
#: per-org sandbox removal): the engine's IGNORED_LEGACY_KEYS minus KEPT_LEGACY.
IGNORED_DEFAULT = ('kiosk', 'spend_frozen', 'sandbox_vols_base', 'disk', 'storage_blocked',
                   'storage_warned', 'storage_full', 'storage_frozen',
                   'bridge_credential_generation', 'bridge_credential_rotated_at')
#: A removed feature's key the converter still carries exactly, as an org setting (design rev
#: 7.2): the former-sandbox credential catch-up reads it after the upgrade.
KEPT_LEGACY = ('sandbox',)

TEXT, INT, FLOAT, NUM, BOOL, TS, JSON, CHAR = 'text', 'int', 'float', 'num', 'bool', 'ts', 'json', 'char'
SQL_TYPES = {TEXT: {'text'}, INT: {'bigint', 'integer'}, FLOAT: {'double precision'},
             NUM: {'numeric'}, BOOL: {'boolean'}, TS: {'timestamp with time zone'},
             JSON: {'json', 'jsonb'}, CHAR: {'character'}}

# Independently read from the engine's validation/writer contracts, as recorded in
# docs/state-system/org-enum-inventory.md. Never import the converter's declarations.
PERMISSION = ('plan', 'default', 'acceptEdits', 'bypassPermissions')  # ledger.PM_LEVELS
VISIBILITY = ('self', 'team', 'subtree', 'full')  # ledger.VIS_LEVELS
EFFORT = ('low', 'medium', 'high', 'xhigh', 'max', '')  # set_scope permits empty to clear
DIR_MODE = ('rw', 'ro')  # schema.DirMode / Org._dirs
WORK_STATUS = ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved',
               'deploy_ready', 'done', 'superseded', 'dropped')  # Org.WORK_STATUSES
CLASSIFICATION = ('met', 'not_exercised', 'environment_limited', 'known_negative')
EXECUTION = ('independent', 'owner_report', 'source_inspection')
RESULT = ('passed', 'expected_negative', 'failed', 'crashed', 'not_executed')  # workevidence
DISPOSITION = ('open', 'fixed', 'rejected', 'deferred', 'duplicate')  # Org.WORK_DISPOSITIONS
STAGE = ('implemented', 'committed', 'pushed', 'deployed', 'in_build')  # workitems.STAGES
MAIL_KIND = ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog')
SEQ_ORIGIN = ('deposit', 'migration_unproven', 'unresolved_mailbox')  # Org.MAIL_SEQ_ORIGIN_*
WATCHDOG_KIND = ('file', 'command', 'process', 'stream', 'activity')  # watchdog_create
MARKER_VALUES = {'obj': ('n', 'o', 'x'), 'list': ('n', 'l', 'x')}  # destination format above


# ------------------------------------------------------------------ the field correspondence
class Col:
    """A scalar field in one typed column (``col`` when it is renamed)."""
    def __init__(self, src: str, kind: str, col: str | None = None, table: str | None = None,
                 *, values: tuple[str, ...] = ()):
        self.src, self.kind, self.col, self.table = src, kind, col or src, table
        if not isinstance(values, tuple) or (values and (kind != TEXT
                or any(not isinstance(v, str) or '\x00' in v for v in values)
                or len(set(values)) != len(values))):
            raise ValueError('enum values must be distinct text members')
        self.values = values


class Obj:
    """A nested object flattened into ``<prefix>_*`` columns plus the code ``<prefix>_is``."""
    def __init__(self, src: str, fields: list, table: str | None = None,
                 *, col: str | None = None):
        self.src, self.fields, self.table, self.col = src, fields, table, col or src


class Principal:
    """A recorded actor: absent, null, bare name, object or an exceptional value.

    Aliases name existing event query headers, without importing a codec.
    """
    def __init__(self, src: str, *, aliases: dict | None = None):
        self.src, self.table, self.aliases = src, None, aliases or {}


class SumState:
    """An integer sum or a float sum with its separate compensation term."""
    def __init__(self, src: str):
        self.src, self.table = src, None


class TurnUsage(Obj):
    """The fixed usage object, including the supported older bare keys list."""
    def __init__(self):
        super().__init__('model_usage_key', [Col('asked', TEXT), Col('matched', BOOL),
            Lst('keys', 'agent_turn_model_usage_keys', ('turn_id',), TEXT)], col='model_usage')


class Lst:
    """A list in a child table ``table`` (keyed by ``fk`` = the parent's key, positioned by
    ``pos``), with the code ``<src>_is`` in the parent row. ``elem`` is a scalar kind (column
    ``value``) or a Rec."""
    def __init__(self, src: str, table: str, fk: tuple, elem: Any, pos: str = 'pos',
                 table_of_code: str | None = None, *, gaps: bool = False):
        self.src, self.ctable, self.fk, self.elem, self.pos = src, table, fk, elem, pos
        self.table = table_of_code
        self.gaps = gaps


class Rec:
    """A record shape; ``key`` are the columns of its row that its own child tables reference."""
    def __init__(self, fields: list, key: tuple = ('id',)):
        self.fields, self.key = fields, key


class Link:
    """An agent name stored as the link ``<src>_id`` (text column ``<src>`` + ``<src>_null``)."""
    def __init__(self, src: str):
        self.src, self.table = src, None


class ToolList:
    """``last_turn_mcp_tools``: ``tool_list_id`` -> tool_lists / tool_list_items."""
    def __init__(self, src: str):
        self.src, self.table = src, None


def _by(src: str = 'by') -> Obj:
    return Obj(src, [Col('node', TEXT), Col('generation', INT)])


def _holder(src: str) -> Obj:
    return Obj(src, [Col('node', TEXT), Col('generation', INT), Col('born', TEXT)])


def _status(src: str) -> Obj:
    return Obj(src, [Col('status', TEXT, values=('working', 'blocked', 'idle')),
                     Col('summary', TEXT), Col('at', TS)])


def _texts(*names: str) -> list:
    return [Col(n, TEXT) for n in names]


def _ints(*names: str) -> list:
    return [Col(n, INT) for n in names]


def _bools(*names: str) -> list:
    return [Col(n, BOOL) for n in names]


def _stamps(*names: str) -> list:
    return [Col(n, TS) for n in names]


def _jsons(*names: str, table: str | None = None) -> list:
    return [Col(n, JSON, table=table) for n in names]


TURN = [Col('n', INT), Col('at', TS), Col('cost', FLOAT), Col('ms', INT), Col('toks', INT),
        Col('denials', INT), Col('approvals', INT), Col('ran_as', TEXT), Col('killed', BOOL),
        Col('estimated', BOOL), Col('cost_complete', BOOL), Col('cost_source', TEXT),
        Lst('cost_unknown_fields', 'agent_turn_cost_unknown_fields', ('turn_id',), TEXT),
        *_jsons('route', 'reported'), TurnUsage()]
PROMPT = _texts('tool', 'arg', 'cwd')
CARRIER = [Col('_halt_id', TEXT, col='halt_id'), Col('text', TEXT), Col('view', TEXT),
           Col('ping', BOOL), Col('ping_reason', TEXT), Col('from', TEXT, col='from_node'),
           Col('at', FLOAT), Col('delivery_id', TEXT),
           Lst('toks', 'agent_carrier_tokens', ('agent_id', 'pos'), TEXT, pos='pos_2'),
           Lst('mail_ids', 'agent_carrier_mail', ('agent_id', 'pos'), TEXT, pos='pos_2'),
           Col('claim', JSON)]
RUNTIME_PAYLOADS = ('frozen', 'halt', 'inflight', 'turn_ended', 'pending_switch',
                    'remote_controlled', 'admit_once', 'unstuck', 'last_wall', 'cache_continuity',
                    'envelope', 'codex_route_last', 'codex_usage_total', 'codex_usage_reset',
                    'desktop_import')
#: presence flag -> the payload it answers for (A.7 point 1)
PRESENCE = {'is_frozen': 'frozen', 'is_halted': 'halt', 'is_inflight': 'inflight',
            'is_remote_controlled': 'remote_controlled', 'has_pending_switch': 'pending_switch'}

NODE = [
    Col('seat_id', TEXT, col='lineage_born'), Col('generation', INT),
    Link('parent'), Link('predecessor'), Link('successor'),
    Col('ui_order', NUM), *_stamps('created', 'archived_at', 'rescinded_at'),
    Col('state', TEXT, values=('live', 'archived', 'unrecoverable', 'deleted')),
    *_texts('title', 'model'), Col('grant', NUM, col='credit_grant'),
    *_texts('lineage'),
    Col('bearer_state', TEXT, values=('knowledge', 'preserving', 'lost')),
    *_texts('lost_reason', 'session_id', 'transcript_incarnation', 'reply_incarnation'),
    Col('pid', INT), Col('session_began_at', TS),
    *_bools('session_unrun', 'cheap_compacted', 'compacted_unrun'),
    Col('account', TEXT), Col('account_primary', BOOL),
    *_texts('codex_account', 'codex_thread', 'codex_native_home', 'antigravity_account',
            'antigravity_conversation', 'mailbox_id'),
    Col('mail_seq', INT),
    Obj('scope', [Col('permission_mode', TEXT, values=PERMISSION),
                  Col('org_visibility', TEXT, values=VISIBILITY),
                  Col('effort', TEXT, values=EFFORT),
                  *_texts('model_version'),
                  *_bools('prefer_reserve', 'account_fallback'),
                  Obj('tools', [*_bools('bash', 'web', 'edit', 'subagents'),
                                Lst('mcp', 'agent_mcp_servers', ('agent_id',), TEXT)]),
                  Lst('add_dirs', 'agent_dir_grants', ('agent_id',),
                      Rec([Col('path', TEXT), Col('mode', TEXT, values=DIR_MODE)], key=('agent_id', 'pos')))]),
    Col('cost_usd', NUM), Col('cost_usd_unknown', BOOL), Col('context_window', INT),
    Col('occupancy', INT), Col('occupancy_est', BOOL),
    *_ints('cli_compactions', 'cli_boundary_offset', 'turn_seq'),
    SumState('turn_est_cost'), SumState('turn_est_toks'),
    _status('last_status'), _status('prev_status'),
    Col('limit_locked', BOOL),
    *_ints('config_seq', 'hard_fail_run', 'limit_run', 'net_fail_run'), Col('net_fail_since', TS),
    Col('untrusted_limit_run', INT),
    *_stamps('docket_reminder_at', 'working_activity_at', 'cache_keepalive_at'),
    Col('last_turn_mcp_tool_count', INT), Col('last_turn_mcp_fingerprint', TEXT),
    ToolList('last_turn_mcp_tools'),
    Lst('last_denials', 'agent_tool_denials', ('agent_id',), Rec(PROMPT, key=('agent_id', 'pos'))),
    Lst('last_approvals', 'agent_tool_approvals', ('agent_id',),
        Rec(PROMPT, key=('agent_id', 'pos'))),
    Lst('turns', 'agent_turns', ('agent_id',), Rec(TURN), pos='recent_pos', gaps=True),
    Lst('halt_queue', 'agent_carriers', ('agent_id',), Rec(CARRIER, key=('agent_id', 'pos'))),
    # the one-to-one cold tables
    Col('charter', TEXT, table='agent_texts'), Col('team_charter', TEXT, table='agent_texts'),
    *_jsons(*RUNTIME_PAYLOADS, table='agent_runtime'),
    Obj('mail_drain', [Lst('ids', 'agent_mail_drain', ('agent_id',), TEXT),
                       Col('retry_at', INT), Col('failures', INT), Col('suspended', BOOL)],
        table='agent_runtime'),
]

CHECK = [Col('at', TS), _by(), Col('evidence_ref', TEXT), Col('note', TEXT),
         Col('classification', TEXT, values=CLASSIFICATION),
         *_texts('artifact', 'runner'),
         Col('execution', TEXT, values=EXECUTION),
         *_texts('execution_means'),
         Col('result', TEXT, values=RESULT),
         *_texts('classification_means', 'composition', 'gate'), Col('blocked_count', INT)]
ACCEPTANCE = [Col('text', TEXT), Obj('checked', CHECK),
              Lst('check_history', 'work_item_acceptance_checks', ('item_id', 'pos'),
                  Rec(CHECK, key=('item_id', 'pos', 'pos_2')), pos='pos_2')]
EVIDENCE = [Col('at', TS), _by(), Col('kind', TEXT, values=('note', 'link', 'file', 'commit', 'log')),
                                  *_texts('ref', 'note'),
                                  Col('execution', TEXT, values=EXECUTION),
                                  *_texts('execution_means'),
            Col('receipt', JSON),
            Col('classification', TEXT, values=CLASSIFICATION),
            *_texts('artifact', 'runner'),
            Col('result', TEXT, values=RESULT),
            *_texts('classification_means')]
SEAT_REQUEST = [Col('seq', INT), *_texts('reviewer', 'requested_by', 'owner', 'to'), Col('at', TS),
                Col('state', TEXT, values=('pending', 'granted', 'withdrawn', 'declined')),
                *_texts('note', 'decided_by'), Col('decided_at', TS),
                Col('decision_note', TEXT)]
HISTORY = [Col('at', TS), Principal('by', aliases={'node': 'by_node',
           'generation': 'by_generation', 'born': 'by_born'}), Col('op', TEXT), Col('kind', TEXT),
           *_jsons('from', 'to', 'done', 'next', 'changes', 'now'),
           *_texts('why', 'note', 'reason'),
           Col('status', TEXT, values=WORK_STATUS),
           Col('status_from', TEXT, values=WORK_STATUS),
           Col('status_to', TEXT, values=WORK_STATUS),
           Col('stage', TEXT, values=STAGE),
           *_texts('reviewer', 'candidate'),
           Col('decision', TEXT, values=('approve', 'changes', 'approve_stage')),
           Col('disposition', TEXT, values=DISPOSITION),
           *_texts('finding', 'artifact', 'name'),
           Col('scope', TEXT, values=('item', 'named')),
           *_texts('via', 'evidence_gap', 'answer'),
           *_ints('scope_seq', 'batch', 'index', 'set_rev', 'supersedes', 'count',
                  'answered_request'),
           *_bools('already_seated', 'after_completion', 'atomic_completion', 'review_in_flight',
                   'verified'),
           *_stamps('accepted_at', 'first_at', 'last_at', 'raised_at'),
           *_jsons('kinds', 'indexes', 'touched', 'requests', 'done_was', 'next_was',
                   'review_packet_was', 'accepted_was', 'superseded_by_was',
                   'dropped_reason_was', 'candidate_verdict_was'),
           Principal('next_actor'), Principal('raised_by')]
HOLDER = [Col('node', TEXT), Col('generation', INT), Col('born', TEXT), Col('from', TS),
          Principal('by'), Col('derived', BOOL), Col('deleted', BOOL)]
SCOPE_ENTRY = [Col('seq', INT), Col('at', TS), _by(), Col('kind', TEXT, values=('objective', 'acceptance', 'decision')),
                                                      *_texts('before', 'after'),
                                                      Col('mode', TEXT, values=('append', 'replace')),
               Col('supersedes', INT), Col('superseded_by', INT), Col('text', TEXT)]
ARTIFACT = [Col('id', TEXT, col='public_id'), Col('seq', INT), Col('at', TS), _by(),
            Col('name', TEXT), Col('bytes', INT), *_texts('sha256', 'path'),
                                                  Col('scope', TEXT, values=('item', 'named')),
            Lst('grants', 'work_item_artifact_grants', ('artifact_id',), Rec([
                Col('to', TEXT, col='recipient_name'), Col('at', TS), Principal('by'),
                Col('revoked_at', TS), Col('note', TEXT)])), Col('note', TEXT)]
DECISION = [Col('at', TS), _by(), Col('disposition', TEXT, values=DISPOSITION), Col('note', TEXT)]
FINDING = [Col('id', TEXT, col='public_id'), Col('seq', INT), Col('at', TS), _by(),
           Col('title', TEXT), Col('disposition', TEXT, values=DISPOSITION),
           Lst('decisions', 'work_item_finding_decisions', ('item_id', 'pos'),
               Rec(DECISION, key=('item_id', 'pos', 'pos_2')), pos='pos_2'),
           *_texts('detail', 'severity', 'evidence_ref')]
DISMISSAL = [Col('at', TS), Col('by', TEXT), Col('set_rev', INT), Col('reason', TEXT)]
REVIEW_SEAT = [Col('reviewer', TEXT, col='reviewer_name'), Principal('holder'),
              Principal('recheck_owner'), Principal('granted_by'), Col('at', TS),
              Col('state', TEXT, values=('granted', 'spent', 'revoked')), Col('note', TEXT),
              Col('answered_request', INT), Col('spent_at', TS), Col('spent_via', TEXT),
              Col('revoked_at', TS), Principal('revoked_by'), Col('revoked_reason', TEXT)]
DELIVERY_CLAIM = [Col('claimed_at', TS), Principal('claimed_by'),
                 *_texts('ref', 'note'), Col('verified', BOOL),
                 *_texts('method', 'detail', 'resolved_oid', 'target', 'ref_as_of'),
                 *_stamps('fetched_at', 'observed_at')]


class Delivery(Obj):
    """Known stages have child claim rows; unknown keys remain at the old path."""
    def __init__(self):
        super().__init__('delivery', [])


def _item_list(src: str, table: str, elem: Any) -> Lst:
    if isinstance(elem, list):
        elem = Rec(elem, key=('item_id', 'pos'))
    return Lst(src, table, ('item_id',), elem)


ITEM = [
    Col('slug', TEXT), Col('rev', INT), Col('kind', TEXT, values=('code', 'non-code')),
                                        *_texts('title', 'objective'),
                                        Col('status', TEXT, values=WORK_STATUS),
                                        *_texts('blocked_reason', 'waiting_reason', 'dropped_reason'),
    Obj('owner', _holder('owner').fields + [Col('deleted', BOOL)]),
    Obj('reviewer', _holder('reviewer').fields + [Col('deleted', BOOL)]),
    _by('created_by'), _by('last_updater'),
    _item_list('participants', 'work_item_participants', TEXT),
    *_stamps('at', 'updated_at', 'docket_at', 'status_at', 'archived_at'),
    _item_list('done_so_far', 'work_item_done', TEXT),
    _item_list('working_on_next', 'work_item_next', TEXT),
    Obj('manual_attention', [Col('reason', TEXT), Col('at', TS), Principal('by'),
                            Col('set_rev', INT)], col='attention'),
    Col('manual_attention_rev', INT),
    _item_list('acceptance', 'work_item_acceptance', ACCEPTANCE),
    _item_list('dependencies', 'work_item_dependencies', TEXT),
    Delivery(), Obj('accepted', [Col('at', TS), Principal('by'), *_texts('note', 'via'),
        Obj('evidence_gap', [*_ints('unclassified', 'total'), Col('summary', TEXT)])]),
    Lst('review_seats', 'work_item_review_seats', ('item_id',), Rec(REVIEW_SEAT), pos='seq'),
    _item_list('review_seat_requests', 'work_item_review_seat_requests', SEAT_REQUEST),
    Col('superseded_by', TEXT), Col('parent', TEXT),
    _item_list('holders', 'work_item_holders', HOLDER),
    Col('notification_attention_epoch', INT), Col('notification_attention_active', BOOL),
    *_ints('scope_seq', 'scope_guard', 'scope_logged'),
    _item_list('artifacts', 'work_item_artifacts', Rec(ARTIFACT)), Col('artifact_seq', INT),
    _item_list('findings', 'work_item_findings', FINDING), Col('finding_seq', INT),
    *_jsons('post_completion'),
]

# The migration's retained event sources, in conversion order. These profiles
# describe source values independently; no runtime mapper is loaded here.
ITEM_EVENT_SOURCES = ('history', 'evidence', 'scope', 'candidate_verdicts',
                      'review_packets', 'dismissals', 'scope_archive', 'quick_staff_receipts')
VERDICT_ENTRY = [Col('at', TS), _holder('by'), Col('candidate', TEXT),
                 Col('decision', TEXT, values=('approve', 'changes', 'approve_stage')),
                 Col('evidence', JSON), Col('note', TEXT), _holder('next_actor')]
PACKET_ENTRY = [Col('at', TS), _holder('by'), Col('candidate', TEXT), Col('base', TEXT),
                Col('note', TEXT), Col('evidence', JSON), _holder('next_actor')]
ITEM_EVENT_FIELDS = [Obj('history', HISTORY), Obj('evidence', EVIDENCE),
                     Obj('scope', SCOPE_ENTRY), Obj('candidate_verdicts', VERDICT_ENTRY),
                     Obj('review_packets', PACKET_ENTRY), Obj('dismissals', DISMISSAL),
                     Obj('scope_archive', SCOPE_ENTRY), Col('quick_staff_receipts', JSON)]
ITEM_EVENT_HEADERS = {'id': INT, 'item_id': INT, 'seq': INT, 'source': TEXT, 'kind': TEXT,
                      'at': TS, 'by_node': TEXT, 'by_generation': INT, 'by_born': TEXT,
                      'content': TEXT, 'status_change': BOOL,
                      'original_at': JSON, 'original_scope_seq': JSON}
ITEM_CURRENT = {'candidate_verdict': ('candidate_verdicts', 'current_verdict_event_id', 'verdict'),
                'review_packet': ('review_packets', 'current_review_packet_event_id', 'review_packet')}

ATTACHMENT = [Col('name', TEXT), Col('path', TEXT), Col('bytes', INT)]


def _child(src: str, table: str, fk: str, elem: Any) -> Lst:
    return Lst(src, table, (fk,), Rec(elem, key=(fk, 'pos')) if isinstance(elem, list) else elem)


ASK = [Col('id', TEXT, col='public_id'), *_texts('node'),
                                         Col('kind', TEXT, values=('question',)),
                                         *_texts('question'),
       Col('questions', JSON), Col('at', TS),
       _child('options', 'ask_options', 'asks_id', _texts('label', 'description')),
       Col('header', TEXT), _child('work_items', 'ask_work_items', 'asks_id', TEXT),
       Col('rev', INT), Col('status', TEXT, values=('open', 'answered', 'dismissed', 'moot', 'withdrawn')),
                        *_texts('reason'), Col('answer', JSON), Col('resolved_at', TS),
       Col('answer_mail', TEXT)]
CREDIT_REQUEST = [Col('id', TEXT, col='public_id'), Col('node', TEXT), Col('old', NUM),
                  Col('new', NUM), Col('reason', TEXT), Col('at', TS), Col('rev', INT),
                  Col('status', TEXT, values=('pending', 'answered', 'denied', 'dismissed', 'moot', 'withdrawn')), Col('granted', NUM), Col('notice', TEXT)]
SCOPE_REQUEST = [Col('id', TEXT, col='public_id'), Col('node', TEXT),
                 _child('items', 'scope_request_items', 'scope_requests_id',
                        [Col('kind', TEXT, values=('dir', 'tool', 'mcp', 'permission_mode')), Col('path', TEXT), Col('mode', TEXT, values=DIR_MODE + PERMISSION), Col('decision', TEXT, values=('approve', 'deny', 'skip', 'approve (clamped — not in effect)', 'approve (partial)')), Col('tool', TEXT, values=('bash', 'edit', 'web', 'subagents')), Col('server', TEXT)]),
                 Col('reason', TEXT), Col('at', TS), Col('rev', INT), Col('status', TEXT, values=('pending', 'answered', 'moot', 'withdrawn')),
                 Col('resolved_at', TS)]
AUDIENCE = [*_texts('grantee', 'grantor'), Col('granted_at', TS), *_texts('reason', 'delegated_by')]
AUDIENCE_REQUEST = [Col('id', TEXT, col='public_id'), *_texts('node', 'target', 'reason'),
                    Col('at', TS), Col('status', TEXT)]
WATCHDOG = [Col('id', TEXT, col='public_id'), *_texts('owner', 'name'),
                                              Col('kind', TEXT, values=WATCHDOG_KIND),
                                              *_texts('target', 'pattern'),
            Col('interval_s', INT), Col('state', TEXT, values=('armed', 'paused')), Col('at', TS), Col('fired', INT),
            _child('events', 'watchdog_events', 'watchdogs_id', [Col('at', TS), Col('gist', TEXT)]),
            Col('high_water', JSON), Col('last_check', TS),
            Col('_last_check_ts', FLOAT, col='last_check_ts'), Col('checks_run', INT),
            *_texts('last_output', 'paused_why'), Col('last_exit', INT), Col('last_fired', TS),
            *_bools('history_retained', 'notice', 'once'), Col('shell', TEXT, values=('native', 'bash')),
            Col('fire_mode', TEXT, values=('event', 'silence')), Col('quiet_period_s', INT), Col('silence_since', TS)]
WATCHDOG_TOMB = [Col('id', TEXT, col='public_id'), *_texts('owner', 'name'),
                                                   Col('kind', TEXT, values=WATCHDOG_KIND),
                                                   *_texts('target'),
                 Col('interval_s', INT), *_stamps('at', 'spent_at'), Col('fired', INT),
                 Col('orphaned_from', TEXT), Col('notice', BOOL),
                 Col('state', TEXT, values=('superseded',)),
                 *_texts('superseded_by', 'reason'), Col('once', BOOL),
                 Col('fire_mode', TEXT, values=('event', 'silence')), Col('quiet_period_s', INT), Col('silence_since', TS)]
WATCHDOG_HISTORY = [Col('at', TS), *_texts('gist', 'watchdog', 'node', 'body')]
RESERVATION = [Col('id', TEXT, col='public_id'),
               *_texts('owner', 'item', 'resource', 'candidate', 'base'),
               _child('paths', 'reservation_paths', 'reservations_id', TEXT), Col('state', TEXT, values=('held', 'released', 'recovered', 'stale', 'landed')),
               *_stamps('created_at', 'updated_at'),
               *[Col(n, FLOAT) for n in ('created_ts', 'updated_ts', 'expires_ts')],
               Col('expires_at', TS), Col('heartbeat_ts', FLOAT), Col('heartbeat_at', TS),
               Col('stale_s', FLOAT), *_texts('integration_key', 'integration_receipt'),
               Col('landed_at', TS), Col('release_receipt', TEXT), Col('successor', JSON)]
DOCUMENT = [Col('id', TEXT, col='public_id'), *_texts('node', 'title', 'body'), Col('at', TS),
            Col('format', TEXT, values=('markdown', 'html')),
            *_texts('file'), Col('bytes', INT), Col('orphaned_from', TEXT)]
EVENT = [*_texts('op', 'actor'), Col('at', TS), Col('detail', JSON),
         _child('warnings', 'event_warnings', 'events_id', TEXT)]
LIFECYCLE = [*_texts('operation_id', 'kind', 'state'), Col('at', TS), Col('count', INT),
             *_texts('message_id', 'recipient', 'sender', 'delivery', 'waited', 'boundary_for'),
             Col('observed', BOOL), *_texts('task_id', 'owner', 'settlement', 'summary', 'item'),
             *_ints('issued_revision', 'current_revision'), Col('issued_candidate', TEXT),
             Col('current_candidate', TEXT),
             *_texts('node', 'cleanup', 'door', 'reason', 'status')]
NOTICE_LOG = [Col('node', TEXT), Col('at', TS), Col('text', TEXT), Col('ev', JSON)]
ORG_INBOX = [Col('id', TEXT, col='public_id'), Col('dir', TEXT, values=('in', 'out')),
                                               *_texts('peer', 'body'), Col('at', TS),
             *_texts('by', 'state'), Col('state_at', TS), Col('net_id', TEXT),
             Col('attributed', BOOL)]
USER_INBOX = [Col('id', TEXT, col='public_id'), *_texts('from'),
                                                Col('kind', TEXT, values=MAIL_KIND),
                                                *_texts('body'), Col('at', TS),
              *_texts('message_id', 'operation_id'),
              _child('attachments', 'user_inbox_attachments', 'user_inbox_id', ATTACHMENT),
              Col('ev', JSON)]
USER_OUTBOX = [Col('id', TEXT, col='public_id'), *_texts('from'),
                                                 Col('kind', TEXT, values=MAIL_KIND),
                                                 *_texts('body'), Col('at', TS),
               *_texts('relationship', 'message_id', 'operation_id', 'client_op'),
               Col('ev', JSON), Col('to', TEXT), Col('recv_seq', INT),
               Col('seq_origin', TEXT, values=SEQ_ORIGIN),
               *_texts('mailbox'),
               _child('attachments', 'user_outbox_attachments', 'user_outbox_id', ATTACHMENT),
               Col('reply_to', JSON),
               _child('attachments_missing', 'user_outbox_attachments_missing', 'user_outbox_id',
                      TEXT)]
USER_MAIL_LOG = [Col('id', TEXT, col='public_id'), *_texts('from'),
                                                   Col('kind', TEXT, values=MAIL_KIND),
                                                   *_texts('body'), Col('at', TS),
                 *_texts('message_id', 'operation_id'),
                 _child('attachments', 'user_mail_log_attachments', 'user_mail_log_id',
                        ATTACHMENT),
                 Col('ev', JSON), Col('urgent', BOOL), Col('urgent_reason', TEXT)]
OP_RECEIPT = [Col('v', INT), Col('id', TEXT, col='public_id'), Col('at', TS), Col('mint_ms', INT),
              Col('node', TEXT), Col('gen', INT), *_texts('tool', 'key', 'fp'),
              Col('targets', JSON), Col('cls', TEXT, values=('transaction', 'transaction+post', 'pre_transaction', 'unrolled_side_effect', 'none')),
                                    Col('outcome', TEXT, values=('applied', 'fenced')),
              *_jsons('result', 'ev_from', 'ev_to', 'post_effects'),
              *_texts('fp_node', 'orphaned_from')]
DIR = [Col('path', TEXT), Col('mode', TEXT, values=DIR_MODE)]
NET_HUB = [Col('id', TEXT, col='public_id'), Col('address', TEXT), Col('enabled', BOOL),
           Col('name', TEXT)]
MAIL = [Col('id', TEXT, col='public_id'), *_texts('from'),
                                          Col('kind', TEXT, values=MAIL_KIND),
                                          *_texts('body'), Col('at', TS),
        Col('relationship', TEXT), Col('restart_notice', BOOL), Col('ev', JSON),
        Col('recv_seq', INT), Col('seq_origin', TEXT, values=SEQ_ORIGIN),
                              *_texts('mailbox', 'message_id', 'operation_id'),
        Col('redelivered', INT)]
NOTICE = [Col('at', TS), Col('text', TEXT), Col('ev', JSON)]
BATCH = [Col('tok', TEXT), Col('at', TS), *_jsons('mail', 'notices'), Col('via', TEXT, values=('turn', 'steer')),
         Obj('custody', [Col('mailbox', TEXT), Col('generation', INT), Col('session', TEXT)]),
         Col('engines', JSON), Col('mode', TEXT, values=('turn', 'steer', 'manual_fetch')), *_jsons('attempt', 'drive', 'segments', 'manual'),
         Obj('claim', [Col('delivery_id', TEXT), Col('tool_use_id', TEXT),
                       Col('claimed_at', FLOAT), Col('lease_until', FLOAT)]),
         Col('attempts', INT),
         _child('delivery_ids', 'delivery_batch_ids', 'delivery_batches_id', TEXT)]
MAIL_LOG = [Col('id', TEXT, col='public_id'), *_texts('from'),
                                              Col('kind', TEXT, values=MAIL_KIND),
                                              *_texts('body'), Col('at', TS),
            *_texts('relationship', 'message_id', 'operation_id', 'client_op'), Col('ev', JSON),
            Col('restart_notice', BOOL), Col('recv_seq', INT), Col('seq_origin', TEXT, values=SEQ_ORIGIN),
                                                               *_texts('mailbox'),
            _child('attachments', 'mail_log_attachments', 'mail_log_id', ATTACHMENT),
            Col('stale', BOOL), Col('stale_at', TS), Col('stale_revision', INT),
            Col('stale_candidate', TEXT), Col('net_id', TEXT), Col('reply_to', JSON),
            *_bools('model_only', 'retracted'),
            _child('attachments_missing', 'mail_log_attachments_missing', 'mail_log_id', TEXT)]
STEER_RECORD = [Col('at', TS), *_texts('delivery_id'),
                               Col('level', TEXT, values=('accepted', 'handoff', 'recorded')),
                *[_child(n, f'steer_record_{n}', 'steer_records_id', TEXT)
                  for n in ('mail_ids', 'delivery_ids', 'acked_ids', 'recorded_ids')],
                Col('attempts', INT), *_bools('retried', 'confirmed_duplicate'),
                *_texts('text', 'visible_id'), Col('segments', JSON), Col('fold', INT),
                *_texts('where', 'outcome')]
TURN_ERROR = [Col('at', TS), Col('text', TEXT), Col('ran_as', TEXT)]
TRANSITION = [*_texts('operation'),
              Col('outcome', TEXT, values=('reclaimed', 'confirmed')),
              *_texts('node'), *_jsons('identity', 'before', 'deliveries')]
MANUAL_ATTEMPT = [Col('v', INT), Col('at', TS), *_texts('tok', 'mailbox'), Col('generation', INT),
                  *_texts('session', 'attempt', 'engine', 'delivery_id', 'seat', 'op_key', 'op_id'),
                  _child('mail_ids', 'manual_attempt_mail_ids', 'manual_attempts_id', TEXT),
                  *_jsons('digests', 'provider_call_id'), Col('call_id_source', TEXT),
                  *_jsons('resolved', 'chunk_calls')]
STEER_ATTEMPT = [Col('at', TS), Col('tool_use_id', TEXT),
                 _child('toks', 'steer_attempt_toks', 'steer_attempts_id', TEXT),
                 _child('mail_ids', 'steer_attempt_mail_ids', 'steer_attempts_id', TEXT),
                 Col('transcript_path', TEXT), *_ints('tp_offset', 'texts_n'), Col('retried', BOOL),
                 *_stamps('acked_at', 'recorded_at'), Col('resolved', TEXT, values=('unconfirmable', 'delivered-elsewhere', 'superseded')),
                 _child('views', 'steer_attempt_views', 'steer_attempts_id', TEXT),
                 Col('view_segments', JSON)]
MIGRATION = [Col('at', TS), *_ints('repaired', 'stripped'), Col('mode', TEXT, values=('inspect',)),
             _child('holders', 'org_doc_migration_holders', 'org_doc_migrations_id', TEXT),
             Col('multi_holder', BOOL),
             _child('healed', 'org_doc_migration_healed', 'org_doc_migrations_id', TEXT),
             *_ints('minted', 'shared')]
NET_STATE = [Col('registered_at', TS), Col('address', TEXT),
             _child('seen_ids', 'net_state_seen_ids', 'net_state_id', TEXT)]
ORPHAN_KEY = [Col('from', TEXT), Col('at', TS), Col('cause', TEXT), *_jsons('arriving_seat', 'owner'),
              _child('sections', 'orphan_key_sections', 'orphan_keys_id', TEXT)]

#: org_settings: one typed column per scalar setting (A.1)
SETTINGS = [
    Col('version', INT), *_texts('slug', 'name'), Col('created', TS),
    *_texts('workspace'),
    Col('permission_mode', TEXT, values=PERMISSION),
    Col('default_visibility', TEXT, values=VISIBILITY),
    Col('default_effort', TEXT, values=EFFORT),
    *[Col(n, NUM) for n in ('max_top_grant', 'default_top_grant', 'compact_at')],
    *_ints('max_children', 'max_depth'),
    Col('fable_limit_policy', TEXT, values=('halt', 'opus', 'dissolve')),
    Col('fable_filter_policy', TEXT, values=('halt', 'opus', 'auto-autopsy')),
    *_texts('fable_filter_model'),
    *_jsons('fable_api_fallback', 'fable_lock'),
    *_bools('cascade_hire', 'cascade_alloc', 'auto_resume', 'auto_resume_compact'),
    Col('auto_resume_last', NUM), *_jsons('auto_cheap_compact', 'default_tools', 'default_dirs'),
    Col('default_account', TEXT), Col('account_fallback_default', JSON),
    Col('account_token_uuid', TEXT), Col('killswitch', JSON), Col('net_autoconnect', BOOL),
    *_jsons('net_identity', 'net_spool'),
    *_bools('external_inbox_multi_holder', 'org_inbox_multi_holder'),
    *_ints('org_inbox_read', 'mail_drain_version'), *_texts('reply_incarnation', 'work_identity'),
    Col('whole_grants_v1', BOOL), Col('_actors_typed', BOOL, col='actors_typed'),
    Col('deleted_cost_usd', NUM), Col('deleted_cost_usd_unknown', BOOL), Col('api_cost_usd', NUM),
    *_jsons('api_fallback', 'api_fallback_since', 'api_fallback_until', 'api_key'),
    *_jsons('cred_warned_at', 'headless', 'desktop_import', 'op_receipts_meta',
            'tool_result_receipts', 'sandbox', 'chain_notices', 'release'),
]

#: Every top-level key the verifier knows, and how the destination holds it. Together these
#: are ledger.NODE_KEYED_SECTIONS plus 'chain_notices', 'release' and KEPT_LEGACY (the static
#: test asserts it).
SECTIONS: dict[str, tuple] = {
    'nodes': ('nodes',),
    'work_items': ('docket', 'active'), 'work_items_archive': ('docket', 'archive'),
    'mail': ('agent_list', 'mail', MAIL), 'mail_log': ('agent_list', 'mail_log', MAIL_LOG),
    'notices': ('agent_list', 'notices', NOTICE),
    'steered_log': ('agent_list', 'steer_records', STEER_RECORD),
    'delivering': ('agent_list', 'delivery_batches', BATCH),
    'turn_error_log': ('agent_list', 'agent_turn_errors', TURN_ERROR),
    'turn_log': ('agent_list', 'agent_turns', TURN),
    'work_scope_log': ('agent_list', 'work_scope_log', SCOPE_ENTRY),
    'mail_transitions': ('agent_dict', 'mail_transitions', TRANSITION),
    'steer_attempts': ('agent_dict', 'steer_attempts', STEER_ATTEMPT),
    'manual_attempts': ('agent_dict', 'manual_attempts', MANUAL_ATTEMPT),
    'op_receipts': ('list', 'op_receipts', OP_RECEIPT),
    'documents': ('list', 'documents', DOCUMENT), 'asks': ('list', 'asks', ASK),
    'credit_requests': ('list', 'credit_requests', CREDIT_REQUEST),
    'scope_requests': ('list', 'scope_requests', SCOPE_REQUEST),
    'watchdogs': ('list', 'watchdogs', WATCHDOG),
    'watchdog_tombs': ('list', 'watchdog_tombs', WATCHDOG_TOMB),
    'audiences': ('list', 'audience_grants', AUDIENCE),
    'audience_requests': ('list', 'audience_requests', AUDIENCE_REQUEST),
    'events': ('list', 'events', EVENT), 'lifecycle': ('list', 'lifecycle_events', LIFECYCLE),
    'notice_log': ('list', 'notice_log', NOTICE_LOG),
    'watchdog_history': ('list', 'watchdog_history', WATCHDOG_HISTORY),
    'org_inbox': ('list', 'org_inbox', ORG_INBOX), 'user_inbox': ('list', 'user_inbox', USER_INBOX),
    'user_outbox': ('list', 'user_outbox', USER_OUTBOX),
    'user_mail_log': ('list', 'user_mail_log', USER_MAIL_LOG),
    'reservations': ('list', 'reservations', RESERVATION),
    'dirs': ('list', 'org_dirs', DIR), 'net_hubs': ('list', 'net_hubs', NET_HUB),
    'orphan_keys': ('dict', 'orphan_keys', ORPHAN_KEY),
    '_migrations': ('dict', 'org_doc_migrations', MIGRATION),
    'net_state': ('dict', 'net_state', NET_STATE),
    'tiers': ('map', 'org_tier_prices', NUM), 'models': ('map', 'org_tier_models', TEXT),
    'work_deleted_names': ('names', 'retired_slugs'),
    **{c.src: ('setting', c) for c in SETTINGS},
}
BY_AGENT = [k for k, v in SECTIONS.items() if v[0] in ('agent_list', 'agent_dict')]
#: tables that are not the document; never compared, never notes
OUTSIDE = {'org_identity', 'org_revision', 'org_topology', 'conversion_runs',
           'conversion_run_kinds', 'schema_migrations'}

# Derived from verified source fields or maintained by database triggers.
# 0006_agents_readers.sql supplies the revision counters; 0007_docket_readers.sql
# supplies docket projections and its counter; 0008_windows.sql supplies the bounded
# windows' keys (generated win_* columns) and the events count. These are not legacy data.
DERIVED = {
    'org_revision': {'node_rev', 'catalog_rev', 'view_rev', 'docket_rev',
                     'node_count', 'retired_axis_count', 'cost', 'cost_unknown',
                     'events_count'},
    'agents': {'parent_misfit', 'predecessor_misfit', 'successor_misfit',
               'state_misfit', 'ui_order_misfit', 'created_misfit',
               'generation_misfit', 'bearer_state_misfit',
               'cost_usd_misfit', 'cost_usd_unknown_misfit'},
    'asks': {'node_misfit', 'status_misfit', 'at_misfit', 'resolved_at_misfit'},
    'credit_requests': {'node_misfit', 'status_misfit', 'at_misfit', 'resolved_at_misfit'},
    'scope_requests': {'node_misfit', 'status_misfit', 'at_misfit', 'resolved_at_misfit'},
    'notice_log': {'win_node', 'win_at'},
    'user_mail_log': {'win_from', 'win_at'},
    'mail_log': {'win_from', 'win_at'},
    'events': {'win_at'},
    'steer_records': {'win_at'},
    'agent_turn_errors': {'win_at'},
    'work_items': {'docket_manual', 'docket_order', 'docket_deadline',
                   'docket_owner_key', 'docket_creator_key', 'docket_reviewer_key',
                   'docket_anchor_key',
                   # 0014: generated read headers of already verified slug/status/extra.
                   'archive_identity_slug', 'archive_legacy_identity',
                   'work_identity_slug_value', 'archive_status_key'},
}


#: roles in correspondence(): a value kind above, or one of these
CODE, KEY, OPT = 'code', 'key', 'opt'      # an <x>_is code; a structural column; may be absent


def _principal_fields(field: Principal, prefix: str) -> list[Col]:
    parts = (('node', TEXT, 'name'), ('generation', INT, 'generation'),
             ('born', TEXT, 'born'), ('deleted', BOOL, 'deleted'))
    return [Col(src, kind, col=field.aliases.get(src, prefix + '_' + suffix))
            for src, kind, suffix in parts]


def _walk(fields: list, owner: str, out: dict) -> None:
    def put(t: str, c: str, role: str) -> None:
        if out[t].get(c) in (None, OPT):
            out[t][c] = role

    def walk(fs: list, table: str, prefix: str) -> None:
        for f in fs:
            t = f.table or table
            if isinstance(f, Col):
                c = _cn(prefix, f.col)
                put(t, c, f.kind)
                put(t, c + '_null', OPT)
                if f.kind == TS:
                    put(t, c + '_text', OPT)
            elif isinstance(f, Principal):
                p = _cn(prefix, f.src)
                put(t, p + '_is', CODE)
                put(t, p + '_kind', TEXT)
                for part in _principal_fields(f, p):
                    put(t, part.col, part.kind)
                    put(t, part.col + '_null', OPT)
            elif isinstance(f, SumState):
                p = _cn(prefix, f.src)
                put(t, p + '_is', CODE)
                put(t, p + '_kind', CHAR)
                for suffix, role in (('integer', NUM), ('float', FLOAT), ('compensation', FLOAT)):
                    put(t, p + '_' + suffix, role)
            elif isinstance(f, TurnUsage):
                put(t, _cn(prefix, f.src) + '_is', CODE)
                walk(f.fields, t, _cn(prefix, f.col))
            elif isinstance(f, Obj):
                p = _cn(prefix, f.col)
                put(t, p + '_is', CODE)
                walk(f.fields, t, p)
            elif isinstance(f, Lst):
                put(f.table or t, _cn(prefix, f.src) + '_is', CODE)
                for c in f.fk + (f.pos,):
                    put(f.ctable, c, KEY)
                if isinstance(f.elem, Rec):
                    put(f.ctable, 'extra', JSON)
                    walk(f.elem.fields, f.ctable, '')
                else:
                    put(f.ctable, 'value', f.elem)
            elif isinstance(f, Link):
                put(t, f.src, TEXT)
                put(t, f.src + '_null', OPT)
                put(t, f.src + '_id', KEY)
            elif isinstance(f, ToolList):
                put(t, 'tool_list_id', KEY)
    put(owner, 'extra', JSON)
    walk(fields, owner, '')


def correspondence() -> dict[str, dict[str, str]]:
    """table -> {column: role} for every destination column this verifier reads: a value
    kind, CODE, KEY (structural), or OPT (a _null / _text sibling the schema may not have)."""
    out: dict[str, dict[str, str]] = defaultdict(dict)
    _walk(NODE, 'agents', out)
    out['agents'].update({'id': KEY, 'name': TEXT, 'ord': KEY, 'tombstone': BOOL,
                          'row_version': OPT, **{f: BOOL for f in PRESENCE}})
    out['agent_texts'].update({'agent_id': KEY, 'extra': JSON})
    out['agent_runtime'].update({'agent_id': KEY, 'extra': JSON})
    out['tool_lists'].update({'id': KEY, 'sha256': OPT})
    out['tool_list_items'].update({'list_id': KEY, 'pos': KEY, 'tool': TEXT})
    _walk(ITEM, 'work_items', out)
    out['work_items'].update({'id': KEY, 'list_key': KEY, 'ord': KEY, 'anchor_name': OPT,
                              'row_version': OPT, 'archive_seq': INT, 'docket_scope_meta': JSON,
                              'docket_policy_extra': JSON, 'docket_list_extra': JSON,
                              'owner_agent_id': KEY, 'reviewer_agent_id': KEY})
    out['work_item_artifacts']['id'] = KEY
    out['work_item_holders']['agent_id'] = KEY
    out['work_item_review_seats'].update({'id': KEY, 'row_version': OPT,
        'reviewer_agent_id': KEY, 'holder_agent_id': KEY, 'recheck_owner_agent_id': KEY})
    out['work_item_artifact_grants'].update({'id': KEY, 'item_id': KEY, 'row_version': OPT,
                                           'agent_id': KEY})
    _walk(DELIVERY_CLAIM, 'work_item_delivery', out)
    out['work_item_delivery'].update({'id': KEY, 'item_id': KEY, 'stage': TEXT,
                                     'claim_is': CODE, 'row_version': OPT})
    out['work_items'].update({s + '_events_is': CODE for s in ITEM_EVENT_SOURCES})
    for _source, column, _kind in ITEM_CURRENT.values():
        out['work_items'].update({column: INT, column + '_is': CODE, column + '_kind': TEXT})
    _walk(ITEM_EVENT_FIELDS, 'work_item_events', out)
    out['work_item_events'].update(ITEM_EVENT_HEADERS)
    for kind, *rest in SECTIONS.values():
        if kind in ('list', 'dict', 'agent_list', 'agent_dict'):
            table, fields = rest
            _walk(fields, table, out)
            out[table].update({'id': KEY, 'row_version': OPT})
            out[table].update({'agent_id': KEY, 'idx': KEY} if kind.startswith('agent')
                              else {'ord': KEY})
            if kind.endswith('dict'):
                out[table]['key'] = TEXT
        elif kind == 'map':
            out[rest[0]].update({'id': KEY, 'ord': KEY, 'key': TEXT, 'value': rest[1],
                                 'value_null': OPT, 'extra': JSON})
        elif kind == 'names':
            out[rest[0]].update({'ord': KEY, 'value': TEXT})
    _walk(SETTINGS, 'org_settings', out)
    out['org_settings']['singleton'] = KEY
    out['org_sections'].update({'key': TEXT, 'ord': KEY, 'state': KEY})
    out['org_section_owners'].update({'section': TEXT, 'agent_id': KEY, 'ord': KEY, 'state': KEY})
    out['org_extra'].update({'key': TEXT, 'val': JSON})
    return {t: dict(cols) for t, cols in out.items()}


def enum_columns(*, include_markers: bool = False) -> dict[tuple[str, str], tuple[str, ...]]:
    """Independent closed sets for the DOCUMENT columns this verifier compares.

    Account and side-file tables remain outside this verifier's stated scope.
    Enumerating the existing correspondence lets static controls check completeness.
    """
    out: dict[tuple[str, str], tuple[str, ...]] = {}

    def put(table: str, column: str, values: tuple[str, ...]) -> None:
        key = (table, column)
        if key in out and out[key] != values:
            raise ValueError(f'inconsistent enum declaration: {table}.{column}')
        out[key] = values

    def walk(fields: list, table: str, prefix: str = '') -> None:
        for field in fields:
            owner = field.table or table
            if isinstance(field, Col):
                if field.values:
                    put(owner, _cn(prefix, field.col), field.values)
            elif isinstance(field, Principal):
                name = _cn(prefix, field.src)
                if include_markers:
                    put(owner, name + '_is', ('n', 's', 'o', 'x'))
                put(owner, name + '_kind', ('agent', 'user', 'engine', 'outside'))
            elif isinstance(field, SumState):
                name = _cn(prefix, field.src)
                if include_markers:
                    put(owner, name + '_is', MARKER_VALUES['list'])
                put(owner, name + '_kind', ('i', 'f'))
            elif isinstance(field, Obj):
                name = _cn(prefix, field.col)
                if include_markers:
                    put(owner, _cn(prefix, field.src if isinstance(field, TurnUsage) else field.col) + '_is',
                        ('n', 'o', 'l', 'x') if isinstance(field, TurnUsage)
                        else MARKER_VALUES['obj'])
                walk(field.fields, owner, name)
            elif isinstance(field, Lst):
                if include_markers:
                    put(owner, _cn(prefix, field.src) + '_is', MARKER_VALUES['list'])
                if isinstance(field.elem, Rec):
                    walk(field.elem.fields, field.ctable)

    walk(NODE, 'agents')
    walk(ITEM, 'work_items')
    walk(ITEM_EVENT_FIELDS, 'work_item_events')
    walk(DELIVERY_CLAIM, 'work_item_delivery')
    put('work_item_delivery', 'stage', STAGE)
    if include_markers:
        put('work_item_delivery', 'claim_is', MARKER_VALUES['obj'])
    put('org_sections', 'state', ('n', 'v'))
    put('org_section_owners', 'state', ('n', 'l', 'o'))
    put('work_items', 'list_key', ('active', 'archive'))
    put('work_item_events', 'source', ITEM_EVENT_SOURCES)
    put('work_item_events', 'kind', ('history', 'evidence', 'scope', 'decision',
                                   'verdict', 'review_packet', 'dismissal', 'quick_staff_receipt'))
    if include_markers:
        for source in ITEM_EVENT_SOURCES:
            put('work_items', source + '_events_is', MARKER_VALUES['list'])
        for _source, column, _kind in ITEM_CURRENT.values():
            put('work_items', column + '_is', ('n', 'v'))
    walk(SETTINGS, 'org_settings')
    for kind, *rest in SECTIONS.values():
        if kind in ('list', 'dict', 'agent_list', 'agent_dict'):
            walk(rest[1], rest[0])
    return out


def known_columns() -> dict[str, set[str]]:
    """Every destination table this verifier compares, with the columns it reads."""
    return {t: set(cols) for t, cols in correspondence().items()}


# ------------------------------------------------------------------ values
def _cn(prefix: str, name: str) -> str:
    return f'{prefix}_{name}' if prefix else name


def jeq(a: Any, b: Any) -> bool:
    """JSON equality with exact types: bool, int and float are different values."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(jeq(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(jeq(x, y) for x, y in zip(a, b))
    if isinstance(a, float):
        return _feq(a, b)
    return a == b


def _feq(a: float, b: float) -> bool:
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    return a == b and math.copysign(1.0, a) == math.copysign(1.0, b)


def _has_nul(v: Any) -> bool:
    if isinstance(v, str):
        return '\x00' in v
    if isinstance(v, dict):
        return any(_has_nul(k) or _has_nul(x) for k, x in v.items())
    if isinstance(v, list):
        return any(_has_nul(x) for x in v)
    return False


def _text_ok(v: Any) -> bool:
    if not isinstance(v, str) or '\x00' in v:
        return False
    try:
        v.encode('utf-8')
    except UnicodeEncodeError:            # a lone surrogate: PostgreSQL text cannot hold it
        return False
    return True


_CANON = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z')
_STRICT = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?'
                     r'(Z|[+-]\d{2}:\d{2})\Z')
_OFFSET = r'([Zz]|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)'
_EXTENDED = re.compile(r'(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?'
                       + _OFFSET + r'\Z')
_BASIC = re.compile(r'(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(?:(\d{2})(?:[.,](\d+))?)?'
                    + _OFFSET + r'\Z')
_UTC = _dt.timezone.utc


def _offset(text: str) -> _dt.timezone:
    if text in ('Z', 'z'):
        return _UTC
    sign = -1 if text[0] == '-' else 1
    digits = text[1:].replace(':', '')
    frac = 0
    if '.' in digits:
        digits, f = digits.split('.')
        frac = int((f + '000000')[:6])
    hh, mm, ss = int(digits[0:2]), int(digits[2:4] or 0), int(digits[4:6] or 0)
    delta = _dt.timedelta(hours=hh, minutes=mm, seconds=ss, microseconds=frac)
    return _dt.timezone(sign * delta)


def parse_instant(text: str) -> tuple[str, _dt.datetime | None, bool]:
    """(fit, instant in UTC, finer than a microsecond) for a timestamp string.

    fit 'yes': the strict ISO form YYYY-MM-DDTHH:MM:SS[.f{1,6}](Z|+HH:MM), a real date: its
    column must hold it. 'maybe': another ISO 8601 form WITH an offset that this parser reads
    (space or basic form, comma, 7+ digits, +HHMM, no seconds, lower-case z): column or extra.
    'no': anything else, an offset-less time included (its instant is not determined): extra."""
    if not isinstance(text, str) or '\x00' in text:
        return 'no', None, False
    fit = 'yes' if _STRICT.match(text) else 'maybe'
    m = _EXTENDED.match(text) or _BASIC.match(text)
    if not m:
        # ISO week dates and alternate separators accepted by the source writer.
        # The original text still has to survive; this is independent stdlib
        # parsing of the legacy value, not destination or mapper code.
        try:
            stamp = _dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
            if stamp.tzinfo is not None and stamp.utcoffset() is not None:
                return 'maybe', stamp.astimezone(_UTC), False
        except (ValueError, OverflowError):
            pass
        return 'no', None, False
    y, mo, d, h, mi, s, frac, off = m.groups()
    finer = bool(frac) and len(frac) > 6
    try:
        tz = _offset(off)
        stamp = _dt.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0),
                             int(((frac or '') + '000000')[:6]), tzinfo=tz)
        return fit, stamp.astimezone(_UTC), finer
    except (ValueError, OverflowError):
        return 'no', None, False


def fit_of(kind: str, v: Any) -> str:
    """Can the typed column of ``kind`` hold ``v`` exactly? 'yes', 'no' or 'maybe'."""
    if kind == TEXT:
        return 'yes' if _text_ok(v) else 'no'
    if kind == INT:
        return 'yes' if (type(v) is int and -2 ** 63 <= v < 2 ** 63) else 'no'
    if kind == FLOAT:
        if type(v) is not float:
            return 'no'
        return 'yes' if math.isfinite(v) else 'maybe'
    if kind == NUM:
        if type(v) is int:
            return 'yes'
        if type(v) is float:
            return 'yes' if math.isfinite(v) and not (v == 0 and math.copysign(1.0, v) < 0) \
                else 'maybe'
        return 'no'
    if kind == BOOL:
        return 'yes' if type(v) is bool else 'no'
    if kind == TS:
        return parse_instant(v)[0]
    if kind == JSON:
        return 'maybe' if _has_nul(v) else 'yes'
    raise ValueError(kind)


def _num_matches(v: Any, text: Any) -> bool:
    if not isinstance(text, str):
        return False
    try:
        d = Decimal(text)
    except InvalidOperation:
        return False
    if type(v) is int:
        return '.' not in text and 'e' not in text.lower() and d == v
    if not d.is_finite():
        return math.isnan(v) and d.is_nan()
    return '.' in text and float(d) == v


def _short(v: Any) -> str:
    try:
        s = json.dumps(v, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        s = repr(v)
    return s if len(s) <= 160 else s[:157] + '...'


_NA = object()


# ------------------------------------------------------------------ the destination
class Dest:
    """The destination database, read with plain SELECTs into memory, table by table."""

    def __init__(self, conn: Any):
        self.c = conn
        self.columns: dict[str, dict[str, str]] = defaultdict(dict)
        for t, c, dt in conn.execute(
                'SELECT table_name, column_name, data_type FROM information_schema.columns '
                'WHERE table_schema = %s ORDER BY table_name, ordinal_position', (SCHEMA,)):
            self.columns[t][c] = dt
        self._rows: dict[str, list[dict]] = {}
        self._groups: dict[tuple, dict[tuple, list[dict]]] = {}
        self.used: dict[str, set[int]] = defaultdict(set)

    def rows(self, table: str) -> list[dict]:
        if table not in self._rows:
            cols = {c: dt for c, dt in self.columns.get(table, {}).items()
                    if c not in DERIVED.get(table, ())}
            if not cols:
                self._rows[table] = []
            else:
                sel = ', '.join(
                    f'"{c}"::text' if dt in ('json', 'jsonb', 'numeric') else f'"{c}"'
                    for c, dt in cols.items())
                cur = self.c.execute(f'SELECT {sel} FROM {SCHEMA}."{table}"')
                names = list(cols)
                self._rows[table] = [dict(zip(names, r)) for r in cur.fetchall()]
        return self._rows[table]

    def group(self, table: str, fk: tuple, pos: str) -> dict[tuple, list[dict]]:
        key = (table, fk, pos)
        if key not in self._groups:
            out: dict[tuple, list[dict]] = defaultdict(list)
            for r in self.rows(table):
                out[tuple(r.get(c) for c in fk)].append(r)
            for rs in out.values():
                rs.sort(key=lambda r: (r.get(pos) is None, r.get(pos) or 0))
            self._groups[key] = dict(out)
        return self._groups[key]

    def take(self, table: str, row: dict) -> None:
        self.used[table].add(id(row))


# ------------------------------------------------------------------ the comparison
class Checker:
    def __init__(self, dest: Dest):
        self.d = dest
        self.problems: list[dict] = []
        self.notes: list[str] = []
        self._type_checked: set[tuple[str, str]] = set()
        #: what was compared, for the report: 'records <table>', 'typed <table>' (values found
        #: in their column), 'nulls <table>', 'extra <table>.<column>' (values found in extra)
        self.stats: dict[str, int] = defaultdict(int)

    def bad(self, section: str, table: str, entity: str, field: str, problem: str,
            source: Any = _NA, dest: Any = _NA) -> None:
        p = {'section': section, 'table': table, 'entity': entity, 'field': field,
             'problem': problem}
        if source is not _NA:
            p['source'] = _short(source)
        if dest is not _NA:
            p['dest'] = _short(dest)
        self.problems.append(p)

    # -- helpers
    def extra_of(self, sec: str, table: str, ent: str, row: dict | None) -> dict:
        if not row or row.get('extra') is None:
            return {}
        try:
            v = json.loads(row['extra'])
        except ValueError:
            self.bad(sec, table, ent, 'extra', 'extra is not JSON', dest=row['extra'])
            return {}
        if not isinstance(v, dict):
            self.bad(sec, table, ent, 'extra', 'extra is not a JSON object', dest=v)
            return {}
        return v

    def _coltype(self, sec: str, table: str, col: str, kind: str) -> bool:
        cols = self.d.columns.get(table, {})
        if col not in cols:
            return False
        if (table, col) not in self._type_checked:
            self._type_checked.add((table, col))
            if cols[col] not in SQL_TYPES[kind]:
                self.bad(sec, table, '*', col, f'column type {cols[col]} is not the '
                         f'verifier\'s {kind}')
        return True

    # -- one record: its fields, then its unknown keys against its extra
    def record(self, sec: str, ent: str, fields: list, src: dict, rows: dict,
               extra: dict, prefix: str, table: str, pkey: tuple | None,
               *, count: bool = True) -> None:
        if not prefix and count:
            self.stats['records ' + table] += 1
        known = set()
        for f in fields:
            known.add(f.src)
            has = f.src in src
            val = src.get(f.src)
            x_has = f.src in extra
            xv = extra.pop(f.src, None)
            where = f'{ent}.{f.src}' if ent else f.src
            if isinstance(f, Col):
                self.col(sec, where, f, has, val, x_has, xv, rows, prefix, table)
            elif isinstance(f, Principal):
                self.principal(sec, where, f, has, val, x_has, xv, rows, prefix, table, pkey)
            elif isinstance(f, SumState):
                self.sum_state(sec, where, f, has, val, x_has, xv, rows, prefix, table)
            elif isinstance(f, TurnUsage):
                self.turn_usage(sec, where, f, has, val, x_has, xv, rows, prefix, table, pkey)
            elif isinstance(f, Delivery):
                self.delivery(sec, where, f, has, val, x_has, xv, rows, prefix, table, pkey)
            elif isinstance(f, Obj):
                self.obj(sec, where, f, has, val, x_has, xv, rows, prefix, table, pkey)
            elif isinstance(f, Lst):
                self.lst(sec, where, f, has, val, x_has, xv, rows, prefix, table, pkey)
            elif isinstance(f, Link):
                self.link(sec, where, f, has, val, x_has, xv, rows.get(table))
            elif isinstance(f, ToolList):
                self.toollist(sec, where, has, val, x_has, xv, rows.get(table))
        for k, v in src.items():
            if k in known:
                continue
            where = f'{ent}.{k}' if ent else k
            if k in extra:
                xv = extra.pop(k)
                if jeq(xv, v):
                    self.stats[f'extra {table}.{_cn(prefix, "<unknown field>")}'] += 1
                else:
                    self.bad(sec, table, where, k, 'field with no typed column differs in extra',
                             v, xv)
            else:
                self.bad(sec, table, where, k, 'field with no typed column is missing from extra',
                         v)
        for k in list(extra):
            self.bad(sec, table, f'{ent}.{k}' if ent else k, k,
                     'extra holds a field the source record does not have', dest=extra.pop(k))
    def current_links(self, sec, ent, table, row, src):
        """Implemented by the full verifier; scalar-only checks need no graph."""

    def principal(self, sec, where, field, has, value, x_has, xv,
                  rows, prefix, table, pkey):
        p = _cn(prefix, field.src)
        row = rows.get(table) or {}
        parts = _principal_fields(field, p)
        fitting_string = has and _text_ok(value)
        marker = (None if not has else 'n' if value is None else 's' if fitting_string
                  else 'o' if isinstance(value, dict) else 'x')
        self.code(sec, table, where, p + '_is', row, marker)
        # Other event sources share the actor query headers with history.by.
        # Their headers are checked separately against those source bodies.
        if field.aliases and row.get('source') not in (None, 'history'):
            row = dict(row)
            for column in field.aliases.values():
                row[column] = row[column + '_null'] = None
            rows = dict(rows, **{table: row})
        name = value if fitting_string else value.get('node') if isinstance(value, dict) else None
        want_kind = (None if not _text_ok(name) else 'user' if name == 'user' else
                     'engine' if name == 'orgtree' else 'outside'
                     if name.startswith(('@org:', '@net:')) else 'agent')
        if row.get(p + '_kind') != want_kind:
            self.bad(sec, table, where, p + '_kind', 'recorded principal kind differs',
                     want_kind, row.get(p + '_kind'))
        if marker == 'o':
            sub = xv if x_has and isinstance(xv, dict) else {}
            if x_has and not isinstance(xv, dict):
                self.bad(sec, table, where, p, 'principal object extra has the wrong shape', value, xv)
            self.record(sec, where, parts, value, rows, sub, '', table, pkey, count=False)
        elif marker == 's':
            self.record(sec, where, parts, {'node': value}, rows, {}, '', table, pkey, count=False)
            if x_has:
                self.bad(sec, table, where, p, 'bare principal is also in extra', value, xv)
        else:
            self.record(sec, where, parts, {}, rows, {}, '', table, pkey, count=False)
            if marker == 'x':
                if not x_has or not jeq(value, xv):
                    self.bad(sec, table, where, p, 'exceptional principal differs in extra', value,
                             xv if x_has else '<absent>')
            elif x_has:
                self.bad(sec, table, where, p, 'inactive principal conflicts with extra', dest=xv)

    def sum_state(self, sec, where, field, has, value, x_has, xv, rows, prefix, table):
        p = _cn(prefix, field.src)
        row = rows.get(table) or {}
        integer = (isinstance(value, list) and len(value) == 2 and value[0] == 'i'
                   and type(value[1]) is int)
        floating = (isinstance(value, list) and len(value) == 3 and value[0] == 'f'
                    and all(type(v) is float and math.isfinite(v) for v in value[1:]))
        marker = None if not has else 'n' if value is None else 'l' if integer or floating else 'x'
        self.code(sec, table, where, p + '_is', row, marker)
        expected = {'kind': 'i' if integer else 'f' if floating else None,
                    'integer': value[1] if integer else None,
                    'float': value[1] if floating else None,
                    'compensation': value[2] if floating else None}
        for suffix, want in expected.items():
            column = p + '_' + suffix
            got = row.get(column)
            kind = NUM if suffix == 'integer' else FLOAT if suffix in ('float', 'compensation') else None
            self._coltype(sec, table, column, kind or CHAR)
            equal = (self.matches(kind, want, got, None, False) == '' if want is not None and kind
                     else jeq(want, got))
            if not equal:
                self.bad(sec, table, where, column, 'sum state value or type differs', want, got)
        if marker == 'x':
            if not x_has or not jeq(value, xv):
                self.bad(sec, table, where, p, 'exceptional sum state differs in extra', value,
                         xv if x_has else '<absent>')
        elif x_has:
            self.bad(sec, table, where, p, 'sum state is also in extra', value, xv)
        elif marker == 'l':
            self.stats['typed sum states ' + table] += 1

    def turn_usage(self, sec, where, field, has, value, x_has, xv,
                  rows, prefix, table, pkey):
        bare = has and isinstance(value, list) and all(_text_ok(v) for v in value)
        marker = (None if not has else 'n' if value is None else 'l' if bare
                  else 'o' if isinstance(value, dict) else 'x')
        self.code(sec, table, where, _cn(prefix, field.src) + '_is', rows.get(table), marker)
        sub = xv if marker == 'o' and x_has and isinstance(xv, dict) else {}
        if marker == 'o' and x_has and not isinstance(xv, dict):
            self.bad(sec, table, where, field.src, 'usage object extra has the wrong shape', dest=xv)
        source = {'keys': value} if bare else value if marker == 'o' else {}
        self.record(sec, where, field.fields, source, rows, sub, _cn(prefix, field.col), table, pkey)
        if marker == 'x':
            if not x_has or not jeq(value, xv):
                self.bad(sec, table, where, field.src, 'exceptional usage object differs in extra', value, xv)
        elif marker != 'o' and x_has:
            self.bad(sec, table, where, field.src, 'usage value is also in extra', value, xv)

    def delivery(self, sec, where, field, has, value, x_has, xv,
                 rows, prefix, table, pkey):
        item_id = pkey[0] if pkey else None
        children = self.d.group('work_item_delivery', ('item_id',), 'stage').get((item_id,), [])
        stages = {r.get('stage'): r for r in children}
        if len(stages) != len(children):
            self.bad(sec, 'work_item_delivery', where, 'stage', 'duplicate stage rows')
        core = {k: v for k, v in value.items() if k not in STAGE} if isinstance(value, dict) else value
        self.obj(sec, where, field, has, core, x_has, xv, rows, prefix, table, pkey)
        for stage in STAGE:
            present = isinstance(value, dict) and stage in value
            claim = value.get(stage) if present else None
            row = stages.pop(stage, None)
            if not present:
                if row is not None:
                    self.bad(sec, 'work_item_delivery', where, stage, 'stage not in source')
                    self.d.take('work_item_delivery', row)
                continue
            if row is None:
                self.bad(sec, 'work_item_delivery', where, stage, 'source stage has no claim row')
                continue
            self.d.take('work_item_delivery', row)
            marker = 'n' if claim is None else 'o' if isinstance(claim, dict) else 'x'
            self.code(sec, 'work_item_delivery', where, 'claim_is', row, marker)
            extra = self.extra_of(sec, 'work_item_delivery', where, row)
            if marker == 'x':
                original = extra.pop('claim', _NA)
                if original is _NA or not jeq(claim, original):
                    self.bad(sec, 'work_item_delivery', where, stage, 'misfit claim differs', claim, original)
            self.record(sec, where + '.' + stage, DELIVERY_CLAIM,
                        claim if marker == 'o' else {}, {'work_item_delivery': row}, extra,
                        '', 'work_item_delivery', (row.get('id'),))
        for stage, row in stages.items():
            self.d.take('work_item_delivery', row)
            self.bad(sec, 'work_item_delivery', where, 'stage', 'unknown stage row', dest=stage)

    def col(self, sec: str, where: str, f: Col, has: bool, val: Any, x_has: bool, xv: Any,
            rows: dict, prefix: str, table: str) -> None:
        t = f.table or table
        row = rows.get(t)
        c = _cn(prefix, f.col)
        exists = self._coltype(sec, t, c, f.kind)
        cols = self.d.columns.get(t, {})
        has_null = c + '_null' in cols
        has_text = f.kind == TS and c + '_text' in cols
        dv = row.get(c) if row else None
        dnull = bool(row) and row.get(c + '_null') is True
        dtext = row.get(c + '_text') if (row and has_text) else None
        typed = dv is not None or dnull or dtext is not None
        if has_null and row and row.get(c + '_null') is False:
            self.bad(sec, t, where, c + '_null', 'false null flag instead of SQL NULL or true')
        if not has:
            if typed:
                self.bad(sec, t, where, c, 'destination holds a value the source does not have',
                         dest=dv if dv is not None else ('null flag' if dnull else dtext))
            if x_has:
                self.bad(sec, t, where, c, 'extra holds a field the source does not have',
                         dest=xv)
            return
        if val is None:
            if (has_null and dnull and dv is None and dtext is None and not x_has) or \
                    (f.kind == JSON and dv == 'null' and not dnull and not x_has):
                self.stats['nulls ' + t] += 1
                return
            if x_has and xv is None and not typed and not has_null:
                self.stats[f'extra {t}.{c} (null)'] += 1
                return
            if has_null and x_has and not typed:
                self.bad(sec, t, where, c, 'null is in extra although the column has a null '
                         'flag', None, xv)
            else:
                self.bad(sec, t, where, c, 'present null not kept (null flag / extra)', None,
                         dv if dv is not None else (xv if x_has else '<absent>'))
            return
        fit = fit_of(f.kind, val) if exists else 'no'
        if f.values and val not in f.values:
            fit = 'no'
        if f.kind == TS and fit != 'no' and not has_text and not _CANON.match(val):
            fit = 'no'                 # no _text column: a non-canonical stamp cannot round-trip
        why = self.matches(f.kind, val, dv, dtext, has_text) if exists else 'no column'
        typed_ok = why == '' and not dnull
        extra_ok = x_has and jeq(xv, val) and not typed
        if typed_ok and not x_has and fit != 'no':
            self.stats['typed ' + t] += 1
            return
        if extra_ok and fit != 'yes':
            self.stats[f'extra {t}.{c}'] += 1
            return
        if fit == 'yes':
            if x_has and not typed:
                self.bad(sec, t, where, c, 'value its column can hold is in extra instead', val, xv)
            elif x_has:
                self.bad(sec, t, where, c, 'value is both in its column and in extra', val, xv)
            elif not typed:
                self.bad(sec, t, where, c, 'value is missing (column and extra empty)', val)
            else:
                self.bad(sec, t, where, c, f'value differs ({why or "null flag set"})', val,
                         dv if dv is not None else dtext)
        elif fit == 'no':
            if x_has and not typed:
                self.bad(sec, t, where, c, 'value differs in extra', val, xv)
            elif typed:
                self.bad(sec, t, where, c, 'value its column cannot hold exactly is in the column'
                         + (' and in extra' if x_has else ''), val,
                         dv if dv is not None else dtext)
            else:
                self.bad(sec, t, where, c, 'value is missing (column and extra empty)', val)
        else:
            self.bad(sec, t, where, c, f'value differs ({why or "in extra"})', val,
                     xv if x_has else (dv if dv is not None else dtext))

    def matches(self, kind: str, v: Any, dv: Any, dtext: Any, has_text: bool) -> str:
        """'' when the typed column holds v exactly, else what differs."""
        if dv is None:
            return 'column empty'
        if kind == TEXT:
            return '' if isinstance(dv, str) and dv == v else 'text'
        if kind == INT:
            return '' if type(dv) is int and type(v) is int and dv == v else 'integer'
        if kind == FLOAT:
            return '' if isinstance(dv, float) and type(v) is float and _feq(dv, v) else 'float'
        if kind == NUM:
            return '' if _num_matches(v, dv) else 'numeric value or int/float type'
        if kind == BOOL:
            return '' if type(dv) is bool and dv == v else 'boolean'
        if kind == JSON:
            try:
                parsed = json.loads(dv)
            except (TypeError, ValueError):
                return 'not JSON'
            return '' if jeq(parsed, v) else 'JSON'
        if kind == TS:
            fit, instant, finer = parse_instant(v)
            if instant is None:
                return 'source is not a timestamp'
            if not isinstance(dv, _dt.datetime) or dv.tzinfo is None:
                return 'not a timestamptz'
            got = dv.astimezone(_UTC)
            delta = abs((got - instant) // _dt.timedelta(microseconds=1))
            if delta > (1 if finer else 0):
                return 'instant'
            if _CANON.match(v):
                return '' if dtext in (None, v) else 'original text'
            if not has_text:
                return 'original text not kept (no _text column)'
            return '' if dtext == v else 'original text'
        raise ValueError(kind)

    def code(self, sec: str, t: str, where: str, col: str, row: dict | None, want: str | None
             ) -> None:
        got = row.get(col) if row else None
        if isinstance(got, str):
            got = got.strip() or None
        if got != want:
            self.bad(sec, t, where, col, f'code {col} differs', want, got)

    def obj(self, sec: str, where: str, f: Obj, has: bool, val: Any, x_has: bool, xv: Any,
            rows: dict, prefix: str, table: str, pkey: tuple | None) -> None:
        t = f.table or table
        p = _cn(prefix, f.col)
        row = rows.get(t)
        if has and isinstance(val, dict):
            self.code(sec, t, where, p + '_is', row, 'o')
            sub = xv if x_has else {}
            if x_has and not isinstance(xv, dict):
                self.bad(sec, t, where, p, 'extra for a flattened object is not an object',
                         dest=xv)
                sub = {}
            self.record(sec, where, f.fields, val, rows, sub, p, t, pkey)
            return
        want = None if not has else ('n' if val is None else 'x')
        self.code(sec, t, where, p + '_is', row, want)
        self.record(sec, where, f.fields, {}, rows, {}, p, t, pkey)    # all parts absent
        if want == 'x':
            if not (x_has and jeq(xv, val)):
                self.bad(sec, t, where, p, 'value of the wrong shape is not kept in extra', val,
                         xv if x_has else '<absent>')
        elif x_has:
            self.bad(sec, t, where, p, 'extra holds an object the source does not have as one',
                     val if has else '<absent>', xv)

    def lst(self, sec: str, where: str, f: Lst, has: bool, val: Any, x_has: bool, xv: Any,
            rows: dict, prefix: str, table: str, pkey: tuple | None) -> None:
        t = f.table or table
        row = rows.get(t)
        code_col = _cn(prefix, f.src) + '_is'
        children = self.d.group(f.ctable, f.fk, f.pos).get(pkey, []) if pkey is not None else []
        if f.gaps:
            children = [r for r in children if r.get(f.pos) is not None]
        # a list goes to its child table when every element fits there: a record list needs
        # objects, a scalar list values its column can hold exactly; else the whole list is
        # in extra (code 'x')
        if has and isinstance(val, list):
            ok = all(isinstance(e, dict) if isinstance(f.elem, Rec) else fit_of(f.elem, e) == 'yes'
                     for e in val)
        else:
            ok = False
        if ok:
            self.code(sec, t, where, code_col, row, 'l')
            if x_has:
                self.bad(sec, t, where, code_col, 'list is both in its table and in extra',
                         val, xv)
            self.children(sec, where, f, val, children)
            return
        want = None if not has else ('n' if val is None else 'x')
        self.code(sec, t, where, code_col, row, want)
        if children:
            self.bad(sec, f.ctable, where, f.src, f'{len(children)} child rows for a list the '
                     'source does not have as a list', val if has else '<absent>')
            for r in children:
                self.d.take(f.ctable, r)
        if want == 'x':
            if not (x_has and jeq(xv, val)):
                self.bad(sec, t, where, f.src, 'value of the wrong shape is not kept in extra',
                         val, xv if x_has else '<absent>')
        elif x_has:
            self.bad(sec, t, where, f.src, 'extra holds a list the source does not have as one',
                     val if has else '<absent>', xv)

    def children(self, sec: str, where: str, f: Lst, val: list, rows: list[dict]) -> None:
        positions = [r.get(f.pos) for r in rows]
        if ((not f.gaps and positions != list(range(len(rows)))) or
                (f.gaps and (any(type(p) is not int or p < 0 for p in positions)
                             or len(set(positions)) != len(positions)))):
            self.bad(sec, f.ctable, where, f.pos, 'child positions have an invalid order or duplicate',
                     dest=positions[:20])
        if len(rows) != len(val):
            self.bad(sec, f.ctable, where, f.src, 'child row count differs', len(val), len(rows))
        for i, (e, r) in enumerate(zip(val, rows)):
            self.d.take(f.ctable, r)
            w = f'{where}[{i}]'
            if isinstance(f.elem, Rec):
                ex = self.extra_of(sec, f.ctable, w, r)
                self.record(sec, w, f.elem.fields, e, {f.ctable: r}, ex, '', f.ctable,
                            tuple(r.get(k) for k in f.elem.key))
                self.current_links(sec, w, f.ctable, r, e)
            else:
                self.col(sec, w, Col('value', f.elem), True, e, False, None, {f.ctable: r}, '',
                         f.ctable)
        for r in rows[len(val):]:
            self.d.take(f.ctable, r)

    def link(self, sec: str, where: str, f: Link, has: bool, val: Any, x_has: bool, xv: Any,
             row: dict | None) -> None:
        did = row.get(f.src + '_id') if row else None
        dtext = row.get(f.src) if row else None
        dnull = bool(row) and row.get(f.src + '_null') is True
        t = 'agents'
        if not has:
            if did is not None or dtext is not None or dnull or x_has:
                self.bad(sec, t, where, f.src + '_id', 'link set for a name the source lacks',
                         dest=did if did is not None else (dtext or xv))
            return
        if val is None:
            if not (dnull and did is None and dtext is None and not x_has):
                self.bad(sec, t, where, f.src + '_id', 'present null link not kept', None,
                         did if did is not None else (dtext or xv))
            return
        if not _text_ok(val):
            if not (x_has and jeq(xv, val) and did is None and dtext is None and not dnull):
                self.bad(sec, t, where, f.src, 'non-name value is not kept in extra', val,
                         xv if x_has else did)
            return
        target = self.agent_by_id.get(did) if did is not None else None
        if x_has:
            self.bad(sec, t, where, f.src, 'link is also in extra', val, xv)
        if target is None:
            self.bad(sec, t, where, f.src + '_id', 'link does not resolve to an agent row', val,
                     did)
        elif target['name'] != val:
            self.bad(sec, t, where, f.src + '_id', 'link points at another agent', val,
                     target['name'])
        elif bool(target['tombstone']) != (val not in self.node_names):
            self.bad(sec, t, where, f.src + '_id', 'link points at the wrong row of that name '
                     '(tombstone versus live)', val, target['name'])
        else:
            self.stats['links resolved ' + ('to tombstones' if target['tombstone'] else
                                            'to agents')] += 1
        if dtext not in (None, val) or dnull:
            self.bad(sec, t, where, f.src, 'link text column differs', val, dtext)

    def toollist(self, sec: str, where: str, has: bool, val: Any, x_has: bool, xv: Any,
                 row: dict | None) -> None:
        tid = row.get('tool_list_id') if row else None
        if has and isinstance(val, list) and all(_text_ok(e) for e in val):
            if x_has:
                self.bad(sec, 'agents', where, 'tool_list_id', 'tool list is also in extra',
                         val, xv)
            if tid is None or tid not in self.tool_list_ids:
                self.bad(sec, 'agents', where, 'tool_list_id', 'no tool list row', val, tid)
                return
            items = self.d.group('tool_list_items', ('list_id',), 'pos').get((tid,), [])
            got = [r.get('tool') for r in items]
            if [r.get('pos') for r in items] != list(range(len(items))) or got != val:
                self.bad(sec, 'tool_list_items', where, 'tool', 'tool list items differ', val,
                         got)
            else:
                self.stats['tool lists resolved'] += 1
            self.used_tool_lists.add(tid)
            return
        if tid is not None:
            self.bad(sec, 'agents', where, 'tool_list_id', 'tool list set for a value that is '
                     'not a list of names', val if has else '<absent>', tid)
        if has:
            if not (x_has and jeq(xv, val)):
                self.bad(sec, 'agents', where, 'last_turn_mcp_tools',
                         'value of the wrong shape is not kept in extra', val,
                         xv if x_has else '<absent>')
        elif x_has:
            self.bad(sec, 'agents', where, 'last_turn_mcp_tools',
                     'extra holds a field the source does not have', dest=xv)


# ------------------------------------------------------------------ sections
class Verifier(Checker):
    def __init__(self, dest: Dest, doc: dict, ignored: Iterable[str]):
        super().__init__(dest)
        self.doc = doc
        self.ignored = set(ignored)
        nodes = doc.get('nodes') if 'nodes' not in self.ignored else None
        self.nodes = nodes if isinstance(nodes, dict) else {}
        self.node_names = set(self.nodes)
        self.agent_by_id: dict[Any, dict] = {}
        self.live_by_name: dict[str, dict] = {}
        self.tomb_by_name: dict[str, dict] = {}
        self.identity_tombs: dict[tuple, list[dict]] = defaultdict(list)
        self.required_identity_tombs: set[tuple] = set()
        self.tool_list_ids: set = set()
        self.used_tool_lists: set = set()
        self.section_state: dict[str, str] = {}

    def run(self) -> None:
        self.sections()
        self.agents()
        settings = {}
        for key, how in SECTIONS.items():
            has = key in self.doc and key not in self.ignored
            val = self.doc.get(key) if has else None
            if how[0] == 'setting':
                if has and not (val is None and self.section_state.get(key) == 'n'):
                    settings[key] = val
                continue
            if has and val is None and self.section_state.get(key) not in (None, 'n'):
                self.bad(key, 'org_sections', key, 'state', 'a null collection is not state n',
                         None, self.section_state.get(key))
            kind = how[0]
            if kind == 'docket':
                self.list_rows(key, 'work_items', ITEM, has, val, list_key=how[1])
            elif kind == 'list':
                self.list_rows(key, how[1], how[2], has, val)
            elif kind == 'dict':
                self.dict_rows(key, how[1], how[2], has, val)
            elif kind in ('agent_list', 'agent_dict'):
                self.agent_rows(key, how[1], how[2], has, val, kind == 'agent_dict')
            elif kind == 'map':
                self.map_rows(key, how[1], how[2], has, val)
            elif kind == 'names':
                self.names_rows(key, how[1], has, val)
        self.settings(settings)
        self.org_extra()
        self.turn_membership()
        self.tombstones()
        self.leftovers()

    # -- top-level order and null state
    def sections(self) -> None:
        want = [k for k in self.doc if k not in self.ignored]
        rows = sorted(self.d.rows('org_sections'), key=lambda r: r.get('ord') or 0)
        for r in rows:
            self.d.take('org_sections', r)
        got = [r.get('key') for r in rows]
        self.section_state = {r.get('key'): (r.get('state') or '').strip() for r in rows}
        if got != want:
            self.bad('*', 'org_sections', '*', 'key', 'top-level keys or their order differ',
                     want, got)
        if [r.get('ord') for r in rows] != list(range(len(rows))):
            self.bad('*', 'org_sections', '*', 'ord', 'section positions are not 0..n-1')
        for k in self.ignored & set(got):
            self.bad(k, 'org_sections', k, 'key', 'an ignored legacy key was converted')
        for k in want:
            st = self.section_state.get(k)
            if st not in (None, 'v', 'n') or (st == 'n' and self.doc[k] is not None):
                self.bad(k, 'org_sections', k, 'state', 'section state differs',
                         'n' if self.doc[k] is None else 'v', st)

    # -- nodes -> agents and the per-agent cold tables
    def agents(self) -> None:
        sec = 'nodes'
        rows = self.d.rows('agents')
        for r in rows:
            self.agent_by_id[r.get('id')] = r
            if r.get('tombstone') and r.get('state') == 'deleted':
                stamp = (r.get('name'), r.get('lineage_born'), r.get('generation'))
                self.identity_tombs[stamp].append(r)
                continue
            target = self.tomb_by_name if r.get('tombstone') else self.live_by_name
            if r.get('name') in target:
                self.bad(sec, 'agents', str(r.get('name')), 'name', 'two agent rows of one name '
                         '(same tombstone state)')
            target[r.get('name')] = r
        self.tool_list_ids = {r.get('id') for r in self.d.rows('tool_lists')}
        nodes = self.doc.get('nodes')
        has = 'nodes' in self.doc and 'nodes' not in self.ignored
        if has and nodes is not None and not isinstance(nodes, dict):
            self.bad(sec, 'agents', '*', 'nodes', 'nodes is not an object')
        live = sorted((r for r in rows if not r.get('tombstone')),
                      key=lambda r: (r.get('ord') is None, r.get('ord') or 0))
        names = [r.get('name') for r in live]
        if names != list(self.nodes):
            self.bad(sec, 'agents', '*', 'name/ord', 'agent rows or their order differ from the '
                     'nodes', len(self.nodes), len(live))
        if [r.get('ord') for r in live] != list(range(len(live))):
            self.bad(sec, 'agents', '*', 'ord', 'agent positions are not 0..n-1')
        texts = {r.get('agent_id'): r for r in self.d.rows('agent_texts')}
        runtime = {r.get('agent_id'): r for r in self.d.rows('agent_runtime')}
        for name, node in self.nodes.items():
            row = self.live_by_name.get(name)
            if row is None:
                self.bad(sec, 'agents', name, 'name', 'node has no agent row')
                continue
            self.d.take('agents', row)
            if not isinstance(node, dict):
                self.bad(sec, 'agents', name, '*', 'node is not an object')
                continue
            aid = row.get('id')
            t_row, r_row = texts.get(aid), runtime.get(aid)
            for t, r in (('agent_texts', t_row), ('agent_runtime', r_row)):
                if r is not None:
                    self.d.take(t, r)
            extra: dict = {}
            for t, r in (('agents', row), ('agent_texts', t_row), ('agent_runtime', r_row)):
                part = self.extra_of(sec, t, name, r)
                for k in part:
                    if k in extra:
                        self.bad(sec, t, name, k, 'field is in the extra of two agent tables')
                extra.update(part)
            self.record(sec, name, NODE, node, {'agents': row, 'agent_texts': t_row,
                                                'agent_runtime': r_row}, extra, '', 'agents',
                        (aid,))
            for flag, payload in PRESENCE.items():
                want = bool(node.get(payload))
                if row.get(flag) is not want:
                    self.bad(sec, 'agents', name, flag, f'presence flag differs from '
                             f'bool({payload})', want, row.get(flag))
                elif want:
                    self.stats['presence flags set'] += 1
    def tombstones(self) -> None:
        """Generic owners and current-identity tombstones serve different references."""
        sec = 'nodes'
        want_tombs = set()
        for node in self.nodes.values():
            if isinstance(node, dict):
                for k in ('parent', 'predecessor', 'successor'):
                    v = node.get(k)
                    if _text_ok(v) and v not in self.node_names:
                        want_tombs.add(v)
        for key in BY_AGENT:
            v = self.doc.get(key)
            if key not in self.ignored and isinstance(v, dict):
                want_tombs.update(k for k in v if k not in self.node_names)
        for name in sorted(set(self.tomb_by_name) - want_tombs, key=str):
            self.bad(sec, 'agents', str(name), 'tombstone', 'tombstone row no source name needs')
        for name in sorted(want_tombs - set(self.tomb_by_name)):
            self.bad(sec, 'agents', name, 'tombstone', 'referenced name has no tombstone row')
        for name, r in self.tomb_by_name.items():
            self.d.take('agents', r)
            data = [c for c, v in r.items() if v is not None and c not in
                    ('id', 'name', 'tombstone', 'row_version', 'ord', *PRESENCE)]
            if data or any(r.get(f) for f in PRESENCE):
                self.bad(sec, 'agents', str(name), ','.join(data) or 'flags',
                         'tombstone row carries data')
        for stamp in self.required_identity_tombs - set(self.identity_tombs):
            self.bad(sec, 'agents', str(stamp), 'tombstone',
                     'current identity has no stamped tombstone')
        for stamp, rows in self.identity_tombs.items():
            if stamp not in self.required_identity_tombs:
                self.bad(sec, 'agents', str(stamp), 'tombstone',
                         'identity tombstone no current source role needs')
            if len(rows) != 1:
                self.bad(sec, 'agents', str(stamp), 'tombstone',
                         'duplicate tombstones for one current identity')
            name, born, generation = stamp
            for row in rows:
                self.d.take('agents', row)
                self.record(sec, str(stamp), NODE,
                            {'state': 'deleted', 'seat_id': born, 'generation': generation},
                            {'agents': row}, self.extra_of(sec, 'agents', str(stamp), row),
                            '', 'agents', (row.get('id'),))
                if row.get('ord') is not None or any(row.get(f) for f in PRESENCE):
                    self.bad(sec, 'agents', str(stamp), 'ord/flags',
                             'identity tombstone carries live placement or presence')

    @staticmethod
    def current_reference(value):
        """Derive a supported current role from authored values, never joined names."""
        if isinstance(value, str):
            value = {'node': value}
        if not isinstance(value, dict):
            return None
        name = value.get('node')
        if (not _text_ok(name) or not name or name in ('user', 'orgtree')
                or name.startswith(('@org:', '@net:'))):
            return None
        born, generation, deleted = (value.get(k) for k in ('born', 'generation', 'deleted'))
        if (born is not None and fit_of(TEXT, born) != 'yes'
                or generation is not None and fit_of(INT, generation) != 'yes'
                or deleted is not None and fit_of(BOOL, deleted) != 'yes'):
            return None
        return name, born or '', generation or 0, deleted or False

    def current_links(self, sec, ent, table, row, src):
        roles = {}
        if table == 'work_items':
            roles = {k + '_agent_id': src.get(k) for k in ('owner', 'reviewer')}
        elif table == 'work_item_holders':
            roles = {'agent_id': src}
        elif table == 'work_item_artifact_grants':
            roles = {'agent_id': src.get('to')}
            artifacts = [a for a in self.d.rows('work_item_artifacts')
                         if a.get('id') == row.get('artifact_id')]
            if len(artifacts) != 1 or row.get('item_id') != artifacts[0].get('item_id'):
                self.bad(sec, table, ent, 'item_id', 'grant belongs to another item or artifact')
        elif table == 'work_item_review_seats':
            reviewer = src.get('reviewer')
            holder = src.get('holder')
            if isinstance(holder, dict) and reviewer == holder.get('node'):
                reviewer = holder
            roles = {'reviewer_agent_id': reviewer, 'holder_agent_id': holder,
                     'recheck_owner_agent_id': src.get('recheck_owner')}
        for column, source in roles.items():
            ref = self.current_reference(source)
            target_id = row.get(column)
            if ref is None:
                if target_id is not None:
                    self.bad(sec, table, ent, column, 'unsupported role has an agent link', source, target_id)
                continue
            name, born, generation, deleted = ref
            node = self.nodes.get(name)
            continuing = False
            if not deleted and isinstance(node, dict):
                try:
                    continuing = (born == str(node.get('seat_id') or '') if born else
                                  int(node.get('generation') or 0) >= generation)
                except (ValueError, TypeError, OverflowError):
                    pass
            if continuing:
                target = self.live_by_name.get(name)
                wanted = target.get('id') if target else None
            else:
                stamp = name, born, generation
                self.required_identity_tombs.add(stamp)
                candidates = self.identity_tombs.get(stamp, [])
                wanted = candidates[0].get('id') if len(candidates) == 1 else None
            if wanted is None or type(target_id) is not int or target_id != wanted:
                self.bad(sec, table, ent, column, 'current role continuity link differs',
                         {'name': name, 'born': born, 'generation': generation,
                          'deleted': deleted, 'id': wanted}, target_id)
            else:
                self.stats['current links verified'] += 1

    # -- lists of records with ord (and work_items by list_key)
    def list_rows(self, sec: str, table: str, fields: list, has: bool, val: Any,
                  list_key: str | None = None) -> None:
        if list_key:
            rows = self.d.group(table, ('list_key',), 'ord').get((list_key,), [])
        else:
            rows = self.d.group(table, (), 'ord').get((), [])
        items = val if (has and isinstance(val, list)) else []
        if has and val is not None and not isinstance(val, list):
            self.bad(sec, table, sec, '*', 'section is not a list')
        self.positional(sec, table, rows, 'ord', len(items))
        for i, (src, row) in enumerate(zip(items, rows)):
            self.d.take(table, row)
            ent = f'{sec}[{i}]'
            if not isinstance(src, dict):
                self.bad(sec, table, ent, '*', 'record is not an object')
                continue
            if table == 'work_items':
                self.item_events(sec, ent, src, row, i, list_key)
                src = {k: v for k, v in src.items() if k not in ITEM_CURRENT and
                       (k not in ITEM_EVENT_SOURCES or not isinstance(v, list))}
                self.docket_projections(sec, ent, src, row)
            self.record(sec, ent, fields, src, {table: row}, self.extra_of(sec, table, ent, row),
                        '', table, (row.get('id'),))
            self.current_links(sec, ent, table, row, src)
        for row in rows[len(items):]:
            self.d.take(table, row)

    def source_extra(self, fields, src, table, prefix=''):
        """Derive exceptional fields from the legacy source and declared SQL types.

        This does not use the destination's extra, mapper code or converter code.
        Column metadata only tells whether a nullable/text companion exists.
        """
        out = {k: v for k, v in src.items() if k not in {f.src for f in fields}}
        for field in fields:
            if field.src not in src:
                continue
            value = src[field.src]
            t = field.table or table
            columns = self.d.columns.get(t, {})
            if isinstance(field, Col):
                column = _cn(prefix, field.col)
                fits = (fit_of(field.kind, value) != 'no' if field.kind in (JSON, TS)
                        else fit_of(field.kind, value) == 'yes')
                if field.values and value not in field.values:
                    fits = False
                if (field.kind == TS and column + '_text' not in columns
                        and (not isinstance(value, str) or not _CANON.match(value))):
                    fits = False
                if value is None:
                    fits = column + '_null' in columns
                if not fits:
                    out[field.src] = value
            elif isinstance(field, Principal):
                if isinstance(value, dict):
                    sub = self.source_extra(_principal_fields(field, _cn(prefix, field.src)),
                                            value, t)
                    if sub:
                        out[field.src] = sub
                elif value is not None and not _text_ok(value):
                    out[field.src] = value
            elif isinstance(field, SumState):
                integer = (isinstance(value, list) and len(value) == 2 and value[0] == 'i'
                           and type(value[1]) is int)
                floating = (isinstance(value, list) and len(value) == 3 and value[0] == 'f'
                            and all(type(v) is float and math.isfinite(v) for v in value[1:]))
                if value is not None and not (integer or floating):
                    out[field.src] = value
            elif isinstance(field, Delivery):
                if isinstance(value, dict):
                    sub = {k: v for k, v in value.items() if k not in STAGE}
                    if sub:
                        out[field.src] = sub
                elif value is not None:
                    out[field.src] = value
            elif isinstance(field, TurnUsage) and isinstance(value, list) and all(_text_ok(v) for v in value):
                continue
            elif isinstance(field, Obj):
                if isinstance(value, dict):
                    sub = self.source_extra(field.fields, value, t, _cn(prefix, field.col))
                    if sub:
                        out[field.src] = sub
                elif value is not None:
                    out[field.src] = value
            elif isinstance(field, Lst):
                supported = (isinstance(value, list) and all(isinstance(v, dict)
                    if isinstance(field.elem, Rec) else fit_of(field.elem, v) == 'yes' for v in value))
                if value is not None and not supported:
                    out[field.src] = value
            elif isinstance(field, (Link, ToolList)):
                supported = (_text_ok(value) if isinstance(field, Link) else
                             isinstance(value, list) and all(_text_ok(v) for v in value))
                if value is not None and not supported:
                    out[field.src] = value
        return out

    def docket_projections(self, sec, ent, src, row):
        extras = self.source_extra(ITEM, src, 'work_items')
        policy_keys = set(('slug rev kind title status owner reviewer created_by participants at '
                           'updated_at docket_at archived_at manual_attention manual_attention_rev '
                           'parent superseded_by').split())
        list_keys = set(('slug rev kind title objective status blocked_reason waiting_reason dropped_reason '
                         'owner reviewer created_by last_updater participants at updated_at docket_at status_at '
                         'archived_at done_so_far working_on_next manual_attention dependencies superseded_by '
                         'parent post_completion scope_seq scope_guard scope_logged scope_rolled scope_frozen '
                         'legacy_status').split())
        for column, keys in (('docket_policy_extra', policy_keys), ('docket_list_extra', list_keys)):
            self._coltype(sec, 'work_items', column, JSON)
            want = {k: v for k, v in extras.items() if k in keys} or None
            value = row.get(column)
            try:
                got = json.loads(value) if value is not None else None
            except (ValueError, TypeError):
                got = _NA
            if got is _NA or not jeq(want, got):
                self.bad(sec, 'work_items', ent, column, 'docket projection differs from legacy source', want, got)
            else:
                self.stats['docket projections verified'] += 1

    def item_events(self, sec: str, ent: str, src: dict, row: dict, position: int,
                    list_key: str | None) -> None:
        """Check the fresh conversion's complete retained sequence and current pointers.

        Conversion assigns identities in active/archive order and source rank order,
        without inventing chronology. Original bodies, including legacy event IDs,
        are checked separately from query headers. This is a conversion verifier,
        not an oracle for identities allocated by later application writes.
        """
        active = self.doc.get('work_items') or []
        previous = list(active[:position]) if list_key == 'active' else list(active)
        if list_key == 'archive':
            previous += list((self.doc.get('work_items_archive') or [])[:position])
        item_id = len(previous) + 1
        event_id = 1 + sum(len(item.get(s, [])) for item in previous if isinstance(item, dict)
                           for s in ITEM_EVENT_SOURCES if isinstance(item.get(s), list))
        for column, want in (('id', item_id), ('archive_seq', item_id if list_key == 'archive' else None)):
            if row.get(column) != want:
                self.bad(sec, 'work_items', ent, column, 'conversion identity differs', want, row.get(column))
        archive = src.get('scope_archive')
        archive = archive if isinstance(archive, list) else []
        def endpoint(value):
            return {k: value.get(k) if isinstance(value, dict) else None for k in ('seq', 'at')}
        scope_meta = {'archive_count': len(archive),
                      'first': endpoint(archive[0] if archive else None),
                      'last': endpoint(archive[-1] if archive else None),
                      'inline_count': len(src['scope']) if isinstance(src.get('scope'), list) else None}
        if self.matches(JSON, scope_meta, row.get('docket_scope_meta'), None, False):
            self.bad(sec, 'work_items', ent, 'docket_scope_meta', 'scope metadata differs',
                     scope_meta, row.get('docket_scope_meta'))
        events = self.d.group('work_item_events', ('item_id',), 'seq').get((row.get('id'),), [])
        expected = []
        for source in ITEM_EVENT_SOURCES:
            value = src.get(source)
            marker = (None if source not in src else 'n' if value is None
                      else 'l' if isinstance(value, list) else 'x')
            self.code(sec, 'work_items', ent, source + '_events_is', row, marker)
            if isinstance(value, list):
                expected.extend((source, value) for value in value)
        if len(events) != len(expected):
            self.bad(sec, 'work_item_events', ent, '*', 'retained event count differs', len(expected), len(events))
        for offset, ((source, value), event) in enumerate(zip(expected, events)):
            self.d.take('work_item_events', event)
            where = f'{ent}.{source}[{offset}]'
            want = self.event_header(source, value)
            want.update(id=event_id + offset, item_id=item_id, seq=offset + 1, source=source)
            for column, kind in ITEM_EVENT_HEADERS.items():
                self._coltype(sec, 'work_item_events', column, kind)
                got = event.get(column)
                if kind == JSON and column in want:
                    try:
                        equal = jeq(want[column], json.loads(got))
                    except (TypeError, ValueError):
                        equal = False
                elif kind == TS:
                    equal = got == want.get(column)
                else:
                    equal = jeq(got, want.get(column))
                if not equal:
                    self.bad(sec, 'work_item_events', where, column, 'event header or identity differs',
                             want.get(column), got)
            self.record(sec, where, ITEM_EVENT_FIELDS, {source: value}, {'work_item_events': event},
                        self.extra_of(sec, 'work_item_events', where, event), '', 'work_item_events', (event.get('id'),))
        for event in events[len(expected):]:
            self.d.take('work_item_events', event)
        for field, (source, column, kind) in ITEM_CURRENT.items():
            value = src.get(field)
            marker = None if field not in src else 'n' if value is None else 'v'
            self.code(sec, 'work_items', ent, column + '_is', row, marker)
            candidates = [event_id + offset for offset, (s, body) in enumerate(expected)
                          if s == source and jeq(value, body)] if marker == 'v' else []
            want = candidates[-1] if candidates else None
            if marker == 'v' and not candidates:
                self.bad(sec, 'work_items', ent, field, 'current value matches no retained event', value)
            if row.get(column) != want:
                self.bad(sec, 'work_items', ent, column, 'current pointer differs', want, row.get(column))
            if row.get(column + '_kind') != kind:
                self.bad(sec, 'work_items', ent, column + '_kind', 'current pointer kind differs', kind,
                         row.get(column + '_kind'))

    @staticmethod
    def event_header(source: str, value: Any) -> dict:
        """Independently derive the migration's query fields from the source body."""
        record = value if isinstance(value, dict) else {}
        actor = record.get('by')
        actor = actor if isinstance(actor, dict) else {'node': actor}
        kind = {'candidate_verdicts': 'verdict', 'review_packets': 'review_packet',
                'dismissals': 'dismissal', 'quick_staff_receipts': 'quick_staff_receipt'}.get(source, source)
        if source in ('scope', 'scope_archive'):
            kind = 'decision' if record.get('kind') == 'decision' else 'scope'
        at = record.get('at')
        instant = parse_instant(at)[1] if isinstance(at, str) and len(at) >= 16 else None
        content = next((record[k] for k in ('text', 'note', 'reason') if isinstance(record.get(k), str)), None)
        changes = record.get('changes')
        status = (source == 'history' and record.get('kind') != 'folded' and bool(at) and
                  (record.get('op') in ('accept', 'reopen', 'supersede') or
                   (record.get('op') == 'update' and isinstance(changes, dict) and 'status' in changes) or
                   (record.get('op') == 'dismiss_attention' and record.get('from') != 'blocked')))
        out = {'kind': kind, 'at': instant, 'status_change': status,
               'content': content if fit_of(TEXT, content) == 'yes' else None}
        for key, typ in (('node', TEXT), ('generation', INT), ('born', TEXT)):
            out['by_' + key] = actor.get(key) if fit_of(typ, actor.get(key)) == 'yes' else None
        if 'at' in record:
            out['original_at'] = record['at']
        if 'seq' in record:
            out['original_scope_seq'] = record['seq']
        return out

    def positional(self, sec: str, table: str, rows: list, pos: str, n: int,
                   ent: str | None = None) -> None:
        got = [r.get(pos) for r in rows]
        if got != list(range(len(rows))):
            self.bad(sec, table, ent or sec, pos, f'{pos} values are not 0..n-1')
        if len(rows) != n:
            self.bad(sec, table, ent or sec, '*', 'row count differs', n, len(rows))

    def dict_rows(self, sec: str, table: str, fields: list, has: bool, val: Any) -> None:
        rows = self.d.group(table, (), 'ord').get((), [])
        items = list(val.items()) if (has and isinstance(val, dict)) else []
        if has and val is not None and not isinstance(val, dict):
            self.bad(sec, table, sec, '*', 'section is not an object')
        self.positional(sec, table, rows, 'ord', len(items))
        self.keyed(sec, table, fields, items, rows, sec)

    def keyed(self, sec: str, table: str, fields: list, items: list, rows: list,
              ent0: str) -> None:
        for (k, src), row in zip(items, rows):
            self.d.take(table, row)
            ent = f'{ent0}[{k}]'
            if row.get('key') != k:
                self.bad(sec, table, ent, 'key', 'record key differs', k, row.get('key'))
            if not isinstance(src, dict):
                self.bad(sec, table, ent, '*', 'record is not an object')
                continue
            self.record(sec, ent, fields, src, {table: row}, self.extra_of(sec, table, ent, row),
                        '', table, (row.get('id'),))
        for row in rows[len(items):]:
            self.d.take(table, row)

    def map_rows(self, sec: str, table: str, kind: str, has: bool, val: Any) -> None:
        rows = self.d.group(table, (), 'ord').get((), [])
        items = list(val.items()) if (has and isinstance(val, dict)) else []
        self.positional(sec, table, rows, 'ord', len(items))
        for (k, v), row in zip(items, rows):
            self.d.take(table, row)
            ent = f'{sec}[{k}]'
            if row.get('key') != k:
                self.bad(sec, table, ent, 'key', 'map key differs', k, row.get('key'))
            self.record(sec, ent, [Col('value', kind)], {'value': v}, {table: row},
                        self.extra_of(sec, table, ent, row), '', table, None)
        for row in rows[len(items):]:
            self.d.take(table, row)

    def names_rows(self, sec: str, table: str, has: bool, val: Any) -> None:
        rows = self.d.group(table, (), 'ord').get((), [])
        items = val if (has and isinstance(val, list)) else []
        self.positional(sec, table, rows, 'ord', len(items))
        for i, (v, row) in enumerate(zip(items, rows)):
            self.d.take(table, row)
            if row.get('value') != v:
                self.bad(sec, table, f'{sec}[{i}]', 'value', 'name differs', v, row.get('value'))
        for row in rows[len(items):]:
            self.d.take(table, row)

    # -- per-agent sections: owners (order, state) and each agent's rows
    def agent_rows(self, sec: str, table: str, fields: list, has: bool, val: Any,
                   keyed: bool) -> None:
        owners = sorted((r for r in self.d.rows('org_section_owners') if r.get('section') == sec),
                        key=lambda r: r.get('ord') or 0)
        for r in owners:
            self.d.take('org_section_owners', r)
        entries = list(val.items()) if (has and isinstance(val, dict)) else []
        if has and val is not None and not isinstance(val, dict):
            self.bad(sec, table, sec, '*', 'section is not an object')
        names = [self.agent_by_id.get(r.get('agent_id'), {}).get('name') for r in owners]
        if names != [k for k, _ in entries]:
            self.bad(sec, 'org_section_owners', sec, 'agent_id', 'owner keys or their order '
                     'differ', len(entries), len(owners))
        if [r.get('ord') for r in owners] != list(range(len(owners))):
            self.bad(sec, 'org_section_owners', sec, 'ord', 'owner positions are not 0..n-1')
        by_owner = self.d.group(table, ('agent_id',), 'idx')
        if table == 'agent_turns':
            by_owner = {k: [r for r in rows if r.get('idx') is not None]
                        for k, rows in by_owner.items()}
            by_owner = {k: rows for k, rows in by_owner.items() if rows}
        seen = set()
        for i, (name, v) in enumerate(entries):
            ent = f'{sec}[{name}]'
            row = self.live_by_name.get(name) if name in self.node_names else \
                self.tomb_by_name.get(name)
            if row is None:
                continue                      # reported with the tombstones
            aid = row.get('id')
            seen.add(aid)
            own = owners[i] if i < len(owners) else None
            want = 'n' if v is None else ('o' if isinstance(v, dict) else 'l')
            if own is None or own.get('agent_id') != aid or (own.get('state') or '').strip() != want:
                self.bad(sec, 'org_section_owners', ent, 'state', 'owner entry differs', want,
                         None if own is None else (own.get('state') or '').strip())
            rows = by_owner.get((aid,), [])
            if keyed:
                items = list(v.items()) if isinstance(v, dict) else []
                if v is not None and not isinstance(v, dict):
                    self.bad(sec, table, ent, '*', 'agent entry is not an object')
                self.positional(sec, table, rows, 'idx', len(items), ent)
                self.keyed(sec, table, fields, items, rows, ent)
                continue
            items = v if isinstance(v, list) else []
            if v is not None and not isinstance(v, list):
                self.bad(sec, table, ent, '*', 'agent entry is not a list')
            self.positional(sec, table, rows, 'idx', len(items), ent)
            for j, (src, r) in enumerate(zip(items, rows)):
                self.d.take(table, r)
                e = f'{ent}[{j}]'
                if not isinstance(src, dict):
                    self.bad(sec, table, e, '*', 'record is not an object')
                    continue
                self.record(sec, e, fields, src, {table: r}, self.extra_of(sec, table, e, r),
                            '', table, (r.get('id'),))
            for r in rows[len(items):]:
                self.d.take(table, r)
        for (aid,), rows in by_owner.items():
            if aid not in seen:
                name = self.agent_by_id.get(aid, {}).get('name')
                self.bad(sec, table, f'{sec}[{name}]', 'agent_id', f'{len(rows)} rows for an '
                         'agent the section does not key')

    def turn_membership(self) -> None:
        """Independently match ordered exact occurrences, without a mapper or digest."""
        logs = self.doc.get('turn_log') if 'turn_log' not in self.ignored else None
        logs = logs if isinstance(logs, dict) else {}
        groups = self.d.group('agent_turns', ('agent_id',), 'recent_pos')
        for name, node in self.nodes.items():
            if not isinstance(node, dict):
                continue
            recent = node.get('turns')
            if not isinstance(recent, list) or not all(isinstance(v, dict) for v in recent):
                recent = []
            logged = logs.get(name)
            logged = logged if isinstance(logged, list) else []
            expected = [None] * len(recent)
            ceiling = len(logged)
            for pos in range(len(recent) - 1, -1, -1):
                for index in range(ceiling - 1, -1, -1):
                    if jeq(recent[pos], logged[index]):
                        expected[pos] = index
                        ceiling = index
                        break
            aid = self.live_by_name.get(name, {}).get('id')
            rows = groups.get((aid,), [])
            selected = [r for r in rows if r.get('recent_pos') is not None]
            if [r.get('idx') for r in selected] != expected:
                self.bad('nodes', 'agent_turns', name, 'idx/recent_pos',
                         'shared turn membership differs', expected, [r.get('idx') for r in selected])
            wanted_count = len(logged) + sum(index is None for index in expected)
            if len(rows) != wanted_count:
                self.bad('nodes', 'agent_turns', name, '*', 'unified turn payload count differs',
                         wanted_count, len(rows))
            self.stats['turn membership occurrences verified'] += len(recent)

    # -- org_settings and org_extra
    def settings(self, settings: dict) -> None:
        rows = self.d.rows('org_settings')
        for r in rows:
            self.d.take('org_settings', r)
        row = rows[0] if rows else None
        if len(rows) > 1:
            self.bad('settings', 'org_settings', '*', '*', 'more than one settings row')
        self.record('settings', '', SETTINGS, settings, {'org_settings': row},
                    self.extra_of('settings', 'org_settings', 'settings', row), '',
                    'org_settings', None)

    def org_extra(self) -> None:
        rows = {r.get('key'): r for r in self.d.rows('org_extra')}
        want = {k: v for k, v in self.doc.items() if k not in SECTIONS and k not in self.ignored}
        for k, v in want.items():
            r = rows.pop(k, None)
            if r is None:
                self.bad(k, 'org_extra', k, 'val', 'unregistered key is not in org_extra', v)
                continue
            self.d.take('org_extra', r)
            try:
                got = json.loads(r.get('val'))
            except (TypeError, ValueError):
                got = _NA
            if got is _NA or not jeq(got, v):
                self.bad(k, 'org_extra', k, 'val', 'unregistered key differs in org_extra', v,
                         r.get('val'))
        for k, r in rows.items():
            self.d.take('org_extra', r)
            self.bad(k, 'org_extra', k, 'val', 'org_extra holds a key the source does not have'
                     if k not in self.ignored else 'an ignored legacy key was converted')

    # -- rows no source entity accounts for, unmapped columns, unknown tables
    def leftovers(self) -> None:
        for tid in self.tool_list_ids - self.used_tool_lists:
            self.bad('nodes', 'tool_lists', str(tid), 'id', 'tool list no agent uses')
        for r in self.d.rows('tool_lists'):
            self.d.take('tool_lists', r)
        for r in self.d.rows('tool_list_items'):
            if r.get('list_id') in self.used_tool_lists:
                self.d.take('tool_list_items', r)
        known = known_columns()
        for table in sorted(self.d.columns):
            if table in OUTSIDE:
                continue
            if table not in known:
                n = len(self.d.rows(table))
                self.notes.append(f'table {table} ({n} rows) is outside the document; '
                                  'not verified')
                continue
            rows = self.d.rows(table)
            left = [r for r in rows if id(r) not in self.d.used[table]]
            if left:
                self.bad('*', table, '*', '*', f'{len(left)} rows no source entity accounts for')
            for c in self.d.columns[table]:
                if c in known[table] or c in DERIVED.get(table, ()):
                    continue
                n = sum(1 for r in rows if r.get(c) is not None)
                if n:
                    self.bad('*', table, '*', c, f'unmapped column holds values in {n} rows')
                else:
                    self.notes.append(f'column {table}.{c} is not in the verifier\'s '
                                      'correspondence (empty)')


# ------------------------------------------------------------------ entry points
def verify_report(source_doc: dict, dest_conninfo: str, *,
                  ignored_keys: Iterable[str] = IGNORED_DEFAULT) -> dict:
    """{'problems': [...], 'notes': [...]} for one org: source document against destination."""
    import psycopg   # noqa: PLC0415  the bundled runtime carries it
    if not isinstance(source_doc, dict):
        raise TypeError('source_doc must be the org document (a dict of top-level sections)')
    with psycopg.connect(dest_conninfo, autocommit=True) as conn:
        conn.execute("SET TIME ZONE 'UTC'")
        conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try:
            v = Verifier(Dest(conn), source_doc, ignored_keys)
            v.run()
        finally:
            conn.execute('ROLLBACK')
    return {'problems': v.problems, 'notes': v.notes, 'stats': dict(sorted(v.stats.items()))}


def verify(source_doc: dict, dest_conninfo: str, *,
           ignored_keys: Iterable[str] = IGNORED_DEFAULT) -> list[dict]:
    """Problems found comparing the destination org database with the source document;
    an empty list means verified."""
    return verify_report(source_doc, dest_conninfo, ignored_keys=ignored_keys)['problems']


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def manifest(paths: list[str]) -> dict[str, str]:
    """sha256 of every file under ``paths`` (files, or folders walked recursively), keyed by
    absolute path. A folder is recorded as 'dir' and a missing path as 'missing', so that a
    vanished file or folder shows in a before/after comparison."""
    out: dict[str, str] = {}
    for p in paths:
        root = Path(p).absolute()
        if root.is_file():
            out[str(root)] = sha256_file(root)
        elif root.is_dir():
            out[str(root)] = 'dir'
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames.sort()
                for d in dirnames:
                    out[str(Path(dirpath) / d)] = 'dir'
                for name in sorted(filenames):
                    f = Path(dirpath) / name
                    out[str(f)] = sha256_file(f)
        else:
            out[str(root)] = 'missing'
    return out


def manifest_changes(before: dict[str, str], after: dict[str, str]) -> list[dict]:
    """What differs between two manifests: each path added, removed or changed."""
    out = []
    for path in sorted(set(before) | set(after)):
        a, b = before.get(path), after.get(path)
        if a != b:
            out.append({'path': path, 'before': a, 'after': b,
                        'change': 'added' if a is None else 'removed' if b is None else 'changed'})
    return out


def summarize(problems: list[dict]) -> dict[str, int]:
    """Problem counts by section / table / field / problem: no values, no names."""
    out: dict[str, int] = defaultdict(int)
    for p in problems:
        out[f"{p['section']} | {p['table']} | {p['field']} | {p['problem']}"] += 1
    return dict(sorted(out.items()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--source', help='the org document (JSON) as today\'s loader gives it')
    ap.add_argument('--dest', help='conninfo of the converted org database')
    ap.add_argument('--ignore', nargs='*', default=list(IGNORED_DEFAULT),
                    help='ignored legacy top-level keys')
    ap.add_argument('--manifest', nargs='+', help='print a sha256 manifest of these paths')
    ap.add_argument('--compare-manifests', nargs=2, metavar=('BEFORE', 'AFTER'),
                    help='two --json-output files of --manifest: list what changed')
    ap.add_argument('--show-values', action='store_true',
                    help='print each problem with its entity and values (never on real data)')
    ap.add_argument('--json-output', help='write the full result here')
    args = ap.parse_args(argv)
    try:
        if args.manifest:
            result: dict[str, Any] = {'manifest': manifest(args.manifest)}
            print(f'{len(result["manifest"])} entries')
        elif args.compare_manifests:
            sides = []
            for p in args.compare_manifests:
                with open(p, encoding='utf-8') as f:
                    sides.append(json.load(f)['manifest'])
            result = {'problems': manifest_changes(*sides)}
            print(f'{len(result["problems"])} paths differ')
        elif args.source and args.dest:
            with open(args.source, encoding='utf-8') as f:
                doc = json.load(f)
            result = verify_report(doc, args.dest, ignored_keys=args.ignore)
            result['summary'] = summarize(result['problems'])
            print(f'{len(result["problems"])} problems')
            for line, n in result['summary'].items():
                print(f'  {n:6d}  {line}')
            for note in result['notes']:
                print(f'  note: {note}')
            compared = sum(n for k, n in result['stats'].items() if not k.startswith('records'))
            print(f'  compared {compared} values in '
                  f'{sum(n for k, n in result["stats"].items() if k.startswith("records"))} '
                  'records (counts per table in --json-output)')
            if args.show_values:
                for p in result['problems']:
                    print(json.dumps(p, ensure_ascii=False))
        else:
            ap.error('give --source and --dest, or --manifest')
            return 2
    except Exception as exc:  # noqa: BLE001  the CLI reports, it does not trace
        print(f'could not verify: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 2
    if args.json_output:
        Path(args.json_output).write_text(json.dumps(result, indent=1, ensure_ascii=False),
                                          encoding='utf-8')
    return 1 if result.get('problems') else 0


if __name__ == '__main__':
    sys.exit(main())
