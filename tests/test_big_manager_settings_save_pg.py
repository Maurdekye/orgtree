"""Saving a big manager's settings does not lock the org's other agents.

Docket 3-2-0-saving-a-big-manager-s-settings-must-not-l. The live org
jammed for ~9 minutes (2026-10-03 11:10-11:19Z) while the user saved
coordinator-opus's settings: a manager with ~1225 archived descendants.
Other agents' transactions failed with `lock timeout` on `node:*` (shared)
and on their own node rows. A capability save (folders, tools, MCP,
visibility, permission mode) locked the manager's WHOLE subtree, archived
nodes and lineage stacks included, FOR UPDATE, and re-clamped every one of
them while holding the locks.

These pin, on actual PostgreSQL (disposable, via test_pgstore):
  * a capability save on a manager with 1225 archived and 12 live
    descendants locks only the rows it changes, never an archived node, and
    finishes under 1 s;
  * an unrelated agent's transaction during that save (a live descendant
    the change does not affect) is not delayed past 100 ms and never times
    out;
  * a revoke still clamps every LIVE descendant that held the revoked
    grant (locking exactly those), and leaves archived ones alone;
  * a folder revoke (`revoke_dir`) plans and rewrites only the LIVE
    holders of the folder;
  * a rehire of an archived descendant gets the manager's CURRENT scope.

Run:  python tools/run-python-verification.py tests/test_big_manager_settings_save_pg.py
"""
import copy
import os
import threading
import time
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
from orgtree import lifecycle_door, lifecycle_tx, orgtx, store
from orgtree.ledger import USER

ARCHIVED = 1225
TOOLS = {"bash": True, "web": True, "edit": True, "subagents": True}


def tearDownModule():
    f.tearDownModule()


def _tools(*mcp):
    return dict(TOOLS, mcp=list(mcp))


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class BigManagerSave(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass

    def setUp(self):
        # test_pgstore pops the switch at import; the pause hook needs it
        hooks = patch.dict(os.environ, {'ORGTREE_ORGTX_TEST_HOOKS': '1'})
        hooks.start()
        self.addCleanup(hooks.stop)
        lazy.LazyRows.setUp(self)
        o = store.load_org(self.slug)
        o.d['nodes'].clear()
        o.d['default_tools'] = _tools('*')
        store.save_org(o)
        o = store.load_org(self.slug)
        o.hire(USER, None, 'haiku', 40, 'boss', charter='manager',
               tools=_tools('alpha', 'beta'))
        # 12 live descendants: two managers with five leaves each. Only the
        # `*-b` leaves (and their managers) hold `beta`.
        self.live = []
        for m in ('m1', 'm2'):
            o.hire(USER, 'boss', 'haiku', 12, m, charter='mid',
                   tools=_tools('alpha', 'beta'))
            self.live.append(m)
            for i in range(5):
                k = f'{m}-{"b" if i == 0 else "a"}{i}'
                o.hire(USER, m, 'haiku', 0, k, charter='leaf',
                       tools=_tools('alpha', 'beta') if i == 0 else _tools('alpha'))
                self.live.append(k)
        o.hire(USER, None, 'haiku', 0, 'other', charter='unrelated',
               tools=_tools('alpha'))
        template = copy.deepcopy(o.d['nodes']['m1-b0'])
        store.save_org(o)
        # the archived history: copies of a retired leaf holding `beta`,
        # under boss and under its managers
        o = store.load_org(self.slug)
        parents = ['boss', 'm1', 'm2']
        for i in range(ARCHIVED):
            n = copy.deepcopy(template)
            n.update(parent=parents[i % 3], state='archived',
                     archived_at=1.0, title=f'old{i}', session_id=None)
            o.d['nodes'][f'old{i}'] = n
        store.save_org(o)
        lazy.LazyRows.stamp(self)

    raw = lazy.LazyRows.raw
    epoch = lazy.LazyRows.epoch

    def stamp(self):
        # LazyRows.stamp locks 'n0', which this org does not have
        with orgtx.org_tx(self.slug, nodes=['other']):
            pass

    # -- helpers ----------------------------------------------------------
    def save(self, **kw):
        """The ⚙ route's transaction; returns (result, seconds, the save
        transaction's locked node rows, seconds it held its locks)."""
        seen = {}
        me = threading.get_ident()

        def hook(point, tx):
            if threading.get_ident() != me:
                return
            if point == 'after_lock':
                seen['locked_at'] = time.perf_counter()
                seen['nodes'] = set(tx.lock_nodes)
            elif point == 'after_commit':
                seen['held'] = time.perf_counter() - seen['locked_at']
        orgtx.set_pause_hook(hook)
        try:
            t0 = time.perf_counter()
            res, _, _ = lifecycle_tx.set_scope_observed(self.slug, USER, 'boss', kw)
            took = time.perf_counter() - t0
        finally:
            orgtx.set_pause_hook(None)
        return res, took, seen.get('nodes', set()), seen.get('held', 0.0)

    def scope(self, nid):
        return store.load_org(self.slug).node(nid)['scope']

    # -- tests ------------------------------------------------------------
    def test_measure_and_lock_set_of_a_big_manager_save(self):
        res, took, nodes, held = self.save(tools=_tools('alpha', 'beta', 'gamma'))
        print(f"\n[measure] grant-only save: {took * 1000:.0f} ms total, locks held "
              f"{held * 1000:.0f} ms, {len(nodes)} node rows locked "
              f"({sum(1 for n in nodes if n.startswith('old'))} archived)")
        self.assertFalse([n for n in nodes if n.startswith('old')],
                         'an archived descendant was locked')
        self.assertLess(took, 1.0)

    def test_revoke_clamps_live_holders_only(self):
        res, took, nodes, held = self.save(tools=_tools('alpha'))
        print(f"\n[measure] revoke save: {took * 1000:.0f} ms total, locks held "
              f"{held * 1000:.0f} ms, {len(nodes)} node rows locked "
              f"({sum(1 for n in nodes if n.startswith('old'))} archived)")
        o = store.load_org(self.slug)
        for k in self.live:
            self.assertNotIn('beta', o.node(k)['scope']['tools']['mcp'], k)
        self.assertIn('beta', o.node('old0')['scope']['tools']['mcp'])
        self.assertFalse([n for n in nodes if n.startswith('old')],
                         'an archived descendant was locked')
        # exactly the agents whose scope changed, plus the saved one
        self.assertEqual(nodes, {'boss', 'm1', 'm2', 'm1-b0', 'm2-b0'})
        self.assertLess(took, 1.0)

    def test_unrelated_agent_is_not_delayed_during_the_save(self):
        # a live descendant the change does not affect, and an agent outside
        # the subtree, each run one transaction while the save holds its
        # locks (held 150 ms here). Their LOCK wait is what is measured: a
        # 100 ms lock_timeout turns any wait past 100 ms into a lock timeout
        # (the wall-clock time also counts thread scheduling, so it is only
        # printed)
        waits = {}
        errors = []
        gate = threading.Event()
        me = threading.get_ident()

        def other(nid):
            gate.wait(10)
            t0 = time.perf_counter()
            try:
                with orgtx.org_tx(self.slug, nodes=[nid], lock_timeout=0.1):
                    waits[nid] = time.perf_counter() - t0
            except Exception as e:                       # noqa: BLE001
                errors.append(f'{nid}: {type(e).__name__}: {e}')

        def hook(point, tx):
            if threading.get_ident() == me and point == 'after_lock':
                gate.set()
                time.sleep(0.15)        # hold our locks while the others run
        threads = [threading.Thread(target=other, args=(n,))
                   for n in ('m1-a1', 'other')]
        for t in threads:
            t.start()
        orgtx.set_pause_hook(hook)
        try:
            lifecycle_tx.set_scope_observed(
                self.slug, USER, 'boss', {'tools': _tools('alpha', 'beta', 'gamma')})
        finally:
            orgtx.set_pause_hook(None)
            gate.set()
            for t in threads:
                t.join(30)
        print(f"\n[measure] concurrent waits: "
              + ", ".join(f"{k}={v * 1000:.0f} ms" for k, v in sorted(waits.items())))
        self.assertEqual(errors, [])
        self.assertEqual(sorted(waits), ['m1-a1', 'other'])

    def test_rehire_gets_the_current_scope(self):
        self.save(tools=_tools('alpha'), permission_mode='default')
        o = store.load_org(self.slug)
        self.assertIn('beta', o.node('old1')['scope']['tools']['mcp'])
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL,
                          sections=('notices',), logs=('events', 'notice_log')) as tx:
            tx.org.rehire(USER, 'old1', grant=0)      # parent m1
        n = store.load_org(self.slug).node('old1')
        self.assertEqual(n['state'], 'live')
        self.assertNotIn('beta', n['scope']['tools']['mcp'])
        self.assertEqual(n['scope'].get('permission_mode'), 'default')

    def test_revoke_dir_touches_live_holders_only(self):
        o = store.load_org(self.slug)
        for k in ('boss', 'm1', 'm1-b0', 'old0', 'old3'):
            o.d['nodes'][k]['scope']['add_dirs'] = [{'path': 'C:/shared', 'mode': 'rw'}]
        store.save_org(o)
        snap = store.load_org(self.slug)
        upd, share = lifecycle_door.revoke_dir_rows(snap, USER, 'boss', 'C:/shared')
        self.assertEqual(upd, {'boss', 'm1', 'm1-b0'})
        with orgtx.org_tx(self.slug, nodes=sorted(upd), share_nodes=sorted(share - upd),
                          logs=('events',)) as tx:
            res = tx.org.revoke_dir(USER, 'boss', 'C:/shared')
        self.assertEqual(sorted(res['removed_from']), ['boss', 'm1', 'm1-b0'])
        o = store.load_org(self.slug)
        self.assertEqual(o.node('old0')['scope']['add_dirs'],
                         [{'path': 'C:/shared', 'mode': 'rw'}])


if __name__ == '__main__':
    unittest.main()
