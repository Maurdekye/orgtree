"""A slow agent cannot delay another agent or misattribute its receipt."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import threading
import time
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from tools.scale.control import Feed
from tools.scale import streaming
from tools.scale.streaming import drive_planned, drive_streams, send_frames
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'scale'))  # baseline_measurement imports load
from tools.scale.baseline_measurement import summarize_window  # noqa: E402


class IndependentStreams(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, mode):
        entered, release, fast = asyncio.Event(), asyncio.Event(), asyncio.Event()
        stop = threading.Event()
        seen = []
        async def submit(nodes, first, due):
            for node in nodes:
                seen.append((node, first, 'start'))
                if node == 'slow':
                    entered.set()
                    await release.wait()
                else:
                    fast.set()
                seen.append((node, first, 'end'))
        task = asyncio.create_task(drive_streams(['slow', 'fast'], submit, started=time.time(),
            duration=10, hz=1, stop=stop, mode=mode))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            # A real blocked submission is the negative control, not an
            # empty async task or an unobserved scheduling-time assertion.
            if mode == 'independent':
                await asyncio.wait_for(fast.wait(), 1)
            else:
                await asyncio.sleep(0)
                self.assertFalse(fast.is_set())
            stop.set()
            release.set()
            await asyncio.wait_for(task, 1)
        finally:
            stop.set(); release.set()
            await task
        self.assertEqual(sum(row == ('slow', True, 'start') for row in seen), 1)
        return seen

    async def test_independent_fast_agent_passes_blocked_slow_agent(self):
        seen = await self.exercise('independent')
        self.assertLess(seen.index(('fast', True, 'end')), seen.index(('slow', True, 'end')))

    async def test_old_batch_control_reproduces_cross_agent_wait(self):
        seen = await self.exercise('batch')
        self.assertGreater(seen.index(('fast', True, 'start')), seen.index(('slow', True, 'end')))

    async def test_each_agent_retains_order_reset_and_backpressure(self):
        stop, active, seen = threading.Event(), set(), {'a': [], 'b': []}
        async def submit(nodes, first, due):
            self.assertEqual(len(nodes), 1)
            node = nodes[0]
            self.assertNotIn(node, active)
            active.add(node)
            seen[node].append((first, due))
            await asyncio.sleep(.01)
            active.remove(node)
            if all(len(v) >= 3 for v in seen.values()):
                stop.set()
        await asyncio.wait_for(drive_streams(['a', 'b'], submit, started=time.time(),
            duration=2, hz=100, stop=stop), 1)
        for rows in seen.values():
            self.assertEqual([v[0] for v in rows], [True] + [False] * (len(rows) - 1))
            self.assertEqual([v[1] for v in rows], sorted(v[1] for v in rows))
            self.assertGreaterEqual(len(rows), 3)

    async def test_out_of_order_requests_keep_their_own_failure_and_arrival_receipts(self):
        entered, release = asyncio.Event(), asyncio.Event()
        feed = Feed(1)
        emitted = time.time()
        for seq in (1, 2): feed.emit(seq, emitted)
        events = []
        rec = SimpleNamespace(write=lambda name, row: events.append(row))
        class Client:
            async def post(self, route, json):
                self_node = json['frames'][0]['node']
                if self_node == 'slow':
                    entered.set()
                    await release.wait()
                    raise RuntimeError('observed rejection')
                feed.receive(0, 2, emitted + .01)
                return SimpleNamespace(status_code=200, json=lambda: {'ok': True})
        client = Client()
        async def send(node, seq):
            await send_frames(client, [{'node': node}], first_seq=seq, emit=emitted,
                due=emitted, started=emitted, feed=feed, rec=rec)
        slow = asyncio.create_task(send('slow', 1))
        try:
            await entered.wait()
            await send('fast', 2)
        finally:
            release.set()
            await slow
        self.assertEqual([row['first_seq'] for row in events], [2, 1])
        self.assertIsNone(events[0]['err'])
        self.assertIn('observed rejection', events[1]['err'])
        feed.retire(emitted + 6)
        self.assertEqual(feed.failed, 1)
        self.assertEqual(len(feed.latencies[0]), 1)
        self.assertEqual(feed.counts[0]['missing'], 0)
        self.assertEqual(feed.counts[0]['due'], 1)


class PlannedCatchUp(unittest.IsolatedAsyncioTestCase):
    """Attempt 5 (2026-09-28): one frame per request at 4 Hz against a ~260 ms
    engine left 2339 planned markers unsent, and the last sent marker went out
    after the duration, 0.1 s before the windows closed."""

    def plan(self, nodes, hz, seconds):
        jobs, m = {n: [] for n in nodes}, 0
        for tick in range(int(hz * seconds)):
            for n in nodes:
                m += 1
                jobs[n].append({'m': m, 't': tick / hz, 'node': n})
        return jobs

    async def replay(self, jobs, *, latency, duration, max_batch):
        clock = {'now': 0.0}
        stop, sent, active = threading.Event(), [], set()
        async def submit(rows):
            node = rows[0]['node']
            self.assertNotIn(node, active)          # one request in flight per agent
            active.add(node)
            sent.append((clock['now'], [r['m'] for r in rows], node))
            clock['now'] += latency
            await asyncio.sleep(0)
            active.discard(node)
        real_sleep = asyncio.sleep
        async def sleep(delay, *a):
            clock['now'] += delay
            await real_sleep(0)
        streaming.asyncio.sleep = sleep
        try:
            await drive_planned(jobs, submit, started=0.0, duration=duration, stop=stop,
                                max_batch=max_batch, clock=lambda: clock['now'])
        finally:
            streaming.asyncio.sleep = real_sleep
        return sent

    async def test_slow_engine_catches_up_in_order_without_unsent_markers(self):
        jobs = self.plan(['a'], hz=4, seconds=60)
        sent = await self.replay(jobs, latency=.26, duration=60, max_batch=8)
        ids = [m for _, batch, _ in sent for m in batch]
        self.assertEqual(ids, [r['m'] for r in jobs['a']])      # all sent, in plan order
        self.assertGreater(max(len(b) for _, b, _ in sent), 1)   # it did batch
        self.assertLessEqual(max(len(b) for _, b, _ in sent), 8)

    async def test_one_frame_per_request_reproduces_attempt_5_shortfall(self):
        # Negative control: the old producer's shape (max_batch=1) falls behind.
        jobs = self.plan(['a'], hz=4, seconds=60)
        sent = await self.replay(jobs, latency=.26, duration=60, max_batch=1)
        self.assertLess(len(sent), len(jobs['a']))

    async def test_bound_keeps_a_stalled_engine_visible(self):
        jobs = self.plan(['a'], hz=4, seconds=60)
        sent = await self.replay(jobs, latency=3.0, duration=60, max_batch=8)
        ids = [m for _, batch, _ in sent for m in batch]
        self.assertLess(len(ids), len(jobs['a']))                # backlog is not hidden
        self.assertLessEqual(max(len(b) for _, b, _ in sent), 8)

    async def test_nothing_is_sent_at_or_after_the_duration(self):
        jobs = self.plan(['a', 'b'], hz=4, seconds=60)
        sent = await self.replay(jobs, latency=.5, duration=30, max_batch=1)
        self.assertTrue(sent)
        self.assertTrue(all(at < 30 for at, _, _ in sent))

    def test_invalid_bound_is_refused(self):
        with self.assertRaises(ValueError):
            asyncio.run(drive_planned({}, None, started=0, duration=1, stop=threading.Event(), max_batch=0))


class FeedMeasurementSplit(unittest.TestCase):
    """Unsent planned markers are a demand failure, reported apart from drops."""

    def write(self, folder, name, rows):
        with (folder / (name + '.jsonl')).open('w', encoding='utf-8') as f:
            for row in rows:
                f.write(json.dumps(row) + '\n')

    def measure(self, sent, received):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            self.write(folder, 'stream-plan', [{'m': m, 't': 10 + m, 'node': 'a'} for m in range(1, 11)])
            self.write(folder, 'markers', [{'m': m, 'emit': 100.0 + m, 'node': 'a'} for m in sent])
            self.write(folder, 'stream', [{'t': 10 + m, 'frames': 1, 'err': None, 'ms': 5.0, 'late_ms': 2.0}
                                          for m in sent])
            self.write(folder, 'feed-receipts', [{'w': 0, 'm': m, 'emit': 100.0 + m, 'receive': 100.2 + m}
                                                 for m in received])
            return summarize_window(folder, {'warmup_s': 0, 'duration_s': 100, 'windows': 1})

    def test_all_sent_and_delivered_passes(self):
        r = self.measure(range(1, 11), range(1, 11))
        self.assertEqual((r['feed'][0]['planned_not_sent'], r['feed'][0]['missing_after_5s']), (0, 0))
        self.assertTrue(r['feed_pass'])

    def test_unsent_is_its_own_field_not_a_drop(self):
        r = self.measure(range(1, 8), range(1, 8))
        f = r['feed'][0]
        self.assertEqual((f['expected'], f['sent'], f['planned_not_sent'], f['missing_after_5s']), (10, 7, 3, 0))
        self.assertFalse(r['feed_pass'])
        self.assertEqual(r['feed_send']['requests'], 7)

    def test_sent_but_undelivered_is_a_drop(self):
        r = self.measure(range(1, 11), range(1, 10))
        self.assertEqual((r['feed'][0]['planned_not_sent'], r['feed'][0]['missing_after_5s']), (0, 1))
        self.assertFalse(r['feed_pass'])

if __name__ == '__main__':
    unittest.main()
