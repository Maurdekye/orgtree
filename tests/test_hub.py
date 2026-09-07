import json
import tempfile
import unittest
from pathlib import Path
from urllib.request import urlopen

from engine.hub import AttachmentPathError, HubClient, HubService, discover_hub


class HubIntegrationTests(unittest.TestCase):
    def test_two_clients_retry_dedup_ack_attachment_and_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            readiness = service.start()
            self.assertEqual(discover_hub(root / "v2-data").port, readiness.port)
            self.assertEqual(readiness.host, "127.0.0.1")
            self.assertGreater(readiness.port, 0)
            self.assertTrue(Path(readiness.readiness_path).is_file())
            with urlopen(f"http://{readiness.host}:{readiness.port}/healthz") as response:
                self.assertTrue(json.loads(response.read())["ok"])

            a = HubClient(root / "client-a", f"http://127.0.0.1:{readiness.port}", "org.a.aaaaaa", "secret-a")
            b = HubClient(root / "client-b", f"http://127.0.0.1:{readiness.port}", "org.b.bbbbbb", "secret-b")
            a.register("A")
            b.register("B")
            source = root / "note.txt"
            source.write_text("attachment bytes", encoding="utf-8")

            sent = a.send(b.slug, "hello", message_id="message-1", attachments=[source])
            self.assertEqual(sent["state"], "sent")
            received = b.poll_once()
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["id"], "message-1")
            self.assertEqual(received[0]["attachments"][0]["name"], "note.txt")
            self.assertEqual(b.poll_once(), [])
            receipt = a.poll_once()
            self.assertEqual(receipt, [])

            # Stop the service and prove send remains durable rather than
            # claiming local success.  Restarting discovers a new dynamic port.
            service.stop()
            queued = a.send(b.slug, "offline", message_id="message-2", attachments=[source])
            self.assertEqual(queued["state"], "queued")
            self.assertEqual(len(list((root / "client-a" / "mail-blobs").rglob("*"))), 2)
            service.start()
            a.hub_url = f"http://127.0.0.1:{service.readiness.port}"
            b.hub_url = a.hub_url
            self.assertEqual(len(a.flush()), 1)
            self.assertEqual(b.poll_once()[0]["id"], "message-2")
            service.stop()
            self.assertFalse(Path(readiness.readiness_path).exists())

    def test_invalid_attachment_path_is_rejected_before_spooling(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            service.start()
            a = HubClient(root / "client-a", f"http://127.0.0.1:{service.port}", "org.a.aaaaaa", "secret-a")
            b = HubClient(root / "client-b", f"http://127.0.0.1:{service.port}", "org.b.bbbbbb", "secret-b")
            a.register()
            b.register()
            with self.assertRaises(AttachmentPathError):
                a.send(b.slug, "bad", attachments=[root / "missing.txt"])
            with a._db() as con:
                self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
            service.stop()


if __name__ == "__main__":
    unittest.main()
