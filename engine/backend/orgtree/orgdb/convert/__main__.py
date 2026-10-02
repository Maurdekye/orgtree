"""The converter's child process (design §5.2): ``python -m orgtree.orgdb.convert``.

    first-pass --data-root <real data root> --report-dir <folder> --build <id>
    retry --org-id <n> --data-root ... --report-dir ... --build ...

Environment (set by the engine host's database bracket):
  ORGTREE_PG_CONNINFO        the runtime role, aimed at the LEGACY database (the loader reads
                             it; the new databases are reached by changing only the name)
  ORGTREE_PG_ADMIN_CONNINFO  the admin role, for the org lifecycle module only (Q10)
  ORGTREE_ORGDB_PREFIX       optional: tests' and rehearsals' database-name prefix

The legacy loader is pointed at a throwaway data root holding only markers, and the storage
switch is cleared for this process, so the loader reads exactly as today's engine does. The
run's report is written to <report-dir>/run.json and printed. Exit status 0 means the run
finished (an org that failed is unavailable, which is a finished run); anything else means the
run itself could not proceed, and the host refuses to start with that reason.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m orgtree.orgdb.convert")
    p.add_argument("mode", choices=("first-pass", "retry"))
    p.add_argument("--data-root", required=True)
    p.add_argument("--report-dir", required=True)
    p.add_argument("--build", required=True)
    p.add_argument("--org-id", type=int)
    p.add_argument("--work-root")
    a = p.parse_args(argv)
    if a.mode == "retry" and a.org_id is None:
        p.error("retry needs --org-id")
    work = a.work_root or tempfile.mkdtemp(prefix="orgdb-convert-")
    own_work = a.work_root is None
    # the legacy loader must read exactly as today's engine: today's store, a root of markers
    os.environ["ORGTREE_DATA"] = os.path.join(work, "data")
    os.environ["ORGTREE_STORE"] = "postgres"
    os.environ.pop("ORGTREE_STORAGE", None)
    Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True, exist_ok=True)
    try:
        from ..lifecycle import Lifecycle            # noqa: PLC0415  after the environment
        from .. import conn                          # noqa: PLC0415
        from . import run                            # noqa: PLC0415
        base = conn.runtime_base()
        cfg = run.Config(data_root=a.data_root, work_root=os.environ["ORGTREE_DATA"],
                         report_dir=a.report_dir, build=a.build, legacy_base=base,
                         runtime_base=base, side=_side_inputs(a.data_root))
        lc = Lifecycle(runtime_role=conn.role_of(base), build=a.build)
        lc.bootstrap()
        report = run.first_pass(lc, cfg) if a.mode == "first-pass" else run.retry(lc, cfg, a.org_id)
        Path(a.report_dir).mkdir(parents=True, exist_ok=True)
        (Path(a.report_dir) / "run.json").write_text(
            json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, default=str))
        return 0
    finally:
        if own_work:
            shutil.rmtree(work, ignore_errors=True)


def _side_inputs(data_root: str):
    """The side files' and the accounts registry's inputs (convert.sidefiles), or None when
    that module is not there yet."""
    try:
        from . import sidefiles                     # noqa: PLC0415
    except ImportError:
        return None
    return sidefiles.side_inputs(data_root)


if __name__ == "__main__":
    sys.exit(main())
