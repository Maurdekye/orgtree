"""Clock host deadlines, notifications in flight, retry and owned shutdown."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from orgtree import record_api as A
from orgtree.orgdb import record_clock_host as H, record_clock as C
from orgtree.orgdb import record_retention as R, registry


def answer(*,deadline=None,active=('org',),failed=(),errors=()):
    return H.Sweep(frozenset(active),{'org':deadline},frozenset(failed),tuple(errors))


class Timer(unittest.IsolatedAsyncioTestCase):
    async def test_earliest_deadline_runs_without_a_socket_or_later_write(self):
        loop,thread = asyncio.get_running_loop(),threading.get_ident()
        reached,calls,errors = asyncio.Event(),[],[]
        def worker(slugs):
            self.assertNotEqual(thread,threading.get_ident())
            calls.append(slugs)
            if len(calls)==1:
                return answer(deadline=datetime.now(timezone.utc)+timedelta(seconds=.03))
            loop.call_soon_threadsafe(reached.set)
            return answer()
        timer = H.Timer(errors.append,worker=worker,discovery=3600)
        timer.start()
        task = timer.task
        timer.start()
        self.assertIs(timer.task,task)
        try:
            await asyncio.wait_for(reached.wait(),2)
        finally:
            await timer.close()
        self.assertEqual(calls,[None,('org',)])
        self.assertEqual(errors,[])
        timer.start()
        self.assertIs(timer.task,task)

    async def test_source_notification_during_worker_is_not_lost(self):
        loop = asyncio.get_running_loop()
        started,reached,release = asyncio.Event(),asyncio.Event(),threading.Event()
        calls = []
        def worker(slugs):
            calls.append(slugs)
            if len(calls)==1:
                loop.call_soon_threadsafe(started.set)
                if not release.wait(3):
                    raise TimeoutError('fixture did not release worker')
            else:
                loop.call_soon_threadsafe(reached.set)
            return answer()
        timer = H.Timer(lambda exc:self.fail(str(exc)),worker=worker,discovery=3600)
        timer.start()
        try:
            await asyncio.wait_for(started.wait(),2)
            timer.changed('org')
            release.set()
            await asyncio.wait_for(reached.wait(),2)
        finally:
            release.set()
            await timer.close()
        self.assertEqual(calls,[None,('org',)])

    async def test_source_write_wakes_idle_timer_and_rearms_earlier_deadline(self):
        loop = asyncio.get_running_loop()
        started,rearmed,reached = asyncio.Event(),asyncio.Event(),asyncio.Event()
        calls = []
        def worker(slugs):
            calls.append(slugs)
            if len(calls)==1:
                loop.call_soon_threadsafe(started.set)
                return answer(deadline=datetime.now(timezone.utc)+timedelta(days=1))
            if len(calls)==2:
                loop.call_soon_threadsafe(rearmed.set)
                return answer(deadline=datetime.now(timezone.utc)+timedelta(seconds=.03))
            loop.call_soon_threadsafe(reached.set)
            return answer()
        timer = H.Timer(lambda exc:self.fail(str(exc)),worker=worker,discovery=3600)
        timer.start()
        try:
            await asyncio.wait_for(started.wait(),2)
            timer.changed('org')
            await asyncio.wait_for(rearmed.wait(),2)
            await asyncio.wait_for(reached.wait(),2)
        finally:
            await timer.close()
        self.assertEqual(calls,[None,('org',),('org',)])

    async def test_registry_and_org_failures_retry_and_removed_org_does_not_spin(self):
        loop,thread = asyncio.get_running_loop(),threading.get_ident()
        reached,calls,errors = asyncio.Event(),[],[]
        global_fault,org_fault = RuntimeError('registry unavailable'),RuntimeError('org unavailable')
        def worker(slugs):
            calls.append(slugs)
            if len(calls)==1:
                raise global_fault
            if len(calls)==2:
                return answer(failed=('org',),errors=(org_fault,))
            loop.call_soon_threadsafe(reached.set)
            return H.Sweep(frozenset(),{},frozenset(),())
        def report(exc):
            self.assertEqual(thread,threading.get_ident())
            errors.append(exc)
        timer = H.Timer(report,worker=worker,discovery=3600,retry=.01)
        timer.start()
        try:
            await asyncio.wait_for(reached.wait(),2)
            await asyncio.sleep(.03)
        finally:
            await timer.close()
        self.assertEqual(calls,[None,None,('org',)])
        self.assertEqual(errors,[global_fault,org_fault])
        self.assertEqual(timer.deadlines,{})

    async def test_periodic_discovery_and_shutdown_await_started_transaction(self):
        loop = asyncio.get_running_loop()
        started,release = asyncio.Event(),threading.Event()
        calls,finished = [],[]
        def worker(slugs):
            calls.append(slugs)
            if len(calls)==2:
                loop.call_soon_threadsafe(started.set)
                if not release.wait(3):
                    raise TimeoutError('fixture did not release worker')
                finished.append(1)
            return answer()
        timer = H.Timer(lambda exc:self.fail(str(exc)),worker=worker,discovery=.01)
        timer.start()
        closing = None
        try:
            await asyncio.wait_for(started.wait(),2)
            closing = asyncio.create_task(timer.close())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            timer.changed('org')
            self.assertEqual(timer.dirty,set())
        finally:
            release.set()
            await asyncio.wait_for(closing if closing is not None else timer.close(),2)
        self.assertEqual(calls,[None,None])
        self.assertEqual(finished,[1])

    async def test_backwards_wall_clock_does_not_strand_registry_discovery(self):
        loop = asyncio.get_running_loop()
        wall = [datetime.now(timezone.utc).timestamp()]
        reached,calls = asyncio.Event(),[]
        def worker(slugs):
            calls.append(slugs)
            if len(calls)==1:
                wall[0] -= 86400
            else:
                loop.call_soon_threadsafe(reached.set)
            return answer(deadline=datetime.now(timezone.utc)+timedelta(days=1))
        timer = H.Timer(lambda exc:self.fail(str(exc)),worker=worker,discovery=.02,now=lambda:wall[0])
        timer.start()
        try:
            await asyncio.wait_for(reached.wait(),2)
        finally:
            await timer.close()
        self.assertEqual(calls,[None,None])

    async def test_api_capability_gate_revision_observer_and_shutdown(self):
        with patch.object(A,'clock',None),patch.object(A,'retention',None),patch.object(A,'hosts',{}), \
                patch.object(H,'Timer') as clock,patch.object(R,'Timer') as retention, \
                patch.object(A.revision_subscribers,'observed') as subscribers:
            for enabled,ready in ((False,False),(False,True),(True,False)):
                with patch.object(A.orgdb,'enabled',return_value=enabled),patch.object(A,'READY',ready):
                    A.start_timers()
            clock.assert_not_called()
            with patch.object(A.orgdb,'enabled',return_value=True),patch.object(A,'READY',True):
                A.start_timers()
                A.start_timers()
            clock.assert_called_once()
            clock.return_value.start.assert_called_once()
            # Identity/gap events also rearm even if no tree host is mounted.
            A.observed('org',0,True)
            clock.return_value.changed.assert_called_once_with('org')
            subscribers.assert_called_once_with('org',0,True)
            clock.return_value.close = AsyncMock()
            retention.return_value.close = AsyncMock()
            await A.close()
            clock.return_value.close.assert_awaited_once()
            self.assertIsNone(A.clock)


class Worker(unittest.TestCase):
    def test_active_socketless_orgs_migration_gate_and_failure_isolation(self):
        calls,published = [],[]
        deadline = datetime.now(timezone.utc)
        @contextmanager
        def connection(slug):
            calls.append(slug)
            if slug=='bad':
                raise registry.OrgUnavailable('unavailable')
            raw = Mock(slug=slug)
            raw.execute.return_value.fetchone.return_value = (None if slug=='old' else 'record_time_state',)
            yield raw
        def publish(raw):
            published.append(raw.slug)
            return C.Published(deadline,deadline,frozenset())
        with patch.object(registry,'active_slugs',return_value=['old','bad','org']), \
                patch.object(registry,'connection',side_effect=connection),patch.object(C,'publish',side_effect=publish):
            result = H.sweep()
            self.assertEqual(result.active,frozenset(('old','bad','org')))
            self.assertEqual(result.deadlines,{'old':None,'org':deadline})
            self.assertEqual(result.failed,frozenset(('bad',)))
            self.assertEqual(len(result.errors),1)
            self.assertEqual(published,['org'])
            calls.clear()
            H.sweep(('removed','org'))
            self.assertEqual(calls,['org'])


if __name__ == '__main__':
    unittest.main()
