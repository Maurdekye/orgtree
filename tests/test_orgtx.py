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
        with orgtx.org_tx(self.slug, nodes=['b', 'a'], sections=['killswitch'],
                          share_sections=['settings_x']) as tx:
            self.assertIs(orgtx.current_tx(self.slug), tx)
            plan = orgtx._lock_plan(tx)
        self.assertIsNone(orgtx.current_tx(self.slug))
        self.assertEqual([(k, n) for k, n, _ in plan],
                         [('node', '*'), ('node', 'a'), ('node', 'b'),
                          ('section', 'killswitch'), ('section', 'settings_x')])
        self.assertEqual([x for _, _, x in plan], [False, True, True, True, False])

    def test_save_hooks_fire_after_commit_outside_locks(self) -> None:
        seen: list[str] = []

        def hook(slug: str) -> None:
            if slug != self.slug:
                return
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
        self.assertEqual(seen, ['got'])

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


if __name__ == '__main__':
    unittest.main()
