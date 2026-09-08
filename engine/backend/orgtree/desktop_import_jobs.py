"""Durable operator import jobs. Status never takes the organization DOC_LOCK.

A destination lease spans the worker lifetime, including recovery. OS release
on process exit lets a later reader mark an unfinished job interrupted without
ever replaying it. Phase/mutation receipts are synchronous; bulk progress is
checkpointed at most once per second, not once per copied file.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import uuid

from . import desktop_import as imp

_guard = threading.RLock()
_live: dict[tuple[str, str], dict] = {}
ACTIVE = {"queued", "planning", "running", "cancelling"}
CANCELLABLE_PHASES = {"queued", "planning", "counting", "reading", "copying", "native", "validating"}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _root():
    root = Path(imp._store().DATA_ROOT).resolve() / "import-jobs"
    imp._plain(root)
    root.mkdir(exist_ok=True)
    return root


def _read(path):
    imp._plain(path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def _write(path, value):
    imp._plain(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _lease(root):
    path = root / "active.lock"
    imp._plain(path)
    stream = path.open("a+b")
    if path.stat().st_size == 0:
        stream.write(b"0")
        stream.flush()
    stream.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close()
        return None
    return stream


def _release(stream):
    if stream is None:
        return
    stream.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    stream.close()


def _public(job):
    out = copy.deepcopy({key: value for key, value in job.items() if not key.startswith("_")})
    out["cancellable"] = bool(job.get("state") in ACTIVE and job.get("phase") in CANCELLABLE_PHASES
                               and not job.get("cancel_requested"))
    return out


def _cancel_path(root, identifier):
    return root / (identifier + ".cancel")


def _cancel_marked(root, identifier):
    return _cancel_path(root, identifier).exists()


def cancel(identifier):
    with _guard:
        root = _root()
        identifier = str(uuid.UUID(identifier))
        job = _read(root / (identifier + ".json"))
        live = _live.get((str(root), identifier))
        if live is not None:
            job = live
        if job is None:
            raise imp.ImportRefused("Import request ID is not recorded", 404)
        if job["state"] not in ACTIVE and job["state"] != "cancelling":
            return _public(job)
        if job.get("phase") not in CANCELLABLE_PHASES:
            raise imp.ImportRefused("Import cannot be cancelled after publication or recovery began", 409)
        # The worker owns the destination lease. A separate durable marker is
        # the cancellation request; the worker consumes it at safe checkpoints.
        _write(_cancel_path(root, identifier), {"requested_at": _now()})
        job["cancel_requested"] = True
        job["state"] = "cancelling"
        job["updated_at"] = _now()
        if live is None:
            _write(root / (identifier + ".json"), job)
        return _public(job)


def _interrupt(root, job):
    if job["state"] in ACTIVE:
        job["state"] = "interrupted"
        job["updated_at"] = _now()
        job["error"] = ("Import engine stopped before a terminal result was recorded. "
                        "Publication or recovery may be incomplete or uncertain; inspect retained "
                        "receipts and imported organizations before any new import. Nothing was replayed.")
        if not job.get("publications"):
            job["error"] = ("Import engine stopped during preparation. No publication was recorded. "
                            "Staging is retained; nothing was replayed.")
        _write(root / (job["id"] + ".json"), job)
    return job


def _get(root, identifier):
    identifier = str(uuid.UUID(identifier))
    key = (str(root), identifier)
    if key in _live:
        return _live[key]
    job = _read(root / (identifier + ".json"))
    if job is None:
        raise imp.ImportRefused("Import request ID is not recorded", 404)
    if job["state"] in ACTIVE:
        lease = _lease(root)
        if lease is not None:
            try:
                # Completion can race the first read. Only the fresh record
                # read while owning the destination lease may be interrupted.
                job = _read(root / (identifier + ".json"))
                if job is None:
                    raise imp.ImportRefused("Import request ID is not recorded", 404)
                job = _interrupt(root, job)
            finally:
                _release(lease)
    return job


def get(identifier):
    with _guard:
        return _public(_get(_root(), identifier))


def current():
    with _guard:
        root = _root()
        pointer = _read(root / "current.json")
        if not pointer:
            return None
        try:
            return _public(_get(root, pointer["id"]))
        except imp.ImportRefused as exc:
            if exc.status == 404:
                return None
            raise


@contextmanager
def maintenance_slot():
    """Reserve job admission while native maintenance takes its own hold."""
    with _guard:
        lease = _lease(_root())
        try:
            yield lease is not None
        finally:
            _release(lease)


def active():
    with maintenance_slot() as available:
        return not available


def start(body, callback):
    payload = body.model_dump(mode="json", exclude={"request_id"})
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    identifier = str(body.request_id)
    # Validate cheap request rules before reserving; source reads/copies belong
    # exclusively to the worker, never the finite HTTP start request.
    if payload["acknowledge_duplicate_work"] is not True:
        raise imp.ImportRefused("Acknowledge possible duplicate work before importing")
    if len(set(payload["organizations"])) != len(payload["organizations"]):
        raise imp.ImportRefused("Choose unique organizations")
    for slug in payload["organizations"]:
        imp._slug(slug)
    with _guard:
        root = _root()
        previous = _read(root / (identifier + ".json"))
        if previous:
            if previous["_fingerprint"] != fingerprint:
                raise imp.ImportRefused("Import request ID already has a different payload", 409)
            return _public(_get(root, identifier))
        lease = _lease(root)
        if lease is None:
            raise imp.ImportRefused("An import is already running for this destination. Check its status.", 409)
        try:
            from . import desktop_maintenance, supervisor
            if (not supervisor._deploy_done.is_set()
                    or (desktop_maintenance.status() or {}).get("state") == "acknowledged"):
                raise imp.ImportRefused("Native maintenance has reserved engine shutdown. Import was not started.", 409)
            # Another process may have completed this ID between our first
            # lookup and lease acquisition. Recheck under the destination lease.
            previous = _read(root / (identifier + ".json"))
            if previous:
                if previous["_fingerprint"] != fingerprint:
                    raise imp.ImportRefused("Import request ID already has a different payload", 409)
                return _public(_interrupt(root, previous))
            pointer = _read(root / "current.json")
            if pointer:
                old = _read(root / (pointer["id"] + ".json"))
                if old and old["state"] in ACTIVE:
                    _interrupt(root, old)
                    raise imp.ImportRefused("Previous import was interrupted. Check its status before starting another.", 409)
            now = _now()
            job = {"id": identifier, "state": "queued", "phase": "queued",
                   "source_root": payload["source_root"], "organizations": payload["organizations"],
                   "current_org": None, "files_copied": 0, "bytes_copied": 0,
                   "started_at": now, "updated_at": now, "result": None, "error": None,
                   "publications": [], "cancel_requested": False,
                   "total_files": None, "total_bytes": None,
                   "progress_percent": None, "eta_seconds": None,
                   "_fingerprint": fingerprint}
            _write(root / (identifier + ".json"), job)
            _write(root / "current.json", {"id": identifier})
            _live[(str(root), identifier)] = job
            thread = threading.Thread(target=_run, args=(root, job, payload, callback, lease),
                                      name="desktop-import-" + identifier, daemon=True)
            thread.start()
            lease = None  # worker now owns it
            return _public(job)
        except BaseException:
            _live.pop((str(root), identifier), None)
            raise
        finally:
            _release(lease)


def _run(root, job, payload, callback, lease):
    path = root / (job["id"] + ".json")
    last_checkpoint = 0.0
    copy_started = None

    def cancelled():
        return (bool(job.get("cancel_requested")) or _cancel_marked(root, job["id"]
                )) and job.get("phase") in CANCELLABLE_PHASES

    def progress(event):
        nonlocal last_checkpoint, copy_started
        with _guard:
            job["updated_at"] = _now()
            is_copy = event.get("progress_scope", "copy") == "copy"
            if "file_bytes" in event and is_copy:
                if copy_started is None:
                    copy_started = time.monotonic()
                job["files_copied"] += 1
                job["bytes_copied"] += event["file_bytes"]
            if "planned_files" in event:
                job["_planning_files"] = event["planned_files"]
                job["_planning_bytes"] = event.get("planned_bytes", job.get("_planning_bytes", 0))
            total = job.get("total_bytes")
            total_files = job.get("total_files")
            if total_files is not None and total is not None and is_copy:
                file_ratio = job["files_copied"] / total_files if total_files else 1.0
                byte_ratio = job["bytes_copied"] / total if total else file_ratio
                work = min(1.0, (file_ratio + byte_ratio) / 2)
                job["progress_percent"] = min(99, int(work * 100))
                elapsed = time.monotonic() - copy_started if copy_started is not None else 0
                rate = work / elapsed if elapsed > 0 else 0
                job["eta_seconds"] = int(max(0, (1 - work) / rate)) if rate else None
            if event.get("phase") in {"native", "validating", "publishing", "recovering", "finished"}:
                job["eta_seconds"] = None
            for key in ("phase", "current_org"):
                if key in event:
                    job[key] = event[key]
            if "publication_intent" in event:
                job["publications"].append({"slug": event["publication_intent"], "state": "publishing", "recovery": "not_started"})
            if "published" in event:
                row = event["published"]
                job["publications"][-1]["state"] = "published"
                if job["result"] is None:
                    job["result"] = {"imported": [], "failed": [], "warnings": [imp.DUPLICATE_WARNING, imp.CONTINUITY_WARNING]}
                job["result"]["imported"].append(copy.deepcopy(row))
            if "recovery_intent" in event:
                for receipt in job["publications"]:
                    if receipt["slug"] == event["recovery_intent"]:
                        receipt["recovery"] = "dispatching"
            if "recovered" in event:
                row = event["recovered"]
                for receipt in job["publications"]:
                    if receipt["slug"] == row["slug"]:
                        receipt["recovery"] = "returned"
                job["result"]["imported"] = [copy.deepcopy(row) if item["slug"] == row["slug"] else item
                                               for item in job["result"]["imported"]]
            bulk_copy = set(event) <= {"file_bytes", "progress_scope"} and is_copy
            if not bulk_copy or time.monotonic() - last_checkpoint >= 1:
                _write(path, job)
                last_checkpoint = time.monotonic()

    def publication_gate(slug):
        # The cancellation marker and publication intent are committed under
        # the same guard. Once this returns, cancellation is refused because
        # publication has begun; there is no check-then-publish gap.
        with _guard:
            if cancelled():
                raise imp.ImportCancelled("Import cancellation requested before publication")
            # Go through the import progress seam while holding _guard. This
            # keeps existing crash/instrumentation hooks observable and makes
            # the marker check and durable intent one critical section.
            imp._progress(phase="publishing", current_org=slug,
                          publication_intent=slug)

    try:
        with _guard:
            job["state"] = "running"
            _write(path, job)
        with _guard:
            job["state"] = "planning"
            job["phase"] = "counting"
            _write(path, job)
        totals = imp.plan_import(payload["source_root"], payload["organizations"],
                                 cancel=cancelled, progress=progress)
        with _guard:
            job["total_files"], job["total_bytes"] = totals
            job.pop("_planning_files", None)
            job.pop("_planning_bytes", None)
            job["state"] = "running"
            _write(path, job)
        result = imp.copy_import(**payload, on_imported=callback, progress=progress,
                                 cancel=cancelled, before_publication=publication_gate)
        with _guard:
            if job.get("cancel_requested") and not job.get("publications"):
                job.update(state="cancelled", phase="finished", error="Import cancelled before publication; staging is retained.", updated_at=_now())
            else:
                job.update(state="succeeded", phase="finished", result=result, progress_percent=100, eta_seconds=0, updated_at=_now())
            _write(path, job)
            try:
                _cancel_path(root, job["id"]).unlink()
            except FileNotFoundError:
                pass
    except BaseException as exc:
        with _guard:
            # Any crossed mutation boundary means failure cannot claim absence
            # of effects; keep receipts and never dispatch again automatically.
            state = "cancelled" if isinstance(exc, imp.ImportCancelled) else ("interrupted" if job["publications"] else "failed")
            job.update(state=state, error=f"{type(exc).__name__}: {exc}", updated_at=_now())
            try:
                _write(path, job)
            except OSError:
                pass  # prior durable checkpoint remains uncertain on restart
    finally:
        with _guard:
            _live.pop((str(root), job["id"]), None)
            try:
                _cancel_path(root, job["id"]).unlink()
            except FileNotFoundError:
                pass
            _release(lease)
