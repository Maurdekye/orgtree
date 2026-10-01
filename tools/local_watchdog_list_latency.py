"""Latency of `orgtree_watchdog action=list` through `/api/agent` under a
small concurrent load, for the tree this runs in (the checks runner puts the
base's files in place for the base arm). A STRESS PROBE, not fleet load:
THREADS callers each issue CALLS lists back to back, over the SQLite store
and a TestClient, with pause as the managed control.
Usage: local_watchdog_list_latency.py <out.json>"""
import os
from pathlib import Path
import statistics
import sys
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
root = tempfile.TemporaryDirectory(prefix='wd-list-lat-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite')
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
sys.path.insert(0, str(repo))

from unittest.mock import patch  # noqa: E402

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, store, supervisor, toolwait  # noqa: E402

THREADS, CALLS = 8, 25
TOOLS = {'bash': True, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
slug = 'wdlat'
org = store.create_org(slug)
org.hire(ledger.USER, None, 'haiku', 12, 'boss')
names = [f'a{i}' for i in range(THREADS)]
for n in names:
    org.hire('boss', 'boss', 'haiku', 0, n, add_dirs=[], tools=TOOLS,
             org_visibility='self', charter='probe')
for n in names:
    for k in range(3):
        org.watchdog_create(n, f'{n}-d{k}', 'command', 'echo hi', 'hi', 600,
                            False, None, False)
store.save_org(org)
tokens = {n: agentauth.child_env(slug, n)['ORGTREE_AGENT_TOKEN'] for n in names}
saves = []
real_save = toolwait._save


def counting_save(row):
    saves.append(1)
    return real_save(row)


with patch.object(supervisor, 'send_message', return_value={'delivered': True}), \
        patch.object(supervisor, 'mail_spark'), patch.object(api, 'mail_notify'), \
        patch.object(api, 'hub_changed'), patch.object(toolwait, '_save', counting_save):
    client = TestClient(app, raise_server_exceptions=False)
    lat: list = []
    errors: list = []
    lock = threading.Lock()

    def worker(n):
        for _ in range(CALLS):
            t = time.perf_counter()
            r = client.post('/api/agent', json=dict(org=slug, node=n, tool='orgtree_watchdog',
                                                    args={'action': 'list'}),
                            headers={'X-Orgtree-Agent-Token': tokens[n]})
            ms = (time.perf_counter() - t) * 1000
            with lock:
                lat.append(ms)
                if r.status_code != 200 or len(r.json().get('watchdogs') or []) != 3:
                    errors.append((r.status_code, r.text[:200]))

    for n in names[:2]:  # warm-up, not counted
        client.post('/api/agent', json=dict(org=slug, node=n, tool='orgtree_watchdog',
                                             args={'action': 'list'}),
                    headers={'X-Orgtree-Agent-Token': tokens[n]})
    lat.clear()
    saves.clear()
    ts = [threading.Thread(target=worker, args=(n,)) for n in names]
    t0 = time.perf_counter()
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    wall = time.perf_counter() - t0
    client.close()

lat.sort()
q = statistics.quantiles(lat, n=100)
result = {'threads': THREADS, 'calls': len(lat), 'errors': errors[:5], 'error_count': len(errors),
          'journal_saves': len(saves), 'wall_s': round(wall, 2),
          'p50_ms': round(q[49], 1), 'p95_ms': round(q[94], 1), 'max_ms': round(lat[-1], 1),
          'managed_call_present': hasattr(toolwait, 'managed_call')}
print(result, flush=True)
provenance.write_result(Path(sys.argv[1]), result)
