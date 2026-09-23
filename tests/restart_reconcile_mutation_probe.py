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
  M7  the spend decides ownership on TRUTHINESS instead of identity -- the
      exact defect this harness could not have found, see below.
  M8  identity by `at` alone: two markers that both lack an `at` compare
      equal and a different turn's marker is spent.
  M9  identity by full equality alone: a marker edited in place reads as a
      different turn, so its seat is dropped and its work is lost.
  M10 dispatch the stale replay anyway instead of dropping it -- the user
      ruling of 2026-09-19, deleted.
  M11 drop the replay but leave the seat uncounted.  The subtlest one here:
      `undispatched = inflight[dispatched:]` is a POSITIONAL SLICE, so a
      bare `continue` does not merely forget the dropped seat, it shifts the
      restore window and puts back the marker of a LATER seat that really
      was dispatched.  That seat then replays a second time.
  M12 drop the replay on BARE ABSENCE, treating a missing marker as proof a
      turn ran.  The tempting one-line "fix" for the absent-marker hole, and
      the one that would silently throw away the drive text of every seat
      whose marker went missing for any other reason.
  M13 the turn's own `finally` stops stamping `turn_ended`.  ⚠ THIS ONE
      SURVIVED its first suite.  The absent-marker probe ends its simulated
      turn by calling `_mark_turn_ended` directly, so removing the PRODUCTION
      call left the probe green while the behaviour reverted completely.
      `tests/test_turn_end_stamp.py` exists because of this mutant, and runs
      a real turn over real pipes to catch it.
  M14 read the stamp's PRESENCE instead of its ORDER.  Every seat that has
      ever completed a turn carries a stamp, so this drops the interrupted
      work of the whole fleet -- and it passes every arm that has no stamp or
      a genuinely newer one.
  M15 order the two stamps as STRINGS rather than as instants, walking into
      the millisecond-transition quirk `ledger.now` documents.

⚠ WHAT THIS HARNESS CANNOT DO, AND THE PROOF IS ITS OWN HISTORY.  It reported
6 mutants, 6 killed, 0 survivors -- and a real blocking defect sailed straight
through it, because the defect was a GUARD THAT WAS NOT THERE.  Mutation
testing perturbs the code that was written; it has no way to express "the
check nobody wrote".  restart-mail found that one by reading the fix against
its own `finally` block and noticing the two touched a marker with different
care.  So read N/N as "the tests cover the lines the fix has", never as "the
fix is right".

M7 through M15 exist only because the code they mutate now exists -- which is
the same limitation, stated from the inside each time.  M11 is the one worth
reading: no suite here caught it until one was written for it specifically,
because every other test in this set puts the affected seat LAST in the loop,
where a misaligned restore window has nothing behind it to damage.

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
IDENT = [sys.executable, '-B', 'tools/run-python-verification.py',
         '--repo-root', '.', 'tests/test_restart_marker_identity.py']
SETTLE = [sys.executable, '-B', 'tools/run-python-verification.py',
          '--repo-root', '.',
          'tests/test_restart_dropped_replay_settles_seat.py']
ABSENT = [sys.executable, '-B', 'tools/run-python-verification.py',
          '--repo-root', '.',
          'tests/restart_reconcile_absent_marker_probe.py']
STAMP = [sys.executable, '-B', 'tools/run-python-verification.py',
         '--repo-root', '.', 'tests/test_turn_end_stamp.py']

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
             '                if _ours:\n',
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
        'what': 'the spend decides ownership on truthiness, not identity',
        'catches': 'the spend race, restart_reconcile_spend_race_probe.py',
        'command': RACE,
        'edits': [
            (SUP,
             '                _ours = _marker_is_same(_cur, inf)\n',
             '                _ours = bool(_cur)\n'),
        ],
    },
    {
        'id': 'M8',
        'what': 'identify a marker by `at` alone, dropping the legacy fallback',
        'catches': 'the at-less collision, marker identity §2',
        'command': IDENT,
        'edits': [
            (SUP,
             '    if inf.get("at") is not None:\n'
             '        return cur.get("at") == inf.get("at")\n'
             '    return cur == inf\n',
             '    return cur.get("at") == inf.get("at")\n'),
        ],
    },
    {
        'id': 'M9',
        'what': 'identify a marker by full equality alone, dropping the `at` branch',
        'catches': 'the in-place edit, marker identity §1',
        'command': IDENT,
        'edits': [
            (SUP,
             '    if inf.get("at") is not None:\n'
             '        return cur.get("at") == inf.get("at")\n'
             '    return cur == inf\n',
             '    return cur == inf\n'),
        ],
    },
    {
        'id': 'M10',
        'what': 'dispatch the stale replay anyway instead of dropping it',
        'catches': 'the user ruling itself -- the race probe\'s DROP check',
        'command': RACE,
        'edits': [
            (SUP,
             '            if not _ours and (_cur or _ended_newer):\n',
             '            if False and (_cur or _ended_newer):\n'),
        ],
    },
    {
        'id': 'M11',
        'what': 'drop the replay but leave the seat uncounted, so the '
                'restore window misaligns',
        'catches': 'the settled-seat suite -- and NOTHING ELSE does, which '
                   'is why that suite exists',
        'command': SETTLE,
        'edits': [
            (SUP,
             '                dispatched += 1\n                continue\n',
             '                continue\n'),
        ],
    },
    {
        'id': 'M12',
        'what': 'drop the replay on BARE ABSENCE, treating a missing marker '
                'as proof a turn ran',
        'catches': "the absent-marker probe's CONTROL-B -- the whole reason "
                   'the fix carries a stamp instead of widening the condition',
        'command': ABSENT,
        'edits': [
            (SUP,
             '                _ended_newer = (_snode is not None and not _cur\n'
             '                                and _newer_turn_ended(_snode, inf))\n',
             '                _ended_newer = not _cur\n'),
        ],
    },
    {
        'id': 'M13',
        'what': "the turn's own finally stops stamping `turn_ended`, so the "
                'absence goes back to being unreadable',
        'catches': 'test_turn_end_stamp.py §1 -- AND NOTHING ELSE DOES. This '
                   'mutant SURVIVED the absent-marker probe, which is what '
                   'that suite was written for: the probe ends its simulated '
                   'turn by calling `_mark_turn_ended` itself, so deleting '
                   "the production call leaves it green while every "
                   'started-and-finished seat goes back to replaying stale '
                   'text. A real turn had to be run to see it.',
        'command': STAMP,
        'edits': [
            (SUP,
             '                if changed:\n'
             '                    _mark_turn_ended(o2.node(nid), _popped)\n',
             '                if False:\n'
             '                    _mark_turn_ended(o2.node(nid), _popped)\n'),
        ],
    },
    {
        'id': 'M14',
        'what': "read the stamp's PRESENCE instead of its ORDER, so any seat "
                'that ever finished a turn is dropped',
        'catches': "the absent-marker probe's CONTROL-C. The subtlest of "
                   'these: every other arm still passes, because every other '
                   'arm either has no stamp or has a genuinely newer one.',
        'command': ABSENT,
        'edits': [
            (SUP, '    return ended > started\n', '    return True\n'),
        ],
    },
    {
        'id': 'M15',
        'what': 'order the two stamps as STRINGS rather than as instants',
        'catches': "the absent-marker probe's LEGACY arm -- `ledger.now`'s "
                   'own documented transition quirk, where a legacy '
                   '"…:00Z" sorts after a newer "…:00.500Z"',
        'command': ABSENT,
        'edits': [
            (SUP,
             '    ended = _stamp_epoch(te.get("at"))\n'
             '    started = _stamp_epoch(inf.get("at") if isinstance(inf, Mapping) else None)\n',
             '    ended = te.get("at")\n'
             '    started = inf.get("at") if isinstance(inf, Mapping) else None\n'),
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
    for command in ([PROBE, FLAG, RACE, IDENT, SETTLE, ABSENT, STAMP]
                    if only is None else
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
