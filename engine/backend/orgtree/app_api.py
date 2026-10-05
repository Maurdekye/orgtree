"""The app socket and coherent host copy, under the existing operator gate.

App registry notifications and org revision subscribers only wake coalesced
readers. Database work never runs on the loop or while assigning host stamps.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from . import orgdb, pgfeed, record_api
from .orgdb import app_reads, conn, names, registry
from .orgdb.app_host import AppHost, AppReplaced


router = APIRouter()
log = logging.getLogger(__name__)
host = None
feed = None
unsubscribe = None
publishers = None
SEND_TIMEOUT = 10.0


def capable():
    if not record_api.READY or not orgdb.enabled():
        return False
    with registry.session(conn.runtime_base(), names.app(),
                          application_name='orgtree-app-capability') as raw:
        if raw.execute("SELECT to_regclass('orgtree.app_identity')").fetchone()[0] is None:
            return False
        return bool(raw.execute('SELECT EXISTS (SELECT 1 FROM orgtree.schema_migrations '
            'WHERE name=%s)', ('0005_app_feed.sql',)).fetchone()[0])


def _error(exc):
    log.error('app feed failed: %s', exc, exc_info=exc)


async def start():
    global host, feed, unsubscribe, publishers
    if host is not None or not await asyncio.to_thread(capable):
        return
    loop = asyncio.get_running_loop()
    async def read_registry():
        value = await asyncio.to_thread(app_reads.registry_snapshot)
        loop.call_soon(transition)
        return value
    async def read_org(row):
        return await asyncio.to_thread(app_reads.org_snapshot, row)
    current = host = AppHost(read_registry, read_org, _error)
    unsubscribe = record_api.revision_subscribers.subscribe(current.observed)
    # The callback captures this host, never a future replacement's globals.
    feed = pgfeed.RevisionFeed(app_reads.AppConnection,
        lambda _slug, _rev, _gap: loop.call_soon_threadsafe(current.refresh.wake))
    feed.start()
    current.refresh.wake()
    from . import app_runtime
    def publish(key, value):
        if current.closed or current.invalid:
            return
        current.runtime(values={key: value})
        if key == 'openrouter':
            record_api.catalog_changed({row['tier']: row['model'] for row in value.get('tiers', [])
                                        if isinstance(row, dict) and 'tier' in row and 'model' in row})
    publishers = app_runtime.start(publish, _error)


def transition():
    """Called on the event loop for supervisor state changes; no org reads."""
    if host is None or host.closed or host.invalid:
        return
    from . import supervisor
    host.runtime(orgs={key: {'working': supervisor.working_count(span.row['slug'])}
                       for key, span in host.spans.items()})


def _current():
    if not record_api.READY or not orgdb.enabled() or host is None:
        raise HTTPException(501, 'app feed requires migrated org database storage')
    return host


@router.get('/api/app/records')
async def records():
    try:
        return record_api._response(await _current().full())
    except (AppReplaced, RuntimeError) as exc:
        raise HTTPException(503, str(exc)) from exc


async def _send(ws, queue):
    while True:
        text = await queue.take()
        if text is None:
            return
        await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT)


async def _receive(ws):
    # No app subscriptions, client cursor or client state to accept. Reading
    # still detects a peer disconnect while the outgoing feed is quiet.
    while True:
        await ws.receive_text()


@router.websocket('/api/app/ws')
async def socket(ws: WebSocket):
    queue = None
    tasks = []
    current = None
    try:
        current = _current()
        await ws.accept()
        queue = await current.connect()
        tasks = [asyncio.create_task(_send(ws, queue)), asyncio.create_task(_receive(ws))]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (HTTPException, AppReplaced, RuntimeError, WebSocketDisconnect, TimeoutError):
        pass
    finally:
        if queue is not None:
            current.disconnect(queue)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await ws.close(code=1013)
        except (RuntimeError, WebSocketDisconnect):
            pass


async def close():
    global host, feed, unsubscribe, publishers
    if publishers is not None:
        await publishers.close()
        publishers = None
    if unsubscribe is not None:
        unsubscribe()
        unsubscribe = None
    if feed is not None:
        current_feed, feed = feed, None
        # Signal before joining outside the event loop. The listener owns and
        # closes its connection, and shutdown leaves no app listener behind.
        current_feed.stop(timeout=0.0)
        await asyncio.to_thread(current_feed.stop, timeout=6.0)
    if host is not None:
        current, host = host, None
        await current.close()
