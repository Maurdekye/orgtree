"""Disposable C: PG lifetime for targeted docket transport checks and costs."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/scale'))
from control import free_commit_gb, guarded_wait

label = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
base = Path(os.environ['TEMP']).resolve() / 'scale-ui-astra' / ('ui-transport-' + label)
pgroot, root = base / 'pg', base / 'seed'
packet = REPO / '.scale-results' / ('ui-transport-' + label)
packet.mkdir(parents=True)
base.mkdir(parents=True)
custodian = r'E:\Libraries\Desktop\orgtree\artifacts\p03-tools\pg-custodian-e4f3c8f.exe'
pgbin = r'E:\Libraries\Desktop\orgtree\artifacts\p03-postgresql\18.6-4\bin'


def pg(action):
    result = subprocess.run([custodian, action, '--root', str(pgroot), '--pg-bin', pgbin],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('private PG ' + action + ' failed; credentials withheld')
    return json.loads(result.stdout)


def run(name, command, env=None, expected=0):
    assert free_commit_gb() >= 10
    with (packet / (name + '.log')).open('w', encoding='utf-8') as log:
        child = subprocess.Popen(command, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
        guarded_wait(child, floor_gb=10, report=packet / (name + '-guard.json'))
    assert child.returncode == expected, (name, child.returncode)


def verify(name, modules, env=None, expected=0):
    receipt = packet / (name + '.json')
    run(name, [sys.executable, 'tools/run-python-verification.py', '--pycache-dir', 'off',
               *modules, '--json-output', str(receipt)], env, expected)
    data = json.loads(receipt.read_text(encoding='utf-8'))
    for module in data['modules']:
        assert module['tests_ran'] > 0 and module['import_provenance'], module
        assert '\nOK (skipped' not in module['stderr'], module
    return data


source = {}
for name in ('ui_transport_probe.py', 'ui_transport_probe_run.py', 'seed.py', 'launch_guard.py', 'control.py'):
    path = REPO / 'tools/scale' / name
    shutil.copyfile(path, packet / name)
    source[name] = hashlib.sha256(path.read_bytes()).hexdigest()
(packet / 'source-sha256.json').write_text(json.dumps(source, indent=2))
started = False
try:
    assert free_commit_gb() >= 10
    pg('init-root'); pg('init'); pg('start'); started = True
    admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
    env = dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=admin)
    verify('new-controls', ['tests/test_work_ui.py', 'tests/test_pg_work_ui.py'], env)
    target = REPO / 'engine/backend/orgtree/work_ui.py'
    original = target.read_bytes()
    mutants = [
        ('constant-stamp', b'current = stamp(slug)', b'current = "mutant"', ['tests/test_pg_work_ui.py']),
        ('late-stamp', b'body = _build(slug)', b'body = _build(slug)\n            current = stamp(slug)', ['tests/test_work_ui.py']),
        ('ignore-group', b'("a" if archived else "n") + ("b" if backlogged else "n")', b'"nn"', ['tests/test_work_ui.py']),
    ]
    controls = []
    try:
        for name, old, new, modules in mutants:
            assert original.count(old) == 1, name
            target.write_bytes(original.replace(old, new))
            result = verify('mutant-' + name, modules, env, expected=1)
            failed = [m['stderr'] for m in result['modules'] if m['phase'] != 'pass']
            assert failed and all('FAIL:' in log and 'AssertionError' in log for log in failed), failed
            controls.append({'name': name, 'caught': failed})
    finally:
        target.write_bytes(original)
    (packet / 'mutants.json').write_text(json.dumps(controls, indent=2))
    seed_env = dict(os.environ, P03_PG_ADMIN_URL=admin)
    run('seed', [sys.executable, '-B', 'tools/scale/seed.py', '--root', str(root), '--agents', '100'], seed_env)
    run('probe', [sys.executable, '-B', 'tools/scale/ui_transport_probe.py', '--root', str(root), '--output', str(packet / 'probe.json')])
    print(str(packet), flush=True)
finally:
    if started:
        pg('stop')
    (packet / 'cleanup.json').write_text(json.dumps({'private_pg_stopped': started,
        'base': str(base), 'no_http_engine': True}))
