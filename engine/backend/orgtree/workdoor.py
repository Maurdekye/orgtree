"""PG-3w: `orgtree_work` on the shared row-transaction door (`pgdoor`).

The docket's mutating actions used to run inside `agent_call`'s resident
DOC_LOCK cycle. Declared here, they run on the door instead (when
`pgdoor.enabled()`): ONE `org_tx` with pgdoor's prologue (the caller's node
row held, halt and killswitch checked on the locked rows, the receipt filed
last), then the door's generic post-commit tail. The read-shaped actions
(list/get/verify/receipt/…) never reach the door: `agent_call` answers them
before either path (`_work_read_call`).

Three pieces, mirroring the legacy branch exactly:

  * `before` — the archive sweep, `worktx.sweep`, in its OWN transaction
    before the call's (plan decision 13). It runs before admission, so a
    replayed key still sweeps; the sweep is idempotent housekeeping.
  * `spec` — the rows one call locks, from `worktx.rows_for` (per action,
    from the arguments). A miss is not an error: PG-0 refuses the unlocked
    write and the door widens and re-runs, committing nothing twice.
  * `body` — the identity conversion and the mutation on the locked
    document, with the ledger's own head-of-call archive move DEFERRED (the
    sweep already ran). Every agent the call mailed (`notified_nodes`, an
    assignment AND a review request can both mail) is driven after the
    commit unless the mail was deferred to an archived recipient, and gets
    its `mail_notify` — the same two effects the legacy branch had.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import pgdoor, worktx

TOOL = "orgtree_work"


def before(call: Any, _a: dict[str, Any]) -> None:
    """The archive move as its own transaction, before the call's."""
    worktx.sweep(call.org)


def spec(_snapshot: Any, _call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The rows one `orgtree_work` call locks, from its arguments."""
    k = worktx.rows_for(str(a.get("action") or ""), a).kwargs()
    return pgdoor.TxSpec(**{n: tuple(v) for n, v in k.items()})


def body(identity_ready: Callable[[Any, str], Any],
         mutate: Callable[[Any, str, dict[str, Any]], dict[str, Any]],
         notify: Callable[[str, str, str], None]
         ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    """The family body. `identity_ready`, `mutate` and `notify` are api's
    `_work_identity_ready`, `_work_mutate` and `mail_notify`, passed in
    because this module must not import api (api imports it)."""
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        slug = str(t.call.org)
        t.org._work_defer_archive = True
        try:
            identity_ready(t.org, slug)
            result = mutate(t.org, t.node, t.args)
        finally:
            t.org._work_defer_archive = False
        told = [str(x) for x in (result.get("notified_nodes")
                                 or [result.get("notified")]) if x]
        if told:
            if not result.get("deferred"):
                for n in told:
                    if n not in t.after.drive:
                        t.after.drive.append(n)
            actor = t.node

            def _notify(_result: Any) -> None:
                for n in told:
                    notify(slug, actor, n)
            t.after.then.append(_notify)
        return result
    return run


def declare(identity_ready: Callable[[Any, str], Any],
            mutate: Callable[[Any, str, dict[str, Any]], dict[str, Any]],
            notify: Callable[[str, str, str], None]) -> None:
    """Register `orgtree_work` on the door (api calls this once at import)."""
    pgdoor.declare(TOOL, spec, body=body(identity_ready, mutate, notify),
                   before=before)
