"""Bounded abandoned-docket recovery through real per-org transactions."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack, contextmanager
from unittest.mock import patch
from uuid import uuid4
import unittest

import test_orgdb_compat_pg as fixture
from orgtree import ledger, orgtx, store, supervisor as sup, worktx

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule
OLD = '1970-01-01T00:16:40Z'


@fixture.needs_pg
class Recovery(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(fixture.storage(True))
        store.claim_data_root()
        self.slug = 'recovery-' + uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 20, 'root')
        org.hire(ledger.USER, 'root', 'opus', 0, 'gone')
        org.hire(ledger.USER, 'root', 'opus', 0, 'other')
        org.node('gone')['state'] = 'archived'
        self.items = []
        for i in range(3):
            result = org.work_create(ledger.USER, 'Recovery ' + str(i), 'recover', owner='root')
            it = org._work_active()[-1]
            it['owner'] = {'node': 'gone', 'generation': org.node('gone')['generation']}
            it['docket_at'] = it['updated_at'] = OLD
            self.items.append(it['slug'])
        store.save_org(org)
        sup._abandoned_retry.pop(self.slug, None)
        self.addCleanup(sup._abandoned_retry.pop, self.slug, None)
        self.stack.enter_context(patch.object(sup.policy_context, 'org_rows',
                                             return_value=[{'slug': self.slug}]))
        self.stack.enter_context(patch.object(sup, 'mail_spark'))
        self.wake = self.stack.enter_context(patch.object(sup, 'send_message'))
        self.plans = []
        original = orgtx.org_tx

        @contextmanager
        def tracked(slug, **kwargs):
            self.plans.append(kwargs)
            with original(slug, **kwargs) as tx:
                yield tx
        self.stack.enter_context(patch.object(orgtx, 'org_tx', side_effect=tracked))

    def owners(self):
        return [it['owner']['node'] for it in store.load_org(self.slug)._work_active()]

    def test_old_plan_reproduces_unlocked_archive_write_and_rolls_back(self):
        org = store.load_org(self.slug)
        item = org._work_active().pop()
        org.d['work_items_archive'] = [item]
        store.save_org(org)
        with self.assertRaises(orgtx.UnlockedWrite) as caught:
            with orgtx.org_tx(self.slug, nodes=orgtx.ALL,
                             sections=('work_items', 'mail', 'notices', 'asks'),
                             logs=('events', 'notice_log', 'mail_log', 'lifecycle')) as tx:
                tx.org.work_reassign_abandoned(now_ts=100000)
        print('old recovery refused rows:', caught.exception.rows)
        self.assertTrue(caught.exception.rows)
        self.assertEqual(self.owners(), ['gone', 'gone'])
        sup._abandoned_docket_recovery_pass(now=100000)
        saved = store.load_org(self.slug)
        self.assertEqual([it['owner']['node'] for it in saved._work_archive()], ['root'])
        self.assertEqual(self.owners(), ['root', 'root'])

    def test_scoped_batch_durable_mail_and_no_repeat(self):
        with patch.object(sup, '_ABANDONED_BATCH', 2):
            sup._abandoned_docket_recovery_pass(now=100000)
            self.assertEqual(self.owners(), ['root', 'root', 'gone'])
            sup._abandoned_docket_recovery_pass(now=100000)
            self.assertEqual(self.owners(), ['root', 'root', 'root'])
            sup._abandoned_docket_recovery_pass(now=100000)
        self.assertEqual(self.wake.call_count, 3)
        for plan in self.plans:
            self.assertIsNot(plan.get('nodes'), orgtx.ALL)
            self.assertNotIn('other', plan.get('nodes', ()))
            self.assertLessEqual(len(plan.get('nodes', ())), 2)
        saved = store.load_org(self.slug)
        for it in saved._work_active():
            self.assertEqual(sum(h['op'] == 'assign' for h in it['history']), 1)
        self.assertIn('docket.assigned', str(saved.d.get('mail')))

    def test_owner_revalidated_between_prediction_and_transaction(self):
        original = worktx.run
        def changed(slug, fn, **kwargs):
            org = store.load_org(slug)
            for it in org._work_active():
                it['owner'] = org._work_holder('other')
            store.save_org(org)
            return original(slug, fn, **kwargs)
        with patch.object(worktx, 'run', side_effect=changed):
            sup._abandoned_docket_recovery_pass(now=100000)
        self.assertNotIn(self.slug, sup._abandoned_retry)
        self.assertEqual(self.owners(), ['other'] * 3)
        self.wake.assert_not_called()

    def test_destination_revalidated_without_writing_an_unplanned_node(self):
        original = worktx.run
        def changed(slug, fn, **kwargs):
            org = store.load_org(slug)
            org.node('root')['state'] = 'archived'
            store.save_org(org)
            return original(slug, fn, **kwargs)
        with patch.object(worktx, 'run', side_effect=changed):
            sup._abandoned_docket_recovery_pass(now=100000)
        self.assertNotIn(self.slug, sup._abandoned_retry)
        self.assertEqual(self.owners(), ['gone'] * 3)
        self.wake.assert_not_called()

    def test_failures_back_off_and_success_clears_backoff(self):
        with patch.object(worktx, 'run', side_effect=orgtx.UnlockedWrite('injected')) as run:
            for stamp in (100000, 100020, 100060, 100179, 100180):
                sup._abandoned_docket_recovery_pass(now=stamp)
            self.assertEqual(run.call_count, 3)
        self.assertEqual(self.owners(), ['gone'] * 3)
        self.wake.assert_not_called()
        sup._abandoned_docket_recovery_pass(now=100419)
        self.assertEqual(self.owners(), ['gone'] * 3)
        sup._abandoned_docket_recovery_pass(now=100420)
        self.assertEqual(self.owners(), ['root'] * 3)
        self.assertNotIn(self.slug, sup._abandoned_retry)


if __name__ == '__main__':
    unittest.main()
