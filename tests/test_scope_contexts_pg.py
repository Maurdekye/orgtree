"""Reached native audience/identity/policy controls on disposable org databases."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout
from copy import deepcopy
import unittest
from unittest.mock import patch
import uuid

import test_orgdb_compat_pg as fixture
from orgtree import identity_context, ledger, lifecycle_tx, orgtx, policy_reads, store, supervisor
from orgtree.orgdb import agents, reader_rows, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class CurrentScopeContexts(unittest.TestCase):
    def setUp(self):
        self.enterContext(fixture.storage(True))
        self.slug = 'scope-context-' + uuid.uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 50, 'boss')
        org.hire(ledger.USER, None, 'luna', 50, 'other')
        org.hire(ledger.USER, 'boss', 'luna', 5, 'parent')
        org.hire(ledger.USER, 'parent', 'luna', 0, 'leaf')
        org.d['org_inbox_multi_holder'] = True
        for name in ('boss', 'other', 'parent', 'leaf'):
            org.node(name)['scope']['tools']['bash'] = True
        org.node('other')['scope']['tools']['bash'] = False
        org.d['watchdogs'] = [dict(id='dog', owner='leaf', kind='command', state='armed',
                                  name='dog', target='echo fixture', interval_s=15)]
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, self.slug)

    def grants(self, *values):
        org = store.load_org(self.slug)
        org.d['audiences'] = list(deepcopy(values))
        store.save_org(org)

    def read(self):
        with patch.object(store, 'load_org', side_effect=AssertionError('whole identity fallback')):
            return identity_context.load(self.slug, 'leaf')

    def test_identity_preserves_occurrences_order_anchors_and_unknown_payload(self):
        grants = [dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss',
                       reason='anchored', unknown={'exact': [None, False]}),
                  dict(grantee='leaf', grantor=ledger.USER, delegated_by={'misfit': [1]}),
                  dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by=None),
                  dict(grantee='leaf', grantor=ledger.EXTERN),
                  dict(grantee='parent', grantor=ledger.EXTERN, delegated_by='boss')]
        self.grants(*grants)
        got = self.read()
        self.assertEqual(got.d['audiences'], grants[:4])
        self.assertTrue(got._has_audience('leaf', ledger.EXTERN))
        self.assertTrue(got._has_audience('leaf', ledger.USER))

    def test_identity_and_actual_transaction_pause_restore_without_grant_rewrite(self):
        grant = dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss',
                     reason='held', unknown=[1, None])
        self.grants(grant)
        self.assertTrue(self.read()._has_audience('leaf', ledger.EXTERN))
        lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
        self.assertFalse(self.read()._has_audience('leaf', ledger.EXTERN))
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            self.assertFalse(tx.org._has_audience('leaf', ledger.EXTERN))
        self.assertEqual(store.load_org(self.slug).d['audiences'], [grant])
        lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'boss')
        self.assertTrue(self.read()._has_audience('leaf', ledger.EXTERN))
        self.assertEqual(store.load_org(self.slug).d['audiences'], [grant])

    def test_native_self_grant_survives_unrelated_and_self_move_until_revoke(self):
        org = store.load_org(self.slug)
        org.audience_grant('boss', 'boss', ledger.EXTERN)
        store.save_org(org)
        lifecycle_tx.move(self.slug, ledger.USER, 'leaf', 'other')
        with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
            self.assertTrue(tx.org._has_audience('boss', ledger.EXTERN))
        lifecycle_tx.move(self.slug, ledger.USER, 'boss', 'other')
        with orgtx.org_tx(self.slug, nodes=['boss'], sections=['audiences']) as tx:
            self.assertTrue(tx.org._has_audience('boss', ledger.EXTERN))
            tx.org.audience_revoke(ledger.USER, 'boss', ledger.EXTERN)
        lifecycle_tx.move(self.slug, ledger.USER, 'boss', None)
        with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
            self.assertFalse(tx.org._has_audience('boss', ledger.EXTERN))

    def test_identity_selection_uses_selected_ids_not_whole_audience_sections(self):
        self.grants(dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss'))
        original = reader_rows.read_records
        calls = []
        def selected(raw, key, ids):
            calls.append((key, list(ids)))
            self.assertEqual(key, 'audiences')
            self.assertEqual(len(ids), 1)
            return original(raw, key, ids)
        with patch.object(reader_rows, 'read_records', side_effect=selected):
            self.assertTrue(self.read()._has_audience('leaf', ledger.EXTERN))
        self.assertEqual(len(calls), 1)

    def test_watchdog_uses_complete_current_chain_and_restores_without_configured_loss(self):
        configured = deepcopy(store.load_org(self.slug).node('leaf')['scope'])
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole policy fallback')):
            before = policy_reads.watchdog_org(self.slug)
            self.assertEqual(set(before.nodes), {'boss', 'parent', 'leaf'})
            self.assertIsNone(supervisor._wd_owner_lost(before, before.d['watchdogs'][0]))
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
            narrow = policy_reads.watchdog_org(self.slug)
            self.assertEqual(set(narrow.nodes), {'other', 'parent', 'leaf'})
            self.assertIn('no longer holds bash',
                          supervisor._wd_owner_lost(narrow, narrow.d['watchdogs'][0]))
            self.assertEqual(narrow.node('leaf')['scope'], configured)
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'boss')
            restored = policy_reads.watchdog_org(self.slug)
            self.assertIsNone(supervisor._wd_owner_lost(restored, restored.d['watchdogs'][0]))

    def test_policy_owner_and_ancestor_scopes_share_one_repeatable_read_snapshot(self):
        original = reader_rows.read_agents
        def interleave(raw, names, **kw):
            self.assertEqual(raw.execute('SHOW transaction_isolation').fetchone()[0], 'repeatable read')
            self.assertEqual(raw.execute('SHOW transaction_read_only').fetchone()[0], 'on')
            with registry.connection(self.slug) as writer:
                writer.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents "
                               "WHERE name='other') WHERE name='parent'")
            return original(raw, names, **kw)
        with patch.object(reader_rows, 'read_agents', side_effect=interleave):
            before = policy_reads.watchdog_org(self.slug)
        self.assertEqual(before.node('parent')['parent'], 'boss')
        self.assertTrue(before.capability_scope('leaf')['tools']['bash'])
        after = policy_reads.watchdog_org(self.slug)
        self.assertEqual(after.node('parent')['parent'], 'other')
        self.assertFalse(after.capability_scope('leaf')['tools']['bash'])


if __name__ == '__main__':
    unittest.main()
