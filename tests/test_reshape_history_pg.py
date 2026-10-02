"""Actual-PG: reshaping the org costs the same however much history it holds.

The user's report (2026-10-01, 3.0.9): moving an agent showed at once on the
canvas but took ~10 s to "actually register". The live log showed the move
before it — coordinator-opus with 1145 descendants, nearly all archived, and
1072 archived docket items owned below it — taking 28.5 s; the next move
queued behind it. On a copy of the live org the big move took 45 s, a demote
60 s, an insert-above hire 47 s and a self-subjugation 73 s. The causes, each
pinned below:

  * the docket-access refresh read each item's parent chain with a recursive
    join that parsed every node row's JSON per level (36 of the move's 40 s),
    and wrote each dirty item's rows with ~6 statements of its own;
  * `Org.descendants` asked `children()` once per node, and `children()`
    without an index scans every node — quadratic in the subtree;
  * self-subjugation, subtree promotion and move batches deep-copied the
    whole on-demand document (every section and log) for a simulation and
    again for a rollback point;
  * an insert-above hire's lock plan missed the anchor's lineage stack, so
    the door ran the whole hire twice.

Round two (review-sol, 2026-10-01: every reachable operation under 1 s and
no statement growth with history, the swap included):

  * the save rewrote node rows one statement each — a swap re-points every
    child row, retired ones too — now one compare-and-set statement
    (`store._cas_nodes`), and the refresh re-reads them in one;
  * a rollback point or dry run deep-copied every DECODED node row; rows
    that never changed stay undecoded in the copy (`store.dry_run_copy`), and
    a whole resident map is copied as an on-demand one for a dry run;
  * the top level's children decoded the whole node table (no index lookup
    for a null parent) — `store.lazy_children_index` now answers it;
  * a swap walked every node row to find two seats' children;
  * migration 0020: the docket-list trigger parsed each row's JSON 8 times.

THE GUARD: each operation is run on two orgs that differ ONLY in history — a
few versus many retired agents below the manager, and as many archived docket
items owned by them — and must send the same number of SQL statements, with
node rows on demand exactly as the live engine loads them. Every speed change
has an equality twin.

Actual PostgreSQL (disposable, via test_pgstore).
Run:  python tools/run-python-verification.py tests/test_reshape_history_pg.py
"""
import json
import random
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, lifecycle_tx, orgtx, pgstore, store, workread
from orgtree.ledger import USER, LedgerError, Org

SMALL, LARGE = 3, 30
_BUILDS = 0


def tearDownModule():
    f.tearDownModule()


class Statements:
    """Counts every statement sent to PostgreSQL while active (engine
    connections and the raw ones the docket read model uses)."""

    def __enter__(self):
        import psycopg
        self.n = 0
        real = psycopg.Cursor.execute

        def execute(cur, *a, **k):
            self.n += 1
            return real(cur, *a, **k)
        self._p = patch.object(psycopg.Cursor, 'execute', execute)
        self._p.start()
        return self

    def __exit__(self, *exc):
        self._p.stop()


def _hire(o, parent, name, grant=0):
    return o.hire(USER, parent, 'luna', grant, name, charter=name)['node']


def build(history: int) -> str:
    """boss (top) ─ m (the manager) ─ m1 (live) and `history` retired agents,
    each owning an archived docket item; peer (top) beside boss."""
    global _BUILDS
    _BUILDS += 1
    org = store.create_org(f'reshape-{history}-{_BUILDS}')
    slug = org.d['slug']
    _hire(org, None, 'boss', 40)
    _hire(org, None, 'peer', 10)
    _hire(org, 'boss', 'm', 20)
    _hire(org, 'm', 'm1', 2)
    _hire(org, 'm', 'm2', 2)
    for i in range(history):
        _hire(org, 'm', f'old{i}')
    store.save_org(org)
    org = store.load_org(slug)
    for i in range(history):
        org.retire(USER, f'old{i}')
    store.save_org(org)
    with pgstore.connect() as c:
        oid = c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (slug,)).fetchone()[0]
        for i in range(history):
            body = json.dumps(dict(slug=f'past-{i}', status='done', title='past',
                                   owner={'node': f'old{i}', 'generation': 0},
                                   created_by={'node': 'm', 'generation': 0}))
            c.execute(f"INSERT INTO org_{oid}.log_l(sect,val) VALUES('work_items_archive',%s)", (body,))
        with c.transaction():
            assert workread.refresh(c, oid)
    # one transaction stamps the heal epoch, so every measured operation
    # runs as the live engine does: node rows on demand, not a whole load
    with orgtx.org_tx(slug, nodes=['boss']):
        pass
    assert store.LAZY_ROWS and store.ORGTX_RESCOPE
    with pgstore.connect() as c:
        stamped = c.execute(f"SELECT val FROM org_{oid}.meta WHERE key='heal_epoch'").fetchone()
    assert stamped and stamped[0] == store.heal_epoch(), stamped
    return slug


def _no_gate(*a, **k):
    return None


def op(slug, **fields):
    with patch.object(api, 'provider_hire_gate', _no_gate):
        return api._op_door(slug, api.Op(**fields), None)


def tool(slug, actor, tool_name, **args):
    """An agent's tool call on its door, as `POST /api/agent` runs it."""
    with patch.object(api, 'provider_hire_gate', _no_gate):
        return api._agent_door(api.AgentCall(org=slug, node=actor, tool=tool_name, args=args), dict(args),
                               {'harness': None, 'archive_warnings': [], 'renamed_to': None,
                                'rename_warnings': [], 'claim_commit': None})


OPS = {
    'move under a peer': lambda s: op(s, op='move', node='m', new_parent='peer'),
    'move to the top level': lambda s: op(s, op='move', node='m', new_parent=None),
    'promote': lambda s: op(s, op='promote', node='m', new_parent=None),
    'demote': lambda s: op(s, op='demote', node='m', new_parent='peer'),
    'hire under the manager': lambda s: op(s, op='hire', parent='m', tier='luna',
                                           grant=0, name='fresh', charter='x'),
    'hire above the manager': lambda s: op(s, op='hire', parent='boss', above='m', tier='luna',
                                           grant=0, name='over', charter='x'),
    'move batch (agent tool)': lambda s: tool(s, 'boss', 'orgtree_move',
                                              moves=[{'node': 'm1', 'new_parent': 'm2'},
                                                     {'node': 'm2', 'new_parent': 'boss'}]),
    'hire above the manager (agent tool)': lambda s: tool(s, 'boss', 'orgtree_hire', name='over2',
                                                          target='m', hire_type='superior',
                                                          tier='luna', grant=0, charter='x'),
    'self-subjugate': lambda s: lifecycle_tx.subjugate(s, 'm', 'm', 'm1'),
    'promote a subtree': lambda s: lifecycle_tx.promote_subtree(s, USER, 'm', 'm1'),
    'swap seats': lambda s: lifecycle_tx.swap_seats(s, USER, 'm', 'peer'),
    'retire': lambda s: op(s, op='retire', node='m1'),
    'dissolve': lambda s: op(s, op='dissolve', node='m'),
    'rehire': lambda s: op(s, op='rehire', node='old0'),
    'reallocate': lambda s: op(s, op='reallocate', node='m', delta=1),
}


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class HistoryDoesNotCost(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def measure(self, name, history):
        slug = build(history)
        with Statements() as s:
            OPS[name](slug)
        store._POOL.close_all(slug)
        return s.n

    def test_every_reshaping_op_sends_as_many_statements_with_more_history(self):
        for name in OPS:
            with self.subTest(op=name):
                small, large = self.measure(name, SMALL), self.measure(name, LARGE)
                # no exception, the swap included: it re-points every child
                # row (retired ones too, each stores its parent), and those
                # rows go in ONE statement (`store._cas_nodes`)
                self.assertEqual(large, small,
                                 f'{name}: {small} statements with {SMALL} retired agents and '
                                 f'archived items, {large} with {LARGE}')

    def test_a_large_move_leaves_docket_access_exact(self):
        slug = build(LARGE)
        with pgstore.connect() as c:
            policy = f'org_{_oid(slug)}.work_read_policy'
            before = dict(c.execute(f'SELECT slug, xmin::text FROM {policy}').fetchall())
        OPS['move under a peer'](slug)
        with pgstore.connect() as c:
            oid = c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (slug,)).fetchone()[0]
            # the move changed who may read each item, not its policy: those
            # rows are left as they were, not rewritten with equal values
            self.assertEqual(dict(c.execute(f'SELECT slug, xmin::text FROM {policy}').fetchall()), before)
            with c.transaction():
                self.assertTrue(workread.reconcile(c, oid))
            viewers = {r[0] for r in c.execute(
                f"SELECT viewer FROM org_{oid}.work_read_access WHERE slug='past-0'")}
        self.assertIn('peer', viewers)
        self.assertNotIn('boss', viewers)
        store._POOL.close_all(slug)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class ParentChains(unittest.TestCase):
    """The docket refresh's parent-chain read follows parent ids by key."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_the_chain_read_joins_on_ids_never_on_row_json(self):
        slug = build(SMALL)
        with pgstore.connect() as c:
            oid = c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (slug,)).fetchone()[0]
            s = f'org_{oid}'
            filler = json.dumps(dict(parent='boss', blob='x' * 2000))
            c.execute(f"INSERT INTO {s}.nodes(id,ord,val) SELECT 'f'||g,1000+g,%s "
                      f"FROM generate_series(1,3000) g", (filler,))
            c.execute(f'ANALYZE {s}.nodes')
            seen = []
            real = c.execute

            def spy(query, *a, **k):
                seen.append((query, a[0] if a else None))
                return real(query, *a, **k)
            c.execute = spy
            parents = workread._Parents(c, s)
            parents.prefetch(['m1', 'old0', 'nobody'])
            del c.execute
            query, params = seen[0]
            plan = c.execute('EXPLAIN (FORMAT JSON) ' + query, params).fetchone()[0]
            self.assertEqual(len(seen), 1)
        # every join and filter compares ids: none reads a row's JSON. The
        # first form joined on `n.id = c.val::json->>'parent'`, which parsed
        # every node row at every level (150 ms per call on 1206 live rows)
        conds = []

        def walk(node):
            if isinstance(node, dict):
                conds.extend(str(v) for k, v in node.items() if k.endswith(('Cond', 'Filter')))
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(plan)
        self.assertTrue(conds, plan)
        self.assertEqual([x for x in conds if 'val' in x], [], conds)
        self.assertEqual(parents.cache['m1'], {'parent': 'm'})
        self.assertEqual(parents.cache['m'], {'parent': 'boss'})
        self.assertIsNone(parents.cache['nobody'])
        with self.assertRaises(KeyError):
            parents['nobody']
        store._POOL.close_all(slug)


def random_org(seed):
    """60 agents in a random forest, 20 of them then retired (in memory)."""
    rng = random.Random(seed)
    o = Org.create('d')
    ids = []
    for i in range(60):
        parent = rng.choice(ids) if ids and rng.random() < 0.85 else None
        ids.append(o.hire(USER, parent, 'luna', 0, f'n{i}', charter='x')['node'])
    for nid in rng.sample(ids, 20):
        if o.nodes[nid]['state'] == 'live':
            try:
                o.retire(USER, nid)
            except LedgerError:
                pass
    return o, ids


class Descendants(unittest.TestCase):
    """`descendants` / `descendant_set` answer what the per-node scan
    answered, without a whole-table scan per node."""

    def org(self, seed):
        return random_org(seed)

    def test_same_order_as_the_scan_for_every_node_and_mode(self):
        for seed in range(5):
            o, ids = self.org(seed)
            for nid in ids:
                for live_only in (True, False):
                    self.assertEqual(o.descendants(nid, live_only),
                                     o._descendants_scan(nid, live_only), (seed, nid, live_only))
                    self.assertEqual(o.descendant_set([nid, *o.lineage_stack(nid)], live_only),
                                     {d for r in [nid, *o.lineage_stack(nid)]
                                      for d in o._descendants_scan(r, live_only)})

    def test_no_whole_table_scan_per_node(self):
        o, ids = self.org(1)
        root = max(ids, key=lambda n: len(o._descendants_scan(n, False)))
        scans = []
        real = Org.children

        def children(org, nid, live_only=True, index=None):
            if index is None:
                scans.append(nid)
            return real(org, nid, live_only, index)
        with patch.object(Org, 'children', children):
            o.descendants(root, False)
            o.descendant_set([root], False)
        self.assertEqual(scans, [])


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class NoWholeDocumentCopies(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_promotion_and_batch_plans_and_rollbacks_never_load_every_log(self):
        slug = build(SMALL)
        loaded = []
        real = store.LazyDoc.materialize_all

        def spy(doc, *a, **k):
            loaded.append(1)
            return real(doc, *a, **k)
        with patch.object(store.LazyDoc, 'materialize_all', spy):
            lifecycle_tx.subjugate(slug, 'm', 'm', 'm1')
            lifecycle_tx.move_batch(slug, USER, [('m2', 'peer'), ('m2', 'boss')])
            with self.assertRaises(LedgerError):
                lifecycle_tx.subjugate(slug, 'peer', 'peer', 'boss')
        self.assertEqual(loaded, [])
        store._POOL.close_all(slug)

    def test_the_plan_still_holds_both_legs(self):
        slug = build(SMALL)
        o = store.load_org(slug)
        upd, share = lifecycle_tx._promote_rows(o, 'm', 'm', 'm1')
        self.assertTrue({'m', 'm1', 'm2', 'boss'} <= upd | share, (upd, share))
        self.assertTrue({'m', 'm1', 'm2'} <= upd, upd)
        store._POOL.close_all(slug)

    def test_a_promotion_refused_after_its_first_leg_restores_the_document(self):
        # leg 1 (m1 rises beside m, under boss) passes the children cap, leg
        # 2 (m under m1) refuses on it: the rollback point must bring back
        # the document exactly, and a save of it then changes nothing
        slug = build(SMALL)
        o = store.load_org(slug)
        o.d['max_children'] = 3
        store.save_org(o)
        o = store.load_org(slug)
        for k in ('a', 'b', 'c'):
            _hire(o, 'm1', 'k' + k)
        store.save_org(o)
        before = {k: (v['parent'], v['scope']) for k, v in store.load_org(slug).nodes.items()}
        with orgtx.org_tx(slug, nodes=orgtx.ALL, sections=['audiences', 'notices'],
                          logs=['events', 'notice_log']) as tx:
            snap = {k: (v['parent'], v['scope']) for k, v in tx.org.nodes.items()}
            with self.assertRaises(LedgerError):
                tx.org.promote_subtree(USER, 'm', 'm1')
            self.assertEqual({k: (v['parent'], v['scope']) for k, v in tx.org.nodes.items()}, snap)
        self.assertEqual({k: (v['parent'], v['scope'])
                          for k, v in store.load_org(slug).nodes.items()}, before)
        store._POOL.close_all(slug)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class InsertAboveRunsOnce(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_an_anchor_with_lineage_bearers_is_hired_above_in_one_run(self):
        slug = build(SMALL)
        o = store.load_org(slug)
        for i in range(3):
            o.compact_split('m', f'session-{i}')
        store.save_org(o)
        self.assertEqual(len(store.load_org(slug).lineage_stack('m')), 3)
        runs = []
        real = api._op_hire

        def counted(*a, **k):
            runs.append(1)
            return real(*a, **k)
        with patch.object(api, '_op_hire', counted):
            OPS['hire above the manager'](slug)
        self.assertEqual(len(runs), 1)
        o = store.load_org(slug)
        self.assertEqual(o.node('m')['parent'], 'over')
        self.assertTrue(all(o.node(k)['parent'] == 'over' for k in o.lineage_stack('m')))
        store._POOL.close_all(slug)


def _oid(slug):
    with pgstore.connect() as c:
        return c.execute('SELECT org_id FROM public.orgs WHERE slug=%s', (slug,)).fetchone()[0]


def _stored(slug):
    with pgstore.connect() as c:
        return dict(c.execute(f'SELECT id, val FROM org_{_oid(slug)}.nodes').fetchall())


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class BatchedNodeWrites(unittest.TestCase):
    """`store._cas_nodes`: every rewritten node row in one statement, with
    the same compare-and-set refusal the row-by-row statements had."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_many_rows_go_in_one_statement(self):
        slug = build(SMALL)
        sent = []
        real = pgstore.PgConn.execute

        def spy(conn, sql, *a, **k):
            sent.append(' '.join(str(sql).split()))
            return real(conn, sql, *a, **k)
        with patch.object(pgstore.PgConn, 'execute', spy):
            with orgtx.org_tx(slug, nodes=['old0', 'old1', 'old2']) as tx:
                for k in ('old0', 'old1', 'old2'):
                    tx.org.nodes[k]['parent'] = 'peer'
        node_writes = [q for q in sent if q.startswith('UPDATE nodes')]
        self.assertEqual(len(node_writes), 1, node_writes)
        self.assertIn('unnest', node_writes[0])
        rows = _stored(slug)
        self.assertEqual({json.loads(rows[k])['parent'] for k in ('old0', 'old1', 'old2')}, {'peer'})
        store._POOL.close_all(slug)

    def test_one_row_changed_underneath_refuses_the_whole_batch(self):
        slug = build(SMALL)
        org = store.load_org(slug)
        for k in ('old0', 'old1', 'old2'):
            org.nodes[k]['parent'] = 'peer'
        # another writer commits old1 after this copy was loaded
        with pgstore.connect() as c:
            c.execute(f"UPDATE org_{_oid(slug)}.nodes SET val = val || ' ' WHERE id = 'old1'")
        before = _stored(slug)
        with self.assertRaises(store.StaleWrite) as refused:
            store.save_org(org)
        self.assertIn("'old1'", str(refused.exception))
        self.assertEqual(_stored(slug), before, 'nothing of the batch was written')
        store._POOL.close_all(slug)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class CachedRefresh(unittest.TestCase):
    """The resident copy catches up on a save's rewritten rows in one read."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_rewritten_rows_are_read_back_together(self):
        slug = build(LARGE)
        store.cached_org(slug)                          # the resident copy
        OPS['swap seats'](slug)                         # rewrites every child row of both
        sent = []
        real = pgstore.PgConn.execute

        def spy(conn, sql, *a, **k):
            sent.append(' '.join(str(sql).split()))
            return real(conn, sql, *a, **k)
        with patch.object(pgstore.PgConn, 'execute', spy), \
                patch.object(store, '_node_rows', wraps=store._node_rows) as reads:
            org = store.cached_org(slug)
        self.assertGreater(reads.call_count, 0, 'the refresh did not re-read rewritten rows')
        self.assertEqual([q for q in sent if q.startswith('SELECT val FROM nodes WHERE id')], [])
        stored = _stored(slug)
        self.assertEqual({k: org.nodes[k]['parent'] for k in stored},
                         {k: json.loads(v)['parent'] for k, v in stored.items()})
        store._POOL.close_all(slug)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class LighterCopies(unittest.TestCase):
    """`dry_run_copy` (and so `rollback_copy`) leaves a decoded row that never
    changed undecoded, and a restored copy saves exactly what it holds."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_clean_rows_stay_undecoded_and_changed_rows_are_copied(self):
        slug = build(SMALL)
        with orgtx.org_tx(slug, nodes=['m', 'm1', 'm2']) as tx:
            nodes = dict.__getitem__(tx.org.d, 'nodes')
            self.assertIsInstance(nodes, store.LazyNodesMap)
            self.assertEqual(tx.org.nodes['m1']['parent'], 'm')       # decoded, clean
            tx.org.nodes['m2']['charter'] = 'changed'                  # decoded, dirty
            cp = store.dry_run_copy(tx.org.d)
            copied = dict.__getitem__(cp, 'nodes')
            self.assertFalse(dict.__contains__(copied, 'm1'))
            self.assertNotIn('m1', cp._snap_nodes)
            self.assertTrue(dict.__contains__(copied, 'm2'))
            self.assertEqual(Org(cp).nodes['m2']['charter'], 'changed')
            self.assertEqual(Org(cp).nodes['m1'], tx.org.nodes['m1'])  # decoded again
            self.assertIsNot(dict.__getitem__(copied, 'm2'), dict.__getitem__(nodes, 'm2'))
        store._POOL.close_all(slug)

    def test_a_whole_map_dry_run_is_on_demand_and_keeps_deletions(self):
        slug = build(SMALL)
        org = store.load_org(slug)                      # the resident, whole document
        self.assertIs(type(dict.__getitem__(org.d, 'nodes')), store.NodesMap)
        del org.nodes['old0']                           # deleted here, still stored
        org.nodes['m2']['charter'] = 'changed'
        stored_m1 = json.loads(_stored(slug)['m1'])
        cp = store.dry_run_copy(org.d)
        copied = dict.__getitem__(cp, 'nodes')
        self.assertIsInstance(copied, store.LazyNodesMap)
        self.assertFalse(copied._complete)
        self.assertTrue(dict.__contains__(copied, 'm2'))
        self.assertFalse(dict.__contains__(copied, 'm1'))
        dry = Org(cp)
        self.assertNotIn('old0', dry.nodes)             # never fetched back
        self.assertEqual(dry.nodes['m2']['charter'], 'changed')
        self.assertEqual(dry.nodes['m1']['parent'], stored_m1['parent'])
        self.assertEqual(org.nodes['m2']['charter'], 'changed')   # the original untouched
        dry.nodes['m1']['charter'] = 'only in the dry run'
        self.assertNotEqual(org.nodes['m1'].get('charter'), 'only in the dry run')
        store._POOL.close_all(slug)

    def test_a_whole_map_rollback_point_holds_its_own_view(self):
        # unlike a dry run, a restore point must give back what THIS document
        # held, even when the stored row has moved on since it was loaded
        slug = build(SMALL)
        org = store.load_org(slug)
        held = json.loads(json.dumps(org.nodes['m1']))
        point = store.rollback_copy(org.d)
        self.assertIs(type(dict.__getitem__(point, 'nodes')), store.NodesMap)
        with pgstore.connect() as c:
            c.execute(f"UPDATE org_{_oid(slug)}.nodes SET val = jsonb_set(val::jsonb, '{{charter}}', "
                      f"'\"written elsewhere\"')::text WHERE id = 'm1'")
        self.assertEqual(json.loads(json.dumps(Org(point).nodes['m1'])), held)
        store._POOL.close_all(slug)

    def test_a_restored_copy_saves_only_its_changes_and_deletes_nothing(self):
        slug = build(SMALL)
        before = _stored(slug)
        with orgtx.org_tx(slug, nodes=['m', 'm1', 'm2']) as tx:
            tx.org.nodes['m1']['parent']                               # decode m1
            tx.org.nodes['m2']['charter'] = 'kept'                     # before the point
            point = store.rollback_copy(tx.org.d)
            tx.org.nodes['m1']['charter'] = 'rolled back'              # after the point
            tx.org.d = point
        after = _stored(slug)
        self.assertEqual(set(after), set(before), 'no row deleted')
        self.assertEqual(json.loads(after['m2'])['charter'], 'kept')
        self.assertEqual(after['m1'], before['m1'])
        store._POOL.close_all(slug)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class TopLevelChildren(unittest.TestCase):
    """The top level is answered from `node_index` like any other parent."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_the_top_level_without_a_whole_load(self):
        slug = build(LARGE)
        whole = store.load_org(slug)
        expect = sorted(k for k, v in whole.nodes.items() if v['parent'] is None)
        loads = []
        real = store.LazyNodesMap.materialize

        def spy(m, *a, **k):
            loads.append(a)
            return real(m, *a, **k)
        with patch.object(store.LazyNodesMap, 'materialize', spy):
            with orgtx.org_tx(slug, nodes=['boss', 'm']) as tx:
                self.assertEqual(sorted(store.lazy_children_index(tx.org, [None])[None]), expect)
                self.assertEqual(sorted(tx.org.children(None, live_only=False)), expect)
                tx.org.nodes['m']['parent'] = None                     # changed in this tx
                self.assertIn('m', store.lazy_children_index(tx.org, [None])[None])
        self.assertEqual(loads, [])
        store._POOL.close_all(slug)


class SwapRelabel(unittest.TestCase):
    """`swap_seats` re-points exactly the rows the whole-table loop did."""

    def test_same_parents_as_the_whole_table_rule(self):
        import copy
        for seed in range(6):
            o, ids = random_org(seed)
            rng = random.Random(seed)
            done = 0
            for _ in range(40):
                a, b = rng.sample(ids, 2)
                trial = Org(copy.deepcopy(o.d))
                expect = {}
                for k, v in trial.nodes.items():
                    expect[k] = v['parent']
                try:
                    trial.swap_seats(USER, a, b)
                except LedgerError:
                    continue
                done += 1
                for k, p in list(expect.items()):
                    if k in (a, b):
                        continue
                    expect[k] = b if p == a else a if p == b else p
                for k in list(expect):
                    if k in (a, b) or o.nodes[k].get('successor') in (a, b):
                        expect.pop(k)       # the seats and their stacks follow §8.5
                got = {k: trial.nodes[k]['parent'] for k in expect}
                self.assertEqual(got, expect, (seed, a, b))
            self.assertGreater(done, 0)


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class WorkListTrigger(unittest.TestCase):
    """Migration 0020: the docket-list trigger parses each row value once and
    still fires exactly when state, generation, seat_id or parent change."""
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_parse_once_and_the_same_decision(self):
        slug = build(SMALL)
        s = f'org_{_oid(slug)}'
        with pgstore.connect() as c:
            src = c.execute("SELECT prosrc FROM pg_proc WHERE proname='orgtree_work_list_dirty'").fetchone()[0]
            self.assertEqual(src.count('OLD.val::jsonb'), 1, src)
            self.assertEqual(src.count('NEW.val::jsonb'), 1, src)

            def revision():
                return c.execute(f'SELECT revision FROM {s}.work_list_state WHERE singleton').fetchone()[0]

            def edit(key, value):
                c.execute(f"UPDATE {s}.nodes SET val = jsonb_set(val::jsonb, %s, %s::jsonb)::text WHERE id='m1'",
                          ('{%s}' % key, json.dumps(value)))
            r = revision()
            edit('charter', 'unrelated')
            self.assertEqual(revision(), r)
            for key, value in (('parent', 'peer'), ('state', 'archived'), ('generation', 7),
                               ('seat_id', 'other-seat')):
                with self.subTest(field=key):
                    r = revision()
                    edit(key, value)
                    self.assertEqual(revision(), r + 1)
        store._POOL.close_all(slug)


if __name__ == '__main__':
    unittest.main()
