"""Docket event conversion: real source lists and explicit current pointers.

No database. PostgreSQL writes, fences and lifecycle isolation have their own
controls in test_orgdb_docket_events_pg.py.
"""
import import_provenance  # noqa: F401  asserts imports resolve in this checkout

import copy
import json
from pathlib import Path
import unittest

from orgtree.orgdb import codec, mappers, sections

AT = '2026-10-03T09:00:00.000Z'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def item():
    verdict = dict(at=AT, by={'node': 'reviewer', 'generation': 2},
                   candidate='a' * 40, decision='approve_stage', note='verdict',
                   next_actor={'node': 'owner', 'generation': 0}, evidence=[])
    packet = dict(at=AT, by={'node': 'owner', 'generation': 0},
                  candidate='a' * 40, base='b' * 40, note='packet', evidence=[])
    return dict(slug='event-item', rev=4, kind='code', status='approved',
                title='Event item', objective='Requested change',
                history=[{'at': AT, 'by': {'node': 'owner'}, 'op': 'create'}],
                evidence=[{'at': AT, 'by': {'node': 'owner'}, 'kind': 'note',
                           'ref': 'report', 'note': 'full content\0 preserved'}],
                scope=[{'seq': 1, 'at': AT, 'by': {'node': 'owner'},
                        'kind': 'decision', 'text': 'Ruling', 'supersedes': None,
                        'superseded_by': None}],
                candidate_verdicts=[copy.deepcopy(verdict), copy.deepcopy(verdict)],
                candidate_verdict=verdict, review_packets=[packet], review_packet=packet,
                dismissals=[{'at': AT, 'by': '@user', 'set_rev': 3, 'reason': 'read'}])


def convert(record):
    doc = {'work_items': [record], 'work_items_archive': []}
    rows, _, _ = sections.encode_document(doc, mappers.sections(), ignored=mappers.ignored_keys())
    decoded = sections.decode_document(rows, mappers.sections(), sections.Context())
    return rows, decoded


class EventConversion(unittest.TestCase):
    def test_one_typed_sequence_and_explicit_last_matching_pointers(self):
        record = item()
        rows, decoded = convert(record)
        events = rows.get('work_item_events', [])
        self.assertEqual(len(events), 7)
        self.assertEqual([r['seq'] for r in events], list(range(1, 8)))
        self.assertEqual([r['kind'] for r in events],
                         ['history', 'evidence', 'decision', 'verdict', 'verdict',
                          'review_packet', 'dismissal'])
        self.assertTrue(all(r['item_id'] == rows['work_items'][0]['id'] for r in events))
        self.assertTrue(all('at' in r and 'by_node' in r and 'content' in r for r in events))
        main = rows['work_items'][0]
        self.assertEqual(main['current_verdict_event_id'], events[4]['id'])
        self.assertEqual(main['current_review_packet_event_id'], events[5]['id'])
        self.assertEqual(canonical(decoded), canonical({'work_items': [record], 'work_items_archive': []}))

    def test_event_sources_are_not_duplicated_in_old_children_or_current_json(self):
        rows, _ = convert(item())
        for old in ('work_item_history', 'work_item_evidence', 'work_item_scope', 'work_item_dismissals'):
            self.assertFalse(rows.get(old), old)
        main = rows['work_items'][0]
        for key in ('candidate_verdict', 'candidate_verdicts', 'review_packet', 'review_packets'):
            self.assertNotIn(key, main)
        extra = getattr(main.get('extra'), 'obj', main.get('extra')) or {}
        self.assertTrue(set(extra).isdisjoint(('history', 'evidence', 'scope', 'dismissals',
                                              'candidate_verdicts', 'review_packets')))

    def test_absent_null_and_empty_sources_and_currents_remain_distinct(self):
        for original in ({'slug': 'absent'}, {'slug': 'null', 'history': None,
                                            'candidate_verdict': None, 'review_packet': None},
                         {'slug': 'empty', 'history': [], 'candidate_verdicts': [], 'review_packets': []}):
            with self.subTest(slug=original['slug']):
                rows, decoded = convert(original)
                main = rows['work_items'][0]
                self.assertIn('current_verdict_event_id', main)
                self.assertIn('current_review_packet_event_id', main)
                self.assertIsNone(main['current_verdict_event_id'])
                self.assertIsNone(main['current_review_packet_event_id'])
                self.assertEqual(decoded['work_items'][0], original)

    def test_current_value_must_match_its_own_source_with_exact_json_types(self):
        for field, source in (('candidate_verdict', 'candidate_verdicts'),
                              ('review_packet', 'review_packets')):
            for current, previous in (({'n': True}, {'n': 1}), ({'n': 1}, {'n': 1.0}),
                                      ({'n': 1.0}, {'n': 1}), ({'note': 'missing'}, {})):
                with self.subTest(field=field, current=current, previous=previous):
                    record = dict(slug='bad-current', **{field: current, source: [previous]})
                    with self.assertRaisesRegex(codec.ShapeError, 'bad-current.*' + field):
                        convert(record)

    def test_current_match_cannot_borrow_a_value_from_another_source(self):
        record = dict(slug='wrong-source', candidate_verdict={'candidate': 'a' * 40},
                      candidate_verdicts=[], review_packets=[{'candidate': 'a' * 40}])
        with self.assertRaisesRegex(codec.ShapeError, 'wrong-source.*candidate_verdict'):
            convert(record)

    def test_unknown_fields_and_unsupported_scalar_sources_remain_exact(self):
        record = item()
        record['history'][0]['future_detail'] = {'nul': '\0', 'n': 1.0, 'bool': True}
        record['scope_archive'] = [{'seq': 0, 'kind': 'objective', 'before': '\0', 'after': 'old'}]
        record['quick_staff_receipts'] = ['receipt-a', {'legacy': True}]
        record['dismissals'] = False
        rows, decoded = convert(record)
        self.assertTrue(rows.get('work_item_events'))
        self.assertEqual(canonical(decoded['work_items'][0]), canonical(record))

    def test_migration_refuses_a_populated_older_org(self):
        migration = (Path(__file__).resolve().parents[1] / 'engine' / 'backend' / 'orgtree' /
                     'pg_migrations' / 'org' / '0010_docket_events.sql')
        text = migration.read_text(encoding='utf-8')
        self.assertIn('converted before 0010: re-convert it from its legacy data', text)
        self.assertIn('ON DELETE RESTRICT', text)


if __name__ == '__main__':
    unittest.main()
