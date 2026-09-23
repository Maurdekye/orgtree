"""Smoke controls for tools/census_contact_overhead.py.

Shape only: timings are never asserted, because a threshold on one machine's
noise would be a flaky test pretending to be a measurement. The benchmark runs
in a child process with its own temporary data root; this process imports no
backend code.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "census_contact_overhead.py"
ARMS = ["plain", "observed_off", "observed_on"]
WORKLOADS = ["pooled_read", "write_transaction", "executemany_batch"]
THREADS = [1, 8]
RESULT_FIELDS = {"workload", "threads", "arm", "calls_per_repetition", "rows_per_repetition",
                 "median_ns_per_call", "p90_ns_per_call", "delta_median_ns_vs_plain",
                 "delta_p90_ns_vs_plain", "delta_median_pct_vs_plain"}


def run(*args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ORGTREE_")}
    return subprocess.run([sys.executable, "-I", "-B", str(TOOL), *args], cwd=str(ROOT), env=env,
                          capture_output=True, text=True, timeout=300)


class OverheadSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run("--repetitions", "2", "--statements", "3", "--warmup", "1")

    def test_runs_and_emits_the_closed_shape(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr[-3000:])
        body = json.loads(self.result.stdout)
        self.assertEqual(set(body), {"schema", "kind", "claim", "environment", "run", "results"})
        self.assertEqual(body["schema"], "orgtree.census-contact-overhead/v1")
        self.assertEqual(body["kind"], "offline_microbenchmark")
        for phrase in ("single-machine", "not end-to-end", "product overhead", "not a measurement of any live"):
            self.assertIn(phrase, body["claim"])
        self.assertEqual(set(body["environment"]), {"python", "implementation", "sqlite", "os", "cpu_count"})
        self.assertEqual(body["environment"]["python"].split(".")[:2], [str(v) for v in sys.version_info[:2]])
        self.assertEqual(body["run"]["arms"], ARMS)
        self.assertEqual(body["run"]["workloads"], WORKLOADS)
        self.assertEqual(body["run"]["threads"], THREADS)
        self.assertEqual((body["run"]["repetitions"], body["run"]["warmup"], body["run"]["statements_per_thread"]), (2, 1, 3))
        results = body["results"]
        self.assertEqual(len(results), len(ARMS) * len(WORKLOADS) * len(THREADS))
        self.assertEqual({(r["workload"], r["threads"], r["arm"]) for r in results},
                         {(w, t, a) for w in WORKLOADS for t in THREADS for a in ARMS})
        for row in results:
            with self.subTest(row=(row["workload"], row["threads"], row["arm"])):
                self.assertEqual(set(row), RESULT_FIELDS)
                calls_per_op = 1 if row["workload"] == "pooled_read" else 3
                self.assertEqual(row["calls_per_repetition"], row["threads"] * 3 * calls_per_op)
                for field in ("median_ns_per_call", "p90_ns_per_call"):
                    self.assertIsInstance(row[field], float)
                    self.assertGreater(row[field], 0)
                self.assertGreaterEqual(row["p90_ns_per_call"], 0)
                if row["arm"] == "plain":
                    self.assertEqual((row["delta_median_ns_vs_plain"], row["delta_p90_ns_vs_plain"],
                                      row["delta_median_pct_vs_plain"]), (0.0, 0.0, 0.0))

    def test_accepts_no_path_url_or_endpoint_and_bounds_its_run(self):
        for args in (("--data-root", "C:/"), ("--endpoint", "http://127.0.0.1:1"), ("C:/data",),
                     ("--repetitions", "0"), ("--statements", "0"), ("--warmup", "-1"),
                     ("--repetitions", "1001")):
            with self.subTest(args=args):
                result = run(*args)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
