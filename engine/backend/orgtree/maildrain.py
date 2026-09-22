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
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    demand = org.node(nid).get('mail_drain')
                    if demand:
                        defer(org, nid, demand)
                        store.save_org(org)
            except Exception:
                pass  # durable content/intent remains; the consumer retries
            raise
        finally:
            # A concurrent send may already have reserved the next worker.
            # Never release its claim while unwinding this older worker.
            with store.DOC_LOCK:
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


def recover(slug: str, nid: str) -> bool:
    """One seat, one admission at most. Never take work from a live owner."""
    from . import halt, supervisor as sup
    global _discovery_needed
    with store.DOC_LOCK:
        org = store.load_org(slug)
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
        if (n['state'] != 'live' or n.get('halt') or org.d.get('killswitch')
                or n.get('frozen') or n.get('limit_locked')
                or n.get('remote_controlled') or org.d.get('spend_frozen')
                or (org.d.get('storage_blocked') and sup.sbx.on_disk(slug))
                or demand.get('retry_at', 0) > time.time()):
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
                org.node(nid)['mail_drain'] = {
                    **demand, 'held_reason': held, 'held_since': now()}
                store.save_org(org)
                print(f'[orgtree] {slug}/{nid}: mail delivery held — {held}')
            return False
        if demand.get('held_reason') or demand.get('held_since'):
            demand = {k: v for k, v in demand.items()
                      if k not in ('held_reason', 'held_since')}
            org.node(nid)['mail_drain'] = demand
            store.save_org(org)
        st = sup.state(slug, nid)
        # A receipt save may have failed after the provider consumed a batch.
        # Retry that save BEFORE any fold-back; never knowingly replay it.
        confirmed = list(st.get('mail_confirmed') or [])
        if confirmed:
            sup._confirm_delivered(slug, nid, confirmed)
            if st.get('mail_confirmed'):
                return False
            org = store.load_org(slug)
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
            box = (o.d.get('mail') or {}).get(nid) or []
            outstanding = {str(m.get('id')) for m in box}
            journals = (o.d.get('delivering') or {}).get(nid) or []
            # A batch still journaled is still owned by something the resolver
            # protected; its content keeps owning the demand, exactly as
            # before. Absence of a row is never read as success.
            outcome['journaled'] = [b['tok'] for b in journals]
            outstanding.update(str(m.get('id')) for b in journals
                               for m in b.get('mail') or [])
            remaining = [i for i in demand['ids'] if i in outstanding]
            outcome['remaining'] = remaining
            if not remaining:
                o.node(nid).pop('mail_drain', None)
            else:
                o.node(nid)['mail_drain'] = {**demand, 'ids': remaining}

        with store.DOC_LOCK:
            org = store.load_org(slug)
            # `queue_consumer=True`: popping a queued carrier and driving a
            # turn for it is this function's own next action, so a queued
            # carrier here really does have a consumer. Without that the
            # resolver would call it stranded and fold the batch out from under
            # a carrier still due for delivery — and `_envelope` skips the
            # mailbox for a carrier that claims to own a batch, so the mail
            # would then be delivered by nobody at all.
            # `now` comes from THIS module's clock so the drain hysteresis can
            # be exercised by the suite the same way the rest of the gate is.
            try:
                sup.reclaim_orphans(slug, nid, org=org, pump_toks=(),
                                    now=time.time(), queue_consumer=True,
                                    mutate=_settle)
            except Exception as exc:                         # noqa: BLE001
                # The transaction did not commit. The in-memory mutation is
                # discarded with the document and NOTHING is concluded from the
                # failure: the demand stays exactly as it was on disk and the
                # next sweep retries. Reporting success here — or clearing the
                # demand because the fold "probably" happened — is the
                # absent-evidence mistake this whole protocol refuses.
                print(f'[orgtree] {slug}/{nid}: mail reclaim will retry: {exc}')
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
        with sup._state_lock:
            queued_toks = {t for c in st['queue'] if isinstance(c, dict)
                           for t in c.get('toks') or []}
        if [t for t in outcome.get('journaled') or [] if t not in queued_toks]:
            return False
        with sup._state_lock:
            # ADMISSION is still gated on the node being free. Reclaim is safe
            # while a turn runs; STARTING one is not.
            if (st.get('busy') or st.get('proc_control') or st.get('responding')
                    or halt._workers.get((slug, nid))):
                return False
        with sup._state_lock:
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
            carrier = (st['queue'].pop(0) if st['queue'] else sup._mark_ping(
                '(orgtree) You have new mail above — handle it as appropriate.',
                mail_ids=remaining))
            st['busy'] = True
        try:
            sup._start_turn_worker(slug, nid, carrier)
        except Exception:
            # A failed thread admission must have another owner: this durable
            # deadline, serviced without another message or UI read.
            org = store.load_org(slug)
            d = org.node(nid).get('mail_drain') or demand
            defer(org, nid, d)
            store.save_org(org)
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
            with store.DOC_LOCK:
                org = store.load_org(slug)
                if not org.d.get('mail_drain_version'):
                    # Upgrade existing queued mail too: requiring one new send
                    # to mint the first intent would preserve the original bug.
                    for nid, n in org.nodes.items():
                        if (n['state'] == 'live' and not n.get('mail_drain')
                                and not n.get('hard_fail_run') and org.waking_mail(nid)):
                            request(org, nid)
                            if n.get('halt') or org.d.get('killswitch'):
                                suspend(org, nid)
                    org.d['mail_drain_version'] = 1
                    store.save_org(org)
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
