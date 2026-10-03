"""Account store switch boundary; physical locking is checked by the PG module."""
import import_provenance  # noqa: F401

import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from orgtree import registry, registry_migration
from orgtree.orgdb import accounts


class AccountStoreSwitch(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.env = patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.path = Path(self.root.name) / 'accounts-registry.json'
        self.path.write_bytes(b'poison rollback copy')
        path_patch = patch.object(registry, 'registry_path', return_value=str(self.path))
        path_patch.start()
        self.addCleanup(path_patch.stop)

    def test_on_reads_database_and_never_reads_poison_json(self):
        expected = registry._blank()
        with patch.object(accounts, 'load', return_value=expected) as read:
            self.assertEqual(registry.load(strict=True), expected)
            registry.list_accounts('here')
        self.assertEqual(read.call_args_list[1].args, ('here',))
        self.assertEqual(self.path.read_bytes(), b'poison rollback copy')

    def test_on_save_refuses_and_preserves_rollback_copy(self):
        with self.assertRaises(registry.RegistryUnreadable):
            registry.save(registry._blank())
        self.assertEqual(self.path.read_bytes(), b'poison rollback copy')

    def test_scoped_lookup_and_alias_pass_the_org(self):
        row = {'id': 'claude-1', 'provider': 'claude', 'credential': {'kind': 'managed', 'path': 'p'}}
        with patch.object(accounts, 'find', return_value=row) as find:
            self.assertEqual(registry.validate_binding('here', 'opus', 'claude-1'), row)
        find.assert_called_once_with('claude-1', 'here')
        with patch.object(accounts, 'resolve_alias', return_value='claude-1') as alias:
            self.assertEqual(registry.resolve_alias('primary', org='here'), 'claude-1')
        alias.assert_called_once_with('primary', 'here')

    def test_native_transaction_failure_does_not_fall_back_to_json(self):
        with patch.object(accounts, 'transaction', side_effect=RuntimeError('commit failed')):
            with self.assertRaisesRegex(RuntimeError, 'commit failed'):
                registry.set_auth('claude-1', 'authenticated')
        self.assertEqual(self.path.read_bytes(), b'poison rollback copy')

    def test_migration_marker_uses_transaction_not_json_save(self):
        doc = registry._MutationDocument(registry._blank())
        @contextlib.contextmanager
        def transaction(*args, **kwargs):
            yield doc
        with patch.object(accounts, 'transaction', side_effect=transaction):
            registry_migration.mark_migrated(123.5)
        self.assertEqual(doc['migrated_at'], 123.5)
        self.assertEqual(self.path.read_bytes(), b'poison rollback copy')

    def test_off_uses_json_and_preserves_no_change_save_notification(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': ''}):
            self.path.unlink()
            row = registry.create_account('claude', '', {'kind': 'managed', 'path': 'p'})
            with patch.object(registry, 'availability_changed') as changed:
                registry.set_auth(row['id'], 'unobserved')
            changed.assert_called_once()
            self.assertEqual(registry.get_account(row['id'])['auth'], 'unobserved')

    def test_off_transaction_rolls_back_on_exception(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': ''}):
            self.path.unlink()
            registry.save(registry._blank())
            before = self.path.read_bytes()
            with self.assertRaises(ValueError):
                with registry.transaction() as doc:
                    doc['aliases']['primary'] = 'missing'
                    raise ValueError('refuse')
            self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
