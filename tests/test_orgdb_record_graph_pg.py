"""Actual private G/O1 migration chain at the B4 record revision door.

The fixture uses the composed repository migrations, including the actual O1
SQL kernel and stats hooks. Sibling implementation approval remains separate.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
import threading
import time
import unittest

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_bulk
from orgtree.orgdb.compat.conn import open_conn

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Graph(unittest.TestCase):
    pair_serial = 0
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record graph')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]
        with fixture.dbconn.connect(fixture.ADMIN,cls.database) as raw:
            installed = raw.execute(
                "SELECT to_regprocedure('orgtree.graph_assert_final_cycles()'),"
                "to_regclass('orgtree.agent_subtree_stats')").fetchone()
            assert all(installed), 'actual O1 migration was not installed'

    @contextmanager
    def connection(self):
        with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
            raw.execute("SET statement_timeout='10s'")
            yield raw

    @contextmanager
    def record_only(self,raw,*,fallback=False):
        # Disposable fault controls isolate the final kernel from the eager
        # UPDATE guard/aggregate locks. Normal-path controls below disable none.
        # Pair inserts and their initial aggregate rows remain fully maintained.
        ids = self.latest_pair
        disabled = ['graph_stats_update']
        if not fallback:
            disabled.append('graph_final_guard')
        for trigger in disabled:
            raw.execute('ALTER TABLE orgtree.agents DISABLE TRIGGER '+trigger)
        try:
            yield
        finally:
            raw.execute('ROLLBACK')
            try:
                # Return the isolated pair to its original root placement, so
                # the unchanged aggregate rows remain correct for later tests.
                raw.execute('UPDATE orgtree.agents SET parent_id=NULL WHERE id=ANY(%s)',(list(ids),))
            finally:
                raw.execute('ROLLBACK')
                for trigger in reversed(disabled):
                    raw.execute('ALTER TABLE orgtree.agents ENABLE TRIGGER '+trigger)
            self.assertEqual(raw.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall(),[])

    def pair(self,raw,label):
        type(self).pair_serial += 1
        label += '-'+str(type(self).pair_serial)
        self.latest_pair = tuple(raw.execute('INSERT INTO orgtree.agents(name,ord) '
            'SELECT %s,coalesce(max(ord),0)+1 FROM orgtree.agents RETURNING id',
            ('record-graph-'+label+'-'+str(n),)).fetchone()[0]
            for n in range(2))
        return self.latest_pair

    def rev(self,raw):
        return raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]

    def pending(self,raw):
        return raw.execute("SELECT current_setting('orgtree.graph_pending',true)").fetchone()[0]

    def test_record_flush_reaches_kernel_after_revision_before_scope_resolution(self):
        with self.connection() as raw:
            a,b = self.pair(raw,'ordered')
            with self.record_only(raw):
                # A scope resolver sees the cleared flag and the assigned stamp.
                # Wrapping the actual resolver avoids a synthetic publication path.
                raw.execute('ALTER FUNCTION orgtree.resolve_scopes() RENAME TO graph_test_resolve')
                raw.execute("""CREATE FUNCTION orgtree.resolve_scopes() RETURNS void
                    LANGUAGE plpgsql AS $fn$ BEGIN
                    IF current_setting('orgtree.graph_pending',true)='1' OR
                       nullif(current_setting('orgtree.record_revision',true),'') IS NULL THEN
                      RAISE EXCEPTION 'cycle assertion was not inside the revision boundary';
                    END IF;
                    PERFORM orgtree.graph_test_resolve(); END $fn$""")
                try:
                    before = self.rev(raw)
                    raw.execute('BEGIN')
                    raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                    self.assertEqual(self.pending(raw),'1')
                    raw.execute('SET CONSTRAINTS orgtree.record_flush IMMEDIATE')
                    self.assertEqual(self.pending(raw),'0')
                    self.assertEqual(self.rev(raw),before+1)
                    raw.execute('COMMIT')
                    self.assertEqual(self.rev(raw),before+1)
                finally:
                    raw.execute('ROLLBACK')
                    raw.execute('DROP FUNCTION orgtree.resolve_scopes()')
                    raw.execute('ALTER FUNCTION orgtree.graph_test_resolve() RENAME TO resolve_scopes')

    def test_cycle_rolls_back_revision_changes_and_notification(self):
        with self.connection() as raw,self.connection() as listener:
            a,b = self.pair(raw,'reject')
            with self.record_only(raw):
                listener.execute('LISTEN org_rev')
                before = self.rev(raw)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(a,b))
                xid = raw.execute('SELECT pg_current_xact_id()').fetchone()[0]
                with self.assertRaises(fixture.psycopg.errors.CheckViolation):
                    raw.execute('COMMIT')
                raw.execute('ROLLBACK')
                self.assertEqual(self.rev(raw),before)
                self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.changes WHERE xid=%s',(xid,)).fetchone()[0],0)
                self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.revisions WHERE xid=%s',(xid,)).fetchone()[0],0)
                self.assertEqual(list(listener.notifies(timeout=.2,stop_after=1)),[])
                self.assertNotEqual(self.pending(raw),'1')

    def test_later_flush_checks_new_graph_roots_without_a_second_revision(self):
        with self.connection() as raw:
            a,b = self.pair(raw,'later')
            with self.record_only(raw):
                before = self.rev(raw)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                raw.execute('SET CONSTRAINTS orgtree.record_flush IMMEDIATE')
                self.assertEqual(self.pending(raw),'0')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(a,b))
                # This names a new key after the early flush, guaranteeing a new
                # event instead of relying on already coalesced source names.
                raw.execute("INSERT INTO orgtree.changes VALUES(pg_current_xact_id(),'org','graph-control-late')")
                self.assertEqual(self.pending(raw),'1')
                with self.assertRaises(fixture.psycopg.errors.CheckViolation):
                    raw.execute('COMMIT')
                raw.execute('ROLLBACK')
                self.assertEqual(self.rev(raw),before)

    def test_raw_fallback_checks_late_write_even_if_all_change_keys_already_exist(self):
        with self.connection() as raw:
            a,b = self.pair(raw,'coalesced')
            with self.record_only(raw,fallback=True):
                before = self.rev(raw)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                self.assertEqual(self.pending(raw),'0')
                # Same row/scope keys already exist; the raw guard re-arms.
                raw.execute('UPDATE orgtree.agents SET parent_id=id WHERE id=%s',(a,))
                self.assertEqual(self.pending(raw),'1')
                with self.assertRaises(fixture.psycopg.errors.CheckViolation):
                    raw.execute('COMMIT')
                raw.execute('ROLLBACK')
                self.assertEqual(self.rev(raw),before)

    def test_savepoint_rollback_and_reuse_restore_transaction_local_pending_roots(self):
        with self.connection() as raw:
            a,b = self.pair(raw,'savepoint')
            with self.record_only(raw):
                before = self.rev(raw)
                raw.execute('BEGIN')
                raw.execute('SAVEPOINT discarded')
                raw.execute('UPDATE orgtree.agents SET parent_id=id WHERE id=%s',(a,))
                self.assertEqual(self.pending(raw),'1')
                raw.execute('ROLLBACK TO discarded')
                self.assertNotEqual(self.pending(raw),'1')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                raw.execute('COMMIT')
                self.assertEqual(self.rev(raw),before+1)
                self.assertNotEqual(self.pending(raw),'1')
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET parent_id=id WHERE id=%s',(b,))
                raw.execute('ROLLBACK')
                self.assertNotEqual(self.pending(raw),'1')
                raw.execute('BEGIN')
                raw.execute("UPDATE orgtree.agents SET title='reuse after rollback' WHERE id=%s",(a,))
                raw.execute('COMMIT')
                self.assertEqual(self.rev(raw),before+2)

    def test_two_writers_finished_before_commit_reject_second_cycle_in_both_orders(self):
        for order in ((0,1),(1,0)):
            with self.subTest(order=order),self.connection() as raw:
                a,b = self.pair(raw,'writers-'+str(order[0]))
                with self.record_only(raw):
                    before = self.rev(raw)
                    barrier = threading.Barrier(3,timeout=10)
                    go = [threading.Event(),threading.Event()]
                    ended = [threading.Event(),threading.Event()]
                    results = [None,None]
                    def writer(n):
                        try:
                            with self.connection() as conn:
                                conn.execute('BEGIN')
                                conn.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',
                                    ((b,a) if n==0 else (a,b)))
                                barrier.wait()
                                if not go[n].wait(10): raise TimeoutError('commit order wait')
                                try:
                                    conn.execute('COMMIT')
                                    results[n] = 'committed'
                                except fixture.psycopg.errors.CheckViolation:
                                    conn.execute('ROLLBACK')
                                    results[n] = 'cycle'
                        except BaseException as exc:
                            results[n] = repr(exc)
                        finally: ended[n].set()
                    workers = [threading.Thread(target=writer,args=(n,)) for n in range(2)]
                    try:
                        for worker in workers: worker.start()
                        barrier.wait()
                        go[order[0]].set()
                        self.assertTrue(ended[order[0]].wait(10))
                        go[order[1]].set()
                    finally:
                        for event in go: event.set()
                        for worker in workers: worker.join(15)
                    self.assertFalse(any(worker.is_alive() for worker in workers))
                    self.assertEqual(results[order[0]],'committed')
                    self.assertEqual(results[order[1]],'cycle')
                    self.assertEqual(self.rev(raw),before+1)

    def test_bulk_and_compat_commit_use_same_actual_kernel(self):
        with self.connection() as raw:
            a,b = self.pair(raw,'seams')
            with self.record_only(raw):
                before = self.rev(raw)
                raw.execute('BEGIN')
                with record_bulk.writer(raw):
                    raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
                raw.execute('COMMIT')
                self.assertEqual(raw.execute('SELECT rev,floor FROM orgtree.org_revision').fetchone(),(before+1,before+1))
                self.assertNotEqual(self.pending(raw),'1')
                with fixture.storage(True):
                    conn = open_conn(self.twin.copy)
                    try:
                        conn.execute('BEGIN IMMEDIATE')
                        conn.raw.execute('UPDATE orgtree.agents SET parent_id=id WHERE id=%s',(b,))
                        conn.on_save_commit(True)
                        with self.assertRaises(Exception) as caught:
                            conn.execute('COMMIT')
                        self.assertEqual(getattr(caught.exception,'sqlstate',None),'23514')
                        self.assertEqual(self.rev(raw),before+1)
                    finally: conn.close()

    def test_normal_eager_cycle_rejects_statement_without_publication(self):
        with self.connection() as raw,self.connection() as listener:
            a,b = self.pair(raw,'eager')
            listener.execute('LISTEN org_rev')
            before = self.rev(raw)
            raw.execute('BEGIN')
            raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(b,a))
            xid = raw.execute('SELECT pg_current_xact_id()').fetchone()[0]
            with self.assertRaisesRegex(fixture.psycopg.errors.CheckViolation,
                                        'cycle in eager aggregates'):
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',(a,b))
            raw.execute('ROLLBACK')
            self.assertEqual(self.rev(raw),before)
            self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.changes WHERE xid=%s',(xid,)).fetchone()[0],0)
            self.assertEqual(list(listener.notifies(timeout=.2,stop_after=1)),[])
            self.assertEqual(raw.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall(),[])

    def test_normal_writers_have_witnessed_stats_wait_then_reject_cycle(self):
        # Eager locks serialize the opposing statements. Prove their actual
        # server wait; do not claim both statements completed before COMMIT.
        for order in ((0,1),(1,0)):
            with self.subTest(order=order),self.connection() as first,self.connection() as witness:
                a,b = self.pair(first,'eager-wait-'+str(order[0]))
                before = self.rev(first)
                moves = ((b,a),(a,b))
                first_pid = first.execute('SELECT pg_backend_pid()').fetchone()[0]
                first.execute('BEGIN')
                first.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',moves[order[0]])
                started = threading.Event()
                result = {}
                def second():
                    try:
                        with self.connection() as conn:
                            result['pid'] = conn.execute('SELECT pg_backend_pid()').fetchone()[0]
                            conn.execute('BEGIN')
                            started.set()
                            try:
                                conn.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',moves[order[1]])
                                conn.execute('COMMIT')
                                result['outcome'] = 'committed'
                            except fixture.psycopg.errors.CheckViolation as exc:
                                result['outcome'] = exc.sqlstate
                                conn.execute('ROLLBACK')
                    except BaseException as exc:
                        result['error'] = repr(exc)
                worker = threading.Thread(target=second)
                worker.start()
                try:
                    self.assertTrue(started.wait(3),result)
                    deadline = time.monotonic()+4
                    waiting = None
                    while time.monotonic()<deadline:
                        waiting = witness.execute('SELECT wait_event_type,pg_blocking_pids(pid) '
                            'FROM pg_stat_activity WHERE pid=%s',(result['pid'],)).fetchone()
                        if waiting and waiting[0]=='Lock' and first_pid in waiting[1]:
                            break
                        time.sleep(.02)
                    self.assertTrue(waiting and waiting[0]=='Lock' and first_pid in waiting[1],
                                    (waiting,result))
                    first.execute('COMMIT')
                finally:
                    first.execute('ROLLBACK')
                    worker.join(12)
                self.assertFalse(worker.is_alive(),result)
                self.assertNotIn('error',result)
                self.assertEqual(result.get('outcome'),'23514',result)
                self.assertEqual(self.rev(first),before+1)
                self.assertEqual(first.execute('SELECT * FROM orgtree.graph_verify_stats()').fetchall(),[])

    def test_planted_missing_kernel_is_caught_by_revision_order_control(self):
        with self.connection() as raw:
            raw.execute('ALTER FUNCTION orgtree.graph_assert_final_cycles() RENAME TO graph_test_kernel')
            raw.execute('CREATE FUNCTION orgtree.graph_assert_final_cycles() RETURNS void '
                        'LANGUAGE plpgsql AS $fn$ BEGIN RETURN; END $fn$')
            try:
                with self.assertRaisesRegex(fixture.psycopg.errors.RaiseException,
                                            'cycle assertion was not inside the revision boundary'):
                    self.test_record_flush_reaches_kernel_after_revision_before_scope_resolution()
            finally:
                raw.execute('ROLLBACK')
                raw.execute('DROP FUNCTION orgtree.graph_assert_final_cycles()')
                raw.execute('ALTER FUNCTION orgtree.graph_test_kernel() RENAME TO graph_assert_final_cycles')


if __name__=='__main__':
    unittest.main()
