"""Owned focused base/tip runs and mutants for
work-items-header-row-mismatch-valueerror-under (a docket write committed
mid-load is re-read, never raised to the caller).
Usage: local_work_refs_race_checks.py <base sha> <tag> <phase>
phases: tip, base (the CHANGED files at <base>; the new module runs against
the base store to show the failure), mutants."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/work-refs-race-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/work-refs-race-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP = ['tests/test_work_refs_snapshot_pg.py', 'tests/test_pg_lazy_work_items.py',
         'tests/test_pg_work_index.py', 'tests/test_pg_work_item_rows.py',
         'tests/test_pg_work_list_meta.py', 'tests/test_pg_work_query.py',
         'tests/test_pg_work_read.py', 'tests/test_pg_work_ui.py',
         'tests/test_pgimport_work_rows.py', 'tests/test_work_item_rows.py',
         'tests/test_pg_lazy_rows.py', 'tests/test_pgstore.py']
CHANGED = ['engine/backend/orgtree/store.py', 'tests/test_pg_lazy_work_items.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-race-raises', 'engine/backend/orgtree/store.py',
     '        _work_race_count("relisted")\n',
     '        raise ValueError("work-items header/row count or identity mismatch")\n',
     'test_a_create_between_header_and_listing_loads_the_new_docket'),
    ('mut-relist-keeps-stale-header', 'engine/backend/orgtree/store.py',
     '    rows.pop(workrows.SECTION, None)\n    if got[0] is not None:\n        rows[workrows.SECTION] = got[0]\n',
     '    pass\n',
     'test_a_create_between_header_and_listing_loads_the_new_docket'),
    ('mut-fetch-race-ignored', 'engine/backend/orgtree/store.py',
     '                raise _WorkRefsRace("work item changed during lazy baseline acquisition")\n',
     '                pass\n',
     'test_an_update_before_the_body_fetch_loads_the_new_version'),
    ('mut-no-whole-fallback', 'engine/backend/orgtree/store.py',
     '        _work_race_count("whole")\n    _load_work_rows_whole(conn, rows)\n',
     '        _work_race_count("whole")\n    raise StaleWrite("work items changed while reading transaction baselines")\n',
     'test_churn_on_every_fetch_falls_back_to_one_whole_read'),
    ('mut-step2-keeps-old-rows', 'engine/backend/orgtree/store.py',
     '    _drop_work_rows(rows)\n    got = conn.execute(_WORK_HEADER_LISTING_SQL',
     '    got = conn.execute(_WORK_HEADER_LISTING_SQL',
     'test_step2_drops_a_ref_bound_before_the_race'),
    ('mut-whole-read-keeps-old-rows', 'engine/backend/orgtree/store.py',
     '    _drop_work_rows(rows)\n    rows.pop(workrows.SECTION, None)\n    for key, raw in got:',
     '    rows.pop(workrows.SECTION, None)\n    for key, raw in got:',
     'test_the_whole_read_drops_a_ref_bound_in_step2'),
    ('mut-corruption-not-raised', 'engine/backend/orgtree/store.py',
     '        if coherent:\n            raise ValueError(what)\n',
     '',
     'test_a_missing_item_row_still_raises'),
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
            logs = run(label, ['tests/test_work_refs_snapshot_pg.py'])
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
