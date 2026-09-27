"""One default-ON N100 baseline; exact 08d0e08 engine/apps plus observer code."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / 'tools/scale'))
from control import free_commit_gb
from switch_audit import audit_for, unexpected
import httpx
import psutil

p = argparse.ArgumentParser()
p.add_argument('--duration', type=int, default=180)
p.add_argument('--agents', type=int, default=100)
p.add_argument('--label', default='loaded')
p.add_argument('--arm', choices=('off0', 'both'))
p.add_argument('--outdir', type=Path)
args = p.parse_args()
base = Path(r'C:\Users\ncola_k8bx\AppData\Local\Temp\scale-ui-astra\switch-qualification')
pgroot = base / 'pg'
custodian = r'E:\Libraries\Desktop\orgtree\artifacts\p03-tools\pg-custodian-e4f3c8f.exe'
pgbin = r'E:\Libraries\Desktop\orgtree\artifacts\p03-postgresql\18.6-4\bin'
outdir = args.outdir.resolve() if args.outdir else repo / '.scale-results' / ('ui-baseline-' + time.strftime('%Y%m%d-%H%M%S'))
if args.outdir and (not args.arm or outdir.parent != (repo / '.scale-results').resolve()):
    raise RuntimeError('resume requires one arm and an existing local evidence packet')
outdir.mkdir(parents=True, exist_ok=bool(args.outdir))
product = '08d0e0816500add001b3fa5e37a8b64bc37d479d'
subprocess.run(['git', 'diff', '--exit-code', product, '--', 'engine', 'apps'], cwd=repo, check=True)
capsule = outdir/'harness'
capsule.mkdir()
manifest = {}
for source in (list((repo/'tools/scale').glob('*.py')) + [repo/'tests/test_scale_write_oracle.py']):
    if source.name.startswith(('switch_', 'ui_baseline', 'write_oracle', 'test_scale_write')) or source.name in (
            'load.py', 'serve.py', 'seed.py', 'launch_guard.py', 'control.py', 'ui_mix.py', 'simulated.py'):
        shutil.copyfile(source, capsule/source.name)
        manifest[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
(capsule/'sha256.json').write_text(json.dumps(manifest, indent=2))
(capsule/'identity.json').write_text(json.dumps({'product': product,
    'driver_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
    'product_tree_equal': True, 'default_switches': True}, indent=2))
if args.arm and (outdir/(args.arm+'-identity.json')).exists():
    raise RuntimeError('refusing to overwrite a completed arm identity')
procs = []
halt_guard = threading.Event()
breach = []
engine = [None]
current_root = [None]
def stop(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        parent = psutil.Process(proc.pid)
        family = parent.children(recursive=True) + [parent]
        for member in reversed(family):
            try: member.terminate()
            except psutil.NoSuchProcess: pass
        _, alive = psutil.wait_procs(family, timeout=10)
        for member in alive:
            member.kill()
        psutil.wait_procs(alive, timeout=10)
        proc.wait(timeout=10)
    except psutil.NoSuchProcess:
        pass
def guard():
    while not halt_guard.wait(1):
        try:
            free = free_commit_gb()
            reason = 'free commit below10GiB' if free < 10 else None
            if engine[0]:
                try:
                    info = engine[0].memory_info()
                    if getattr(info, 'private', info.rss) > 6 * 2**30:
                        reason = 'engine private bytes above6GiB'
                    cpu = engine[0].cpu_times()
                    with (current_root[0]/'metrics'/'independent-samples.jsonl').open('a',encoding='utf8') as log:
                        log.write(json.dumps(dict(at=time.time(), pid=engine[0].pid, cpu_s=cpu.user+cpu.system,
                            free_commit_gb=free, private=getattr(info,'private',info.rss)))+'\n')
                except psutil.NoSuchProcess: pass
            if current_root[0]:
                audit = current_root[0]/'metrics'/'serve-refused.jsonl'
                if audit.exists():
                    classifier = audit_for(current_root[0])
                    for line in audit.read_text(encoding='utf8').splitlines():
                        entry = json.loads(line)
                        if unexpected(classifier, entry):
                            reason = 'non-capability external-program attempt in isolated engine'
                            break
            if reason:
                raise RuntimeError(reason)
        except Exception as exc:
            breach.append(str(exc))
            for proc in reversed(procs): stop(proc)
            return
def check():
    if breach: raise RuntimeError(breach)
def run(command, log, *, allow_verdict_failure=False, **kwargs):
    check()
    with log.open('w', encoding='utf8') as output:
        proc = subprocess.Popen(command, cwd=repo, stdout=output, stderr=subprocess.STDOUT, **kwargs)
        procs.append(proc)
        start = time.monotonic()
        while proc.poll() is None:
            check()
            if time.monotonic()-start > 600: raise RuntimeError('child exceeded600s')
            time.sleep(1)
    check()
    if proc.returncode and not (allow_verdict_failure and proc.returncode == 2):
        raise RuntimeError(f'child exit{proc.returncode}: {log}')
    return proc.returncode
def pg(action):
    # No timeout: custodian recovery may need minutes. Never emit its URL response.
    cp = subprocess.run([custodian, action, '--root', str(pgroot), '--pg-bin', pgbin],
                        capture_output=True, text=True)
    if cp.returncode: raise RuntimeError('custodian ' + action + ' failed')
    return json.loads(cp.stdout)
def call(desc, route):
    with httpx.Client(timeout=120, headers={'X-Orgtree-Desktop-Token': desc['token']}) as client:
        return client.get(desc['origin'] + route).raise_for_status().json()
def assert_activity(desc, enabled):
    activity = call(desc, '/scale/activity')
    launches = activity.pop('launch_attempts')
    assert launches['unexpected'] == 0, launches
    assert activity == dict(started=0, finished=0, rescope=enabled, steer_cheap=enabled,
                            transition_fence=False, pgdoor=True, inline=False), activity
    activity['launch_attempts'] = launches
    return activity
def save(path, data):
    path.write_text(json.dumps(data, indent=2), encoding='utf8')
guard_thread = threading.Thread(target=guard, daemon=True)
guard_thread.start()
started_pg = False
arms = json.loads((outdir/'arms.json').read_text()) if (outdir/'arms.json').exists() else {}
try:
    if free_commit_gb() < 10: raise RuntimeError('insufficient headroom')
    if not pgroot.exists():
        base.mkdir(parents=True,exist_ok=True)
        pg('init-root'); pg('init')
    pg('start'); started_pg = True
    admin = pg('urls')['urls']['P03_PG_ADMIN_URL']
    # Qualify the changed independent oracle before measuring; no engine yet.
    receipt = outdir/'oracle-controls.json'
    run([sys.executable, 'tools/run-python-verification.py', '--pycache-dir', 'off',
         'tests/test_scale_write_oracle.py', '--json-output', str(receipt)],
        outdir/'oracle-controls.log', env=dict(os.environ, ORGTREE_TEST_PG_ADMIN_URL=admin))
    proof = json.loads(receipt.read_text())
    assert proof['modules'][0]['tests_ran'] == 6 and proof['modules'][0]['import_provenance']
    assert 'skipped' not in proof['modules'][0]['stderr'].split('OK')[-1]
    stamp = time.strftime('%Y%m%d-%H%M%S')
    for name, enabled in [('both', True)]:
        if args.arm and name != args.arm:
            continue
        root = base / (f'n{args.agents}-{stamp}-{name}')
        current_root[0] = root
        print('seed', name, flush=True)
        run([sys.executable, str(repo/'tools/scale/seed.py'), '--root', str(root), '--agents', str(args.agents),
             '--admin-url', admin], outdir/(name+'-seed.log'))
        print('prepare', name, flush=True)
        run([sys.executable, str(repo/'tools/scale/switch_prepare.py'), '--root', str(root)],
            outdir/(name+'-prepare.log'))
        prepared = json.loads((root/'prepared.json').read_text())
        server_log = (outdir/(name+'-server-parent.log')).open('w', encoding='utf8')
        server = subprocess.Popen([sys.executable, '-u', str(repo/'tools/scale/serve.py'), '--root', str(root),
            '--env', 'ORGTREE_SCALE_ASSERT_NO_TURNS=1'], cwd=repo, stdout=server_log, stderr=subprocess.STDOUT)
        procs.append(server)
        try:
            begin = last = time.monotonic()
            while True:
                check()
                if server.poll() is not None: raise RuntimeError('engine exited before ready')
                try: desc = json.loads((root/'scale-descriptor.json').read_text())
                except (json.JSONDecodeError, PermissionError): time.sleep(1); continue
                if desc.get('serve', {}).get('state') == 'ready':
                    ids = {c.pid for c in psutil.Process(server.pid).children(recursive=True)}
                    assert desc['serve']['pid'] in ids
                    engine[0] = psutil.Process(desc['serve']['pid'])
                    break
                if time.monotonic()-begin > 600: raise RuntimeError('readiness exceeded600s')
                if time.monotonic()-last > 20:
                    print('waiting readiness', name, flush=True); last=time.monotonic()
                time.sleep(1)
            print('warm', name, flush=True)
            observer_log=(outdir/(name+'-pg-observer.log')).open('w',encoding='utf8')
            observer=subprocess.Popen([sys.executable,str(repo/'tools/scale/switch_pg_activity.py'),
                '--root',str(root)],cwd=repo,stdout=observer_log,stderr=subprocess.STDOUT)
            procs.append(observer)
            for _ in range(60): check(); time.sleep(1)
            before = assert_activity(desc, enabled)
            assert not any(key in desc['serve']['env_orgtree'] for key in (
                'ORGTREE_ORGTX_RESCOPE', 'ORGTREE_STEER_CHEAP', 'ORGTREE_SCALE_SIMULATED_PROVIDER'))
            # No credentials in copied evidence.
            save(outdir/(name+'-identity.json'), dict(root=str(root), commit=desc['engine_commit'],
                serve=desc['serve'], prepared=prepared, activity=before, seed=desc['seed']['summary']))
            client_log = (outdir/(name+'-load.log')).open('w', encoding='utf8')
            print('load', name, flush=True)
            client = subprocess.Popen([sys.executable, '-u', str(repo/'tools/scale/load.py'), '--root', str(root),
                '--duration', str(args.duration), '--rate', '2', '--steer-rate', '3.9', '--windows', '4',
                '--stream-nodes', '5', '--stream-hz', '8', '--max-engine-gb', '6', '--min-free-commit-gb', '10',
                '--label', args.label], cwd=repo, stdout=client_log, stderr=subprocess.STDOUT)
            procs.append(client)
            begin = last = time.monotonic()
            profiling = False
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                futures = {}
                while client.poll() is None:
                    check()
                    elapsed = time.monotonic()-begin
                    if elapsed > 60 and not profiling:
                        profiling = True
                        for route in ('stacks', 'threadcpu'):
                            futures[route] = executor.submit(call, desc, f'/scale/{route}?seconds=20')
                    if elapsed > args.duration+180: raise RuntimeError('load exceeded drain limit')
                    if time.monotonic()-last > 20:
                        print('load running', name, round(elapsed), flush=True); last=time.monotonic()
                    time.sleep(1)
                for route, future in futures.items(): save(outdir/(name+'-'+route+'.json'), future.result())
            client_log.close()
            save(outdir/(name+'-activity.json'), assert_activity(desc, enabled))
            code = client.returncode
            (root/'metrics'/'stop-pg-observer').touch()
            observer.wait(timeout=10)
            observer_log.close()
            if observer.returncode: raise RuntimeError('PG observer failed')
        finally:
            engine[0] = None
            for proc in reversed(procs): stop(proc)
            server_log.close()
        print('storage check', name, flush=True)
        run([sys.executable, str(repo/'tools/scale/switch_oracle_final.py'), '--root', str(root), '--label', args.label],
            outdir/(name+'-oracle.log'), allow_verdict_failure=True)
        metrics = root/'metrics'/args.label
        summary = json.loads((metrics/'summary.json').read_text())
        stored = json.loads((metrics/'stored-writes.json').read_text())
        save(outdir/(name+'-summary.json'), summary)
        save(outdir/(name+'-stored.json'), stored)
        arms[name] = dict(root=str(root), client_exit=code, summary=summary, stored=stored)
        save(outdir/'arms.json', arms)
        print('arm complete', name, 'exit', code, 'stored', stored['passed'], flush=True)
    save(outdir/'baseline-input.json', dict(arms=arms,
        product='08d0e0816500add001b3fa5e37a8b64bc37d479d', only_default_on=True))
    print('baseline complete', str(outdir), flush=True)
finally:
    for proc in reversed(procs): stop(proc)
    halt_guard.set(); guard_thread.join(timeout=5)
    if started_pg: pg('stop'); print('owned PG stopped', flush=True)
    save(outdir/'cleanup.json', dict(pg_stopped=started_pg, guard_breach=breach))
