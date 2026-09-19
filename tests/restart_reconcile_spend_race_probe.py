"""Does the per-marker spend destroy a marker that belongs to a DIFFERENT turn?

Review probe for `whiteout-reconcile` @ 0860d48, written by restart-mail against
the premise whiteout asked to have challenged: "is spending under a fresh
`store.load_org` inside the dispatch loop safe against anything else writing the
doc between collection and dispatch?"

THE ASYMMETRY UNDER TEST.  reconcile() now has two places that touch a marker
outside the collection lock, and they do NOT guard the same way.

  the spend, before each dispatch (supervisor.py:31702)
      if nid in _spend.nodes and _spend.node(nid).get("inflight"):
          _spend.node(nid).pop("inflight", None)          # <-- TRUTHINESS ONLY

  the restore, in the finally (supervisor.py:31750)
      if nid in back.nodes and not back.node(nid).get("inflight"):
          back.node(nid)["inflight"] = inf                # <-- REFUSES to clobber

The restore path knows the hazard and says so in its own comment: "A node that
has since started a new turn owns its own marker and must not be overwritten."
The spend path has the mirror-image hazard and no guard.  It pops whatever
marker is on disk RIGHT NOW, without checking that it is the marker this
iteration collected and is about to pay for.

WHY THE WINDOW IS REAL.  Collection happens under DOC_LOCK and the lock is
released at supervisor.py:31681.  The dispatch loop then runs OUTSIDE it, and
every iteration is a whole turn: seat #1's agent runs, does work, and can
`orgtree_message` seat #3.  `st["busy"]` is process state and is False after a
restart, so that message starts a real turn on seat #3, which writes seat #3 a
NEW `inflight` (supervisor.py:18227).  The loop then reaches seat #3 and spends
-- destroying the RUNNING turn's marker and replaying the OLD text on top of it.

Under the OLD code this could not happen: every marker was popped up front, so
by the time the loop reached seat #3 the old marker was already off disk and a
newly-written one was simply left alone.  This is a window the fix OPENS.

TWO ARMS, and the second is the control.

    concurrent   a new turn starts on `charlie` during `alpha`'s dispatch.
                 charlie's NEW marker must SURVIVE -- it belongs to a turn
                 that is running right now and was never reconcile's to spend.
    quiet        nothing concurrent happens.  charlie's own old marker is
                 spent by its own dispatch, exactly as designed.  If this arm
                 does not spend, the probe is measuring a broken setup rather
                 than the defect, and it says so instead of reporting.

    python tools/run-python-verification.py tests/restart_reconcile_spend_race_probe.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="spend-race-probe-")
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
OLD_AT = "2026-09-19T00:00:00.000Z"          # the interrupted turns
NEW_AT = "2026-09-19T05:55:55.555Z"          # the turn that starts DURING the pass
VICTIM = "charlie"                            # last in the loop, so the window is widest


def seed(slug: str) -> None:
    """Three live seats, each carrying an interrupted-turn marker.

    Written directly rather than by running three real turns: the marker SHAPE
    is what reconcile reads, and it is pinned at supervisor.py:18207-18227
    ({"at": now_iso(), "text": ..., "view": ...}).  whiteout's kill probe seeds
    the same state with real turns; this probe is about what reconcile does
    with the markers, not about who wrote them.
    """
    org = store.create_org(slug)
    for name in NODES:
        org.hire(ledger.USER, None, "haiku", 0, name)
    store.save_org(org)
    with store.DOC_LOCK:
        o = store.load_org(slug)
        for name in NODES:
            o.node(name)["inflight"] = {
                "at": OLD_AT,
                "text": f"OLD-INTERRUPTED-TURN for {name}",
                "view": f"OLD-INTERRUPTED-TURN for {name}"}
        store.save_org(o)


def run(arm: str) -> dict:
    slug = f"spend-race-{arm}"
    seed(slug)

    dispatched: list[str] = []
    replay_text: dict[str, str] = {}

    def drive(_slug, nid, text, **kw):
        dispatched.append(nid)
        replay_text[nid] = (text or "")[:200]
        if arm == "concurrent" and len(dispatched) == 1:
            # ⚠ THE RACE, made deterministic. While seat #1's turn is running,
            # something else starts a REAL turn on the victim -- seat #1's own
            # agent sending it mail is the ordinary way, and `send_message` is
            # stubbed here, so the marker write is performed directly in the
            # shape supervisor.py:18227 writes it. This is a concurrent writer,
            # not a contrivance: the dispatch loop holds no lock.
            with store.DOC_LOCK:
                o = store.load_org(_slug)
                o.node(VICTIM)["inflight"] = {
                    "at": NEW_AT,
                    "text": "NEW-RUNNING-TURN started during the startup pass",
                    "view": "NEW-RUNNING-TURN started during the startup pass"}
                store.save_org(o)
        return {"accepted": True, "queued": 0}

    real_send = sup.send_message
    sup.send_message = drive
    try:
        sup.reconcile(slug, active_only=True)       # exactly what api.py runs
    finally:
        sup.send_message = real_send

    org = store.load_org(slug)
    after = {n: (org.node(n).get("inflight") or {}).get("at") for n in NODES}
    return {
        "arm": arm,
        "dispatched": dispatched,
        "marker_at_after_pass": after,
        "victim_marker_after": after[VICTIM],
        "victim_replay_text": replay_text.get(VICTIM),
    }


def main() -> int:
    quiet = run("quiet")
    concurrent = run("concurrent")

    print("\n=== ARM: quiet (CONTROL) ===")
    print(json.dumps(quiet, indent=2))
    print("\n=== ARM: concurrent ===")
    print(json.dumps(concurrent, indent=2))

    # CONTROL: the ordinary path must still spend the marker it paid for.
    control_ok = (quiet["victim_marker_after"] is None
                  and VICTIM in quiet["dispatched"])
    # THE CLAIM: a marker written by a DIFFERENT, still-running turn is not
    # reconcile's to spend and must survive the pass.
    victim_survived = concurrent["victim_marker_after"] == NEW_AT
    # The second harm: the OLD text is replayed onto a node that is now
    # running a fresh turn.
    old_text_replayed = "OLD-INTERRUPTED-TURN" in (
        concurrent["victim_replay_text"] or "")

    print("\n================ VERDICT ================")
    if not control_ok:
        print("CONTROL   BROKEN SETUP -- the quiet arm did not spend "
              f"{VICTIM}'s own marker ({quiet['victim_marker_after']!r}, "
              f"dispatched={quiet['dispatched']}).")
        print("          Nothing below is measuring the defect. NOT REPORTING.")
        print("=========================================")
        return 3
    print(f"CONTROL   quiet arm spent {VICTIM}'s own marker and replayed it "
          "-> OK")
    if victim_survived:
        print(f"CLAIM     {VICTIM}'s NEW marker survived the pass "
              f"({NEW_AT}) -> SAFE")
        rc = 0
    else:
        print(f"CLAIM     {VICTIM}'s NEW marker was DESTROYED "
              f"(expected {NEW_AT}, found "
              f"{concurrent['victim_marker_after']!r}) -> MARKER LOSS")
        print("          The running turn now has no marker: if the backend "
              "dies again, nothing replays it, and the desk draws the node "
              "as idle. This is the exact failure 427ae61 set out to fix, "
              "re-entered through the spend it added.")
        rc = 1
    if old_text_replayed:
        print(f"ALSO      the OLD interrupted text was replayed onto {VICTIM} "
              "while its new turn was running -> DOUBLE DRIVE")
    print("=========================================")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
