"""Opt-in cached_org caller, rebuild and mutex-acquisition attribution.

Diagnostic only. Values are inclusive and concurrent wall sums are not elapsed
time. No arguments, org IDs, frames or payloads are retained. CPU uses the
platform thread clock and may be quantized (15.625 ms on this Windows host).
"""
import contextlib
import functools
import sys
import threading
import time


class CacheTrace:
    def __init__(self, limit=256):
        self.limit = limit
        self.rows = {}
        self.dropped = 0
        self.lock = threading.Lock()
        self.local = threading.local()

    def record(self, caller, phase, wall, cpu):
        key = (caller, phase)
        with self.lock:
            if key not in self.rows and len(self.rows) >= self.limit:
                self.dropped += 1
                return
            row = self.rows.setdefault(key, {'calls': 0, 'wall_ns': 0, 'thread_cpu_ns': 0})
            row['calls'] += 1
            row['wall_ns'] += wall
            row['thread_cpu_ns'] += cpu

    def snapshot(self):
        with self.lock:
            return {'rows': [dict(caller=k[0], phase=k[1], **v) for k,v in self.rows.items()],
                    'dropped': self.dropped, 'limit': self.limit,
                    'inclusive': True, 'mutex_measure': 'acquisition wall, including scheduling'}


def install(store):
    """Call after the scale server's disposable-root guard; never in product."""
    trace = CacheTrace()
    cached = store.cached_org
    mutex = store._rebuild_mutex

    @functools.wraps(cached)
    def measured(*args, **kwargs):
        frame = sys._getframe(1)
        try:
            caller = str(frame.f_globals.get('__name__', '?')) + ':' + frame.f_code.co_name
        finally:
            del frame
        previous = getattr(trace.local, 'caller', None)
        trace.local.caller = caller
        wall, cpu = time.monotonic_ns(), time.thread_time_ns()
        try:
            return cached(*args, **kwargs)
        finally:
            trace.record(caller, 'total', time.monotonic_ns()-wall, time.thread_time_ns()-cpu)
            trace.local.caller = previous

    @contextlib.contextmanager
    def measured_mutex(slug):
        lock = mutex(slug)
        caller = getattr(trace.local, 'caller', None)
        wall, cpu = time.monotonic_ns(), time.thread_time_ns()
        lock.acquire()
        try:
            if caller is not None:
                trace.record(caller, 'mutex_acquire', time.monotonic_ns()-wall,
                             time.thread_time_ns()-cpu)
            yield
        finally:
            lock.release()

    store.cached_org = measured
    store._rebuild_mutex = measured_mutex
    for name in ('_assemble_snapshot', '_load_pinned'):
        original = getattr(store, name)
        def phase(*args, _original=original, _name=name, **kwargs):
            caller = getattr(trace.local, 'caller', None)
            if caller is None:
                return _original(*args, **kwargs)
            wall, cpu = time.monotonic_ns(), time.thread_time_ns()
            try:
                return _original(*args, **kwargs)
            finally:
                trace.record(caller, _name, time.monotonic_ns()-wall, time.thread_time_ns()-cpu)
        setattr(store, name, phase)
    return trace
