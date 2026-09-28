"""Opt-in HTTP transport for selected foreground nodes.

The API's normal operator/public gateway remains the authority boundary. All
field production and public scrubbing use the shared tree projection, while
the context is assembled inside the graph's committed storage snapshot.
"""
from __future__ import annotations

import gzip
import importlib
import time

from fastapi import HTTPException, Request, Response

from . import foreground_cache, foreground_store, foreground_view, store, tree_delta, tree_ui
from .ledger import LedgerError


class _Unavailable(RuntimeError):
    pass


def _context(raw, slug, graph, *, header, reuse=None, reuse_settings=None, inputs=None):
    # The shared adapter is a separately reviewed dependency. Do not silently
    # load a complete Org, or invent header counts, if it cannot serve a view.
    try:
        adapter = importlib.import_module('.foreground_context', __package__)
    except ModuleNotFoundError as error:
        if error.name != __package__ + '.foreground_context':
            raise
        raise _Unavailable from error
    try:
        return adapter.build(raw, slug, graph, header=header, reuse=reuse,
                             reuse_settings=reuse_settings, inputs=inputs)
    except adapter.CompatibilityRequired as error:
        raise _Unavailable from error


def _project(raw, slug, graph, request, *, sync_rev, kind, requested=None, keep=False):
    started = time.perf_counter()
    context = _context(raw, slug, graph, header=kind == 'snapshot')
    profile = getattr(request.state, 'profile_timing', None)
    if profile is not None:
        profile['foreground_context_ms'] = (time.perf_counter() - started) * 1000
    saved = _kept(context, graph)
    payload = _reproject(saved, request, sync_rev=sync_rev, kind=kind, requested=requested)
    return (payload, saved) if keep else payload


def _advance(raw, slug, saved, stamp, rows):
    """The kept projection inputs moved to this snapshot, re-reading only the
    changed node rows (the cache proved no other node row was written).
    Settings, windows, mail, inbox and counts are read again as a full build
    reads them; unchanged nodes keep their normalized copies."""
    old, graph = saved['context'], saved['graph']
    inputs = getattr(old, 'inputs', None)
    if inputs is not None and stamp['view_revision'] == graph['stamp']['view_revision']:
        # No doc or listed-log row was written since (the 0004 triggers bump
        # view_revision for every one, direct SQL included): settings, mail,
        # windows and inbox are as read. Funding follows the changed rows' meta.
        funding = [{**row, **{key: rows[row['id']]['meta'][key]
                              for key in ('parent', 'state', 'model', 'grant')}}
                   if row['id'] in rows else row for row in inputs['funding']]
        inputs = {**inputs, 'funding': funding}
    else:
        inputs = None
    graph = {**graph, 'stamp': stamp, 'rows': {**graph['rows'], **rows}}
    reuse = {nid: node for nid, node in old.nodes.items() if nid not in rows}
    context = _context(raw, slug, graph, header=True, reuse=reuse,
                       reuse_settings=getattr(old, 'settings_key', None), inputs=inputs)
    return _kept(context, graph)


def _kept(context, graph):
    """Projection inputs the cache may keep; `valid` says whether they may
    still be projected again without a new build (clock deadlines)."""
    from . import foreground_context
    return {'context': context, 'graph': graph,
            'valid': lambda: foreground_context.still_valid(context)}


def _reproject(saved, request, *, sync_rev, kind='snapshot', requested=None):
    """Header, node projection and runtime annotation from a committed context.
    Reads no storage: a runtime-only change repeats just this part."""
    from . import api
    context, graph = saved['context'], saved['graph']
    profile = getattr(request.state, 'profile_timing', None)
    prepared = foreground_view.prepare(context, graph, detail_token=api._archived_detail_rev,
        sync_rev=sync_rev, primed_restart=api.supervisor.primed_restart())
    annotated = api._annotate_org_view(context, prepared['tree'], request, profile=profile)
    return foreground_view.finish(prepared, annotated, kind=kind, requested=requested)


def _response(payload, *, code=200, headers=None):
    return Response(tree_delta.encode(payload), status_code=code,
                    media_type='application/json', headers=headers)


def _unavailable(slug):
    # A client can deliberately use the unchanged full-tree API. This is not
    # an empty graph and must never be interpreted as deleted history.
    return _response({'format': foreground_view.FORMAT, 'kind': 'compatibility',
        'reason': 'foreground_unavailable', 'legacy_url': f'/api/orgs/{slug}'},
        code=409, headers={'Cache-Control': 'no-store'})


def read(slug: str, request: Request, *, mode='snapshot', nid=None) -> Response:
    from . import api
    public_slug = api._public_slug(request)
    if public_slug is not None and public_slug != slug:
        raise HTTPException(404, 'not found')
    if store.STORE_BACKEND != 'postgres':
        return _unavailable(slug)
    compressed = tree_ui.accepts_gzip(request.headers.get('accept-encoding', ''))
    query = request.query_params
    try:
        if mode == 'snapshot':
            etag, body, watermarks = foreground_cache.read(
                slug, public_slug is not None, request.headers.get('if-none-match', ''),
                include=query.getlist('include'), compressed=compressed,
                runtime=lambda: api._tree_runtime_stamp(slug),
                sync_revision=lambda: api._current_sync_rev(slug), feed=api._REV_FEED,
                build=lambda raw, graph: _project(raw, slug, graph, request,
                    sync_rev=api._current_sync_rev(slug), kind='snapshot', keep=True),
                reproject=lambda saved: _reproject(saved, request,
                    sync_rev=api._current_sync_rev(slug)),
                advance=lambda raw, saved, stamp, rows: _advance(raw, slug, saved, stamp, rows))
        else:
            # Capture before storage, never a newer watermark stamped on an
            # older committed graph. The cache applies the same ordering.
            sync_rev = api._current_sync_rev(slug)
            project = lambda raw, graph: _project(raw, slug, graph, request,
                sync_rev=sync_rev, kind='lookup' if mode == 'lookup' else 'page', requested=nid)
            if mode == 'references':
                # The store projects only the same public identity facts the
                # normal tree exposes. No runtime/history context is needed.
                def references(raw, result):
                    return {'format': foreground_view.FORMAT, 'kind': 'references',
                        'catalog_revision': foreground_view.catalog(result),
                        'org_rev': result['stamp']['org_revision'], 'sync_rev': sync_rev,
                        'references': result['references'], 'missing': result['missing']}
                payload = foreground_store.read_references(slug, query.getlist('include'), project=references)
            elif mode == 'lookup':
                payload = foreground_store.read_exact(slug, nid, project=project)
            elif mode in ('children', 'search'):
                limit = int(query.get('limit', '50'))
                options = {'limit': limit, 'cursor': query.get('cursor'), 'project': project}
                if mode == 'children':
                    options['edge'] = query.get('edge')
                    payload = foreground_store.read_retired_children(slug, query.get('parent', ''), **options)
                else:
                    payload = foreground_store.search(slug, query.get('q', ''),
                                                       state=query.get('state'), **options)
            else:
                raise ValueError('unknown foreground read')
            token = foreground_view.revision(payload)
            payload['revision'] = token
            etag = 'W/"foreground-page-' + token + '"'
            watermarks = {'X-Orgtree-Org-Rev': str(payload['org_rev']),
                          'X-Orgtree-Sync-Rev': str(payload['sync_rev']),
                          'X-Orgtree-Catalog-Rev': payload['catalog_revision']}
            body = None if request.headers.get('if-none-match') == etag else tree_delta.encode(payload)
            if body is not None and compressed:
                body = gzip.compress(body, compresslevel=1, mtime=0)
    except foreground_store.CursorReset as error:
        return _response({'format': foreground_view.FORMAT, 'kind': 'reset',
                          'reason': 'catalog_changed', 'catalog_revision': error.catalog},
                         code=409, headers={'Cache-Control': 'no-store'})
    except foreground_store.OrgNotFound as error:
        raise HTTPException(404, str(error)) from error
    except LedgerError as error:
        # A corrupt/incomplete index is not an empty organization or a missing
        # historical node. Keep it an explicit server error.
        raise HTTPException(503, 'foreground projection is inconsistent') from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except _Unavailable:
        return _unavailable(slug)
    headers = {'ETag': etag, 'Vary': 'Accept-Encoding',
               'Cache-Control': 'private, no-cache', **watermarks}
    if body is None:
        return Response(status_code=304, headers=headers)
    if compressed:
        headers['Content-Encoding'] = 'gzip'
    return Response(body, media_type='application/json', headers=headers)
