"""The P02 replay harness end to end: tests that run REAL PRODUCT CODE under
the guards (``tests/isolation_guards.py``), on SYNTHETIC data only.

⚠ RUN THIS MODULE ONLY WITH THE GUARDS INTACT. Here the guard is the only
barrier between product code and the host: a replay arm follows whatever the
fixture names (PIDs, paths), and a weakened rule lets it act for real.
Guard-weakening mutants target ``tests/test_isolation_guards.py`` (decisions,
controls, copy step — no product import); mutants of the TOOL's own logic
(copy change detection, journal skip), which leave the guards whole, may
run here.

- Root pinning: an arm whose data root sits inside a protected root refuses
  before ``load_app``; so does the guarded child on its own, and without either
  pinning variable; devguard refuses independently when the harness check is
  bypassed. The internal writers (``_writer``, ``_fixture-child``) pin the
  live root on their own too, and leave a decoy live root byte-identical.
- The synthetic gate: builds a synthetic org, copies it while a writer is
  active, replays arms B and C twice each, and checks the realistic live-path
  vector (a copied transcript source pointing into a protected folder) is
  refused inside product code.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import isolation_guards as ig
from test_isolation_guards import ROOT, TOOL, Temp, ig_exit_refused, run_tool


class RootPinning(Temp):
    def test_the_harness_refuses_a_data_root_inside_a_protected_root(self):
        inside = self.decoy / "data"
        inside.mkdir()
        code, last, out = run_tool("arm", "--tree", str(ROOT), "--arm", "C", "--run",
                                   str(self.decoy), "--data", str(inside),
                                   "--protect", str(self.decoy))
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertIs(last["load_app_called"], False)

    def test_the_guarded_child_refuses_on_its_own_variable(self):
        inside = self.decoy / "data"
        inside.mkdir()
        env = {k: os.environ[k] for k in ("SystemRoot", "PATH") if k in os.environ}
        env.update(ORGTREE_AGENT_PARENT_DATA=str(self.decoy), ORGTREE_DATA=str(inside))
        code, last, out = run_tool("_arm-child", "--tree", str(ROOT), "--arm", "C", "--run",
                                   str(self.decoy), "--data", str(inside), "--out",
                                   str(self.tmp / "x.json"), env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertIs(last["load_app_called"], False)
        env.pop("ORGTREE_AGENT_PARENT_DATA")
        code, last, out = run_tool("_arm-child", "--tree", str(ROOT), "--arm", "C", "--run",
                                   str(self.tmp), "--data", str(self.tmp / "d"), "--out",
                                   str(self.tmp / "x.json"), env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertIn("cannot establish the live root", last["reason"])

    def test_pinning_survives_removing_both_variables(self):
        fake_live = self.tmp / "appdata" / "Orgtree v2" / "data"
        (fake_live / "x").mkdir(parents=True)
        env = {k: v for k, v in os.environ.items()
               if k not in ("ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA")}
        env["APPDATA"] = str(self.tmp / "appdata")
        code, last, out = run_tool("arm", "--tree", str(ROOT), "--arm", "C", "--run",
                                   str(fake_live), "--data", str(fake_live / "x"), env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])

    def test_devguard_refuses_at_store_import_when_the_harness_check_is_bypassed(self):
        # plan §4 step 3(b). The bypass is THIS test importing the store
        # directly; the runnable tool has no switch that disables its check
        # (review A4).
        inside = self.decoy / "data"
        inside.mkdir()
        env = {k: os.environ[k] for k in ("SystemRoot", "PATH") if k in os.environ}
        env.update(ORGTREE_AGENT_PARENT_DATA=str(self.decoy), ORGTREE_DATA=str(inside),
                   HOME=str(self.tmp), USERPROFILE=str(self.tmp))
        code = ("import sys; sys.path[:0] = [sys.argv[1]]\n"
                "try:\n    import orgtree.store\nexcept RuntimeError as e:\n"
                "    print('REFUSED', 'independent ORGTREE_DATA' in str(e)); sys.exit(7)\n"
                "print('IMPORTED'); sys.exit(0)\n")
        proc = subprocess.run([sys.executable, "-I", "-B", "-c", code,
                               str(ROOT / "engine" / "backend")],
                              capture_output=True, text=True, env=env, timeout=300)
        self.assertEqual(proc.returncode, 7, proc.stdout + proc.stderr)
        self.assertIn("REFUSED True", proc.stdout)


class InternalChildrenPinTheLiveRoot(Temp):
    """Review B1: the two internal WRITERS (``_writer``, ``_fixture-child``)
    establish the live root themselves, like ``_arm-child``: with nothing
    inherited in P02_PROTECTED they still refuse a target inside the live
    root, and they refuse outright when the live root is not given."""

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: os.environ[k] for k in ("SystemRoot", "PATH") if k in os.environ}
        env.update(P02_PROTECTED="[]", **extra)
        return env

    def decoy_bytes(self) -> dict[str, bytes]:
        return {str(p.relative_to(self.decoy)): p.read_bytes()
                for p in sorted(self.decoy.rglob("*")) if p.is_file()}

    def test_a_target_inside_the_live_root_is_refused_and_left_byte_identical(self):
        target = self.decoy / "data"
        (target / "orgs").mkdir(parents=True)
        (target / "tool-waits.db").write_bytes(b"decoy sidecar")
        before = self.decoy_bytes()
        env = self.env(ORGTREE_AGENT_PARENT_DATA=str(self.decoy), ORGTREE_DATA=str(target))
        code, last, out = run_tool("_writer", "--target", str(target), "--org-db", "x.db",
                                   "--seconds", "1", env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        code, last, out = run_tool("_fixture-child", "--tree", str(ROOT), "--data", str(target),
                                   "--run", str(self.tmp / "logs"), "--decoy",
                                   str(self.tmp / "d"), env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertEqual(self.decoy_bytes(), before)

    def test_both_refuse_when_the_live_root_is_not_given(self):
        target = self.tmp / "data"
        (target / "orgs").mkdir(parents=True)
        env = self.env(ORGTREE_DATA=str(target))
        for argv in (("_writer", "--target", str(target), "--org-db", "x.db", "--seconds", "1"),
                     ("_fixture-child", "--tree", str(ROOT), "--data", str(target), "--run",
                      str(self.tmp / "logs"), "--decoy", str(self.decoy))):
            with self.subTest(argv[0]):
                code, last, out = run_tool(*argv, env=env)
                self.assertEqual(code, ig_exit_refused(), out[-1500:])
                self.assertIn("cannot establish the live root", last["reason"])
        self.assertEqual([p.name for p in target.rglob("*")], ["orgs"])

    def test_the_fixture_refuses_when_orgtree_data_names_another_root(self):
        target = self.tmp / "data"
        target.mkdir()
        env = self.env(ORGTREE_AGENT_PARENT_DATA=str(self.decoy),
                       ORGTREE_DATA=str(self.tmp / "elsewhere"))
        code, last, out = run_tool("_fixture-child", "--tree", str(ROOT), "--data", str(target),
                                   "--run", str(self.tmp / "logs"), "--decoy", str(self.decoy),
                                   env=env)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertIn("ORGTREE_DATA does not name", last["reason"])
        self.assertEqual(list(target.iterdir()), [])


class SegmentedReplay(Temp):
    """The real-data replay must fit foreground calls: ``replay --round R``
    runs one round, measured segments are skipped, a crashed segment is
    redone, the master is frozen by digest, and ``replay-summary`` refuses an
    incomplete, unequal or other-master set. Synthetic master and expected
    refusals come from one small gate run; every arm uses this checkout."""

    N, ROUNDS = 40, 2

    def replay(self, *extra: str) -> tuple[int, dict | None, str]:
        return run_tool("replay", "--master", str(self.master), "--run", str(self.run),
                        "--tree", str(ROOT), "--tree-a", str(ROOT), "--expect-dir",
                        str(self.expect), "--rounds", str(self.ROUNDS), "--n", str(self.N),
                        *extra, timeout=1500)

    def summary(self, rounds: int) -> tuple[int, dict | None, str]:
        return run_tool("replay-summary", "--run", str(self.run), "--master", str(self.master),
                        "--rounds", str(rounds), "--n", str(self.N))

    def arm_doc(self, arm: str, rnd: int) -> dict:
        return json.loads((self.run / "out" / f"arm-{arm}-{rnd}.json").read_text("utf-8"))

    def test_round_skip_crash_redo_summary_and_every_refusal(self):
        gate = self.tmp / "gate"
        code, last, out = run_tool("gate", "--run", str(gate), "--tree", str(ROOT),
                                   "--tree-a", str(ROOT), "--n", str(self.N), timeout=1500)
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        self.expect = gate / "out"
        self.run = self.tmp / "replay"
        self.master = self.run / "master" / "data"
        shutil.copytree(gate / "copy" / "master" / "data", self.master)

        # round 1 runs its three arms; the master is frozen
        code, last, out = self.replay("--round", "1")
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        self.assertEqual([s.get("verdict") for s in last["segments"]], ["measured"] * 3)
        digest = self.arm_doc("A", 1)["segment"]["master_digest"]
        self.assertTrue(digest)
        some_file = next(p for p in self.master.rglob("*") if p.is_file())
        self.assertFalse(os.access(some_file, os.W_OK), "the master is read-only")
        before = self.arm_doc("B", 1)

        # round 1 again: skipped, nothing rewritten
        code, last, out = self.replay("--round", "1")
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        self.assertEqual([s.get("skipped") for s in last["segments"]], ["already measured"] * 3)
        self.assertEqual(self.arm_doc("B", 1), before)

        # a summary over an incomplete set is refused, naming what is missing
        code, last, out = self.summary(self.ROUNDS)
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertIn("round 2 arm A: missing", last["problems"])

        # a crashed segment whose earlier attempt is still alive (its process
        # names the fixture) STOPS the round: nothing is removed or started
        crashed = self.run / "arms" / "2-B" / "data"
        crashed.mkdir(parents=True)
        (crashed / "half-written.db").write_bytes(b"partial")
        orphan_path = os.path.join(ig.normal(str(self.run)), "arms", "2-B", "data")
        orphan = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(900)",
                                   orphan_path])
        try:
            code, last, out = self.replay("--round", "2")
        finally:
            orphan.kill()
            orphan.wait(timeout=60)
        self.assertEqual(code, 4, out[-1500:])
        self.assertIn("still use this fixture", last["stopped"])
        self.assertEqual(last["segments"], [])
        self.assertTrue((crashed / "half-written.db").exists(), "nothing was removed")
        self.assertEqual(sorted(p.name for p in (self.run / "out").glob("arm-*-2.json")), [])

        # once it is gone, the crashed segment is removed and redone
        code, last, out = self.replay("--round", "2")
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        redone = {s["arm"]: s.get("redone_after_crash") for s in last["segments"]}
        self.assertEqual(redone, {"B": True, "C": False, "A": False})
        self.assertFalse((crashed / "half-written.db").exists())

        # the complete set summarizes, with equal work
        code, last, out = self.summary(self.ROUNDS)
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        ab = json.loads((self.run / "out" / "ab-summary.json").read_text("utf-8"))
        self.assertTrue(ab["segmented"] and ab["summary"]["equal_work"])
        self.assertEqual(len(ab["runs"]), 3 * self.ROUNDS)

        # a result that did not measure stops the round: never retried silently
        path = self.run / "out" / "arm-C-2.json"
        good = path.read_text("utf-8")
        doc = json.loads(good)
        doc["verdict"] = "failed"
        path.write_text(json.dumps(doc), "utf-8")
        code, last, out = self.replay("--round", "2")
        self.assertEqual(code, 4, out[-1500:])
        self.assertIn("did not measure", last["stopped"])
        path.write_text(good, "utf-8")

        # a tampered master (a byte changed, a file added, a file removed) is
        # refused before any fixture copy, and so is a summary over it
        target = next(p for p in sorted(self.master.rglob("*"))
                      if p.is_file() and p.stat().st_size)
        original = target.read_bytes()
        added = self.master / "added.bin"

        def flip():
            os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
            target.write_bytes(bytes([original[0] ^ 1]) + original[1:])

        def remove():
            os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
            target.unlink()

        def restore():
            if added.exists():
                added.unlink()
            if target.exists():
                os.chmod(target, stat.S_IREAD | stat.S_IWRITE)
            target.write_bytes(original)

        arms_before = sorted(p.name for p in (self.run / "arms").iterdir())
        for name, tamper in (("byte changed", flip), ("file added", lambda: added.write_bytes(b"x")),
                             ("file removed", remove)):
            with self.subTest(name):
                tamper()
                try:
                    code, last, out = self.replay("--round", "1")
                    self.assertEqual(code, 4, out[-1500:])
                    self.assertIn("master copy changed", last["stopped"])
                    self.assertEqual(sorted(p.name for p in (self.run / "arms").iterdir()),
                                     arms_before)
                    code, last, out = self.summary(self.ROUNDS)
                    self.assertEqual(code, ig_exit_refused(), out[-1500:])
                    self.assertIn("master copy changed", last["reason"])
                finally:
                    restore()
        code, last, out = self.summary(self.ROUNDS)
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])

    def test_a_fixture_removal_outside_arms_is_refused(self):
        spec = importlib.util.spec_from_file_location("p02_copy_replay_seg", TOOL)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        run = self.tmp / "run"
        keep = run / "not-arms"
        (keep / "x").mkdir(parents=True)
        (run / "arms").mkdir()
        for target in (keep, run / "arms", run, self.tmp):
            with self.subTest(str(target.relative_to(self.tmp.parent))):
                with self.assertRaises(ig.RefuseToRun):
                    tool._remove_fixture(run, target, ig)
        self.assertTrue((keep / "x").is_dir(), "nothing outside arms/ was removed")
        inside = run / "arms" / "1-A"
        (inside / "data").mkdir(parents=True)
        tool._remove_fixture(run, inside, ig)
        self.assertFalse(inside.exists())


class EndToEndGate(Temp):
    def test_synthetic_gate_passes_with_every_check_executed(self):
        run = self.tmp / "gate"
        code, last, out = run_tool("gate", "--run", str(run), "--tree", str(ROOT),
                                   "--n", "40", timeout=1500)
        verdict = json.loads((run / "out" / "gate-verdict.json").read_text("utf-8"))
        self.assertEqual(code, 0, json.dumps(last) + out[-1500:])
        checks = verdict["checks"]
        for name in ("fixture", "copy_busy", "copy_quiet", "copy_journal", "controls",
                     "pin_harness_refuses", "pin_child_refuses", "pin_without_variables",
                     "decoy_alive", "decoy_unchanged", "home_empty", "trees_unchanged",
                     "decoy_path_read_refused", "privacy_clean"):
            with self.subTest(name):
                self.assertTrue(checks[name]["passed"], checks[name])
        self.assertTrue(checks["copy_busy"]["change_detection_fired"])
        for arm in ("B", "C"):
            with self.subTest(arm):
                a = checks["arms"][arm]
                self.assertTrue(a["passed"] and a["repeatable"], a["confirm"]["gates"])
                self.assertEqual(a["confirm"]["observed"], 40)
                self.assertEqual(a["confirm"]["provenance"]["foreign"], [])
                self.assertTrue(a["confirm"]["provenance"]["commit"])
                self.assertIn("pth", a["confirm"]["provenance"]["interpreter"])
                self.assertEqual(a["confirm"]["native_blocked"], ["psutil"])
                self.assertTrue(a["confirm"]["gates"]["native_process_modules_blocked"])
                for d in a["discovery"]["refusal_details"]:
                    if d["route"] != "post-control":
                        self.assertNotEqual(d["where"], "-", d)
        self.assertIn(["read", "open", "chat"], checks["arms"]["C"]["expected_refusals"])


if __name__ == "__main__":
    unittest.main()
