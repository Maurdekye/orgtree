"""Host lifecycle: stale snapshots, replacements and ordered runtime copies."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import threading
import unittest

from orgtree.orgdb import record_host as H, record_reads as Q, record_transport as T
from orgtree.orgdb.record_registry import Registry, Entity, Selection
from orgtree.orgdb.record_runtime import AgentOverlays, HostClock


class Overlay(AgentOverlays):
    thread = None
    memory = {'busy':False}
    def __init__(self, *args):
        super().__init__(*args, clock=HostClock())
        self._contexts = {}
        self.boot_at = ''

    def _fields(self, key):
        if threading.get_ident() != self.thread:
            raise AssertionError('runtime sampled on a worker')
        return dict(title=self._bodies[key]['title'], **self.memory,
                    models=copy.deepcopy(self._models))

    def adopt(self, bodies, contexts, *, removed=()):
        self._contexts.update(contexts)
        return self.update(bodies, removed=removed)

    def transition(self, names=None):
        return self._refresh(self._bodies)


class Host(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        Overlay.thread = threading.get_ident()
        Overlay.memory = {'busy':False}
        self.current = Q.Cursor('uuid','original',1)
        self.rows = {'1':dict(id='a',title='one'), '9':dict(id='pin',title='nine')}
        self.models = {'org':dict(window=1)}
        self.errors, self.sent, self.calls = [],[],[]
        self.started, self.release = threading.Event(),threading.Event()
        self.pause = False
        self.registry = Registry()
        self.registry.register(Entity('agent', lambda *_:frozenset(),lambda *_:{}))
        self.host = H.OrgHost('org',self.errors.append,registry=self.registry,
                             worker=self.worker,overlay_factory=Overlay)

    async def asyncTearDown(self):
        self.release.set()
        await self.host.close()
        self.assertEqual(self.errors,[])

    def worker(self, kind, after, requests, selections):
        self.assertNotEqual(threading.get_ident(),Overlay.thread)
        cursor = self.current
        held = {'1'} | {key for s in selections for key in s.agents}
        rows = {key:copy.deepcopy(self.rows[key]) for key in held if key in self.rows}
        inputs = H.RuntimeInputs(cursor,rows,{key:dict(retained=True) for key in rows},
                                 copy.deepcopy(self.models))
        self.calls.append((kind,cursor,tuple(selections)))
        if self.pause:
            self.pause = False
            self.started.set()
            if not self.release.wait(5):
                raise AssertionError('control barrier was not released')
        records = lambda s:[dict(entity='agent',id=k,body=v,set=s) for k,v in rows.items()]
        if kind == 'batch':
            changes,answers = {},{}
            for token,r in requests.items():
                reset = after and (after.org_uuid,after.incarnation) != (cursor.org_uuid,cursor.incarnation)
                changes[token] = (dict(type='record_reset') if reset else dict(type='record_changes',
                    **cursor.wire(), **{'from':(after or cursor).rev,'to':cursor.rev},
                    upserts=records('shared'),tombstones=[]))
                answers[token] = (() if reset else tuple(dict(type='record_subscribed',sub=g,
                    **cursor.wire(),records=records('sub:'+str(g))) for g in sorted(r.pending)))
            frame = T.Batch(cursor,changes,answers)
        elif kind == 'baseline':
            frame = dict(type='record_snapshot',cursor=cursor.wire(),records=records('shared'))
        else:
            frame = dict(type='record_changes',**cursor.wire(),
                         **{'from':after.rev,'to':cursor.rev},upserts=records('shared'),tombstones=[])
        return frame,inputs

    def send(self, frame):
        self.sent.append(copy.deepcopy(frame))
        return True

    async def barrier(self):
        self.assertTrue(await asyncio.to_thread(self.started.wait,3))

    async def test_first_socket_frame_is_full_and_live_frames_follow_it(self):
        self.assertTrue(await self.host.join('socket',self.send))
        await self.host.runner.run.idle()
        full = self.sent[0]
        self.assertEqual((full['type'],full['full']),('agent_runtime',True))
        Overlay.memory['busy'] = True
        self.host.transition()
        partial = self.sent[-1]
        self.assertFalse(partial['full'])
        self.assertGreaterEqual(partial['seq'], partial['agents']['1']['seq'])
        self.assertGreater(partial['agents']['1']['seq'],full['seq'])
        self.assertTrue(partial['agents']['1']['busy'])

    async def test_delayed_http_copy_samples_current_memory_after_worker_returns(self):
        await self.host.join('socket',self.send)
        await self.host.runner.run.idle()
        self.pause = True
        task = asyncio.create_task(self.host.http())
        await self.barrier()
        Overlay.memory['busy'] = True
        self.host.transition()
        live = self.sent[-1]['agents']['1']
        self.release.set()
        result = await task
        copied = result['runtime']['agents']['1']
        self.assertTrue(copied['busy'])
        self.assertGreater(copied['seq'],live['seq'])
        self.assertEqual(result['cursor']['rev'],1)

    async def test_older_snapshot_cannot_replace_newer_retained_body_or_models(self):
        await self.host.http()
        old = H.RuntimeInputs(self.current,{'1':dict(title='stale')},{'1':{}},{'old':1})
        self.current = Q.Cursor('uuid','original',2)
        self.rows['1']['title'] = 'new'
        await self.host.http()
        self.assertEqual(self.host._adopt(old),{})
        self.assertEqual(self.host.overlay._bodies['1']['title'],'new')
        self.assertEqual(self.host.persisted_models,self.models)

    async def test_gap_fences_delayed_old_identity_without_a_later_write(self):
        await self.host.http()
        self.pause = True
        task = asyncio.create_task(self.host.http())
        await self.barrier()
        self.current = Q.Cursor('uuid','replacement',0)
        self.rows['1']['title'] = 'replaced'
        self.host.observed('org',0,True)
        self.release.set()
        result = await task
        self.assertEqual(result['cursor'],self.current.wire())
        self.assertEqual(result['runtime']['incarnation'],'replacement')
        self.assertIn(('uuid','original'),self.host.retired)
        self.assertEqual(self.host.overlay._bodies['1']['title'],'replaced')

    async def test_subscription_body_precedes_runtime_and_http_keeps_other_socket_pins(self):
        await self.host.join('socket',self.send)
        await self.host.runner.run.idle()
        self.sent.clear()
        self.host.runner.subscribe('socket',dict(sub=1,agents=['9']))
        await self.host.runner.run.idle()
        self.assertEqual([f['type'] for f in self.sent],
                         ['record_changes','record_subscribed','agent_runtime'])
        self.assertTrue(self.sent[-1]['full'])
        self.assertIn('9',self.sent[-1]['agents'])
        await self.host.http()
        self.assertIn('9',self.host.overlay._bodies)
        self.host.runner.unsubscribe('socket',1)
        await self.host.http()
        self.assertNotIn('9',self.host.overlay._bodies)

    async def test_leave_during_initial_copy_does_not_join_a_dead_socket(self):
        self.pause = True
        task = asyncio.create_task(self.host.join('socket',self.send))
        await self.barrier()
        self.host.leave('socket')
        self.release.set()
        self.assertFalse(await task)
        self.assertEqual(self.sent,[])
        self.assertFalse(self.host.runner.clients)

    async def test_catalog_deselection_removes_favourite_without_org_write(self):
        await self.host.http()
        self.host.catalog_changed({'extra':2,'org':99})
        self.assertEqual(self.host.overlay._values['1']['models'],{'extra':2,'org':{'window':1}})
        self.host.catalog_changed({})
        self.assertEqual(self.host.overlay._values['1']['models'],self.models)
        self.assertEqual(self.host.input_cursor.rev,1)

    async def test_socket_queue_rejection_clears_subscriptions_without_blocking_http(self):
        await self.host.join('socket',self.send)
        await self.host.runner.run.idle()
        self.host.runner.subscribe('socket',dict(sub=1,agents=['9']))
        await self.host.runner.run.idle()
        self.host.sends['socket'] = lambda _frame:False
        Overlay.memory['busy'] = True
        self.host.transition()
        self.assertFalse(self.host.runner.clients['socket'].selections)
        self.assertEqual((await self.host.http())['cursor']['rev'],1)

    async def test_reentrant_disconnect_during_runtime_send_does_not_raise(self):
        await self.host.join('socket',self.send)
        await self.host.runner.run.idle()
        def disconnect(_frame):
            self.host.leave('socket')
            return False
        self.host.sends['socket'] = disconnect
        Overlay.memory['busy'] = True
        self.host.transition()
        self.assertFalse(self.host.runner.clients)
        self.assertFalse(self.host.sends)


class Subscribers(unittest.TestCase):
    def test_all_local_foreign_gap_and_reentrant_subscribers_are_isolated(self):
        errors,calls = [],[]
        subscribers = H.RevisionSubscribers(errors.append)
        def broken(*_):
            raise RuntimeError('subscriber failed')
        remove = subscribers.subscribe(broken)
        subscribers.subscribe(lambda *args:calls.append(args))
        for args in (('org',1,False),('org',2,False),('org',0,True)):
            subscribers.observed(*args)
        self.assertEqual(calls,[('org',1,False),('org',2,False),('org',0,True)])
        self.assertEqual(len(errors),3)
        remove()
        remove()
        subscribers.observed('org',3,False)
        self.assertEqual(len(errors),3)


if __name__ == '__main__':
    unittest.main()
