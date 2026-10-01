"""Scale harness engines cannot reach the operator's real mail hub.

scale-test-engines-register-as-orgs-named-scale (2026-09-29): every engine the
scale harness started registered its seeded org, named "scale", on the live hub
(270 rows). tools/scale/seed.child_env now pins a dead hub address, and
tools/scale/serve.py's engine child refuses every request to a live hub port.

Nothing here opens a socket to a hub: the address check only reads
net._default_address(), and the guard check sends through a mock transport and
an opener with no handlers, so even a BROKEN guard cannot touch the real hub.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import child_python

ROOT = Path(__file__).resolve().parents[1]
SCALE = ROOT / 'tools' / 'scale'


def _run(code, env, *args):
    env = {k: v for k, v in env.items() if k not in ('PYTHONPATH', 'PYTHONHOME')}
    # child_python roots the child in THIS checkout; tests/ and tools/scale too
    return subprocess.run(child_python.argv('-c', code, *map(str, args), flags=('-I',),
                                            extra_roots=(ROOT / 'tests', SCALE)),
                          env=env, capture_output=True, text=True, timeout=120)


def _scale_env(root):
    sys.path.insert(0, str(SCALE))
    try:
        from seed import child_env
    finally:
        sys.path.remove(str(SCALE))
    env = child_env(root, 'postgresql://127.0.0.1:1/unused')
    env['ORGTREE_STORE'] = 'sqlite'      # the address check needs no database
    return env


ADDRESS = ('from orgtree import net\n'
           'print(net._default_address())\n')


class ScaleEngineHubAddress(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for name in ('data', 'home', 'temp'):
            (self.root / name).mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_child_env_pins_the_dead_address(self):
        from orgtree import net
        env = _scale_env(self.root)
        self.assertEqual(env['ORGTREE_LOCAL_HUB_ADDRESS'], net.UNROUTABLE_HUB_ADDRESS)
        run = _run(ADDRESS, env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), net.UNROUTABLE_HUB_ADDRESS)

    def test_control_without_the_pin_reaches_the_live_hub(self):
        # The defect itself: TEMP points into the root, so the temp-root floor
        # does not apply and a root with no defaults.json gets the live hub.
        from orgtree import net
        env = _scale_env(self.root)
        env.pop('ORGTREE_LOCAL_HUB_ADDRESS')
        run = _run(ADDRESS, env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), net.DEFAULT_HUB_ADDRESS)


GUARD = '''
import json, sys, urllib.request
from pathlib import Path
import httpx
import serve
root = Path(sys.argv[1])
serve.install_hub_guard(root)
sent = []
client = httpx.Client(transport=httpx.MockTransport(
    lambda request: sent.append(str(request.url)) or httpx.Response(200)))
refused = 0
for _ in range(3):
    try:
        client.post("http://127.0.0.1:7370/api/register", json={})
    except ConnectionRefusedError:
        refused += 1
try:
    urllib.request.OpenerDirector().open("http://127.0.0.1:7371/healthz")
except ConnectionRefusedError:
    refused += 1
client.post("http://127.0.0.1:5999/other")
print(json.dumps({"refused": refused, "sent": sent}))
'''


class ScaleServeGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'metrics').mkdir()
        self.env = dict(os.environ, ORGTREE_LOCAL_HUB_ADDRESS='http://127.0.0.1:9')

    def tearDown(self):
        self.tmp.cleanup()

    def test_live_hub_requests_are_refused_and_logged_once(self):
        run = _run(GUARD, self.env, self.root)
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout.strip().splitlines()[-1])
        self.assertEqual(result['refused'], 4)
        self.assertEqual(result['sent'], ['http://127.0.0.1:5999/other'])
        lines = (self.root / 'metrics' / 'live-hub-refused.jsonl').read_text(
            encoding='utf-8').splitlines()
        self.assertEqual(sorted(json.loads(line)['url'] for line in lines),
                         ['http://127.0.0.1:7370/api/register', 'http://127.0.0.1:7371/healthz'])

    def test_refuses_to_start_on_a_live_or_missing_address(self):
        code = 'import sys, serve; from pathlib import Path; serve.install_hub_guard(Path(sys.argv[1]))'
        for value in ('http://127.0.0.1:7370', '127.0.0.1:7371', None):
            env = dict(self.env)
            if value is None:
                env.pop('ORGTREE_LOCAL_HUB_ADDRESS')
            else:
                env['ORGTREE_LOCAL_HUB_ADDRESS'] = value
            run = _run(code, env, self.root)
            self.assertNotEqual(run.returncode, 0, value)
            self.assertIn('scale engine refused', run.stderr, value)


if __name__ == '__main__':
    unittest.main()
