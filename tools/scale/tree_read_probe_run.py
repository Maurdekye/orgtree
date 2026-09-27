"""Own private NVMe PG/seed lifetime for the bounded UI route-cost probe."""
import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/scale'))
from control import free_commit_gb, guarded_wait

p = argparse.ArgumentParser()
p.add_argument('--reuse-base', type=Path)
args = p.parse_args()
label = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
allowed = (Path(os.environ['TEMP']) / 'scale-ui-astra').resolve()
base = args.reuse_base.resolve() if args.reuse_base else allowed / ('tree-read-' + label)
assert base.parent == allowed and base.name.startswith('tree-read-')
root = base / 'seed'
pgroot = base / 'pg'
packet = REPO / '.scale-results' / ('tree-read-' + label)
packet.mkdir(parents=True, exist_ok=False)
if not args.reuse_base:
    base.mkdir(parents=True, exist_ok=False)
custodian = r'E:\Libraries\Desktop\orgtree\artifacts\p03-tools\pg-custodian-e4f3c8f.exe'
pgbin = r'E:\Libraries\Desktop\orgtree\artifacts\p03-postgresql\18.6-4\bin'
source = {}
for name in ('tree_read_probe.py', 'tree_read_probe_run.py', 'seed.py', 'tree_probe_prepare.py', 'launch_guard.py', 'control.py'):
    file = REPO / 'tools/scale' / name
    shutil.copyfile(file, packet / name)
    source[name] = hashlib.sha256(file.read_bytes()).hexdigest()
(packet / 'source-sha256.json').write_text(json.dumps(source, indent=2))


def pg(action):
    done = subprocess.run([custodian, action, '--root', str(pgroot), '--pg-bin', pgbin],
                          capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError('private PG ' + action + ' failed; credentials withheld')
    return json.loads(done.stdout)


def run(name, argv, env=None):
    assert free_commit_gb() >= 10
    with (packet / (name + '.log')).open('w', encoding='utf-8') as output:
        child = subprocess.Popen(argv, cwd=REPO, env=env, stdout=output, stderr=subprocess.STDOUT)
        guarded_wait(child, floor_gb=10, report=packet / (name + '-guard.json'))
    if child.returncode:
        raise RuntimeError(name + ' failed; see preserved log')


started = False
try:
    assert free_commit_gb() >= 10
    if not args.reuse_base:
        pg('init-root')
        pg('init')
    pg('start')
    started = True
    admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
    if args.reuse_base:
        descriptor_path = root / 'scale-descriptor.json'
        descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
        current = urlsplit(admin)
        descriptor['pg_url'] = urlunsplit((current.scheme, current.netloc,
            '/' + descriptor['pg_database'], current.query, current.fragment))
        descriptor_path.write_text(json.dumps(descriptor), encoding='utf-8')
    if not args.reuse_base:
        env = dict(os.environ, P03_PG_ADMIN_URL=admin)
        run('seed', [sys.executable, '-B', 'tools/scale/seed.py', '--root', str(root), '--agents', '100'], env)
        run('prepare', [sys.executable, '-B', 'tools/scale/tree_probe_prepare.py', '--root', str(root)])
    run('probe', [sys.executable, '-B', 'tools/scale/tree_read_probe.py', '--root', str(root),
                  '--output', str(packet / 'probe.json')])
    print(str(packet), flush=True)
finally:
    if started:
        pg('stop')
    (packet / 'cleanup.json').write_text(json.dumps(dict(private_pg_stopped=started,
        base=str(base), note='No HTTP engine started; child processes exited before PG stop.')))
