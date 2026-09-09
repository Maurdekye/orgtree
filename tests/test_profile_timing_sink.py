"""allow-live-profiling-evidence-retrieval: the reviewed org/desk timing
instrumentation (f512cde) prints `[orgtree.profile]` lines to stdout, but
neither real launch path (service_host.py's boot host, engine.ts's own
spawn) persists that stream past the JSON readiness handshake — both drop
it. This is the bounded, default-off, in-memory sink that makes the same
records retrievable over the existing token-gated API instead, without
touching the readiness protocol or the failure/refusal behavior at all
(see engine/backend/orgtree/api.py's `_PROFILE_RECORDS`/`profile_timing`).

Positive-control shape throughout, same as the sibling reply-attachment
tests: a case that proves the flag OFF really is silent, paired with a case
that proves it ON really is populated — never just one side.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-profile-sink-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_PROFILE_TIMING='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app  # noqa: E402  (env must be set first)
app, *_ = load_app()


_orgs_created: list[str] = []


def tearDownModule():
    from orgtree import store
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


class ProfileTimingSinkEnabledTests(unittest.TestCase):
    """`_PROFILE_TIMING` is bound at api.py IMPORT time (module load), same as
    `_PROFILE_RECORDS`'s presence — this process therefore only ever proves
    the ENABLED shape; the disabled default is a separate fresh interpreter
    below, exactly because a module-level constant cannot be re-toggled
    inside one already-imported process."""

    HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}

    def test_a_real_request_produces_a_bounded_numeric_record(self):
        from orgtree import store
        client = TestClient(app)
        slug = 'profile-sink-probe-org'
        store.create_org(slug)
        _orgs_created.append(slug)
        got = client.get(f'/api/orgs/{slug}', headers=self.HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        read = client.get('/api/desktop/profile-timing', headers=self.HEADERS)
        self.assertEqual(read.status_code, 200, read.text)
        body = read.json()
        self.assertTrue(body['enabled'])
        records = body['records']
        matching = [r for r in records if 'orgs' in r.get('route', '') and 'timing' not in r.get('route', '')]
        self.assertGreaterEqual(len(matching), 1, f'the /api/orgs/{{slug}} call above must have produced a record: {records}')
        row = matching[-1]
        # ROUTE TEMPLATE, not the literal request path: proves no slug/id/secret
        # ever reaches the sink, only the matched route's own placeholder string.
        self.assertIn('{', row['route'], f'expected a route TEMPLATE with a placeholder, got {row["route"]!r}')
        self.assertNotIn(slug, row['route'], 'the literal slug must never reach the sink, only its route template')
        for numeric_field in ('handler_ms', 'total_ms', 'bytes'):
            self.assertIsInstance(row[numeric_field], (int, float), f'{numeric_field}: {row}')
        # Nothing beyond route + numbers: a body, header or query value sent
        # through this endpoint must never show up as a sink field's value.
        self.assertNotIn('operator', json.dumps(row), 'the desktop token must never reach a profile record')

    def test_token_gate_still_covers_the_new_route(self):
        # Same TokenGate as every other route (launch.py §155-185) — proven
        # here rather than assumed, since a new route is exactly the kind of
        # addition that could accidentally bypass middleware ordering.
        client = TestClient(app)
        refused = client.get('/api/desktop/profile-timing')
        self.assertEqual(refused.status_code, 401, refused.text)

    def test_sink_is_bounded_and_drops_the_oldest_first(self):
        # Exercising the real 2000-entry cap over HTTP would be slow and
        # would not test anything a direct append does not already prove;
        # the deque's own `maxlen` eviction is the mechanism, and it is
        # stdlib-guaranteed FIFO — this pins OUR usage of it, not deque
        # itself, so a future change to an unbounded structure would fail
        # this rather than silently regressing.
        from orgtree import api
        self.assertEqual(api._PROFILE_RECORDS.maxlen, 2000)
        marker_low, marker_high = object(), object()
        api._PROFILE_RECORDS.append({'route': 'sentinel-old', '_marker': marker_low})
        for _ in range(2000):
            api._PROFILE_RECORDS.append({'route': 'filler'})
        api._PROFILE_RECORDS.append({'route': 'sentinel-new', '_marker': marker_high})
        routes = [r.get('route') for r in api._PROFILE_RECORDS]
        self.assertNotIn('sentinel-old', routes, 'the buffer must evict its oldest entry, not grow unbounded')
        self.assertIn('sentinel-new', routes)
        self.assertLessEqual(len(api._PROFILE_RECORDS), 2000)

    def test_a_handler_exception_still_reaches_the_client_unmasked(self):
        # `_access_emit` (and now the sink append inside it) sits in the
        # caller's `finally`/`except Exception: pass` — this proves that
        # contract still holds with the sink present, not merely that the
        # sink itself does not raise in the success path above.
        client = TestClient(app, raise_server_exceptions=False)
        got = client.get('/api/orgs/does-not-exist-at-all', headers=self.HEADERS)
        self.assertEqual(got.status_code, 404, got.text)


class ProfileTimingSinkDisabledByDefaultTests(unittest.TestCase):
    """A fresh interpreter, ORGTREE_PROFILE_TIMING deliberately UNSET: proves
    the positive tests above are not vacuous — the flag really does gate
    both the printed line and the sink, and stays silent without it."""

    def test_fresh_process_without_the_flag_never_populates_the_sink(self):
        with tempfile.TemporaryDirectory(prefix='v2-profile-sink-off-') as tmp:
            data_dir = Path(tmp) / 'data'; data_dir.mkdir()
            home_dir = Path(tmp) / 'home'; home_dir.mkdir()
            script = (
                "import os\n"
                "from pathlib import Path\n"
                "from engine.launch import load_app\n"
                "app, *_ = load_app()\n"
                "from fastapi.testclient import TestClient\n"
                "client = TestClient(app)\n"
                "headers = {'X-Orgtree-Desktop-Token': 'operator'}\n"
                "client.get('/api/orgs', headers=headers)\n"
                "r = client.get('/api/desktop/profile-timing', headers=headers)\n"
                "import json, sys\n"
                "sys.stdout.write(json.dumps(r.json()))\n"
            )
            env = {**os.environ, 'ORGTREE_DATA': str(data_dir), 'HOME': str(home_dir),
                   'USERPROFILE': str(home_dir), 'ORGTREE_V2_TOKEN': 'operator'}
            env.pop('ORGTREE_PROFILE_TIMING', None)
            result = subprocess.run([sys.executable, '-c', script], env=env,
                                    capture_output=True, text=True, timeout=60,
                                    cwd=str(Path(__file__).resolve().parent.parent))
            self.assertEqual(result.returncode, 0, result.stderr)
            # stdout also carries the unconditional `[orgtree.access]` lines
            # `_access_emit` prints regardless of the flag; only the LAST
            # line is this script's own final JSON write.
            last_line = result.stdout.strip().splitlines()[-1]
            self.assertNotIn('[orgtree.profile]', result.stdout,
                             'the profile line itself must not print when the flag is off')
            body = json.loads(last_line)
            self.assertFalse(body['enabled'])
            self.assertEqual(body['records'], [], 'no request may populate the sink when the flag is off')


if __name__ == '__main__':
    unittest.main()
