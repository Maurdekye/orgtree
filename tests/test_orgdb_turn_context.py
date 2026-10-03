"""Per-run credentials preserve identity and never substitute the current run."""
import import_provenance  # noqa: F401

from dataclasses import replace
import json
import base64
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from orgtree.orgdb import turn_context as context
from orgtree.orgdb.turn_runtime import initial_limit


class Credentials(unittest.TestCase):
    def setUp(self):
        self.key = b'a' * 32
        self.run = context.Run('org', 'seat', 1, 2, str(uuid4()), 3, 4, str(uuid4()))

    def test_exact_roundtrip_and_another_instance_key(self):
        credential = context.sign(self.run, self.key)
        self.assertEqual(context.verify(credential, lambda owner: self.key if owner == 4 else None), self.run)
        self.assertIsNone(context.verify(credential, lambda owner: b'b' * 32))
        self.assertIsNone(context.verify(credential, lambda owner: None))

    def test_every_signed_identity_field_is_fenced_by_signature(self):
        credential = context.sign(self.run, self.key)
        encoded, signature = credential.split('.')
        original = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        for index in range(len(original)):
            payload = original.copy()
            payload[index] = 'changed' if isinstance(payload[index], str) else payload[index] + 1
            altered = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
            self.assertIsNone(context.verify(altered + '.' + signature, lambda owner: self.key), index)

    def test_old_credential_cannot_be_relabelled_from_bound_new_run(self):
        credential = context.sign(self.run, self.key)
        successor = replace(self.run, request_id=str(uuid4()), epoch=5, token=str(uuid4()))
        with context.bind(successor):
            self.assertEqual(context.current(), successor)
            self.assertEqual(context.verify(credential, lambda owner: self.key), self.run)
            with context.bind(self.run):
                self.assertEqual(context.current(), self.run)
            self.assertEqual(context.current(), successor)
        self.assertIsNone(context.current())

    def test_malformed_wrong_type_and_oversized_credentials_are_refused(self):
        for value in ('', '.', '%%%.' + 'a' * 64, 'a' * 4097, None, 3):
            self.assertIsNone(context.verify(value, lambda owner: self.key))
        for field in ('org_id', 'agent_id', 'epoch', 'owner'):
            with self.assertRaises(ValueError):
                replace(self.run, **{field: True})

    def test_saved_default_invalid_and_environment_limits_match_existing_rules(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(initial_limit(root, {}), 16)
            self.assertEqual(initial_limit(root, {'ORGTREE_MAX_TURNS': '7'}), 7)
            self.assertEqual(initial_limit(root, {'ORGTREE_MAX_TURNS': 'wrong'}), 16)
            path = Path(root) / 'app-settings.json'
            path.write_text(json.dumps({'version': 1, 'runtime': {'max_concurrent_turns': 8}}))
            self.assertEqual(initial_limit(root, {'ORGTREE_MAX_TURNS': '7'}), 8)
            for value in (0, 513, True, '8', None):
                path.write_text(json.dumps({'version': 1, 'runtime': {'max_concurrent_turns': value}}))
                self.assertEqual(initial_limit(root, {'ORGTREE_MAX_TURNS': '7'}), 7)
            path.write_text('bad json')
            self.assertEqual(initial_limit(root, {}), 16)


if __name__ == '__main__':
    unittest.main()
