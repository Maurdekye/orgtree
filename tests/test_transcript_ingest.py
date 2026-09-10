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

if __name__=='__main__':unittest.main()
