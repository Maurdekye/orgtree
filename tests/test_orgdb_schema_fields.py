"""Runtime record mappings preserve legacy estimates, actors and attention."""

import import_provenance  # noqa: F401  asserts this checkout, not the installed app

import copy
import json
import math
import unittest

from orgtree import ledger
from orgtree.orgdb import codec, docket, docket_events, mappers, sections
from orgtree.orgdb.mappers import docket as D


def exact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def round_trip(document):
    rows, _, _ = sections.encode_document(document, mappers.sections())
    back = sections.decode_document(rows, mappers.sections(), sections.Context())
    return back, rows


PRINCIPALS = (
    codec.MISSING, None, False, 0, 1.0, '', 'user', 'orgtree', '@org:other', '@net:peer',
    'renamed-worker', '\0\ud800', [], ['worker'], {},
    {'node': 'worker', 'generation': 0, 'born': 'old-lineage'},
    {'node': None, 'generation': None, 'born': None, 'deleted': None},
    {'node': '\0\ud800', 'generation': True, 'born': False, 'deleted': 0,
     'unknown': {'\0\ud800': [False, 0, 0.0]}},
)


class RuntimeFields(unittest.TestCase):
    def test_estimate_states_in_the_full_node_keep_exact_types(self):
        cases = (codec.MISSING, None, ['i', 0], ['i', 10 ** 100], ['f', 1e16, 1.0],
                 ['f', -0.0, -0.0], ['i', True], ['f', 1, 1.0], ['f', 1.0, 0],
                 ['f', 1.0], ['unknown', 3], False, {'raw': '\0\ud800'})
        for value in cases:
            with self.subTest(value=value):
                worker = {'turn_seq': 4, 'turns': [{'n': 4, 'cost': 7.0, 'toks': 12}]}
                if value is not codec.MISSING:
                    worker.update(turn_est_cost=copy.deepcopy(value), turn_est_toks=copy.deepcopy(value))
                document = {'nodes': {'worker': worker}}
                back, rows = round_trip(document)
                self.assertEqual(exact(back), exact(document))
                row = rows['agents'][0]
                self.assertNotIn('turn_est_cost', row)
                self.assertNotIn('turn_est_toks', row)
                if value is not codec.MISSING and value == ['f', -0.0, -0.0]:
                    self.assertEqual(math.copysign(1.0, back['nodes']['worker']['turn_est_cost'][1]), -1)
                    self.assertEqual(math.copysign(1.0, back['nodes']['worker']['turn_est_cost'][2]), -1)

    def test_killed_turn_estimates_use_the_retained_compensation(self):
        # One additional float cancels the large sum, leaving the compensation.
        # Folding it into total in storage would silently turn this result to 0.
        worker = {'turn_seq': 3, 'turn_est_cost': ['f', 1e16, 1.0],
                  'turn_est_toks': ['i', 10 ** 100],
                  'turns': [{'n': 3, 'cost': 1e16, 'toks': 1},
                            {'cost': -1e16, 'toks': 9},
                            {'cost': 500.0, 'toks': 1000, 'killed': True}]}
        back, _ = round_trip({'nodes': {'worker': worker}})
        self.assertEqual(ledger.turn_estimate_sums(worker), (1.0, 10 ** 100 + 9))
        self.assertEqual(ledger.turn_estimate_sums(back['nodes']['worker']),
                         ledger.turn_estimate_sums(worker))
        worker['turn_est_cost'] = None
        back, _ = round_trip({'nodes': {'worker': worker}})
        with self.assertRaises(TypeError):
            ledger.turn_estimate_sums(back['nodes']['worker'])

    def test_history_and_holder_principals_round_trip_every_shape(self):
        for principal in PRINCIPALS:
            with self.subTest(principal=principal):
                history = {'op': 'update', 'changes': {'status': {'from': 'open', 'to': 'done'}},
                           'at': '2026-10-04T00:00:00.000Z'}
                holder = {'node': 'worker', 'generation': 0, 'born': 'lineage'}
                if principal is not codec.MISSING:
                    history.update(by=principal, raised_by=principal, next_actor=principal)
                    holder['by'] = principal
                record = {'slug': 'actors', 'history': [history], 'holders': [holder]}
                document = {'nodes': {'worker': {}}, 'work_items': [record]}
                back, rows = round_trip(document)
                self.assertEqual(exact(back), exact(document))
                event = rows['work_item_events'][0]
                self.assertNotIn('history_by', event)
                self.assertNotIn('history_raised_by', event)
                self.assertNotIn('history_next_actor', event)
                self.assertNotIn('by', rows['work_item_holders'][0])
                # The hot actor header and the reconstructing columns are one value.
                for key in ('by_node', 'by_generation', 'by_born'):
                    self.assertEqual(event[key], docket_events.event_header('history', history)[key])

    def test_nonhistory_actor_headers_survive_inactive_history_columns(self):
        for source in D.EVENT_SOURCES:
            if source == 'history':
                continue
            with self.subTest(source=source):
                value = {'by': {'node': 'former-name', 'generation': 8, 'born': 'old-seat'},
                         'at': '2026-10-04T01:02:03.000Z', 'note': 'authored'}
                row = docket_events.encode_event(source, value, id=23, item_id=7, seq=15)
                self.assertEqual(exact(docket_events.event_value(row)), exact(value))
                self.assertEqual(row['by_node'], 'former-name')
                self.assertEqual(row['by_generation'], 8)
                self.assertEqual(row['by_born'], 'old-seat')
                self.assertIsNone(row['history_is'])

    def test_actor_edits_keep_event_identity_and_current_pointers(self):
        history = {'op': 'update', 'by': {'node': 'old-name', 'generation': 1}}
        verdict = {'candidate': 'abc', 'by': {'node': 'reviewer'}, 'decision': 'approve_stage'}
        record = {'slug': 'stable-events', 'history': [history],
                  'candidate_verdicts': [verdict], 'candidate_verdict': verdict}
        old = [docket_events.encode_event('history', history, id=71, item_id=9, seq=6),
               docket_events.encode_event('candidate_verdicts', verdict, id=72, item_id=9, seq=7)]
        record['history'][0] = dict(history, by={'node': 'old-name', 'generation': 2})
        events, removed, rewritten = docket_events.difference(
            record, old, item_id=9, allocate=lambda: self.fail('a rewrite must reuse its event id'))
        self.assertEqual(removed, [])
        self.assertEqual(rewritten, [71])
        self.assertEqual([(e['id'], e['seq']) for e in events], [(71, 6), (72, 7)])
        self.assertEqual(docket_events.pointers(record, events),
                         {'current_verdict_event_id': 72, 'current_review_packet_event_id': None})
        self.assertIs(events[1], old[1])

    def test_lifecycle_candidate_is_exact_text_null_absence_or_extra(self):
        candidates = (codec.MISSING, None, '', 'refs/heads/some-branch', '\0\ud800',
                      False, 0, 0.0, [], {'unexpected': [None, 'raw']})
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                record = {'operation_id': 'operation', 'kind': 'review', 'state': 'recorded'}
                if candidate is not codec.MISSING:
                    record['current_candidate'] = candidate
                document = {'lifecycle': [record]}
                back, rows = round_trip(document)
                self.assertEqual(exact(back), exact(document))
                row = rows['lifecycle_events'][0]
                if candidate is None:
                    self.assertTrue(row['current_candidate_null'])
                elif isinstance(candidate, str) and codec.fits('text', candidate):
                    self.assertEqual(row['current_candidate'], candidate)
                else:
                    self.assertIsNone(row['current_candidate'])

    def test_attention_and_acceptance_keep_nested_nulls_misfits_and_dates(self):
        shapes = (codec.MISSING, None, False, 0, [], {}, {'unknown': '\0\ud800'},
                  {'at': '2026-10-04T01:02:03+02:00', 'by': 'user', 'reason': None, 'set_rev': 4,
                   'note': 'accepted', 'via': 'manual',
                   'evidence_gap': {'unclassified': 2, 'total': 3, 'summary': 'one unchecked'}},
                  {'at': None, 'by': {'node': None, 'generation': True}, 'reason': '\0\ud800',
                   'set_rev': 2.0, 'note': None, 'via': False,
                   'evidence_gap': {'unclassified': None, 'total': 10 ** 100,
                                    'summary': None, 'more': {'\ud800': [0, 0.0]}}})
        for value in shapes:
            with self.subTest(value=value):
                record = {'slug': 'typed-attention', 'manual_attention_rev': 17}
                if value is not codec.MISSING:
                    record.update(manual_attention=value, accepted=value)
                document = {'work_items': [record]}
                back, rows = round_trip(document)
                self.assertEqual(exact(back), exact(document))
                row = rows['work_items'][0]
                self.assertNotIn('manual_attention', row)
                self.assertNotIn('accepted', row)
                self.assertEqual(row['docket_manual'], bool(record.get('manual_attention')))

    def test_policy_and_list_projections_reconstruct_typed_attention(self):
        flag = {'reason': 'review this', 'at': '2026-10-04T01:02:03+02:00',
                'by': {'node': 'user', 'generation': None}, 'set_rev': 19, 'custom': '\0\ud800'}
        record = {'slug': 'projected', 'manual_attention': flag, 'manual_attention_rev': 19}
        _, rows = round_trip({'work_items': [record]})
        row = rows['work_items'][0]
        children = codec.Children(rows, D.WORK_ITEMS.layout())
        for spec in (docket._POLICY, docket._LIST, docket._MANUAL):
            with self.subTest(spec=spec):
                decoded = codec.decode(spec, row, children, (row['id'],))
                self.assertEqual(exact(decoded['manual_attention']), exact(flag))
                self.assertEqual(decoded['slug'], 'projected')


if __name__ == '__main__':
    unittest.main()
