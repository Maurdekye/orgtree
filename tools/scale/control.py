"""Small, testable controls for a disposable scale workload (no engine imports)."""
from __future__ import annotations

import concurrent.futures as cf
import ctypes
import os
import threading


def free_commit_gb():
    """Read Windows commit headroom directly, without a shell or network wait."""
    if os.name != "nt":
        raise RuntimeError("scale qualification requires Windows commit accounting")
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in (
                "total_phys", "avail_phys", "total_page", "avail_page",
                "total_virtual", "avail_virtual", "avail_extended")]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError()
    return status.avail_page / 2 ** 30


def memory_breach(free_gb, engine_bytes, client_bytes, *, floor_gb=10,
                  engine_cap_gb=5, total_cap_gb=8):
    if free_gb is None:
        return "commit headroom unavailable"
    if free_gb < floor_gb:
        return f"free commit {free_gb:.2f} GiB < floor {floor_gb} GiB"
    if engine_bytes > engine_cap_gb * 2 ** 30:
        return f"engine private bytes exceed {engine_cap_gb} GiB"
    if engine_bytes + client_bytes > total_cap_gb * 2 ** 30:
        return f"engine plus client private bytes exceed {total_cap_gb} GiB"
    return None


class BoundedPool:
    """Never block the open-loop producer and never hide missed demand.

    Capacity includes executing and queued requests. A rejected submission is
    an overload sample, not a completed request. shutdown cancels queued work.
    """
    def __init__(self, workers):
        self.pool = cf.ThreadPoolExecutor(max_workers=workers)
        self.slots = threading.BoundedSemaphore(2 * workers)
        self.lock = threading.Lock()
        self.counts = dict(offered=0, submitted=0, completed=0, rejected=0,
                           cancelled=0, worker_errors=0, peak_outstanding=0)

    def submit(self, fn, *args):
        with self.lock:
            self.counts["offered"] += 1
            if not self.slots.acquire(blocking=False):
                self.counts["rejected"] += 1
                return False
            self.counts["submitted"] += 1
            pending = self.counts["submitted"] - self.counts["completed"] - self.counts["cancelled"]
            self.counts["peak_outstanding"] = max(pending, self.counts["peak_outstanding"])
        try:
            future = self.pool.submit(fn, *args)
        except BaseException:
            self.slots.release()
            raise
        def complete(f):
            with self.lock:
                self.counts["cancelled" if f.cancelled() else "completed"] += 1
                if not f.cancelled() and f.exception() is not None:
                    self.counts["worker_errors"] += 1
            self.slots.release()
        future.add_done_callback(complete)
        return True

    def shutdown(self, *, cancel_pending=False):
        self.pool.shutdown(wait=True, cancel_futures=cancel_pending)


class Workload:
    """Select real permitted parents and item owners; track finite write budgets."""
    def __init__(self, metadata, live):
        self.parents = metadata["parents"]
        if not live or not set(live).issubset(self.parents):
            raise ValueError("token/node coverage differs from workload metadata")
        self.message_actors = [n for n in live if self.parents[n] in self.parents]
        self.items = [dict(x) for x in metadata["items"] if x["owner"] in live]
        if not self.message_actors or not self.items:
            raise ValueError("no permitted message actor or owned work item")
        self.create_left = max(0, 200 - metadata["active_items"])
        self.substitutions = dict(evidence_capacity=0, create_capacity=0)

    def select(self, me, tool, args, rng):
        if tool in ("orgtree_message", "orgtree_send_notice"):
            me = rng.choice(self.message_actors)
            args["to"] = self.parents[me]
        if tool == "orgtree_work":
            action = args.get("action")
            if action == "create":
                if self.create_left:
                    self.create_left -= 1
                else:
                    self.substitutions["create_capacity"] += 1
                    args = dict(action="update", done_so_far=["scale bounded update"],
                                working_on_next=["continue scale workload"])
                    action = "update"
            if action in ("get", "update", "evidence"):
                eligible = self.items
                if action == "evidence":
                    eligible = [x for x in self.items if x["evidence"] < 50]
                    if not eligible:
                        self.substitutions["evidence_capacity"] += 1
                        args = dict(action="update", done_so_far=["scale bounded update"],
                                    working_on_next=["continue scale workload"])
                        eligible = self.items
                item = rng.choice(eligible)
                me, args["slug"] = item["owner"], item["slug"]
                if args["action"] == "evidence":
                    item["evidence"] += 1
        return me, tool, args


class Feed:
    """Bound retained marker state to the most recent 5 seconds plus one batch.

    Latencies use packed doubles, not a dict per marker. A missed 5-second
    delivery is counted once, even if a later frame repeats that marker.
    """
    def __init__(self, windows):
        from array import array
        self.lock = threading.Lock()
        self.pending = {}
        self.windows = windows
        self.latencies = {w: array("d") for w in range(windows)}
        self.counts = {w: dict(due=0, missing=0, over_1s=0) for w in range(windows)}
        self.failed = 0

    def emit(self, marker, when):
        with self.lock:
            self.pending[marker] = [when, None, {}]

    def acknowledge(self, markers, success):
        with self.lock:
            for marker in markers:
                self.pending[marker][1] = success

    def receive(self, window, marker, when):
        with self.lock:
            item = self.pending.get(marker)
            if item is not None and window not in item[2]:
                item[2][window] = when
                return {"w": window, "m": marker, "emit": item[0], "receive": when}
        return None

    def retire(self, now):
        with self.lock:
            for marker, (emitted, accepted, seen) in list(self.pending.items()):
                if accepted is None or now - emitted < 5:
                    continue
                if not accepted:
                    self.failed += 1
                else:
                    for w in range(self.windows):
                        self.counts[w]["due"] += 1
                        if w not in seen or seen[w] - emitted > 5:
                            self.counts[w]["missing"] += 1
                        if w in seen:
                            ms = (seen[w] - emitted) * 1000
                            self.latencies[w].append(ms)
                            self.counts[w]["over_1s"] += ms > 1000
                del self.pending[marker]


def guarded_wait(proc, *, floor_gb=10, cap_gb=8, report=None):
    """Monitor an owned subprocess family during startup/seeding as well as load."""
    import json
    import time
    import psutil
    parent = psutil.Process()
    # The child can exit at any moment (a quick seed step, 2026-09-28): a
    # vanished pid is not an error, poll() reports its exit on the next pass.
    try:
        child = psutil.Process(proc.pid)
    except psutil.NoSuchProcess:
        child = None
    try:
        while proc.poll() is None:
            try:
                family = [child] + child.children(recursive=True) if child else []
            except psutil.NoSuchProcess:
                family = []
            total = 0
            for process in [parent] + family:
                try:
                    info = process.memory_info()
                    total += getattr(info, "private", info.rss)
                except psutil.NoSuchProcess:
                    pass
            free = free_commit_gb()
            reason = memory_breach(free, 0, total, floor_gb=floor_gb, total_cap_gb=cap_gb)
            if reason:
                if report:
                    report.write_text(json.dumps(dict(at=time.time(), reason=reason,
                                                      private_bytes=total, free_commit_gb=free)))
                raise RuntimeError(reason)
            time.sleep(1)
        return proc.returncode
    finally:
        if proc.poll() is None:
            try:
                family = child.children(recursive=True) if child else []
            except psutil.NoSuchProcess:
                family = []
            for process in reversed(family):
                try:
                    process.kill()
                except psutil.NoSuchProcess:
                    pass
            proc.kill()
            proc.wait(timeout=30)

