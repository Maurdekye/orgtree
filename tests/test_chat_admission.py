"""Transcript saturation must leave the real control API responsive."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import httpx

_root = tempfile.TemporaryDirectory(prefix='v2-chat-admission-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orgtree import api, ledger, store, supervisor
from engine.launch import TokenGate
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class ChatAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        store._POOL.close_all('admission')

    async def test_chat_and_transcript_tools_do_not_exhaust_control_workers(self):
        org = store.create_org('admission')
        org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(org)
        release = threading.Event()
        guard = threading.Lock()
        active = 0
        maximum = 0
        entered = 0

        def read(org, node, **kwargs):
            nonlocal active, maximum, entered
            with guard:
                active += 1; entered += 1; maximum = max(maximum, active)
            try:
                if not release.wait(8):
                    raise RuntimeError('test did not release transcript readers')
                return {'messages':[{'role':'assistant','text':'completed exact read'}],
                        'busy':False, 'occupancy':None, 'live':[], 'queued':0}
            finally:
                with guard:
                    active -= 1

        transport = httpx.ASGITransport(app=TokenGate(api.app, 'operator'))
        async with httpx.AsyncClient(transport=transport, base_url='http://test',
                headers={'X-Orgtree-Desktop-Token':'operator'}) as client:
            with patch.object(supervisor, 'read_chat', side_effect=read):
                tasks = [asyncio.create_task(client.get('/api/orgs/admission/nodes/agent/chat')) for _ in range(40)]
                tasks += [asyncio.create_task(client.post('/api/agent', json={
                    'org':'admission','node':'agent','tool':'orgtree_read_transcript',
                    'args':{'node':'agent','last':8}})) for _ in range(8)]
                try:
                    deadline = asyncio.get_running_loop().time() + 3
                    while entered < 4 and asyncio.get_running_loop().time() < deadline:
                        await asyncio.sleep(.01)
                    self.assertGreaterEqual(entered, 4, 'positive control: chat reads are really blocked')
                    response = await asyncio.wait_for(client.get('/api/orgs'), timeout=1)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertIn('admission', response.text)
                    self.assertEqual(maximum, 4)
                finally:
                    release.set()
                    results = await asyncio.gather(*tasks)
                self.assertEqual(len(results), 48)
                for result in results:
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertIn('completed exact read', result.text)
        store._POOL.close_all('admission')


if __name__ == '__main__':
    unittest.main()
