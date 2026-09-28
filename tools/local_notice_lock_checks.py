"""Owned focused base/tip runs and mutants for step 1 of
n1000-burst-27-of-messages-fail-with-locktimeout (a local message locks its
recipients' notice boxes, not the whole section).
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
os.environ['ORGTREE_DATA'] = 'C:/Temp/notice-lock-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/notice-lock-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP_A = ['tests/test_message_notice_locks_pg.py', 'tests/test_maildoor.py',
           'tests/test_pg3d_mail_tx.py', 'tests/test_pgdoor_agent_tx.py',
           'tests/test_s7_scope_audience_race.py', 'tests/test_node_message_command_tx.py',
           'tests/test_pg3d_rt4_duplicate_delivery.py', 'tests/test_scale_lock_burst.py']
GROUP_B = ['tests/test_mail_archive_bounds_pg.py', 'tests/test_worktx.py',
           'tests/test_pg_s7_sessions_accounts.py', 'tests/test_mail_history_cost_pg.py',
           'tests/test_mail_drain_fence_off.py', 'tests/test_mail_drain_halt_unwind.py',
           'tests/test_slice_a_recover_cost.py']
CHANGED = ['engine/backend/orgtree/maildoor.py', 'engine/backend/orgtree/mailtx.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-spec-not-narrowed', 'engine/backend/orgtree/maildoor.py',
     'if not any(d.startswith(("@net:", "@org:")) for d in dest):',
     'if False:', 'test_a_local_send_locks_only_its_recipients_box'),
    ('mut-whole-section-kept', 'engine/backend/orgtree/mailtx.py',
     'out["sections"] = _dedupe([*(s for s in out.get("sections", []) if s != "notices"),',
     'out["sections"] = _dedupe([*out.get("sections", []),',
     'test_sends_to_different_recipients_do_not_wait_on_each_other'),
    ('mut-no-recipient-box', 'engine/backend/orgtree/mailtx.py',
     '*(("notices", o) for o in agents)])', '])',
     'test_a_local_send_locks_only_its_recipients_box'),
    ('mut-outside-narrowed-too', 'engine/backend/orgtree/maildoor.py',
     'if not any(d.startswith(("@net:", "@org:")) for d in dest):',
     'if True:', 'test_outside_mail_keeps_the_whole_section'),
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
        run(PHASE, [m for m in GROUP_A if 'notice_locks' not in m])   # new at the tip
    elif PHASE in ('tip-b', 'base-b'):
        run(PHASE, GROUP_B)
    elif PHASE == 'mutants':
        for label, path, old, new, expected in MUTANTS:
            mutate(path, old, new)
            logs = run(label, ['tests/test_message_notice_locks_pg.py'])
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
