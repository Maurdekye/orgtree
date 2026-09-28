"""Committed tree freshness while the PG notification feed is delayed."""
import json
import os
import unittest
from unittest.mock import patch

import test_pgstore as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, store, tree_ui, tree_fast, tree_changes


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PG not configured: NOT RUN')
class CommittedTree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('tree-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 0, 'boss')
        store.save_org(org)
        self.before, _, _ = self.read()

    def read(self, since=''):
        return tree_ui.read(self.slug, False, since,
            stamp=lambda:str(store.org_seq(self.slug)),
            build=lambda:store.cached_org(self.slug).tree(),
            fast=tree_fast.StatusProjection(self.slug, lambda:0, lambda:{}))

    def test_local_status_only_uses_changed_row_without_full_projection(self):
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'status':'working','summary':'latest'}
        org.nodes['boss']['working_activity_at'] = 'now'
        store.save_org(org)
        with patch.object(ledger.Org, 'tree', side_effect=AssertionError('whole projection rebuilt')):
            _, body, _ = self.read(self.before)
        self.assertEqual(json.loads(body)['nodes']['boss']['set']['last_status']['summary'], 'latest')

    def test_foreign_revision_never_reuses_local_fast_history(self):
        self.external_name()
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'summary':'local'}
        store.save_org(org)
        original = tree_fast.StatusProjection.update
        observed = []
        def checked(projection, state, mark):
            result = original(projection, state, mark)
            observed.append(result)
            return result
        with patch.object(tree_fast.StatusProjection, 'update', new=checked):
            _, body, _ = self.read(self.before)
        self.assertEqual(observed, [None])
        self.assertEqual(json.loads(body)['top']['set']['name'], 'External title')

    def external_name(self):
        import psycopg
        with psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True) as conn:
            oid = conn.execute('SELECT org_id FROM public.orgs WHERE slug=%s',(self.slug,)).fetchone()[0]
            with conn.transaction():
                conn.execute(f'UPDATE org_{int(oid)}.doc SET val=%s WHERE key=%s',
                             (json.dumps('External title'), 'name'))
                conn.execute('UPDATE public.orgs SET revision=revision+1 WHERE org_id=%s',(oid,))

    def test_external_commit_is_visible_before_feed_arrives(self):
        stale = store.cached_org(self.slug)
        self.external_name()
        self.assertNotEqual(stale.d['name'], 'External title')
        tag, body, _ = self.read(self.before)
        self.assertNotEqual(tag, self.before)
        self.assertEqual(json.loads(body)['top']['set']['name'], 'External title')

    def test_foreign_commit_followed_by_local_commit_still_refreshes_foreign_section(self):
        self.external_name()
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'summary':'local node update'}
        store.save_org(org)
        _, body, _ = self.read(self.before)
        reply = json.loads(body)
        self.assertEqual(reply['top']['set']['name'], 'External title')
        self.assertEqual(reply['nodes']['boss']['set']['last_status']['summary'], 'local node update')

    def test_local_unrelated_save_keeps_content_token_and_section_cache(self):
        org = store.load_org(self.slug)
        org.nodes['boss']['unused_tree_probe'] = 'not projected'
        store.save_org(org)
        with patch.object(store, 'external_change', side_effect=AssertionError('unneeded full refresh')):
            tag, body, _ = self.read(self.before)
        self.assertEqual(tag, self.before)
        self.assertIsNone(body)


if __name__ == '__main__':
    unittest.main()
