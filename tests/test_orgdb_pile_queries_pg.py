"""Pile page parity and bounded plans on a disposable org database."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest

import test_orgdb_compat_pg as fixture
import test_orgdb_hot_paths_pg as hot
from orgtree import foreground_store as F
from orgtree.orgdb import agents, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class PileQueries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for i in range(2048):
                name = f'history-{i:04}'
                org.nodes[name] = dict(fixture.node(name, 'boss'), state='archived',
                                      successor='', ui_order=i)
            for name, parent, order in (
                    ('root-null', None, 0), ('root-empty', '', 1),
                    ('rare-first', 'boss', '-100'), ('rare-last', 'boss', '100000'),
                    ('false-successor', 'boss', -50)):
                org.nodes[name] = dict(fixture.node(name, parent), state='archived',
                                      successor=False if name == 'false-successor' else '',
                                      ui_order=order)
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('pile queries', seed)
        with fixture.storage(True), registry.connection(cls.twin.copy) as raw:
            raw.execute('ANALYZE orgtree.agents')
            cls.sizes = {'agents': raw.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0]}

    def read(self, on, fn):
        with fixture.storage(on):
            return fn(self.twin.copy if on else self.twin.legacy)

    def test_named_pile_plans_are_bounded(self):
        with fixture.storage(True):
            for last in (False, True):
                with self.subTest(last=last):
                    measured = hot.measure(self.twin.copy, lambda slug:
                        F.read_snapshot(slug, lambda raw, stamp:
                            agents.child_page(raw, 'boss', 1, last=last)), self.sizes)
                    self.assertGreaterEqual(measured['relation_pages']['agents'], hot.MIN_SCAN_PAGES)
                    self.assertFalse([v for q in measured['queries'] for v in q['violations']],
                                     'pile query scans retained agents')
                    # One parent, one typed edge, two rare order records and
                    # their keyed lineage probes must not walk 2048 siblings.
                    self.assertLess(measured['rows'], 128, 'pile edge work grows with history')

    def test_legacy_first_last_and_keysets_with_rare_values(self):
        for parent in ('boss', ''):
            with self.subTest(parent=parent):
                pages = [self.read(on, lambda slug: F.read_retired_children(slug, parent, limit=3))
                         for on in (False, True)]
                for _ in range(3):
                    self.assertEqual(pages[0]['matches'], pages[1]['matches'])
                    self.assertEqual(pages[0]['missing_ancestors'], pages[1]['missing_ancestors'])
                    self.assertEqual(bool(pages[0]['next_cursor']), bool(pages[1]['next_cursor']))
                    if not pages[0]['next_cursor']:
                        break
                    pages = [self.read(on, lambda slug, cursor=page['next_cursor']:
                             F.read_retired_children(slug, parent, limit=3, cursor=cursor))
                             for on, page in zip((False, True), pages)]
                edges = [self.read(on, lambda slug:
                         F.read_retired_children(slug, parent, limit=1, edge='last')['matches'])
                         for on in (False, True)]
                self.assertEqual(edges[0], edges[1])

    def test_multiple_physical_parent_ids_include_tombstones(self):
        expected = self.read(False, lambda slug:
            F.read_retired_children(slug, 'boss', limit=4)['matches'])
        with fixture.storage(True), registry.connection(self.twin.copy) as raw:
            with raw.transaction(force_rollback=True):
                duplicate = raw.execute("INSERT INTO orgtree.agents(name,ord,tombstone,state) "
                    "VALUES('boss',9000,true,'live') RETURNING id").fetchone()[0]
                raw.execute("UPDATE orgtree.agents SET parent_id=%s WHERE name='history-0000'",
                            (duplicate,))
                self.assertEqual(raw.execute("SELECT count(*) FROM orgtree.agents "
                                 "WHERE name='boss'").fetchone()[0], 2)
                got = agents.child_page(raw, 'boss', 4)
                self.assertIn('history-0000', [row[0] for row in got])
                self.assertEqual([row[0] for row in got], expected)
                after = (got[1][1], got[1][2], got[1][3], got[1][0])
                next_page = agents.child_page(raw, 'boss', 2, after=after)
                self.assertEqual([row[0] for row in next_page], expected[2:4])

    def test_empty_physical_parent_and_successor_names(self):
        expected = self.read(False, lambda slug:
            F.read_retired_children(slug, '', limit=4)['matches'])
        with fixture.storage(True), registry.connection(self.twin.copy) as raw:
            with raw.transaction(force_rollback=True):
                empty = raw.execute("INSERT INTO orgtree.agents(name,ord,tombstone,state) "
                    "VALUES('',9001,true,'live') RETURNING id").fetchone()[0]
                raw.execute("UPDATE orgtree.agents SET parent_id=%s,successor_id=%s "
                            "WHERE name='root-empty'", (empty, empty))
                got = agents.child_page(raw, '', 4)
                self.assertIn('root-empty', [row[0] for row in got])
                self.assertIn('root-null', [row[0] for row in got])
                self.assertEqual([row[0] for row in got], expected)


if __name__ == '__main__':
    unittest.main()
