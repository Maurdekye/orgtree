"""Current native scope protects actual file bytes and display projections."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

from copy import deepcopy
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import test_orgdb_compat_pg as fixture
from orgtree import api, ledger, lifecycle_tx, orgtx, pgdoor, store, supervisor
from orgtree.orgdb import registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class CurrentScopeFiles(unittest.TestCase):
    def setUp(self):
        self.enterContext(fixture.storage(True))
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='scope-files-')))
        self.project = self.folder / 'project'
        self.project.mkdir()
        self.source = self.project / 'fixture.txt'
        self.source.write_bytes(b'current permission controls these bytes')
        self.slug = 'scope-files-' + uuid.uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 50, 'boss')
        org.hire(ledger.USER, None, 'luna', 50, 'other')
        org.hire(ledger.USER, 'boss', 'luna', 5, 'parent')
        org.hire(ledger.USER, 'parent', 'luna', 0, 'leaf')
        for name in ('boss', 'parent', 'leaf'):
            org.node(name)['scope']['add_dirs'] = [{'path': str(self.project), 'mode': 'rw'}]
            org.node(name)['scope']['permission_mode'] = 'bypassPermissions'
            org.node(name)['scope']['org_visibility'] = 'full'
        org.node('other')['scope']['add_dirs'] = []
        org.node('other')['scope']['permission_mode'] = 'plan'
        org.node('other')['scope']['org_visibility'] = 'self'
        org.node('other')['scope']['tools']['edit'] = False
        store.save_org(org)
        self.addCleanup(store._POOL.close_all, self.slug)
        self.captured = store.load_org(self.slug)
        self.configured = deepcopy(self.captured.node('leaf')['scope'])

    def move(self, destination):
        lifecycle_tx.move(self.slug, ledger.USER, 'parent', destination)

    def sent_bytes(self, sent):
        return (Path(supervisor.scratch_dir(self.slug, 'leaf')) / sent['path']).read_bytes()

    def test_actual_send_uses_current_chain_and_restores_without_configured_loss(self):
        args = {'path': str(self.source)}
        before = api._agent_send_file(self.captured, 'leaf', args)
        self.assertEqual(self.sent_bytes(before['sent']), self.source.read_bytes())
        self.move('other')
        with self.assertRaisesRegex(ledger.LedgerError, 'only files'):
            api._agent_send_file(self.captured, 'leaf', args)
        self.move('boss')
        restored = api._agent_send_file(self.captured, 'leaf', args)
        self.assertEqual(self.sent_bytes(restored['sent']), self.source.read_bytes())
        self.assertEqual(store.load_org(self.slug).node('leaf')['scope'], self.configured)
        self.assertEqual(self.captured.node('parent')['parent'], 'boss')

    def test_delivery_id_replay_rechecks_scope_before_reusing_saved_bytes(self):
        args = {'path': str(self.source), 'delivery_id': 'scope-fixture-delivery-0001'}
        before = api._agent_send_file(self.captured, 'leaf', args)
        self.move('other')
        with self.assertRaisesRegex(ledger.LedgerError, 'only files'):
            api._agent_send_file(self.captured, 'leaf', args)
        self.assertEqual(self.sent_bytes(before['sent']), self.source.read_bytes())
        self.move('boss')
        self.assertEqual(api._agent_send_file(self.captured, 'leaf', args)['sent'], before['sent'])

    def test_actual_html_snapshot_refuses_a_currently_unheld_grant(self):
        source = self.project / 'fixture.html'
        source.write_text('<!doctype html><p>scope fixture</p>', encoding='utf-8')
        self.move('other')
        with self.assertRaisesRegex(ledger.LedgerError, 'only files'):
            api._outbox_snapshot(self.captured, 'leaf', str(source),
                                 always_copy=True, html_bundle=True)
        self.move('boss')
        name, size = api._outbox_snapshot(self.captured, 'leaf', str(source),
                                        always_copy=True, html_bundle=True)
        self.assertGreater(size, 0)
        self.assertEqual(self.sent_bytes({'path': 'outbox/' + name}), source.read_bytes())

    def test_current_scope_paths_stay_locked_through_the_real_copy(self):
        import psycopg
        original = api.shutil.copy2
        outcomes = []
        def writer():
            try:
                with registry.connection(self.slug) as raw, raw.transaction():
                    raw.execute("SET LOCAL lock_timeout='150ms'")
                    raw.execute("UPDATE orgtree.agents SET credit_grant=credit_grant WHERE name='boss'")
                outcomes.append('wrote')
            except psycopg.errors.LockNotAvailable:
                outcomes.append('blocked')
            except Exception as exc:
                outcomes.append(repr(exc))
        def copying(*args, **kwargs):
            self.assertIsNotNone(pgdoor.current(self.slug))
            competing = threading.Thread(target=writer)
            competing.start()
            competing.join(4)
            self.assertFalse(competing.is_alive())
            self.assertEqual(outcomes, ['blocked'])
            return original(*args, **kwargs)
        with patch.object(api.shutil, 'copy2', side_effect=copying):
            result = api._agent_send_file(self.captured, 'leaf', {'path': str(self.source)})
        self.assertEqual(self.sent_bytes(result['sent']), self.source.read_bytes())
        with registry.connection(self.slug) as raw, raw.transaction():
            raw.execute("SET LOCAL lock_timeout='150ms'")
            raw.execute("UPDATE orgtree.agents SET credit_grant=credit_grant WHERE name='boss'")

    def test_scratch_and_workspace_are_still_reachable_under_a_narrow_manager(self):
        scratch = Path(supervisor.scratch_dir(self.slug, 'leaf'))
        scratch.mkdir(parents=True, exist_ok=True)
        local = scratch / 'local.txt'
        local.write_bytes(b'own scratch remains reachable')
        workspace = self.folder / 'workspace'
        workspace.mkdir()
        shared = workspace / 'shared.txt'
        shared.write_bytes(b'org workspace remains reachable')
        org = store.load_org(self.slug)
        org.d['workspace'] = str(workspace)
        store.save_org(org)
        self.move('other')
        for path in (local, shared):
            with self.subTest(path=path.name):
                got = api._agent_send_file(self.captured, 'leaf', {'path': str(path)})
                self.assertEqual(self.sent_bytes(got['sent']), path.read_bytes())

    def test_tree_projects_effective_scope_and_keeps_configured_editor_choices(self):
        before = orgtx.org_read(self.slug)
        self.move('other')
        narrow = orgtx.org_read(self.slug)
        value = narrow.tree_node('leaf', descend=False, lineage=False)
        self.assertEqual(value['configured_scope'], self.configured)
        self.assertEqual(value['scope']['add_dirs'], [])
        self.assertFalse(value['scope']['tools']['edit'])
        self.assertEqual(value['scope']['permission_mode'], 'plan')
        self.assertEqual(value['scope']['org_visibility'], 'self')
        self.assertEqual(before.tree_node('leaf', descend=False, lineage=False)['scope'], self.configured)
        self.move('boss')
        restored = orgtx.org_read(self.slug).tree_node('leaf', descend=False, lineage=False)
        self.assertEqual(restored['scope'], self.configured)
        self.assertEqual(restored['configured_scope'], self.configured)

    def test_capability_payload_reports_current_modes_instead_of_the_captured_seat(self):
        self.move('other')
        self.assertEqual(api._agent_capability_payload(self.captured, 'leaf')['scope'],
                         {'org_visibility': 'self', 'permission_mode': 'plan'})
        self.move('boss')
        self.assertEqual(api._agent_capability_payload(self.captured, 'leaf')['scope'],
                         {'org_visibility': 'full', 'permission_mode': 'bypassPermissions'})

    def test_receipt_checkout_and_log_bytes_use_the_current_grant(self):
        args = {'checkout': str(self.project), 'logs': [str(self.source)]}
        self.assertEqual(api._work_checkout(self.captured, 'leaf', args), str(self.project))
        before = api._work_receipt_logs(self.captured, 'leaf', args)
        self.assertEqual(before[0]['text'], self.source.read_text(encoding='utf-8'))
        self.move('other')
        with self.assertRaisesRegex(ledger.LedgerError, 'only files'):
            api._work_checkout(self.captured, 'leaf', args)
        denied = api._work_receipt_logs(self.captured, 'leaf', args)
        self.assertIn('unreadable', denied[0])
        self.assertEqual(denied[0]['bytes'], 0)
        self.move('boss')
        self.assertEqual(api._work_receipt_logs(self.captured, 'leaf', args)[0]['text'], before[0]['text'])

    def test_archived_summary_omits_both_full_scopes_but_uses_effective_readonly_marker(self):
        self.move('other')
        value = orgtx.org_read(self.slug).tree_node('leaf', descend=False, lineage=False)
        value['state'] = 'archived'
        api._summarise_archived(value)
        summary = value
        self.assertNotIn('scope', summary)
        self.assertNotIn('configured_scope', summary)
        self.assertTrue(summary['read_only'])


if __name__ == '__main__':
    unittest.main()
