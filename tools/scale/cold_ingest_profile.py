"""Small, owned profile of cold transcript backfill (cold-transcript-ingest item).

Throwaway C:/Temp/cold-ingest-* root and private PostgreSQL only. Shapes match
the N1000 attempt-2 files: active ~180 records of ~1.46 KB, archived 2 records
of ~130 KB. Phase 1 runs the real sweep without its sleep and times every
capture. Phase 2 measures foreground chat reads with the backfill idle and busy.
"""
import argparse
import cProfile
import io
import json
import os
from pathlib import Path
import pstats
import statistics
import subprocess
import sys
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools'))
sys.path.insert(0, str(REPO / 'tools/scale'))
from assert_repo_import import assert_repo_import

TOOL = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
PGBIN = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))] if values else None


def summary(values):
    return dict(n=len(values), median=statistics.median(values) if values else None,
                p95=pct(values, .95), max=max(values) if values else None, total=sum(values))


def write_transcript(path, records, size, rng_tag):
    pad = 'x' * max(0, size - 120)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for i in range(records):
            kind = 'user' if i % 2 == 0 else 'assistant'
            f.write(json.dumps({'type': kind, 'uuid': f'{rng_tag}-{i}',
                                'message': {'role': kind, 'content': f'{i} {pad}'}}) + '\n')


def main(args):
    root = args.root.resolve()
    if root.exists() or root.parent != Path('C:/Temp').resolve() or not root.name.startswith('cold-ingest-'):
        raise ValueError('new owned C:/Temp/cold-ingest-* root required')
    root.mkdir()
    pgroot = root / 'pg'

    def pg(action):
        cp = subprocess.run([TOOL, action, '--root', str(pgroot), '--pg-bin', PGBIN],
                            capture_output=True, text=True, timeout=60)
        if cp.returncode:
            raise RuntimeError(action + ': ' + cp.stdout + cp.stderr)
        return json.loads(cp.stdout)

    out = dict(args=dict(active=args.active, archived=args.archived), phases={})
    from control import free_commit_gb
    if free_commit_gb() < 12:
        raise RuntimeError('free commit below 12 GiB')
    pg('init-root'); pg('init'); pg('start')
    try:
        admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
        from seed import _create_db
        os.environ['ORGTREE_PG_URL'] = _create_db(admin, 'orgtree_cold_ingest_profile')
        os.environ['ORGTREE_STORE'] = 'postgres'
        os.environ['ORGTREE_DATA'] = str(root / 'data')
        os.environ['ORGTREE_V2_TOKEN'] = 'cold-ingest-profile-only'
        (root / 'data').mkdir()
        prov = assert_repo_import(REPO)
        from engine.launch import load_app
        load_app()
        from orgtree import store, ledger, pgstore, supervisor as sup, transcript_ingest as ingest
        from orgtree import transcript_records as records, chat_window
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])
        files = root / 'transcripts'
        files.mkdir()
        org = store.create_org('cold-' + uuid.uuid4().hex[:8])
        slug = org.d['slug']
        active = [f'worker-{i:03d}' for i in range(args.active)]
        for nid in active:
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        template = dict(org.node(active[0]))
        archived = []
        for i in range(args.archived):
            node = dict(template)
            nid = f'hist-{i:03d}'
            node.update(id=nid, state='archived', session_id=str(uuid.uuid4()),
                        transcript_incarnation=f'hist-incarnation-{i:012d}')
            org.d['nodes'][nid] = node
            archived.append(nid)
        store.save_org(org)
        org = store.load_org(slug)
        paths = {}
        for nid in active:
            p = files / f'{nid}.jsonl'
            write_transcript(p, 180, 1460, nid)
            paths[org.node(nid)['session_id']] = str(p)
        for nid in archived:
            p = files / f'{nid}.jsonl'
            write_transcript(p, 2, 131500, nid)
            paths[org.node(nid)['session_id']] = str(p)
        sup.transcript_path = lambda sid, *a, **k: paths.get(str(sid))
        out['files'] = dict(active_bytes=sum(os.path.getsize(files / f'{n}.jsonl') for n in active),
                            archived_bytes=sum(os.path.getsize(files / f'{n}.jsonl') for n in archived))

        def pause(result):
            # the worker loop's own pause: the new pacing, or the old fixed second
            if hasattr(ingest, 'PENDING_PAUSE_S'):
                return ingest.PENDING_PAUSE_S if result else ingest.IDLE_PAUSE_S
            return 1.0

        # ---- phase 1: the real sweep, every capture timed (paced = real pauses) ----
        timings = {'active': [], 'archived': []}
        first_visit = {'active': [], 'archived': []}
        seen = set()
        original = ingest.capture

        def timed(slug_, nid, **kw):
            t = time.perf_counter()
            try:
                return original(slug_, nid, **kw)
            finally:
                dt = time.perf_counter() - t
                kind = 'archived' if nid.startswith('hist-') else 'active'
                (first_visit if nid not in seen else timings)[kind].append(dt)
                seen.add(nid)
        ingest.capture = timed
        state = ingest._SweepState()
        profiler = cProfile.Profile()
        ticks, tick_times, start = 0, [], time.perf_counter()
        done_at = {}
        with records.reuse_database():
            profiler.enable()
            while time.perf_counter() - start < args.phase1_s:
                t = time.perf_counter()
                result = ingest._sweep(state)
                tick_times.append(time.perf_counter() - t)
                if args.paced:
                    time.sleep(pause(result))
                ticks += 1
                if True:  # every tick, so done times resolve to one tick
                    with records.database() as conn:
                        rows = conn.execute('SELECT source,lower_byte FROM transcript_sources').fetchall()
                    states = {}
                    for source, lower in rows:
                        states[source] = lower
                    kinds = {'active': 0, 'archived': 0}
                    for source, lower in states.items():
                        if lower == 0:
                            kinds['archived' if 'hist-incarnation' in source else 'active'] += 1
                    for kind, n in kinds.items():
                        total = args.archived if kind == 'archived' else args.active
                        if n >= total and kind not in done_at:
                            done_at[kind] = dict(tick=ticks, busy_seconds=sum(tick_times),
                                                 wall_seconds=time.perf_counter() - start)
                    if len(done_at) == 2:
                        break
            profiler.disable()
        ingest.capture = original
        buf = io.StringIO()
        stats = pstats.Stats(profiler, stream=buf)
        stats.sort_stats('cumulative').print_stats(45)
        stats.print_callers(r'\(org_tx\)|\(incarnation\)')
        (root / 'phase1-cprofile.txt').write_text(buf.getvalue(), encoding='utf-8')
        out['phases']['sweep'] = dict(ticks=ticks, tick=summary(tick_times), done_at=done_at,
            capture_first_visit={k: summary(v) for k, v in first_visit.items()},
            capture_later={k: summary(v) for k, v in timings.items()},
            paced=args.paced, note='paced: the worker loop pauses between ticks; unpaced: none')

        # ---- phase 2: foreground chat reads, backfill idle vs busy ----
        org2 = store.create_org('cold2-' + uuid.uuid4().hex[:8])
        slug2 = org2.d['slug']
        fg_nodes = [f'worker-{i:03d}' for i in range(args.active)]
        for nid in fg_nodes:
            org2.hire(ledger.USER, None, 'haiku', 0, nid)
        store.save_org(org2)
        org2 = store.load_org(slug2)
        for nid in fg_nodes:
            p = files / f'fg-{nid}.jsonl'
            write_transcript(p, 180, 1460, 'fg' + nid)
            paths[org2.node(nid)['session_id']] = str(p)
        reader_targets = active[:10]

        def reads(n):
            lat = []
            for i in range(n):
                nid = reader_targets[i % len(reader_targets)]
                t = time.perf_counter()
                chat_window.read_window(store.cached_org(slug), nid, 40)
                lat.append(time.perf_counter() - t)
            return lat
        reads(10)
        idle = reads(args.reads)
        stop = threading.Event()
        bg_ticks = [0]

        def backfill():
            state2 = ingest._SweepState()
            with records.reuse_database():
                while not stop.is_set():
                    result = ingest._sweep(state2)
                    bg_ticks[0] += 1
                    if args.paced:
                        time.sleep(pause(result))
        worker = threading.Thread(target=backfill, daemon=True)
        worker.start()
        time.sleep(1.0)
        busy = reads(args.reads)
        stop.set()
        worker.join(60)
        out['phases']['foreground'] = dict(target='chat_window.read_window(cached_org, active node, 40)',
            idle=summary(idle), busy_backfill_no_sleep=summary(busy), backfill_ticks=bg_ticks[0],
            backfill_thread_alive=worker.is_alive())
        records.close_all()
        pgstore.close_idle()
        out['provenance'] = str(prov.__dict__ if hasattr(prov, '__dict__') else prov)
        prov.write_result(root / 'result.json', out)
    finally:
        out['pg_stop'] = pg('stop')
        (root / 'result-final.json').write_text(json.dumps(out, indent=2, default=str), encoding='utf-8')
        print(json.dumps(out, indent=1, default=str), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--active', type=int, default=50)
    parser.add_argument('--archived', type=int, default=50)
    parser.add_argument('--phase1-s', type=float, default=240)
    parser.add_argument('--reads', type=int, default=60)
    parser.add_argument('--paced', action='store_true')
    main(parser.parse_args())
