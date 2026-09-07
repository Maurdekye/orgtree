import json
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

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
            with urlopen(Request(f"http://{readiness.host}:{readiness.port}/healthz", headers={"X-Hub-Token": readiness.token})) as response:
                self.assertTrue(json.loads(response.read())["ok"])

            a = HubClient(root / "client-a", f"http://127.0.0.1:{readiness.port}", "org.a.aaaaaa", "secret-a", readiness.token)
            b = HubClient(root / "client-b", f"http://127.0.0.1:{readiness.port}", "org.b.bbbbbb", "secret-b", readiness.token)
            a.register("A")
            b.register("B")
            unsafe_id = a.send(b.slug, "unsafe id", message_id="..")
            self.assertEqual(unsafe_id["state"], "queued")
            self.assertIn("malformed message id", unsafe_id["error"])
            self.assertEqual(b._inbox_destination("..").parent.resolve(), (b.blob_root / "inbox").resolve())
            # net.py multiplexes all identities configured for one hub in a
            # single request.  Each identity must carry its own scoped peer
            # token; one token must not grant access to the other identity.
            peer_a = a.create_peer("peer-a", a.slug)
            peer_b = a.create_peer("peer-b", b.slug)
            with self.assertRaises(Exception) as duplicate_peer:
                a.create_peer("peer-a", a.slug)
            self.assertEqual(getattr(duplicate_peer.exception, "status", None), 409)
            multi_headers = {
                "Content-Type": "application/json",
                "X-Org-Auth": f"{a.auth} {b.auth}",
                "X-Hub-Peer-Token": f"{peer_a['peer_token']} {peer_b['peer_token']}",
            }
            multi_payload = json.dumps({"from": b.slug, "to": a.slug, "body": "multiplexed", "id": "multiplexed-1"}).encode()
            with urlopen(Request(f"http://127.0.0.1:{readiness.port}/api/send", data=multi_payload, headers=multi_headers, method="POST")) as response:
                self.assertFalse(json.loads(response.read())["duplicate"])
            forged_multi = dict(multi_headers)
            forged_multi["X-Hub-Peer-Token"] = peer_a["peer_token"]
            with self.assertRaises(Exception) as forged_multi_error:
                urlopen(Request(f"http://127.0.0.1:{readiness.port}/api/send", data=multi_payload.replace(b"multiplexed-1", b"multiplexed-2"), headers=forged_multi, method="POST"))
            self.assertEqual(getattr(forged_multi_error.exception, "code", None), 401)
            multi_poll = Request(
                f"http://127.0.0.1:{readiness.port}/api/poll?wait=0",
                data=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "X-Org-Auth": f"{a.auth} {b.auth}",
                    "X-Hub-Peer-Token": f"{peer_a['peer_token']} {peer_b['peer_token']}",
                },
                method="POST",
            )
            with urlopen(multi_poll) as response:
                self.assertEqual(json.loads(response.read())["messages"][0]["id"], "multiplexed-1")
            a._request("POST", "/api/ack", {"ids": ["multiplexed-1"]})
            pairing = a.create_peer("peer-b-again", b.slug)
            self.assertEqual(pairing["slug"], b.slug)
            paired = HubClient(root / "client-paired", f"http://127.0.0.1:{readiness.port}", b.slug, "secret-b", pairing["peer_token"], peer_token=True)
            self.assertTrue(paired.roster()["roster"])
            forged = HubClient(root / "client-forged", f"http://127.0.0.1:{readiness.port}", a.slug, "secret-a", pairing["peer_token"], peer_token=True)
            with self.assertRaises(Exception) as forged_error:
                forged.register()
            self.assertEqual(forged_error.exception.status, 403)
            source = root / "note.txt"
            source.write_text("attachment bytes", encoding="utf-8")

            sent = a.send(b.slug, "hello", message_id="message-1", attachments=[source])
            self.assertEqual(sent["state"], "sent")
            duplicate = a.send(b.slug, "hello", message_id="message-1")
            self.assertTrue(duplicate["duplicate"])
            received = b.poll_once()
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["id"], "message-1")
            self.assertEqual(received[0]["attachments"][0]["name"], "note.txt")
            local_attachment = Path(received[0]["attachments"][0]["path"])
            self.assertEqual(local_attachment.read_text(encoding="utf-8"), "attachment bytes")
            self.assertEqual(list((root / "v2-data" / "hub" / "blobs").iterdir()), [])
            self.assertEqual(b.poll_once(), [])
            receipt = a.poll_once()
            self.assertEqual(receipt, [])
            self.assertEqual(a.roster()["roster"][0]["slug"], a.slug)
            self.assertEqual(b.poll_once(wait=0.2), [])
            oversized = a.send(b.slug, "x" * 20_001)
            self.assertEqual(oversized["state"], "queued")
            with a._db() as con:
                queued_body = json.loads(con.execute("SELECT payload FROM outbox WHERE id=?", (oversized["id"],)).fetchone()["payload"])["body"]
            self.assertEqual(len(queued_body), 20_001)  # rejected by hub, never silently truncated

            # Stop the service and prove send remains durable rather than
            # claiming local success.  Restarting discovers a new dynamic port.
            service.stop()
            queued = a.send(b.slug, "offline", message_id="message-2", attachments=[source])
            self.assertEqual(queued["state"], "queued")
            self.assertEqual(len(list((root / "client-a" / "mail-blobs").rglob("*"))), 2)
            service.start()
            a.hub_url = f"http://127.0.0.1:{service.readiness.port}"
            b.hub_url = a.hub_url
            a.instance_token = b.instance_token = service.readiness.token
            time.sleep(2.1)  # first offline retry is deliberately backoff-delayed
            self.assertEqual(len(a.flush()), 1)
            self.assertEqual(b.poll_once()[0]["id"], "message-2")
            service.stop()
            self.assertFalse(Path(readiness.readiness_path).exists())

    def test_token_required_and_attachment_failure_is_not_acked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            readiness = service.start()
            a = HubClient(root / "client-a", f"http://127.0.0.1:{service.port}", "org.a.aaaaaa", "secret-a", readiness.token)
            b = HubClient(root / "client-b", f"http://127.0.0.1:{service.port}", "org.b.bbbbbb", "secret-b", readiness.token)
            bad = HubClient(root / "client-bad", f"http://127.0.0.1:{service.port}", "org.bad.dddddd", "secret-bad", "x" * 40)
            a.register()
            b.register()
            with self.assertRaises(Exception) as unauthorized:
                bad.register()
            self.assertEqual(getattr(unauthorized.exception, "status", None), 401)
            source = root / "lost.txt"
            source.write_text("must retry", encoding="utf-8")
            a.send(b.slug, "attachment", message_id="lost-attachment", attachments=[source])
            # Remove the hub transport copy to simulate a failed download.
            with service._server.db() as con:
                aid = con.execute("SELECT id FROM attachments").fetchone()["id"]
            (root / "v2-data" / "hub" / "blobs" / aid).unlink()
            first = b.poll_once()
            self.assertIn("error", first[0]["attachments"][0])
            second = b.poll_once()
            self.assertEqual(second[0]["id"], "lost-attachment")
            service.stop()

    def test_invalid_attachment_path_is_rejected_before_spooling(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            service.start()
            a = HubClient(root / "client-a", f"http://127.0.0.1:{service.port}", "org.a.aaaaaa", "secret-a", service.readiness.token)
            b = HubClient(root / "client-b", f"http://127.0.0.1:{service.port}", "org.b.bbbbbb", "secret-b", service.readiness.token)
            a.register()
            b.register()
            with self.assertRaises(AttachmentPathError):
                a.send(b.slug, "bad", attachments=[root / "missing.txt"])
            with a._db() as con:
                self.assertEqual(con.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
            service.stop()


if __name__ == "__main__":
    unittest.main()
