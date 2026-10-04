"""Typed claim rows keep the docket's authored stage map and physical identity."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
import unittest
from unittest.mock import patch

from orgtree.orgdb import codec, docket_events, docket_relations as R, mappers, sections
from orgtree.orgdb.mappers import docket as D
from orgtree.orgdb.compat import rows as C


def exact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def convert(records, *, archived=()):
    doc = {'work_items': records, 'work_items_archive': list(archived)}
    rows, _, _ = sections.encode_document(doc, mappers.sections())
    decoded = sections.decode_document(rows, mappers.sections(), sections.Context())
    return doc, rows, decoded


def decode_one(row, relations):
    children = codec.Children({R.DELIVERY.table: relations}, D.WORK_ITEMS.layout())
    return docket_events.decode_item(row, children, [])


class DeliveryRows(unittest.TestCase):
    def test_all_stage_claim_and_outer_shapes_are_exact(self):
        claims = (None, {}, False, 0, 0.0, '', [], ['raw'], {'custom': '\0\ud800'},
                  {'claimed_at': None, 'claimed_by': None, 'ref': None, 'verified': None},
                  {'claimed_at': '2026-10-04T01:02:03+02:00',
                   'claimed_by': {'node': 'reviewer', 'generation': 3, 'born': 'old-seat'},
                   'ref': 'a' * 40, 'note': 'full note', 'verified': False, 'method': 'git',
                   'detail': 'observed', 'resolved_oid': 'b' * 40, 'target': 'v3',
                   'ref_as_of': 'head', 'fetched_at': '2026-10-04T01:00:00.000Z',
                   'observed_at': '2026-10-04T01:01:00.000Z'},
                  {'claimed_at': '\0\ud800', 'claimed_by': [0, 0.0, False],
                   'ref': {}, 'note': [], 'verified': 0, 'method': True,
                   'detail': None, 'resolved_oid': 0.0, 'target': '\ud800',
                   'ref_as_of': None, 'fetched_at': 3, 'observed_at': False})
        for value in (codec.MISSING, None, False, 0, [], '', {},
                      {'outside': {'raw': '\0\ud800'}}):
            with self.subTest(container=value):
                item = {'slug': 'outer'}
                if value is not codec.MISSING:
                    item['delivery'] = value
                doc, rows, decoded = convert([item])
                self.assertEqual(exact(decoded), exact(doc))
                self.assertFalse(rows.get(R.DELIVERY.table))
        for claim in claims:
            with self.subTest(claim=claim):
                item = {'slug': 'all-stages', 'delivery': {s: claim for s in R.STAGES}}
                item['delivery']['custom-stage'] = {'value': '\0\ud800'}
                doc, rows, decoded = convert([item])
                self.assertEqual(exact(decoded), exact(doc))
                children = rows[R.DELIVERY.table]
                self.assertEqual([r['stage'] for r in children], list(R.STAGES))
                self.assertEqual([r['id'] for r in children], list(range(1, 6)))
                self.assertEqual({r['item_id'] for r in children}, {1})

    def test_supported_payload_is_not_duplicated_in_parent_extra(self):
        claim = {'claimed_by': 'user', 'claimed_at': '2026-10-04T00:00:00.000Z',
                 'ref': 'source', 'verified': True, 'note': 'note', 'unmapped': '\0\ud800'}
        _, rows, _ = convert([{'slug': 'narrow', 'delivery': {'pushed': claim, 'other': 0}}])
        main = rows['work_items'][0]
        self.assertNotIn('delivery', main)
        self.assertNotIn('delivery_null', main)
        self.assertEqual(codec.from_column('json', main['extra'])['delivery'], {'other': 0})
        row = rows[R.DELIVERY.table][0]
        self.assertNotIn('claimed_by', row)
        self.assertEqual(row['claimed_by_kind'], 'user')
        self.assertEqual(row['verified'], True)
        self.assertEqual(codec.from_column('json', row['extra']), {'unmapped': '\0\ud800'})

    def test_mixed_active_archived_items_do_not_share_claims(self):
        active = [{'slug': 'a', 'delivery': {'committed': {'ref': 'a'}}},
                  {'slug': 'b', 'delivery': {'committed': None}}]
        archive = [{'slug': 'c', 'delivery': {'committed': {'ref': 'c'}, 'pushed': {}}}]
        doc, rows, decoded = convert(active, archived=archive)
        self.assertEqual(exact(decoded), exact(doc))
        self.assertEqual([r['item_id'] for r in rows[R.DELIVERY.table]], [1, 2, 3, 3])
        self.assertEqual([r['id'] for r in rows[R.DELIVERY.table]], [1, 2, 3, 4])

    def test_claim_edits_reuse_ids_and_only_new_stages_allocate(self):
        old = {}
        R.encode({'delivery': {'committed': {'ref': 'before'}, 'pushed': None}}, 7, old)
        old_rows = old[R.DELIVERY.table]
        old_rows[0]['id'], old_rows[1]['id'] = 71, 72
        allocated = []

        def allocate(table):
            allocated.append(table)
            return 100 + len(allocated)

        out = {}
        record = {'slug': 'edit', 'delivery': {'committed': {'ref': 'after'}, 'deployed': {}}}
        keys = D.row_keys(record, id=7, list_key='active', ord=4, events=[])
        docket_events.encode_current(record, keys, [], out,
                                     previous_relations=old_rows, allocate_relation=allocate)
        self.assertEqual(allocated, [R.DELIVERY.table])
        self.assertEqual([(r['stage'], r['id']) for r in out[R.DELIVERY.table]],
                         [('committed', 71), ('deployed', 101)])
        self.assertEqual(exact(decode_one(out['work_items'][0], out[R.DELIVERY.table])),
                         exact(record))

    def test_previous_rows_from_another_item_or_duplicate_stage_are_refused(self):
        out = {}
        R.encode({'delivery': {'pushed': {}}}, 8, out)
        old = out[R.DELIVERY.table]
        for previous in (old + old, [dict(old[0], item_id=9)]):
            with self.subTest(previous=previous):
                with self.assertRaisesRegex(codec.ShapeError, 'duplicate stage|another item'):
                    R.encode({'delivery': {'pushed': {}}}, 8, {}, previous=previous)

    def test_invalid_stage_duplicates_and_inactive_parent_are_refused(self):
        _, rows, _ = convert([{'slug': 'bad', 'delivery': {'pushed': {}}}])
        main, good = rows['work_items'][0], rows[R.DELIVERY.table][0]
        for bad in ([dict(good, stage='not-a-stage')], [good, dict(good, id=99)]):
            with self.subTest(rows=bad):
                with self.assertRaisesRegex(codec.ShapeError, 'stage'):
                    decode_one(main, bad)
        with self.assertRaisesRegex(codec.ShapeError, 'inactive container'):
            decode_one(dict(main, delivery_is='n'), [good])
        poisoned = dict(main, extra=codec.to_column('json', {'delivery': {'pushed': None}}))
        with self.assertRaisesRegex(codec.ShapeError, 'stage'):
            decode_one(poisoned, [good])

    def test_nonobject_claim_rows_refuse_conflicting_typed_values(self):
        _, rows, _ = convert([{'slug': 'bad-claim', 'delivery': {'pushed': None}}])
        good = rows[R.DELIVERY.table][0]
        bad_rows = (dict(good, claim_is='l'), dict(good, ref='not-null'),
                    dict(good, extra=codec.to_column('json', {'claim': 0})),
                    dict(good, claim_is='x'),
                    dict(good, claim_is='x', extra=codec.to_column('json', {'another': 0})))
        for bad in bad_rows:
            with self.subTest(row=bad):
                with self.assertRaises(codec.ShapeError):
                    R.claim(bad)

    def test_object_map_needs_children_and_selected_layout_keeps_the_join(self):
        _, rows, _ = convert([{'slug': 'needs-rows', 'delivery': {'pushed': {}}}])
        with self.assertRaisesRegex(ValueError, 'child rows needed'):
            docket_events.decode_item(rows['work_items'][0], None, [])
        child = D.WORK_ITEMS.layout()[R.DELIVERY.table]
        self.assertEqual(child['parent_table'], 'work_items')
        self.assertEqual(child['parent_cols'], ('item_id',))
        self.assertEqual(child['ref_cols'], ('id',))
        self.assertEqual(child['pos'], 'stage')
        columns = dict(child['columns'])
        self.assertIn('claimed_by_kind', columns)
        self.assertNotIn('claimed_by', columns)
        self.assertFalse(any(field.kind == 'json' for field in R.DELIVERY.fields))


class SeatsAndGrants(unittest.TestCase):
    def test_seat_lists_preserve_every_container_and_typed_state(self):
        seats = [
            {'reviewer': 'reviewer', 'holder': {'node': 'owner', 'generation': 3, 'born': 'seat'},
             'granted_by': 'user', 'at': '2026-10-04T01:02:03+02:00',
             'note': 'first seat; state was not authored', 'answered_request': None},
            {'reviewer': 'reviewer', 'state': 'spent', 'spent_at': None,
             'spent_via': 'review', 'recheck_owner': {'node': 'former', 'deleted': True}},
            {'reviewer': None, 'state': 'revoked', 'revoked_at': '2026-10-04T00:00:00.000Z',
             'revoked_by': {'node': 'user', 'generation': None}, 'revoked_reason': None},
            {'reviewer': '\0\ud800', 'holder': [0, 0.0, False], 'state': 'custom',
             'spent_at': False, 'answered_request': 1.0, 'unknown': {'\ud800': [False, 0]}}
        ]
        for value in (codec.MISSING, None, False, 0, 0.0, '', {}, [], [None], ['bare'], seats):
            with self.subTest(value=value):
                item = {'slug': 'seats'}
                if value is not codec.MISSING:
                    item['review_seats'] = value
                doc, rows, decoded = convert([item])
                self.assertEqual(exact(decoded), exact(doc))
                self.assertNotIn('review_seats', rows['work_items'][0])
                if value is seats:
                    seat_rows = rows[R.SEAT.table]
                    self.assertEqual([r['seq'] for r in seat_rows], list(range(4)))
                    self.assertIsNone(seat_rows[0]['state'])
                    self.assertIsNone(seat_rows[1]['spent_at'])
                    self.assertTrue(seat_rows[1]['spent_at_null'])
                    self.assertEqual(seat_rows[1]['recheck_owner_deleted'], True)
                    self.assertNotIn('review_seats', codec.from_column('json', rows['work_items'][0]['extra']) or {})

    def test_grant_revoke_regrant_occurrences_stay_in_order(self):
        grants = [{'to': 'reader', 'by': 'user', 'at': '2026-10-04T00:00:00.000Z',
                   'revoked_at': '2026-10-04T01:00:00.000Z', 'note': 'first'},
                  {'to': 'reader', 'by': {'node': 'owner', 'generation': 2},
                   'at': '2026-10-04T01:01:00+02:00', 'revoked_at': None},
                  {'to': '\0\ud800', 'by': {'node': None, 'unknown': [False, 0, 0.0]},
                   'revoked_at': False, 'note': None}]
        artifacts = [{'id': 'r1', 'name': 'one', 'grants': grants},
                     {'id': 'r2', 'grants': [{'to': 'reader'}]}]
        doc, rows, decoded = convert([{'slug': 'grant-history', 'artifacts': artifacts}])
        self.assertEqual(exact(decoded), exact(doc))
        self.assertEqual([r['id'] for r in rows[R.ARTIFACT_TABLE]], [1, 2])
        grant_rows = rows[R.GRANT.table]
        self.assertEqual([(r['artifact_id'], r['pos']) for r in grant_rows], [(1, 0), (1, 1), (1, 2), (2, 0)])
        self.assertEqual([r['recipient_name'] for r in grant_rows[:2]], ['reader', 'reader'])
        self.assertNotIn('grants', rows[R.ARTIFACT_TABLE][0])
        self.assertFalse(codec.from_column('json', rows[R.ARTIFACT_TABLE][0]['extra']))
        self.assertTrue(all(r['item_id'] == 1 for r in grant_rows))

    def test_grant_containers_and_exceptional_elements_remain_exact(self):
        for grants in (codec.MISSING, None, False, 0, '', {}, [], ['reader'], [None],
                       [{'to': None}], [{'to': [], 'by': False, 'at': '\0\ud800'}]):
            with self.subTest(grants=grants):
                artifact = {'id': 'r1'}
                if grants is not codec.MISSING:
                    artifact['grants'] = grants
                doc, rows, decoded = convert([{'slug': 'shapes', 'artifacts': [artifact]}])
                self.assertEqual(exact(decoded), exact(doc))
                self.assertEqual(rows[R.ARTIFACT_TABLE][0]['grants_is'], R.list_shape(grants))
                if R.list_shape(grants) != 'l':
                    self.assertFalse(rows.get(R.GRANT.table))

    def test_artifact_reorder_and_grant_revoke_keep_surrogates(self):
        old_record = {'slug': 'ids', 'review_seats': [{'reviewer': 'r', 'state': 'granted'}],
                      'artifacts': [{'id': 'r1', 'grants': [{'to': 'a'}]},
                                    {'id': 'r2', 'grants': [{'to': 'b'}]}]}
        _, old, _ = convert([old_record])
        for r in old[R.ARTIFACT_TABLE]:
            r['id'] += 70
        for r in old[R.GRANT.table]:
            r['id'] += 80
            r['artifact_id'] += 70
        old[R.SEAT.table][0]['id'] = 91
        record = {'slug': 'ids', 'review_seats': [{'reviewer': 'r', 'state': 'spent'}],
                  'artifacts': [{'id': 'r2', 'grants': [{'to': 'b', 'revoked_at': None}]},
                                {'id': 'r1', 'grants': [{'to': 'a', 'revoked_at': '2026-10-04T00:00:00Z'},
                                                      {'to': 'a'}]}]}
        allocated = []

        def allocate(table):
            allocated.append(table)
            return 200 + len(allocated)

        out = {}
        docket_events.encode_current(record, D.row_keys(record, id=1, list_key='active', ord=0),
                                     [], out, previous_children=old, allocate_relation=allocate)
        self.assertEqual([r['id'] for r in out[R.ARTIFACT_TABLE]], [72, 71])
        self.assertEqual([r['id'] for r in out[R.GRANT.table]], [82, 81, 201])
        self.assertEqual(out[R.SEAT.table][0]['id'], 91)
        self.assertEqual(allocated, [R.GRANT.table])
        self.assertEqual(exact(decode_one_all(out)), exact(record))

    def test_current_reference_callback_receives_previous_names_and_ids(self):
        record = {'slug': 'current', 'review_seats': [
            {'reviewer': 'r', 'holder': {'node': 'h'}, 'recheck_owner': {'node': 'c'}}],
            'artifacts': [{'id': 'r1', 'grants': [{'to': 'reader'}]}]}
        _, old, _ = convert([record])
        old[R.SEAT.table][0].update(reviewer_agent_id=11, holder_agent_id=12, recheck_owner_agent_id=13)
        old[R.GRANT.table][0]['agent_id'] = 14
        calls = []

        def resolve(value, previous, aid):
            calls.append((value, previous, aid))
            return aid

        out = {}
        docket_events.encode_current(record, D.row_keys(record, id=1, list_key='active', ord=0), [], out,
                                     previous_children=old, resolve_current=resolve)
        self.assertEqual(calls, [(codec.MISSING, codec.MISSING, None)]*2 +
                                [('r', 'r', 11), ({'node': 'h'}, {'node': 'h'}, 12),
                                 ({'node': 'c'}, {'node': 'c'}, 13), ('reader', 'reader', 14)])
        self.assertEqual(out[R.GRANT.table][0]['agent_id'], 14)

    def test_immediate_keys_indexes_and_child_joins_are_declared(self):
        layout = D.WORK_ITEMS.layout()
        self.assertEqual(layout[R.SEAT.table]['pos'], 'seq')
        self.assertEqual(layout[R.GRANT.table]['parent_cols'], ('item_id', 'artifact_id'))
        self.assertEqual(layout[R.GRANT.table]['ref_cols'], ('item_id', 'id'))
        self.assertIn(('id', 'bigint'), layout[R.ARTIFACT_TABLE]['keys'])
        ddl = '\n'.join(D.WORK_ITEMS.ddl())
        self.assertEqual(ddl.count('CREATE TABLE orgtree.work_item_artifact_grants'), 1)
        self.assertIn('recipient_name,pos DESC', ddl)
        self.assertIn('REFERENCES orgtree.agents(id) NOT DEFERRABLE', ddl)
        self.assertNotIn('UNIQUE(artifact_id,agent_id)', ddl)

    def test_inactive_or_gapped_lists_are_refused(self):
        record = {'slug': 'bad', 'review_seats': [{'reviewer': 'a'}, {'reviewer': 'b'}],
                  'artifacts': [{'id': 'r1', 'grants': [{'to': 'x'}, {'to': 'y'}]}]}
        _, rows, _ = convert([record])
        for table, column in ((R.SEAT.table, 'seq'), (R.GRANT.table, 'pos')):
            with self.subTest(table=table):
                damaged = copy.deepcopy(rows)
                damaged[table][1][column] = 7
                with self.assertRaisesRegex(codec.ShapeError, 'occurrence'):
                    decode_one_all(damaged)
        damaged = copy.deepcopy(rows)
        damaged[R.ARTIFACT_TABLE][0]['grants_is'] = 'n'
        with self.assertRaisesRegex(codec.ShapeError, 'inactive list'):
            decode_one_all(damaged)

    def test_whole_item_insert_remaps_artifact_fk_after_global_id_allocation(self):
        record = {'slug': 'global', 'review_seats': [{'reviewer': 'r'}],
                  'delivery': {'pushed': {}}, 'artifacts': [{'id': 'r1', 'grants': [{'to': 'a'}]}]}
        _, rows, _ = convert([record])
        inserted = {}
        starts = {'work_items': 101, R.ARTIFACT_TABLE: 201, R.SEAT.table: 301,
                  R.DELIVERY.table: 401, R.GRANT.table: 501}

        def ids(connection, table, n):
            return list(range(starts[table], starts[table]+n))

        def insert(connection, table, records, *, override=False):
            if records:
                inserted[table] = [dict(r) for r in records]

        with patch.object(C, 'new_ids', ids), patch.object(C, 'insert', insert):
            self.assertEqual(C.store_encoded(None, D.WORK_ITEMS, rows), [101])
        grant = inserted[R.GRANT.table][0]
        self.assertEqual((grant['id'], grant['item_id'], grant['artifact_id']), (501, 101, 201))
        self.assertEqual(inserted[R.ARTIFACT_TABLE][0]['id'], 201)
        self.assertEqual(inserted[R.SEAT.table][0]['item_id'], 101)
        decoded = decode_one_all(inserted)
        self.assertEqual(exact(decoded), exact(record))

    def test_default_allocation_does_not_collide_with_later_retained_rows(self):
        old_record = {'slug': 'keep', 'delivery': {'committed': {}},
                      'artifacts': [{'id': 'r1', 'grants': [{'to': 'a'}]}]}
        _, old, _ = convert([old_record])
        record = {'slug': 'keep', 'delivery': {'implemented': {}, 'committed': {}},
                  'artifacts': [{'id': 'new', 'grants': [{'to': 'b'}]},
                                {'id': 'r1', 'grants': [{'to': 'a'}]}]}
        out = {}
        docket_events.encode_current(record, D.row_keys(record, id=1, list_key='active', ord=0), [], out,
                                     previous_relations=old[R.DELIVERY.table], previous_children=old)
        self.assertEqual([r['id'] for r in out[R.DELIVERY.table]], [2, 1])
        self.assertEqual([r['id'] for r in out[R.ARTIFACT_TABLE]], [2, 1])
        self.assertEqual([r['id'] for r in out[R.GRANT.table]], [2, 1])
        self.assertEqual(exact(decode_one_all(out)), exact(record))


def decode_one_all(rows):
    children = codec.Children(rows, D.WORK_ITEMS.layout())
    return docket_events.decode_item(rows['work_items'][0], children, [])


if __name__ == '__main__':
    unittest.main()
