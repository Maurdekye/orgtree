"""Child for the real-launch startup-budget test. Explicit temporary data only."""
import os
from pathlib import Path
import sys
import time

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO), str(REPO / "engine"), str(REPO / "engine/backend")]
root = Path(os.environ["ORGTREE_DATA"]).resolve(strict=True)
assert (root / "synthetic-startup-root").is_file(), "refuse anything but our fixture"
assert os.environ["HOME"] == str(root.parent / "home")

if sys.argv[1] == "seed":
    from orgtree import store
    from tests.startup_fixture import seed
    seed(root)
    store._POOL.close_all("startup-budget")
    raise SystemExit(0)

import launch
original = launch.load_app


def load():
    result = original()
    from orgtree import api, startup, store, supervisor, warmpool, net, transcript_ingest
    from orgtree.fleet_walk import fleet_walk_budget
    assert Path(store.DATA_ROOT).resolve() == root
    # Keep real ASGI startup, HTTP, guardian and persistence. Explicitly disable
    # provider discovery/spawning and outside transports in this fixture.
    for name in dir(supervisor):
        if name.startswith("start_"):
            setattr(supervisor, name, lambda: None)
    supervisor.send_message = lambda *a, **kw: (_ for _ in ()).throw(AssertionError("fixture must not dispatch a turn"))
    warmpool.start_warm_pool = lambda: None
    net.start_net_client = lambda: None
    transcript_ingest.start = lambda: None
    api.restart_wake.on_backend_startup = lambda: None
    supervisor._transcript_root = lambda *a: str(root.parent / "home/.claude")
    reconcile = supervisor.reconcile
    def held(*args, **kw):
        (root / "repair-entered").write_text("entered")
        until = time.monotonic() + 40
        while not (root / "release-repair").exists():
            if time.monotonic() >= until:
                raise RuntimeError("test did not release repair")
            time.sleep(0.02)
        with fleet_walk_budget("imports-inventory", 1) as budget:
            marked = reconcile(*args, **kw)
        assert budget.calls == 1 and marked == []
        (root / "repair-completed").write_text(str(budget.calls))
        return marked
    supervisor.reconcile = held
    if sys.argv[1] == "synchronous-control":
        # The former lifespan ordering, with identical real fixture/repair.
        startup.recovery.start = lambda repair: repair()
    return result


launch.load_app = load
launch.main()
