"""S1 (fence-off): the agent MAIL tools on the shared row-transaction door.

PG-3d moved the mail WRITES (a send, a delivery) onto `org_tx` and `mailtx`,
but the TOOLS that make them — `orgtree_send_notice`, `orgtree_message`,
`orgtree_ask`, `orgtree_withdraw_ask`, `orgtree_audience` — still ran inside
`agent_call`'s resident DOC_LOCK cycle (api.py, "the RESIDENT write cycle"),
which takes the process-wide lock even with the transition fence off.
Declared here, each runs on the door instead (when `pgdoor.enabled()`): ONE
`org_tx` with pgdoor's prologue (the caller's row held, halt and killswitch
checked on the locked rows, the receipt filed last), then the door's generic
post-commit tail.

THE ROWS. A send's rows depend on its RESOLVED recipient (`mailtx.send_rows`).
`spec` resolves on the lock-free snapshot the door hands it; the body
resolves again on the locked document and raises `pgdoor.Widen` when the
answer differs (a rename or hire in between) — the door rolls back, locks the
union and re-runs. A name that does not resolve on the snapshot locks only
the send's shared rows; the body's own resolution then raises the ledger's
refusal, and nothing is written.

AFTER THE COMMIT. Everything the legacy cycle did after its save for these
tools — the spark on the wire (`mail_notify`), the steer that carries a
notice into a running recipient, the delivery note that names the carrier —
is appended to `after.then`, so it runs only once the send is durable and
never on a rolled-back or re-run attempt. The body itself is a pure function
of the locked document (pgdoor RE-RUN SAFETY).

The api-side callables are PASSED IN (api imports this module, not the
reverse), exactly as `workdoor` does.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import mailtx, pgdoor
from .ledger import USER, LedgerError

NOTICE = "orgtree_send_notice"

#: api-side effects a mail body schedules after the commit
Notify = Callable[[str, str, str], None]           # api.mail_notify(slug, frm, to)
Steer = Callable[..., Any]                          # supervisor.send_message
Note = Callable[..., Any]                           # supervisor.delivery_note


def _spec_for(recipients: list[str]) -> pgdoor.TxSpec:
    rows = mailtx.send_rows(*recipients)
    return pgdoor.TxSpec(**{k: tuple(v) for k, v in rows.items()})


def _covered(t: pgdoor.AgentTx, recipient: str) -> bool:
    """Does the transaction already hold a send to `recipient`?"""
    # compare in pgdoor's canonical row form (tuples for owner rows)
    want, have = pgdoor._norm(_spec_for([recipient])), pgdoor._norm(t.spec)
    return (set(want.nodes) <= set(have.nodes)
            and set(want.sections) <= set(have.sections)
            and set(want.logs) <= set(have.logs))


def _resolve_on_snapshot(snapshot: Any, to: str, **kw: Any) -> list[str]:
    try:
        return [snapshot._resolve_recipient(to, **kw)]
    except Exception:                                        # noqa: BLE001
        return []                  # the body's own resolution refuses it


# ------------------------------------------------------ orgtree_send_notice

def notice_spec(snapshot: Any, _call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """A notice to one in-org agent: that agent's node row, pending box and
    mail_log owner, plus a send's shared rows (notices, audiences, the logs)."""
    return _spec_for(_resolve_on_snapshot(snapshot, str(a.get("to", ""))))


def notice_body(notify: Notify, steer: Steer, note: Note
                ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    """The legacy `orgtree_send_notice` branch, on the locked document; its
    post-save steps (spark, wake=False steer, delivery note) after commit."""
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        slug, actor = str(t.call.org), t.node
        nto = t.org._resolve_recipient(str(t.args.get("to", "")))
        if nto == USER or nto.startswith("@"):
            raise LedgerError(
                "notices are for agents in this org — the user "
                "inbox and outside addresses never wake anyone "
                "anyway; send those an orgtree_message")
        if not _covered(t, nto):
            raise pgdoor.Widen(**mailtx.send_rows(nto))
        result = t.org.post_mail(actor, nto, t.args.get("body", ""), "notice")
        deferred = bool(result.get("deferred"))
        state = result.get("recipient_state") or "not live"

        def _deliver(res: Any) -> None:
            notify(slug, actor, nto)
            if not isinstance(res, dict):
                return
            if deferred:
                # a rehire alone never delivers a notice (legacy wording)
                res["delivery"] = note(slug, nto, {"deferred": state}, kind="notice")
                return
            # wake=False: steer a running recipient mid-task; an idle one
            # stays idle and reads it at its next turn
            r = steer(slug, nto,
                      "(orgtree) A notice arrived in your mail above — "
                      "informational, no reply expected. Note it and "
                      "continue your current task.",
                      wake=False, mail_ping=True, sender=actor,
                      ping_reason="notice")
            res["delivery"] = note(slug, nto, r, kind="notice")
        t.after.then.append(_deliver)
        return result
    return run


def declare(notify: Notify, steer: Steer, note: Note) -> None:
    """Register the mail tools on the door (api calls this once at import)."""
    pgdoor.declare(NOTICE, notice_spec, body=notice_body(notify, steer, note))
