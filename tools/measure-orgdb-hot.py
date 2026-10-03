"""Measure hot operations on matching DISPOSABLE legacy and orgdb copies.

Run under tools/p03-run.ps1 -Agent <agent> -Wait. Restore the authorized dump
into a template on that agent's private custodian cluster first. Supply URLs
only through ORGTREE_TEST_PG_ADMIN_URL / ORGTREE_TEST_PG_RUNTIME_URL.
See tools/measure-orgdb-hot.md for boundaries and the launch recipe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
sys.path.insert(0, str(REPO / 'engine' / 'backend'))
sys.path.insert(0, str(REPO / 'tools' / 'scale'))
from assert_repo_import import assert_repo_import

PROVENANCE = assert_repo_import(str(REPO))
READS = {
    'org_list': 'store.list_orgs()',
    'tree': 'api.org_tree; warm 200 response, no conditional header',
    'foreground': 'foreground_api.read; selected include IDs, warm 200 response',
    'agent_newest8': 'foreground_store.read_exact; selected agent body, newest 8 turns',
    'identity': 'identity_context.load; selected per-turn identity neighbourhood',
    'inbox': 'store.read_node_inbox; keep=80, slack=40',
    'history': 'store.read_node_history_rows; cap=80 per source',
    'gallery': 'store.read_document_gallery; all gallery metadata',
    'document_window': 'foreground_store.read_card_windows; one selected agent',
    'docket_list': 'worklist.foreground; fallback Org.work_list, active only',
    'docket_get': 'workdetail.get; fallback Org.work_get, full item by slug',
    'docket_counts': 'workread.counts_raw; fallback Org.work_counts',
}
WRITES = {
    'title': 'one-node org_tx, changed title through COMMIT',
    'settings': 'settings org_tx, changed max_children through COMMIT',
    'move': 'operator move coordinator-opus under coordinator-astra-2',
    'insert_above': 'operator hire above coordinator-opus (large subtree)',
    'subjugate': 'coordinator-opus orgtree_self_subjugate to coordinator-astra-2',
    'swap': 'coordinator-opus orgtree_swap coordinator-astra-2 and review-sol',
}


class ChildFailure(RuntimeError):
    def __init__(self, detail):
        super().__init__('isolated child failed')
        self.detail = detail


def error_detail(error):
    return {'error': type(error).__name__, 'frames': [
        {'function': f.name, 'line': f.lineno, 'file': Path(f.filename).name}
        for f in traceback.extract_tb(error.__traceback__)]}


def with_db(url, db):
    from psycopg.conninfo import make_conninfo
    return make_conninfo(url, dbname=db)


def private_cluster(admin, runtime, agent, cluster_root):
    """Refuse before any write unless both URLs name this agent's dev cluster."""
    import psycopg
    from psycopg.conninfo import conninfo_to_dict
    if not re.fullmatch(r'[a-z][a-z0-9-]+', agent):
        raise ValueError('invalid agent name')
    expected = cluster_root.resolve() / agent
    for url in (admin, runtime):
        info = conninfo_to_dict(url)
        if info.get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('the benchmark requires a loopback dev cluster')
        # Ask as admin but aim at each URL's host/port; never infer from its label.
        from psycopg.conninfo import make_conninfo
        target = make_conninfo(admin, host=info['host'], port=info.get('port', '5432'))
        with psycopg.connect(target, autocommit=True) as c:
            actual = Path(c.execute('SHOW data_directory').fetchone()[0]).resolve()
            if actual != expected and expected not in actual.parents:
                raise ValueError('database is outside this agent\'s disposable cluster')
    if conninfo_to_dict(runtime).get('user') != 'orgtree_runtime':
        raise ValueError('measurements must use the runtime role')
    return str(expected)


def require_lock(agent, lock_root):
    import psutil
    holder = json.loads((lock_root / 'holder.json').read_text(encoding='utf-8-sig'))
    ancestors = {p.pid for p in psutil.Process().parents()}
    if holder.get('agent') != agent or holder.get('small') or holder.get('pid') not in ancestors:
        raise ValueError('run inside this agent\'s P03 heavy wrapper')


def clean_environment(root):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
        ('ORGTREE_', 'OPENAI_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'GEMINI_',
         'GOOGLE_API', 'PYTHON', 'ADMIN', 'RUNTIME'))}
    for part in ('home', 'temp', 'data/orgs', 'metrics'):
        (root / part).mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(root / 'home'), USERPROFILE=str(root / 'home'),
               APPDATA=str(root / 'home'), LOCALAPPDATA=str(root / 'home'),
               TEMP=str(root / 'temp'), TMP=str(root / 'temp'),
               ORGTREE_DATA=str(root / 'data'), ORGTREE_STORE='postgres',
               ORGTREE_V2_TOKEN='hot-benchmark-only', ORGTREE_WARM='0',
               ORGTREE_LOCAL_HUB_ADDRESS='http://127.0.0.1:9',
               PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
    return env


def digest(admin, db):
    """Counts/checksums only: no real row body enters an output artifact."""
    import psycopg
    from psycopg import sql
    values = {}
    with psycopg.connect(with_db(admin, db)) as c:
        for schema, table in c.execute("SELECT table_schema,table_name FROM information_schema.tables "
                "WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') "
                'ORDER BY 1,2'):
            statement = sql.SQL("SELECT count(*), md5(coalesce(string_agg(md5(t::text), '' "
                "ORDER BY md5(t::text)), '')) FROM {}.{} t").format(sql.Identifier(schema), sql.Identifier(table))
            values[f'{schema}.{table}'] = list(c.execute(statement).fetchone())
    return values


def call_child(config, root, env, result_name):
    # Config contains secrets; deliver through stdin, never argv, logs or files.
    result = root / result_name
    config = dict(config, result=str(result))
    got = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--child'],
                         input=json.dumps(config), text=True, encoding='utf-8', env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1100)
    if got.returncode:
        safe = next((json.loads(line[len('HOT_ERROR='):]) for line in got.stderr.splitlines()
                     if line.startswith('HOT_ERROR=')), {'error':'ChildExited'})
        raise ChildFailure(dict(phase=config['phase'], side=config.get('side'), **safe))
    return json.loads(result.read_text(encoding='utf-8'))


def drop_groups(admin, prefixes):
    """Only unguessable prefixes generated by this invocation can be dropped."""
    import psycopg
    from psycopg import sql
    if any(not re.fullmatch(r'hot[0-9a-f]{12}_', p) for p in prefixes):
        raise ValueError('invalid owned database prefix')
    errors, remaining = [], []
    try:
        with psycopg.connect(admin, autocommit=True) as c:
            names = [r[0] for r in c.execute('SELECT datname FROM pg_database')]
            for db in names:
                if any(db.startswith(p) for p in prefixes):
                    try:
                        c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))
                    except Exception as e:
                        errors.append(type(e).__name__)
            remaining = [r[0] for r in c.execute('SELECT datname FROM pg_database')
                         if any(r[0].startswith(p) for p in prefixes)]
    except Exception as e:
        errors.append(type(e).__name__)
    return remaining, errors


def summarize(rows, runs):
    out = []
    for operation in [*READS, *WRITES]:
        sides = {}
        for side in ('legacy', 'native'):
            subset = [r for r in rows if r['operation'] == operation and r['side'] == side]
            if subset:
                good = [r['ms'] for r in subset if r.get('ok')]
                complete = len(good) == runs
                sides[side] = {'samples': subset, 'completed': len(good),
                    'median_ms': statistics.median(good) if complete else None,
                    'path': subset[0]['path']}
        if not sides:
            continue
        before, after = (sides.get(s, {}).get('median_ms') for s in ('legacy', 'native'))
        out.append({'operation': operation, 'boundary': (READS | WRITES)[operation], 'sides': sides,
                    'ratio_native_over_legacy': after / before if before and after is not None else None})
    return out


def markdown(report):
    lines = ['# Legacy / orgdb hot operations', '',
        f"Commit: `{report['commit']}`. Org: `{report['org']}`. Agents: " + ', '.join(report['agents']) + '.',
        f"Warm medians of {report['runs']} runs; {report['warmups']} excluded read warm-ups.",
        'Each write has a fresh matching clone, an excluded reallocate/cached-org warm-up, and excluded setup steps.',
        'Wall-clock synchronous function boundaries include database queries, decoding and commits; no HTTP network transit.',
        'Ratios above 1 mean the native side was slower. Missing medians mean incomplete or failed samples.', '',
        '| Operation | Legacy ms | Native ms | Native / legacy | Native path |',
        '|---|---:|---:|---:|---|']
    if report.get('failure'):
        lines.insert(2, '**Run failed: these timings are incomplete and are not acceptance evidence.**')
    for row in report['table']:
        def cell(side):
            value = row['sides'].get(side, {}).get('median_ms')
            return f'{value:.3f}' if value is not None else 'failed / incomplete'
        ratio = row['ratio_native_over_legacy']
        lines.append(f"| {row['operation']} | {cell('legacy')} | {cell('native')} | "
                     f"{f'{ratio:.2f}' if ratio is not None else '—'} | {row['sides'].get('native', {}).get('path', '—')} |")
    lines.extend(['', '## Timed boundaries', ''])
    lines.extend(f"- **{r['operation']}**: {r['boundary']}." for r in report['table'])
    lines.extend(['', 'Setup/conversion/reset timings, sample status, import provenance and source checksums are in the JSON.',
                  f"Cleanup verified: {report['cleanup_ok']}. Source unchanged: {report['source_unchanged']}.", ''])
    return '\n'.join(lines)


def parent(a):
    import psycopg
    from psycopg import sql
    repo_root = REPO.parents[1] if REPO.parent.name == '.worktrees' else REPO
    require_lock(a.agent, repo_root / 'artifacts' / 'machine-test-run')
    admin, runtime = (os.environ[k] for k in ('ORGTREE_TEST_PG_ADMIN_URL', 'ORGTREE_TEST_PG_RUNTIME_URL'))
    cluster = private_cluster(admin, runtime, a.agent, repo_root / 'artifacts' / 'p03-db')
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', a.template) or a.template in ('postgres', 'orgtree'):
        raise ValueError('use a disposable restored template name')
    selected = a.operations.split(',') if a.operations else [*READS, *WRITES]
    if set(selected) - set(READS) - set(WRITES):
        raise ValueError('unknown operation')
    root = Path(tempfile.mkdtemp(prefix='orgdb-hot-'))
    prefixes, rows, setups = [], [], []
    report = dict(commit=PROVENANCE.commit, import_provenance=PROVENANCE.as_dict(),
                  org=a.org, agents=a.agents.split(','), runs=a.runs, warmups=a.warmups,
                  measured_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  source_template=a.template, disposable_cluster=cluster, table=[], setup=[],
                  source_unchanged=False, cleanup_ok=False, failure=None)
    before = digest(admin, a.template)
    report['source_inventory'] = before
    try:
        groups = [('reads', [op for op in selected if op in READS], 0)]
        groups += [(op, [op], n) for op in selected if op in WRITES for n in range(a.runs)]
        for label, operations, iteration in groups:
            if not operations:
                continue
            prefix = 'hot' + uuid.uuid4().hex[:12] + '_'
            with psycopg.connect(admin, autocommit=True) as c:
                if c.execute('SELECT 1 FROM pg_database WHERE starts_with(datname,%s)', (prefix,)).fetchone():
                    raise RuntimeError('random database prefix already exists')
            prefixes.append(prefix)
            group_root = root / prefix
            env = clean_environment(group_root)
            legacy = prefix + 'legacy'
            env.update(ORGTREE_PG_URL=with_db(runtime, legacy), ORGTREE_ORGDB_PREFIX=prefix)
            t = time.perf_counter()
            with psycopg.connect(admin, autocommit=True) as c:
                c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE {}').format(sql.Identifier(legacy), sql.Identifier(a.template)))
                c.execute(sql.SQL('ALTER DATABASE {} SET default_transaction_read_only=on').format(sql.Identifier(legacy)))
                c.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO orgtree_runtime').format(sql.Identifier(legacy)))
            with psycopg.connect(with_db(admin, legacy)) as c:
                for org_id, slug in c.execute('SELECT org_id,slug FROM public.orgs WHERE deleted_at IS NULL'):
                    (group_root / 'data/orgs' / f'{slug}.pg').write_text(
                        json.dumps({'org_id': org_id, 'slug': slug}), encoding='utf-8')
            cfg = dict(admin=admin, runtime=with_db(runtime, legacy), root=str(group_root), prefix=prefix,
                       org=a.org, agents=a.agents.split(','), operations=operations,
                       runs=a.runs if label == 'reads' else 1, warmups=a.warmups, iteration=iteration)
            cloned_inventory = digest(admin, legacy)
            if cloned_inventory != before:
                raise RuntimeError('clone does not match the source inventory')
            started = call_child(dict(cfg, phase='start'), group_root, env, 'start.json')
            if digest(admin, legacy) != cloned_inventory:
                raise RuntimeError('startup changed the read-only legacy clone')
            setups.append(dict(group=label, iteration=iteration, clone_and_conversion_ms=(time.perf_counter()-t)*1000,
                               conversion=started))
            # A native write must not change the legacy comparison input.
            original = digest(admin, legacy)
            order = ('legacy', 'native') if iteration % 2 == 0 else ('native', 'legacy')
            for side in order:
                side_env = dict(env)
                if side == 'native':
                    side_env['ORGTREE_STORAGE'] = 'orgdb'
                elif label != 'reads':
                    with psycopg.connect(admin, autocommit=True) as c:
                        c.execute(sql.SQL('ALTER DATABASE {} SET default_transaction_read_only=off').format(sql.Identifier(legacy)))
                got = call_child(dict(cfg, phase='measure', side=side), group_root, side_env, side+'.json')
                rows.extend(got['rows'])
                setups[-1][side+'_warmup_ms'] = got['warmup_ms']
                setups[-1][side+'_source_hash'] = got['source_hash']
                setups[-1][side+'_import_provenance'] = got['import_provenance']
                setups[-1][side+'_process_audit'] = got['refused_launches']
                print(f'{label} {iteration+1}: {side} samples complete', flush=True)
            if setups[-1]['legacy_source_hash'] != setups[-1]['native_source_hash']:
                raise RuntimeError('legacy/native starting documents differ')
            if label == 'reads' and original != digest(admin, legacy):
                raise RuntimeError('read-only comparison source changed')
            remaining, errors = drop_groups(admin, [prefix])
            if remaining or errors:
                raise RuntimeError('group cleanup failed')
    except Exception as e:
        report['failure'] = type(e).__name__  # Never echo connection strings or real row content.
        report['failure_detail'] = e.detail if isinstance(e, ChildFailure) else error_detail(e)
    finally:
        try:
            report['source_unchanged'] = before == digest(admin, a.template)
        except Exception as e:
            report['failure'] = type(e).__name__
        remaining, cleanup_errors = drop_groups(admin, prefixes)
        report['cleanup_ok'] = not remaining and not cleanup_errors
        report['owned_prefixes'], report['remaining_databases'] = prefixes, remaining
        report['cleanup_errors'] = cleanup_errors
        shutil.rmtree(root)
        report['setup'], report['table'] = setups, summarize(rows, a.runs)
        a.output.parent.mkdir(parents=True, exist_ok=True)
        a.output.with_suffix('.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        a.output.with_suffix('.md').write_text(markdown(report), encoding='utf-8')
    return 0 if (not report['failure'] and report['cleanup_ok'] and report['source_unchanged']
        and all(s['completed'] == a.runs for r in report['table'] for s in r['sides'].values())) else 1


def child():
    cfg = json.load(sys.stdin)
    from orgtree.orgdb import lifecycle, registry
    lc = lifecycle.Lifecycle(admin=cfg.pop('admin'), prefix=cfg['prefix'], build='hot-measure')
    result = Path(cfg['result'])
    if cfg['phase'] == 'start':
        from orgtree.orgdb import startup
        t = time.perf_counter()
        lc.bootstrap()
        started = startup.start(lc=lc, runtime=cfg['runtime'], data_root=os.environ['ORGTREE_DATA'],
                                env=dict(os.environ), build='hot-measure')
        if not started['first_pass']['ran'] or any(r['state'] != 'active' for r in lc.rows()):
            raise RuntimeError('not every source org converted successfully')
        out = dict(start_ms=(time.perf_counter()-t)*1000, active_orgs=len(lc.rows()),
                   import_provenance=PROVENANCE.as_dict())
    else:
        # Register an in-process lifecycle without carrying admin into the engine environment.
        if cfg['side'] == 'native':
            lc.bootstrap()
            registry.use_lifecycle(lc)
        from launch_guard import LaunchAudit, pin_git
        # Production view code reads build identity. The shared guard permits
        # only its fixed read-only Git argument forms, never arbitrary Git.
        git = shutil.which('git')
        subprocess.Popen = pin_git(subprocess.Popen, git)
        audit = LaunchAudit(Path(cfg['root']), git=git, providers=[])
        sys.addaudithook(audit)
        from orgtree import api, foreground_api, foreground_store, identity_context, orgtx, store
        from orgtree import worklist, workdetail, workread
        from orgtree.ledger import USER
        from starlette.requests import Request
        slug, ids = cfg['org'], cfg['agents']
        if Path(store.DATA_ROOT).resolve() != Path(cfg['root']).resolve() / 'data':
            raise RuntimeError('engine data root escaped the benchmark')
        # Discover only metadata used as a workload key; never emit authored titles/bodies.
        from urllib.parse import urlencode
        request = Request({'type':'http', 'method':'GET', 'path':'/', 'headers':[],
                           'query_string':urlencode([('include', n) for n in ids]).encode()})
        org = store.load_org(slug)
        from orgtree.orgdb import mappers
        from orgtree.orgdb.convert.run import canon
        document = json.loads(json.dumps(org.d))
        source_hash = hashlib.sha256(canon({k:v for k,v in document.items()
            if k not in set(mappers.ignored_keys())}).encode('utf-8')).hexdigest()
        del document
        for nid in ids:
            org.node(nid)
        work = org.work_list(USER)
        item = next((it['slug'] for it in work.get('items', []) if it.get('slug')), None)
        native_docket = (REPO / 'engine/backend/orgtree/orgdb/docket.py').exists()

        def counts():
            if cfg['side'] == 'native' and not native_docket:
                return store.load_org(slug).work_counts()
            got = foreground_store.read_snapshot(slug, lambda raw, stamp: workread.counts_raw(
                raw, stamp['org_id'], viewer=USER, now_ts=time.time()))
            return got if got is not None else store.load_org(slug).work_counts()

        def docket_list():
            if cfg['side'] == 'native' and not native_docket:
                return store.load_org(slug).work_list(USER)
            got = worklist.foreground(slug)
            return got if got is not None else store.load_org(slug).work_list(USER)

        def docket_get():
            if item is None:
                raise ValueError('no current docket item in selected org')
            if cfg['side'] == 'native' and not native_docket:
                return store.load_org(slug).work_get(USER, item)
            got = workdetail.get(slug, USER, item)
            return got if got is not None else store.load_org(slug).work_get(USER, item)

        reads = dict(org_list=store.list_orgs, tree=lambda:api.org_tree(slug, request),
            foreground=lambda:foreground_api.read(slug, request),
            agent_newest8=lambda:foreground_store.read_exact(slug, ids[0]),
            identity=lambda:identity_context.load(slug, ids[0]),
            inbox=lambda:store.read_node_inbox(slug, ids[0], 80),
            history=lambda:store.read_node_history_rows(slug, ids[0], 80),
            gallery=lambda:store.read_document_gallery(slug),
            document_window=lambda:foreground_store.read_snapshot(slug,
                lambda raw, stamp:foreground_store.read_card_windows(raw, ids[:1])),
            docket_list=docket_list, docket_get=docket_get, docket_counts=counts)

        def op(**fields):
            return api._op_door(slug, api.Op(**fields), True, None)

        def agent(tool, **args):
            return api._agent_door(api.AgentCall(org=slug, node='coordinator-opus', tool=tool, args=args),
                dict(args), {'harness':None,'archive_warnings':[],'renamed_to':None,'rename_warnings':[],
                             'claim_commit':None})

        def title():
            with orgtx.org_tx(slug, nodes=ids[:1]) as tx:
                tx.d['nodes'][ids[0]]['title'] = 'hot operation measurement'

        def settings():
            with orgtx.org_tx(slug, nodes=[], sections=['settings']) as tx:
                tx.d['max_children'] = int(tx.d.get('max_children') or 0)+1

        writes = dict(title=title, settings=settings,
            move=lambda:op(op='move', node='coordinator-opus', new_parent='coordinator-astra-2'),
            insert_above=lambda:op(op='hire', parent=None, above='coordinator-opus', name='hot-above',
                tier='opus',grant=0,charter='benchmark',add_dirs=[],
                tools={'bash':False,'web':False,'edit':False,'subagents':False,'mcp':[]},org_visibility='team'),
            subjugate=lambda:agent('orgtree_self_subjugate', target='coordinator-astra-2'),
            swap=lambda:agent('orgtree_swap', a='coordinator-astra-2', b='review-sol'))
        rows, warmup_ms = [], {}
        for operation in cfg['operations']:
            try:
                t = time.perf_counter()
                if operation in WRITES:
                    # Exactly mkplans2.py's excluded warm-up, before any reshape setup.
                    api.provider_hire_gate = lambda *args, **kwargs: None
                    op(op='reallocate', node='review-sol', delta=1)
                    store.cached_org(slug)
                    if operation == 'move':
                        op(op='move', node='coordinator-astra-2', new_parent=None)
                    fn = writes[operation]
                else:
                    fn = reads[operation]
                    for _ in range(cfg['warmups']):
                        value = fn()
                        if getattr(value, 'status_code', 200) >= 400:
                            raise RuntimeError('read returned an error response')
                warmup_ms[operation] = (time.perf_counter()-t)*1000
                for i in range(cfg['runs']):
                    t = time.perf_counter()
                    value = fn()
                    ms = (time.perf_counter()-t)*1000
                    if getattr(value, 'status_code', 200) >= 400:
                        raise RuntimeError('operation returned an error response')
                    if operation in READS and value is None:
                        raise RuntimeError('reader requested an unmeasured compatibility fallback')
                    rows.append(dict(operation=operation, side=cfg['side'], iteration=cfg['iteration']+i,
                        ok=True, ms=ms, path=('compat path' if operation.startswith('docket_') and
                            cfg['side']=='native' and not native_docket else cfg['side'])))
            except Exception as e:
                rows.append(dict(operation=operation, side=cfg['side'], iteration=cfg['iteration'],
                    ok=False, ms=None, error=type(e).__name__, error_detail=error_detail(e), path='failed'))
        if audit.snapshot()['unexpected']:
            refused = json.loads((Path(cfg['root'])/'metrics/qualification-invalid.json').read_text(encoding='utf-8'))
            words = refused.get('argv') or []
            verb = words[1] if len(words)>1 and words[1] in ('rev-parse','status','--version') else '<other>'
            raise ChildFailure({'error':'ProcessGuardRefusal', 'counts':audit.snapshot(),
                'executable':Path(refused.get('executable') or (words[0] if words else 'unknown')).name,
                'verb':verb})
        out = dict(rows=rows, warmup_ms=warmup_ms, import_provenance=PROVENANCE.as_dict(),
                   source_hash=source_hash, refused_launches=audit.snapshot())
    result.write_text(json.dumps(out, indent=2), encoding='utf-8')
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--child', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--agent')
    p.add_argument('--template', default='livecopy')
    p.add_argument('--org', default='orgtree')
    p.add_argument('--agents', default='coordinator-opus,coordinator-astra-2')
    p.add_argument('--runs', type=int, default=5)
    p.add_argument('--warmups', type=int, default=2)
    p.add_argument('--operations', default='', help='comma-separated subset; defaults to all')
    p.add_argument('--output', type=Path, default=Path('artifacts/orgdb-hot/latest'))
    a = p.parse_args()
    if a.child:
        try:
            return child()
        except Exception as e:
            print('HOT_ERROR='+json.dumps(e.detail if isinstance(e,ChildFailure) else error_detail(e)), file=sys.stderr)
            return 1
    if not a.agent or not 1 <= a.runs <= 100 or not 1 <= a.warmups <= 20 or not all(a.agents.split(',')):
        p.error('--agent, nonempty agents, runs 1..100 and warmups 1..20 are required')
    return parent(a)


if __name__ == '__main__':
    sys.exit(main())
