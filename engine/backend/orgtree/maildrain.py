"""Durable demand for mail delivery, independent of a turn's lifetime.

Mail and delivery journals own the content. This record owns only the fact
that a waking send still requires delivery; passive mail never creates it.
The consumer visits each eligible seat once per sweep and uses ordinary
turn admission, so delivery cannot recursively drain an expanding mailbox.
"""
from __future__ import annotations

import threading
import time
from functools import wraps

from . import stateprobe, store

POLL_S = 1.0
MAX_BATCH = 32
_kick = threading.Event()
_started = False
_discovery_needed = False
_pending: dict[tuple[str, str], None] = {}
_pending_lock = threading.Lock()


def _track(slug, nid):
    with _pending_lock:
        _pending[(slug, nid)] = None


def _forget(slug, nid):
    with _pending_lock:
        _pending.pop((slug, nid), None)


def request(org, nid: str) -> bool:
    """Under DOC_LOCK, before the send leaves durable storage (caller saves)."""
    ids = [str(m['id']) for m in (org.d.get('mail') or {}).get(nid, [])
           if m.get('id')]
    if not ids:
        return False
    old = org.node(nid).get('mail_drain') or {}
    org.node(nid)['mail_drain'] = {
        'ids': list(dict.fromkeys([*(old.get('ids') or []), *ids])),
        'retry_at': 0, 'failures': 0}
    _track(org.d['slug'], nid)
    _kick.set()
    return True


def pending(org, nid: str) -> bool:
    demand = org.node(nid).get('mail_drain') or {}
    return bool(demand and not demand.get('suspended'))


def suspend(org, nid: str) -> None:
    """Halt release restores eligibility only; it is not a new wake."""
    demand = org.node(nid).get('mail_drain')
    if demand:
        org.node(nid)['mail_drain'] = {**demand, 'suspended': True}
    _forget(org.d['slug'], nid)


def wake() -> None:
    _kick.set()


def worker(fn):
    """The last owner always releases its claim, even when cleanup raises."""
    @wraps(fn)
    def run(slug, nid, *args, **kwargs):
        from . import supervisor as sup
        stateprobe.set_op("drain:" + fn.__name__)
        st = sup.state(slug, nid)
        owner = threading.current_thread()
        with sup._state_lock:
            st.setdefault('mail_drain_owner', owner)
        try:
            return fn(slug, nid, *args, **kwargs)
        except Exception:
            try:
                # PG-3d: the seat's own row, not DOC_LOCK
                from . import orgtx
                with orgtx.org_tx(slug, nodes=[nid]) as tx:
                    demand = tx.org.node(nid).get('mail_drain')
                    if demand:
                        defer(tx.org, nid, demand)
            except Exception:
                pass  # durable content/intent remains; the consumer retries
            raise
        finally:
            # A concurrent send may already have reserved the next worker.
            # Never release its claim while unwinding this older worker.
            # fence-off S2: `_state_lock` only. Every claim and release of
            # `mail_drain_owner` is taken under it (here, `run` above and
            # `_start_turn_worker`); DOC_LOCK here ordered this RAM release
            # only against DOC_LOCK holders, which with the fence off no send
            # is. A send that saw `busy` leaves its mail in the durable box
            # and its demand in `mail_drain`, and the `wake()` below re-drives
            # `recover`, which delivers it (test_mail_drain_fence_off).
            with sup._state_lock:
                if st.get('mail_drain_owner') is owner:
                    st.pop('mail_drain_owner', None)
                    st['busy'] = st['waiting'] = st['responding'] = False
                    sup._fold_steer(st)
            wake()
    return run


def defer(org, nid, demand):
    failures = int(demand.get('failures') or 0) + 1
    org.node(nid)['mail_drain'] = {**demand, 'failures': failures,
        'retry_at': time.time() + min(30, 2 ** min(failures, 5))}


def discard(org, nid: str, ids) -> None:
    """Retire a terminal provider attempt; newer queued sends remain eligible."""
    demand = org.node(nid).get('mail_drain')
    if not demand:
        return
    drop = set(ids)
    keep = [i for i in demand['ids'] if i not in drop]
    if keep:
        org.node(nid)['mail_drain'] = {**demand, 'ids': keep}
    else:
        org.node(nid).pop('mail_drain', None)


#: The org-level sections the gate reads. The reclaim transaction holds them
#: FOR SHARE, so the gate it re-decides on the locked Org holds until commit.
GATE_SECTIONS = ('killswitch', 'spend_frozen', 'storage_blocked')


def _gated(org, nid: str, slug: str) -> bool:
    """The durable admission gate for one seat (the drain's own retry
    deadline aside), read on the lock-free snapshot to decide whether to try
    at all. It is decided AGAIN inside the reclaim transaction, on the locked
    Org (`supervisor._reclaim_blocked`, which covers every term here), before
    any admission (fence-off S2, p01's review condition b): the DOC_LOCK
    this replaced kept a freeze or spend write from committing between the
    gate read and the thread start."""
    from . import supervisor as sup
    n = org.nodes.get(nid)
    return bool(n is None or n['state'] != 'live' or n.get('halt')
                or org.d.get('killswitch') or n.get('frozen')
                or n.get('limit_locked') or n.get('remote_controlled')
                or org.d.get('spend_frozen')
                or (org.d.get('storage_blocked') and sup.sbx.on_disk(slug)))


def _write_demand(slug: str, nid: str, fn, default=None) -> None:
    """One row transaction on the seat's node row: `fn(org, demand)` edits
    the CURRENT `mail_drain` (re-read under the lock, never the snapshot's),
    or `default` when there is none; nothing is written when both are empty."""
    from . import orgtx
    with orgtx.org_tx(slug, nodes=[nid]) as tx:
        demand = tx.org.node(nid).get('mail_drain') or default
        if demand:
            fn(tx.org, demand)


def recover(slug: str, nid: str) -> bool:
    """One seat, one admission at most. Never take work from a live owner.

    fence-off S2: no DOC_LOCK. The old single hold covered several SEPARATE
    saves (the hold reason, the receipt retry, the reclaim fold and settle,
    the failed-admission deferral); each is now its own row transaction, and
    the fold and the settle stay ONE. The durable gate is decided on a
    lock-free read first and re-decided inside the reclaim transaction."""
    from . import halt, orgtx, supervisor as sup
    global _discovery_needed
    org = orgtx.org_read(slug)
    n = org.nodes.get(nid)
    if n is None:
        # A renamed seat carries its marker under the new name.
        _discovery_needed = True
    if not n or not pending(org, nid):
        _forget(slug, nid)
        return False
    demand = n['mail_drain']
    # ⚠ Import recovery is NOT a mail gate (user report 2026-09-14). It
    # owns exactly ONE thing — the single retained intent an import
    # interrupted — and `supervisor._import_recovery_hold` guards that at
    # the place it would be replayed. This consumer never replays it; it
    # delivers ordinary NEW mail, which cannot re-dispatch an imported
    # turn. Gating here switched the drain off from the import onward for
    # an org whose recovery can never settle (archived imported agents
    # leave their rows "uncertain" for good), and the same reasoning is
    # already written out at `_import_recovery_hold`.
    if _gated(org, nid, slug) or demand.get('retry_at', 0) > time.time():
        return False
    # SAY SO WHEN A SEAT CANNOT BE REACHED AT ALL. Every refusal above is
    # already visible on the agent's card — archived, frozen, limit-
    # locked, halted, out of spend. A native-context hold was not, and it
    # refuses the send path too, so an agent could stop receiving mail
    # completely with nothing anywhere saying why: the 2026-09-14 report
    # was "the coordinator isn't receiving new messages despite not being
    # in a turn", with 9 messages sitting undelivered in its mailbox.
    # Written once per distinct reason — this loop runs every second.
    held = sup._native_context_hold(org, nid)
    if held:
        if demand.get('held_reason') != held:
            from .ledger import now

            def _hold(o, d):
                if d.get('held_reason') != held:
                    o.node(nid)['mail_drain'] = {
                        **d, 'held_reason': held, 'held_since': now()}
            _write_demand(slug, nid, _hold)
            print(f'[orgtree] {slug}/{nid}: mail delivery held — {held}')
        return False
    if demand.get('held_reason') or demand.get('held_since'):
        def _unhold(o, d):
            o.node(nid)['mail_drain'] = {
                k: v for k, v in d.items()
                if k not in ('held_reason', 'held_since')}
        _write_demand(slug, nid, _unhold)
        demand = {k: v for k, v in demand.items()
                  if k not in ('held_reason', 'held_since')}
    st = sup.state(slug, nid)
    # A receipt save may have failed after the provider consumed a batch.
    # Retry that save BEFORE any fold-back; never knowingly replay it.
    confirmed = list(st.get('mail_confirmed') or [])
    if confirmed:
        sup._confirm_delivered(slug, nid, confirmed)
        if st.get('mail_confirmed'):
            return False
    sup.scan_steer_records(slug, nid)
    with sup._state_lock:
        # ⚠ ONLY when the turn has stopped responding. The steer store
        # means something exactly while `responding` is true — that is the
        # flag `send_message` reads to append there — so folding it under a
        # live tool call would take a carrier away from the turn that is
        # about to collect it.
        if not st.get('responding'):
            sup._fold_steer(st)
    # RECLAIM, then decide whether a turn is owed.
    #
    # ⚠ The old code returned here when the node was `busy`, `responding`
    # or under process control. That is the node-wide bit: it says the node
    # is doing SOMETHING, never that it is doing something with THIS batch,
    # and an old batch nothing owns stayed invisible to recovery for as
    # long as the node stayed busy with anything else. The resolver answers
    # the actual question per batch, so recovery no longer needs the
    # blindfold — a live current-turn batch, a queued or steered carrier, a
    # claim, a lease, a halt hold and a pending confirmation all still
    # protect, on their own evidence.
    #
    # One transaction: the fold and the `mail_drain` bookkeeping go into
    # the same document through `mutate`, instead of the old sequence of
    # self-loading wrapper, reload, and a second save against a document
    # read after an unsynchronized mutation.
    outcome: dict = {}

    def _settle(o) -> None:
        # Runs only once `reclaim_orphans` has re-decided the gate on the
        # LOCKED Org (`_reclaim_blocked`, a superset of `_gated`), so a seat
        # refused there never reaches this and is never admitted.
        outcome['settled'] = True
        box = (o.d.get('mail') or {}).get(nid) or []
        outstanding = {str(m.get('id')) for m in box}
        journals = (o.d.get('delivering') or {}).get(nid) or []
        # A batch still journaled is still owned by something the resolver
        # protected; its content keeps owning the demand, exactly as
        # before. Absence of a row is never read as success.
        outcome['journaled'] = [b['tok'] for b in journals]
        outstanding.update(str(m.get('id')) for b in journals
                           for m in b.get('mail') or [])
        # the demand as it is NOW, under the lock: the snapshot's copy may
        # predate a send that added ids, and those must not be dropped
        current = o.node(nid).get('mail_drain') or demand
        remaining = [i for i in current['ids'] if i in outstanding]
        outcome['remaining'] = remaining
        if not remaining:
            o.node(nid).pop('mail_drain', None)
        else:
            o.node(nid)['mail_drain'] = {**current, 'ids': remaining}

    # A queued carrier always holds its batch in the resolver: it is
    # due for delivery, and `_envelope` skips the mailbox for a
    # carrier that owns a batch, so folding it would leave the mail
    # delivered by nobody. This function services that carrier below.
    # `now` comes from THIS module's clock so the drain hysteresis can
    # be exercised by the suite the same way the rest of the gate is.
    # fence-off S2: the row branch (no `org=`) — ONE org_tx on the
    # seat's reclaim rows (its node row FOR UPDATE) plus GATE_SECTIONS FOR
    # SHARE, so the gate `_reclaim_blocked` re-decides on the locked Org
    # cannot change before the commit (p01's review condition b).
    try:
        sup.reclaim_orphans(slug, nid, pump_toks=(),
                            now=time.time(), mutate=_settle,
                            share_sections=GATE_SECTIONS)
    except Exception as exc:                         # noqa: BLE001
        # The transaction did not commit. The in-memory mutation is
        # discarded with the document and NOTHING is concluded from the
        # failure: the demand stays exactly as it was on disk and the
        # next sweep retries. Reporting success here — or clearing the
        # demand because the fold "probably" happened — is the
        # absent-evidence mistake this whole protocol refuses.
        print(f'[orgtree] {slug}/{nid}: mail reclaim will retry: {exc}')
        return False
    if not outcome.get('settled'):
        # refused on the locked Org: a gate closed since the lock-free read.
        # Nothing was settled and nothing is admitted, and the seat stays
        # tracked, exactly as a refusal at the first gate leaves it.
        return False
    remaining = outcome.get('remaining') or []
    if not remaining:
        _forget(slug, nid)
        return False
    # Anything still journaled is protected by something. A QUEUE carrier
    # is the one holder this function is itself about to service, so it
    # does not block; every other holder — a live turn, the steer store, a
    # claim, a lease, halt retention, a pending confirmation, or a batch
    # still inside the drain grace — owns the delivery, and starting a
    # second turn for the same mail would duplicate it. This is the old
    # `keep` rule, decided from evidence rather than from carrier shape.
    # The holder check, the free-node check, the pop and `busy` are ONE
    # take: a turn admitted between two takes would otherwise be joined
    # by a second one started here.
    with sup._state_lock:
        queued_toks = {t for c in st['queue'] if isinstance(c, dict)
                       for t in c.get('toks') or []}
        if [t for t in outcome.get('journaled') or [] if t not in queued_toks]:
            return False
        # ADMISSION is still gated on the node being free. Reclaim is safe
        # while a turn runs; STARTING one is not.
        if (st.get('busy') or st.get('proc_control') or st.get('responding')
                or halt._workers.get((slug, nid))):
            return False
        # Protected journaled carriers still own their exact payload.
        # Only empty obsolete pointers can be removed from this queue.
        st['queue'] = [c for c in st['queue']
                       if not (sup._carrier_is_ping(c) and not c.get('toks')
                               and c.get('mail_ids')
                               and not set(c['mail_ids']).intersection(remaining))]
        # A carrier that survived the filter may still name a batch the
        # reclaim moved back. Strip those tokens: a carrier claiming to own
        # a row that no longer exists makes `_envelope` skip the mailbox,
        # so it would deliver neither the folded mail nor the new mail.
        st['queue'] = [survivor for survivor in
                       (sup._publishable(st, c) for c in st['queue'])
                       if survivor is not None]
        # The pop registers a visible handoff in this same take, so the
        # carrier is never held only by this frame on its way to the turn.
        carrier = sup._take_queued_carrier(st)
        if carrier is None:
            carrier = sup._mark_ping(
                '(orgtree) You have new mail above — handle it as appropriate.',
                mail_ids=remaining)
        st['busy'] = True
    try:
        sup._start_turn_worker(slug, nid, carrier)
    except Exception:
        # A failed thread admission must have another owner: this durable
        # deadline, serviced without another message or UI read.
        # the legacy `get('mail_drain') or demand`: a demand settled away
        # meanwhile is re-armed, so the failed admission keeps an owner
        _write_demand(slug, nid, lambda o, d: defer(o, nid, d), default=demand)
        raise
    return True


def discover() -> bool:
    """One startup scan reconstructs the active index from durable intent."""
    complete = True
    try:
        orgs = store.list_orgs()
    except Exception:
        return False
    for row in orgs:
        slug = row['slug']
        try:
            # PG-3d: a lock-free read, and the one-time upgrade as a row
            # transaction on the org's node rows, not DOC_LOCK
            from . import orgtx
            org = orgtx.org_read(slug)
            if not org.d.get('mail_drain_version'):
                declared = list(org.nodes)
                with orgtx.org_tx(slug, nodes=declared, sections=['mail_drain_version'],
                                  share_sections=['mail', 'killswitch']) as tx:
                    up = tx.org
                    if not up.d.get('mail_drain_version'):
                        # Upgrade existing queued mail too: requiring one new
                        # send to mint the first intent would preserve the
                        # original bug. (A seat hired since the read gets its
                        # intent from its own first send.)
                        for nid in declared:
                            n = up.nodes.get(nid)
                            if (n and n['state'] == 'live' and not n.get('mail_drain')
                                    and not n.get('hard_fail_run') and up.waking_mail(nid)):
                                request(up, nid)
                                if n.get('halt') or up.d.get('killswitch'):
                                    suspend(up, nid)
                        up.d['mail_drain_version'] = 1
                org = orgtx.org_read(slug)
            seats = [nid for nid, n in org.nodes.items()
                     if pending(org, nid) and n['state'] == 'live']
        except Exception:
            complete = False
            continue
        for nid in seats:
            _track(slug, nid)
    return complete


def sweep() -> None:
    # Rotate a finite batch. A busy or held seat cannot starve later seats,
    # and ordinary ticks never walk every archived node in every org.
    with _pending_lock:
        seats = list(_pending)[:MAX_BATCH]
        for key in seats:
            _pending.pop(key)
            _pending[key] = None
    for slug, nid in seats:
        try:
            recover(slug, nid)
        except Exception as exc:
            print(f'[orgtree] {slug}/{nid}: mail drain will retry: {exc}')


def start() -> None:
    global _started, _discovery_needed
    if _started:
        return
    _discovery_needed = not discover()

    from . import startup
    threading.Thread(target=run, args=(startup.recovery.cancelled,),
                     daemon=True, name='mail-drain').start()
    _started = True


def run(stop: threading.Event) -> None:
    global _discovery_needed
    while not stop.is_set():
        _kick.wait(POLL_S)
        _kick.clear()
        if not stop.is_set():
            if _discovery_needed:
                _discovery_needed = not discover()
            sweep()
