"""Records routes, bounded native queues and legacy feed/socket preservation."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, WebSocketDisconnect
from orgtree import api, record_api as A, pgfeed, orgtx
from orgtree.orgdb import record_reads as Q


class Routes(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # These transport controls supply their host/storage responses; actual
        # readiness and per-org migration gates have separate controls below.
        ready = patch.object(A, 'capable', return_value=True)
        ready.start()
        self.addCleanup(ready.stop)

    async def test_selection_route_is_no_store_and_does_not_build_tree_or_host(self):
        answer = dict(cursor=dict(org_uuid='u',incarnation='i',rev=2),
                      names={'lone\ud800':'5'},missing=['gone'],matches=['9'])
        with patch.object(A.orgdb,'enabled',return_value=True), \
                patch.object(A.S,'resolve',return_value=answer) as resolve, \
                patch.object(A,'host',side_effect=AssertionError('selection created a host')):
            result = await A.selection('slug',json.dumps(dict(names=['lone\ud800','gone'],search=dict(query=' OLD '))))
        self.assertEqual(result.headers['cache-control'],'no-store')
        self.assertEqual(json.loads(result.body),answer)
        resolve.assert_called_once_with('slug',('lone\ud800','gone'),dict(query='old',state=None))

    async def test_invalid_selection_rejects_before_snapshot_and_disabled_storage_refuses(self):
        with patch.object(A.S,'resolve',side_effect=AssertionError('invalid selection reached snapshot')):
            for args in (dict(names=['']),dict(names=['x'*256]*300),dict(search=dict(query='x',state='bad'))):
                with self.assertRaises(HTTPException) as caught:
                    await A.selection('slug',json.dumps(args))
                self.assertEqual(caught.exception.status_code,422)
            with patch.object(A.orgdb,'enabled',return_value=False):
                with self.assertRaises(HTTPException) as caught:
                    await A.selection('slug','{}')
                self.assertEqual(caught.exception.status_code,501)

    async def test_actual_hub_writer_drains_large_subscription_pages_in_order(self):
        hub = api.Hub()
        received = []
        box = api._Outbox('slug')
        box.max_frames,box.max_bytes = 3,512
        async def send(text):
            received.append(json.loads(text))
            if received[-1]['type'] == 'after':
                box.close()
        # A real WebSocket is hashable; SimpleNamespace is not.
        class Socket:
            send_text = staticmethod(send)
        socket = Socket()
        hub._boxes[socket] = box
        self.assertTrue(hub.record(socket,dict(type='before')))
        pages = tuple(dict(type='record_subscribed',sub=2,page=n,final=n==299,
                           records=[dict(body='x'*50)]) for n in range(300))
        self.assertTrue(hub.record_pages(socket,pages))
        self.assertTrue(hub.record(socket,dict(type='after')))
        await asyncio.wait_for(hub._writer('slug',socket,box),2)
        self.assertEqual(received,[dict(type='before'),*pages,dict(type='after')])
        self.assertEqual(box.sent,302)
        self.assertEqual((box.bytes,len(box.frames)),(0,0))
        hub.leave('slug',socket)

    async def test_snapshot_and_same_cursor_changes_emit_runtime_without_shared_cache(self):
        runtime = dict(type='agent_runtime',org_uuid='u',incarnation='i',epoch='e',seq=4,
                       agents={'1':dict(title='lone\ud800')})
        instance = SimpleNamespace(http=AsyncMock(return_value=dict(type='record_snapshot',
            cursor=dict(org_uuid='u',incarnation='i',rev=2),records=[],runtime=runtime)))
        with patch.object(A,'host',return_value=instance):
            result = await A.records('slug')
            self.assertEqual(result.headers['cache-control'],'no-store')
            self.assertEqual(json.loads(result.body)['runtime'],runtime)
            self.assertIn(b'\\ud800',result.body)
            instance.http.assert_awaited_once_with()
            instance.http.reset_mock()
            await A.changes('slug','2','u','i','[{"sub":3,"agents":["7"]}]')
            args = instance.http.await_args.kwargs
            self.assertEqual(args['after'],Q.Cursor('u','i',2))
            self.assertEqual(args['selections'][0].agents,('7',))
            self.assertEqual(args['selections'][0].set,'sub:3')

    async def test_invalid_cursor_and_subscription_reject_before_host_or_database(self):
        with patch.object(A,'host',side_effect=AssertionError('invalid query reached host')):
            for after,subs in [('01','[]'),('-1','[]'),('1.0','[]'),('1','null'),
                    ('1','[{"sub":1,"agents":["007"]}]'),
                    ('1','[{"sub":1,"windows":[{"kind":"unknown"}]}]'),
                    (str(2**53),'[]')]:
                with self.assertRaises(HTTPException) as caught:
                    await A.changes('slug',after,'u','i',subs)
                self.assertEqual(caught.exception.status_code,422)

    async def test_native_off_returns_unavailable_without_creating_a_host(self):
        with patch.object(A.orgdb,'enabled',return_value=False), patch.dict(A.hosts,{},clear=True):
            with self.assertRaises(HTTPException) as caught:
                await A.records('slug')
            self.assertEqual(caught.exception.status_code,501)
            self.assertFalse(A.hosts)

    async def test_missing_org_host_is_removed_and_closed(self):
        current = SimpleNamespace(http=AsyncMock(side_effect=A.foreground_store.OrgNotFound('missing')),
                                  close=AsyncMock())
        with patch.object(A,'host',return_value=current),patch.dict(A.hosts,{'missing':current},clear=True):
            with self.assertRaises(HTTPException) as caught:
                await A.records('missing')
            self.assertEqual(caught.exception.status_code,404)
            current.close.assert_awaited_once()
            self.assertFalse(A.hosts)

    async def test_native_socket_full_connect_parse_and_disconnect_keep_legacy_pings(self):
        socket = SimpleNamespace(receive_text=AsyncMock(side_effect=[
            'ping','{"type":"subscribe","sub":2,"agents":["7"]}',
            '{"type":"unsubscribe","sub":2}',WebSocketDisconnect()]))
        current = SimpleNamespace(join=AsyncMock(return_value=True),runner=Mock(),leave=Mock(),unsubscribe=Mock())
        hub = SimpleNamespace(join=AsyncMock(),record=Mock(return_value=True),
                              record_pages=Mock(return_value=True),leave=Mock())
        with patch.object(api,'hub',hub),patch.object(A,'READY',True), \
                patch.object(A.orgdb,'enabled',return_value=True),patch.object(A,'host',return_value=current):
            await api.org_ws(socket,'slug')
            current.join.assert_awaited_once()
            self.assertTrue(current.join.await_args.args[2](({'type':'record_subscribed'},)))
            hub.record_pages.assert_called_once_with(socket,({'type':'record_subscribed'},))
            current.runner.subscribe.assert_called_once_with(socket,dict(sub=2,agents=['7']))
            current.unsubscribe.assert_called_once_with(socket,2)
            current.leave.assert_called_once_with(socket)
        current.join.reset_mock()
        socket.receive_text = AsyncMock(side_effect=['arbitrary old ping',WebSocketDisconnect()])
        with patch.object(api,'hub',hub),patch.object(A,'READY',False), \
                patch.object(A,'capable',return_value=False):
            await api.org_ws(socket,'slug')
            current.join.assert_not_awaited()

    async def test_actual_hub_record_queue_bounds_bytes_and_suppresses_changed_only(self):
        hub = api.Hub()
        socket = object()
        box = api._Outbox('slug')
        hub._boxes[socket] = box
        hub.rooms['slug'] = {socket}
        self.assertTrue(hub.record(socket,dict(type='agent_runtime',full=True)))
        await hub._send('slug',dict(type='changed'))
        self.assertEqual(len(box.frames),1)
        await hub._send('slug',dict(type='mail',body='animation'))
        self.assertEqual([json.loads(t)['type'] for t,_ in box.frames],['agent_runtime','mail'])
        self.assertEqual(box.bytes,sum(size for _,size in box.frames))
        self.assertFalse(hub.record(socket,dict(type='record_changes',body='x'*box.max_bytes)))
        self.assertEqual([json.loads(t) for t,_ in box.frames],[dict(type='record_reset')])
        hub.leave('slug',socket)
        self.assertFalse(hub.record(socket,dict(type='agent_runtime')))


class Feed(unittest.TestCase):
    def test_native_feed_notifies_subscribers_for_local_and_replaced_orgs_without_local_bookkeeping(self):
        class Loop:
            def call_soon_threadsafe(self, callback, *args):
                callback(*args)
        with patch.object(api,'_REV_FEED',None),patch.object(api,'_LOOP',Loop()), \
                patch.object(A.orgdb,'enabled',return_value=True),patch.object(A,'READY',True), \
                patch.object(pgfeed,'RevisionFeed') as constructor, \
                patch.object(api.store,'external_change') as invalidated, \
                patch.object(api,'hub_changed') as changed,patch.object(A,'observed') as observed, \
                patch.object(orgtx,'commit_listeners',[]) as listeners:
            api._start_revision_feed()
            callback = constructor.call_args.args[1]
            for args in [('slug',4,False),('slug',0,True)]:
                callback(*args)
            self.assertEqual([c.args for c in observed.call_args_list],[('slug',4,False),('slug',0,True)])
            self.assertEqual(invalidated.call_count,2)
            self.assertEqual([c.args for c in changed.call_args_list],[('slug',),('slug',)])
            self.assertEqual(listeners,[])
            constructor.return_value.start.assert_called_once()

    def test_switch_off_uses_existing_engine_callback_and_local_commit_listener(self):
        with patch.object(api,'_REV_FEED',None),patch.object(A.orgdb,'enabled',return_value=False), \
                patch.object(pgfeed,'RevisionFeed') as constructor, \
                patch.object(pgfeed,'engine_callback',return_value='legacy callback') as callback, \
                patch.object(pgfeed,'note_local') as note,patch.object(orgtx,'commit_listeners',[]) as listeners:
            api._start_revision_feed()
            self.assertEqual(constructor.call_args.args[1],'legacy callback')
            callback.assert_called_once()
            self.assertEqual(len(listeners),1)
            listeners[0](SimpleNamespace(slug='slug',revision=5))
            note.assert_called_once_with('slug',5)


if __name__ == '__main__':
    unittest.main()
