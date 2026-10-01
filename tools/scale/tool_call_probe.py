"""Owned probe: what does one agent tool call read from PG, statement by statement?

N1000 attempt 7b (#3): orgtree_message, orgtree_send_notice, orgtree_work
update and orgtree_watchdog list each ran 65-73 statements and read about
1.1-1.2 MB. This probe seeds the rows-preflight org (seed.py + prepare_steady.py)
on a private PG under a new C:/Temp/tool-probe-* root ONCE, then, for each
--tree given, runs a child interpreter that imports THAT checkout (import
provenance checked) and POSTs the four calls to /api/agent through the real
app with a per-statement psycopg tracer. Each call runs once to warm up and
then --reps times measured; the result names statements, rows and value bytes
per call and the heaviest statements of the last measured run.

Same fixture for every tree, so a base/tip pair compares like with like
(each tree's calls add a few rows of mail; the order is recorded).
Analysis only. Usage:
  tool_call_probe.py --root C:/Temp/tool-probe-<x> --agents 100 --tree <base> --tree <tip>
"""
import argparse
import collections
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))
sys.path.insert(0, str(REPO / 'tools/scale'))
TOOL = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
PGBIN = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
CALLS = ('message', 'send_notice', 'work_update', 'watchdog_list')


def value_bytes(v):
    if v is None:
        return 0
    if isinstance(v, bytes):
        return len(v)
    if isinstance(v, str):
        return len(v.encode('utf-8'))
    return len(json.dumps(v, default=str).encode('utf-8'))


def _who():
    """The innermost orgtree frames outside the storage layer: who asked."""
    import traceback
    frames = [f for f in traceback.extract_stack()[:-2]
              if os.path.basename(os.path.dirname(f.filename)) == 'orgtree'
              and os.path.basename(f.filename) not in ('pgstore.py',)]
    return ' < '.join(f'{os.path.basename(f.filename)}:{f.lineno}:{f.name}' for f in reversed(frames[-10:]))


def child(root, tree, out):
    sys.path.insert(0, str(tree / 'tools'))
    from assert_repo_import import assert_repo_import
    prov = assert_repo_import(tree)
    desc = json.loads((root / 'scale-descriptor.json').read_text(encoding='utf-8'))
    desk = os.environ['ORGTREE_V2_TOKEN']   # read before the app consumes it
    from engine.launch import load_app
    load_app()
    import psycopg
    from starlette.testclient import TestClient
    from orgtree import agentauth, api, store
    import contextvars
    stmts = []
    last = {}
    orig_exec = psycopg.Cursor.execute
    # only statements issued inside the measured request count -- the same
    # contextvar rule as sql_counts.Boundary (background turns keep running)
    inside = contextvars.ContextVar('tool_probe_inside', default=False)

    async def measured_app(scope, receive, send):
        tok = inside.set(True)
        try:
            await api.app(scope, receive, send)
        finally:
            inside.reset(tok)

    def execute(self, query, params=None, *a, **k):
        if not inside.get():
            last.pop(id(self), None)
            return orig_exec(self, query, params, *a, **k)
        if not isinstance(query, (str, bytes)):
            query = query.as_string(self.connection)
        if isinstance(query, bytes):
            query = query.decode('utf-8')
        rec = dict(sql=' '.join(query.split())[:220], rows=0, bytes=0, who=_who())
        stmts.append(rec)
        last[id(self)] = rec
        return orig_exec(self, query, params, *a, **k)

    def wrap_fetch(name):
        orig = getattr(psycopg.Cursor, name)

        def fetch(self, *a, **k):
            res = orig(self, *a, **k)
            rec = last.get(id(self))
            if rec is not None:
                rows = ([res] if res is not None else []) if name in ('fetchone', '__next__') else res
                rec['rows'] += len(rows)
                rec['bytes'] += sum(sum(value_bytes(v) for v in row) for row in rows)
            return res
        setattr(psycopg.Cursor, name, fetch)
    psycopg.Cursor.execute = execute
    for name in ('fetchone', 'fetchmany', 'fetchall', '__next__'):
        wrap_fetch(name)

    slug = desc['org']
    org = store.load_org(slug)
    live = sorted(n for n, v in org.nodes.items() if v.get('state') == 'live')
    parents = {n: org.nodes[n].get('parent') for n in live}
    target = live[0]
    actor = parents.get(target) or next(n for n in live if parents.get(n) == target)
    client = TestClient(measured_app, raise_server_exceptions=True)

    def token(nid):
        return agentauth.node_env(slug, nid, store.load_org(slug).nodes[nid])['ORGTREE_AGENT_TOKEN']

    def call(nid, tool, args):
        r = client.post('/api/agent', json=dict(org=slug, node=nid, tool=tool, args=args),
                        headers={'X-Orgtree-Desktop-Token': desk, 'X-Orgtree-Agent-Token': token(nid)})
        if r.status_code != 200:
            raise RuntimeError(f'{tool} {args} -> {r.status_code} {r.text[:400]}')
        return r.json()

    # an item the actor may update: the first live agent owning an active item
    worker, item = None, None
    for nid in live:
        got = call(nid, 'orgtree_work', dict(action='list', fields=['slug', 'owner']))
        for it in got.get('items') or []:
            owner = it.get('owner') or {}
            if (owner.get('node') if isinstance(owner, dict) else owner) == nid:
                worker, item = nid, it['slug']
                break
        if item:
            break
    if not item:
        raise RuntimeError('no live agent owns an active item')
    plan = {
        'message': (actor, 'orgtree_message', dict(to=target, kind='message', body='[tool-probe] message.')),
        'send_notice': (actor, 'orgtree_send_notice', dict(to=target, body='[tool-probe] notice.')),
        'work_update': (worker, 'orgtree_work', dict(action='update', slug=item, status='in_progress',
                                                    done_so_far=['[tool-probe] step'],
                                                    working_on_next=['[tool-probe] next'])),
        'watchdog_list': (actor, 'orgtree_watchdog', dict(action='list')),
    }
    result = dict(org=slug, agents=len(live), actor=actor, target=target, worker=worker, item=item,
                  tree=str(tree), calls={})
    for label in CALLS:
        nid, tool, args = plan[label]
        token(nid)                      # mint outside the measured window
        call(nid, tool, args)           # warm-up
        runs = []
        for _ in range(REPS):
            tok = token(nid)
            stmts.clear()
            r = client.post('/api/agent', json=dict(org=slug, node=nid, tool=tool, args=args),
                            headers={'X-Orgtree-Desktop-Token': desk, 'X-Orgtree-Agent-Token': tok})
            if r.status_code != 200:
                raise RuntimeError(f'{label} -> {r.status_code} {r.text[:400]}')
            runs.append(dict(statements=len(stmts), rows=sum(s['rows'] for s in stmts),
                             bytes=sum(s['bytes'] for s in stmts)))
        by = collections.OrderedDict()
        for s in stmts:
            key = re.sub(r"'[^']*'", "'?'", s['sql'])
            agg = by.setdefault(key, dict(sql=key, n=0, rows=0, bytes=0))
            agg['n'] += 1; agg['rows'] += s['rows']; agg['bytes'] += s['bytes']
        whos = collections.Counter()
        for s in stmts:
            whos[s['who']] += 1
        result['calls'][label] = dict(runs=runs, top=sorted(by.values(), key=lambda a: (-a['bytes'], -a['n']))[:25],
                                      callers=whos.most_common(40),
                                      sequence=[(s['sql'][:90], s['rows'], s['bytes'], s['who']) for s in stmts])
        print(label, runs, flush=True)
    prov.write_result(out, result)


REPS = 3


def main(args):
    root = args.root.resolve()
    if root.exists() or root.parent != Path('C:/Temp').resolve() or not root.name.startswith('tool-probe-'):
        raise ValueError('new owned C:/Temp/tool-probe-* root required')
    root.mkdir()
    pgroot = root / 'pg'

    def pg(action):
        cp = subprocess.run([TOOL, action, '--root', str(pgroot), '--pg-bin', PGBIN],
                            capture_output=True, text=True, timeout=60)
        if cp.returncode:
            raise RuntimeError(action + ': ' + cp.stdout + cp.stderr)
        return json.loads(cp.stdout)
    from control import free_commit_gb
    if free_commit_gb() < 12:
        raise RuntimeError('free commit below 12 GiB')
    pg('init-root'); pg('init'); pg('start')
    try:
        admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
        seed = root / 'seed'
        py = sys.executable
        for script, extra in (('seed.py', ['--agents', str(args.agents), '--active-items', str(args.items),
                                           '--archived-per-live', '0', '--archived-items-per-live', '0',
                                           '--transcript-kb', '1', '--seed', '1', '--admin-url', admin,
                                           '--min-free-commit-gb', '12', '--no-profile-item']),
                              ('prepare_steady.py', ['--seconds', '.25', '--output-bytes', '256'])):
            with (root / (script + '.log')).open('w', encoding='utf-8') as log:
                subprocess.run([py, '-I', '-B', str(REPO / 'tools/scale' / script), '--root', str(seed), *extra],
                               cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=True)
        desc = json.loads((seed / 'scale-descriptor.json').read_text(encoding='utf-8'))
        from seed import child_env
        env = child_env(seed, desc['pg_url'])
        for i, tree in enumerate(args.tree):
            tree = tree.resolve()
            out = root / f'tool-probe-{i}-{tree.name}.json'
            with (root / f'child-{i}.log').open('w', encoding='utf-8') as log:
                subprocess.run([py, '-I', '-B', __file__, '--child', '--root', str(seed), '--tree', str(tree),
                                '--out', str(out)], cwd=tree, env=env,
                               stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=True)
            print('wrote', out, flush=True)
    finally:
        stopped = pg('stop')
        (root / 'pg-stop.json').write_text(json.dumps(stopped, indent=1), encoding='utf-8')
        print('pg stop ok', stopped.get('ok'), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--agents', type=int, default=100)
    parser.add_argument('--items', type=int, default=180)
    parser.add_argument('--tree', type=Path, action='append', default=[])
    parser.add_argument('--out', type=Path)
    parser.add_argument('--child', action='store_true')
    a = parser.parse_args()
    if a.child:
        child(a.root.resolve(), a.tree[0].resolve(), a.out)
    else:
        main(a)
