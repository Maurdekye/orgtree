"""Serial tree bytes/dependency audit on a disposable PG seed; not load evidence."""
import argparse
from collections import Counter
import hashlib
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/scale'))
from seed import child_env
from control import free_commit_gb
p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--status-rounds', type=int, default=0)
args = p.parse_args()
root = args.root.resolve()
desc = json.loads((root / 'scale-descriptor.json').read_text())
env = child_env(root, desc['pg_url'])
env.update(ORGTREE_CLAUDE=str(root / 'no-cli/claude.exe'),
           ORGTREE_CODEX=str(root / 'no-cli/codex.exe'))
os.environ.clear()
os.environ.update(env)
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(str(REPO))
from launch_guard import LaunchAudit, pin_git
git = shutil.which('git')
subprocess.Popen = pin_git(subprocess.Popen, git)
(root / 'metrics').mkdir(exist_ok=True)
audit = LaunchAudit(root, git=git, providers=[env['ORGTREE_CLAUDE'], env['ORGTREE_CODEX']],
                    agy=shutil.which('agy'))
sys.addaudithook(audit)
from engine.launch import load_app
app, *_ = load_app()
from orgtree import api, store, ledger
from starlette.requests import Request
from starlette.responses import Response
assert Path(store.DATA_ROOT).resolve() == root / 'data'
assert store.STORE_BACKEND == 'postgres'
slug = desc['org']
rows = []

def request(etag=None, compressed=False):
    headers = [(b'x-orgtree-desktop-token', b'probe')]
    if etag:
        headers.append((b'if-none-match', etag.encode()))
    if compressed:
        headers.append((b'accept-encoding', b'gzip'))
    return Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': headers, 'state': {}})

def read(name, etag=None, *, transport=False, compressed=False):
    assert free_commit_gb() >= 10
    wall, cpu = time.perf_counter(), time.thread_time()
    req = request(etag, compressed)
    reply = api._org_tree_transport(slug, req) if transport else api.org_tree(slug, req, Response())
    rows.append(dict(name=name, status=reply.status_code, bytes=len(reply.body),
        cpu_ms=(time.thread_time()-cpu)*1000, wall_ms=(time.perf_counter()-wall)*1000,
        etag=reply.headers.get('etag'), org_seq=store.org_seq(slug)))
    print(json.dumps(rows[-1]), flush=True)
    assert audit.snapshot()['unexpected'] == 0
    return reply

def nodes(tree):
    todo = list(tree['roots'])
    while todo:
        n = todo.pop()
        todo.extend(n['children'])
        yield n

def content(tree):
    return {k:v for k,v in tree.items() if k not in ('org_rev','sync_rev')}

def difference(before, after):
    bn = {n['id']:n for n in nodes(before)}
    an = {n['id']:n for n in nodes(after)}
    return dict(top=[k for k in set(before)|set(after)
                     if k != 'roots' and before.get(k)!=after.get(k)],
        nodes={nid:[k for k in set(bn.get(nid,{}))|set(n)
                    if k != 'children' and bn.get(nid,{}).get(k)!=n.get(k)]
               for nid,n in an.items() if bn.get(nid)!=n})

initial = read('cold')
initial = read('warm_body')  # first annotation may populate runtime caches
before = json.loads(initial.body)
(args.output.parent / 'tree-full.json').write_bytes(initial.body)
read('unchanged', initial.headers['etag'])
view = read('view_cold', transport=True)
view = read('view_warm', transport=True)
read('view_gzip_full', transport=True, compressed=True)
read('view_unchanged', view.headers['etag'], transport=True)
fields = {'live':Counter(), 'archived':Counter()}
all_nodes = list(nodes(before))
for n in all_nodes:
    group = 'live' if n['state']=='live' else 'archived'
    for k,v in n.items():
        if k != 'children':
            fields[group][k] += len(api._dump_tree({k:v}))
changes=[]
worker = next(n['id'] for n in all_nodes if n['id'].startswith('worker-') and n['state']=='live')
for name in ('unrelated_node_field','visible_status','docket_evidence'):
    org = store.load_org(slug)
    if name == 'unrelated_node_field':
        org.nodes[worker]['tree_probe_unused'] = 'saved but not projected'
    elif name == 'visible_status':
        org.nodes[worker]['last_status'] = {'status':'working','summary':'tree probe visible','at':ledger.now()}
    else:
        org.d['work_items'][0].setdefault('evidence',[]).append({'kind':'note','ref':'probe','note':'invisible tree evidence'})
    store.save_org(org)
    after_reply=read(name, initial.headers['etag'])
    assert after_reply.status_code == 200
    after=json.loads(after_reply.body)
    changes.append(dict(name=name, difference=difference(before,after),
        same_content=content(before)==content(after)))
    updated = read('view_'+name, view.headers['etag'], transport=True)
    zipped = read('view_'+name+'_gzip', view.headers['etag'], transport=True, compressed=True)
    if updated.status_code == 200:
        assert gzip.decompress(zipped.body) == updated.body
        (args.output.parent / ('view-'+name+'.json')).write_bytes(updated.body)
    view = updated
    before, initial = after, after_reply
    read(name+'_repeat', initial.headers['etag'])

status_rounds = []
if args.status_rounds:
    # ABBA order, persisted writes outside timing. Each request pays its own
    # snapshot refresh; the other route is never called first on that write.
    # Aggregate thread CPU resolves below Windows' single-sample quantum.
    from unittest.mock import patch
    workers = [n['id'] for n in all_nodes if n['id'].startswith('worker-') and n['state']=='live']
    for arm, transport in enumerate((False, True, True, False)):
        tag = read('round_warm_'+str(arm), transport=transport, compressed=transport).headers['etag']
        samples = []
        projected = []
        original = api._org_view
        def counted(*a, **kw):
            projected.append(1)
            return original(*a, **kw)
        with patch.object(api, '_org_view', side_effect=counted):
            for i in range(args.status_rounds):
                assert free_commit_gb() >= 10
                nid = workers[i % len(workers)]
                status = {'status':'working', 'summary':f'route-{arm}-{i}', 'at':ledger.now()}
                org = store.load_org(slug)
                org.nodes[nid]['last_status'] = status
                org.nodes[nid]['working_activity_at'] = status['at']
                store.save_org(org)
                req = request(tag, transport)
                cpu, wall = time.thread_time_ns(), time.perf_counter_ns()
                reply = api._org_tree_transport(slug, req) if transport else api.org_tree(slug, req, Response())
                wall = (time.perf_counter_ns()-wall)/1e6
                cpu = (time.thread_time_ns()-cpu)/1e6
                assert reply.status_code == 200, (arm, i, reply.status_code)
                wire = json.loads(gzip.decompress(reply.body) if transport else reply.body)
                if transport and 'tree' not in wire:
                    assert wire['nodes'][nid]['set']['last_status'] == status
                else:
                    tree = wire['tree'] if transport else wire
                    assert next(n for n in nodes(tree) if n['id']==nid)['last_status'] == status
                samples.append({'cpu_ms':cpu, 'wall_ms':wall, 'bytes':len(reply.body)})
                tag = reply.headers['etag']
        entry = {'arm':arm, 'route':'delta' if transport else 'legacy', 'count':len(samples),
            'projection_builds':len(projected), 'cpu_ms_mean':sum(x['cpu_ms'] for x in samples)/len(samples),
            'wall_ms_mean':sum(x['wall_ms'] for x in samples)/len(samples),
            'bytes_mean':sum(x['bytes'] for x in samples)/len(samples), 'samples':samples}
        status_rounds.append(entry)
        print(json.dumps({k:v for k,v in entry.items() if k!='samples'}), flush=True)

provenance.write_result(args.output, dict(scope='serial route CPU/bytes only; no HTTP server/lifespan/load',
    modules={m.__name__:m.__file__ for m in (api,store,ledger)}, rows=rows, changes=changes,
    status_rounds=status_rounds,
    fields={k:v.most_common() for k,v in fields.items()},
    top_fields=sorted([(k,len(api._dump_tree({k:v}))) for k,v in before.items() if k!='roots'],key=lambda x:-x[1]),
    node_count=len(all_nodes), audit=audit.snapshot()))
