"""Fresh imports prove both scale defaults, independent overrides, and fences."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

REPO = Path(__file__).resolve().parents[1]
CHILD = r'''
import json, sys
from pathlib import Path
repo = Path(sys.argv[1])
sys.path.insert(0, str(repo / 'tools'))
from assert_repo_import import assert_repo_import
assert_repo_import(repo)
from orgtree import halt, orgtx, store, supervisor
print(json.dumps({'rescope': store.ORGTX_RESCOPE, 'cheap': supervisor.STEER_CHEAP,
                  'fence': orgtx.TRANSITION_FENCE, 'halt_fence': halt._fence() is store.FENCE,
                  'store_file': store.__file__, 'supervisor_file': supervisor.__file__}))
'''


class ScaleSwitchDefaults(unittest.TestCase):
    def imported(self, backend, rescope=None, cheap=None):
        with tempfile.TemporaryDirectory(prefix='scale-switch-defaults-') as root:
            env = {k: v for k, v in os.environ.items() if not k.startswith('ORGTREE_')}
            env.update(ORGTREE_DATA=root, ORGTREE_STORE=backend)
            if rescope is not None:
                env['ORGTREE_ORGTX_RESCOPE'] = rescope
            if cheap is not None:
                env['ORGTREE_STEER_CHEAP'] = cheap
            out = subprocess.run([sys.executable, '-c', CHILD, str(REPO)], cwd=REPO,
                                 env=env, text=True, capture_output=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            result = json.loads(out.stdout.strip().splitlines()[-1])
            for name in ('store', 'supervisor'):
                self.assertEqual(Path(result[name + '_file']).resolve(),
                                 REPO / 'engine' / 'backend' / 'orgtree' / (name + '.py'))
            self.assertIs(result['fence'], backend != 'postgres')
            self.assertIs(result['halt_fence'], backend != 'postgres')
            return result['rescope'], result['cheap']

    def test_defaults_on_without_changing_backend_fences(self):
        for backend in ('sqlite', 'json', 'postgres'):
            with self.subTest(backend=backend):
                self.assertEqual(self.imported(backend), (True, True))

    def test_each_switch_can_be_disabled_independently(self):
        for rescope, cheap in (('0', '1'), ('1', '0'), ('0', '0')):
            with self.subTest(rescope=rescope, cheap=cheap):
                self.assertEqual(self.imported('sqlite', rescope, cheap),
                                 (rescope == '1', cheap == '1'))

    def test_explicit_empty_keeps_previous_disabled_meaning(self):
        self.assertEqual(self.imported('sqlite', '', ''), (False, False))


if __name__ == '__main__':
    unittest.main()
