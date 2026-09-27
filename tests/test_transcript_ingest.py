"""Capture without a chat read, including failed turns and background backfill."""
import json
import os
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
    def write(self,start,count,mode='w'):
        with self.path.open(mode,encoding='utf8') as stream:
            for i in range(start,start+count):stream.write(json.dumps({'type':'assistant','message':{'content':str(i)}})+'\n')
    def rows(self):
        return records.tail(source_key(store.load_org(self.org.d['slug']),'agent'),1000)[0]
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
        self.write(0,180)
        ingest.capture(self.org.d['slug'],'agent',beginning=True)
        self.assertEqual(len(self.rows()),1,'admission must not import the entire old transcript')
        self.write(180,20,'a')
        ingest.capture(self.org.d['slug'],'agent')
        self.assertEqual(len(self.rows()),21)
        ingest.capture(self.org.d['slug'],'agent',backfill=True)
        self.assertEqual(len(self.rows()),85)
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
             patch.object(records,'ingest_prompt_views',side_effect=AssertionError('re-read unchanged views')):
            self.assertFalse(self.backfill())
        self.write(10,5,'a')
        self.assertTrue(self.backfill())
        self.assertEqual(len(self.rows()),15)
        self.assertFalse(self.backfill())
    def test_pending_history_keeps_the_node_unsettled(self):
        self.write(0,200)
        self.assertEqual([self.backfill() for _ in range(5)],[True,True,True,True,False])
        self.assertEqual(len(self.rows()),200)
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
    def test_an_idle_cycle_pauses_backfill_but_never_busy_capture(self):
        import collections
        from types import SimpleNamespace
        calls=[]
        def fake(slug,nid,**kw):
            calls.append((nid,bool(kw.get('backfill'))));return False
        queue,state=collections.deque(),{}
        with patch.object(store,'cached_list',return_value=[{'slug':'x'}]), \
             patch.object(store,'cached_org',return_value=SimpleNamespace(nodes=['a','b','c'])), \
             patch.dict(sup._state,{('x','busy'):{'busy':True}},clear=True), \
             patch.object(ingest,'capture_safely',side_effect=fake):
            ingest._sweep(queue,state,0.0)          # first cycle: 3 slices, no work
            self.assertEqual(calls,[('busy',False),('a',True),('b',True),('c',True)]);calls.clear()
            ingest._sweep(queue,state,1.0)          # idle cycle seen: backfill pauses
            self.assertEqual(calls,[('busy',False)]);calls.clear()
            ingest._sweep(queue,state,1.0+ingest.BACKOFF_S-0.5)
            self.assertEqual(calls,[('busy',False)]);calls.clear()
            ingest._sweep(queue,state,1.0+ingest.BACKOFF_S)
            self.assertEqual(calls,[('busy',False),('a',True),('b',True),('c',True)])
    def test_a_cycle_that_worked_does_not_pause(self):
        import collections
        from types import SimpleNamespace
        calls=[]
        def fake(slug,nid,**kw):
            calls.append(nid);return nid=='b'
        queue,state=collections.deque(),{}
        with patch.object(store,'cached_list',return_value=[{'slug':'x'}]), \
             patch.object(store,'cached_org',return_value=SimpleNamespace(nodes=['a','b','c'])), \
             patch.dict(sup._state,{},clear=True), patch.object(ingest,'capture_safely',side_effect=fake):
            ingest._sweep(queue,state,0.0);ingest._sweep(queue,state,1.0)
        self.assertEqual(calls,['a','b','c','a','b','c'])

if __name__=='__main__':unittest.main()
