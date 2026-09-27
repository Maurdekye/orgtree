"""Actual PG snapshot checks for the foreground context (count seam stubbed)."""
import copy
import json
import sys
import threading
import types
import unittest
from unittest.mock import patch
import test_pgstore as fixture
import orgtree
from orgtree import foreground_store as fg, foreground_context as ctx, ledger, store


def tearDownModule():fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN,'disposable PostgreSQL required: NOT RUN')
class ContextPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):store.claim_data_root()

    def setUp(self):
        org=store.create_org('ctx-'+self._testMethodName)
        org.hire(ledger.USER,None,'haiku',30,'boss')
        org.hire(ledger.USER,'boss','haiku',5,'leaf')
        # Load normalizes the just-hired seat identities before projecting.
        org=ledger.Org(copy.deepcopy(org.d))
        self.slug=org.d['slug'];store.save_org(org)
        self.count_calls=[]
        def counts(raw,org_id,*,viewer,now_ts):
            self.count_calls.append((raw,org_id,viewer,now_ts))
            return {'active':0,'attention':0,'archived':0,'backlogged':0}
        try:
            from orgtree import workread as module
        except ImportError:
            module=types.ModuleType('orgtree.workread')
            self.module_patch=patch.dict(sys.modules,{'orgtree.workread':module})
            self.module_patch.start();self.addCleanup(self.module_patch.stop)
            self.package_patch=patch.object(orgtree,'workread',module,create=True)
            self.package_patch.start();self.addCleanup(self.package_patch.stop)
        self.count_module=module
        self.count_patch=patch.object(module,'counts_raw',counts,create=True)
        self.count_patch.start();self.addCleanup(self.count_patch.stop)

    def context(self):
        return fg.read_foreground(self.slug,project=lambda raw,g:ctx.build(raw,self.slug,g))

    def test_shared_header_and_cards_equal_whole_org(self):
        org=store.load_org(self.slug)
        org.d['auto_resume']=False;org.d['default_effort']='high'
        org.d['user_inbox']=[{'id':'pending','from':ledger.USER,'body':'test','urgent':True,'at':ledger.now()}]
        org.d['org_inbox']=[{'id':str(i),'body':'old'} for i in range(30)]
        org.d['org_inbox_read']=22
        org.d['documents']=[{'id':str(i),'node':'boss','title':'Doc','at':str(i),'body':'x'*4096} for i in range(20)]
        store.save_org(org);org=store.load_org(self.slug)
        view=self.context()
        self.assertEqual(view.tree_header([]),org.tree_header([]))
        for nid in org.nodes:self.assertEqual(view.tree_node(nid),org.tree_node(nid,descend=False,lineage=False))
        self.assertEqual(len(view.d['documents']),10)
        self.assertEqual(view.tree_node('boss')['documents_count'],20)
        self.assertEqual(len(self.count_calls),1)

    def test_exact_subset_preserves_global_budget(self):
        org=store.load_org(self.slug)
        view=fg.read_exact(self.slug,'boss',project=lambda raw,g:ctx.build(raw,self.slug,g))
        self.assertEqual(set(view.nodes),{'boss'})
        self.assertEqual(view.free('boss'),org.free('boss'))
        self.assertEqual(view.audit(),org.audit())

    def test_same_snapshot_survives_concurrent_settings_and_node_commit(self):
        org=store.load_org(self.slug);before=org.tree_header([])
        def project(raw,g):
            errors=[]
            def writer():
                try:
                    other=store.load_org(self.slug)
                    other.d['name']='committed-later';other.node('leaf')['grant']=6
                    store.save_org(other)
                except Exception as exc:errors.append(exc)
            thread=threading.Thread(target=writer);thread.start();thread.join(15)
            self.assertFalse(thread.is_alive());self.assertFalse(errors)
            return ctx.build(raw,self.slug,g)
        view=fg.read_foreground(self.slug,project=project)
        self.assertEqual(view.tree_header([]),before)
        self.assertEqual(view.free('boss'),org.free('boss'))
        self.assertEqual(self.context().d['name'],'committed-later')

    def test_reopened_snapshot_refuses_older_graph(self):
        graph=fg.read_foreground(self.slug)
        org=store.load_org(self.slug);org.d['name']='moved';store.save_org(org)
        with fg._snapshot(self.slug) as (raw,stamp):
            with self.assertRaisesRegex(ctx.CompatibilityRequired,'same|share'):
                ctx.build(raw,self.slug,graph)

    def test_save_refusal_preserves_revision_and_rows(self):
        view=self.context();graph=fg.read_foreground(self.slug)
        for save in (store.save_org,store._save_org,store._save_sqlite,store._save_json):
            with self.assertRaises(TypeError):save(view)
        self.assertEqual(fg.read_foreground(self.slug),graph)

    def test_missing_count_contract_never_claims_empty(self):
        self.count_module.counts_raw=lambda *a,**k:None
        with self.assertRaisesRegex(ctx.CompatibilityRequired,'counts'):self.context()


    def test_pending_owner_rows_and_delivery_control_match_committed_data(self):
        from orgtree import warmpool, supervisor
        org=store.load_org(self.slug)
        org.d['mail']={'boss':[{'id':'pending','body':'current'}],
                       'leaf':[{'id':'other','body':'also current'}]}
        org.d['delivering']={'boss':[{'id':'inflight','body':'claimed'}]}
        store.save_org(org)
        view=fg.read_exact(self.slug,'boss',project=lambda raw,g:ctx.build(raw,self.slug,g))
        self.assertEqual(view.d['mail'],{'boss':[{'id':'pending','body':'current'}]})
        self.assertEqual(view.d['delivering'],{'boss':[{'id':'inflight','body':'claimed'}]})
        with patch.object(warmpool,'eligible',return_value=(True,'')):
            self.assertEqual(warmpool._warm_eligible(view,'boss'),(False,'delivery-in-progress'))


    def test_wire_preparation_accepts_real_projection_context(self):
        from orgtree import foreground_view, api
        def project(raw,graph):
            view=ctx.build(raw,self.slug,graph)
            return foreground_view.prepare(view,graph,detail_token=api._archived_detail_rev,
                                           sync_rev=0,primed_restart=None)
        prepared=fg.read_foreground(self.slug,project=project)
        self.assertEqual(prepared['tree']['roots'][0]['id'],'boss')
        wire=foreground_view.finish(prepared,prepared['tree'])
        self.assertEqual(wire['roots'],['boss'])
        self.assertEqual(wire['nodes']['boss']['children'],['leaf'])

if __name__=='__main__':unittest.main()
