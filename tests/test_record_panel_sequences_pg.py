"""Seeded panel evolution and commit-time boundary qualification on real PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import random
import json
import time
from contextlib import ExitStack
from dataclasses import replace
from unittest.mock import patch
import unittest
import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_reads as Q, record_panels, record_panel_sql as P
from orgtree.orgdb import record_shared_panels as shared, record_derivations as D
from orgtree.orgdb.record_registry import Registry, Selection
from orgtree import api, supervisor

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Sequences(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for section in ('user_inbox', 'user_mail_log', 'user_outbox'):
                org.d[section] = [dict(id=f'{section}{i}', at=fixture.AT, body=str(i),
                    **{'from':'dev','to':'ops'}) for i in range(60)]
            org.d['events'] = [dict(op='seed',actor='dev',at=fixture.AT,detail={'node':'dev'}) for _ in range(305)]
            org.d['notice_log'] = [dict(node='dev',at=fixture.AT,text=str(i)) for i in range(85)]
            fixture.store.save_org(org)
        self.twin = fixture.Twins('panel sequence '+self._testMethodName,seed)
        self.database = fixture.registry.lookup(self.twin.copy)[1]
        self.raw = fixture.dbconn.connect(fixture.ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute("SET statement_timeout='10s'")
        self.enterContext(fixture.storage(True))
        self.registry = record_panels.register(Registry())
        aid = str(self.raw.execute("SELECT id FROM orgtree.agents WHERE name='dev' AND NOT tombstone").fetchone()[0])
        self.selection = (Selection(), Selection('sub:1',windows=(
            {'kind':'agent_history','agent':aid}, {'kind':'agent_mail','agent':aid})))
        self.next_ord = 90000

    def baseline(self):
        with Q.snapshot(self.twin.copy) as state:
            return {(r['entity'],r['id']):r['body'] for r in Q.records(self.registry,state,self.selection)},Q.cursor(state)

    def test_real_chat_after_fills_burst_from_indexed_transcript_and_then_sends_nothing(self):
        org = fixture.store.load_org(self.twin.copy)
        org.node('dev')['session_id'] = 'panel-chat-session'
        fixture.store.save_org(org)
        path = fixture.DATA/'panel-chat.jsonl'
        def append(start,end,mode):
            with path.open(mode,encoding='utf-8') as target:
                for i in range(start,end):
                    target.write(json.dumps({'type':'assistant','uuid':f'row{i}',
                        'timestamp':f'2026-10-05T20:{i//60:02d}:{i%60:02d}Z',
                        'message':{'id':f'm{i}','role':'assistant','content':f'message{i}'}})+'\n')
        append(0,12,'w')
        with patch.object(supervisor,'transcript_path',return_value=str(path)):
            initial = api.node_chat(self.twin.copy,'dev',last=3)
            self.assertEqual(len(initial['messages']),3)
            self.assertIn('after',initial)
            append(12,45,'a')
            delta = api.node_chat(self.twin.copy,'dev',last=3,after=initial['after'])
            self.assertTrue(delta.get('incremental'))
            self.assertEqual([row['text'] for row in delta['messages']], [f'message{i}' for i in range(12,45)])
            empty = api.node_chat(self.twin.copy,'dev',last=3,after=delta['after'])
            self.assertEqual(empty['messages'],[])

    def apply(self, held, after):
        with Q.snapshot(self.twin.copy) as state:
            frame = Q.catchup(self.registry,state,after,selections=self.selection)
            self.assertEqual(frame['type'],'record_changes')
            for row in frame['tombstones']:
                held.pop((row['entity'],row['id']),None)
            for row in frame['upserts']:
                held[row['entity'],row['id']] = row['body']
            fresh = {(r['entity'],r['id']):r['body'] for r in Q.records(self.registry,state,self.selection)}
            self.assertEqual(held,fresh)
            return held,Q.cursor(state)

    def test_seeded_insert_delete_edit_and_history_predicate_changes_equal_each_baseline(self):
        rng = random.Random(9419)
        held, cursor = self.baseline()
        reconnect, reconnect_cursor = dict(held),cursor
        for step in range(36):
            table = ('user_inbox','user_mail_log','user_outbox','events','notice_log')[step % 5]
            column = 'op' if table == 'events' else 'text' if table == 'notice_log' else 'body'
            action = rng.choice(('insert','delete','edit'))
            if action == 'insert':
                if table in ('events','notice_log'):
                    owner = 'actor' if table == 'events' else 'node'
                    self.raw.execute(f'INSERT INTO orgtree.{table}(ord,{owner},at,{column}) VALUES(%s,\'dev\',%s,%s)',
                                     (50000+step,fixture.AT,str(step)))
                else:
                    self.raw.execute(f'INSERT INTO orgtree.{table}(ord,{column}) VALUES(%s,%s)',(50000+step,str(step)))
            else:
                key = self.raw.execute(f'SELECT id FROM orgtree.{table} ORDER BY id DESC OFFSET %s LIMIT 1',
                                       (rng.choice((0,1,48,52)),)).fetchone()[0]
                if action == 'delete':
                    self.raw.execute(f'DELETE FROM orgtree.{table} WHERE id=%s',(key,))
                else:
                    self.raw.execute(f'UPDATE orgtree.{table} SET {column}=%s WHERE id=%s',(f'edit{step}',key))
            held,cursor = self.apply(held,cursor)
            if step % 6 == 5:
                reconnect,reconnect_cursor = self.apply(reconnect,reconnect_cursor)
        for name in ('ops','dev'):
            self.raw.execute("UPDATE orgtree.notice_log SET node=%s WHERE id=(SELECT max(id) FROM orgtree.notice_log)",(name,))
            held,cursor = self.apply(held,cursor)

    def test_history_index_reads_stay_bounded_with_ten_times_more_inactive_rows(self):
        counts, holds = [], []
        for scale in (1,10):
            self.raw.execute("INSERT INTO orgtree.notice_log(ord,node,at,text) "
                "SELECT %s+i,'dev','2000-01-01','old' FROM generate_series(1,%s) i",
                (scale*100000,scale*500))
            self.raw.execute('ANALYZE orgtree.notice_log')
            plan = self.raw.execute('EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM orgtree.notice_log '
                "WHERE win_node='dev' ORDER BY win_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 80").fetchone()[0][0]['Plan']
            def scans(node):
                return ([node] if 'Scan' in node['Node Type'] else []) + [child for sub in node.get('Plans',[]) for child in scans(sub)]
            indexed = [node for node in scans(plan) if node.get('Index Name')=='notice_log_record_window']
            self.assertEqual(len(indexed),1,plan)
            counts.append(indexed[0]['Actual Rows'])
            self.assertLessEqual(counts[-1],80)
            # Acquire the revision row explicitly after the statement captures.
            # The measured interval includes deferred scope resolution and the
            # commit roundtrip, providing an upper bound on flush hold time.
            for i in range(5):
                self.raw.execute('BEGIN')
                self.raw.execute("INSERT INTO orgtree.notice_log(ord,node,at,text) VALUES(%s,'dev',%s,'hot')",
                                 (scale*100000+50000+i,fixture.AT))
                self.raw.execute('SELECT singleton FROM orgtree.org_revision WHERE singleton FOR UPDATE')
                start = time.perf_counter()
                self.raw.execute('COMMIT')
                holds.append((time.perf_counter()-start)*1000)
        self.assertEqual(counts,[80,80])
        print(json.dumps({'panel_history_index_rows':counts,'revision_hold_upper_ms':holds}),flush=True)

    def _race(self, reverse, delete=False):
        self.next_ord += 2
        with ExitStack() as stack:
            writers = [stack.enter_context(fixture.dbconn.connect(fixture.ADMIN,self.database)) for _ in range(2)]
            for raw in writers:
                raw.execute("SET statement_timeout='10s'")
                raw.execute('BEGIN')
            try:
                writers[0].execute("INSERT INTO orgtree.user_mail_log(ord,body) VALUES(%s,'new')",(self.next_ord,))
                if delete:
                    writers[1].execute('DELETE FROM orgtree.user_mail_log WHERE id=(SELECT max(id) FROM orgtree.user_mail_log)')
                else:
                    writers[1].execute("INSERT INTO orgtree.user_mail_log(ord,body) VALUES(%s,'second')",(self.next_ord+1,))
                first,second = writers[::-1] if reverse else writers
                first.execute('COMMIT')
                held,after = self.baseline()
                second.execute('COMMIT')
                self.apply(held,after)
            finally:
                for raw in writers:
                    raw.execute('ROLLBACK')

    def test_newest_k_insert_delete_two_statement_captures_both_orders(self):
        for reverse in (False,True):
            with self.subTest(reverse=reverse):
                self._race(reverse,delete=True)

    def test_newest_one_both_orders_and_statement_time_resolution_mutant(self):
        panels = tuple(replace(panel,window=replace(panel.window,size=1))
                       if panel.section=='user_mail_log' else panel for panel in shared.PANELS)
        windows = tuple(panel.window for panel in panels if panel.window is not None)
        extensions = (replace(record_panels.SHARED,windows=windows),*record_panels.EXTENSIONS[1:])
        correct = P.resolver(extensions)
        with patch.object(shared,'PANELS',panels):
            self.registry = record_panels.register(Registry())
        self.raw.execute(correct)
        for reverse in (False,True):
            self._race(reverse)
        window = next(w for w in windows if w.name=='user_mail_log')
        # Deliberately move this boundary selection to statement time. Both
        # writers capture before either commits, so the later commit misses
        # the row the earlier commit pushed into the newest-one window.
        resolution = D.window_resolution(window)
        self.assertIn(resolution,correct)
        self.raw.execute(correct.replace(resolution,'NULL;'))
        source = P.sources(extensions)['user_mail_log']
        capture = D.capture_function('user_mail_log',source).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
        fault = "INSERT INTO orgtree.changes(xid,entity,entity_id) SELECT pg_current_xact_id(),'user_mail_log:shared',id::text FROM orgtree.user_mail_log ORDER BY id DESC LIMIT 2 ON CONFLICT DO NOTHING;"
        self.assertIn('RETURN NULL;',capture)
        self.raw.execute(capture.replace('RETURN NULL;',fault+' RETURN NULL;'))
        try:
            with self.assertRaises(AssertionError):
                self._race(False)
        finally:
            self.raw.execute(capture)
            self.raw.execute(correct)
        self._race(False)


if __name__ == '__main__':
    unittest.main()
