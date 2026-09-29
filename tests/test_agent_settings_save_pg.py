"""Saving an agent's settings (the ⚙ dialog) does not read the whole org.

Measured on a PostgreSQL copy of the live org (1095 node rows, 13 MB): a
settings save took 440-790 ms for a leaf agent and 1.8-2.2 s for a large
manager, and a model switch of a BUSY agent (queued, D-234) took 9-12 s and
read 190 MB. The causes, each pinned here:

  * `_taken_with` (the scope plan's lock set) and `_sweep_dirs` walked
    `children()`, which on on-demand rows decodes the whole node table — now
    one `node_index` statement per generation (`store.lazy_children_index`);
  * on a whole document the same walks were quadratic — now one
    `children_index` per walk;
  * the queued switch dry-ran itself on a JSON copy of the whole document,
    loading every log first — now `store.dry_run_copy`, which leaves unread
    sections unread.

Every speed test here has an equality twin: the fast walk answers what the
whole-table walk answers, and the queued switch still refuses what the
immediate switch refuses.

Actual PostgreSQL (disposable, via test_pgstore).
Run:  python tools/run-python-verification.py tests/test_agent_settings_save_pg.py
"""
import contextlib
import traceback
import types
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
from orgtree import api, ledger, orgtx, pgstore, store
from orgtree.ledger import USER, LedgerError, Org

WHOLE_NODES = 'FROM nodes ORDER BY ord'
LOG_LOADS = ('SELECT owner, seq, val FROM log_d', 'SELECT seq, val FROM log_l')


def tearDownModule():
    f.tearDownModule()


class _Rollback(Exception):
    pass


class _Req:
    def __init__(self):
        self.state = types.SimpleNamespace()
        self.headers = {}
        self.url = types.SimpleNamespace(path='/api/orgs/x')


class Statements:
    """Every SQL text this process sends while active."""

    def __enter__(self):
        self.sql = []
        real = pgstore.PgConn.execute
        seen = self.sql

        stacks = self.stacks = []

        def execute(conn, sql, *a, **k):
            seen.append(str(sql))
            if any(n in str(sql) for n in (WHOLE_NODES, *LOG_LOADS)):
                stacks.append(''.join(traceback.format_stack(limit=14)))
            return real(conn, sql, *a, **k)
        self._p = patch.object(pgstore.PgConn, 'execute', execute)
        self._p.start()
        return self

    def __exit__(self, *exc):
        self._p.stop()

    def count(self, needle):
        return sum(needle in s for s in self.sql)


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class AgentSettingsSave(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass

    def setUp(self):
        lazy.LazyRows.setUp(self)
        o = store.load_org(self.slug)
        o.d['nodes'].clear()
        store.save_org(o)
        o = store.load_org(self.slug)
        o.hire(USER, None, 'haiku', 6, 'boss', charter='manager')
        for k in ('a', 'b'):
            o.hire(USER, 'boss', 'haiku', 2, k, charter='report')
        o.hire(USER, 'a', 'haiku', 0, 'a1', charter='leaf')
        o.hire(USER, 'a', 'haiku', 0, 'a2', charter='retired leaf')
        o.hire(USER, 'b', 'haiku', 0, 'b1', charter='leaf')
        # many unrelated rows: what a whole-table read would pay for
        for i in range(25):
            o.hire(USER, None, 'haiku', 0, f'other{i}', charter='elsewhere')
        store.save_org(o)
        o = store.load_org(self.slug)
        o.retire(USER, 'a2')
        store.save_org(o)
        # stamp the heal epoch: later loads are on-demand rows
        lazy.LazyRows.stamp(self)

    epoch = lazy.LazyRows.epoch
    raw = lazy.LazyRows.raw

    @contextlib.contextmanager
    def lazy(self):
        """A transaction's document — node rows on demand, none decoded yet,
        the control every "no whole read" assertion rests on — rolled back
        after use (`load_org` serves the resident, whole document)."""
        try:
            with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                self.assertIsInstance(nodes, store.LazyNodesMap)
                self.assertFalse(nodes._complete)
                yield tx.org
                raise _Rollback
        except _Rollback:
            pass

    def whole(self):
        o = store.load_org(self.slug)
        dict(o.nodes.items())            # decode every row: the reference walk
        return o

    # -- the walks answer what the whole-table walk answers ----------------
    def test_taken_with_equals_the_whole_walk_for_every_node(self):
        ref = self.whole()
        ids = list(ref.nodes)
        want = {n: ref._taken_with(n) for n in ids}
        plain = Org(dict(ref.d))                            # plain dict nodes
        for n in ids:
            with self.lazy() as o:
                self.assertEqual(o._taken_with(n), want[n], n)
            self.assertEqual(plain._taken_with(n), want[n], n)
        # the control: the fixture has a real subtree and an archived member
        self.assertEqual(want['boss'], {'boss', 'a', 'b', 'a1', 'a2', 'b1'})

    def test_taken_with_sees_an_unsaved_move(self):
        with self.lazy() as o:
            o.nodes['b1']['parent'] = 'a'                   # not saved
            self.assertEqual(o._taken_with('a'), {'a', 'a1', 'a2', 'b1'})
            self.assertEqual(o._taken_with('b'), {'b'})

    def test_children_equals_the_whole_walk_for_every_node(self):
        ref = self.whole()
        for n in ref.nodes:
            with self.lazy() as o, Statements() as st:
                for live in (True, False):
                    self.assertEqual(o.children(n, live_only=live),
                                     ref.children(n, live_only=live), n)
            self.assertEqual(st.count(WHOLE_NODES), 0, n)
        self.assertEqual(ref.children('a', live_only=False), ['a1', 'a2'])   # control
        self.assertEqual(ref.children('a'), ['a1'])

    def test_children_falls_back_to_one_whole_read_after_the_cap(self):
        ref = self.whole()
        with self.lazy() as o, patch.object(store, 'LAZY_CHILD_QUERIES', 2),                 Statements() as st:
            got = [o.children(n, live_only=False) for n in ('boss', 'a', 'b', 'a1', 'b1')]
        self.assertEqual(got, [ref.children(n, live_only=False)
                               for n in ('boss', 'a', 'b', 'a1', 'b1')])
        self.assertEqual(st.count(WHOLE_NODES), 1)
        self.assertEqual(st.count('node_index'), 2)

    def test_subtree_index_equals_children_for_every_node(self):
        ref = self.whole()
        for n in ref.nodes:
            with self.lazy() as o, Statements() as st:
                idx = o._lazy_subtree_index(n)
                for k in ref._taken_with(n):
                    self.assertEqual(o.children(k, live_only=False, index=idx),
                                     ref.children(k, live_only=False), (n, k))
            self.assertEqual(st.count(WHOLE_NODES), 0, n)

    # -- the save reads no whole table -------------------------------------
    def body(self, nid, **kw):
        o = store.load_org(self.slug)
        sc = o.nodes[nid]['scope']
        return api.Scope(add_dirs=list(sc.get('add_dirs') or []),
                         tools=dict(sc.get('tools') or {}),
                         org_visibility=sc.get('org_visibility'),
                         permission_mode=sc.get('permission_mode'), **kw)

    def test_settings_save_reads_no_whole_node_table(self):
        for nid in ('a1', 'boss'):
            body = self.body(nid, effort='high')
            store.cached_org(self.slug)                     # warm, as the engine is
            # no single-parent queries: only the batched walks may avoid the table
            with patch.object(store, 'LAZY_CHILD_QUERIES', 0), Statements() as st:
                api.node_scope(self.slug, nid, body, _Req())
            self.assertEqual(st.count(WHOLE_NODES), 0, (nid, st.stacks))
            self.assertGreater(st.count('node_index'), 0, nid)   # the control
            self.assertEqual(store.load_org(self.slug).nodes[nid]['scope']['effort'], 'high')

    def test_shrinking_a_managers_folders_still_clamps_the_subtree(self):
        o = store.load_org(self.slug)
        for k in ('boss', 'a', 'a1', 'b', 'b1'):
            o.nodes[k]['scope']['add_dirs'] = [{'path': 'C:/work', 'mode': 'rw'}]
        store.save_org(o)
        store.cached_org(self.slug)                         # warm, as the engine is
        with patch.object(store, 'LAZY_CHILD_QUERIES', 0), Statements() as st:
            api.node_scope(self.slug, 'boss', api.Scope(add_dirs=[]), _Req())
        self.assertEqual(st.count(WHOLE_NODES), 0, st.stacks)
        o = store.load_org(self.slug)
        for k in ('a', 'a1', 'b', 'b1'):
            self.assertEqual(o.nodes[k]['scope']['add_dirs'], [], k)

    def test_whole_document_walk_is_not_quadratic(self):
        o = self.whole()
        calls = []
        real = Org.children_index

        def counted(self):
            calls.append(1)
            return real(self)
        with patch.object(Org, 'children_index', counted):
            o._taken_with('boss')
            o._sweep_dirs('boss', clamp_root=False)
        self.assertEqual(len(calls), 2)                     # one per walk

    # -- the queued switch of a busy agent ---------------------------------
    def test_queued_switch_loads_no_log(self):
        o = store.load_org(self.slug)
        o.nodes['a1']['inflight'] = {'at': ledger.now()}
        store.save_org(o)
        store.cached_org(self.slug)                         # warm, as the engine is
        with Statements() as st, patch.object(api, 'provider_hire_gate',
                                               lambda *a, **k: None):
            r = api.org_op(self.slug, api.Op(op='switch_model', node='a1', tier='sonnet',
                                             actor=USER), _Req())
        self.assertFalse(r.get('queued') is False, r)
        self.assertEqual(store.load_org(self.slug).nodes['a1']['pending_switch']['tier'],
                         'sonnet')
        for needle in (WHOLE_NODES, *LOG_LOADS):
            self.assertEqual(st.count(needle), 0, (needle, st.stacks))

    def test_queued_switch_still_refuses_what_the_switch_refuses(self):
        def attempt(busy):
            with self.lazy() as o:
                copies = []
                real = store.dry_run_copy

                def spy(doc):
                    copies.append(type(doc))
                    return real(doc)
                try:
                    with patch.object(store, 'dry_run_copy', spy):
                        o.switch_model('boss', 'a1', 'fable', busy=busy)
                    return 'ok', copies
                except LedgerError as e:
                    return 'refused', str(e), copies
        immediate = attempt(False)
        self.assertEqual(immediate[0], 'refused')           # the control
        queued = attempt(True)
        self.assertEqual(queued[:2], immediate[:2])
        self.assertEqual(queued[2], [store.LazyDoc])        # the dry run ran, lazily

    def test_dry_run_copy_is_independent_and_lazy(self):
        with self.lazy() as o:
            self.assertFalse(dict.__contains__(o.d, 'events'))   # unread section
            cp = store.dry_run_copy(o.d)
            self.assertIsInstance(cp, store.LazyDoc)
            self.assertFalse(dict.__contains__(cp, 'events'))
            c = Org(cp)
            c.nodes['a1']['charter'] = 'changed in the copy'
            c.d['events'].append({'op': 'dry'})
            self.assertEqual(o.nodes['a1']['charter'], 'leaf')
            self.assertFalse(dict.__contains__(o.d, 'events'))
            self.assertEqual(c.d['events'][:-1], o.d['events'])
            self.assertTrue(c.d['events'][:-1])                  # control: not empty
        plain = {'nodes': {'x': {'v': (1, 2)}}}
        self.assertEqual(store.dry_run_copy(plain), {'nodes': {'x': {'v': [1, 2]}}})


if __name__ == '__main__':
    unittest.main()
