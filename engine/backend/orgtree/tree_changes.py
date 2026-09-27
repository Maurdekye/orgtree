"""Small retained change journal, published atomically with store.org_seq.

It does not consume the shared snapshot's accumulators. Missing evidence is
unknown, never an empty change. No documents or mutable SaveChanges survive.
"""
from collections import OrderedDict
import threading

MAX_ORGS = 8
MAX_HISTORY = 128
_lock = threading.Lock()
_pending = {}
_history = OrderedDict()


def publish(root, slug, changes):
    key = (str(root), slug)
    with _lock:
        if key not in _history:
            _history[key] = OrderedDict()
        _history.move_to_end(key)
        while len(_history) > MAX_ORGS:
            old, _ = _history.popitem(last=False)
            _pending.pop(old, None)
        try:
            value = None if changes is None else (
                frozenset(changes.changed_keys()),
                frozenset(changes.node_updates),
                bool(changes.node_inserts or changes.node_deletes))
            if key in _pending:
                prior = _pending[key]
                value = None if prior is None or value is None else (
                    prior[0] | value[0], prior[1] | value[1], prior[2] or value[2])
            _pending[key] = value
        except BaseException:
            _pending[key] = None
            raise


def commit(root, slug, seq):
    # Called under store's seq lock, after the commit and before readers can
    # observe its new sequence. A bump without publish creates an unknown row.
    key = (str(root), slug)
    with _lock:
        history = _history.get(key)
        pending = _pending.pop(key, None)
        if history is not None:
            history[seq] = pending
            while len(history) > MAX_HISTORY:
                history.popitem(last=False)


def forget(root, slug):
    with _lock:
        key = (str(root), slug)
        _history.pop(key, None)
        _pending.pop(key, None)


def since(root, slug, after, through):
    if through < after or through - after > MAX_HISTORY:
        return None
    keys, nodes, structural = set(), set(), False
    with _lock:
        history = _history.get((str(root), slug), {})
        for seq in range(after + 1, through + 1):
            value = history.get(seq)
            if value is None:
                return None
            keys.update(value[0])
            nodes.update(value[1])
            structural |= value[2]
    return keys, nodes, structural
