"""The engine's start with the 3.2.0 storage switch on (piece A7a; design §2.12, §2.13, §5.2).

``start()`` runs once per engine process, after the data root is owned and the database is
up, and BEFORE the API loads, so nothing serves until it has returned. The packaged engine
calls it from its database bracket (``engine/pg_process.py``) in place of the legacy
migrations; the developer launch (``python -m orgtree.api``) right after
``store.claim_data_root()``. In order:

1. **The lifecycle.** It holds the admin conninfo it is given. The engine never keeps that in
   its own environment, so agent and tool processes never inherit it (Q10). The lifecycle is
   handed to the registry (``registry.use_lifecycle``); its bootstrap creates and migrates the
   app database, registers this engine instance and drops stray staging databases.
2. **The first pass**, while the cutover marker is unset: the converter in a child process
   (``python -m orgtree.orgdb.convert first-pass --progress``), with the admin conninfo in that
   child's environment only. Each org it starts is reported as a ``database-convert: <slug>``
   phase, the desktop's and the boot host's long readiness window.
3. **Claims a stopped engine left**: finished (create, trash, restore, purge) or released
   (retry, convert: back to unavailable, their staging database dropped).
4. **Org migrations**: every active org to this build's level; a failing one becomes
   unavailable and the others start (§2.12).
5. **Automatic Retry, once per build**: every unavailable org that a different build last
   attempted (§2.13).

A failure of 1 or 2 raises ``StartRefused``, and the caller refuses the start with its reason.
A failure in 3 to 5 is one org's: that org is left as the lifecycle left it and is named in
the report, and the others start. One exception: an automatic Retry whose attempt could not be
recorded refuses the start too (StartRefused 'retry'), since a completed start would let every
start of this build retry it again.

Nothing here, nor in the caller, migrates the legacy database (design §5.1, rev 4.1).

This module is imported before the store is configured, so it never imports the store (or
anything that does): the org folders and this build's identity are worked out here from the
same rules, and tests keep them equal to the store's.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Mapping

#: The phase prefix the desktop and the boot host give their long (900 s) readiness window.
CONVERT_PHASE = "database-convert"
#: The engine's per-boot desktop token: no child of the start needs it.
_TOKEN_ENV = "ORGTREE_V2_TOKEN"
_CONNINFO_ENV = "ORGTREE_PG_CONNINFO"

Progress = Callable[[str], None]


class StartRefused(RuntimeError):
    """The engine must not start. ``step`` is 'app' (the app database), 'conversion' (the first
    pass) or 'retry' (an automatic Retry's attempt could not be recorded); ``report_dir`` is
    where the first pass's report and log are, when it ran."""

    def __init__(self, step: str, reason: str, report_dir: str | None = None) -> None:
        super().__init__(reason)
        self.step = step
        self.reason = reason
        self.report_dir = report_dir


def this_build() -> str:
    """This engine's build identity, as ``workitems.build_identity()`` gives it ('<commit>' or
    '<commit>+dirty', '' when unknown), without importing the store."""
    from .. import build_identity as _bi   # noqa: PLC0415
    root = _bi.artifact_root_for(_bi.__file__)
    info = _bi.resolve_build_identity(root, packaged_info=root / "build-info.json")
    commit = str(info.get("commit") or "unknown")
    if commit == "unknown":
        return ""
    return commit + ("+dirty" if info.get("dirty") else "")


def org_folders(data_root: str, slug: str) -> tuple[tuple[str, str], ...]:
    """The folders that belong to one org (label, path), as ``store.org_folders`` names them."""
    return (("workspace", os.path.join(data_root, "workspaces", slug)),
            ("scratch", os.path.join(data_root, "scratch", slug)))


def converter_env(base: Mapping[str, str], runtime: str) -> dict[str, str]:
    """The environment of a converter child: ``base`` without the desktop token, with the
    runtime conninfo (aimed at the legacy database) the legacy loader reads. The admin
    conninfo is added by the lifecycle (``Lifecycle.child_env``) and by nothing else."""
    from .lifecycle import ADMIN_ENV   # noqa: PLC0415
    env = {k: v for k, v in base.items() if k not in (_TOKEN_ENV, ADMIN_ENV)}
    env[_CONNINFO_ENV] = runtime
    return env


def start(*, runtime: str, data_root: str, admin: str | None = None, lc: Any = None,
          env: Mapping[str, str] | None = None, build: str | None = None,
          progress: Progress | None = None) -> dict[str, Any]:
    """The engine's start with the switch on (see the module docstring). ``runtime`` is the
    runtime role's conninfo, aimed at the legacy database as the engine is given it. Either
    ``admin``, the admin role's conninfo, for a new lifecycle (the packaged engine's bracket),
    or ``lc``, one already bootstrapped (the developer launch: ``store.claim_data_root`` did
    it). ``env`` is the environment converter children start from (default: this process's).
    Returns the start report; raises StartRefused."""
    from . import conn as _conn          # noqa: PLC0415
    from . import lifecycle as L         # noqa: PLC0415
    from . import registry               # noqa: PLC0415
    step = progress or (lambda _phase: None)
    step("database-orgdb")
    boot: dict[str, Any] = {}
    if lc is None:
        if not admin:
            raise StartRefused("app", "no admin connection was given to the org lifecycle")
        # 'unknown' as the converter children record it (their --build), so an org a child
        # left unavailable counts as attempted by this build, not retried again at once
        build = (this_build() if build is None else build) or "unknown"
        try:
            lc = L.Lifecycle(admin=admin, runtime_role=_conn.role_of(runtime) or L.RUNTIME_ROLE,
                             build=build)
            boot = lc.bootstrap()
        except Exception as e:   # noqa: BLE001  no org runs without the app database (§2.12)
            raise StartRefused("app", f"the app database could not be prepared: "
                                      f"{type(e).__name__}: {e}") from e
    registry.use_lifecycle(lc)
    child_env = converter_env(dict(os.environ) if env is None else env, runtime)
    report: dict[str, Any] = {"build": lc.build, "app": {"applied": boot.get("applied", []),
                                                        "swept": boot.get("swept", [])}}
    report["first_pass"] = first_pass(lc, data_root, child_env, step)
    step("database-orgdb-resume")
    report["resumed"] = resume_claims(lc, data_root)
    step("database-orgdb-migrate")
    report["migrations"] = lc.migrate_orgs()
    report["retried"] = retry_new_build(lc, data_root, child_env, step)
    # The host owns the data-root lock and the guardian has stopped the
    # previous engine tree before this lifecycle was bootstrapped. Org
    # migrations must finish before its durable request bridge can start.
    from . import turn_runtime   # noqa: PLC0415
    turn_runtime.start(runtime=runtime, instance_id=lc.instance_id,
                       data_root=data_root, env=child_env, prefix=lc.prefix)
    _register_turn_shutdown()
    return report


_turn_shutdown_registered = False


def _register_turn_shutdown() -> None:
    global _turn_shutdown_registered
    if not _turn_shutdown_registered:
        import atexit   # noqa: PLC0415
        atexit.register(stop)
        _turn_shutdown_registered = True


def stop() -> None:
    """Stop this host's heartbeat and listener without freeing active turns."""
    from . import turn_runtime   # noqa: PLC0415
    turn_runtime.stop()


def cutover_at(lc: Any) -> Any:
    """When the converter's first pass finished (``app_settings.legacy_cutover_at``), or None."""
    with lc._app() as c:                                            # noqa: SLF001
        row = c.execute("SELECT legacy_cutover_at FROM orgtree.app_settings").fetchone()
    return None if row is None else row[0]


def first_pass(lc: Any, data_root: str, env: Mapping[str, str], step: Progress) -> dict[str, Any]:
    """The converter's one first pass, in a child process, while the marker is unset."""
    done = cutover_at(lc)
    if done is not None:
        return {"ran": False, "finished_at": done.isoformat()}
    from .convert.run import PROGRESS_PREFIX   # noqa: PLC0415
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_dir = Path(data_root) / "conversion" / f"{stamp}-{os.getpid()}"
    report_dir.mkdir(parents=True, exist_ok=True)
    log = report_dir / "converter.log"
    backend = Path(__file__).resolve().parents[2]
    # this engine's own backend first, whatever the interpreter's path file lists
    code = ("import sys; sys.path.insert(0, sys.argv[1]); "
            "from orgtree.orgdb.convert.__main__ import main; sys.exit(main(sys.argv[2:]))")
    step(f"{CONVERT_PHASE}: new storage")
    last = ""
    with open(log, "w", encoding="utf-8", errors="replace") as err, subprocess.Popen(
            [sys.executable, "-c", code, str(backend), "first-pass", "--progress",
             "--data-root", str(data_root), "--report-dir", str(report_dir),
             "--build", lc.build],
            env=lc.child_env(dict(env)), cwd=str(backend), stdout=subprocess.PIPE, stderr=err,
            text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as child:
        assert child.stdout is not None
        for line in child.stdout:
            line = line.rstrip("\r\n")
            if line.startswith(PROGRESS_PREFIX):
                step(f"{CONVERT_PHASE}: {line[len(PROGRESS_PREFIX):]}"[:100])
            elif line.strip():
                last = line
        code_ = child.wait()
    if code_ != 0:
        lines = [ln.strip() for ln in log.read_text(encoding="utf-8", errors="replace").splitlines()
                 if ln.strip()]
        why = lines[-1][:500] if lines else f"the converter exited {code_}"
        raise StartRefused("conversion", why, str(report_dir))
    try:
        run = json.loads(last)
    except ValueError:
        run = {}
    orgs = run.get("orgs") if isinstance(run, dict) else None
    return {"ran": True, "report_dir": str(report_dir),
            "orgs": [{k: o.get(k) for k in ("slug", "org_id", "outcome", "reason")}
                     for o in orgs or [] if isinstance(o, dict)]}


def resume_claims(lc: Any, data_root: str) -> list[dict[str, Any]]:
    """Every claim a stopped engine left becomes this instance's (``take_over``) and is finished
    or released. One org's failure is reported and does not stop the others."""
    out: list[dict[str, Any]] = []
    trash_dir = os.path.join(data_root, "deleted")
    for claim in lc.take_over():
        row = lc.row(claim.org_id)
        entry: dict[str, Any] = {"org_id": claim.org_id, "slug": row["slug"], "kind": claim.kind,
                                 "step": row["op_step"]}
        try:
            if claim.kind == "create":
                entry["outcome"] = lc.finish_create(claim)
            elif claim.kind in ("trash", "restore", "purge"):
                lc.resume_lifecycle(claim, folders=org_folders(data_root, str(row["slug"])),
                                    trash_dir=trash_dir)
                entry["outcome"] = ("purged" if claim.kind == "purge"
                                    else str(lc.row(claim.org_id)["state"]))
            elif claim.kind in ("retry", "convert"):
                # a Retry the engine stopped in (a first pass's own claims are the first pass's)
                lc.abandon(claim, step=str(row["unavailable_step"] or "conversion"),
                           reason="interrupted when Orgtree stopped; Retry runs it again")
                entry["outcome"] = "unavailable"
            else:
                entry["outcome"] = "left claimed: nothing in this build finishes it"
        except Exception as e:   # noqa: BLE001  one org's failure is that org's
            entry["outcome"] = "failed"
            entry["error"] = f"{type(e).__name__}: {e}"[:500]
        out.append(entry)
    return out


def retry_new_build(lc: Any, data_root: str, env: Mapping[str, str],
                    step: Progress) -> list[dict[str, Any]]:
    """Retry, once, every unavailable org that a different build last attempted (§2.13): the
    new build may contain the fix. Each attempt records this build, so the next start of the
    same build does not retry it again. An attempt that could not be recorded refuses the
    start (review f3): completing it would let every start of this build retry again."""
    from . import lifecycle as L   # noqa: PLC0415
    from . import registry         # noqa: PLC0415
    out: list[dict[str, Any]] = []
    for row in lc.rows():
        if row["state"] != "unavailable" or row["op_kind"] is not None:
            continue
        if (row["attempted_build"] or "") == lc.build:
            continue
        step(f"{CONVERT_PHASE}: retry {row['slug']}"[:100])
        entry: dict[str, Any] = {"org_id": int(row["org_id"]), "slug": row["slug"],
                                 "step": row["unavailable_step"]}
        try:
            got = registry.retry(int(row["org_id"]), data_root=data_root, env=dict(env))
            entry.update(outcome=got["outcome"], reason=got["reason"])
        except L.AttemptNotRecorded as e:
            cause = e.__cause__
            raise StartRefused("retry", f"{e}: {type(cause).__name__}: {cause}") from e
        except Exception as e:   # noqa: BLE001  one org's failure is that org's
            entry.update(outcome="failed", error=f"{type(e).__name__}: {e}"[:500])
        out.append(entry)
    return out
