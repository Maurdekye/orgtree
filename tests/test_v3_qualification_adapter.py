"""Real HTTP adapter regression: a refusal must not hide an injected mutation.

Only the request return seam injects the fault; the extra state change uses the
production public work update. Later legitimate updates overwrite its progress
text, reproducing the review's false pass if the snapshot check is removed.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO/"tools"),str(REPO/"engine/backend"),str(REPO)]
from v3_qualification.runner import child_env

_fixture = tempfile.TemporaryDirectory(prefix="v3-qualification-refusal-")
_root = Path(_fixture.name).resolve()
(_root/"data").mkdir()
(_root/"home").mkdir()
_environment = child_env(_root)
os.environ.clear()
os.environ.update(_environment)

from v3_qualification.backend import Backend


class RefusalAdapterTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend(REPO,_root)
        self.backend.slug = self._testMethodName.replace("_","-")
        self.backend.fixture(1)
        self.addCleanup(self.backend.close)

    @classmethod
    def tearDownClass(cls):
        _fixture.cleanup()

    def test_positive_controls_pass_without_injection(self):
        result = self.backend.controls()
        self.assertEqual(result["classification"],"passed",result)
        self.assertEqual(result["errors"],[])

    def test_changed_payload_refusal_cannot_hide_a_public_update(self):
        self.inject_and_assert("changed-payload")

    def test_stale_revision_refusal_cannot_hide_a_public_update(self):
        self.inject_and_assert("stale-revision")

    def test_stale_authorization_refusal_cannot_hide_a_public_update(self):
        self.inject_and_assert("stale-authorization")

    def inject_and_assert(self, target):
        request = self.backend.request
        injected = []

        def faulty(tool,args,**kw):
            response = request(tool,args,**kw)
            name = ("changed-payload" if tool == "orgtree_op_call" and response.status_code == 409 else
                    "stale-revision" if tool == "orgtree_work" and args.get("action") == "update" and response.status_code == 422 else
                    "stale-authorization" if response.status_code == 403 else "")
            if name == target and not injected:
                inner = args["args"] if tool == "orgtree_op_call" else args
                item = inner["slug"]
                before = request("orgtree_work",{"action":"get","slug":item}).json()["item"]
                update = request("orgtree_work",{"action":"update","slug":item,"expected_rev":before["rev"],
                    "done_so_far":["forbidden update injected after refusal"],"working_on_next":[]})
                self.assertEqual(update.status_code,200,update.text)
                injected.append(item)
            return response

        with patch.object(self.backend,"request",side_effect=faulty):
            result = self.backend.controls()
        self.assertEqual(len(injected),1)
        self.assertEqual(result["classification"],"failed",result)
        self.assertIn(f"{target} refusal changed the public item state",result["errors"])
        self.assertEqual(result["observed"]["expected_control_rev"],4)
        self.assertEqual(result["observed"]["actual_control_rev"],5)


if __name__ == "__main__":
    unittest.main()
