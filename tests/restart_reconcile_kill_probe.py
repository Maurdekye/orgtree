"""Kill the engine INSIDE reconcile's dispatch loop and watch markers vanish.

`restart_kill_probe.py` proves the marker survives a process killed mid-TURN,
so restart recovery has something to replay.  This probe covers the window
immediately after that one: the startup pass itself.

`supervisor.reconcile()` pops `inflight` off EVERY eligible node in one pass
and `store.save_org()`s that erasure to disk BEFORE dispatching a single
resume (supervisor.py:31523 and :31536-31537).  It then dispatches them one at
a time OUTSIDE the document lock (:31628), each dispatch being a whole turn,
and only a `finally` (:31655) puts the undispatched ones back.

A `finally` does not run when the process is killed.  So a kill partway through
that loop is expected to lose every not-yet-dispatched marker permanently, with
no later boot replaying them -- and because the marker is also what would
render the node as died-mid-turn, the stranded agent then reads as merely idle.

This probe establishes that rather than arguing it, with a real child process
and a real `taskkill /T /F` -- the same hard tree kill the desktop's guardian
performs on a dying engine.

TWO ARMS, AND THE SECOND ONE IS THE POINT.  A probe that only shows the bad
outcome cannot tell "the marker was destroyed by the kill" from "the marker was
never there".  So it runs the identical setup twice:

    --arm kill      dispatch #2 blocks and the process is hard-killed inside
                    it.  The `finally` cannot run.  Markers MUST be gone and
                    the undispatched seats MUST never be replayed.
    --arm survive   dispatch #2 RAISES instead, at the same point in the same
                    loop, and the process LIVES.  The `finally` therefore runs
                    and MUST restore the undispatched markers, and a second
                    pass MUST replay them.

`survive` is the control and the two arms differ in exactly one thing: whether
the process is alive when the loop unwinds.  Same seats, same loop, same point
of failure.  If the control does not restore and replay, the probe is measuring
a broken setup rather than the defect, and it says so instead of reporting.

    python tests/restart_reconcile_kill_probe.py            # both arms
    python tests/restart_reconcile_kill_probe.py --arm kill
    python tests/restart_reconcile_kill_probe.py --arm survive

Run it explicitly; `unittest discover` does not pick it up.
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
SLUG = 'reconcile-kill-probe'
# Three seats on purpose.  One is dispatched before the kill, one is the seat
# the loop is inside when the kill lands, and one is never reached at all.
# That third seat is the whole finding: it was erased by a pass that never got
# far enough to do anything with it.
NODES = ('alpha', 'bravo', 'charlie')
DRIVER = 'the message that drove the interrupted turn'


def _bind(root):
    """Bind THIS process to a throwaway data root before orgtree is imported.

    store.DATA_ROOT binds at import time, so the order here is load-bearing.
    """
    os.environ['ORGTREE_DATA'] = str(root)
    os.environ['HOME'] = os.environ['USERPROFILE'] = str(root.parent / 'home')
    os.environ['ORGTREE_V2_TOKEN'] = 'operator'
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        os.environ.pop(key, None)
    assert 'orgtree.store' not in sys.modules, 'store was imported too early'
    sys.path.insert(0, str(REPO / 'tools'))
    from assert_repo_import import assert_repo_import          # noqa: PLC0415
    provenance = assert_repo_import(REPO, 'orgtree.store')
    from orgtree import store                                  # noqa: PLC0415
    assert Path(store.DATA_ROOT).resolve() == Path(root).resolve(), \
        'bound to %s, not the throwaway root' % store.DATA_ROOT
    return store, provenance


# ------------------------------------------------------------------ phase 1
# Real turns, so the markers under test are the ones the engine really writes.
if len(sys.argv) > 2 and sys.argv[1] == 'seed':
    root = Path(sys.argv[2])
    store, prov = _bind(root)
    from orgtree import ledger, supervisor

    org = store.create_org(SLUG)
    for name in NODES:
        org.hire(ledger.USER, None, 'haiku', 0, name)
    store.save_org(org)

    # The ONE seam: the provider argv.  Admission, the mail drain, the
    # envelope and the inflight persist itself are all the real code; the
    # launched process simply never answers, which is what a turn in progress
    # looks like from the outside.
    supervisor._build_cmd = lambda *a, **k: [
        sys.executable, '-c', 'import time; time.sleep(900)']

    import threading
    for name in NODES:
        threading.Thread(target=supervisor.send_message,
                         args=(SLUG, name, DRIVER), daemon=True).start()

    deadline = time.time() + 120
    marked = {}
    while time.time() < deadline:
        org2 = store.load_org(SLUG)
        marked = {n: bool(org2.node(n).get('inflight')) for n in NODES}
        if all(marked.values()):
            break
        time.sleep(0.2)
    print(json.dumps({'seeded': marked,
                      'import_provenance': prov.origins
                      if hasattr(prov, 'origins') else None}), flush=True)
    raise SystemExit(0 if all(marked.values()) else 3)


# ------------------------------------------------------------------ phase 2
# The victim: a fresh process that runs the startup pass and is killed inside
# the dispatch loop (or, in the control arm, is allowed to finish it).
if len(sys.argv) > 3 and sys.argv[1] == 'pass':
    root, arm, sig = Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4])
    store, _prov = _bind(root)
    from orgtree import supervisor

    dispatched = []

    def drive(slug, nid, text, **kw):
        dispatched.append(nid)
        sig.write_text(json.dumps({'dispatched': dispatched,
                                   'pid': os.getpid()}), encoding='utf-8')
        if len(dispatched) == 1:
            return {'accepted': True, 'queued': 0}
        # Dispatch #2 is the point of failure in BOTH arms, and the arms
        # differ in exactly one thing: whether this process is still alive
        # when the loop unwinds.
        if arm == 'kill':
            while True:            # ... held open until taskkill lands
                time.sleep(0.5)
        raise RuntimeError('dispatch #2 failed while the process lived')

    supervisor.send_message = drive
    try:
        supervisor.reconcile(SLUG, active_only=True)  # exactly what api.py runs
        completed = True
    except RuntimeError as exc:
        completed = str(exc)
    print(json.dumps({'completed': completed, 'dispatched': dispatched}),
          flush=True)
    raise SystemExit(0)


# ------------------------------------------------------------------ phase 3
AFTER = r'''
import json, sys
from pathlib import Path
root, arm = Path(sys.argv[1]), sys.argv[2]
sys.path.insert(0, str(Path.cwd() / "engine" / "backend"))
from orgtree import store, supervisor
assert Path(store.DATA_ROOT).resolve() == root.resolve(), store.DATA_ROOT
SLUG = "reconcile-kill-probe"
NODES = ("alpha", "bravo", "charlie")

org = store.load_org(SLUG)
survived = {n: bool(org.node(n).get("inflight")) for n in NODES}
print("§C  markers on disk after the pass: %s" % survived)

driven = []
def drive(slug, nid, text, **kw):
    driven.append(nid); return {"accepted": True, "queued": 0}
supervisor.send_message = drive
supervisor.reconcile(SLUG, active_only=True)      # the NEXT boot
print("§D  the next boot replayed: %s" % driven)

result = {"survived": survived, "replayed": driven}
Path(sys.argv[3]).write_text(json.dumps(result), encoding="utf-8")
'''


def _run_arm(arm):
    box = tempfile.mkdtemp(prefix='reconcile-kill-probe-')
    root = Path(box) / 'data'
    root.mkdir()
    (Path(box) / 'home').mkdir()
    env = {**os.environ, 'ORGTREE_DATA': str(root),
           'HOME': str(Path(box) / 'home'),
           'USERPROFILE': str(Path(box) / 'home'),
           'ORGTREE_V2_TOKEN': 'operator', 'PYTHONIOENCODING': 'utf-8'}
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        env.pop(key, None)

    print('\n=== ARM: %s ===' % arm)
    print('§A  seeding three real interrupted turns in %s' % root)
    seed = subprocess.run([sys.executable, '-B', __file__, 'seed', str(root)],
                          cwd=str(REPO), env=env, text=True,
                          encoding='utf-8', errors='replace',
                          capture_output=True, timeout=600)
    if seed.returncode:
        sys.stderr.write(seed.stdout + '\n' + seed.stderr[-4000:])
        raise SystemExit('seeding failed: not all three markers were written')
    print('    %s' % seed.stdout.strip().splitlines()[-1])

    sig = Path(box) / 'dispatch.json'
    print('§B  running the startup pass (%s)' % arm)
    victim = subprocess.Popen([sys.executable, '-B', __file__, 'pass',
                               str(root), arm, str(sig)],
                              cwd=str(REPO), env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if arm == 'kill':
        deadline = time.time() + 300
        seen = []
        while time.time() < deadline:
            if victim.poll() is not None:
                raise SystemExit('the pass exited before it could be killed')
            try:
                seen = json.loads(sig.read_text(encoding='utf-8'))['dispatched']
            except (OSError, ValueError, KeyError):
                seen = []
            if len(seen) >= 2:
                break
            time.sleep(0.1)
        if len(seen) < 2:
            victim.kill()
            raise SystemExit('the pass never reached the second dispatch; '
                             'nothing was exercised')
        print('    the loop is inside dispatch #2 (%s); killing the tree'
              % seen)
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(victim.pid)],
                       capture_output=True, check=True)
        victim.wait(timeout=120)
        print('    exit code %s' % victim.returncode)
    else:
        out, err = victim.communicate(timeout=600)
        if victim.returncode:
            sys.stderr.write(out + '\n' + err[-4000:])
            raise SystemExit('the control arm did not complete')
        print('    %s' % out.strip().splitlines()[-1])

    out_path = Path(box) / 'after.json'
    after = subprocess.run([sys.executable, '-B', '-c', AFTER, str(root), arm,
                            str(out_path)],
                           cwd=str(REPO), env=env, text=True,
                           encoding='utf-8', errors='replace',
                           capture_output=True, timeout=600)
    sys.stdout.write(after.stdout)
    if after.returncode:
        sys.stderr.write(after.stderr[-6000:])
        raise SystemExit('the next-boot pass failed')
    return json.loads(out_path.read_text(encoding='utf-8'))


def main():
    want = None
    for i, a in enumerate(sys.argv):
        if a == '--arm' and i + 1 < len(sys.argv):
            want = sys.argv[i + 1]
        elif a.startswith('--arm='):
            want = a.split('=', 1)[1]
    arms = [want] if want else ['survive', 'kill']
    results = {a: _run_arm(a) for a in arms}

    print('\n================ VERDICT ================')
    ok = True
    if 'survive' in results:
        r = results['survive']
        # The control must show the `finally` doing its job while the process
        # lives.  If it does not, nothing the kill arm shows can be attributed
        # to the kill rather than to the setup.
        restored = [n for n, v in r['survived'].items() if v]
        expect = list(NODES[1:])          # alpha was dispatched and is spent
        good = restored == expect and sorted(r['replayed']) == sorted(expect)
        ok &= good
        print('CONTROL   finally restored %s (expected %s), next boot '
              'replayed %s  -> %s'
              % (restored, expect, r['replayed'],
                 'OK' if good else 'BROKEN SETUP'))
    if 'kill' in results:
        r = results['kill']
        # THE INVARIANT, and it is stronger than "the agent is replayed":
        # after the kill, every seat must be either marker-present or
        # replayed -- never neither.  The ONLY seat allowed to be lost is the
        # one the loop was inside when the kill landed, whose marker the
        # "spent by its dispatch" rule already treats as gone.  Seats the loop
        # NEVER REACHED must all survive; that is the whole defect.
        dispatched_before_kill, in_flight = NODES[0], NODES[1]
        never_reached = list(NODES[2:])
        stranded = [n for n in NODES
                    if not r['survived'][n] and n not in r['replayed']]
        rescued = [n for n in never_reached
                   if r['survived'][n] or n in r['replayed']]
        leaked = [n for n in stranded
                  if n not in (dispatched_before_kill, in_flight)]
        good = rescued == never_reached and not leaked
        ok &= good
        print('KILL      next boot replayed %s' % r['replayed'])
        print('          never-reached seats rescued: %s (expected %s)'
              % (rescued, never_reached))
        print('          lost beyond the in-flight marker: %s  -> %s'
              % (leaked or 'none', 'OK' if good else 'STRANDING'))
    print('=========================================')
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
