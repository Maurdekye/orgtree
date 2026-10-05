"""Reached native audience/identity/policy controls on disposable org databases."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch
import uuid

import test_orgdb_compat_pg as fixture
from orgtree import identity_context, ledger, lifecycle_tx, orgtx, pgdoor, policy_context, policy_reads, store, supervisor
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
        org.node('other')['scope']['tools']['edit'] = False
        org.d['watchdogs'] = [dict(id='dog', owner='leaf', kind='command', state='armed',
                                  name='dog', target='echo fixture', interval_s=15)]
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, self.slug)

    def grants(self, *values):
        org = store.load_org(self.slug)
        org.d['audiences'] = list(deepcopy(values))
        store.save_org(org)

    def test_detached_launch_inputs_reenter_current_transaction(self):
        from orgtree.orgdb import native_move
        with orgtx.org_tx(self.slug, share_nodes=['leaf']) as tx:
            detached = tx.org
        with self.assertRaisesRegex(ledger.LedgerError, 'current planned org transaction'):
            supervisor.granted_mcp_servers.__wrapped__(detached, 'leaf')
        observed = []
        def servers():
            active = pgdoor.current(self.slug)
            self.assertIsNotNone(active)
            observed.append(active.org.capability_scope('leaf')['tools']['bash'])
            return {}
        with patch.object(supervisor, 'registered_mcp_servers', side_effect=servers):
            self.assertEqual(supervisor.granted_mcp_servers(detached, 'leaf'), {})
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
            self.assertEqual(supervisor.granted_mcp_servers(detached, 'leaf'), {})
        self.assertEqual(observed, [True, False])
        prompt = supervisor.identity_prompt(detached, 'leaf')
        self.assertIn('Disabled for you:', prompt)
        self.assertIn('bash', prompt)
        with self.assertRaisesRegex(ledger.LedgerError, 'current planned org transaction'):
            native_move.connection(detached)

    def test_inbound_mail_rechecks_moved_audience_and_preserves_receipt(self):
        self.grants(dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss'))
        self.assertEqual(supervisor._inbound_recipients(self.slug), ['leaf'])
        original = supervisor._inbound_recipients
        moved = []
        def predict(slug):
            result = original(slug)
            if not moved:
                moved.append(True)
                lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
            return result
        with patch.object(supervisor, '_inbound_recipients', side_effect=predict), \
                patch.object(supervisor, 'send_message'), patch.object(supervisor, 'mail_spark'):
            first = supervisor.deliver_org_inbox(self.slug, '@net:repair-test',
                'repair fixture', net_id='repair-test', op_key='inbound-repair-test')
            again = supervisor.deliver_org_inbox(self.slug, '@net:repair-test',
                'repair fixture', net_id='repair-test', op_key='inbound-repair-test')
        self.assertEqual(first, ['boss'])
        self.assertEqual(again, first)
        org = store.load_org(self.slug)
        delivered = [m for m in org.d['mail']['boss'] if m.get('body') == 'repair fixture']
        self.assertEqual(len(delivered), 1)
        self.assertFalse(any(m.get('body') == 'repair fixture'
                             for m in org.d['mail'].get('leaf', [])))

    def test_inbound_mail_covers_four_independent_holders_in_one_plan(self):
        org = store.load_org(self.slug)
        for name in ('third', 'fourth'):
            org.hire(ledger.USER, None, 'luna', 0, name)
        store.save_org(org)
        holders = ['boss', 'other', 'third', 'fourth']
        self.grants(*(dict(grantee=name, grantor=ledger.EXTERN) for name in holders))
        self.assertEqual(supervisor._inbound_recipients(self.slug), holders)
        with patch.object(supervisor, 'send_message'), patch.object(supervisor, 'mail_spark'):
            got = supervisor.deliver_org_inbox(self.slug, '@net:repair-test',
                'four holders', op_key='four-holder-repair-test')
        self.assertEqual(got, holders)
        org = store.load_org(self.slug)
        for name in holders:
            self.assertEqual(sum(m.get('body') == 'four holders'
                                 for m in org.d['mail'][name]), 1)

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
        with orgtx.org_tx(self.slug, nodes=['leaf'], share_nodes=['boss']) as tx:
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
        with orgtx.org_tx(self.slug, nodes=['boss'], sections=['audiences', 'notices'],
                          logs=['events', 'notice_log']) as tx:
            self.assertTrue(tx.org._has_audience('boss', ledger.EXTERN))
            tx.org.audience_revoke(ledger.USER, 'boss', ledger.EXTERN)
        lifecycle_tx.move(self.slug, ledger.USER, 'boss', None)
        with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
            self.assertFalse(tx.org._has_audience('boss', ledger.EXTERN))

    def test_omitted_anchor_widens_and_retries_before_current_authority_is_used(self):
        self.grants(dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss'))
        lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
        attempts, decisions = [], []
        def action(tx):
            attempts.append(1)
            decision = tx.org._has_audience('leaf', ledger.EXTERN)
            decisions.append(decision)
            return decision
        self.assertFalse(pgdoor.run(self.slug, pgdoor.TxSpec(nodes=('leaf',)), action))
        self.assertEqual(len(attempts), 2)
        self.assertEqual(decisions, [False])

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

    def test_recurring_policy_context_resolves_current_capabilities_and_paused_audiences(self):
        self.grants(dict(grantee='leaf', grantor=ledger.EXTERN, delegated_by='boss'))
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole policy fallback')):
            before = policy_context.read(self.slug)
            self.assertIsInstance(before, policy_context.PolicyContext)
            self.assertTrue(before.capability_scope('leaf')['tools']['bash'])
            self.assertTrue(before._has_audience('leaf', ledger.EXTERN))
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
            after = policy_context.read(self.slug)
        self.assertFalse(after.effective_agent('leaf')['scope']['tools']['bash'])
        self.assertFalse(after._has_audience('leaf', ledger.EXTERN))
        self.assertTrue(before.capability_scope('leaf')['tools']['bash'])
        self.assertTrue(before._has_audience('leaf', ledger.EXTERN))

    def test_codex_approval_uses_current_chain_while_issued_sandbox_stays_fixed(self):
        captured = store.load_org(self.slug)
        issued = pgdoor.run(self.slug, pgdoor.TxSpec(share_nodes=('leaf',)),
                            lambda tx: deepcopy(tx.org.capability_scope('leaf')))
        sandbox = supervisor._codex_sandbox(issued)
        allowed, denied = [], []
        callback = supervisor._codex_approval_decider(captured, 'leaf', allowed, denied)
        command = 'item/commandExecution/requestApproval'
        file_change = 'item/fileChange/requestApproval'
        with patch.object(identity_context, 'load', side_effect=AssertionError('cached authority')), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole cached authority')):
            self.assertEqual(callback(command, {'command': ['fixture', 'read']}), 'accept')
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'other')
            self.assertEqual(callback(command, {'command': ['fixture', 'write']}), 'decline')
            self.assertEqual(callback(file_change, {'grantRoot': 'fixture'}), 'decline')
            lifecycle_tx.move(self.slug, ledger.USER, 'parent', 'boss')
            self.assertEqual(callback(file_change, {'grantRoot': 'fixture'}), 'accept')
        self.assertEqual(supervisor._codex_sandbox(issued), sandbox)
        self.assertEqual(captured.node('parent')['parent'], 'boss')
        self.assertEqual([r['tool_name'] for r in allowed], ['commandExecution', 'fileChange'])
        self.assertEqual([r['tool_name'] for r in denied], ['commandExecution', 'fileChange'])

    def test_codex_approval_holds_ancestor_share_lock_through_the_decision(self):
        import psycopg
        outcomes = []
        def competing_writer():
            try:
                with registry.connection(self.slug) as raw, raw.transaction():
                    raw.execute("SET LOCAL lock_timeout='150ms'")
                    raw.execute("UPDATE orgtree.agents SET credit_grant=credit_grant WHERE name='boss'")
                outcomes.append('wrote')
            except psycopg.errors.LockNotAvailable:
                outcomes.append('blocked')
            except Exception as exc:
                outcomes.append(type(exc).__name__ + ': ' + str(exc))

        original = supervisor._codex_may_write
        def decide(scope):
            self.assertIsNotNone(pgdoor.current(self.slug))
            writer = threading.Thread(target=competing_writer)
            writer.start()
            writer.join(4)
            self.assertFalse(writer.is_alive(), 'competing writer did not reach its lock timeout')
            self.assertEqual(outcomes, ['blocked'])
            return original(scope)

        callback = supervisor._codex_approval_decider(store.load_org(self.slug), 'leaf', [], [])
        with patch.object(supervisor, '_codex_may_write', side_effect=decide):
            self.assertEqual(callback('item/fileChange/requestApproval', {}), 'accept')
        with registry.connection(self.slug) as raw, raw.transaction():
            raw.execute("SET LOCAL lock_timeout='150ms'")
            raw.execute("UPDATE orgtree.agents SET credit_grant=credit_grant WHERE name='boss'")


if __name__ == '__main__':
    unittest.main()
