"""Record revision/scope controls on disposable PostgreSQL.

The normal migration chain installs the candidate. These controls extend its
declared window registry with one newest-1 fixture window.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
import threading
import unittest
from unittest import mock

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_derivations as D
from orgtree.orgdb import record_sql as S
from orgtree.orgdb import jobs, record_bulk
from orgtree.orgdb.compat.conn import open_conn

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule

WINDOW = D.Window('record_latest', 1, (
    D.Stream('documents', 'r.node', 'r.id::text', ('r.ord', 'r.id')),))


@fixture.needs_pg
class Capture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record capture')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]
        with fixture.dbconn.connect(fixture.ADMIN, cls.database) as raw:
            good = S.migration_sql(windows=(WINDOW,))
            start = good.index('CREATE FUNCTION orgtree.resolve_scopes')
            stop = good.index('CREATE FUNCTION orgtree.record_flush')
            raw.execute(good[start:stop].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'))
            source = D.with_windows(D.SOURCES,(WINDOW,))['documents']
            raw.execute(D.capture_function('documents',source).replace(
                'CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))

    @contextmanager
    def connection(self):
        with fixture.dbconn.connect(fixture.ADMIN, self.database) as raw:
            yield raw

    def revision(self, raw):
        return raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]

    def names(self, raw, revision, entity='agent'):
        return {row[0] for row in raw.execute(
            'SELECT c.entity_id FROM orgtree.changes c JOIN orgtree.revisions r USING(xid) '
            'WHERE r.rev=%s AND c.entity=%s', (revision, entity))}

    def test_conversion_starts_at_zero_and_save_seam_never_assigns_an_early_revision(self):
        twin = fixture.Twins('record save seam')
        database = fixture.registry.lookup(twin.copy)[1]
        with fixture.dbconn.connect(fixture.ADMIN,database) as observer:
            self.assertEqual(self.revision(observer),0)
            self.assertEqual(observer.execute('SELECT count(*) FROM orgtree.changes').fetchone()[0],0)
        with fixture.storage(True), mock.patch('orgtree.pgfeed.begin_local',side_effect=AssertionError(
                'native save must not suppress its record notification')):
            conn = open_conn(twin.copy)
            try:
                conn.execute('BEGIN IMMEDIATE')
                conn.raw.execute("UPDATE orgtree.agents SET title='record saved' WHERE name='dev'")
                conn.on_save_commit(True)
                self.assertEqual(conn.revision(),0)
                conn.execute('COMMIT')
                self.assertEqual(conn.last_revision,1)
                self.assertEqual(conn.revision(),1)
                conn.execute('BEGIN IMMEDIATE')
                conn.on_save_commit(False)
                conn.execute('COMMIT')
                self.assertIsNone(conn.last_revision)
                self.assertEqual(conn.revision(),1)
            finally:
                conn.close()

    def test_preserved_json_escapes_capture_changed_row_and_skip_exact_noop(self):
        from psycopg.types.json import Json
        for payload in ({'unknown': {'nul': '\x00', 'surrogate': '\ud800'}},
                        {'parent': 'boss', 'unknown': {'nul': '\x00', 'surrogate': '\ud800'}}):
            with self.connection() as raw:
                before = self.revision(raw)
                raw.execute('BEGIN')
                agent = raw.execute("SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone").fetchone()[0]
                raw.execute('UPDATE orgtree.agents SET extra=%s WHERE id=%s', (Json(payload), agent))
                raw.execute('COMMIT')
                self.assertEqual(self.revision(raw), before+1)
                self.assertIn(str(agent), self.names(raw, before+1))
                self.assertEqual(raw.execute('SELECT extra FROM orgtree.agents WHERE id=%s',
                                            (agent,)).fetchone()[0], payload)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET extra=extra WHERE id=%s', (agent,))
                raw.execute('COMMIT')
                self.assertEqual(self.revision(raw), before+1)

    def test_eight_finished_writers_commit_gap_free_and_notify_once_each(self):
        errors, revisions = [], []
        barrier = threading.Barrier(8,timeout=15)
        with self.connection() as observer, self.connection() as listener:
            ids = [observer.execute('INSERT INTO orgtree.agents(name,ord) VALUES(%s,%s) RETURNING id',
                (f'record-eight-{n}',930000+n)).fetchone()[0] for n in range(8)]
            before = self.revision(observer)
            listener.execute('LISTEN org_rev')

            def write(n):
                try:
                    with self.connection() as raw:
                        raw.execute('BEGIN')
                        raw.execute("UPDATE orgtree.agents SET title='concurrent record' WHERE id=%s",(ids[n],))
                        xid = raw.execute('SELECT pg_current_xact_id()').fetchone()[0]
                        barrier.wait()
                        raw.execute('COMMIT')
                        revisions.append(raw.execute('SELECT rev FROM orgtree.revisions WHERE xid=%s',
                                                     (xid,)).fetchone()[0])
                except BaseException as exc:
                    errors.append(exc)

            writers = [threading.Thread(target=write,args=(n,)) for n in range(8)]
            for writer in writers:
                writer.start()
            for writer in writers:
                writer.join(20)
            self.assertFalse(any(writer.is_alive() for writer in writers),'writer did not finish')
            self.assertEqual(errors,[])
            self.assertEqual(sorted(revisions),list(range(before+1,before+9)))
            notifications = list(listener.notifies(timeout=2,stop_after=8))
            self.assertEqual(len(notifications),8)
            self.assertEqual({int(n.payload.rsplit(':',1)[1]) for n in notifications},set(revisions))

    def test_job_handler_and_bulk_helper_use_the_database_revision_door(self):
        with self.connection() as raw:
            before = self.revision(raw)
            job = jobs.enqueue(raw,'record-control','record-control')
            leased = next(j for j in jobs.claim(raw,71,limit=32) if j.id == job.id)
            self.assertEqual(self.revision(raw),before)

            def handler(conn, current):
                conn.execute("UPDATE orgtree.agents SET title='job record' WHERE name='dev'")
                conn.execute("UPDATE orgtree.agents SET title='second job record' WHERE name='dev'")

            self.assertTrue(jobs.execute(raw,leased,handler))
            self.assertEqual(self.revision(raw),before+1)
            raw.execute('BEGIN')
            with record_bulk.writer(raw):
                raw.execute("UPDATE orgtree.agents SET title='bulk helper record' WHERE name='dev'")
            self.assertNotEqual(raw.execute("SELECT current_setting('orgtree.capture',true)").fetchone()[0],'off')
            raw.execute('COMMIT')
            self.assertEqual(raw.execute('SELECT rev,floor FROM orgtree.org_revision').fetchone(),
                             (before+2,before+2))

    def test_own_changes_commit_once_empty_and_rolled_back_statements_do_not(self):
        with self.connection() as raw:
            before = self.revision(raw)
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.agents SET title='record new title' WHERE name='dev'")
            raw.execute("UPDATE orgtree.agents SET title='record later title' WHERE name='dev'")
            raw.execute('SAVEPOINT discarded')
            raw.execute("INSERT INTO orgtree.agents(name,ord) VALUES('record-discarded',900000)")
            raw.execute('ROLLBACK TO SAVEPOINT discarded')
            self.assertEqual(self.revision(raw), before)
            raw.execute('COMMIT')
            self.assertEqual(self.revision(raw), before+1)
            self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.revisions WHERE rev=%s',
                                        (before+1,)).fetchone()[0], 1)
            self.assertFalse(raw.execute("SELECT 1 FROM orgtree.agents WHERE name='record-discarded'").fetchone())
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.agents SET title='rollback' WHERE name='dev'")
            raw.execute('ROLLBACK')
            raw.execute("UPDATE orgtree.agents SET title='empty' WHERE name='record-nobody'")
            self.assertEqual(self.revision(raw), before+1)

    def test_change_only_writer_bulk_reset_and_forced_checks_use_the_same_door(self):
        with self.connection() as raw:
            before = self.revision(raw)
            raw.execute('BEGIN')
            raw.execute("SELECT set_config('orgtree.capture','off',true)")
            raw.execute("UPDATE orgtree.agents SET title='bulk title' WHERE name='dev'")
            raw.execute('SELECT orgtree.invalidate_cursors()')
            raw.execute('COMMIT')
            self.assertEqual(raw.execute('SELECT rev,floor FROM orgtree.org_revision').fetchone(),
                             (before+1,before+1))
            raw.execute('BEGIN')
            raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
            raw.execute("INSERT INTO orgtree.changes(xid,entity,entity_id) "
                        "VALUES(pg_current_xact_id(),'org','watchdogs')")
            raw.execute('COMMIT')
            self.assertEqual(self.revision(raw), before+2)

    def test_two_finished_window_writes_resolve_in_both_commit_orders(self):
        for reverse in (False, True):
            partition = f'record-window-{reverse}'
            entity = f'record_latest:{partition}'
            order_base = 900000 + int(reverse)*100
            with self.connection() as observer, self.connection() as first, self.connection() as second:
                old = observer.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                                       (order_base,partition)).fetchone()[0]
                baseline = self.revision(observer)
                first.execute('BEGIN')
                second.execute('BEGIN')
                b = first.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                                  (order_base+1,partition)).fetchone()[0]
                c = second.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                                   (order_base+2,partition)).fetchone()[0]
                # Both source statements finished before either commit. A client
                # at the middle cursor holds that first committer's newest entry.
                earlier, later = (second, first) if reverse else (first, second)
                earlier.execute('COMMIT')
                middle = self.revision(observer)
                self.assertEqual(middle, baseline+1)
                held = str(c if reverse else b)
                later.execute('COMMIT')
                final = self.revision(observer)
                self.assertEqual(final, middle+1)
                named = self.names(observer, final, entity)
                newest = str(c)
                self.assertIn(held, named)  # unchanged displaced member must be named
                self.assertIn(newest, named)
                members = {str(row[0]) for row in observer.execute(
                    'SELECT id FROM orgtree.documents WHERE node=%s ORDER BY ord DESC,id DESC LIMIT 1',
                    (partition,))}
                client = {held}
                client.difference_update(named-members)
                client.update(named & members)
                self.assertEqual(client, members)
                self.assertNotIn(str(old), members)

    def test_late_bulk_invalidation_after_a_forced_flush_raises_the_same_revision_floor(self):
        with self.connection() as raw:
            before = self.revision(raw)
            raw.execute('BEGIN')
            raw.execute("UPDATE orgtree.agents SET title='before forced flush' WHERE name='dev'")
            raw.execute('SET CONSTRAINTS orgtree.record_flush IMMEDIATE')
            self.assertEqual(self.revision(raw), before+1)
            raw.execute('SAVEPOINT discarded_invalidation')
            raw.execute('SELECT orgtree.invalidate_cursors()')
            raw.execute('ROLLBACK TO SAVEPOINT discarded_invalidation')
            with record_bulk.writer(raw):
                raw.execute("UPDATE orgtree.agents SET title='after forced flush' WHERE name='dev'")
            raw.execute('COMMIT')
            self.assertEqual(raw.execute('SELECT rev,floor FROM orgtree.org_revision').fetchone(),
                             (before+1,before+1))
            self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.revisions WHERE rev=%s',
                                        (before+1,)).fetchone()[0],1)

    def test_parent_only_capture_names_every_bearer_root_without_expanding_children(self):
        with self.connection() as raw:
            for size in (0,200):
                ids = {}
                for offset,name in enumerate(('p','q','x','bearer')):
                    ids[name] = raw.execute('INSERT INTO orgtree.agents(name,ord,state) '
                        "VALUES(%s,%s,'live') RETURNING id",(f'capture-{size}-{name}',
                        980000+size*100+offset)).fetchone()[0]
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=ANY(%s)',
                    (ids['p'],[ids['x'],ids['bearer']]))
                for child in range(size):
                    raw.execute('INSERT INTO orgtree.agents(name,ord,state,parent_id) '
                        "VALUES(%s,%s,'live',%s)",(f'capture-{size}-child-{child}',
                        940000+child,ids['bearer']))
                before = self.revision(raw)
                raw.execute('BEGIN')
                raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=ANY(%s)',
                    (ids['q'],[ids['x'],ids['bearer']]))
                raw.execute('COMMIT')
                self.assertEqual(self.revision(raw),before+1)
                scopes = self.names(raw,before+1,'~scope')
                self.assertEqual({s for s in scopes if s.startswith('subtree:')},
                    {'subtree:'+str(ids['x']),'subtree:'+str(ids['bearer'])})
                named = self.names(raw,before+1)
                self.assertIn(str(ids['x']),named)
                self.assertIn(str(ids['bearer']),named)
                self.assertLessEqual(len(named),12)  # same bound at zero and 200 children
                if size:
                    self.assertFalse(any(s.startswith(('references:','refname:')) for s in scopes))

    def test_configured_scope_children_and_state_capture_are_savepoint_safe(self):
        with self.connection() as raw:
            aid = raw.execute('INSERT INTO orgtree.agents(name,ord,state) '
                "VALUES('capture-scope',960000,'live') RETURNING id").fetchone()[0]
            for sql,params in (
                ('UPDATE orgtree.agents SET scope_tools_bash=false WHERE id=%s',(aid,)),
                ('UPDATE orgtree.agents SET extra=%s WHERE id=%s',('{"scope":{"tools":{"web":null}}}',aid)),
                ('INSERT INTO orgtree.agent_mcp_servers(agent_id,pos,value) VALUES(%s,0,%s)',(aid,'fixture')),
                ('INSERT INTO orgtree.agent_dir_grants(agent_id,pos,path,mode) VALUES(%s,0,%s,%s)',(aid,'E:/fixture','ro')),
                ("UPDATE orgtree.agents SET state='archived' WHERE id=%s",(aid,))):
                before = self.revision(raw)
                raw.execute('BEGIN')
                raw.execute('SAVEPOINT ignored')
                raw.execute(sql,params)
                raw.execute('ROLLBACK TO SAVEPOINT ignored')
                self.assertEqual(self.revision(raw),before)
                raw.execute(sql,params)
                raw.execute('COMMIT')
                self.assertEqual(self.revision(raw),before+1)
                self.assertIn('subtree:'+str(aid),self.names(raw,before+1,'~scope'))

    def test_unchanged_rows_do_not_publish_but_name_changes_refresh_joined_children(self):
        with self.connection() as raw:
            parent = raw.execute('INSERT INTO orgtree.agents(name,ord,state) '
                "VALUES('capture-name',970000,'live') RETURNING id").fetchone()[0]
            child = raw.execute('INSERT INTO orgtree.agents(name,ord,state,parent_id) '
                "VALUES('capture-name-child',970001,'live',%s) RETURNING id",(parent,)).fetchone()[0]
            before = self.revision(raw)
            raw.execute('UPDATE orgtree.agents SET parent_id=parent_id,extra=extra WHERE id=%s',(parent,))
            self.assertEqual(self.revision(raw),before)
            raw.execute("UPDATE orgtree.agents SET name='capture-new-name' WHERE id=%s",(parent,))
            self.assertEqual(self.revision(raw),before+1)
            self.assertIn(str(child),self.names(raw,before+1))
            self.assertIn('references:'+str(parent),self.names(raw,before+1,'~scope'))

    def test_two_finished_pile_writes_name_the_displaced_edge_in_both_orders(self):
        for reverse in (False, True):
            order_base = 910000 + int(reverse)*100
            with self.connection() as observer, self.connection() as first, self.connection() as second:
                parent = observer.execute('INSERT INTO orgtree.agents(name,ord,state) '
                    "VALUES(%s,%s,'live') RETURNING id", (f'record-parent-{reverse}',order_base)).fetchone()[0]
                rows = []
                for label, order, state in (('old',10,'archived'),('b',2,'live'),('c',1,'live')):
                    rows.append(observer.execute('INSERT INTO orgtree.agents(name,ord,parent_id,state,ui_order) '
                        'VALUES(%s,%s,%s,%s,%s) RETURNING id',
                        (f'record-pile-{reverse}-{label}',order_base+order,parent,state,order)).fetchone()[0])
                old,b,c = rows
                first.execute('BEGIN')
                second.execute('BEGIN')
                first.execute("UPDATE orgtree.agents SET state='archived' WHERE id=%s", (b,))
                second.execute("UPDATE orgtree.agents SET state='archived' WHERE id=%s", (c,))
                earlier,later = (second,first) if reverse else (first,second)
                earlier.execute('COMMIT')
                held = str(c if reverse else b)
                later.execute('COMMIT')
                named = self.names(observer,self.revision(observer))
                self.assertIn(held,named)
                self.assertIn(str(c),named)
                self.assertIn(str(old),named)

    def test_negative_resolver_fault_leaves_the_displaced_member_uncaptured(self):
        good = S.migration_sql(windows=(WINDOW,))
        # Replace ONLY the scope resolver, preserving statement capture. This
        # measured negative control is the rev-2 concurrency failure's shape.
        start = good.index('CREATE FUNCTION orgtree.resolve_scopes')
        stop = good.index('CREATE FUNCTION orgtree.record_flush')
        resolver = good[start:stop].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        broken = resolver.replace('greatest(1,1-named_count+1) AND 1+named_count', '999999 AND 999999')
        self.assertNotEqual(resolver,broken)
        with self.connection() as raw:
            partition = 'record-negative'
            entity = 'record_latest:'+partition
            raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(920000,%s)', (partition,))
            old = raw.execute('SELECT id FROM orgtree.documents WHERE node=%s', (partition,)).fetchone()[0]
            try:
                raw.execute(broken)
                raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(920001,%s)', (partition,))
                self.assertNotIn(str(old),self.names(raw,self.revision(raw),entity))
            finally:
                raw.execute(resolver)
            raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(920002,%s)', (partition,))
            self.assertEqual(len(self.names(raw,self.revision(raw),entity)),2)


if __name__ == '__main__':
    unittest.main()
