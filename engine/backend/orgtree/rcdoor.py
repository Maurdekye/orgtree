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
from .ledger import USER

# org settings the funding decisions read (FOR SHARE: the phantom rule — a
# settings writer takes them FOR UPDATE)
FUNDING_SETTINGS = ("tiers", "cascade_alloc", "max_top_grant", "kiosk",
                    "slug", "headless")
FUNDING_LOGS = ("events", "notice_log")
# `_notify_ev` / `_stranding_warnings` rewrite the org-wide notices row
FUNDING_SECTIONS = ("notices",)

REQUESTS = "credit_requests"
RESERVATIONS = "reservations"
WATCHDOG_SECTIONS = ("watchdogs", "watchdog_tombs", "lifecycle")
WATCHDOG_SETTINGS = ("sandbox", "workspace", "slug")

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
                 share_sections=WATCHDOG_SETTINGS, logs=("events",))


def watchdog_fire_rows(owner: str) -> pgdoor.TxSpec:
    """A dog firing (the supervisor's `_wd_fire`/`_wd_alert`): the dog rows
    plus the wake mail's deposit into the owner's box. `watchdog_history` is
    appended, so it is named as a log."""
    return union(watchdog_rows(), _mail(owner),
                 _spec(logs=("watchdog_history",)))


def watchdog_spec(snapshot: Any, body: Any, a: dict[str, Any]
                  ) -> pgdoor.TxSpec:
    return watchdog_rows()


# ------------------------------------------------------------ the re-check

def require(held: pgdoor.TxSpec, need: pgdoor.TxSpec) -> None:
    """Call FIRST in a body, with the rows re-derived from the LOCKED
    document: if the tree moved since the snapshot and a row is missing,
    `Widen` so the door re-runs with it. Nothing has been written yet."""
    miss = {k: tuple(x for x in getattr(need, k) if x not in getattr(held, k)
                     and not (k.startswith("share_")
                              and x in getattr(held, k[6:])))
            for k in ("nodes", "sections", "share_nodes", "share_sections",
                      "logs")}
    if any(miss.values()):
        raise pgdoor.Widen(**{k: v for k, v in miss.items() if v})


def declare_all() -> None:
    pgdoor.declare("orgtree_reallocate", reallocate_spec)
    pgdoor.declare("orgtree_request_credits", request_spec)
    pgdoor.declare("orgtree_status", status_spec)
    pgdoor.declare("orgtree_reservation", reservation_spec)
    pgdoor.declare("orgtree_resource_reservation", reservation_spec)
    pgdoor.declare("orgtree_watchdog", watchdog_spec)


# ------------------------------------------------------ operator doors

def _log_key(x: Any) -> str:
    return x if isinstance(x, str) else " ".join(x)


def _norm(spec: pgdoor.TxSpec) -> pgdoor.TxSpec:
    """pgdoor's rule (a row named both ways is held FOR UPDATE only;
    ascending order) with logs sorted by a key that also orders the
    `(section, owner)` dict-log names mail sends carry — pgdoor._norm's plain
    `sorted()` raises TypeError on that mix (reported to WS3a)."""
    ns = tuple(sorted(set(spec.nodes)))
    ss = tuple(sorted(set(spec.sections)))
    return pgdoor.TxSpec(ns, ss,
                         tuple(sorted(set(spec.share_nodes) - set(ns))),
                         tuple(sorted(set(spec.share_sections) - set(ss))),
                         tuple(sorted(set(spec.logs), key=_log_key)))


def run_op(slug: str, spec: pgdoor.TxSpec, fn: Any) -> Any:
    """Run an OPERATOR door body `fn(tx)` in one `org_tx` on `spec`, re-running
    with the widened set when the body raises `pgdoor.Widen` (the tree moved
    since the snapshot the spec came from). `tx` is orgtx's OrgTx: the locked
    Org is `tx.org`, and `tx.spec` is set to the rows held so a body can
    `require()` against them. Same contract as pgdoor.op_tx, on orgtx
    directly (pgdoor's production seam is not installed on this branch)."""
    from . import orgtx
    widens = 0
    while True:
        spec = _norm(spec)
        try:
            with orgtx.org_tx(slug, nodes=list(spec.nodes),
                              sections=list(spec.sections),
                              share_nodes=list(spec.share_nodes),
                              share_sections=list(spec.share_sections),
                              logs=list(spec.logs)) as tx:
                tx.spec = spec      # type: ignore[attr-defined]
                return fn(tx)
        except pgdoor.Widen as w:
            widens += 1
            if widens > pgdoor.MAX_WIDEN:
                from .ledger import LedgerError
                raise LedgerError("rcdoor: the lock set kept growing — nothing "
                                  "was applied; retry") from w
            spec = spec.widened(w)
