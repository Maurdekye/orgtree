"""Harness-only engine time attribution (ORGTREE_SCALE_ENGPROF=1); never shipped.

Answers "where does the engine's time go, per route, under N1000 load" for
item n1000-find-where-engine-time-goes-reads-tools-1. Three instruments, all
in the served engine process (tools/scale/serve.py child):

1. PER REQUEST (fields added to the sql_counts row of every HTTP request):
   pool_wait_ms   waiting for a threadpool worker (anyio limiter + scheduling)
   thread_ms      wall time of the sync handler on its worker thread
   thread_cpu_ms  that thread's CPU over the same interval (time.thread_time)
   pg_ms/pg_cpu_ms  wall/CPU inside psycopg execute/fetch (sql_counts wrapper)
   ser_ms/ser_cpu_ms  FastAPI serialize_response + Response.render
                  (these run on the EVENT-LOOP thread, not the worker)
   route/tool/action  route template; /api/agent tool name and args.action
   Off-CPU python time of the handler = thread_ms - thread_cpu_ms - (pg_ms -
   pg_cpu_ms): GIL/scheduler wait plus lock waits (the stacks split those).

2. ALL-THREAD STACK SAMPLER, SAMPLE_HZ (default 20) from engine start:
   every Python thread's stack plus its OS CPU delta (GetThreadTimes) since
   the previous sample. Aggregated per minute into
   metrics/engprof-stacks.jsonl: key = (thread group, route label, category,
   collapsed innermost frames) -> [samples, cpu_s]. A worker thread carries
   the route label of the request it is serving. Categories are read from
   the stack: pg (inside psycopg), lock (threading acquire/wait), serialize
   (json encode / jsonable_encoder / render), idle (worker waiting for work),
   python (anything else). cpu_s / (samples / SAMPLE_HZ) is the on-CPU share.

3. GIL PROBE: a thread that sleeps 5 ms and records how late it wakes; the
   lateness is dominated by waiting for the GIL. Per minute p50/p95/p99/max,
   plus process CPU and the sampler's own cost (metrics/engprof-minutes.jsonl).
"""
from __future__ import annotations

import collections
import contextvars
import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

ENABLED = os.environ.get("ORGTREE_SCALE_ENGPROF") == "1"
SAMPLE_HZ = float(os.environ.get("ORGTREE_SCALE_ENGPROF_HZ", "20") or 20)
STACK_DEPTH = int(os.environ.get("ORGTREE_SCALE_ENGPROF_DEPTH", "14") or 14)
FLUSH_S = float(os.environ.get("ORGTREE_SCALE_ENGPROF_FLUSH_S", "15") or 15)

#: native thread id -> route label of the request that thread is serving now
_serving: dict[int, str] = {}
#: the sql_counts per-request dict (set by sql_counts.Boundary); None outside a request
_counts_var: contextvars.ContextVar | None = None


def _add(field: str, value: float) -> None:
    counts = _counts_var.get() if _counts_var is not None else None
    if counts is not None:
        counts[field] = counts.get(field, 0.0) + value


# ---------------------------------------------------------------- threads
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.OpenThread.restype = wintypes.HANDLE
_k32.OpenThread.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_k32.GetThreadTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
_k32.QueryThreadCycleTime.argtypes = (wintypes.HANDLE, ctypes.POINTER(ctypes.c_ulonglong))
_k32.GetCurrentThread.restype = wintypes.HANDLE
#: CPU cycles per second of QueryThreadCycleTime, calibrated in start_sampler.
#: thread_time/GetThreadTimes move in 15.6 ms scheduler ticks on Windows, far
#: too coarse for one request; cycle counts are exact.
CYCLES_HZ = 0.0


def _cycles(handle) -> int | None:
    out = ctypes.c_ulonglong()
    if not _k32.QueryThreadCycleTime(handle, ctypes.byref(out)):
        return None
    return out.value


def thread_cpu_now() -> float:
    """This thread's CPU seconds (cycle-exact when calibrated)."""
    if CYCLES_HZ:
        c = _cycles(_k32.GetCurrentThread())
        if c is not None:
            return c / CYCLES_HZ
    return time.thread_time()


def _calibrate() -> float:
    best = 0.0
    me = _k32.GetCurrentThread()
    for _ in range(5):
        c0, t0 = _cycles(me), time.perf_counter()
        while time.perf_counter() - t0 < 0.05:
            pass
        c1, t1 = _cycles(me), time.perf_counter()
        if c0 is not None and c1 is not None:
            best = max(best, (c1 - c0) / (t1 - t0))   # a preempted pass reads low
    return best
_k32.CloseHandle.argtypes = (wintypes.HANDLE,)
_THREAD_QUERY_LIMITED_INFORMATION = 0x0800
_handles: dict[int, int] = {}


def _thread_cpu_s(native_id: int) -> float | None:
    h = _handles.get(native_id)
    if h is None:
        h = _k32.OpenThread(_THREAD_QUERY_LIMITED_INFORMATION, False, native_id)
        if not h:
            return None
        _handles[native_id] = h
    if CYCLES_HZ:
        c = _cycles(h)
        return None if c is None else c / CYCLES_HZ
    c, e, k, u = (wintypes.FILETIME() for _ in range(4))
    if not _k32.GetThreadTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u)):
        return None
    ft = lambda f: (f.dwHighDateTime << 32 | f.dwLowDateTime) / 1e7  # noqa: E731
    return ft(k) + ft(u)


def _group(name: str) -> str:
    if name.startswith("AnyIO worker"):
        return "worker"
    if name == "MainThread":
        return "loop"
    import re
    return re.sub(r"\d+", "N", name)


_PG = ("psycopg",)
_SER = ("jsonable_encoder", "serialize_response", "render", "dumps", "encode", "iterencode")
_LOCKS = ("acquire", "wait", "_wait_for_tstate_lock", "__enter__")


def _classify(frames: list[tuple[str, str]]) -> str:
    # frames innermost first: (module-ish file, function)
    if not frames:
        return "none"
    for f, fn in frames[:8]:
        if "psycopg" in f:
            return "pg"
    leaf_f, leaf_fn = frames[0]
    if leaf_f in ("threading", "queue") and leaf_fn in _LOCKS + ("get",):
        # an AnyIO worker parked on its queue is idle, not waiting for a lock
        if any(fn == "run" and f in ("_threads", "to_thread", "_asyncio") for f, fn in frames[:5]):
            return "idle"
        return "lock"
    if leaf_f in ("selectors", "windows_events", "proactor_events", "base_events") and leaf_fn in (
            "select", "_poll", "_run_once", "run_forever"):
        return "io"          # event loop waiting for events
    if leaf_fn in ("wait", "acquire"):
        return "lock"
    for f, fn in frames[:6]:
        if fn in _SER and f in ("encoder", "__init__", "encoders", "routing", "responses"):
            return "serialize"
    return "python"


def _collapse(frame) -> tuple[list[tuple[str, str]], str]:
    out: list[tuple[str, str]] = []
    depth = 0
    while frame is not None and depth < 200:
        code = frame.f_code
        f = os.path.splitext(os.path.basename(code.co_filename))[0]
        if "psycopg" in code.co_filename:
            f = "psycopg." + f
        item = (f, code.co_name)
        if item not in out[-4:]:   # fold recursion (deepcopy <-> _deepcopy_dict, json encode)
            out.append(item)
        frame = frame.f_back
        depth += 1
    key = " < ".join(f"{f}:{fn}" for f, fn in out[:STACK_DEPTH])
    return out, key


class _Sampler(threading.Thread):
    def __init__(self, metrics: Path):
        super().__init__(name="engprof-sampler", daemon=True)
        self.metrics = metrics
        self.agg: dict = collections.defaultdict(lambda: [0, 0.0])
        self.last_cpu: dict[int, float] = {}
        self.cost_s = 0.0
        self.ticks = 0
        self.lateness: list[float] = []
        self.proc_cpu0 = time.process_time()
        self.minute0 = time.time()

    def run(self) -> None:
        me = threading.get_ident()
        period = 1.0 / SAMPLE_HZ
        nxt = time.perf_counter()
        while True:
            nxt += period
            delay = nxt - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                nxt = time.perf_counter()
            t0 = time.perf_counter()
            try:
                self.sample(me)
            except Exception as exc:                       # noqa: BLE001
                self.agg[("engprof", "-", "error", repr(exc)[:200])][0] += 1
            self.cost_s += time.perf_counter() - t0
            self.ticks += 1
            if time.time() - self.minute0 >= FLUSH_S:
                self.flush()

    def sample(self, me: int) -> None:
        threads = {t.ident: t for t in threading.enumerate()}
        frames = sys._current_frames()
        for ident, frame in frames.items():
            if ident == me:
                continue
            t = threads.get(ident)
            if t is None or t.native_id is None:
                continue
            nid = t.native_id
            cpu = _thread_cpu_s(nid)
            prev = self.last_cpu.get(nid)
            if cpu is not None:
                self.last_cpu[nid] = cpu
            delta = (cpu - prev) if (cpu is not None and prev is not None) else 0.0
            stack, key = _collapse(frame)
            group = _group(t.name)
            route = _serving.get(nid, "-") if group == "worker" else t.name
            cat = _classify(stack)
            slot = self.agg[(group, route, cat, key)]
            slot[0] += 1
            slot[1] += delta

    def flush(self) -> None:
        now = time.time()
        proc = time.process_time()
        late = sorted(_probe_late)
        _probe_late.clear()

        def pct(q):
            return round(late[min(len(late) - 1, int(q * len(late)))] * 1000, 2) if late else None
        minute = dict(t0=self.minute0, t1=now, ticks=self.ticks, hz=SAMPLE_HZ, cycles_hz=CYCLES_HZ,
                      sampler_cost_s=round(self.cost_s, 3),
                      process_cpu_s=round(proc - self.proc_cpu0, 3),
                      gil_probe=dict(n=len(late), p50_ms=pct(.5), p95_ms=pct(.95), p99_ms=pct(.99),
                                     max_ms=round(late[-1] * 1000, 2) if late else None,
                                     mean_ms=round(sum(late) / len(late) * 1000, 3) if late else None),
                      threads=threading.active_count())
        rows = [[g, r, c, k, n, round(cpu, 4)] for (g, r, c, k), (n, cpu) in self.agg.items()]
        with open(self.metrics / "engprof-minutes.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(minute) + "\n")
        with open(self.metrics / "engprof-stacks.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(dict(t0=self.minute0, t1=now, rows=rows)) + "\n")
        self.agg.clear()
        self.cost_s = 0.0
        self.ticks = 0
        self.proc_cpu0 = proc
        self.minute0 = now


_probe_late: list[float] = []


def _gil_probe() -> None:
    while True:
        t = time.perf_counter()
        time.sleep(0.005)
        _probe_late.append(max(0.0, time.perf_counter() - t - 0.005))


def start_sampler(metrics: Path) -> None:
    """Call as early as possible in the engine child (covers startup/readiness)."""
    if not ENABLED:
        return
    global CYCLES_HZ
    metrics.mkdir(parents=True, exist_ok=True)
    CYCLES_HZ = _calibrate()
    try:
        # 1 ms timer resolution so the probe's 5 ms sleep measures the GIL, not the 15.6 ms tick
        ctypes.WinDLL("winmm").timeBeginPeriod(1)
    except Exception:                                      # noqa: BLE001
        pass
    _Sampler(metrics).start()
    threading.Thread(target=_gil_probe, name="engprof-gilprobe", daemon=True).start()


# ---------------------------------------------------------------- requests
def install_request_hooks(counts_var: contextvars.ContextVar) -> None:
    """Threadpool timing, route labels for worker threads, serialization timing."""
    global _counts_var
    if not ENABLED:
        return
    _counts_var = counts_var
    import fastapi.concurrency as fc
    import fastapi.dependencies.utils as fdu
    import fastapi.routing as fr
    import starlette.concurrency as sc
    import starlette.responses as sr
    original = sc.run_in_threadpool

    async def timed_run_in_threadpool(func, *args, **kwargs):
        counts = counts_var.get()
        if counts is None:
            return await original(func, *args, **kwargs)
        submitted = time.perf_counter()
        label = counts.get("route_hint") or "-"

        def timed():
            started = time.perf_counter()
            cpu0 = thread_cpu_now()
            nid = threading.get_native_id()
            prev = _serving.get(nid)
            _serving[nid] = label
            try:
                return func(*args, **kwargs)
            finally:
                if prev is None:
                    _serving.pop(nid, None)
                else:
                    _serving[nid] = prev
                counts["pool_wait_ms"] = counts.get("pool_wait_ms", 0.0) + (started - submitted) * 1000
                counts["thread_ms"] = counts.get("thread_ms", 0.0) + (time.perf_counter() - started) * 1000
                counts["thread_cpu_ms"] = counts.get("thread_cpu_ms", 0.0) + (thread_cpu_now() - cpu0) * 1000
                counts["pool_calls"] = counts.get("pool_calls", 0) + 1
        return await original(timed)

    for mod in (sc, fc, fr, fdu):
        if getattr(mod, "run_in_threadpool", None) is original:
            mod.run_in_threadpool = timed_run_in_threadpool

    original_serialize = fr.serialize_response

    async def timed_serialize(*args, **kwargs):
        t, c = time.perf_counter(), thread_cpu_now()
        try:
            return await original_serialize(*args, **kwargs)
        finally:
            _add("ser_ms", (time.perf_counter() - t) * 1000)
            _add("ser_cpu_ms", (thread_cpu_now() - c) * 1000)
    fr.serialize_response = timed_serialize

    for cls in (sr.JSONResponse,):
        original_render = cls.render

        def timed_render(self, content, _orig=original_render):
            t, c = time.perf_counter(), thread_cpu_now()
            try:
                return _orig(self, content)
            finally:
                _add("render_ms", (time.perf_counter() - t) * 1000)
                _add("render_cpu_ms", (thread_cpu_now() - c) * 1000)
        cls.render = timed_render
