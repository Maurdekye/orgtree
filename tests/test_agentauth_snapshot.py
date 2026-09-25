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

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import agentauth, orgtx, store

class SnapshotTokenTests(unittest.TestCase):
    def test_snapshot_token_matches_loaded_generation_without_loading_again(self):
        org = SimpleNamespace(node=lambda nid: {'generation': 7, 'seat_id': 'seat-a'})
        # PG-3r: outside a legacy DOC_LOCK hold the node is read lock-free through orgtx.org_read
        with patch.object(agentauth, '_key', b'fixture-secret'), patch.object(orgtx, 'org_read', return_value=org) as load,                 patch.object(store, 'load_org', side_effect=AssertionError('no legacy load outside a hold')):
            canonical = agentauth.child_env('fixture', 'agent')
            load.assert_called_once_with('fixture')
            load.reset_mock()
            snapshot = agentauth.child_env('fixture', 'agent', generation=7, seat_id='seat-a')
            self.assertEqual(canonical, snapshot)
            self.assertEqual(agentauth.verify(snapshot['ORGTREE_AGENT_TOKEN']), ('fixture', 'agent', 7, 'seat-a'))
            load.assert_not_called()
            self.assertNotEqual(snapshot, agentauth.child_env('fixture', 'agent', generation=8, seat_id='seat-a'))
            self.assertNotEqual(snapshot, agentauth.child_env('fixture', 'agent', generation=7, seat_id='seat-b'))
            self.assertEqual(snapshot, agentauth.node_env('fixture', 'agent', {'generation': 7, 'seat_id': 'seat-a'}))

    def test_a_caller_inside_a_legacy_hold_reads_its_own_resident_document(self):
        # a caller holding DOC_LOCK may carry an unsaved new generation that only its resident document shows
        org = SimpleNamespace(node=lambda nid: {'generation': 9, 'seat_id': 'seat-h'})
        with patch.object(agentauth, '_key', b'fixture-secret'), patch.object(store, 'load_org', return_value=org) as load,                 patch.object(orgtx, 'org_read', side_effect=AssertionError('org_read cannot see the hold')):
            with store.DOC_LOCK:
                held = agentauth.child_env('fixture', 'agent')
            load.assert_called_once_with('fixture')
            self.assertEqual(agentauth.verify(held['ORGTREE_AGENT_TOKEN']), ('fixture', 'agent', 9, 'seat-h'))

    def test_disabled_signing_and_invalid_generation(self):
        with patch.object(agentauth, '_key', None), patch.object(store, 'load_org') as load,                 patch.object(orgtx, 'org_read') as read:
            self.assertEqual(agentauth.child_env('fixture', 'agent', generation=0), {})
            load.assert_not_called()
            read.assert_not_called()
        with patch.object(agentauth, '_key', b'fixture-secret'):
            for value in (-1, True, '7'):
                with self.assertRaises(ValueError):
                    agentauth.child_env('fixture', 'agent', generation=value, seat_id='seat-a')
            for seat in ('', None, 7):
                with self.assertRaises(ValueError):
                    agentauth.child_env('fixture', 'agent', generation=0, seat_id=seat) if seat is not None else \
                        agentauth.node_env('fixture', 'agent', {'generation': 0})

if __name__ == '__main__':
    unittest.main()
