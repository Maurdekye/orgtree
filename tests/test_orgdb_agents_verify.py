"""A1 presence metadata is derived; unrecognized authored columns stay checked."""
import import_provenance  # noqa: F401  assert checkout imports

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('a1_verifier',
    Path(__file__).resolve().parents[1] / 'tools/orgdb_verify.py')
ov = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ov
spec.loader.exec_module(ov)


class Cursor:
    def __init__(self, rows):
        self.data = rows

    def fetchall(self):
        return self.data

    def __iter__(self):
        return iter(self.data)


class Connection:
    def __init__(self, table, field, value):
        self.table, self.field, self.value, self.selects = table, field, value, []

    def execute(self, query, args=None):
        if 'information_schema.columns' in query:
            return Cursor([(self.table, 'id', 'bigint'), (self.table, self.field, 'boolean')])
        self.selects.append(query)
        columns = [part.split('"')[1] for part in query.split(' FROM ')[0][7:].split(', ')]
        return Cursor([tuple(1 if col == 'id' else self.value for col in columns)])


def checked(connection):
    dest = ov.Dest(connection)
    checker = ov.Checker(dest)
    checker.tool_list_ids = checker.used_tool_lists = set()
    for row in dest.rows(connection.table):
        dest.take(connection.table, row)
    checker.leftovers()
    return dest, checker


class A1DerivedColumns(unittest.TestCase):
    def test_presence_values_are_not_compared_or_selected(self):
        for table in ('agents', 'asks', 'credit_requests', 'scope_requests'):
            for field in ov.DERIVED[table]:
                for value in (False, True):
                    with self.subTest(table=table, field=field, value=value):
                        connection = Connection(table, field, value)
                        dest, checker = checked(connection)
                        self.assertEqual(checker.problems, [])
                        self.assertNotIn(field, dest.rows(table)[0])
                        self.assertNotIn('"'+field+'"', connection.selects[0])

    def test_undeclared_false_value_still_detects_unmapped_data(self):
        _, checker = checked(Connection('agents', 'future_authored_data', False))
        self.assertEqual(len(checker.problems), 1)
        self.assertEqual(checker.problems[0]['field'], 'future_authored_data')

    def test_removing_presence_declaration_is_detected(self):
        fields = dict(ov.DERIVED)
        fields['agents'] = ov.DERIVED['agents'] - {'successor_misfit'}
        with patch.object(ov, 'DERIVED', fields):
            _, checker = checked(Connection('agents', 'successor_misfit', False))
        self.assertEqual(len(checker.problems), 1)
        self.assertEqual(checker.problems[0]['field'], 'successor_misfit')


if __name__ == '__main__':
    unittest.main()
