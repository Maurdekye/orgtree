"""Owned probe: what does GET /nodes/{n}/chat?last=8 read from PG, statement by statement?

Seeds the rows-preflight org (seed.py + prepare_steady.py, same arguments) on a
private PG under a new C:/Temp/chat-probe-* root, then calls api.node_chat in a
child interpreter with a per-statement psycopg tracer. Each statement is tagged
with the phase that issued it (load_org, read_chat, rest). Analysis only.
Usage: chat_read_probe.py --root C:/Temp/chat-probe-<x> [--agents 10]
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


def child(root):
    from assert_repo_import import assert_repo_import
    prov = assert_repo_import(REPO)
    desc = json.loads((root / 'scale-descriptor.json').read_text(encoding='utf-8'))
    from engine.launch import load_app
    load_app()
    import psycopg
    from orgtree import api, store, supervisor
    phase = ['setup']
    stmts = []
    last = {}
    orig_exec = psycopg.Cursor.execute

    def value_bytes(v):
        if v is None:
            return 0
        if isinstance(v, bytes):
            return len(v)
        if isinstance(v, str):
            return len(v.encode('utf-8'))
        return len(json.dumps(v, default=str).encode('utf-8'))

    def execute(self, query, params=None, *a, **k):
        if not isinstance(query, (str, bytes)):
            query = query.as_string(self.connection)
        if isinstance(query, bytes):
            query = query.decode('utf-8')
        rec = dict(phase=phase[0], sql=' '.join(query.split())[:220], rows=0, bytes=0,
                   params=[str(p)[:60] for p in (params or ())][:4] if isinstance(params, (list, tuple)) else None)
        stmts.append(rec)
        last[id(self)] = rec
        return orig_exec(self, query, params, *a, **k)

    def wrap_fetch(name):
        orig = getattr(psycopg.Cursor, name)

        def fetch(self, *a, **k):
            out = orig(self, *a, **k)
            rec = last.get(id(self))
            if rec is not None:
                rows = ([out] if out is not None else []) if name in ('fetchone', '__next__') else out
                rec['rows'] += len(rows)
                rec['bytes'] += sum(sum(value_bytes(v) for v in row) for row in rows)
            return out
        setattr(psycopg.Cursor, name, fetch)
    psycopg.Cursor.execute = execute
    for name in ('fetchone', 'fetchmany', 'fetchall', '__next__'):
        wrap_fetch(name)

    def tagged(fn, name):
        def inner(*a, **k):
            prev = phase[0]
            phase[0] = name
            try:
                return fn(*a, **k)
            finally:
                phase[0] = prev
        return inner
    store.load_org = tagged(store.load_org, 'load_org')
    supervisor.read_chat = tagged(supervisor.read_chat, 'read_chat')
    slug = desc['org']
    target = sorted(desc['live_agents'])[0]
    runs = {}
    for label in ('warm-up', 'measured'):
        stmts.clear()
        phase[0] = 'rest'
        out = api.node_chat(slug, target, None, 8)
        runs[label] = dict(statements=len(stmts), rows=sum(s['rows'] for s in stmts),
                           bytes=sum(s['bytes'] for s in stmts), messages=len(out.get('messages') or []))
    by = collections.OrderedDict()
    for s in stmts:
        key = (s['phase'], re.sub(r"'[^']*'", "'?'", s['sql']))
        agg = by.setdefault(key, dict(phase=s['phase'], sql=key[1], n=0, rows=0, bytes=0, params=s['params']))
        agg['n'] += 1; agg['rows'] += s['rows']; agg['bytes'] += s['bytes']
    phases = collections.Counter()
    for s in stmts:
        phases[s['phase'] + ':rows'] += s['rows']; phases[s['phase'] + ':bytes'] += s['bytes']
        phases[s['phase'] + ':statements'] += 1
    # what does the org hold that is big? the largest value rows, by table/key
    import psycopg as pg
    sizes = {}
    with pg.connect(os.environ['ORGTREE_PG_URL']) as conn:
        schemas = [r[0] for r in conn.execute("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'org\\_%'")]
        for sch in schemas:
            for table, keycol in (('doc', 'key'), ('nodes', 'id'), ('log_d', 'sect'), ('log_l', 'sect')):
                try:
                    rows = conn.execute(f"SELECT {keycol}, count(*), sum(octet_length(val)) FROM {sch}.{table} "
                                        f"GROUP BY {keycol} ORDER BY 3 DESC NULLS LAST LIMIT 8").fetchall()
                except Exception as e:
                    conn.rollback(); rows = [('error', 0, str(e)[:80])]
                sizes[f'{sch}.{table}'] = [(str(r[0])[:60], r[1], r[2]) for r in rows]
    result = dict(org=slug, node=target, runs=runs, phases=dict(phases),
                  statements=sorted(by.values(), key=lambda a: -a['bytes']), table_sizes=sizes)
    prov.write_result(root / 'chat-probe.json', result)
    print(json.dumps(dict(runs=runs, phases=dict(phases)), indent=1), flush=True)


def main(args):
    root = args.root.resolve()
    if root.exists() or root.parent != Path('C:/Temp').resolve() or not root.name.startswith('chat-probe-'):
        raise ValueError('new owned C:/Temp/chat-probe-* root required')
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
    stopped = None
    try:
        admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
        seed = root / 'seed'
        py = sys.executable
        for script, extra in (('seed.py', ['--agents', str(args.agents), '--active-items', '20', '--archived-per-live', '0',
                                           '--archived-items-per-live', '0', '--transcript-kb', '1', '--seed', '1',
                                           '--admin-url', admin, '--min-free-commit-gb', '12', '--no-profile-item']),
                              ('prepare_steady.py', ['--seconds', '.25', '--output-bytes', '256'])):
            with (root / (script + '.log')).open('w', encoding='utf-8') as log:
                subprocess.run([py, '-I', '-B', str(REPO / 'tools/scale' / script), '--root', str(seed), *extra],
                               cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=600, check=True)
        desc = json.loads((seed / 'scale-descriptor.json').read_text(encoding='utf-8'))
        from seed import child_env
        env = child_env(seed, desc['pg_url'])
        with (root / 'child.log').open('w', encoding='utf-8') as log:
            subprocess.run([py, '-I', '-B', __file__, '--child', '--root', str(seed)], cwd=REPO, env=env,
                           stdout=log, stderr=subprocess.STDOUT, timeout=600, check=True)
    finally:
        stopped = pg('stop')
        (root / 'pg-stop.json').write_text(json.dumps(stopped, indent=1), encoding='utf-8')
        print('pg stop ok', stopped.get('ok'), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--agents', type=int, default=10)
    parser.add_argument('--child', action='store_true')
    a = parser.parse_args()
    child(a.root.resolve()) if a.child else main(a)
