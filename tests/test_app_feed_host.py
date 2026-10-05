"""App snapshots and active spans: deterministic controls with real async barriers."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import json
import unittest

from orgtree.orgdb.app_host import AppHost, AppReplaced
from orgtree.orgdb.record_runtime import HostClock


def record(state='active', uuid='org'):
    return dict(entity='registry_org', id='1', body=dict(org_id=1, slug='one', org_uuid=uuid,
        state=state, unavailable_step=None, state_reason=None, attempts=0, report_path=None))


class Host(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cursor = dict(app_uuid='app', incarnation='app-inc', rev=10)
        self.records = [record()]
        self.source = dict(org_uuid='org', incarnation='z', rev=99,
                           body=dict(name='one'), notices=[dict(id='notice')])
        self.errors, self.reads = [], []
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.pause = False
        self.concurrent = self.peak = 0
        self.now, self.sleeps = 0, []
        self.host = AppHost(self.registry, self.org, self.errors.append, clock=HostClock(),
                            interval=1, monotonic=lambda: self.now, sleep=self.sleep)
        self.host.refresh.wake()
        await self.host.idle()
        self.queue = await self.host.connect()
        self.initial = json.loads(await self.queue.take())

    async def asyncTearDown(self):
        self.release.set()
        await self.host.close()

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    async def registry(self):
        return copy.deepcopy((self.cursor, self.records))

    async def org(self, row):
        self.concurrent += 1
        self.peak = max(self.peak, self.concurrent)
        result = copy.deepcopy(self.source)
        self.reads.append((row, result))
        try:
            if self.pause:
                self.pause = False
                self.started.set()
                await self.release.wait()
            return result
        finally:
            self.concurrent -= 1

    async def refresh(self, records):
        self.records = records
        self.cursor['rev'] += 1
        self.host.refresh.wake()
        await self.host.refresh.idle()

    async def frames(self):
        result = []
        while self.queue.frames:
            result.append(json.loads(await self.queue.take()))
        return result

    async def test_registry_equal_body_new_revision_is_still_a_complete_frame(self):
        await self.refresh([record()])
        await self.refresh([record()])
        frames = await self.frames()
        self.assertEqual([f['cursor']['rev'] for f in frames], [11, 12])
        self.assertEqual(frames[0]['records'], frames[1]['records'])
        self.assertEqual(len(self.reads), 1)

    async def test_coalesced_create_delete_finishes_at_complete_baseline(self):
        self.cursor['rev'] = 12
        self.records = []
        for _ in range(4):
            self.host.refresh.wake()
        await self.host.idle()
        frames = await self.frames()
        self.assertEqual([f['type'] for f in frames], ['org_summary', 'org_notices', 'registry_snapshot'])
        self.assertIsNone(frames[0]['body'])
        self.assertIsNone(frames[1]['notices'])
        self.assertEqual(frames[-1]['records'], [])
        self.assertEqual((await self.host.full())['summaries'], {})

    async def test_late_old_span_read_is_discarded_and_new_read_never_overlaps(self):
        self.pause = True
        self.source['body'] = dict(name='stale')
        self.host.observed('one', 100, False)
        await self.started.wait()
        await self.refresh([record('unavailable')])
        self.source.update(incarnation='a', rev=1, body=dict(name='replacement'), notices=[])
        await self.refresh([record()])
        # A new span must wait for the old span's single runner.
        self.assertEqual(self.concurrent, 1)
        self.release.set()
        await self.host.idle()
        frames = await self.frames()
        self.assertEqual([f['body'] for f in frames if f['type'] == 'org_summary'],
                         [None, dict(name='replacement')])
        self.assertEqual(self.peak, 1)
        self.assertEqual(frames[-2]['incarnation'], 'a')
        self.assertEqual(frames[-2]['rev'], 1)
        self.assertGreaterEqual(sum(self.sleeps), 2)

    async def test_replacement_identity_compared_before_revision_in_both_uuid_orders(self):
        for incarnation in ('a', 'zz'):
            self.source.update(incarnation=incarnation, rev=1)
            self.host.observed('one', 1, True)
            await self.host.idle()
            frames = await self.frames()
            self.assertEqual([f['type'] for f in frames], ['org_summary', 'org_notices'])
            self.assertEqual(frames[0]['incarnation'], incarnation)
            self.assertEqual(frames[0]['body'], self.initial['summaries']['1']['body'])

    async def test_rev_only_does_not_send_but_wake_during_read_repeats(self):
        self.pause = True
        self.source['rev'] += 1
        self.host.observed('one', 100)
        await self.started.wait()
        self.source.update(rev=101, body=dict(name='new name'))
        self.host.observed('one', 101)
        self.release.set()
        await self.host.idle()
        frames = await self.frames()
        self.assertEqual(len(self.reads), 3)
        self.assertEqual([f['type'] for f in frames], ['org_summary'])
        self.assertEqual(frames[0]['body']['name'], 'new name')
        self.assertEqual(self.peak, 1)

    async def test_copy_owns_nested_values_and_seq_follows_every_stored_entry(self):
        self.host.runtime(values=dict(accounts=[dict(id='account')]), orgs={'1': {'working': 2}})
        first = await self.host.full()
        self.host.runtime(values=dict(accounts=[dict(id='new')]), orgs={'1': {'working': 0}})
        second = await self.host.full()
        self.assertEqual(first['runtime']['values']['accounts']['value'], [dict(id='account')])
        self.assertGreater(second['seq'], first['seq'])
        self.assertGreater(second['seq'], second['runtime']['values']['accounts']['seq'])
        self.assertGreater(second['seq'], second['summaries']['1']['seq'])
        self.assertEqual(second['epoch'], second['notices']['1']['epoch'])

    async def test_every_connect_contains_all_four_sources(self):
        self.host.runtime(values=dict(login={'ok': True}), orgs={'1': {'working': 2}})
        reconnect = await self.host.connect()
        frame = json.loads(await reconnect.take())
        self.assertEqual(frame['type'], 'app_snapshot')
        self.assertEqual(frame['registry']['records'], self.records)
        self.assertEqual(frame['summaries']['1']['body'], self.source['body'])
        self.assertEqual(frame['notices']['1']['notices'], self.source['notices'])
        self.assertEqual(frame['runtime']['values']['login']['value'], {'ok': True})
        self.assertEqual(frame['runtime']['orgs']['1']['working'], 2)

    async def test_app_identity_change_closes_clients_and_refuses_same_epoch_copy(self):
        self.cursor.update(incarnation='restored', rev=0)
        self.host.refresh.wake()
        await self.host.refresh.idle()
        self.assertTrue(self.queue.closed)
        self.assertIsInstance(self.errors[0], AppReplaced)
        with self.assertRaises(AppReplaced):
            await self.host.full()

    async def test_overflow_closes_without_org_reset(self):
        tiny = await self.host.connect(max_bytes=64)
        self.assertTrue(tiny.closed)
        self.assertIsNone(await tiny.take())
        self.assertNotIn(tiny, self.host.clients)

    async def test_failed_last_org_read_retries_without_another_revision(self):
        completed = asyncio.Event()
        attempts = 0
        async def read(row):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError('transient read failure')
            value = await self.org(row)
            completed.set()
            return value
        self.host.read_org = read
        self.host.interval = .001
        self.source['body'] = dict(name='last committed name')
        self.host.observed('one', 100)
        await asyncio.wait_for(completed.wait(), 1)
        await self.host.idle()
        self.assertEqual(attempts, 2)
        self.assertEqual((await self.host.full())['summaries']['1']['body'], self.source['body'])

    async def test_failed_last_registry_read_retries_without_another_revision(self):
        completed = asyncio.Event()
        attempts = 0
        async def read():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError('transient registry failure')
            completed.set()
            return await self.registry()
        self.host.read_registry = read
        self.host.interval = .001
        self.cursor['rev'] = 12
        self.records = []
        self.host.refresh.wake()
        await asyncio.wait_for(completed.wait(), 1)
        await self.host.idle()
        self.assertEqual(attempts, 2)
        self.assertEqual((await self.host.full())['registry']['records'], [])
        self.assertEqual(self.host.runners, {})
        self.assertEqual(self.host.last_read, {})

    async def test_removed_inflight_runner_prunes_only_after_read_exits(self):
        self.pause = True
        self.host.observed('one', 100)
        await self.started.wait()
        await self.refresh([])
        runner = self.host.runners['1']
        self.release.set()
        await runner.idle()
        # task-done callbacks are ordered after the runner's finally.
        await asyncio.sleep(0)
        self.assertEqual(self.host.runners, {})
        self.assertEqual(self.host.last_read, {})


if __name__ == '__main__':
    unittest.main()
