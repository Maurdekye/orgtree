"""Bounded frame queues and coalesced runners, independent of socket routes.

The app feed reuses FrameQueue/CoalescedRunner. The org runner keeps one
cursor, answers subscription generations after their same-snapshot catch-up,
and never waits on a slow socket while advancing that cursor.
"""
from __future__ import annotations

import asyncio
from collections import deque
import copy
from dataclasses import dataclass, field
import json
from itertools import groupby
from typing import Any, Awaitable, Callable, Mapping

from . import record_reads as Q
from .record_registry import Registry, Selection, Snapshot


@dataclass
class _PageBatch:
    remaining: deque[Mapping]
    text: str
    size: int

class FrameQueue:
    """One writer consumes ordered frames. Overflow resets or closes.

    ``reset=True`` is the org protocol. The app protocol uses ``reset=False``
    and reconnects after close.
    A same-snapshot subscription answer occupies one queue entry and encodes
    only its next page. Its already-built bodies remain owned by that entry;
    a large explicit selection does not create a second full encoded copy.
    Limits cover ready encoded bytes and individual pages, not those bodies.
    An in-flight send is outside this queue and still needs a send timeout.
    """
    def __init__(self, *, max_frames=128, max_bytes=4*1024*1024, reset=True,
                 overflow: Callable[[],None] | None = None):
        if max_frames < 1 or max_bytes < 64:
            raise ValueError('invalid record queue limits')
        self.max_frames, self.max_bytes, self.reset = max_frames, max_bytes, reset
        self.frames: deque[tuple[str,int] | _PageBatch] = deque()
        self.bytes = 0
        self.closed = False
        self.overflow = overflow
        self.ready = asyncio.Event()

    def clear(self):
        self.frames.clear()
        self.bytes = 0
        self.ready.clear()

    def close(self):
        self.clear()
        self.closed = True
        self.ready.set()

    @staticmethod
    def _encode(payload):
        text = json.dumps(payload, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
        return text, len(text.encode('utf-8'))

    def _append(self, entry, size):
        if (size > self.max_bytes or self.bytes+size > self.max_bytes
                or len(self.frames) >= self.max_frames):
            self.clear()
            if self.overflow is not None:
                self.overflow()
            if self.reset:
                text, size = '{"type":"record_reset"}', 23
            else:
                self.close()
                return False
            accepted = False
        else:
            accepted = True
        self.frames.append(entry if accepted else (text,size))
        self.bytes += size
        self.ready.set()
        return accepted

    def offer(self, payload: Mapping) -> bool:
        if self.closed:
            return False
        text,size = self._encode(payload)
        return self._append((text,size),size)

    def offer_pages(self, pages) -> bool:
        if self.closed:
            return False
        remaining = deque(pages)
        if not remaining:
            return True
        first = remaining.popleft()
        text,size = self._encode(first)
        return self._append(_PageBatch(remaining,text,size),size)

    async def take(self) -> str | None:
        while not self.frames:
            if self.closed:
                return None
            self.ready.clear()
            await self.ready.wait()
        entry = self.frames[0]
        if isinstance(entry,_PageBatch):
            text,size = entry.text,entry.size
            self.bytes -= size
            next_page = entry.remaining.popleft() if entry.remaining else None
            if next_page is None:
                self.frames.popleft()
            else:
                entry.text,entry.size = self._encode(next_page)
                if entry.size > self.max_bytes or self.bytes+entry.size > self.max_bytes:
                    # A single oversize page or genuine later-frame backlog.
                    # The partial answer cannot publish before its final page.
                    self.clear()
                    if self.overflow is not None:
                        self.overflow()
                    if self.reset:
                        self.offer(dict(type='record_reset'))
                    else:
                        self.close()
                else:
                    self.bytes += entry.size
            return text
        text,size = self.frames.popleft()
        self.bytes -= size
        return text


class CoalescedRunner:
    """Event-loop-owned work: a wake during a read makes one more pass."""
    def __init__(self, work: Callable[[], Awaitable[None]],
                 error: Callable[[Exception], None]):
        self.work, self.error = work, error
        self.dirty = False
        self.task: asyncio.Task | None = None
        self.closed = False

    def wake(self):
        if self.closed:
            return
        self.dirty = True
        if self.task is None:
            self.task = asyncio.create_task(self._run())

    async def _run(self):
        try:
            while self.dirty and not self.closed:
                self.dirty = False
                try:
                    await self.work()
                except Exception as exc:
                    self.error(exc)
        finally:
            self.task = None

    async def idle(self):
        while self.task is not None:
            await self.task

    async def close(self):
        self.closed = True
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass


@dataclass(frozen=True)
class SocketRequest:
    selections: tuple[Selection, ...]
    pending: frozenset[int]


@dataclass(frozen=True)
class Batch:
    cursor: Q.Cursor
    changes: Mapping[Any, dict]
    answers: Mapping[Any, tuple[dict, ...]]
    runtime: Any = None


def read_snapshot(registry: Registry, state: Snapshot, after: Q.Cursor | None,
                  requests: Mapping[Any, SocketRequest], *, defer_bodies=False) -> Batch:
    """Every socket's changes and answers use this exact committed snapshot."""
    current = Q.cursor(state)
    changes, answers = {}, {}
    for token,request in requests.items():
        changes[token] = Q.catchup(registry,state,after or current,selections=request.selections)
        answers[token] = (() if changes[token]['type']=='record_reset' else tuple(
            page for selection in request.selections
            if selection.set.startswith('sub:')
            and int(selection.set.partition(':')[2]) in request.pending
            for page in ((Q.subscribed(registry,state,selection),) if defer_bodies
                         else Q.subscribed_pages(registry,state,selection))))
    return Batch(current,changes,answers)


def reader(slug: str, registry: Registry):
    """Worker read checks out one connection, shared by ALL socket builders."""
    def read(after, requests):
        with Q.snapshot(slug) as state:
            return read_snapshot(registry,state,after,requests)
    async def load(after, requests):
        return await asyncio.to_thread(read,after,requests)
    return load


@dataclass
class _Client:
    send: Callable[[dict], bool]
    send_pages: Callable[[tuple[dict, ...]], bool] | None = None
    selections: dict[int, Selection] = field(default_factory=dict)
    pending: set[int] = field(default_factory=set)
    highest: int = -1


class OrgRunner:
    """One cursor per active org; subscription declarations per socket.

    Join sends no record baseline: the caller queues the initial full runtime
    first, and the client performs its HTTP reconnect catch-up. The initial
    runner read establishes its cursor and answers pending subscriptions.
    ``send`` queues synchronously and returns False after reset/closure.
    """
    def __init__(self, load, error: Callable[[Exception], None], *, registry: Registry | None = None,
                 published: Callable[[Batch], None] | None = None):
        self.load = load
        self.registry = registry
        self.cursor: Q.Cursor | None = None
        self.clients: dict[Any, _Client] = {}
        self.run = CoalescedRunner(self._read, self._failed)
        self.error = error
        self.published = published

    def join(self, token, send, send_pages=None):
        if token in self.clients:
            raise ValueError('socket already joined')
        self.clients[token] = _Client(send,send_pages)
        self.run.wake()

    def leave(self, token):
        self.clients.pop(token,None)

    def subscribe(self, token, args):
        client = self.clients[token]
        # Validate each <=128-agent declaration and the bounded set count.
        # Large include selections split into several generations.
        existing = [dict(sub=g,agents=list(s.agents),windows=list(s.windows))
                    for g,s in client.selections.items()]
        selected = Q.subscriptions(existing+[copy.deepcopy(args)])[-1]
        for arguments in selected.windows:
            window = self.registry.windows.get(arguments.get('kind')) if self.registry else None
            if window is None:
                raise ValueError('unknown record window')
            window.validate(arguments)
        generation = int(selected.set.partition(':')[2])
        if generation <= client.highest:
            raise ValueError('subscription generation must grow')
        client.highest = generation
        client.selections[generation] = selected
        client.pending.add(generation)
        self.run.wake()

    def unsubscribe(self, token, generation):
        if type(generation) is not int or not 0 <= generation <= Q.MAX_GENERATION:
            raise ValueError('invalid subscription generation')
        client = self.clients[token]
        client.selections.pop(generation,None)
        client.pending.discard(generation)

    def wake(self):
        self.run.wake()

    @staticmethod
    def _reset(client):
        client.selections.clear()
        client.pending.clear()

    def _failed(self, exc):
        for client in list(self.clients.values()):
            client.send(dict(type='record_reset'))
            self._reset(client)
        self.error(exc)

    async def _read(self):
        if not self.clients:
            return
        # Token may be reused after a socket disconnect. Retain the actual
        # client object too, so the old worker cannot publish to its successor.
        clients = dict(self.clients)
        requests = {token: SocketRequest((Selection(), *client.selections.values()),
                        frozenset(client.pending)) for token,client in clients.items()}
        batch = await self.load(self.cursor, requests)
        for token,request in requests.items():
            client = self.clients.get(token)
            if client is not clients[token]:
                continue
            frame = batch.changes[token]
            if frame['type']=='record_reset':
                client.send(frame)
                self._reset(client)
                continue
            held = {'shared', *(s.set for s in client.selections.values())}
            frame = {**frame, 'upserts':[r for r in frame['upserts'] if r['set'] in held],
                     'tombstones':[r for r in frame['tombstones'] if r['set'] in held]}
            answers = batch.answers[token]
            if (frame['from'] != frame['to'] or answers) and not client.send(frame):
                self._reset(client)
                continue
            for generation,group in groupby(answers,key=lambda a:a['sub']):
                pages = tuple(group)
                if generation not in client.pending or generation not in client.selections:
                    continue  # unsubscribe during this snapshot's read
                accepted = (client.send_pages(pages) if client.send_pages is not None
                            else all(client.send(page) for page in pages))
                if not accepted:
                    self._reset(client)
                    break
                if pages[-1].get('final', True):
                    client.pending.remove(generation)
        # Advance only AFTER every current socket's frames were queued.
        self.cursor = batch.cursor
        if self.published is not None:
            self.published(batch)

    async def close(self):
        self.clients.clear()
        await self.run.close()
