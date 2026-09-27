"""Conservative status-only projection updates, never a second full projection."""
import hashlib
from . import store, tree_changes, tree_delta

# Both status producers (rcdoor and the compatibility API path) set these.
# Only last_status is rendered. Every other node field must be unchanged.
_STATUS = frozenset(('last_status', 'working_activity_at'))


def signature(node):
    return hashlib.sha256(tree_delta.encode({k:v for k,v in node.items() if k not in _STATUS})).digest()


class StatusProjection:
    def __init__(self, slug, runtime, watermarks):
        self.slug, self.runtime, self.watermarks = slug, runtime, watermarks

    def mark(self):
        return store.org_seq(self.slug), self.runtime()

    def capture(self, mark):
        org = store.cached_org(self.slug)
        hashes = {nid:signature(node) for nid,node in org.nodes.items()}
        if self.mark() != mark:
            return None
        return {'mark':mark, 'hashes':hashes}

    def update(self, state, mark):
        if state is None or state['mark'][1] != mark[1]:
            return None
        changes = tree_changes.since(store.DATA_ROOT, self.slug, state['mark'][0], mark[0])
        if changes is None:
            return None
        keys, nids, structural = changes
        if structural or keys - {'nodes', 'log'}:
            return None
        # Snapshot refresh reads changed rows only. Its sequence is rechecked
        # after every read: a racing save forces the ordinary full projection.
        watermarks = self.watermarks()
        org = store.cached_org(self.slug)
        nodes = {}
        for nid in nids:
            node = org.nodes.get(nid)
            if node is None or node.get('state') != 'live' or signature(node) != state['hashes'].get(nid):
                return None
            nodes[nid] = {'last_status':node.get('last_status')}
        if self.mark() != mark:
            return None
        return nodes, watermarks, {'mark':mark, 'hashes':state['hashes']}
