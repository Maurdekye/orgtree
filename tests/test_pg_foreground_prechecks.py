"""Actual-PG controls for foreground prechecks, including rebuild isolation."""
import copy
import json
import os
import threading
import unittest
from unittest.mock import patch
import test_pgstore as f
from orgtree import foreground_reads as reads, halt, ledger, orgtx, pgstore, store
from orgtree import supervisor as sup, api


def tearDownModule(): f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class ForegroundPrechecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    def setUp(self):
        self.slug=f._fresh_org('fg-'+self._testMethodName[-35:].replace('_','-'))
        org=store.load_org(self.slug)
        org.node('a').update(state='live',parent='b',generation=4)
        org.d['killswitch']=None
        store.save_org(org)

    def discovery(self, tool, nid='a'):
        call=api.AgentCall(org=self.slug,node=nid,tool=tool,args={})
        with patch.object(api,'_agent_identity'), \
             patch.object(api,'_tier_discovery_payload',return_value={'tiers':['fixture']}), \
             patch.object(api,'_list_orgs_payload',return_value={'orgs':['fixture']}):
            return api.agent_call(call,None)

    def test_actual_plans_and_discovery_avoid_full_read(self):
        with patch.object(store,'cached_org',side_effect=AssertionError('full cache')), \
             patch.object(store,'load_org',side_effect=AssertionError('full load')):
            rows=sup._admission_rows(self.slug,'a',compact=True)
            self.assertIn('a@4',rows['nodes'])
            self.assertIn(('notices','b'),rows['sections'])
            self.assertEqual(next(sup._report_plans(self.slug,'a'))['_sup'],'b')
            self.assertFalse(halt.requested(self.slug,'a'))
            self.assertEqual(self.discovery('orgtree_list_tiers'),{'tiers':['fixture']})
            self.assertEqual(self.discovery('orgtree_list_orgs'),{'orgs':['fixture']})

    def test_changed_generation_is_rechecked_on_locked_row(self):
        plan=sup._admission_rows(self.slug,'a',compact=True)
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:
            tx.org.node('a')['generation']=5
        with halt.txn(self.slug,**plan) as tx:
            self.assertFalse(sup._admission_pred_locked(tx,tx.org,'a'))

    def test_changed_parent_is_rechecked_on_locked_row(self):
        plan=sup._admission_rows(self.slug,'a',compact=True)
        report=next(sup._report_plans(self.slug,'a'))
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:
            tx.org.node('a')['parent']='c'
        with halt.txn(self.slug,**plan) as tx:
            self.assertFalse(sup._admission_pred_locked(tx,tx.org,'a'))
            with self.assertRaises(sup._Replan):sup._check_plan(tx.org,'a',report)

    def test_halt_commit_after_precheck_still_refuses_locked_admission(self):
        self.assertFalse(halt.requested(self.slug,'a'))
        plan=sup._admission_rows(self.slug,'a',compact=True)
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:tx.org.node('a')['halt']=True
        self.assertTrue(halt.requested(self.slug,'a'))
        with halt.txn(self.slug,**plan) as tx:
            with self.assertRaises(halt.Cancelled):sup._halt_check_locked(tx.org,'a')

    def test_killswitch_commit_and_missing_seat_discovery_refuse(self):
        with orgtx.org_tx(self.slug,sections=['killswitch']) as tx:tx.d['killswitch']={'by':'user'}
        for tool in ('orgtree_list_tiers','orgtree_list_orgs'):
            with self.assertRaises(api.HTTPException) as caught:self.discovery(tool)
            self.assertEqual(caught.exception.status_code,409)
        with orgtx.org_tx(self.slug,sections=['killswitch']) as tx:tx.d['killswitch']=None
        with self.assertRaises(api.HTTPException) as caught:self.discovery('orgtree_list_tiers','missing')
        self.assertEqual(caught.exception.status_code,422)
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:tx.org.node('a')['state']='archived'
        with self.assertRaises(api.HTTPException) as caught:self.discovery('orgtree_list_tiers')
        self.assertIn('not live',str(caught.exception.detail))

    def test_discovery_rechecks_gate_after_initial_api_precheck(self):
        # Force a commit between agent_call's first gate and its discovery seat read.
        original=halt.blocked
        def crossing(slug,nid):
            result=original(slug,nid)
            with orgtx.org_tx(slug,nodes=[nid]) as tx:tx.org.node(nid)['halt']=True
            return result
        with patch.object(halt,'blocked',crossing):
            with self.assertRaises(api.HTTPException) as caught:self.discovery('orgtree_list_orgs')
        self.assertEqual(caught.exception.status_code,422)
        self.assertIn('halted',str(caught.exception.detail))

    def test_legacy_and_fresh_fallbacks_preserve_org_normalization(self):
        org=store.load_org(self.slug)
        with patch.object(store,'read_runtime_node',return_value=None), \
             patch.object(store,'cached_org',return_value=org) as cached, \
             patch.object(store,'load_org',return_value=org) as fresh:
            self.assertEqual(reads.node_gates(self.slug,'a')['node'],org.node('a'))
            cached.assert_called_once();fresh.assert_not_called()
            reads.node_gates(self.slug,'a',fresh=True);fresh.assert_called_once()
        legacy={'node':{'state':'live','parent':'b','generation':4}}
        with patch.object(store,'read_runtime_node',return_value=legacy), \
             patch.object(store,'cached_org',return_value=org) as cached:
            self.assertEqual(reads.node_gates(self.slug,'a')['node']['seat_id'],org.node('a')['seat_id'])
            cached.assert_called_once()

    def test_fresh_status_reads_committed_value_without_cache(self):
        before=store.cached_org(self.slug)
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:
            tx.org.node('a')['last_status']={'status':'working'}
        with patch.object(store,'cached_org',side_effect=AssertionError('cache')), \
             patch.object(store,'load_org',side_effect=AssertionError('whole')):
            self.assertTrue(sup._reported_working(reads.node_gates(self.slug,'a',fresh=True)['node']))
        self.assertFalse(sup._reported_working(before.node('a')))

    def test_prechecks_complete_while_actual_cache_rebuild_is_held(self):
        store.cached_org(self.slug)
        with orgtx.org_tx(self.slug,nodes=['b']) as tx:
            tx.org.node('b')['last_status']={'status':'idle','summary':'invalidate'}
        entered=threading.Event();release=threading.Event();finished=threading.Event();errors=[]
        original=store._assemble_snapshot
        def held(*args):
            entered.set()
            if not release.wait(15):raise AssertionError('holder not released')
            return original(*args)
        def build():
            try:store.cached_org(self.slug)
            except BaseException as e:errors.append(e)
        def prechecks():
            try:self.test_actual_plans_and_discovery_avoid_full_read()
            except BaseException as e:errors.append(e)
            finally:finished.set()
        with patch.object(store,'_assemble_snapshot',held):
            holder=threading.Thread(target=build);holder.start()
            try:
                self.assertTrue(entered.wait(10),'actual rebuild did not enter')
                reader=threading.Thread(target=prechecks);reader.start()
                self.assertTrue(finished.wait(10),'foreground reader waited on held rebuild')
            finally:
                release.set();holder.join(15)
                if 'reader' in locals():reader.join(15)
        self.assertFalse(holder.is_alive())
        self.assertEqual(errors,[])


if __name__=='__main__':unittest.main()
