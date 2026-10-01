"""Bounded serial route-cost probe, no HTTP server or supervisor lifespan.

Run against a fresh scale seed via ui_transport_probe_run.py. These are isolated
per-call CPU/bytes observations, not loaded latency or renderer qualification.
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import faulthandler

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/scale'))
from seed import child_env
from control import free_commit_gb

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
args = p.parse_args()
faulthandler.dump_traceback_later(20, repeat=True)
root = args.root.resolve()
desc = json.loads((root / 'scale-descriptor.json').read_text(encoding='utf-8'))
env = child_env(root, desc['pg_url'])
env.update(ORGTREE_CLAUDE=str(root / 'no-cli' / 'claude.exe'),
           ORGTREE_CODEX=str(root / 'no-cli' / 'codex.exe'))
os.environ.clear()
os.environ.update(env)
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(str(REPO))
from launch_guard import LaunchAudit, pin_git
git = shutil.which('git')
subprocess.Popen = pin_git(subprocess.Popen, git)
(root / 'metrics').mkdir(exist_ok=True)
audit = LaunchAudit(root, git=git,
    providers=[os.environ['ORGTREE_CLAUDE'], os.environ['ORGTREE_CODEX']],
    agy=shutil.which('agy'))
sys.addaudithook(audit)
from engine.launch import load_app
app, *_ = load_app()
print('API import complete', flush=True)
from orgtree import api, store, ledger, work_ui
from starlette.requests import Request
from starlette.responses import Response, JSONResponse
assert Path(store.DATA_ROOT).resolve() == root / 'data'
assert store.STORE_BACKEND == 'postgres'

slug = desc['org']
rows = []


def request(etag=None):
    headers = [(b'x-orgtree-desktop-token', b'probe')]
    if etag:
        headers.append((b'if-none-match', etag.encode()))
    return Request({'type': 'http', 'method': 'GET', 'path': '/',
                    'headers': headers, 'state': {}})


def measure(name, fn, *, expected=200):
    free = free_commit_gb()
    assert free >= 10, f'free commit {free} below10GiB'
    wall, cpu = time.perf_counter(), time.thread_time()
    result = fn()
    # Match the HTTP JSON response encoding for plain mappings/lists. The
    # route's own bytes are already serialized on the cached Response path.
    if not isinstance(result, Response):
        result = JSONResponse(result)
    cpu = (time.thread_time() - cpu) * 1000
    wall = (time.perf_counter() - wall) * 1000
    assert expected is None or result.status_code == expected, (name, result.status_code)
    rows.append(dict(name=name, cpu_ms=cpu, wall_ms=wall,
                     status=result.status_code, bytes=len(result.body),
                     etag=result.headers.get('etag'), free_commit_gb=free))
    print(json.dumps(rows[-1]), flush=True)
    assert not audit.snapshot()['unexpected'], 'launch audit invalidated probe'
    return result


org = store.load_org(slug)
print('Initial org read complete', flush=True)
worker = sorted(n for n in org.nodes if n.startswith('worker-'))[0]
shape = dict(live=sum(n.get('state') == 'live' for n in org.nodes.values()),
             nodes=len(org.nodes), active_items=len(org.d.get('work_items', [])))
item = org.d['work_items'][0]['slug']
del org
full_body = None
for repeat in range(3):
    api._work_list_cache.clear()
    full = measure('docket_full_cold', lambda: api.work_items_list(
        slug, archived=1, backlogged=1, request=request()))
    full_body = full.body
    etag = full.headers['etag']
    measure('docket_full_body_cache', lambda: api.work_items_list(
        slug, archived=1, backlogged=1, request=request()))
    measure('docket_full_304', lambda: api.work_items_list(
        slug, archived=1, backlogged=1, request=request(etag)), expected=304)
    # A genuine persisted, unrelated node-status update should expose the
    # global-sequence validator cost without changing any work item.
    org = store.load_org(slug)
    org.nodes[worker]['status'] = {'state': 'idle', 'summary': f'probe {repeat}'}
    store.save_org(org)
    del org
    measure('full_after_status_save', lambda: api.work_items_list(
        slug, archived=1, backlogged=1, request=request(etag)))
    work_ui._cache.clear()
    light = measure('light_cold', lambda: api.work_items_view(slug, request=request()))
    item = json.loads(light.body)['items'][0]['slug']
    stamp = light.headers['etag']
    measure('light_warm_body', lambda: api.work_items_view(slug, request=request()))
    measure('light_304', lambda: api.work_items_view(slug, request=request(stamp)), expected=304)
    org = store.load_org(slug)
    org.nodes[worker]['status'] = {'state': 'idle', 'summary': f'light probe {repeat}'}
    store.save_org(org)
    del org
    measure('light_after_status_save', lambda: api.work_items_view(slug, request=request(stamp)), expected=304)
    org = store.load_org(slug)
    selected = next(row for row in org.d['work_items'] if row['slug'] == item)
    selected['title'] = f'Edited item {repeat}'
    selected['rev'] += 1
    store.save_org(org)
    del org
    changed = measure('light_one_item_delta', lambda: api.work_items_view(slug, request=request(stamp)))
    payload = json.loads(changed.body)
    assert len(payload['delta']['items']['upsert']) == 1, payload.keys()
    measure('light_all_groups', lambda: api.work_items_view(slug, archived=1, backlogged=1, request=request()))
    measure('full_selected_item', lambda: api.work_item_get(slug, item))

# Account for the large fields without preserving the 33 MB body in evidence.
payload = json.loads(full_body)
field_bytes = collections.Counter()
group_counts = {}
for group in ('items', 'archived', 'backlogged'):
    group_counts[group] = len(payload.get(group, []))
    for item in payload.get(group, []):
        for key, value in item.items():
            field_bytes[key] += len(api._dump_tree({key: value}))
provenance.write_result(args.output, dict(
    scope='serial direct route plus JSON encoding; no HTTP server, lifespan or concurrent load',
    modules={m.__name__: m.__file__ for m in (api, store, ledger, work_ui)},
    shape=shape, groups=group_counts, rows=rows,
    largest_fields=field_bytes.most_common(15), audit=audit.snapshot(),
    full_sha256=hashlib.sha256(full_body).hexdigest()))
