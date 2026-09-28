"""Foreground topology and wire changes preserve the selected display rows."""
import copy
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, foreground_view as view, tree_delta
from orgtree.ledger import LedgerError, Org, USER


class ForegroundView(unittest.TestCase):
    def setUp(self):
        self.org = Org.create('foreground-view')
        for nid, parent in [('boss', None), ('old', 'boss'), ('child', 'old'), ('past', 'boss')]:
            self.org.hire(USER, parent, 'luna', 5, nid, charter='Visible charter for ' + nid)
        self.org.nodes['old']['state'] = 'archived'
        self.org.nodes['past'].update(state='archived', successor='boss', generation=2)
        self.graph = {'stamp': {'org_id': 3, 'org_revision': 10, 'catalog_revision': 5,
                               'retired_axis_count': 8},
                      'rows': {}, 'hidden_retired_children': {'': 2, 'boss': 3, 'old': 4},
                      'missing': ['gone'], 'missing_ancestors': []}
        for ordinal, (nid, node) in enumerate(self.org.nodes.items()):
            self.graph['rows'][nid] = {'ordinal': ordinal, 'node': node,
                'meta': {'parent': node['parent'] or '', 'state': node['state'],
                         'predecessor': node.get('predecessor') or '',
                         'successor': node.get('successor') or '',
                         'order': node.get('ui_order', 0), 'created': node['created']},
                'lineage_count': 2 if nid == 'boss' else 0,
                'consultable_predecessor': {'id': 'past', 'generation': 2} if nid == 'boss' else None}

    def render(self, *, kind='snapshot', requested=None, public=False):
        with patch.object(self.org, 'org_children', side_effect=AssertionError('full descendant walk')):
            with patch.object(self.org, 'lineage_stack', side_effect=AssertionError('full lineage walk')):
                prepared = view.prepare(self.org, self.graph, detail_token=api._archived_detail_rev,
                                        sync_rev=7, primed_restart=None)
        annotated = copy.deepcopy(prepared['tree'])
        for node in annotated['roots']:
            if node['state'] == 'archived':
                api._summarise_archived(node)
        if public:
            api._scrub_public(annotated)
        return view.finish(prepared, annotated, kind=kind, requested=requested)

    def test_selected_fields_and_ancestor_topology_survive_without_lineage_walk(self):
        full = self.org.tree_node('boss', descend=False, lineage=False)
        result = self.render()
        self.assertEqual(result['roots'], ['boss'])
        self.assertEqual(set(result['nodes']), set(self.graph['rows']))
        self.assertEqual(result['nodes']['boss']['children'], ['old'])
        self.assertEqual(result['nodes']['old']['children'], ['child'])
        for key, value in full.items():
            if key not in ('lineage', 'children'):
                self.assertEqual(result['nodes']['boss'][key], value, key)
        self.assertEqual(result['nodes']['boss']['lineage_count'], 2)
        self.assertEqual(result['nodes']['boss']['consultable_predecessor'], {'id': 'past', 'generation': 2})
        self.assertFalse(result['nodes']['boss']['lineage_loaded'])
        self.assertNotIn('lineage', result['nodes']['boss'])
        self.assertEqual(result['header']['hidden_retired_roots'], 2)
        self.assertEqual(result['header']['retired_total'], 8)

    def test_lookup_keeps_off_axis_identity_and_ancestors(self):
        result = self.render(kind='lookup', requested='past')
        self.assertEqual(result['path'], ['boss', 'past'])
        self.assertTrue(result['found'])
        row = result['nodes']['past']
        self.assertEqual(row['axis'], 'lineage')
        self.assertEqual(row['successor'], 'boss')
        self.assertEqual(row['parent'], 'boss')
        self.assertFalse(row['detail'])
        self.assertNotIn('past', result['nodes']['boss']['children'])

    def test_page_matches_are_distinct_from_ghost_ancestors(self):
        self.graph.update(matches=['child'], next_cursor='opaque')
        result = self.render(kind='page')
        self.assertEqual(result['matches'], ['child'])
        self.assertEqual(result['next_cursor'], 'opaque')
        self.assertIn('old', result['nodes'])
        self.assertNotIn('header', result)

    def test_missing_lookup_is_explicit(self):
        self.graph['rows'] = {}
        result = self.render(kind='lookup', requested='missing')
        self.assertEqual(result['nodes'], {})
        self.assertEqual(result['path'], [])
        self.assertFalse(result['found'])

    def test_missing_ancestors_and_cycles_fail_instead_of_hiding_nodes(self):
        self.graph['rows']['boss']['meta']['parent'] = 'absent'
        with self.assertRaisesRegex(LedgerError, 'ancestor is missing'):
            self.render()
        self.graph['rows']['boss']['meta']['parent'] = 'child'
        with self.assertRaisesRegex(LedgerError, 'ancestor cycle'):
            self.render()

    def test_sibling_order_preserves_ordinal_ties(self):
        self.graph['rows']['past']['meta']['successor'] = ''
        self.graph['rows']['past']['meta']['order'] = -1
        self.assertEqual(self.render()['nodes']['boss']['children'], ['past', 'old'])
        for nid in ('past', 'old'):
            self.graph['rows'][nid]['meta'].update(order=0, created='same')
        self.assertEqual(self.render()['nodes']['boss']['children'], ['old', 'past'])

    def test_public_scrubbing_is_not_undone_by_packing_flat_nodes(self):
        self.org.nodes['boss']['session_id'] = 'private-session'
        self.org.nodes['boss']['external_handles'] = ['private-peer']
        self.org.nodes['boss']['scope']['add_dirs'] = [{'path': 'C:/secret/folder', 'mode': 'rw'}]
        result = self.render(public=True)['nodes']['boss']
        self.assertNotIn('session_id', result)
        self.assertNotIn('external_handles', result)
        self.assertEqual(result['scope']['add_dirs'][0]['path'], 'folder')
        self.assertEqual(self.org.nodes['boss']['scope']['add_dirs'][0]['path'], 'C:/secret/folder')

    def test_detail_token_tracks_local_detail_and_committed_lineage_dependency(self):
        before = self.render()['nodes']['old']['detail_rev']
        self.graph['stamp']['org_revision'] += 1
        self.assertEqual(self.render()['nodes']['old']['detail_rev'], before)
        self.org.nodes['old']['charter'] += ' changed'
        local = self.render()['nodes']['old']['detail_rev']
        self.assertNotEqual(local, before)
        self.graph['stamp']['catalog_revision'] += 1
        self.assertNotEqual(self.render()['nodes']['old']['detail_rev'], local)

    def test_annotation_cannot_silently_drop_or_duplicate_identities(self):
        prepared = view.prepare(self.org, self.graph, detail_token=api._archived_detail_rev, sync_rev=7)
        bad = copy.deepcopy(prepared['tree'])
        bad['roots'].pop()
        with self.assertRaisesRegex(LedgerError, 'lost an identity'):
            view.finish(prepared, bad)
        bad['roots'].append(bad['roots'][0])
        with self.assertRaisesRegex(LedgerError, 'identities disagree'):
            view.finish(prepared, bad)

    def test_delta_reconstructs_future_fields_topology_removal_and_watermarks(self):
        old = self.render()
        new = copy.deepcopy(old)
        new.update(org_rev=21, sync_rev=19, catalog_revision='3:6', missing_requested=[])
        new['header'].pop('asks')
        new['header']['future'] = [False, {'a': 1}]
        new['nodes'].pop('past')
        new['nodes']['boss']['future'] = True
        new['nodes']['old'].pop('charter_line')
        new['nodes']['child']['last_status'] = {'summary': 'Changed'}
        new['roots'] = ['child']
        old_bytes = tree_delta.encode(old)
        change = view.delta(old, new, view.revision(old), view.revision(new))
        restored = copy.deepcopy(old)
        def apply(row, patch):
            row.update(patch['set'])
            for key in patch['unset']:
                row.pop(key, None)
        apply(restored['header'], change['header'])
        for nid in change['removed']:
            restored['nodes'].pop(nid)
        for nid, row in change['nodes'].items():
            apply(restored['nodes'].setdefault(nid, {}), row)
        for key in ('org_rev', 'sync_rev', 'catalog_revision', 'roots', 'missing_requested'):
            restored[key] = change[key]
        self.assertEqual(restored, new)
        self.assertEqual(tree_delta.encode(old), old_bytes)
        self.assertEqual(view.revision(old), view.revision({**old, 'org_rev': 100, 'sync_rev': 300}))
        self.assertNotEqual(view.revision(old), view.revision(new))


if __name__ == '__main__':
    unittest.main()
