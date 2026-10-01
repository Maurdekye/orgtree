"""Selected read-only inputs before the locked turn admission transaction."""
from . import identity_context, store
from .foreground_context import CompatibilityRequired


def load(slug, nid, *, mail=False):
    """Normalize the selected seat and optionally its current pending mailbox.

    This does not resolve custody receipts or authorize an admission. The
    locked turn transaction remains authoritative, including mail composition.
    """
    pinned = getattr(store._orgtx_local, 'pinned', None) or {}
    if store.STORE_BACKEND == 'postgres' and slug not in pinned:
        from .foreground_store import _snapshot
        import json
        try:
            with _snapshot(slug) as (raw, _stamp):
                context = identity_context._read(raw, slug, nid)
                if mail:
                    key = 'mail' + store.SPLIT_SEP + nid
                    values = dict(raw.execute(
                        'SELECT key,val FROM doc WHERE key=ANY(%s)',
                        ([key, 'mail'],)).fetchall())
                    if json.loads(values.get('mail', '{}')):
                        raise CompatibilityRequired('legacy unsplit mailbox')
                    context.d['mail'] = {nid: json.loads(values.get(key, '[]'))}
                return context
        except CompatibilityRequired:
            pass
    return store.load_runtime_org(slug)
