"""Host prune timer lifecycle; no import-time database work or abandoned worker."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import threading
import unittest
from unittest.mock import Mock, patch
from contextlib import contextmanager

from orgtree import record_api as A
from orgtree.orgdb import record_retention as R, registry
from orgtree.orgdb import record_clock_host as C


class Timer(unittest.IsolatedAsyncioTestCase):
    async def test_periodic_sweeps_without_socket_or_revision_and_idempotent_start(self):
        loop = asyncio.get_running_loop()
        twice = asyncio.Event()
        calls, errors = [], []
        def worker():
            self.assertNotEqual(threading.get_ident(),loop_thread)
            calls.append(1)
            if len(calls) == 2:
                loop.call_soon_threadsafe(twice.set)
            return []
        loop_thread = threading.get_ident()
        timer = R.Timer(errors.append,worker=worker,interval=.01)
        timer.start()
        task = timer.task
        timer.start()
        self.assertIs(timer.task,task)
        try:
            await asyncio.wait_for(twice.wait(),2)
        finally:
            await timer.close()
        self.assertGreaterEqual(len(calls),2)
        self.assertEqual(errors,[])
        self.assertTrue(task.done())
        timer.start()
        self.assertIs(timer.task,task)

    async def test_shutdown_awaits_started_worker_and_prevents_later_sweep(self):
        loop = asyncio.get_running_loop()
        started, release = asyncio.Event(), threading.Event()
        finished, calls = [], []
        def worker():
            calls.append(1)
            loop.call_soon_threadsafe(started.set)
            if not release.wait(3):
                raise TimeoutError('fixture did not release worker')
            finished.append(1)
            return []
        timer = R.Timer(lambda exc:self.fail(str(exc)),worker=worker,interval=.01)
        timer.start()
        closing = None
        try:
            await asyncio.wait_for(started.wait(),2)
            closing = asyncio.create_task(timer.close())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            self.assertEqual(finished,[])
        finally:
            release.set()
            await asyncio.wait_for(closing if closing is not None else timer.close(),2)
        self.assertEqual((calls,finished),([1],[1]))

    async def test_failure_reports_on_loop_and_retries_without_another_write(self):
        calls, errors = [], []
        loop = asyncio.get_running_loop()
        resumed = asyncio.Event()
        thread = threading.get_ident()
        fault = RuntimeError('unavailable registry')
        def worker():
            calls.append(1)
            if len(calls) == 1:
                raise fault
            loop.call_soon_threadsafe(resumed.set)
            return []
        def report(exc):
            self.assertEqual(threading.get_ident(),thread)
            errors.append(exc)
        timer = R.Timer(report,worker=worker,interval=3600,retry=.01)
        timer.start()
        try:
            await asyncio.wait_for(resumed.wait(),2)
        finally:
            await timer.close()
        self.assertEqual(errors,[fault])
        self.assertEqual(len(calls),2)

    async def test_capability_gate_and_api_shutdown_own_exactly_one_timer(self):
        with patch.object(A,'retention',None),patch.object(A,'clock',None),patch.object(A,'hosts',{}), \
                patch.object(C,'Timer') as clock_constructor,patch.object(R,'Timer') as constructor:
            for enabled,ready in ((False,False),(False,True),(True,False)):
                with patch.object(A.orgdb,'enabled',return_value=enabled),patch.object(A,'READY',ready):
                    A.start_timers()
            constructor.assert_not_called()
            with patch.object(A.orgdb,'enabled',return_value=True),patch.object(A,'READY',True):
                A.start_timers()
                A.start_timers()
            self.assertEqual(constructor.call_count,1)
            constructor.return_value.start.assert_called_once()
            from unittest.mock import AsyncMock
            constructor.return_value.close = AsyncMock()
            clock_constructor.return_value.close = AsyncMock()
            await A.close()
            constructor.return_value.close.assert_awaited_once()
            self.assertIsNone(A.retention)


class Sweep(unittest.TestCase):
    def test_active_orgs_migration_gate_and_one_failure_does_not_strand_next_org(self):
        connections, pruned = [], []
        @contextmanager
        def connection(slug):
            connections.append(slug)
            if slug == 'unavailable':
                raise registry.OrgUnavailable('unavailable org')
            raw = Mock()
            raw.execute.return_value.fetchone.return_value = (None if slug == 'old' else 'orgtree.revisions',)
            raw.slug = slug
            yield raw
        with patch.object(registry,'active_slugs',return_value=['old','unavailable','new']), \
                patch.object(registry,'connection',side_effect=connection), \
                patch.object(R,'prune',side_effect=lambda raw:pruned.append(raw.slug)):
            errors = R.sweep()
        self.assertEqual(connections,['old','unavailable','new'])
        self.assertEqual(pruned,['new'])
        self.assertEqual(len(errors),1)
        self.assertIsInstance(errors[0],registry.OrgUnavailable)


if __name__ == '__main__':
    unittest.main()
