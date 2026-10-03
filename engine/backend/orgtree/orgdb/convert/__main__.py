"""The converter's child process (design §5.2): ``python -m orgtree.orgdb.convert``.

    first-pass --data-root <real data root> --report-dir <folder> --build <id> [--progress]
    retry --org-id <n> --data-root ... --report-dir ... --build ...

``--progress`` prints ``run.PROGRESS_PREFIX`` and the org's name as each org's conversion
starts (the engine's start reads them as startup phases).

Environment (set by the engine host's database bracket):
  ORGTREE_PG_CONNINFO        the runtime role, aimed at the LEGACY database (the loader reads
                             it; the new databases are reached by changing only the name)
  lifecycle.ADMIN_ENV        the admin role, read by the org lifecycle module only (Q10)
  ORGTREE_ORGDB_PREFIX       optional: tests' and rehearsals' database-name prefix

The legacy loader is pointed at a throwaway data root holding only markers, and the storage
switch is cleared for this process, so the loader reads exactly as today's engine does. The
run's report is written to <report-dir>/run.json and printed. Exit status 0 means the run
finished (an org that failed is unavailable, which is a finished run); anything else means the
run itself could not proceed, and the host refuses to start with that reason. A retry also
exits ``registry.EXIT_BUSY`` when another operation holds the org (nothing ran) and
``registry.EXIT_NOT_RETRYABLE`` when the org is not unavailable at 'conversion' or 'import'.
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
    p.add_argument("--progress", action="store_true")
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
        from ..lifecycle import Busy, Lifecycle, LifecycleError, LostClaim   # noqa: PLC0415
        from .. import conn                          # noqa: PLC0415
        from ..registry import EXIT_BUSY, EXIT_NOT_RETRYABLE   # noqa: PLC0415
        from . import run                            # noqa: PLC0415
        base = conn.runtime_base()
        cfg = run.Config(data_root=a.data_root, work_root=os.environ["ORGTREE_DATA"],
                         report_dir=a.report_dir, build=a.build, legacy_base=base,
                         runtime_base=base, side=_side_inputs(a.data_root))
        lc = Lifecycle(runtime_role=conn.role_of(base), build=a.build)
        lc.bootstrap()
        if a.mode == "first-pass":
            report = run.first_pass(
                lc, cfg, progress=(lambda slug: print(run.PROGRESS_PREFIX + slug, flush=True))
                if a.progress else None)
        else:
            try:
                report = run.retry(lc, cfg, a.org_id)
            except Busy as e:
                print(f"BUSY: {e}", file=sys.stderr)
                return EXIT_BUSY
            except LostClaim:
                raise
            except (ValueError, LifecycleError) as e:
                print(f"NOT RETRYABLE: {e}", file=sys.stderr)
                return EXIT_NOT_RETRYABLE
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
    build = getattr(sidefiles, "side_inputs", None)
    return build(data_root) if build is not None else None


if __name__ == "__main__":
    sys.exit(main())
