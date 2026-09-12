"""Primary selection crosses the real agent dispatch, never live data."""
import asyncio
import time
import unittest
from unittest.mock import patch

import test_account_selection_contract as fx


class PrimarySelection(unittest.TestCase):
    @property
    def _seq(self):
        return fx.AccountSelectionContract._seq

    setUp = fx.AccountSelectionContract.setUp
    account = fx.AccountSelectionContract.account
    call = fx.AccountSelectionContract.call
    bound = fx.AccountSelectionContract.bound

    def bind_worker(self, provider='claude', ran=False):
        row = self.account(provider)
        node = self.org.node('worker')
        node['account'] = row['id']
        if provider == 'openai':
            node['model'] = 'luna'
            if ran:
                node['codex_thread'] = 'fixture-thread'
                node['session_unrun'] = False
        fx.store.save_org(self.org)
        return row

    def test_retool_clears_secondary_and_records_primary(self):
        old = self.bind_worker()
        out = self.call('orgtree_retool', node='worker', account='primary')
        self.assertIsNone(self.bound('worker'))
        self.assertEqual(out['account'], 'claude/primary')
        disclosure = out['account_binding']
        self.assertEqual(disclosure['previous_account'], old['id'])
        self.assertEqual(disclosure['billing_mode'], 'ambient')
        self.assertEqual(disclosure['auth'], 'unobserved')
        self.assertTrue(disclosure['cache_namespace_changed'])
        self.assertFalse(disclosure['session_boundary'])
        events = [e for e in self.org.d['events'] if e['op'] == 'account_assign']
        self.assertEqual(events[-1]['detail']['account'], 'claude/primary')

    def test_codex_retool_archives_old_session_and_clears_home(self):
        old = self.bind_worker('openai', ran=True)
        with patch.object(fx.supervisor, 'export_predecessor_transcript') as export:
            out = self.call('orgtree_retool', node='worker', account='openai/primary')
        self.assertIsNone(self.bound('worker'))
        self.assertEqual(fx.supervisor.codex_bound_home(self.org, 'worker'), ('', ''))
        self.assertTrue(out['account_binding']['session_boundary'])
        bearer = self.org.node(out['account_binding']['bearer'])
        self.assertEqual(bearer['account'], old['id'])
        self.assertEqual(bearer['codex_thread'], 'fixture-thread')
        self.assertNotIn('codex_thread', self.org.node('worker'))
        export.assert_called_once()

    def test_primary_noop_preserves_codex_session(self):
        node = self.org.node('worker')
        node.update(model='luna', codex_thread='keep', session_unrun=False)
        fx.store.save_org(self.org)
        with patch.object(fx.supervisor, 'export_predecessor_transcript') as export:
            out = self.call('orgtree_retool', node='worker', account='primary')
        self.assertFalse(out['account_binding']['session_boundary'])
        self.assertFalse(out['account_binding']['cache_namespace_changed'])
        self.assertEqual(self.org.node('worker')['codex_thread'], 'keep')
        export.assert_not_called()

    def test_primary_hire_overrides_org_default(self):
        row = self.account()
        self.org.set_hire_defaults(default_account=row['id'])
        fx.store.save_org(self.org)
        for tool, extra in [('orgtree_hire', {}), ('orgtree_staff', {
                'title': 'Primary work', 'objective': 'Need a seat on primary.'})]:
            with self.subTest(tool=tool):
                name = 'new-' + tool.replace('_', '-')
                out = self.call(tool, name=name, tier='haiku', grant=0,
                                charter='fixture', add_dirs=[], tools=fx.NO_TOOLS,
                                org_visibility='self', account='claude/primary', **extra)
                self.assertIsNone(self.bound(name))
                self.assertEqual(out['account'], 'claude/primary')

    def test_rehire_primary_persisted_before_drive_and_notice(self):
        self.bind_worker('openai', ran=True)
        self.call('orgtree_retire', node='worker')
        observed = []
        def observe(*args, **kw):
            node = fx.store.load_org(self.slug).node('worker')
            observed.append((node['state'], node.get('account'), node.get('codex_thread')))
            return {}
        with patch.object(fx.supervisor, 'send_message', side_effect=observe), \
             patch.object(fx.supervisor, 'notify', side_effect=observe), \
             patch.object(fx.supervisor, 'export_predecessor_transcript'):
            out = self.call('orgtree_rehire', node='worker', account='primary', kickoff='go')
        self.assertTrue(out['started'])
        self.assertTrue(observed)
        self.assertTrue(all(o == ('live', None, None) for o in observed), observed)

    def test_refused_rehire_or_staff_has_no_account_side_effect(self):
        old = self.bind_worker('openai', ran=True)
        destination = self.account('openai', label='destination')
        self.call('orgtree_retire', node='worker')
        cases = [
            ('orgtree_rehire', {'tools': {**fx.NO_TOOLS, 'mcp': ['forbidden']}}),
            ('orgtree_rehire', {'audiences': ['unknown']}),
            ('orgtree_rehire', {'kickoff': 'go', 'kickoff_kind': 'notice'}),
            ('orgtree_staff', {'title': 'Rejected', 'objective': ''}),
        ]
        for tool, extra in cases:
            with self.subTest(tool=tool, extra=extra), \
                 patch.object(fx.supervisor, 'assign_account') as assign, \
                 patch.object(fx.supervisor, 'export_predecessor_transcript') as export:
                with self.assertRaises(fx.api.HTTPException):
                    self.call(tool, node='worker', account=destination['id'], **extra)
                assign.assert_not_called()
                export.assert_not_called()
                node = fx.store.load_org(self.slug).node('worker')
                self.assertEqual(node['state'], 'archived')
                self.assertEqual(node['account'], old['id'])
                self.assertEqual(node['codex_thread'], 'fixture-thread')

    def test_staff_rehire_primary(self):
        self.bind_worker()
        self.call('orgtree_retire', node='worker')
        out = self.call('orgtree_staff', node='worker', account='primary',
                        title='Restored', objective='Need restored primary capacity.')
        self.assertIsNone(self.bound('worker'))
        self.assertEqual(out['account'], 'claude/primary')

    def test_primary_authority_and_provider_checks(self):
        for actor, target, account in [('manager', 'manager', 'primary'),
                                       ('worker', 'manager', 'primary'),
                                       ('manager', 'worker', 'openai/primary')]:
            with self.subTest(actor=actor, target=target, account=account):
                with self.assertRaises(fx.api.HTTPException):
                    self.call('orgtree_retool', actor=actor, node=target, account=account)

    def test_busy_retool_keeps_scope_and_account(self):
        old = self.bind_worker()
        st = fx.supervisor.state(self.slug, 'worker')
        st['busy'] = True
        try:
            with self.assertRaises(fx.api.HTTPException):
                self.call('orgtree_retool', node='worker', account='primary', charter='changed')
        finally:
            st['busy'] = False
        self.assertEqual(self.bound('worker'), old['id'])
        self.assertEqual(fx.store.load_org(self.slug).node('worker')['charter'], 'fixture')

    def test_operator_endpoint_accepts_the_visible_primary_value(self):
        self.bind_worker()
        out = asyncio.run(fx.api.node_account_assign(
            self.slug, 'worker', fx.api.AccountAssign(account='claude/primary')))
        self.assertEqual(out['account'], 'claude/primary')
        self.assertIsNone(self.bound('worker'))

    def test_imported_ambient_name_matches_creation_and_listing(self):
        path = fx.Path(fx.FX) / self.slug / 'ambient-codex'
        path.mkdir(parents=True)
        with patch('orgtree.registry_migration.observe_ambient', return_value={
                'claude': None, 'openai': str(path), 'google': None}):
            created = asyncio.run(fx.api.accounts_create(fx.api.AccountCreate(
                provider='openai', kind='imported', path=str(path), label='Personal')))
            listed = asyncio.run(fx.api.accounts_list(self.slug))['accounts'][0]
        self.assertEqual(created['name'], 'openai/primary')
        self.assertEqual(listed['name'], created['name'])
        self.assertEqual(created['label'], created['name'])
        self.assertEqual(fx.registry.validate_selection(
            self.slug, 'luna', created['name'])['id'], '')

    def test_public_names_survive_label_collisions_renames_and_removal(self):
        first = self.account(label='primary')
        second = self.account(label=first['id'])
        doc = fx.registry.load(strict=True)
        fx.registry.get_account(first['id'], doc)['label'] = second['id']
        doc['aliases']['legacy-login'] = second['id']
        fx.registry.save(doc)
        rows = asyncio.run(fx.api.accounts_list(self.slug))['accounts']
        self.assertEqual({r['name'] for r in rows}, {first['id'], second['id']})
        for row in rows:
            self.assertEqual(row['label'], row['name'])
            resolved = fx.registry.validate_selection(self.slug, 'haiku', row['name'])
            self.assertEqual(resolved['id'], row['id'])
        self.assertEqual(fx.registry.validate_selection(self.slug, 'haiku', 'primary')['id'], '')
        self.assertEqual(fx.registry.validate_selection(self.slug, 'haiku', 'legacy-login')['id'], second['id'])
        fx.registry.remove_account(first['id'])
        replacement = self.account(label=first['id'])
        self.assertNotEqual(replacement['id'], first['id'])
        with self.assertRaises(fx.registry.BindingRefused):
            fx.registry.validate_selection(self.slug, 'haiku', first['id'])

    def test_roster_ui_and_all_four_tools_accept_the_same_secondary_name(self):
        row = self.account(label='a confusing mutable label')
        listed = asyncio.run(fx.api.accounts_list(self.slug))['accounts'][0]
        chosen = listed['name']
        board = fx.turnusage.board(self.org, 'manager', now=fx.NOW)[0]
        self.assertIn(f'{chosen} account={chosen}', board)
        self.assertIn(f'{chosen} |', board)
        self.assertNotIn(row['label'], board)
        self.call('orgtree_retool', node='worker', account=chosen)
        self.assertEqual(self.bound('worker'), row['id'])
        self.call('orgtree_retire', node='worker')
        self.call('orgtree_rehire', node='worker', account=chosen)
        self.assertEqual(self.bound('worker'), row['id'])
        for tool, extra in [('orgtree_hire', {}), ('orgtree_staff', {
                'title': 'Named work', 'objective': 'Use the displayed name.'})]:
            out = self.call(tool, name=tool.replace('_', '-'), tier='haiku', grant=0,
                            charter='fixture', add_dirs=[], tools=fx.NO_TOOLS,
                            org_visibility='self', account=chosen, **extra)
            self.assertEqual(out['account'], chosen)
            self.assertEqual(self.bound(out['node']), row['id'])

    def test_bound_codex_usage_marks_its_own_account_as_selected(self):
        row = self.bind_worker('openai')
        with fx.codex_limits._lock:
            fx.codex_limits._home_cache['acct:' + row['id']] = {
                'at': fx.NOW - 10, 'data': {'available': True,
                    'limits': [fx.limit('weekly_all', 18)]}}
        board = fx.turnusage.board(self.org, 'worker', selected_provider='openai', now=fx.NOW)[0]
        self.assertIn(f"{row['id']}* | weekly_all | 18%", board)
        self.assertNotIn('openai/primary*', board)

    def test_receipt_replay_retains_primary_and_session_cost(self):
        self.bind_worker('openai', ran=True)
        epoch, _ = fx.api.opreceipts.custody(self.org.d, fx.store.DATA_ROOT, self.slug)
        body = fx.api.AgentCall(org=self.slug, node='manager', tool='orgtree_op_call', args={
            'tool': 'orgtree_retool', 'args': {'node': 'worker', 'account': 'primary'},
            'op_key': f'{int(time.time() * 1000)}-{fx.uuid.uuid4().hex[:24]}', 'op_epoch': epoch})
        with patch.object(fx.supervisor, 'export_predecessor_transcript') as export:
            first = fx.api.agent_call(body, fx.Request({'type': 'http', 'headers': []}))
            second = fx.api.agent_call(body, fx.Request({'type': 'http', 'headers': []}))
        self.assertEqual(first['account'], 'openai/primary')
        self.assertTrue(second['replayed'])
        result = second['receipt']['result']
        self.assertEqual(result['account'], 'openai/primary')
        self.assertTrue(result['account_binding']['session_boundary'])
        self.assertTrue(result['account_binding']['cache_namespace_changed'])
        export.assert_called_once()

    def test_legacy_ambient_id_rehire_retains_the_profile_binding(self):
        row = self.bind_worker()
        fx.AccountSelectionContract.make_ambient(self, row)
        self.call('orgtree_retire', node='worker')
        out = self.call('orgtree_rehire', node='worker', account=row['id'])
        self.assertEqual(self.bound('worker'), row['id'])
        self.assertEqual(out['account'], 'claude/primary')

    def test_explicit_primary_is_not_rebound_by_a_migration_rerun(self):
        from orgtree import registry_migration
        old = self.bind_worker()
        self.call('orgtree_retool', node='worker', account='primary')
        registry_migration.run_migration([self.org.d], {
            'claude': old['credential']['path'], 'openai': None, 'google': None})
        self.assertIsNone(self.org.node('worker').get('account'))
        self.assertTrue(self.org.node('worker')['account_primary'])

    def test_atomic_model_switch_accepts_qualified_primary(self):
        self.bind_worker()
        self.org.node('worker')['pending_switch'] = {
            'tier': 'luna', 'from': 'haiku', 'by': 'manager', 'at': 0,
            'account': 'openai/primary'}
        fx.supervisor._apply_pending_switch_locked(self.org, self.slug, 'worker')
        self.assertEqual(self.org.node('worker')['model'], 'luna')
        self.assertIsNone(self.org.node('worker').get('account'))


def tearDownModule():
    fx.tearDownModule()


if __name__ == '__main__':
    unittest.main()
