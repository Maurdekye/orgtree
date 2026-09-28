"""S9 step 5 (plan decisions 42 and 44): the transition fence's DEFAULT is OFF
only on PostgreSQL with the door enabled (every writer converted, the
fence-off gate passed) and ON otherwise: SQLite/JSON, and PostgreSQL with
ORGTREE_PGDOOR=0, where the legacy door-off DOC_LOCK fallbacks run again.
ORGTREE_ORGTX_FENCE=0/1 overrides it both ways.

What these prove:
  * `orgtx.default_transition_fence` gives every backend x fence x door answer;
  * a fresh interpreter importing orgtree with only the env set gets the same
    answer in `orgtx.TRANSITION_FENCE` and in halt's fence, so the pin is on
    the real module-level value and not only on the helper.

Run:  python tools/run-python-verification.py tests/test_fence_default.py
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-fence-default-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
os.environ.update(ORGTREE_DATA=str(data), ORGTREE_STORE='sqlite')

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import orgtree  # noqa: E402
from orgtree import orgtx  # noqa: E402

CASES = [
    # (backend, ORGTREE_ORGTX_FENCE, ORGTREE_PGDOOR, expected fence); None = unset
    ('postgres', None, None, False),
    ('postgres', '', None, False),
    ('postgres', '1', None, True),
    ('postgres', '0', None, False),
    ('postgres', None, '1', False),
    ('postgres', None, '0', True),     # the door's escape hatch keeps the fence
    ('postgres', '0', '0', False),     # ... unless the fence is overridden off
    ('sqlite', None, None, True),
    ('sqlite', '', None, True),
    ('sqlite', '1', None, True),
    ('sqlite', '0', None, False),
    ('sqlite', None, '1', True),       # door on SQLite: unconverted writers remain
    ('json', None, None, True),
]

# The packaged interpreter's ._pth ignores PYTHONPATH and cwd, so the child
# puts this checkout first itself; the test then checks orgtree.__file__.
_CHILD = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
import orgtree
from orgtree import halt, orgtx, store
print(json.dumps({'file': orgtree.__file__, 'backend': store.STORE_BACKEND,
                  'fence': orgtx.TRANSITION_FENCE, 'halt': halt._fence() is store.FENCE}))
"""


def tearDownModule() -> None:
    _temp.cleanup()


class FenceDefault(unittest.TestCase):
    def test_helper_gives_every_answer(self):
        for backend, raw, door, want in CASES:
            env = {k: v for k, v in (('ORGTREE_ORGTX_FENCE', raw), ('ORGTREE_PGDOOR', door))
                   if v is not None}
            with self.subTest(backend=backend, fence=raw, door=door):
                self.assertIs(orgtx.default_transition_fence(env, backend), want)

    def test_helper_reads_the_store_backend_when_not_told(self):
        self.assertIs(orgtx.default_transition_fence({}), orgtx.store.STORE_BACKEND != 'postgres')
        # an explicit door wins over the env reading
        self.assertIs(orgtx.default_transition_fence({'ORGTREE_PGDOOR': '0'}, 'postgres', door=True), False)
        self.assertIs(orgtx.default_transition_fence({}, 'postgres', door=False), True)

    def test_a_fresh_import_gets_the_default(self):
        root = Path(orgtree.__file__).resolve().parents[1]      # engine/backend
        for backend, raw, door, want in [c for c in CASES if c[0] != 'json']:
            env = {k: v for k, v in os.environ.items()
                   if k not in ('ORGTREE_ORGTX_FENCE', 'ORGTREE_PGDOOR')}
            env.update(ORGTREE_STORE=backend)
            if raw is not None:
                env['ORGTREE_ORGTX_FENCE'] = raw
            if door is not None:
                env['ORGTREE_PGDOOR'] = door
            with self.subTest(backend=backend, fence=raw, door=door):
                out = subprocess.run([sys.executable, '-c', _CHILD, str(root)], env=env, cwd=str(root),
                                     capture_output=True, text=True, timeout=120)
                self.assertEqual(out.returncode, 0, out.stderr[-2000:])
                got = json.loads(out.stdout.strip().splitlines()[-1])
                # the child must have imported THIS checkout, not an installed build
                self.assertEqual(Path(got['file']).resolve(), Path(orgtree.__file__).resolve())
                self.assertEqual(got['backend'], backend)
                self.assertIs(got['fence'], want)
                self.assertIs(got['halt'], want)


if __name__ == '__main__':
    unittest.main()
