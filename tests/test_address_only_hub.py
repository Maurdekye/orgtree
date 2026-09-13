import tempfile
import unittest
from pathlib import Path

from engine.hub import HubClient, HubService


class AddressOnlyHubTests(unittest.TestCase):
    def test_address_only_clients_register_and_deliver_without_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            service = HubService(root / "hub-data")
            ready = service.start()
            try:
                address = f"http://127.0.0.1:{ready.port}"
                sender = HubClient(root / "sender", address, "sender.user.aaaaaa")
                recipient = HubClient(root / "recipient", address, "recipient.user.bbbbbb")
                self.assertTrue(sender.register("Sender")["ok"])
                self.assertTrue(recipient.register("Recipient")["ok"])
                self.assertEqual(sender.send(recipient.slug, "hello", message_id="address-only-1")["state"], "sent")
                self.assertEqual(recipient.poll_once()[0]["body"], "hello")
            finally:
                service.stop()
