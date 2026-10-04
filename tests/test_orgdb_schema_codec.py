"""Typed schema adapters keep record paths, placement and unusual legacy values."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import json
import math
import unittest

from orgtree.orgdb import codec

F, S = codec.Field, codec.Spec


def token(value):
    return json.dumps(value, sort_keys=True, allow_nan=False)


def round_trip(spec, record):
    rows = {}
    codec.encode(spec, record, {'id': 17}, rows, link={'id': 'record_id'})
    layout = codec.layout(spec, (('id', 'bigint'),), {'id': 'record_id'})
    return codec.decode(spec, rows[spec.table][0], codec.Children(rows, layout), (17,)), rows


class SchemaCodec(unittest.TestCase):
    def test_sum_and_principal_inside_a_flattened_object(self):
        spec = S('records', (F('settings', 'obj', spec=S('', (
            F('estimate', 'sum', col='cost'), F('author', 'principal', col='actor')))),))
        cases = ({}, {'settings': None}, {'settings': {}},
                 {'settings': {'estimate': ['i', 10 ** 90], 'author': 'user'}},
                 {'settings': {'estimate': ['f', -0.0, 1.0],
                               'author': {'node': 'worker', 'generation': 3, 'born': None,
                                          'unknown': {'raw': '\0\ud800'}}}},
                 {'settings': {'estimate': ['i', True],
                               'author': {'node': '\0\ud800', 'generation': True}}},
                 {'settings': {'estimate': False, 'author': ['historical']}},
                 {'settings': {'estimate': None, 'author': None}})
        for record in cases:
            with self.subTest(record=record):
                back, rows = round_trip(spec, record)
                self.assertEqual(token(back), token(record))
                self.assertNotIn('settings_cost', rows['records'][0])
                self.assertNotIn('settings_actor', rows['records'][0])
        back, _ = round_trip(spec, cases[4])
        self.assertEqual(math.copysign(1, back['settings']['estimate'][1]), -1)

    def test_adapters_in_child_records_keep_occurrences_and_order(self):
        spec = S('records', (F('entries', 'list', spec=S('entries', (
            F('by', 'principal'), F('sum', 'sum')))),))
        record = {'entries': [{'by': {'node': 'x', 'generation': 0}, 'sum': ['i', 0]},
                              {'by': {'node': 'x', 'generation': 0}, 'sum': ['i', 0]},
                              {'by': '@org:peer', 'sum': ['f', 1e16, 1.0]},
                              {'by': None, 'sum': {'unexpected': 3}}]}
        back, rows = round_trip(spec, record)
        self.assertEqual(token(back), token(record))
        self.assertEqual([r['pos'] for r in rows['entries']], [0, 1, 2, 3])
        self.assertTrue(all(r['record_id'] == 17 for r in rows['entries']))
        self.assertEqual(rows['entries'][2]['by_kind'], 'outside')

    def test_history_aliases_reuse_the_existing_actor_header(self):
        aliases = (('node', 'by_node'), ('generation', 'by_generation'), ('born', 'by_born'))
        spec = S('events', (F('history', 'obj', spec=S('', (
            F('by', 'principal', principal_aliases=aliases),
            F('raised_by', 'principal')))),))
        record = {'history': {'by': {'node': 'old-name', 'generation': 2, 'born': 'old-seat'},
                              'raised_by': 'user'}}
        back, rows = round_trip(spec, record)
        row = rows['events'][0]
        self.assertEqual(token(back), token(record))
        self.assertEqual(row['by_node'], 'old-name')
        self.assertNotIn('history_by_name', row)
        columns = dict(codec.columns(spec))
        self.assertEqual(columns['by_node'], 'text')
        self.assertEqual(columns['history_by_is'], 'char(1)')
        self.assertNotIn('history_by_generation', columns)

    def test_layout_and_markers_cover_every_typed_adapter_column(self):
        spec = S('records', (F('estimate', 'sum'), F('by', 'principal')))
        _, rows = round_trip(spec, {'estimate': ['f', 1.0, 0.1],
                                    'by': {'node': 'x', 'generation': None}})
        self.assertEqual(set(rows['records'][0]) - {'id', 'extra'}, set(dict(codec.columns(spec))))
        markers = {col: (path, values) for col, path, values in codec.markers(spec)}
        self.assertEqual(markers['estimate_is'], (('estimate',), ('n', 'l', 'x')))
        self.assertEqual(markers['by_is'], (('by',), ('n', 'o', 's', 'x')))
        text = '\n'.join(codec.ddl(spec, (('id', 'bigint'),)))
        self.assertIn('"estimate_integer" numeric', text)
        self.assertIn('"estimate_compensation" double precision', text)
        self.assertNotIn('"estimate" json', text)
        self.assertNotIn('"by" json', text)

    def test_damaged_typed_values_fail_through_the_public_codec(self):
        spec = S('records', (F('estimate', 'sum'), F('by', 'principal')))
        _, rows = round_trip(spec, {'estimate': ['f', 1e16, 1.0], 'by': 'worker'})
        row = rows['records'][0]
        for changes in ({'estimate_compensation': None}, {'estimate_kind': 'i'},
                        {'by_kind': 'user'}, {'by_generation': 3}):
            with self.subTest(changes=changes), self.assertRaises(codec.ShapeError):
                codec.decode(spec, {**row, **changes}, None, (17,))

    def test_column_aliases_are_explicit_and_cannot_collide(self):
        for aliases in ([('node', 'by_node')], (('node', ''),), (('other', 'by_other'),),
                        (('node', 'by_node'), ('node', 'another'))):
            with self.subTest(aliases=aliases), self.assertRaises(ValueError):
                F('by', 'principal', principal_aliases=aliases)
        with self.assertRaises(ValueError):
            F('by', 'text', principal_aliases=(('node', 'by_node'),))
        spec = S('records', (F('by', 'principal', principal_aliases=(('node', 'by_generation'),)),))
        with self.assertRaisesRegex(ValueError, 'collide'):
            codec.columns(spec)


if __name__ == '__main__':
    unittest.main()
