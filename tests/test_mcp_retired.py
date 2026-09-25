"""The retired @mcp: address form (user ruling 2026-09-25: outside chats use
the built-in mail hub exclusively; coordinator decisions 2 and 4 on
`the-external-chat-mcp-server-cannot-reach-the-v2`).

Stage 1 removed the external-chat MCP server and refused NEW @mcp: sends.
This file pins the behaviour that only source-hash tests caught before
(reviewer finding f1): a bare name must never auto-resolve to an OLD @mcp:
correspondent still sitting in the org inbox. Before the retirement the
ledger offered `@mcp:<name>` from inbox history ahead of the mail hub; now
the name takes exactly the path it would take with no @mcp: history at all.
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="mcp-retired-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store


def tearDownModule():
    store._POOL.close_all("mcp-retired")
    _root.cleanup()


def _org_with_old_mcp_correspondent() -> ledger.Org:
    org = ledger.Org.create("mcp-retired-" + uuid.uuid4().hex[:8])
    org.hire(ledger.USER, None, "haiku", 0, "top")
    # history from before the retirement: bob asked, the org answered
    org._org_inbox_log("in", "@mcp:bob", "an old question")
    org._org_inbox_log("out", "@mcp:bob", "an old answer", by="top")
    return org


class BareNameNeverResolvesToOldMcp(unittest.TestCase):
    def test_no_hub_match_is_the_ordinary_unknown_recipient_refusal(self):
        org = _org_with_old_mcp_correspondent()
        rows = len(org.d["org_inbox"])
        with patch.object(ledger, "external_candidates", lambda name: {}):
            with self.assertRaises(ledger.LedgerError) as cm:
                org.post_mail("top", "bob", "hello again")
        msg = str(cm.exception)
        self.assertIn("no agent named 'bob'", msg)
        self.assertNotIn("@mcp:", msg)
        self.assertNotEqual(msg, ledger.MCP_RETIRED)
        self.assertEqual(len(org.d["org_inbox"]), rows, "a refused send recorded a row")

    def test_a_hub_match_wins_over_the_old_mcp_correspondent(self):
        org = _org_with_old_mcp_correspondent()
        with patch.object(ledger, "external_candidates",
                          lambda name: {"net": [name]} if name == "bob" else {}):
            result = org.post_mail("top", "bob", "hello again")
        self.assertEqual(result["delivered"], "@net:bob")
        self.assertEqual(org.d["org_inbox"][-1]["peer"], "@net:bob")

    def test_the_explicit_mcp_form_is_still_refused(self):
        org = _org_with_old_mcp_correspondent()
        with self.assertRaises(ledger.LedgerError) as cm:
            org.post_mail("top", "@mcp:bob", "hello again")
        self.assertEqual(str(cm.exception), ledger.MCP_RETIRED)


if __name__ == "__main__":
    unittest.main()
