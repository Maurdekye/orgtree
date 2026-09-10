"""Projected typed mail retires its pending copy by identity, never by body."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-chat-pending-id-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import api, events, store, supervisor
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()

def mail(mid):
    return {'id':mid, 'from':'@user', 'kind':'message', 'at':'2026-09-10T23:00:00Z', 'body':'continue',
        'ev':{'v':1,'variant':'ordinary.message','actor':{'kind':'user','id':'@user'},
              'object':None,'engine_authored':False,'body':'continue'}}

class PendingIdentityTests(unittest.TestCase):
    def read(self, messages, in_delivery=False):
        rows=[mail('delivered'),mail('next-identical')]
        org=SimpleNamespace(d={'mail':{'agent':[] if in_delivery else rows}},node=lambda nid: {'session_id':'test'})
        out={'messages':messages,'busy':True,'live':[]}
        with patch.object(store,'load_org',return_value=org), \
             patch.object(supervisor,'_transcript_incarnation',return_value='scope'), \
             patch.object(supervisor,'read_chat',return_value=out), \
             patch.object(supervisor,'delivering_mail',side_effect=lambda org,nid,visible: [r for r in rows if not visible(r)] if in_delivery else []):
            return api.node_chat('test','agent')

    def test_projected_body_uses_identity_and_keeps_repeated_send(self):
        self.assertEqual(events.decode(mail('delivered')['ev'],mail('delivered'))['status'],'ok')
        self.assertEqual(len(self.read([])['pending_mail']),2)
        out=self.read([{'role':'user','text':'continue','segments':[{'kind':'mail','rows':[mail('delivered')]}]}])
        self.assertEqual([r['id'] for r in out['pending_mail']],['next-identical'])
        self.assertEqual(out['mail_pending'],1)
        delivered=self.read([{'role':'user','text':'continue','segments':[{'kind':'mail','rows':[mail('delivered')]}]}], in_delivery=True)
        self.assertEqual([r['id'] for r in delivered['pending_mail']],['next-identical'])

    def test_legacy_transport_marker_still_retires_legacy_pending(self):
        out=self.read([{'role':'user','text':'FROM @user (user) \u00b7 message \u00b7 2026-09-10T23:00:00Z\ncontinue'}])
        self.assertEqual(out['pending_mail'],[])

    def test_untyped_or_invalid_row_does_not_claim_delivery(self):
        for value in (None, {'v':999}):
            row=mail('delivered'); row['ev']=value
            out=self.read([{'role':'user','text':'continue','segments':[{'kind':'mail','rows':[row]}]}])
            self.assertEqual(len(out['pending_mail']),2)

if __name__ == '__main__': unittest.main()
