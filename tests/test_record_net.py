"""Reached hub transitions and real host frames through mounted projection."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from orgtree import net, record_api, api
from orgtree.orgdb import record_host as H, record_reads as Q, record_runtime as R


class Overlay(R.AgentOverlays):
    def adopt(self, *args, **kwargs):
        return {}

    def transition(self, *_):
        return {}


class Net(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.patch = patch.multiple(net, _status={}, _rosters={}, _hub_names={},
                                   notify_changed=None, notify_runtime=None)
        self.patch.start()
        self.cursor = Q.Cursor('hub-test', 'original', 3)
        self.doc = dict(slug='hub-org', net_identity={'slug':'own-public'},
            net_hubs=[dict(id=net.LOCAL_HUB_ID, address='https://hub.invalid', enabled=True)],
            net_state={})
        self.errors, self.sent, self.calls = [], [], []
        self.started, self.release = threading.Event(), threading.Event()
        self.pause = False
        self.host = H.OrgHost('hub-org', self.errors.append,
                             worker=self.worker, overlay_factory=Overlay)

    async def asyncTearDown(self):
        self.release.set()
        await self.host.close()
        self.patch.stop()
        self.assertEqual(self.errors, [])

    def worker(self, kind, after, requests, _selections):
        self.calls.append(kind)
        inputs = H.RuntimeInputs(self.cursor, {}, {}, {}, copy.deepcopy(self.doc))
        if self.pause:
            self.pause = False
            self.started.set()
            if not self.release.wait(4):
                raise AssertionError('unreleased worker')
        if kind == 'batch':
            changes = {token: dict(type='record_changes', **self.cursor.wire(),
                **{'from': (after or self.cursor).rev, 'to': self.cursor.rev}, upserts=[], tombstones=[])
                for token in requests}
            return H.Batch(self.cursor, changes, {token: () for token in requests}), inputs
        return dict(type='record_snapshot', cursor=self.cursor.wire(), records=[]), inputs

    def send(self, frame):
        self.sent.append(copy.deepcopy(frame))
        return True

    async def test_hub_status_roster_and_name_reach_mounted_feed_without_a_read(self):
        await self.host.join('socket', self.send)
        await self.host.runner.run.idle()
        initial = self.sent[0]
        self.assertTrue(initial['net']['hubs'][0]['hidden'])
        count = len(self.calls)
        net.notify_runtime = lambda _slug: self.host.transition(())
        net._rosters['https://hub.invalid'] = [dict(slug='own-public',online=True),
                                              dict(slug='peer',online=True)]
        net._record_hub_name('https://hub.invalid', 'Found hub', {}, {})
        net._set_status('hub-org', net.LOCAL_HUB_ID, True)
        live = self.sent[-1]
        self.assertFalse(live['full'])
        self.assertGreaterEqual(live['seq'], live['net']['seq'])
        self.assertEqual([r['slug'] for r in live['net']['hubs'][0]['roster']], ['peer'])
        self.assertFalse(live['net']['hubs'][0]['hidden'])
        # A roster refresh at the SAME connected/error status must publish.
        net._rosters['https://hub.invalid'][1]['online'] = False
        net._set_status('hub-org', net.LOCAL_HUB_ID, True)
        latest = self.sent[-1]
        self.assertGreater(latest['seq'], live['seq'])
        self.assertFalse(latest['net']['hubs'][0]['roster'][0]['online'])
        self.assertEqual(len(self.calls), count)
        self.assertEqual(self.host.input_cursor.rev, 3)
        expected = net.status_block({**self.doc, 'net_spool':{net.LOCAL_HUB_ID:[{}]}})
        packet = dict(cursor=self.cursor.wire(), initial=initial, live=latest,
            body=net.status_block({**self.doc, 'net_spool':{net.LOCAL_HUB_ID:[{}]}}, include_runtime=False),
            expected=expected)
        with tempfile.TemporaryDirectory(prefix='record-net-') as folder:
            path = Path(folder)/'wire.json'
            path.write_text(json.dumps(packet), encoding='utf-8')
            env = {**os.environ, 'ORGTREE_RECORD_NET_FIXTURE':str(path)}
            result = subprocess.run(['node','tests/run.mjs','recordnet'],
                cwd=Path(__file__).resolve().parents[1]/'apps/desktop/renderer',
                env=env, capture_output=True, text=True, encoding='utf-8', timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            self.assertRegex(result.stdout, r'(?m)^.* pass 4\b')
            self.assertRegex(result.stdout, r'(?m)^.* skipped 0\b')

    async def test_delayed_copy_samples_live_memory_and_cannot_adopt_old_config(self):
        await self.host.http()
        old = H.RuntimeInputs(self.cursor, {}, {}, {}, copy.deepcopy(self.doc))
        self.cursor = Q.Cursor('hub-test', 'original', 4)
        self.doc['net_hubs'][0]['address'] = 'https://new.invalid'
        await self.host.http()
        self.assertEqual(self.host._adopt(old), {})
        self.pause = True
        task = asyncio.create_task(self.host.http())
        self.assertTrue(await asyncio.to_thread(self.started.wait, 3))
        net._set_status('hub-org', net.LOCAL_HUB_ID, True)
        self.host.transition(())
        self.release.set()
        result = await task
        hub = result['runtime']['net']['hubs'][0]
        self.assertEqual(hub['address'], 'https://new.invalid')
        self.assertTrue(hub['connected'])
        self.cursor = Q.Cursor('hub-test', 'replaced', 0)
        self.doc['net_hubs'] = []
        result = await self.host.http()
        self.assertEqual(result['runtime']['incarnation'], 'replaced')
        self.assertEqual(result['runtime']['net']['hubs'], [])

    async def test_probe_roster_runtime_signal_and_legacy_transition_policy(self):
        from types import SimpleNamespace
        events, legacy = [], []
        net.notify_runtime = events.append
        net.notify_changed = legacy.append
        with patch.object(net,'now', side_effect=['a','b']):
            net._set_status('hub-org','h',True)
            net._set_status('hub-org','h',True)
        self.assertEqual(events,['hub-org','hub-org'])
        self.assertEqual(legacy,['hub-org'])
        net._rosters['https://hub.invalid'] = []
        response = SimpleNamespace(status_code=200,json=lambda:{'roster':[{'slug':'new'}]})
        with patch.object(net,'_client') as client:
            client.return_value.__enter__.return_value.get.return_value = response
            self.assertTrue(net.probe_peer('new'))
        self.assertIsNone(events[-1])
        calls = []
        with patch.object(api, '_LOOP', SimpleNamespace(call_soon_threadsafe=lambda *a:calls.append(a))):
            api.hub_runtime_changed('hub-org')
        self.assertEqual(calls, [(record_api.hub_transition, 'hub-org')])
        with patch.dict(record_api.hosts, {'hub-org':self.host}, clear=True):
            record_api.hub_transition(None)
        self.assertFalse(self.calls)  # runtime signal never checks out an org


if __name__ == '__main__':
    unittest.main()
