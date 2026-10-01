"""Owned focused base/tip runs and mutants for tests/child_python.py
(child-python-tests-import-the-main-checkout-s-or).
Usage: local_child_python_checks.py <base sha> <tag> <phase: tip|base|mutants>

tip      tests/test_child_python.py + every migrated module
base     the migrated modules as they are at <base>
mut-no-check   the child never refuses -> test_child_python's refusal tests fail
mut-no-roots   children get no checkout roots, so they resolve the interpreter's
               own (main checkout's) engine -> each migrated module whose
               children run must fail with the helper's refusal"""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/child-python-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE = sys.argv[1]
PHASE = sys.argv[3]
out = Path('C:/Temp/child-python-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
helper = repo / 'tests/child_python.py'
saved_helper = helper.read_bytes()
NEW = ['tests/test_child_python.py']
MIGRATED = ['tests/test_assistant_identity.py', 'tests/test_desktop_devguard.py',
            'tests/test_engine_http.py', 'tests/test_history_retention.py',
            'tests/test_desktop_import.py', 'tests/test_desktop_import_jobs.py',
            'tests/test_desktop_maintenance.py', 'tests/test_profile_timing_sink.py',
            'tests/test_startup_progress.py', 'tests/test_v3_migration_harness.py',
            'tests/test_wire_contract.py', 'tests/test_wire_contract_controls.py']
BASE_FILES = [m for m in MIGRATED if 'wire_contract' not in m] + ['tests/wire_contract/python_target.py']
saved = {f: (repo / f).read_bytes() for f in BASE_FILES}


def run(label, modules):
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '400', '--json-output', str(receipt)], cwd=repo,
                        capture_output=True, text=True, timeout=1100)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    rows = [(m.get('module') or m.get('path'), m['tests_ran'], m['exit_code'],
             m['import_provenance'].get('orgtree') if m['import_provenance'] else None)
            for m in data['modules']]
    for row in rows:
        print(label, row, flush=True)
    return data, logs


def mutate(old, new):
    text = saved_helper.decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, old
    helper.write_bytes(text.replace(old, new).encode('utf-8'))


try:
    if PHASE == 'tip':
        run('tip', NEW + MIGRATED)
    if PHASE == 'base':
        for f in BASE_FILES:
            (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
        run('base', MIGRATED)
        for f, data in saved.items():
            (repo / f).write_bytes(data)
    if PHASE != 'mutants':
        raise SystemExit(0)
    mutate('            _o._exit(_code)\n', '            pass\n')
    _, logs = run('mut-no-check', NEW)
    assert 'FAIL: test_a_foreign' in logs, 'mut-no-check survived'
    mutate('_s.path[:0] = _roots\n', '_roots = []\n')
    _, logs = run('mut-no-roots', NEW + MIGRATED)
    print('refusals under mut-no-roots:', logs.count('child_python: '), flush=True)
finally:
    helper.write_bytes(saved_helper)
    for f, data in saved.items():
        (repo / f).write_bytes(data)
    restored = helper.read_bytes() == saved_helper and all((repo / f).read_bytes() == d for f, d in saved.items())
    provenance.write_result(out / 'cleanup.json', {'source_restored': restored})
    print('source_restored', restored, flush=True)
