"""Status-only updates must be proved complete or rebuild the ordinary view."""
import json
import unittest
from unittest.mock import patch
import test_tree_ui as fixture
from orgtree import ledger, store, tree_ui, tree_fast, tree_changes
from orgtree.stateprobe import SaveChanges


class StatusProjection(unittest.TestCase):
    def setUp(self):
        self.slug = 'fast-' + fixture.os.urandom(3).hex()
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'boss', charter='Kept charter')
        store.save_org(org)
        self.builds = 0
        self.runtime = 0
        self.fast = tree_fast.StatusProjection(self.slug, lambda:self.runtime, lambda:{'sync_rev':4})
        self.tag, _, _ = self.read()

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def build(self):
        self.builds += 1
        return store.cached_org(self.slug).tree()

    def read(self, tag=''):
        return tree_ui.read(self.slug, False, tag,
            stamp=lambda:(store.org_seq(self.slug), self.runtime), build=self.build, fast=self.fast)

    def save(self, **values):
        org = store.load_org(self.slug)
        org.nodes['boss'].update(values)
        store.save_org(org)

    def test_status_update_skips_full_projection_and_keeps_other_fields(self):
        self.save(last_status={'status':'working','summary':'New'}, working_activity_at='now')
        with patch.object(self, 'build', side_effect=AssertionError('full projection on status')):
            _, body, _ = self.read(self.tag)
        self.assertEqual(json.loads(body)['nodes']['boss']['set'],
                         {'last_status':{'status':'working','summary':'New'}})
        _, full, _ = self.read()
        self.assertEqual(json.loads(full)['tree']['roots'][0]['charter'], 'Kept charter')
        self.assertEqual(self.builds, 1)

    def test_other_node_field_and_runtime_change_require_full_projection(self):
        self.save(last_status={'summary':'New'}, charter='Edited charter')
        _, body, _ = self.read(self.tag)
        self.assertEqual(self.builds, 2)
        self.assertEqual(json.loads(body)['nodes']['boss']['set']['charter'], 'Edited charter')
        self.runtime += 1
        self.read()
        self.assertEqual(self.builds, 3)

    def test_unknown_or_pruned_history_forces_full_projection(self):
        self.save(last_status={'summary':'New'})
        tree_changes.forget(store.DATA_ROOT, self.slug)
        self.read(self.tag)
        self.assertEqual(self.builds, 2)

    def test_non_node_section_change_requires_full_projection(self):
        org = store.load_org(self.slug)
        org.d['name'] = 'New org name'
        store.save_org(org)
        _, body, _ = self.read(self.tag)
        self.assertEqual(self.builds, 2)
        self.assertEqual(json.loads(body)['top']['set']['name'], 'New org name')

    def test_journal_copies_change_sets_and_bump_without_publish_is_unknown(self):
        root, slug = 'fake-root', 'journal'
        changes = SaveChanges()
        changes.node_updates.append('a')
        tree_changes.publish(root, slug, changes)
        changes.node_updates.append('not-part-of-this-commit')
        tree_changes.commit(root, slug, 7)
        self.assertEqual(tree_changes.since(root, slug, 6, 7), ({'nodes'}, {'a'}, False))
        tree_changes.commit(root, slug, 8)
        self.assertIsNone(tree_changes.since(root, slug, 6, 8))

    def test_race_during_changed_node_read_falls_back(self):
        self.save(last_status={'summary':'New'})
        original = tree_fast.signature
        fired = []
        def racing(node):
            if not fired:
                fired.append(True)
                self.runtime += 1
            return original(node)
        with patch.object(tree_fast, 'signature', side_effect=racing):
            self.read(self.tag)
        self.assertTrue(fired)
        self.assertEqual(self.builds, 2)


if __name__ == '__main__':
    unittest.main()
