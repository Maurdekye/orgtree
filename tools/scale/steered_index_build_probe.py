"""Owned probe: build cost of ix_log_d_steered_tail on a large log_d.

Private PG under a new C:/Temp/steered-index-* root. For each size, a log_d
of the product's shape is filled in SQL (generate_series) with a given share
of steered_log rows spread over agents, then the migration's exact CREATE
INDEX is timed. Values are 1 KB (the build reads owner/at/seq, not val).
Usage: steered_index_build_probe.py --root C:/Temp/steered-index-<x>
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/scale'))
TOOL = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
PGBIN = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
INDEX = ("CREATE INDEX ix_log_d_steered_tail ON log_d "
         "(owner, (COALESCE(at, '') COLLATE \"C\") DESC, seq DESC) WHERE sect='steered_log'")


def main(args):
    root = args.root.resolve()
    if root.exists() or root.parent != Path('C:/Temp').resolve() or not root.name.startswith('steered-index-'):
        raise ValueError('new owned C:/Temp/steered-index-* root required')
    root.mkdir()
    pgroot = root / 'pg'

    def pg(action):
        cp = subprocess.run([TOOL, action, '--root', str(pgroot), '--pg-bin', PGBIN],
                            capture_output=True, text=True, timeout=120)
        if cp.returncode:
            raise RuntimeError(action + ': ' + cp.stdout + cp.stderr)
        return json.loads(cp.stdout)
    from control import free_commit_gb
    if free_commit_gb() < 12:
        raise RuntimeError('free commit below 12 GiB')
    results = []
    pg('init-root'); pg('init'); pg('start')
    try:
        import psycopg
        from seed import _create_db
        url = _create_db(pg('urls')['urls']['P03_PG_ADMIN_URL'], 'orgtree_steered_index_probe')
        with psycopg.connect(url, autocommit=True) as conn:
            for total, steered_share in ((200_000, 0.2), (1_000_000, 0.2)):
                conn.execute('DROP TABLE IF EXISTS log_d')
                conn.execute('CREATE TABLE log_d (seq bigserial PRIMARY KEY, sect text NOT NULL, '
                             'owner text NOT NULL, at text, val text NOT NULL)')
                conn.execute('CREATE INDEX ix_log_d ON log_d (sect, owner, seq)')
                t = time.perf_counter()
                conn.execute(
                    "INSERT INTO log_d(sect, owner, at, val) SELECT "
                    "CASE WHEN g %% 100 < %s THEN 'steered_log' ELSE 'mail_log' END, "
                    "'agent-' || (g %% 1000), "
                    "to_char(timestamp '2026-01-01' + g * interval '1 second', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), "
                    "repeat('x', 1000) FROM generate_series(1, %s) g",
                    (int(steered_share * 100), total))
                fill_s = time.perf_counter() - t
                conn.execute('ANALYZE log_d')
                size = conn.execute("SELECT pg_total_relation_size('log_d')").fetchone()[0]
                steered = conn.execute("SELECT count(*) FROM log_d WHERE sect='steered_log'").fetchone()[0]
                t = time.perf_counter()
                conn.execute(INDEX)
                build_s = time.perf_counter() - t
                index_bytes = conn.execute("SELECT pg_relation_size('ix_log_d_steered_tail')").fetchone()[0]
                row = dict(log_d_rows=total, steered_rows=steered, log_d_bytes=size,
                           fill_seconds=round(fill_s, 2), index_build_seconds=round(build_s, 3),
                           index_bytes=index_bytes)
                results.append(row)
                print(json.dumps(row), flush=True)
    finally:
        stop = pg('stop')
        (root / 'result.json').write_text(json.dumps(dict(results=results, pg_stop=stop), indent=1),
                                          encoding='utf-8')
        print('pg stop ok', stop.get('ok'), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    main(parser.parse_args())
