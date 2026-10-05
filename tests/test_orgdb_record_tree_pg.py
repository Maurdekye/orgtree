"""Tree renderer-value parity and local detail stamps on disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree import api, foreground_context, foreground_store, foreground_view, net, ledger
from orgtree.orgdb import record_reads as Q, record_tree as T, record_sql as S
from orgtree.orgdb import record_runtime as R
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule

OVERLAY = {'cache_forecast','continue_accounts','account_label','account_tint_ordinal',
    'serving_account','ran_as_label','codex_route','activity','tasks','bg_tasks',
    'last_error','busy','waiting','queued_for_slot','responding','phase','ran_as','queued'}


@fixture.needs_pg
class Tree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for i in range(5):
                name = f'retired-{i}'
                org.nodes[name] = {**fixture.node(name,'boss'), 'state':'archived',
                    'session_id':'record-'+name, 'ui_order':100+i,
                    'charter':'private detail\nsecond line'}
            org.nodes['predecessor'] = {**fixture.node('predecessor',None),
                'session_id':'record-predecessor', 'state':'archived',
                'successor':'retired-2','ui_order':200}
            org.nodes['retired-2']['predecessor'] = 'predecessor'
            # This compatibility fixture writes minimal node records directly;
            # populate the required display fields the real hire path supplies.
            for name,node in org.nodes.items():
                node.setdefault('session_id','record-'+name)
                node.setdefault('bearer_state',None)
            for ask in org.d['asks']:
                ask['questions'] = [{'id':'question-1','question':ask['question']}]
            org.d['net_identity'] = {'slug':'record-public', 'secret':'record-private-secret'}
            org.d['net_hubs'] = [{'id':'r','address':'https://records.invalid','enabled':True}]
            org.d['net_spool'] = {'r':[{'id':'m','body':'record-private-mail','last_err':'retry','tries':1}]}
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('record tree',seed)
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    def connection(self):
        return fixture.dbconn.connect(fixture.ADMIN,self.database)

    def records(self,state,selection=Selection()):
        return Q.records(T.register(Registry()),state,(selection,))

    def wire_node(self,node):
        return {k:v for k,v in node.items() if k not in OVERLAY and
                not k.startswith(('proc_','mcp_')) and k not in ('children','detail_rev')}

    def foreground(self,state,include):
        graph = foreground_store.select_foreground(state.raw,dict(state.stamp),include,piles={})
        context = foreground_context.build(state.raw,state.slug,graph,now_ts=state.now)
        prepared = foreground_view.prepare(context,graph,detail_token=api._archived_detail_rev,sync_rev=0)
        with ExitStack() as stack:
            stack.enter_context(patch.object(api.registry,'list_accounts',return_value=[]))
            stack.enter_context(patch.object(api.registry,'resolve_alias',return_value=None))
            stack.enter_context(patch('orgtree.registry_migration.observe_ambient',return_value={}))
            stack.enter_context(patch.object(fixture.store,'local_net_slugs',return_value=set()))
            stack.enter_context(patch.object(api.supervisor,'cache_forecast_public',return_value=None))
            stack.enter_context(patch.object(api.warmpool,'process_control_status',return_value={}))
            annotated = api._annotate_org_view(context,prepared['tree'],SimpleNamespace(state=SimpleNamespace()))
        return foreground_view.finish(prepared,annotated)

    def test_shared_and_subscription_union_matches_foreground_with_distinct_held_counts(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            key = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
            selected = (Selection(),Selection('sub:1',(key,)),Selection('sub:2',(key,)))
            rows = Q.records(T.register(Registry()),state,selected)
            by_id = {r['id']:r['body'] for r in rows if r['entity']=='agent'}
            shared = {r['id'] for r in rows if r['entity']=='agent' and r['set']=='shared'}
            self.assertNotIn(key,shared)
            self.assertEqual(sum(r['id']==key and r['entity']=='agent' for r in rows),2)
            expected = self.foreground(state,['retired-2'])
            models = next(r['body']['models'] for r in rows if r['entity']=='org' and r['id']=='tiers')
            self.assertEqual({n['name'] for n in by_id.values()},set(expected['nodes']))
            for ident,node in by_id.items():
                self.assertNotIn('children',node)
                self.assertNotIn('hidden_retired_children',node)
                old = dict(expected['nodes'][node['name']])
                parent_name = by_id[node['parent_id']]['name'] if node['parent_id'] else None
                self.assertEqual(parent_name,old.pop('parent'))
                held = sum(n['state']=='archived' and not n.get('successor') and n['parent_id']==ident
                           for n in by_id.values())
                self.assertEqual(node['retired_children_total']-held,old.pop('hidden_retired_children'))
                overlay = R.agent_fields(node,models,boot_at=ledger.Org._boot_at())
                projected = {**node,'context_window':overlay['context_window'],
                    'ask':node.get('ask') if overlay['ask_linger_visible'] else None}
                actual = {k:v for k,v in self.wire_node(projected).items() if k not in
                    ('name','parent_id','ord','created','retired_children_total')}
                self.assertEqual(actual,self.wire_node(old),node['name'])

    def test_retained_hub_inputs_and_revisioned_body_merge_to_legacy_net(self):
        with fixture.storage(True), Q.snapshot(self.twin.copy) as state:
            body = T.org_bodies(state, frozenset(('net',)))['net']['net']
            context = state.cache['tree_context'][0]
            context.d['net_hubs'][0]['private_extra'] = 'record-private-config'
            context.d['net_state'] = {'r':dict(private_extra='record-private-state')}
            inputs = T.runtime_net_inputs(state)
            self.assertNotIn('net_spool', inputs)
            self.assertEqual(set(inputs['net_identity']), {'slug'})
            self.assertNotIn('record-private', str(inputs))
            with patch.dict(net._status, {(state.slug,'r'):dict(connected=True,last_ok='now',error=None)}, clear=True), \
                    patch.dict(net._rosters, {'https://records.invalid':[
                        dict(slug='record-public',online=True), dict(slug='peer',online=True)]}, clear=True):
                overlay = R.AgentOverlays(state.stamp['org_uuid'], state.stamp['incarnation'])
                overlay.net.adopt(inputs)
                live = overlay.full()['net']['hubs']
                actual = {**body, 'hubs':[{**hub, **runtime} for hub,runtime in zip(body['hubs'], live)]}
                self.assertEqual(actual, net.status_block(context.d))
                self.assertEqual(actual['hubs'][0]['queued'],1)
                self.assertEqual(actual['hubs'][0]['stuck'],1)
                self.assertNotIn('record-private', str(actual))

    def test_group_merge_is_complete_and_org_values_do_not_read_app_or_supervisor(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state,ExitStack() as stack:
            for target in ('orgtree.ledger.app_prefer_reserve_default','orgtree.openrouter.tiers',
                'orgtree.openrouter.models','orgtree.openrouter.stale_seats','orgtree.openrouter.context_for',
                'orgtree.api.registry.list_accounts',
                'orgtree.supervisor.state','orgtree.store.local_net_slugs'):
                stack.enter_context(patch(target,side_effect=AssertionError('record body read '+target)))
            rows = self.records(state)
            groups = {r['id']:r['body'] for r in rows if r['entity']=='org'}
            self.assertEqual(set(groups),set(T.GROUPS))
            merged = {k:v for body in groups.values() for k,v in body.items()}
            self.assertNotIn('prefer_reserve_default',merged)
            self.assertEqual(merged['net']['slug'],'record-public')
            self.assertEqual(merged['net']['hubs'][0]['queued'],1)
            wire = str(rows)
            self.assertNotIn('record-private-secret',wire)
            self.assertNotIn('record-private-mail',wire)
            for row in rows:
                if row['entity']=='agent':
                    self.assertFalse(OVERLAY.intersection(row['body']))

    def test_runtime_inputs_keep_omitted_predecessors_and_survive_snapshot_close(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            key = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
            rows = Q.records(T.register(Registry()),state,(Selection(),Selection('sub:1',(key,))))
            bodies = {row['id']:row['body'] for row in rows if row['entity']=='agent'}
            contexts = T.runtime_contexts(state,frozenset(bodies))
            self.assertEqual(set(contexts),set(bodies))
            boss = next(key for key,value in bodies.items() if value['id']=='boss')
            self.assertIn('predecessor',contexts[boss].nodes)
        # The snapshot is now closed: transitions can use retained inputs,
        # but must neither reopen this org nor read the app account registry.
        with ExitStack() as stack:
            stack.enter_context(patch.object(fixture.store,'load_org',side_effect=AssertionError('org reload')))
            stack.enter_context(patch.object(api.registry,'list_accounts',side_effect=AssertionError('app read')))
            stack.enter_context(patch.object(api.supervisor,'cache_forecast_public',return_value=None))
            stack.enter_context(patch.object(api.warmpool,'process_control_status',return_value={}))
            runtime = R.SupervisorOverlays(state.stamp['org_uuid'],state.stamp['incarnation'])
            runtime.adopt(bodies,contexts)
            frame = runtime.full()
            self.assertEqual(set(frame['agents']),set(bodies))
            self.assertEqual(runtime.transition(),{})
            self.assertFalse(any('account_label' in value for value in frame['agents'].values()))

    def test_archived_body_is_independent_of_set_and_of_unrelated_changes(self):
        with fixture.storage(True),self.connection() as raw:
            key = str(raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
            with Q.snapshot(self.twin.copy) as state:
                before = T.bodies(state,frozenset((key,)))[key]
                multiple = T.bodies(state,frozenset((key,str(raw.execute(
                    "SELECT id FROM orgtree.agents WHERE name='ops'").fetchone()[0]))))[key]
                self.assertEqual(before,multiple)
            raw.execute("UPDATE orgtree.agents SET title=title||' unrelated' WHERE name='ops'")
            with Q.snapshot(self.twin.copy) as state:
                unchanged = T.bodies(state,frozenset((key,)))[key]
                self.assertEqual(before,unchanged)
            raw.execute("UPDATE orgtree.agent_texts SET charter=charter||' detail' WHERE agent_id=%s",
                        (int(key),))
            with Q.snapshot(self.twin.copy) as state:
                own = T.bodies(state,frozenset((key,)))[key]
                self.assertNotEqual(own['detail_rev'],before['detail_rev'])
            raw.execute("UPDATE orgtree.agents SET title=title||' predecessor' WHERE name='predecessor'")
            with Q.snapshot(self.twin.copy) as state:
                pred = T.bodies(state,frozenset((key,)))[key]
                self.assertNotEqual(pred['detail_rev'],own['detail_rev'])
            with Q.snapshot(self.twin.copy) as state:
                after = Q.cursor(state)
            raw.execute("UPDATE orgtree.agent_texts SET charter='changed chain detail' WHERE agent_id="
                        "(SELECT id FROM orgtree.agents WHERE name='predecessor')")
            with Q.snapshot(self.twin.copy) as state:
                answer = Q.catchup(T.register(Registry()),state,after,
                    selections=(Selection(),Selection('sub:7',(key,))))
                changed = next(r['body'] for r in answer['upserts'] if r['id']==key and r['set']=='sub:7')
                self.assertNotEqual(changed['detail_rev'],pred['detail_rev'])

    def test_missing_subscription_is_empty_and_known_subscription_includes_ancestors(self):
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            self.assertEqual(T.members(state,Selection('sub:3',('9223372036854775806',))),frozenset())
            key = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
            rows = self.records(state,Selection('sub:4',(key,)))
            self.assertEqual({r['body']['name'] for r in rows},{'boss','retired-2'})
            self.assertEqual({r['entity'] for r in rows},{'agent'})

    def test_archived_predicates_capture_entrants_leavers_and_current_ancestors(self):
        with fixture.storage(True),self.connection() as raw:
            registry = T.register(Registry())
            boss = str(raw.execute("SELECT id FROM orgtree.agents WHERE name='boss'").fetchone()[0])
            selections = (Selection(),Selection('sub:80',windows=({'kind':'archived_all'},)),
                Selection('sub:81',windows=({'kind':'archived_under','parent':boss},)))
            with Q.snapshot(self.twin.copy) as state:
                held = {(r['set'],r['entity'],r['id']):r for r in Q.records(registry,state,selections)}
                after = Q.cursor(state)
            for statement in (
                "UPDATE orgtree.agents SET state='live' WHERE name='retired-3'",
                "UPDATE orgtree.agents SET state='archived' WHERE name='retired-3'",
                "UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='ops') "
                    "WHERE name='retired-3'",
                "UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='boss') "
                    "WHERE name='retired-3'",
            ):
                raw.execute(statement)
                with Q.snapshot(self.twin.copy) as state:
                    answer = Q.catchup(registry,state,after,selections=selections)
                    self.assertEqual(answer['type'],'record_changes')
                    for replacement in answer.get('replacements',()):
                        held = {key:value for key,value in held.items() if key[0]!=replacement['set']}
                        held.update({(r['set'],r['entity'],r['id']):r for r in replacement['records']})
                    for r in answer['tombstones']:
                        held.pop((r['set'],r['entity'],r['id']),None)
                    for r in answer['upserts']:
                        held[(r['set'],r['entity'],r['id'])] = r
                    self.assertEqual(held,{(r['set'],r['entity'],r['id']):r
                        for r in Q.records(registry,state,selections)},statement)
                    after = Q.cursor(state)

    def test_300_archived_members_and_split_includes_match_full_tree_identities(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for n in range(300):
                name = f'large-retired-{n}'
                org.nodes[name] = {**fixture.node(name,'boss'),'state':'archived',
                    'session_id':'record-'+name,'bearer_state':None}
            for name,node in org.nodes.items():
                node.setdefault('session_id','record-'+name)
                node.setdefault('bearer_state',None)
            for ask in org.d['asks']:
                ask['questions'] = [{'id':'question-1','question':ask['question']}]
            fixture.store.save_org(org)
        twin = fixture.Twins('record large selection',seed)
        with fixture.storage(True),Q.snapshot(twin.copy) as state:
            registry = T.register(Registry())
            identities = T._identities(state,[f'large-retired-{n}' for n in range(300)])
            boss = T._identities(state,['boss'])['boss']
            all_set = Selection('sub:1',windows=({'kind':'archived_all'},))
            under = Selection('sub:2',windows=({'kind':'archived_under','parent':boss},))
            ids = list(identities.values())
            split = tuple(Selection(f'sub:{n+3}',tuple(ids[offset:offset+128]))
                for n,offset in enumerate(range(0,len(ids),128)))
            all_rows = Q.records(registry,state,(Selection(),all_set))
            under_rows = Q.records(registry,state,(Selection(),under))
            split_rows = Q.records(registry,state,(Selection(),*split))
            # The legacy full-tree fallback walks all org-axis nodes. Compare
            # identities at the same R; body/display parity is checked above.
            full = fixture.store.load_org(twin.copy).tree()
            def names(nodes):
                return {node['id'] for node in nodes} | {key for node in nodes
                    for key in names(node.get('children',[]))}
            expected = names(full['roots'])
            for rows in (all_rows,under_rows,split_rows):
                self.assertEqual({r['body']['id'] for r in rows if r['entity']=='agent'},expected)
            pages = Q.subscribed_pages(registry,state,all_set)
            self.assertEqual([p['page'] for p in pages],list(range(len(pages))))
            self.assertEqual([p['final'] for p in pages],[False]*(len(pages)-1)+[True])
            self.assertEqual(len({r['id'] for p in pages for r in p['records']}),301)
            self.assertEqual(Q.cursor(state).rev,0)

    def test_parent_totals_and_pile_membership_converge_after_archive_unarchive_and_move(self):
        with fixture.storage(True),self.connection() as raw:
            registry = T.register(Registry())
            with Q.snapshot(self.twin.copy) as state:
                after = Q.cursor(state)
                held = {(r['set'],r['entity'],r['id']):r for r in Q.records(registry,state)}
            statements = (
                "UPDATE orgtree.agents SET state='live' WHERE name='retired-1'",
                "UPDATE orgtree.agents SET state='archived' WHERE name='retired-1'",
                "UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='ops') "
                    "WHERE name='retired-0'",
                "UPDATE orgtree.agents SET parent_id=(SELECT id FROM orgtree.agents WHERE name='boss') "
                    "WHERE name='retired-0'",
                "UPDATE orgtree.agents SET ui_order=90 WHERE name='retired-4'",
            )
            for statement in statements:
                raw.execute(statement)
                with Q.snapshot(self.twin.copy) as state:
                    answer = Q.catchup(registry,state,after)
                    self.assertEqual(answer['type'],'record_changes')
                    for r in answer['tombstones']:
                        held.pop((r['set'],r['entity'],r['id']),None)
                    for r in answer['upserts']:
                        held[(r['set'],r['entity'],r['id'])] = r
                    expected = {(r['set'],r['entity'],r['id']):r for r in Q.records(registry,state)}
                    self.assertEqual(held,expected,statement)
                    after = Q.cursor(state)

    def test_planted_missing_local_version_is_caught_then_restored(self):
        with fixture.storage(True),self.connection() as raw:
            key = str(raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
            with Q.snapshot(self.twin.copy) as state:
                before = T.bodies(state,frozenset((key,)))[key]['detail_rev']
            sql = S.migration_sql()
            start = sql.index('CREATE FUNCTION orgtree.record_stamp_details')
            stop = sql.index('CREATE FUNCTION orgtree.record_flush')
            restore = sql[start:stop].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
            raw.execute('CREATE OR REPLACE FUNCTION orgtree.record_stamp_details(r bigint) RETURNS void '
                        'LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$')
            try:
                raw.execute("UPDATE orgtree.agents SET title=title||' broken stamp' WHERE name='predecessor'")
                with Q.snapshot(self.twin.copy) as state:
                    broken = T.bodies(state,frozenset((key,)))[key]['detail_rev']
                with self.assertRaises(AssertionError):
                    self.assertNotEqual(broken,before)
            finally:
                raw.execute(restore)
            raw.execute("UPDATE orgtree.agents SET title=title||' restored stamp' WHERE name='predecessor'")
            with Q.snapshot(self.twin.copy) as state:
                self.assertNotEqual(T.bodies(state,frozenset((key,)))[key]['detail_rev'],before)


if __name__ == '__main__':
    unittest.main()
