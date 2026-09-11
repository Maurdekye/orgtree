"""Kill a real engine process mid-turn and watch the next one resume it.

The unit suite (test_restart_resume.py) drives supervisor.reconcile() directly.
It therefore ASSUMES the thing that makes restart recovery possible at all: that
a turn's `inflight` marker is still on disk after the process running that turn
dies. This probe establishes that instead of assuming it — a real child engine
process starts a real turn through send_message(), is killed with
`taskkill /T /F` (the same hard tree kill the desktop's guardian performs on a
dying engine), and a second process then runs the startup pass.

Run it explicitly; `unittest discover` does not pick it up:

    python tests/restart_kill_probe.py            # normal run
    python tests/restart_kill_probe.py --mutant no-marker
                                                  # a negative control: with
                                                  # the marker removed before
                                                  # the pass, the probe MUST
                                                  # fail, or it proves nothing

Phases: `start` runs in the child (it is this same file, re-invoked).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO = Path(__file__).resolve().parents[1]
SLUG = 'kill-probe'
NODE = 'worker'
DRIVER = 'the message that drove the interrupted turn'


def _bind(root):
    """Bind THIS process to a throwaway data root before orgtree is imported.
    store.DATA_ROOT binds at import time, so the order here is load-bearing."""
    os.environ['ORGTREE_DATA'] = str(root)
    os.environ['HOME'] = os.environ['USERPROFILE'] = str(root.parent / 'home')
    os.environ['ORGTREE_V2_TOKEN'] = 'operator'
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        os.environ.pop(key, None)
    assert 'orgtree.store' not in sys.modules, 'store was imported too early'
    sys.path.insert(0, str(REPO / 'engine' / 'backend'))
    from orgtree import store                                 # noqa: PLC0415
    assert Path(store.DATA_ROOT).resolve() == Path(root).resolve(), \
        'bound to %s, not the throwaway root' % store.DATA_ROOT
    return store


# --------------------------------------------------------------- the child
if len(sys.argv) > 2 and sys.argv[1] == 'start':
    root = Path(sys.argv[2])
    store = _bind(root)
    from orgtree import ledger, supervisor

    org = store.create_org(SLUG)
    org.hire(ledger.USER, None, 'haiku', 0, NODE)
    # the live shape: an import whose recovery the operator never resolved
    org.d['desktop_import'] = {'source_root': 'C:/old-install',
                               'active_nodes': ['someone-else'],
                               'recovery_pending': True}
    store.save_org(org)

    # The ONE seam: the provider argv. Everything before it — admission, the
    # mail drain, the envelope, and the inflight persist itself — is the real
    # code. The launched process simply never answers, which is what a turn
    # in progress looks like from the outside.
    supervisor._build_cmd = lambda *a, **k: [
        sys.executable, '-c', 'import time; time.sleep(900)']
    supervisor.send_message(SLUG, NODE, DRIVER)

    deadline = time.time() + 60
    while time.time() < deadline:
        marker = store.load_org(SLUG).node(NODE).get('inflight')
        if marker:
            print(json.dumps({'ready': True, 'pid': os.getpid(),
                              'marker_at': marker.get('at')}), flush=True)
            break
        time.sleep(0.1)
    else:
        print(json.dumps({'ready': False, 'pid': os.getpid()}), flush=True)
    while True:                       # hold the turn open until we are killed
        time.sleep(1)


# -------------------------------------------------------------- the parent
def main():
    mutant = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == '--mutant' \
        else (sys.argv[1][9:] if len(sys.argv) > 1
              and sys.argv[1].startswith('--mutant=') else None)
    if len(sys.argv) > 1 and sys.argv[1] == '--mutant' and len(sys.argv) > 2:
        mutant = sys.argv[2]
    box = tempfile.mkdtemp(prefix='restart-kill-probe-')
    root = Path(box) / 'data'
    root.mkdir()
    (Path(box) / 'home').mkdir()
    env = {**os.environ, 'ORGTREE_DATA': str(root),
           'HOME': str(Path(box) / 'home'),
           'USERPROFILE': str(Path(box) / 'home'),
           'ORGTREE_V2_TOKEN': 'operator'}
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        env.pop(key, None)
    env['PYTHONIOENCODING'] = 'utf-8'      # the section marks are not ascii

    print('§A  starting a real engine process and a real turn in %s' % root)
    child = subprocess.Popen([sys.executable, '-B', __file__, 'start', str(root)],
                             cwd=str(REPO), env=env, text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line = ''
    deadline = time.time() + 180
    while time.time() < deadline:
        line = child.stdout.readline()
        if not line:
            break
        if line.lstrip().startswith('{'):
            break
    try:
        hello = json.loads(line)
    except ValueError:
        child.kill()
        raise SystemExit('the child never reported: %r\n%s'
                         % (line, child.stderr.read()[-4000:]))
    assert hello.get('ready'), 'the turn never persisted an inflight marker'
    print('    child pid %s is mid-turn, marker written at %s'
          % (hello['pid'], hello['marker_at']))

    print('§B  killing the process tree the way the guardian does')
    subprocess.run(['taskkill', '/T', '/F', '/PID', str(hello['pid'])],
                   capture_output=True, check=True)
    child.wait(timeout=60)
    print('    exit code %s' % child.returncode)

    # a fresh process: nothing of the dead one survives but the data root
    after = subprocess.run([sys.executable, '-B', '-c', AFTER,
                            str(root), str(mutant or '')],
                           cwd=str(REPO), env=env, text=True,
                           encoding='utf-8', errors='replace',
                           capture_output=True, timeout=300)
    sys.stdout.write(after.stdout)
    if after.returncode:
        sys.stderr.write(after.stderr[-6000:])
        raise SystemExit('FAILED (mutant=%s)' % mutant)
    print('\nPASS%s' % ('  [mutant %s was expected to fail and did NOT]'
                        % mutant if mutant else ''))
    raise SystemExit(1 if mutant else 0)


AFTER = r'''
import json, os, sys
from pathlib import Path
root = Path(sys.argv[1]); mutant = sys.argv[2]
sys.path.insert(0, str(Path.cwd() / "engine" / "backend"))
from orgtree import store, supervisor
assert Path(store.DATA_ROOT).resolve() == root.resolve(), store.DATA_ROOT
SLUG, NODE = "kill-probe", "worker"
DRIVER = "the message that drove the interrupted turn"

org = store.load_org(SLUG)
marker = org.node(NODE).get("inflight")
print("\u00a7C  the dead process left a marker on disk: %s" % bool(marker))
assert marker, "no inflight marker survived the kill - restart recovery has nothing to replay"
assert DRIVER in marker["text"], marker["text"][:200]
assert not org.node(NODE).get("turns"), "the killed turn booked a result anyway"
assert org.d["desktop_import"]["recovery_pending"] is True

if mutant == "no-marker":
    # negative control: without the marker the pass MUST NOT resume anything
    org.node(NODE).pop("inflight"); store.save_org(org)

driven = []
def drive(slug, nid, text, **kw):
    driven.append((nid, text)); return {"accepted": True, "queued": 0}
supervisor.send_message = drive
supervisor.reconcile(SLUG, active_only=True)      # exactly what api.py runs
print("\u00a7D  the startup pass drove: %s" % [n for n, _ in driven])
assert [n for n, _ in driven] == [NODE], "the interrupted turn was not resumed"
assert "[ORGTREE RESTART]" in driven[0][1]
assert driven[0][1].rstrip().endswith(DRIVER), driven[0][1][-200:]
store._POOL.close_all(SLUG)
after = store.load_org(SLUG)
assert not after.node(NODE).get("inflight"), "the marker would replay a second time"
print("\u00a7E  marker spent: a second restart replays nothing")
'''

if __name__ == '__main__':
    main()
