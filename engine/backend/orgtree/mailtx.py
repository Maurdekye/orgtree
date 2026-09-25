# pyright: strict
"""PG-3d: mail on row transactions (`orgtx.org_tx`), PYPG-PLAN §3.

THE PROBLEM. Every mail write (a send, a notice, a delivery, a read mark)
held `store.DOC_LOCK`, the one process-wide lock, around load → change →
save. PG-0's `org_tx` locks only the rows an operation names; this module is
the ONE place that says which rows a mail operation names, so every caller —
the mail routes and tools here, and the other families that write mail
inside their own transaction (work items, turn start, the hub transport) —
declares the same set.

THE RULE FOR CALLERS. The row helpers (`send_rows`, …) return the keyword
arguments for `org_tx`; merge them with your own and open ONE transaction:

    rows = mailtx.merge(mailtx.send_rows(to), nodes=[nid], sections=["x"])
    with orgtx.org_tx(slug, **rows) as tx:
        tx.org.post_mail(...)

The mail WRITERS (`ledger.Org.post_mail`, `deposit_mail`, …) never open a
transaction and never take DOC_LOCK: they change the `org` they are given.
Drives and wakes are fired by the caller AFTER the commit.

WHAT IS LOCKED. The mutable mail queues (`mail`, `notices`, `delivering`)
are whole-org doc sections in the seam's row layout, so a send locks the
org's `mail` row, not only the recipient's box (PG-0's layout; a per-owner
split would change only these helpers). `mail_log` is a dict log: naming
`("mail_log", owner)` lets the transaction edit that owner's rows, and
appends take no lock. The recipient's node row carries `mail_seq` /
`mailbox_id`.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterable, Iterator
from typing import Any

from . import orgtx
from .ledger import USER, Org

#: Sections a send may write: the pending boxes, notices to a superior chain
#: or a replaced holder, audience grants (reply / first contact / deep reach)
#: and the per-operation lifecycle.
SEND_SECTIONS: tuple[str, ...] = ("mail", "notices", "audiences", "lifecycle")

#: Global list logs a send may append to.
SEND_LOGS: tuple[str, ...] = ("events", "notice_log", "user_mail_log", "user_outbox",
                              "org_inbox")

#: A user read mark / mark-all-read: unread rows move to the read archive.
READ_MARK_ROWS: dict[str, list[Any]] = {"sections": ["user_inbox"], "logs": ["user_mail_log"]}

#: The user's outside send: the outbound org-inbox row, and the hub spool it
#: queues on; the kiosk seal, the local identity and the hubs are read for
#: the decision (FOR SHARE).
OUTSIDE_SEND_ROWS: dict[str, list[Any]] = {
    "sections": ["net_spool"], "logs": ["org_inbox", "events"],
    "share_sections": ["kiosk", "net_identity", "net_hubs"]}


def _dedupe(xs: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def send_rows(*recipients: str) -> dict[str, list[Any]]:
    """The `org_tx` names for a send (mail or notice) to `recipients`:
    each agent recipient's node row and mail_log owner; the user inbox for
    mail to the user."""
    nodes = [r for r in recipients if r and r != USER and not r.startswith("@")]
    sections = list(SEND_SECTIONS)
    if USER in recipients:
        sections.append("user_inbox")
    logs: list[Any] = list(SEND_LOGS) + [("mail_log", r) for r in nodes]
    return {"nodes": _dedupe(nodes), "sections": _dedupe(sections), "logs": _dedupe(logs)}


def merge(*parts: dict[str, list[Any]], **extra: Iterable[Any]) -> dict[str, list[Any]]:
    """Union row declarations (and plain `org_tx` name lists in `extra`)."""
    out: dict[str, list[Any]] = {}
    for p in (*parts, {k: list(v) for k, v in extra.items()}):
        for k, v in p.items():
            out[k] = _dedupe([*out.get(k, []), *v])
    return out


def ask_rows(node: str | None) -> dict[str, list[Any]]:
    """Answering or dismissing an ask: the asks row (a save touching asks
    also rewrites work_items — the docket reconcile) plus the answer mail to
    the asking node."""
    return merge(send_rows(node) if node else {}, sections=["asks", "work_items"])


def audience_rows(node: str) -> dict[str, list[Any]]:
    """A user audience grant / deny / revoke: the audience tables, and the
    decision mail and notices it writes (to the node, a replaced outside
    holder, or the user)."""
    return merge(send_rows(node, USER), sections=["audience_requests"])


def retract_rows(nid: str) -> dict[str, list[Any]]:
    """Retracting one undrained mail: the pending boxes and that node's
    archive (the tombstone)."""
    return {"sections": ["mail"], "logs": [("mail_log", nid)]}


def confirm_rows(nid: str) -> dict[str, list[Any]]:
    """Confirming a delivered batch: the delivery journal, the reclaim
    receipts (`mail_transitions`) and the node row (its `mail_drain` demand
    and `halt_queue`)."""
    return {"nodes": [nid], "sections": ["delivering", "mail_transitions"]}


def reclaim_rows(nid: str) -> dict[str, list[Any]]:
    """Folding undelivered batches back: the journal and reclaim receipts,
    the pending boxes and notices they return to, and the node row."""
    return {"nodes": [nid], "sections": ["delivering", "mail_transitions", "mail", "notices"]}


class NothingToCommit(Exception):
    """Raised inside a mail transaction whose operation found nothing to do:
    it rolls the transaction back, as the DOC_LOCK path's early return
    without a save did."""


def tx_open(slug: str) -> bool:
    """Is an `org_tx` open on `slug` on THIS thread? (A mail helper called
    with a transaction's Org mutates it rather than opening a second
    transaction, which would raise NestedTx.) Reads orgtx's per-thread
    registry; PG-0 is asked for a public equivalent."""
    slugs = getattr(orgtx._open, "slugs", None) or set()   # pyright: ignore[reportPrivateUsage]
    return slug in slugs


@contextlib.contextmanager
def org_of(slug: str, **rows: Any) -> Iterator[Org]:
    """`org_tx` yielding the Org itself: the drop-in for a
    `store.write_org(slug)` block whose body is a mail write. The body must
    NOT call `store.save_org` — the transaction saves (and checks) on exit."""
    with orgtx.org_tx(slug, **rows) as tx:
        yield tx.org
