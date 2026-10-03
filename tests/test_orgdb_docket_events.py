"""Docket event conversion: real source lists and explicit current pointers.

No database. PostgreSQL writes, fences and lifecycle isolation have their own
controls in test_orgdb_docket_events_pg.py.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
from pathlib import Path
import unittest

from orgtree.orgdb import codec, docket_events, mappers, sections
from orgtree.orgdb.mappers import docket as D

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


class EventDifferences(unittest.TestCase):
    def plan(self, before, after):
        old, _ = convert(before)
        rows = old['work_item_events']
        next_id = iter(range(100, 1000))
        return rows, docket_events.difference(after, rows, item_id=1,
                                              allocate=lambda: next(next_id))

    def test_append_and_current_pointer_keep_every_old_event(self):
        before = item()
        after = copy.deepcopy(before)
        after['history'].append({'at': AT, 'op': 'update', 'changes': {'status': {}}})
        after['candidate_verdicts'].append(copy.deepcopy(after['candidate_verdict']))
        old, (events, removed, rewritten) = self.plan(before, after)
        self.assertFalse(removed)
        self.assertFalse(rewritten)
        self.assertEqual(events[:len(old)], old)
        self.assertEqual([e['seq'] for e in events[len(old):]], [8, 9])
        self.assertTrue(all(e['id'] >= 100 for e in events[len(old):]))
        pointers = docket_events.pointers(after, events)
        self.assertEqual(pointers['current_verdict_event_id'], events[-1]['id'])

    def test_fold_rewrites_first_row_and_removes_only_the_old_prefix(self):
        before = item()
        before['history'] = [{'at': AT, 'op': str(n)} for n in range(5)]
        after = copy.deepcopy(before)
        after['history'] = [{'kind': 'folded', 'count': 3}, *before['history'][3:],
                            {'at': AT, 'op': 'new'}]
        old, (events, removed, rewritten) = self.plan(before, after)
        hist = [e for e in events if e['source'] == 'history']
        self.assertEqual((hist[0]['id'], hist[0]['seq']), (old[0]['id'], old[0]['seq']))
        self.assertEqual(set(removed), {old[1]['id'], old[2]['id']})
        self.assertEqual(rewritten, [old[0]['id']])
        self.assertEqual(hist[1:3], old[3:5])
        self.assertEqual(hist[-1]['seq'], max(e['seq'] for e in old)+1)
        self.assertEqual([e for e in events if e['source'] != 'history'], old[5:])

    def test_scope_supersession_rewrites_one_row_and_preserves_other_sources(self):
        before = item()
        after = copy.deepcopy(before)
        after['scope'][0]['superseded_by'] = 2
        after['scope'].append({'seq': 2, 'kind': 'decision', 'text': 'New ruling'})
        old, (events, removed, rewritten) = self.plan(before, after)
        old_scope = next(e for e in old if e['source'] == 'scope')
        self.assertFalse(removed)
        self.assertEqual(rewritten, [old_scope['id']])
        keep = [e for e in events if e['id'] != old_scope['id'] and e['id'] < 100]
        self.assertEqual(keep, [e for e in old if e['id'] != old_scope['id']])
        new_scope = next(e for e in events if e['id'] == old_scope['id'])
        self.assertEqual(docket_events.event_value(new_scope), after['scope'][0])

    def test_clearing_current_values_keeps_their_history_and_noop_is_exact(self):
        before = item()
        old, (events, removed, rewritten) = self.plan(before, before)
        self.assertEqual(events, old)
        self.assertFalse(removed)
        self.assertFalse(rewritten)
        after = copy.deepcopy(before)
        after['candidate_verdict'] = after['review_packet'] = None
        _, (events, removed, rewritten) = self.plan(before, after)
        self.assertEqual(events, old)
        self.assertFalse(removed)
        self.assertFalse(rewritten)
        self.assertEqual(docket_events.pointers(after, events),
                         {'current_verdict_event_id': None,
                          'current_review_packet_event_id': None})


if __name__ == '__main__':
    unittest.main()
