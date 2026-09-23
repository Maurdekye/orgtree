"""User-mail attachments are uncapped while outside transport limits remain."""

import os
import filecmp
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException


_ROOT = tempfile.TemporaryDirectory(prefix="v2-user-mail-attachments-")
_DATA = Path(_ROOT.name) / "data"
_HOME = Path(_ROOT.name) / "home"
_DATA.mkdir()
_HOME.mkdir()
os.environ.update(ORGTREE_DATA=str(_DATA), HOME=str(_HOME),
                  USERPROFILE=str(_HOME), ORGTREE_V2_TOKEN="operator")
for _key in ("ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_PORT"):
    os.environ.pop(_key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

load_app()
from orgtree import api, ledger, mcptool, store, supervisor  # noqa: E402


_ORGS: list[str] = []
_REQUEST = SimpleNamespace(state=SimpleNamespace())


def tearDownModule() -> None:
    for slug in _ORGS:
        store._POOL.close_all(slug)
    _ROOT.cleanup()


class UserMailAttachmentLimitTests(unittest.TestCase):
    def _org_with_file(self, slug: str, name: str, data: bytes) -> Path:
        _ORGS.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, "haiku", 0, "sender")
        store.save_org(org)
        path = Path(supervisor.scratch_dir(slug, "sender")) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def _message(self, slug: str, **args: object) -> dict[str, object]:
        return api.agent_call(
            api.AgentCall(org=slug, node="sender", tool="orgtree_message",
                          args={"to": "user", "body": "attached", **args}),
            _REQUEST,
        )

    def test_user_mail_accepts_over_25mb_and_preserves_exact_download_bytes(self):
        # 256 MiB + 1 is the former user-mail ceiling (_SENDFILE_MAX), not
        # merely the separate 25 MiB @net ceiling. Seek creates a bounded,
        # sparse fixture on the test filesystem without allocating a giant
        # Python bytes object; the final byte makes the content non-empty.
        size = 256 * 1024 * 1024 + 1
        _ORGS.append("user-large")
        org = store.create_org("user-large")
        org.hire(ledger.USER, None, "haiku", 0, "sender")
        store.save_org(org)
        source = Path(supervisor.scratch_dir("user-large", "sender")) / "installer.bin"
        source.parent.mkdir(parents=True, exist_ok=True)
        with source.open("wb") as handle:
            handle.seek(size - 1)
            handle.write(b"Z")

        # The default path is still capped for standalone send_file/present;
        # user mail opts out explicitly below.
        with self.assertRaises(ledger.LedgerError):
            api._agent_send_file(store.load_org("user-large"), "sender",
                                 {"path": source.name})

        result = self._message("user-large", attachments=[source.name])
        self.assertEqual(result["delivered"], "user_inbox")

        org = store.load_org("user-large")
        attachment = org.d["user_inbox"][-1]["attachments"][0]
        self.assertEqual(attachment["name"], "installer.bin")
        self.assertEqual(attachment["bytes"], size)
        stored = (Path(supervisor.scratch_dir("user-large", "sender")) /
                  "outbox" / "installer.bin")
        self.assertEqual(stored.stat().st_size, size)
        self.assertTrue(filecmp.cmp(source, stored, shallow=False))

    def test_missing_or_copy_failed_attachment_creates_no_user_mail(self):
        self._org_with_file("user-failure", "present.txt", b"present")

        with self.assertRaises(HTTPException) as missing:
            self._message("user-failure", attachments=["missing.bin"])
        self.assertEqual(missing.exception.status_code, 422)
        self.assertEqual(store.load_org("user-failure").d.get("user_inbox", []), [])

        with patch.object(api.shutil, "copy2",
                          side_effect=OSError("simulated storage failure")):
            with self.assertRaises(HTTPException) as failed:
                self._message("user-failure", attachments=["present.txt"])
        self.assertEqual(failed.exception.status_code, 422)
        self.assertEqual(store.load_org("user-failure").d.get("user_inbox", []), [])

    def test_net_attachment_cap_remains_25mb(self):
        size = 25 * 1024 * 1024 + 1
        source = self._org_with_file("net-capped", "large.bin", b"x" * size)
        org = store.load_org("net-capped")
        org.d["net_hubs"] = [{"enabled": True}]
        store.save_org(org)

        with patch.object(api, "_require_net_peer"):
            with self.assertRaises(HTTPException) as capped:
                api.agent_call(
                    api.AgentCall(
                        org="net-capped", node="sender", tool="orgtree_message",
                        args={"to": "@net:peer", "body": "attached",
                              "attachments": [source.name]}),
                    _REQUEST,
                )
        self.assertEqual(capped.exception.status_code, 422)
        self.assertIn("25 MB", str(capped.exception.detail))

    def test_message_tool_description_distinguishes_user_and_net_limits(self):
        card = next(t for t in mcptool.available_tools()
                    if t["name"] == "orgtree_message")
        description = card["inputSchema"]["properties"]["attachments"]["description"]
        self.assertIn("no product per-file byte cap", description)
        self.assertIn("@net:", description)
        self.assertIn("25 MB per-file cap", description)


if __name__ == "__main__":
    unittest.main()
