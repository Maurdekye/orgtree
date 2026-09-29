"""Independent, ordered stream producers for the disposable scale client."""
from __future__ import annotations

import asyncio
import threading
import time


async def send_frames(client, frames, *, first_seq, emit, due, started, feed, rec, ids=None):
    """Bind receipts to this request before another producer advances IDs.

    ``ids`` names each frame's marker when they are not consecutive (a planned
    catch-up batch interleaves with other agents' plan IDs); ``due`` is the
    OLDEST frame's due time, so ``late_ms`` keeps the backlog visible."""
    own_ids = list(ids) if ids is not None else list(range(first_seq, first_seq + len(frames)))
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


def split_unsent(plan_rows, sent_ids, max_batch):
    """Split planned-but-unsent frames into ``(close_cutoff, backlog)``.

    ``drive_planned`` keeps one request per agent in flight and emits nothing
    at or after the close. So an agent whose last request was still in flight
    at the close leaves the frames due since then unsent. The next single
    request would have carried at most ``max_batch`` of them. Those are the
    close cutoff (attempt 6: one frame, due 0.25 s before the close). Anything
    beyond that, an unsent frame due before a frame of the same agent that
    WAS sent, and every frame of an agent that sent nothing, is a real backlog.
    """
    by_node = {}
    for row in plan_rows:
        by_node.setdefault(row['node'], []).append(row)
    cutoff = backlog = 0
    for rows in by_node.values():
        rows.sort(key=lambda r: (r['t'], r['m']))
        last_sent = max((i for i, r in enumerate(rows) if r['m'] in sent_ids), default=-1)
        backlog += sum(1 for r in rows[:last_sent + 1] if r['m'] not in sent_ids)
        tail = sum(1 for r in rows[last_sent + 1:] if r['m'] not in sent_ids)
        if last_sent < 0:                          # never sent at all: not a close cutoff
            backlog += tail
            continue
        cutoff += min(tail, max_batch)
        backlog += max(0, tail - max_batch)
    return cutoff, backlog


async def drive_planned(jobs, submit, *, started, duration, stop, max_batch,
                        clock=time.time):
    """Replay a per-agent frame plan with bounded catch-up.

    One submission per agent in flight, as in ``drive_streams``. An agent that
    falls behind sends its overdue rows together, in order, at most
    ``max_batch`` per request, the way the CLI reader hands over the deltas
    that piled up while it was busy. The bound keeps a stalled engine visible:
    it can clear at most ``max_batch`` frames per round trip, so a backlog
    still grows, shows in ``late_ms`` and ends as planned-but-unsent frames.
    Nothing is emitted at or after ``started + duration``, so every marker
    that is sent gets the caller's full delivery horizon.
    ``submit(rows)`` owns marker emission and receipt accounting.
    """
    if max_batch < 1 or duration <= 0:
        raise ValueError('invalid catch-up bound or duration')
    end = started + duration

    async def producer(rows):
        i = 0
        while i < len(rows) and not stop.is_set():
            now = clock()
            if now >= end:
                return
            delay = started + rows[i]['t'] - now
            if delay > 0:
                await asyncio.sleep(min(delay, .1))
                continue
            j = i + 1
            while j < len(rows) and j - i < max_batch and started + rows[j]['t'] <= now:
                j += 1
            await submit(rows[i:j])
            i = j

    tasks = [asyncio.create_task(producer(rows)) for rows in jobs.values()]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def run_planned_threads(jobs, submit, *, started, duration, stop, max_batch,
                        clock=time.time, sleep=time.sleep):
    """``drive_planned`` with one THREAD per agent, for the in-engine producer.

    The engine's CLI reader threads call ``supervisor.stream`` directly, so the
    in-engine producer does the same (coordinator approval 2026-09-29 04:03Z):
    no HTTP hop per frame. Same catch-up bound and close rule as
    ``drive_planned``: overdue rows go together, at most ``max_batch`` per
    call, and nothing is emitted at or after ``started + duration``.
    Returns the started threads; ``submit(rows)`` runs on them.
    """
    if max_batch < 1 or duration <= 0:
        raise ValueError('invalid catch-up bound or duration')
    end = started + duration

    def producer(rows):
        i = 0
        while i < len(rows) and not stop.is_set():
            now = clock()
            if now >= end:
                return
            delay = started + rows[i]['t'] - now
            if delay > 0:
                sleep(min(delay, .1))
                continue
            j = i + 1
            while j < len(rows) and j - i < max_batch and started + rows[j]['t'] <= now:
                j += 1
            submit(rows[i:j])
            i = j

    threads = [threading.Thread(target=producer, args=(rows,), daemon=True, name=f'scale-stream-{node}')
               for node, rows in jobs.items()]
    for thread in threads:
        thread.start()
    return threads


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
