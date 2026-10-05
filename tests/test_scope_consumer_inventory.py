"""The capability inventory refuses new or silently changed scope origins."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scope_inventory', ROOT / 'tools/scope-consumer-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class ScopeInventory(unittest.TestCase):
    def test_isolated_cli_reaches_guard_and_reports_the_complete_inventory(self):
        with tempfile.TemporaryDirectory(prefix='scope-inventory-cli-') as folder:
            report = Path(folder) / 'inventory.json'
            result = subprocess.run(
                [sys.executable, '-I', str(ROOT / 'tools/scope-consumer-inventory.py'),
                 '--json-output', str(report)], cwd=ROOT, capture_output=True,
                text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            value = json.loads(report.read_text(encoding='utf-8'))
        provenance = value['import_provenance']
        self.assertEqual(Path(provenance['repo']).resolve(), ROOT)
        self.assertIsNone(provenance['commit_problem'])
        self.assertRegex(provenance['commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(provenance['import_provenance'], {
            'engine': str(ROOT / 'engine/__init__.py'),
            'orgtree': str(ROOT / 'engine/backend/orgtree/__init__.py')})
        self.assertEqual(value['issues'], [])
        self.assertEqual(len(value['matches']), len(value['classifications']))
        self.assertGreater(len(value['matches']), 100)

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
