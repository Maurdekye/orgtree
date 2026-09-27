"""Own one N10 PG/server/load/renderer lifecycle; run under the exclusive p03 slot.

The parent imports no product modules. Seed/server/prepare children carry the
repository import guard after installing their disposable environment.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / 'tools/scale'))
from control import free_commit_gb
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--build', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--archive-multiplier', type=int, default=1)
args = parser.parse_args()
packet = args.output.resolve()
packet.mkdir(parents=True, exist_ok=False)
allowed = Path(r'C:\Users\ncola_k8bx\AppData\Local\Temp\n1-review-astra').resolve()
base = allowed / ('fixture-' + time.strftime('%Y%m%d-%H%M%S'))
base.mkdir(parents=True, exist_ok=False)
pgroot, root, paint = base / 'pg', base / 'seed', base / 'paint'
custodian = r'E:\Libraries\Desktop\orgtree\artifacts\p03-tools\pg-custodian-e4f3c8f.exe'
pgbin = r'E:\Libraries\Desktop\orgtree\artifacts\p03-postgresql\18.6-4\bin'
processes, logs, breaches = [], [], []
done = threading.Event()
started_pg = False

def save(name, value):
    (packet / name).write_text(json.dumps(value, indent=2), encoding='utf8')

def stop(child):
    if child.poll() is not None:
        return
    try:
        parent = psutil.Process(child.pid)
        family = parent.children(recursive=True) + [parent]
        for process in family:
            try: process.terminate()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(family, timeout=5)
        for process in alive:
            try: process.kill()
            except psutil.NoSuchProcess: pass
        psutil.wait_procs(alive, timeout=5)
        child.wait(timeout=10)
    except psutil.NoSuchProcess:
        pass

def guard():
    while not done.wait(1):
        try:
            free = free_commit_gb()
            if free < 10: raise RuntimeError('free commit below10GiB')
            if (root / 'metrics/qualification-invalid.json').exists():
                raise RuntimeError('unexpected provider attempt invalidated fixture')
        except Exception as error:
            breaches.append(str(error))
            for child in reversed(processes): stop(child)
            return

def check():
    if breaches: raise RuntimeError(str(breaches))

def launch(name, argv, env=None):
    check()
    log = (packet / (name + '.log')).open('w', encoding='utf8')
    logs.append(log)
    child = subprocess.Popen(argv, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append(child)
    return child

def wait(child, timeout=300, allow_failure=False):
    deadline = time.monotonic() + timeout
    while child.poll() is None:
        check()
        if time.monotonic() > deadline: raise RuntimeError('owned child exceeded deadline')
        time.sleep(.2)
    check()
    if child.returncode and not allow_failure: raise RuntimeError(f'child exit{child.returncode}; see retained log')
    return child.returncode

def pg(action):
    # Do not log URLs or credentials. This custodian only owns our newly created root.
    result = subprocess.run([custodian, action, '--root', str(pgroot), '--pg-bin', pgbin],
                            capture_output=True, text=True, timeout=180)
    if result.returncode: raise RuntimeError('private PG ' + action + ' failed')
    return json.loads(result.stdout)

def descriptor():
    try: return json.loads((root / 'scale-descriptor.json').read_text(encoding='utf8'))
    except (FileNotFoundError, json.JSONDecodeError, PermissionError): return {}

guard_thread = threading.Thread(target=guard, daemon=True)
guard_thread.start()
try:
    if free_commit_gb() < 10: raise RuntimeError('insufficient headroom')
    # This command must only be used after the standalone compositor check passed.
    build = json.loads((args.build / 'build.json').read_text())
    save('source.json', dict(build=build, workload='queued-mail; provider launches forbidden', agents=10))
    pg('init-root'); pg('init'); started_pg = True; pg('start')
    admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
    wait(launch('seed', [sys.executable, '-I', '-B', str(REPO / 'tools/scale/seed.py'),
        '--root', str(root), '--agents', '10', '--admin-url', admin]))
    wait(launch('prepare', [sys.executable, '-I', '-B', str(Path(__file__).with_name('prepare.py')), '--root', str(root),
        '--archive-multiplier', str(args.archive_multiplier)]))
    shutil.copy2(root / 'prepared.json', packet / 'prepared.json')
    server = launch('server', [sys.executable, '-I', '-B', str(REPO / 'tools/scale/serve.py'),
        '--root', str(root), '--env', 'ORGTREE_SCALE_ASSERT_NO_TURNS=1', '--env', 'ORGTREE_SCALE_TRACE_GIT=1'])
    deadline = time.monotonic() + 180
    while descriptor().get('serve', {}).get('state') != 'ready':
        check()
        if server.poll() is not None or time.monotonic() > deadline: raise RuntimeError('engine readiness failed')
        time.sleep(.5)
    desc = descriptor()
    if desc['serve']['pid'] not in [p.pid for p in psutil.Process(server.pid).children(recursive=True)]:
        raise RuntimeError('engine PID is not owned by fixture')
    # Declared warmup only; load and renderer have their own complete receipts.
    for _ in range(10): check(); time.sleep(1)
    load = launch('load', [sys.executable, '-I', '-B', str(REPO / 'tools/scale/load.py'), '--root', str(root),
        '--duration', '120', '--rate', '2', '--steer-rate', '3.9', '--windows', '1', '--stream-nodes', '1',
        '--stream-hz', '4', '--max-engine-gb', '6', '--min-free-commit-gb', '10', '--label', 'renderer'])
    config = root / 'metrics/renderer/config.json'
    deadline = time.monotonic() + 60
    while not config.exists() or not descriptor().get('load', {}).get('running'):
        check()
        if load.poll() is not None or time.monotonic() > deadline: raise RuntimeError('load did not start')
        time.sleep(.2)
    # Socket startup resets config.started; wait for proven completed demand.
    calls = root / 'metrics/renderer/calls.jsonl'
    while not calls.exists() or calls.stat().st_size == 0:
        check()
        if load.poll() is not None or time.monotonic() > deadline: raise RuntimeError('load did not do work')
        time.sleep(.2)
    renderer = launch('renderer', ['node', str(REPO / 'tools/scale/renderer-paint.mjs'), 'run', '--build', str(args.build),
        '--descriptor', str(root / 'scale-descriptor.json'), '--label', 'renderer', '--output', str(paint), '--seconds', '15', '--repeats', '3'])
    renderer_code = wait(renderer, 240, allow_failure=True)
    if renderer_code: raise RuntimeError('renderer smoke incomplete; preserved raw artifacts')
    load_code = wait(load, 240, allow_failure=True)
    report = launch('report', ['node', str(REPO / 'tools/scale/renderer-paint.mjs'), 'report', '--output', str(paint)])
    report_code = wait(report, 30, allow_failure=True)
    save('result.json', dict(renderer_exit=renderer_code, load_exit=load_code, report_exit=report_code))
    if load_code or report_code: raise RuntimeError('measurement invalid; consult report')
finally:
    for child in reversed(processes): stop(child)
    done.set();guard_thread.join(timeout=5)
    for log in logs: log.close()
    stopped = False
    if started_pg:
        pg('stop');stopped = True
    # Retain measurement evidence, never descriptors/credentials or browser profile.
    if paint.exists():
        (packet / 'paint').mkdir(exist_ok=True)
        for source in paint.iterdir():
            if source.is_file(): shutil.copy2(source, packet / 'paint' / source.name)
    if (root / 'metrics/renderer').exists():
        shutil.copytree(root / 'metrics/renderer', packet / 'load', dirs_exist_ok=True)
    for name in ('serve-guard.json', 'qualification-invalid.json', 'serve-refused.jsonl', 'git-reads.jsonl'):
        source = root / 'metrics' / name
        if source.exists(): shutil.copy2(source, packet / name)
    # Resolve absolute target before deletion, including possible junctions.
    resolved = base.resolve()
    if resolved.parent != allowed or not resolved.name.startswith('fixture-'):
        raise RuntimeError('cleanup path escaped authorized temp parent')
    if started_pg and not stopped: raise RuntimeError('refusing to delete running PG root')
    shutil.rmtree(resolved)
    save('cleanup.json', dict(base=str(resolved), removed=not resolved.exists(), pg_stopped=stopped, guard_breaches=breaches))
