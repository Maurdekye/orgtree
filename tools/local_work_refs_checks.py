"""Owned focused base/tip runs and mutants for the one-row work-ref listing
(message-send-reads-grow-above-n-100-985-rows-1-2, option B).
Usage: local_work_refs_checks.py <base sha> <tag> <phase>
phases: tip-a, tip-b (modules at the tip), base-a, base-b (the changed files at
<base>), mutants (tests/test_pg_lazy_work_items.py against each mutant)."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/work-refs-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/work-refs-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP_A = ['tests/test_pg_lazy_work_items.py', 'tests/test_pg_lazy_rows.py',
           'tests/test_pg_work_item_rows.py', 'tests/test_work_item_rows.py',
           'tests/test_pg_work_read.py', 'tests/test_pg_work_query.py',
           'tests/test_pg_work_index.py', 'tests/test_pg_work_list_meta.py',
           'tests/test_scale_rows_preflight.py']
GROUP_B = ['tests/test_pg_work_ui.py', 'tests/test_pgimport_work_rows.py', 'tests/test_worktx.py',
           'tests/test_workdoor.py', 'tests/test_work_receipt_route_tx.py',
           'tests/test_work_reminder_admission.py', 'tests/test_pgdoor_orgtx.py',
           'tests/test_pgstore.py', 'tests/test_pg3c_reservations_tx.py',
           'tests/test_pg3c_watchdog_tx.py']
CHANGED = ['engine/backend/orgtree/store.py', 'tests/test_pg_lazy_work_items.py',
           'tools/scale/rows_preflight.py', 'tests/test_scale_rows_preflight.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}
target = repo / 'engine/backend/orgtree/store.py'

ONE_ROW = (
    '    agg = conn.execute(\n'
    '        "SELECT array_agg(key ORDER BY key), array_agg(xmin::text ORDER BY key), "\n'
    '        "array_agg(ctid::text ORDER BY key), array_agg(tableoid::text ORDER BY key) "\n'
    '        "FROM doc WHERE starts_with(key, ?)",\n'
    '        (workrows.PREFIX,)).fetchone()\n'
    '    versions = list(zip(*agg)) if agg and agg[0] is not None else []\n')
ROW_PER_ITEM = (
    '    versions = conn.execute(\n'
    '        "SELECT key, xmin::text, ctid::text, tableoid::text FROM doc WHERE starts_with(key, ?)",\n'
    '        (workrows.PREFIX,)).fetchall()\n')
MUTANTS = [
    ('mut-row-per-item', ONE_ROW, ROW_PER_ITEM,
     'test_a_load_lists_every_item_version_in_one_row'),
    ('mut-misaligned-versions',
     'array_agg(xmin::text ORDER BY key)', 'array_agg(xmin::text ORDER BY key DESC)',
     'test_the_listing_still_carries_every_item_and_its_version'),
    ('mut-listing-dropped',
     'versions = list(zip(*agg)) if agg and agg[0] is not None else []', 'versions = []',
     'test_orphaned_item_rows_are_still_refused'),
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


def mutate(old, new):
    text = saved['engine/backend/orgtree/store.py'].decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, old
    target.write_bytes(text.replace(old, new).encode('utf-8'))


try:
    pg('init-root'); pg('init'); pg('start')
    env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=pg('urls')['urls']['P03_PG_ADMIN_URL'])
    if PHASE in ('base-a', 'base-b'):
        for f in CHANGED:
            (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
    if PHASE in ('tip-a', 'base-a'):
        run(PHASE, GROUP_A)
    elif PHASE in ('tip-b', 'base-b'):
        run(PHASE, GROUP_B)
    elif PHASE == 'mutants':
        for label, old, new, expected in MUTANTS:
            mutate(old, new)
            logs = run(label, ['tests/test_pg_lazy_work_items.py'])
            caught = ('FAIL: ' + expected in logs) or ('ERROR: ' + expected in logs)
            print(label, 'CAUGHT' if caught else 'SURVIVED', flush=True)
            target.write_bytes(saved['engine/backend/orgtree/store.py'])
finally:
    for f, data in saved.items():
        (repo / f).write_bytes(data)
    restored = all((repo / f).read_bytes() == d for f, d in saved.items())
    cleanup = pg('stop')
    cleanup['source_restored'] = restored
    provenance.write_result(out / 'cleanup.json', cleanup)
    print('source_restored', restored, flush=True)
