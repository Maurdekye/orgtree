"""Actual PostgreSQL lazy transaction reads; no skipped run is a success."""
import copy
import json
import os
import unittest
from unittest.mock import patch
import test_pgstore as f
from orgtree import orgtx, pgstore, store, workrows
from test_work_item_rows import items


def tearDownModule(): f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class LazyRows(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    def setUp(self):
        self.slug=f._fresh_org('lazy-'+self._testMethodName)
        org=store.load_org(self.slug)
        org.d['work_items']=[dict(v, evidence=[{'body':'x'*131072}]) for v in items()]
        store.save_org(org)
        # Cold validation is explicit and separated from the warm read claim.
        with orgtx.org_tx(self.slug, nodes=['a']) as tx: pass

    def row(self, slug='one'):
        return store.read_work_items_rows(self.slug,[slug])['items'][slug]

    def watch(self):
        seen=[]; original=pgstore.PgConn.execute
        def execute(c, sql, params=()):
            result=original(c,sql,params)
            if 'SELECT' in sql and 'val' in sql and 'doc' in sql:
                seen.append((sql,params))
            return result
        return seen,patch.object(pgstore.PgConn,'execute',execute)

    def test_node_transaction_never_reads_work_bodies_after_validation(self):
        seen,watch=self.watch()
        with watch:
            with orgtx.org_tx(self.slug,nodes=['a']) as tx:
                self.assertIn('work_items', tx.d._deferred_doc)
                tx.d['nodes']['a']['last_status']={'summary':'node only'}
        self.assertFalse(any('ANY' in sql or 'xmin' in sql for sql,_ in seen),seen)
        self.assertEqual(self.row()['evidence'][0]['body'],'x'*131072)
        self.assertEqual(store.read_node(self.slug,'a')['last_status']['summary'],'node only')

    def test_one_item_access_fetches_only_that_item_nested_edit_survives(self):
        seen,watch=self.watch()
        with watch:
            with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
                rows=tx.d['work_items']
                self.assertFalse(rows[0]._loaded); self.assertFalse(rows[1]._loaded)
                rows[0]['nested']['values'].append(7)
                self.assertFalse(rows[1]._loaded)
        fetches=[p for sql,p in seen if 'SELECT val, xmin' in sql]
        self.assertEqual(fetches,[(workrows.PREFIX+'one',)])
        self.assertEqual(self.row()['nested']['values'],[1,7])
        self.assertEqual(self.row('two')['nested']['values'],[2])

    def test_external_alias_and_retained_nested_reference(self):
        external={'value':1}
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            row=tx.d['work_items'][0]
            nested=row['nested']; nested['external']=external
            observed=nested['external']; external['value']=2
            nested['values'].append(8)
        self.assertEqual(self.row()['nested'],{'values':[1,8],'external':{'value':2}})

    def test_attention_update_only_loads_changed_item(self):
        seen,watch=self.watch()
        with watch:
            with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
                tx.d['asks']=[{'id':'q','status':'open','questions':[{'work_item':'one'}]}]
        self.assertEqual([p for sql,p in seen if 'SELECT val, xmin' in sql],[(workrows.PREFIX+'one',)])
        self.assertTrue(self.row()['notification_attention_active'])
        self.assertFalse(self.row('two')['notification_attention_active'])

    def test_stale_lazy_access_refuses_before_overwrite(self):
        old=store._load_sqlite_org(self.slug,lazy_work=True)
        fresh=store.load_org(self.slug);fresh.d['work_items'][0]['rev']=2;store.save_org(fresh)
        with self.assertRaises(store.StaleWrite): old.d['work_items'][0]['rev']=3
        self.assertEqual(self.row()['rev'],2)

    def test_stale_delete_without_access_rolls_back_node_write(self):
        old=store._load_sqlite_org(self.slug,lazy_work=True)
        old.d['work_items'].pop(0)
        fresh=store.load_org(self.slug);fresh.d['work_items'][0]['rev']=2;store.save_org(fresh)
        old.d['nodes']['a']['last_status']={'summary':'must roll back'}
        with self.assertRaises(store.StaleWrite): store.save_org(old)
        self.assertEqual(self.row()['rev'],2)
        self.assertNotEqual(store.read_node(self.slug,'a').get('last_status'),{'summary':'must roll back'})

    def test_materialized_stale_cas_still_refuses(self):
        old=store._load_sqlite_org(self.slug,lazy_work=True)
        old.d['work_items'][0]['rev']=3
        fresh=store.load_org(self.slug);fresh.d['work_items'][0]['rev']=2;store.save_org(fresh)
        with self.assertRaises(store.StaleWrite): store.save_org(old)
        self.assertEqual(self.row()['rev'],2)

    def test_complete_dict_json_deepcopy_and_no_connection_retained(self):
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            row=tx.d['work_items'][0]
            expected=self.row()
            self.assertEqual(dict(row),expected)
            self.assertEqual(json.loads(json.dumps(row)),expected)
            duplicate=copy.deepcopy(tx.d)
            duplicate['work_items'][0]['nested']['values'].append(9)
            self.assertEqual(row['nested']['values'],[1])
        self.assertEqual(self.row()['nested']['values'],[1])

    def test_snapshot_and_plain_load_preserve_eager_old_values(self):
        a=store.load_org_snapshot(self.slug,[]);b=store.load_org(self.slug)
        fresh=store.load_org(self.slug);fresh.d['work_items'][0]['rev']=2;store.save_org(fresh)
        self.assertEqual(a.d['work_items'][0]['rev'],1)
        self.assertEqual(b.d['work_items'][0]['rev'],1)

    def test_unknown_legacy_attention_is_initialized(self):
        org=store.load_org(self.slug)
        del org.d['work_items'][0]['notification_attention_active']
        # Raw fixture removes the field without save's intentional heal.
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('UPDATE doc SET val=? WHERE key=?',(store._dumps(org.d['work_items'][0]),workrows.PREFIX+'one'))
        with orgtx.org_tx(self.slug,nodes=['a']) as tx: pass
        self.assertFalse(self.row()['notification_attention_active'])

    def test_unlocked_write_refused_and_changed_version_revalidated(self):
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug,nodes=['a']) as tx: tx.d['work_items'][0]['rev']=9
        self.assertEqual(self.row()['rev'],1)
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx: tx.d['work_items'][0]['rev']=2
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx: tx.d['work_items'][0]['rev']=3
        self.assertEqual(self.row()['rev'],3)

    def test_metadata_body_race_refuses_instead_of_caching_wrong_version(self):
        import psycopg
        store._WORK_ITEM_META.clear()
        original=pgstore.PgConn.execute; fired=[]
        def execute(c,sql,params=()):
            cur=original(c,sql,params)
            # right after the version listing (one aggregated row since option B)
            if 'starts_with(key' in sql and 'xmin::text' in sql and not fired:
                fired.append(True)
                with psycopg.connect(os.environ['ORGTREE_PG_URL'],autocommit=True) as other:
                    row=other.execute(f'SELECT val FROM org_{c.org_id}.doc WHERE key=%s',(workrows.PREFIX+'one',)).fetchone()
                    value=json.loads(row[0]);value['rev']=17
                    other.execute(f'UPDATE org_{c.org_id}.doc SET val=%s WHERE key=%s',(store._dumps(value),workrows.PREFIX+'one'))
            return cur
        with patch.object(pgstore.PgConn,'execute',execute):
            with self.assertRaises(store.StaleWrite):
                with orgtx.org_tx(self.slug,nodes=['a']): pass
        self.assertEqual(fired,[True]);self.assertEqual(self.row()['rev'],17)

    def test_delete_and_replace_unread_item_preserve_original_cas(self):
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            tx.d['work_items'].pop(1)
            tx.d['work_items'][0]={'slug':'one','rev':11,'notification_attention_active':False}
        rows=store.read_work_items_rows(self.slug,['one','two'])
        self.assertEqual(rows['ids'],['one']);self.assertEqual(rows['items']['one']['rev'],11)

    def test_identity_check_does_not_fetch_evidence_from_other_items(self):
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            rows=tx.d['work_items']
            self.assertEqual(tx.org.work_identity_state(),tx.org.WORK_IDENTITY_SLUG)
            self.assertTrue(all(not row._loaded for row in rows))
            rows[0]['nested']['values'].append(13)
            self.assertFalse(rows[1]._loaded)
        self.assertEqual(self.row()['nested']['values'],[1,13])


    def test_cold_equality_and_inequality_load_both_operands(self):
        for different in (False, True):
            for unequal in (False, True):
                with self.subTest(different=different, unequal=unequal):
                    left=store._load_sqlite_org(self.slug,lazy_work=True).d['work_items'][0]
                    right=store._load_sqlite_org(self.slug,lazy_work=True).d['work_items'][int(different)]
                    self.assertFalse(left._loaded)
                    self.assertFalse(right._loaded)
                    actual=(left != right) if unequal else (left == right)
                    self.assertEqual(actual,different if unequal else not different)
                    self.assertTrue(left._loaded)
                    self.assertTrue(right._loaded)

    def test_cold_equality_rejects_stale_right_operand(self):
        for unequal in (False, True):
            with self.subTest(unequal=unequal):
                right=store._load_sqlite_org(self.slug,lazy_work=True).d['work_items'][0]
                self.assertFalse(right._loaded)
                fresh=store.load_org(self.slug)
                fresh.d['work_items'][0]['rev'] += 1
                store.save_org(fresh)
                store._load_sqlite_org(self.slug,lazy_work=True)  # validate the new version
                left=store._load_sqlite_org(self.slug,lazy_work=True).d['work_items'][0]
                self.assertFalse(left._loaded)
                with self.assertRaises(store.StaleWrite):
                    if unequal: left != right
                    else: left == right
                self.assertEqual(self.row()['rev'],fresh.d['work_items'][0]['rev'])

    def test_runtime_projection_skips_bodies_but_rejects_later_version(self):
        seen,watch=self.watch()
        with watch:
            old=store.load_runtime_org(self.slug)
        self.assertFalse(any('ANY' in sql or 'xmin' in sql for sql,_ in seen),seen)
        self.assertEqual(old.nodes['a']['id'],'a')
        fresh=store.load_org(self.slug)
        fresh.d['work_items'][0]['rev']=19
        store.save_org(fresh)
        with self.assertRaises(store.StaleWrite): old.d['work_items'][0]['rev']
        self.assertEqual(self.row()['rev'],19)

    def test_runtime_eager_mail_stays_in_snapshot(self):
        # ORGTREE_LAZY_ROWS=0 keeps the whole-load contract: mail is read in
        # the view's one snapshot
        with patch.object(store,'LAZY_ROWS',False):
            fresh=store.load_org(self.slug)
            fresh.d['mail']={'a':[{'id':'before','body':'one'}]}
            store.save_org(fresh)
            old=store.load_runtime_org(self.slug)
            fresh=store.load_org(self.slug)
            fresh.d['mail']['a'].append({'id':'after','body':'two'})
            store.save_org(fresh)
            self.assertEqual([m['id'] for m in old.d['mail']['a']],['before'])
            self.assertEqual([m['id'] for m in store.load_runtime_org(self.slug).d['mail']['a']],['before','after'])

    def test_runtime_on_demand_mail_is_fresher_and_counted(self):
        # ORGTREE_LAZY_ROWS on (the default): a runtime view reads a box when
        # it is touched and may see a later commit; that is counted, never an
        # error (n1000 decision #3, "option A")
        with patch.object(store,'LAZY_ROWS',True):
            fresh=store.load_org(self.slug)
            fresh.d['mail']={'a':[{'id':'before','body':'one'}]}
            store.save_org(fresh)
            with orgtx.org_tx(self.slug,nodes=['a']):
                pass                                    # a whole load stamps the heal epoch
            old=store.load_runtime_org(self.slug)
            self.assertIsInstance(dict.get(old.d,'mail'),store.LazySplitSection)
            fresh=store.load_org(self.slug)
            fresh.d['mail']['a'].append({'id':'after','body':'two'})
            store.save_org(fresh)
            before=store.LAZY_ROWS_STATS['post_load_changes']
            self.assertEqual([m['id'] for m in old.d['mail']['a']],['before','after'])
            self.assertEqual(store.LAZY_ROWS_STATS['post_load_changes'],before+1)

    def test_runtime_escape_hatch_retains_eager_snapshot(self):
        with patch.object(store,'ORGTX_RESCOPE',False):
            old=store.load_runtime_org(self.slug)
        fresh=store.load_org(self.slug)
        fresh.d['work_items'][0]['rev']=23
        store.save_org(fresh)
        self.assertEqual(old.d['work_items'][0]['rev'],1)

    def test_sweep_metadata_preserves_scope_heal_and_mutated_scope(self):
        from orgtree import worktx
        org=store.load_org(self.slug)
        org.d['work_items'][0]['scope']=[{'seq':n} for n in range(org.WORK_SCOPE_INLINE+1)]
        store.save_org(org)
        store.load_runtime_org(self.slug)  # validate the new version once
        lazy=store.load_runtime_org(self.slug)
        self.assertTrue(worktx.due(lazy))
        item=lazy.d['work_items'][0]
        self.assertFalse(item._loaded)
        item['scope']=[]
        self.assertFalse(worktx.due(lazy))
        item['scope_archive']=[{'seq':1}]
        self.assertTrue(worktx.due(lazy))

    def test_sweep_metadata_preserves_age_status_and_question_hold(self):
        from orgtree import worktx
        org=store.load_org(self.slug)
        item=org.d['work_items'][0]
        item.update(status='done',docket_at='2020-01-01T00:00:00+00:00',scope=[])
        store.save_org(org)
        store.load_runtime_org(self.slug)
        lazy=store.load_runtime_org(self.slug)
        self.assertTrue(worktx.due(lazy))
        self.assertFalse(lazy.d['work_items'][0]._loaded)
        org=store.load_org(self.slug)
        org.d['asks']=[{'id':'q','node':'a','status':'open','questions':[{'work_item':'one'}]}]
        store.save_org(org)
        store.load_runtime_org(self.slug)
        self.assertFalse(worktx.due(store.load_runtime_org(self.slug)))
        org=store.load_org(self.slug)
        org.d['asks']=[]
        org.d['work_items'][0]['status']='in_progress'
        store.save_org(org)
        store.load_runtime_org(self.slug)
        self.assertFalse(worktx.due(store.load_runtime_org(self.slug)))

    def test_sweep_metadata_rechecks_reopen_under_transaction(self):
        from orgtree import worktx
        org=store.load_org(self.slug)
        org.d['work_items'][0].update(status='done',docket_at='2020-01-01T00:00:00+00:00')
        store.save_org(org)
        store.load_runtime_org(self.slug)
        old=store.load_runtime_org(self.slug)
        self.assertTrue(worktx.due(old))
        org=store.load_org(self.slug)
        org.d['work_items'][0]['status']='in_progress'
        store.save_org(org)
        self.assertEqual(worktx.sweep(self.slug,snapshot=old),[])
        self.assertEqual(self.row()['status'],'in_progress')

    def test_argument_only_specs_skip_snapshot_and_default_specs_keep_it(self):
        from orgtree import pgdoor
        seen=[]
        def spec(snapshot,call,args):
            seen.append(snapshot)
            return pgdoor.TxSpec(nodes=(args['node'],))
        names=('lazy-args-only','lazy-needs-snapshot')
        try:
            pgdoor.declare(names[0],spec,needs_snapshot=False)
            pgdoor.declare(names[1],spec)
            sentinel=object()
            with patch.object(pgdoor,'_snapshot',return_value=sentinel) as read:
                self.assertEqual(pgdoor._resolve(names[0],self.slug,None,{'node':'a'}).nodes,('a',))
                read.assert_not_called()
                pgdoor._resolve(names[1],self.slug,None,{'node':'a'})
                read.assert_called_once_with(self.slug)
            self.assertIsNone(seen[0]);self.assertIs(seen[1],sentinel)
        finally:
            for name in names:
                pgdoor.LOCKS.pop(name,None);pgdoor.SNAPSHOT_FREE.discard(name)


    def test_runtime_agent_identity_does_not_refresh_work_cache(self):
        from types import SimpleNamespace
        from orgtree import api
        from fastapi import HTTPException
        with orgtx.org_tx(self.slug,nodes=['a']) as tx:
            tx.org.nodes['a'].update(state='live',generation=0,seat_id='fixture-seat')
        body=SimpleNamespace(org=self.slug,node='a')
        state=SimpleNamespace(agent_identity=None,bridge_slug=None)
        request=SimpleNamespace(state=state)
        seen,watch=self.watch()
        with watch, patch.object(store,'cached_org',side_effect=AssertionError('eager identity')), \
                patch.object(store,'load_runtime_org',side_effect=AssertionError('full identity')):
            caller=api._agent_identity(body,request)
        self.assertEqual(caller['id'],'a')
        self.assertFalse(any('ANY' in sql or 'xmin' in sql for sql,_ in seen),seen)
        state.agent_identity=(self.slug,'a',int(caller.get('generation',0))+1,caller.get('seat_id'))
        with self.assertRaises(HTTPException) as rejected: api._agent_identity(body,request)
        self.assertEqual(rejected.exception.status_code,403)
        state.agent_identity=None
        body.node='absent'
        with self.assertRaises(HTTPException) as rejected: api._agent_identity(body,request)
        self.assertEqual(rejected.exception.status_code,403)

    def test_runtime_message_spec_preserves_snapshot_seam_and_no_work_reads(self):
        from types import SimpleNamespace
        from orgtree import api,maildoor,pgdoor
        from orgtree.ledger import USER
        call=SimpleNamespace(org=self.slug,node='a')
        args={'to':USER}
        seen,watch=self.watch()
        with watch, patch.object(store,'cached_org',side_effect=AssertionError('eager mail')):
            spec=pgdoor._resolve(maildoor.MESSAGE,self.slug,call,args)
            before=api._message_door_before(call,args)
        self.assertEqual(before['dest'],USER)
        self.assertFalse(any('ANY' in sql or 'xmin' in sql for sql,_ in seen),seen)
        # Explicit test seams retain precedence; normal lock prediction is equal.
        old=pgdoor._SEAM.snapshot
        try:
            snapshot=store.load_org(self.slug)
            pgdoor._SEAM.snapshot=lambda slug:snapshot
            with patch.object(store,'load_runtime_org',side_effect=AssertionError('seam bypass')):
                self.assertEqual(pgdoor._resolve(maildoor.MESSAGE,self.slug,call,args),spec)
        finally: pgdoor._SEAM.snapshot=old

    def test_malformed_scope_does_not_break_unrelated_runtime_reads(self):
        org=store.load_org(self.slug)
        org.d['work_items'][0]['scope']=3
        store.save_org(org)
        # Legacy malformed scope is not interpreted until a caller uses it.
        self.assertEqual(store.load_runtime_org(self.slug).nodes['a']['id'],'a')
        lazy=store.load_runtime_org(self.slug)
        self.assertFalse(lazy.d['work_items'][0]._loaded)
        self.assertEqual(lazy.d['work_items'][0]['scope'],3)


    def test_runtime_gate_projection_is_coherent_and_reads_committed_holds(self):
        from orgtree import halt
        org=store.load_org(self.slug)
        org.nodes['a']['halt']=False
        org.d['killswitch']=None
        store.save_org(org)
        with patch.object(store,'cached_org',side_effect=AssertionError('eager gate')):
            self.assertIsNone(halt.blocked(self.slug,'a'))
            with orgtx.org_tx(self.slug,nodes=['a'],sections=['killswitch']) as tx:
                tx.org.nodes['a']['halt']=True
                tx.d['killswitch']={'at':'now','by':'user'}
            self.assertEqual(halt.blocked(self.slug,'a'),'halt')
            self.assertEqual(halt.blocked(self.slug,'missing'),'killswitch')
            with orgtx.org_tx(self.slug,nodes=['a']) as tx:
                tx.org.nodes['a']['halt']=False
            self.assertEqual(halt.blocked(self.slug,'a'),'killswitch')
        # A commit after the statement has executed cannot mix its node with
        # a newer latch. PgConn buffers the statement's complete result.
        original=pgstore.PgConn.execute
        fired=[]
        def execute(conn,sql,params=()):
            result=original(conn,sql,params)
            if '__runtime_node' in sql and not fired:
                fired.append(True)
                with orgtx.org_tx(self.slug,nodes=['a'],sections=['killswitch']) as tx:
                    tx.org.nodes['a']['halt']=True
                    tx.d['killswitch']=None
            return result
        with patch.object(pgstore.PgConn,'execute',execute):
            before=store.read_runtime_node(self.slug,'a',('killswitch',))
        self.assertEqual(fired,[True])
        self.assertFalse(before['node']['halt'])
        self.assertTrue(before['killswitch'])
        after=store.read_runtime_node(self.slug,'a',('killswitch',))
        self.assertTrue(after['node']['halt'])
        self.assertIsNone(after['killswitch'])

    def test_runtime_node_projection_excludes_work_and_preserves_legacy_fallback(self):
        seen,watch=self.watch()
        with watch:
            row=store.read_runtime_node(self.slug,'a',('spend_frozen','storage_blocked'))
        self.assertEqual(row['node']['id'],'a')
        self.assertEqual(len(seen),1,seen)
        self.assertIn('UNION ALL',seen[0][0])
        self.assertNotIn('work_items',str(seen))
        with self.assertRaises(ValueError): store.read_runtime_node(self.slug,'a',('work_items',))
        self.assertIsNone(store.read_runtime_node(self.slug,'absent')['node'])
        with patch.object(store,'row_store',return_value=False):
            self.assertIsNone(store.read_runtime_node(self.slug,'a'))


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class WorkRefsListing(unittest.TestCase):
    """Every load lists all active items' versions in ONE row, whatever the
    docket size (message-send-reads-grow-above-n-100-985-rows-1-2, option B:
    same keys and versions, so the checks are exactly as before)."""
    setUpClass = LazyRows.setUpClass

    def setUp(self):
        self.slug = f._fresh_org('wlist-' + self._testMethodName[-20:])
        org = store.load_org(self.slug)
        org.d['work_items'] = items()
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx: pass   # heal epoch

    def grow(self, n):
        with orgtx.org_tx(self.slug, sections=['work_items', 'asks']) as tx:
            for i in range(n):
                tx.d['work_items'].append({'slug': f'extra-{i:02d}', 'notification_attention_active': False,
                                           'nested': {'values': []}, 'rev': 1})

    def listing_rows(self, body):
        """Rows the version listing returned, per listing statement."""
        counts = []; original = pgstore.PgConn.execute
        class Counted:
            def __init__(s, cur): s.cur = cur
            def fetchone(s):
                r = s.cur.fetchone(); counts.append(1 if r is not None else 0); return r
            def fetchall(s):
                r = s.cur.fetchall(); counts.append(len(r)); return r
            def __getattr__(s, name): return getattr(s.cur, name)
        def execute(c, sql, params=()):
            result = original(c, sql, params)
            if 'starts_with(key' in sql and params and params[0] == workrows.PREFIX:
                return Counted(result)
            return result
        with patch.object(pgstore.PgConn, 'execute', execute):
            body()
        return counts

    def node_tx(self):
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['last_status'] = {'summary': 'node only'}

    def test_a_load_lists_every_item_version_in_one_row(self):
        small = self.listing_rows(self.node_tx)
        self.grow(30)
        large = self.listing_rows(self.node_tx)
        self.assertTrue(small, 'control: the listing ran')
        self.assertEqual(small, [1] * len(small))
        self.assertEqual(large, small)

    def test_the_listing_still_carries_every_item_and_its_version(self):
        self.grow(3)
        with store._POOL.acquire(self.slug) as conn:
            rows = {workrows.SECTION: conn.execute('SELECT val FROM doc WHERE key=?',
                                                   (workrows.SECTION,)).fetchone()[0]}
            store._load_work_refs(conn, self.slug, rows)
            stored = {k: tuple(v) for k, *v in conn.execute(
                "SELECT key, xmin::text, ctid::text, tableoid::text FROM doc "
                "WHERE starts_with(key, ?)", (workrows.PREFIX,)).fetchall()}
        refs = {k: v for k, v in rows.items() if k != workrows.SECTION}
        self.assertEqual(set(refs), set(stored))
        self.assertEqual(len(refs), 5)
        for key, ref in refs.items():
            if isinstance(ref, store._WorkRowRef):
                self.assertEqual(ref.version, stored[key])

    def test_a_missing_item_row_is_still_an_identity_mismatch(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('DELETE FROM doc WHERE key=?', (workrows.PREFIX + 'two',))
        with self.assertRaises(ValueError):
            store._load_sqlite_org(self.slug, lazy_work=True)

    def test_orphaned_item_rows_are_still_refused(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('DELETE FROM doc WHERE key=?', (workrows.SECTION,))
        with self.assertRaises(ValueError):
            store._load_sqlite_org(self.slug, lazy_work=True)

    def test_an_org_with_no_docket_lists_nothing(self):
        slug = f._fresh_org('wlist-empty-' + self._testMethodName[-8:])
        with orgtx.org_tx(slug, nodes=['a']) as tx:
            self.assertEqual(list(tx.d.get('work_items') or []), [])

if __name__=='__main__': unittest.main()
