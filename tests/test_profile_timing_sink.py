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
        # No 'timing' filter needed here any more (redteam-opus's finding):
        # self-polling this very route no longer appends to its own history,
        # so every record with 'orgs' in its route is a genuine hit.
        matching = [r for r in records if 'orgs' in r.get('route', '')]
        self.assertGreaterEqual(len(matching), 1, f'the /api/orgs/{{slug}} call above must have produced a record: {records}')
        row = matching[-1]
        # ROUTE TEMPLATE, not the literal request path: proves no slug/id/secret
        # ever reaches the sink, only the matched route's own placeholder string.
        self.assertIn('{', row['route'], f'expected a route TEMPLATE with a placeholder, got {row["route"]!r}')
        self.assertNotIn(slug, row['route'], 'the literal slug must never reach the sink, only its route template')
        for numeric_field in ('seq', 'handler_ms', 'total_ms', 'bytes'):
            self.assertIsInstance(row[numeric_field], (int, float), f'{numeric_field}: {row}')
        # Nothing beyond route + numbers: a body, header or query value sent
        # through this endpoint must never show up as a sink field's value.
        self.assertNotIn('operator', json.dumps(row), 'the desktop token must never reach a profile record')

    def test_the_route_never_pollutes_its_own_history(self):
        # redteam-opus's finding #1: every request gets `profile={}` from the
        # middleware, so appending unconditionally means the sink's OWN reads
        # (and every uninstrumented route) crowd out what it exists to hold.
        client = TestClient(app)
        for _ in range(5):
            client.get('/api/desktop/profile-timing', headers=self.HEADERS)
        records = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()['records']
        self.assertFalse(any(r.get('route') == '/api/desktop/profile-timing' for r in records),
                         f'the sink route must never appear in its own history: {records}')

    def test_an_uninstrumented_route_produces_no_record_either(self):
        # Same finding, general case: only org_tree ever writes stage timings
        # into request.state.profile_timing — every other handler leaves it
        # `{}`, and an empty profile must not become a (nearly-empty) record.
        client = TestClient(app)
        newest_before = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()['newest_seq']
        client.get('/api/orgs', headers=self.HEADERS)  # the list route: never touches profile_timing
        body = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()
        self.assertFalse(any(r.get('route') == '/api/orgs' for r in body['records']),
                         f"an uninstrumented route's empty profile must not be appended: {body['records']}")
        # And it must not have silently advanced the sequence either — an
        # untracked seq bump would be its own quiet form of the same leak.
        self.assertEqual(body['newest_seq'], newest_before)

    def test_seq_is_monotonic_and_never_repeats(self):
        from orgtree import store
        client = TestClient(app)
        slug = 'profile-sink-seq-probe-org'
        store.create_org(slug)
        _orgs_created.append(slug)
        for _ in range(3):
            client.get(f'/api/orgs/{slug}', headers=self.HEADERS)
        records = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()['records']
        seqs = [r['seq'] for r in records]
        self.assertEqual(seqs, sorted(seqs), f'seq must be monotonic: {seqs}')
        self.assertEqual(len(seqs), len(set(seqs)), f'seq must never repeat: {seqs}')

    def test_snapshot_metadata_identifies_new_records_and_detects_eviction(self):
        # Coordinator's exact ask: oldest/newest sequence and a dropped count
        # are enough — no ?since= filter or streaming API needed, since a
        # caller can already tell "nothing new" (newest_seq unchanged) from
        # "records aged out before I read them" (dropped increased, or the
        # remembered seq it expected is now below oldest_seq) from these
        # three numbers plus its own memory of a prior snapshot.
        from orgtree import api
        saved = list(api._PROFILE_RECORDS)
        saved_seq = api._PROFILE_SEQ
        try:
            api._PROFILE_RECORDS.clear()
            api._PROFILE_SEQ = 0
            client = TestClient(app)
            empty = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()
            self.assertEqual(empty['oldest_seq'], None)
            self.assertEqual(empty['newest_seq'], None)
            self.assertEqual(empty['dropped'], 0)

            class FakeRoute:
                path = '/api/fake/{id}'
            scope = {'route': FakeRoute(), 'method': 'GET', 'type': 'http'}
            for i in range(5):
                api._access_emit(scope, 200, 1.0, 1.0, 0, 1, profile={'n': float(i)})
            first = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()
            self.assertEqual(first['oldest_seq'], 1)
            self.assertEqual(first['newest_seq'], 5)
            self.assertEqual(first['dropped'], 0, 'nothing has evicted yet inside a 2000-cap buffer holding 5')
            self.assertEqual([r['seq'] for r in first['records']], [1, 2, 3, 4, 5])

            # Force real eviction (not a re-sized fixture): append past the
            # real 2000 cap and confirm `dropped`/`oldest_seq` reflect it.
            for _ in range(2000):
                api._access_emit(scope, 200, 1.0, 1.0, 0, 1, profile={'n': 0.0})
            after = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()
            self.assertEqual(after['newest_seq'], 2005)
            self.assertGreater(after['oldest_seq'], 1, 'the first 5 records must have aged out of the real 2000 cap')
            self.assertEqual(after['dropped'], 2005 - len(after['records']))
            self.assertGreater(after['dropped'], 0)
        finally:
            api._PROFILE_RECORDS.clear()
            api._PROFILE_RECORDS.extend(saved)
            api._PROFILE_SEQ = saved_seq

    def test_a_non_numeric_or_nonfinite_profile_value_never_reaches_the_sink(self):
        # redteam-opus's finding #3, extended per coordinator's "finite"
        # wording: `**profile` merges whatever a handler's dict holds.
        # Nothing upstream enforces numeric-and-finite structurally without
        # this filter — exercise `_access_emit` directly with values no real
        # handler sends today (a string, a bool, and each of the three ways a
        # float can be non-finite) to prove the filter holds.
        from orgtree import api
        import math

        class FakeRoute:
            path = '/api/fake/{id}'

        scope = {'route': FakeRoute(), 'method': 'GET', 'type': 'http'}
        before = len(api._PROFILE_RECORDS)
        api._access_emit(scope, 200, 1.0, 1.0, 0, 1,
                         profile={'good_ms': 4.5, 'bad_field': 'not-a-number', 'sneaky_bool': True,
                                  'nan_ms': math.nan, 'inf_ms': math.inf, 'neg_inf_ms': -math.inf})
        self.assertEqual(len(api._PROFILE_RECORDS), before + 1)
        row = api._PROFILE_RECORDS[-1]
        self.assertEqual(row.get('good_ms'), 4.5)
        for rejected in ('bad_field', 'sneaky_bool', 'nan_ms', 'inf_ms', 'neg_inf_ms'):
            self.assertNotIn(rejected, row, f'{rejected!r} must never reach the sink: {row}')

    def test_a_handler_cannot_overwrite_reserved_fields_via_its_profile_dict(self):
        # root's finding: `**numeric_profile` was merged LAST, so a handler
        # whose dict happens to carry a numeric value under 'seq', 'bytes',
        # etc. would silently win over the sink's own computed fields —
        # 'seq' in particular is the monotonicity guarantee every other test
        # here relies on.
        from orgtree import api

        class FakeRoute:
            path = '/api/fake/{id}'

        scope = {'route': FakeRoute(), 'method': 'GET', 'type': 'http'}
        before_seq = api._PROFILE_SEQ
        api._access_emit(scope, 200, 1.0, 1.0, 0, 1,
                         profile={'seq': 999999, 'route': 'spoofed', 'bytes': -1,
                                  'handler_ms': -1, 'total_ms': -1, 'good_ms': 2.5})
        row = api._PROFILE_RECORDS[-1]
        self.assertEqual(row['seq'], before_seq + 1, f'a handler must never be able to set its own seq: {row}')
        self.assertEqual(row['route'], '/api/fake/{id}', f'a handler must never overwrite the real route: {row}')
        self.assertGreaterEqual(row['bytes'], 0, f'a handler must never overwrite bytes: {row}')
        self.assertEqual(row.get('good_ms'), 2.5, 'a non-reserved numeric field must still pass through')

    def test_the_snapshot_exposes_a_process_capture_identity(self):
        # root's finding: 'seq never resets' is a PER-PROCESS promise only —
        # _PROFILE_SEQ is a plain module global and restarts at 0 across a
        # real process restart. `instance` (the SAME per-process value already
        # used for X-Orgtree-Instance/noteInstance — api.py's INSTANCE) lets a
        # collector detect that, without inventing a second identity scheme.
        from orgtree import api
        client = TestClient(app)
        body = client.get('/api/desktop/profile-timing', headers=self.HEADERS).json()
        self.assertEqual(body['instance'], api.INSTANCE)
        self.assertTrue(body['instance'], 'instance must be a real, non-empty value')

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
        #
        # Snapshot/restore around the mutation: this test's own raw (seq-less)
        # fixture rows would otherwise corrupt the seq/since tests that share
        # this same module-level deque, regardless of unittest's run order.
        from orgtree import api
        self.assertEqual(api._PROFILE_RECORDS.maxlen, 2000)
        saved = list(api._PROFILE_RECORDS)
        try:
            api._PROFILE_RECORDS.clear()
            marker_low, marker_high = object(), object()
            api._PROFILE_RECORDS.append({'route': 'sentinel-old', '_marker': marker_low})
            for _ in range(2000):
                api._PROFILE_RECORDS.append({'route': 'filler'})
            api._PROFILE_RECORDS.append({'route': 'sentinel-new', '_marker': marker_high})
            routes = [r.get('route') for r in api._PROFILE_RECORDS]
            self.assertNotIn('sentinel-old', routes, 'the buffer must evict its oldest entry, not grow unbounded')
            self.assertIn('sentinel-new', routes)
            self.assertLessEqual(len(api._PROFILE_RECORDS), 2000)
        finally:
            api._PROFILE_RECORDS.clear()
            api._PROFILE_RECORDS.extend(saved)

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
