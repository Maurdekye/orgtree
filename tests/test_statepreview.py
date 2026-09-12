"""W19 read-only inspection and transition-preview coverage."""

import json
import os
import tempfile
import unittest


# The ledger's provider projection imports the store module.  Give the test a
# throwaway root before importing backend modules; never use the live root.
_tmp = tempfile.mkdtemp(prefix="w19-statepreview-")
os.environ.setdefault("ORGTREE_DATA", os.path.join(_tmp, "data"))
os.environ.pop("ORGTREE_AGENT_PARENT_DATA", None)
os.environ.pop("ORGTREE_AGENT_LEGACY_DATA", None)

from engine.backend.orgtree import statepreview  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
