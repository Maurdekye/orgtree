"""Actual record routes and socket runner share one native org snapshot."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_orgdb_record_tree_pg as tree_fixture
from orgtree import api, record_api as A
from orgtree.orgdb import record_reads as Q

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Host(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse exactly the validated native display seed, including an
        # off-set predecessor and subscription-only retired child.
        tree_fixture.Tree.setUpClass()
        cls.twin, cls.database = tree_fixture.Tree.twin, tree_fixture.Tree.database

    async def test_actual_http_then_subscribe_and_commit_refresh_retained_native_inputs(self):
        with ExitStack() as stack:
            stack.enter_context(fixture.storage(True))
            stack.enter_context(patch.dict(A.hosts,{},clear=True))
            stack.enter_context(patch.object(api.supervisor,'state',return_value={
                'busy':False,'waiting':False,'responding':False,'phase':None,
                'queue':[],'last_error':None,'live':[]}))
            stack.enter_context(patch.object(api.supervisor,'cache_forecast_public',return_value=None))
            stack.enter_context(patch.object(api.warmpool,'process_control_status',return_value={}))
            try:
                response = await A.records(self.twin.copy)
                result = json.loads(response.body)
                self.assertEqual(result['type'],'record_snapshot')
                self.assertEqual(result['runtime']['org_uuid'],result['cursor']['org_uuid'])
                self.assertEqual(result['runtime']['incarnation'],result['cursor']['incarnation'])
                shared = {r['id'] for r in result['records'] if r['entity']=='agent'}
                self.assertEqual(set(result['runtime']['agents']),shared)
                self.assertNotIn('record-private-secret',response.body.decode())
                self.assertNotIn('record-private-mail',response.body.decode())
                with Q.snapshot(self.twin.copy) as state:
                    key = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
                    self.assertEqual(Q.cursor(state).wire(),result['cursor'])
                self.assertNotIn(key,shared)
                sent = []
                current = A.host(self.twin.copy)
                def send(frame):
                    sent.append(frame)
                    return True
                self.assertTrue(await current.join('socket',send))
                await current.runner.run.idle()
                self.assertTrue(sent[0]['full'])
                A.socket_message(current,'socket',json.dumps(dict(type='subscribe',sub=1,agents=[key])))
                await current.runner.run.idle()
                answer = next(f for f in sent if f['type']=='record_subscribed')
                self.assertIn(key,{r['id'] for r in answer['records']})
                context = current.overlay._contexts[key]
                self.assertIn('predecessor',context.nodes)
                sent.clear()
                with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                    raw.execute("UPDATE orgtree.agents SET title='fresh title' WHERE name='retired-2'")
                # No additional source write is needed after the observed rev.
                current.observed(self.twin.copy,0,False)
                await current.runner.run.idle()
                change = next(f for f in sent if f['type']=='record_changes')
                self.assertEqual(next(r['body']['title'] for r in change['upserts']
                    if r['id']==key and r['set']=='sub:1'),'fresh title')
                self.assertEqual(current.overlay._bodies[key]['title'],'fresh title')
                self.assertGreater(current.input_cursor.rev,result['cursor']['rev'])
                catchup = json.loads((await A.changes(self.twin.copy,str(result['cursor']['rev']),
                    result['cursor']['org_uuid'],result['cursor']['incarnation'],
                    json.dumps([dict(sub=1,agents=[key])]))).body)
                self.assertEqual(catchup['to'],current.input_cursor.rev)
                self.assertIn(key,catchup['runtime']['agents'])
                self.assertEqual(next(r['body']['title'] for r in catchup['upserts']
                    if r['id']==key and r['set']=='sub:1'),'fresh title')
            finally:
                await A.close()


    async def test_migration_gate_and_kept_foreground_capability_share_the_snapshot(self):
        from types import SimpleNamespace
        from orgtree import foreground_api as F, foreground_store
        request = SimpleNamespace(state=SimpleNamespace())
        with fixture.storage(True), patch.object(A,'READY',True):
            with Q.snapshot(self.twin.copy) as state:
                self.assertTrue(A.capable(raw=state.raw))
                graph = foreground_store.select_foreground(state.raw,dict(state.stamp),[],piles={})
                with patch.object(api,'_annotate_org_view',side_effect=lambda context,tree,*a,**k:tree), \
                        patch.object(api.supervisor,'primed_restart',return_value=None):
                    payload,saved = F._project(state.raw,state.slug,graph,request,
                                              sync_rev=0,kind='snapshot',keep=True)
                    self.assertTrue(payload['header']['capabilities']['record_changes_v1'])
                    with patch.object(A,'capable',side_effect=AssertionError('reproject read readiness')):
                        again = F._reproject(saved,request,sync_rev=0)
                    self.assertEqual(again,payload)
                    with patch.object(A,'READY',False):
                        off = F._reproject(saved,request,sync_rev=0)
                    self.assertNotIn('capabilities',off['header'])
            # A real missing migration marker refuses, even when the relations
            # exist. Rollback restores the exact marker and the ready path.
            with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                raw.execute('BEGIN')
                try:
                    removed = raw.execute('DELETE FROM orgtree.schema_migrations WHERE name=%s RETURNING name',
                                          ('0018_records.sql',)).fetchall()
                    self.assertEqual(removed,[('0018_records.sql',)])
                    self.assertFalse(A.capable(raw=raw))
                finally:
                    raw.execute('ROLLBACK')
                self.assertTrue(A.capable(raw=raw))

if __name__ == '__main__':
    unittest.main()
