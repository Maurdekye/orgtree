"""One full-source inventory scan per suite run for the state boundary modules.

Importing this module (after ``import state_operation_contracts as contracts``)
replaces ``contracts.inventory.scan`` with a cached equivalent. The ~24
test_state_* boundary modules each scanned the whole engine source (~3.5 s)
once or twice, always of the same checkout within one run.

Entries are keyed by the checkout root AND a hash of every file the scan reads
(and of the scanner), so a stale entry cannot be reused even when two worktrees
share a run root or the tree changes between modules. The first scan of a
given source in a run is real; its result is kept in this
process and, under tools/run-python-verification.py, pickled into the run
root (the parent of each module's ORGTREE_DATA) for the modules that follow.
The runner deletes the run root when the run ends, so every suite run still
scans the tree it is testing exactly once, and nothing outlives the run.
Every caller gets its own deep copy, so no test can see another's edits. The interpreter
is not part of the key: one runner call uses one interpreter for every module, and
the run root does not outlive the call. A
module run on its own, or outside the runner, scans for itself.

Not used by test_state_operation_inventory or test_state_operation_contracts:
those test the scanner and its CLI, and must keep calling the real one.
"""
from __future__ import annotations

import copy
import hashlib
import os
import pickle
import uuid
from pathlib import Path

import state_operation_contracts as _contracts

_real_scan = _contracts.inventory.scan
_memo: dict[str, dict] = {}


# Read ONCE, at import: every test module then points ORGTREE_DATA at its own temp
# folder (some clear ORGTREE_* entirely), so the runner's value is only visible now.
# Each module imports this before it rewrites its environment.
_RUN_ROOT = (Path(os.environ["ORGTREE_DATA"]).parent
             if os.environ.get("ORGTREE_VERIFY_MODULE") and os.environ.get("ORGTREE_DATA") else None)


def _shared(key: str) -> Path | None:
    return None if _RUN_ROOT is None else _RUN_ROOT / f"inventory-scan-{key}.pickle"


def _fingerprint(repo: Path) -> str:
    """Checkout root + the bytes of every file the scan reads + the scanner itself,
    so an entry can only ever be reused for exactly the source it was made from."""
    h = hashlib.sha256(str(Path(repo).resolve()).encode("utf-8") + b"\0")
    for path in [Path(_contracts.inventory.__file__), *_contracts.inventory.module_paths(Path(repo))]:
        h.update(str(path).encode("utf-8") + b"\0")
        h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()[:32]


def scan(repo: Path) -> dict:
    key = _fingerprint(repo)
    if key not in _memo:
        shared = _shared(key)
        result = None
        if shared is not None and shared.exists():
            try:
                result = pickle.loads(shared.read_bytes())
            except Exception:  # noqa: BLE001 -- a partial entry is never a verdict: scan here
                result = None
        if result is None:
            result = _real_scan(repo)
            if shared is not None:
                staged = shared.with_name(f".{shared.name}.{uuid.uuid4().hex}")
                staged.write_bytes(pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL))
                try:
                    os.replace(staged, shared)
                except OSError:
                    staged.unlink(missing_ok=True)
        _memo[key] = result
    return copy.deepcopy(_memo[key])


_contracts.inventory.scan = scan
