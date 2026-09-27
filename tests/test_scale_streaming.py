"""A slow agent cannot delay another agent or misattribute its receipt."""
import asyncio
from types import SimpleNamespace
import threading
import time
import unittest

from tools.scale.control import Feed
from tools.scale.streaming import drive_streams, send_frames


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
        self.assertEqual(feed.failed, 1)
        feed.retire(emitted + 6)
        self.assertEqual(len(feed.latencies[0]), 1)
        self.assertEqual(feed.missing[0], 0)


if __name__ == '__main__':
    unittest.main()
