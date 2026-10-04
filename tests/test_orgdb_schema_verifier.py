"""Independent comparisons detect faults in every G1-G11 record family.

Only the test imports the mapper to build relational fixtures. The verifier
derives expected values from the original document, without those imports.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from collections import defaultdict
import datetime as dt
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from orgtree.orgdb import mappers, sections

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('schema_verifier', ROOT / 'tools/orgdb_verify.py')
ov = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ov
spec.loader.exec_module(ov)

STAMP = '2026-10-04T00:00:00.000Z'
ROLE = {'node': 'worker', 'born': 'seat', 'generation': 1}
ACTOR = dict(ROLE, deleted=False, unknown={'\0\ud800': [False, 0, 0.0]})
POLICY = set(('slug rev kind title status owner reviewer created_by participants at updated_at '
              'docket_at archived_at manual_attention manual_attention_rev parent superseded_by').split())
LIST = set(('slug rev kind title objective status blocked_reason waiting_reason dropped_reason owner '
            'reviewer created_by last_updater participants at updated_at docket_at status_at archived_at '
            'done_so_far working_on_next manual_attention dependencies superseded_by parent post_completion '
            'scope_seq scope_guard scope_logged scope_rolled scope_frozen legacy_status').split())


def document():
    turn = {'n': 1, 'at': STAMP, 'cost': 1.5, 'cost_unknown_fields': ['cost', 'toks'],
            'model_usage_key': {'asked': 'model', 'matched': True, 'keys': ['b', 'a']}}
    item = {'slug': 'work', 'title': '\0\ud800', 'kind': 'code', 'status': 'open',
            'owner': ROLE, 'reviewer': dict(ROLE, born='former-seat'),
            'holders': [dict(ROLE, by=ACTOR), dict(ROLE, deleted=True)],
            'review_seats': [dict(reviewer='worker', holder=ROLE, recheck_owner=ROLE,
                                 granted_by=ACTOR, at=STAMP, state='granted',
                                 note='approved', answered_request=9,
                                 revoked_by='user', revoked_at=None)],
            'artifacts': [{'id': 'file', 'kind': 'file', 'grants': [
                {'to': 'worker', 'at': STAMP, 'by': ACTOR, 'revoked_at': None, 'note': 'first'},
                {'to': 'worker', 'at': STAMP, 'by': 'user', 'note': 'again'}]}],
            'manual_attention': {'reason': 'reason', 'at': STAMP, 'by': ACTOR, 'set_rev': 8},
            'accepted': {'at': STAMP, 'by': 'user', 'note': 'yes', 'via': 'manual',
                         'evidence_gap': {'unclassified': 2, 'total': 4, 'summary': 'two left'}},
            'delivery': {'implemented': {'claimed_at': STAMP, 'claimed_by': ACTOR,
                                        'ref': 'commit', 'verified': True, 'detail': 'proof'},
                         'committed': None, 'pushed': False, 'deployed': {},
                         'in_build': {'note': '\0\ud800'}, 'unknown-stage': [0, 0.0, False]},
            'history': [{'by': ACTOR, 'raised_by': 'user', 'next_actor': ROLE,
                         'at': STAMP, 'op': 'update', 'changes': {'status': 'open'}}],
            'scope': [{'seq': 2, 'at': STAMP}], 'scope_archive': [{'seq': 1}],
            'candidate_verdicts': [{'by': ROLE, 'at': STAMP, 'decision': 'approve_stage'}]}
    return {'nodes': {'worker': {'state': 'live', 'seat_id': 'seat', 'generation': 2,
                                'turn_est_cost': ['f', 1e16, 1.0],
                                'turn_est_toks': ['i', 10 ** 100],
                                'turns': [{'n': 0, 'model_usage_key': ['old']}, turn, turn]}},
            'turn_log': {'worker': [turn, turn, turn]}, 'work_items': [item],
            'lifecycle': [{'current_candidate': 'refs/heads/review'}]}


def fixture(doc):
    """Simulate PostgreSQL's returned values, using independently declared layouts."""
    owners = mappers.sections()
    rows, _, _ = sections.encode_document(doc, owners)
    columns = defaultdict(dict)
    types = {'timestamptz': 'timestamp with time zone', 'char(1)': 'character',
             'numeric': 'numeric', 'bigint': 'bigint', 'integer': 'integer'}
    for owner in owners:
        for table in owner.tables:
            for name, entry in table.layout().items():
                for col, typ in entry['keys'] + entry['columns']:
                    columns[name][col] = types.get(typ, typ)
                if entry['extra']:
                    columns[name]['extra'] = 'json'
    for name, fields in {
        'org_sections': {'key': 'text', 'ord': 'bigint', 'state': 'character'},
        'org_extra': {'key': 'text', 'val': 'json'},
        'org_section_owners': {'section': 'text', 'agent_id': 'bigint', 'ord': 'bigint', 'state': 'character'},
        'tool_lists': {'id': 'bigint', 'sha256': 'text'},
        'tool_list_items': {'list_id': 'bigint', 'pos': 'integer', 'tool': 'text'},
    }.items():
        columns[name].update(fields)
    for col in ('name',):
        columns['agents'][col] = 'text'
    columns['agents'].update(ord='bigint', tombstone='boolean',
                             **{col: 'boolean' for col in ov.PRESENCE})
    columns['work_items'].update(docket_scope_meta='json', docket_policy_extra='json', docket_list_extra='json')
    columns['work_items'].update(current_verdict_event_id_kind='text', current_review_packet_event_id_kind='text')
    original_items = doc.get('work_items', []) + doc.get('work_items_archive', [])
    for source, row in zip(original_items, rows.get('work_items', [])):
        row.update(current_verdict_event_id_kind='verdict', current_review_packet_event_id_kind='review_packet')
        ex = row['extra'].obj if row.get('extra') is not None else {}
        row['docket_policy_extra'] = json.dumps({k: v for k, v in ex.items() if k in POLICY}) \
            if any(k in POLICY for k in ex) else None
        row['docket_list_extra'] = json.dumps({k: v for k, v in ex.items() if k in LIST}) \
            if any(k in LIST for k in ex) else None
        archive = source.get('scope_archive')
        archive = archive if isinstance(archive, list) else []
        def endpoint(value):
            return {k: value.get(k) if isinstance(value, dict) else None for k in ('seq', 'at')}
        row['docket_scope_meta'] = json.dumps({'archive_count': len(archive),
            'first': endpoint(archive[0] if archive else None),
            'last': endpoint(archive[-1] if archive else None),
            'inline_count': len(source['scope']) if isinstance(source.get('scope'), list) else None})
    dest = ov.Dest.__new__(ov.Dest)
    dest.columns, dest._groups, dest.used = columns, {}, defaultdict(set)
    dest._rows = {table: [] for table in columns}
    for table, records in rows.items():
        dest._rows[table] = []
        for record in records:
            output = {}
            for key, value in record.items():
                if key in ov.DERIVED.get(table, ()):
                    continue
                if hasattr(value, 'obj'):
                    value = json.dumps(value.obj)
                elif value is not None and columns[table].get(key) == 'numeric':
                    value = str(value)
                output[key] = value
            dest._rows[table].append(output)
    return dest


def check(doc, dest=None):
    verifier = ov.Verifier(dest or fixture(doc), doc, ())
    verifier.run()
    return verifier


class SchemaVerifier(unittest.TestCase):
    def assert_clean(self, doc):
        verifier = check(doc)
        self.assertEqual(verifier.problems, [], verifier.problems[:8])
        return verifier

    def fault(self, table, field, value, index=0):
        doc = document()
        dest = fixture(doc)
        before = len(dest.rows(table))
        dest.rows(table)[index][field] = value
        verifier = check(doc, dest)
        self.assertEqual(len(dest.rows(table)), before)
        self.assertTrue(any(p['table'] == table and field in p['field'] for p in verifier.problems),
                        verifier.problems[:8])

    def test_complete_fixture_compares_each_new_family(self):
        v = self.assert_clean(document())
        for table in ('work_item_review_seats', 'work_item_artifact_grants', 'work_item_delivery',
                      'agent_turns', 'work_item_holders', 'work_item_events', 'lifecycle_events'):
            self.assertGreater(v.stats['records ' + table], 0, table)
        self.assertEqual(v.stats['docket projections verified'], 2)
        self.assertGreater(v.stats['current links verified'], 7)

    def test_current_layout_has_no_unmapped_or_mistyped_document_column(self):
        dest = fixture(document())
        known = ov.correspondence()
        for table, columns in dest.columns.items():
            for column, kind in columns.items():
                with self.subTest(table=table, column=column):
                    self.assertIn(column, known.get(table, {}))
                    role = known[table][column]
                    if role in ov.SQL_TYPES:
                        self.assertIn(kind, ov.SQL_TYPES[role])
                    if role == ov.CODE:
                        self.assertEqual(kind, 'character')

    def test_source_scan_rejects_all_converter_import_routes(self):
        spec = importlib.util.spec_from_file_location('schema_verifier_scan',
            ROOT / 'tests/test_orgdb_verify_static.py')
        scanner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = scanner
        spec.loader.exec_module(scanner)
        self.assertEqual(scanner.scan((ROOT / 'tools/orgdb_verify.py').read_text(encoding='utf-8')), [])
        for code in ('import orgtree', 'from orgtree.orgdb import codec',
                     '__import__("orgtree.orgdb")', 'import importlib'):
            self.assertTrue(scanner.scan(code))

    def test_every_principal_shape_and_misfit_remains_exact(self):
        values = (None, False, 0, 1.0, '', 'user', 'orgtree', '@net:peer', 'old', '\0\ud800', [], {},
                  {'node': None, 'born': None, 'generation': None, 'deleted': None},
                  {'node': '\0\ud800', 'generation': True, 'born': False, 'deleted': 0})
        for value in values:
            with self.subTest(value=value):
                doc = document()
                item = doc['work_items'][0]
                item['history'][0].update(by=value, raised_by=value, next_actor=value)
                item['review_seats'][0].update(granted_by=value, revoked_by=value)
                item['artifacts'][0]['grants'][0]['by'] = value
                item['manual_attention']['by'] = item['accepted']['by'] = value
                item['delivery']['implemented']['claimed_by'] = value
                self.assert_clean(doc)

    def test_current_links_apply_birth_then_directional_generation(self):
        for role in (ROLE, dict(ROLE, born='former-seat'), {'node': 'worker', 'generation': 1},
                     {'node': 'worker', 'generation': 3}, dict(ROLE, deleted=True),
                     {'node': 'absent'}, {'node': 'worker', 'generation': False},
                     {'node': 'worker', 'born': 0}, None, {}, {'node': 'user'}):
            with self.subTest(role=role):
                doc = document()
                item = doc['work_items'][0]
                item['owner'] = item['reviewer'] = role
                item['holders'] = [role] if isinstance(role, dict) else []
                item['review_seats'][0]['holder'] = item['review_seats'][0]['recheck_owner'] = role
                self.assert_clean(doc)

    def test_identity_coercions_match_legacy_unicode_and_exceptional_metadata(self):
        for generation in (None, False, True, 0.5, '2', '\u0662', -2, [], {'raw': 1}):
            with self.subTest(generation=generation):
                self.assert_clean({'nodes': {'worker': {'generation': generation}},
                    'work_items': [{'owner': {'node': 'worker', 'generation': 1}}]})
        for born in (None, False, True, 0, 1, 0.5, [], {}, {'raw': 1}):
            with self.subTest(born=born):
                self.assert_clean({'nodes': {'worker': {'seat_id': born}},
                    'work_items': [{'owner': {'node': 'worker', 'born': str(born or '')}}]})

    def test_estimates_check_large_integer_compensation_and_signed_zero(self):
        for state in (None, ['i', 10 ** 100], ['f', -0.0, -0.0], ['i', True],
                      ['f', 1, 1.0], ['f', 1.0, 0], [], {'raw': '\0\ud800'}):
            with self.subTest(state=state):
                doc = document()
                doc['nodes']['worker'].update(turn_est_cost=state, turn_est_toks=state)
                self.assert_clean(doc)
        self.fault('agents', 'turn_est_cost_compensation', 0.0)
        self.fault('agents', 'turn_est_toks_integer', str(10 ** 100) + '.0')

    def test_turn_usage_supports_bare_lists_nulls_and_exceptional_shapes(self):
        for value in (None, False, [], ['first', 'second'], ['\0\ud800'], {},
                      {'asked': None, 'matched': False, 'keys': ['key']},
                      {'asked': 0, 'matched': None, 'keys': False, 'unknown': '\0\ud800'}):
            with self.subTest(value=value):
                self.assert_clean({'nodes': {'worker': {'turns': [{'model_usage_key': value}]}}})

    def test_ordered_seat_and_grant_values_are_checked(self):
        for table, field, value in (
            ('work_item_review_seats', 'seq', 2), ('work_item_review_seats', 'state', 'spent'),
            ('work_item_review_seats', 'note', 'other'),
            ('work_item_review_seats', 'answered_request', 10),
            ('work_item_artifact_grants', 'pos', 4), ('work_item_artifact_grants', 'note', 'changed'),
            ('work_item_artifact_grants', 'recipient_name', 'someone-else'),
            ('work_item_artifact_grants', 'item_id', 999),
        ):
            with self.subTest(table=table, field=field):
                self.fault(table, field, value)

    def test_all_current_role_links_reject_wrong_live_and_tombstone_targets(self):
        for table, fields in (
            ('work_items', ('owner_agent_id', 'reviewer_agent_id')),
            ('work_item_holders', ('agent_id',)),
            ('work_item_review_seats', ('reviewer_agent_id', 'holder_agent_id', 'recheck_owner_agent_id')),
            ('work_item_artifact_grants', ('agent_id',)),
        ):
            for field in fields:
                with self.subTest(table=table, field=field):
                    self.fault(table, field, 999)
        self.fault('work_items', 'reviewer_agent_id', 1)

    def test_delivery_and_typed_attention_accepted_fields_reject_changes(self):
        for table, field, value in (
            ('work_item_delivery', 'claimed_by_name', 'wrong'),
            ('work_item_delivery', 'verified', False), ('work_item_delivery', 'ref', 'wrong'),
            ('work_item_delivery', 'claim_is', 'n'),
            ('work_items', 'attention_set_rev', 999), ('work_items', 'attention_reason', 'wrong'),
            ('work_items', 'accepted_evidence_gap_total', 99), ('work_items', 'accepted_via', 'other'),
        ):
            with self.subTest(table=table, field=field):
                self.fault(table, field, value)

    def test_projection_copies_are_independently_compared_to_legacy(self):
        for field in ('docket_policy_extra', 'docket_list_extra', 'docket_scope_meta'):
            with self.subTest(field=field):
                self.fault('work_items', field, '{}')
        doc = document()
        dest = fixture(doc)
        row = dest.rows('work_items')[0]
        # Corrupting all copies together must not verify itself.
        extra = json.loads(row['extra'])
        extra['title'] = 'wrong'
        row['extra'] = json.dumps(extra)
        for field in ('docket_policy_extra', 'docket_list_extra'):
            copied = json.loads(row[field])
            copied['title'] = 'wrong'
            row[field] = json.dumps(copied)
        problems = check(doc, dest).problems
        for field in ('docket_policy_extra', 'docket_list_extra'):
            self.assertTrue(any(p['field'] == field for p in problems))

    def test_attention_accepted_relations_and_projections_preserve_exceptional_shapes(self):
        for value in (None, False, 0, 0.0, '', [], ['text'], {},
                      {'unknown': '\0\ud800'},
                      {'by': {'node': '\0\ud800', 'generation': False},
                       'at': '2026-W40-7T02:00:00+02:00', 'reason': None, 'set_rev': 0.0,
                       'evidence_gap': {'total': 10 ** 100, 'summary': None}}):
            with self.subTest(value=value):
                doc = {'work_items': [{'manual_attention': value, 'accepted': value,
                                       'review_seats': value, 'delivery': value,
                                       'artifacts': [{'grants': value}], 'post_completion': value}]}
                self.assert_clean(doc)

    def test_every_new_typed_value_null_and_shape_column_detects_corruption(self):
        doc = document()
        good = fixture(doc)
        owned = {
            'agents': ('turn_est_',),
            'agent_turns': ('cost_unknown_fields_', 'model_usage_'),
            'lifecycle_events': ('current_candidate',),
            'work_items': ('attention_', 'accepted_', 'delivery_', 'review_seats_'),
            'work_item_holders': ('by_', 'deleted'),
            'work_item_events': ('history_by_', 'history_next_actor_', 'history_raised_by_'),
            'work_item_review_seats': ('',),
            'work_item_artifact_grants': ('',),
            'work_item_delivery': ('',),
        }
        exercised = 0
        for table, prefixes in owned.items():
            for column, sql_type in good.columns[table].items():
                role = ov.correspondence()[table].get(column)
                if (not column.startswith(prefixes) or role not in (*ov.SQL_TYPES, ov.CODE, ov.OPT)
                        or column in ('row_version', 'extra') or column.endswith('_text')):
                    continue
                with self.subTest(table=table, column=column):
                    dest = fixture(doc)
                    row = dest.rows(table)[0]
                    before = row.get(column)
                    if sql_type in ('integer', 'bigint'):
                        altered = (before or 0) + 99
                    elif sql_type == 'numeric':
                        altered = '999.0'
                    elif sql_type == 'double precision':
                        altered = (before or 0.0) + 2.0
                    elif sql_type == 'boolean':
                        altered = not before
                    elif sql_type == 'timestamp with time zone':
                        altered = (before or dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)) + dt.timedelta(days=1)
                    elif sql_type == 'character':
                        altered = 'x' if before != 'x' else 'n'
                    elif sql_type == 'text':
                        altered = 'altered'
                    else:
                        continue
                    row[column] = altered
                    problems = check(doc, dest).problems
                    self.assertTrue(any(p['table'] == table and
                        (p['field'] == column or p['field'] == column.removesuffix('_null'))
                        for p in problems), problems[:8])
                    exercised += 1
        self.assertGreater(exercised, 160)
        print(json.dumps({'typed_column_faults_detected': exercised}))

    def test_removing_link_or_projection_check_is_caught_by_fault_control(self):
        for method, table, field, value in (
            ('current_links', 'work_items', 'owner_agent_id', 999),
            ('docket_projections', 'work_items', 'docket_policy_extra', '{}'),
        ):
            with self.subTest(method=method), patch.object(ov.Verifier, method, lambda *args: None):
                with self.assertRaises(AssertionError):
                    self.fault(table, field, value)

    def test_turns_detect_shared_membership_fault_with_identical_payload_counts(self):
        doc = document()
        dest = fixture(doc)
        self.assert_clean(doc)
        rows = dest.rows('agent_turns')
        a, b = [r for r in rows if r.get('idx') in (0, 1)]
        a['recent_pos'], b['recent_pos'] = b['recent_pos'], a['recent_pos']
        self.assertTrue(any(p['field'] == 'idx/recent_pos' for p in check(doc, dest).problems))

    def test_recent_order_accepts_gaps_without_decoding_log_only_as_recent(self):
        doc = document()
        dest = fixture(doc)
        for row in dest.rows('agent_turns'):
            if row.get('recent_pos') is not None:
                row['recent_pos'] = row['recent_pos'] * 10 + 5
        self.assertEqual(check(doc, dest).problems, [])

    def test_turn_child_values_and_order_are_checked(self):
        for table, field, value in (
            ('agent_turn_cost_unknown_fields', 'value', 'wrong'),
            ('agent_turn_cost_unknown_fields', 'pos', 5),
            ('agent_turn_model_usage_keys', 'value', 'wrong'),
            ('agent_turn_model_usage_keys', 'pos', 5),
            ('agent_turns', 'model_usage_asked', 'wrong'),
            ('agent_turns', 'model_usage_matched', False),
        ):
            with self.subTest(table=table, field=field):
                self.fault(table, field, value)

    def test_lifecycle_candidate_uses_text_and_detects_changed_value(self):
        for value in (None, '', 'branch', '\0\ud800', False, 0, [], {}):
            with self.subTest(value=value):
                self.assert_clean({'lifecycle': [{'current_candidate': value}]})
        self.fault('lifecycle_events', 'current_candidate', 'wrong')


if __name__ == '__main__':
    unittest.main()
