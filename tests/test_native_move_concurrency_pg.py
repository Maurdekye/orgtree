"""Actual two-session move, admission and current-scope controls."""
import import_provenance  # noqa: F401 asserts own checkout before engine imports
import os
import json
import threading
import time
import unittest
from unittest.mock import patch

import test_native_move_endpoints_pg as base
from orgtree import api, ledger, lifecycle_tx, orgtx, store
from orgtree.orgdb import graph, registry

setUpModule = base.setUpModule
tearDownModule = base.tearDownModule


@base.fixture.needs_pg
class MoveConcurrency(unittest.TestCase):
    def setUp(self):
        base.NativeMoveEndpoints.setUp(self)
        # Settle healing before either measured operation reaches its body.
        with orgtx.org_tx(self.slug, nodes=['boss', 'a', 'b', 'leaf']):
            pass
    values = base.NativeMoveEndpoints.values
    configure_capabilities = base.NativeMoveEndpoints.configure_capabilities

    def move(self, root, parent):
        return lifecycle_tx.move(self.slug, ledger.USER, root, parent)

    def hire(self, name, parent='boss'):
        return api.org_op(self.slug, api.Op(op='hire', actor=ledger.USER, parent=parent,
                         tier='luna', grant=0, name=name, charter='barrier test agent'),
                          base.REQUEST)

    def raw_move(self, root, parent):
        """An actual unplanned runtime writer; eager/final SQL guards still apply."""
        with registry.connection(self.slug) as raw:
            with raw.transaction():
                self._capture_connection(raw)
                raw.execute("SET LOCAL lock_timeout='15s'")
                raw.execute("UPDATE orgtree.agents SET parent_id=(SELECT id FROM "
                            "orgtree.agents WHERE name=%s AND NOT tombstone), "
                            "row_version=row_version+1 WHERE name=%s AND NOT tombstone",
                            (parent, root))
                self._pause_body('before_commit', None)

    def raw_insert(self, name):
        """Two disjoint headers must still serialize their shared stats path."""
        with registry.connection(self.slug) as raw, raw.transaction():
            self._capture_connection(raw)
            raw.execute("SET LOCAL lock_timeout='15s'")
            row = raw.execute("INSERT INTO orgtree.agents(name,parent_id,state) "
                              "SELECT %s,id,'live' FROM orgtree.agents "
                              "WHERE name='boss' AND NOT tombstone RETURNING id",
                              (name,)).fetchone()
            self._pause_body('before_commit', None)
            return row[0]

    def pair(self, first, second):
        """Pause the first real body before save; observe the other's server wait."""
        ready, release, planned = (threading.Event() for _ in range(3))
        pids, outcomes, stages = {}, {}, {}
        observations = []
        original = graph.plan_locks

        def capture_connection(raw):
            name = threading.current_thread().name
            if name in ('o1-first', 'o1-second'):
                pids[name] = raw.execute('SELECT pg_backend_pid()').fetchone()[0]
                if name == 'o1-second':
                    planned.set()

        def capture(raw, tx):
            value = original(raw, tx)
            capture_connection(raw)
            return value

        def hook(point, tx):
            name = threading.current_thread().name
            if name == 'o1-first' and point == 'before_commit' and not ready.is_set():
                stages['first_ready'] = time.perf_counter()
                ready.set()
                if not release.wait(45):
                    raise AssertionError('controller did not release the real first body')

        def invoke(name, operation):
            started = time.perf_counter()
            try:
                result = operation()
                if isinstance(result, dict) and 'error' in result:
                    raise AssertionError('actual operation returned an error: ' + str(result))
                outcomes[name] = {'result': result}
            except BaseException as error:
                outcomes[name] = {'error': error}
            finally:
                stages[name + '_ms'] = (time.perf_counter() - started) * 1000

        a = threading.Thread(target=invoke, args=('first', first), name='o1-first')
        b = threading.Thread(target=invoke, args=('second', second), name='o1-second')
        self._capture_connection = capture_connection
        self._pause_body = hook
        with patch.dict(os.environ, ORGTREE_ORGTX_TEST_HOOKS='1'), \
                patch.object(graph, 'plan_locks', side_effect=capture), \
                patch.object(api, 'provider_hire_gate'), \
                patch.object(api, 'new_hire_harness', return_value=None):
            orgtx.set_pause_hook(hook)
            try:
                a.start()
                self.assertTrue(ready.wait(20),
                                'first actual body not reached: ' + str(outcomes))
                b.start()
                self.assertTrue(planned.wait(12), 'second actual connection was never planned')
                with registry.connection(self.slug) as observer:
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline:
                        found = observer.execute(
                            'SELECT wait_event_type,wait_event,pg_blocking_pids(pid) '
                            'FROM pg_stat_activity WHERE pid=%s',
                            (pids['o1-second'],)).fetchone()
                        if found and pids['o1-first'] in found[2]:
                            observations.append({'wait_event_type': found[0],
                                'wait_event': found[1], 'blockers': found[2],
                                'locks': observer.execute(
                                    'SELECT locktype,mode,granted,relation::regclass::text,'
                                    'page,tuple FROM pg_locks WHERE pid=%s '
                                    'AND (NOT granted OR relation IS NOT NULL)',
                                    (pids['o1-second'],)).fetchall()})
                            break
                        time.sleep(.01)
                self.assertTrue(observations, 'no server lock wait on the first body was measured')
                self.assertTrue(b.is_alive(), 'second operation escaped while first was held')
                stages['released'] = time.perf_counter()
            finally:
                release.set()
                a.join(20)
                if b.ident is not None:
                    b.join(35)
                orgtx.set_pause_hook(None)
                del self._capture_connection
                del self._pause_body
        self.assertFalse(a.is_alive(), 'first session did not finish')
        self.assertFalse(b.is_alive(), 'second session did not finish')
        self.assertNotIn('error', outcomes['first'], str(outcomes['first']))
        with registry.connection(self.slug) as raw:
            self.assertEqual(graph.verify_stats(raw), [])
        measured = {'test': self.id(), 'pids': pids, 'observations': observations,
                    'first_ms': stages['first_ms'], 'second_ms': stages['second_ms'],
                    'held_ms': (stages['released']-stages['first_ready'])*1000,
                    'outcomes': {key: {field: str(value) for field,value in result.items()}
                                 for key,result in outcomes.items()}}
        print('O1_BARRIER_MEASURED=' + json.dumps(measured), flush=True)
        self.last_observations = observations
        return outcomes

    def test_crossing_moves_first_a_then_b_rechecks_cycle_after_wait(self):
        got = self.pair(lambda: self.move('a', 'b'), lambda: self.move('b', 'a'))
        self.assertIn('error', got['second'])
        self.assertRegex(str(got['second']['error']), '(?i)cycle|descendant')
        self.assertEqual(self.values()['a'][0], 'b')
        self.assertEqual(self.values()['b'][0], 'boss')

    def test_crossing_moves_first_b_then_a_rechecks_cycle_after_wait(self):
        got = self.pair(lambda: self.move('b', 'a'), lambda: self.move('a', 'b'))
        self.assertIn('error', got['second'])
        self.assertRegex(str(got['second']['error']), '(?i)cycle|descendant')
        self.assertEqual(self.values()['b'][0], 'a')
        self.assertEqual(self.values()['a'][0], 'boss')

    def test_two_native_hires_share_exact_ancestor_stats(self):
        got = self.pair(lambda: self.hire('first-hire'), lambda: self.hire('second-hire'))
        self.assertNotIn('error', got['second'], str(got['second']))
        self.assertEqual(self.values()['first-hire'][0], 'boss')
        self.assertEqual(self.values()['second-hire'][0], 'boss')

    def test_hire_and_move_share_destination_stats(self):
        got = self.pair(lambda: self.hire('first-hire', 'b'), lambda: self.move('a', 'b'))
        self.assertNotIn('error', got['second'], str(got['second']))
        self.assertEqual(self.values()['first-hire'][0], 'b')
        self.assertEqual(self.values()['a'][0], 'b')

    def assert_stats_wait(self, got):
        self.assertNotIn('error', got['second'], str(got['second']))
        # Unlike native/native admission's earlier advisory wait, this direct
        # writer has no orgtx advisories. The blocked transaction holds the
        # aggregate table's RowExclusiveLock before waiting for a row owner.
        waits = self.last_observations
        self.assertTrue(any(row['wait_event'] in ('transactionid', 'tuple')
                            and any(lock[3] == 'orgtree.agent_subtree_stats'
                                    and lock[1] == 'RowExclusiveLock'
                                    for lock in row['locks']) for row in waits), waits)

    def test_two_raw_inserts_wait_on_the_shared_ancestor_stats(self):
        got = self.pair(lambda: self.raw_insert('raw-first'),
                        lambda: self.raw_insert('raw-second'))
        self.assert_stats_wait(got)

    def test_native_hire_prelocks_stats_before_raw_insert(self):
        got = self.pair(lambda: self.hire('native-first'),
                        lambda: self.raw_insert('raw-second'))
        self.assert_stats_wait(got)

    def test_native_then_raw_crossing_move_refuses_final_cycle(self):
        got = self.pair(lambda: self.move('a', 'b'), lambda: self.raw_move('b', 'a'))
        self.assertIn('error', got['second'])
        self.assertRegex(str(got['second']['error']), '(?i)cycle|descendant')
        self.assertEqual(self.values()['a'][0], 'b')
        self.assertEqual(self.values()['b'][0], 'boss')

    def test_raw_then_native_crossing_move_rechecks_after_wait(self):
        got = self.pair(lambda: self.raw_move('b', 'a'), lambda: self.move('a', 'b'))
        self.assertIn('error', got['second'])
        self.assertRegex(str(got['second']['error']), '(?i)cycle|descendant')
        self.assertEqual(self.values()['b'][0], 'a')
        self.assertEqual(self.values()['a'][0], 'boss')

    def test_child_cap_race_checks_committed_first_move(self):
        org = store.load_org(self.slug)
        org.d['max_children'] = 1
        store.save_org(org)
        got = self.pair(lambda: self.move('leaf', 'b'), lambda: self.move('a', 'b'))
        self.assertIn('error', got['second'])
        self.assertRegex(str(got['second']['error']), '(?i)cap|report')
        self.assertEqual(self.values()['leaf'][0], 'b')
        self.assertEqual(self.values()['a'][0], 'boss')

    def action(self):
        with orgtx.org_tx(self.slug, nodes=['leaf']) as tx:
            allowed = tx.org._holds_scope_item('leaf', {'kind': 'tool', 'tool': 'bash'})
            if allowed:
                tx.org.node('leaf')['charter'] = 'authorized current-chain action'
            return allowed

    def shrink(self):
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.org.node('a')['scope']['tools']['bash'] = False

    def test_action_share_chain_precedes_scope_shrink(self):
        self.configure_capabilities()
        got = self.pair(self.action, self.shrink)
        self.assertTrue(got['first']['result'])
        self.assertNotIn('error', got['second'], str(got['second']))
        self.assertFalse(self.action())
        self.assertEqual(store.load_org(self.slug).node('leaf')['charter'],
                         'authorized current-chain action')

    def test_scope_shrink_precedes_waiting_action(self):
        self.configure_capabilities()
        before = store.load_org(self.slug).node('leaf')['charter']
        got = self.pair(self.shrink, self.action)
        self.assertFalse(got['second']['result'])
        self.assertEqual(store.load_org(self.slug).node('leaf')['charter'], before)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MoveConcurrency(name) for name in MoveConcurrency.__dict__
                              if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
