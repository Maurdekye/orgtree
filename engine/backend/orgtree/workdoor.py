"""PG-3w: `orgtree_work` on WS3a's shared door (`pgdoor`), off DOC_LOCK.

⚠ LANDS ONLY AFTER `pgdoor` IS ON v3 (lead ruling 2026-09-25 16:53Z): until
then this module lives on a scratch branch with pgdoor cherry-picked, and the
landing branch carries `worktx` alone.

Three pieces:

  * `orgtx_seam()` — the storage primitive pgdoor is given. PG-0's `org_tx`
    yields an `OrgTx` HANDLE and refuses an unnamed write at COMMIT with
    `UnlockedWrite`; pgdoor's `_run` wants the Org and re-runs on `Widen`.
    The seam yields `tx.org` and turns the commit-time refusal into a
    `Widen` naming exactly the refused rows, so a docket write that mails a
    recipient discovered at run time re-runs once with that recipient's rows
    — no change to pgdoor's body. Proposed to WS3a as THE production seam.
  * `spec(...)` — the `orgtree_work` lock declaration, from
    `worktx.rows_for` (per action, from the arguments).
  * `body(identity_ready, mutate)` — the family body `agent_tx` runs on the
    locked document: the identity conversion and the mutation, with the
    archive move deferred (decision 13 — `worktx.sweep` runs first, in its
    own transaction, see `call`).
"""
from __future__ import annotations

import contextlib
from collections.abc import Callable, Iterator
from typing import Any

from . import orgtx, pgdoor, worktx

TOOL = "orgtree_work"

#: `orgtree_work` actions that only read. They never reach the door: the
#: api answers them from the shared snapshot, outside every lock.
READ_ACTIONS = frozenset({"list", "get", "verify", "receipts",
                          "artifact_read"})


@contextlib.contextmanager
def _seam_tx(slug: str, **names: Any) -> Iterator[Any]:
    try:
        with orgtx.org_tx(slug, **names) as tx:
            yield tx.org
    except orgtx.UnlockedWrite as e:
        rows = worktx.refused_rows(e)
        if not rows:
            raise
        raise pgdoor.Widen(
            nodes=[n for k, n in rows if k == "node"],
            sections=[n for k, n in rows if k == "section"],
            logs=[n for k, n in rows if k == "log"]) from e


def orgtx_seam() -> None:
    """Install PG-0's `org_tx` as pgdoor's storage primitive (see above)."""
    pgdoor.use_org_tx(
        _seam_tx,
        is_retryable=lambda e: isinstance(e, orgtx.Retryable),
        snapshot=lambda slug: orgtx.org_read(slug))


def spec(_snapshot: Any, _body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The rows one `orgtree_work` call locks, from its arguments."""
    r = worktx.rows_for(str(a.get("action") or ""), a)
    return pgdoor.TxSpec(nodes=tuple(sorted(r.nodes)),
                         sections=tuple(sorted(r.sections)),
                         share_nodes=tuple(sorted(r.share_nodes)),
                         share_sections=tuple(sorted(r.share_sections)),
                         logs=tuple(sorted(r.logs)))


def body(identity_ready: Callable[[Any, str], None],
         mutate: Callable[[Any, str, dict[str, Any]], dict[str, Any]]
         ) -> Callable[[pgdoor.AgentTx], dict[str, Any]]:
    """The family body. `identity_ready` and `mutate` are api's
    `_work_identity_ready` and `_work_mutate`, passed in because this module
    must not import api (api imports it)."""
    def run(t: pgdoor.AgentTx) -> dict[str, Any]:
        t.org._work_defer_archive = True
        try:
            identity_ready(t.org, t.org.d["slug"])
            return mutate(t.org, t.node, t.args)
        finally:
            t.org._work_defer_archive = False
    return run


def declare() -> None:
    pgdoor.declare(TOOL, spec)


def call(body_: Any, a: dict[str, Any], fn: Callable[[pgdoor.AgentTx], Any],
         *, admit: Any, file: Any, on_commit: Any = None) -> Any:
    """One mutating `orgtree_work` call: the archive sweep in its own
    transaction, then the call on the door."""
    worktx.sweep(body_.org)
    return pgdoor.agent_tx(body_, a, fn, admit=admit, file=file,
                           on_commit=on_commit)
