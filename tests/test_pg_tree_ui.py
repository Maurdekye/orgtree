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

    def expire(self):
        # what IDLE_S does to an entry nobody read for a minute
        with tree_ui._lock:
            tree_ui._cache.clear()

    def test_proof_of_freshness_outlives_an_idle_entry(self):
        """N1000 #4: at N1000 every tree read after a quiet minute published an
        unknown change set, and the next reader paid a ~21 MB full reload."""
        self.expire()
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'summary': 'after idle'}
        store.save_org(org)
        loads = dict(store.full_load_counts)
        with patch.object(store, 'external_change', side_effect=AssertionError('unneeded full refresh')):
            _, body, _ = self.read()
        self.assertIn('after idle', body.decode())
        self.assertEqual(dict(store.full_load_counts), loads)

    def test_control_without_the_proof_an_idle_read_refreshes_in_full(self):
        self.expire()
        with tree_ui._lock:
            tree_ui._verified.clear()
        seen = []
        real = store.external_change
        with patch.object(store, 'external_change',
                          side_effect=lambda slug, reason='': (seen.append(reason), real(slug, reason))):
            self.read()
        self.assertEqual(seen, ['tree_unverified'])

    def test_a_proof_for_another_org_under_the_same_slug_is_not_trusted(self):
        """review N4: the proof is keyed by slug, so an org deleted and
        re-created under that slug can reach the same revision number. Only
        the org_id tells the two apart; a match on the revision alone must
        not skip the refresh."""
        self.expire()
        proof = (str(store.DATA_ROOT), self.slug)
        with tree_ui._lock:
            org_id, revision = tree_ui._verified[proof]
            tree_ui._verified[proof] = (org_id + 1, revision)
        seen = []
        real = store.external_change
        with patch.object(store, 'external_change',
                          side_effect=lambda slug, reason='': (seen.append(reason), real(slug, reason))):
            self.read()
        self.assertEqual(seen, ['tree_unverified'])
        with tree_ui._lock:
            self.assertEqual(tree_ui._verified[proof], (org_id, revision))

    def test_foreign_commit_after_an_idle_entry_is_still_refreshed(self):
        stale = store.cached_org(self.slug)
        self.expire()
        self.external_name()
        self.assertNotEqual(stale.d['name'], 'External title')
        before = store.full_load_counts['unknown:tree_unverified']
        _, body, _ = self.read()
        self.assertEqual(json.loads(body)['tree']['name'], 'External title')
        self.assertEqual(store.full_load_counts['unknown:tree_unverified'], before + 1)


if __name__ == '__main__':
    unittest.main()
