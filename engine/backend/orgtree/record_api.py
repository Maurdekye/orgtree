"""Record HTTP routes and event-loop-owned org hosts.

Mounted under the existing operator gateway. Only migrated org databases
advertise the capability; other sockets retain the legacy protocol.
Extension registries/subscribers do not start any process.
"""
from __future__ import annotations

import json
import logging
import copy
import asyncio

from fastapi import APIRouter, HTTPException, Response

from . import orgdb, foreground_store, store, profiling
from .orgdb import record_host as H, record_reads as Q, record_selection as S


router = APIRouter()
READY = True
hosts: dict[str, H.OrgHost] = {}
favourites: dict = {}
registry = H.REGISTRY
log = logging.getLogger(__name__)
retention = None
clock = None


def _error(exc):
    log.error('record feed failed: %s', exc, exc_info=exc)


revision_subscribers = H.RevisionSubscribers(_error)


def start_timers():
    """Startup only; never open org databases when the capability is off."""
    global retention, clock
    if READY and orgdb.enabled():
        if retention is None:
            from .orgdb import record_retention
            retention = record_retention.Timer(_error)
            retention.start()
        if clock is None:
            from .orgdb import record_clock_host
            clock = record_clock_host.Timer(_error)
            clock.start()


def capable(slug=None, *, raw=None):
    """Read readiness on the supplied snapshot, or a validated org connection.

    Callers on the event loop must use to_thread. The switch-off path never
    checks out a database, and no readiness is shared across org identities.
    """
    if not READY or not orgdb.enabled():
        return False
    if raw is None:
        from .orgdb import registry as org_registry
        slug = store._safe_slug(slug)
        try:
            with org_registry.connection(slug) as connection:
                return capable(raw=connection)
        except org_registry.OrgUnavailable as exc:
            raise foreground_store.OrgNotFound(str(exc)) from exc
    present = raw.execute("SELECT to_regclass('orgtree.schema_migrations'), "
                          "to_regclass('orgtree.changes'), "
                          "to_regclass('orgtree.revisions')").fetchone()
    if any(value is None for value in present):
        return False
    return bool(raw.execute('SELECT EXISTS (SELECT 1 FROM orgtree.schema_migrations '
                            'WHERE name=%s)', ('0018_records.sql',)).fetchone()[0])


def host(slug):
    if not orgdb.enabled():
        raise HTTPException(501, 'records require org database storage')
    slug = store._safe_slug(slug)
    current = hosts.get(slug)
    if current is None:
        current = hosts[slug] = H.OrgHost(slug, _error)
        current.catalog_changed(favourites)
    return current


def observed(slug, rev, gap):
    # Invoked on the event loop after the listener invalidated its snapshots.
    if clock is not None:
        clock.changed(slug)
    current = hosts.get(slug)
    if current is not None:
        current.observed(slug, rev, gap)
    revision_subscribers.observed(slug, rev, gap)


def transition(slug, names=None):
    current = hosts.get(slug)
    if current is not None:
        current.transition(names)


def hub_transition(slug=None):
    # Called on the loop; each host reads only its own retained hub inputs.
    for key, current in list(hosts.items()):
        if slug is None or key == slug:
            current.transition(())


def catalog_changed(models):
    """B4b calls on the loop after favourite/catalog runtime publication."""
    global favourites
    favourites = copy.deepcopy(dict(models))
    for current in list(hosts.values()):
        current.catalog_changed(favourites)


def _response(frame):
    # JSON's escaped representation also carries retained lone surrogates.
    with profiling.stage('record_serialize_ms'):
        return Response(json.dumps(frame, ensure_ascii=True, allow_nan=False,
                                   separators=(',', ':')), media_type='application/json',
                        headers={'Cache-Control':'no-store'})


async def _read(slug, **kwargs):
    try:
        if not await profiling.record_worker('record_capability_ms', capable, slug):
            raise HTTPException(501, 'record feed is unavailable for this org')
        return _response(await host(slug).http(**kwargs))
    except foreground_store.OrgNotFound as exc:
        # Do not retain a host for a nonexistent/retired slug.
        current = hosts.pop(slug, None)
        if current is not None:
            await current.close()
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get('/api/orgs/{slug}/records')
async def records(slug: str):
    return await _read(slug)


@router.get('/api/orgs/{slug}/records/selection')
async def selection(slug: str, args: str = '{}'):
    try:
        if len(args) > 65536:
            raise ValueError('selection declaration too large')
        names, search = S.arguments(json.loads(args))
        if not orgdb.enabled():
            raise HTTPException(501, 'records require org database storage')
        slug = store._safe_slug(slug)
        if not await asyncio.to_thread(capable, slug):
            raise HTTPException(501, 'record feed is unavailable for this org')
        return _response(await asyncio.to_thread(S.resolve, slug, names, search))
    except foreground_store.OrgNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get('/api/orgs/{slug}/changes')
async def changes(slug: str, after: str, org_uuid: str, incarnation: str, subs: str = '[]'):
    # Validate declarations before the worker, including windows registered by
    # panel extensions. IDs are declarations only, never prior membership.
    try:
        if not after.isascii() or not after.isdigit() or str(int(after)) != after:
            raise ValueError('invalid record cursor')
        cursor = Q.Cursor(org_uuid, incarnation, int(after))
        if len(subs) > 65536:
            raise ValueError('subscription declaration too large')
        selections = Q.subscriptions(json.loads(subs))
        for selection in selections:
            for args in selection.windows:
                window = registry.windows.get(args.get('kind'))
                if window is None:
                    raise ValueError('unknown record window')
                window.validate(args)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return await _read(slug, after=cursor, selections=selections)


def socket_message(current, token, text):
    """Parse only subscriptions; old ping text remains a harmless keepalive."""
    if text in ('ping', 'pong'):
        return
    if len(text) > 65536:
        raise ValueError('subscription declaration too large')
    args = json.loads(text)
    if not isinstance(args, dict):
        raise ValueError('invalid record socket message')
    kind = args.pop('type', None)
    if kind == 'subscribe':
        current.runner.subscribe(token, args)
    elif kind == 'unsubscribe' and set(args) == {'sub'}:
        current.unsubscribe(token, args['sub'])
    elif kind != 'ping':
        raise ValueError('invalid record socket message')


async def close():
    global retention, clock
    if clock is not None:
        current_clock, clock = clock, None
        await current_clock.close()
    if retention is not None:
        current_retention, retention = retention, None
        await current_retention.close()
    current = list(hosts.values())
    hosts.clear()
    for instance in current:
        await instance.close()
