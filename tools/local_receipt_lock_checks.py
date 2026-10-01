"""Owned focused base/tip runs and mutants for step 3 of
n1000-burst-27-of-messages-fail-with-locktimeout (custody receipts locked per
owner where receipts are rows; blob orgs keep the whole-section lock).
Usage: local_receipt_lock_checks.py <base sha> <tag> <phase>
phases: tip-a, tip-b (modules at the tip), base-a, base-b (the changed files at
<base>), mutants (the new test module against each mutant)."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/receipt-lock-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/receipt-lock-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP_A = ['tests/test_receipt_owner_locks_pg.py', 'tests/test_pg_receipt_store.py',
           'tests/test_pg_receipt_bound.py', 'tests/test_pg_receipt_commit.py',
           'tests/test_pg_receiptrows.py', 'tests/test_pg_receipt_adoption.py',
           'tests/test_mail_runtime_reclaim.py', 'tests/test_pg3d_rt4_duplicate_delivery.py',
           'tests/test_pg3e_admission_tx.py', 'tests/test_manual_inbox_receipts.py']
GROUP_B = ['tests/test_mail_drain.py', 'tests/test_manual_inbox.py',
           'tests/test_manual_inbox_restart_evidence.py', 'tests/test_restart_resume.py',
           'tests/test_s11_halt_carriers_fence_off.py', 'tests/test_agent_halt.py',
           'tests/test_pgdoor_orgtx.py', 'tests/test_pgstore.py', 'tests/test_maildoor.py',
           'tests/test_message_audience_locks_pg.py', 'tests/test_message_notice_locks_pg.py',
           'tests/test_scale_lock_burst.py']
CHANGED = ['engine/backend/orgtree/orgtx.py', 'engine/backend/orgtree/store.py',
           'engine/backend/orgtree/mailtx.py', 'engine/backend/orgtree/halt.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-blob-org-gets-owner-locks', 'engine/backend/orgtree/orgtx.py',
     '    if not owners or converted:\n        return\n',
     '    return\n', 'test_different_owners_still_serialize_on_the_whole_section'),
    ('mut-not-the-writers-key', 'engine/backend/orgtree/orgtx.py',
     '        if kind == "section" and name.startswith(_RECEIPT_OWNER):\n',
     '        if False:\n', 'test_the_owner_lock_is_the_custody_writers_key'),
    ('mut-any-owner-may-write', 'engine/backend/orgtree/orgtx.py',
     '            if k not in tx.lock_sections and store.RECEIPT_KEY not in tx.lock_sections:\n',
     '            if False:\n', 'test_an_owners_write_needs_that_owner_or_the_whole_section'),
    ('mut-join-not-covered-by-whole', 'engine/backend/orgtree/halt.py',
     '                and not (s.startswith(store.RECEIPT_KEY + store.SPLIT_SEP)\n',
     '                and not (False\n', 'test_a_halt_join_asking_for_an_owner_is_covered_by_the_whole_section'),
    ('mut-confirm-declares-whole', 'engine/backend/orgtree/mailtx.py',
     'return {"nodes": [nid], "sections": [("delivering", nid), ("mail_transitions", nid)]}',
     'return {"nodes": [nid], "sections": [("delivering", nid), "mail_transitions"]}',
     'test_confirm_and_reclaim_declare_their_own_owner'),
    ('mut-converted-by-flag-alone', 'engine/backend/orgtree/orgtx.py',
     '    return raw.execute("SELECT 1 FROM meta WHERE key = %s",\n',
     '    return True or raw.execute("SELECT 1 FROM meta WHERE key = %s",\n',
     'test_different_owners_still_serialize_on_the_whole_section (__main__.FlagOnUnconvertedOrg'),
    ('mut-writes-recorded-as-whole', 'engine/backend/orgtree/store.py',
     'changes.doc_upserts.extend(RECEIPT_KEY + SPLIT_SEP + o for o in sorted(plan.owners))',
     'changes.doc_upserts.append(RECEIPT_KEY)',
     'test_an_owner_writes_its_receipts_and_not_anothers'),
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
        run(PHASE, [m for m in GROUP_A if 'receipt_owner_locks' not in m])   # new at the tip
    elif PHASE in ('tip-b', 'base-b'):
        run(PHASE, GROUP_B)
    elif PHASE == 'mutants':
        for label, path, old, new, expected in MUTANTS:
            mutate(path, old, new)
            logs = run(label, ['tests/test_receipt_owner_locks_pg.py'])
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
