"""Record actual compact process construction without launching a provider."""
import os
import json
import uuid
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-fork-profile-')
os.environ.update(ORGTREE_DATA=_root.name,HOME=_root.name,USERPROFILE=_root.name)
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'/'backend'))
from orgtree import store, ledger, supervisor, desktop_native

def tearDownModule():
    store._POOL.close_all('fork-profile')
    _root.cleanup()

class ForkProfileTests(unittest.TestCase):
    def test_compact_dependency_refusal_preserves_in_memory_ledger(self):
        org=ledger.Org.create('atomic-split')
        org.hire(ledger.USER,None,'haiku',0,'worker')
        org.node('worker')['desktop_import']={'native_continuity':{'status':'ready'}}
        before=copy.deepcopy(org.d)
        with patch.object(ledger.Org,'_retire_native_import',side_effect=ledger.LedgerError('backup differs')):
            with self.assertRaisesRegex(ledger.LedgerError,'backup differs'):
                org.compact_split('worker',str(uuid.uuid4()))
        self.assertEqual(org.d,before)
        with patch.object(ledger.Org,'_retire_native_import'):
            predecessor=org.compact_split('worker',str(uuid.uuid4()))
        self.assertIn(predecessor,org.nodes)
        self.assertEqual(org.node('worker')['generation'],1)

    def test_actual_bearer_writer_rebinds_native_session_and_preserves_source(self):
        org = ledger.Org.create('bearer-writer')
        org.hire(ledger.USER,None,'haiku',0,'worker')
        node=org.node('worker')
        node['desktop_import']={'native_continuity':{'status':'ready'}}
        sid=node['session_id']
        from orgtree import desktop_native_claude_rewind as rewind
        profile=Path(_root.name)/'bearer-profile'
        backups=profile/'file-history'/sid
        backups.mkdir(parents=True)
        backup='a'*16+'@v1'
        (backups/backup).write_bytes(b'original backup')
        node['desktop_import']['native_continuity'].update(
            session_id=sid,provider='claude',rewind={
                'session_id':sid,'profile':str(profile),'files':[backup]})
        source=Path(_root.name)/'bearer-source.jsonl'
        rid=str(uuid.uuid4())
        row={'type':'user','uuid':rid,'parentUuid':None,'sessionId':sid,
             'timestamp':'2026-09-08T00:00:00Z','message':{'role':'user','content':'preserve'}}
        original=(json.dumps(row)+'\n').encode()
        source.write_bytes(original)
        with patch.object(supervisor,'transcript_path',return_value=source):
            new_sid=supervisor._fork_bearer_session(org,sid,1)
        self.assertIsNotNone(new_sid)
        clone=json.loads((source.parent/f'{new_sid}.jsonl').read_text())
        self.assertEqual(clone['sessionId'],new_sid)
        self.assertEqual(clone['uuid'],rid)
        self.assertEqual(clone['message'],row['message'])
        self.assertEqual(source.read_bytes(),original)
        desktop_native.claude_records([clone],new_sid,new_sid,'validation')
        clone_path=source.parent/f'{new_sid}.jsonl'
        with patch.object(supervisor,'transcript_path',return_value=clone_path), \
             patch.object(rewind,'selected_profile',return_value=profile):
            predecessor=org.record_cli_compaction('worker',bearer_sid=new_sid,boundary_offset=1)
        self.assertEqual(org.node(predecessor)['desktop_import']['native_continuity']['rewind']['session_id'],new_sid)
        self.assertEqual((profile/'file-history'/new_sid/backup).read_bytes(),b'original backup')
        self.assertEqual((backups/backup).read_bytes(),b'original backup')
        self.assertEqual(source.read_bytes(),original)

    def test_actual_compact_uses_imported_resume_and_node_environment(self):
        org = store.create_org('fork-profile')
        org.hire(ledger.USER,None,'haiku',0,'worker')
        org.node('worker')['desktop_import']={'native_continuity':{'status':'ready'}}
        store.save_org(org)
        selected = str(Path(_root.name)/'selected-profile')
        native = str(Path(_root.name)/'independent.jsonl')
        calls=[]
        def environment(org, tier=None, nid=None):
            return {'CLAUDE_CONFIG_DIR':selected if nid=='worker' else 'wrong-ambient'}
        def process(argv, **kwargs):
            calls.append((argv,kwargs))
            raise OSError('recorder stops before provider')
        with patch.object(supervisor,'spawn_env',side_effect=environment), \
             patch.object(supervisor,'_native_context_hold',return_value=None), \
             patch.object(desktop_native,'native_session_path',return_value=native), \
             patch.object(supervisor,'_claude_argv',return_value=['claude']), \
             patch.object(supervisor.subprocess,'Popen',side_effect=process):
            supervisor._compact_split_body('fork-profile','worker')
            self.assertEqual(len(calls),1)
            argv, kwargs = calls[0]
            self.assertEqual(argv[argv.index('--resume')+1],native)
            self.assertEqual(kwargs['env']['CLAUDE_CONFIG_DIR'],selected)
            with patch.object(supervisor,'_native_context_hold',return_value='rewind profile changed'):
                supervisor._compact_split_body('fork-profile','worker')
            self.assertEqual(len(calls),1)
            self.assertIn('rewind profile changed',supervisor.state('fork-profile','worker')['last_error'])
            org.node('worker').pop('desktop_import')
            store.save_org(org)
            supervisor._compact_split_body('fork-profile','worker')
            self.assertEqual(len(calls),2)
            self.assertEqual(calls[-1][0][calls[-1][0].index('--resume')+1],org.node('worker')['session_id'])
            self.assertEqual(calls[-1][1]['env']['CLAUDE_CONFIG_DIR'],'wrong-ambient')

if __name__=='__main__': unittest.main()
