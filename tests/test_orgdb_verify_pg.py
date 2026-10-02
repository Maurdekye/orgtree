"""The independent destination verifier against a real converted org database (§5.4 check 1).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module creates is named with
                               its own prefix t<pid>_ and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

The destination is built by the REAL converter's sections (encode_document, rowio.write, the
lifecycle's open_build / mark_filled / publish, as tests/test_orgdb_mappers_pg.py does) from a
synthetic document that holds every key of ledger.NODE_KEYED_SECTIONS plus 'chain_notices' and
'release', the two ignored legacy keys and an unregistered key. Only this TEST imports
orgtree.orgdb; tools/orgdb_verify.py does not (tests/test_orgdb_verify_static.py).

What it proves:
  * the clean conversion verifies with no problems, and the verifier really compared it (records
    of every section, typed values, links, tool lists, values held in extra);
  * a source that differs from what was converted is reported;
  * each PLANTED CORRUPTION, alone (committed into the clean database, then undone; a digest of
    every table's rows proves the undo exact), with every table's row count unchanged, is
    reported, naming the corrupted table: a text field in agents, a
    timestamp moved by 1 ms, a boolean flipped, a _null flag cleared, a parent_id pointed at
    another agent, a mail body, a docket history entry, a list's order swapped, a value moved
    into extra, a docket slug, and more (numeric type, per-agent ownership, a JSON payload, a
    tool list, the top-level order, a nested docket value, a code, an original timestamp text,
    org_extra, two agent names swapped, the agent order, a per-agent entry's state, an item
    moved between the docket lists, a value inside extra, a presence flag);
  * the MUTANT: a verifier that only compares row counts passes the clean database and misses
    every one of those corruptions, so the corruption test fails under it (it has teeth).

Run:  python tools/run-python-verification.py --timeout 1200 tests/test_orgdb_verify_pg.py
"""

import contextlib
import copy
import importlib.util
import os
from pathlib import Path
import sys
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.orgdb import conn, lifecycle, mappers, sections  # noqa: E402
from orgtree.orgdb.convert import rowio  # noqa: E402

_SPEC = importlib.util.spec_from_file_location(
    'orgdb_verify', Path(__file__).resolve().parents[1] / 'tools' / 'orgdb_verify.py')
ov = importlib.util.module_from_spec(_SPEC)
sys.modules['orgdb_verify'] = ov
_SPEC.loader.exec_module(ov)

T = '2026-10-02T10:00:00.000Z'
T2 = '2026-09-01T00:00:00.000Z'
BY = {'node': 'boss', 'generation': 0}


def node(**kw):
    base = {'session_id': 's', 'seat_id': 'seat', 'model': 'm', 'parent': None, 'grant': 5,
            'state': 'live', 'title': 't', 'charter': None, 'created': T,
            'archived_at': None, 'ui_order': 1.0, 'generation': 0, 'lineage': 'l',
            'scope': {'permission_mode': 'p', 'org_visibility': 'team', 'effort': 'high',
                      'add_dirs': [{'path': 'x', 'mode': 'rw'}, {'path': 'y', 'mode': 'ro'}],
                      'tools': {'bash': True, 'web': False, 'edit': True, 'subagents': False,
                                'mcp': ['a', 'b']}},
            'turns': [{'n': 1, 'at': T, 'cost': 0.5, 'ms': 10, 'denials': 0, 'route': {'r': 1}}],
            'frozen': None, 'prev_status': {'status': 'idle', 'summary': 's', 'at': T}}
    base.update(kw)
    return base


def item(slug, **kw):
    base = {'slug': slug, 'rev': 1, 'kind': 'task', 'title': 'T ' + slug, 'objective': 'O',
            'status': 'open', 'blocked_reason': None, 'waiting_reason': None,
            'dropped_reason': None, 'owner': {'node': 'x', 'generation': 0, 'born': 'b'},
            'reviewer': None, 'created_by': BY, 'last_updater': BY, 'participants': [],
            'at': T, 'updated_at': T, 'docket_at': T, 'status_at': T, 'archived_at': None,
            'done_so_far': [], 'working_on_next': [], 'manual_attention': None,
            'manual_attention_rev': 0, 'dismissals': [], 'acceptance': [], 'dependencies': [],
            'evidence': [], 'delivery': None, 'accepted': None, 'history': [],
            'superseded_by': None, 'parent': None, 'holders': []}
    base.update(kw)
    return base


def document():
    tools = ['orgtree_message', 'orgtree_work']
    return {
        'version': 3, 'slug': 'acme', 'name': 'Acme', 'created': '2026-01-01T00:00:00Z',
        'workspace': 'C:/ws', 'permission_mode': 'default', 'default_visibility': 'team',
        'default_effort': 'high', 'max_top_grant': 100, 'default_top_grant': 7.5,
        'compact_at': 0.8, 'max_children': 12, 'max_depth': None, 'fable_limit_policy': 'p',
        'fable_filter_policy': 'q', 'fable_filter_model': 'fm', 'fable_api_fallback': {'on': True},
        'fable_lock': None, 'cascade_hire': True, 'cascade_alloc': False, 'auto_resume': True,
        'auto_resume_compact': False, 'auto_resume_last': 1.5,
        'auto_cheap_compact': {'enabled': True, 'occ': 0.7},
        'default_tools': {'bash': True, 'mcp': ['a']}, 'default_dirs': [{'path': 'x'}],
        'default_account': None, 'account_fallback_default': {'a': 1},
        'account_token_uuid': 'uuid-1', 'killswitch': None, 'net_autoconnect': True,
        'net_identity': {'id': 'n'}, 'net_spool': {'h': []}, 'external_inbox_multi_holder': False,
        'org_inbox_multi_holder': True, 'org_inbox_read': 3, 'mail_drain_version': 2,
        'reply_incarnation': 'ri', 'work_identity': 'wi', 'whole_grants_v1': True,
        '_actors_typed': True, 'deleted_cost_usd': 0, 'deleted_cost_usd_unknown': False,
        'api_cost_usd': 1.25, 'api_fallback': None, 'api_fallback_since': T2,
        'api_fallback_until': None, 'api_key': {'k': 'v'}, 'bridge_credential_generation': 4,
        'bridge_credential_rotated_at': T2, 'cred_warned_at': None, 'headless': False,
        'desktop_import': {'source_root': 'r', 'warnings': ['w']}, 'op_receipts_meta': {'v': 1},
        'tool_result_receipts': {}, 'sandbox': {'enabled': True}, 'sandbox_vols_base': 'b', 'disk': {'gb': 1},
        'storage_blocked': False, 'storage_frozen': None, 'storage_full': False,
        'storage_warned': T2, 'chain_notices': [], 'release': '3.1.0',
        'tiers': {'opus': 15, 'haiku': 0.25}, 'models': {'opus': 'o-5', 'haiku': 'h-4'},
        'kiosk': {'token': 'old'}, 'spend_frozen': None,
        'nodes': {
            'boss': node(last_turn_mcp_tools=tools, mailbox_id='mb1', mail_seq=3,
                         team_charter='team', cost_usd=1.5, context_window=200000,
                         occupancy=None, last_status=None, account_primary=True,
                         last_denials=[], turn_est_cost=['x', 1.5, 2], turn_seq=4,
                         docket_reminder_at=T, cli_compactions=2),
            'x': node(parent='boss', successor='x@0', last_turn_mcp_tools=list(tools),
                      frozen={'until': 1}, charter='do it', team_charter=None,
                      halt={'phase': 'halting', 'at': T}, inflight={'at': T, 'text': 'q'},
                      last_denials=[{'tool': 't', 'arg': 'a', 'cwd': 'c'}],
                      last_approvals=[{'tool': 'u', 'arg': 'b'}],
                      halt_queue=[{'_halt_id': 'h', 'toks': ['t1', 't2'], 'mail_ids': [],
                                   'at': 1.5, 'text': 'x', 'view': 'v', 'ping': True,
                                   'ping_reason': None, 'from': 'boss', 'delivery_id': 'd',
                                   'claim': {'c': 1}}],
                      last_status={'status': 'busy', 'summary': 'w', 'at': T}),
            'x@0': node(parent='gone-boss', predecessor='x', state='archived',
                        archived_at='2026-10-01T00:00:00.000Z', generation=1,
                        mail_drain={'ids': ['m1', 'm3'], 'failures': 0, 'retry_at': 5,
                                    'suspended': True},
                        surprise_field=[1], lost_reason='gone', bearer_state='archived',
                        successor=None),
            'odd': node(grant=2.5, ui_order=2, created='not a time', title='nul\x00here',
                        docket_reminder_at='2026-10-02T10:00:00.123456+00:00',
                        session_began_at='2026-10-02 10:00:00Z',
                        last_status={'status': 's', 'summary': 'u',
                                     'at': '2026-10-02T10:00:00+02:00', 'more': 1},
                        scope={'permission_mode': 'p', 'mystery': 7,
                               'tools': {'bash': 'yes', 'zap': 1}},
                        turns=[{'n': 2, 'at': '2026-10-02 10:00:00', 'cost': 1, 'weird': True}],
                        pending_switch={'to': 'm'}, remote_controlled={'at': T}, pid=None,
                        codex_usage_total={'totalTokens': 5}, envelope={'usage': {'a': 1}}),
            'gen2': node(predecessor='gone-pred', parent='boss', last_turn_mcp_tools=[],
                         account='acct', codex_thread='th', mail_drain=None),
        },
        'mail': {'boss': [{'id': 'm1', 'from': 'x', 'kind': 'k', 'body': 'hi', 'at': T,
                           'relationship': 'r', 'restart_notice': True, 'ev': {'v': 1},
                           'recv_seq': 1, 'seq_origin': 'o', 'mailbox': 'mb1',
                           'message_id': 'msg1', 'operation_id': 'op1', 'redelivered': 1}],
                 'x': [], 'x#orphan-abc123def456': [{'id': 'm2', 'body': 'old'}], 'x@0': None},
        'mail_log': {'x': [{'id': 'L1', 'from': 'boss', 'kind': 'k', 'body': 'b', 'at': T,
                            'relationship': 'r', 'attachments': [{'name': 'f', 'path': 'p',
                                                                  'bytes': 3}],
                            'attachments_missing': ['q'], 'stale': True, 'stale_at': T,
                            'stale_revision': 2, 'stale_candidate': None,
                            'reply_to': {'id': 'x'}, 'client_op': 'c', 'model_only': False,
                            'retracted': True, 'net_id': 'n', 'message_id': 'mm',
                            'operation_id': 'oo', 'ev': {'e': [1, None]}}]},
        'notices': {'x': [{'at': T, 'text': 'n1', 'ev': {'v': 1}},
                          {'at': T, 'text': 'n2', 'ev': None}]},
        'delivering': {'x': [{'tok': 'tk', 'at': T, 'mail': [{'id': 'm9'}], 'notices': [],
                              'via': 'v', 'mode': 'm', 'attempt': 1, 'drive': None,
                              'segments': [], 'custody': {'mailbox': 'mb', 'generation': 1,
                                                          'session': 's'},
                              'claim': {'delivery_id': 'd', 'tool_use_id': 'u',
                                        'claimed_at': 1.5, 'lease_until': 2.5},
                              'attempts': 2, 'delivery_ids': ['d1', 'd2'], 'engines': [1, 2],
                              'manual': {'x': 1}}]},
        'steered_log': {'x': [{'at': T, 'text': 'hi', 'level': 'l', 'segments': [{'kind': 'k'}],
                               'visible_id': 'v', 'delivery_id': 'd', 'mail_ids': ['m1'],
                               'delivery_ids': ['d1'], 'acked_ids': [], 'recorded_ids': ['r'],
                               'attempts': 1, 'retried': False, 'confirmed_duplicate': False,
                               'fold': 2, 'where': 'w', 'outcome': 'o'},
                              {'at': T, 'text': 'plain'}]},
        'turn_error_log': {'boss': [{'at': T, 'text': 'e', 'ran_as': 'r'}]},
        'turn_log': {'x': [{'n': 1, 'at': T, 'cost': 1.5, 'ms': None, 'denials': 0},
                           {'n': 2, 'at': T, 'cost': 1.0, 'ms': 5, 'toks': 3, 'denials': 0,
                            'approvals': 1, 'ran_as': 'x', 'killed': False, 'estimated': True,
                            'cost_complete': True, 'cost_source': 'c',
                            'cost_unknown_fields': ['a'], 'route': {'r': 1},
                            'reported': {'x': 2}, 'model_usage_key': {'k': 3}}]},
        'work_scope_log': {'boss': [{'seq': 1, 'at': T, 'by': BY, 'kind': 'k', 'text': 't',
                                     'supersedes': None, 'superseded_by': 3, 'before': 'b',
                                     'after': 'a', 'mode': 'm'}]},
        'mail_transitions': {'x': {'k1': {'operation': 'o', 'outcome': 'c', 'node': 'x',
                                          'identity': ['i'], 'before': {'b': 1},
                                          'deliveries': {'d': 2}}}},
        'steer_attempts': {'x': {'d1': {'at': T, 'tool_use_id': 'u', 'toks': ['a'],
                                        'mail_ids': ['m'], 'transcript_path': 'p',
                                        'tp_offset': 3, 'texts_n': 1, 'retried': False,
                                        'acked_at': T, 'recorded_at': T, 'resolved': 'r',
                                        'views': ['v'], 'view_segments': [{'s': 1}]},
                                 'd2': {}}},
        'manual_attempts': {'boss': {'mf-1': {'v': 1, 'at': T, 'tok': 't', 'mailbox': 'm',
                                              'generation': 0, 'session': 's', 'attempt': 'a',
                                              'engine': 'e', 'delivery_id': 'd', 'seat': 's',
                                              'op_key': 'k', 'op_id': 'i', 'mail_ids': ['m1'],
                                              'digests': {'a': 'b'}, 'provider_call_id': None,
                                              'call_id_source': 'c', 'resolved': None,
                                              'chunk_calls': [{'c': 1}]}}},
        'asks': [{'id': 'q1', 'node': 'x', 'kind': 'ask', 'question': 'Q',
                  'questions': [{'question': 'Q'}], 'at': T,
                  'options': [{'label': 'L', 'description': 'D'}], 'header': 'H',
                  'work_items': ['a-thing'], 'rev': 1, 'status': 'answered', 'reason': 'r',
                  'answer': {'selected': ['L']}, 'resolved_at': T, 'answer_mail': 'am'}],
        'credit_requests': [{'id': 'c1', 'node': 'x', 'old': 1.5, 'new': 2, 'reason': 'r',
                             'at': T, 'rev': 1, 'status': 's', 'granted': 2, 'notice': 'n'}],
        'scope_requests': [{'id': 's1', 'node': 'x',
                            'items': [{'kind': 'dir', 'path': 'p', 'mode': 'rw',
                                       'decision': 'ok'}, {'kind': 'mcp', 'server': 'srv'}],
                            'reason': 'r', 'at': T, 'rev': 1, 'status': 's', 'resolved_at': T}],
        'audiences': [{'grantee': 'x', 'grantor': 'boss', 'granted_at': T, 'reason': 'r',
                       'delegated_by': 'y'}],
        'audience_requests': [{'id': 'ar', 'node': 'x', 'target': 't', 'reason': 'r', 'at': T,
                               'status': 's'}],
        'watchdogs': [{'id': 'w1', 'owner': 'x', 'name': 'n', 'kind': 'k', 'target': 't',
                       'pattern': 'p', 'interval_s': 5, 'state': 's', 'at': T, 'fired': 0,
                       'events': [{'at': T, 'gist': 'g'}], 'high_water': {'h': 1},
                       'last_check': T, '_last_check_ts': 1.5, 'checks_run': 2,
                       'last_output': 'o', 'paused_why': 'p', 'last_exit': 0, 'last_fired': T,
                       'history_retained': True, 'notice': True, 'once': False},
                      # a silence alarm (watchdog_config): the three sparse fields
                      {'id': 'w3', 'owner': 'x', 'name': 'quiet', 'kind': 'activity',
                       'target': 'x', 'interval_s': 60, 'state': 'armed', 'at': T,
                       'fire_mode': 'silence', 'quiet_period_s': 600, 'silence_since': T}],
        'watchdog_tombs': [{'id': 'w2', 'owner': 'x', 'name': 'n', 'kind': 'k', 'target': 't',
                            'interval_s': 5, 'at': T, 'spent_at': T, 'fired': 1,
                            'fire_mode': 'event', 'notice': True},
                           {'id': 'w4', 'owner': 'x', 'name': 'wait', 'kind': 'activity',
                            'target': 'x', 'interval_s': 60, 'at': T, 'fire_mode': 'silence',
                            'quiet_period_s': 60, 'silence_since': T2, 'spent_at': T,
                            'state': 'superseded', 'superseded_by': 'boss', 'reason': 'r',
                            'once': True}],
        'watchdog_history': [{'at': T, 'gist': 'g', 'watchdog': 'w1', 'node': 'x', 'body': 'b'}],
        'reservations': [{'id': 'r1', 'owner': 'x', 'item': 'a-thing', 'resource': 'res',
                          'candidate': 'c', 'base': 'b', 'paths': ['p1', 'p2'], 'state': 'held',
                          'created_at': T, 'updated_at': T, 'created_ts': 1.0,
                          'updated_ts': 2.0, 'expires_ts': 3.0, 'expires_at': T,
                          'heartbeat_ts': 4.0, 'heartbeat_at': T, 'stale_s': 5.0,
                          'integration_key': None, 'integration_receipt': 'ir',
                          'landed_at': T, 'release_receipt': 'rr', 'successor': None}],
        'documents': [{'id': 'd1', 'node': 'x', 'title': 't', 'body': 'b', 'at': T,
                       'format': 'f', 'file': 'x', 'bytes': 3}],
        'events': [{'op': 'hire', 'actor': 'boss', 'at': T, 'detail': {'k': [1, None]},
                    'warnings': []},
                   {'op': 'move', 'actor': 'user', 'at': T, 'detail': {'to': 'x'},
                    'warnings': ['w1', 'w2']}],
        'lifecycle': [{'operation_id': 'o', 'kind': 'k', 'state': 's', 'at': T, 'count': 1,
                       'sender': 'x', 'recipient': 'boss', 'waited': 'w', 'boundary_for': None,
                       'observed': True, 'current_candidate': None, 'issued_candidate': 'c'}],
        'notice_log': [{'node': 'x', 'at': T, 'text': 't', 'ev': {'e': 1}}],
        'org_inbox': [{'id': 'oi', 'dir': 'in', 'peer': 'p', 'body': 'b', 'at': T, 'by': 'x',
                       'state': 's', 'state_at': T, 'net_id': 'n', 'attributed': True}],
        'user_inbox': [{'id': 'ui', 'from': 'f', 'kind': 'k', 'body': 'b', 'at': T,
                        'message_id': 'm', 'operation_id': 'o',
                        'attachments': [{'name': 'n', 'path': 'p', 'bytes': 1}]}],
        'user_outbox': [{'id': 'uo', 'from': 'f', 'kind': 'k', 'body': 'b', 'at': T,
                         'relationship': 'r', 'to': 'x', 'attachments': [],
                         'attachments_missing': ['x'], 'reply_to': None, 'ev': {'a': 1}}],
        'user_mail_log': [{'id': 'ul', 'from': 'f', 'kind': 'k', 'body': 'b', 'at': T,
                           'urgent': True, 'urgent_reason': 'u'}],
        'op_receipts': [{'v': 1, 'id': 'op', 'at': T, 'mint_ms': 5, 'node': 'x', 'gen': 0,
                         'tool': 't', 'key': 'k', 'fp': 'f', 'targets': {'t': 1}, 'cls': 'c',
                         'outcome': 'o', 'result': {'r': 1}, 'ev_from': None, 'ev_to': None,
                         'post_effects': {'p': 1}}],
        'orphan_keys': {'x#orphan-abc123def456': {'from': 'x', 'at': T, 'cause': 'c',
                                                  'arriving_seat': 's', 'owner': None,
                                                  'sections': ['mail']}},
        '_migrations': {'heal_a': {'at': T2, 'healed': ['x'], 'mode': 'm', 'repaired': 1},
                        'heal_b': {'at': T2, 'holders': [], 'multi_holder': False}},
        'net_state': {'hub-1': {'registered_at': T, 'address': 'a', 'seen_ids': ['s1', 's2']}},
        'dirs': [{'path': 'C:/a', 'mode': 'rw'}, {'path': 'C:/b', 'mode': 'ro'}],
        'net_hubs': [{'id': 'h1', 'address': 'a', 'enabled': True, 'name': 'n'}],
        'work_deleted_names': ['gone-thing'],
        'work_items': [
            item('a-thing', participants=['boss'], done_so_far=['d'],
                 working_on_next=['n1', 'n2', 'n3'],
                 reviewer={'node': 'boss', 'generation': 0, 'born': 'bb'},
                 dismissals=[{'at': T, 'by': 'x', 'set_rev': 1, 'reason': 'r'}],
                 acceptance=[{'text': 'a1', 'checked': None, 'check_history': []},
                             {'text': 'a2', 'checked': {'at': T, 'by': BY, 'note': None,
                                                        'result': 'ok'},
                              'check_history': [{'at': T, 'by': BY, 'result': 'passed',
                                                 'note': 'n'}]}],
                 dependencies=['b-thing'],
                 evidence=[{'at': T, 'by': BY, 'kind': 'k', 'ref': 'r', 'note': 'n',
                            'receipt': {'x': 1}}],
                 delivery={'pushed': {'at': T}}, candidate_verdicts=[], review_packet=None,
                 review_packets=[], review_seats=[{'reviewer': 'boss'}],
                 review_seat_requests=[{'seq': 1, 'reviewer': 'boss', 'requested_by': 'x',
                                        'owner': 'x', 'to': 'boss', 'at': T, 'state': 's',
                                        'note': 'n', 'decided_by': None, 'decided_at': None,
                                        'decision_note': None}],
                 history=[{'at': T, 'by': BY, 'op': 'create', 'from': None},
                          {'at': T, 'by': 'boss', 'op': 'edit', 'from': 'x', 'to': {'y': 1},
                           'verified': None, 'answered_request': 3, 'note': None}],
                 holders=[{'node': 'x', 'generation': 0, 'born': 'b', 'from': T, 'by': BY,
                           'derived': True}],
                 notification_attention_epoch=1, notification_attention_active=False,
                 scope=[{'seq': 1, 'at': T, 'by': BY, 'kind': 'k', 'text': 't',
                         'supersedes': None, 'superseded_by': None}],
                 scope_seq=1, scope_guard=1,
                 artifacts=[{'id': 'A1', 'seq': 1, 'at': T, 'by': BY, 'name': 'n', 'bytes': 1,
                             'sha256': 's', 'path': 'p', 'scope': 'sc', 'grants': [{'x': 1}],
                             'note': 'n'}], artifact_seq=1,
                 findings=[{'id': 'F1', 'seq': 1, 'at': T, 'by': BY, 'title': 't',
                            'disposition': 'd', 'decisions': [{'at': T, 'by': BY,
                                                               'disposition': 'x',
                                                               'note': 'n'}],
                            'detail': 'x', 'severity': 's', 'evidence_ref': 'e'}],
                 finding_seq=1, surprise={'s': 1}),
            item('b-thing', owner={'node': 'gen2', 'generation': 0}, parent='a-thing'),
        ],
        'work_items_archive': [
            item('old-thing', archived_at=T2, status='done', superseded_by='a-thing',
                 accepted={'at': T, 'by': BY}, quick_staff_receipts={'u': {'x': 1}},
                 post_completion={'count': 1}, scope_logged=2,
                 candidate_verdict={'decision': 'approve'}, candidate_verdicts=[{'d': 1}]),
        ],
        'hand_edited_default': {'anything': True},
    }


def _drop_all() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


A = "(SELECT id FROM orgtree.agents WHERE name = '{}' AND NOT tombstone)"
ITEM_ID = "(SELECT id FROM orgtree.work_items WHERE slug = '{}')"
NEXT = "UPDATE orgtree.work_item_next SET pos = {} WHERE item_id = " + ITEM_ID.format('a-thing') \
    + " AND pos = {}"
SWAP_NEXT = [NEXT.format(-1, 0), NEXT.format(0, 2), NEXT.format(2, -1)]
SECT = "UPDATE orgtree.org_sections SET ord = {} WHERE key = '{}'"
SWAP_SECTIONS = [SECT.format(-1, 'version'), SECT.format(0, 'slug'), SECT.format(1, 'version')]
UNSWAP_SECTIONS = [SECT.format(-1, 'slug'), SECT.format(0, 'version'), SECT.format(1, 'slug')]
ORD = "UPDATE orgtree.agents SET ord = {} WHERE name = '{}' AND NOT tombstone"
NAME = "UPDATE orgtree.agents SET name = '{}' WHERE name = '{}'"
SWAP_NAMES = [NAME.format('tmp-swap', 'boss'), NAME.format('boss', 'gen2'),
              NAME.format('gen2', 'tmp-swap')]

#: name -> (the table it corrupts, its statements, the statements that undo it exactly).
#: Each keeps every row count; after the undo the whole database must equal the clean one.
CORRUPTIONS = {
    'text field in agents': ('agents', [
        "UPDATE orgtree.agents SET title = title || ' (changed)' WHERE name = 'boss'"], [
        "UPDATE orgtree.agents SET title = 't' WHERE name = 'boss'"]),
    'timestamp moved by 1 ms': ('agents', [
        "UPDATE orgtree.agents SET created = created + interval '1 millisecond' "
        "WHERE name = 'x'"], [
        "UPDATE orgtree.agents SET created = created - interval '1 millisecond' "
        "WHERE name = 'x'"]),
    'boolean flipped': ('agents', [
        "UPDATE orgtree.agents SET scope_tools_bash = NOT scope_tools_bash WHERE name = 'boss'"],
        ["UPDATE orgtree.agents SET scope_tools_bash = NOT scope_tools_bash WHERE name = 'boss'"]),
    '_null flag cleared': ('agent_texts', [
        "UPDATE orgtree.agent_texts SET charter_null = NULL WHERE agent_id = " + A.format('boss')],
        ["UPDATE orgtree.agent_texts SET charter_null = true WHERE agent_id = "
         + A.format('boss')]),
    'parent_id pointed at another agent': ('agents', [
        "UPDATE orgtree.agents SET parent_id = " + A.format('x@0') + " WHERE name = 'x'"], [
        "UPDATE orgtree.agents SET parent_id = " + A.format('boss') + " WHERE name = 'x'"]),
    'mail body changed': ('mail', [
        "UPDATE orgtree.mail SET body = 'changed' WHERE public_id = 'm1'"], [
        "UPDATE orgtree.mail SET body = 'hi' WHERE public_id = 'm1'"]),
    'docket history entry changed': ('work_item_history', [
        "UPDATE orgtree.work_item_history SET op = 'changed' WHERE item_id = "
        + ITEM_ID.format('a-thing') + " AND pos = 1"], [
        "UPDATE orgtree.work_item_history SET op = 'edit' WHERE item_id = "
        + ITEM_ID.format('a-thing') + " AND pos = 1"]),
    'list order swapped': ('work_item_next', SWAP_NEXT, SWAP_NEXT),
    'value moved into extra': ('agents', [
        "UPDATE orgtree.agents SET extra = (coalesce(extra::jsonb, '{}'::jsonb) "
        "|| jsonb_build_object('title', title))::json, title = NULL WHERE name = 'boss'"], [
        "UPDATE orgtree.agents SET title = extra::jsonb ->> 'title', extra = NULL "
        "WHERE name = 'boss'"]),
    'docket slug changed': ('work_items', [
        "UPDATE orgtree.work_items SET slug = 'a-thing-renamed' WHERE slug = 'a-thing'"], [
        "UPDATE orgtree.work_items SET slug = 'a-thing' WHERE slug = 'a-thing-renamed'"]),
    'numeric int became float': ('agents', [
        "UPDATE orgtree.agents SET credit_grant = 5.0 WHERE name = 'boss'"], [
        "UPDATE orgtree.agents SET credit_grant = 5 WHERE name = 'boss'"]),
    'per-agent row moved to another agent': ('mail', [
        "UPDATE orgtree.mail SET agent_id = " + A.format('x') + " WHERE public_id = 'm1'"], [
        "UPDATE orgtree.mail SET agent_id = " + A.format('boss') + " WHERE public_id = 'm1'"]),
    'JSON payload changed': ('agent_runtime', [
        "UPDATE orgtree.agent_runtime SET frozen = '{\"until\": 1.0}' WHERE agent_id = "
        + A.format('x')], [
        "UPDATE orgtree.agent_runtime SET frozen = '{\"until\": 1}' WHERE agent_id = "
        + A.format('x')]),
    'tool list item changed': ('tool_list_items', [
        "UPDATE orgtree.tool_list_items SET tool = 'orgtree_other' WHERE pos = 1"], [
        "UPDATE orgtree.tool_list_items SET tool = 'orgtree_work' WHERE pos = 1"]),
    'top-level order swapped': ('org_sections', SWAP_SECTIONS, UNSWAP_SECTIONS),
    'nested docket value changed': ('work_item_acceptance_checks', [
        "UPDATE orgtree.work_item_acceptance_checks SET result = 'failed'"], [
        "UPDATE orgtree.work_item_acceptance_checks SET result = 'passed'"]),
    'present null became absent': ('work_items', [
        "UPDATE orgtree.work_items SET reviewer_is = NULL WHERE slug = 'b-thing'"], [
        "UPDATE orgtree.work_items SET reviewer_is = 'n' WHERE slug = 'b-thing'"]),
    'original timestamp text changed': ('org_settings', [
        "UPDATE orgtree.org_settings SET created_text = '2026-01-01T00:00:00+00:00'"], [
        "UPDATE orgtree.org_settings SET created_text = '2026-01-01T00:00:00Z'"]),
    'org_extra value changed': ('org_extra', [
        "UPDATE orgtree.org_extra SET val = '{\"anything\": 1}' WHERE key = 'hand_edited_default'"],
        ["UPDATE orgtree.org_extra SET val = '{\"anything\": true}' "
         "WHERE key = 'hand_edited_default'"]),
    'two agent names swapped': ('agents', SWAP_NAMES, SWAP_NAMES),
    'setting value changed': ('org_settings', [
        "UPDATE orgtree.org_settings SET max_children = 13"], [
        "UPDATE orgtree.org_settings SET max_children = 12"]),
    'agent order swapped': ('agents', [
        ORD.format(-1, 'boss'), ORD.format(0, 'x'), ORD.format(1, 'boss')], [
        ORD.format(-1, 'x'), ORD.format(0, 'boss'), ORD.format(1, 'x')]),
    'per-agent section entry state changed': ('org_section_owners', [
        "UPDATE orgtree.org_section_owners SET state = 'n' WHERE section = 'mail' "
        "AND agent_id = " + A.format('x')], [
        "UPDATE orgtree.org_section_owners SET state = 'l' WHERE section = 'mail' "
        "AND agent_id = " + A.format('x')]),
    'archived item moved to the active list': ('work_items', [
        "UPDATE orgtree.work_items SET list_key = 'active', ord = 2 WHERE slug = 'old-thing'"], [
        "UPDATE orgtree.work_items SET list_key = 'archive', ord = 0 WHERE slug = 'old-thing'"]),
    'value inside extra changed': ('agents', [
        "UPDATE orgtree.agents SET extra = replace(extra::text, '\"ui_order\": 2', "
        "'\"ui_order\": 3')::json WHERE name = 'odd'"], [
        "UPDATE orgtree.agents SET extra = replace(extra::text, '\"ui_order\": 3', "
        "'\"ui_order\": 2')::json WHERE name = 'odd'"]),
    'presence flag flipped': ('agents', [
        "UPDATE orgtree.agents SET is_halted = NOT is_halted WHERE name = 'x'"], [
        "UPDATE orgtree.agents SET is_halted = NOT is_halted WHERE name = 'x'"]),
}


def counts_only(source_doc, dest_conninfo, *, ignored_keys=ov.IGNORED_DEFAULT):
    """THE MUTANT: a verifier that only compares row counts with what the source implies."""
    import psycopg
    want = {}
    for key, how in ov.SECTIONS.items():
        v = source_doc.get(key) if key not in ignored_keys else None
        kind = how[0]
        if kind in ('list', 'names') and isinstance(v, list):
            want[how[1]] = want.get(how[1], 0) + len(v)
        elif kind == 'docket' and isinstance(v, list):
            want['work_items'] = want.get('work_items', 0) + len(v)
        elif kind in ('dict', 'map') and isinstance(v, dict):
            want[how[1]] = len(v)
        elif kind in ('agent_list', 'agent_dict') and isinstance(v, dict):
            want[how[1]] = sum(len(x) for x in v.values() if isinstance(x, (list, dict)))
    out = []
    with psycopg.connect(dest_conninfo) as c:
        live = c.execute('SELECT count(*) FROM orgtree.agents WHERE NOT tombstone').fetchone()[0]
        if live != len(source_doc.get('nodes') or {}):
            out.append({'table': 'agents', 'problem': 'row count'})
        for table, n in want.items():
            got = c.execute(f'SELECT count(*) FROM orgtree."{table}"').fetchone()[0]
            if got != n:
                out.append({'table': table, 'problem': 'row count', 'source': n, 'dest': got})
    return out


def _tables(c) -> list:
    return [r[0] for r in c.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'orgtree' "
        "ORDER BY table_name")]


def table_counts(dbname: str) -> dict:
    with conn.connect(ADMIN, dbname) as c:
        return {t: c.execute(f'SELECT count(*) FROM orgtree."{t}"').fetchone()[0]
                for t in _tables(c)}


def fingerprint(dbname: str) -> dict:
    """Every table's row count and a digest of all its rows: equal means equal content."""
    with conn.connect(ADMIN, dbname) as c:
        return {t: c.execute(f'SELECT count(*), md5(coalesce(string_agg(md5(x::text), \'\' '
                             f'ORDER BY md5(x::text)), \'\')) FROM orgtree."{t}" x').fetchone()
                for t in _tables(c)}


class RestoreFailed(RuntimeError):
    """Not an AssertionError, so that no assertRaises can swallow it."""


class SyntheticDocument(unittest.TestCase):
    def test_it_holds_every_registered_section(self) -> None:
        doc = document()
        missing = (set(ledger.NODE_KEYED_SECTIONS) | {'chain_notices', 'release'}) - set(doc)
        self.assertEqual(missing, set())
        self.assertTrue(set(ledger.IGNORED_LEGACY_KEYS) <= set(doc))


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class AgainstARealConversion(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _drop_all()
        cls.doc = document()
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX,
                                 build='test')
        lc.bootstrap()
        org_id = lc.register_org('acme', state='converting')
        build = lc.open_build(org_id, 'convert')
        rows, _, _ = sections.encode_document(copy.deepcopy(cls.doc), mappers.sections(),
                                              ignored=mappers.ignored_keys())
        with conn.connect(RUNTIME, build.database, autocommit=False) as c:
            rowio.write(c, rows)
            c.commit()
        lc.mark_filled(build)
        cls.final = lc.publish(build)
        cls.dest = conn.with_db(RUNTIME, cls.final)
        cls.clean_counts = table_counts(cls.final)
        cls.clean = fingerprint(cls.final)

    def _run(self, statements: list) -> None:
        with conn.connect(ADMIN, self.final, autocommit=False) as c:
            for s in statements:
                c.execute(s)
            c.commit()

    @contextlib.contextmanager
    def planted(self, name: str):
        """The clean database with one corruption committed, undone afterwards; the undo must
        give back exactly the clean content, or the run stops (RestoreFailed)."""
        _table, corrupt, undo = CORRUPTIONS[name]
        self._run(corrupt)
        try:
            yield self.dest
        finally:
            self._run(undo)
            if fingerprint(self.final) != self.clean:
                raise RestoreFailed(f'{name}: the undo did not restore the clean database')

    # -- the clean conversion
    def test_the_clean_conversion_verifies(self) -> None:
        report = ov.verify_report(self.doc, self.dest)
        self.assertEqual(report['problems'], [])
        stats = report['stats']
        self.assertGreater(sum(n for k, n in stats.items() if k.startswith('typed')), 500)
        self.assertGreater(sum(n for k, n in stats.items() if k.startswith('extra')), 5)
        self.assertEqual(stats['links resolved to tombstones'], 2)       # gone-boss, gone-pred
        self.assertGreaterEqual(stats['links resolved to agents'], 4)
        self.assertEqual(stats['tool lists resolved'], 3)                # one shared, one empty
        for table in ('agents', 'work_items', 'mail', 'mail_log', 'agent_turns', 'events',
                      'org_settings', 'asks', 'reservations', 'steer_attempts', 'org_tier_prices',
                      'work_item_history', 'agent_carriers', 'delivery_batches', 'orphan_keys'):
            self.assertGreater(stats.get('records ' + table, 0), 0, table)

    def test_a_source_that_differs_is_reported(self) -> None:
        for change in (lambda d: d['nodes']['x'].update(title='other'),
                       lambda d: d['work_items'][0]['history'].pop(),
                       lambda d: d['mail']['boss'][0].update(at='2026-10-02T10:00:00.001Z'),
                       lambda d: d['events'].reverse(),
                       lambda d: d.update(hand_edited_default={'anything': False}),
                       lambda d: d['nodes']['boss'].update(grant=5.0),
                       lambda d: d['nodes']['gen2'].update(parent='x')):
            doc = document()
            change(doc)
            with self.subTest(change=change):
                self.assertNotEqual(ov.verify(doc, self.dest), [])

    def test_the_mutant_passes_the_clean_conversion(self) -> None:
        self.assertEqual(counts_only(self.doc, self.dest), [])

    # -- planted corruptions
    def test_corruptions_keep_every_row_count_and_undo_exactly(self) -> None:
        for name in CORRUPTIONS:
            with self.subTest(corruption=name):
                with self.planted(name):
                    self.assertEqual(table_counts(self.final), self.clean_counts)
                    self.assertNotEqual(fingerprint(self.final), self.clean)   # it did change

    def assert_each_corruption_reported(self, verify) -> None:
        for name, (table, _corrupt, _undo) in CORRUPTIONS.items():
            with self.planted(name) as dest:
                problems = verify(self.doc, dest)
            self.assertTrue(problems, f'{name}: not reported')
            self.assertIn(table, {p.get('table') for p in problems}, f'{name}: {problems}')

    def test_each_planted_corruption_is_reported(self) -> None:
        self.assert_each_corruption_reported(ov.verify)

    def test_the_corruption_test_fails_under_a_counts_only_verifier(self) -> None:
        for name in CORRUPTIONS:
            with self.subTest(corruption=name):
                with self.planted(name) as dest:
                    self.assertEqual(counts_only(self.doc, dest), [])
        with self.assertRaises(AssertionError):
            self.assert_each_corruption_reported(counts_only)


if __name__ == '__main__':
    unittest.main()
