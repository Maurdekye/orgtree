"""The exact column codec of the one-database-per-org layout (design §3.0).

No database: encode -> decode in memory. test_orgdb_codec_pg.py repeats the
round trip through real PostgreSQL columns.

What it proves:
  * every field kind round-trips exactly as canonical JSON (sorted keys,
    exact types): absent, present null (with and without a null flag), values
    of the right type, and values of the wrong type, which go to extra;
  * numbers keep int versus float (1e20, 5.0, 5e-324, huge ints); -0.0 goes to
    extra; a NaN anywhere raises ShapeError (no JSON column can hold it);
  * timestamps: the canonical form keeps no text; seconds, microseconds,
    offsets and over-long fractions keep their text; non-timestamps go to
    extra;
  * U+0000 in a text column goes to extra;
  * flattened objects: null, missing, not an object, unknown keys and misfit
    sub-fields; lists of records and of scalars, nested lists, a misfit element
    sending the whole list to extra, and unknown top-level keys;
  * a record that is not an object raises ShapeError;
  * layout and DDL: child tables, keys renamed for children, primary and
    foreign keys; colliding column names refuse.

Run:  python tools/run-python-verification.py tests/test_orgdb_codec.py
"""

import json
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec
from orgtree.orgdb.codec import Field, Spec

TURN = Spec('t_turns', (
    Field('n', 'int'),
    Field('at', 'ts'),
    Field('cost', 'num'),
    codec.Field('tools', 'list', item='text', table='t_turn_tools'),
))

RECORD = Spec('t_rec', (
    Field('name', 'text'),
    Field('charter', 'text', nullable=True),
    Field('grant', 'num'),
    Field('ui_order', 'float'),
    Field('turn_seq', 'int'),
    Field('primary', 'bool'),
    Field('created', 'ts'),
    Field('envelope', 'json'),
    Field('scope', 'obj', spec=Spec('', (
        Field('mode', 'text'),
        Field('effort', 'text', nullable=True),
        Field('dirs', 'list', item='text', table='t_scope_dirs'),
        Field('inner', 'obj', spec=Spec('', (Field('x', 'int'),))),
    ))),
    Field('turns', 'list', spec=TURN),
    Field('stamps', 'list', item='ts', table='t_stamps'),
))
KEYS = (('id', 'bigint'),)
LINK = {'id': 'rec_id'}


def canon(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def round_trip(record, spec=RECORD):
    out: codec.Rows = {}
    codec.encode(spec, record, {'id': 1}, out, link=LINK)
    lay = codec.layout(spec, KEYS, LINK)
    children = codec.Children({t: rows for t, rows in out.items() if t != spec.table}, lay)
    (row,) = out[spec.table]
    return codec.decode(spec, row, children, (1,)), out


class RoundTrip(unittest.TestCase):
    def check(self, record, spec=RECORD):
        back, out = round_trip(record, spec)
        self.assertEqual(canon(back), canon(record))
        return out

    def test_full_record(self):
        out = self.check({
            'name': 'x', 'charter': 'c', 'grant': 5, 'ui_order': 1.5, 'turn_seq': 3,
            'primary': True, 'created': '2026-10-02T15:48:00.123Z', 'envelope': {'a': [1, None]},
            'scope': {'mode': 'm', 'effort': 'high', 'dirs': ['a', 'b'], 'inner': {'x': 1}},
            'turns': [{'n': 1, 'at': '2026-10-02T15:48:00.123Z', 'cost': 0.25, 'tools': ['t']},
                      {'n': 2, 'cost': 3, 'tools': []}],
            'stamps': ['2026-10-02T15:48:00Z', '2026-10-02T15:48:00.000Z'],
        })
        (row,) = out['t_rec']
        self.assertIsNone(row['extra'])
        self.assertEqual(row['scope_is'], 'o')
        self.assertEqual(row['scope_dirs_is'], 'l')
        self.assertEqual([r['pos'] for r in out['t_turns']], [0, 1])
        self.assertEqual(out['t_turn_tools'], [{'rec_id': 1, 'pos': 0, 'pos_2': 0, 'value': 't'}])
        self.assertEqual([r['value_text'] for r in out['t_stamps']], ['2026-10-02T15:48:00Z', None])

    def test_absent_and_null(self):
        self.check({})
        out = self.check({'charter': None, 'name': None, 'envelope': None, 'scope': None,
                          'turns': None, 'stamps': None})
        (row,) = out['t_rec']
        self.assertTrue(row['charter_null'])
        self.assertEqual(row['extra'].obj, {'name': None, 'envelope': None})
        self.assertEqual((row['scope_is'], row['turns_is']), ('n', 'n'))

    def test_wrong_types_go_to_extra(self):
        out = self.check({'name': 7, 'grant': '5', 'ui_order': 2, 'turn_seq': True,
                          'primary': 1, 'created': 1700000000.5, 'charter': ['x'],
                          'scope': ['not', 'an', 'object'], 'turns': {'not': 'a list'},
                          'stamps': 'x'})
        (row,) = out['t_rec']
        self.assertEqual(set(row['extra'].obj), {'name', 'grant', 'ui_order', 'turn_seq',
                                                 'primary', 'created', 'charter', 'scope',
                                                 'turns', 'stamps'})
        self.assertEqual((row['scope_is'], row['turns_is'], row['stamps_is']), ('x', 'x', 'x'))

    def test_numbers_keep_their_types(self):
        for v in (0, -3, 2 ** 70, 5.0, 1e20, 1e-7, 5e-324, 123.456, 0.1, -1.5, 1.7976931348623157e308):
            with self.subTest(v=v):
                out = self.check({'grant': v})
                self.assertIsNone(out['t_rec'][0]['extra'])
        out = self.check({'grant': -0.0, 'ui_order': -0.0})
        self.assertEqual(set(out['t_rec'][0]['extra'].obj), {'grant'})   # float keeps -0.0
        out = self.check({'turn_seq': 2 ** 63})
        self.assertEqual(set(out['t_rec'][0]['extra'].obj), {'turn_seq'})
        for bad in ({'grant': float('nan')}, {'envelope': {'x': float('inf')}},
                    {'unknown': [float('-inf')]}):
            with self.subTest(bad=bad), self.assertRaises(codec.ShapeError):
                round_trip(bad)

    def test_timestamps(self):
        cases = {
            '2026-10-02T15:48:00.123Z': None,
            '2026-10-02T15:48:00Z': '2026-10-02T15:48:00Z',
            '2026-10-02T15:48:00.123456+00:00': '2026-10-02T15:48:00.123456+00:00',
            '2026-10-02T17:48:00.123+02:00': '2026-10-02T17:48:00.123+02:00',
            '1969-07-20T20:17:40.000Z': None,
            '2026-10-02T15:48:00.1234567Z': '2026-10-02T15:48:00.1234567Z',
        }
        for text, kept in cases.items():
            with self.subTest(text=text):
                out = self.check({'created': text})
                row = out['t_rec'][0]
                self.assertIsNone(row['extra'])
                self.assertEqual(row['created_text'], kept)
        for bad in ('2026-10-02', '2026-10-02T15:48:00', 'yesterday', ''):
            with self.subTest(bad=bad):
                out = self.check({'created': bad})
                self.assertEqual(out['t_rec'][0]['extra'].obj, {'created': bad})

    def test_nul_characters(self):
        out = self.check({'name': 'a\x00b', 'envelope': 'c\x00d', 'stamps': [], 'turns': [
            {'tools': ['ok', 'b\x00d']}]})
        row = out['t_rec'][0]
        self.assertEqual(set(row['extra'].obj), {'name'})
        self.assertEqual(out['t_turns'][0]['tools_is'], 'x')     # the misfit list went whole

    def test_objects_and_lists(self):
        self.check({'scope': {}})
        self.check({'scope': {'mode': 1, 'surprise': {'k': 'v'}, 'effort': None,
                              'inner': 'flat', 'dirs': [1, 2]}})
        self.check({'scope': {'inner': {'x': 1, 'y': 2}}})
        self.check({'turns': [{}, {'n': 1, 'extra_key': [1]}], 'stamps': []})
        self.check({'turns': [{'n': 1}, 'not a record']})
        self.check({'stamps': ['2026-10-02T15:48:00.123Z', None]})
        self.check({'mystery': {'deep': [1, {'a': None}]}, 'other': None})

    def test_not_an_object(self):
        for bad in ([], 'x', None, 3):
            with self.subTest(bad=bad), self.assertRaises(codec.ShapeError):
                codec.encode(RECORD, bad, {'id': 1}, {})


class Layout(unittest.TestCase):
    def test_tables_and_keys(self):
        lay = codec.layout(RECORD, KEYS, LINK)
        self.assertEqual(list(lay), ['t_rec', 't_scope_dirs', 't_turns', 't_turn_tools', 't_stamps'])
        self.assertEqual(lay['t_turn_tools']['keys'],
                         (('rec_id', 'bigint'), ('pos', 'integer'), ('pos_2', 'integer')))
        self.assertEqual((lay['t_turn_tools']['parent_table'], lay['t_turn_tools']['parent_cols'],
                          lay['t_turn_tools']['ref_cols']),
                         ('t_turns', ('rec_id', 'pos'), ('rec_id', 'pos')))
        self.assertEqual((lay['t_turns']['parent_cols'], lay['t_turns']['ref_cols']),
                         (('rec_id',), ('id',)))

    def test_ddl(self):
        stmts = codec.ddl(RECORD, KEYS, link=LINK,
                          record_columns=('id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY',))
        self.assertEqual(len(stmts), 5)
        self.assertIn('CREATE TABLE orgtree.t_rec (\n  id bigint GENERATED ALWAYS AS IDENTITY '
                      'PRIMARY KEY,\n  "name" text,', stmts[0])
        self.assertNotIn('"id" bigint NOT NULL', stmts[0])
        self.assertIn('"created" timestamptz,\n  "created_text" text,', stmts[0])
        self.assertIn('"charter_null" boolean', stmts[0])
        self.assertIn('"scope_inner_x" bigint', stmts[0])
        self.assertIn('"grant" numeric', stmts[0])
        self.assertIn('PRIMARY KEY ("rec_id", "pos", "pos_2")', stmts[3])
        self.assertIn('FOREIGN KEY ("rec_id") REFERENCES orgtree.t_rec ("id") ON DELETE CASCADE',
                      '\n'.join(stmts))
        self.assertIn('FOREIGN KEY ("rec_id", "pos") REFERENCES orgtree.t_turns ("rec_id", "pos")',
                      '\n'.join(stmts))

    def test_collisions_refuse(self):
        bad = Spec('t_bad', (Field('a_b', 'text'),
                             Field('a', 'obj', spec=Spec('', (Field('b', 'text'),)))))
        with self.assertRaises(ValueError):
            codec.columns(bad)

    def test_bad_fields_refuse(self):
        for kwargs in ({'kind': 'nope'}, {'kind': 'obj'}, {'kind': 'list'},
                       {'kind': 'list', 'item': 'text'}, {'kind': 'obj', 'nullable': True},
                       {'kind': 'text', 'table': 'x'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Field('k', **kwargs)


if __name__ == '__main__':
    unittest.main()
