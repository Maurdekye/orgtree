"""Forecast workers must never stall or overwrite the ordered live overlay."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
from contextlib import ExitStack
from datetime import datetime, timezone
import threading
import time
import unittest
from unittest.mock import patch

from orgtree import api, ledger
from orgtree.orgdb import record_host as H, record_reads as Q, record_runtime as R
from test_orgdb_supervisor_overlay import body, context, state


class Forecast(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.live = state()
        self.live['busy'] = False
        self.stack.enter_context(patch.object(api.supervisor, 'state', side_effect=lambda *_: self.live))
        self.stack.enter_context(patch.object(api.supervisor, '_auto_cheap_cfg', return_value=None))
        self.stack.enter_context(patch.object(api.warmpool, 'process_control_status', return_value={}))
        self.stack.enter_context(patch.object(ledger.Org, '_boot_at', return_value=''))
        self.errors, self.sent = [], []
        self.host = H.OrgHost('overlay-test', self.errors.append)
        self.ctx = context()
        self.cursor = Q.Cursor('uuid', 'inc', 1)
        self.host._adopt(self.inputs({'version': 0}))
        self.host.sends['probe'] = lambda frame: self.sent.append(copy.deepcopy(frame)) or True
        self.release = threading.Event()

    def inputs(self, value, **kwargs):
        return H.RuntimeInputs(self.cursor, {'1': body()}, {'1': self.ctx}, {},
                               forecasts={'1': value}, **kwargs)

    async def asyncTearDown(self):
        self.release.set()
        await self.host.close()
        self.stack.close()
        self.assertEqual(self.errors, [])

    async def drain(self):
        if self.host._forecast_task is not None:
            await asyncio.wait_for(asyncio.shield(self.host._forecast_task), 5)

    async def test_two_second_forecast_keeps_transition_and_heartbeat_responsive(self):
        threads, beats = [], []
        def slow(*_):
            threads.append(threading.get_ident())
            time.sleep(2)
            return {'version': 1}
        async def heartbeat():
            for _ in range(20):
                beats.append(time.perf_counter())
                await asyncio.sleep(.02)
        with patch.object(api.supervisor, 'cache_forecast_public', side_effect=slow):
            pulse = asyncio.create_task(heartbeat())
            self.live['busy'] = True
            before = time.perf_counter()
            self.host.transition(('agent',))
            self.assertLess(time.perf_counter() - before, .05)
            first = self.sent[-1]['seq']
            await pulse
            self.assertEqual(len(beats), 20)
            self.assertLess(max(b-a for a,b in zip(beats, beats[1:])), .2)
            await self.drain()
        self.assertEqual(len(threads), 1)
        self.assertNotEqual(threads[0], threading.get_ident())
        self.assertGreater(self.sent[-1]['seq'], first)
        self.assertEqual(self.sent[-1]['agents']['1']['cache_forecast'], {'version': 1})

    async def test_stream_frames_and_hub_notifications_do_not_recompute(self):
        with patch.object(api.supervisor, 'cache_forecast_public', return_value={'version': 1}) as compute:
            for _ in range(100):
                self.host.transition()
                self.host.transition(('agent',))
            await asyncio.sleep(.02)
            self.assertEqual(compute.call_count, 0)
            for busy in (True, False):
                self.live['busy'] = busy
                self.host.transition(('agent',))
                await self.drain()
            self.assertEqual(compute.call_count, 2)

    async def test_marks_coalesce_and_old_generation_does_not_publish(self):
        started = threading.Event()
        calls = []
        def compute(*_):
            calls.append(len(calls)+1)
            if len(calls) == 1:
                started.set()
                self.release.wait(3)
            return {'version': len(calls)}
        with patch.object(api.supervisor, 'cache_forecast_public', side_effect=compute):
            self.host._mark_forecasts(('1',))
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            for _ in range(100):
                self.host._mark_forecasts(('1',))
            self.release.set()
            await self.drain()
        self.assertEqual(calls, [1, 2])
        versions = [f['agents']['1']['cache_forecast']['version'] for f in self.sent if '1' in f['agents']]
        self.assertEqual(versions, [2])

    async def test_delayed_results_drop_after_readoption_removal_and_identity_replacement(self):
        for action in ('adopt', 'remove', 'replace'):
            with self.subTest(action=action):
                self.host._adopt(self.inputs({'version': 0}))
                started = threading.Event()
                self.release.clear()
                def compute(*_):
                    started.set()
                    self.release.wait(3)
                    return {'version': 'stale'}
                with patch.object(api.supervisor, 'cache_forecast_public', side_effect=compute):
                    self.host._mark_forecasts(('1',))
                    self.assertTrue(await asyncio.to_thread(started.wait, 2))
                    if action == 'replace':
                        self.cursor = Q.Cursor('uuid', 'replacement', 1)
                    if action == 'remove':
                        self.host._adopt(H.RuntimeInputs(self.cursor, {}, {}, {}, forecasts={}))
                    else:
                        self.host._adopt(self.inputs({'version': 'fresh'}))
                    self.sent.clear()
                    self.release.set()
                    await self.drain()
                self.assertFalse(any(v.get('cache_forecast') == {'version': 'stale'}
                                     for f in self.sent for v in f['agents'].values()))

    async def test_http_worker_supplies_complete_forecast_without_mutating_context(self):
        before = copy.deepcopy(self.ctx.d)
        def worker(*_):
            self.assertNotEqual(threading.get_ident(), threading.main_thread().ident)
            values = R.forecasts({'1': body()}, {'1': self.ctx})
            return {'type': 'record_snapshot'}, self.inputs(values['1'])
        self.host.worker, self.host._default_worker = worker, False
        with patch.object(api.supervisor, 'cache_forecast_public', return_value={'version': 'http'}):
            result = await self.host.http()
        self.assertEqual(result['runtime']['agents']['1']['cache_forecast'], {'version': 'http'})
        self.assertEqual(self.ctx.d, before)

    async def test_newer_generation_forecast_survives_delayed_snapshot(self):
        overlay = self.host.overlay
        captured = dict(overlay._fgen)
        with patch.object(api.supervisor, 'cache_forecast_public', return_value={'version': 'new'}):
            self.host._mark_forecasts(('1',))
            await self.drain()
            self.host._adopt(self.inputs({'version': 'old'}, forecast_generations=captured,
                                        forecast_overlay=overlay))
            self.assertEqual(overlay._values['1']['cache_forecast'], {'version': 'new'})
            await self.drain()

    async def test_real_forecast_projection_is_read_only_and_archived_is_skipped(self):
        self.ctx.node('agent')['cache_continuity'] = {'public': {
            'state': 'compatible_observed', 'expires_at': '2020-01-01T00:00:00Z'}}
        before = copy.deepcopy(self.ctx.d)
        values = await asyncio.to_thread(R.forecasts, {'1': body()}, {'1': self.ctx})
        self.assertEqual(values['1']['state'], 'expired_known_entry')
        self.assertEqual(self.ctx.d, before)
        with patch.object(api.supervisor, 'cache_forecast_public', side_effect=AssertionError('archived compute')):
            values = await asyncio.to_thread(R.forecasts, {'1': {**body(), 'state': 'archived'}}, {'1': self.ctx})
            self.assertIsNone(values['1'])
            periodic = self.host._forecast_periodic
            self.host._adopt(H.RuntimeInputs(self.cursor,
                {'1': {**body(), 'state': 'archived'}}, {'1': self.ctx}, {}, forecasts=values))
            self.assertTrue(periodic.cancelled())
            self.assertIsNone(self.host._forecast_periodic)
            self.host._adopt(self.inputs({'version': 'live-again'}))
            self.assertIsNotNone(self.host._forecast_periodic)

    async def test_expiry_and_file_timer_refresh_without_other_events(self):
        expiry = datetime.fromtimestamp(time.time()+.05, timezone.utc).isoformat()
        self.host._adopt(self.inputs({'state': 'compatible_observed', 'expires_at': expiry}))
        with patch.object(api.supervisor, 'cache_forecast_public', return_value={'state': 'expired_known_entry'}) as compute:
            await asyncio.sleep(.1)
            await self.drain()
            self.assertEqual(self.host.overlay._values['1']['cache_forecast']['state'], 'expired_known_entry')
            self.host._forecast_periodic.cancel()
            self.host._forecast_files_changed()
            await self.drain()
            self.assertEqual(compute.call_count, 2)

    async def test_close_drops_worker_result_and_cancels_timers(self):
        started = threading.Event()
        def compute(*_):
            started.set()
            self.release.wait(3)
            return {'version': 'late'}
        with patch.object(api.supervisor, 'cache_forecast_public', side_effect=compute):
            self.host._mark_forecasts(('1',))
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            await asyncio.wait_for(self.host.close(), .2)
            self.release.set()
            await asyncio.sleep(.05)
        self.assertEqual(self.sent, [])
        self.assertIsNone(self.host._forecast_periodic)


if __name__ == '__main__':
    unittest.main()
