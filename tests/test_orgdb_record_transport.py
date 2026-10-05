"""Socket ordering and races using real stateless record readers, no database."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import json
import unittest

from orgtree.orgdb import record_reads as Q, record_transport as T
from orgtree.orgdb.record_registry import Entity, Registry, Selection, Snapshot


class Raw:
    def __init__(self, entries):
        self.entries = entries
        self.rows = []

    def execute(self, sql, args):
        low, high, bound = args
        self.rows = sorted({(entity,key) for rev,entity,key in self.entries if low<rev<=high})[:bound]
        return self

    def fetchall(self):
        return self.rows


class Queues(unittest.IsolatedAsyncioTestCase):
    async def test_large_subscription_encodes_one_page_and_drains_without_reset(self):
        q = T.FrameQueue(max_frames=1,max_bytes=256)
        pages = tuple(dict(type='record_subscribed',sub=1,page=n,final=n==999,
                           records=[dict(body='x'*60)]) for n in range(1000))
        self.assertTrue(q.offer_pages(pages))
        self.assertEqual(len(q.frames),1)
        for page in pages:
            self.assertLessEqual(q.bytes,256)
            self.assertEqual(json.loads(await q.take()),page)
        self.assertEqual((q.bytes,len(q.frames)),(0,0))

    async def test_pages_stay_between_earlier_and_later_frames(self):
        q = T.FrameQueue(max_frames=3,max_bytes=512)
        self.assertTrue(q.offer(dict(type='before')))
        self.assertTrue(q.offer_pages([dict(type='page',page=n) for n in range(20)]))
        self.assertTrue(q.offer(dict(type='after')))
        self.assertEqual(json.loads(await q.take())['type'],'before')
        self.assertEqual([json.loads(await q.take())['page'] for _ in range(20)],list(range(20)))
        self.assertEqual(json.loads(await q.take())['type'],'after')

    async def test_later_oversize_page_resets_and_notifies_the_host(self):
        faults = []
        q = T.FrameQueue(max_bytes=128,overflow=lambda:faults.append('overflow'))
        self.assertTrue(q.offer_pages([dict(type='page',page=0),dict(body='x'*200)]))
        self.assertEqual(json.loads(await q.take())['page'],0)
        self.assertEqual(faults,['overflow'])
        self.assertEqual(json.loads(await q.take()),dict(type='record_reset'))
        self.assertEqual((q.bytes,len(q.frames)),(0,0))

    async def test_later_backlog_and_app_oversize_batches_keep_overflow_policy(self):
        q = T.FrameQueue(max_frames=1)
        self.assertTrue(q.offer_pages([dict(type='page')]*20))
        self.assertFalse(q.offer(dict(type='backlog')))
        self.assertEqual(json.loads(await q.take()),dict(type='record_reset'))
        q = T.FrameQueue(max_bytes=128,reset=False)
        self.assertTrue(q.offer_pages([dict(type='page'),dict(body='x'*200)]))
        self.assertEqual(json.loads(await q.take())['type'],'page')
        self.assertTrue(q.closed)
        self.assertIsNone(await q.take())

    async def test_queue_preserves_order_and_counts_actual_wire_bytes(self):
        q = T.FrameQueue(max_frames=4,max_bytes=256)
        frame = dict(type='value',body='emoji\U0001f600 and lone \ud800')
        self.assertTrue(q.offer(frame))
        size = q.bytes
        self.assertTrue(q.offer(dict(type='second')))
        first = await q.take()
        self.assertEqual(json.loads(first),frame)
        self.assertEqual(size,len(first.encode('utf-8')))
        self.assertEqual(json.loads(await q.take())['type'],'second')
        self.assertEqual(q.bytes,0)
        waiter = asyncio.create_task(q.take())
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        q.close()
        self.assertIsNone(await waiter)
        self.assertFalse(q.offer(frame))

    async def test_org_overflow_discards_entire_old_queue_and_resets(self):
        for q, frame in ((T.FrameQueue(max_frames=1),dict(type='second')),
                         (T.FrameQueue(max_bytes=64),dict(body='x'*65)),
                         (T.FrameQueue(max_bytes=64),dict(body='x'*30))):
            self.assertTrue(q.offer(dict(body='x'*20)))
            self.assertFalse(q.offer(frame))
            self.assertEqual(json.loads(await q.take()),dict(type='record_reset'))
            self.assertEqual(q.bytes,0)
            self.assertFalse(q.closed)
        q.offer(dict(type='fresh'))
        self.assertEqual(json.loads(await q.take())['type'],'fresh')

    async def test_app_overflow_closes_instead_of_sending_an_org_reset(self):
        q = T.FrameQueue(max_frames=1,reset=False)
        q.offer(dict(type='registry_snapshot'))
        self.assertFalse(q.offer(dict(type='app_runtime')))
        self.assertTrue(q.closed)
        self.assertIsNone(await q.take())

    async def test_coalesced_work_serializes_repeated_wakes_and_cancellation(self):
        began, release = asyncio.Event(),asyncio.Event()
        calls, errors = [],[]
        async def read():
            calls.append(len(calls))
            began.set()
            await release.wait()
        runner = T.CoalescedRunner(read,errors.append)
        runner.wake()
        await began.wait()
        for _ in range(10):
            runner.wake()
        self.assertEqual(calls,[0])
        release.set()
        await runner.idle()
        self.assertEqual(calls,[0,1])
        release.clear()
        runner.wake()
        await asyncio.sleep(0)
        await runner.close()
        runner.wake()
        self.assertIsNone(runner.task)
        self.assertEqual(errors,[])


class Runner(unittest.IsolatedAsyncioTestCase):
    async def test_subscription_batch_queues_once_after_catchup_and_before_cursor(self):
        sent = []
        def pages(batch):
            sent.append((batch,self.runner.cursor.rev,1 in self.runner.clients['a'].pending))
            return True
        self.runner.clients['a'].send_pages = pages
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.runner.run.idle()
        self.assertEqual([f['type'] for f in self.sent['a']],['record_changes'])
        self.assertEqual((len(sent),sent[0][1:]),(1,(1,True)))
        self.assertTrue(sent[0][0][-1]['final'])
        self.assertEqual(self.runner.clients['a'].pending,set())

    async def asyncSetUp(self):
        self.stamp = dict(org_uuid='uuid',incarnation='inc',org_revision=1,floor=0)
        self.rows = {'1':dict(title='one'), '2':dict(title='two'), '9':dict(title='nine')}
        self.entries = []
        self.seen, self.errors, self.sent = [],[],{}
        self.delay, self.release = asyncio.Event(),asyncio.Event()
        self.pause = False
        registry = self.registry = Registry()
        registry.register(Entity('agent',
            lambda state,s: frozenset(('1','2')) if s.set=='shared' else frozenset((*s.agents,'1')),
            lambda state,ids: {key:state.cache['rows'][key] for key in ids}))
        async def load(after, requests):
            state = Snapshot(Raw(list(self.entries)),'org',dict(self.stamp),123,
                             dict(rows=copy.deepcopy(self.rows)))
            self.seen.append((state,requests))
            if self.pause:
                self.pause = False
                self.delay.set()
                await self.release.wait()
            return T.read_snapshot(registry,state,after,requests)
        self.runner = T.OrgRunner(load,self.errors.append)
        self.runner.join('a',self.sender('a'))
        await self.runner.run.idle()

    def sender(self, token):
        def send(frame):
            self.sent.setdefault(token,[]).append(copy.deepcopy(frame))
            return True
        return send

    async def asyncTearDown(self):
        await self.runner.close()
        self.assertEqual(self.errors,[])

    def write(self, key, title):
        self.stamp['org_revision'] += 1
        self.rows[key]['title'] = title
        self.entries.append((self.stamp['org_revision'],'agent',key))

    async def test_unchanged_subscription_uses_same_snapshot_catchup_then_answer(self):
        self.assertEqual(self.sent.get('a',[]),[])
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.runner.run.idle()
        changes, answer = self.sent['a']
        self.assertEqual((changes['from'],changes['to']),(1,1))
        self.assertEqual(answer['type'],'record_subscribed')
        self.assertEqual((answer['sub'],answer['rev']),(1,1))
        self.assertEqual({r['id'] for r in answer['records']},{'1','9'})
        self.assertEqual({r['set'] for r in answer['records']},{'sub:1'})
        self.assertEqual(self.runner.clients['a'].pending,set())
        self.assertEqual(self.stamp['org_revision'],1)

    async def test_multiple_sockets_receive_their_sets_before_cursor_advances(self):
        self.runner.join('b',self.sender('b'))
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        self.runner.subscribe('b',dict(sub=4,agents=['2']))
        await self.runner.run.idle()
        self.sent.clear()
        self.write('9','changed nine')
        queued = []
        for token,client in self.runner.clients.items():
            send = client.send
            def callback(frame, token=token, send=send):
                queued.append((token,self.runner.cursor.rev))
                return send(frame)
            client.send = callback
        self.runner.wake()
        await self.runner.run.idle()
        self.assertEqual(queued,[('a',1),('b',1)])
        self.assertEqual(self.runner.cursor.rev,2)
        self.assertEqual({r['set'] for r in self.sent['a'][0]['upserts']},{'sub:1'})
        self.assertEqual(self.sent['b'][0]['upserts'],[])
        self.assertEqual(len(self.seen[-1][1]),2)

    async def test_live_change_during_read_repeats_without_a_concurrent_worker(self):
        self.pause = True
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.delay.wait()
        old_reads = len(self.seen)
        self.write('9','newest')
        for _ in range(10):
            self.runner.wake()
        self.assertEqual(len(self.seen),old_reads)
        self.release.set()
        await self.runner.run.idle()
        self.assertEqual(len(self.seen),old_reads+1)
        changes,answer,last = self.sent['a']
        self.assertEqual((changes['to'],answer['rev'],last['from'],last['to']),(1,1,1,2))
        self.assertEqual(next(r['body']['title'] for r in last['upserts'] if r['id']=='9'),'newest')

    async def test_unsubscribe_and_new_generation_during_read_reject_old_answer(self):
        self.pause = True
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.delay.wait()
        self.runner.unsubscribe('a',1)
        self.runner.subscribe('a',dict(sub=2,agents=['2']))
        self.release.set()
        await self.runner.run.idle()
        answers = [f for f in self.sent['a'] if f['type']=='record_subscribed']
        self.assertEqual([f['sub'] for f in answers],[2])
        self.assertEqual(set(self.runner.clients['a'].selections),{2})
        self.sent.clear()
        self.write('9','not held now')
        self.runner.wake()
        await self.runner.run.idle()
        self.assertFalse(any(r['set']=='sub:1' for frame in self.sent['a']
            for r in frame.get('upserts',[])+frame.get('tombstones',[])))

    async def test_disconnected_token_reuse_cannot_receive_old_worker_answer(self):
        self.pause = True
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.delay.wait()
        self.runner.leave('a')
        self.runner.join('a',self.sender('new-a'))
        self.release.set()
        await self.runner.run.idle()
        self.assertEqual(self.sent.get('new-a',[]),[])
        self.assertEqual(self.sent.get('a',[]),[])

    async def test_replacement_lower_revision_and_floor_reset_without_another_write(self):
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.runner.run.idle()
        self.sent.clear()
        self.stamp.update(incarnation='replacement',org_revision=0)
        self.runner.wake()  # reconnect/poll supplies this wake even with no later commit
        await self.runner.run.idle()
        self.assertEqual(self.sent['a'],[dict(type='record_reset')])
        self.assertEqual(self.runner.cursor,Q.Cursor('uuid','replacement',0))
        self.assertEqual(self.runner.clients['a'].selections,{})
        self.runner.subscribe('a',dict(sub=2,agents=['9']))
        await self.runner.run.idle()
        self.sent.clear()
        self.stamp.update(org_revision=1,floor=1)
        self.runner.wake()
        await self.runner.run.idle()
        self.assertEqual(self.sent['a'],[dict(type='record_reset')])

    async def test_queue_overflow_for_one_socket_does_not_block_other_socket(self):
        q = T.FrameQueue(max_frames=1)
        self.runner.join('b',self.sender('b'))
        self.runner.clients['a'].send = q.offer
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.runner.run.idle()
        self.assertEqual(self.runner.clients['a'].selections,{})
        self.assertEqual(json.loads(await q.take()),dict(type='record_reset'))
        self.write('1','changed shared')
        self.runner.wake()
        await self.runner.run.idle()
        self.assertEqual(self.runner.cursor.rev,2)
        self.assertEqual(self.sent['b'][-1]['to'],2)

    async def test_generation_and_per_set_bounds_validate_before_worker_read(self):
        self.runner.subscribe('a',dict(sub=1,agents=['9']))
        await self.runner.run.idle()
        read_count = len(self.seen)
        for args in (dict(sub=1),dict(sub=0),dict(sub=True),dict(sub=2,previous_members=['1']),
            dict(sub=2,windows=[dict(kind='not-registered')]),
            dict(sub=2,agents=[str(n) for n in range(10,139)])):
            with self.assertRaises(ValueError):
                self.runner.subscribe('a',args)
        self.assertEqual(len(self.seen),read_count)
        self.assertEqual(set(self.runner.clients['a'].selections),{1})

    async def test_all_pages_are_ordered_and_generation_stays_pending_until_final(self):
        for n in range(300):
            self.rows[str(n+10)] = dict(title=str(n))
        # A predicate window may hold more than the explicit include bound.
        self.registry.entities['agent'] = Entity('agent',
            lambda state,s:frozenset(('1','2')) if s.set=='shared' else frozenset(state.cache['rows']),
            lambda state,ids:{key:state.cache['rows'][key] for key in ids})
        observed = []
        send = self.runner.clients['a'].send
        def capture(frame):
            if frame['type'] == 'record_subscribed':
                observed.append((frame['page'],1 in self.runner.clients['a'].pending))
            return send(frame)
        self.runner.clients['a'].send = capture
        self.runner.subscribe('a',dict(sub=1))
        await self.runner.run.idle()
        pages = [p for p in self.sent['a'] if p['type']=='record_subscribed']
        self.assertEqual(observed,[(0,True),(1,True),(2,True)])
        self.assertEqual([p['final'] for p in pages],[False,False,True])
        self.assertEqual(len({r['id'] for p in pages for r in p['records']}),303)
        self.assertEqual(self.runner.clients['a'].pending,set())


if __name__ == '__main__':
    unittest.main()
