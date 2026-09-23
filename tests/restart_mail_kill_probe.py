"""Kill a real engine mid-turn with a message QUEUED for it, and read the
bytes the replacement agent process is handed.

`restart_kill_probe.py` proves the `inflight` marker survives a hard kill.
This probe asks the next question, the one the user reported on 2026-09-18:
"messages that are queued when an org restarts seem to almost never get
delivered to an agent when it starts up again, only ever waiting for its first
turn to end". A test that asserts the mailbox is non-empty proves the mailbox
is non-empty. This asserts the message TEXT reaches the agent's turn input.

The only seam is the provider argv (`_build_cmd`). Admission, the delivery
journal, the restart fold in `reconcile`, the turn-start drain and the
envelope are the shipped code; the stand-in CLI writes whatever is put on its
stdin to a file, and that file is the agent's first-turn input.

Run it explicitly; `unittest discover` does not pick it up:

    python tests/restart_mail_kill_probe.py
    python tests/restart_mail_kill_probe.py --mutant no-fold
                                    # negative control: the delivery journal
                                    # is discarded instead of folded back, so
                                    # the probe MUST fail, or it proves nothing

Phases: `start` runs in the child (it is this same file, re-invoked).
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO = Path(__file__).resolve().parents[1]
SLUG = 'restart-mail-probe'
NODE = 'worker'
DRIVER = 'DRIVER: the work the agent was doing when orgtree died'
QUEUED = 'QUEUED-BEFORE-RESTART: this must be in the first turn input'

# stand-in provider CLIs. HANG holds a turn open so the engine can be killed
# mid-turn; DUMP records the bytes this turn was handed and then holds too, so
# nothing is folded back and the measurement is of ONE turn's input.
HANG = 'import sys, time\nsys.stdin.readline()\ntime.sleep(240)\n'
DUMP = ("import sys, os, time\n"
        "line = sys.stdin.readline()\n"
        "with open(os.environ['PROBE_DUMP'], 'a', encoding='utf-8') as f:\n"
        "    f.write(line if line.endswith('\\n') else line + '\\n')\n"
        "    f.flush()\n"
        "time.sleep(240)\n")


def _bind(root):
    """Bind THIS process to a throwaway data root before orgtree is imported.
    store.DATA_ROOT binds at import time, so the order here is load-bearing."""
    os.environ['ORGTREE_DATA'] = str(root)
    os.environ['HOME'] = os.environ['USERPROFILE'] = str(root.parent / 'home')
    os.environ['ORGTREE_V2_TOKEN'] = 'operator'
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        os.environ.pop(key, None)
    assert 'orgtree.store' not in sys.modules, 'store was imported too early'
    sys.path.insert(0, str(REPO / 'tools'))
    from assert_repo_import import assert_repo_import          # noqa: PLC0415
    provenance = assert_repo_import(REPO)
    from orgtree import store                                  # noqa: PLC0415
    assert Path(store.DATA_ROOT).resolve() == Path(root).resolve(), \
        'bound to %s, not the throwaway root' % store.DATA_ROOT
    return store, provenance


# --------------------------------------------------------------- the child
if len(sys.argv) > 2 and sys.argv[1] == 'start':
    root = Path(sys.argv[2])
    store, provenance = _bind(root)
    from orgtree import ledger, supervisor

    org = store.create_org(SLUG)
    org.hire(ledger.USER, None, 'haiku', 0, NODE)
    store.save_org(org)

    script = root.parent / 'hang.py'
    script.write_text(HANG, encoding='utf-8')
    supervisor._build_cmd = lambda *a, **k: [sys.executable, '-I', str(script)]

    supervisor.send_message(SLUG, NODE, DRIVER)
    deadline = time.time() + 120
    while time.time() < deadline:
        if supervisor.state(SLUG, NODE).get('responding'):
            break
        time.sleep(0.1)
    else:
        print(json.dumps({'ready': False, 'pid': os.getpid(),
                          'why': 'the turn never reached the provider'}),
              flush=True)
        while True:
            time.sleep(1)

    # the user messages the busy agent: this is the state the desk labels
    # "queued for a future turn boundary — not read yet"
    with store.DOC_LOCK:
        o = store.load_org(SLUG)
        o.post_mail(ledger.USER, NODE, QUEUED, kind='message')
        store.save_org(o)
    sent = supervisor.send_message(SLUG, NODE, 'mail pointer', mail_ping=True)
    time.sleep(0.5)
    o = store.load_org(SLUG)
    print(json.dumps({
        'ready': True, 'pid': os.getpid(), 'send_result': sent,
        'desk_stages': [m.get('stage')
                        for m in supervisor.delivering_mail(o, NODE)],
        'inflight': bool(o.node(NODE).get('inflight')),
        'mailbox': len((o.d.get('mail') or {}).get(NODE) or []),
        'commit': provenance.short_commit,
    }), flush=True)
    while True:                       # hold the turn open until we are killed
        time.sleep(1)


# -------------------------------------------------------------- the parent
AFTER = r'''
import json, os, sys, time
from pathlib import Path
root, mutant, repo, dump = (Path(sys.argv[1]), sys.argv[2],
                            Path(sys.argv[3]), Path(sys.argv[4]))
sys.path.insert(0, str(repo / "tools"))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
from orgtree import store, supervisor
assert Path(store.DATA_ROOT).resolve() == root.resolve(), store.DATA_ROOT
SLUG, NODE = "restart-mail-probe", "worker"
QUEUED = "QUEUED-BEFORE-RESTART: this must be in the first turn input"

org = store.load_org(SLUG)
before = {"inflight": bool(org.node(NODE).get("inflight")),
          "delivering": len((org.d.get("delivering") or {}).get(NODE) or []),
          "mailbox": len((org.d.get("mail") or {}).get(NODE) or []),
          "mail_drain": bool(org.node(NODE).get("mail_drain"))}
print("\u00a7C  what the dead process left on disk: %s" % json.dumps(before))
assert before["inflight"], "no inflight marker survived the kill"
assert before["delivering"] == 1, "the queued message left no durable batch"

if mutant == "no-fold":
    # negative control: discard the journal instead of folding it back, so the
    # queued message is genuinely gone and this probe MUST fail
    org.d.pop("delivering", None)
    org.d.setdefault("mail", {})[NODE] = []
    org.node(NODE).pop("mail_drain", None)
    store.save_org(org)
    store._POOL.close_all(SLUG)

script = root.parent / "dump.py"
os.environ["PROBE_DUMP"] = str(dump)
supervisor._build_cmd = lambda *a, **k: [sys.executable, "-I", str(script)]

supervisor.reconcile(SLUG, active_only=True)      # exactly what api.py runs
supervisor.maildrain.discover()
deadline = time.time() + 120
while time.time() < deadline and not dump.exists():
    supervisor.maildrain.sweep()
    time.sleep(0.5)

turns = []
for raw in (dump.read_text(encoding="utf-8").splitlines()
            if dump.exists() else []):
    try:
        content = (json.loads(raw).get("message") or {}).get("content")
    except ValueError:
        turns.append(raw); continue
    turns.append("\n".join(str(c.get("text") or "") for c in content
                           if isinstance(c, dict))
                 if isinstance(content, list) else str(content))

hits = [i + 1 for i, t in enumerate(turns) if QUEUED in t]
print("\u00a7D  %d turn(s) reached a provider; the queued message is in %s"
      % (len(turns), hits or "none of them"))
Path(root.parent / "result.json").write_text(json.dumps({
    "state_before_startup": before, "turns_observed": len(turns),
    "first_turn_head": turns[0][:600] if turns else None,
    "turns_carrying_the_queued_message": hits,
    "provenance": provenance.as_dict()}, indent=2), encoding="utf-8")
assert turns, "the restarted agent never reached a provider at all"
assert hits[:1] == [1], (
    "the message queued before the restart was NOT in the first turn's "
    "input (found in turns %r)\n---\n%s" % (hits, turns[0][:800]))
print("\u00a7E  the queued message rode the restarted agent's FIRST turn")
'''


def main():
    mutant = ''
    if len(sys.argv) > 1 and sys.argv[1].startswith('--mutant'):
        mutant = (sys.argv[1].split('=', 1)[1] if '=' in sys.argv[1]
                  else (sys.argv[2] if len(sys.argv) > 2 else ''))
    box = Path(tempfile.mkdtemp(prefix='restart-mail-probe-'))
    root = box / 'data'
    root.mkdir()
    (box / 'home').mkdir()
    (box / 'dump.py').write_text(DUMP, encoding='utf-8')
    dump = box / 'turn-input.jsonl'
    env = {**os.environ, 'ORGTREE_DATA': str(root), 'HOME': str(box / 'home'),
           'USERPROFILE': str(box / 'home'), 'ORGTREE_V2_TOKEN': 'operator',
           'PYTHONIOENCODING': 'utf-8'}
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        env.pop(key, None)

    print('§A  a real engine process and a real turn in %s' % root)
    child = subprocess.Popen(
        [sys.executable, '-B', __file__, 'start', str(root)],
        cwd=str(REPO), env=env, text=True, encoding='utf-8', errors='replace',
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line = ''
    deadline = time.time() + 240
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
    if not hello.get('ready'):
        child.kill()
        raise SystemExit('the child never reached a mid-turn state: %s' % hello)
    print('    pid %s is mid-turn; the message is queued, desk stage %s, '
          'mailbox %s' % (hello['pid'], hello['desk_stages'], hello['mailbox']))

    print('§B  killing the process tree the way the guardian does')
    subprocess.run(['taskkill', '/T', '/F', '/PID', str(hello['pid'])],
                   capture_output=True)
    child.wait(timeout=120)
    print('    exit code %s' % child.returncode)

    after = subprocess.run(
        [sys.executable, '-B', '-c', AFTER, str(root), mutant, str(REPO),
         str(dump)],
        cwd=str(REPO), env=env, text=True, encoding='utf-8', errors='replace',
        capture_output=True, timeout=600)
    sys.stdout.write(after.stdout)
    if after.returncode:
        sys.stderr.write(after.stderr[-8000:])
        print('\nFAILED (mutant=%s)' % (mutant or 'none'))
        return 0 if mutant else 1
    print('\nPASS%s' % ('  [mutant %s was expected to FAIL and did NOT — this '
                        'probe proves nothing]' % mutant if mutant else ''))
    return 1 if mutant else 0


if __name__ == '__main__':
    raise SystemExit(main())
