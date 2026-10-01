"""Owned focused base/tip runs and observed source mutants for the bounded org
list (org-list-api-orgs-reads-grow-with-agent-count).
Usage: local_org_list_checks.py <base sha> <tag> [--new-only]"""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/org-list-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE = sys.argv[1]
out = Path('C:/Temp/org-list-checks-' + sys.argv[2])
out.mkdir()
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
target = repo / 'engine/backend/orgtree/org_summary.py'
saved = target.read_bytes()
NEW = ['tests/test_org_list_bounded_pg.py']
EXISTING = ['tests/test_org_summary_behavior_pg.py', 'tests/test_org_summary_reads_pg.py',
            'tests/test_org_summary_volume_pg.py',
            'tests/test_ui_read_pool.py', 'tests/test_v3_qualification_ui.py',
            'tests/test_state_org_admin_boundary.py', 'tests/test_state_exchange_boundary.py',
            'tests/test_state_lifecycle_boundary.py', 'tests/test_p02_operation_contacts.py']


def pg(action):
    cp = subprocess.run([tool, action, '--root', str(pgroot), '--pg-bin', pgbin],
                        capture_output=True, text=True, timeout=60)
    if cp.returncode:
        raise RuntimeError(cp.stdout + cp.stderr)
    return json.loads(cp.stdout)


def run(label, modules, expected=None):
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '400', '--json-output', str(receipt)], cwd=repo, env=env,
                        capture_output=True, text=True, timeout=1100)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    for module in data['modules']:
        assert module['import_provenance'] and module['tests_ran'] > 0, module
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    print(label, [(m.get('module') or m.get('path'), m['tests_ran'], m['exit_code']) for m in data['modules']],
          flush=True)
    if expected:
        assert cp.returncode and any(('FAIL: ' + e in logs or 'ERROR: ' + e in logs) for e in expected), logs[-4000:]
    return data


def mutate(old, new):
    text = target.read_bytes().decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, old
    target.write_bytes(text.replace(old, new).encode('utf-8'))


try:
    pg('init-root'); pg('init'); pg('start')
    env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=pg('urls')['urls']['P03_PG_ADMIN_URL'])
    if '--new-only' in sys.argv:
        # a test-only follow-up: the new module at tip plus the mutants
        run('tip', NEW)
    else:
        run('tip', NEW + EXISTING)
        target.write_bytes(subprocess.check_output(
            ['git', 'show', BASE + ':engine/backend/orgtree/org_summary.py'], cwd=repo))
        run('base', EXISTING)
        target.write_bytes(saved)
    for label, old, new, expected in (
        ('mut-load-all-active-nodes',
         "        if settings.get('kiosk'):\n"
         "            for nid, ordinal, value in raw.execute(\n"
         "                    \"SELECT n.id,n.ord,n.val FROM node_index i JOIN nodes n ON n.id=i.id \"\n"
         "                    \"WHERE i.meta->>'state'<>'archived' AND i.meta->>'parent'='' \"\n",
         "        if True:\n"
         "            for nid, ordinal, value in raw.execute(\n"
         "                    \"SELECT n.id,n.ord,n.val FROM node_index i JOIN nodes n ON n.id=i.id \"\n"
         "                    \"WHERE i.meta->>'state'<>'archived' \"\n",
         ['test_listing_reads_do_not_grow_with_agents']),
        ('mut-no-top-level-filter',
         "\"WHERE i.meta->>'state'<>'archived' AND i.meta->>'parent'='' \"",
         "\"WHERE i.meta->>'state'<>'archived' \"",
         ['test_listing_reads_do_not_grow_with_agents']),
        ('mut-live-counts-unrecoverable',
         "\"SELECT count(*) FROM node_index i WHERE i.meta->>'state'='live'\"",
         "\"SELECT count(*) FROM node_index i WHERE i.meta->>'state'<>'archived'\"",
         ['test_rows_equal_the_full_org_answer_for_every_node_shape']),
        ('mut-kiosk-reads-archived-top-level',
         "\"WHERE i.meta->>'state'<>'archived' AND i.meta->>'parent'='' \"",
         "\"WHERE i.meta->>'parent'='' \"",
         ['test_kiosk_read_skips_retired_top_level_seats']),
    ):
        mutate(old, new)
        run(label, NEW, expected)
        target.write_bytes(saved)
finally:
    target.write_bytes(saved)
    cleanup = pg('stop')
    cleanup['source_restored'] = target.read_bytes() == saved
    provenance.write_result(out / 'cleanup.json', cleanup)
    print('cleanup', json.dumps(cleanup)[:300], flush=True)
