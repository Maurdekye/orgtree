"""Unmodified G backfill with an already installed pre-G feed; disposable PG.

The old feed is an exact committed source fixture, not a live database copy.
This proves cursor invalidation at the bulk seam, not all G migration behavior
or the later G/O1/full-tree composition. No peer-owned migration is edited.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

from orgtree.orgdb import codec, conn, docket_events, record_bulk, record_reads as Q, turns
from orgtree.orgdb.convert import rowio
from orgtree.orgdb.mappers import agents as A, docket as D, records as N
from orgtree.orgdb.record_registry import Registry, Snapshot

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT/'engine/backend/orgtree/pg_migrations/org'
ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL','').strip()
OLD = '2386309919ecaec167d45baae7492cb5472f1c56'
OLD_PATH = 'engine/backend/orgtree/pg_migrations/org/0016_records.sql'
G_PATH = 'engine/backend/orgtree/pg_migrations/org/0016_schema_conformance.sql'


def source(ref,expected_blob):
    def git(*args):
        return subprocess.run(['git',*args],cwd=ROOT,check=True,capture_output=True,timeout=300).stdout
    actual = git('rev-parse',ref).decode().strip()
    if actual != expected_blob:
        raise AssertionError(('unapproved source fixture',ref,actual,expected_blob))
    return git('show',ref).decode('utf-8')


@unittest.skipUnless(ADMIN,'needs owned disposable ORGTREE_TEST_PG_ADMIN_URL')
class ExistingFeedBulk(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_feed = source(OLD+':'+OLD_PATH,'eb3ee930c0d4a851fe2e9dd29e81406579db5e64')
        cls.g_sql = source('HEAD:'+G_PATH,'647ae599d17ab661c9ef091ea7c27bb85ebbf7e3')

    def setUp(self):
        from psycopg import sql
        self.database = 't'+str(os.getpid())+'_record_bulk_'+uuid.uuid4().hex[:8]
        with conn.connect(ADMIN,'postgres') as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(self.database)))
        self.addCleanup(self.drop)
        self.raw = conn.connect(ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute("SET statement_timeout='15s'")
        self.raw.execute('CREATE SCHEMA orgtree')
        for path in sorted(MIGRATIONS.glob('*.sql')):
            if path.name <= '0015_turn_requests.sql':
                with self.raw.transaction():
                    self.raw.execute(path.read_text(encoding='utf-8'))
        self.raw.execute('INSERT INTO orgtree.org_identity(org_uuid,slug,incarnation) VALUES(%s,%s,%s)',
                         (uuid.uuid4(),'record-bulk-owned',uuid.uuid4()))
        self.common = {'n':3,'cost':1.0,'cost_unknown_fields':['x','x'],
                       'model_usage_key':{'asked':'model','matched':True,'keys':['b','a']}}
        self.node = {'state':'live','seat_id':'current','generation':9,
                     'turns':[{'n':0,'model_usage_key':['old']},self.common,self.common]}
        self.item = {'slug':'record-bulk-item','status':'open','rev':1,
                     'owner':{'node':'worker','born':'current','generation':9},
                     'review_seats':[{'reviewer':'worker','holder':{'node':'worker','born':'current','generation':9},
                                      'state':'granted'}],
                     'delivery':{'implemented':{'claimed_by':'user','note':'bulk fixture'}},
                     'artifacts':[{'id':'r1','grants':[{'to':'worker','by':'user','revoked_at':None}]}]}
        rows = {}
        codec.encode(A.LEGACY_HOT,self.node,dict(id=1,name='worker',ord=0,tombstone=False),
                     rows,link=A.LEGACY_AGENTS.link)
        for pos,value in enumerate([self.common,self.common]):
            codec.encode(N.AGENT_TURNS,value,dict(id=17+pos*13,agent_id=1,idx=pos),rows,
                         link=N._turns().migration_tables[0].link)
        codec.encode(D.ALPHA_WORK_ITEM,self.item,D.row_keys(self.item,id=107,list_key='active',ord=0),
                     rows,link=D.LEGACY_WORK_ITEMS.link)
        order = [*A.LEGACY_AGENTS.layout(),*N._turns().migration_tables[0].layout(),
                 *D.LEGACY_WORK_ITEMS.layout()]
        with self.raw.transaction():
            rowio.write(self.raw,rows,order=order)
        self.raw.execute("SELECT setval(pg_get_serial_sequence('orgtree.agents','id'),100,true)")
        self.raw.execute("SELECT setval(pg_get_serial_sequence('orgtree.agent_turns','id'),100,true)")
        with self.raw.transaction():
            self.raw.execute(self.old_feed)
        self.raw.execute("UPDATE orgtree.agents SET title='before bulk rewrite' WHERE id=1")
        self.before = self.stamp(self.raw)
        self.assertGreater(self.before['org_revision'],0)

    def drop(self):
        from psycopg import sql
        with conn.connect(ADMIN,'postgres') as admin:
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(self.database)))

    def stamp(self,raw):
        org,inc,rev,floor = raw.execute('SELECT i.org_uuid::text,i.incarnation::text,r.rev,r.floor '
                                      'FROM orgtree.org_identity i CROSS JOIN orgtree.org_revision r').fetchone()
        return dict(org_uuid=org,incarnation=inc,org_revision=rev,floor=floor)

    @contextmanager
    def state(self):
        with conn.connect(ADMIN,self.database) as raw:
            raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                yield Snapshot(raw,'record-bulk-owned',self.stamp(raw),time.time())
            finally:
                raw.execute('ROLLBACK')

    def rewrite(self,*,invalidate=True,fault=False):
        with self.raw.transaction():
            with record_bulk.writer(self.raw,new_database=not invalidate):
                self.raw.execute(self.g_sql)
                if fault:
                    self.raw.execute("DO $fault$ BEGIN RAISE EXCEPTION 'bulk late fault'; END $fault$")

    def assert_contents(self):
        from psycopg.rows import dict_row
        self.assertIsNone(self.raw.execute("SELECT to_regclass('orgtree.agent_recent_turns')").fetchone()[0])
        self.assertEqual(self.raw.execute('SELECT id FROM orgtree.agent_turns WHERE idx IS NOT NULL ORDER BY idx').fetchall(),
                         [(17,),(30,)])
        self.assertEqual(turns.read_recent(self.raw,[1])[1],self.node['turns'])
        self.assertEqual(self.raw.execute('SELECT value FROM orgtree.agent_turn_cost_unknown_fields '
                                         'WHERE turn_id=17 ORDER BY pos').fetchall(),[('x',),('x',)])
        self.assertEqual(self.raw.execute('SELECT value FROM orgtree.agent_turn_model_usage_keys '
                                         'WHERE turn_id=17 ORDER BY pos').fetchall(),[('b',),('a',)])
        with self.raw.cursor(row_factory=dict_row) as cur:
            row = cur.execute('SELECT * FROM orgtree.work_items WHERE id=107').fetchone()
            children = {table:cur.execute('SELECT * FROM orgtree.'+table).fetchall()
                        for table in D.WORK_ITEMS.layout() if table!='work_items'}
            events = cur.execute('SELECT * FROM orgtree.work_item_events').fetchall()
        self.assertEqual(docket_events.decode_item(row,codec.Children(children,D.WORK_ITEMS.layout()),events),self.item)
        self.assertEqual(row['owner_agent_id'],1)
        self.assertEqual(self.raw.execute('SELECT agent_id FROM orgtree.work_item_artifact_grants').fetchall(),[(1,)])

    def assert_reset(self):
        with self.state() as state:
            answer = Q.catchup(Registry(),state,Q.Cursor(self.before['org_uuid'],self.before['incarnation'],
                                                       self.before['org_revision']))
            self.assertEqual(answer,{'type':'record_reset'},'previous newest cursor must reset without another write')
        current = self.stamp(self.raw)
        self.assertEqual(current['org_revision'],self.before['org_revision']+1)
        self.assertEqual(current['floor'],current['org_revision'])
        self.assertEqual(self.raw.execute('SELECT count(*) FROM orgtree.revisions WHERE rev=%s',
                                         (current['org_revision'],)).fetchone()[0],1)

    def test_actual_g_rewrite_resets_newest_cursor_and_notifies_with_old_snapshot_held(self):
        with conn.connect(ADMIN,self.database) as listener,self.state() as held:
            listener.execute('LISTEN org_rev')
            old_history = held.raw.execute('SELECT rev,xid::text FROM orgtree.revisions ORDER BY rev').fetchall()
            old_changes = held.raw.execute('SELECT xid::text,entity,entity_id FROM orgtree.changes ORDER BY 1,2,3').fetchall()
            self.rewrite()
            self.assert_contents()
            self.assert_reset()
            self.assertEqual(self.stamp(held.raw),self.before)
            self.assertEqual(held.raw.execute('SELECT rev,xid::text FROM orgtree.revisions ORDER BY rev').fetchall(),old_history)
            self.assertEqual(held.raw.execute('SELECT xid::text,entity,entity_id FROM orgtree.changes ORDER BY 1,2,3').fetchall(),old_changes)
            self.assertEqual([n.payload for n in listener.notifies(timeout=1,stop_after=1)],
                             ['record-bulk-owned:'+str(self.before['org_revision']+1)])

    def test_late_rewrite_fault_rolls_back_schema_capture_and_cursor_then_reuse_succeeds(self):
        from psycopg.errors import RaiseException
        with conn.connect(ADMIN,self.database) as listener:
            listener.execute('LISTEN org_rev')
            with self.assertRaisesRegex(RaiseException,'bulk late fault'):
                self.rewrite(fault=True)
            self.assertEqual(self.stamp(self.raw),self.before)
            self.assertIsNotNone(self.raw.execute("SELECT to_regclass('orgtree.agent_recent_turns')").fetchone()[0])
            self.assertIsNone(self.raw.execute("SELECT to_regclass('orgtree.work_item_artifact_grants')").fetchone()[0])
            self.assertNotEqual(self.raw.execute("SELECT current_setting('orgtree.capture',true)").fetchone()[0],'off')
            self.assertEqual(list(listener.notifies(timeout=.2,stop_after=1)),[])
            self.rewrite()
            self.assert_contents()
            self.assert_reset()

    def test_omitted_invalidation_is_detected_at_previous_newest_cursor(self):
        # Deliberate fault: misuse converter-only mode for an existing rewrite.
        self.rewrite(invalidate=False)
        self.assert_contents()
        with self.assertRaisesRegex(AssertionError,'previous newest cursor must reset'):
            self.assert_reset()


if __name__ == '__main__':
    unittest.main()
