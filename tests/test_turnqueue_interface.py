"""Database identity seam fails explicitly; legacy behaviour stays available."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import os
import unittest
from unittest.mock import patch
from orgtree import turnslots


class Interface(unittest.TestCase):
    def test_storage_off_needs_no_configuration(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': ''}):
            slots = turnslots.FairSlots(1)
            with turnslots.bind_agent('org', 'agent'):
                slots.acquire('org')
                slots.release()
            self.assertEqual(slots.snapshot()['held'], 0)

    def test_storage_on_never_guesses_identity(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            slots = turnslots.FairSlots()
            with self.assertRaisesRegex(RuntimeError, 'configure'):
                slots.acquire('org')
            turnslots.configure(42, lambda: None)
            with self.assertRaisesRegex(RuntimeError, 'bind_request'):
                slots.acquire('org')
            with self.assertRaisesRegex(RuntimeError, 'identity resolver'):
                turnslots.bind_agent('org', 'agent')


if __name__ == '__main__':
    unittest.main()
