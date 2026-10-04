"""The capability inventory refuses new or silently changed scope origins."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scope_inventory', ROOT / 'tools/scope-consumer-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class ScopeInventory(unittest.TestCase):
    def test_every_actual_scope_origin_and_effective_binding_is_classified(self):
        entries = json.loads((ROOT / 'tools/scope-consumers-python.json').read_text())['entries']
        matches = inventory.scan(ROOT)
        self.assertGreater(len(matches), 100)
        self.assertEqual(inventory.validate(matches, entries), [])

    def test_new_raw_alias_and_repeated_read_need_their_own_classification(self):
        old = inventory.scan_text('def consumer(node):\n return node["scope"]\n', 'fixture.py')
        entry = dict(old[0], classification='configured', reason='fixture configured writer')
        changed = inventory.scan_text('def consumer(node):\n saved = node["scope"]\n'
                                      ' return node["scope"]\n', 'fixture.py')
        self.assertIn('unclassified expression (1)', inventory.validate(changed, [entry])[0])

    def test_binding_or_explanation_cannot_disappear_silently(self):
        matches = inventory.scan_text('def consumer(org):\n return org.capability_scope("leaf")\n',
                                      'fixture.py')
        entry = dict(matches[0], classification='effective', reason='current chain')
        self.assertEqual(inventory.validate(matches, [entry]), [])
        entry['reason'] = ''
        self.assertIn('incomplete classification', inventory.validate(matches, [entry])[0])
        self.assertTrue(any('stale classification' in issue
                            for issue in inventory.validate([], [entry])))


if __name__ == '__main__':
    unittest.main()
