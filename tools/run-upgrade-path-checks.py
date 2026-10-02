"""Run upgrade checks in a newly provisioned disposable cluster, under P03 -Wait.

The custodian and PostgreSQL binaries must already exist; this builds nothing.
"""
from __future__ import annotations

import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
PROVENANCE = assert_repo_import(REPO)

import argparse
import json
import os
import subprocess
import tempfile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--custodian', type=Path, required=True)
    p.add_argument('--pg-bin', type=Path, required=True)
    p.add_argument('--generate', action='store_true')
    p.add_argument('--generate-only', action='store_true')
    p.add_argument('--json-output', type=Path)
    p.add_argument('modules', nargs='*')
    a = p.parse_args()
    with tempfile.TemporaryDirectory(prefix='upgrade-path-cluster-', ignore_cleanup_errors=True) as tmp:
        pgroot = Path(tmp) / 'pg'

        def pg(action):
            done = subprocess.run([str(a.custodian), action, '--root', str(pgroot),
                                   '--pg-bin', str(a.pg_bin)], capture_output=True,
                                  text=True, timeout=90)
            if done.returncode:
                raise RuntimeError(done.stdout + done.stderr)
            return json.loads(done.stdout)

        started = False
        try:
            pg('init-root'); pg('init'); pg('start')
            started = True
            urls = pg('urls')['urls']
            env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=urls['P03_PG_ADMIN_URL'],
                       ORGTREE_TEST_PG_RUNTIME_URL=urls['P03_PG_RUNTIME_URL'],
                       ORGTREE_TEST_PG_BIN=str(a.pg_bin))
            if a.generate or a.generate_only:
                subprocess.run([sys.executable, '-I', str(REPO / 'tools/generate-upgrade-fixtures.py'),
                                '--pg-bin', str(a.pg_bin)], env=env, check=True, timeout=900)
            if not a.generate_only:
                cmd = [sys.executable, str(REPO / 'tools/run-python-verification.py'),
                       '--timeout', '1100', *(a.modules or ['tests/test_upgrade_paths_pg.py',
                                                          'tests/test_published_migrations.py'])]
                if a.json_output:
                    cmd += ['--json-output', str(a.json_output)]
                return subprocess.run(cmd, cwd=REPO, env=env, timeout=1190).returncode
            return 0
        finally:
            if started:
                pg('stop')


if __name__ == '__main__':
    sys.exit(main())
