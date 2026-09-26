# pyright: strict
"""PG-3w: work items and the docket on `org_tx` row transactions.

THE PROBLEM. Every docket write ran under `store.DOC_LOCK`: load the whole
org, change one item, save. PYPG-PLAN §3 replaces that with `orgtx.org_tx`,
which locks only the rows the operation reads for a decision or writes.

TWO TRANSACTIONS PER DOCKET WRITE (plan decision 13, p03-lead 2026-09-25):

  1. `sweep(slug)` — the archive move `_work_sweep` used to do inline at the
     head of every mutation. Its own `org_tx` on `work_items` (+ `asks`, which
     `reconcile_attention` rewrites with it) and the `work_items_archive` /
     `events` logs. Eligibility is re-checked INSIDE the transaction, so a
     reopen or update that committed first is never lost (decision 13 a).
  2. the action itself, via `run(...)`, with `Org._work_defer_archive` set so
     the ledger method skips the move. The identity check and slug backfill
     still run inside it.

WHICH ROWS. A docket write always locks `work_items` and `asks` and appends to
`events`. What else it touches depends on what the ledger decides while it
runs: an assignment mails the new owner (the owner's own `("mail", nid)`
box and node row, and a send's sections and logs from `mailtx`), a delete writes `user_outbox` and
`work_deleted_names`, a review request writes `user_inbox`. Those notification
writes were inside the same DOC_LOCK save, so they stay inside the same
`org_tx` (§3 step 3, p01 do-not-split list) — they are NOT split out.

The rows are named up front from the arguments where that is possible (the
new owner, added participants). Where the ledger discovers a row at run time,
the fake refuses the commit with `UnlockedWrite` and NOTHING is written;
`run` then WIDENS the row set by exactly the refused rows and re-runs the
whole body from a fresh load, under the wider locks. That is sound because
the refused attempt committed nothing and the retry re-decides everything
under locks that cover every row it writes. It is bounded (`MAX_WIDEN`), and a
widening that adds nothing new is a bug, not a retry.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

from . import mailtx, orgtx, store
from .ledger import Org

T = TypeVar("T")

#: Every docket write locks these: a save touching `asks` or `work_items`
#: rewrites `work_items` (reconcile_attention), so the two go together.
BASE_SECTIONS: tuple[str, ...] = ("work_items", "asks")
#: `_log` appends to `events` on almost every docket write.
BASE_LOGS: tuple[str, ...] = ("events",)
#: A notification (assignment, participant, review, delete) is a mail send:
#: its rows are `mailtx.send_rows(*recipients)` — the single source — which
#: names each PREDICTED recipient's own box `("mail", nid)` and
#: `("mail_log", nid)`, never the whole `mail` section, so a docket write that
#: mails one agent does not queue behind mail to every other agent in the org.
#: A recipient the arguments do not predict is refused at commit as
#: `mailnid` and widened into as exactly that owner row (`widen`).

#: How many times `run` may widen the row set before giving up.
MAX_WIDEN = 4

_REFUSED = re.compile(r"\b(section|node|log) '((?:[^'\\]|\\.)*)'")


class WidenExhausted(orgtx.OrgTxError):
    """The row set kept growing past MAX_WIDEN, or a refusal named nothing new."""


@dataclass
class Rows:
    """The rows one docket transaction names."""
    sections: set[Any] = field(default_factory=lambda: set(BASE_SECTIONS))
    nodes: set[str] = field(default_factory=lambda: set())
    logs: set[Any] = field(default_factory=lambda: set(BASE_LOGS))
    share_nodes: set[str] = field(default_factory=lambda: set())
    share_sections: set[Any] = field(default_factory=lambda: set())

    def notify(self, *nodes: str | None) -> Rows:
        """Name the rows a notification to `nodes` writes."""
        r = mailtx.send_rows(*[n for n in nodes if n])
        self.sections |= set(r["sections"])
        self.logs |= set(r["logs"])
        self.nodes |= set(r["nodes"])
        return self

    def widen(self, refused: Iterable[tuple[str, str]]) -> bool:
        """Add refused rows; True when anything was actually new."""
        grew = False
        refused = list(refused)
        # A split section's CONTAINER refused beside one of its own owner
        # rows was only created by that owner's write (an empty container is
        # allowed under the owner lock), so widen by the owner row alone —
        # taking the container FOR UPDATE would lock every owner's box.
        owned = {n.split(store.SPLIT_SEP, 1)[0] for k, n in refused
                 if k == "section" and store.SPLIT_SEP in n}
        refused = [(k, n) for k, n in refused
                   if not (k == "section" and n in owned)]
        for kind, name in refused:
            if kind == "section" and store.SPLIT_SEP in name:
                # an owner row of a split section (PG-3d): org_tx names it
                # `sectionowner` and takes it back as (section, owner)
                sec, owner = name.split(store.SPLIT_SEP, 1)
                name = (sec, owner)   # type: ignore[assignment]
            target = {"section": self.sections, "node": self.nodes,
                      "log": self.logs}[kind]
            if name not in target:
                target.add(name)
                grew = True
            if kind == "node":
                self.share_nodes.discard(name)
            if kind == "section":
                self.share_sections.discard(name)
        return grew

    def kwargs(self) -> dict[str, Any]:
        return {"sections": sorted(self.sections, key=_rowkey),
                "nodes": sorted(self.nodes),
                "logs": sorted(self.logs, key=_rowkey),
                "share_nodes": sorted(self.share_nodes - self.nodes),
                "share_sections": sorted(self.share_sections - self.sections,
                                         key=_rowkey)}


def _rowkey(x: Any) -> str:
    """Sort key for a row name that may be a (section, owner) pair."""
    return x if isinstance(x, str) else store.SPLIT_SEP.join(x)


def _names(v: Any) -> list[str]:
    if isinstance(v, str):
        return [v] if v else []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in cast("Iterable[Any]", v) if x]
    return []


def rows_for(action: str, a: dict[str, Any]) -> Rows:
    """The rows an `orgtree_work` action is PREDICTED to write, from its
    arguments alone (measured per action, breadcrumbs 16:25Z). A prediction,
    not a promise: anything the ledger reaches beyond it is caught at commit
    and widened by `run`, so a miss costs one re-run and never a wrong write."""
    r = Rows()
    if action == "create":
        who = _names(a.get("owner")) + _names(a.get("participants"))
        if who:
            r.notify(*who)
    elif action == "assign":
        r.notify(*_names(a.get("owner")))
    elif action == "participants":
        r.notify(*_names(a.get("add")))
    elif action == "update" and a.get("reviewer"):
        r.notify(*_names(a.get("reviewer")))
    elif action == "review_request":
        r.notify()
        r.sections.add("user_inbox")
    elif action in ("archive", "supersede"):
        r.logs.add("work_items_archive")
    elif action == "delete":
        r.notify()
        r.sections.add("work_deleted_names")
        r.logs.add("user_outbox")
    if a.get("attention") is not None or a.get("attention_amend"):
        r.sections.add("user_inbox")
    return r


def refused_rows(err: orgtx.UnlockedWrite) -> list[tuple[str, str]]:
    """The (kind, name) rows an UnlockedWrite names. Prefers a structured
    `rows` attribute when PG-0 provides one; otherwise reads the message."""
    rows = getattr(err, "rows", None)
    if rows:
        return [(str(k), str(n)) for k, n in cast("Iterable[tuple[Any, Any]]", rows)]
    return [(m.group(1), m.group(2)) for m in _REFUSED.finditer(str(err))]


def run(slug: str, fn: Callable[[Org], T], *, rows: Rows | None = None,
        op_key: str | None = None, fingerprint: str | None = None,
        lock_timeout: float | None = None) -> T:
    """Run one docket mutation `fn(org)` in an `org_tx`, widening the row set
    on UnlockedWrite (see the module docstring). The archive move is deferred:
    call `sweep(slug)` first. Returns fn's result (or the stored result of a
    replayed `op_key`)."""
    return tx(slug, fn, rows=rows or Rows(), op_key=op_key,
              fingerprint=fingerprint, lock_timeout=lock_timeout,
              defer_archive=True)


def tx(slug: str, fn: Callable[[Org], T], *, rows: Rows,
       op_key: str | None = None, fingerprint: str | None = None,
       lock_timeout: float | None = None, defer_archive: bool = False) -> T:
    """`run` without the docket defaults: any row set, the same widening.
    For writers outside the docket proper (the supervisor's reminder and
    recovery passes) that still discover rows at run time."""
    for _ in range(MAX_WIDEN + 1):
        try:
            with orgtx.org_tx(slug, op_key=op_key, fingerprint=fingerprint,
                              lock_timeout=lock_timeout, **rows.kwargs()) as t:
                if t.replayed:
                    return cast(T, t.result)
                t.org._work_defer_archive = defer_archive  # pyright: ignore[reportAttributeAccessIssue]
                try:
                    out = fn(t.org)
                finally:
                    t.org._work_defer_archive = False  # pyright: ignore[reportAttributeAccessIssue]
                if op_key is not None and t.result is None:
                    t.result = out
            return out
        except orgtx.UnlockedWrite as e:
            if not rows.widen(refused_rows(e)):
                raise WidenExhausted(f"refusal named no new row: {e}") from e
    raise WidenExhausted(f"tx on {slug!r} still widening after "
                         f"{MAX_WIDEN} attempts: {rows.kwargs()}")


def sweep(slug: str, now_ts: float | None = None, *,
          lock_timeout: float | None = None) -> list[str]:
    """The archive move as its own transaction (decision 13). Returns the
    slugs moved. Re-checks eligibility under the `work_items` lock."""
    return tx(slug, lambda org: org._work_archive_eligible(now_ts),  # pyright: ignore[reportPrivateUsage]
              rows=Rows(logs={"events", "work_items_archive"}),
              lock_timeout=lock_timeout)


def mutate(slug: str, fn: Callable[[Org], T], *, rows: Rows | None = None,
           op_key: str | None = None, fingerprint: str | None = None,
           now_ts: float | None = None) -> T:
    """The whole docket write: `sweep` in its own transaction, then `run`."""
    sweep(slug, now_ts)
    return run(slug, fn, rows=rows, op_key=op_key, fingerprint=fingerprint)
