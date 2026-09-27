"""Serial tree bytes/dependency audit on a disposable PG seed; not load evidence."""
import argparse
from collections import Counter
import hashlib
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

def request(etag=None):
    headers = [(b'x-orgtree-desktop-token', b'probe')]
    if etag:
        headers.append((b'if-none-match', etag.encode()))
    return Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': headers, 'state': {}})

def read(name, etag=None):
    assert free_commit_gb() >= 10
    wall, cpu = time.perf_counter(), time.thread_time()
    reply = api.org_tree(slug, request(etag), Response())
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
    before, initial = after, after_reply
    read(name+'_repeat', initial.headers['etag'])

provenance.write_result(args.output, dict(scope='serial route CPU/bytes only; no HTTP server/lifespan/load',
    modules={m.__name__:m.__file__ for m in (api,store,ledger)}, rows=rows, changes=changes,
    fields={k:v.most_common() for k,v in fields.items()},
    top_fields=sorted([(k,len(api._dump_tree({k:v}))) for k,v in before.items() if k!='roots'],key=lambda x:-x[1]),
    node_count=len(all_nodes), audit=audit.snapshot()))
