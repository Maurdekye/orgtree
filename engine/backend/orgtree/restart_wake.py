# pyright: strict
"""Restart-wake and passive restart notifications (FR-xx).

Every backend restart sends a PASSIVE NOTICE to every live agent carrying the
deployed version information (commit SHA, backend PID, boot timestamp, branch).
Passive notices land in the mailbox (kind="notice") and are read at the agent's
next turn without starting one, making them completely free at scale. If several
restarts happen before an agent wakes, the newest notice supersedes earlier ones
so only one current notice is ever waiting.

Agents may also TOGGLE their next restart notification into a full waking turn
(orgtree_restart_wake). Armed toggles are ONE-SHOT ONLY: they fire once on the
next restart, then revert to passive notices. They survive compaction, and are
dropped if the agent is retired or deleted before the restart lands.
"""

from __future__ import annotations

import datetime as _dtm
import json
import os
import subprocess
import threading
import uuid
from typing import Any, Final

from . import events
from . import sandbox as sbx
from . import store
from . import supervisor

_WAKES_FILE: Final = "restart-wakes.json"
_wakes_lock = threading.Lock()
_startup_done = False
_boot_info_cache: dict[str, Any] | None = None


def now_iso() -> str:
    return _dtm.datetime.now(_dtm.timezone.utc).isoformat()


def _wakes_path() -> str:
    return os.path.join(store.DATA_ROOT, _WAKES_FILE)


def _wakes_read() -> dict[str, Any]:
    """Read the machine-wide restart-wakes registry. Never raises."""
    try:
        with open(_wakes_path(), encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError(f"not an object: {type(d).__name__}")
        return d
    except FileNotFoundError:
        return {}
    except Exception as e:                                   # noqa: BLE001
        print(f"[orgtree] restart-wakes record unreadable ({e!r}) — "
              f"treating as empty", flush=True)
        return {}


def _wakes_write(d: dict[str, Any]) -> None:
    """Atomic replace (tmp + os.replace), same shape as store and primed restart."""
    p = _wakes_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, p)


def get_boot_build_info() -> dict[str, Any]:
    """Build info frozen at process launch.

    Reading once and freezing protects against git drift while the process is running:
    an agent checking what is RUNNING needs the commit that was imported/started,
    not whatever branch or commit the on-disk repo happens to point to now.
    """
    global _boot_info_cache
    if _boot_info_cache is None:
        commit = "unknown"
        commit_short = "unknown"
        branch = None
        dirty = False
        try:
            r = subprocess.run(["git", "rev-parse", "HEAD"],
                               cwd=sbx.REPO_ROOT, capture_output=True,
                               text=True, timeout=10,
                               creationflags=(subprocess.CREATE_NO_WINDOW
                                              if os.name == "nt" else 0))
            if r.returncode == 0 and r.stdout.strip():
                commit = r.stdout.strip()
                commit_short = commit[:7]
            b = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                               cwd=sbx.REPO_ROOT, capture_output=True,
                               text=True, timeout=10,
                               creationflags=(subprocess.CREATE_NO_WINDOW
                                              if os.name == "nt" else 0))
            if b.returncode == 0:
                name = b.stdout.strip()
                if name and name not in ("HEAD", "main"):
                    branch = name
            d = subprocess.run(["git", "status", "--porcelain", "-uno"],
                               cwd=sbx.REPO_ROOT, capture_output=True,
                               text=True, timeout=10,
                               creationflags=(subprocess.CREATE_NO_WINDOW
                                              if os.name == "nt" else 0))
            if d.returncode == 0 and d.stdout.strip():
                dirty = True
        except (OSError, subprocess.TimeoutExpired):
            pass
        _boot_info_cache = {
            "commit": commit,
            "commit_short": commit_short,
            "branch": branch,
            "dirty": dirty,
            "backend_pid": os.getpid(),
            "started_at": now_iso(),
        }
    return dict(_boot_info_cache)


def _reset_boot_build_info_for_tests(fake_info: dict[str, Any] | None = None) -> None:
    """Test helper to inject faked boot build info or clear the cache."""
    global _boot_info_cache
    _boot_info_cache = dict(fake_info) if fake_info is not None else None


def _reset_startup_done_for_tests() -> None:
    """Test helper to allow re-running on_backend_startup."""
    global _startup_done
    _startup_done = False


def arm_restart_wake(slug: str, nid: str, actor: str, *,
                     mode: str = "one_shot",
                     reason: str | None = None) -> dict[str, Any]:
    """Arm the wake toggle for an agent node.

    Always one-shot: fires once on the next restart, then reverts to passive notices.
    Idempotent: arming when already armed updates the reason without duplicating.
    """
    if mode != "one_shot":
        raise ValueError("only one-shot restart wakes are supported; re-arm after waking if needed")
    key = f"{slug}:{nid}"
    with _wakes_lock:
        d = _wakes_read()
        wakes = d.setdefault("wakes", {})
        cur = wakes.get(key)
        already_armed = isinstance(cur, dict)
        boot = get_boot_build_info()
        rec: dict[str, Any] = {
            "org": slug,
            "node": nid,
            "mode": "one_shot",
            "armed_at": now_iso(),
            "armed_by": actor,
            "armed_by_pid": boot["backend_pid"],
            "armed_commit": boot["commit_short"],
        }
        if reason:
            rec["reason"] = reason[:200]
        elif already_armed and isinstance(cur, dict) and cur.get("reason"):
            rec["reason"] = cur["reason"]

        wakes[key] = rec
        _wakes_write(d)

    return {
        "armed": True,
        "already_armed": already_armed,
        "wake": rec,
        "status": (
            "wake toggle ARMED (one-shot). When orgtree next restarts, you will be "
            "woken with a full turn carrying the running commit SHA and backend PID."
            + (f" Reason: {rec['reason']}" if rec.get("reason") else "")
            + (" (Re-armed: existing toggle was updated.)" if already_armed else "")
            + " Cancel with action='cancel'."
        ),
    }


def cancel_restart_wake(slug: str, nid: str) -> dict[str, Any]:
    """Disarm the wake toggle, reverting to passive notice default."""
    key = f"{slug}:{nid}"
    with _wakes_lock:
        d = _wakes_read()
        wakes = d.setdefault("wakes", {})
        cur = wakes.pop(key, None)
        if cur is not None:
            _wakes_write(d)

    if cur is None:
        return {
            "cancelled": False,
            "wake": None,
            "status": "no wake toggle was armed — already on passive notice default",
        }
    return {
        "cancelled": True,
        "was": cur,
        "status": (
            "wake toggle disarmed. When orgtree next restarts, you will receive "
            "a passive notice without starting a turn."
        ),
    }


def status_restart_wake(slug: str, nid: str) -> dict[str, Any]:
    """Check current wake toggle status for an agent node."""
    key = f"{slug}:{nid}"
    with _wakes_lock:
        d = _wakes_read()
        wakes = d.get("wakes") or {}
        cur = wakes.get(key)

    boot = get_boot_build_info()
    if cur is not None:
        return {
            "armed": True,
            "wake": dict(cur),
            "running_build": boot,
            "status": (
                "wake toggle is ARMED (one-shot) — will wake with a turn on next restart."
                + (f" Reason: {cur['reason']}" if cur.get("reason") else "")
            ),
        }
    return {
        "armed": False,
        "wake": None,
        "running_build": boot,
        "status": "wake toggle is PASSIVE (default) — will receive a passive notice on restart without starting a turn.",
    }


def on_backend_startup(*, dry_run: bool = False) -> dict[str, Any]:
    """Execute on backend process startup.

    1. Wakes agents that have an armed toggle.
    2. Drops a passive notice to all other live-and-idle agents.
    3. Supersedes any previous unread restart notices in mailboxes.
    4. Clears one-shot armed toggles.
    5. Updates running backend PID and commit in registry.
    """
    global _startup_done
    if _startup_done and not dry_run:
        return {"already_ran": True}
    if not dry_run:
        _startup_done = True

    with _wakes_lock:
        d = _wakes_read()
        previous_pid = d.get("running_backend_pid")
        previous_commit = d.get("running_commit")
        wakes = dict(d.get("wakes") or {})

        boot = get_boot_build_info()
        current_pid = boot["backend_pid"]
        current_commit = boot["commit"]
        current_short = boot["commit_short"]
        started_at = boot["started_at"]
        branch = boot["branch"]
        dirty = boot["dirty"]

        # Record this process as current
        d["running_backend_pid"] = current_pid
        d["running_commit"] = current_commit
        d["boot_at"] = started_at

        woken: list[dict[str, Any]] = []
        notified: list[dict[str, Any]] = []
        dropped: list[dict[str, Any]] = []

        branch_info = f", branch: {branch}" if branch else ""
        dirty_info = " [DIRTY - uncommitted changes present at boot]" if dirty else ""

        for o in store.list_orgs():
            slug = o["slug"]
            changed = False
            try:
                with store.DOC_LOCK:
                    org = store.load_org(slug)
                    for nid, node in list(org.nodes.items()):
                        key = f"{slug}:{nid}"
                        # Archived or deleted nodes cannot receive wakes or notices
                        if node.get("state") != "live":
                            if key in wakes:
                                dropped.append(wakes.pop(key))
                            continue

                        wake_rec = wakes.get(key)
                        if wake_rec and isinstance(wake_rec, dict):
                            # WAKE TOGGLE PATH: full waking turn
                            reason = wake_rec.get("reason")
                            armed_was_pid = wake_rec.get("armed_by_pid") or previous_pid
                            wake_pid_text = f"{current_pid}" + (f" (was: {armed_was_pid})" if armed_was_pid and armed_was_pid != current_pid else "")
                            reason_line = f"\nReason armed: {reason}" if reason else ""
                            wake_text = (
                                f"[ORGTREE RESTART WAKE] orgtree has restarted and your one-shot wake toggle has fired.\n\n"
                                f"Running build:\n"
                                f"- Commit: {current_commit} (short: {current_short}){dirty_info}\n"
                                f"- Backend PID: {wake_pid_text}\n"
                                f"- Started at: {started_at}{branch_info}{reason_line}\n\n"
                                f"Ancestry check: git merge-base --is-ancestor <your-commit> {current_commit}\n"
                                f"(Your wake toggle was one-shot and has cleared. To wake on a subsequent restart, re-arm with orgtree_restart_wake.)"
                            )
                            supervisor.send_message(slug, nid, wake_text, wake=True)
                            woken.append({"org": slug, "node": nid, "reason": reason, "mode": "one_shot"})
                            wakes.pop(key, None)
                        else:
                            # PASSIVE NOTICE PATH: live agent without toggle.
                            # Typed (family runtime_recovery): runtime.restart_notice
                            # on the BuildRef; the body is its frozen rendering —
                            # byte for byte the former literal (test_events_producers §R).
                            box = org.d.setdefault("mail", {}).setdefault(nid, [])
                            ev = events.mint(
                                "runtime.restart_notice",
                                {"kind": "system", "id": "@system"},
                                {"kind": "build", "commit": str(current_commit),
                                 "short": str(current_short), "dirty": bool(dirty),
                                 "pid": int(current_pid)},
                                prev_pid=(int(previous_pid) if previous_pid else None),
                                started_at=str(started_at),
                                branch=(str(branch) if branch else None))
                            entry: dict[str, Any] = {
                                "id": uuid.uuid4().hex[:12],
                                "from": "orgtree",
                                "kind": "notice",
                                "body": events.render_agent(ev),
                                "at": now_iso(),
                                "relationship": "system",
                                "restart_notice": True,
                            }
                            entry["ev"] = events.encode_row_ev(ev, entry)
                            # Supersede an existing unread restart notice: the typed
                            # variant first, then the durable flag; the body test is
                            # the pre-typed rows' shape and stays for them only.
                            existing_idx = None
                            for idx, m in enumerate(box):
                                if (events.decode(m.get("ev"), m).get("ev") or {}).get(
                                        "variant") == "runtime.restart_notice" \
                                        or m.get("restart_notice") or (
                                    m.get("from") == "orgtree"
                                    and m.get("kind") == "notice"
                                    and "[ORGTREE RESTART" in m.get("body", "")
                                ):
                                    existing_idx = idx
                                    break
                            if existing_idx is not None:
                                box[existing_idx] = entry
                            else:
                                box.append(entry)

                            # Also mirror into mail_log
                            log = org.d.setdefault("mail_log", {}).setdefault(nid, [])
                            log.append(dict(entry))
                            del log[:-100]

                            changed = True
                            notified.append({"org": slug, "node": nid})

                    if changed:
                        store.save_org(org)
            except Exception as e:                               # noqa: BLE001
                print(f"[orgtree] {slug}: restart notification failed ({e})", flush=True)

        d["wakes"] = wakes
        _wakes_write(d)

    print(f"[orgtree] restart-wake startup pass complete: "
          f"{len(woken)} woken, {len(notified)} passively notified, "
          f"{len(dropped)} stale wakes dropped", flush=True)
    return {
        "woken": woken,
        "notified": notified,
        "dropped": dropped,
        "current_build": boot,
        "previous_pid": previous_pid,
    }