"""Integrated graph/context/viewer counts: no stub or full-org fallback."""
import copy
import threading
import unittest
from unittest.mock import patch
import test_pgstore as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, pgstore, ledger, workread, foreground_store as fg, foreground_context as ctx

def tearDownModule():fixture.tearDownModule()

@unittest.skipUnless(fixture.ADMIN,'disposable PostgreSQL required: NOT RUN')
class ContextCounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):store.claim_data_root()

    def setUp(self):
        org=store.create_org('ctx-counts-'+self._testMethodName)
        org.hire(ledger.USER,None,'haiku',10,'boss')
        org.hire(ledger.USER,None,'haiku',10,'other')
        org.d['work_items']=[dict(slug='active',status='open',owner={'node':'boss','generation':0}),
                             dict(slug='hidden',status='open',owner={'node':'other','generation':0}),
                             dict(slug='backlog',status='backlogged',owner={'node':'boss','generation':0})]
        org.d['work_items_archive']=[dict(slug='held',status='done',owner={'node':'boss','generation':0},
                                         manual_attention={'reason':'operator must see this'}),
                                     dict(slug='past',status='done',owner={'node':'boss','generation':0})]
        org=ledger.Org(copy.deepcopy(org.d));self.slug=org.d['slug'];store.save_org(org)
        self.oid=fg.read_foreground(self.slug)['stamp']['org_id']

    def read(self,viewer=ledger.USER):
        return fg.read_foreground(self.slug,project=lambda raw,g:ctx.build(raw,self.slug,g,viewer=viewer,now_ts=2000000000))

    def oracle(self,viewer):
        org=store.load_org(self.slug);out=dict(active=0,attention=0,archived=0,backlogged=0)
        for section,physical in (('work_items',False),('work_items_archive',True)):
            for item in org.d[section]:
                if not org._work_can_read(viewer,item):continue
                if org._work_attention(item):out['attention']+=1
                if org._work_archived(item,physical,2000000000):out['archived']+=1
                elif org._work_backlogged(item):out['backlogged']+=1
                elif org._work_counts_active(item):out['active']+=1
        return out

    def test_real_counts_match_authority_and_attention_held_archives(self):
        expected={v:self.oracle(v) for v in (ledger.USER,'boss','other','stranger')}
        with patch.object(store,'cached_org',side_effect=AssertionError('whole cache entered')):
            for viewer in expected:
                with self.subTest(viewer=viewer):
                    self.assertEqual(self.read(viewer).work_counts(),expected[viewer])
        self.assertEqual(expected['boss']['attention'],1)
        self.assertEqual(expected['boss']['archived'],1)
        self.assertEqual(expected['stranger'],dict(active=0,attention=0,archived=0,backlogged=0))

    def test_count_and_node_windows_share_snapshot_across_commit(self):
        before=self.read().work_counts();errors=[]
        def project(raw,graph):
            def change():
                try:
                    org=store.load_org(self.slug);org.d['name']='changed'
                    org.d['work_items_archive'][0]['manual_attention']=None
                    store.save_org(org)
                except Exception as exc:errors.append(exc)
            t=threading.Thread(target=change);t.start();t.join(10)
            self.assertFalse(t.is_alive());self.assertFalse(errors)
            return ctx.build(raw,self.slug,graph,now_ts=2000000000)
        view=fg.read_foreground(self.slug,project=project)
        self.assertEqual(view.work_counts(),before)
        self.assertNotEqual(view.d['name'],'changed')
        self.assertEqual(self.read().work_counts()['attention'],0)
        self.assertEqual(self.read().d['name'],'changed')

    def test_dirty_external_count_state_requests_exact_compatibility(self):
        with pgstore.connect() as raw:
            raw.execute(f"UPDATE org_{self.oid}.work_read_state SET ready=false")
        with self.assertRaises(ctx.CompatibilityRequired):self.read()
        with pgstore.connect() as raw,raw.transaction():
            self.assertFalse(workread.refresh(raw,self.oid))  # ordinary saves never repair explicit invalidation
            self.assertTrue(workread.reconcile(raw,self.oid))
        self.assertEqual(self.read().work_counts(),self.oracle(ledger.USER))

if __name__=='__main__':unittest.main()
