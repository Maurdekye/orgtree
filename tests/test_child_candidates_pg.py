"""Indexed child candidates through the actual compatibility and lazy-store readers."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree import orgtx, store
from orgtree.orgdb import conn, registry
from orgtree.orgdb.compat import rows as R


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class ChildCandidates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twins = fixture.Twins('child-candidates')
        with fixture.storage(True):
            # Stamp the converted document before introducing raw exceptional headers.
            with orgtx.org_tx(cls.twins.copy, nodes=['boss']):
                pass
            row = registry.lookup(cls.twins.copy)
            with conn.connect(fixture.ADMIN, row[1], autocommit=False) as raw:
                def add(name, parent=None, state='live', extra=None, tombstone=False):
                    from psycopg.types.json import Json
                    return raw.execute(
                        'INSERT INTO orgtree.agents(name,ord,parent_id,parent_null,state,extra,tombstone) '
                        'VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING id',
                        (name, next(order), parent,
                         True if parent is None and not (extra and 'parent' in extra) else None,
                         state, Json(extra) if extra is not None else None,
                         tombstone)).fetchone()[0]
                order = iter(range(100, 200))
                boss = raw.execute("SELECT id FROM orgtree.agents WHERE name='boss'").fetchone()[0]
                destination = add('destination')
                first = add('boss', tombstone=True)
                second = add('boss', tombstone=True)
                empty = add('', tombstone=True)
                add('first-name-bearer-child', first)
                add('second-name-bearer-child', second)
                add('empty-parent-child', empty)
                add('top-child')
                add('archived-child', boss, state='archived', extra={'unknown': 1})
                add('null-state-child', boss, state=None)
                add('exceptional-state-child', boss, state=None, extra={'state': 'odd'})
                add('parent-correction', extra={'parent': 'boss'})
                add('parent-overlap', boss, extra={'parent': 'boss'})
                add('numeric-parent', extra={'parent': 7})
                add('null-parent-correction', extra={'parent': None})
                add('unknown-only', destination, extra={'unknown': {'kept': [1, None]}})
                raw.commit()

    def setUp(self):
        self.enterContext(fixture.storage(True))
        self.slug = self.twins.copy
        self.addCleanup(store._POOL.close_all, self.slug)

    def candidates(self, parents, live_only=False):
        row = registry.lookup(self.slug)
        with conn.connect(fixture.RUNTIME, row[1]) as raw:
            return R.children_ids(raw, parents, live_only)

    def reached(self, parents, live_only=False, edit=None):
        class DiscardReadEdits(Exception):
            pass
        try:
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                self.assertIsInstance(nodes, store.LazyNodesMap)
                self.assertFalse(nodes._complete)
                if edit:
                    edit(nodes)
                with patch.object(R, 'children_ids', wraps=R.children_ids) as selected:
                    result = store.lazy_children_index(tx.org, parents, live_only)
                self.assertEqual(selected.call_count, 1,
                                 'the actual compat child reader was not reached')
                self.assertIsNotNone(result)
                # These controls exercise unsaved edits; no test edit may reach storage.
                raise DiscardReadEdits()
        except DiscardReadEdits:
            pass
        return result, nodes

    def reference(self, parents, live_only=False):
        # Today's full decoded document is the parity oracle, independent of candidate SQL.
        nodes = fixture.document(self.slug)['nodes']
        return {p: [name for name, node in nodes.items() if node.get('parent') == p
                    and (not live_only or node.get('state') != 'archived')] for p in parents}

    def test_all_physical_parent_namesakes_and_candidate_order(self):
        found = self.candidates(['boss', 'boss'])
        self.assertEqual(found, ['dev', 'ops', 'first-name-bearer-child',
                                'second-name-bearer-child', 'archived-child', 'null-state-child',
                                'exceptional-state-child', 'parent-correction', 'parent-overlap',
                                'numeric-parent', 'null-parent-correction'])
        self.assertEqual(found.count('parent-overlap'), 1)
        got, _ = self.reached(['boss'])
        self.assertEqual(got, self.reference(['boss']))

    def test_null_root_and_empty_name_parent_alias_are_rejudged(self):
        for parents in ([None], [''], [None, '']):
            with self.subTest(parents=parents):
                got, _ = self.reached(parents)
                self.assertEqual(got, self.reference(parents))
        found = self.candidates([''])
        self.assertIn('empty-parent-child', found)
        self.assertIn('top-child', found)
        self.assertNotIn('', found, 'tombstoned child was returned')

    def test_live_only_excludes_typed_archived_but_keeps_null_and_misfit_states(self):
        found = self.candidates(['boss'], live_only=True)
        self.assertNotIn('archived-child', found)
        self.assertIn('null-state-child', found)
        self.assertIn('exceptional-state-child', found)
        got, _ = self.reached(['boss'], live_only=True)
        self.assertEqual(got, self.reference(['boss'], live_only=True))

    def test_every_parent_misfit_remains_a_candidate_without_authored_json_filtering(self):
        found = self.candidates(['no-such-parent'])
        self.assertEqual(found, ['parent-correction', 'parent-overlap', 'numeric-parent',
                                'null-parent-correction'])
        got, _ = self.reached(['no-such-parent'])
        self.assertEqual(got, {'no-such-parent': []})

    def test_unrelated_unknown_payload_is_neither_selected_nor_decoded(self):
        got, nodes = self.reached(['boss'])
        self.assertEqual(got, self.reference(['boss']))
        self.assertNotIn('unknown-only', dict.keys(nodes))
        self.assertFalse(nodes._complete)
        self.assertNotIn('unknown-only', self.candidates(['boss']))

    def test_loaded_unsaved_parent_state_insert_and_delete_override_stored_candidates(self):
        def edit(nodes):
            nodes['dev']['parent'] = 'destination'
            nodes['unknown-only']['parent'] = 'boss'
            nodes['archived-child']['state'] = 'live'
            nodes['parent-overlap']['state'] = 'archived'
            nodes.pop('ops')
            nodes['new-child'] = fixture.node('new-child', 'boss')
        got, _ = self.reached(['boss'], live_only=True, edit=edit)
        self.assertEqual(got['boss'], ['first-name-bearer-child', 'second-name-bearer-child',
                                       'null-state-child', 'exceptional-state-child',
                                       'parent-correction', 'unknown-only', 'archived-child',
                                       'new-child'])
        self.assertEqual(self.reference(['boss'], live_only=True),
                         {'boss': ['dev', 'ops', 'first-name-bearer-child',
                                   'second-name-bearer-child', 'null-state-child',
                                   'exceptional-state-child', 'parent-correction', 'parent-overlap']},
                         'read-only edits unexpectedly reached storage')


if __name__ == '__main__':
    unittest.main()
