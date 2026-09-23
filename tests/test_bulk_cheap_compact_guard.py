"""The operator `cheap_compact` op's opt-in mid-turn guard (`if_idle`).

Docket add-bulk-cheap-compact-context-menu-actions: the renderer's bulk
actions ("Cheap-compact all agents…", "Cheap-compact subtree…") must never swap
the session of an agent that is running a turn. The single action has no such
guard and keeps its behaviour; the bulk run sends `if_idle`, and the backend
re-checks the supervisor's busy flag under the document lock so an agent that
STARTED a turn after the run was planned is refused (409) with nothing changed.
"""

import os
import tempfile
import unittest
from unittest.mock import patch

_tmp = tempfile.mkdtemp(prefix="bulk-cheap-compact-")
os.environ.setdefault("ORGTREE_DATA", os.path.join(_tmp, "data"))
os.environ.pop("ORGTREE_AGENT_PARENT_DATA", None)
os.environ.pop("ORGTREE_AGENT_LEGACY_DATA", None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import api  # noqa: E402
from engine.backend.orgtree.ledger import Org, USER  # noqa: E402

SLUG = "bulk-cc-test"


def _fixture() -> Org:
    org = Org.create(SLUG)
    tools = {"bash": True, "web": False, "edit": False,
             "subagents": False, "mcp": []}
    org.hire(USER, None, "haiku", 2, "lead", [], tools=tools)
    org.hire(USER, "lead", "haiku", 0, "worker", [], tools=tools)
    return org


class IfIdleGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.org = _fixture()
        self.saved: list[Org] = []
        self._patches = [
            patch.object(api.store, "load_org", return_value=self.org),
            patch.object(api.store, "save_org",
                         side_effect=lambda o: self.saved.append(o)),
            patch.object(api, "hub_changed"),
            patch.object(api.supervisor, "export_predecessor_transcript"),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self._patches])
        self._busy_keys: list[tuple[str, str]] = []
        self.addCleanup(self._clear_busy)

    def _set_busy(self, nid: str) -> None:
        api.supervisor.state(SLUG, nid)["busy"] = True
        self._busy_keys.append((SLUG, nid))

    def _clear_busy(self) -> None:
        for slug, nid in self._busy_keys:
            api.supervisor.state(slug, nid)["busy"] = False

    def _op(self, **kw: object) -> dict:
        return api._org_op_locked(SLUG, api.Op(op="cheap_compact", **kw))

    def test_if_idle_refuses_a_mid_turn_agent_and_changes_nothing(self) -> None:
        self._set_busy("worker")
        sid = self.org.node("worker")["session_id"]
        with self.assertRaises(api.HTTPException) as raised:
            self._op(node="worker", if_idle=True)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("mid-turn", str(raised.exception.detail))
        self.assertEqual(self.org.node("worker")["session_id"], sid)
        self.assertNotIn("worker@0", self.org.nodes)
        self.assertEqual(self.saved, [], "a refused bulk target was saved")

    def test_if_idle_compacts_an_idle_agent(self) -> None:
        sid = self.org.node("worker")["session_id"]
        result = self._op(node="worker", if_idle=True)
        self.assertEqual(result["node"], "worker")
        self.assertNotEqual(self.org.node("worker")["session_id"], sid)
        self.assertIn(result["bearer"], self.org.nodes)
        self.assertEqual(len(self.saved), 1)

    def test_single_action_without_if_idle_is_unchanged(self) -> None:
        # the existing single cheap-compact keeps its behaviour exactly: the
        # guard is opt-in and nothing else about the op moved
        self._set_busy("worker")
        sid = self.org.node("worker")["session_id"]
        self._op(node="worker")
        self.assertNotEqual(self.org.node("worker")["session_id"], sid)

    def test_if_idle_keeps_the_ordinary_unknown_node_refusal(self) -> None:
        with self.assertRaises(api.HTTPException) as raised:
            self._op(node="nobody", if_idle=True)
        self.assertEqual(raised.exception.status_code, 422)

    def test_if_idle_keeps_the_existing_eligibility_checks(self) -> None:
        # an agent with open background tasks is refused by the ledger exactly
        # as the single action is — the guard adds a check, it removes none
        self.org.node("worker")["bg_open"] = True
        with self.assertRaises(api.HTTPException) as raised:
            self._op(node="worker", if_idle=True)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("background", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
