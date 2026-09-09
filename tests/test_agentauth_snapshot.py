"""Already-loaded generations avoid per-agent organization reloads."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='agentauth-snapshot-')
os.environ['ORGTREE_DATA'] = root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import agentauth, store

class SnapshotTokenTests(unittest.TestCase):
    def test_snapshot_token_matches_loaded_generation_without_loading_again(self):
        org = SimpleNamespace(node=lambda nid: {'generation': 7})
        with patch.object(agentauth, '_key', b'fixture-secret'), patch.object(store, 'load_org', return_value=org) as load:
            canonical = agentauth.child_env('fixture', 'agent')
            load.assert_called_once_with('fixture')
            load.reset_mock()
            snapshot = agentauth.child_env('fixture', 'agent', generation=7)
            self.assertEqual(canonical, snapshot)
            self.assertEqual(agentauth.verify(snapshot['ORGTREE_AGENT_TOKEN']), ('fixture', 'agent', 7))
            load.assert_not_called()
            self.assertNotEqual(snapshot, agentauth.child_env('fixture', 'agent', generation=8))

    def test_disabled_signing_and_invalid_generation(self):
        with patch.object(agentauth, '_key', None), patch.object(store, 'load_org') as load:
            self.assertEqual(agentauth.child_env('fixture', 'agent', generation=0), {})
            load.assert_not_called()
        with patch.object(agentauth, '_key', b'fixture-secret'):
            for value in (-1, True, '7'):
                with self.assertRaises(ValueError):
                    agentauth.child_env('fixture', 'agent', generation=value)

if __name__ == '__main__':
    unittest.main()
