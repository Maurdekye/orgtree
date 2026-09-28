"""Owned focused base/tip runs and mutants for step 2 of
n1000-burst-27-of-messages-fail-with-locktimeout (a message holds `audiences`
FOR SHARE unless it will grant one; a wrong "no" is refused and re-run).
Usage: local_audience_lock_checks.py <base sha> <tag> <phase>
phases: tip-a, tip-b (modules at the tip), base-a, base-b (the changed files at
<base>), mutants (the new test module against each mutant)."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/audience-lock-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/audience-lock-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP_A = ['tests/test_message_audience_locks_pg.py', 'tests/test_message_notice_locks_pg.py',
           'tests/test_maildoor.py',
           'tests/test_pg3d_mail_tx.py', 'tests/test_pgdoor_agent_tx.py',
           'tests/test_s7_scope_audience_race.py', 'tests/test_node_message_command_tx.py',
           'tests/test_pg3d_rt4_duplicate_delivery.py', 'tests/test_scale_lock_burst.py']
GROUP_B = ['tests/test_mail_archive_bounds_pg.py', 'tests/test_worktx.py',
           'tests/test_pg_s7_sessions_accounts.py', 'tests/test_mail_history_cost_pg.py',
           'tests/test_mail_drain_fence_off.py', 'tests/test_mail_drain_halt_unwind.py',
           'tests/test_slice_a_recover_cost.py', 'tests/test_turn_org_state_shared.py']
CHANGED = ['engine/backend/orgtree/maildoor.py', 'engine/backend/orgtree/mailtx.py',
           'engine/backend/orgtree/store.py', 'engine/backend/orgtree/pgdoor.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-never-predict-a-write', 'engine/backend/orgtree/maildoor.py',
     '    if not dest:\n        return True                                 # unresolved: the body decides\n',
     '    return False\n', 'test_a_reply_grant_takes_it_for_update'),
    ('mut-always-predict-a-write', 'engine/backend/orgtree/maildoor.py',
     '    if not dest:\n        return True                                 # unresolved: the body decides\n',
     '    return True\n', 'test_ordinary_sends_only_share_the_list'),
    ('mut-existing-audience-ignored', 'engine/backend/orgtree/maildoor.py',
     '                    and not snapshot._has_audience(d, sender)):',
     '                    ):', 'test_an_existing_reply_audience_needs_no_write'),
    ('mut-list-kept-exclusive', 'engine/backend/orgtree/mailtx.py',
     'out["sections"] = [s for s in out.get("sections", []) if s != "audiences"]',
     'out["sections"] = list(out.get("sections", []))',
     'test_two_reading_sends_do_not_wait_on_each_other'),
    ('mut-retry-path-broken', 'engine/backend/orgtree/pgdoor.py',
     '            rows = _refused(e)\n', '            rows = None\n',
     'test_a_wrong_no_is_refused_and_rerun_holding_it_exactly_once'),
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
    if PHASE in ('base-a', 'base-b'):
        for f in CHANGED:
            (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
    if PHASE == 'tip-a':
        run(PHASE, GROUP_A)
    elif PHASE == 'base-a':
        run(PHASE, [m for m in GROUP_A if 'audience_locks' not in m])   # new at the tip
    elif PHASE in ('tip-b', 'base-b'):
        run(PHASE, GROUP_B)
    elif PHASE == 'mutants':
        for label, path, old, new, expected in MUTANTS:
            mutate(path, old, new)
            logs = run(label, ['tests/test_message_audience_locks_pg.py'])
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
