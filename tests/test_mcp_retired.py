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


class ResponseHandlesAreRetired(unittest.TestCase):
    """Stage 2: no NEW @mcp: response handle can be granted, and a handle a
    node stored before the retirement is kept but has no effect."""

    def _org(self) -> ledger.Org:
        org = ledger.Org.create("mcp-handles-" + uuid.uuid4().hex[:8])
        org.hire(ledger.USER, None, "haiku", 0, "top")
        return org

    def test_hire_with_a_handle_is_refused_and_hires_nobody(self):
        org = self._org()
        with self.assertRaises(ledger.LedgerError) as cm:
            org.hire(ledger.USER, "top", "haiku", 0, "panel",
                     external_handles=["@mcp:wizard"])
        self.assertIn(ledger.HANDLES_RETIRED, str(cm.exception))
        self.assertNotIn("panel", org.nodes)

    def test_retool_with_a_handle_is_refused_but_an_empty_list_clears(self):
        org = self._org()
        org.nodes["top"]["external_handles"] = ["@mcp:wizard"]   # pre-retirement doc
        with self.assertRaises(ledger.LedgerError) as cm:
            org.set_scope(ledger.USER, "top", external_handles=["@mcp:other"])
        self.assertIn(ledger.HANDLES_RETIRED, str(cm.exception))
        self.assertEqual(org.nodes["top"]["external_handles"], ["@mcp:wizard"])
        org.set_scope(ledger.USER, "top", external_handles=[])
        self.assertNotIn("external_handles", org.nodes["top"])

    def test_a_stored_handle_survives_load_and_grants_nothing(self):
        org = self._org()
        org.hire(ledger.USER, "top", "haiku", 0, "child")
        org.nodes["child"]["external_handles"] = ["@mcp:wizard"]
        # through the REAL storage path (reviewer f2): a clear-on-load in
        # store.load_org must fail here, not only in source-hash tests
        store.save_org(org)
        loaded = store.load_org(org.d["slug"])
        self.assertEqual(loaded.nodes["child"]["external_handles"], ["@mcp:wizard"],
                         "a stored handle must not be cleared on load")
        # its own address is refused like any @mcp: send ...
        with self.assertRaises(ledger.LedgerError) as cm:
            loaded.post_mail("child", "@mcp:wizard", "progress")
        self.assertEqual(str(cm.exception), ledger.MCP_RETIRED)
        # ... and the handle no longer lets a non-holder speak for the org
        with self.assertRaises(ledger.LedgerError) as cm:
            loaded.post_mail("child", "@org:elsewhere", "hello")
        self.assertIn("ORG-INBOX audience holders", str(cm.exception))

    def test_the_identity_prompt_no_longer_advertises_a_stored_handle(self):
        from orgtree import supervisor
        org = self._org()
        org.nodes["top"]["external_handles"] = ["@mcp:wizard"]
        prompt = supervisor.identity_prompt(org, "top")
        self.assertNotIn("@mcp:wizard", prompt)
        self.assertNotIn("EXTERNAL RESPONSE HANDLE", prompt)


if __name__ == "__main__":
    unittest.main()
