"""Request-only timing controls; no database and no live data."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import concurrent.futures
from contextlib import contextmanager
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orgtree import profiling, record_api
from orgtree.orgdb import record_host as H, record_reads as Q, record_pass as P
import test_orgdb_record_host as fixture


class RequestTiming(unittest.IsolatedAsyncioTestCase):
    async def test_host_wait_executor_wait_and_worker_are_separate(self):
        case = fixture.Host()
        await case.asyncSetUp()
        profile = {}
        token = profiling.bind(profile)
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        asyncio.get_running_loop().set_default_executor(pool)
        entered, release = threading.Event(), threading.Event()
        def occupying():
            entered.set()
            release.wait(2)
        occupied = pool.submit(occupying)
        self.assertTrue(entered.wait(1))
        try:
            await case.host._read_lock.acquire()
            pending = asyncio.create_task(case.host.http())
            await asyncio.sleep(.025)
            case.host._read_lock.release()
            await asyncio.sleep(.040)
            release.set()
            result = await asyncio.wait_for(pending, 2)
            self.assertEqual(result['type'], 'record_snapshot')
            self.assertGreaterEqual(profile['record_host_wait_ms'], 15)
            self.assertGreaterEqual(profile['record_executor_wait_ms'], 25)
            self.assertIn('record_worker_ms', profile)
            self.assertIn('record_worker_cpu_ms', profile)
            self.assertIn('record_publish_ms', profile)
            self.assertNotIn('record_host_wait_cpu_ms', profile)
            self.assertNotIn('record_executor_wait_cpu_ms', profile)
        finally:
            release.set()
            occupied.result(2)
            profiling.unbind(token)
            await case.asyncTearDown()

    async def test_http_capability_and_serialization_keep_response_identical(self):
        frame = {'type': 'record_snapshot', 'records': ['\ud800', 'é']}
        class Host:
            async def http(self, **kwargs):
                return frame
        profile = {}
        token = profiling.bind(profile)
        try:
            with patch.object(record_api, 'capable', return_value=True), patch.object(record_api, 'host', return_value=Host()):
                response = await record_api._read('private-name')
            self.assertEqual(response.body, b'{"type":"record_snapshot","records":["\\ud800","\\u00e9"]}')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            for field in ('record_executor_wait_ms','record_capability_ms','record_serialize_ms'):
                self.assertIn(field, profile)
            self.assertFalse(any('private-name' in k for k in profile))
        finally:
            profiling.unbind(token)


class WorkerTiming(unittest.TestCase):
    def test_gate_times_only_entry_and_preserves_exception_cleanup(self):
        profile, exits = {}, []
        @contextmanager
        def gate():
            time.sleep(.02)
            try:
                yield 42
            finally:
                exits.append(True)
        token = profiling.bind(profile)
        try:
            with self.assertRaisesRegex(ValueError, 'body'):
                with profiling.record_gate(gate()) as value:
                    self.assertEqual(value, 42)
                    measured = profile['record_gate_wait_ms']
                    time.sleep(.04)
                    raise ValueError('body')
            self.assertEqual(profile['record_gate_wait_ms'], measured)
            self.assertGreaterEqual(measured, 15)
            self.assertEqual(exits, [True])
        finally:
            profiling.unbind(token)

    def test_default_worker_records_context_assembly_and_forecast(self):
        state = SimpleNamespace(stamp={'org_uuid':'u','incarnation':'i','org_revision':1})
        registry = SimpleNamespace(entities={'agent':SimpleNamespace(bodies=P.tree.bodies)}, scopes={}, windows={})
        registry.select = lambda *_: {'agent':frozenset({'1'})}
        registry.bodies = lambda state, entity, ids: {k:({'id':'agent'} if entity=='agent' else {'models':{}}) for k in ids}
        @contextmanager
        def snapshot(*args):
            yield state
        profile = {}
        token = profiling.bind(profile)
        host = H.OrgHost('private',lambda exc:None,registry=registry)
        try:
            with patch.object(Q, 'snapshot', snapshot), patch.object(Q, 'baseline',return_value={'type':'record_snapshot'}), patch.object(P.tree,'prepare_context'), patch.object(H.tree,'runtime_contexts',return_value={}), patch.object(H.tree,'runtime_net_inputs',return_value={}), patch.object(H.mail_runtime,'inputs',return_value={}), patch.object(H,'forecasts',return_value={'1':{'state':'unknown'}}):
                frame, inputs = host._worker('baseline',None,None,(H.Selection(),))
            self.assertEqual(inputs.forecasts['1']['state'],'unknown')
            self.assertEqual(frame['type'],'record_snapshot')
            for field in ('record_context_ms','record_assembly_ms','record_forecast_ms'):
                self.assertIn(field, profile)
            self.assertGreaterEqual(profile['record_assembly_ms'], profile['record_context_ms'])
        finally:
            profiling.unbind(token)

    def test_slow_sink_threshold_privacy_and_no_nested_double_count(self):
        from orgtree import api, slowtrace
        outer = dict(record_host_wait_ms=10.,record_executor_wait_ms=20.,record_worker_ms=600.,record_capability_ms=30.,record_publish_ms=5.,record_serialize_ms=2.)
        nested = dict(record_assembly_ms=550.,record_context_ms=200.,record_gate_wait_ms=100.,record_forecast_ms=50.,record_worker_cpu_ms=70.)
        scope={'route':SimpleNamespace(path='/api/orgs/{slug}/changes'),'method':'GET','type':'http'}
        with patch.object(api,'_PROFILE_TIMING',False), patch.object(slowtrace,'THRESHOLD_MS',500), patch.object(slowtrace,'emit') as emit, patch('builtins.print'):
            api._access_emit(scope,200,499.,499.,42,1,profile=outer)
            emit.assert_not_called()
            api._access_emit(scope,200,700.,701.,42,1,profile={**outer,**nested,'secret':123,'record_serialize_cpu_ms':float('nan')})
            row=emit.call_args.args[0]
        self.assertEqual(row['unattributed_ms'],33.)
        for key,value in {**outer,**nested}.items():self.assertEqual(row[key],value)
        self.assertNotIn('secret',row)
        self.assertNotIn('record_serialize_cpu_ms',row)


if __name__ == '__main__':
    unittest.main()
