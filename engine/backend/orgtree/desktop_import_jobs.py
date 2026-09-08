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
ACTIVE = {"queued", "running"}


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
    return copy.deepcopy({key: value for key, value in job.items() if not key.startswith("_")})


def _interrupt(root, job):
    if job["state"] in ACTIVE:
        job["state"] = "interrupted"
        job["updated_at"] = _now()
        job["error"] = ("Import engine stopped before a terminal result was recorded. "
                        "Publication or recovery may be incomplete or uncertain; inspect retained "
                        "receipts and imported organizations before any new import. Nothing was replayed.")
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
        return _public(_get(root, pointer["id"])) if pointer else None


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
                   "publications": [], "_fingerprint": fingerprint}
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

    def progress(event):
        nonlocal last_checkpoint
        with _guard:
            job["updated_at"] = _now()
            if "file_bytes" in event:
                job["files_copied"] += 1
                job["bytes_copied"] += event["file_bytes"]
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
            if set(event) != {"file_bytes"} or time.monotonic() - last_checkpoint >= 1:
                _write(path, job)
                last_checkpoint = time.monotonic()

    try:
        with _guard:
            job["state"] = "running"
            _write(path, job)
        result = imp.copy_import(**payload, on_imported=callback, progress=progress)
        with _guard:
            job.update(state="succeeded", phase="finished", result=result, updated_at=_now())
            _write(path, job)
    except BaseException as exc:
        with _guard:
            # Any crossed mutation boundary means failure cannot claim absence
            # of effects; keep receipts and never dispatch again automatically.
            state = "interrupted" if job["publications"] else "failed"
            job.update(state=state, error=f"{type(exc).__name__}: {exc}", updated_at=_now())
            try:
                _write(path, job)
            except OSError:
                pass  # prior durable checkpoint remains uncertain on restart
    finally:
        with _guard:
            _live.pop((str(root), job["id"]), None)
            _release(lease)
