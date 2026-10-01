"""Owned focused base/tip runs and mutants for
transcript-capture-source-view-falls-back-to-a-f (a node's first capture uses
the bounded source view, not the whole org).
Usage: local_source_view_checks.py <base sha> <tag> <phase>
phases: tip, base (the CHANGED files at <base>), mutants."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/source-view-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/source-view-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
GROUP = ['tests/test_transcript_ingest.py', 'tests/test_transcript_ingest_pg.py',
         'tests/test_claude_pipe_lifecycle.py', 'tests/test_freeze_classification.py',
         'tests/test_live_effort.py', 'tests/test_mail_runtime_reclaim.py',
         'tests/test_provider_attempt_and_liveness.py', 'tests/test_restart_replay_turnlog.py',
         'tests/test_s6_fable_wall_turn.py', 'tests/test_turn_end_stamp.py',
         'tests/test_turn_locals_org_copies.py', 'tests/test_turn_org_state_shared.py']
CHANGED = ['engine/backend/orgtree/transcript_ingest.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}


MUTANTS = [
    ('mut-fallback-when-unminted', 'engine/backend/orgtree/transcript_ingest.py',
     "    if doc is not None:\n        return _SourceView(doc)\n",
     "    if doc is not None and doc['nodes'][nid].get('transcript_incarnation'):\n        return _SourceView(doc)\n",
     'test_an_unminted_node_is_captured_without_any_whole_org_load'),
    ('mut-missing-node-loads-whole', 'engine/backend/orgtree/transcript_ingest.py',
     "    if store.node_row_exists(slug, nid) is False:\n        return None\n",
     "",
     'test_a_missing_node_is_nothing_to_capture'),
    ('mut-blob-root-returns-nothing', 'engine/backend/orgtree/transcript_ingest.py',
     "    return store.cached_org(slug)\n\n\ndef capture(",
     "    return None\n\n\ndef capture(",
     'test_a_root_the_bounded_read_cannot_answer_still_uses_the_whole_org'),
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
        # a module that timed out has no provenance record: report it, do not
        # abandon the other modules (a run with it missing is still no verdict
        # for that module)
        assert m['import_provenance'] or m.get('phase') == 'execution_failure', m
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
            logs = run(label, ['tests/test_transcript_ingest.py'])
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
