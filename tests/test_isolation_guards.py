"""The P02 isolated-copy replay guards (``tests/isolation_guards.py``) and
harness (``tools/p02_copy_replay.py``), on SYNTHETIC data only.

Two layers, because each proves something the other cannot:

- IN-PROCESS decision tests drive the audit hook's dispatcher directly,
  WITHOUT installing it (a hook can never be removed, and this test process
  must stay usable). They pin every refusal rule and every allowance.
- SUBPROCESS tests run the tool, whose children install the hooks for real
  before any product import. Every negative control there must be refused AND
  counted, and the effect it attempted must be absent afterwards — a control
  that did not fire fails, so a green run cannot come from a guard that never
  ran.
- CONTAINMENT: the same controls with every guard replaced by a no-op (what a
  broken guard or a guard-weakening mutant leaves) must all FAIL and leave the
  host untouched — no registry key, nothing outside the test's folder.

NO PRODUCT CODE runs in this module, so it is the one guard-weakening mutants
target. The product end to end (root pinning, the synthetic gate) lives in
``tests/test_p02_replay_gate.py`` and runs only with the guards intact.

Nothing here reads, lists or copies a real Orgtree root: every root is a new
temporary directory, and the protected "live" roots the children see are
decoys inside it (plus the real ones, which they only refuse).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import isolation_guards as ig

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "p02_copy_replay.py"
BASE_TMP = os.environ.get("P02_HARNESS_TMP") or None


def run_tool(*argv: str, env: dict[str, str] | None = None,
             timeout: float = 600) -> tuple[int, dict | None, str]:
    proc = subprocess.run([sys.executable, "-I", "-B", str(TOOL), *argv],
                          capture_output=True, text=True, timeout=timeout,
                          env=env if env is not None else dict(os.environ))
    last = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                last = json.loads(line)
            except ValueError:
                pass
    return proc.returncode, last, proc.stdout + proc.stderr


class Temp(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="p02-guards-", dir=BASE_TMP)
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.decoy = self.tmp / "decoy-live"
        self.decoy.mkdir()
        (self.decoy / "secret.txt").write_text("decoy", encoding="utf-8")


# ---------------------------------------------------------------------------
# protected roots
# ---------------------------------------------------------------------------

class PinnedRoots(unittest.TestCase):
    def test_live_root_comes_from_the_variable_and_always_from_appdata(self):
        pinned = ig.pinned_protected_roots({
            "ORGTREE_AGENT_PARENT_DATA": r"D:\live\data", "APPDATA": r"C:\U\x\AppData\Roaming",
            "USERPROFILE": r"C:\U\x"})
        self.assertEqual(pinned["live"], [r"D:\live\data",
                                          os.path.join(r"C:\U\x\AppData\Roaming", "Orgtree v2",
                                                       "data")])
        self.assertIn(os.path.join(r"C:\U\x", "orgtree"), pinned["legacy"])
        for name in (".claude", ".codex", ".gemini"):
            self.assertIn(os.path.join(r"C:\U\x", name), pinned["other"])

    def test_without_the_variables_appdata_still_pins_the_live_root(self):
        # review A3: removing the variable must not remove the protection
        pinned = ig.pinned_protected_roots({"APPDATA": r"C:\U\x\AppData\Roaming"})
        self.assertEqual(pinned["live"], [os.path.join(r"C:\U\x\AppData\Roaming",
                                                       "Orgtree v2", "data")])

    def test_refuses_when_no_live_root_can_be_established(self):
        with self.assertRaises(ig.RefuseToRun):
            ig.pinned_protected_roots({"USERPROFILE": r"C:\U\x"})
        with self.assertRaises(ig.RefuseToRun):
            ig.pinned_protected_roots({"ORGTREE_AGENT_PARENT_DATA": "relative\\path"})

    def test_overlap_is_refused_in_both_directions(self):
        root = ig.normal(r"C:\p02\live")
        with self.assertRaises(ig.RefuseToRun):
            ig.refuse_overlap("x", r"C:\p02\live\copy", [root])
        with self.assertRaises(ig.RefuseToRun):
            ig.refuse_overlap("x", r"C:\p02", [root])
        ig.refuse_overlap("x", r"C:\p02\live-copy", [root])

    def test_a_write_root_inside_a_protected_root_is_refused(self):
        with self.assertRaises(ig.RefuseToRun):
            ig.Policy(write_roots=[r"C:\p02\live\x"], protected_roots=[r"C:\p02\live"])


# ---------------------------------------------------------------------------
# hook decisions, driven directly (never installed here)
# ---------------------------------------------------------------------------

class HookDecisions(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.gettempdir()) / "p02-decisions-not-created"
        self.write = self.base / "run"
        self.live = self.base / "live"
        self.report = ig.Report()
        self.policy = ig.Policy(write_roots=[str(self.write)], protected_roots=[str(self.live)])
        self.hook = ig._Hook(self.policy, self.report)

    def refused(self, event: str, *args: object) -> str:
        with self.assertRaises(ig.GuardRefused, msg=event):
            self.hook(event, args)
        return self.report.details[-1]["guard"]

    def allowed(self, event: str, *args: object) -> None:
        before = self.report.total()
        self.hook(event, args)
        self.assertEqual(self.report.total(), before, event)

    def test_writes_are_confined_to_the_write_roots(self):
        self.allowed("open", str(self.write / "a.txt"), "w", 0)
        self.assertEqual(self.refused("open", str(self.base / "a.txt"), "w", 0), "write")
        self.assertEqual(self.refused("open", str(self.base / "a.txt"), "rb+", 0), "write")
        self.assertEqual(self.refused("open", str(self.base / "a.txt"), None,
                                      os.O_WRONLY | os.O_CREAT), "write")
        self.assertEqual(self.refused("open", str(self.live / "a.txt"), "a", 0), "write")
        # audit names, not function names (review A5)
        self.assertEqual(self.refused("os.rename", str(self.write / "a"), str(self.base / "b"),
                                      -1, -1), "write")
        self.assertEqual(self.refused("os.rename", str(self.base / "a"), str(self.write / "b"),
                                      -1, -1), "write")
        self.assertEqual(self.refused("os.remove", str(self.base / "a"), -1), "write")
        self.assertEqual(self.refused("shutil.rmtree", str(self.base), None), "write")
        self.assertEqual(self.refused("tempfile.mkstemp", str(self.base / "t")), "write")
        self.allowed("os.remove", str(self.write / "a"), -1)
        self.allowed("open", 3, "wb", 0)  # an fd: already-open, not a path

    def test_protected_roots_refuse_reads_except_listed_files(self):
        self.assertEqual(self.refused("open", str(self.live / "orgs" / "x.db"), "rb", 0), "read")
        self.assertEqual(self.refused("os.listdir", str(self.live)), "read")
        self.assertEqual(self.refused("os.scandir", str(self.live / "orgs")), "read")
        self.assertEqual(self.refused("glob.glob", str(self.live / "*" / "*.jsonl"), False),
                         "read")
        self.assertEqual(self.refused("shutil.copyfile", str(self.live / "s"),
                                      str(self.write / "s")), "read")
        self.allowed("open", str(self.base / "elsewhere.txt"), "r", 0)
        self.policy.read_exceptions.add(ig.normal(self.live / "orgs" / "x.db"))
        self.allowed("open", str(self.live / "orgs" / "x.db"), "rb", 0)
        self.assertEqual(self.refused("open", str(self.live / "orgs" / "y.db"), "rb", 0), "read")
        self.policy.list_exceptions.add(ig.normal(self.live / "orgs"))
        self.allowed("os.listdir", str(self.live / "orgs"))

    def test_sqlite_connect_is_checked_by_the_file_it_opens(self):
        self.allowed("sqlite3.connect", ":memory:")
        self.allowed("sqlite3.connect", "file::memory:?cache=shared")
        self.allowed("sqlite3.connect", str(self.write / "a.db"))
        self.assertEqual(self.refused("sqlite3.connect", str(self.base / "a.db")), "write")
        self.assertEqual(self.refused("sqlite3.connect", str(self.live / "a.db")), "read")
        uri = "file:///" + str(self.live / "a.db").replace("\\", "/") + "?mode=ro"
        self.assertEqual(self.refused("sqlite3.connect", uri), "read")

    def test_process_kill_and_egress_are_refused(self):
        for event, args in (("subprocess.Popen", ("x", ["git", "status"], None, None)),
                            ("_winapi.CreateProcess", (None, "cmd", None)),
                            ("os.system", ("exit",)), ("os.startfile", ("f", "open")),
                            ("os.spawn", (0, "x", [], None)), ("os.exec", ("x", [], None)),
                            ("webbrowser.open", ("http://x",))):
            self.assertEqual(self.refused(event, *args), "process")
        self.assertEqual(self.report.details[0]["detail"], "git")
        self.assertEqual(self.refused("os.kill", 1234, 15), "kill")
        # what Popen.kill/terminate reach on Windows
        self.assertEqual(self.refused("_winapi.OpenProcess", 1234, 0x0001), "kill")
        self.assertEqual(self.refused("_winapi.TerminateProcess", 99, 1), "kill")
        self.assertEqual(self.refused("socket.connect", object(), ("192.0.2.1", 9)), "egress")
        self.assertEqual(self.refused("socket.connect", object(), ("127.0.0.1", 9)), "egress")
        self.assertEqual(self.refused("socket.sendto", object(), ("8.8.8.8", 53)), "egress")
        self.assertEqual(self.refused("socket.getaddrinfo", "example.com", 80, 0, 0, 0),
                         "egress")
        self.assertEqual(self.refused("socket.bind", object(), ("0.0.0.0", 0)), "egress")
        self.allowed("socket.bind", object(), ("127.0.0.1", 0))

    def test_ctypes_refuses_process_registry_and_file_symbols_and_network_libraries(self):
        self.assertEqual(self.refused("ctypes.dlsym", object(), "OpenProcess"), "kill")
        self.assertEqual(self.refused("ctypes.dlsym", object(), "CreateProcessW"), "kill")
        self.assertEqual(self.refused("ctypes.dlsym", object(), "RegSetValueExW"), "registry")
        self.assertEqual(self.refused("ctypes.dlsym", object(), "CreateFileW"), "write")
        self.assertEqual(self.refused("ctypes.dlopen", "ws2_32"), "kill")
        self.assertEqual(self.refused("ctypes.dlopen", r"C:\x\winhttp.dll"), "kill")
        self.allowed("ctypes.dlopen", "kernel32")
        self.allowed("ctypes.dlsym", object(), "GetTickCount64")
        self.policy.ctypes_symbols.add("CreateFileW")
        self.allowed("ctypes.dlsym", object(), "CreateFileW")

    def test_registry_writes_are_refused_and_reads_pass(self):
        self.assertEqual(self.refused("winreg.CreateKey", 0, "Software\\x", 0), "registry")
        self.assertEqual(self.refused("winreg.SetValue", 0, "v", 1, "x"), "registry")
        self.assertEqual(self.refused("winreg.OpenKey", 0, "Software", 0x20006), "registry")
        self.allowed("winreg.OpenKey", 0, "Software", 0x20019)

    def test_shares_and_devices_are_egress_on_the_raw_path(self):
        # decided on the RAW text: normal() would realpath, which opens it
        for event, args in (("open", (r"\\server\share\x.txt", "r", 0)),
                            ("open", (r"\\.\pipe\orgtree", "rb", 0)),
                            ("open", ("//server/share/x", "w", 0)),
                            ("os.listdir", (r"\\server\share",)),
                            ("sqlite3.connect", (r"\\server\share\x.db",)),
                            ("sqlite3.connect", ("file://server/share/x.db",)),
                            ("_winapi.CreateFile", (r"\\.\pipe\x", 0x80000000, 0, 3, 0)),
                            ("ctypes.dlopen", (r"\\server\share\kernel32.dll",))):
            with self.subTest(event=event, path=args[0]):
                self.assertEqual(self.refused(event, *args), "egress")
        # the long-path form of a LOCAL file is a local file
        self.allowed("open", "\\\\?\\" + str(self.base / "elsewhere.txt"), "r", 0)

    def test_winapi_createfile_junction_and_pipe_server(self):
        generic_read, generic_write = 0x80000000, 0x40000000
        a, w = str(self.base / "a"), str(self.write / "a")
        self.assertEqual(self.refused("_winapi.CreateFile", a, generic_write, 0, 3, 0), "write")
        self.assertEqual(self.refused("_winapi.CreateFile", a, generic_read, 0, 2, 0), "write")
        self.assertEqual(self.refused("_winapi.CreateFile", a, generic_read, 0, 3, 0x04000000),
                         "write")
        # MAXIMUM_ALLOWED may grant write, so it is judged as one (review R2)
        self.assertEqual(self.refused("_winapi.CreateFile", a, 0x02000000, 0, 3, 0), "write")
        self.assertEqual(self.refused("_winapi.CreateFile", str(self.live / "a"), generic_read,
                                      0, 3, 0), "read")
        self.allowed("_winapi.CreateFile", a, generic_read, 0, 3, 0)
        self.allowed("_winapi.CreateFile", w, generic_write, 0, 2, 0)
        self.assertEqual(self.refused("_winapi.CreateJunction", w, str(self.base / "j")), "write")
        self.assertEqual(self.refused("_winapi.CreateNamedPipe", r"\\.\pipe\x", 3, 0), "egress")

    def test_loader_symbols_and_ordinal_lookups_are_refused(self):
        for name in ("LoadLibraryW", "LoadLibraryExA", "GetProcAddress", "LdrLoadDll",
                     "LdrGetProcedureAddress"):
            with self.subTest(name):
                self.assertEqual(self.refused("ctypes.dlsym", object(), name), "kill")
        self.assertEqual(self.refused("ctypes.dlsym", object(), 42), "kill")
        self.assertEqual(self.refused("ctypes.dlsym/handle", 0, 7), "kill")

    def test_refusals_count_by_guard_event_and_route(self):
        self.report.route = "chat"
        self.refused("os.kill", 1, 15)
        self.refused("os.kill", 1, 15)
        self.assertEqual(self.report.refused[("kill", "os.kill", "chat")], 2)
        self.assertEqual(self.report.total("kill"), 2)
        self.assertEqual(self.report.as_json()["refused_total"], 2)


class WakeGuard(unittest.TestCase):
    def test_only_the_passive_paths_pass(self):
        calls = []
        stub = types.SimpleNamespace(**{n: (lambda *a, _n=n, **k: calls.append(_n))
                                        for n in ig.WAKE_ENTRY_POINTS if n != "reconcile"})
        report = ig.Report()
        wrapped = ig.install_wake_guard(stub, report)
        self.assertNotIn("reconcile", wrapped)  # absent from this build: not claimed
        stub.send_message("s", "n", "x", wake=False)
        stub.drive_unfrozen_by_switch("s", [])
        for call in (lambda: stub.send_message("s", "n", "x"),
                     lambda: stub.send_message("s", "n", "x", wake=True, mail_ping=True),
                     lambda: stub.drive_unfrozen_by_switch("s", ["n"]),
                     lambda: stub.drive_account_unpark("s", "n"),
                     lambda: stub.drive_auth_thaw("s", "n"),
                     lambda: stub.resume_frozen("s"),
                     lambda: stub.deliver_org_inbox("s", "p", "b"),
                     lambda: stub.remote_reap("s")):
            with self.assertRaises(ig.GuardRefused):
                call()
        self.assertEqual(calls, ["send_message"])
        self.assertEqual(report.total("wake"), 8)
        self.assertEqual(ig.install_wake_guard(stub, report), [], "idempotent")

    def test_native_process_modules_become_unimportable_and_a_loaded_one_refuses(self):
        saved = {m: sys.modules[m] for m in ig.NATIVE_PROCESS_MODULES if m in sys.modules}
        try:
            for m in ig.NATIVE_PROCESS_MODULES:
                sys.modules.pop(m, None)
            self.assertEqual(ig.block_native_process_modules(), ["psutil"])
            with self.assertRaises(ImportError):
                import psutil  # noqa: F401
            sys.modules["psutil"] = types.ModuleType("psutil")
            with self.assertRaises(ig.RefuseToRun):
                ig.block_native_process_modules()
        finally:
            for m in ig.NATIVE_PROCESS_MODULES:
                sys.modules.pop(m, None)
            sys.modules.update(saved)

    def test_a_product_import_before_the_guards_is_refused(self):
        added = "engine" not in sys.modules
        if added:
            sys.modules["engine"] = types.ModuleType("engine")
        try:
            with self.assertRaises(ig.RefuseToRun):
                ig.assert_no_product_imports()
        finally:
            if added:
                del sys.modules["engine"]


# ---------------------------------------------------------------------------
# real hooks, in the tool's own children
# ---------------------------------------------------------------------------

class NegativeControls(Temp):
    def test_every_guard_route_refuses_counts_and_leaves_no_effect(self):
        run = self.tmp / "controls"
        code, last, out = run_tool("controls", "--run", str(run), "--protect", str(self.decoy))
        self.assertEqual(code, 0, out[-2000:])
        doc = json.loads((run / "out" / "controls.json").read_text("utf-8"))
        controls = doc["controls"]
        required = {"write_outside", "os_open_outside", "replace_outside", "unlink_outside",
                    "mkdir_outside", "rmtree_protected", "read_protected", "listdir_protected",
                    "copy_from_protected", "sqlite_protected", "sqlite_outside", "popen",
                    "os_system", "os_spawn", "os_startfile", "os_kill", "tcp_connect",
                    "tcp_connect_loopback", "udp_connect", "getaddrinfo", "bind_non_loopback",
                    "httpx_sync", "httpx_async", "asyncio_default_loop", "wake_send_message",
                    "wake_drive_account_unpark", "wake_drive_auth_thaw", "wake_resume_frozen",
                    "wake_deliver_org_inbox", "wake_drive_unfrozen_nonempty"}
        if os.name == "nt":
            required |= {"winapi_createprocess", "winapi_openprocess", "ctypes_openprocess",
                         "ctypes_network_library", "ctypes_createfile", "ctypes_registry_write",
                         "asyncio_proactor_loop", "winreg_create", "winreg_open_write"}
        self.assertEqual(sorted(required - set(controls)), [], "a control did not run")
        for name in required:
            with self.subTest(name):
                c = controls[name]
                self.assertTrue(c["refused"], c)
                self.assertGreaterEqual(c["delta"], 1, c)
                self.assertTrue(c.get("effect_absent", True), c)
                self.assertIn(c["containment"], ("fails", "local", "content"), c)
        for name in ("write_inside", "socketpair", "bind_loopback", "read_unprotected",
                     "wake_notice_passes", "wake_drive_unfrozen_empty"):
            with self.subTest(name):
                self.assertTrue(controls[name]["passed"], controls[name])
        self.assertEqual(doc["stub_leaks"], [])
        self.assertEqual(doc["missing"], [], "the tool's own required-control check")
        self.assertEqual(doc["undeclared_containment"], [])
        self.assertTrue(doc["own_child_alive"], "the control's own child was killed")
        # each async layer proven on its own: the forced selector loop by an
        # audited connect, the Proactor backstop by its own refusal
        self.assertIn("socket.connect", controls["asyncio_default_loop"]["events"])
        if os.name == "nt":
            self.assertIn("IocpProactor.connect", controls["asyncio_proactor_loop"]["events"])
        # nothing acted outside the run, nor on the caller's --protect folder
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["controls", "decoy-live"])
        self.assertEqual(sorted(p.name for p in self.decoy.iterdir()), ["secret.txt"])
        self.assertEqual(list((run / "not-allowed").iterdir()), [])
        self.assertTrue((run / "decoy-protected" / "secret.txt").exists())
        self.assertFalse((run / "absent").exists())
        self.assertTrue(registry_canary_absent())


def registry_canary_absent() -> bool:
    if os.name != "nt":
        return True
    import winreg
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\orgtree-p02-decoy"))
        return False
    except OSError:
        return True


#: A child that runs the controls with every guard REPLACED BY A NO-OP: the
#: state a broken guard, or a guard-weakening mutant, would leave. Test code
#: only — the runnable tool has no way to skip its guards (review A4).
UNGUARDED_CONTROLS = """
import importlib.util, sys
root, run = sys.argv[1], sys.argv[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

ig = load("isolation_guards", root + "/tests/isolation_guards.py")
ig.install_audit_guards = lambda policy, report: None
ig.force_selector_loop = lambda: None
ig.block_proactor_connect = lambda report: None
ig.install_wake_guard = lambda supervisor, report: []
tool = load("p02_copy_replay", root + "/tools/p02_copy_replay.py")
sys.exit(tool.main(["controls", "--run", run]))
"""


class ContainmentWhenGuardsFail(Temp):
    """The negative control FOR the negative controls. Every refusal is
    missing here, so every forbidden action is really attempted — and the
    proof is that the host is still untouched: every "fails" control's OS call
    failed, and nothing exists outside this test's temporary folder.

    ⚠ WHAT IT CANNOT SEE (review N5): whether ``os_system`` started a
    ``cmd.exe`` (its "content" class: the command is a no-op either way), and
    network traffic as such — no packet capture. The egress controls are
    contained by construction instead (closed sockets; our own listener with
    ``trust_env=False``, so no proxy). ``os_startfile`` on a missing file is
    expected to fail without any window; watch its first execution for a
    shell dialog or the 300 s timeout (review N4)."""

    def test_every_control_fails_and_nothing_leaves_the_run(self):
        self.assertTrue(registry_canary_absent(), "canary present before the test")
        run = self.tmp / "controls"
        env = {k: v for k, v in os.environ.items()}
        proc = subprocess.run([sys.executable, "-I", "-B", "-c", UNGUARDED_CONTROLS,
                               str(ROOT), str(run)],
                              capture_output=True, text=True, env=env, timeout=300)
        self.assertEqual(proc.returncode, 4, proc.stdout[-1500:] + proc.stderr[-1500:])
        doc = json.loads((run / "out" / "controls.json").read_text("utf-8"))
        self.assertEqual(doc["verdict"], "failed")
        self.assertEqual(doc["missing"], [], "every control ran")
        self.assertEqual(doc["undeclared_containment"], [])
        negatives = {n: c for n, c in doc["controls"].items() if not c.get("positive")}
        self.assertGreaterEqual(len(negatives), 30)
        for name, c in negatives.items():
            with self.subTest(name):
                self.assertFalse(c["refused"], c)
                self.assertEqual(c["delta"], 0, c)
                self.assertFalse(c["passed"], c)
                if c["containment"] == "fails":
                    # the OS call behind the audit event could not succeed
                    self.assertIn("exception", c, c)
        # the host: no registry key, nothing outside the run, the caller's
        # decoy untouched (it was never passed to the child at all)
        self.assertTrue(registry_canary_absent(), "a control reached the registry")
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["controls", "decoy-live"])
        self.assertEqual(sorted(p.name for p in self.decoy.iterdir()), ["secret.txt"])
        self.assertFalse((run / "absent").exists())


class StaticChecks(unittest.TestCase):
    def test_no_disable_switch_in_the_runnable_tool(self):
        text = TOOL.read_text(encoding="utf-8")
        for word in ("--no-root-check", "--skip-root", "--unsafe", "--disable", "bypass"):
            self.assertNotIn(word, text)

    def test_controls_never_take_a_caller_pid(self):
        # the kill controls aim only at the command's own child
        text = TOOL.read_text(encoding="utf-8")
        start = text.index('sub.add_parser("controls")')
        end = text.index("sub.add_parser", start + 1)
        self.assertNotIn("--decoy-pid", text[start:end])

    def test_every_negative_control_declares_its_containment(self):
        spec = importlib.util.spec_from_file_location("p02_copy_replay_static", TOOL)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        negatives = (set(tool.REQUIRED_CONTROLS) | set(tool.REQUIRED_CONTROLS_NT)) - {
            "write_inside", "socketpair", "bind_loopback", "read_unprotected",
            "wake_notice_passes", "wake_drive_unfrozen_empty"}
        self.assertEqual(sorted(negatives - set(tool.CONTAINMENT)), [])
        self.assertEqual(set(tool.CONTAINMENT.values()) - {"fails", "local", "content"}, set())


def ig_exit_refused() -> int:
    return 3


class CopyStep(Temp):
    def make_source(self) -> Path:
        src = self.tmp / "source"
        (src / "orgs").mkdir(parents=True)
        for name in ("alpha", "beta"):
            with sqlite3.connect(src / "orgs" / f"{name}.db") as c:
                c.execute("PRAGMA journal_mode=WAL")
                c.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, val TEXT)")
                c.execute("INSERT INTO meta VALUES ('schema_version', '1')")
            c.close()
        with sqlite3.connect(src / "tool-waits.db") as c:
            c.execute("CREATE TABLE t (i)")
        c.close()
        return src

    def listing(self, root: Path) -> dict:
        return {str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
                for p in sorted(root.rglob("*")) if p.is_file()}

    def test_copies_without_touching_the_source_and_skips_a_journal(self):
        src = self.make_source()
        before = self.listing(src)
        code, last, out = run_tool("snapshot", "--source", str(src), "--protect", str(src),
                                   "--run", str(self.tmp / "copy"), "--wait", "0.1")
        self.assertEqual(code, 0, out[-1500:])
        self.assertEqual(self.listing(src), before, "the copy step changed the source")
        self.assertEqual(last["refused_total"], 0)
        self.assertEqual(last["classes"]["org_db"]["copied"], 2)
        self.assertEqual(last["classes"]["tool_waits"]["copied"], 1)
        master = self.tmp / "copy" / "master" / "data"
        with sqlite3.connect(master / "orgs" / "alpha.db") as c:
            self.assertEqual(c.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        c.close()
        manifest = (self.tmp / "copy" / "out" / "copy-manifest.json").read_text("utf-8")
        self.assertNotIn("alpha", manifest, "file names must not leave the run (N1)")
        (src / "orgs" / "beta.db-journal").write_bytes(b"")
        code, last, out = run_tool("snapshot", "--source", str(src), "--protect", str(src),
                                   "--run", str(self.tmp / "copy2"), "--tries", "2",
                                   "--wait", "0.1")
        self.assertEqual(code, 0, out[-1500:])
        self.assertEqual(last["classes"]["org_db"]["skipped_reasons"], {"journal": 1})

    def test_refuses_a_source_that_is_not_protected(self):
        src = self.make_source()
        code, last, out = run_tool("snapshot", "--source", str(src),
                                   "--run", str(self.tmp / "copy"))
        self.assertEqual(code, ig_exit_refused(), out[-1500:])
        self.assertFalse((self.tmp / "copy").exists())


class CopyChangeDetection(Temp):
    """``copy_one``'s DIGEST comparison, driven deterministically. The gate's
    busy-copy check cannot prove it: a per-call writer's vanishing ``-wal``
    also forces retries (mutation run on e1d4d14: with the comparison
    removed, the gate stayed green). Here the source changes in place right
    after each copy, which only the digest comparison can see."""

    def setUp(self) -> None:
        super().setUp()
        spec = importlib.util.spec_from_file_location("p02_copy_replay_copy", TOOL)
        self.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.tool)
        self.src = self.tmp / "src" / "tool-waits.db"
        self.src.parent.mkdir()
        with sqlite3.connect(self.src) as c:
            c.execute("CREATE TABLE t (i)")
            c.execute("INSERT INTO t VALUES (1)")
        c.close()
        # the copy step's read check, which the guard provides in a real run
        self.hook = types.SimpleNamespace(_check_read=lambda event, path: None)

    def copy(self) -> dict:
        return self.tool.copy_one(str(self.src), "tool-waits.db", self.tmp / "stage",
                                  self.tmp / "master", self.hook, 3, 0, False)

    def test_a_source_changed_in_place_during_the_copy_is_retried_then_skipped(self):
        real, copied = self.tool._copy_bytes, []

        def copy_then_change(src, dst, hook):
            n = real(src, dst, hook)
            copied.append(src)
            with open(src, "ab") as f:  # an in-place write lands after our read
                f.write(b"\0")
            return n

        self.tool._copy_bytes = copy_then_change
        out = self.copy()
        self.assertEqual((out["status"], out["reason"], out["retries"]), ("skipped", "changed", 2))
        self.assertEqual(len(copied), 3, "every attempt really copied")
        self.assertFalse((self.tmp / "master" / "tool-waits.db").exists())

    def test_an_unchanged_source_is_copied_intact(self):
        out = self.copy()
        self.assertEqual((out["status"], out["retries"]), ("copied", 0))
        with sqlite3.connect(self.tmp / "master" / "tool-waits.db") as c:
            self.assertEqual(c.execute("SELECT i FROM t").fetchall(), [(1,)])
        c.close()


if __name__ == "__main__":
    unittest.main()
