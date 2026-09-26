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

import contextlib
from typing import Any, Iterator

from . import pgdoor
from .ledger import USER, LedgerError, slugify


def _sweep_first(call: Any, a: dict[str, Any]) -> None:
    """PG-3w (plan decision 13): the docket's archive move in its OWN
    transaction before the call's, as every docket write does; the call then
    runs with the move deferred (`_archive_deferred`), so it neither writes
    the archive nor widens into it. An agent call names its org; an operator
    op carries it as `org_slug` (`slug` in orgtree_staff's args is the ITEM)."""
    from . import worktx
    worktx.sweep(str(getattr(call, "org", None) or a["org_slug"]))


@contextlib.contextmanager
def _archive_deferred(org: Any) -> Iterator[None]:
    org._work_defer_archive = True
    try:
        yield
    finally:
        org._work_defer_archive = False

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
HIRE_LOGS = ("events", "notice_log", "mail_log", "lifecycle")
#   · single-row doc sections, rewritten whole — so FOR UPDATE, and every
#     other writer of them in the org queues behind a hire (`mail` and
#     `notices` are the org-wide mutable queues: see store.py §3.2):
HIRE_SECTIONS = ("notices", "mail", "audiences")


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


def _writes_docket(a: dict[str, Any]) -> bool:
    """A hire carrying `work_item` or `review_items` also writes the docket
    (`api._seat_finish`: `work_assign` / `work_review_grant`)."""
    return (bool(str(a.get("work_item") or "").strip())
            or a.get("review_items") is not None)


def agent_hire_rows(org: Any, actor: str, a: dict[str, Any]) -> pgdoor.TxSpec:
    """`orgtree_hire`'s rows: `hire_rows`, and when the hire writes the
    docket, `work_items` and the assigned item's CURRENT owner (sent the
    handover notice), exactly as `staff_rows` takes them. A reviewer grant's
    other noticed parties are rarer and ride the door's widening."""
    h = hire_rows(org, actor, a)
    if not _writes_docket(a):
        return h
    nodes = h.nodes
    wi = str(a.get("work_item") or "").strip()
    if wi:
        prev = _item_owner(org, wi)
        if prev and prev in org.nodes and prev not in nodes:
            nodes = nodes + (prev,)
    return pgdoor.TxSpec(nodes=nodes, sections=h.sections + ("work_items",),
                         share_sections=h.share_sections, logs=h.logs)


def hire_spec(snapshot: Any, body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The callable spec registered for `orgtree_hire`."""
    return agent_hire_rows(snapshot, body.node, a)


def _hire_sweep_first(call: Any, a: dict[str, Any]) -> None:
    """PG-3w decision 13 for the hire that writes the docket; a plain hire
    touches no docket row and skips the sweep's transaction."""
    if _writes_docket(a):
        _sweep_first(call, a)


def require_rows(held: pgdoor.TxSpec, org: Any, actor: str,
                 a: dict[str, Any]) -> None:
    """Re-derive the rows from the LOCKED document; if any is not held (the
    tree or a name moved since the snapshot), `Widen` so the door re-runs
    with them. Call it FIRST in the body, before anything is written."""
    need = agent_hire_rows(org, actor, a)
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
    # decision 13: the sweep ran first (`_hire_sweep_first`), so the docket
    # write here defers the archive move instead of widening into it
    defer = (_archive_deferred(tx.org) if _writes_docket(a)
             else contextlib.nullcontext())
    with defer:
        result = api._hire_seat(tx.org, tx.call.org, tx.node, a, drive,
                                tx.pre.get("harness"))
    check_created(tx.spec, str(result.get("node") or ""))
    tx.after.drive.extend(drive)
    return result


pgdoor.declare("orgtree_hire", hire_spec, body=hire_body,
               before=_hire_sweep_first)


# ------------------------------------------------ the operator's hire (op)

def op_hire_rows(org: Any, body: Any) -> pgdoor.TxSpec:
    """The rows the operator's hire (`POST /ops` op="hire") holds: the same
    rule as the agent hire, with the destination being the anchor for an
    insert-above (`above`, which the hire goes UNDER before the splice) and
    `parent` otherwise (None = the top level). The acting identity is
    `body.actor` (the user, or an agent acting through the operator door)."""
    dest = body.above if getattr(body, "above", None) is not None else body.parent
    return hire_rows(org, str(body.actor),
                     {"target": dest or USER, "name": body.name or ""})


def op_hire_spec(snapshot: Any, body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The callable spec registered for the `hire` op."""
    return op_hire_rows(snapshot, body)


def op_hire_body(tx: pgdoor.OpTx) -> Any:
    """The `hire` op on the door: exactly `api._op_hire` (the hire, the
    atomic effort / pool-order / fallback scope, the insert-above splice) on
    the locked rows, re-deriving them first so a taken name or a moved tree
    widens before anything is written. A user FABLE hire also rewrites every
    node's `limit_locked` (clear_fable_lock); the door's refusal-driven
    widening takes those rows on its second run."""
    from . import api
    need = op_hire_rows(tx.org, tx.body)
    missing = [n for n in need.nodes if n not in tx.spec.nodes]
    if missing:
        raise pgdoor.Widen(nodes=missing)
    result = api._op_hire(tx.org, tx.body, bool(tx.pre.get("rc")),
                          tx.pre.get("harness"))
    check_created(tx.spec, str(result.get("node") or ""))
    return result


pgdoor.declare("hire", op_hire_spec, body=op_hire_body)


# ------------------------------------------- orgtree_staff (hire mode only)

def _staff_on_door(a: dict[str, Any]) -> bool:
    """Only the HIRE mode is PG-3b's: the rehire mode (and its pre-lock
    rename) belongs to PG-3a and keeps the DOC_LOCK cycle until they route it."""
    from . import api
    return api._staff_mode(a) == "hire"


def _item_owner(org: Any, slug: str) -> str | None:
    try:
        it, _archived = org._work_find(slug)
    except LedgerError:
        return None
    o = it.get("owner")
    return str(o.get("node") if isinstance(o, dict) else o or "") or None


def staff_rows(org: Any, actor: str, a: dict[str, Any]) -> pgdoor.TxSpec:
    """The hire's rows, plus the docket: `work_items` (a single row per org
    today — PG-3w's layout), and on an update the item's CURRENT owner, who
    is sent the handover notice (measured: that node's `mail_seq` changes).
    Participants who are noticed are rarer and ride the door's widening."""
    h = hire_rows(org, actor, a)
    nodes = h.nodes
    slug = str(a.get("slug") or "").strip()
    if slug:
        prev = _item_owner(org, slug)
        if prev and prev in org.nodes:
            nodes = nodes + (prev,)
    return pgdoor.TxSpec(nodes=nodes, sections=h.sections + ("work_items",),
                         share_sections=h.share_sections, logs=h.logs)


def staff_spec(snapshot: Any, body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    return staff_rows(snapshot, body.node, a)


def staff_body(tx: pgdoor.AgentTx) -> Any:
    """`orgtree_staff` in hire mode on the door: exactly `api._staff_call`
    (the seat via `_hire_seat`, then the docket create/update with that seat
    as owner, the assignment notice) on the locked rows. Known impurity:
    `_staff_call` fires `mail_notify` (a UI animation signal, no state) inside
    the transaction, so a re-run may fire it twice — harmless."""
    from . import api
    a = tx.args
    need = staff_rows(tx.org, tx.node, a)
    missing = [n for n in need.nodes if n not in tx.spec.nodes]
    if missing:
        raise pgdoor.Widen(nodes=missing)
    drive: list[str] = []
    with _archive_deferred(tx.org):
        result = api._staff_call(tx.org, tx.call.org, tx.node, a, drive, None,
                                 [], tx.pre.get("harness"))
    check_created(tx.spec, str(result.get("node") or ""))
    tx.after.drive.extend(drive)
    return result


pgdoor.declare("orgtree_staff", staff_spec, body=staff_body, when=_staff_on_door,
               before=_sweep_first)


# --------------------------------- quick staff (the ticket menu's Staff…)

# MEASURED (scratch probe_quickstaff_rows.py, every mode + the undo): the
# staffing writes the hire's rows plus the USER's outbox log (quick staff
# acts as the user); a request writes the docket, the assignee's mail and
# the outbox; the undo writes the docket, the recipient's mail and its logs.
QS_LOGS = HIRE_LOGS + ("user_outbox",)
QS_SECTIONS = ("work_items",) + HIRE_SECTIONS


def quick_staff_rows(org: Any, wid: str, tier: Any = None, effort: Any = None,
                     account: Any = None) -> pgdoor.TxSpec:
    """The rows one quick-staff click holds, from an org document. A ticket
    that is not stageable (not backlogged, archived, gone) needs only the
    docket: the body then replays a receipt or refuses, writing nothing
    else. A request locks the assignee (it is mailed); an immediate staffing
    is `orgtree_staff`'s rows with the user as the actor."""
    from . import quickstaff
    base = pgdoor.TxSpec(sections=QS_SECTIONS, logs=QS_LOGS)
    try:
        item, ctx = quickstaff.context(org, wid)
    except LedgerError:
        return base
    if ctx["mode"] == "request":
        nid = str((ctx["owner"] or {}).get("node") or "")
        return pgdoor.TxSpec(nodes=(nid,) if nid in org.nodes else (),
                             sections=QS_SECTIONS, logs=QS_LOGS)
    if not tier:
        return base                      # the body refuses: no model chosen
    s = staff_rows(org, USER, quickstaff.staff_args(org, item, ctx, str(tier),
                                                    effort, account))
    return pgdoor.TxSpec(nodes=s.nodes, sections=s.sections,
                         share_sections=s.share_sections, logs=QS_LOGS)


def quick_staff_spec(snapshot: Any, body: Any, a: dict[str, Any]) -> pgdoor.TxSpec:
    return quick_staff_rows(snapshot, a["wid"], body.tier, body.effort,
                            body.account)


def quick_staff_body(tx: pgdoor.OpTx) -> Any:
    """`api._quick_staff_locked` on the locked rows, re-deriving them from the
    LOCKED document first (a name taken, an assignee retired or the staffing
    behaviour changed since the snapshot widens before anything is written).
    Returns (result, undo, drive); a replayed receipt leaves through
    `pgdoor._Replay`, so the transaction rolls back instead of committing an
    empty write."""
    from . import api
    b, p = tx.body, tx.pre
    need = quick_staff_rows(tx.org, tx.args["wid"], b.tier, b.effort, b.account)
    missing = [n for n in need.nodes if n not in tx.spec.nodes]
    if missing:
        raise pgdoor.Widen(nodes=missing)
    drive: list[str] = []
    with _archive_deferred(tx.org):
        result, undo, replayed = api._quick_staff_locked(
            tx.org, tx.slug, tx.args["wid"], b, p["request_id"],
            p["selection"], p["snap"], p.get("harness"), drive)
    if replayed:
        raise pgdoor._Replay(result)
    check_created(tx.spec, str(result.get("node") or ""))
    return result, undo, drive


pgdoor.declare("quick_staff", quick_staff_spec, body=quick_staff_body,
               before=_sweep_first)


def quick_staff_undo_rows(org: Any, undo: dict[str, Any]) -> pgdoor.TxSpec:
    """The undo's rows: the docket, the request's recipient (its mail is
    retracted) and the owner being restored (an ownership write notifies).
    ⚠ The two NODE rows are held conservatively: measured today the undo
    changes neither (the retraction edits the org-wide `mail` section, and a
    request never changes the owner), so no outcome test can tell them apart
    from nothing (mutant Q7 survives by construction). They are kept because
    the mailbox is that node's, and WS5's mail split makes it a per-node row."""
    nodes = tuple(dict.fromkeys(
        n for n in (str(undo.get("node") or ""), str(undo.get("owner") or ""))
        if n and n in org.nodes))
    return pgdoor.TxSpec(nodes=nodes, sections=QS_SECTIONS, logs=QS_LOGS)


def quick_staff_undo_spec(snapshot: Any, body: Any,
                          a: dict[str, Any]) -> pgdoor.TxSpec:
    return quick_staff_undo_rows(snapshot, a["undo"])


def quick_staff_undo_body(tx: pgdoor.OpTx) -> bool:
    """`api._quick_staff_undo_locked` on the locked rows. When it declines
    (the item moved on), nothing was written and the transaction rolls back
    through `pgdoor._Replay` rather than committing an empty write."""
    from . import api
    a = tx.args
    with _archive_deferred(tx.org):
        done = api._quick_staff_undo_locked(tx.org, a["wid"], a["request_id"],
                                            a["nid"], a["undo"])
    if not done:
        raise pgdoor._Replay(False)
    return True


pgdoor.declare("quick_staff_undo", quick_staff_undo_spec,
               body=quick_staff_undo_body, before=_sweep_first)
