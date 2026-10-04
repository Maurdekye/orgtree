"""Independent verifier keeps derived projections separate from legacy data."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('derived_verifier', ROOT / 'tools/orgdb_verify.py')
ov = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ov
spec.loader.exec_module(ov)


class Cursor:
    def __init__(self, rows):
        self.data = rows

    def __iter__(self):
        return iter(self.data)

    def fetchall(self):
        return self.data


class DestinationConnection:
    """Only the SQL destination boundary is simulated, not verifier comparisons."""
    def __init__(self, fields, row):
        self.fields, self.row, self.selects = fields, row, []

    def execute(self, query, args=None):
        if 'information_schema.columns' in query:
            return Cursor([('work_items', c, dt) for c, dt in self.fields.items()])
        self.selects.append(query)
        columns = [part.split('"')[1] for part in query.split(' FROM ')[0][7:].split(', ')]
        return Cursor([tuple(self.row.get(c) for c in columns)])


def leftovers(dest):
    checker = ov.Verifier(dest, {}, ())
    checker.tool_list_ids = checker.used_tool_lists = set()
    for row in dest.rows('work_items'):
        dest.take('work_items', row)
    checker.leftovers()
    return checker


class DerivedColumns(unittest.TestCase):
    def test_each_declared_docket_projection_is_not_compared_as_data(self):
        for column in ('docket_manual', 'docket_order', 'docket_deadline',
                       'docket_owner_key', 'docket_creator_key', 'docket_reviewer_key',
                       'docket_anchor_key'):
            with self.subTest(column=column):
                connection = DestinationConnection({'id': 'bigint', column: 'text'},
                                                   {'id': 1, column: 'changed derived value'})
                dest = ov.Dest(connection)
                self.assertEqual(leftovers(dest).problems, [])
                self.assertNotIn(column, dest.rows('work_items')[0])
                self.assertNotIn('"' + column + '"', connection.selects[0])

    def test_stored_docket_copies_are_read_for_explicit_source_comparison(self):
        for column in ('docket_policy_extra', 'docket_list_extra', 'docket_scope_meta'):
            with self.subTest(column=column):
                connection = DestinationConnection({'id': 'bigint', column: 'json'},
                                                   {'id': 1, column: '{"title":false}'})
                dest = ov.Dest(connection)
                self.assertEqual(dest.rows('work_items')[0][column], '{"title":false}')
                self.assertIn('"' + column + '"::text', connection.selects[0])

    def test_unmapped_data_value_is_read_and_rejected_with_same_row_count(self):
        # A matching prefix is not enough to classify an unknown value as derived.
        connection = DestinationConnection({'id': 'bigint', 'docket_unmapped_data': 'text'},
                                           {'id': 1, 'docket_unmapped_data': None})
        clean = leftovers(ov.Dest(connection))
        self.assertEqual(clean.problems, [])
        self.assertTrue(any('docket_unmapped_data' in note for note in clean.notes))
        connection.row['docket_unmapped_data'] = 'planted data'
        checker = leftovers(ov.Dest(connection))
        self.assertEqual(len(checker.problems), 1)
        self.assertEqual(checker.problems[0]['field'], 'docket_unmapped_data')
        self.assertEqual(checker.problems[0]['problem'], 'unmapped column holds values in 1 rows')
        self.assertIn('"docket_unmapped_data"', connection.selects[-1])

    def test_agent_numeric_profiles_preserve_type_and_detect_value_changes(self):
        for name in ('ui_order', 'cost_usd'):
            field = next(f for f in ov.NODE if isinstance(f, ov.Col) and f.src == name)
            for source, value in ((0, '0'), (0.0, '0.0'), (1.25, '1.25')):
                with self.subTest(field=name, source=source):
                    dest = ov.Dest(DestinationConnection({}, {}))
                    dest.columns['agents'][name] = 'numeric'
                    checker = ov.Checker(dest)
                    checker.col('nodes', 'lead.' + name, field, True, source, False, None,
                                {'agents': {name: value}}, '', 'agents')
                    self.assertEqual(checker.problems, [])
                    checker.col('nodes', 'lead.' + name, field, True, source, False, None,
                                {'agents': {name: '2.0'}}, '', 'agents')
                    self.assertEqual(len(checker.problems), 1)
                    self.assertIn('value differs', checker.problems[0]['problem'])


if __name__ == '__main__':
    unittest.main()
