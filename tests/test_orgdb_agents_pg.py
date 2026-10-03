"""A1 native reader controls; a skip is not an executed check.

The shared twins fixture provisions only throwaway databases. Run under P03's
heavy lock through tools/run-python-verification.py, never on live data.
"""
import import_provenance  # noqa: F401  asserts this checkout before engine imports
import unittest

import test_orgdb_compat_pg as fixture
from orgtree import foreground_store as F, identity_context, turn_inputs


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class NativeReaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            org.nodes['old'] = dict(fixture.node('old', 'boss'), state='archived', generation=1)
            org.nodes['dev']['predecessor'] = 'old'
            org.nodes['old']['successor'] = 'dev'
            org.nodes['retired'] = dict(fixture.node('retired', 'boss'), state='archived',
                                        ui_order=2)
            org.nodes['dev']['turns'] = [{'n': n, 'at': fixture.AT} for n in range(20)]
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('a1', seed)

    def read(self, fn):
        with fixture.storage(True):
            return fn(self.twin.copy)

    def test_foreground_ancestor_closure(self):
        graph = self.read(lambda s: F.read_foreground(s, ['retired']))
        self.assertEqual(set(graph['rows']), {'boss', 'dev', 'ops', 'retired'})
        self.assertEqual(graph['hidden_retired_children']['boss'], 0)

    def test_exact_recent_turns_and_lineage(self):
        graph = self.read(lambda s: F.read_exact(s, 'dev'))
        self.assertEqual([t['n'] for t in graph['rows']['dev']['node']['turns']], list(range(12, 20)))
        self.assertEqual(graph['rows']['dev']['lineage_count'], 1)
        self.assertEqual(graph['rows']['dev']['consultable_predecessor'], {'id': 'old', 'generation': 1})

    def test_retired_page_and_search_and_references(self):
        page = self.read(lambda s: F.read_retired_children(s, 'boss'))
        self.assertEqual(page['matches'], ['retired'])
        search = self.read(lambda s: F.search(s, 'retir'))
        self.assertEqual(search['matches'], ['retired'])
        refs = self.read(lambda s: F.read_references(s, ['old', 'missing']))
        self.assertEqual(refs['references']['old']['axis'], 'lineage')
        self.assertEqual(refs['missing'], ['missing'])

    def test_identity_neighbourhood(self):
        context = self.read(lambda s: identity_context.load(s, 'dev'))
        self.assertEqual(set(context.nodes), {'boss', 'dev', 'old'})

    def test_turn_inputs_mail(self):
        context = self.read(lambda s: turn_inputs.load(s, 'dev', mail=True))
        self.assertEqual(set(context.nodes), {'boss', 'dev', 'old'})
        self.assertEqual([m['id'] for m in context.d['mail']['dev']], ['m1'])

    def test_snapshot_counters_exist(self):
        stamp = self.read(lambda s: F.read_snapshot(s, lambda raw, stamp: stamp))
        self.assertEqual(stamp['node_count'], 5)
        self.assertEqual(stamp['retired_axis_count'], 1)
        self.assertGreaterEqual(stamp['node_revision'], 5)


if __name__ == '__main__':
    unittest.main()
