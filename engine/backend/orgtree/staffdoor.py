"""staffdoor — PG-3b's lock declarations: hiring onto `org_tx`.

What a hire reads to decide and what it writes (read from `Org.hire`,
`_chain_acquire` and `_new_node`, and MEASURED by the row audit in
tests/test_staffdoor_rows.py, which runs real hires and fails if a hire
changes a row this declaration does not hold FOR UPDATE):

  · the DESTINATION and every ancestor up to the acting agent — FOR UPDATE.
    The depth cap, authority and placement read them; `_chain_acquire`
    inflates `grant` along exactly that path; `free()` of each one reads its
    children. Locking the destination is also what serialises two hires under
    one parent, so the children cap cannot be overrun by a race (race test
    RT3): the second hire counts the children only after the first commits.
  · the NEW node's row. Its id is `slugify(name)`, suffixed `-2`, `-3`... on a
    collision, so it is computed from the snapshot; if the locked document
    picks a different id (a racing hire took the name), the body raises
    `Widen` and the door re-runs with the right row.
  · the org settings a hire decides on — FOR SHARE, so a settings writer
    (FOR UPDATE) cannot change a cap between our check and our commit.
  · the append-only logs a hire writes.

The children scan and the name probe iterate every node; that needs
`org_tx`'s all-nodes read (WS2, `nodes=ALL`), not a lock on every node.
"""
from __future__ import annotations

from typing import Any

from . import pgdoor
from .ledger import USER, LedgerError, slugify

# org settings `Org.hire` / `_new_node` read to DECIDE (the phantom rule: a
# writer of any of these takes it FOR UPDATE, so a hire holding it FOR SHARE
# cannot commit against a value that changed under it)
HIRE_SETTINGS = (
    "tiers", "max_depth", "max_children", "max_top_grant", "cascade_hire",
    "dirs", "default_tools", "default_visibility", "permission_mode", "kiosk",
    "default_account", "slug", "fable_lock",
)
# the append-only sections one hire writes (measured: events, notice_log,
# notices for the lifecycle.hired notices to parent and peers)
HIRE_LOGS = ("events", "notice_log", "notices")


def new_node_id(org: Any, name: str) -> str:
    """The id `_new_node` will give `name` in `org` — the same rule, so the
    spec and the hire agree on which row is being created."""
    base = slugify(name)
    nid, i = base, 2
    while nid in org.nodes:
        nid, i = f"{base}-{i}", i + 1
    return nid


def chain(org: Any, dest: str | None, actor: str) -> tuple[str, ...]:
    """The destination and its ancestors up to and INCLUDING the acting agent
    (for the user, up to the top). This is the path `_chain_acquire` walks."""
    out: list[str] = []
    cur = dest
    seen: set[str] = set()
    while cur is not None and cur != USER and cur not in seen and cur in org.nodes:
        out.append(cur)
        seen.add(cur)
        if cur == actor:
            break
        cur = org.nodes[cur].get("parent")
    return tuple(out)


def hire_rows(org: Any, actor: str, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The rows one `orgtree_hire` (or the operator's hire) holds, computed
    from an org document (the unlocked snapshot, or the locked one when a
    body re-checks)."""
    dest = str(a.get("target") or a.get("parent") or actor)
    htype = str(a.get("hire_type") or "subordinate")
    top_level = actor == USER and dest == USER
    nodes: list[str] = [] if top_level else list(chain(org, dest, actor))
    if htype != "subordinate" and dest in org.nodes:
        # sibling / superior: the new seat lands beside or above `dest`, so
        # its parent (the payer) is written too
        p = org.nodes[dest].get("parent")
        if p is not None and p not in nodes:
            nodes.append(p)
    name = str(a.get("name") or "")
    if name:
        nodes.append(new_node_id(org, name))
    return pgdoor.TxSpec(nodes=tuple(nodes), share_sections=HIRE_SETTINGS,
                         logs=HIRE_LOGS)


def hire_spec(snapshot: Any, body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The callable spec registered for `orgtree_hire`."""
    return hire_rows(snapshot, body.node, a)


def require_rows(held: pgdoor.TxSpec, org: Any, actor: str,
                 a: dict[str, Any]) -> None:
    """Re-derive the rows from the LOCKED document; if any is not held (the
    tree or a name moved since the snapshot), `Widen` so the door re-runs
    with them. Call it FIRST in the body, before anything is written."""
    need = hire_rows(org, actor, a)
    missing = [n for n in need.nodes if n not in held.nodes]
    if missing:
        raise pgdoor.Widen(nodes=missing)


def check_created(held: pgdoor.TxSpec, nid: str) -> None:
    """After the hire: the created row must be one the transaction holds."""
    if nid and nid not in held.nodes:
        raise LedgerError(f"staffdoor: hire created {nid!r}, a row this "
                          f"transaction does not hold")
