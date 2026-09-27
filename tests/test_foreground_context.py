"""Foreground partial contexts retain display semantics and cannot be saved."""
import copy
import os
import tempfile
from pathlib import Path
import json
import unittest
from unittest.mock import patch, Mock
import import_provenance
_temp = tempfile.TemporaryDirectory(prefix="orgtree-context-")
os.environ["ORGTREE_DATA"] = str(Path(_temp.name) / "data")
Path(os.environ["ORGTREE_DATA"]).mkdir()
os.environ["ORGTREE_V2_TOKEN"] = "context-test-only"
from engine.launch import load_app
load_app()
from orgtree import ledger, store
from orgtree.foreground_context import ForegroundContext, CompatibilityRequired


def fixture(include=('parent',)):
    org = ledger.Org.create('foreground context')
    org.hire(ledger.USER, None, 'haiku', 30, 'parent')
    org.hire(ledger.USER, 'parent', 'haiku', 3, 'a')
    org.hire(ledger.USER, 'parent', 'haiku', 5, 'b')
    org.node('b')['state'] = 'unrecoverable'
    org = ledger.Org(copy.deepcopy(org.d))
    graph = {'stamp': {'cost': str(sum(n.get('cost_usd', 0) for n in org.nodes.values())),
                       'cost_unknown': False},
             'rows': {nid: {'node': n, 'ordinal': i} for i,(nid,n) in enumerate(org.nodes.items()) if nid in include}}
    funding = [dict(id=nid, **{key: n[key] for key in ('parent','state','model','grant')})
               for nid,n in org.nodes.items() if n['state'] != 'archived']
    settings = {k: copy.deepcopy(v) for k,v in org.d.items() if k not in ('nodes','events')}
    windows = {'asks': {'asks': [], 'credit_requests': [], 'scope_requests': []},
               'documents': {}, 'document_counts': {}}
    args = dict(settings=settings, graph=graph, funding=funding, windows=windows,
                inbox={'total': 0,'unread':0,'entries':[]},
                work_counts={'active':0,'attention':0,'archived':0,'backlogged':0})
    return org,args


class ContextTests(unittest.TestCase):
    def test_subset_funding_and_audit_include_unrecoverable_sibling(self):
        org,args=fixture(); view=ForegroundContext(**args)
        self.assertEqual(view.free('parent'),org.free('parent'))
        self.assertEqual(view.audit(),org.audit())
        self.assertEqual(set(view.nodes),{'parent'})

    def test_custom_tier_price_and_overdraft(self):
        org,args=fixture()
        args['settings']['tiers']['haiku']=2.75
        org.d['tiers']['haiku']=2.75
        org.node('parent')['grant']=1
        args['graph']['rows']['parent']['node']['grant']=1
        args['funding'][0]['grant']=1
        view=ForegroundContext(**args)
        self.assertEqual(view.audit(),org.audit())
        self.assertEqual(view.free('parent'),org.free('parent'))
        self.assertFalse(view.audit()['no_overdraft'])

    def test_legacy_migrations_or_ceiling_never_inferred_from_subset(self):
        for marker in ('_actors_typed','whole_grants_v1','_migrations'):
            with self.subTest(marker=marker):
                org,args=fixture();args['settings'].pop(marker,None)
                with self.assertRaises(CompatibilityRequired):ForegroundContext(**args)
        org,args=fixture();args['settings']['kiosk']={'credits':10}
        with self.assertRaisesRegex(CompatibilityRequired,'kiosk ceiling'):ForegroundContext(**args)

    def test_selected_node_normalization_matches_full(self):
        org,args=fixture(('b',))
        node=args['graph']['rows']['b']['node'];node.pop('ui_order');node['purpose']='old charter';node.pop('charter',None)
        node['scope']={'bash':False,'add_dirs':[]}
        normalized=ledger.Org(copy.deepcopy(org.d))
        view=ForegroundContext(**args)
        self.assertEqual(view.nodes['b'],normalized.nodes['b'])

    def test_data_detached_and_no_mutation_methods(self):
        org,args=fixture();view=ForegroundContext(**args)
        view.nodes['parent']['title']='local only'
        self.assertNotEqual(org.node('parent')['title'],'local only')
        for name in ('hire','retire','delete','work_update','post_mail','tree'):
            with self.assertRaises(AttributeError):getattr(view,name)

    def test_all_save_entries_refuse_before_hooks_or_sql(self):
        org,args=fixture();view=ForegroundContext(**args)
        for target in ('save_org','_save_org','_save_sqlite','_save_json'):
            with self.subTest(target=target), patch.object(store,'_assert_synced_data_root',side_effect=AssertionError('storage reached')):
                with self.assertRaisesRegex(TypeError,'partial read-only'):getattr(store,target)(view)
        conn=Mock()
        with self.assertRaisesRegex(TypeError,'partial read-only'):store._write_doc(conn,view.d,None)
        conn.execute.assert_not_called()
        with self.assertRaisesRegex(TypeError,'partial read-only'):ledger.Org(view.d)
        with self.assertRaisesRegex(TypeError,'partial read-only'):ledger.Org(copy.deepcopy(view.d))

    def test_external_holder_order_and_single_holder_rule(self):
        org,args=fixture();aud=[{'grantor':ledger.EXTERN,'grantee':'a'}, {'grantor':ledger.EXTERN,'grantee':'parent'}]
        org.d['audiences']=aud;args['settings']['audiences']=aud
        for multi in (False,True):
            org.d['org_inbox_multi_holder']=multi;args['settings']['org_inbox_multi_holder']=multi
            self.assertEqual(ForegroundContext(**args).extern_holders(),org.extern_holders())

    def test_missing_counts_is_compatibility_not_zero(self):
        org,args=fixture();args['work_counts']=None
        with self.assertRaises(CompatibilityRequired):ForegroundContext(**args)

    def test_shared_card_and_header_match_full_view(self):
        org,args=fixture(('parent','a','b'));view=ForegroundContext(**args)
        for nid in org.nodes:
            expected=org.tree_node(nid,descend=False,lineage=False)
            self.assertEqual(view.tree_node(nid),expected)
        self.assertEqual(view.tree_header([]),org.tree_header([]))

    def test_history_cost_and_inbox_total_not_selected_sum_or_preview_length(self):
        org,args=fixture()
        org.d['deleted_cost_usd']=2.5;org.node('b')['cost_usd']=7.5;org.node('b')['cost_usd_unknown']=True
        args['settings']['deleted_cost_usd']=2.5
        args['graph']['stamp'].update(cost='7.5',cost_unknown=True)
        entries=[{'id':str(i),'body':'old'} for i in range(20)]
        org.d['org_inbox']=entries;org.d['org_inbox_read']=11
        args['inbox']={'total':20,'unread':9,'entries':entries[-3:]}
        view=ForegroundContext(**args)
        self.assertEqual(view.tree_header([]),org.tree_header([]))

    def test_pending_ask_and_resolved_scope_use_same_display(self):
        org,args=fixture()
        question={'id':'q','node':'parent','status':'open','at':ledger.now(),
                  'questions':[{'id':'tab','question':'Ready?'}]}
        args['windows']['asks']['asks']=[question];org.d['asks']=[question]
        view=ForegroundContext(**args)
        self.assertEqual(view.tree_node('parent'),org.tree_node('parent',descend=False,lineage=False))
        self.assertEqual(view.tree_header([]),org.tree_header([]))

    def test_pending_mail_ids_and_expired_global_lock_require_compatibility(self):
        for field,value in (('user_inbox',[{'body':'old'}]),('mail',{'parent':[{'body':'old'}]}),
                            ('fable_lock',{'until_ts':1})):
            org,args=fixture();args['settings'][field]=value
            with self.subTest(field=field),self.assertRaises(CompatibilityRequired):ForegroundContext(**args)

    def test_kiosk_with_existing_ceiling_preserves_legacy_defaults(self):
        org,args=fixture()
        kiosk={'credits':10,'max_scope':{'tools':{},'add_dirs':[],
             'org_visibility':'self','permission_mode':'plan'}}
        org.d['kiosk']=copy.deepcopy(kiosk);args['settings']['kiosk']=copy.deepcopy(kiosk)
        expected=ledger.Org(copy.deepcopy(org.d));view=ForegroundContext(**args)
        self.assertEqual(view.tree_header([]),expected.tree_header([]))
        self.assertEqual(view.d['kiosk'],expected.d['kiosk'])


    def test_real_api_annotation_private_and_public_matches_legacy(self):
        from types import SimpleNamespace
        from orgtree import api, supervisor, registry_migration
        from contextlib import ExitStack
        for public in (False, True):
            with self.subTest(public=public):
                org,args=fixture(('parent','a','b'))
                org.node('parent')['cache_continuity']={'public':{
                    'state':'no_completed_fingerprint','source':'unobserved'}}
                org.d['auto_cheap_compact']={'enabled':True,'occ':0.6}
                args['settings']['auto_cheap_compact']=org.d['auto_cheap_compact']
                if public:
                    kiosk={'enabled':True,'credits':10,'max_scope':{
                        'tools':{},'add_dirs':[],'org_visibility':'self','permission_mode':'plan'}}
                    org.d['kiosk']=kiosk;args['settings']['kiosk']=copy.deepcopy(kiosk)
                    org=ledger.Org(copy.deepcopy(org.d))
                view=ForegroundContext(**args)
                request=SimpleNamespace(state=SimpleNamespace(public_slug=org.d['slug'] if public else None))
                def tree(context):
                    return context.tree_header([context.tree_node(n,descend=False,lineage=False)
                                                for n in ('parent','a','b')])
                with ExitStack() as stack:
                    stack.enter_context(patch.object(api.registry,'list_accounts',return_value=[]))
                    stack.enter_context(patch.object(api.registry,'resolve_alias',return_value=None))
                    stack.enter_context(patch.object(registry_migration,'observe_ambient',return_value={}))
                    stack.enter_context(patch.object(supervisor,'state',return_value={
                        'busy':False,'queue':[],'last_error':None}))
                    stack.enter_context(patch.object(api.net,'status_block',return_value=None))
                    stack.enter_context(patch.object(api.warmpool,'warm_decision',return_value=(False,'fixture')))
                    forecast=stack.enter_context(patch.object(supervisor,'cache_forecast_public',wraps=supervisor.cache_forecast_public))
                    expected=api._annotate_org_view(org,tree(org),request)
                    actual=api._annotate_org_view(view,tree(view),request)
                    self.assertEqual(actual,expected)
                    self.assertEqual(forecast.call_count,6)
                    self.assertTrue(actual['roots'][0]['cheap_compact_on'])
                    if public:
                        self.assertTrue(actual['public'])
                        self.assertNotIn('max_scope',actual['kiosk'])


    def test_modern_forecast_inputs_match_without_swallowing_adapter_errors(self):
        from orgtree import supervisor, warmpool
        from contextlib import ExitStack
        org,args=fixture(('parent','a'))
        org.node('parent')['team_charter']='Inherited standing rule'
        view=ForegroundContext(**args)
        # Stub external CLI/filesystem observations, not the Org-consuming
        # identity, argv or cache-snapshot functions. Call snapshot directly:
        # cache_forecast_public deliberately catches preview errors.
        with ExitStack() as stack:
            stack.enter_context(patch.object(supervisor,'_claude_argv',return_value=['fixture-claude']))
            stack.enter_context(patch.object(supervisor,'cli_capable',return_value=False))
            stack.enter_context(patch.object(supervisor,'cli_version',return_value='2.1.300'))
            stack.enter_context(patch.object(supervisor,'transcript_path',return_value=None))
            stack.enter_context(patch.object(supervisor,'registered_mcp_servers',return_value={}))
            stack.enter_context(patch.object(supervisor,'_cache_claude_namespace',return_value=('fixture','claude_subscription')))
            stack.enter_context(patch.object(warmpool,'native_startup_context_digest',return_value='fixture-files'))
            kwargs=dict(now=1234567890,env={'fixture':'1'},include_history=False)
            expected=supervisor._cache_snapshot(org,'a',**kwargs)
            actual=supervisor._cache_snapshot(view,'a',**kwargs)
            self.assertEqual(actual,expected)
            self.assertTrue(actual['components']['system'])

if __name__=='__main__':unittest.main()
