"""Record actual compact process construction without launching a provider."""
import os
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
