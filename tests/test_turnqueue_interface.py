"""Alpha uses memory until configured; durable identity remains explicit."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import os
import unittest
from unittest.mock import Mock, patch
from orgtree import turnslots


class Interface(unittest.TestCase):
    def test_storage_off_needs_no_configuration(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': ''}), \
                patch.object(turnslots, '_database_queue', object()), \
                patch.object(turnslots, '_database_instance', 42):
            slots = turnslots.FairSlots(1)
            self.assertIs(type(slots), turnslots.FairSlots)
            with turnslots.bind_agent('org', 'agent'):
                slots.acquire('org')
                slots.release()
            self.assertEqual(slots.snapshot()['held'], 0)

    def test_storage_on_unconfigured_constructs_memory_slots(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            slots = turnslots.FairSlots(1)
            self.assertIs(type(slots), turnslots.FairSlots)
            slots.acquire('org')
            self.assertEqual(slots.snapshot()['held'], 1)
            slots.release()
            self.assertEqual(slots.snapshot()['held'], 0)

    def test_storage_on_unconfigured_bind_is_null(self):
        resolver = Mock(side_effect=AssertionError('must not resolve alpha identity'))
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None), \
                patch.object(turnslots, '_database_resolver', resolver):
            with turnslots.bind_agent('org', 'agent', 'compact') as value:
                self.assertIsNone(value)
            resolver.assert_not_called()

    def test_storage_on_configured_never_guesses_identity(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None), \
                patch.object(turnslots, '_database_resolver', None):
            turnslots.configure(42, lambda: None)
            slots = turnslots.FairSlots()
            self.assertIs(type(slots), turnslots.DatabaseSlots)
            with self.assertRaisesRegex(RuntimeError, 'bind_request'):
                slots.acquire('org')
            with self.assertRaisesRegex(RuntimeError, 'identity resolver'):
                turnslots.bind_agent('org', 'agent')

    def test_configured_missing_instance_does_not_fall_back(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', object()), \
                patch.object(turnslots, '_database_instance', None):
            self.assertIs(type(turnslots.FairSlots()), turnslots.DatabaseSlots)
            with self.assertRaisesRegex(RuntimeError, 'configure'):
                turnslots.bind_agent('org', 'agent')


if __name__ == '__main__':
    unittest.main()
