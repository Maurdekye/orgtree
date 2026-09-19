"""Strand a seat in the dispatch loop, kill, restart -- and read the bytes the
rescued agent is handed.

THIS IS THE JOIN, AND THE JOIN IS THE POINT.  Two results already exist and
they are not the same result:

  * `restart_reconcile_kill_probe.py` (whiteout): a seat the startup dispatch
    loop never reached keeps its `inflight` marker across a hard kill and IS
    replayed at the next boot.
  * `restart_mail_kill_probe.py` + `test_restart_resume.py` §10 (restart-mail):
    a replayed seat's queued mail rides its FIRST turn's input.

"A stranded agent therefore gets its mail when it is rescued" follows from the
two TOGETHER.  Neither agent measured the composition, both said so, and it is
recorded as decision 5 on the marker ticket.  A join nobody runs is exactly the
shape that stays true right up until one half changes.  This probe runs it: one
process lineage, one fixture, strand -> kill -> restart -> replay -> delivery.

WHICH MECHANISM DELIVERED IT IS NOT ASSUMED, IT IS SEPARATED.  There are two
rescue routes at startup and they are easy to confuse for one:

  MARKER   `reconcile` replays a seat that still holds an `inflight` marker.
           The mail is drained at the start of that replayed turn.
  DRAIN    a seat with NO marker but a durable `mail_drain` record is driven,
           and the mail is drained at the start of THAT turn instead.

           ⚠ The DRAIN route is ONE RECORD WITH TWO DISPATCHERS, and the arm
           below removes the record rather than either dispatcher, because
           removing one dispatcher removes nothing: `reconcile`'s own revive
           list (gated on `maildrain.pending` when `active_only`) and
           `maildrain.recover()`, run by the consumer `maildrain.start()`
           keeps alive.  Measured, not assumed -- killing the revive list
           outright still delivers on every arm (mutant M4), while making
           `maildrain.pending` answer False takes the whole route out and
           turns `drain-only` red (mutant M5).

A run that only ever exercised both at once could pass forever on the drain
route while the marker route was broken, which is precisely the composition
this item exists to measure.  So the same stranding is replayed four ways:

    --arm both          marker and drain record both present (production shape)
    --arm marker-only   the drain record is removed; MARKER is the route that
                        rescues the seat  (read the warning below -- the record
                        does NOT stay removed, and that is not a defect)
    --arm drain-only    the marker is removed: only DRAIN can deliver
    --arm none          both removed: NOTHING may deliver  <- negative control

⚠ `marker-only` DOES NOT STAY MARKER-ONLY, AND THE ARM IS STILL VALID.  Found by
whiteout in review (2026-09-19) and confirmed here against the code and against a
finished run's data root -- it is written down rather than quietly relied on,
because an earlier version of this table claimed "only MARKER can deliver" and
that sentence was simply false.

The arm deletes the victim's `mail_drain` record, and then the marker route's own
replay puts it straight back.  `reconcile` replays by calling `send_message`
(supervisor.py:31862) and does not pass `wake=False`; `send_message` defaults to
`wake=True` and, at supervisor.py:24845-24847, calls `maildrain.request` for any
node whose mailbox is non-empty.  At exactly that moment the victim's mailbox
holds the message the restart fold-back just returned to it (§C prints
`"mailbox": 1`), so `maildrain.request` mints a fresh record and the caller saves
it.  A finished `marker-only` run ends with `mail_drain={"ids": [...]}` on disk.

WHY THE ARM STILL MEASURES WHAT IT CLAIMS.  The re-mint is CAUSED BY the marker
route firing -- it cannot exist unless `reconcile` already reached the replay --
so it can never deliver on its own.  And by the time the record exists the seat is
mid-turn and stays that way: the stand-in CLI holds its turn open for the rest of
the run, which is why `victim_turns` is 1 and not 2.  **That is the isolation, and
it is worth saying out loud because it is not obvious: the arm is isolated by the
ORDER of events and by the held turn, not by the record staying deleted.**

WHAT ACTUALLY LICENSES THE ARM IS M1, NOT THE DELETION.  Break the marker route
(mutant M1, the pre-fix `reconcile`) and `marker-only` goes RED while `drain-only`
stays green.  A deletion that the product undoes proves nothing by itself; a
mutant that reddens exactly one arm does.

`none` is not decoration.  Without it a green run cannot tell delivery from a
fixture that queued nothing, because a probe that never queues anything and a
probe whose delivery works look identical from the passing side.  `none` uses
the same seeding, the same kill and the same assertion, and it MUST report NOT
DELIVERED.  If it delivers, every other arm in the run is void and this probe
says so instead of reporting a pass.

IT EARNED ITS KEEP THE FIRST TIME IT RAN (2026-09-19).  `maildrain.discover()`
carries a one-shot upgrade that mints a `mail_drain` record for every live seat
with waking mail on any org that has no `mail_drain_version` -- and a brand-new
throwaway org is exactly such an org.  So the first run of `--arm none` handed
the victim its deleted record straight back and DELIVERED, and `--arm
marker-only` had quietly had both routes live the whole time.  The seed phase
now runs `discover()` once at creation, before any seat has mail, which stamps
the version the way every real org gets it and mints nothing.  The fixture must
be production-shaped or the separation of the routes is fiction.

WHAT MUTATION SHOWED, so the next reader does not have to re-derive it.  Five
mutants, each breaking one link, run against all four arms (harness:
`mutate_rescue.py` in restart-mail's scratch folder, results in
`mutation-rescue.json`):

  M1  the PRE-FIX `reconcile` -- every marker erased up front, saved before a
      single dispatch.  `marker-only` goes red; `both` and `drain-only` STILL
      DELIVER, through the drain route, and only the FAULT line reports the
      stranding.  That is why faults are judged before deliveries.
  M2  the turn-start drain takes no mail: every delivering arm goes red.
  M3  the delivery journal is never folded back: every arm red, MAIL LOST.
  M4  `reconcile`'s revive LIST is dead: nothing changes -- the record's other
      consumer delivers.  Equivalent under this probe, and a fact about the
      product rather than a gap in the test.
  M5  `maildrain.pending` answers False, taking the whole drain route out:
      `drain-only` goes red while both marker arms stay green.

M1 and M5 are a matched pair and they are the evidence for "the routes are
distinguished": each one reddens exactly the arm named after the route it
broke, and leaves the other arm green.

    python tests/restart_rescue_mail_probe.py                # all four arms
    python tests/restart_rescue_mail_probe.py --arm marker-only
    python tests/restart_rescue_mail_probe.py --kill-at 2 --hold 90

Exit codes are three, not two: 0 the composition holds, 1 a MEASURED break,
2 NOT MEASURED -- an arm could not construct the state under test and said so
instead of reporting a non-delivery it never observed.

THE ONLY SEAM IS THE PROVIDER ARGV (`_build_cmd`), in every phase.  Admission,
the inflight persist, the delivery journal, the restart fold-back, the marker
spend, the revive gate and the turn-start drain are all the shipped code.  The
stand-in CLI writes the bytes handed to its stdin into a per-seat file, and
that file is what the agent actually RECEIVED -- as opposed to what the org
document says was queued for it, which is the whole difference between this
probe and the two results it joins.

Run it explicitly; `unittest discover` does not pick it up.  Phases `seed`,
`pass` and `boot` run in child processes -- this same file, re-invoked.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO = Path(__file__).resolve().parents[1]
SLUG = 'restart-rescue-probe'
# Three seats, so the kill has somewhere to land that is neither the seat it is
# inside nor a seat already spent.  CHARLIE is the seat under test: with the
# kill at dispatch #2, ALPHA was dispatched, BRAVO is the one the loop was
# inside, and CHARLIE is the seat the loop NEVER REACHED.  That last one is the
# stranding the marker fix rescues, and it is the one the mail is queued for.
NODES = ('alpha', 'bravo', 'charlie')
VICTIM = 'charlie'
DRIVER = 'DRIVER: the work the agent was doing when orgtree died'
QUEUED = 'QUEUED-BEFORE-RESTART: this must reach the rescued agent'
ARMS = ('both', 'marker-only', 'drain-only', 'none')

# HANG holds a turn open so the engine can be killed with real interrupted
# turns on disk.  DUMP records the bytes ITS OWN seat's turn was handed, into a
# per-seat file, and then holds too -- so the measurement is of one turn's
# input and nothing is folded back underneath it.
HANG = 'import sys, time\nsys.stdin.readline()\ntime.sleep(900)\n'
DUMP = ("import sys, os, time\n"
        "nid = sys.argv[1]\n"
        "line = sys.stdin.readline()\n"
        "path = os.path.join(os.environ['PROBE_DUMP_DIR'], nid + '.jsonl')\n"
        "with open(path, 'a', encoding='utf-8') as f:\n"
        "    f.write(line if line.endswith('\\n') else line + '\\n')\n"
        "    f.flush()\n"
        "time.sleep(float(os.environ.get('PROBE_HOLD') or 900))\n")


def _bind(root):
    """Bind THIS process to a throwaway data root before orgtree is imported.

    `store.DATA_ROOT` binds at import time, so the order here is load-bearing:
    the assert below is what makes "no live ORGTREE_DATA was touched" a
    measurement rather than an intention.
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


def _tail(path, n=2500):
    """The end of a phase's own log, for a driver-side abort message."""
    try:
        return path.read_text(encoding='utf-8', errors='replace')[-n:].strip()
    except OSError:
        return '(no log)'


def _turn_texts(path):
    """The turn inputs a stand-in CLI recorded, oldest first."""
    if not path.exists():
        return []
    out = []
    for raw in path.read_text(encoding='utf-8').splitlines():
        if not raw.strip():
            continue
        try:
            content = (json.loads(raw).get('message') or {}).get('content')
        except ValueError:
            out.append(raw)
            continue
        out.append('\n'.join(str(c.get('text') or '') for c in content
                             if isinstance(c, dict))
                   if isinstance(content, list) else str(content))
    return out


# ------------------------------------------------------------------ phase 1
# Real turns on all three seats, and a real WAKING message queued for the seat
# the kill will strand.  Everything this phase leaves on disk -- the markers,
# the delivery journal, the mail_drain record -- is written by the shipped
# code, which is what makes the later phases a measurement of the product.
if len(sys.argv) > 2 and sys.argv[1] == 'seed':
    root = Path(sys.argv[2])
    store, provenance = _bind(root)
    from orgtree import ledger, supervisor

    org = store.create_org(SLUG)
    for name in NODES:
        org.hire(ledger.USER, None, 'haiku', 0, name)
    store.save_org(org)

    # ⚠ MAKE THE FIXTURE PRODUCTION-SHAPED, AND MAKE IT SO BY RUNNING THE REAL
    # CODE THAT SHAPES PRODUCTION ORGS.  `maildrain.discover()` carries a
    # ONE-SHOT UPGRADE: on an org with no `mail_drain_version` it MINTS a
    # `mail_drain` record for every live seat holding waking mail.  A brand-new
    # throwaway org is exactly that org, so the upgrade fires at the next boot
    # and hands the victim back the very record an arm below deleted -- which
    # makes `--arm none` deliver and `--arm marker-only` secretly have both
    # routes live.  Measured here on 2026-09-19: without this line the control
    # arm delivered and voided the whole run.  Running discover() NOW, while no
    # seat has any mail, stamps the version the way every real org gets it and
    # mints nothing; §C asserts the stamp is still there, so a future change
    # that re-opens the upgrade shows up as a broken fixture rather than as a
    # quietly passing run.
    supervisor.maildrain.discover()

    script = root.parent / 'hang.py'
    script.write_text(HANG, encoding='utf-8')
    supervisor._build_cmd = lambda org_, nid, *a, **k: [
        sys.executable, '-I', str(script)]

    import threading
    for name in NODES:
        threading.Thread(target=supervisor.send_message,
                         args=(SLUG, name, DRIVER), daemon=True).start()

    # `responding` as well as `inflight`: the marker appears at turn start, but
    # the message queued below only reaches the DELIVERY JOURNAL -- the durable
    # carrier the restart has to fold back -- if the victim's turn has actually
    # reached its provider.  Waiting only for the marker leaves the mail sitting
    # in the plain mailbox, and the fold-back half of the path goes unexercised.
    deadline = time.time() + 180
    marked, live = {}, {}
    while time.time() < deadline:
        o = store.load_org(SLUG)
        marked = {n: bool(o.node(n).get('inflight')) for n in NODES}
        live = {n: bool(supervisor.state(SLUG, n).get('responding'))
                for n in NODES}
        if all(marked.values()) and live[VICTIM]:
            break
        time.sleep(0.2)
    if not (all(marked.values()) and live.get(VICTIM)):
        print(json.dumps({'ready': False, 'pid': os.getpid(),
                          'why': 'not every seat reached a real turn',
                          'inflight': marked, 'responding': live}), flush=True)
        while True:
            time.sleep(1)

    # The user messages the busy victim.  This is the state the desk labels
    # "queued for a future turn boundary -- not read yet": durable in the org
    # document, not in anybody's RAM.
    with store.DOC_LOCK:
        o = store.load_org(SLUG)
        o.post_mail(ledger.USER, VICTIM, QUEUED, kind='message')
        store.save_org(o)
    sent = supervisor.send_message(SLUG, VICTIM, 'mail pointer', mail_ping=True)
    time.sleep(0.5)
    o = store.load_org(SLUG)
    print(json.dumps({
        'ready': True, 'pid': os.getpid(), 'send_result': sent,
        'inflight': {n: bool(o.node(n).get('inflight')) for n in NODES},
        'desk_stages': [m.get('stage')
                        for m in supervisor.delivering_mail(o, VICTIM)],
        'delivering': len((o.d.get('delivering') or {}).get(VICTIM) or []),
        'mailbox': len((o.d.get('mail') or {}).get(VICTIM) or []),
        'mail_drain': bool(o.node(VICTIM).get('mail_drain')),
        'mail_drain_version': o.d.get('mail_drain_version'),
        'commit': provenance.short_commit,
    }), flush=True)
    while True:                       # hold the turns open until we are killed
        time.sleep(1)


# ------------------------------------------------------------------ phase 2
# The startup pass that is killed partway through its dispatch loop, leaving
# the victim a seat the loop never reached.  `send_message` is stood in for so
# the kill point is deterministic; `reconcile` itself is the shipped code.
if len(sys.argv) > 3 and sys.argv[1] == 'pass':
    root, sig = Path(sys.argv[2]), Path(sys.argv[3])
    kill_at = int(sys.argv[4])
    store, _prov = _bind(root)
    from orgtree import supervisor

    dispatched = []

    def drive(slug, nid, text, **kw):
        dispatched.append(nid)
        sig.write_text(json.dumps({'dispatched': dispatched,
                                   'pid': os.getpid()}), encoding='utf-8')
        if len(dispatched) < kill_at:
            return {'accepted': True, 'queued': 0}
        while True:                    # ... held open until taskkill lands
            time.sleep(0.5)

    supervisor.send_message = drive
    supervisor.reconcile(SLUG, active_only=True)   # exactly what api.py runs
    print(json.dumps({'completed': True, 'dispatched': dispatched}), flush=True)
    raise SystemExit(0)


# ------------------------------------------------------------------ phase 3
# The next boot.  This is the only phase with a real `send_message`, so the
# turn the rescued seat is given is a real turn with a real provider argv, and
# the file that argv writes is the agent's actual first-turn input.
if len(sys.argv) > 4 and sys.argv[1] == 'boot':
    root, arm, dumps, out = (Path(sys.argv[2]), sys.argv[3],
                             Path(sys.argv[4]), Path(sys.argv[5]))
    store, provenance = _bind(root)
    from orgtree import supervisor

    org = store.load_org(SLUG)
    before = {
        'inflight': {n: bool(org.node(n).get('inflight')) for n in NODES},
        'mailbox': len((org.d.get('mail') or {}).get(VICTIM) or []),
        'delivering': len((org.d.get('delivering') or {}).get(VICTIM) or []),
        'mail_drain': bool(org.node(VICTIM).get('mail_drain')),
        'mail_drain_version': org.d.get('mail_drain_version'),
        'waking_mail': bool(org.waking_mail(VICTIM)),
        # Recorded because the №31 sweep at the head of `reconcile` CONDEMNS a
        # node that has run but whose transcript is gone -- and a stand-in
        # provider CLI writes no transcript.  A condemned seat is excluded from
        # both rescue routes, so it would read as a delivery failure when it is
        # really a fixture that stopped holding.  See the state check below.
        'state': {n: org.node(n).get('state') for n in NODES},
    }
    print('\u00a7C  what the killed pass left on disk: %s' % json.dumps(before))
    # \u26a0 THESE ARE FINDINGS, NOT FIXTURE CHECKS, AND THE DIFFERENCE IS THE
    # DRIVER.  The driver has already verified the state the engine died in:
    # three real markers, and the queued message in the DELIVERY JOURNAL.  So
    # anything wrong here is downstream of the killed startup pass -- it is a
    # regression in the code under test, not a fixture that failed to set up,
    # and it is recorded and judged rather than raised as a setup error.  Each
    # one names the mechanism it belongs to, because "the composition broke" is
    # not an actionable sentence.
    faults = []
    if not before['inflight'][VICTIM]:
        faults.append(
            'STRANDED: the killed startup pass destroyed the marker of a seat '
            'it never reached, so no later boot will ever replay it -- this is '
            'the stranding the marker fix exists to prevent')
    if before['delivering']:
        faults.append(
            'NOT FOLDED: the delivery journal still holds the queued batch '
            'after the restart, so the mail never returned to the mailbox')
    if before['mailbox'] < 1:
        faults.append(
            'MAIL LOST: the message that was in the delivery journal when the '
            'engine died is in neither the journal nor the mailbox')
    if not before['mail_drain']:
        faults.append(
            'NO DEMAND: the durable mail_drain record did not survive the '
            'restart, so the revive route has nothing to act on')
    # Not a finding -- a fixture guard, and the one real one.  See the seed
    # phase: an org without this stamp gets a free mail_drain record back from
    # discover()'s one-shot upgrade, which would silently re-arm the very route
    # an arm below removes.
    assert before['mail_drain_version'], (
        'the fixture org is not production-shaped -- discover() would mint the '
        'mail_drain record back and no arm of this probe would mean anything')
    # Also a fixture guard, for the same reason: a condemned victim is ineligible
    # for BOTH rescue routes, so it would report a delivery failure that is not
    # one.  Say so rather than measure it.
    assert before['state'][VICTIM] == 'live', (
        'the victim seat is %r, not live -- the №31 sweep took it out of '
        'both rescue routes, so this run cannot measure delivery'
        % before['state'][VICTIM])
    for f in faults:
        print('\u00a7C! %s' % f)

    # ---- the arm: remove one rescue route, both, or neither.
    removed = []
    with store.DOC_LOCK:
        o = store.load_org(SLUG)
        if arm in ('drain-only', 'none'):
            o.node(VICTIM).pop('inflight', None)
            removed.append('marker')
        if arm in ('marker-only', 'none'):
            o.node(VICTIM).pop('mail_drain', None)
            removed.append('mail_drain')
        if removed:
            store.save_org(o)
    store._POOL.close_all(SLUG)
    # \u26a0 "the route that rescues", NOT "the only route left".  For `marker-only`
    # the deleted record comes BACK a moment later, minted by the replay's own
    # `send_message` (see the module docstring).  Saying "only MARKER" here was
    # false for every instant after dispatch, and a probe that misdescribes its
    # own fixture is the thing this whole line of tickets keeps being bitten by.
    print('\u00a7D  arm %r: removed %s from the victim; the route that rescues '
          'the seat is %s' % (arm, removed or 'nothing',
                              {'both': 'either', 'marker-only': 'MARKER',
                               'drain-only': 'DRAIN', 'none': 'NONE'}[arm]))
    if arm == 'marker-only':
        print('    (the mail_drain record is re-minted by the replay\'s own '
              'send; it cannot deliver independently -- see the docstring)')

    dumps.mkdir(parents=True, exist_ok=True)
    script = root.parent / 'dump.py'
    os.environ['PROBE_DUMP_DIR'] = str(dumps)
    supervisor._build_cmd = lambda org_, nid, *a, **k: [
        sys.executable, '-I', str(script), nid]

    victim_dump = dumps / ('%s.jsonl' % VICTIM)
    # `reconcile` runs OFF this thread on purpose.  `send_message` blocks for
    # the whole life of the turn it starts, and the stand-in CLI holds its turn
    # open so that what is measured is ONE turn's input with nothing folded
    # back underneath it.  Reading the dump while that turn is still open is
    # what makes "the FIRST turn's input" a measurement rather than a summary
    # of whatever happened to be last.
    import threading
    boot_err = []

    def _boot():
        try:
            supervisor.reconcile(SLUG, active_only=True)  # what api.py runs
            supervisor.maildrain.discover()
        except BaseException as exc:                      # noqa: BLE001
            boot_err.append(repr(exc))

    threading.Thread(target=_boot, daemon=True).start()
    # The revive route is a background consumer, so give it real time to run
    # even in the arms where it is not expected to deliver -- an arm that
    # reports NOT DELIVERED because nobody waited would be a lie.
    deadline = time.time() + float(os.environ.get('PROBE_SETTLE') or 90)
    while time.time() < deadline and not victim_dump.exists():
        try:
            supervisor.maildrain.sweep()
        except Exception:                                 # noqa: BLE001
            pass
        time.sleep(0.5)
    time.sleep(1.0)                    # let a just-created dump finish its line
    if boot_err:
        print('§D! the startup pass raised: %s' % boot_err[0])

    turns = {n: _turn_texts(dumps / ('%s.jsonl' % n)) for n in NODES}
    vt = turns[VICTIM]
    carrying = [i + 1 for i, t in enumerate(vt) if QUEUED in t]
    occurrences = vt[0].count(QUEUED) if vt else 0
    result = {
        'arm': arm, 'removed': removed, 'state_before_boot': before,
        'faults_after_the_killed_pass': faults,
        'turns_per_seat': {n: len(t) for n, t in turns.items()},
        'victim_turns': len(vt),
        'victim_first_turn_head': vt[0][:700] if vt else None,
        'turns_carrying_the_queued_message': carrying,
        'occurrences_in_first_turn': occurrences,
        'delivered': bool(carrying[:1] == [1] and occurrences == 1),
        'startup_pass_error': boot_err[0] if boot_err else None,
        'provenance': provenance.as_dict(),
    }
    out.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('\u00a7E  the victim reached a provider %d time(s); the queued '
          'message is in turn(s) %s, %d time(s) in the first'
          % (len(vt), carrying or 'none', occurrences))
    raise SystemExit(0)


# ------------------------------------------------------------------- driver
def _run_arm(arm, kill_at, hold, settle):
    box = Path(tempfile.mkdtemp(prefix='restart-rescue-probe-'))
    root = box / 'data'
    root.mkdir()
    (box / 'home').mkdir()
    (box / 'dump.py').write_text(DUMP, encoding='utf-8')
    dumps = box / 'turn-input'
    env = {**os.environ, 'ORGTREE_DATA': str(root), 'HOME': str(box / 'home'),
           'USERPROFILE': str(box / 'home'), 'ORGTREE_V2_TOKEN': 'operator',
           'PYTHONIOENCODING': 'utf-8', 'PROBE_HOLD': str(hold),
           'PROBE_SETTLE': str(settle)}
    for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
        env.pop(key, None)

    print('\n=== ARM: %s (kill point: dispatch #%d) ===' % (arm, kill_at))
    print('\u00a7A  three real interrupted turns and one real queued message '
          'in %s' % root)
    seed = subprocess.Popen(
        [sys.executable, '-B', __file__, 'seed', str(root)],
        cwd=str(REPO), env=env, text=True, encoding='utf-8', errors='replace',
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    line, deadline = '', time.time() + 300
    while time.time() < deadline:
        line = seed.stdout.readline()
        if not line or line.lstrip().startswith('{'):
            break
    try:
        hello = json.loads(line)
    except ValueError:
        seed.kill()
        raise SystemExit('the seed never reported: %r\n%s'
                         % (line, seed.stderr.read()[-4000:]))
    if not hello.get('ready'):
        seed.kill()
        raise SystemExit('seeding never reached the state under test: %s'
                         % hello)
    print('    pid %s: markers %s, victim desk stage %s, delivery journal %s, '
          'mailbox %s, mail_drain %s, mail_drain_version %s'
          % (hello['pid'], hello['inflight'], hello['desk_stages'],
             hello['delivering'], hello['mailbox'], hello['mail_drain'],
             hello['mail_drain_version']))
    # The queued message must be in the DELIVERY JOURNAL, not merely in the
    # mailbox: the journal is the carrier the restart fold-back exists for, and
    # a run that seeded the easier state would skip that half of the path
    # without saying so.
    if not hello['delivering']:
        seed.kill()
        raise SystemExit('the queued message never reached the delivery '
                         'journal, so the restart fold-back would not be '
                         'exercised: %s' % hello)
    # And the durable demand must exist BEFORE the kill, for the same reason.
    # §C raises a NO DEMAND fault when the record is missing after the restart,
    # and that fault names the PRODUCT.  Without this gate a seed that never
    # minted one at all would produce the identical fault, blaming the engine
    # for losing a record that was never there.  Found by whiteout in review.
    if not hello['mail_drain']:
        seed.kill()
        raise SystemExit('the seed never minted a durable mail_drain record, '
                         'so §C could not tell a product failure from a '
                         'fixture that never armed the drain route: %s' % hello)

    print('\u00a7B  killing the engine the way the guardian does, then running '
          'the startup pass and killing THAT inside dispatch #%d' % kill_at)
    subprocess.run(['taskkill', '/T', '/F', '/PID', str(hello['pid'])],
                   capture_output=True)
    seed.wait(timeout=180)

    sig = box / 'dispatch.json'
    # The pass's own output goes to a FILE, not a pipe nobody drains.  A pipe
    # here deadlocks a chatty pass once the buffer fills, and -- the reason it
    # was changed -- when this phase misbehaves its `[orgtree] ...` lines are
    # the only account of what the dispatch loop actually did.
    passlog = box / 'startup-pass.log'
    with open(passlog, 'w', encoding='utf-8') as sink:
        victim = subprocess.Popen([sys.executable, '-B', __file__, 'pass',
                                   str(root), str(sig), str(kill_at)],
                                  cwd=str(REPO), env=env, text=True,
                                  stdout=sink, stderr=subprocess.STDOUT)
        deadline, seen = time.time() + 300, []
        while time.time() < deadline:
            if victim.poll() is not None:
                raise SystemExit('the startup pass exited before it could be '
                                 'killed: %s'
                                 % _tail(passlog))
            try:
                seen = json.loads(sig.read_text(encoding='utf-8'))['dispatched']
            except (OSError, ValueError, KeyError):
                seen = []
            if len(seen) >= kill_at:
                break
            time.sleep(0.1)
        if len(seen) < kill_at:
            victim.kill()
            raise SystemExit('the pass never reached dispatch #%d; nothing '
                             'was exercised: %s' % (kill_at, _tail(passlog)))
        # ⚠ THE KILL MUST LAND WHERE IT WAS AIMED, AND THIS IS NOT PEDANTRY.
        # The whole probe rests on the victim being the seat the loop NEVER
        # REACHED.  If the loop visited the seats in some other order -- a seat
        # condemned by the №31 sweep and dropped from the collection, a marker
        # skipped as a newer turn's -- then the kill lands one seat further on
        # and the victim's marker has already been spent by its own dispatch.
        # The run then reports a STRANDED fault that is an artefact of the
        # fixture rather than a regression in the product.  Measured 2026-09-19:
        # this happened roughly once in forty runs before the guard, and it is
        # exactly the kind of rare false finding that destroys trust in a probe.
        # So the expected visit order is asserted, and a run that does not get
        # it says NOT MEASURED instead of inventing a finding.
        if list(seen) != list(NODES[:kill_at]):
            victim.kill()
            raise SystemExit(
                'the dispatch loop visited %s, not %s -- the victim seat is '
                'not the never-reached one in this run, so nothing downstream '
                'would mean what it says: %s'
                % (seen, list(NODES[:kill_at]), _tail(passlog)))
        print('    the loop is inside dispatch #%d (%s); %s was never reached'
              % (kill_at, seen, VICTIM))
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(victim.pid)],
                       capture_output=True, check=True)
        victim.wait(timeout=180)

    out_path = box / 'result.json'
    boot = subprocess.run(
        [sys.executable, '-B', __file__, 'boot', str(root), arm, str(dumps),
         str(out_path)],
        cwd=str(REPO), env=env, text=True, encoding='utf-8', errors='replace',
        capture_output=True, timeout=1800)
    sys.stdout.write(boot.stdout)
    if boot.returncode:
        sys.stderr.write(boot.stderr[-8000:])
        raise SystemExit('the next-boot phase failed before it could measure '
                         'anything (arm %s)' % arm)
    result = json.loads(out_path.read_text(encoding='utf-8'))
    result['state_at_seed'] = hello
    result['dispatched_before_the_kill'] = seen
    result['box'] = str(box)
    return result


def _sweep_boxes(results, keep_all):
    """Remove each clean arm's temp box; KEEP every box worth reading.

    ⚠ THE ASYMMETRY IS THE WHOLE DESIGN, and unconditional cleanup would be the
    wrong fix.  Every earlier version leaked its box: whiteout counted 114
    `restart-rescue-probe-*` directories in %TEMP% before its review run, each
    holding a whole org document, three process logs and the per-seat stdin
    dumps.  But a box is also the only account of what an arm actually did --
    whiteout confirmed the `mail_drain` re-mint by opening a finished run's data
    root read-only, and an arm that broke unexpectedly is exactly the one whose
    evidence must survive.

    ⚠ AND IT IS SWEPT AFTER THE VERDICT, NOT INSIDE THE ARM, because the arm
    does not know what it was supposed to do.  `none` not delivering is a PASS
    and `both` not delivering is a BREAK, and only `_verdict` holds that
    expectation.  An earlier draft of this swept inside `_run_arm` on a `faults`
    key that does not exist there (it is `faults_after_the_killed_pass`), which
    would have deleted the box of every measured break in the run -- the exact
    evidence it is meant to preserve.
    """
    for arm, r in results.items():
        box = r.get('box')
        if not box or not os.path.isdir(box):
            continue
        broke = bool(r.get('faults_after_the_killed_pass')) or (
            r['delivered'] is not (arm != 'none'))
        if keep_all or broke:
            print('    (arm %s: box kept for inspection -- %s)' % (arm, box))
            continue
        shutil.rmtree(box, ignore_errors=True)


def _verdict(results):
    """Judge the run.  `none` is judged FIRST: it licenses everything else."""
    ok = True
    print('\n================ VERDICT ================')
    # ⚠ JUDGED BEFORE ANY DELIVERY LINE, because a fault here can be MASKED by
    # a delivery.  Destroy the marker of a never-reached seat and the revive
    # route still delivers the mail -- the arm reports `delivered=True` and the
    # stranding goes unmentioned.  That is precisely the "a pass attributable
    # only to the revive loop" failure this probe exists to make visible, so
    # the fault fails the run whatever the delivery lines say.
    for arm in ARMS:
        for f in results.get(arm, {}).get('faults_after_the_killed_pass') or []:
            ok = False
            print('FAULT     arm `%s`: %s' % (arm, f))
    if 'none' in results:
        r = results['none']
        good = not r['delivered']
        ok &= good
        print('CONTROL   arm `none` (no marker, no mail_drain): victim reached '
              'a provider %d time(s), delivered=%s  -> %s'
              % (r['victim_turns'], r['delivered'],
                 'OK, the probe can see a non-delivery' if good else
                 'VOID -- delivery happened with BOTH routes removed, so no '
                 'other arm in this run means anything'))
        if not good:
            print('=========================================')
            return False
    for arm in ('both', 'marker-only', 'drain-only'):
        if arm not in results:
            continue
        r = results[arm]
        good = r['delivered']
        ok &= good
        # "rescued by", not "the only route left" -- see §D and the docstring:
        # `marker-only`'s deleted record is re-minted by the replay's own send,
        # so the claim that survives is about which route RESCUED the seat.
        route = {'both': 'either route', 'marker-only': 'rescued by MARKER '
                 'alone', 'drain-only': 'rescued by DRAIN alone'}[arm]
        print('DELIVERY  arm `%s` (%s): %d turn(s), message in %s, %d time(s) '
              'in the first  -> %s'
              % (arm, route, r['victim_turns'],
                 r['turns_carrying_the_queued_message'] or 'none',
                 r['occurrences_in_first_turn'],
                 'OK' if good else 'NOT DELIVERED'))
    if {'both', 'marker-only', 'drain-only'} <= set(results):
        print('ROUTES    the two rescue routes were exercised separately, so a '
              'pass here is not attributable to the revive loop alone')
    print('=========================================')
    return ok


def main():
    want, kill_at, hold, settle = None, 2, 180, 90
    for i, a in enumerate(sys.argv):
        for flag, cast in (('--arm', str), ('--kill-at', int),
                           ('--hold', int), ('--settle', int)):
            val = None
            if a == flag and i + 1 < len(sys.argv):
                val = sys.argv[i + 1]
            elif a.startswith(flag + '='):
                val = a.split('=', 1)[1]
            if val is None:
                continue
            if flag == '--arm':
                want = val
            elif flag == '--kill-at':
                kill_at = int(val)
            elif flag == '--hold':
                hold = int(val)
            else:
                settle = int(val)
    arms = [want] if want else list(ARMS)
    for a in arms:
        if a not in ARMS:
            raise SystemExit('unknown arm %r; known: %s' % (a, ', '.join(ARMS)))
    results, aborted = {}, None
    try:
        for a in arms:
            results[a] = _run_arm(a, kill_at, hold, settle)
    except SystemExit as exc:
        # An arm that could not even reach its measurement is NOT a
        # non-delivery: it is a run that established nothing, and the two must
        # never collapse into one exit code.  Say which, in the machine line.
        aborted = str(exc)
    ok = _verdict(results) if aborted is None else False
    # An aborted run keeps EVERY box: it established nothing, so the question is
    # always "what went wrong", and the boxes are the only place that is written.
    _sweep_boxes(results, keep_all=aborted is not None)
    # ONE machine-readable line, so a mutation harness never has to guess what
    # this run meant from prose.
    print('\nRESULT_JSON ' + json.dumps({
        'ok': ok, 'arms': arms, 'aborted': aborted,
        'delivered': {a: r['delivered'] for a, r in results.items()},
        'faults': {a: r['faults_after_the_killed_pass']
                   for a, r in results.items()},
        'dispatched': {a: r['dispatched_before_the_kill']
                       for a, r in results.items()},
        'victim_turns': {a: r['victim_turns'] for a, r in results.items()}}))
    if aborted is not None:
        print('\nCOMPOSITION NOT MEASURED: %s' % aborted)
        raise SystemExit(2)
    print('\nCOMPOSITION %s over arms %s'
          % ('HOLDS' if ok else 'BROKEN', arms))
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
