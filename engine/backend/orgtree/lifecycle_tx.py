"""PG-3a: topology and lifecycle writers on row transactions (PYPG-PLAN §3).

Each writer here is the legacy `ledger.Org` method it names, run inside ONE
`halt.txn` (the transition fence, then `orgtx.org_tx`) that locks exactly the
rows the method reads for its decision or writes. The ledger methods keep
their behaviour; what changes is which rows are locked around them.

`SPECS` is this family's lock declaration, one entry per operation, in the
shape WS3a's door takes (`LOCKS[tool_or_op] -> TxSpec`). A writer whose
declaration misses a row it writes fails at commit with `orgtx.UnlockedWrite`
and writes NOTHING — the tests pin each spec against that.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import halt


@dataclass(frozen=True)
class Spec:
    """The rows one operation locks. Node ids are filled in per call."""
    sections: tuple[str, ...] = ()
    share_sections: tuple[str, ...] = ()
    logs: tuple[Any, ...] = ()
    notes: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


SPECS: dict[str, Spec] = {
    # №31: the ledger said live, the session cannot resume. Writes the node's
    # state, a typed notice into its parent's box (`notices` + `notice_log`)
    # and the event row. The parent id is read from the node's own row; the
    # parent row itself is only tested for existence, never decided on.
    "mark_unrecoverable": Spec(sections=("notices",),
                               logs=("events", "notice_log"),
                               notes="nodes=[nid]"),
}


def _txn(op: str, slug: str, nodes: list[str], share_nodes: list[str] = ()):
    s = SPECS[op]
    return halt.txn(slug, nodes=nodes, share_nodes=share_nodes,
                    sections=s.sections, share_sections=s.share_sections,
                    logs=s.logs)


def mark_unrecoverable(slug: str, nid: str, reason: str) -> bool:
    """Mark `nid` unrecoverable. Runtime-internal (no actor, no receipt).
    False when the node no longer exists."""
    with _txn("mark_unrecoverable", slug, [nid]) as tx:
        if nid not in tx.org.nodes:
            return False
        tx.org.mark_unrecoverable(nid, reason)
        return True
