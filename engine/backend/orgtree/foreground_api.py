"""Opt-in HTTP transport for selected foreground nodes.

The API's normal operator/public gateway remains the authority boundary. All
field production and public scrubbing use the shared tree projection, while
the context is assembled inside the graph's committed storage snapshot.
"""
from __future__ import annotations

from collections import OrderedDict
import gzip
import importlib
import threading
import time

from fastapi import HTTPException, Request, Response

from . import foreground_cache, foreground_store, foreground_view, store, tree_delta, tree_ui
from .ledger import LedgerError


class _Unavailable(RuntimeError):
    pass


def _context(raw, slug, graph, *, header, reuse=None, reuse_settings=None, inputs=None,
             funding=None):
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
                             reuse_settings=reuse_settings, inputs=inputs, funding=funding)
    except adapter.CompatibilityRequired as error:
        raise _Unavailable from error


def _project(raw, slug, graph, request, *, sync_rev, kind, requested=None, keep=False):
    started = time.perf_counter()
    context = (_context(raw, slug, graph, header=True) if kind == 'snapshot'
               else _page_context(raw, slug, graph))
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


# ---------------------------------------------------------------- pages
#
# A children/search/lookup page used to rebuild its whole context on every
# request: the settings and current-list rows, every live node's funding, the
# card windows and the org inbox, then the projection, and only then the
# revision a 304 compares against (N1000 attempt 6: 16,000 children pages were
# 22% of all engine time and read 8.2 GB to serve 17 KB answers).
#
# Two reuses, each keyed by the committed revision that covers what it holds:
#  * `_page_inputs`: settings/list blobs, the selected nodes' mail, the card
#    windows and the inbox window for one selected id set. Every doc row and
#    every listed-log row they derive from bumps `view_revision` (the 0004
#    triggers, direct SQL included) -- the proof `_advance` relies on too.
#  * `_page_funding`: `read_funding`'s rows. Every node row write bumps
#    `node_revision` and rewrites that node's index meta in the same trigger.
# And one memo: `_pages` keeps a finished answer (etag + body) for exactly
# the committed stamp, runtime stamp and sync revision it was built from --
# the snapshot cache's own freshness key -- until the context's clock deadline.
# A repeat of an unchanged page (a poll, or its 304) then opens the snapshot,
# compares, and builds nothing.
_PAGE_INPUTS_MAX = 16
_PAGES_MAX = 64
_PAGES_MAX_BYTES = 16 * 1024 * 1024
_page_lock = threading.Lock()
_page_inputs: OrderedDict = OrderedDict()
_page_funding: dict = {}
_pages: OrderedDict = OrderedDict()


def _db_stamp(stamp):
    # `seq` is this process's journal position, pinned with the snapshot: not content
    return tuple(sorted((k, v) for k, v in stamp.items() if k != 'seq'))


def _page_context(raw, slug, graph):
    stamp = graph['stamp']
    org = (str(store.DATA_ROOT), slug, stamp['org_id'])
    key = (*org, stamp['view_revision'], tuple(sorted(graph['rows'])))
    with _page_lock:
        inputs = _page_inputs.get(key)
        if inputs is not None:
            _page_inputs.move_to_end(key)
        kept = _page_funding.get(org)
    funding = kept[1] if kept is not None and kept[0] == stamp['node_revision'] else None
    if inputs is None:
        context = _context(raw, slug, graph, header=False, funding=funding)
    else:
        if funding is None:
            funding = foreground_store.read_funding(raw)
        context = _context(raw, slug, graph, header=False, inputs={**inputs, 'funding': funding})
    read = context.inputs
    with _page_lock:
        if inputs is None:
            for old in [k for k in _page_inputs if k[:3] == org and k[3] < stamp['view_revision']]:
                del _page_inputs[old]
            _page_inputs[key] = {name: read[name] for name in ('blobs', 'windows', 'inbox')}
            while len(_page_inputs) > _PAGE_INPUTS_MAX:
                _page_inputs.popitem(last=False)
        kept = _page_funding.get(org)
        if kept is None or kept[0] < stamp['node_revision']:
            _page_funding[org] = (stamp['node_revision'], read['funding'])
    return context


class _Page:
    """One finished page answer and the exact state it was built from."""
    __slots__ = ('stamp', 'runtime', 'sync_rev', 'valid_until', 'etag', 'watermarks', 'body', 'gzip')

    def __init__(self, stamp, runtime, sync_rev, valid_until, etag, watermarks, body):
        self.stamp, self.runtime, self.sync_rev = stamp, runtime, sync_rev
        self.valid_until = valid_until
        self.etag, self.watermarks, self.body, self.gzip = etag, watermarks, body, None

    def wire(self, compressed):
        if not compressed:
            return self.body
        if self.gzip is None:
            self.gzip = gzip.compress(self.body, compresslevel=1, mtime=0)
        return self.gzip

    def size(self):
        return len(self.body) + len(self.gzip or b'')


def _page_hit(key, stamp, runtime, sync_rev):
    from . import foreground_context
    with _page_lock:
        page = _pages.get(key)
        if page is None:
            return None
        # the context's clock deadline too (review f4 on the kept context)
        if (page.stamp != _db_stamp(stamp) or page.runtime != runtime or page.sync_rev != sync_rev
                or not foreground_context.still_valid(page)):
            return None
        _pages.move_to_end(key)
        return page


def _page_keep(key, page):
    with _page_lock:
        current = _pages.get(key)
        # never replace an answer built from a newer committed snapshot
        if current is not None and dict(current.stamp)['org_revision'] > dict(page.stamp)['org_revision']:
            return
        _pages[key] = page
        _pages.move_to_end(key)
        while len(_pages) > _PAGES_MAX or sum(p.size() for p in _pages.values()) > _PAGES_MAX_BYTES:
            _pages.popitem(last=False)


def _read_page(slug, request, *, mode, nid, public):
    """children / search / lookup: the remembered answer when nothing it was
    built from has moved, else a fresh build (which is then remembered)."""
    from . import api
    query = request.query_params
    # Capture before storage, never a newer watermark stamped on an
    # older committed graph. The cache applies the same ordering.
    sync_rev = api._current_sync_rev(slug)
    runtime = api._tree_runtime_stamp(slug)
    built = {}

    def project(raw, graph):
        payload, saved = _project(raw, slug, graph, request, sync_rev=sync_rev,
                                  kind='lookup' if mode == 'lookup' else 'page',
                                  requested=nid, keep=True)
        built['stamp'] = graph['stamp']
        built['until'] = getattr(saved['context'], 'valid_until', None)
        return payload

    if mode == 'lookup':
        key = (str(store.DATA_ROOT), slug, public, mode, nid)
        memo = lambda stamp: _page_hit(key, stamp, runtime, sync_rev)
        payload = foreground_store.read_exact(slug, nid, project=project, memo=memo)
    else:
        limit = int(query.get('limit', '50'))
        options = {'limit': limit, 'cursor': query.get('cursor'), 'project': project}
        if mode == 'children':
            options['edge'] = query.get('edge')
            params = (query.get('parent', ''), limit, options['cursor'], options['edge'])
        else:
            params = (query.get('q', ''), query.get('state'), limit, options['cursor'])
        key = (str(store.DATA_ROOT), slug, public, mode, params)
        options['memo'] = lambda stamp: _page_hit(key, stamp, runtime, sync_rev)
        if mode == 'children':
            payload = foreground_store.read_retired_children(slug, params[0], **options)
        else:
            payload = foreground_store.search(slug, params[0], state=params[1], **options)
    if isinstance(payload, _Page):
        return payload
    token = foreground_view.revision(payload)
    payload['revision'] = token
    page = _Page(_db_stamp(built['stamp']) if 'stamp' in built else None, runtime, sync_rev,
                 built.get('until'),
                 'W/"foreground-page-' + token + '"',
                 {'X-Orgtree-Org-Rev': str(payload['org_rev']),
                  'X-Orgtree-Sync-Rev': str(payload['sync_rev']),
                  'X-Orgtree-Catalog-Rev': payload['catalog_revision']},
                 tree_delta.encode(payload))
    if page.stamp is not None:
        # an answer our projector did not build carries no committed stamp
        # to be checked against, so it is served but never remembered
        _page_keep(key, page)
    return page


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
        elif mode == 'references':
            # The store projects only the same public identity facts the
            # normal tree exposes. No runtime/history context is needed.
            sync_rev = api._current_sync_rev(slug)
            def references(raw, result):
                return {'format': foreground_view.FORMAT, 'kind': 'references',
                    'catalog_revision': foreground_view.catalog(result),
                    'org_rev': result['stamp']['org_revision'], 'sync_rev': sync_rev,
                    'references': result['references'], 'missing': result['missing']}
            payload = foreground_store.read_references(slug, query.getlist('include'), project=references)
            token = foreground_view.revision(payload)
            payload['revision'] = token
            etag = 'W/"foreground-page-' + token + '"'
            watermarks = {'X-Orgtree-Org-Rev': str(payload['org_rev']),
                          'X-Orgtree-Sync-Rev': str(payload['sync_rev']),
                          'X-Orgtree-Catalog-Rev': payload['catalog_revision']}
            body = None if request.headers.get('if-none-match') == etag else tree_delta.encode(payload)
            if body is not None and compressed:
                body = gzip.compress(body, compresslevel=1, mtime=0)
        elif mode in ('lookup', 'children', 'search'):
            page = _read_page(slug, request, mode=mode, nid=nid, public=public_slug is not None)
            etag, watermarks = page.etag, dict(page.watermarks)
            body = None if request.headers.get('if-none-match') == etag else page.wire(compressed)
        else:
            raise ValueError('unknown foreground read')
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
