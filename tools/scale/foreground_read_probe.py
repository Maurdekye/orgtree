"""Serial foreground route CPU/bytes on synthetic PostgreSQL history pairs.

No HTTP server, lifespan, provider or load qualification. Writes/fixture creation
are outside read timing. Every status reply is checked against its stored write.
"""
import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(str(REPO))
sys.path[:0] = [str(REPO / 'tests'), str(REPO / 'tools' / 'scale')]
from control import free_commit_gb

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--rounds', type=int, default=100)
args = parser.parse_args()
if args.rounds < 20:
    raise ValueError('aggregate CPU needs at least 20 repetitions')
import test_pgstore as fixture
if not fixture.ADMIN:
    raise RuntimeError('disposable PostgreSQL required')
root = fixture.data.parent
os.environ['ORGTREE_CLAUDE'] = str(root / 'no-cli' / 'claude.exe')
os.environ['ORGTREE_CODEX'] = str(root / 'no-cli' / 'codex.exe')
from launch_guard import LaunchAudit, pin_git
git = shutil.which('git')
subprocess.Popen = pin_git(subprocess.Popen, git)
(root / 'metrics').mkdir(exist_ok=True)
audit = LaunchAudit(root, git=git, providers=[os.environ['ORGTREE_CLAUDE'], os.environ['ORGTREE_CODEX']],
                    agy=shutil.which('agy'))
sys.addaudithook(audit)
from orgtree import api, foreground_api, foreground_cache, ledger, orgtx, store
from starlette.requests import Request
from starlette.responses import Response


def guard():
    available = free_commit_gb()
    if available < 10:
        raise RuntimeError(f'commit floor breached: {available:.3f} GiB')
    if audit.snapshot()['unexpected']:
        raise RuntimeError('unexpected child launch')
    return available


def request(tag=''):
    headers = [(b'accept-encoding', b'gzip')]
    if tag:
        headers.append((b'if-none-match', tag.encode()))
    return Request({'type': 'http', 'method': 'GET', 'path': '/',
                    'headers': headers, 'query_string': b'', 'state': {}})


def decode(reply):
    body = gzip.decompress(reply.body) if reply.headers.get('content-encoding') == 'gzip' else reply.body
    return json.loads(body)


def flat_nodes(tree):
    pending = list(tree['roots'])
    while pending:
        row = pending.pop()
        pending.extend(row['children'])
        yield row


def seed(history, active_template=None):
    org = store.create_org(f'foreground-probe-{history}')
    org.hire(ledger.USER, None, 'luna', 10, 'boss', charter='Visible charter ' * 40)
    for i in range(4):
        org.hire(ledger.USER, 'boss', 'luna', 0, f'worker-{i}')
    if active_template is not None:
        org.d['nodes'] = copy.deepcopy(active_template)
    active = copy.deepcopy(org.nodes)
    active_hash = hashlib.sha256(store._dumps(active).encode()).hexdigest()
    template = org.nodes['worker-0']
    for i in range(history):
        nid = f'past-{i:06d}'
        org.nodes[nid] = dict(copy.deepcopy(template), id=nid, name=nid, seat_id=f'past-seat-{i}',
                              state='archived', ui_order=i + 10, charter='old charter ' * 80)
    owner = {'node': 'boss', 'generation': 0}
    org.d['work_items'] = [dict(slug='current', status='open', owner=owner, objective='active')]
    org.d['work_items_archive'] = [dict(slug=f'past-work-{i}', status='done', owner=owner,
        objective='closed ' * 80, evidence=[{'kind': 'note', 'ref': 'old', 'note': 'history ' * 80}])
        for i in range(history)]
    org.d['asks'] = [dict(id=f'ask-{i}', node='worker-0', status='answered', at='2000-01-01T00:00:00Z',
        resolved_at='2000-01-01T00:00:00Z', question='past question', questions=[]) for i in range(history)]
    mail = [dict(id=f'mail-{i}', **{'from': 'boss', 'to': 'worker-0'}, body='read mail ' * 80,
                 at='2000-01-01T00:00:00Z') for i in range(history)]
    org.d['mail_log'] = {'worker-0': mail}
    org.d['user_mail_log'] = [dict(m, to='user') for m in mail]
    org.d['org_inbox'] = [dict(m, id=f'org-{i}') for i, m in enumerate(mail)]
    org.d['org_inbox_read'] = history
    org.d['documents'] = [dict(id=f'doc-{i}', node='boss', title='Past document',
        at='2000-01-01T00:00:00Z', body='old text ' * 80) for i in range(history)]
    org = ledger.Org(copy.deepcopy(org.d))
    store.save_org(org)
    manifest = {'history': history, 'active_ids': sorted(active), 'active_input_sha256': active_hash,
                'retired_nodes': history, 'archived_work': history, 'resolved_asks': history,
                'read_recipient_mail': history, 'read_user_mail': history, 'read_org_mail': history,
                'documents': history, 'unread_mail': 0, 'watchdog_tombs': 0}
    return org.d['slug'], manifest, active


def cache_shape():
    with foreground_cache._lock:
        return {'entries': len(foreground_cache._cache),
                'versions': sum(len(e['versions']) for e in foreground_cache._cache.values()),
                'encoded_bytes': sum(foreground_cache._size(e) for e in foreground_cache._cache.values()),
                'max_nodes': max((len(v['nodes']) for e in foreground_cache._cache.values()
                                 for v in e['versions'].values()), default=0)}


def arm(slug, history, ordinal):
    results = []
    # Real clock/runtime stamp remains active. Report any full fallback caused
    # by its boundary; do not suppress it to make the status result look better.
    for mode in ('legacy_rebuild', 'legacy_status', 'foreground_cold', 'foreground_304', 'foreground_status'):
        guard()
        foreground_cache._cache.clear()
        prime = foreground_api.read(slug, request())
        if prime.status_code != 200:
            raise AssertionError((mode, prime.status_code, prime.body))
        expected = decode(prime)
        if set(expected['nodes']) != {'boss', 'worker-0', 'worker-1', 'worker-2', 'worker-3'}:
            raise AssertionError('history leaked into foreground identities')
        if expected['header']['work_items_summary'] != dict(active=1, attention=0):
            raise AssertionError(('wrong real counts', expected['header']['work_items_summary']))
        if expected['header']['retired_total'] != history or expected['header']['org_inbox']['total'] != history:
            raise AssertionError('historical totals differ from fixture')
        tag = prime.headers['etag']
        samples = []
        kinds = {}
        for i in range(args.rounds):
            guard()
            status = None
            if mode == 'foreground_cold':
                foreground_cache._cache.clear()
            if mode in ('legacy_status', 'foreground_status'):
                status = {'status': 'working', 'summary': f'arm-{ordinal}-status-{i}', 'at': ledger.now()}
                with orgtx.org_tx(slug, nodes=['worker-0']) as org:
                    org.nodes['worker-0']['last_status'] = status
                # Independent read in a new transaction, outside route timing.
                with store._POOL.acquire(slug) as conn:
                    node = json.loads(conn.raw.execute('SELECT val FROM nodes WHERE id=%s', ('worker-0',)).fetchone()[0])
                    if node['last_status'] != status:
                        raise AssertionError('status did not persist')
            req = request(tag if mode in ('foreground_304', 'foreground_status') else '')
            cpu, wall = time.thread_time_ns(), time.perf_counter_ns()
            reply = (Response(api._dump_tree(api._org_view(slug, req)), media_type='application/json')
                     if mode.startswith('legacy_') else foreground_api.read(slug, req))
            elapsed = {'cpu_ms': (time.thread_time_ns() - cpu) / 1e6,
                       'wall_ms': (time.perf_counter_ns() - wall) / 1e6,
                       'bytes': len(reply.body), 'status': reply.status_code}
            if reply.status_code not in (200, 304):
                raise AssertionError((mode, reply.status_code, reply.body))
            if reply.status_code == 200:
                wire = decode(reply)
                kind = wire.get('kind', 'legacy')
                if status:
                    observed = (next(n for n in flat_nodes(wire) if n['id'] == 'worker-0')['last_status']
                                if kind == 'legacy' else wire['nodes']['worker-0']['set']['last_status']
                                if kind == 'delta' else wire['nodes']['worker-0']['last_status'])
                    if observed != status:
                        raise AssertionError('status response differs from persisted write')
            else:
                kind = '304'
                if status:
                    raise AssertionError('visible status update returned 304')
            kinds[kind] = kinds.get(kind, 0) + 1
            tag = reply.headers.get('etag', tag)
            samples.append(elapsed)
        entry = dict(arm=ordinal, history=history, mode=mode, count=len(samples), kinds=kinds,
                     cpu_ms_mean=sum(r['cpu_ms'] for r in samples) / len(samples),
                     wall_ms_mean=sum(r['wall_ms'] for r in samples) / len(samples),
                     bytes_mean=sum(r['bytes'] for r in samples) / len(samples),
                     cache=cache_shape(), samples=samples)
        results.append(entry)
        print(json.dumps({k: v for k, v in entry.items() if k != 'samples'}), flush=True)
    return results


result = dict(scope='Serial direct route calls; no HTTP/lifespan/renderer/load or 5% qualification',
              history_order=[100, 1000, 1000, 100], rounds_per_mode=args.rounds,
              manifest=[], arms=[], complete=False)
try:
    guard()
    store.claim_data_root()
    fixtures = {}
    active_template = None
    for history in (100, 1000):
        slug, manifest, active_template = seed(history, active_template)
        fixtures[history] = slug
        result['manifest'].append(manifest)
    if len({m['active_input_sha256'] for m in result['manifest']}) != 1:
        raise AssertionError('active fixture data differs')
    for ordinal, history in enumerate(result['history_order']):
        result['arms'].extend(arm(fixtures[history], history, ordinal))
    result['complete'] = True
finally:
    result['audit'] = audit.snapshot()
    result['free_commit_gb_final'] = free_commit_gb()
    provenance.write_result(args.output, result)
    fixture.tearDownModule()
