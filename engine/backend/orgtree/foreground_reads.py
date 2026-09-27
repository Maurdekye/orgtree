"""Small foreground prechecks; write gates still use their locked Org."""
from __future__ import annotations

from . import store


def node_gates(slug: str, nid: str, sections: tuple[str, ...] = (), *,
               fresh: bool = False) -> dict:
    """One coherent stored node/gate read, or the exact legacy Org view.

    These consumers use only durable status, parent, generation and gates.
    Older node identities may need Org normalization; do not infer it here.
    A missing node is distinct from an unsupported representation. No result
    is cached or used to replace a locked authorization decision.
    """
    if store.STORE_BACKEND == "postgres":
        projection = store.read_runtime_node(slug, nid, sections)
        if projection is not None:
            node = projection["node"]
            if node is None or ("state" in node and "generation" in node
                                and node.get("seat_id")):
                return projection
    org = store.load_org(slug) if fresh else store.cached_org(slug)
    return {"node": org.nodes.get(nid),
            **{key: org.d.get(key) for key in sections}}
