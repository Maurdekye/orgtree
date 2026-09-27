"""Actual PG checks for selected pre-slot and image-preload inputs."""
import copy
import threading
import unittest
import uuid
from contextlib import ExitStack
from unittest.mock import patch
import test_pgstore as f
from orgtree import halt, identity_context, ledger, orgtx, store, turn_inputs
from orgtree import supervisor as sup
from tools.scale.simulated import SimulatedProvider

def tearDownModule(): f.tearDownModule()

@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class TurnInputsPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    def setUp(self):
        org=store.create_org('turn-input-'+uuid.uuid4().hex[:10])
        org.hire(ledger.USER,None,'luna',0,'worker')
        org.hire(ledger.USER,None,'luna',0,'other')
        org.node('worker')['session_id']=str(uuid.uuid4())
        self.message=org.post_mail(ledger.USER,'worker','selected image preload mail')
        org.post_mail(ledger.USER,'other','must not fetch this box')
        store.save_org(org); self.slug=org.d['slug']

    def test_selected_node_and_mail_match_full_without_other_boxes(self):
        full=store.load_runtime_org(self.slug)
        with patch.object(store,'load_runtime_org',side_effect=AssertionError('full reader')):
            view=turn_inputs.load(self.slug,'worker',mail=True)
        self.assertIsInstance(view,identity_context.IdentityContext)
        self.assertEqual(view.node('worker'),full.node('worker'))
        self.assertEqual(view.d['mail'],{'worker':full.d['mail']['worker']})
        self.assertNotIn('mail',turn_inputs.load(self.slug,'worker').d)
        with self.assertRaises(Exception): store.save_org(view)

    def test_mail_and_node_share_snapshot_across_commit(self):
        old=identity_context._read
        def crossed(raw,slug,nid):
            context=old(raw,slug,nid)
            errors=[]
            def commit():
                try:
                    with orgtx.org_tx(slug,whole=True) as tx:
                        org=tx.org
                        org.node('worker')['charter']='new charter'
                        org.post_mail(ledger.USER,'worker','new committed mail')
                except Exception as exc: errors.append(exc)
            thread=threading.Thread(target=commit);thread.start();thread.join(10)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            return context
        with patch.object(identity_context,'_read',side_effect=crossed):
            first=turn_inputs.load(self.slug,'worker',mail=True)
        second=turn_inputs.load(self.slug,'worker',mail=True)
        self.assertNotEqual(first.node('worker').get('charter'),'new charter')
        self.assertEqual(len(first.d['mail']['worker']),1)
        self.assertEqual(second.node('worker')['charter'],'new charter')
        self.assertEqual(len(second.d['mail']['worker']),2)

    def test_pinned_and_legacy_keep_runtime_compatibility(self):
        full=store.load_runtime_org(self.slug)
        with patch.object(store._orgtx_local,'pinned',{self.slug:object()},create=True), patch.object(store,'load_runtime_org',return_value=full) as fallback:
            self.assertIs(turn_inputs.load(self.slug,'worker',mail=True),full)
            fallback.assert_called_once_with(self.slug)
        with orgtx.org_tx(self.slug,whole=True) as tx: tx.org.node('worker')['cheap_compacted']=True
        with patch.object(store,'load_runtime_org',wraps=store.load_runtime_org) as fallback:
            self.assertNotIsInstance(turn_inputs.load(self.slug,'worker',mail=True),identity_context.IdentityContext)
            fallback.assert_called_once_with(self.slug)

    def test_real_turn_uses_both_selected_reads_and_commits_mail_consumption(self):
        adapter=SimulatedProvider(sup,halt,slug=self.slug,nodes=['worker'],seconds=0)
        calls=[]; original=turn_inputs.load
        def observed(slug,nid,**kw):
            view=original(slug,nid,**kw)
            self.assertIsInstance(view,identity_context.IdentityContext)
            calls.append(bool(kw.get('mail')))
            return view
        with ExitStack() as stack:
            for owner,name,value in [(sup,'_codex_leg',adapter),(sup,'_after_turn',adapter.finish)]:
                stack.enter_context(patch.object(owner,name,value))
            stack.enter_context(patch.object(sup,'spawn_env',return_value={}))
            stack.enter_context(patch.object(sup,'_deployment_org_gate'))
            stack.enter_context(patch.object(sup.subprocess,'Popen',side_effect=AssertionError('provider forbidden')))
            stack.enter_context(patch.object(turn_inputs,'load',side_effect=observed))
            sup._run_one_turn(self.slug,'worker',sup._mark_ping('mail',mail_ids=[self.message['id']]))
        counters=adapter.snapshot()
        self.assertEqual(counters['started'],1);self.assertEqual(counters['completed'],1)
        self.assertEqual(counters['booked'],1);self.assertEqual(counters['failed_bookings'],0)
        self.assertIn(False,calls);self.assertIn(True,calls)
        saved=orgtx.org_read(self.slug)
        self.assertFalse(saved.d['mail'].get('worker'))
        self.assertFalse(saved.d['delivering'].get('worker'))
        self.assertEqual(len(saved.d['mail']['other']),1)

if __name__=='__main__': unittest.main()

