"""Restore a trashed org, with 3.2.0's storage (one database per org; umbrella decision 27).

3.1.0's delete moved an org's file into <data>/deleted/, and its restore was by hand: move the file
back into orgs/ and restart. 3.2.0's delete renames the org's database into the trash and moves its
folders to <data>/deleted/<slug>-<stamp>-<org_id>/, so there is no file to move back. This tool is
that manual restore for 3.2.0. It calls the org lifecycle's restore (store.restore_trashed_org):
the database is renamed back, its identity is checked, it is migrated to this build's level, its
folders move back, and the org is active under its own name again. It works for an org deleted
after the upgrade and for one 3.1.0 had trashed (the upgrade converted it as trashed; its folders
never moved). An org whose name another org has now is refused: delete that org first. No route or
desktop control calls this.

Stop Orgtree first: the tool holds the data root's owner lock, as `pgimport import` does, so it
refuses while Orgtree runs, and Orgtree cannot start while it works.

    python tools/restore-org.py --root <data root> --custodian <pg-custodian> --list
    python tools/restore-org.py --root <data root> --custodian <pg-custodian> <slug> [--org-id N]

The root's database is brought up through pg-custodian, as Orgtree's launch does, and stopped again
afterwards unless it was already running. On a developer cluster, set ORGTREE_PG_ADMIN_CONNINFO
(the admin role) and ORGTREE_PG_CONNINFO (the runtime role) instead of giving --custodian.

Exit 0: restored (active) or listed. 1: refused, nothing changed (the reason on stderr). 3: restored
but unavailable (its identity or its migration failed; the reason on stderr): start Orgtree and
use Retry on it. 2: usage.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any, Iterator

_REPO = Path(__file__).resolve().parents[1]
#: orgdb.lifecycle.ADMIN_ENV and engine/pg_process.CONNINFO_ENV
ADMIN_ENV = "ORGTREE_PG_ADMIN_CONNINFO"
RUNTIME_ENV = "ORGTREE_PG_CONNINFO"
#: how pg-custodian serves a root (tools/pypg/pgimport.py root_mode)
PROTOTYPE_MARKER = "orgtree-p03-prototype-root.json"
PRODUCT_BINDING = "orgtree-product-root.json"


class Refused(Exception):
    """Nothing was changed; the reason is the message."""


@contextlib.contextmanager
def engine_stopped(root: Path, store: Any) -> Iterator[None]:
    """Hold the data root's owner lock (``store.owner_file``, the byte the engine's
    ``claim_data_root`` takes), as tools/pypg/pgimport.py's engine_stopped does."""
    fd = os.open(store.owner_file(str(root)), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        if not store._try_lock(fd):                                     # noqa: SLF001
            raise Refused(f"{root} is in use (its owner lock is held): stop Orgtree first")
        try:
            yield
        finally:
            os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt  # noqa: PLC0415
                with contextlib.suppress(OSError):
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


@contextlib.contextmanager
def connections(root: Path, custodian: Path | None) -> Iterator[tuple[str, str]]:
    """(admin, runtime) conninfo of the root's database: from the environment (a developer
    cluster), else brought up through pg-custodian as Orgtree's launch brings it up (and
    stopped again afterwards unless it was already running)."""
    admin = os.environ.get(ADMIN_ENV, "").strip()
    runtime = os.environ.get(RUNTIME_ENV, "").strip()
    if admin and runtime:
        yield admin, runtime
        return
    if custodian is None:
        raise Refused(f"give --custodian, or set {ADMIN_ENV} and {RUNTIME_ENV}")
    if not custodian.is_absolute() or not custodian.is_file():
        raise Refused(f"--custodian {custodian} is not an existing absolute file")
    if (root / PROTOTYPE_MARKER).is_file():
        product = False
    elif (root / PRODUCT_BINDING).is_file():
        product = True
    else:
        raise Refused(f"{root} has neither a prototype marker nor the product binding: "
                      "pg-custodian does not serve it")
    if str(_REPO) not in sys.path:
        sys.path.insert(0, str(_REPO))
    from engine import pg_process as pp  # noqa: PLC0415
    workdir = Path(tempfile.mkdtemp(prefix="orgtree-restore-org-"))
    child = {k: v for k, v in os.environ.items() if k not in ("ORGTREE_V2_TOKEN", pp.CONNINFO_ENV)}
    up = pp.database_up(custodian, root, child, workdir, product)
    try:
        info = up["runtime"]
        if not info.get("admin_role"):
            raise Refused("pg-custodian attach gave no admin_role")
        yield (pp.conninfo(info, str(info["admin_role"]), "orgtree-restore-org"),
               pp.conninfo(info, pp.RUNTIME_ROLE, "orgtree-restore-org"))
    finally:
        if up.get("action") != "attached":
            pp.database_down(custodian, root, child, workdir, product)
        shutil.rmtree(workdir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="restore-org.py",
                                description="Restore a trashed org (3.2.0's storage).")
    p.add_argument("slug", nargs="?", help="the trashed org's name (its slug)")
    p.add_argument("--root", type=Path, required=True,
                   help="the data root of the Orgtree to restore into (its ORGTREE_DATA)")
    p.add_argument("--custodian", type=Path, help="pg-custodian, as Orgtree's launch uses it")
    p.add_argument("--org-id", type=int, help="which one, when several trashed orgs had the name")
    p.add_argument("--list", action="store_true", help="list the trashed orgs and exit")
    a = p.parse_args(argv)
    if a.list == bool(a.slug):
        p.error("give the trashed org's slug, or --list")
    root = a.root.resolve()
    if not root.is_dir():
        print(f"restore-org: REFUSED: {root} is not a folder", file=sys.stderr)
        return 1
    # the store binds its data root when it is imported
    os.environ["ORGTREE_DATA"] = str(root)
    os.environ["ORGTREE_STORAGE"] = "orgdb"
    os.environ["ORGTREE_STORE"] = "postgres"
    if str(_REPO / "engine" / "backend") not in sys.path:
        sys.path.insert(0, str(_REPO / "engine" / "backend"))
    from orgtree import orgtx, store, workitems  # noqa: PLC0415
    from orgtree.ledger import LedgerError  # noqa: PLC0415
    from orgtree.orgdb import conn as _conn  # noqa: PLC0415
    from orgtree.orgdb import lifecycle as L  # noqa: PLC0415
    from orgtree.orgdb import registry  # noqa: PLC0415
    try:
        with engine_stopped(root, store), connections(root, a.custodian) as (admin, runtime):
            os.environ[RUNTIME_ENV] = runtime        # the registry reads the runtime role here
            lc = L.Lifecycle(admin=admin, runtime_role=_conn.role_of(runtime) or L.RUNTIME_ROLE,
                             build=workitems.build_identity() or "unknown")
            lc.bootstrap()
            registry.use_lifecycle(lc)
            try:
                if a.list:
                    print(json.dumps({"trashed": store.trashed_orgs()}, indent=1))
                    return 0
                out = store.restore_trashed_org(a.slug, a.org_id)
            finally:
                registry.close_idle()
                registry.close_registry()
    except (Refused, LedgerError, orgtx.LockTimeout) as e:
        print(f"restore-org: REFUSED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, default=str))
    if out["state"] != "active":
        print(f"restore-org: {a.slug!r} is back from the trash but {out['state']}: {out['reason']}. "
              "Start Orgtree and use Retry on it.", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
