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
resolves again on the locked document. When the answer differs (a rename or
hire in between), the send writes a row it does not hold, PG-0 refuses it
(`UnlockedWrite`) and the door turns that into a widening: it rolls back,
locks the union and re-runs (pgdoor, "Two things widen it"). A name that does not resolve on the snapshot locks only
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


# ----------------------------------------------- orgtree_ask / withdraw_ask

ASK = "orgtree_ask"
WITHDRAW_ASK = "orgtree_withdraw_ask"


def ask_spec(snapshot: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """An ask parks a card in `asks` (and, attached to a docket item, checks
    `work_items`); an agent without a user audience has it ROUTED to its
    superior as question mail instead — so the superior's send rows are
    locked up front (the door drives `routed` after the commit)."""
    parent = None
    try:
        parent = (snapshot.nodes.get(str(call.node)) or {}).get("parent")
    except Exception:                                        # noqa: BLE001
        pass
    rows = mailtx.merge(mailtx.send_rows(str(parent)) if parent else {},
                        sections=["asks"] + (["work_items"] if a.get("work_item") else []),
                        logs=["events"])
    return pgdoor.TxSpec(**{k: tuple(v) for k, v in rows.items()})


def ask_body(t: pgdoor.AgentTx) -> dict[str, Any]:
    """The legacy `orgtree_ask` branch, verbatim, on the locked document."""
    a = t.args
    return t.org.ask_user(t.node, a.get("question") or "",
                          options=a.get("options"),
                          multi=bool(a.get("multi")),
                          header=a.get("header"),
                          questions=a.get("questions"),
                          work_item=(str(a["work_item"]) if a.get("work_item") else None))


#: withdrawing clears the caller's open ask and its scope / credit requests
WITHDRAW_SPEC = pgdoor.TxSpec(sections=("asks", "credit_requests", "scope_requests"),
                              logs=("events",))


def withdraw_body(t: pgdoor.AgentTx) -> dict[str, Any]:
    return t.org.withdraw_ask(t.node)


# ------------------------------------------------------------ orgtree_audience

AUDIENCE = "orgtree_audience"


def audience_spec(snapshot: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """Audience actions write the audience tables and the decision mail /
    notices to the parties named in the arguments (resolved in the body; a
    party the snapshot misses is widened in)."""
    parties = [str(a.get(k) or "") for k in ("target", "from", "grantee")]
    who: list[str] = []
    for p in parties:
        if p:
            who += _resolve_on_snapshot(snapshot, p)
    try:
        # a request's first hop is mail to the caller's own superior
        parent = (snapshot.nodes.get(str(call.node)) or {}).get("parent")
    except Exception:                                        # noqa: BLE001
        parent = None
    if parent:
        who.append(str(parent))
    rows = mailtx.merge(mailtx.audience_rows(who[0]) if who else {},
                        *(mailtx.send_rows(w) for w in who[1:]),
                        sections=["audiences", "audience_requests"],
                        logs=["events"])
    return pgdoor.TxSpec(**{k: tuple(v) for k, v in rows.items()})


def audience_body(t: pgdoor.AgentTx) -> dict[str, Any]:
    """The legacy `orgtree_audience` branch on the locked document; the
    agents it names to wake are driven after the commit."""
    a, org, me = t.args, t.org, t.node
    action = a.get("action", "")
    if action == "request":
        result = org.request_audience(me, a.get("target", ""), a.get("reason", ""))
    elif action == "forward":
        result = org.audience_forward(me, a.get("from", ""), a.get("target", ""))
    elif action == "grant":
        result = org.audience_grant(me, a.get("from", ""), a.get("target") or None)
    elif action == "deny":
        result = org.audience_deny(me, a.get("from", ""), a.get("target", "") or me)
    elif action == "revoke":
        result = org.audience_revoke(me, a.get("grantee", ""))
    else:
        raise LedgerError("action must be request|forward|grant|deny|revoke")
    for n in result.pop("drive", []):
        if n not in t.after.drive:
            t.after.drive.append(n)
    return result


def declare(notify: Notify, steer: Steer, note: Note) -> None:
    """Register the mail tools on the door (api calls this once at import)."""
    pgdoor.declare(NOTICE, notice_spec, body=notice_body(notify, steer, note))
    pgdoor.declare(ASK, ask_spec, body=ask_body)
    pgdoor.declare(WITHDRAW_ASK, WITHDRAW_SPEC, body=withdraw_body)
    pgdoor.declare(AUDIENCE, audience_spec, body=audience_body)
