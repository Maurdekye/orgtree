import json
import importlib.util
import ipaddress
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
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
            # Simulate a legacy/foreign hub row containing a hostile id.  The
            # public send path rejects it, but the client must remain safe even
            # if an authenticated peer or old hub already persisted one.
            with service._server.db() as con:
                con.execute("UPDATE messages SET id='..' WHERE id='lost-attachment'")
                con.execute("UPDATE attachments SET message_id='..' WHERE message_id='lost-attachment'")
                con.commit()
            sentinel = root / "client-b" / "mail-blobs" / "staged-outbound.txt"
            sentinel.write_text("must survive", encoding="utf-8")
            # Remove the hub transport copy to simulate a failed download.
            with service._server.db() as con:
                aid = con.execute("SELECT id FROM attachments").fetchone()["id"]
            (root / "v2-data" / "hub" / "blobs" / aid).unlink()
            first = b.poll_once()
            self.assertIn("error", first[0]["attachments"][0])
            self.assertTrue(sentinel.is_file())
            self.assertTrue((root / "client-b" / "mail-blobs").is_dir())
            second = b.poll_once()
            self.assertEqual(second[0]["id"], "..")
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
                con.execute("INSERT INTO outbox (id,payload,attachments,created_at,attempts,next_attempt,state,last_error) VALUES (?,?,?,?,?,?,?,?)", ("overflow", "{}", "[]", "now", 1023, None, "queued", None))
                con.commit()
            self.assertEqual(a._record_attempt("overflow", "offline"), "queued")
            service.stop()

    @unittest.skipUnless(os.name == "nt", "Windows ACL behavior is platform-specific")
    def test_readiness_acl_failure_closes_listener_and_removes_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            with patch("engine.hub.service.HubService._restrict_windows_readiness_acl", side_effect=OSError("forced ACL failure")):
                with self.assertRaises(OSError):
                    service.start()
            self.assertIsNone(service._server)
            self.assertIsNone(service.readiness)
            self.assertFalse(service.readiness_path.exists())
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", service.port), timeout=0.2)
            timed = HubService(root / "v2-data-timeout")
            original_unlink = Path.unlink
            unlink_state = {"blocked": True}

            def fail_readiness_unlink(path: Path, missing_ok: bool = False):
                if path.name.startswith(".readiness-") and unlink_state["blocked"]:
                    unlink_state["blocked"] = False
                    raise PermissionError("forced cleanup unlink failure")
                return original_unlink(path, missing_ok=missing_ok)

            with patch("engine.hub.service.HubService._restrict_windows_readiness_acl", side_effect=OSError("forced ACL failure")), patch("engine.hub.service.subprocess.run", side_effect=subprocess.TimeoutExpired("icacls", 15)) as reset_run, patch.object(Path, "unlink", new=fail_readiness_unlink):
                with self.assertRaises(OSError):
                    timed.start()
            self.assertEqual(reset_run.call_count, 1)
            self.assertIsNone(timed._server)
            self.assertFalse(timed.readiness_path.exists())
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", timed.port), timeout=0.2)

    @unittest.skipUnless(os.name == "nt", "Windows ACL behavior is platform-specific")
    def test_readiness_acl_is_effective_and_serving_starts_after_protection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "v2-data")
            original_acl = service._restrict_windows_readiness_acl
            checks: list[Path] = []

            def observe_before_serving(path: Path):
                checks.append(path)
                with self.assertRaises(Exception):
                    urlopen(Request(f"http://127.0.0.1:{service.port}/healthz", headers={"X-Hub-Token": "probe"}), timeout=0.2)
                return original_acl(path)

            with patch.object(service, "_restrict_windows_readiness_acl", side_effect=observe_before_serving):
                ready = service.start()
            self.assertEqual(len(checks), 2)
            principal = subprocess.check_output(["whoami"], text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).strip()
            acl = subprocess.check_output(["icacls", str(Path(ready.readiness_path))], text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertIn(principal.lower(), acl.lower())
            self.assertNotIn("(I)", acl)
            service.stop()

    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "cryptography is required for TLS fixture generation")
    def test_tls_requires_trusted_ca_and_rejects_wrong_certificate(self):
        from datetime import datetime, timedelta
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        def material(root: Path, stem: str) -> tuple[Path, Path]:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
            cert = (
                x509.CertificateBuilder()
                .subject_name(name)
                .issuer_name(name)
                .public_key(key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(datetime.utcnow() - timedelta(minutes=1))
                .not_valid_after(datetime.utcnow() + timedelta(days=1))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
                .sign(key, hashes.SHA256())
            )
            cert_path, key_path = root / f"{stem}.crt", root / f"{stem}.key"
            cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
            return cert_path, key_path

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cert, key = material(root, "server")
            wrong_ca, _ = material(root, "wrong")
            service = HubService(root / "v2-data", tls_certfile=cert, tls_keyfile=key, tls_ca_file=cert)
            ready = service.start()
            self.assertTrue(ready.tls)
            self.assertEqual(discover_hub(root / "v2-data").tls_ca_file, str(cert.resolve()))
            client = HubClient(root / "client", f"https://127.0.0.1:{ready.port}", "org.tls.tttttt", "secret-tls", ready.token, ca_file=cert)
            self.assertTrue(client.register()["ok"])
            wrong = HubClient(root / "wrong-client", f"https://127.0.0.1:{ready.port}", "org.bad.bbbbbb", "secret-bad", ready.token, ca_file=wrong_ca)
            with self.assertRaises(Exception):
                wrong.register()
            service.stop()


if __name__ == "__main__":
    unittest.main()
