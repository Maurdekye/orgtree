"""PG-0: the org_tx / org_read interface and its in-process fake (orgtx.py).

What these prove, on the SeamBackend fake over a throwaway SQLite root:
  * named rows commit; the revision bumps by one; listeners hear it;
  * a write to an unnamed node, section or log is refused and NOTHING lands;
  * a body exception rolls back;
  * FOR UPDATE blocks a second writer of the same row, and not a writer of
    another row; FOR SHARE admits sharers together but blocks a writer;
  * a lock-order cycle is detected (DeadlockDetected) and org_tx_call
    re-runs the body;
  * op_key: a replay returns the stored result and writes nothing twice;
    another fingerprint is refused;
  * nesting on one org is refused; the pause hooks need the env switch;
  * org_read's changes are never saved.

Run:  python tools/run-python-verification.py tests/test_orgtx.py
"""

import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-orgtx-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402

# These suites prove ROW-lock behaviour, which the transition fence (every
# org_tx behind DOC_LOCK, plan decision 19) would serialize away; the fence
# has its own tests, which turn it back on.
orgtx.TRANSITION_FENCE = False


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    nodes = org.d['nodes']
    for nid in ('a', 'b', 'c'):
        nodes[nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    org.d['killswitch'] = {'on': False}
    org.d['settings_x'] = {'v': 0}
    store.save_org(org)
    # a load normalizes raw fixture rows (node defaults, `_migrations`); save
    # once more so the stored org is at the fixed point real data sits at
    store.save_org(store.load_org(slug))
    return slug


def _node(slug: str, nid: str) -> dict:
    return store.load_org(slug).d['nodes'][nid]


class OrgTxBasics(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'tx-{self._testMethodName}')

    def test_named_rows_commit_and_revision_bumps(self) -> None:
        heard: list[orgtx.Committed] = []
        orgtx.commit_listeners.append(heard.append)
        try:
            with orgtx.org_tx(self.slug, nodes=['a'], sections=['killswitch']) as tx:
                tx.d['nodes']['a']['name'] = 'A'
                tx.d['killswitch']['on'] = True
            r1 = tx.revision
            with orgtx.org_tx(self.slug, nodes=['b']) as tx2:
                tx2.d['nodes']['b']['name'] = 'B'
        finally:
            orgtx.commit_listeners.remove(heard.append)
        self.assertEqual(_node(self.slug, 'a')['name'], 'A')
        self.assertEqual(_node(self.slug, 'b')['name'], 'B')
        self.assertTrue(store.load_org(self.slug).d['killswitch']['on'])
        self.assertEqual(tx2.revision, r1 + 1)
        self.assertEqual([c.revision for c in heard], [r1, r1 + 1])
        self.assertIn('a', heard[0].changes.node_updates)

    def test_unlocked_node_write_refused_and_nothing_lands(self) -> None:
        with self.assertRaises(orgtx.UnlockedWrite) as cm:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'A'
                tx.d['nodes']['b']['name'] = 'B'
        self.assertIn("node 'b'", str(cm.exception))
        self.assertEqual(_node(self.slug, 'a')['name'], 'a')
        self.assertEqual(_node(self.slug, 'b')['name'], 'b')

    def test_share_locked_row_is_not_writable(self) -> None:
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, share_sections=['killswitch']) as tx:
                tx.d['killswitch']['on'] = True
        self.assertFalse(store.load_org(self.slug).d['killswitch']['on'])

    def test_unnamed_section_and_log_refused(self) -> None:
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['settings_x']['v'] = 1
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.append('events', {'kind': 'x'})
        with orgtx.org_tx(self.slug, logs=['events']) as tx:
            tx.append('events', {'kind': 'ok'})
        kinds = [e.get('kind') for e in store.load_org(self.slug).d['events']]
        self.assertEqual(kinds.count('ok'), 1)
        self.assertNotIn('x', kinds)
        self.assertEqual(store.load_org(self.slug).d['settings_x']['v'], 0)

    def test_body_exception_rolls_back(self) -> None:
        with self.assertRaises(KeyError):
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'A'
                raise KeyError('boom')
        self.assertEqual(_node(self.slug, 'a')['name'], 'a')

    def test_argument_validation(self) -> None:
        with self.assertRaises(ValueError):
            with orgtx.org_tx(self.slug, sections=['events']):
                pass
        with self.assertRaises(TypeError):
            with orgtx.org_tx(self.slug, nodes='a'):
                pass
        with self.assertRaises(ValueError):
            with orgtx.org_tx(self.slug, logs=[('events', 'x')]):
                pass

    def test_nested_same_org_refused(self) -> None:
        with orgtx.org_tx(self.slug, nodes=['a']):
            with self.assertRaises(orgtx.NestedTx):
                with orgtx.org_tx(self.slug, nodes=['b']):
                    pass

    def test_receipt_replay_and_conflict(self) -> None:
        with orgtx.org_tx(self.slug, nodes=['a'], op_key='k1', fingerprint='f') as tx:
            self.assertFalse(tx.replayed)
            tx.d['nodes']['a']['n'] = tx.d['nodes']['a'].get('n', 0) + 1
            tx.result = {'n': 1}
        rev = tx.revision
        with orgtx.org_tx(self.slug, nodes=['a'], op_key='k1', fingerprint='f') as tx:
            self.assertTrue(tx.replayed)
            self.assertEqual(tx.result, {'n': 1})
            tx.d['nodes']['a']['n'] = 99          # discarded: never written twice
        self.assertEqual(_node(self.slug, 'a')['n'], 1)
        self.assertEqual(tx.revision, rev)
        with self.assertRaises(orgtx.ReceiptConflict):
            with orgtx.org_tx(self.slug, nodes=['a'], op_key='k1', fingerprint='g'):
                pass
        calls = []
        out = orgtx.org_tx_call(self.slug, lambda t: calls.append(1) or 'x',
                                nodes=['a'], op_key='k1', fingerprint='f')
        self.assertEqual((out, calls), ({'n': 1}, []))

    def test_legacy_save_cannot_overwrite_an_org_tx_commit(self) -> None:
        legacy = store.load_org(self.slug)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['name'] = 'from-tx'
        legacy.d['nodes']['a']['name'] = 'from-legacy'
        legacy.d['nodes']['b']['name'] = 'also-legacy'
        with self.assertRaises(store.StaleWrite):
            store.save_org(legacy)
        self.assertEqual(_node(self.slug, 'a')['name'], 'from-tx')
        self.assertEqual(_node(self.slug, 'b')['name'], 'b')

    def test_load_heal_is_committed_before_the_locks(self) -> None:
        # an org stored WITHOUT the ledger's `_migrations` marker: its next
        # load heals it (setdefault), a write the tx did not name
        org = store.load_org(self.slug)
        self.assertIsNotNone(dict.pop(org.d, '_migrations', None))
        store.save_org(org)                    # the differ deletes the row
        orgtx.use_backend(orgtx.SeamBackend())          # nothing healed yet
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['name'] = 'healed-then-written'
        self.assertEqual(_node(self.slug, 'a')['name'], 'healed-then-written')

    def test_unlocked_write_names_rows_structured(self) -> None:
        with self.assertRaises(orgtx.UnlockedWrite) as cm:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['b']['name'] = 'B'
                tx.d['settings_x']['v'] = 9
        self.assertEqual(set(cm.exception.rows), {('node', 'b'), ('section', 'settings_x')})

    def test_current_tx_and_lock_plan_order(self) -> None:
        self.assertIsNone(orgtx.current_tx(self.slug))
        self.assertFalse(orgtx.open_on(self.slug))
        with orgtx.org_tx(self.slug, nodes=['b', 'a'], sections=['killswitch'],
                          share_sections=['settings_x']) as tx:
            self.assertIs(orgtx.current_tx(self.slug), tx)
            self.assertTrue(orgtx.open_on(self.slug))
            plan = orgtx._lock_plan(tx)
        self.assertIsNone(orgtx.current_tx(self.slug))
        self.assertEqual([(k, n) for k, n, _ in plan],
                         [('node', '*'), ('node', 'a'), ('node', 'b'),
                          ('section', 'killswitch'), ('section', 'settings_x')])
        self.assertEqual([x for _, _, x in plan], [False, True, True, True, False])

    def test_save_hooks_fire_after_commit_outside_locks(self) -> None:
        seen: list[str] = []
        with orgtx.org_tx(self.slug, nodes=['a']):
            pass                                # heal first (its save fires hooks)

        def hook(slug: str) -> None:
            if slug != self.slug or seen:
                return
            seen.append('fired')
            out: list[str] = []

            def other() -> None:
                try:
                    with orgtx.org_tx(slug, nodes=['a'], lock_timeout=0.3):
                        out.append('got')
                except orgtx.LockTimeout:
                    out.append('blocked')
            t = threading.Thread(target=other)
            t.start()
            t.join(5)
            seen.extend(out)
        store.save_hooks.append(hook)
        try:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'H'
        finally:
            store.save_hooks.remove(hook)
        self.assertEqual(seen, ['fired', 'got'])

    def test_org_read_never_saves(self) -> None:
        org = orgtx.org_read(self.slug, sections=['events'])
        org.d['nodes']['a']['name'] = 'Z'
        self.assertEqual(_node(self.slug, 'a')['name'], 'a')

    def test_pause_hook_needs_env(self) -> None:
        with self.assertRaises(RuntimeError):
            orgtx.set_pause_hook(lambda p, t: None)
        os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
        seen: list[str] = []
        try:
            orgtx.set_pause_hook(lambda p, t: seen.append(p))
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'A'
        finally:
            orgtx.set_pause_hook(None)
            os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS')
        self.assertEqual(seen, list(orgtx.PAUSE_POINTS))


class OrgTxConcurrency(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'cc-{self._testMethodName}')

    def _hold(self, entered: threading.Event, release: threading.Event, **names) -> threading.Thread:
        def run() -> None:
            with orgtx.org_tx(self.slug, **names):
                entered.set()
                release.wait(5)
        t = threading.Thread(target=run)
        t.start()
        self.assertTrue(entered.wait(5))
        return t

    def _try(self, timeout: float, **names) -> str:
        try:
            with orgtx.org_tx(self.slug, lock_timeout=timeout, **names):
                return 'got'
        except orgtx.LockTimeout:
            return 'blocked'

    def test_update_blocks_same_row_not_other_rows(self) -> None:
        entered, release = threading.Event(), threading.Event()
        t = self._hold(entered, release, nodes=['a'])
        try:
            self.assertEqual(self._try(0.2, nodes=['a']), 'blocked')
            self.assertEqual(self._try(0.2, share_nodes=['a']), 'blocked')
            self.assertEqual(self._try(0.2, nodes=['b']), 'got')
        finally:
            release.set()
            t.join()
        self.assertEqual(self._try(0.2, nodes=['a']), 'got')

    def test_share_admits_sharers_blocks_writer(self) -> None:
        entered, release = threading.Event(), threading.Event()
        t = self._hold(entered, release, share_sections=['killswitch'])
        try:
            self.assertEqual(self._try(0.2, share_sections=['killswitch']), 'got')
            self.assertEqual(self._try(0.2, sections=['killswitch']), 'blocked')
        finally:
            release.set()
            t.join()

    def test_all_nodes_excludes_named_node_writers_and_creators(self) -> None:
        entered, release = threading.Event(), threading.Event()
        t = self._hold(entered, release, nodes=orgtx.ALL)
        try:
            self.assertEqual(self._try(0.2, nodes=['b']), 'blocked')
            self.assertEqual(self._try(0.2, nodes=['brand-new']), 'blocked')
            self.assertEqual(self._try(0.2, sections=['killswitch']), 'got')
        finally:
            release.set()
            t.join()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
            for n in tx.d['nodes'].values():
                n['swept'] = True
        self.assertTrue(all(_node(self.slug, x).get('swept') for x in ('a', 'b', 'c')))

    def test_multi_org_locks_and_commits_both(self) -> None:
        other = _fresh_org(f'cc2-{self._testMethodName}')
        entered, release = threading.Event(), threading.Event()
        done: list[str] = []

        def run() -> None:
            with orgtx.org_tx_multi({self.slug: dict(nodes=['a']),
                                     other: dict(nodes=['b'])}) as t:
                entered.set()
                release.wait(5)
                t[self.slug].d['nodes']['a']['name'] = 'mA'
                t[other].d['nodes']['b']['name'] = 'mB'
            done.append('ok')
        th = threading.Thread(target=run)
        th.start()
        self.assertTrue(entered.wait(5))
        try:
            with self.assertRaises(orgtx.LockTimeout):
                with orgtx.org_tx(other, nodes=['b'], lock_timeout=0.2):
                    pass
            self.assertEqual(self._try(0.2, nodes=['c']), 'got')
        finally:
            release.set()
            th.join(10)
        self.assertEqual(done, ['ok'])
        self.assertEqual(_node(self.slug, 'a')['name'], 'mA')
        self.assertEqual(_node(other, 'b')['name'], 'mB')
        with orgtx.org_tx_multi({self.slug: dict(nodes=['a']), other: dict()}):
            with self.assertRaises(orgtx.NestedTx):
                with orgtx.org_tx(other, nodes=['c']):
                    pass

    def test_waiting_probe(self) -> None:
        locks = orgtx.RowLocks()
        o1, o2 = object(), object()
        k = ('s', 'node', 'a')
        locks.acquire(o1, k, True, 1)
        t = threading.Thread(target=lambda: locks.acquire(o2, k, True, 5))
        t.start()
        for _ in range(100):
            if locks.waiting(o2):
                break
            time.sleep(0.01)
        self.assertEqual(locks.waiting(o2), frozenset({o1}))
        locks.release_all(o1)
        t.join(5)
        self.assertEqual(locks.waiting(o2), frozenset())

    def test_deadlock_detected_and_call_retries(self) -> None:
        locks = orgtx.RowLocks()
        o1, o2 = object(), object()
        k1, k2 = ('s', 'node', 'a'), ('s', 'node', 'b')
        locks.acquire(o1, k1, True, 1)
        locks.acquire(o2, k2, True, 1)
        waiting = threading.Event()
        err: list[BaseException] = []

        def first() -> None:
            waiting.set()
            try:
                locks.acquire(o1, k2, True, 5)
            except BaseException as e:          # noqa: BLE001
                err.append(e)
        t = threading.Thread(target=first)
        t.start()
        waiting.wait(5)
        time.sleep(0.1)
        with self.assertRaises(orgtx.DeadlockDetected):
            locks.acquire(o2, k1, True, 5)
        locks.release_all(o2)
        t.join(5)
        self.assertEqual(err, [])
        self.assertEqual(locks.holders(k2)[0], o1)

        # org_tx_call re-runs a body that fails retryably after the body ran
        runs: list[int] = []

        def body(tx: orgtx.OrgTx) -> str:
            runs.append(1)
            if len(runs) == 1:
                raise orgtx.SerializationFailure('first attempt')
            tx.d['nodes']['c']['name'] = 'C'
            return 'ok'
        self.assertEqual(orgtx.org_tx_call(self.slug, body, nodes=['c']), 'ok')
        self.assertEqual(len(runs), 2)
        self.assertEqual(_node(self.slug, 'c')['name'], 'C')

    def test_racing_increments_are_not_lost(self) -> None:
        def bump() -> None:
            for _ in range(5):
                with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                    n = tx.d['nodes']['a']
                    n['n'] = n.get('n', 0) + 1
        ts = [threading.Thread(target=bump) for _ in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(60)
        self.assertEqual(_node(self.slug, 'a')['n'], 20)


class TransitionFence(unittest.TestCase):
    # plan decision 19: (a) an unconverted DOC_LOCK load->save cycle racing an
    # org_tx on the same row loses nothing with the fence ON, and loses the
    # update (or raises StaleWrite) with it OFF; (b) a DOC_LOCK holder may
    # call org_tx (re-entry, no deadlock)

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'fence-{self._testMethodName}'[:60])
        with orgtx.org_tx(self.slug, nodes=['a']):
            pass                                  # heal before racing

    def tearDown(self) -> None:
        orgtx.TRANSITION_FENCE = False

    def _race(self, fence: bool) -> tuple:
        orgtx.TRANSITION_FENCE = fence
        loaded, go = threading.Event(), threading.Event()
        stale: list = []

        def legacy() -> None:
            try:
                with store.DOC_LOCK:
                    org = store.load_org(self.slug)
                    node = org.d['nodes']['a']            # the baseline is read
                    loaded.set()
                    go.wait(10)
                    node['legacy'] = 1
                    store.save_org(org)
            except store.StaleWrite as e:
                stale.append(e)

        def converted() -> None:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['tx'] = 1
        lt = threading.Thread(target=legacy)
        lt.start()
        self.assertTrue(loaded.wait(10))
        ct = threading.Thread(target=converted)
        ct.start()
        ct.join(1.0)
        tx_done_early = not ct.is_alive()
        go.set()
        lt.join(10)
        ct.join(10)
        node = _node(self.slug, 'a')
        return tx_done_early, node.get('legacy'), node.get('tx'), bool(stale)

    def test_a_fence_on_loses_nothing(self) -> None:
        early, legacy, tx, stale = self._race(True)
        self.assertFalse(early, 'the org_tx must wait for the DOC_LOCK holder')
        self.assertEqual((legacy, tx, stale), (1, 1, False))

    def test_a_fence_off_loses_the_update_or_refuses(self) -> None:
        early, legacy, tx, stale = self._race(False)
        self.assertTrue(early, 'without the fence the org_tx does not wait')
        self.assertFalse(legacy == 1 and tx == 1, 'both writes survived: no race was exercised')
        self.assertTrue(stale or legacy is None or tx is None)

    def test_a2_org_tx_holds_the_fence_until_commit(self) -> None:
        orgtx.TRANSITION_FENCE = True
        inside, release = threading.Event(), threading.Event()
        got_lock = threading.Event()

        def converted() -> None:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                inside.set()
                release.wait(10)
                tx.d['nodes']['a']['tx2'] = 1

        def legacy() -> None:
            with store.DOC_LOCK:
                got_lock.set()
        ct = threading.Thread(target=converted)
        ct.start()
        self.assertTrue(inside.wait(10))
        lt = threading.Thread(target=legacy)
        lt.start()
        self.assertFalse(got_lock.wait(0.5), 'a DOC_LOCK cycle ran inside an open org_tx')
        release.set()
        ct.join(10)
        lt.join(10)
        self.assertTrue(got_lock.is_set())
        self.assertEqual(_node(self.slug, 'a').get('tx2'), 1)

    def test_b_doc_lock_holder_reenters(self) -> None:
        orgtx.TRANSITION_FENCE = True
        done: list = []

        def run() -> None:
            with store.DOC_LOCK:
                with orgtx.org_tx(self.slug, nodes=['b']) as tx:
                    tx.d['nodes']['b']['name'] = 'reentered'
                done.append(1)
        t = threading.Thread(target=run)
        t.start()
        t.join(10)
        self.assertFalse(t.is_alive(), 'deadlocked')
        self.assertEqual(done, [1])
        self.assertEqual(_node(self.slug, 'b')['name'], 'reentered')


class PG0bFake(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'pg0b-{self._testMethodName}'[:60])

    def tearDown(self) -> None:
        orgtx.TRANSITION_FENCE = False
        os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

    def _unheal(self) -> None:
        org = store.load_org(self.slug)
        self.assertIsNotNone(dict.pop(org.d, '_migrations', None))
        store.save_org(org)

    def test_heal_recurs_and_bypasses_the_public_save(self) -> None:
        from unittest.mock import patch
        for _ in range(2):                         # not once per process
            self._unheal()
            calls: list = []
            real = store.save_org
            with patch.object(store, 'save_org', lambda o: (calls.append(1), real(o))[1]):
                with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                    tx.d['nodes']['a']['name'] = 'after-heal'
            self.assertEqual(len(calls), 1, 'only the commit goes through store.save_org')
            self.assertIn('_migrations', store.load_org(self.slug).d)

    def test_killswitch_row_always_present(self) -> None:
        org = store.load_org(self.slug)
        dict.pop(org.d, 'killswitch', None)        # an org that never had one
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['name'] = 'x'
        d = store.load_org(self.slug).d
        self.assertIn('killswitch', d)
        self.assertIsNone(d['killswitch'])
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d['killswitch'] = {'on': True, 'by': 'USER'}
        with orgtx.org_tx(self.slug, sections=['killswitch']) as tx:
            tx.d.pop('killswitch')                 # a release that pops
        d = store.load_org(self.slug).d
        self.assertIn('killswitch', d)
        self.assertIsNone(d['killswitch'], 'a popped latch is cleared, never left latched')

    def test_absent_section_share_lock_blocks_the_writer(self) -> None:
        entered, release = threading.Event(), threading.Event()

        def hold() -> None:
            with orgtx.org_tx(self.slug, share_sections=['never-written']):
                entered.set()
                release.wait(5)
        t = threading.Thread(target=hold)
        t.start()
        self.assertTrue(entered.wait(5))
        try:
            with self.assertRaises(orgtx.LockTimeout):
                with orgtx.org_tx(self.slug, sections=['never-written'], lock_timeout=0.2):
                    pass
        finally:
            release.set()
            t.join()

    def test_mixed_replay_is_refused(self) -> None:
        other = _fresh_org(f'pg0b-other-{self._testMethodName}'[:60])
        with orgtx.org_tx(self.slug, nodes=['a'], op_key='k1', fingerprint='f'):
            pass
        with self.assertRaises(orgtx.MixedReplay):
            with orgtx.org_tx_multi({self.slug: dict(nodes=['a'], op_key='k1', fingerprint='f'),
                                     other: dict(nodes=['b'], op_key='k2', fingerprint='f')}) as t:
                t[other].d['nodes']['b']['name'] = 'must-not-vanish-silently'
        self.assertEqual(_node(other, 'b')['name'], 'b')

    def test_doc_lock_after_row_locks_trips_with_hooks(self) -> None:
        os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
        orgtx.TRANSITION_FENCE = False
        with self.assertRaises(AssertionError):
            with orgtx.org_tx(self.slug, nodes=['a']):
                with store.DOC_LOCK:
                    pass
        orgtx.TRANSITION_FENCE = True               # fenced: re-entrant, fine
        with orgtx.org_tx(self.slug, nodes=['a']):
            with store.DOC_LOCK:
                pass


if __name__ == '__main__':
    unittest.main()
