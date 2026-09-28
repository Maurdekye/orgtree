"""Capture without a chat read, including failed turns and background backfill."""
import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

fixture=tempfile.TemporaryDirectory(prefix='orgtree-capture-')
os.environ['ORGTREE_DATA']=str(Path(fixture.name)/'data')
os.environ['ORGTREE_V2_TOKEN']='capture-test-only'
Path(os.environ['ORGTREE_DATA']).mkdir()

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
load_app()
from orgtree import store, ledger, supervisor as sup, transcript_ingest as ingest, transcript_records as records
from orgtree.chat_window import source_key

def tearDownModule():
    from orgtree import transcript_records
    transcript_records.close_all()
    for item in store.list_orgs():store._POOL.close_all(item['slug'])
    fixture.cleanup()

class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.org=store.create_org('capture-'+uuid.uuid4().hex[:8])
        self.org.hire(ledger.USER,None,'haiku',0,'agent')
        store.save_org(self.org)
        self.path=Path(fixture.name)/(self.org.d['slug']+'.jsonl')
        self.lookup=patch.object(sup,'transcript_path',side_effect=lambda *a: str(self.path) if self.path.exists() else None)
        self.lookup.start();self.addCleanup(self.lookup.stop)
        # Mint conversation identity before comparing two unchanged passes.
        source_key(store.load_org(self.org.d['slug']), 'agent')
    def write(self,start,count,mode='w',width=0):
        with self.path.open(mode,encoding='utf8') as stream:
            for i in range(start,start+count):stream.write(json.dumps({'type':'assistant','message':{'content':str(i).zfill(width)}})+'\n')
    def rows(self):
        return records.tail(source_key(store.load_org(self.org.d['slug']),'agent'),1000)[0]
    def slice_of(self,records_per_slice):
        """Patch the byte budget to exactly this many of this file's (fixed-width) records."""
        line=self.path.read_bytes().index(b'\n')+1   # on-disk size, CRLF included
        return patch.object(ingest,'SLICE_BYTES',records_per_slice*line)
    def test_new_session_captured_at_failed_turn_boundary_without_any_view(self):
        def body(*a,**k):
            self.write(0,40)
            raise RuntimeError('failed after output')
        with patch.object(sup,'_run_one_turn_recorded',side_effect=body), patch.object(sup.turnlog,'start',return_value=None), patch.object(sup,'read_chat',side_effect=AssertionError('no UI reader')):
            with self.assertRaisesRegex(RuntimeError,'failed after output'):
                sup._run_one_turn(self.org.d['slug'],'agent','hello')
        self.path.unlink()
        self.assertEqual(len(self.rows()),40)
    def test_prompt_projection_is_durable_before_any_desk_read(self):
        import hashlib
        sid=self.org.node('agent')['session_id'];slug=self.org.d['slug']
        raw='provider envelope and human message'
        sup._record_prompt_view(slug,sid,raw,'human message')
        Path(sup._prompt_view_path(slug,sid)).unlink()
        rows=records.prompt_views_for(records.views_source(slug,sid),hashlib.sha256(raw.encode()).hexdigest())
        self.assertEqual([r['visible'] for r in rows],['human message'])

    def test_known_session_suffix_is_captured_and_history_backfills_in_slices(self):
        self.write(0,180,width=3)
        ingest.capture(self.org.d['slug'],'agent',beginning=True)
        self.assertEqual(len(self.rows()),1,'admission must not import the entire old transcript')
        self.write(180,20,'a',width=3)
        ingest.capture(self.org.d['slug'],'agent')
        self.assertEqual(len(self.rows()),21)
        with self.slice_of(64):
            ingest.capture(self.org.d['slug'],'agent',backfill=True)
            self.assertEqual(len(self.rows()),85,'one slice imports one byte budget of older records')
            ingest.capture(self.org.d['slug'],'agent',backfill=True)
            ingest.capture(self.org.d['slug'],'agent',backfill=True)
        self.path.unlink()
        self.assertEqual(len(self.rows()),200)
        self.assertEqual(len({(r[0],r[1]) for r in self.rows()}),200)
    # ---- slice C: an idle backfill costs a few stat() calls, not a re-read ----
    def backfill(self):
        return ingest.capture(self.org.d['slug'],'agent',backfill=True)
    def test_a_settled_node_is_skipped_until_its_file_changes(self):
        self.write(0,10)
        self.assertTrue(self.backfill())
        self.assertEqual(len(self.rows()),10)
        with patch.object(records,'ingest',side_effect=AssertionError('re-read an unchanged transcript')), \
             patch.object(records,'ingest_prompt_views',side_effect=AssertionError('re-read unchanged views')), \
             patch.object(records,'database',side_effect=AssertionError('opened a database for settled files')):
            self.assertFalse(self.backfill())
        self.write(10,5,'a')
        self.assertTrue(self.backfill())
        self.assertEqual(len(self.rows()),15)
        self.assertFalse(self.backfill())
    def test_pending_history_keeps_the_node_unsettled(self):
        self.write(0,200,width=3)
        with self.slice_of(64):
            self.assertEqual([self.backfill() for _ in range(5)],[True,True,True,True,False])
        self.assertEqual(len(self.rows()),200)

    # ---- cold catch-up: byte-sized slices, one identity mint, active first ----
    def test_default_slice_imports_a_small_history_in_one_visit(self):
        self.write(0,200)
        self.assertEqual([self.backfill(),self.backfill()],[True,False])
        self.assertEqual(len(self.rows()),200)
        self.assertEqual(len({(r[0],r[1]) for r in self.rows()}),200)

    def test_one_slice_never_reads_more_than_its_budget_plus_one_record(self):
        self.write(0,200,width=3)
        seen=[]
        original=records._insert
        def counted(conn,source,epoch,rows):
            rows=list(rows);seen.append(sum(len(line)+1 for _,line in rows))
            return original(conn,source,epoch,rows)
        line=self.path.read_bytes().index(b'\n')+1
        with self.slice_of(10), patch.object(records,'_insert',side_effect=counted):
            for _ in range(60):
                if not self.backfill():
                    break
            else:
                self.fail('backfill never settled')
        self.assertEqual(len(self.rows()),200)
        self.assertTrue(seen,'control: slices really inserted rows')
        self.assertLessEqual(max(seen),10*line+line)
        self.assertGreaterEqual(len(seen),200//11)

    def test_a_record_larger_than_the_budget_still_makes_progress(self):
        with self.path.open('w',encoding='utf8') as f:
            for i in range(3):f.write(json.dumps({'type':'assistant','message':{'content':str(i)+'x'*5000}})+'\n')
        with patch.object(ingest,'SLICE_BYTES',100):
            results=[self.backfill() for _ in range(4)]
        self.assertEqual(len(self.rows()),3)
        self.assertEqual(results[-1],False)

    def test_unbounded_backfill_does_not_count_lifetime_records(self):
        import contextlib
        self.write(0,200,width=3)
        statements=[]
        original=records.database
        class Proxy:
            def __init__(self,conn):self.conn=conn
            def execute(self,sql,*args):
                statements.append(sql);return self.conn.execute(sql,*args)
            def executemany(self,sql,*args):
                statements.append(sql);return self.conn.executemany(sql,*args)
            def __getattr__(self,name):return getattr(self.conn,name)
        @contextlib.contextmanager
        def observed():
            with original() as conn:yield Proxy(conn)
        with self.slice_of(64), patch.object(records,'database',observed):
            self.backfill();self.backfill()
        self.assertTrue(any('transcript_records' in sql for sql in statements),'control: backfill ran')
        self.assertFalse(any('COUNT(*) FROM transcript_records' in sql for sql in statements))
        self.assertEqual(len(self.rows()),128)

    def test_unminted_node_is_minted_once_to_the_same_identity(self):
        from orgtree import orgtx, reply_events
        slug=self.org.d['slug']
        org=store.load_org(slug)
        for key in ('transcript_incarnation','reply_incarnation'):
            org.node('agent').pop(key,None)
        store.save_org(org)
        self.write(0,5)
        calls=[]
        original=orgtx.org_tx
        def counted(*a,**k):
            calls.append((a,k));return original(*a,**k)
        with patch.object(orgtx,'org_tx',side_effect=counted):
            self.assertTrue(self.backfill())
        after=store.load_org(slug)
        node=after.node('agent')
        self.assertEqual(node['transcript_incarnation'],after.d['reply_incarnation']+':'+node['reply_incarnation'],
                         'minted value must be the identity today\'s routine mints')
        self.assertEqual(node['transcript_incarnation'],reply_events.incarnation(after,'agent'))
        self.assertLessEqual(len(calls),2,'one reply-identity and one transcript-identity transaction')
        self.assertEqual(len(self.rows()),5)
        self.assertEqual(records.tail(json.dumps([node['transcript_incarnation'],node['session_id'],False]),10)[0],
                         self.rows(),'records land under the minted identity')
    def test_a_changed_prompt_view_sidecar_unsettles_the_node(self):
        self.write(0,3)
        slug=self.org.d['slug'];sid=self.org.node('agent')['session_id']
        self.assertTrue(self.backfill());self.assertFalse(self.backfill())
        vpath=Path(sup._prompt_view_path(slug,sid));vpath.parent.mkdir(parents=True,exist_ok=True)
        with vpath.open('a',encoding='utf8') as f:
            f.write(json.dumps({'v':1,'sha256':'0'*64,'chars':1,'visible':'x','at':'2026-09-27T00:00:00Z'})+'\n')
        self.assertTrue(self.backfill(),'a grown sidecar was skipped')
        self.assertFalse(self.backfill())
    def test_a_fresh_source_is_never_skipped(self):
        self.write(0,3)
        self.assertTrue(self.backfill());self.assertFalse(self.backfill())
        with ingest._lock:ingest._fresh.add(source_key(store.load_org(self.org.d['slug']),'agent'))
        self.assertTrue(self.backfill())
    def test_idle_cycles_keep_polling_and_never_delay_busy_capture(self):
        import collections
        from types import SimpleNamespace
        calls=[]
        def fake(slug,nid,**kw):
            calls.append((nid,bool(kw.get('backfill'))));return False
        queue=ingest._SweepState();now=[0.0]
        with patch.object(store,'org_slugs',return_value=['x']), \
             patch.object(store,'read_transcript_nodes_page',return_value={'rows': [('a','live'),('b','live'),('c','live')], 'more': False}), \
             patch.dict(sup._state,{('x','busy'):{'busy':True}},clear=True), \
             patch.object(ingest,'capture_safely',side_effect=fake):
            ingest._sweep(queue,clock=lambda:now[0])
            self.assertEqual(calls,[('busy',False),('a',True),('b',True),('c',True)]);calls.clear()
            now[0]+=1.0
            ingest._sweep(queue,clock=lambda:now[0])
            self.assertEqual(calls,[('busy',False),('a',True),('b',True),('c',True)])
    def test_a_cycle_that_worked_does_not_pause(self):
        import collections
        from types import SimpleNamespace
        calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid);return nid=='b'
        queue=ingest._SweepState()
        with patch.object(store,'org_slugs',return_value=['x']), \
             patch.object(store,'read_transcript_nodes_page',return_value={'rows': [('a','live'),('b','live'),('c','live')], 'more': False}), \
             patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            ingest._sweep(queue);ingest._sweep(queue)
        self.assertEqual(calls,['a','b','c','a','b','c'])

    def fake_state(self,active,archived=()):
        """A sweep state whose discovery is stubbed: `active` live keys, and
        `archived` keys handed to capture as discovered history."""
        state=ingest._SweepState()
        state.root=str(store.DATA_ROOT)
        state.orgs.append('x')
        for nid in active:state.active[('x',nid)]=state.round
        queue=list(archived)
        def discover():
            out=[('x',n) for n in queue];queue.clear();return out
        state.discover=discover
        return state

    def test_history_waits_until_every_active_node_is_settled(self):
        calls=[];unsettled={'a','b'}
        def fake(slug,nid,**kw):
            calls.append(nid)
            with ingest._lock:
                if nid in unsettled:ingest._settled.pop((slug,nid),None)
                else:ingest._remember_settled((slug,nid),((),()))
            return True
        state=self.fake_state(['a','b','c'],[f'old{i}' for i in range(20)])
        with patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake), \
             patch.object(ingest,'ARCHIVED_PER_ACTIVE_ROUND',2):
            self.assertTrue(ingest._sweep(state))
            self.assertEqual(calls,['a','b','c','old0','old1'],'only the per-round allowance while active is pending')
            calls.clear();unsettled.clear()
            ingest._sweep(state)   # this round settles every active node
            self.assertEqual(calls[:3],['a','b','c'])
            self.assertEqual(calls[3:],['old2','old3'])
            calls.clear()
            ingest._sweep(state)   # the settled round is judged: history is unrestricted
        self.assertEqual([n for n in calls if n.startswith('old')],[f'old{i}' for i in range(4,20)])

    def test_backfill_work_in_one_tick_is_time_bounded(self):
        now=[0.0];calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid);now[0]+=0.04
            with ingest._lock:ingest._settled.pop((slug,nid),None)
            return True
        state=self.fake_state([str(i) for i in range(20)])
        with patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            self.assertTrue(ingest._sweep(state,clock=lambda:now[0]))
        self.assertEqual(len(calls),4,'0.15 s budget at 0.04 s per capture')
        self.assertEqual(len(state.hot),16,'the rest waits for the next tick')

    def test_single_slice_catch_up_never_sleeps_a_second_while_work_remains(self):
        """The N1000 shape: every active file settles in ONE visit. Each tick
        must still report pending while never-settled nodes remain."""
        now=[0.0];calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid);now[0]+=0.04
            with ingest._lock:ingest._remember_settled((slug,nid),((),()))
            return True
        state=self.fake_state([str(i) for i in range(20)])
        results=[]
        with patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            for _ in range(8):
                results.append(ingest._sweep(state,clock=lambda:now[0]))
                if len(set(calls))==20 and results[-1] is False:
                    break
            self.assertEqual(len(set(calls)),20,'control: every node was caught up')
            first_idle=results.index(False)
            self.assertTrue(all(results[:first_idle]),results)
            self.assertEqual(len(set(calls[:4*first_idle])),20,'no idle pause before the last node settled')
            calls.clear()
            self.assertFalse(ingest._sweep(state,clock=lambda:now[0]),'all settled: idle cadence again')
            self.assertTrue(0 < len(calls) <= ingest.IDLE_CHECKS_PER_TICK)

    def test_catch_up_queued_behind_the_idle_check_cap_stays_pending(self):
        """F6: a tick that ends on the settled-check cap before reaching a
        never-settled node must still report pending."""
        seen=[str(i) for i in range(10)];unseen=[f'u{i}' for i in range(5)]
        calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid)
            with ingest._lock:ingest._remember_settled((slug,nid),((),()))
            return True
        state=self.fake_state(seen+unseen)
        state.settled_seen.update(('x',n) for n in seen)
        with patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            self.assertTrue(ingest._sweep(state,clock=lambda:0.0))
        self.assertEqual(calls,seen[:ingest.IDLE_CHECKS_PER_TICK],'control: the tick ended on the cap')

    def failing_sweeps(self,bad,seconds=120.0):
        """Real capture_safely and _sweep, driven like the worker loop (the
        pause after each tick is the one start() would sleep) for `seconds`
        of simulated time; `bad(nid)` decides which captures raise. Busy
        node 'busy' is captured by the once-per-second busy path too."""
        good=[str(i) for i in range(12)]
        state=self.fake_state(good+['bad'])
        raised=[];now=[0.0];results=[];logged=[0]
        def capture(slug,nid,**kw):
            now[0]+=0.001
            if bad(nid):
                raised.append(nid);raise RuntimeError('injected capture failure')
            with ingest._lock:ingest._remember_settled((slug,nid),((),()))
            return True
        per_tick=[]
        with patch.dict(sup._state,{('x','busy'):{'busy':True}},clear=True), \
             patch.object(ingest,'capture',side_effect=capture), \
             patch.object(ingest._log,'exception',side_effect=lambda *a,**k:logged.__setitem__(0,logged[0]+1)):
            while now[0]<seconds:
                before=len(raised)
                results.append(ingest._sweep(state,clock=lambda:now[0]))
                per_tick.append(len(raised)-before)
                now[0]+=ingest.PENDING_PAUSE_S if results[-1] else ingest.IDLE_PAUSE_S
        return results,per_tick,raised,logged[0]

    def backoff_attempts(self,seconds):
        """Attempts a node makes in `seconds` under the backoff schedule."""
        t,n,fails=0.0,0,0
        while t<seconds:
            n+=1;fails+=1;t+=min(ingest.BACKOFF_MAX_S,ingest.BACKOFF_BASE_S*2**(fails-1))
        return n

    def test_a_node_that_keeps_failing_backs_off_and_returns_to_the_idle_cadence(self):
        results,per_tick,raised,logged=self.failing_sweeps(lambda nid:nid=='bad')
        self.assertTrue(results[0],'control: healthy catch-up is pending')
        self.assertGreaterEqual(raised.count('bad'),3,'control: the failing node is really retried')
        self.assertLessEqual(raised.count('bad'),self.backoff_attempts(120.0)+1)
        self.assertEqual(logged,len(raised),'one log line per failed attempt')
        self.assertFalse(any(results[5:]),results)
        self.assertLessEqual(len(results),130,'wakeups stay at the idle cadence')

    def test_a_database_outage_backs_off_with_bounded_exceptions_and_wakeups(self):
        results,per_tick,raised,logged=self.failing_sweeps(lambda nid:True)
        nodes=len(set(raised))
        self.assertEqual(nodes,14,'control: every node, busy included, really failed')
        self.assertLessEqual(max(per_tick),ingest.IDLE_CHECKS_PER_TICK+1)
        self.assertLessEqual(len(raised),nodes*(self.backoff_attempts(120.0)+1),
                             'each node fails once per backoff step, not once per tick')
        self.assertEqual(logged,len(raised))
        self.assertFalse(any(results[5:]),results)
        self.assertLessEqual(len(results),130,'wakeups stay at the idle cadence')

    def test_busy_nodes_are_captured_once_per_second_however_short_the_pauses(self):
        calls=[];now=[0.0]
        state=self.fake_state([])
        with patch.dict(sup._state,{('x','busy'):{'busy':True}},clear=True), \
             patch.object(ingest,'capture_safely',side_effect=lambda s,n,**k:calls.append(n)):
            for step in (0.0,0.3,0.6,1.05,1.5,2.1):
                now[0]=step;ingest._sweep(state,clock=lambda:now[0])
        self.assertEqual(calls.count('busy'),3)

    def test_settled_rechecks_keep_the_old_idle_cadence(self):
        calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid)
            with ingest._lock:ingest._remember_settled((slug,nid),((),()))
            return True       # an evicted settled node: real check, still settled
        state=self.fake_state([str(i) for i in range(30)])
        state.settled_seen.update(state.active)   # all caught up earlier in this process
        with patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            self.assertFalse(ingest._sweep(state))
        self.assertEqual(len(calls),ingest.IDLE_CHECKS_PER_TICK)

    def test_active_nodes_are_seeded_before_discovery_reaches_them(self):
        rows=[(f'hist-{i:03d}','archived') for i in range(40)]+[(f'worker-{i:03d}','live') for i in range(5)]
        def page(slug,after='',limit=8):
            tail=[row for row in rows if row[0]>after]
            return {'rows':tail[:limit],'more':len(tail)>limit}
        active=[(f'worker-{i:03d}',i) for i in range(5)]
        pages=[]
        def active_page(slug,after=None,limit=256):
            pages.append(after)
            start=0 if after is None else next(i for i,r in enumerate(active) if (r[1],r[0])==after)+1
            chunk=active[start:start+2]
            return {'rows':chunk,'more':start+2<len(active)}
        captured=[]
        def fake(slug,nid,**kw):
            captured.append(nid)
            with ingest._lock:ingest._remember_settled((slug,nid),((),()))
            return True
        state=ingest._SweepState()
        with patch.object(store,'org_slugs',return_value=['x']), \
             patch.object(store,'read_transcript_nodes_page',side_effect=page), \
             patch.object(store,'read_active_transcript_nodes',side_effect=active_page), \
             patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            ingest._sweep(state)
        self.assertEqual(captured[:5],[f'worker-{i:03d}' for i in range(5)],'active first, before any hist-*')
        self.assertEqual(len(pages),3,'bounded pages of 2 cover 5 active ids')

    def test_partial_line_retry_and_same_size_replacement(self):
        self.write(0,3)
        self.backfill(); self.assertFalse(self.backfill())
        with self.path.open('a',encoding='utf8') as f:f.write('{"partial":')
        self.backfill()
        self.assertEqual(len(self.rows()),3)
        with self.path.open('a',encoding='utf8') as f:f.write('true}\n')
        self.backfill()
        self.assertEqual(len(self.rows()),4)
        old = self.path.stat()
        replacement = self.path.with_suffix('.replacement')
        replacement.write_bytes(self.path.read_bytes().replace(b'partial',b'replace'))
        os.utime(replacement, ns=(old.st_atime_ns, old.st_mtime_ns))
        replacement.replace(self.path)
        self.backfill()
        self.assertTrue(any('replace' in r[2] for r in self.rows()))

    def test_sidecar_backlog_is_not_mistaken_for_settled(self):
        self.write(0,2)
        slug=self.org.d['slug'];sid=self.org.node('agent')['session_id']
        vpath=Path(sup._prompt_view_path(slug,sid));vpath.parent.mkdir(parents=True,exist_ok=True)
        vpath.write_text(''.join(json.dumps({'sha256':str(i),'visible':str(i)})+'\n'
                                 for i in range(700)),encoding='utf8')
        self.assertEqual([self.backfill() for _ in range(4)],[True,True,True,False])
        vsource=records.views_source(slug,sid,records.incarnation(store.load_org(slug),'agent'))
        self.assertEqual(records.prompt_views_for(vsource,'699')[0]['visible'],'699')

    def test_failure_does_not_cache_an_unfinished_capture(self):
        self.write(0,10)
        with patch.object(records,'_insert',side_effect=RuntimeError('injected before commit')):
            with self.assertLogs(ingest._log,level='ERROR'):
                ingest.capture_safely(self.org.d['slug'],'agent',backfill=True)
        self.assertEqual(len(self.rows()),0)
        self.assertTrue(self.backfill())
        self.assertEqual(len(self.rows()),10)

    def test_unrelated_fresh_node_does_not_disable_settled_skip(self):
        self.write(0,3);self.backfill()
        with ingest._lock:ingest._fresh.add('unrelated-empty-session')
        try:self.assertFalse(self.backfill())
        finally:
            with ingest._lock:ingest._fresh.discard('unrelated-empty-session')

    def test_settled_files_still_recover_output_spooled_during_database_outage(self):
        self.write(0,3);self.backfill();self.assertFalse(self.backfill())
        sid='spool-'+self.org.d['slug']
        source=records.journal_source(self.org.d['slug'],sid)
        mirror=str(self.path.with_suffix('.recovered.jsonl'))
        with patch.object(records,'_commit_owned',side_effect=sqlite3.OperationalError('outage')):
            self.assertFalse(records.append_owned(self.org.d['slug'],sid,mirror,[{'text':'recover me'}]))
        # Do not use tail(): that reader drains the spool itself and would hide
        # a capture worker which skipped recovery along with unchanged files.
        with records.database() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM transcript_records WHERE source=?',
                                          (source,)).fetchone()[0],0)
        self.assertFalse(self.backfill())
        with records.database() as conn:
            rows=conn.execute('SELECT body FROM transcript_records WHERE source=?',(source,)).fetchall()
        self.assertEqual([json.loads(row[0])['text'] for row in rows],['recover me'])

    def test_source_projection_uses_existing_identity_without_whole_org(self):
        self.write(0, 4)
        slug = self.org.d['slug']
        expected = source_key(store.load_org(slug), 'agent')
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            view = ingest._source_view(slug, 'agent')
            self.assertEqual(source_key(view, 'agent'), expected)
            self.assertEqual(sup.transcript_path_for_node(view, 'agent'), str(self.path))
            self.assertTrue(ingest.capture(slug, 'agent', backfill=True))
        self.assertEqual(len(self.rows()), 4)

    def test_source_without_session_needs_no_whole_org_or_identity_mint(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        org.node('agent').pop('session_id', None)
        store.save_org(org)
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            self.assertFalse(ingest.capture(slug, 'agent', backfill=True))

    def test_source_projection_excludes_unrelated_payloads(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        org.node('agent')['charter'] = 'unrelated' * 10000
        store.save_org(org)
        doc = store.read_transcript_source(slug, 'agent')
        self.assertNotIn('charter', doc['nodes']['agent'])
        self.assertNotIn('work_items', doc)
        self.assertLess(len(json.dumps(doc)), 2000)

    # -- transcript-capture-source-view-falls-back-to-a-f --------------------
    # A node's first capture (no transcript/reply identity minted yet) used to
    # load the whole org; the bounded view now serves it, with identical output.

    @staticmethod
    def _old_source_view(slug, nid):
        """ingest._source_view as it was before the fix (v3 1232253)."""
        doc = store.read_transcript_source(slug, nid)
        if doc is not None:
            node = doc['nodes'][nid]
            if not node.get('session_id'):
                return ingest._SourceView(doc)
            if (doc.get('reply_incarnation') and node.get('transcript_incarnation')
                    and node.get('reply_incarnation') and node.get('model')
                    and node.get('session_id') and 'generation' in node):
                return ingest._SourceView(doc)
        return store.cached_org(slug)

    def _fresh_org(self):
        """A real-shaped org whose node has never been captured: no reply or
        transcript identity minted (a plain hire, as at N1000)."""
        org = store.create_org('fresh-' + uuid.uuid4().hex[:8])
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        org.node('agent')['charter'] = 'real-shaped payload ' * 200
        store.save_org(org)
        node = store.load_org(org.d['slug']).node('agent')
        self.assertTrue(node.get('session_id'), 'control: the node has a conversation')
        self.assertFalse(node.get('transcript_incarnation'), 'control: nothing minted yet')
        self.assertFalse(node.get('reply_incarnation'), 'control: nothing minted yet')
        return org.d['slug']

    def _capture_with(self, view, slug):
        whole = []
        original = store.cached_org
        def counted(value):
            whole.append(value)
            return original(value)
        with patch.object(ingest, '_source_view', view), \
             patch.object(store, 'cached_org', side_effect=counted):
            self.assertTrue(ingest.capture(slug, 'agent', backfill=True))
        org = store.load_org(slug)             # the whole-Org resolver, after the fact
        key = source_key(org, 'agent')
        rows = records.tail(key, 1000)[0]
        node = org.node('agent')
        return whole, key, [r[2] for r in rows], node, org.d.get('reply_incarnation')

    def test_first_capture_is_identical_on_the_bounded_view(self):
        self.write(0, 6)
        slug_old, slug_new = self._fresh_org(), self._fresh_org()
        whole_old, key_old, bodies_old, node_old, org_old = self._capture_with(
            self._old_source_view, slug_old)
        whole_new, key_new, bodies_new, node_new, org_new = self._capture_with(
            ingest._source_view, slug_new)
        self.assertTrue(whole_old, 'control: the old path loaded the whole org')
        self.assertEqual(whole_new, [], 'the bounded view needs no whole Org')
        self.assertEqual(len(bodies_old), 6)
        self.assertEqual(bodies_new, bodies_old)
        for node, org_id, key in ((node_old, org_old, key_old), (node_new, org_new, key_new)):
            # captured under the identity the whole-Org resolver computes, and
            # that identity is the persisted reply ids, minted once
            self.assertEqual(node['transcript_incarnation'], org_id + ':' + node['reply_incarnation'])
            self.assertEqual(json.loads(key), [node['transcript_incarnation'], node['session_id'], False])

    def test_an_unminted_node_is_captured_without_any_whole_org_load(self):
        self.write(0, 3)
        slug = self._fresh_org()
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            self.assertTrue(ingest.capture(slug, 'agent', backfill=True))
            self.assertTrue(ingest.capture(slug, 'agent'))
        self.assertEqual(len(records.tail(source_key(store.load_org(slug), 'agent'), 1000)[0]), 3)

    def test_source_projection_missing_identity_stays_bounded(self):
        # was ..._uses_legacy_resolution: a view missing an identity field
        # fell back to cached_org; it is now served as is (mints use it)
        slug = self.org.d['slug']
        doc = store.read_transcript_source(slug, 'agent')
        doc['nodes']['agent'].pop('transcript_incarnation', None)
        with patch.object(store, 'read_transcript_source', return_value=doc), \
             patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            view = ingest._source_view(slug, 'agent')
        self.assertEqual(view.node('agent')['session_id'], self.org.node('agent')['session_id'])
        self.assertNotIn('transcript_incarnation', view.node('agent'))

    def test_a_missing_node_is_nothing_to_capture(self):
        # before: a whole-org load, then KeyError -> capture failure and retry
        slug = self.org.d['slug']
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            self.assertIsNone(ingest._source_view(slug, 'no-such-node'))
            self.assertFalse(ingest.capture(slug, 'no-such-node', backfill=True))
            self.assertFalse(ingest.capture_safely(slug, 'no-such-node'))

    def test_a_root_the_bounded_read_cannot_answer_still_uses_the_whole_org(self):
        # the JSON backend, or `nodes` stored as one blob: read_transcript_source
        # and node_row_exists both answer None
        slug = self.org.d['slug']
        calls = []
        original = store.cached_org
        def legacy(value):
            calls.append(value)
            return original(value)
        with patch.object(store, 'read_transcript_source', return_value=None), \
             patch.object(store, 'node_row_exists', return_value=None), \
             patch.object(store, 'cached_org', side_effect=legacy):
            view = ingest._source_view(slug, 'agent')
        self.assertEqual(calls, [slug])
        self.assertEqual(view.node('agent')['session_id'], self.org.node('agent')['session_id'])

    def test_source_projection_preserves_sandbox_and_bound_account(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        org.d['sandbox'] = {'enabled': True, 'secret': 'test-only'}
        org.node('agent')['account'] = 'missing-profile-test-only'
        store.save_org(org)
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
            view = ingest._source_view(slug, 'agent')
            self.assertEqual(sup._transcript_root(view, 'agent'),
                             sup._transcript_root(org, 'agent'))
            self.assertEqual(view.node('agent')['account'], 'missing-profile-test-only')

    def test_archived_discovery_is_bounded_and_not_in_hot_queue(self):
        rows = [(f'old{i:04d}', 'archived') for i in range(80)]
        rows.append(('zlive', 'live'))
        selected = []
        def page(slug, after='', limit=8):
            tail = [row for row in rows if row[0] > after]
            selected.append(tail[:limit])
            return {'rows': tail[:limit], 'more': len(tail) > limit}
        state = ingest._SweepState()
        calls = []
        now = [0.0]
        with patch.object(store, 'org_slugs', return_value=['x']), \
             patch.object(store, 'read_transcript_nodes_page', side_effect=page), \
             patch.dict(sup._state, {('x','busy'): {'busy': True}}, clear=True), \
             patch.object(ingest, 'capture_safely', side_effect=lambda s,n,**k: calls.append((n,k))):
            for _ in range(11):
                ingest._sweep(state, clock=lambda: now[0])
                now[0] += 1.0
        self.assertEqual(sum(len(batch) for batch in selected), 81)
        self.assertTrue(all(len(batch) <= 8 for batch in selected))
        self.assertEqual(list(state.active), [('x', 'zlive')])
        self.assertFalse(any(n.startswith('old') for _,n in state.hot))
        self.assertEqual(sum(n=='busy' for n,k in calls), 11)
        self.assertEqual(sum(n.startswith('old') for n,k in calls), 80)

    def test_discovery_exact_page_wrap_and_deleted_org_prunes_active(self):
        state = ingest._SweepState()
        rows = [(str(i), 'live') for i in range(8)]
        with patch.object(store, 'org_slugs', return_value=['x']), \
             patch.object(store, 'read_transcript_nodes_page', return_value={'rows': rows, 'more': False}):
            state.discover()
            self.assertFalse(state.orgs, 'exact page must not cost an empty tick')
        with patch.object(store, 'org_slugs', return_value=[]):
            state.discover()
        self.assertEqual(len(state.active), 0)

    def test_settled_cache_is_bounded_and_evicted_source_still_detects_replacement(self):
        self.write(0, 3)
        self.backfill()
        with ingest._lock:
            for i in range(ingest._SETTLED_LIMIT + 3):
                ingest._remember_settled(('other',str(i)), ((),()))
            self.assertEqual(len(ingest._settled), ingest._SETTLED_LIMIT)
            self.assertNotIn((self.org.d['slug'],'agent'), ingest._settled)
        original = self.path.stat()
        replacement = self.path.with_suffix('.changed')
        replacement.write_bytes(self.path.read_bytes().replace(b'"0"', b'"X"'))
        os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
        replacement.replace(self.path)
        self.assertTrue(self.backfill())
        self.assertTrue(any('X' in row[2] for row in self.rows()))

    def test_projection_keeps_explicit_null_metadata_distinct_from_absent(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        org.node('agent')['desktop_import'] = None
        store.save_org(org)
        doc = store.read_transcript_source(slug, 'agent')
        self.assertIn('desktop_import', doc['nodes']['agent'])
        self.assertIsNone(doc['nodes']['agent']['desktop_import'])

    def test_archived_reconciliation_imports_new_records_without_ui_or_hot_queue(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        org.node('agent')['state'] = 'archived'
        store.save_org(org)
        self.write(0, 3)
        state = ingest._SweepState()
        with patch.object(store, 'org_slugs', return_value=[slug]), \
             patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')), \
             patch.dict(sup._state, {}, clear=True):
            ingest._sweep(state)
            self.assertFalse(state.active)
            self.assertFalse(state.hot)
            with patch.object(records, 'ingest', side_effect=AssertionError('settled source reread')):
                ingest._sweep(state)
            self.write(3, 2, 'a')
            ingest._sweep(state)
        self.assertEqual(len(self.rows()), 5)
        self.assertTrue(any('4' in row[2] for row in self.rows()))

    def test_evicted_unchanged_source_does_not_count_lifetime_records(self):
        import contextlib
        self.write(0, 40)
        self.backfill()
        with ingest._lock:
            ingest._settled.pop((self.org.d['slug'], 'agent'), None)
        statements = []
        original = records.database
        class Proxy:
            def __init__(self, conn): self.conn = conn
            def execute(self, sql, *args):
                statements.append(sql)
                return self.conn.execute(sql, *args)
            def __getattr__(self, name): return getattr(self.conn, name)
        @contextlib.contextmanager
        def observed():
            with original() as conn:
                yield Proxy(conn)
        with patch.object(records, 'database', observed):
            self.backfill()
        self.assertTrue(statements, 'negative control must execute database reads')
        self.assertFalse(any('COUNT(*) FROM transcript_records' in sql for sql in statements))
        self.assertEqual(len(self.rows()), 40)

    def test_source_projection_observes_new_committed_identity_despite_cached_org(self):
        slug = self.org.d['slug']
        old = store.cached_org(slug)
        org = store.load_org(slug)
        org.node('agent')['session_id'] = 'changed-session'
        org.node('agent')['transcript_incarnation'] = 'changed-incarnation'
        store.save_org(org)
        with patch.object(store, 'cached_org', return_value=old):
            view = ingest._source_view(slug, 'agent')
        self.assertEqual(view.node('agent')['session_id'], 'changed-session')
        self.assertEqual(records.incarnation(view, 'agent'), 'changed-incarnation')

    def test_disappearing_org_mid_page_does_not_starve_later_org(self):
        slug = self.org.d['slug']
        org = store.load_org(slug)
        for i in range(12):
            node = dict(org.node('agent'));node.update(id=f'old{i:02d}', state='archived')
            org.d['nodes'][node['id']] = node
        store.save_org(org)
        later = store.create_org('later-'+uuid.uuid4().hex[:8])
        later.hire(ledger.USER,None,'haiku',0,'later-agent');store.save_org(later)
        state = ingest._SweepState()
        with patch.object(store,'org_slugs',return_value=[slug,later.d['slug']]):
            state.discover()
            self.assertEqual(state.orgs[0],slug)
            store.delete_org(slug)
            state.discover()
        self.assertIn((later.d['slug'],'later-agent'),state.active)
        self.assertNotIn(slug,state.orgs)
        with patch.object(store,'org_slugs',return_value=[later.d['slug']]):
            state.discover()
        self.assertFalse(any(key[0]==slug for key in state.active))

    def test_transient_org_discovery_failure_retries_next_round(self):
        state=ingest._SweepState();failed=[]
        def page(slug,after='',limit=8):
            if slug=='x' and not failed:
                failed.append(slug);raise OSError('temporary unreadable org')
            return {'rows':[(slug+'-agent','live')],'more':False}
        with patch.object(store,'org_slugs',return_value=['x','y']), \
             patch.object(store,'read_transcript_nodes_page',side_effect=page):
            state.discover()
            self.assertIn(('y','y-agent'),state.active)
            state.discover()
        self.assertEqual(set(state.active),{('x','x-agent'),('y','y-agent')})

    def test_unread_suffix_retries_without_another_file_change(self):
        import builtins
        self.write(0,3);self.backfill();self.assertFalse(self.backfill())
        self.write(3,2,'a')
        real_open=builtins.open
        attempts=[]
        def temporarily_unreadable(filename,*args,**kwargs):
            if str(filename)==str(self.path):
                attempts.append(str(filename))
                raise FileNotFoundError('provider temporarily moved the file after stat')
            return real_open(filename,*args,**kwargs)
        # stat succeeds, but ingest cannot open the changed file. Its existing
        # FileNotFoundError path returns without advancing upper_byte (lower is0).
        with patch.object(builtins,'open',side_effect=temporarily_unreadable):
            self.assertTrue(self.backfill())
        self.assertTrue(attempts,'control: the failed read really occurred')
        self.assertEqual(len(self.rows()),3)
        # The file now stays byte-for-byte and stat-for-stat unchanged. Only
        # the upper-byte check prevents the first failed pass being cached.
        self.assertTrue(self.backfill())
        self.assertEqual(len(self.rows()),5)
        self.assertFalse(self.backfill())

    # ---- transcript-capture-loops-on-imported-agents-and (rehearsal 2) ----
    def test_imported_agent_history_is_captured_once_on_every_backend(self):
        """An imported agent's history file (desktop_import.history) used to
        refuse on PostgreSQL with "V2 copy import requires the SQLite backend"
        on every backfill, retried for ever. It is a read-only path lookup."""
        slug=self.org.d['slug'];rel=f'imports/{slug}/history.jsonl'
        hist=Path(store.DATA_ROOT)/rel;hist.parent.mkdir(parents=True,exist_ok=True)
        with hist.open('w',encoding='utf8') as stream:
            for i in range(30):stream.write(json.dumps({'type':'assistant','message':{'content':f'h{i}'}})+'\n')
        org=store.load_org(slug);org.node('agent')['desktop_import']={'history':rel};store.save_org(org)
        imported=lambda:records.tail(source_key(store.load_org(slug),'agent',True),1000)[0]
        with patch.object(ingest._log,'exception',side_effect=AssertionError('capture failed')):
            self.assertTrue(self.backfill())
            self.assertFalse(self.backfill(),'settled after one pass: no retry loop')
        self.assertEqual(len(imported()),30)
        self.assertEqual(len({(r[0],r[1]) for r in imported()}),30,'no duplicated rows')

    def test_worker_stops_before_the_database_at_exit(self):
        """launch.py registers the database stop (atexit) before the API
        starts this worker; atexit runs hooks last-in first-out. The worker
        used to keep capturing while PostgreSQL shut down: one traceback per
        capture (rehearsal 2: 216). Now its own hook stops it first."""
        import atexit, threading
        hooks=[];down=threading.Event();logged=[]
        def failing(*a,**k):raise RuntimeError('the database system is shutting down')
        def database_stop():
            down.set()
            with patch.object(store,'read_transcript_nodes_page',failing), \
                 patch.object(store,'read_active_transcript_nodes',failing), \
                 patch.object(store,'read_transcript_source',failing), \
                 patch.object(store,'org_slugs',failing):
                threading.Event().wait(0.5)   # pg_ctl stop takes a while
        def log(*a,**k):
            if down.is_set():logged.append(a[0] if a else '')
        self.write(0,5)
        hooks.append((database_stop,()))
        self.addCleanup(lambda:getattr(ingest,'_stop',threading.Event()).clear())
        with patch.object(atexit,'register',side_effect=lambda f,*a:hooks.append((f,a))), \
             patch.object(ingest,'_started',False), \
             patch.object(ingest,'IDLE_PAUSE_S',0.01),patch.object(ingest,'PENDING_PAUSE_S',0.01), \
             patch.object(ingest._log,'exception',side_effect=log):
            ingest.start()
            deadline=threading.Event()
            for _ in range(200):
                if self.rows():break
                deadline.wait(0.02)
            self.assertEqual(len(self.rows()),5,'control: the worker really captured')
            for f,a in reversed(hooks):f(*a)
        self.assertTrue(down.is_set(),'control: the database stop ran')
        self.assertEqual(logged,[],'no capture or discovery failure while the database stops')
        self.assertGreater(len(hooks),1,'the worker registered its own exit hook')
        self.assertTrue(ingest.stop(1.0),'worker thread gone')

    def busy_exit(self,raises):
        """The rehearsal case: the worker is INSIDE a capture when the exit
        hooks run. The first capture blocks until stop is requested, then
        returns (or raises, as a capture does once PostgreSQL goes away)."""
        import atexit, threading
        slug=self.org.d['slug'];org=store.load_org(slug)
        for n in range(4):org.hire(ledger.USER,None,'haiku',0,f'extra{n}')
        store.save_org(org)
        hooks=[];entered=threading.Event();release=threading.Event();seen={}
        calls=[];logged=[]
        def blocking(*key,**kw):
            calls.append(ingest._stop.is_set())
            if not entered.is_set():
                entered.set();release.wait(5)
                if raises:raise RuntimeError('the database system is shutting down')
            return True
        def database_stop():
            seen['worker_alive_at_database_stop']=ingest._thread.is_alive()
        def log(*a,**k):
            if ingest._stop.is_set():logged.append(a[0] if a else '')
        def run_hooks():
            for f,a in reversed(hooks):f(*a)
        hooks.append((database_stop,()))
        self.addCleanup(lambda:getattr(ingest,'_stop',threading.Event()).clear())
        with patch.object(atexit,'register',side_effect=lambda f,*a:hooks.append((f,a))), \
             patch.object(ingest,'_started',False), \
             patch.object(ingest,'capture_safely',side_effect=blocking), \
             patch.object(ingest,'WORK_BUDGET_S',30.0), \
             patch.object(ingest,'IDLE_PAUSE_S',0.01),patch.object(ingest,'PENDING_PAUSE_S',0.01), \
             patch.object(ingest._log,'exception',side_effect=log):
            ingest.start()
            self.assertTrue(entered.wait(5),'control: the worker entered a capture')
            exiting=threading.Thread(target=run_hooks);exiting.start()
            for _ in range(500):
                if ingest._stop.is_set():break
                threading.Event().wait(0.01)
            threading.Event().wait(0.1)      # the stop hook is now waiting on the worker
            release.set();exiting.join(15)
        self.assertFalse(exiting.is_alive())
        self.assertIn('worker_alive_at_database_stop',seen,'control: the database stop ran')
        self.assertFalse(seen['worker_alive_at_database_stop'],'the stop hook waited for the busy worker')
        self.assertNotIn(True,calls,'no capture starts after stop was requested')
        self.assertEqual(logged,[],'nothing logged once stop was requested')

    def test_busy_worker_finishes_its_capture_before_the_database_stops(self):
        self.busy_exit(raises=False)

    def test_busy_worker_failing_after_stop_leaves_quietly(self):
        self.busy_exit(raises=True)

if __name__=='__main__':unittest.main()
