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

import json
import os
import subprocess
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from test_isolation_guards import ROOT, Temp, ig_exit_refused, run_tool


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
