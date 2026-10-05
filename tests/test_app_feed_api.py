"""App route lifecycle and socket cancellation, without a database or live engine."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, WebSocketDisconnect
from orgtree import app_api as A
from orgtree.orgdb.app_host import AppHost
from orgtree.orgdb.record_runtime import HostClock


class API(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.native = patch.object(A.orgdb, 'enabled', return_value=True)
        self.native.start()
        self.ready = patch.object(A.record_api, 'READY', True)
        self.ready.start()
        self.host = AppHost(AsyncMock(return_value=(dict(app_uuid='a', incarnation='i', rev=1), [])),
                            AsyncMock(), Mock(), clock=HostClock())
        self.previous = A.host
        A.host = self.host

    async def asyncTearDown(self):
        await self.host.close()
        A.host = self.previous
        self.ready.stop()
        self.native.stop()

    async def test_http_full_copy_is_no_store_and_escapes_surrogates(self):
        self.host.runtime(values={'providers': {'name': '\ud800'}})
        result = await A.records()
        body = json.loads(result.body)
        self.assertEqual(body['type'], 'app_snapshot')
        self.assertEqual(body['runtime']['values']['providers']['value'], {'name': '\ud800'})
        self.assertEqual(result.headers['cache-control'], 'no-store')
        self.assertIn(b'\\ud800', result.body)

    async def test_switch_off_refuses_without_database_or_host_read(self):
        with patch.object(A.orgdb, 'enabled', return_value=False), \
                patch.object(A.registry, 'session', side_effect=AssertionError('database reached')):
            self.assertFalse(A.capable())
            with self.assertRaises(HTTPException) as caught:
                await A.records()
            self.assertEqual(caught.exception.status_code, 501)
        self.host.read_registry.assert_not_awaited()

    async def test_socket_first_copy_then_peer_disconnect_releases_queue(self):
        frames = []
        sent = asyncio.Event()
        async def send(text):
            frames.append(json.loads(text))
            sent.set()
        async def receive():
            await sent.wait()
            raise WebSocketDisconnect()
        ws = Mock(accept=AsyncMock(), close=AsyncMock(), send_text=send, receive_text=receive)
        await asyncio.wait_for(A.socket(ws), 1)
        self.assertEqual([f['type'] for f in frames], ['app_snapshot'])
        self.assertEqual(self.host.clients, set())
        ws.close.assert_awaited_once()

    async def test_blocked_writer_times_out_and_cancels_receive(self):
        cancelled = asyncio.Event()
        async def receive():
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        async def send(text):
            await asyncio.Future()
        ws = Mock(accept=AsyncMock(), close=AsyncMock(), send_text=send, receive_text=receive)
        with patch.object(A, 'SEND_TIMEOUT', .001):
            await asyncio.wait_for(A.socket(ws), 1)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.host.clients, set())

    async def test_closed_overflow_queue_ends_socket_without_record_reset(self):
        original = self.host.connect
        async def connect():
            return await original(max_bytes=64)
        ws = Mock(accept=AsyncMock(), close=AsyncMock(), send_text=AsyncMock(),
                  receive_text=AsyncMock(side_effect=lambda: asyncio.Future()))
        async def receive():
            await asyncio.Future()
        ws.receive_text = receive
        with patch.object(self.host, 'connect', connect):
            await asyncio.wait_for(A.socket(ws), 1)
        ws.send_text.assert_not_awaited()
        self.assertEqual(self.host.clients, set())

    async def test_route_paths_cannot_take_the_org_named_records(self):
        self.assertEqual({r.path for r in A.router.routes}, {'/api/app/ws', '/api/app/records'})


if __name__ == '__main__':
    unittest.main()
