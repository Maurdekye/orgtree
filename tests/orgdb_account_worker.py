"""A5 physical concurrency control: a separate process and separate locks."""
from pathlib import Path
import sys
repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
from assert_repo_import import assert_repo_import
assert_repo_import(repo)

import time
from orgtree import registry

account_id, barrier = sys.argv[1:]
deadline = time.monotonic() + 20
while not Path(barrier).exists():
    if time.monotonic() > deadline:
        raise RuntimeError('concurrency barrier timed out')
    time.sleep(0.01)
for _ in range(10):
    registry.add_spend(account_id, 0.25)
for _ in range(3):
    registry.create_account('claude', '', {'kind': 'managed', 'path': 'concurrent-profile'},
                            registered_from='concurrent-a5')
