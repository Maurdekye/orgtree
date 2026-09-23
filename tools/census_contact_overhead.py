"""Offline single-machine microbenchmark of the P02-A3 SQLite contact observer.

WHAT IT MEASURES. The cost the primary store's connection class
(`census_contacts.ObservedConnection`, installed by `store._open_conn`) adds to
SQLite statement calls, in three interleaved arms on identical synthetic data:

  plain         the store's own connect arguments and pragmas WITHOUT
                `factory=` and without the pool's checkout note - the store as
                it was before P02-A3;
  observed_off  the real `store._open_conn` / `store._Pool` with census capture
                OFF, which is the shipped default;
  observed_on   the same with capture ON and a bound per-thread tally, which
                is what an operator-enabled capture window costs.

Workloads: a pooled read (checkout + one keyed SELECT), a write transaction
(BEGIN IMMEDIATE, one upsert, COMMIT) and an executemany batch upsert, each
quiet (one thread) and concurrent (eight threads against the same database).

WHAT IT DOES NOT CLAIM. One machine, one process, synthetic rows, a temporary
database: the numbers are per-call deltas of a microbenchmark and never an
end-to-end, request-level or product overhead figure. The output says so.

SAFETY. It creates a fresh temporary data root, points `ORGTREE_DATA` at it
BEFORE importing any backend code, refuses to run if the store resolved any
other root, removes the temporary root when done, and accepts no path, URL or
endpoint argument. Census capture is switched on only inside this process.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "orgtree.census-contact-overhead/v1"
ARMS = ("plain", "observed_off", "observed_on")
WORKLOADS = ("pooled_read", "write_transaction", "executemany_batch")
THREADS = (1, 8)
BATCH_ROWS = 16
CLAIM = ("Offline single-machine microbenchmark on synthetic temporary SQLite databases. "
         "Per-call deltas between arms of one process; not end-to-end, request-level or "
         "product overhead, and not a measurement of any live or installed data.")
RESULT_FIELDS = ("workload", "threads", "arm", "calls_per_repetition", "rows_per_repetition",
                 "median_ns_per_call", "p90_ns_per_call", "delta_median_ns_vs_plain",
                 "delta_p90_ns_vs_plain", "delta_median_pct_vs_plain")


def _nearest_rank(values, percentile):
    ordered = sorted(values)
    return ordered[max(0, -(-percentile * len(ordered) // 100) - 1)]


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


class Bench:
    def __init__(self, data_root: Path):
        self.data_root = data_root
        os.environ["ORGTREE_DATA"] = str(data_root)
        for key in ("ORGTREE_LOCAL_HUB_ADDRESS", "ORGTREE_OPERATION_CENSUS", "ORGTREE_STORE",
                    "ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_DATA"):
            os.environ.pop(key, None)
        for path in (ROOT / "engine" / "backend", ROOT):
            if str(path) not in sys.path:
                sys.path.insert(0, str(path))
        from orgtree import census, census_contacts, store
        if Path(store.DATA_ROOT).resolve() != data_root.resolve():
            raise SystemExit("census overhead refused: the store did not bind the temporary data root")
        self.census, self.contacts, self.store = census, census_contacts, store
        census.set_enabled(False)
        self.pools = {arm: store._Pool() for arm in ARMS}
        self.slugs = {arm: f"overhead-{arm.replace('_', '-')}" for arm in ARMS}
        for arm in ARMS:
            conn = store._open_conn(store._db_path(self.slugs[arm]), create=True)
            with contextlib.closing(conn):
                conn.execute("BEGIN IMMEDIATE")
                conn.executemany("INSERT OR REPLACE INTO meta(key, val) VALUES (?, ?)",
                                 [(f"k{i}", "v") for i in range(256)])
                conn.execute("COMMIT")

    def _plain_open(self, path, *, create=False):
        """`store._open_conn` exactly, minus `factory=`: the pre-A3 connection."""
        target = path
        if not create:
            target = Path(os.path.abspath(path)).as_uri() + "?mode=rw"
        conn = sqlite3.connect(target, timeout=10.0, isolation_level=None,
                               check_same_thread=False, uri=not create)
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    @contextlib.contextmanager
    def arm(self, name):
        """Configure the process for one arm, and undo it afterwards."""
        store, contacts = self.store, self.contacts
        saved = (store._open_conn, contacts.note_checkout)
        try:
            if name == "plain":
                store._open_conn = self._plain_open
                contacts.note_checkout = lambda: None
            self.census.set_enabled(name == "observed_on")
            yield
        finally:
            self.census.set_enabled(False)
            store._open_conn, contacts.note_checkout = saved

    def _work(self, arm, workload, statements, thread_index):
        pool, slug = self.pools[arm], self.slugs[arm]
        calls = 0
        token = self.contacts.bind(self.contacts.Tally()) if arm == "observed_on" else None
        try:
            for i in range(statements):
                key = f"k{(thread_index * 31 + i) % 256}"
                with pool.acquire(slug) as conn:
                    if workload == "pooled_read":
                        conn.execute("SELECT val FROM meta WHERE key=?", (key,)).fetchone()
                        calls += 1
                    elif workload == "write_transaction":
                        conn.execute("BEGIN IMMEDIATE")
                        conn.execute("INSERT OR REPLACE INTO meta(key, val) VALUES (?, ?)", (key, str(i)))
                        conn.execute("COMMIT")
                        calls += 3
                    else:
                        conn.execute("BEGIN IMMEDIATE")
                        conn.executemany("INSERT OR REPLACE INTO meta(key, val) VALUES (?, ?)",
                                         [(f"k{(i + j) % 256}", str(j)) for j in range(BATCH_ROWS)])
                        conn.execute("COMMIT")
                        calls += 3
        finally:
            if token is not None:
                self.contacts.unbind(token)
        return calls

    def repetition(self, arm, workload, threads, statements):
        """Wall nanoseconds per call for one repetition of one arm."""
        barrier = threading.Barrier(threads + 1)
        calls = [0] * threads
        errors = []

        def run(index):
            try:
                barrier.wait()
                calls[index] = self._work(arm, workload, statements, index)
            except BaseException as error:  # noqa: BLE001 - reported, then re-raised below
                errors.append(error)

        workers = [threading.Thread(target=run, args=(i,)) for i in range(threads)]
        with self.arm(arm):
            for worker in workers:
                worker.start()
            barrier.wait()
            started = time.perf_counter_ns()
            for worker in workers:
                worker.join()
            elapsed = time.perf_counter_ns() - started
        if errors:
            raise errors[0]
        return elapsed / sum(calls), sum(calls)

    def close(self):
        for arm in ARMS:
            self.store._POOL.close_all(self.slugs[arm])
            self.pools[arm].close_all(self.slugs[arm])


def run(repetitions, statements, warmup):
    with tempfile.TemporaryDirectory(prefix="census-overhead-") as directory:
        bench = Bench(Path(directory) / "data")
        try:
            samples = {}
            meta = {}
            for workload in WORKLOADS:
                for threads in THREADS:
                    for rep in range(warmup + repetitions):
                        # Rotate the arm order every repetition, so no arm is
                        # always first (cold) or always last (warm).
                        order = ARMS[rep % len(ARMS):] + ARMS[:rep % len(ARMS)]
                        for arm in order:
                            per_call, calls = bench.repetition(arm, workload, threads, statements)
                            meta[workload, threads, arm] = calls
                            if rep >= warmup:
                                samples.setdefault((workload, threads, arm), []).append(per_call)
        finally:
            bench.close()
    results = []
    for workload in WORKLOADS:
        for threads in THREADS:
            base = samples[workload, threads, "plain"]
            base_median, base_p90 = _median(base), _nearest_rank(base, 90)
            for arm in ARMS:
                values = samples[workload, threads, arm]
                median, p90 = _median(values), _nearest_rank(values, 90)
                calls = meta[workload, threads, arm]
                results.append({
                    "workload": workload, "threads": threads, "arm": arm,
                    "calls_per_repetition": calls,
                    "rows_per_repetition": threads * statements * (BATCH_ROWS if workload == "executemany_batch" else 1),
                    "median_ns_per_call": round(median, 1), "p90_ns_per_call": round(p90, 1),
                    "delta_median_ns_vs_plain": round(median - base_median, 1),
                    "delta_p90_ns_vs_plain": round(p90 - base_p90, 1),
                    "delta_median_pct_vs_plain": round((median - base_median) * 100 / base_median, 2),
                })
    return {
        "schema": SCHEMA,
        "kind": "offline_microbenchmark",
        "claim": CLAIM,
        "environment": {"python": platform.python_version(),
                        "implementation": platform.python_implementation(),
                        "sqlite": sqlite3.sqlite_version, "os": sys.platform,
                        "cpu_count": os.cpu_count()},
        "run": {"repetitions": repetitions, "warmup": warmup, "statements_per_thread": statements,
                "batch_rows": BATCH_ROWS, "threads": list(THREADS), "arms": list(ARMS),
                "workloads": list(WORKLOADS), "order": "arms rotated each repetition; warmup discarded",
                "unit": "wall nanoseconds per statement call, from a barrier start to the last thread's end"},
        "results": results,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline microbenchmark of the census SQLite contact observer on synthetic temporary databases. Takes no path, URL or endpoint; never touches live or installed data.")
    parser.add_argument("--repetitions", type=int, default=30, help="measured repetitions per arm (default 30)")
    parser.add_argument("--statements", type=int, default=200, help="operations per thread per repetition (default 200)")
    parser.add_argument("--warmup", type=int, default=3, help="discarded repetitions per arm (default 3)")
    args = parser.parse_args(argv)
    if not (1 <= args.repetitions <= 1000 and 1 <= args.statements <= 100000 and 0 <= args.warmup <= 100):
        parser.error("repetitions 1-1000, statements 1-100000, warmup 0-100")
    print(json.dumps(run(args.repetitions, args.statements, args.warmup), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
