"""S2 slice 4 (fence-off): `orgtree_present` and `orgtree_submit_report` on
the shared row-transaction door, in the pattern S1 set for the mail tools
(maildoor.py).

Both tools ran inside `agent_call`'s resident DOC_LOCK cycle. Declared here,
each runs on the door instead (when `pgdoor.enabled()`): ONE `org_tx` with
pgdoor's prologue (the caller's row held, halt and killswitch checked on the
locked rows, the receipt filed last), then the door's generic tail (which
attaches the `@doc:` reference).

THE ROWS.
  * present: the `documents` log (a new card is appended; `replaces` edits
    one in place) and `events` (the ledger's `present` event); `audiences`
    FOR SHARE, because the direct-user-audience gate reads it.
  * submit_report: the same, plus the send rows of the caller's superior —
    its node row, pending box and mail log, or the user inbox for a
    top-level caller. The superior is the caller's own `parent`, and the
    caller's row is held FOR UPDATE, so the prediction cannot go stale; a
    report that cites artifacts also holds `work_items` FOR SHARE (the
    artifact read gate).

AT MOST ONE ATTEMPT OF EVERYTHING THAT IS NOT A ROW (lead condition C6). The
body is a pure function of the locked document, so a widened or retried
attempt rolls back and runs again with nothing left behind. The one disk
effect — present-by-path COPYING an HTML file into outbox/ — is the
before-step's (`pgdoor.declare(before=)`), which runs once per call with no
lock held. The legacy submit_report branch drove nobody after its mail (it
set `mail_to` but never appended to `drive`), and this keeps exactly that.

The api-side callables are PASSED IN (api imports this module, not the
reverse), exactly as `maildoor` and `workdoor` do.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import mailtx, pgdoor
from .ledger import USER

PRESENT = "orgtree_present"
SUBMIT_REPORT = "orgtree_submit_report"

#: what every presentation writes and reads
_DOC_LOGS = ("documents", "events")
_DOC_SHARE = ("audiences",)


def present_spec(snapshot: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """A presentation: the documents log and its event; the audience table
    the gate reads FOR SHARE. (The caller's node row is the door's own.)"""
    return pgdoor.TxSpec(share_sections=_DOC_SHARE, logs=_DOC_LOGS)


def _superior(snapshot: Any, nid: str) -> str:
    try:
        return str((snapshot.nodes.get(nid) or {}).get("parent") or USER)
    except Exception:                                        # noqa: BLE001
        return USER             # the body's own read decides; PG-0 widens


def report_spec(snapshot: Any, call: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """A report: a presentation's rows, the superior's send rows, and the
    docket FOR SHARE when artifacts are cited."""
    share = _DOC_SHARE + (("work_items",) if a.get("artifacts") else ())
    rows = mailtx.merge(mailtx.send_rows(_superior(snapshot, str(call.node))),
                        share_sections=list(share), logs=list(_DOC_LOGS))
    return pgdoor.TxSpec(**{k: tuple(v) for k, v in rows.items()})


def declare(present_before: Callable[[Any, dict[str, Any]], dict[str, Any]],
            present_body: Callable[[pgdoor.AgentTx], dict[str, Any]],
            report_body: Callable[[pgdoor.AgentTx], dict[str, Any]]) -> None:
    """Register both tools on the door (api calls this once at import)."""
    pgdoor.declare(PRESENT, present_spec, body=present_body, before=present_before)
    pgdoor.declare(SUBMIT_REPORT, report_spec, body=report_body)
