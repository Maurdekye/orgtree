"""Reviewer probe (by transcript-db-review-astra, copied verbatim) (cold-transcript-ingest-at-n1000): foreground latency while the
REAL transcript worker loop has backfill continuously pending.

Throwaway C:/Temp/cold-review-* root and a private PG. One arm per invocation:
    fg_probe.py --repo <worktree> --root C:/Temp/cold-review-<x> --active 300 --busy 0|20
Measures, idle then with the worker loop running (its own pauses: tip
PENDING/IDLE, base fixed 1 s):
  * chat_window.read_window(active, 40) on a separate, fully ingested org
  * a fixed pure-Python CPU op (GIL contention)
and counts worker ticks, pending ticks and busy captures inside the window.
Refuses a verdict if backfill was not pending for the whole window.
"""
import argparse, json, os, statistics, subprocess, sys, threading, time, uuid
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--repo', type=Path, required=True)
ap.add_argument('--root', type=Path, required=True)
ap.add_argument('--active', type=int, default=300)
ap.add_argument('--busy', type=int, default=0)
ap.add_argument('--window', type=float, default=15.0)
# owner addition: cold nodes already carry their transcript identity (an
# existing org), so first visits do no identity-mint org_tx
ap.add_argument('--preminted', action='store_true')
args = ap.parse_args()
REPO = args.repo.resolve()
sys.path.insert(0, str(REPO / 'tools'))
sys.path.insert(0, str(REPO / 'tools/scale'))
from assert_repo_import import assert_repo_import

TOOL = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
PGBIN = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'


def pct(v, q):
    v = sorted(v); return v[min(len(v) - 1, int(q * len(v)))] if v else None


def summ(v):
    return dict(n=len(v), p50=statistics.median(v) if v else None, p95=pct(v, .95), p99=pct(v, .99),
                max=max(v) if v else None, mean=statistics.mean(v) if v else None)


def write_transcript(path, records, size, tag):
    pad = 'x' * max(0, size - 120)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for i in range(records):
            kind = 'user' if i % 2 == 0 else 'assistant'
            f.write(json.dumps({'type': kind, 'uuid': f'{tag}-{i}',
                                'message': {'role': kind, 'content': f'{i} {pad}'}}) + '\n')


root = args.root.resolve()
assert not root.exists() and root.parent == Path('C:/Temp').resolve() and root.name.startswith('cold-review-')
root.mkdir()
pgroot = root / 'pg'


def pg(action):
    cp = subprocess.run([TOOL, action, '--root', str(pgroot), '--pg-bin', PGBIN], capture_output=True, text=True, timeout=60)
    if cp.returncode:
        raise RuntimeError(action + cp.stdout + cp.stderr)
    return json.loads(cp.stdout)


out = dict(args={k: str(v) for k, v in vars(args).items()})
pg('init-root'); pg('init'); pg('start')
try:
    admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
    from seed import _create_db
    os.environ['ORGTREE_PG_URL'] = _create_db(admin, 'orgtree_cold_review')
    os.environ['ORGTREE_STORE'] = 'postgres'
    os.environ['ORGTREE_DATA'] = str(root / 'data')
    os.environ['ORGTREE_V2_TOKEN'] = 'cold-review-only'
    (root / 'data').mkdir()
    prov = assert_repo_import(REPO)
    from engine.launch import load_app
    load_app()
    from orgtree import store, ledger, pgstore, supervisor as sup, transcript_ingest as ingest
    from orgtree import transcript_records as records, chat_window
    pgstore.migrate(os.environ['ORGTREE_PG_URL'])
    out['head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    out['dirty'] = subprocess.check_output(['git', 'status', '--porcelain', '-uno'], cwd=REPO, text=True).strip()
    out['tip_code'] = hasattr(ingest, 'WORK_BUDGET_S')
    files = root / 't'; files.mkdir()
    paths = {}
    sup.transcript_path = lambda sid, *a, **k: paths.get(str(sid))

    def make_org(prefix, n, recs, size):
        org = store.create_org(prefix + uuid.uuid4().hex[:8])
        nids = [f'worker-{i:03d}' for i in range(n)]
        for nid in nids:
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        if args.preminted and prefix == 'cold-':
            org.d.setdefault('reply_incarnation', uuid.uuid4().hex)
            for nid in nids:
                node = org.node(nid)
                node.setdefault('reply_incarnation', uuid.uuid4().hex)
                node['transcript_incarnation'] = org.d['reply_incarnation'] + ':' + node['reply_incarnation']
        store.save_org(org)
        org = store.load_org(org.d['slug'])
        for nid in nids:
            p = files / f"{org.d['slug']}-{nid}.jsonl"
            write_transcript(p, recs, size, org.d['slug'] + nid)
            paths[org.node(nid)['session_id']] = str(p)
        return org.d['slug'], nids

    # foreground org first, fully ingested before the cold org exists
    fg_slug, fg_nodes = make_org('fg-', 10, 180, 1460)
    with records.reuse_database():
        for _ in range(40):
            if not any(ingest.capture(fg_slug, n, backfill=True) for n in fg_nodes):
                break
    cold_slug, cold_nodes = make_org('cold-', args.active, 180, 1460)
    out['cold_bytes'] = sum(os.path.getsize(files / f'{cold_slug}-{n}.jsonl') for n in cold_nodes)
    for nid in cold_nodes[:args.busy]:
        sup._state[(cold_slug, nid)] = dict(sup._state.get((cold_slug, nid)) or {}, busy=True)

    blob = [{'k': i, 'v': 'y' * 40, 'l': list(range(20))} for i in range(1500)]

    def cpu_op():
        t = time.perf_counter(); json.loads(json.dumps(blob)); return time.perf_counter() - t

    def read_op(i):
        t = time.perf_counter(); chat_window.read_window(store.cached_org(fg_slug), fg_nodes[i % 10], 40)
        return time.perf_counter() - t

    def measure(seconds):
        reads, cpus, end, i = [], [], time.perf_counter() + seconds, 0
        while time.perf_counter() < end:
            reads.append(read_op(i)); cpus.append(cpu_op()); i += 1
            time.sleep(0.01)
        return reads, cpus

    measure(1.0)
    idle_r, idle_c = measure(args.window / 3)

    stop = threading.Event()
    ticks = []           # (start, dur, pending)
    busy_calls = [0]
    orig_capture = ingest.capture

    def counted(slug, nid, **kw):
        if not kw.get('backfill'):
            busy_calls[0] += 1
        return orig_capture(slug, nid, **kw)
    ingest.capture = counted

    def worker():
        state = ingest._SweepState()
        with records.reuse_database():
            while not stop.is_set():
                t = time.perf_counter()
                pending = ingest._sweep(state)
                ticks.append((t, time.perf_counter() - t, pending))
                if hasattr(ingest, 'PENDING_PAUSE_S'):
                    time.sleep(ingest.PENDING_PAUSE_S if pending else ingest.IDLE_PAUSE_S)
                else:
                    time.sleep(1)
    th = threading.Thread(target=worker, daemon=True); th.start()
    time.sleep(1.0)
    w0 = time.perf_counter(); b0 = busy_calls[0]
    busy_r, busy_c = measure(args.window)
    w1 = time.perf_counter(); b1 = busy_calls[0]
    stop.set(); th.join(120)
    ingest.capture = orig_capture
    inwin = [t for t in ticks if t[0] >= w0 - 2 and t[0] <= w1]
    with records.database() as conn:
        rows = conn.execute('SELECT source,lower_byte FROM transcript_sources').fetchall()
    cold_done = sum(1 for s, lo in rows if lo == 0)
    out.update(
        idle=dict(read=summ(idle_r), cpu=summ(idle_c)),
        backfill=dict(read=summ(busy_r), cpu=summ(busy_c)),
        worker=dict(ticks_in_window=len(inwin), pending_ticks=sum(1 for t in inwin if t[2]),
                    tick=summ([t[1] for t in inwin]),
                    worker_busy_fraction=sum(t[1] for t in inwin) / (w1 - w0),
                    busy_captures_per_s=(b1 - b0) / (w1 - w0), all_ticks=len(ticks)),
        sources_done_after=cold_done, sources_total=len(rows))
    # refuse a verdict unless backfill work really overlapped the whole window
    last_pending = max((t[0] for t in ticks if t[2]), default=0) if out['tip_code'] else None
    out['valid'] = (cold_done < args.active) and len(inwin) > 3
    out['provenance'] = str(getattr(prov, '__dict__', prov))
    records.close_all(); pgstore.close_idle()
finally:
    out['pg_stop'] = pg('stop').get('ok')
    (root / 'result.json').write_text(json.dumps(out, indent=1, default=str), encoding='utf-8')
    print(json.dumps({k: v for k, v in out.items() if k != 'provenance'}, indent=1, default=str), flush=True)
