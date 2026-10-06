"""Bounded abandoned-docket recovery through real per-org transactions."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
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

    def test_archived_prediction_parity_without_full_materialization(self):
        org = store.load_org(self.slug)
        base = copy.deepcopy(org._work_active()[0])
        org.d['work_items'] = []
        compacted = org._work_holder('root')
        org.node('root')['generation'] += 1
        reminted = {**org._work_holder('other'), 'born': 'previous-seat'}
        cases = [
            ('deleted', {'node': 'missing', 'generation': 1}, OLD, OLD),
            ('retired', base['owner'], OLD, OLD),
            ('reminted', reminted, OLD, OLD),
            ('compacted', compacted, OLD, OLD),
            ('fresh-update', base['owner'], OLD, '1970-01-01T00:43:20Z'),
            ('fresh-docket', base['owner'], '1970-01-01T00:43:20Z', OLD),
        ]
        archived = []
        for name, owner, docket_at, updated_at in cases:
            archived.append({**copy.deepcopy(base), 'slug': name,
                             'owner': owner, 'docket_at': docket_at,
                             'updated_at': updated_at, 'status': 'open'})
        org.d['work_items_archive'] = archived
        store.save_org(org)
        def selected(snap, projected, slugs=None):
            return [(it['slug'], age, state) for it, age, state in
                    snap._work_abandoned_candidates(3000, None, slugs,
                                                    project_archive=projected)]
        full = selected(store.load_runtime_org(self.slug), False)
        self.assertEqual([x[0] for x in full], ['deleted', 'retired', 'reminted'])
        for wanted in (None, {'retired', 'fresh-update'}, {'compacted'}):
            snap = store.load_runtime_org(self.slug)
            self.assertFalse(snap.d.resident('work_items_archive'))
            with patch.object(snap, '_work_archive', side_effect=AssertionError('full archive')):
                actual = selected(snap, True, wanted)
            self.assertEqual(actual, selected(store.load_runtime_org(self.slug), False, wanted))
            self.assertFalse(snap.d.resident('work_items_archive'))
        resident = store.load_runtime_org(self.slug)
        resident._work_archive()
        self.assertEqual(selected(resident, True), full)

    def test_projected_recovery_rows_are_rejected_before_any_assignment(self):
        org = store.load_org(self.slug)
        item = org._work_active()[0]
        projected = ledger._WorkRecoveryProjection({k: item.get(k) for k in org._WORK_PROJ})
        rows = [(item, 2000, 'archived'), (projected, 2000, 'archived')]
        with patch.object(org, '_work_abandoned_candidates', return_value=iter(rows)), \
                patch.object(org, '_work_assign_core') as assign:
            with self.assertRaisesRegex(ledger.LedgerError, 'projected recovery'):
                org.work_reassign_abandoned(now_ts=3000)
        assign.assert_not_called()

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


    def projection_fixture(self):
        org = store.load_org(self.slug)
        base = copy.deepcopy(org._work_active()[0])
        rows = []
        shapes = ({}, {'status': {'odd': True}, 'title': ['unusual'],
                      'owner': 'gone', 'created_by': ['root'], 'reviewer': 7,
                      'participants': {'root': True}, 'manual_attention': ['yes'],
                      'docket_at': 17, 'updated_at': {'invalid': True}},
                  {'status': 'waiting', 'owner': {'node': 'gone', 'generation': 'x'},
                   'participants': ['root', {'odd': True}],
                   'docket_at': '2020-01-01T01:00:00+01:00',
                   'updated_at': 'not-a-date'},
                  {f: None for f in ledger.Org._WORK_PROJ if f != 'slug'})
        for i, changes in enumerate(shapes):
            rows.append({**copy.deepcopy(base), **changes, 'slug': f'projection-{i}'})
        org.d['work_items'] = []
        org.d['work_items_archive'] = rows
        store.save_org(org)
        return rows

    def test_native_projection_matches_all_fields_without_body_event_decode(self):
        from orgtree.orgdb.compat import rows as reader
        self.projection_fixture()
        full = store.load_runtime_org(self.slug)._work_archive()
        expected = [{f: row.get(f) for f in ledger.Org._WORK_PROJ} for row in full]
        with patch.object(reader, 'entry_of', wraps=reader.entry_of) as body, \
                patch.object(reader, '_item_events', wraps=reader._item_events) as events:
            snap = store.load_runtime_org(self.slug)
            self.assertEqual(snap._work_archive_proj(), expected)
            self.assertFalse(snap.d.resident('work_items_archive'))
            self.assertEqual(body.call_count, 0)
            self.assertEqual(events.call_count, 0)
            # The same counters must fire for an uncovered field request.
            extra = ledger.Org._WORK_PROJ + ('objective',)
            actual = snap.d.project('work_items_archive', extra)
            self.assertEqual(actual, [{f: row.get(f) for f in extra} for row in full])
            self.assertGreater(body.call_count, 0)
            self.assertGreater(events.call_count, 0)

    def test_native_projection_preserves_pending_moves_deletes_and_order(self):
        import json
        from orgtree.orgdb import docket
        self.projection_fixture()
        fields = ledger.Org._WORK_PROJ
        sql = "SELECT json_extract(val," + ','.join("'$." + f + "'" for f in fields) + ") FROM log_l WHERE sect BETWEEN ? AND ? ORDER BY seq"
        with store._POOL.acquire(self.slug) as conn:
            with conn.atomic():
                deleted = conn.raw.execute("SELECT id FROM orgtree.work_items WHERE list_key='archive' ORDER BY archive_seq LIMIT 1").fetchone()[0]
                moved = {'0': {'text': json.dumps({'slug': 'moved-first', 'status': ['weird']})},
                         '999999': {'text': json.dumps({'slug': 'moved-last', 'owner': 'gone'})}}
                conn.raw.execute("SELECT set_config('orgtree.compat_docket_pending',%s,true)",
                                 (json.dumps({'deleted': [deleted], 'moved': moved}),))
                actual = conn.execute(sql, ('work_items_archive', 'work_items_archive')).fetchall()
                with patch.object(docket, '_POLICY_KEYS', frozenset()):
                    expected = conn.execute(sql, ('work_items_archive', 'work_items_archive')).fetchall()
                self.assertEqual(actual, expected)
                slugs = [json.loads(row[0])[0] for row in actual]
                self.assertNotIn('projection-0', slugs)
                self.assertEqual(slugs[0], 'moved-first')
                self.assertEqual(slugs[-1], 'moved-last')


if __name__ == '__main__':
    unittest.main()
