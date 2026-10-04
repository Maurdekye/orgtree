"""Docket current links preserve continuity, authored names and physical identity."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import unittest
from unittest.mock import patch

from orgtree.orgdb import codec, current_refs as R, docket_events, mappers, sections
from orgtree.orgdb.compat import rows as C
from orgtree.orgdb.mappers import agents as A, docket as D
from orgtree.ledger import Org


def convert(doc):
    rows, context, _ = sections.encode_document(doc, mappers.sections())
    decoded = sections.decode_document(rows, mappers.sections(), sections.Context())
    return rows, context, decoded


def context(nodes):
    result = sections.Context()
    for name, record in nodes.items():
        result.add_node(name, record)
    return result


class Continuity(unittest.TestCase):
    def test_supported_live_references_match_the_ledger_oracle(self):
        nodes = {'head': {'state': 'live', 'seat_id': 'lineage', 'generation': 8},
                 'head@0': {'state': 'live', 'seat_id': 'lineage', 'generation': 0}}
        org = Org.__new__(Org)
        org.d = {'nodes': nodes}
        ctx = context(nodes)
        for name in nodes:
            for born in (codec.MISSING, None, '', 'lineage', 'other'):
                for gen in (codec.MISSING, None, 0, 1, 8, 9):
                    for deleted in (codec.MISSING, None, False, True):
                        ref = {'node': name}
                        for key, value in (('born', born), ('generation', gen), ('deleted', deleted)):
                            if value is not codec.MISSING:
                                ref[key] = value
                        with self.subTest(ref=ref):
                            same, _ = org._work_identity_state(ref)
                            aid = ctx.current(ref)
                            self.assertEqual(aid == ctx.ids[name], same)
                            if not same:
                                self.assertEqual(ctx.current_tombstones[aid]['state'], 'deleted')

    def test_retired_and_bearer_rows_remain_distinct_identities(self):
        ctx = context({'head': {'generation': 7, 'seat_id': 'same', 'state': 'archived'},
                       'head@0': {'generation': 0, 'seat_id': 'same', 'state': 'live'}})
        self.assertEqual(ctx.current({'node': 'head', 'born': 'same'}), ctx.ids['head'])
        self.assertEqual(ctx.current({'node': 'head@0', 'born': 'same'}), ctx.ids['head@0'])
        self.assertNotEqual(ctx.ids['head'], ctx.ids['head@0'])

    def test_stale_stamps_do_not_bind_to_a_compacted_namesake(self):
        ctx = context({'x': {'generation': 99, 'seat_id': 'new'}})
        first = ctx.current({'node': 'x', 'born': 'old-a', 'generation': 1})
        second = ctx.current({'node': 'x', 'born': 'old-b', 'generation': 1})
        no_birth = ctx.current({'node': 'x', 'generation': 100})
        self.assertEqual(ctx.current({'node': 'x', 'born': 'old-a', 'generation': 1}), first)
        self.assertEqual(len({first, second, no_birth, ctx.ids['x']}), 4)
        self.assertEqual(ctx.current_tombstones[first]['seat_id'], 'old-a')

    def test_non_agent_and_misfit_references_have_no_invented_link(self):
        ctx = context({'x': {}})
        unsupported = (codec.MISSING, None, False, 0, 0.0, [], {}, '', 'user', 'orgtree',
                       '@org:peer', '@net:peer', '\0', '\ud800', {'node': 2},
                       {'node': 'x', 'generation': True}, {'node': 'x', 'generation': '3'},
                       {'node': 'x', 'born': []}, {'node': 'x', 'deleted': 1})
        for ref in unsupported:
            with self.subTest(ref=ref):
                self.assertIsNone(ctx.current(ref))
        self.assertFalse(ctx.current_tombstones)

    def test_unchanged_reference_survives_rename_and_a_new_namesake(self):
        ctx = context({'old': {'seat_id': 'before', 'generation': 2}})
        ref = {'node': 'old', 'born': 'before', 'generation': 2}
        aid = ctx.current(ref)
        ctx.ids['renamed'] = ctx.ids.pop('old')
        ctx.names[aid] = 'renamed'
        namesake = ctx.add_node('old', {'seat_id': 'after', 'generation': 9})
        self.assertEqual(ctx.current(ref, copy.deepcopy(ref), aid), aid)
        self.assertEqual(ctx.current('old', 'old', aid), aid)
        self.assertEqual(ctx.current(dict(ref, by='new', **{'from': 'later'}),
                                     dict(ref, by='old'), aid), aid)
        self.assertEqual(ctx.current(dict(ref, node='renamed'), ref, aid), aid)
        self.assertEqual(ctx.current({'node': 'old', 'born': 'after'}, ref, aid), namesake)
        self.assertNotEqual(ctx.current(dict(ref, deleted=True), ref, aid), namesake)

    def test_a_changed_reference_does_not_merge_two_nodes_with_the_same_birth(self):
        ctx = context({'x': {'seat_id': 'shared'}, 'x@0': {'seat_id': 'shared'}})
        old = {'node': 'x', 'born': 'shared'}
        new = {'node': 'x@0', 'born': 'shared'}
        self.assertEqual(ctx.current(new, old, ctx.ids['x']), ctx.ids['x@0'])


class MappedRoles(unittest.TestCase):
    def test_all_seven_current_roles_resolve_and_historical_actors_do_not(self):
        ref = {'node': 'x', 'born': 'old', 'generation': 1}
        doc = {'nodes': {'x': {'seat_id': 'new', 'generation': 2}}, 'work_items': [{
            'slug': 'all', 'owner': ref, 'reviewer': ref,
            'holders': [dict(ref, by={'node': 'historical', 'born': 'authored'})],
            'review_seats': [{'reviewer': 'x', 'holder': ref, 'recheck_owner': ref,
                              'granted_by': 'historical'}],
            'artifacts': [{'id': 'r1', 'grants': [{'to': 'x', 'by': 'historical'}]}]}]}
        rows, ctx, decoded = convert(doc)
        self.assertEqual(R.exact(decoded), R.exact(doc))
        tomb = rows['work_items'][0]['owner_agent_id']
        self.assertNotEqual(tomb, ctx.ids['x'])
        self.assertEqual(rows['work_items'][0]['reviewer_agent_id'], tomb)
        self.assertEqual(rows['work_item_holders'][0]['agent_id'], tomb)
        seat = rows['work_item_review_seats'][0]
        for role in ('reviewer', 'holder', 'recheck_owner'):
            self.assertEqual(seat[role+'_agent_id'], tomb)
        self.assertEqual(rows['work_item_artifact_grants'][0]['agent_id'], ctx.ids['x'])
        self.assertNotIn('historical', ctx.names.values())
        target = next(r for r in rows['agents'] if r['id'] == tomb)
        self.assertTrue(target['tombstone'])
        self.assertEqual(target['state'], 'deleted')
        self.assertEqual(target['lineage_born'], 'old')

    def test_role_shapes_deleted_flags_and_nulls_round_trip_exactly(self):
        values = (None, False, 0, 0.0, '', [], {}, {'node': None},
                  {'node': 'x', 'born': None, 'generation': None, 'deleted': None},
                  {'node': 'x', 'deleted': False}, {'node': 'x', 'deleted': True},
                  {'node': 'x', 'deleted': 1}, {'node': '\0\ud800', 'custom': [0, 0.0]})
        for value in values:
            with self.subTest(value=value):
                doc = {'nodes': {'x': {}}, 'work_items': [{'slug': 'shapes', 'owner': value,
                        'reviewer': value, 'holders': [value] if isinstance(value, dict) else [],
                        'review_seats': [{'reviewer': value, 'holder': value, 'recheck_owner': value}],
                        'artifacts': [{'id': 'r1', 'grants': [{'to': value}]}]}]}
                rows, _, decoded = convert(doc)
                self.assertEqual(R.exact(decoded), R.exact(doc))
                if R.reference(value) is None:
                    self.assertIsNone(rows['work_items'][0]['owner_agent_id'])
        rows, _, decoded = convert({'work_items': [{'slug': 'absent'}]})
        self.assertNotIn('owner', decoded['work_items'][0])
        self.assertIsNone(rows['work_items'][0]['owner_agent_id'])

    def test_selected_writer_preserves_previous_ids_and_holder_authorship(self):
        ctx = context({'x': {'seat_id': 'stamp', 'generation': 1}})
        ref = {'node': 'x', 'born': 'stamp', 'generation': 1}
        item = {'slug': 'writer', 'owner': ref, 'reviewer': ref,
                'holders': [dict(ref, by='then')],
                'review_seats': [{'reviewer': 'x', 'holder': ref, 'recheck_owner': ref}],
                'artifacts': [{'id': 'r1', 'grants': [{'to': 'x'}]}]}
        first = {}
        keys = D.row_keys(item, id=1, list_key='active', ord=0)
        docket_events.encode_current(item, keys, [], first, resolve_current=ctx.current)
        old_id = ctx.ids['x']
        ctx.ids['renamed'] = ctx.ids.pop('x')
        ctx.names[old_id] = 'renamed'
        ctx.add_node('x', {'seat_id': 'namesake', 'generation': 100})
        changed = copy.deepcopy(item)
        # The ledger rebinds these dictionaries, preserving historical aliases.
        changed['owner'] = dict(changed['owner'], node='renamed')
        changed['reviewer'] = dict(changed['reviewer'], node='renamed')
        changed['holders'][0]['by'] = 'later'
        second = {}
        docket_events.encode_current(changed, keys, [], second, previous_item=first['work_items'][0],
                                     previous_children=first, resolve_current=ctx.current)
        for role in ('owner', 'reviewer'):
            self.assertEqual(second['work_items'][0][role+'_agent_id'], old_id)
        self.assertEqual(second['work_item_holders'][0]['agent_id'], old_id)
        self.assertEqual(second['work_item_artifact_grants'][0]['agent_id'], old_id)
        for role in ('reviewer', 'holder', 'recheck_owner'):
            self.assertEqual(second['work_item_review_seats'][0][role+'_agent_id'], old_id)
        ch = codec.Children({k: v for k, v in second.items() if k != 'work_items'}, D.WORK_ITEMS.layout())
        self.assertEqual(R.exact(docket_events.decode_item(second['work_items'][0], ch, [])), R.exact(changed))

    def test_current_reference_ddl_is_immediate_and_indexed_on_each_many_side(self):
        ddl = '\n'.join(D.WORK_ITEMS.ddl())
        for column in ('owner_agent_id', 'reviewer_agent_id', 'agent_id', 'holder_agent_id',
                       'recheck_owner_agent_id'):
            self.assertIn(column+' bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE', ddl)
        for index in ('work_items_owner_agent', 'work_items_reviewer_agent', 'work_item_holders_agent',
                      'work_item_review_seats_reviewer', 'work_item_review_seats_holder',
                      'work_item_review_seats_recheck_owner', 'work_item_artifact_grants_agent'):
            self.assertIn('CREATE INDEX '+index, ddl)
        self.assertIn("WHERE tombstone AND state='deleted'", '\n'.join(A.AGENTS.ddl()))


class RuntimeHeaders(unittest.TestCase):
    def test_runtime_role_uses_a_selected_typed_header_and_preserves_previous_link(self):
        names = C.Names(object())
        row = dict(id=5, name='renamed', tombstone=False, lineage_born='stamp', generation=8, extra=None)
        with patch.object(C, 'dict_rows', return_value=[row]) as read:
            self.assertEqual(names.current({'node': 'renamed', 'born': 'stamp'}), 5)
            sql, params = read.call_args.args[1:]
            self.assertIn('WHERE name=%s AND NOT tombstone', sql)
            self.assertNotIn('->', sql)
            self.assertEqual(params, ('renamed',))
            read.reset_mock()
            self.assertEqual(names.current('old', 'old', 5), 5)
            read.assert_not_called()
        with patch.object(names, 'current_record', return_value=row), \
                patch.object(names, 'current_tombstone', return_value=9) as mint:
            self.assertEqual(names.current({'node': 'renamed', 'born': 'older'}), 9)
            self.assertEqual(mint.call_args.args[0].stamp, ('renamed', 'older', 0))

    def test_runtime_tombstone_is_inserted_with_its_stamp_before_returning_its_fk(self):
        operations = []
        class Connection:
            def execute(self, sql, params):
                operations.append((sql, params))
                return self
            def fetchone(self):
                return None
        c = Connection()
        names = C.Names(c)
        ref = R.reference({'node': 'x', 'born': 'older', 'generation': 3})
        def inserted(connection, table, rows):
            self.assertIs(connection, c)
            self.assertEqual(table, 'agents')
            row = rows[0]
            self.assertEqual((row['id'], row['name'], row['lineage_born'], row['generation'], row['state']),
                             (17, 'x', 'older', 3, 'deleted'))
            self.assertTrue(row['tombstone'])
            operations.append(('inserted', row))
        with patch.object(C, 'new_ids', return_value=[17]), patch.object(C, 'insert', side_effect=inserted):
            self.assertEqual(names.current_tombstone(ref), 17)
        self.assertEqual(operations[-1][0], 'inserted')
        lookups = [(sql, params) for sql, params in operations if sql.startswith('SELECT id')]
        self.assertEqual(len(lookups), 2)
        for sql, params in lookups:
            self.assertIn('lineage_born=%s AND generation=%s', sql)
            self.assertNotIn('->', sql)
            self.assertEqual(params, ('x', 'older', 3))

    def test_header_lookup_restores_only_selected_identity_misfits(self):
        row = dict(id=4, name='x', tombstone=False, lineage_born=None, generation=None,
                   extra=codec.to_column('json', {'seat_id': 23, 'generation': '8', 'charter': 'private'}))
        decoded = C.agent_identity(row)
        self.assertEqual(decoded, dict(id=4, name='x', tombstone=False, seat_id=23, generation='8'))
        del row['extra']
        self.assertEqual(C.agent_identity(row), dict(id=4, name='x', tombstone=False))

    def test_deleted_node_keeps_its_stamp_and_clears_its_owned_rows(self):
        row = dict(id=9, lineage_born='original', generation=7, extra=None)
        with patch.object(C, 'dict_rows', return_value=[row]) as read, \
                patch.object(C, '_clear_node_rows') as clear, \
                patch.object(C._turns(), 'clear_recent') as clear_recent, \
                patch.object(C, '_update_agent') as update:
            connection = object()
            self.assertEqual(C.node_delete(connection, 'old'), 1)
        self.assertIn('FOR UPDATE', read.call_args.args[1])
        clear.assert_called_once_with(connection, 9)
        clear_recent.assert_called_once_with(connection, 9)
        result = update.call_args.args[2]
        self.assertEqual((result['id'], result['state'], result['lineage_born'], result['generation']),
                         (9, 'deleted', 'original', 7))
        self.assertTrue(result['tombstone'])
        self.assertIsNone(result['mailbox_id'])


if __name__ == '__main__':
    unittest.main()
