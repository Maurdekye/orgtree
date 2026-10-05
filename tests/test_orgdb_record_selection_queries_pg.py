"""Archive predicate and large keyed selection plans on disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest

import test_orgdb_compat_pg as fixture
import test_orgdb_hot_paths_pg as hot
from orgtree import foreground_store as F
from orgtree.orgdb import agents, reader_rows, record_reads as Q, record_tree as T, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class SelectionQueries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for i in range(4096):
                name = f'selection-{i:04}'
                org.nodes[name] = dict(fixture.node(name, 'boss' if i < 2048 else 'ops'),
                                       state='archived')
            for name, parent in (('root-none', None), ('root-empty', ''),
                                 ('rare-parent', False), ('false', None)):
                org.nodes[name] = dict(fixture.node(name, parent), state='archived')
            org.d['mail']['selection-0000'] = [dict(id='selected', **{'from': 'boss'},
                                                    body='selected mail', at=fixture.AT)]
            org.d['mail']['selection-0001'] = []
            org.d['mail']['selection-4000'] = []
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('record selection queries', seed)
        with fixture.storage(True), registry.connection(cls.twin.copy) as raw:
            raw.execute('ANALYZE orgtree.agents')
            cls.sizes = {'agents': raw.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0]}
            cls.ids = dict(raw.execute('SELECT name,id::text FROM orgtree.agents WHERE NOT tombstone'))
        cls.selected = [f'selection-{i:04}' for i in range(4096)]

    def measure(self, reader, *, plan_options=()):
        def native(slug):
            with Q.snapshot(slug) as state:
                return reader(state)
        with fixture.storage(True):
            measured = hot.measure(self.twin.copy, native, self.sizes, plan_options=plan_options)
        self.assertGreaterEqual(measured['relation_pages']['agents'], hot.MIN_SCAN_PAGES)
        return measured

    def test_large_name_identity_lookup_uses_requested_keys(self):
        measured = self.measure(lambda state: T._identities(state, self.selected))
        self.assertFalse([v for q in measured['queries'] for v in q['violations']])
        self.assertLess(measured['rows'], 2 * len(self.selected) + 32)

    def test_large_id_name_lookup_uses_requested_keys(self):
        measured = self.measure(lambda state: T._names(state, [self.ids[n] for n in self.selected]))
        self.assertFalse([v for q in measured['queries'] for v in q['violations']])
        self.assertLess(measured['rows'], 2 * len(self.selected) + 32)

    def test_archived_parent_predicate_uses_typed_parent_index(self):
        measured = self.measure(lambda state: T._archived_members(state,
            {'kind': 'archived_under', 'parent': self.ids['boss']}))
        # This assertion owns only the direct predicate. The complete public
        # selection (including ancestor closure/body work) has separate guards.
        direct = [q for q in measured['queries'] if "a.state='archived'" in q['sql']
                  and q['sql'].startswith('SELECT a.name FROM orgtree.agents a WHERE')]
        self.assertTrue(direct, 'direct predicate was not reached')
        self.assertFalse([v for q in direct for v in q['violations']])
        self.assertTrue(all(q['rows'] <= 128 for q in direct))
        self.assertEqual(sum(q['rows'] for q in direct), 2048)

    def test_parent_scan_control_reaches_plan_oracle(self):
        measured = self.measure(lambda state: T._archived_members(state,
            {'kind': 'archived_under', 'parent': self.ids['boss']}), plan_options=(
                'SET LOCAL enable_indexscan=off', 'SET LOCAL enable_indexonlyscan=off',
                'SET LOCAL enable_bitmapscan=off'))
        direct = [q for q in measured['queries'] if "a.state='archived'" in q['sql']
                  and q['sql'].startswith('SELECT a.name FROM orgtree.agents a WHERE')]
        self.assertTrue(direct, 'faulted predicate was not reached')
        self.assertTrue(all('sequential scan of agents' in q['violations'] for q in direct))

    def test_key_lookup_duplicates_missing_ids_and_tombstones_retain_membership(self):
        with fixture.storage(True), registry.connection(self.twin.copy) as raw:
            with raw.transaction(force_rollback=True):
                tomb = raw.execute("INSERT INTO orgtree.agents(name,ord,tombstone,state) "
                    "VALUES('selection-0000',9999,true,'live') RETURNING id").fetchone()[0]
                state = type('State', (), {'raw': raw})()
                names = ['selection-0000', 'selection-0000', 'missing']
                self.assertEqual(T._identities(state, names),
                                 {'selection-0000': self.ids['selection-0000']})
                self.assertEqual(T._names(state, [self.ids['selection-0000']] * 2 +
                    [str(tomb), '9223372036854775806']), ['selection-0000'])
                self.assertEqual(T._identities(state, []), {})
                self.assertEqual(T._names(state, []), [])

    def test_root_and_rare_parent_members_equal_exact_legacy_selection(self):
        with fixture.storage(False):
            def legacy(raw, _stamp):
                result = {}
                for parent in ('', 'boss', 'false'):
                    direct = [row[0] for row in raw.execute("SELECT id FROM node_index "
                        "WHERE meta->>'state'='archived' AND meta->>'parent'=%s", (parent,))]
                    result[parent] = F._ancestors(raw, direct)
                return result
            expected_names = F.read_snapshot(self.twin.legacy, legacy)
        with fixture.storage(True), Q.snapshot(self.twin.copy) as state:
            for parent in ('', 'boss', 'false'):
                with self.subTest(parent=parent):
                    key = self.ids[parent] if parent else '0'
                    actual = T._archived_members(state, {'kind': 'archived_under', 'parent': key})
                    self.assertEqual(actual, frozenset(T._identities(state, expected_names[parent]).values()))

    def test_large_ancestor_seed_uses_requested_name_probes(self):
        measured = self.measure(lambda state: agents.ancestors(state.raw, self.selected))
        direct = [q for q in measured['queries'] if
                  q['sql'].startswith('WITH RECURSIVE wanted(id,ref_id) AS')]
        self.assertTrue(direct, 'ancestor closure was not reached')
        self.assertFalse([v for q in direct for v in q['violations']])

    def test_large_section_owner_lookup_uses_requested_name_probes(self):
        measured = self.measure(lambda state: reader_rows.read_sections(
            state.raw, ['mail'], owners=self.selected))
        direct = [q for q in measured['queries'] if 'orgtree.agents' in q['sql']
                  and 'tombstone' in q['sql'] and 'ORDER BY' in q['sql']]
        self.assertEqual(len(direct), 1, 'section owner lookup was not reached')
        self.assertFalse(direct[0]['violations'])
        self.assertEqual(direct[0]['rows'], len(self.selected))

    def test_shared_lookup_scan_controls_reach_actual_readers(self):
        options = ('SET LOCAL enable_indexscan=off', 'SET LOCAL enable_indexonlyscan=off',
                   'SET LOCAL enable_bitmapscan=off')
        for name, reader, marker in (
                ('ancestor', lambda state: agents.ancestors(state.raw, ['selection-0000']),
                 lambda sql: sql.startswith('WITH RECURSIVE wanted(id,ref_id) AS')),
                ('owner', lambda state: reader_rows.read_sections(state.raw, ['mail'],
                                                                owners=['selection-0000']),
                 lambda sql: 'orgtree.agents' in sql and 'tombstone' in sql and 'ORDER BY' in sql)):
            with self.subTest(reader=name):
                measured = self.measure(reader, plan_options=options)
                direct = [q for q in measured['queries'] if marker(q['sql'])]
                self.assertTrue(direct, 'faulted reader was not reached')
                self.assertTrue(any('sequential scan of agents' in q['violations'] for q in direct))

    def test_ancestor_closure_keeps_legacy_rare_duplicate_and_missing_names(self):
        wanted = [*self.selected, 'rare-parent', 'root-empty', 'selection-0000', 'missing']
        with fixture.storage(False):
            expected = F.read_snapshot(self.twin.legacy, lambda raw, _stamp: F._ancestors(raw, wanted))
        with fixture.storage(True), Q.snapshot(self.twin.copy) as state:
            self.assertEqual(set(agents.ancestors(state.raw, wanted)), set(expected))
            self.assertEqual(agents.ancestors(state.raw, []), [])

    def test_section_owner_lookup_preserves_physical_ids_order_and_exact_containers(self):
        class CaptureOwners:
            def __init__(self, raw):
                self.raw, self.selected = raw, None

            def execute(self, statement, params=None, **kwargs):
                cursor = self.raw.execute(statement, params, **kwargs)
                if 'orgtree.agents' in statement and 'tombstone' in statement and 'ORDER BY' in statement:
                    self.selected = cursor.fetchall()
                    selected = self.selected
                    return type('Rows', (), {'fetchall': lambda _self: selected})()
                return cursor

            def __getattr__(self, name):
                return getattr(self.raw, name)

        with fixture.storage(False):
            mail = fixture.document(self.twin.legacy)['mail']
        with fixture.storage(True), registry.connection(self.twin.copy) as raw:
            with raw.transaction(force_rollback=True):
                raw.execute("INSERT INTO orgtree.agents(name,ord,tombstone,state) "
                            "VALUES('selection-0000',9999,true,'live')")
                for wanted in (['selection-0000', 'selection-0000', 'missing',
                                'selection-0001', 'selection-4000'], []):
                    expected_ids = raw.execute('SELECT id,name FROM orgtree.agents '
                        'WHERE name=ANY(%s) ORDER BY tombstone,id', (wanted,)).fetchall()
                    capture = CaptureOwners(raw)
                    actual = reader_rows.read_sections(capture, ['mail'], owners=iter(wanted))
                    self.assertEqual(capture.selected, expected_ids)
                    self.assertEqual(actual, {'mail': {name: value for name,value in mail.items()
                                                       if name in wanted}})


if __name__ == '__main__':
    unittest.main()
