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
  · the append-only logs a hire writes, and the single-row doc sections it
    rewrites (the org-wide `mail` and `notices` queues, `audiences`,
    `lifecycle`) FOR UPDATE.

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
    "tiers", "max_depth", "max_children", "max_top_grant", "default_top_grant",
    "cascade_hire", "dirs", "default_tools", "default_visibility",
    "permission_mode", "default_effort", "kiosk", "default_account", "slug",
    "fable_lock",
)  # agreed with pg-settings (PG-3f), whose writers take these FOR UPDATE
# What a full agent hire (api._hire_seat, incl. _seat_finish and a kickoff)
# writes, MEASURED on a throwaway org (scratch probe_hire_seat_rows.py):
#   · append-only logs (store.LIST_LOGS / DICT_LOGS — one row per entry):
HIRE_LOGS = ("events", "notice_log", "mail_log")
#   · single-row doc sections, rewritten whole — so FOR UPDATE, and every
#     other writer of them in the org queues behind a hire (`mail` and
#     `notices` are the org-wide mutable queues: see store.py §3.2):
HIRE_SECTIONS = ("notices", "mail", "audiences", "lifecycle")


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
    top_level = actor == USER and dest == USER
    # hire_type='superior' needs nothing extra: it hires under `dest` and
    # then re-parents `dest`, whose old parent `insert_parent` writes — and
    # placement admits a superior only under a STRICT descendant of the actor
    # (never a top-level agent), so that parent is always on this chain.
    # (A separate "add dest's parent" clause was mutation-tested and could
    # never change the result, so it is not here.)
    nodes: list[str] = [] if top_level else list(chain(org, dest, actor))
    name = str(a.get("name") or "")
    if name:
        nodes.append(new_node_id(org, name))
    return pgdoor.TxSpec(nodes=tuple(nodes), sections=HIRE_SECTIONS,
                         share_sections=HIRE_SETTINGS, logs=HIRE_LOGS)


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


def hire_body(tx: pgdoor.AgentTx) -> Any:
    """`orgtree_hire` on the door: exactly `api._hire_seat` (the same hire,
    scope fields, audiences and kickoff the DOC_LOCK cycle runs), on the
    locked rows. The rows are re-derived from the LOCKED document first, so
    a name taken or a tree moved since the snapshot widens before anything
    is written. The kickoff's wake rides `after.drive`, after the commit.

    Also the entry for a hire INSIDE another family's transaction (RT7's
    move racing a hire): call it with that transaction's AgentTx; a row it
    lacks widens that transaction."""
    from . import api     # api imports this module; resolve at call time
    a = tx.args
    require_rows(tx.spec, tx.org, tx.node, a)
    drive: list[str] = []
    result = api._hire_seat(tx.org, tx.call.org, tx.node, a, drive,
                            tx.pre.get("harness"))
    check_created(tx.spec, str(result.get("node") or ""))
    tx.after.drive.extend(drive)
    return result


pgdoor.declare("orgtree_hire", hire_spec, body=hire_body)
