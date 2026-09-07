"""Resume only imported in-flight work through the normal recovery lifecycle."""
from . import store, supervisor


def resume_import(slug: str) -> dict:
    with store.DOC_LOCK:
        org = store.load_org(slug)
        metadata = org.d.get('desktop_import') or {}
        selected = list(metadata.get('active_nodes') or [])
        if not metadata.get('recovery_pending'):
            return {'selected': [], 'pending': [], 'already_reconciled': True}
    # reconcile saves the release before drive, folds uncertain deliveries,
    # respects frozen holds, and leaves idle queued agents alone in this mode.
    marked = supervisor.reconcile(slug, active_only=True)
    with store.DOC_LOCK:
        org = store.load_org(slug)
        pending = [nid for nid in selected if nid in org.nodes and org.nodes[nid].get('inflight')]
        metadata = org.d.setdefault('desktop_import', {})
        metadata['recovery_pending'] = bool(pending)
        metadata['recovery_selected'] = selected
        metadata['recovery_blocked'] = pending
        store.save_org(org)
    if pending:
        raise RuntimeError('Imported active work remains held; recovery metadata is retained')
    return {'selected': selected, 'pending': pending, 'unrecoverable': marked}
