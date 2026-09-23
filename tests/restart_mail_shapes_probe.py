"""Is mail queued BEFORE an orgtree restart part of the restarted agent's FIRST
turn input? Fourteen shapes of the question, side by side.

Written 2026-09-18 to reproduce a user report — "messages that are queued when
an org restarts seem to almost never get delivered to an agent when it starts up
again, only ever waiting for its first turn to end". IT DID NOT REPRODUCE: in
every shape the product is meant to deliver, the message rides the first turn,
exactly once. The two shapes that deliver nothing are a `frozen` node (which
runs nothing until resume) and `kind="notice"` mail (passive by design), and one
shape, `no-waking-send`, exposes a separate narrow hole — see below.

Runs the REAL restart path: `supervisor.reconcile(slug, active_only=True)`, the
call `api.py:1145` makes at backend startup, plus the real `_run_turn`,
`maildrain.discover/sweep`, mailbox and delivery journal. Only `_run_one_turn`'s
body is stood in for, by `_envelope(..., "turn")`, which runs the same
`_take_delivery_mail` + `_journal_drain` pair it does — the substitution
`tests/test_mail_drain.py` makes for the same reason. For the end-to-end article
— a real process, a real `taskkill /T /F`, and the actual bytes the replacement
CLI is handed — see `tests/restart_mail_kill_probe.py`.

⚠ `CONTROL-broken-drain` IS NOT A SCENARIO, IT IS THE INSTRUMENT'S OWN CHECK.
It stubs `_take_delivery_mail` to `[]` and MUST report NOT DELIVERED. A run in
which every shape reports delivery INCLUDING that one has measured nothing.

⚠ `no-waking-send` vs `no-waking-send-fresh-org` is the pair that matters if you
are chasing undelivered mail. They are the same code and the same message; the
only difference is `mail_drain_version`. On a PRODUCTION-shaped org (the marker
already set, as every real org on this machine has it) the message is never
delivered, because the restart revive loop is gated on `maildrain.pending` when
`active_only` is set and `maildrain.discover()`'s adoption of already-boxed mail
is a one-shot upgrade that has long since been spent.

Run it explicitly; `unittest discover` does not pick it up:

    python tests/restart_mail_shapes_probe.py

Provenance is proven by `tools/assert_repo_import`, not assumed: the result file
carries the commit sha and the `__file__` each engine module was imported from.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

REPO = os.environ.get("ORGTREE_REPO") or str(Path(__file__).resolve().parents[1])
sys.path.insert(0, os.path.join(REPO, "tools"))
from assert_repo_import import assert_repo_import        # noqa: E402

PROV = assert_repo_import(REPO)
for _line in PROV.receipt():
    print(_line)

_root = tempfile.TemporaryDirectory(prefix="restart-mail-repro-")
os.environ["ORGTREE_DATA"] = _root.name

from orgtree import store, ledger, supervisor as sup, maildrain   # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve(), \
    f"data root is {store.DATA_ROOT}, not the throwaway {_root.name}"


class Scenario:
    """One org, one agent, one message, one restart."""

    def __init__(self, name: str, *, responding: bool, inflight: bool,
                 fold_to_queue: bool, messages: int = 1,
                 frozen: bool = False, no_drain_marker: bool = False,
                 kind: str = "message", break_the_drain: bool = False,
                 fresh_org: bool = False):
        self.name = name
        self.slug = name
        self.responding = responding        # was the agent mid-response?
        self.inflight = inflight            # did the node carry a turn marker?
        self.fold_to_queue = fold_to_queue  # did the boundary fold it to queue?
        self.messages = messages
        self.frozen = frozen
        self.no_drain_marker = no_drain_marker   # mail posted with no waking send
        self.kind = kind
        # NEGATIVE CONTROL: deliberately break the turn-start drain, so a probe
        # that reports "delivered" for every shape is shown able to report the
        # opposite. A control that cannot fail has proved nothing.
        self.break_the_drain = break_the_drain
        self.fresh_org = fresh_org
        self.turns: list[dict] = []

    # ---------------------------------------------------------------- set-up
    def build(self) -> None:
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "haiku", 0, "worker")
        # PRODUCTION STATE, not a fresh org: every real org on this machine
        # already carries mail_drain_version 1, so `maildrain.discover`'s
        # one-shot upgrade — which adopts boxed mail that has no durable drain
        # demand — will never run again. A fresh org hides that.
        if not self.fresh_org:
            org.d["mail_drain_version"] = 1
        store.save_org(org)
        self.st = sup.state(self.slug, "worker")

        # The agent is inside a turn: busy, and (for the steer case) responding.
        # A real turn also writes the durable `inflight` marker at its start
        # (`supervisor.py:18202`) — that marker is what `reconcile` replays.
        self.st.update(busy=True, responding=self.responding)
        if self.inflight:
            with store.DOC_LOCK:
                org = store.load_org(self.slug)
                org.node("worker")["inflight"] = {
                    "text": "the work the agent was doing when orgtree died",
                    "view": "the work the agent was doing when orgtree died",
                    "at": sup.now_iso()}
                store.save_org(org)

        # The user sends message(s) to that busy agent.
        self.bodies = [f"{MESSAGE} #{i + 1}" for i in range(self.messages)]
        self.send_result = None
        for body in self.bodies:
            with store.DOC_LOCK:
                org = store.load_org(self.slug)
                org.post_mail(ledger.USER, "worker", body, kind=self.kind)
                store.save_org(org)
            if not self.no_drain_marker:
                self.send_result = sup.send_message(
                    self.slug, "worker", "mail pointer", mail_ping=True,
                    wake=(self.kind != "notice"))

        if self.frozen:
            with store.DOC_LOCK:
                org = store.load_org(self.slug)
                org.node("worker")["frozen"] = {"reason": "usage limit",
                                                "at": sup.now_iso()}
                store.save_org(org)

        if self.fold_to_queue:
            # the running response reached its boundary and folded the steer
            # carrier into the queue — this is the state the desk labels
            # "queued for a future turn boundary — not read yet"
            with sup._state_lock:
                self.st["responding"] = False
                sup._fold_steer(self.st)

        self.pre_stage = self.stage()
        self.pre_box = self.box()

    # ------------------------------------------------------------ inspection
    def stage(self) -> list[str]:
        org = store.load_org(self.slug)
        return [str(m.get("stage") or "") for m in
                sup.delivering_mail(org, "worker")]

    def box(self) -> list[str]:
        org = store.load_org(self.slug)
        return [m.get("body", "") for m in
                (org.d.get("mail") or {}).get("worker", [])]

    # --------------------------------------------------------------- restart
    def restart(self) -> None:
        """Everything in RAM is gone; the doc on disk is all that survives."""
        store._POOL.close_all(self.slug)
        sup._state.pop((self.slug, "worker"), None)
        # the whole process died: no seat is tracked in RAM any more, and no
        # other scenario's org may leak into this one's sweep
        maildrain._pending.clear()
        self.st = sup.state(self.slug, "worker")

    def run_startup(self) -> None:
        """The backend's startup pass, in the order api.py runs it."""
        def record(slug, nid, carrier, *a, **kw):
            # `_run_one_turn` composes the agent's actual first-turn input by
            # draining the mailbox INSIDE itself (supervisor.py:18078-18142).
            # Stand in for exactly that step with `_envelope`, which runs the
            # same `_take_delivery_mail` + `_journal_drain` pair — the shape
            # tests/test_mail_drain.py uses for the same reason.
            toks = list(carrier.get("toks") or []) if isinstance(carrier, dict) else []
            raw = carrier.get("text", "") if isinstance(carrier, dict) else carrier
            ids = carrier.get("mail_ids") if isinstance(carrier, dict) else None
            text, tok, _ = sup._envelope(slug, nid, raw, "turn",
                                         owned_toks=toks, mail_ids=ids)
            if tok:
                toks.append(tok)
            if slug == self.slug:
                self.turns.append({"n": len(self.turns) + 1, "text": text,
                                   "carrier_text": raw})
            sup._confirm_delivered(slug, nid, toks)
            st = sup.state(slug, nid)
            with sup._state_lock:
                sup._fold_steer(st)
                if st["queue"]:
                    return st["queue"].pop(0)
                st["busy"] = False
            return None

        broken = (patch.object(sup, "_take_delivery_mail", return_value=[])
                  if self.break_the_drain else patch.object(sup, "now_iso",
                                                            wraps=sup.now_iso))
        with broken, \
             patch.object(sup, "_native_context_hold", return_value=None), \
             patch.object(sup, "_cancel_working_cache"), \
             patch.object(sup, "_note_working_activity"), \
             patch.object(sup, "_hold_for_deploy", return_value=True), \
             patch.object(sup, "scan_steer_records"), \
             patch.object(sup, "_transcript_evidence", return_value=set()), \
             patch.object(sup, "_reconcile_steer_records"), \
             patch.object(store, "list_orgs", return_value=[{"slug": self.slug}]), \
             patch.object(sup, "_start_turn_worker", side_effect=sup._run_turn), \
             patch.object(sup, "_run_one_turn", side_effect=record):
            # exactly what api.py:1145 calls
            sup.reconcile(self.slug, active_only=True)
            # then the mail-drain consumer's first pass (api.py:1162)
            maildrain.discover()
            for _ in range(3):
                maildrain.sweep()

    # ------------------------------------------------------------------ main
    def report(self) -> dict:
        self.build()
        self.restart()
        self.run_startup()
        # per message: which turn numbers carried it (a body may only appear
        # once — twice is a double delivery and is reported as such)
        where = {b: [t["n"] for t in self.turns if b in t["text"]]
                 for b in self.bodies}
        first = all(v[:1] == [1] for v in where.values())
        once = all(len(v) == 1 for v in where.values())
        return {
            "scenario": self.name,
            "responding_at_shutdown": self.responding,
            "inflight_marker": self.inflight,
            "folded_to_queue": self.fold_to_queue,
            "messages_sent": self.messages,
            "kind": self.kind,
            "frozen_at_restart": self.frozen,
            "no_waking_send": self.no_drain_marker,
            "drain_deliberately_broken": self.break_the_drain,
            "send_result": self.send_result,
            "desk_stage_before_restart": self.pre_stage,
            "mailbox_before_restart": len(self.pre_box),
            "turns_after_restart": len(self.turns),
            "first_turn_text_head": (self.turns[0]["text"][:400]
                                     if self.turns else None),
            "turns_carrying_each_message": where,
            "mailbox_after_startup": self.box(),
            "VERDICT": ("ALL MESSAGES IN FIRST TURN, EXACTLY ONCE"
                        if first and once and self.bodies else
                        "DELIVERED TWICE" if first and not once else
                        "NOT DELIVERED AT ALL"
                        if all(not v for v in where.values()) else
                        f"PARTIAL/LATE: {where}"),
        }


MESSAGE = "PRE-RESTART-MESSAGE-CANARY: read this on your first turn"

SCENARIOS = [
    # the desk's "queued for a future turn boundary" state: drained into a
    # steer carrier, folded to the in-memory queue at the response boundary
    Scenario("queued-folded-inflight", responding=True, inflight=True,
             fold_to_queue=True),
    Scenario("queued-folded-no-inflight", responding=True, inflight=False,
             fold_to_queue=True),
    # still in the steer store when the backend died
    Scenario("steering-inflight", responding=True, inflight=True,
             fold_to_queue=False),
    Scenario("steering-no-inflight", responding=True, inflight=False,
             fold_to_queue=False),
    # busy but not responding: the raw carrier sat in the in-memory queue and
    # the mail never left the mailbox
    Scenario("busy-queue-inflight", responding=False, inflight=True,
             fold_to_queue=False),
    Scenario("busy-queue-no-inflight", responding=False, inflight=False,
             fold_to_queue=False),
    # several messages across one restart — the live coordinator carried 15
    # unconfirmed batches at once when this was measured
    Scenario("many-messages-inflight", responding=True, inflight=True,
             fold_to_queue=True, messages=4),
    Scenario("many-messages-idle", responding=True, inflight=False,
             fold_to_queue=True, messages=4),
    # the agent is idle when the message arrives and the backend dies before
    # the turn it started can drain anything
    Scenario("idle-target", responding=False, inflight=False,
             fold_to_queue=False, messages=1),
    # frozen (usage limit) at the moment of the restart
    Scenario("frozen-at-restart", responding=False, inflight=False,
             fold_to_queue=False, frozen=True),
    # waking mail in the box with NO durable drain demand — any poster that
    # does not go through a waking send_message leaves this state
    Scenario("no-waking-send", responding=False, inflight=False,
             fold_to_queue=False, no_drain_marker=True),
    # the same, on a FRESH org, where discover()'s one-shot upgrade still runs
    Scenario("no-waking-send-fresh-org", responding=False, inflight=False,
             fold_to_queue=False, no_drain_marker=True, fresh_org=True),
    # passive notices: by design they must NOT start a turn
    Scenario("notice-only", responding=False, inflight=False,
             fold_to_queue=False, kind="notice"),
    # ⚠ NEGATIVE CONTROL — the drain is deliberately broken. If this scenario
    # reports delivery, the probe is not measuring delivery at all.
    Scenario("CONTROL-broken-drain", responding=True, inflight=True,
             fold_to_queue=True, break_the_drain=True),
]


def main() -> int:
    rows = []
    for sc in SCENARIOS:
        try:
            rows.append(sc.report())
        except Exception as exc:                            # noqa: BLE001
            import traceback
            rows.append({"scenario": sc.name, "ERROR": repr(exc),
                         "traceback": traceback.format_exc()})
    out = {"data_root": _root.name, "results": rows}
    # the one-line summary FIRST, so a reader who pipes this through `head`
    # still sees every verdict. (The full JSON below is the record; an earlier
    # version printed only that, and `| head` then killed the run with SIGPIPE
    # before the result file was written.)
    for row in rows:
        print("%-30s %s" % (row["scenario"],
                            row.get("VERDICT") or row.get("ERROR")))
    control = [r for r in rows if r["scenario"].startswith("CONTROL")]
    if not control or any("NOT DELIVERED" not in (r.get("VERDICT") or "")
                          for r in control):
        print("\n⚠ THE NEGATIVE CONTROL DID NOT FAIL — this run measured "
              "nothing and its verdicts must not be quoted.")
    print()
    print(json.dumps(out, indent=2, default=str))
    # NEVER into the checkout: this file lives in tests/, and defaulting beside
    # it dropped a result file into the repo on every run.
    dest = PROV.write_result(
        os.environ.get("REPRO_OUT")
        or Path(tempfile.gettempdir()) / "restart-mail-shapes-result.json", out)
    print(f"\nwritten: {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
