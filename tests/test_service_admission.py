"""Service admission tests use synthetic accounts and no live credentials."""

import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
from orgtree import api, supervisor
from orgtree.service_custody import WAITING_FOR_SIGN_IN


class Org:
    d = {"slug": "isolated-test"}

    def __init__(self, account="selected"):
        self.account = account

    def node(self, _nid):
        return {"model": "sol", "account": self.account}


class AdmissionTests(unittest.TestCase):
    def test_service_boot_never_prewarms_unclassified_provider_processes(self):
        with patch("engine.bridge_client.available", return_value=True), \
             patch.object(api.warmpool, "start_warm_pool") as warm:
            api._start_provider_warm_pool()
            warm.assert_not_called()
        with patch("engine.bridge_client.available", return_value=False), \
             patch.object(api.warmpool, "start_warm_pool") as warm:
            api._start_provider_warm_pool()
            warm.assert_called_once_with()

    def test_gateway_key_is_service_safe_only_when_its_file_is_readable(self):
        org = Org("")
        org.node = lambda _nid: {"model": "or-example", "account": ""}
        with patch("engine.bridge_client.available", return_value=True), \
             patch.object(supervisor.openrouter, "key_set", return_value=True):
            self.assertEqual(supervisor._service_admission(
                org, "node", selected_identity=supervisor.OPENROUTER_IDENTITY
            ).decision, "service")
        with patch("engine.bridge_client.available", return_value=True), \
             patch.object(supervisor.openrouter, "key_set", return_value=False):
            self.assertEqual(supervisor._service_admission(org, "node").decision,
                             "unavailable")

    def test_selected_file_provider_runs_before_login_with_unknown_git(self):
        row = {"provider": "openai", "credential": {"kind": "managed"}}
        with patch("engine.bridge_client.available", return_value=True), \
             patch("engine.bridge_client.state", return_value={"bridge": "off"}), \
             patch.object(supervisor.registry, "validate_binding", return_value=row), \
             patch.object(supervisor.service_custody, "probe_provider_file",
                          return_value=True):
            decision = supervisor._service_admission(Org(), "node")
            self.assertEqual(decision.decision, "service")
            self.assertIsNone(supervisor._native_context_hold(Org(), "node"))

    def test_session_provider_holds_until_genuine_bridge_is_on(self):
        row = {"provider": "google", "credential": {"kind": "ambient"}}
        org = Org()
        org.node = lambda _nid: {"model": "pro", "account": "selected"}
        with patch("engine.bridge_client.available", return_value=True), \
             patch.object(supervisor.registry, "validate_binding", return_value=row), \
             patch.object(supervisor.service_custody, "probe_provider_file",
                          return_value=False), \
             patch("engine.bridge_client.state", return_value={"bridge": "off"}) as state:
            self.assertEqual(supervisor._native_context_hold(org, "node"),
                             WAITING_FOR_SIGN_IN)
            state.return_value = {"bridge": "on"}
            self.assertIsNone(supervisor._native_context_hold(org, "node"))
            self.assertTrue(supervisor._service_bridge_turn(org, "node"))
            state.return_value = {"bridge": "off"}
            self.assertEqual(supervisor._native_context_hold(org, "node"),
                             WAITING_FOR_SIGN_IN)

    def test_spawn_identity_is_rechecked_instead_of_reusing_preflight_choice(self):
        safe = {"id": "selected", "provider": "openai",
                "credential": {"kind": "managed"}}
        session = {"provider": "openai", "credential": {"kind": "unknown"}}
        with patch("engine.bridge_client.available", return_value=True), \
             patch("engine.bridge_client.state", return_value={"bridge": "on"}), \
             patch.object(supervisor.registry, "validate_binding", return_value=safe), \
             patch.object(supervisor.registry, "get_account", return_value=session), \
             patch.object(supervisor.service_custody, "probe_provider_file",
                          return_value=True):
            self.assertEqual(supervisor._service_admission(Org(), "node").decision,
                             "service")
            self.assertEqual(supervisor._service_admission(
                Org(), "node", selected_identity="actual-spawn").decision,
                "unavailable")


if __name__ == "__main__":
    unittest.main()
