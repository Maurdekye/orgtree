"""Recorded principals keep their exact shape and never gain live metadata."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest

from orgtree.orgdb import codec, principal_columns as P


class PrincipalColumns(unittest.TestCase):
    def test_missing_null_strings_and_actor_objects(self):
        values = (codec.MISSING, None, 'user', 'orgtree', '@org:peer', '@net:peer',
                  'node@4', '', {}, {'node': 'worker', 'generation': 4, 'born': 'stamp'},
                  {'node': None, 'generation': None, 'born': None, 'deleted': None},
                  {'node': '', 'generation': 0, 'born': '', 'deleted': False})
        for value in values:
            with self.subTest(value=value):
                row, extra = P.encode('by', value)
                actual = P.decode('by', row, extra)
                if value is codec.MISSING:
                    self.assertIs(actual, codec.MISSING)
                else:
                    self.assertEqual(actual, value)
                self.assertFalse(any(k.endswith('_agent_id') for k in row))

    def test_unknown_keys_and_nonfitting_fields_stay_at_original_path(self):
        values = (False, 0, [], ['user'], '\0\ud800',
                  {'node': '\0\ud800', 'generation': True, 'born': ['unknown'],
                   'deleted': 0, 'other': {'value': '\0\ud800'}},
                  {'node': 'worker', 'generation': 10 ** 100, 'born': None})
        for value in values:
            with self.subTest(value=value):
                row, extra = P.encode('by', value)
                restored_extra = codec.from_column('json', codec.to_column('json', extra))
                self.assertEqual(P.decode('by', row, restored_extra), value)
        row, extra = P.encode('by', {'node': 'worker', 'generation': 10 ** 100})
        self.assertIsNone(row['by_generation'])
        self.assertEqual(extra, {'by': {'generation': 10 ** 100}})

    def test_history_actor_reuses_existing_header_columns(self):
        aliases = {'node': 'by_node', 'generation': 'by_generation', 'born': 'by_born'}
        value = {'node': 'before-rename', 'generation': 3, 'born': 'old', 'deleted': False}
        row, extra = P.encode('by', value, prefix='history_by', aliases=aliases)
        self.assertEqual(row['by_node'], 'before-rename')
        self.assertNotIn('history_by_name', row)
        self.assertNotIn('history_by_generation', row)
        self.assertEqual(P.decode('by', row, extra, prefix='history_by', aliases=aliases), value)

    def test_nonfinite_principal_keeps_existing_shape_refusal(self):
        for value in ({'generation': float('nan')}, {'unknown': float('inf')}):
            with self.subTest(value=value):
                with self.assertRaises(codec.ShapeError):
                    P.encode('by', value)

    def test_damaged_or_duplicated_recorded_fields_are_refused(self):
        row, extra = P.encode('by', {'node': 'worker', 'generation': 4})
        for change in ({'by_is': 'n'}, {'by_kind': 'user'},
                       {'by_name_null': True}, {'by_generation': True}):
            with self.subTest(change=change):
                with self.assertRaises(codec.ShapeError):
                    P.decode('by', {**row, **change}, extra)
        with self.assertRaises(codec.ShapeError):
            P.decode('by', row, {'by': {'node': 'other'}})
        string_row, _ = P.encode('by', 'worker')
        with self.assertRaises(codec.ShapeError):
            P.decode('by', {**string_row, 'by_generation': 4}, {})
        missing_extra, _ = P.encode('by', False)
        with self.assertRaises(codec.ShapeError):
            P.decode('by', missing_extra, {})


if __name__ == '__main__':
    unittest.main()
