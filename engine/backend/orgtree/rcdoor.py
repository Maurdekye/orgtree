"""rcdoor — PG-3c's lock declarations: credits, reservations, status and
watchdogs onto `org_tx` (PYPG-PLAN §3; the door is pgdoor, plan decisions 10
and 12).

What each operation reads to decide and what it writes (traced from
`Org.reallocate`, `_chain_acquire`, `request_credits`, `credit_headroom`,
`credit_request_action`, `reservations.execute`, the `orgtree_status` branch
and the watchdog methods; the inventory is scratch p03-ws4-rcfamilies/
pg3c-inventory.md):

  FUNDING (money — mutation-tested)
  · reallocate(actor, nid, Δ) — the TARGET and every ancestor up to the
    acting agent (the user: up to the top), FOR UPDATE. Authority walks that
    chain; a raise draws on `free()` of each hop (`_chain_acquire`) and may
    write `grant` on any of them; a cut reads `free(nid)`.
    THE INVARIANT THAT MAKES THIS ENOUGH: `free(k)` is `k.grant` minus its
    children's grants and seat costs, and every writer of a child's grant
    holds that child's PARENT row FOR UPDATE (a reallocate's chain starts at
    the target's parent; a hire's chain starts at the destination). So two
    spends from one payer queue on the payer's row, and the second one
    re-reads the first one's committed grant before deciding (race test RT1,
    the last credit).
  · request_credits — `credit_requests` FOR UPDATE (one pending request per
    node, `cr<n>` ids minted from its length); the node and its chain FOR
    SHARE (the headroom check). The headroom check only decides whether a
    request is FILED — no credit moves until a decision, which re-checks
    everything through reallocate — so the kiosk-pool branch's scan of the
    top-level nodes is read unlocked.
  · credit decide (operator) — `credit_requests` FOR UPDATE; on approve the
    reallocate rows above with actor USER; the decision mail's send rows.

  STATUS · the caller's row (last_status); for done/blocked with a parent,
    the report mail's send rows to the parent (`mailtx.send_rows`).

  RESERVATIONS · the `reservations` section FOR UPDATE — every action scans
    and rewrites that one row, so two acquires of one resource queue on it
    and the second sees the first (race test RT8). The 512-row cap
    (reservations.py) is unchanged. Visibility reads of `work_items` are
    FOR SHARE; a release to a successor adds that mail's send rows.

  WATCHDOGS · `watchdogs`, `watchdog_tombs`, `lifecycle` FOR UPDATE (caps:
    8 per agent, 32 per org, counted on that row).

The kiosk credit cap (`api._kiosk_cap_check`) reads every live node
(`Org.audit`), which no row lock can cover; it runs on the transaction's
document, unlocked, for the grant-changing operations only (pending the
lead's ruling, asked 2026-09-25 16:50Z).
"""
from __future__ import annotations

from typing import Any

from . import mailtx, pgdoor
from .ledger import USER, actor_kind

# org settings the funding decisions read (FOR SHARE: the phantom rule — a
# settings writer takes them FOR UPDATE)
FUNDING_SETTINGS = ("tiers", "cascade_alloc", "max_top_grant", "kiosk",
                    "slug", "headless")
FUNDING_LOGS = ("events", "notice_log")
# `_notify_ev` / `_stranding_warnings` rewrite the org-wide notices row
FUNDING_SECTIONS = ("notices",)

REQUESTS = "credit_requests"
RESERVATIONS = "reservations"
WATCHDOG_SECTIONS = ("watchdogs", "watchdog_tombs")
WATCHDOG_SETTINGS = ("sandbox", "workspace", "slug")

# Tools that skip `api._kiosk_cap_check` (lead decision 18.8). The cap bounds
# `Org.audit()["top_level_holds"]` = the sum of seat_cost(model) + grant over
# the live top-level nodes, so only a write to a node's parent, state, model
# or grant, a new node, or the `tiers` prices can move it. None of these
# tools writes any of those (status: last_status/working_activity_at and the
# parent's mail_seq/mailbox_id; reservations: the reservations row; watchdogs:
# the watchdog rows; a credit REQUEST: credit_requests — the grant moves only
# at the decision, which keeps the check). Proven end to end, on an org
# already over its cap, by tests/test_pg3c_kiosk_exempt.py.
KIOSK_EXEMPT = frozenset({"orgtree_status", "orgtree_reservation",
                          "orgtree_resource_reservation", "orgtree_watchdog",
                          "orgtree_request_credits"})
HOLDS_FIELDS = ("parent", "state", "model", "grant")

TOOLS = ("orgtree_reallocate", "orgtree_request_credits", "orgtree_status",
         "orgtree_reservation", "orgtree_resource_reservation",
         "orgtree_watchdog")


def chain(org: Any, nid: str | None, actor: str) -> tuple[str, ...]:
    """`nid` and its ancestors up to and INCLUDING `actor` (for the user, up
    to the top). An unknown id stops the walk (the body's own checks refuse
    it)."""
    out: list[str] = []
    cur = nid
    seen: set[str] = set()
    while cur and cur != USER and cur not in seen and cur in org.nodes:
        out.append(cur)
        seen.add(cur)
        if cur == actor:
            break
        cur = org.nodes[cur].get("parent")
    return tuple(out)


def _spec(nodes: tuple[str, ...] = (), sections: tuple[str, ...] = (),
          share_nodes: tuple[str, ...] = (),
          share_sections: tuple[str, ...] = (),
          logs: tuple[Any, ...] = ()) -> pgdoor.TxSpec:
    return pgdoor.TxSpec(nodes=tuple(nodes), sections=tuple(sections),
                         share_nodes=tuple(share_nodes),
                         share_sections=tuple(share_sections),
                         logs=tuple(logs))


def _mail(*to: str) -> pgdoor.TxSpec:
    r = mailtx.send_rows(*to)
    return _spec(nodes=tuple(r.get("nodes", ())),
                 sections=tuple(r.get("sections", ())),
                 logs=tuple(r.get("logs", ())))


def union(*specs: pgdoor.TxSpec) -> pgdoor.TxSpec:
    out = _spec()
    for s in specs:
        out = out.widened(pgdoor.Widen(nodes=s.nodes, sections=s.sections,
                                       share_nodes=s.share_nodes,
                                       share_sections=s.share_sections,
                                       logs=s.logs))
    return out


# ------------------------------------------------------------------ funding

def reallocate_rows(org: Any, actor: str, nid: str | None) -> pgdoor.TxSpec:
    return _spec(nodes=chain(org, nid, actor), sections=FUNDING_SECTIONS,
                 share_sections=FUNDING_SETTINGS, logs=FUNDING_LOGS)


def reallocate_spec(snapshot: Any, body: Any, a: dict[str, Any]
                    ) -> pgdoor.TxSpec:
    return reallocate_rows(snapshot, body.node, str(a.get("node") or ""))


def request_rows(org: Any, nid: str) -> pgdoor.TxSpec:
    return _spec(sections=(REQUESTS,),
                 share_nodes=chain(org, nid, USER),
                 share_sections=FUNDING_SETTINGS + ("audiences",),
                 logs=("events",))


def request_spec(snapshot: Any, body: Any, a: dict[str, Any]
                 ) -> pgdoor.TxSpec:
    return request_rows(snapshot, body.node)


def decide_rows(org: Any, rid: str) -> pgdoor.TxSpec:
    """The operator's decision on credit request `rid`: the request row, the
    approval's reallocate (actor USER, so the chain runs to the top) and the
    decision mail to the asking node."""
    req = next((r for r in org.d.get(REQUESTS) or [] if r.get("id") == rid),
               None)
    nid = str(req.get("node") or "") if req else ""
    parts = [_spec(sections=(REQUESTS,), logs=("events",))]
    if nid:
        # the user SENDS the decision mail: its outbox is in the send logs
        parts += [reallocate_rows(org, USER, nid), _mail(nid)]
    return union(*parts)


# ------------------------------------------------------------------- status

def status_rows(org: Any, nid: str, status: str) -> pgdoor.TxSpec:
    parent = org.nodes.get(nid, {}).get("parent") if nid in org.nodes \
        else None
    if status in ("done", "blocked") and parent:
        return union(_spec(nodes=(nid,)), _mail(parent))
    return _spec(nodes=(nid,))


def status_spec(snapshot: Any, body: Any, a: dict[str, Any]
                ) -> pgdoor.TxSpec:
    return status_rows(snapshot, body.node, str(a.get("status") or "working"))


# ------------------------------------------------------------- reservations

def reservation_rows(successor: str | None = None) -> pgdoor.TxSpec:
    base = _spec(sections=(RESERVATIONS,),
                 share_sections=("work_items",))
    if successor:
        return union(base, _mail(successor))
    return base


def reservation_spec(snapshot: Any, body: Any, a: dict[str, Any]
                     ) -> pgdoor.TxSpec:
    succ = str(a.get("successor") or "") or None
    return reservation_rows(succ if a.get("action") == "release" else None)


# ---------------------------------------------------------------- watchdogs

def watchdog_rows() -> pgdoor.TxSpec:
    return _spec(sections=WATCHDOG_SECTIONS,
                 share_sections=WATCHDOG_SETTINGS, logs=("events", "lifecycle"))


def watchdog_fire_rows(owner: str) -> pgdoor.TxSpec:
    """A dog firing (the supervisor's `_wd_fire`/`_wd_alert`): the dog rows
    plus the wake mail's deposit into the owner's box. `watchdog_history` is
    appended, so it is named as a log."""
    return union(watchdog_rows(), _mail(owner),
                 _spec(logs=("watchdog_history",)))


def watchdog_action_rows(org: Any, actor: str, wid: str) -> pgdoor.TxSpec:
    """pause/resume/remove/supersede by `actor`: the dog rows, plus the
    owner's chain up to the actor FOR SHARE — the downward-authority check
    reads it. The user (or the system) passes that check without reading any
    node row (`Org._require_authority`), so for them it is the dog rows only
    — the canvas route (`api.watchdog_action`, fence-off S10)."""
    if actor_kind(actor) in ("user", "system"):
        return watchdog_rows()
    w = next((d for d in org.d.get("watchdogs") or [] if d.get("id") == wid),
             None)
    owner = str(w.get("owner") or "") if w else ""
    if not owner or owner == actor:
        return watchdog_rows()
    return union(watchdog_rows(), _spec(share_nodes=chain(org, owner, actor)))


def watchdog_spec(snapshot: Any, body: Any, a: dict[str, Any]
                  ) -> pgdoor.TxSpec:
    act = str(a.get("action") or "")
    if act in ("pause", "resume", "remove", "supersede"):
        return watchdog_action_rows(snapshot, body.node,
                                    str(a.get("id") or ""))
    return watchdog_rows()


# ------------------------------------------------------------ the re-check

def require(held: pgdoor.TxSpec, need: pgdoor.TxSpec) -> None:
    """Call FIRST in a body, with the rows re-derived from the LOCKED
    document: if the tree moved since the snapshot and a row is missing,
    `Widen` so the door re-runs with it. Nothing has been written yet.

    Coverage is the door's own rule (`TxSpec.covers`, the one `pgdoor.join`
    applies): a shared row is covered by either lock, a (section, owner) row
    by its whole section, a (log, owner) by its log."""
    miss = held.covers(need)
    if not miss.empty():
        raise pgdoor.Widen(nodes=miss.nodes, sections=miss.sections,
                           share_nodes=miss.share_nodes,
                           share_sections=miss.share_sections, logs=miss.logs)


# ------------------------------------------------------ the door bodies
#
# Each body is the agent_call branch of the same tool, moved onto the door
# (pgdoor.declare(..., body=)). It runs inside ONE org_tx, may re-run (widen,
# retry), so nothing outside the document happens in it: wakes go in
# `tx.after.drive`, and mail_notify and the like in `tx.after.then`, both of
# which the door runs only after the commit. `api` is imported lazily — it
# imports this module.

def _reallocate_body(tx: Any) -> Any:
    from . import api
    a = tx.args
    require(tx.spec, reallocate_rows(tx.org, tx.node, str(a.get("node") or "")))
    return tx.org.reallocate(tx.node, a.get("node"),
                             api._arg_num(a, "delta", 0))


def op_reallocate_spec(snapshot: Any, body: Any, a: dict[str, Any]
                       ) -> pgdoor.TxSpec:
    """The OPERATOR's reallocate (`POST /ops` op="reallocate"; p03-lead
    ruling 2026-09-26 13:22Z (a): funding supplies it, WS3a declares it for
    op_tx). The same rows as the agent tool (`reallocate_spec`) with the
    acting identity `body.actor` — the user, or an agent acting through the
    operator door — in place of the calling seat."""
    return reallocate_rows(snapshot, str(body.actor), body.node)


def op_reallocate_body(tx: Any) -> Any:
    """`_org_op_locked`'s reallocate branch on the locked rows, re-checked
    first like `_reallocate_body` (a moved tree widens before anything is
    written). Pure document work: no after-commit tail."""
    from .ledger import LedgerError
    b = tx.body
    if b.delta is None:
        raise LedgerError("reallocate needs delta")
    require(tx.spec, reallocate_rows(tx.org, str(b.actor), b.node))
    return tx.org.reallocate(b.actor, b.node, b.delta)


def _request_body(tx: Any) -> Any:
    a = tx.args
    require(tx.spec, request_rows(tx.org, tx.node))
    return tx.org.request_credits(tx.node, a.get("new_limit"), a.get("reason"))


def _status_body(tx: Any) -> Any:
    from . import api, events, supervisor
    from .ledger import actor_of
    org, node, a = tx.org, tx.node, tx.args
    status = a.get("status", "working")
    summary = a.get("summary", "")
    require(tx.spec, status_rows(org, node, str(status)))
    # the orgtree_status branch of api.agent_call, unchanged: `done` is
    # stored as idle, `blocked` is not collapsed; done/blocked reports to
    # the superior as typed status mail
    stored = "idle" if status == "done" else status
    status_at = supervisor.now_iso()
    org.node(node)["last_status"] = {"status": stored, "summary": summary,
                                     "at": status_at}
    if stored == "working":
        org.node(node)["working_activity_at"] = status_at
    else:
        org.node(node).pop("working_activity_at", None)
    result: dict[str, Any] = {"recorded": status}
    if status in ("done", "blocked"):
        parent = org.node(node)["parent"]
        if parent:
            r = org.post_mail(
                node, parent, "", kind="status",
                ev=events.mint("status.report", actor_of(node),
                               org.node_ref(node),
                               state=str(status), summary=str(summary)))
            tx.after.then.append(
                lambda _res, _p=parent: api.mail_notify(tx.call.org, node, _p))
            tx.after.drive.append(parent)
            result["reported_to"] = parent
            result["delivered"] = parent
            result["id"] = r.get("id")
            result["warnings"] = r.get("warnings", [])
        else:
            result["reported_to"] = ("status chip only — report your "
                                     "actual results to the user via "
                                     "orgtree_message")
    return result


def _reservation_body(tx: Any) -> Any:
    from . import api, reservations, supervisor
    from .ledger import LedgerError
    org, node, a = tx.org, tx.node, tx.args
    succ_arg = str(a.get("successor") or "") or None
    require(tx.spec, reservation_rows(
        succ_arg if a.get("action") == "release" else None))
    org._require_live(node)

    def _item_visible(item: str) -> bool:
        try:
            org._work_get_for(node, item)
            return True
        except LedgerError:
            return False

    def _live_node(n: str) -> bool:
        try:
            return org.node(n).get("state") == "live"
        except LedgerError:
            return False

    def _successor_allowed(n: str, item: str) -> bool:
        if not item:
            return False
        try:
            org._work_get_for(n, item)
            return True
        except LedgerError:
            return False

    try:
        result = reservations.execute(
            org.d, node, a, item_reader=_item_visible, node_exists=_live_node,
            successor_allowed=_successor_allowed)
    except reservations.ReservationError as e:
        raise LedgerError(str(e)) from e
    succ = str(result.get("notified") or "")
    if succ:
        # the successor the store chose must be one this tx holds the mail
        # rows for; if the caller named none (or another), widen
        require(tx.spec, reservation_rows(succ))
        rid = str((result.get("reservation") or {}).get("id") or "")
        posted = org.post_mail(
            node, succ,
            f"Reservation {rid} was released; its release receipt "
            f"is {str(result.get('release_receipt') or '')}.",
            "status")
        slug = tx.call.org

        def _after(res: Any, _s: str = succ,
                   _wake: bool = not posted.get("deferred")) -> None:
            api.mail_notify(slug, node, _s)
            if _wake:
                # the cycle's drive for a mail recipient (`mail_to`): the
                # wake, plus the carrier note on the result
                r = supervisor.send_message(
                    slug, _s,
                    "(orgtree) You have new mail above — handle it as "
                    "appropriate, and use orgtree_status when your own task "
                    "state changes.", mail_ping=True, sender=node,
                    ping_reason="agent_mail")
                if isinstance(res, dict):
                    res["delivery"] = supervisor.delivery_note(slug, _s, r)
        tx.after.then.append(_after)
    return result


def _watchdog_body(tx: Any) -> Any:
    """The orgtree_watchdog branch of api.agent_call on the door (plan
    decision 22). Its host checks (sandbox, the file containment, finding a
    bash) only read, so they may re-run with the body; the smoke run spawns
    a real child and waits seconds for it, so it runs in `after.then`, once,
    after the commit — the same place the cycle ran it (after the save)."""
    import os

    from . import sandbox, supervisor
    from .ledger import LedgerError
    org, node, a = tx.org, tx.node, tx.args
    act = str(a.get("action") or "")
    if act == "list":
        # the owner's dogs and its subtree's: read-only, unlocked rows
        return {"watchdogs": [
            supervisor.wd_list_row(w)
            for w in org.d.get("watchdogs") or []
            if w["owner"] == node or org.is_ancestor(node, str(w["owner"]))]}
    if act != "create":
        require(tx.spec, watchdog_action_rows(org, node,
                                              str(a.get("id") or "")))
        return org.watchdog_action(node, str(a.get("id") or ""), act,
                                   str(a.get("reason") or ""))
    require(tx.spec, watchdog_rows())
    kind = str(a.get("kind") or "")
    tgt = str(a.get("target") or "").strip()
    if kind == "file":
        # capability containment — see api.agent_call's copy of this branch
        # for the reasoning; the rule itself is `wd_file_contained`
        if sandbox.is_sandboxed(org):
            raise LedgerError(
                "sandboxed agents watch files with a STREAM "
                "watchdog instead (e.g. target: tail -n0 -f "
                "<path>) — it runs inside your container "
                "with your own hands")
        wroot = os.path.realpath(supervisor.scratch_dir(tx.call.org, node))
        full = os.path.realpath(tgt if os.path.isabs(tgt)
                                else os.path.join(wroot, tgt))
        if not supervisor.wd_file_contained(org, node, full):
            raise LedgerError(
                f"cannot watch {tgt} — only files in your "
                f"working folder, the workspace, or a "
                f"folder you hold are watchable "
                f"(orgtree_request_scope can ask for more)")
        tgt = full
    shell = str(a.get("shell") or "native").strip().lower()
    if shell == "bash" and kind in ("command", "stream"):
        # ☠ REFUSE, NEVER FALL BACK — see api.agent_call's copy
        if sandbox.is_sandboxed(org):
            raise LedgerError(
                "shell='bash' is for host orgs — your dogs "
                "already run in a POSIX shell (`sh -lc`) "
                "inside your container, so the full idiom "
                "works without it. Omit `shell`.")
        if supervisor.wd_bash_exe() is None:
            raise LedgerError(
                "shell='bash' was asked for but no bash can "
                "be found on this machine (looked on PATH, "
                "in the Git for Windows install locations, "
                "and in the registry; a WSL "
                "System32\\bash.exe is deliberately NOT "
                "used — it would run your command in a "
                "different filesystem entirely). REFUSING "
                "rather than quietly running your target in "
                "cmd.exe, where a bash idiom matches nothing "
                "and the dog looks healthy forever. Install "
                "Git for Windows, or write a cmd target "
                "(findstr, dir /b, %VAR%) and omit `shell`.")
    result = org.watchdog_create(
        node, a.get("name"), kind, tgt, a.get("pattern"),
        a.get("interval_s") or 60, a.get("notice"), a.get("shell"),
        a.get("once"))
    smoke_org = org

    def _smoke(res: Any, _k: str = kind, _t: str = tgt) -> None:
        # FAIL LOUDLY AT CREATE TIME — api.agent_call's smoke epilogue, moved
        # here unchanged: outside every lock, once, after the commit
        if not isinstance(res, dict):
            return
        try:
            smoke = supervisor.wd_smoke(smoke_org, node, _k, _t,
                                        a.get("pattern"),
                                        shell_pref=a.get("shell"))
            res["smoke"] = smoke
            if smoke.get("broken"):
                res["status"] = (
                    "⚠ ARMED BUT ITS TARGET DOES NOT WORK — see `smoke`. "
                    "This dog will sit `armed, fired: 0` forever, which "
                    "looks exactly like the condition never happening. Fix "
                    "the target and re-create it. "
                    + str(res.get("status") or ""))
        except Exception as e:                                   # noqa: BLE001
            res["smoke"] = {"error": f"smoke run failed: {e}"}
    tx.after.then.append(_smoke)
    return result


def declare_all() -> None:
    """Register PG-3c's agent tools on the door. `orgtree_watchdog` is here
    with the supervisor's `_wd_*` writers (`supervisor._wd_write`), which
    take the same rows (plan decision 22)."""
    for name, spec, body in (
            ("orgtree_reallocate", reallocate_spec, _reallocate_body),
            ("orgtree_request_credits", request_spec, _request_body),
            ("orgtree_status", status_spec, _status_body),
            ("orgtree_reservation", reservation_spec, _reservation_body),
            ("orgtree_resource_reservation", reservation_spec,
             _reservation_body),
            ("orgtree_watchdog", watchdog_spec, _watchdog_body)):
        pgdoor.declare(name, spec, body=body,
                       kiosk_exempt=name in KIOSK_EXEMPT)


declare_all()


# ------------------------------------------------------ operator doors

def run_op(slug: str, spec: pgdoor.TxSpec, fn: Any) -> Any:
    """An OPERATOR door (no caller row, no halt gate, no receipts): `fn(h)`
    in one pgdoor transaction on `spec` — `h.org` is the locked Org — with
    pgdoor's widening and retries. The body re-checks its rows with
    `hold()`."""
    return pgdoor.run(slug, spec, fn)


def hold(slug: str, need: pgdoor.TxSpec) -> None:
    """Inside a `run_op` body: every row in `need` must already be held, or
    pgdoor widens and re-runs (pgdoor.join). Call it FIRST, re-deriving
    `need` from the locked document."""
    with pgdoor.join(slug, nodes=need.nodes, sections=need.sections,
                     share_nodes=need.share_nodes,
                     share_sections=need.share_sections, logs=need.logs):
        pass
