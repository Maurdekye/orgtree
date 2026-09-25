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
runs: an assignment mails the new owner (the `mail` and `lifecycle` sections,
the owner's node row, the `mail_log` log), a delete writes `user_outbox` and
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

from . import orgtx
from .ledger import Org

T = TypeVar("T")

#: Every docket write locks these: a save touching `asks` or `work_items`
#: rewrites `work_items` (reconcile_attention), so the two go together.
BASE_SECTIONS: tuple[str, ...] = ("work_items", "asks")
#: `_log` appends to `events` on almost every docket write.
BASE_LOGS: tuple[str, ...] = ("events",)
#: Sections a notification (assignment, participant, review, delete) writes.
NOTIFY_SECTIONS: tuple[str, ...] = ("mail", "lifecycle")
NOTIFY_LOGS: tuple[str, ...] = ("mail_log",)

#: How many times `run` may widen the row set before giving up.
MAX_WIDEN = 4

_REFUSED = re.compile(r"\b(section|node|log) '((?:[^'\\]|\\.)*)'")


class WidenExhausted(orgtx.OrgTxError):
    """The row set kept growing past MAX_WIDEN, or a refusal named nothing new."""


@dataclass
class Rows:
    """The rows one docket transaction names."""
    sections: set[str] = field(default_factory=lambda: set(BASE_SECTIONS))
    nodes: set[str] = field(default_factory=lambda: set())
    logs: set[str] = field(default_factory=lambda: set(BASE_LOGS))
    share_nodes: set[str] = field(default_factory=lambda: set())
    share_sections: set[str] = field(default_factory=lambda: set())

    def notify(self, *nodes: str | None) -> Rows:
        """Name the rows a notification to `nodes` writes."""
        self.sections |= set(NOTIFY_SECTIONS)
        self.logs |= set(NOTIFY_LOGS)
        self.nodes |= {n for n in nodes if n}
        return self

    def widen(self, refused: Iterable[tuple[str, str]]) -> bool:
        """Add refused rows; True when anything was actually new."""
        grew = False
        for kind, name in refused:
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
        return {"sections": sorted(self.sections), "nodes": sorted(self.nodes),
                "logs": sorted(self.logs),
                "share_nodes": sorted(self.share_nodes - self.nodes),
                "share_sections": sorted(self.share_sections - self.sections)}


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
    rows = rows or Rows()
    for _ in range(MAX_WIDEN + 1):
        try:
            with orgtx.org_tx(slug, op_key=op_key, fingerprint=fingerprint,
                              lock_timeout=lock_timeout, **rows.kwargs()) as tx:
                if tx.replayed:
                    return cast(T, tx.result)
                tx.org._work_defer_archive = True  # pyright: ignore[reportAttributeAccessIssue]
                try:
                    out = fn(tx.org)
                finally:
                    tx.org._work_defer_archive = False  # pyright: ignore[reportAttributeAccessIssue]
                if op_key is not None and tx.result is None:
                    tx.result = out
            return out
        except orgtx.UnlockedWrite as e:
            if not rows.widen(refused_rows(e)):
                raise WidenExhausted(f"refusal named no new row: {e}") from e
    raise WidenExhausted(f"docket tx on {slug!r} still widening after "
                         f"{MAX_WIDEN} attempts: {rows.kwargs()}")


def sweep(slug: str, now_ts: float | None = None, *,
          lock_timeout: float | None = None) -> list[str]:
    """The archive move as its own transaction (decision 13). Returns the
    slugs moved. Re-checks eligibility under the `work_items` lock."""
    rows = Rows(logs={"events", "work_items_archive"})

    def body(org: Org) -> list[str]:
        return org._work_archive_eligible(now_ts)  # pyright: ignore[reportPrivateUsage]

    for _ in range(MAX_WIDEN + 1):
        try:
            with orgtx.org_tx(slug, lock_timeout=lock_timeout, **rows.kwargs()) as tx:
                return body(tx.org)
        except orgtx.UnlockedWrite as e:
            if not rows.widen(refused_rows(e)):
                raise WidenExhausted(f"refusal named no new row: {e}") from e
    raise WidenExhausted(f"sweep on {slug!r} still widening")


def mutate(slug: str, fn: Callable[[Org], T], *, rows: Rows | None = None,
           op_key: str | None = None, fingerprint: str | None = None,
           now_ts: float | None = None) -> T:
    """The whole docket write: `sweep` in its own transaction, then `run`."""
    sweep(slug, now_ts)
    return run(slug, fn, rows=rows, op_key=op_key, fingerprint=fingerprint)
