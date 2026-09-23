"""Provider runners can hand their exact spawn to the service bridge.

These fakes exercise only the callback seam; no service, credential or
provider CLI is started.
"""

import io
import tempfile
import unittest

import import_provenance  # noqa: F401
from orgtree import antigravityrun, codexrun
from orgtree import service_process
from unittest.mock import patch


class FinishedProcess:
    pid = 12345
    returncode = 0

    def __init__(self):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO()
        self.stderr = io.BytesIO()

    def poll(self):
        return 0


class ProcessFactoryTests(unittest.TestCase):
    def test_bridge_factory_uses_unique_lease_for_each_process(self):
        calls = []
        def fake_spawn(turn_id, argv, cwd, env, **options):
            calls.append((turn_id, argv, cwd, env, options))
            return object()
        with patch("engine.bridge_client.spawn", side_effect=fake_spawn):
            first = service_process.bridged_binary([r"C:\tool.exe"],
                                                    r"C:\work", {})
            second = service_process.bridged_text([r"C:\tool.exe"],
                                                   r"C:\work", {})
        self.assertIsNot(first, second)
        self.assertNotEqual(calls[0][0], calls[1][0])
        self.assertEqual(calls[0][4], {})
        self.assertEqual(calls[1][4],
                         {"text": True, "encoding": "utf-8", "errors": "replace"})

    def test_codex_app_server_uses_supplied_binary_process(self):
        calls = []
        def factory(argv, cwd, env):
            calls.append((argv, cwd, env))
            return FinishedProcess()
        with tempfile.TemporaryDirectory() as cwd:
            client = codexrun.AppServerClient(
                [r"C:\test\codex.exe"], cwd=cwd,
                env_extra={"ORGTREE_TEST_MARK": "yes"}, process_factory=factory)
            try:
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][0][-1], "app-server")
                self.assertEqual(calls[0][1], cwd)
                self.assertEqual(calls[0][2]["ORGTREE_TEST_MARK"], "yes")
                self.assertIsInstance(client.proc.stdin, io.BytesIO)
            finally:
                client.close()

    def test_antigravity_turn_uses_supplied_binary_process(self):
        calls = []
        def factory(argv, cwd, env):
            calls.append((argv, cwd, env))
            return FinishedProcess()
        with tempfile.TemporaryDirectory() as cwd:
            turn = antigravityrun.AntigravityTurn(
                [r"C:\test\agy.exe"], cwd=cwd, model="gemini-test",
                effort=None, process_factory=factory)
            try:
                turn.launch()
                self.assertEqual(len(calls), 1)
                self.assertIn("--model", calls[0][0])
                self.assertEqual(calls[0][1], cwd)
                self.assertIsInstance(turn.proc.stdout, io.BytesIO)
            finally:
                turn.close()

    def test_service_git_prompt_settings_override_child_environment(self):
        env = {"GIT_TERMINAL_PROMPT": "1", "GCM_INTERACTIVE": "always",
               "GIT_ASKPASS": "unsafe-helper", "SSH_ASKPASS": "unsafe-helper"}
        with patch("engine.bridge_client.available", return_value=True):
            service_process.harden_git_env(env)
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(env["GCM_INTERACTIVE"], "never")
        self.assertEqual(env["GIT_ASKPASS"], "")
        self.assertEqual(env["SSH_ASKPASS"], "")
        self.assertEqual(env["SSH_ASKPASS_REQUIRE"], "never")


if __name__ == "__main__":
    unittest.main()
