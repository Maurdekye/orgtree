"""Owned focused base/tip runs and observed source mutants for cold ingest, then restore."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = str(repo / '.cold-results/guard-data')
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE = '5e99a25'
out = repo / '.cold-results'
out.mkdir(exist_ok=True)
pgroot = Path('C:/Temp/cold-ingest-checks-pg')
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
names = ['engine/backend/orgtree/transcript_ingest.py', 'engine/backend/orgtree/transcript_records.py',
         'engine/backend/orgtree/store.py', 'tests/test_transcript_ingest.py',
         'tests/test_transcript_ingest_pg.py']
paths = [repo / n for n in names]
saved = {p: p.read_bytes() for p in paths}
MODULES = ['tests/test_transcript_ingest.py', 'tests/test_transcript_ingest_pg.py',
           'tests/test_transcript_records.py', 'tests/test_transcript_records_conn_cache.py']


def pg(action):
    cp = subprocess.run([tool, action, '--root', str(pgroot), '--pg-bin', pgbin],
                        capture_output=True, text=True, timeout=60)
    if cp.returncode:
        raise RuntimeError(cp.stdout + cp.stderr)
    return json.loads(cp.stdout)


def restore():
    for path, raw in saved.items():
        path.write_bytes(raw)


def run(label, modules, expected=None):
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '300', '--json-output', str(receipt)], cwd=repo, env=env,
                        capture_output=True, text=True, timeout=900)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    for module in data['modules']:
        assert module['import_provenance'] and module['tests_ran'] > 0, module
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    summary = [(m['module'] if 'module' in m else m.get('path'), m['tests_ran'], m['exit_code']) for m in data['modules']]
    print(label, summary, flush=True)
    print('\n'.join(line for line in logs.splitlines() if line.startswith(('Ran ', 'OK', 'FAILED', 'FAIL:', 'ERROR:'))), flush=True)
    if expected:
        assert cp.returncode and any(('FAIL: ' + e in logs or 'ERROR: ' + e in logs) for e in expected), logs[-4000:]
    return data


def mutate(path, old, new):
    text = path.read_bytes().decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, (path, old)
    path.write_bytes(text.replace(old, new).encode('utf-8'))


try:
    pg('init-root'); pg('init'); pg('start')
    env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=pg('urls')['urls']['P03_PG_ADMIN_URL'])
    run('tip', MODULES)
    for path in paths:
        path.write_bytes(subprocess.check_output(['git', 'show', BASE + ':' + path.relative_to(repo).as_posix()], cwd=repo))
    run('base', MODULES)
    restore()
    ingest_py, records_py = paths[0], paths[1]
    mutants = [
        ('mut-slice-budget-ignored', records_py, '                budget[0] -= stop - split\n', '                pass\n',
         ['test_one_slice_never_reads_more_than_its_budget_plus_one_record'], MODULES[:1]),
        ('mut-history-not-gated', ingest_py, '            state.active_settled or state.archive_allowance > 0):',
         '            True):', ['test_history_waits_until_every_active_node_is_settled'], MODULES[:1]),
        ('mut-no-time-budget', ingest_py, '    while clock() < deadline:\n        if not state.hot:',
         '    while True:\n        if not state.hot:', ['test_backfill_work_in_one_tick_is_time_bounded'], MODULES[:1]),
        ('mut-no-active-seeding', ingest_py, '            self.seed_active(list(self.orgs))\n', '            pass\n',
         ['test_active_nodes_are_seeded_before_discovery_reaches_them'], MODULES[:1]),
        ('mut-pending-only-unsettled', ingest_py, '            pending = pending or catching_up\n',
         '            pass\n', ['test_single_slice_catch_up_never_sleeps_a_second_while_work_remains'], MODULES[:1]),
        ('mut-busy-every-tick', ingest_py, '    if state.last_busy is None or now - state.last_busy >= 1.0:',
         '    if True:', ['test_busy_nodes_are_captured_once_per_second_however_short_the_pauses'], MODULES[:1]),
        ('mut-no-queued-scan', ingest_py, '        pending = True   # the tick ended with never-settled active nodes queued\n',
         '        pass\n', ['test_catch_up_queued_behind_the_idle_check_cap_stays_pending'], MODULES[:1]),
        ('mut-failure-is-pending', ingest_py, '            state.round_unsettled = True\n            checks += 1\n',
         '            state.round_unsettled = True\n            pending = True\n            checks += 1\n',
         ['test_a_node_that_keeps_failing_backs_off_and_returns_to_the_idle_cadence'], MODULES[:1]),
        ('mut-no-backoff', ingest_py, '    return entry is not None and now < entry[1]\n',
         '    return False\n', ['test_a_database_outage_backs_off_with_bounded_exceptions_and_wakeups'], MODULES[:1]),
        ('mut-no-mint-once', ingest_py, "    if not node.get('transcript_incarnation'):\n        # Mint",
         "    if False:\n        # Mint", ['test_unminted_node_is_minted_once_to_the_same_identity'], MODULES[:2]),
    ]
    for label, path, old, new, expected, modules in mutants:
        mutate(path, old, new)
        run(label, modules, expected)
        restore()
finally:
    restore()
    cleanup = pg('stop')
    cleanup['source_restored'] = all(p.read_bytes() == raw for p, raw in saved.items())
    provenance.write_result(out / 'cleanup.json', cleanup)
    print('cleanup', json.dumps(cleanup), flush=True)
