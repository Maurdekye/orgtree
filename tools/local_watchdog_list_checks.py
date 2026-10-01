"""Owned focused base/tip runs and mutants for
orgtree-watchdog-list-pays-the-managed-wait-jour (a watchdog `list` takes the
ordinary agent-call path, not toolwait's managed-wait journal).
Usage: local_watchdog_list_checks.py <base sha> <tag> <phase>
phases: tip, base (the CHANGED files at <base>), mutants."""
import json
import os
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/watchdog-list-checks-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/watchdog-list-checks-' + sys.argv[2]) / PHASE
out.mkdir(parents=True)
NEW = 'tests/test_watchdog_list_unmanaged.py'
GROUP = [NEW, 'tests/test_s10_watchdog_route.py', 'tests/test_pg3c_watchdog_tx.py',
         'tests/test_pg3c_kiosk_exempt.py', 'tests/test_write_route_timing.py',
         'tests/test_operation_census.py', 'tests/test_send_file_seat.py',
         'tests/test_agent_continue_on.py', 'tests/test_state_requests_boundary.py',
         'tests/test_p02_operation_contacts.py', 'tests/test_state_p02_contact_facets.py']
CHANGED = ['engine/backend/orgtree/api.py', 'engine/backend/orgtree/toolwait.py',
           'tests/test_p02_operation_contacts.py', 'tests/test_watchdog_list_unmanaged.py',
           'tests/test_operation_census.py']
saved = {f: (repo / f).read_bytes() for f in CHANGED}
API, TW = CHANGED[:2]

MUTANTS = [
    # the ticket's mutant: list back on the managed path
    ('mut-gate-by-tool-name', API,
     "    if body.node != USER and toolwait.managed_call(body):",
     "    if body.node != USER and toolwait.tool_name(body) in toolwait.TOOLS:",
     'test_list_skips_the_journal_and_pause_still_uses_it'),
    ('mut-keyed-not-unwrapped', TW,
     "        args = args.get('args') if isinstance(args.get('args'), dict) else {}\n",
     "        pass  # not unwrapped\n",
     'test_keyed_list_is_judged_by_the_call_it_wraps'),
    ('mut-pause-counted-a-read', TW,
     "READ_ACTIONS = {'orgtree_watchdog': frozenset({'list'})}",
     "READ_ACTIONS = {'orgtree_watchdog': frozenset({'list', 'pause'})}",
     'test_list_skips_the_journal_and_pause_still_uses_it'),
    ('mut-case-folded-action', TW,
     "    return str(args.get('action') or '') not in READ_ACTIONS.get(name, ())",
     "    return str(args.get('action') or '').lower() not in READ_ACTIONS.get(name, ())",
     'test_every_other_watchdog_action_stays_managed'),
]


def run(label, modules):
    receipt = out / (label + '.json')
    cp = subprocess.run([sys.executable, 'tools/run-python-verification.py', *modules,
                         '--timeout', '600', '--json-output', str(receipt)], cwd=repo,
                        capture_output=True, text=True, timeout=1150)
    data = json.loads(receipt.read_text())
    logs = '\n'.join(m['stderr'] for m in data['modules'])
    (out / (label + '.log')).write_text(cp.stdout + cp.stderr + '\n' + logs, encoding='utf-8')
    for m in data['modules']:
        assert m['import_provenance'] or m.get('phase') == 'execution_failure', m
        print(label, m.get('module') or m.get('path'), m['tests_ran'], m['exit_code'], flush=True)
    return logs


def mutate(path, old, new):
    text = saved[path].decode('utf-8')
    old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, old
    (repo / path).write_bytes(text.replace(old, new).encode('utf-8'))


try:
    if PHASE == 'base':
        for f in CHANGED:
            (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
    if PHASE in ('tip', 'base'):
        # one module per call (the coordinator's small-run rule)
        for mod in GROUP:
            run(PHASE + '-' + Path(mod).stem, [mod])
    elif PHASE in ('latency-tip', 'latency-base'):
        if PHASE == 'latency-base':
            for f in CHANGED[:2]:
                (repo / f).write_bytes(subprocess.check_output(['git', 'show', f'{BASE}:{f}'], cwd=repo))
        cp = subprocess.run([sys.executable, 'tools/local_watchdog_list_latency.py',
                             str(out / 'latency.json')], cwd=repo, capture_output=True,
                            text=True, timeout=900)
        (out / 'latency.log').write_text(cp.stdout + cp.stderr, encoding='utf-8')
        print(PHASE, cp.returncode, cp.stdout.strip()[-600:], flush=True)
    elif PHASE == 'mutants':
        for label, path, old, new, expected in MUTANTS:
            mutate(path, old, new)
            logs = run(label, [NEW])
            caught = ('FAIL: ' + expected in logs) or ('ERROR: ' + expected in logs)
            print(label, 'CAUGHT' if caught else 'SURVIVED', flush=True)
            (repo / path).write_bytes(saved[path])
finally:
    for f, data in saved.items():
        (repo / f).write_bytes(data)
    restored = all((repo / f).read_bytes() == d for f, d in saved.items())
    provenance.write_result(out / 'cleanup.json', {'source_restored': restored})
    print('source_restored', restored, flush=True)
