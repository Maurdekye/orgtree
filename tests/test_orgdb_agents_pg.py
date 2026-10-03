"""A1 native reader controls; a skip is not an executed check.

The shared twins fixture provisions only throwaway databases. Run under P03's
heavy lock through tools/run-python-verification.py, never on live data.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest

import test_orgdb_compat_pg as fixture
from orgtree import foreground_store as F, identity_context, turn_inputs, org_summary


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class NativeReaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            org.nodes['old'] = dict(fixture.node('old', 'boss'), state='archived', generation=1)
            org.nodes['dev']['predecessor'] = 'old'
            org.nodes['old']['successor'] = 'dev'
            org.nodes['retired'] = dict(fixture.node('retired', 'boss'), state='archived',
                                        ui_order=2)
            org.nodes['dev']['turns'] = [{'n': n, 'at': fixture.AT} for n in range(1,21)]
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('a1', seed)

    def read(self, fn):
        with fixture.storage(True):
            return fn(self.twin.copy)

    def test_foreground_ancestor_closure(self):
        graph = self.read(lambda s: F.read_foreground(s, ['retired']))
        self.assertEqual(set(graph['rows']), {'boss', 'dev', 'ops', 'retired'})
        self.assertEqual(graph['hidden_retired_children']['boss'], 0)

    def test_exact_recent_turns_and_lineage(self):
        graph = self.read(lambda s: F.read_exact(s, 'dev'))
        with fixture.storage(False):
            expected = F.read_exact(self.twin.legacy, 'dev')
        self.assertEqual(graph['rows']['dev']['node']['turns'], expected['rows']['dev']['node']['turns'])
        self.assertEqual(graph['rows']['dev']['lineage_count'], 1)
        self.assertEqual(graph['rows']['dev']['consultable_predecessor'], {'id': 'old', 'generation': 1})

    def test_retired_page(self):
        page = self.read(lambda s: F.read_retired_children(s, 'boss'))
        self.assertEqual(page['matches'], ['retired'])
    def test_search(self):
        search = self.read(lambda s: F.search(s, 'retir'))
        self.assertEqual(search['matches'], ['retired'])
    def test_references(self):
        refs = self.read(lambda s: F.read_references(s, ['old', 'missing']))
        self.assertEqual(refs['references']['old']['axis'], 'lineage')
        self.assertEqual(refs['missing'], ['missing'])

    def test_identity_neighbourhood(self):
        context = self.read(lambda s: identity_context.load(s, 'dev'))
        self.assertEqual(set(context.nodes), {'boss', 'dev', 'old'})

    def test_turn_inputs_mail(self):
        context = self.read(lambda s: turn_inputs.load(s, 'dev', mail=True))
        self.assertEqual(set(context.nodes), {'boss', 'dev', 'old'})
        self.assertEqual([m['id'] for m in context.d['mail']['dev']], ['m1'])

    def test_snapshot_counters_exist(self):
        stamp = self.read(lambda s: F.read_snapshot(s, lambda raw, stamp: stamp))
        self.assertEqual(stamp['node_count'], 5)
        self.assertEqual(stamp['retired_axis_count'], 1)
        self.assertGreaterEqual(stamp['node_revision'], 5)

    def test_discovery(self):
        page = self.read(lambda s: F.discover(s, limit=2))
        self.assertEqual([n['id'] for n in page['nodes']], ['boss', 'dev'])
        tail = self.read(lambda s: F.discover(s, limit=2, cursor=page['next_cursor']))
        self.assertEqual([n['id'] for n in tail['nodes']], ['ops'])

    def test_pile_edges(self):
        graph = self.read(lambda s: F.read_foreground(s, piles={}))
        self.assertIn('retired', graph['rows'])

    def test_card_windows(self):
        got = self.read(lambda s: F.read_snapshot(s, lambda raw, stamp: F.read_card_windows(raw, ['dev'])))
        with fixture.storage(False):
            want = F.read_snapshot(self.twin.legacy, lambda raw, stamp: F.read_card_windows(raw, ['dev']))
        self.assertEqual(got, want)

    def test_inbox_window(self):
        got = self.read(lambda s: F.read_snapshot(s, lambda raw, stamp: F.read_org_inbox_window(raw)))
        with fixture.storage(False):
            want = F.read_snapshot(self.twin.legacy, lambda raw, stamp: F.read_org_inbox_window(raw))
        self.assertEqual(got, want)

    def test_summary_snapshot(self):
        row, context = self.read(org_summary._read)
        self.assertEqual((row['nodes'], row['live']), (5, 3))
        self.assertEqual(context.cost_total(), 1.25)

    def test_native_foreground_context_uses_same_snapshot(self):
        import types
        from unittest.mock import patch
        from orgtree import foreground_context, orgdb
        calls=[]
        counts={'active':2,'attention':0,'archived':0,'backlogged':0}
        def count(raw,org_id,*,viewer,now_ts):
            self.assertEqual(raw.execute("SELECT current_setting('transaction_isolation'),"
                "current_setting('transaction_read_only')").fetchone(),('repeatable read','on'))
            calls.append((raw,org_id,viewer,now_ts))
            return counts
        dependency=types.SimpleNamespace(counts_raw=count,attention_raises_raw=lambda *a,**k:[])
        with patch.object(orgdb,'docket',dependency,create=True):
            context=self.read(lambda s:F.read_exact(s,'dev',project=lambda raw,graph:
                foreground_context.build(raw,s,graph,now_ts=123)))
        self.assertEqual(set(context.nodes),{'boss','dev'})
        self.assertEqual(context.work_counts(),counts)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][3],123)
        self.assertEqual([row['id'] for row in context.d['mail']['dev']],['m1'])
        self.assertEqual(context.d['slug'],self.twin.copy)
        self.assertEqual(context.inputs['blobs']['models'],context.d['models'])
        self.assertGreater(context.committed('boss'),0)

    def test_empty_cursor_rejected(self):
        import base64
        cursor = base64.urlsafe_b64encode(b'[]').decode()
        with self.assertRaises(ValueError):
            self.read(lambda s: F.discover(s, cursor=cursor))


@fixture.needs_pg
class NativeWindows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org=fixture.store.load_org(slug)
            org.nodes['missing']=fixture.node('missing',None)
            for nid,parent,created,order in [('first','boss','2026-10-02T00:00:00.000Z',1),
                                            ('last','boss','2026-10-03T00:00:00.000Z',1),
                                            ('zero','boss','2026-10-04T00:00:00.000Z',-0.0),
                                            ('orphan','missing',fixture.AT,2),
                                            ('root','',fixture.AT,0)]:
                org.nodes[nid]=dict(fixture.node(nid,parent),state='archived',successor='',
                                    created=created,ui_order=order)
            org.d['asks']=[{'id':f'q{i}','node':'dev','status':'resolved',
                           'at':fixture.AT,'resolved_at':f'2026-10-{30-i:02d}T00:00:00.000Z',
                           'question':str(i)} for i in range(20)]
            org.d['documents']=[{'id':f'd{i}','node':'dev','title':{'odd':i} if i==19 else str(i),
                                 'at':fixture.AT,'format':False if i==19 else 'markdown',
                                 'body':'x'*10000} for i in range(20)]
            org.d['org_inbox']=[{'id':f'm{i}','body':str(i),'at':fixture.AT} for i in range(6)]
            org.d['org_inbox_read']=4
            fixture.store.save_org(org)
        cls.twin=fixture.Twins('a1 windows',seed)
        cls.twin.edit(lambda d:d['nodes'].pop('missing'))

    def both(self,fn):
        result=[]
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on): result.append(fn(slug))
        return result

    def test_child_dates_empty_refs_orphans_and_misfit_order(self):
        for parent in ('boss',''):
            with self.subTest(parent=parent):
                pages=self.both(lambda s:F.read_retired_children(s,parent,limit=1))
                while True:
                    self.assertEqual(pages[0]['matches'],pages[1]['matches'])
                    self.assertEqual(pages[0]['missing_ancestors'],pages[1]['missing_ancestors'])
                    self.assertEqual(bool(pages[0]['next_cursor']),bool(pages[1]['next_cursor']))
                    if not pages[0]['next_cursor']: break
                    cursors=[p['next_cursor'] for p in pages]
                    pages=[]
                    for on,slug,cursor in ((False,self.twin.legacy,cursors[0]),(True,self.twin.copy,cursors[1])):
                        with fixture.storage(on): pages.append(F.read_retired_children(slug,parent,limit=1,cursor=cursor))

    def test_tombstone_parent_native_page(self):
        from orgtree.orgdb import agents
        with fixture.storage(True):
            page=F.read_snapshot(self.twin.copy,lambda raw,stamp:agents.child_page(raw,'missing',10))
        self.assertEqual([row[0] for row in page],['orphan'])

    def test_orphan_graph_keeps_existing_refusal(self):
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on),self.assertRaises(fixture.store.LedgerError):
                F.read_retired_children(slug,'missing')

    def test_resolved_date_order_and_document_metadata(self):
        for header in (False,True):
            values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:F.read_card_windows(raw,['dev'],header=header)))
            self.assertEqual(values[0],values[1])
            self.assertEqual(values[1]['documents']['dev'][-1]['at'],fixture.AT)
            self.assertEqual(values[1]['documents']['dev'][-1]['format'],'false')
            self.assertNotIn('body',values[1]['documents']['dev'][-1])

    def test_inbox_tail_and_count_ack(self):
        values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:F.read_org_inbox_window(raw)))
        self.assertEqual(values[0],values[1])
        self.assertEqual((values[1]['total'],values[1]['unread']),(6,2))

    def test_exact_stamp_with_empty_successors(self):
        values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:stamp))
        for field in ('node_count','retired_axis_count','cost','cost_unknown'):
            self.assertEqual(values[0][field],values[1][field],field)


@fixture.needs_pg
class NativeCounters(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('a1 counters')

    def stamps(self):
        result = []
        for on, slug in ((False, self.twin.legacy), (True, self.twin.copy)):
            with fixture.storage(on):
                result.append(F.read_snapshot(slug, lambda raw, stamp: stamp))
        return result

    def test_each_catalog_field_and_six_exclusions(self):
        changes = {'parent': 'ops', 'state': 'unrecoverable', 'title': 'new', 'model': 'sonnet',
                   'ui_order': -0.0, 'created': '2026-10-02T00:00:00.000Z',
                   'predecessor': 'boss', 'successor': 'ops', 'generation': 2,
                   'bearer_state': 'lost', 'cost_usd': 0.1 + 0.2,
                   'cost_usd_unknown': True, 'grant': 11, 'session_id': 'next',
                   'transcript_incarnation': 'next', 'reply_incarnation': 'next'}
        for key, value in changes.items():
            with self.subTest(field=key):
                before = self.stamps()
                self.twin.edit(lambda d: d['nodes']['dev'].__setitem__(key, value))
                after = self.stamps()
                self.assertGreaterEqual(after[0]['node_revision']-before[0]['node_revision'],1)
                self.assertEqual(after[1]['node_revision']-before[1]['node_revision'],1)
                self.assertEqual(after[0]['catalog_revision'] != before[0]['catalog_revision'],
                                 after[1]['catalog_revision'] != before[1]['catalog_revision'])
                self.assertEqual(after[0]['cost'], after[1]['cost'])
                self.assertEqual(after[0]['cost_unknown'], after[1]['cost_unknown'])

    def test_each_view_source(self):
        changes = [
            ('settings', lambda d: d.__setitem__('max_children', 999)),
            ('mail', lambda d: d['mail']['dev'].append({'id':'new','body':'new'})),
            ('delivering', lambda d: d.__setitem__('delivering', {'dev':[{'id':'batch','mail':[{'id':'x'}]}]})),
            ('asks', lambda d: d['asks'][0].__setitem__('question','next')),
            ('credit_requests', lambda d: d.__setitem__('credit_requests',[{'node':'dev','amount':7}])),
            ('scope_requests', lambda d: d.__setitem__('scope_requests',[{'node':'dev','items':[{'kind':'web'}]}])),
            ('documents', lambda d: d.__setitem__('documents',[{'id':'d','node':'dev','body':'text'}])),
            ('org_inbox', lambda d: d.__setitem__('org_inbox',[{'id':'i','body':'text'}])),
            ('user_inbox', lambda d: d.__setitem__('user_inbox',[{'id':'u','body':'text'}])),
            ('audiences', lambda d: d.__setitem__('audiences',[{'grantee':'dev','grantor':'user'}])),
            ('audience_requests', lambda d: d.__setitem__('audience_requests',[{'node':'dev','target':'user'}])),
            ('watchdogs', lambda d: d['watchdogs'][0].__setitem__('state','paused')),
            ('watchdog_tombs', lambda d: d.__setitem__('watchdog_tombs',[{'id':'gone','owner':'dev'}])),
            ('work_items_archive', lambda d: d.setdefault('work_items_archive',[]).append(d['work_items'].pop())),
            ('work_scope_log', lambda d: d.__setitem__('work_scope_log',{'fix-the-thing':[{'text':'next'}]})),
        ]
        for key, change in changes:
            with self.subTest(source=key):
                before = self.stamps()
                self.twin.edit(change)
                after = self.stamps()
                if key=='work_scope_log':
                    # Legacy tracks list logs only; the typed by-owner scope
                    # rows must invalidate natively under the accepted rule.
                    self.assertEqual(after[0]['view_revision'],before[0]['view_revision'])
                else:
                    self.assertGreater(after[0]['view_revision'], before[0]['view_revision'])
                self.assertGreater(after[1]['view_revision'], before[1]['view_revision'])

    def test_standalone_statement_counts_savepoint_and_seat_identity(self):
        with fixture.storage(True):
            database = fixture.registry.lookup(self.twin.copy)[1]
            with fixture.dbconn.connect(fixture.RUNTIME, database) as raw:
                def counters():
                    return raw.execute('SELECT node_rev,catalog_rev FROM orgtree.org_revision').fetchone()
                before = counters()
                raw.execute("UPDATE orgtree.agents SET title=title WHERE name IN ('boss','ops')")
                self.assertEqual(counters(), (before[0]+2,before[1]))
                raw.execute('BEGIN')
                raw.execute('SAVEPOINT discarded')
                raw.execute("UPDATE orgtree.agents SET title='discarded' WHERE name='boss'")
                raw.execute('ROLLBACK TO SAVEPOINT discarded')
                raw.execute("UPDATE orgtree.agents SET lineage_born='replacement' WHERE name='ops'")
                raw.execute('COMMIT')
                self.assertEqual(counters(), (before[0]+3,before[1]+1))
                raw.execute('BEGIN')
                raw.execute("UPDATE orgtree.agents SET title='rollback' WHERE name='boss'")
                raw.execute('ROLLBACK')
                self.assertEqual(counters(), (before[0]+3,before[1]+1))


@fixture.needs_pg
class NativeMisfits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin=fixture.Twins('a1 misfits')

    def both(self,fn):
        values=[]
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on): values.append(fn(slug))
        return values

    def test_exact_text_metadata(self):
        for value in ({'longer': [1e20, -0.0, 'é'], 'a': True},[False,{'z':1,'aa':2}],False,1e20):
            with self.subTest(value=value):
                self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('title',value))
                values=self.both(lambda s:F.read_exact(s,'dev')['rows']['dev']['meta']['title'])
                self.assertEqual(values[0],values[1])

    def test_state_filter_misfit(self):
        for value in (False,{'odd':1},['live'],None):
            with self.subTest(value=value):
                self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('state',value))
                found=self.both(lambda s:[n['id'] for n in F.discover(s,state='live')['nodes']])
                self.assertEqual(found[0],found[1])
                found=self.both(lambda s:F.search(s,'dev',state='live')['matches'])
                self.assertEqual(found[0],found[1])
                found=self.both(lambda s:org_summary._read(s)[0]['live'])
                self.assertEqual(found[0],found[1])
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('state','live'))

    def test_summary_cost_exception_keeps_refusal(self):
        from orgtree.foreground_context import CompatibilityRequired
        for value in ('1.25',True):
            with self.subTest(value=value):
                self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('cost_usd',value))
                for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
                    with fixture.storage(on),self.assertRaises(CompatibilityRequired):
                        org_summary._read(slug)
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('cost_usd',0.25))

    def test_null_state_live_count(self):
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('state',None))
        values=self.both(lambda s:org_summary._read(s)[0]['live'])
        self.assertEqual(values[0],values[1])
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('state','live'))

    def test_successor_misfit_axis(self):
        self.twin.edit(lambda d:d['nodes'].__setitem__('odd-retired',dict(
            fixture.node('odd-retired','boss'),state='archived',successor=False)))
        values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:stamp['retired_axis_count']))
        self.assertEqual(values[0],values[1])
        values=self.both(lambda s:F.read_retired_children(s,'boss')['matches'])
        self.assertEqual(values[0],values[1])
        values=self.both(lambda s:F.search(s,'odd-retired')['matches'])
        self.assertEqual(values[0],values[1])

    def test_document_format_text_misfit(self):
        self.twin.edit(lambda d:d.__setitem__('documents',[dict(
            id='odd',node='dev',title='odd',at=fixture.AT,
            format={'longer':[1e20,-0.0],'a':True},body='large body')]))
        values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:F.read_card_windows(raw,['dev'])))
        self.assertEqual(values[0],values[1])


    def test_document_header_does_not_transfer_retained_body(self):
        from unittest.mock import patch
        from orgtree.orgdb import agents
        self.twin.edit(lambda d:d.__setitem__('documents',[dict(
            id='retained',node='dev',title={'z':'header'},at=fixture.AT,
            format='markdown',body={'authored':'large body'*10000})]))
        expected=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:
            F.read_card_windows(raw,['dev'])))
        self.assertEqual(expected[0],expected[1])
        read=agents._dicts
        observed=[]
        def probe(raw,sql,params=()):
            result=read(raw,sql,params)
            if 'FROM orgtree.documents' in sql:
                observed.extend(result)
            return result
        with fixture.storage(True),patch.object(agents,'_dicts',probe):
            F.read_snapshot(self.twin.copy,lambda raw,stamp:F.read_card_windows(raw,['dev']))
        self.assertTrue(observed)
        for row in observed:
            self.assertNotIn('body',row)
            self.assertNotIn('body',row.get('extra') or {})
            self.assertLess(len(str(row)),2000)


@fixture.needs_pg
class NativeReferences(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin=fixture.Twins('a1 references')
        cls.twin.edit(lambda d:d['nodes'].__setitem__('false',dict(
            fixture.node('false','boss'),state='archived',generation=7)))

    def both(self,fn):
        values=[]
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on): values.append(fn(slug))
        return values

    def test_parent_misfit_matching_a_name(self):
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('parent',False))
        try:
            values=self.both(lambda s:F.read_exact(s,'dev'))
            self.assertEqual(set(values[0]['rows']),set(values[1]['rows']))
            self.assertEqual(values[0]['missing_ancestors'],values[1]['missing_ancestors'])
        finally:
            self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('parent','boss'))

    def test_predecessor_misfit_matching_a_name(self):
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('predecessor',False))
        try:
            values=self.both(lambda s:F.read_exact(s,'dev'))
            for key in ('lineage_count','consultable_predecessor'):
                self.assertEqual(values[0]['rows']['dev'][key],values[1]['rows']['dev'][key])
            values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:
                set(identity_context._read(raw,s,'dev').nodes)))
            self.assertEqual(values[0],values[1])
        finally:
            self.twin.edit(lambda d:d['nodes']['dev'].pop('predecessor',None))

    def test_identity_user_extern_audiences(self):
        from orgtree.ledger import USER,EXTERN
        self.twin.edit(lambda d:d.__setitem__('audiences',[
            dict(grantee='dev',grantor=USER),dict(grantee='dev',grantor=EXTERN)]))
        values=self.both(lambda s:F.read_snapshot(s,lambda raw,stamp:
            identity_context._read(raw,s,'dev').d['audiences']))
        self.assertEqual(values[0],values[1])
        self.assertEqual({r['grantor'] for r in values[1]},{USER,EXTERN})

    def test_parent_boundary_after_typed_link_and_cycle(self):
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('parent','ops'))
        self.twin.edit(lambda d:d['nodes']['ops'].__setitem__('parent',False))
        self.twin.edit(lambda d:d['nodes']['false'].__setitem__('parent','ops'))
        try:
            values=self.both(lambda s:F.read_exact(s,'dev'))
            self.assertEqual(set(values[0]['rows']),set(values[1]['rows']))
            self.assertEqual(set(values[1]['rows']),{'dev','ops','false'})
            self.assertEqual(values[0]['missing_ancestors'],values[1]['missing_ancestors'])
        finally:
            self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('parent','boss'))
            self.twin.edit(lambda d:d['nodes']['ops'].__setitem__('parent','boss'))
            self.twin.edit(lambda d:d['nodes']['false'].__setitem__('parent','boss'))

    def test_predecessor_boundary_after_typed_link_and_cycle(self):
        self.twin.edit(lambda d:d['nodes'].__setitem__('old',dict(
            fixture.node('old','boss'),state='archived',generation=1,predecessor=False)))
        self.twin.edit(lambda d:d['nodes']['dev'].__setitem__('predecessor','old'))
        self.twin.edit(lambda d:d['nodes']['false'].__setitem__('predecessor','dev'))
        try:
            values=self.both(lambda s:F.read_exact(s,'dev')['rows']['dev'])
            for key in ('lineage_count','consultable_predecessor'):
                self.assertEqual(values[0][key],values[1][key])
            self.assertEqual(values[1]['lineage_count'],2)
            self.assertEqual(values[1]['consultable_predecessor'],{'id':'false','generation':7})
        finally:
            self.twin.edit(lambda d:d['nodes'].pop('old'))
            self.twin.edit(lambda d:d['nodes']['dev'].pop('predecessor',None))
            self.twin.edit(lambda d:d['nodes']['false'].pop('predecessor',None))


if __name__ == '__main__':
    unittest.main()
