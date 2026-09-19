"""A newer turn that STARTS AND FINISHES during recovery: is its stale replay
dropped, and is an unexplained absence still replayed?

THE HOLE THIS MEASURES.  The shipped rule drops an interrupted turn's replay
when reconcile finds a DIFFERENT marker on disk -- a newer turn is running, so
the agent has moved on.  But a newer turn that also FINISHES inside the
dispatch window leaves no marker at all: a turn's own `finally` pops the one it
wrote.  The seat then reads as absent, and absent replayed.  So the case most
clearly inside the user's ruling -- "an agent has already started a newer turn"
-- was the one case the implementation could not see.

WHY IT CANNOT BE FIXED BY WIDENING THE CONDITION.  Absence is not evidence.
`if not _ours: drop` would also discard the drive text of a seat whose marker
went missing for any other reason, and that text exists nowhere else.  The fix
under test instead WRITES THE FACT DOWN: the turn's own `finally` stamps
`turn_ended` beside the pop, and reconcile drops only when that stamp names a
turn that started LATER than the interrupted one.  No stamp means no evidence,
and no evidence means replay.

FIVE ARMS.  Three of them are controls, and they pull in OPPOSITE directions,
which is the point: a fix can fail this probe by being either too timid or too
eager, and a fix that reads the stamp without reading its ORDER fails the
fourth while passing the first three.

    quiet         nothing concurrent happens.  CONTROL: every seat's own
                  marker is spent by its own dispatch and replayed, exactly as
                  designed.  A fix that dropped too eagerly would strand the
                  whole org, and without this arm the probe would call that a
                  pass.

    finished      a newer turn starts on the victim during seat #1's dispatch
                  and FINISHES before the loop reaches it.  CLAIM: the stale
                  replay is DROPPED -- never dispatched, old text never sent --
                  and the seat counts as settled, so the positional restore
                  window in reconcile's `finally` does not put the marker back.

    vanished      the victim's marker is removed during the pass by something
                  that is NOT a turn, so no `turn_ended` stamp is written.
                  This is `desktop_recovery.py`'s plain pop, and it is the
                  shape the halt path leaves behind too.  CONTROL: the seat is
                  STILL REPLAYED.  A fix that drops on bare absence fails here.

    stale_stamp   the victim carries a `turn_ended` from a turn that ran
                  BEFORE the interrupted one -- the ordinary state of any seat
                  that has ever completed a turn -- and then its marker
                  vanishes without a turn.  CONTROL: STILL REPLAYED.  A fix
                  that treats the mere PRESENCE of a stamp as proof drops this
                  seat, and without this arm that fix passes everything else.

    legacy        the interrupted marker carries a SECOND-RESOLUTION `at` from
                  a build older than the 2026-07-31 millisecond ruling, and
                  the newer turn finishes 500 ms later.  CLAIM: DROPPED.  This
                  is the arm that distinguishes an epoch comparison from a
                  string one: `ledger.now`'s own comment records that a legacy
                  "...:00Z" sorts AFTER a newer "...:00.500Z", so a string
                  compare calls the later turn the earlier one and lets the
                  stale replay through.

    python tools/run-python-verification.py tests/restart_reconcile_absent_marker_probe.py

⚠ HOW THE CONCURRENT TURN IS SIMULATED, STATED PLAINLY.  `send_message` is
stubbed, so no real turn runs.  The arms that need one therefore write the
newer marker in the shape the turn start writes it, and then end that turn BY
CALLING THE PRODUCTION HELPER `supervisor._mark_turn_ended` -- the same
function the real `finally` calls, not a hand-rolled copy of the stamp.  If
that helper ever stops writing what reconcile reads, this probe goes red with
it.  What is NOT covered here: that the real `finally` actually calls it.  That
is one line, and the mutation harness covers it (M13).  That the stamp survives
a real `save_org` round trip IS covered -- the `finished` arm re-reads the doc
from disk at the end and asserts it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="absent-marker-probe-")
os.environ["ORGTREE_DATA"] = _root.name

REPO = os.environ.get("ORGTREE_REPO") or str(Path(__file__).resolve().parents[1])
sys.path.insert(0, os.path.join(REPO, "tools"))
from assert_repo_import import assert_repo_import           # noqa: E402

for _line in assert_repo_import(REPO).receipt():
    print(_line)

from orgtree import store, ledger, supervisor as sup        # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve(), \
    f"data root is {store.DATA_ROOT}, not the throwaway {_root.name}"

NODES = ("alpha", "bravo", "charlie")
OLD_AT = "2026-09-19T00:00:00.000Z"      # the interrupted turns
NEW_AT = "2026-09-19T05:55:55.555Z"      # the turn that runs DURING the pass
VICTIM = "charlie"                        # last in the loop, so the window is widest

#: a turn this seat completed BEFORE the one that was interrupted. Every seat
#: that has ever finished a turn carries one of these, so `stale_stamp` is the
#: ordinary case and not an exotic one.
EARLIER_AT = "2026-09-18T00:00:00.000Z"

#: the legacy arm. `LEGACY_OLD_AT` is second-resolution, as `ledger.now` wrote
#: before 2026-07-31; `LEGACY_NEW_AT` is 500 ms LATER in real time but sorts
#: EARLIER as a string, because '.' < 'Z'. Asserted below so the arm cannot
#: quietly stop testing what it says it tests.
LEGACY_OLD_AT = "2026-09-19T00:00:00Z"
LEGACY_NEW_AT = "2026-09-19T00:00:00.500Z"
assert LEGACY_NEW_AT < LEGACY_OLD_AT, \
    "the legacy arm is pointless unless the later stamp sorts earlier as a string"


def seed(slug: str, old_at: str = OLD_AT, victim_stamp: str | None = None) -> None:
    """Three live seats, each carrying an interrupted-turn marker.

    Written directly rather than by running three real turns, for the reason
    the spend-race probe gives: the marker SHAPE is what reconcile reads, and
    the kill probe already covers markers written by real turns.

    `victim_stamp` seeds a `turn_ended` from a turn that already completed
    before the interruption -- see the `stale_stamp` arm.
    """
    org = store.create_org(slug)
    for name in NODES:
        org.hire(ledger.USER, None, "haiku", 0, name)
    store.save_org(org)
    with store.DOC_LOCK:
        o = store.load_org(slug)
        for name in NODES:
            at = old_at if name == VICTIM else OLD_AT
            o.node(name)["inflight"] = {
                "at": at,
                "text": f"OLD-INTERRUPTED-TURN for {name}",
                "view": f"OLD-INTERRUPTED-TURN for {name}"}
        if victim_stamp is not None:
            o.node(VICTIM)["turn_ended"] = {
                "at": victim_stamp, "ended": victim_stamp}
        store.save_org(o)


def _newer_turn_runs_and_finishes(slug: str, new_at: str = NEW_AT) -> None:
    """A whole turn, start to finish, on the victim -- while the loop is
    elsewhere.  Start writes the marker in the shape the supervisor writes at
    turn start; end pops it and stamps `turn_ended` THROUGH THE PRODUCTION
    HELPER, so this arm cannot pass against a helper that writes something
    reconcile does not read."""
    with store.DOC_LOCK:
        o = store.load_org(slug)
        o.node(VICTIM)["inflight"] = {
            "at": new_at,
            "text": "NEW-TURN that ran during the startup pass",
            "view": "NEW-TURN that ran during the startup pass"}
        store.save_org(o)
    with store.DOC_LOCK:
        o = store.load_org(slug)
        popped = o.node(VICTIM).pop("inflight", None)
        sup._mark_turn_ended(o.node(VICTIM), popped)
        store.save_org(o)


def _marker_vanishes(slug: str) -> None:
    """The marker is taken by something that is NOT a turn, so nothing stamps
    `turn_ended`.  Copied from `desktop_recovery.py`, which pops it exactly
    like this; `halt.py` leaves the same absence behind when it moves the
    marker into `halt["interrupted_turn"]`."""
    with store.DOC_LOCK:
        o = store.load_org(slug)
        o.node(VICTIM).pop("inflight", None)
        store.save_org(o)


ARMS = {
    # arm            old_at          seeded stamp   what happens mid-pass
    "quiet":        (OLD_AT,        None,          None),
    "finished":     (OLD_AT,        None,          "turn"),
    "vanished":     (OLD_AT,        None,          "vanish"),
    "stale_stamp":  (OLD_AT,        EARLIER_AT,    "vanish"),
    "legacy":       (LEGACY_OLD_AT, None,          "turn-legacy"),
}


def run(arm: str) -> dict:
    old_at, victim_stamp, during = ARMS[arm]
    # ⚠ HYPHENS, because `create_org` SLUGIFIES. An arm named with an
    # underscore was created as `...-stale-stamp` and then looked up as
    # `...-stale_stamp`, which failed as "no such org" -- a setup error that
    # looks nothing like one.
    slug = f"absent-marker-{arm}".replace("_", "-")
    seed(slug, old_at=old_at, victim_stamp=victim_stamp)

    dispatched: list[str] = []
    replay_text: dict[str, str] = {}

    def drive(_slug, nid, text, **kw):
        dispatched.append(nid)
        # ⚠ THE WHOLE TEXT IS KEPT, and the first version of this probe did
        # not keep it. A replay is WRAPPED: `_restart_replay` composes an
        # "[ORGTREE RESTART] ..." preamble of a few hundred characters and
        # puts the interrupted turn's own text after it. Searching a 200-char
        # slice for that text therefore found nothing on a seat that HAD been
        # replayed, and the control arm reported lost work that had not been
        # lost. The display copy below is still truncated; assertions read
        # this one.
        replay_text[nid] = (text or "")
        if len(dispatched) == 1:
            # ⚠ THE WINDOW, made deterministic. Seat #1's turn is running and
            # the dispatch loop holds no lock, so anything may write the doc
            # here -- which is the premise the whole ticket rests on.
            if during == "turn":
                _newer_turn_runs_and_finishes(_slug)
            elif during == "turn-legacy":
                _newer_turn_runs_and_finishes(_slug, new_at=LEGACY_NEW_AT)
            elif during == "vanish":
                _marker_vanishes(_slug)
        return {"accepted": True, "queued": 0}

    real_send = sup.send_message
    sup.send_message = drive
    try:
        sup.reconcile(slug, active_only=True)       # exactly what api.py runs
    finally:
        sup.send_message = real_send

    org = store.load_org(slug)
    after = {n: (org.node(n).get("inflight") or {}).get("at") for n in NODES}
    stamp = org.node(VICTIM).get("turn_ended")
    # ⚠ CLOSE THE POOL, or the run is reported as SKIPPED rather than PASSED
    # (WinError 32 on the TemporaryDirectory cleanup) -- see the spend-race
    # probe, where that was measured.
    store._POOL.close_all(slug)
    victim_text = replay_text.get(VICTIM)
    return {
        "arm": arm,
        "dispatched": dispatched,
        "marker_at_after_pass": after,
        "victim_marker_after": after[VICTIM],
        # the ASSERTED fact, taken from the whole text rather than a slice
        "victim_got_old_text": "OLD-INTERRUPTED-TURN" in (victim_text or ""),
        # a readable excerpt, for the human reading a failure
        "victim_replay_excerpt": (victim_text or "")[:200] or None,
        "victim_turn_ended_after": stamp,
    }


def _dropped(res: dict) -> bool:
    """The victim was skipped entirely: not dispatched, old text never sent."""
    return VICTIM not in res["dispatched"] and not res["victim_got_old_text"]


def _replayed(res: dict) -> bool:
    return VICTIM in res["dispatched"] and res["victim_got_old_text"]


def main() -> int:
    res = {arm: run(arm) for arm in ARMS}

    for arm, r in res.items():
        print(f"\n=== ARM: {arm} ===")
        print(json.dumps(r, indent=2))

    rc = 0
    print("\n================ VERDICT ================")

    # -- CONTROL A: the ordinary path still spends and replays everything.
    # Without this, a fix that dropped every seat would look like a pass.
    quiet = res["quiet"]
    if not (quiet["victim_marker_after"] is None
            and quiet["dispatched"] == list(NODES)):
        print("CONTROL-A BROKEN SETUP -- the quiet arm did not replay all "
              f"three seats (dispatched={quiet['dispatched']}, "
              f"victim marker {quiet['victim_marker_after']!r}).")
        print("          Nothing below is measuring the defect. NOT REPORTING.")
        print("=========================================")
        return 3
    print("CONTROL-A quiet arm replayed all three seats and spent their own "
          "markers -> OK")

    # -- THE CLAIM: a newer turn that started AND FINISHED drops the replay.
    finished = res["finished"]
    if _dropped(finished):
        print(f"CLAIM     {VICTIM}'s newer turn ran and finished, and the "
              "stale replay was discarded rather than dispatched -> OK")
    else:
        print(f"CLAIM     {VICTIM} ran a whole newer turn during the pass and "
              "was STILL SENT the interrupted turn's drive text -> STALE REPLAY")
        print(f"          dispatched={finished['dispatched']}, "
              f"replay={finished['victim_replay_excerpt']!r}")
        print("          The agent has already done newer work; this injects "
              "pre-restart instructions behind it. Same ruling as a newer "
              "turn still running (user 2026-09-19), different disguise: the "
              "finished turn left no marker to recognise it by.")
        rc = 1

    # -- SETTLED: the dropped seat must not be restored by the positional
    # `finally` slice, or the next boot replays the very turn just dropped.
    if finished["victim_marker_after"] is None:
        print("SETTLED   the dropped seat left no marker behind -> OK")
    else:
        print(f"SETTLED   {VICTIM}'s OLD marker was written back after the "
              f"drop ({finished['victim_marker_after']!r}) -> NOT SETTLED")
        print("          `undispatched = inflight[dispatched:]` is positional: "
              "a drop that does not count the seat both restores this marker "
              "and shifts the window onto a seat that really was dispatched.")
        rc = 1

    # -- ROUND TRIP: the stamp the decision rests on must survive `save_org`.
    # Cheap to assert, and it is the one assumption the arm above would hide:
    # if `turn_ended` did not persist, the drop could only have come from
    # something else.
    stamp = finished["victim_turn_ended_after"]
    if isinstance(stamp, dict) and stamp.get("at") == NEW_AT:
        print(f"STAMP     `turn_ended` persisted and named the newer turn "
              f"({stamp.get('at')}) -> OK")
    else:
        print(f"STAMP     `turn_ended` did not survive the doc round trip "
              f"({stamp!r}, expected at={NEW_AT}) -> NO EVIDENCE")
        print("          Then the drop above was decided on something other "
              "than the evidence this fix claims to use.")
        rc = 1

    # -- CONTROL B: bare absence, with nothing proving a turn ran, must STILL
    # replay. This is the arm a drop-on-absence fix fails.
    if _replayed(res["vanished"]):
        print(f"CONTROL-B {VICTIM}'s marker vanished with no turn behind it "
              "and the interrupted turn was still replayed -> OK")
    else:
        print(f"CONTROL-B {VICTIM}'s marker vanished with NO evidence a turn "
              "ran, and its interrupted turn was DISCARDED anyway -> LOST WORK")
        print(f"          dispatched={res['vanished']['dispatched']}, "
              f"replay={res['vanished']['victim_replay_excerpt']!r}")
        print("          Absence is not proof. This is a seat whose drive "
              "text existed nowhere else, thrown away on a missing key -- the "
              "exact loss the restart-stranding fix exists to prevent.")
        rc = 1

    # -- CONTROL C: a stamp from an EARLIER turn is not proof of a later one.
    if _replayed(res["stale_stamp"]):
        print(f"CONTROL-C {VICTIM} carried a stamp from a turn that ran "
              "BEFORE the interruption, and was still replayed -> OK")
    else:
        print(f"CONTROL-C {VICTIM} was dropped on the strength of a "
              "`turn_ended` from BEFORE the interrupted turn -> LOST WORK")
        print(f"          dispatched={res['stale_stamp']['dispatched']}, "
              f"stamp={res['stale_stamp']['victim_turn_ended_after']!r}")
        print("          Every seat that has ever completed a turn carries "
              "one of these. Reading the stamp's PRESENCE rather than its "
              "ORDER drops the interrupted work of the whole fleet.")
        rc = 1

    # -- LEGACY: ordering must be by instant, not by string.
    if _dropped(res["legacy"]):
        print("LEGACY    a second-resolution interrupted marker was ordered "
              "correctly against a later millisecond stamp -> OK")
    else:
        print("LEGACY    a newer turn finished 500ms after a SECOND-RESOLUTION "
              "interrupted marker, and the stale replay went out anyway "
              "-> WRONG ORDER")
        print(f"          dispatched={res['legacy']['dispatched']}, "
              f"stamp={res['legacy']['victim_turn_ended_after']!r}")
        print(f"          As strings {LEGACY_NEW_AT!r} < {LEGACY_OLD_AT!r}, "
              "which is the transition quirk `ledger.now` documents. The "
              "comparison has to parse both to an instant.")
        rc = 1

    print("=========================================")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
