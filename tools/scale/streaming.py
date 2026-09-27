"""Independent, ordered stream producers for the disposable scale client."""
from __future__ import annotations

import asyncio
import time


async def send_frames(client, frames, *, first_seq, emit, due, started, feed, rec):
    """Bind receipts to this request before another producer advances IDs."""
    own_ids = list(range(first_seq, first_seq + len(frames)))
    begun, err = time.time(), None
    try:
        response = await client.post('/scale/stream', json={'frames': frames})
        if response.status_code != 200 or not response.json().get('ok'):
            err = response.text[:200]
    except Exception as exc:
        err = f'{type(exc).__name__}: {exc}'[:200]
    feed.acknowledge(own_ids, not err)
    feed.retire(time.time())
    rec.write('stream', {'t': round(begun - started, 3), 'frames': len(frames), 'err': err,
                         'ms': round((time.time() - begun) * 1000, 1),
                         'first_seq': first_seq, 'emit': emit,
                         'late_ms': round((begun - due) * 1000, 1)})


async def drive_streams(nodes, submit, *, started, duration, hz, stop,
                        mode='independent', clock=time.time):
    """One in-flight submission per agent, with no cross-agent barrier.

    ``batch`` preserves the old synthetic cross-agent serialization solely
    for comparison. A slow agent retains its own backpressure in either mode.
    There is one async task per producer, not a thread or unbounded queue.
    ``submit(nodes, first, due)`` owns frame IDs and receipt accounting.
    """
    if mode not in ('independent', 'batch') or hz <= 0 or duration <= 0:
        raise ValueError('invalid stream mode, frequency or duration')
    if len(set(nodes)) != len(nodes):
        raise ValueError('stream producers must name distinct agents')

    async def producer(own):
        due, first = started, True
        while not stop.is_set() and clock() < started + duration:
            delay = due - clock()
            if delay > 0:
                await asyncio.sleep(min(delay, .1))
                continue
            await submit(own, first, due)
            first = False
            due += 1 / hz

    groups = [nodes] if mode == 'batch' and nodes else [[node] for node in nodes]
    tasks = [asyncio.create_task(producer(group)) for group in groups]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
