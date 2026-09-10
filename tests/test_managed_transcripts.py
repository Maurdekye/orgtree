import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

fixture=tempfile.TemporaryDirectory(prefix='orgtree-managed-transcripts-')
os.environ['ORGTREE_DATA']=str(Path(fixture.name)/'data')
os.environ['HOME']=str(Path(fixture.name)/'home')
os.environ['USERPROFILE']=os.environ['HOME']
from engine.backend.orgtree import ledger,registry,store,supervisor as sup
assert str(store.DATA_ROOT)==os.environ['ORGTREE_DATA']

class ManagedTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.org=ledger.Org.create('profile-test-'+uuid.uuid4().hex[:6])
        self.org.hire(ledger.USER,None,'fable',0,'agent')
        self.profile=Path(fixture.name)/uuid.uuid4().hex
        row=registry.create_account('claude','secondary',{'kind':'managed','path':str(self.profile)})
        self.org.node('agent')['account']=row['id']
        self.sid=self.org.node('agent')['session_id']
        self.path=self.write(self.profile,'managed transcript')
        self.ambient=self.write(Path(os.environ['HOME'])/'.claude','wrong ambient transcript')
    def write(self,root,text):
        p=root/'projects'/'fixture'/(self.sid+'.jsonl');p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps({'type':'assistant','uuid':uuid.uuid4().hex,'timestamp':'2026-09-10T16:00:00Z','message':{'role':'assistant','content':text}})+'\n',encoding='utf8')
        return p
    def test_lookup_and_both_chat_readers_use_bound_profile(self):
        self.assertEqual(sup.transcript_path_for_node(self.org,'agent'),str(self.path))
        for reader in [sup._read_chat_uncached,sup._read_chat_current]:
            rows=reader(self.org,'agent')['messages']
            self.assertEqual([r.get('text') for r in rows],['managed transcript'])
        with patch.object(sup,'_transcript_root',return_value=None):
            self.assertEqual(Path(sup.transcript_path_for_node(self.org,'agent')),self.ambient,'wrong-account positive control')
    def test_startup_evidence_and_session_operations_find_profile(self):
        self.ambient.unlink()
        self.assertEqual(sup._transcript_evidence(self.org)[self.sid],str(self.path))
        self.assertEqual(sup._transcript_root(self.org,session_id=self.sid),str(self.profile))
        self.assertEqual(sup._count_cli_compactions(self.org,'agent')[0],0)
    def test_missing_bound_session_does_not_read_other_account(self):
        self.path.unlink()
        self.assertIsNone(sup.transcript_path_for_node(self.org,'agent'))
        self.assertEqual(sup._read_chat_current(self.org,'agent')['messages'],[])

if __name__=='__main__':unittest.main()
