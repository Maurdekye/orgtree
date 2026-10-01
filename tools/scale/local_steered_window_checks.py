"""Owned focused base/tip runs and observed source mutants for the bounded
steered_log chat window (desk-chat-read-loads-the-agent-s-whole-steered-m)."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/steered-window-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE = sys.argv[1]
out = Path('C:/Temp/steered-window-checks-' + sys.argv[2])
out.mkdir()
pgroot = out / 'pg'
tool = 'E:/Libraries/Desktop/orgtree/artifacts/p03-tools/pg-custodian-e4f3c8f.exe'
pgbin = 'E:/Libraries/Desktop/orgtree/artifacts/p03-postgresql/18.6-4/bin'
names = ['engine/backend/orgtree/supervisor.py', 'engine/backend/orgtree/store.py',
         'engine/backend/orgtree/chat_window.py',
         'engine/backend/orgtree/pg_migrations/0016_steered_log_tail.sql']
paths = [repo / n for n in names]
saved = {p: p.read_bytes() for p in paths}
NEW = ['tests/test_chat_steered_window_pg.py']
EXISTING = ['tests/test_chat_window.py', 'tests/test_prompt_view_clock_skew.py',
            'tests/test_reminder_wake_visibility.py', 'tests/test_replay_envelope_segments.py',
            'tests/test_restart_replay_envelope.py', 'tests/test_send_file_seat.py',
            'tests/test_history_retention.py', 'tests/test_live_durable_identity.py',
            'tests/test_manual_inbox.py', 'tests/test_state_material_reads.py',
            'tests/test_client_op.py', 'tests/test_pg_lazy_rows.py']


def pg(action):
    cp = subprocess.run([tool, action, '--root', str(pgroot), '--pg-bin', pgbin],
                        capture_output=True, text=True, timeout=60)
    if cp.returncode:
        raise RuntimeError(cp.stdout + cp.stderr)
    return json.loads(cp.stdout)


def restore():
    for path, raw in saved.items():
        path.write_bytes(raw)


def run(label, modules, expected=None, extra_env=None):
    env = dict(base_env, **(extra_env or {}))
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '400', '--json-output', str(receipt)], cwd=repo, env=env,
                        capture_output=True, text=True, timeout=1000)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    for module in data['modules']:
        assert module['import_provenance'] and module['tests_ran'] > 0, module
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    print(label, [(m.get('module') or m.get('path'), m['tests_ran'], m['exit_code']) for m in data['modules']], flush=True)
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
    base_env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=pg('urls')['urls']['P03_PG_ADMIN_URL'])
    run('tip', NEW + EXISTING)
    run('tip-lazy-rows', NEW, extra_env={'ORGTREE_LAZY_ROWS': '1'})
    for path in paths[:3]:
        path.write_bytes(subprocess.check_output(['git', 'show', BASE + ':' + path.relative_to(repo).as_posix()], cwd=repo))
    paths[3].unlink()   # the migration does not exist at base
    run('base', EXISTING)
    restore()
    supervisor_py, store_py, window_py, migration_sql = paths
    for label, path, old, new, expected in (
        ('mut-huge-store-limit', store_py, '            _LOG_TAIL_SQL, (owner, cap + 1)).fetchall()]',
         '            _LOG_TAIL_SQL, (owner, 10 ** 9)).fetchall()]',
         ['test_server_reads_a_bounded_index_range_at_1x_and_10x']),
        ('mut-order-by-seq-only', store_py,
         r'''"ORDER BY COALESCE(at, '') COLLATE \"C\" DESC, seq DESC LIMIT ?")''',
         '"ORDER BY seq DESC LIMIT ?")', ['test_out_of_order_at_equals_the_full_read']),
        ('mut-no-tail-index', migration_sql,
         "(owner, (COALESCE(at, '''') COLLATE \"C\") DESC, seq DESC)",
         '(owner, seq)', ['test_server_reads_a_bounded_index_range_at_1x_and_10x']),
        ('mut-appends-guard', store_py, '            or section._appends.get(owner)):\n', '            ):\n',
         ['test_unsaved_appends_and_other_sections_use_the_full_path']),
        ('mut-no-window-guard', supervisor_py,
         '        if position is None or position >= len(selected) - cast(int, window):\n            return None\n',
         '        if position is None:\n            return None\n',
         ['test_window_reaching_the_oldest_fetched_steer_falls_back_exactly']),
    ):
        mutate(path, old, new)
        run(label, NEW, expected)
        restore()
finally:
    restore()
    cleanup = pg('stop')
    cleanup['source_restored'] = all(p.read_bytes() == raw for p, raw in saved.items())
    provenance.write_result(out / 'cleanup.json', cleanup)
    print('cleanup', json.dumps(cleanup)[:300], flush=True)
