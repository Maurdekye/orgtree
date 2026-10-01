"""Owned focused base/tip runs and a mutant for the load probe fix (an org
load reads the owners meta rows' presence, not their N-sized values).
Usage: local_load_probe_checks.py <base sha> <tag> <phase>
phases: tip, base (store.py at <base>), mutants."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/load-probe-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/load-probe-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP = ['tests/test_load_probes.py', 'tests/test_pgstore.py', 'tests/test_pg_lazy_rows.py',
         'tests/test_pg_lazy_work_items.py', 'tests/test_steer_attempts_lazy.py',
         'tests/test_append_only_log.py', 'tests/test_toolcall_single_load.py',
         'tests/test_org_summary_volume_pg.py', 'tests/test_docket_scope_lazy_log.py',
         'tests/test_state_access_rearchitecture.py']
CHANGED = ['engine/backend/orgtree/store.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-probe-reads-owner-lists', 'engine/backend/orgtree/store.py',
     """+ ") THEN '' ELSE val END FROM meta WHERE key IN (""",
     """+ ") THEN val ELSE val END FROM meta WHERE key IN (""",
     'test_the_owner_lists_are_not_fetched'),
]


def pg(action):
    cp = subprocess.run([tool, action, '--root', str(pgroot), '--pg-bin', pgbin],
                        capture_output=True, text=True, timeout=60)
    if cp.returncode:
        raise RuntimeError(cp.stdout + cp.stderr)
    return json.loads(cp.stdout)


def run(label, modules):
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '400', '--json-output', str(receipt)], cwd=repo, env=env,
                        capture_output=True, text=True, timeout=1100)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    for m in data['modules']:
        assert m['import_provenance'], m
        print(label, m.get('module') or m.get('path'), m['tests_ran'], m['exit_code'], flush=True)
    return logs


def mutate(path, old, new):
    text = saved[path].decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, old
    (repo / path).write_bytes(text.replace(old, new).encode('utf-8'))


try:
    pg('init-root'); pg('init'); pg('start')
    env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=pg('urls')['urls']['P03_PG_ADMIN_URL'])
    if PHASE == 'base':
        for f in CHANGED:
            (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
    if PHASE in ('tip', 'base'):
        run(PHASE, GROUP)
    elif PHASE == 'mutants':
        for label, path, old, new, expected in MUTANTS:
            mutate(path, old, new)
            logs = run(label, ['tests/test_load_probes.py'])
            caught = ('FAIL: ' + expected in logs) or ('ERROR: ' + expected in logs)
            print(label, 'CAUGHT' if caught else 'SURVIVED', flush=True)
            (repo / path).write_bytes(saved[path])
finally:
    for f, data in saved.items():
        (repo / f).write_bytes(data)
    restored = all((repo / f).read_bytes() == d for f, d in saved.items())
    cleanup = pg('stop')
    cleanup['source_restored'] = restored
    provenance.write_result(out / 'cleanup.json', cleanup)
    print('source_restored', restored, flush=True)
