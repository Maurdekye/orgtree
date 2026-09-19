"""Break the fix on purpose and prove the tests notice.

A test that is green after the fix is not evidence until it is shown to be RED
without it.  This harness applies one deliberate mutation at a time to the
production source, runs the test that is supposed to catch it, and requires a
FAILURE.  A mutant that survives is reported as a survivor, which is a finding
about the test, not about the mutant.

It runs a BASELINE first: the unmutated tree must be green, or "red under
mutation" means nothing.

    python tests/restart_reconcile_mutation_probe.py          # all mutants
    python tests/restart_reconcile_mutation_probe.py --only M3

THE MUTANTS, and what each one is a stand-in for:

  M1  erase every marker up front again, exactly as the code did before the
      fix.  This IS the reported defect, restored.  Caught by the kill arm.
  M2  never spend a marker at all.  The opposite failure -- a fix that
      over-preserved would replay an already-dispatched turn a second time.
      Caught by the CONTROL arm, which is the arm that exists to show the
      probe is measuring the loop rather than the kill.
  M3  reconcile stops declaring its replays as replays.
  M4  the turn record derives `restart_replay` from `retry_payload`, i.e.
      makes it a second name for `resumed`.  That is precisely the conflation
      the field was added to end, and it is silent: the flag still exists,
      still coerces, and is simply wrong on every replay.
  M5  the flag is stamped on every carrier instead of only the replayed one.
  M6  the field is undeclared, so coercion drops it off the record.
  M7  the spend pops on TRUTHINESS instead of identity -- the exact defect
      this harness could not have found, see below.

⚠ WHAT THIS HARNESS CANNOT DO, AND THE PROOF IS ITS OWN HISTORY.  It reported
6 mutants, 6 killed, 0 survivors -- and a real blocking defect sailed straight
through it, because the defect was a GUARD THAT WAS NOT THERE.  Mutation
testing perturbs the code that was written; it has no way to express "the
check nobody wrote".  restart-mail found that one by reading the fix against
its own `finally` block and noticing the two touched a marker with different
care.  So read 6/6 as "the tests cover the lines the fix has", never as "the
fix is right".  M7 exists only because the guard now exists to be mutated --
which is exactly the limitation, stated from the inside.

⚠ THIS HARNESS EDITS FILES IN THE WORKING TREE.  Every original is held in
memory and restored in a `finally`, and the run ends by re-checking every
file against its original bytes and saying so out loud.  If it is ever
interrupted between the write and the restore, `git diff` shows the mutation
and `git checkout --` undoes it -- the mutations are one-line edits to
tracked files, nothing else is touched.
"""
import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SUP = 'engine/backend/orgtree/supervisor.py'
TURNREAD = 'engine/backend/orgtree/turnread.py'

PROBE = [sys.executable, '-B', 'tests/restart_reconcile_kill_probe.py',
         '--kill-at', '2']
FLAG = [sys.executable, '-B', 'tools/run-python-verification.py',
        '--repo-root', '.', 'tests/test_restart_replay_turnlog.py']
RACE = [sys.executable, '-B', 'tools/run-python-verification.py',
        '--repo-root', '.', 'tests/restart_reconcile_spend_race_probe.py']

MUTANTS = [
    {
        'id': 'M1',
        'what': 'erase every replayable marker up front, as before the fix',
        'catches': 'the reported defect itself',
        'command': PROBE,
        'edits': [
            (SUP,
             '                    inflight.append((nid, inf))\n'
             '                    if recovery_observer is not None \\\n',
             '                    n.pop("inflight", None)\n'
             '                    inflight.append((nid, inf))\n'
             '                    if recovery_observer is not None \\\n'),
            (SUP,
             '        if dropped_cmd:\n            store.save_org(org)\n',
             '        if inflight or dropped_cmd:\n            store.save_org(org)\n'),
        ],
    },
    {
        'id': 'M2',
        'what': 'never spend a marker, so a dispatched turn replays again',
        'catches': 'over-preservation -- caught by the CONTROL arm, not the kill arm',
        'command': PROBE,
        'edits': [
            (SUP,
             '                if _cur == inf:\n',
             '                if False:\n'),
        ],
    },
    {
        'id': 'M3',
        'what': 'reconcile stops declaring its replays as replays',
        'catches': 'the carrier hop, §1a',
        'command': FLAG,
        'edits': [
            (SUP,
             '                         restart_replay=True,\n',
             '                         restart_replay=False,\n'),
        ],
    },
    {
        'id': 'M4',
        'what': 'the record derives restart_replay from retry_payload '
                '(makes it a second name for `resumed`)',
        'catches': 'the record, §2a -- the silent conflation the field ends',
        'command': FLAG,
        'edits': [
            (SUP,
             '    is_restart_replay = (bool(text.get("restart_replay"))\n'
             '                         if isinstance(text, dict) else False)\n',
             '    is_restart_replay = bool(retry_payload)\n'),
        ],
    },
    {
        'id': 'M5',
        'what': 'stamp the flag on every carrier, not only the replayed one',
        'catches': 'the controls, §1b and §3b',
        'command': FLAG,
        'edits': [
            (SUP,
             '    if restart_replay:\n        _segs["restart_replay"] = True\n',
             '    if True:\n        _segs["restart_replay"] = True\n'),
        ],
    },
    {
        'id': 'M7',
        'what': 'the spend pops on truthiness instead of identity',
        'catches': 'the spend race, restart_reconcile_spend_race_probe.py',
        'command': RACE,
        'edits': [
            (SUP, '                if _cur == inf:\n', '                if _cur:\n'),
        ],
    },
    {
        'id': 'M6',
        'what': 'undeclare the field, so coercion drops it off the record',
        'catches': 'the schema, §3a, and the record sections with it',
        'command': FLAG,
        'edits': [
            (TURNREAD, '    "restart_replay": B,\n', ''),
        ],
    },
]


def _digest(rel):
    return hashlib.sha256((REPO / rel).read_bytes()).hexdigest()


def _run(command):
    """Green or red, and the tail of what it said."""
    proc = subprocess.run(command, cwd=str(REPO), capture_output=True,
                          text=True, encoding='utf-8', errors='replace',
                          timeout=2400)
    return proc.returncode, (proc.stdout or '') + (proc.stderr or '')


def _apply(mutant, originals):
    """Apply every edit, refusing outright if a target text is not found -- a
    mutation that silently changed nothing would report a SURVIVOR and blame
    the test for a defect that was never introduced."""
    for rel, old, new in mutant['edits']:
        path = REPO / rel
        text = path.read_text(encoding='utf-8')
        if rel not in originals:
            originals[rel] = text
        if text.count(old) != 1:
            raise SystemExit(
                '%s: the target text for %s appears %d times, not once. The '
                'source moved under this harness; fix the mutant rather than '
                'reporting a survivor.' % (mutant['id'], rel, text.count(old)))
        path.write_text(text.replace(old, new), encoding='utf-8')


def main():
    only = None
    for i, a in enumerate(sys.argv):
        if a == '--only' and i + 1 < len(sys.argv):
            only = sys.argv[i + 1]
        elif a.startswith('--only='):
            only = a.split('=', 1)[1]
    wanted = [m for m in MUTANTS if only is None or m['id'] == only]

    before = {rel: _digest(rel) for rel in (SUP, TURNREAD)}

    print('=== BASELINE: the unmutated tree must be green ===')
    baseline = {}
    for command in ([PROBE, FLAG, RACE] if only is None else
                    [wanted[0]['command']]):
        key = ' '.join(command[-2:])
        code, out = _run(command)
        baseline[key] = code
        print('  %-40s -> %s' % (key, 'GREEN' if code == 0 else 'RED'))
        if code != 0:
            print(out[-3000:])
            raise SystemExit('the baseline is not green; nothing below means '
                             'anything until it is')

    killed, survivors = [], []
    originals = {}
    try:
        for mutant in wanted:
            print('\n=== %s  %s ===' % (mutant['id'], mutant['what']))
            print('    should be caught by: %s' % mutant['catches'])
            _apply(mutant, originals)
            try:
                code, out = _run(mutant['command'])
            finally:
                for rel, text in originals.items():
                    (REPO / rel).write_text(text, encoding='utf-8')
            if code == 0:
                survivors.append(mutant['id'])
                print('    SURVIVED  -- the test does not catch this. That is '
                      'a finding about the test.')
                print(out[-2000:])
            else:
                killed.append(mutant['id'])
                for line in out.splitlines():
                    if ('STRANDING' in line or 'BROKEN SETUP' in line
                            or line.startswith('FAILED')
                            or line.startswith('AssertionError')
                            or 'unexpected_failures' in line):
                        print('    | %s' % line.strip()[:160])
                print('    KILLED')
    finally:
        for rel, text in originals.items():
            (REPO / rel).write_text(text, encoding='utf-8')

    print('\n================ MUTATION VERDICT ================')
    print('killed:    %s' % (', '.join(killed) or 'none'))
    print('survivors: %s' % (', '.join(survivors) or 'none'))
    restored = all(_digest(rel) == before[rel] for rel in before)
    print('working tree restored byte for byte: %s' % ('yes' if restored else
                                                       'NO -- CHECK git diff'))
    print('==================================================')
    raise SystemExit(0 if (not survivors and restored) else 1)


if __name__ == '__main__':
    main()
