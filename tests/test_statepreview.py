"""W19 read-only inspection and transition-preview coverage."""

import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


# The ledger's provider projection imports the store module.  Give the test a
# throwaway root before importing backend modules; never use the live root.
_tmp = tempfile.mkdtemp(prefix="w19-statepreview-")
os.environ.setdefault("ORGTREE_DATA", os.path.join(_tmp, "data"))
os.environ.pop("ORGTREE_AGENT_PARENT_DATA", None)
os.environ.pop("ORGTREE_AGENT_LEGACY_DATA", None)

from engine.backend.orgtree import statepreview  # noqa: E402
from engine.backend.orgtree import api  # noqa: E402
from engine.backend.orgtree.ledger import LedgerError, Org, USER  # noqa: E402


def _fixture() -> Org:
    org = Org.create("w19-test")
    tools = {"bash": True, "web": False, "edit": False,
             "subagents": False, "mcp": []}
    org.hire(USER, None, "haiku", 4, "manager", [], tools=tools,
             org_visibility="subtree")
    org.hire(USER, "manager", "haiku", 0, "child", [], tools=tools,
             org_visibility="subtree")
    org.hire(USER, None, "haiku", 0, "peer", [], tools=tools,
             org_visibility="self")
    return org


class StateInspectionTests(unittest.TestCase):
    def test_scope_projection_excludes_peer_and_private_axes(self) -> None:
        org = _fixture()
        out = statepreview.inspect_state(org, "manager")
        self.assertEqual({row["id"] for row in out["nodes"]}, {"manager", "child"})
        encoded = json.dumps(out)
        self.assertNotIn("session_id", encoded)
        self.assertNotIn("resume_texts", encoded)
        with self.assertRaises(LedgerError):
            statepreview.inspect_state(org, "manager", ["peer"])


class TransitionPreviewTests(unittest.TestCase):
    def test_preview_matches_reallocate_without_mutating_source(self) -> None:
        org = _fixture()
        before = json.dumps(org.d, sort_keys=True)
        out = statepreview.preview(
            org, USER, "reallocate", {"node": "manager", "delta": 1})
        self.assertFalse(out["applied"])
        self.assertTrue(any(change["path"].endswith(".grant")
                            for change in out["changes"]))
        self.assertEqual(before, json.dumps(org.d, sort_keys=True))

    def test_preview_keeps_ordinary_authority_checks(self) -> None:
        org = _fixture()
        with self.assertRaises(LedgerError):
            statepreview.preview(
                org, "manager", "reallocate", {"node": "peer", "delta": 1})

    def test_move_batch_requires_the_normal_new_parent_shape(self) -> None:
        org = _fixture()
        with self.assertRaises(LedgerError):
            statepreview.preview(
                org, USER, "move", {"moves": [{"node": "child"}]})

    def test_agent_capabilities_report_the_real_move_tool(self) -> None:
        org = _fixture()
        out = api._agent_capability_payload(org, "manager")
        self.assertIn("orgtree_move", out["agent_only"])
        self.assertNotIn("orgtree_move_batch", out["agent_only"])

    def test_agent_retool_preview_keeps_account_validation(self) -> None:
        org = _fixture()
        body = api.AgentCall(
            org="w19-test", node="manager", tool="orgtree_preview",
            args={"operation": "retool", "args": {
                "node": "child", "account": "not-a-real-account"}})
        request = SimpleNamespace(state=SimpleNamespace())
        with patch.object(api.store, "load_org", return_value=org):
            with self.assertRaises(api.HTTPException) as raised:
                api.agent_call(body, request)
        self.assertEqual(raised.exception.status_code, 422)

    def test_agent_retool_preview_runs_directory_translation(self) -> None:
        org = _fixture()
        body = api.AgentCall(
            org="w19-test", node="manager", tool="orgtree_preview",
            args={"operation": "retool", "args": {
                "node": "child", "add_dirs": [{"path": "/container/grant"}]}})
        request = SimpleNamespace(state=SimpleNamespace())
        with patch.object(api.store, "load_org", return_value=org), \
                patch.object(api.supervisor, "sandbox_dirs_to_host",
                             return_value=([], [])) as translated:
            api.agent_call(body, request)
        translated.assert_called_once_with(org, [{"path": "/container/grant"}])

    def test_agent_switch_preview_keeps_account_gate(self) -> None:
        org = _fixture()
        body = api.AgentCall(
            org="w19-test", node="manager", tool="orgtree_preview",
            args={"operation": "switch_model", "args": {
                "node": "child", "tier": "haiku", "account": "bad"}})
        request = SimpleNamespace(state=SimpleNamespace())
        with patch.object(api.store, "load_org", return_value=org), \
                patch.object(api, "provider_hire_gate"), \
                patch.object(api.supervisor, "check_switch_account",
                             side_effect=ValueError("account refused")):
            with self.assertRaises(api.HTTPException) as raised:
                api.agent_call(body, request)
        self.assertEqual(raised.exception.status_code, 422)

    def test_public_operator_preview_is_blocked(self) -> None:
        org = _fixture()
        body = api.Op(op="reallocate", preview=True, node="manager", delta=1)
        request = SimpleNamespace(state=SimpleNamespace())
        with patch.object(api, "_public_slug", return_value="w19-test"), \
                patch.object(api.store, "load_org", return_value=org):
            with self.assertRaises(api.HTTPException) as raised:
                api.org_op("w19-test", body, request)
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
