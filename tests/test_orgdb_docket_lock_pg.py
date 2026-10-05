"""Real docket-save/agent-transaction lock interactions on disposable PostgreSQL.

The barriers only choose an interleaving; every write and row lock is the
production implementation. Run through the repository verification runner
under the heavy P03 lock, with an owned disposable cluster.
"""

import import_provenance  # noqa: F401  asserts this checkout before engine imports

import threading
import time
import copy
import json
import unittest
from unittest.mock import patch

import test_orgdb_schema_rename_pg as f
from orgtree import ledger, orgtx, store
from orgtree.orgdb import docket_locks, registry
from orgtree.orgdb.compat import rows as R


def setUpModule():
    f.setUpModule()


def tearDownModule():
    f.tearDownModule()


def errors(error):
    result = []
    while error is not None:
        result.append((type(error).__name__, getattr(error, 'sqlstate', None), str(error)))
        error = error.__cause__
    return result


@f.f.needs_pg
class DocketAgentLocks(unittest.TestCase):
    def overlap(self, *, changed_roles=False, settings=False):
        twins = f.f.Twins('docket-agent-' + self._testMethodName, before=f.prepare_legacy)
        ready, release = threading.Event(), threading.Event()
        outcomes, pids, blocked_queries = {}, {}, []
        real_write, real_checkout = R._docket_write, registry.checkout
        real_lock = docket_locks.lock
        agent = 'owner' if changed_roles else 'worker'

        def checkout(*args, **kwargs):
            raw = real_checkout(*args, **kwargs)
            name = threading.current_thread().name
            if name in ('agent-writer', 'docket-writer'):
                pids[name] = raw.info.backend_pid
            return raw

        def docket_write(c, record, keys, previous):
            if not settings and threading.current_thread().name == 'docket-writer' and record.get('title') == 'B title':
                ready.set()
                if not release.wait(12):
                    raise RuntimeError('docket scheduling barrier expired')
            return real_write(c, record, keys, previous)

        def role_lock(*args, **kwargs):
            result = real_lock(*args, **kwargs)
            if settings and threading.current_thread().name == 'docket-writer':
                ready.set()
                if not release.wait(12):
                    raise RuntimeError('settings scheduling barrier expired')
            return result

        def observe(name, fn):
            try:
                fn()
                outcomes[name] = ('committed', [])
            except BaseException as error:
                outcomes[name] = ('raised', errors(error))

        with f.f.storage(True):
            original = store.load_org(twins.copy)
            record = f.item(original, 'owned-item')
            record['title'] = 'B title'
            if settings:
                original.d['max_children'] = 7
            if changed_roles:
                # Reach every immediate current-role FK, with newly authored
                # identities rather than only the unchanged holder rewrite.
                holder = original._work_holder(agent)
                record['owner'] = holder.copy()
                record['reviewer'] = holder.copy()
                record['holders'][0].update(holder)
                seat = record['review_seats'][0]
                seat.update(reviewer=agent, holder=holder.copy(), recheck_owner=holder.copy())
                record['artifacts'][0]['grants'][0]['to'] = agent

            def agent_save():
                with orgtx.org_tx(twins.copy, nodes=[agent], sections=['work_items'] +
                                  (['max_children'] if settings else []),
                                  lock_timeout=10, retries=0) as tx:
                    tx.d['nodes'][agent]['title'] = 'A agent'
                    next(row for row in tx.d['work_items']
                         if row['slug'] == 'owned-item')['title'] = 'A title'
                    if settings:
                        tx.d['max_children'] = 8

            with patch.object(R, '_docket_write', docket_write), patch.object(registry, 'checkout', checkout), \
                    patch.object(docket_locks, 'lock', role_lock):
                docket = threading.Thread(name='docket-writer', target=observe,
                                          args=('docket', lambda: store.save_org(original)))
                agent_thread = threading.Thread(name='agent-writer', target=observe,
                                                args=('agent', agent_save))
                try:
                    docket.start()
                    self.assertTrue(ready.wait(10), outcomes)
                    agent_thread.start()
                    deadline = time.monotonic() + 7
                    with registry.connection(twins.copy) as monitor:
                        while time.monotonic() < deadline:
                            if 'agent-writer' in pids and 'docket-writer' in pids:
                                row = monitor.execute(
                                    'SELECT pg_blocking_pids(pid),query FROM pg_stat_activity WHERE pid=%s',
                                    (pids['agent-writer'],)).fetchone()
                                if row is not None and pids['docket-writer'] in row[0]:
                                    blocked_queries.append(row[1])
                                    break
                            time.sleep(.01)
                        else:
                            self.fail('agent writer never waited on docket writer: ' + repr((pids, outcomes)))
                finally:
                    release.set()
                    if agent_thread.ident:
                        agent_thread.join(25)
                    docket.join(25)
                self.assertFalse(agent_thread.is_alive() or docket.is_alive(), outcomes)
                self.assertTrue(blocked_queries, outcomes)
                sqlstates = [e[1] for _, caught in outcomes.values() for e in caught]
                self.assertNotIn('40P01', sqlstates, outcomes)
                self.assertEqual(outcomes, {'docket': ('committed', []), 'agent': ('committed', [])})
            reloaded = store.load_org(twins.copy)
            self.assertEqual(f.item(reloaded, 'owned-item')['title'], 'A title')
            self.assertEqual(reloaded.nodes[agent]['title'], 'A agent')
            if settings:
                self.assertEqual(reloaded.d['max_children'], 8)
            if changed_roles:
                saved = f.item(reloaded, 'owned-item')
                for role in ('owner', 'reviewer'):
                    self.assertEqual(saved[role]['node'], agent)
                self.assertEqual(saved['holders'][0]['node'], agent)
                self.assertEqual(saved['review_seats'][0]['recheck_owner']['node'], agent)
                self.assertEqual(saved['artifacts'][0]['grants'][0]['to'], agent)

    def test_title_only_ordinary_save_and_native_agent_docket_transaction_do_not_deadlock(self):
        self.overlap()

    def test_changed_seven_current_roles_and_native_agent_docket_transaction_do_not_deadlock(self):
        self.overlap(changed_roles=True)

    def test_mixed_settings_and_docket_save_keeps_settings_fence_before_agent_tier(self):
        self.overlap(settings=True)

    def test_recorded_plan_without_physical_locks_is_caught_then_restored_passes(self):
        def broken(raw, ids, names, *, updates=(), source='save'):
            docket_locks.install(raw, ids, names, source=source)

        with patch.object(docket_locks, 'lock', broken):
            with self.assertRaises(AssertionError) as caught:
                self.overlap()
        self.assertIn('40P01', str(caught.exception), 'the intended physical-lock fault was not reached')
        self.overlap()

    def test_new_role_outside_item_plan_refuses_every_write_then_widened_retry_commits(self):
        twins = f.f.Twins('docket-role-widen', before=f.prepare_legacy)
        with f.f.storage(True):
            before = f.rows(twins.copy)
            for declared, succeeds in ((['worker'], False), (['worker', 'taken'], True)):
                caught = None
                try:
                    with orgtx.org_tx(twins.copy, nodes=declared,
                                      sections=['work_items']) as tx:
                        tx.d['nodes']['worker']['title'] = 'widened write'
                        record = f.item(tx.org, 'owned-item')
                        record['owner'] = tx.org._work_holder('taken')
                        record['title'] = 'widened item'
                except orgtx.UnlockedWrite as error:
                    caught = error
                if not succeeds:
                    self.assertIsNotNone(caught)
                    self.assertIn(('node', 'taken'), caught.rows)
                    self.assertEqual(f.rows(twins.copy), before)
                else:
                    self.assertIsNone(caught)
            loaded = store.load_org(twins.copy)
            self.assertEqual(loaded.nodes['worker']['title'], 'widened write')
            self.assertEqual(f.item(loaded, 'owned-item')['owner']['node'], 'taken')

    def test_foreign_key_share_locks_do_not_authorize_agent_mutation(self):
        twins = f.f.Twins('docket-role-authority', before=f.prepare_legacy)
        with f.f.storage(True):
            before = f.rows(twins.copy)
            with self.assertRaises(orgtx.UnlockedWrite):
                with orgtx.org_tx(twins.copy, sections=['work_items']) as tx:
                    # worker is physically locked for the existing owner FK,
                    # but the transaction never declared an agent write.
                    tx.d['nodes']['worker']['title'] = 'unauthorized'
                    f.item(tx.org, 'owned-item')['title'] = 'also rolled back'
            self.assertEqual(f.rows(twins.copy), before)

    def test_plan_rolls_back_at_savepoint_and_transaction_and_does_not_survive_reuse(self):
        twins = f.f.Twins('docket-role-rollback', before=f.prepare_legacy)
        with registry.connection(twins.copy) as raw:
            worker, owner = (f.ids(twins.copy)[n] for n in ('worker', 'owner'))
            self.assertIsNone(docket_locks.plan(raw))
            with raw.transaction():
                docket_locks.lock(raw, [worker], ['worker'])
                first = docket_locks.plan(raw)
                with self.assertRaisesRegex(RuntimeError, 'rollback inner'):
                    with raw.transaction():
                        docket_locks.lock(raw, [owner], ['owner'])
                        self.assertEqual(docket_locks.plan(raw)['ids'], [owner])
                        raise RuntimeError('rollback inner')
                self.assertEqual(docket_locks.plan(raw), first)
            self.assertIsNone(docket_locks.plan(raw))
            with self.assertRaisesRegex(RuntimeError, 'rollback outer'):
                with raw.transaction():
                    docket_locks.lock(raw, [owner], ['owner'])
                    raise RuntimeError('rollback outer')
            with raw.transaction():
                self.assertIsNone(docket_locks.plan(raw))

    def test_same_save_hire_and_deleted_role_tombstone_are_written_before_references(self):
        twins = f.f.Twins('docket-new-identity', before=f.prepare_legacy)
        with f.f.storage(True):
            org = store.load_org(twins.copy)
            org.hire(ledger.USER, 'boss', 'haiku', 0, 'new-role')
            record = f.item(org, 'owned-item')
            record['owner'] = org._work_holder('new-role')
            record['reviewer'] = dict(node='missing-role', born='missing-birth', generation=7, deleted=True)
            store.save_org(org)
            with registry.connection(twins.copy) as raw:
                row = raw.execute("SELECT a.name,a.tombstone,b.name,b.tombstone,b.lineage_born,b.generation "
                                  "FROM orgtree.work_items w JOIN orgtree.agents a ON a.id=w.owner_agent_id "
                                  "JOIN orgtree.agents b ON b.id=w.reviewer_agent_id "
                                  "WHERE w.slug='owned-item'").fetchone()
                self.assertEqual(tuple(row), ('new-role', False, 'missing-role', True, 'missing-birth', 7))
            self.assertEqual(f.item(store.load_org(twins.copy), 'owned-item')['reviewer'], record['reviewer'])

    def test_successful_insert_witness_rolls_back_with_the_new_row_and_retry_works(self):
        twins = f.f.Twins('docket-birth-rollback', before=f.prepare_legacy)
        with f.f.storage(True):
            node = copy.deepcopy(store.load_org(twins.copy).nodes['taken'])
        with registry.connection(twins.copy) as raw:
            with raw.transaction():
                ids = f.ids(twins.copy)
                docket_locks.lock(raw, ids.values(), [*ids, 'new-nested'])
                before = docket_locks.plan(raw)
                with self.assertRaisesRegex(RuntimeError, 'rollback birth'):
                    with raw.transaction():
                        R.node_put(raw, 'new-nested', node, R.Names(raw))
                        born = raw.execute("SELECT id FROM orgtree.agents WHERE name='new-nested'").fetchone()[0]
                        self.assertIn(born, docket_locks.plan(raw)['ids'])
                        raise RuntimeError('rollback birth')
                self.assertEqual(docket_locks.plan(raw), before)
                self.assertIsNone(raw.execute("SELECT id FROM orgtree.agents WHERE name='new-nested'").fetchone())
                R.node_put(raw, 'new-nested', node, R.Names(raw))
                retry = raw.execute("SELECT id FROM orgtree.agents WHERE name='new-nested'").fetchone()[0]
                self.assertNotEqual(retry, born)
                self.assertIn(retry, docket_locks.plan(raw)['ids'])
                self.assertNotIn(born, docket_locks.plan(raw)['ids'])
            self.assertIsNone(docket_locks.plan(raw))

    def test_placeholder_hire_and_native_save_settle_without_deadlock(self):
        twins = f.f.Twins('docket-placeholder-upgrade', before=f.prepare_legacy)
        with registry.connection(twins.copy) as raw, raw.transaction():
            R.Names(raw).id('placeholder', mint=True)
        ready, release = threading.Event(), threading.Event()
        outcomes, pids = {}, {}
        real_lock, real_checkout = docket_locks.lock, registry.checkout

        def checkout(*args, **kwargs):
            raw = real_checkout(*args, **kwargs)
            if threading.current_thread().name in ('first-hire', 'second-hire'):
                pids[threading.current_thread().name] = raw.info.backend_pid
            return raw

        def role_lock(*args, **kwargs):
            result = real_lock(*args, **kwargs)
            if threading.current_thread().name == 'first-hire':
                ready.set()
                if not release.wait(12):
                    raise RuntimeError('placeholder scheduling barrier expired')
            return result

        def save(name, org):
            try:
                store.save_org(org)
                outcomes[name] = ('committed', [])
            except BaseException as error:
                outcomes[name] = ('raised', errors(error))

        def native_save():
            try:
                with orgtx.org_tx(twins.copy, nodes=['placeholder'], sections=['work_items'],
                                  lock_timeout=10, retries=0) as tx:
                    tx.d['nodes']['placeholder']['title'] = 'second'
                    f.item(tx.org, 'owned-item')['title'] = 'second item'
                outcomes['second'] = ('committed', [])
            except BaseException as error:
                outcomes['second'] = ('raised', errors(error))

        with f.f.storage(True):
            first = store.load_org(twins.copy)
            first.hire(ledger.USER, None, 'haiku', 0, 'placeholder')
            first.nodes['placeholder']['title'] = 'first'
            f.item(first, 'owned-item')['owner'] = first._work_holder('placeholder')
            with patch.object(docket_locks, 'lock', role_lock), patch.object(registry, 'checkout', checkout):
                a = threading.Thread(name='first-hire', target=save, args=('first', first))
                b = threading.Thread(name='second-hire', target=native_save)
                try:
                    a.start()
                    self.assertTrue(ready.wait(10), outcomes)
                    b.start()
                    deadline = time.monotonic() + 7
                    with registry.connection(twins.copy) as monitor:
                        while time.monotonic() < deadline:
                            if 'second-hire' in pids and 'first-hire' in pids:
                                row = monitor.execute('SELECT pg_blocking_pids(%s)', (pids['second-hire'],)).fetchone()
                                if pids['first-hire'] in row[0]:
                                    break
                            time.sleep(.01)
                        else:
                            self.fail('second hire never waited on the first')
                finally:
                    release.set()
                    if b.ident:
                        b.join(25)
                    a.join(25)
                self.assertFalse(a.is_alive() or b.is_alive(), outcomes)
                self.assertNotIn('40P01', [e[1] for _, caught in outcomes.values() for e in caught], outcomes)
                self.assertEqual(outcomes, {'first': ('committed', []), 'second': ('committed', [])})
            self.assertEqual(store.load_org(twins.copy).nodes['placeholder']['title'], 'second')

    def test_placeholder_update_modes_are_held_before_node_write(self):
        import psycopg
        for native in (False, True):
            with self.subTest(native=native):
                twins = f.f.Twins('docket-placeholder-mode', before=f.prepare_legacy)
                with registry.connection(twins.copy) as raw, raw.transaction():
                    aid = R.Names(raw).id('placeholder', mint=True)
                real_lock = docket_locks.lock
                reached = []

                def probe_mode():
                    # SHARE can share another SHARE lock but not UPDATE.
                    # Probe the actual row before node_put can upgrade it.
                    with self.assertRaises(psycopg.errors.LockNotAvailable):
                        with registry.connection(twins.copy) as probe, probe.transaction():
                            probe.execute('SELECT id FROM orgtree.agents WHERE id=%s FOR SHARE NOWAIT', (aid,))
                    reached.append(aid)

                def check_mode(*args, **kwargs):
                    result = real_lock(*args, **kwargs)
                    probe_mode()
                    return result

                with f.f.storage(True):
                    if native:
                        with orgtx.org_tx(twins.copy, nodes=['placeholder'],
                                          sections=['work_items', ('notices', 'boss')],
                                          logs=['events', 'notice_log']) as tx:
                            probe_mode()
                            tx.org.hire(ledger.USER, None, 'haiku', 0, 'placeholder')
                            f.item(tx.org, 'owned-item')['owner'] = tx.org._work_holder('placeholder')
                    else:
                        org = store.load_org(twins.copy)
                        org.hire(ledger.USER, None, 'haiku', 0, 'placeholder')
                        f.item(org, 'owned-item')['owner'] = org._work_holder('placeholder')
                        with patch.object(docket_locks, 'lock', check_mode):
                            store.save_org(org)
                    self.assertEqual(reached, [aid])
                    self.assertEqual(f.item(store.load_org(twins.copy), 'owned-item')['owner']['node'], 'placeholder')

    def test_whole_org_plan_includes_retained_current_roles_and_all_live_nodes(self):
        twins = f.f.Twins('docket-whole-roles', before=f.prepare_legacy)
        with f.f.storage(True):
            org = store.load_org(twins.copy)
            f.item(org, 'owned-item')['reviewer'] = dict(node='gone', deleted=True, born='old')
            store.save_org(org)
            with orgtx.org_tx(twins.copy, whole=True) as tx:
                raw = store._orgtx_local.pinned[twins.copy].raw
                # The pinned save connection holds both live and tombstone FK
                # targets before the item rows; authorization remains name based.
                held = docket_locks.plan(raw)
                linked = docket_locks.linked(raw, 'true', ())
                self.assertTrue(linked <= set(held['ids']))
                f.item(tx.org, 'owned-item')['title'] = 'whole role write'
            self.assertEqual(f.item(store.load_org(twins.copy), 'owned-item')['title'], 'whole role write')

    def test_compat_item_archive_append_replace_and_whole_list_use_early_plan(self):
        twins = f.f.Twins('docket-compat-entry', before=f.prepare_legacy)
        with f.f.storage(True):
            record = copy.deepcopy(f.item(store.load_org(twins.copy), 'owned-item'))
        real_write = R._docket_write
        reached = []

        def checked(raw, record, keys, previous):
            held = docket_locks.plan(raw)
            self.assertIsNotNone(held)
            prior = docket_locks.linked(raw, 'w.slug=%s', (record['slug'],))
            self.assertTrue(prior <= set(held['ids']))
            reached.append(record['title'])
            return real_write(raw, record, keys, previous)

        with registry.connection(twins.copy) as raw, patch.object(R, '_docket_write', checked):
            with raw.transaction():
                record['title'] = 'direct item'
                tx = R.Tx()
                R.item_put(raw, tx, record['slug'], record)
                R.docket_finish(raw, tx)
            with raw.transaction():
                tx = R.Tx()
                R.docket_prepare_doc(raw, 'work_items\x1f' + record['slug'])
                R.doc_delete(raw, 'work_items\x1f' + record['slug'], R.Names(raw), tx=tx)
                record['title'] = 'archive append'
                seq = R.log_insert(raw, R.model().logs['work_items_archive'], None,
                                   json.dumps(record), R.Names(raw), tx=tx)
                R.docket_finish(raw, tx)
            with raw.transaction():
                tx = R.Tx()
                record['title'] = 'archive replace'
                self.assertEqual(R.log_replace(raw, R.model().logs['work_items_archive'],
                                               R.by_seq(R.model().logs['work_items_archive'].log, seq)[1], json.dumps(record),
                                               expected=None, tx=tx), 1)
                R.docket_finish(raw, tx)
            with raw.transaction():
                record['title'] = 'whole archive'
                R._docket_section_put(raw, 'work_items_archive', [record], None)
        self.assertEqual(reached, ['direct item', 'archive append', 'archive replace', 'whole archive'])

    def test_ordinary_active_deletes_and_whole_archive_clear_preserve_save_behavior(self):
        for archive in (False, True):
            with self.subTest(archive=archive):
                twins = f.f.Twins('docket-delete-plan', before=f.prepare_legacy)
                with f.f.storage(True):
                    org = store.load_org(twins.copy)
                    if archive:
                        f.item(org, 'owned-item')['status'] = 'done'
                        org.work_archive_now(ledger.USER, 'owned-item')
                        store.save_org(org)
                        org = store.load_org(twins.copy)
                    key = 'work_items_archive' if archive else 'work_items'
                    org.d[key].clear()
                    store.save_org(org)
                    self.assertEqual(store.load_org(twins.copy).d[key], [])


if __name__ == '__main__':
    unittest.main()
