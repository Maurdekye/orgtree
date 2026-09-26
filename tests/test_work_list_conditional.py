"""The docket list answers 304 while nothing moved, and a change is never hidden.

Five renderer surfaces poll GET /api/orgs/{slug}/work-items with both groups
included; on the operator's org every answer was ~38 MB (measured 2026-09-25,
mem-leak-probe). The list now carries an ETag derived from `store.org_seq` and
a clock bucket, answers 304 with no body while neither moved, and shares one
build between pollers. These tests count what each request actually returned —
status, body length, ETag — so a validator that never fired cannot pass.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='work-list-conditional-', ignore_cleanup_errors=True)
_data = Path(_temp.name) / 'data'
_home = Path(_temp.name) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import api, ledger, store  # noqa: E402

OP = {'X-Orgtree-Desktop-Token': 'operator'}


class WorkListConditional(unittest.TestCase):
    def setUp(self) -> None:
        self.slug = 'wlc-' + os.urandom(3).hex()
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'boss')
        store.save_org(org)
        self._add('first-item')
        self.client = TestClient(app)
        self.url = f'/api/orgs/{self.slug}/work-items?archived=1&backlogged=1'

    def _add(self, title: str) -> None:
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.work_create('boss', title=title, objective=f'{title}: the problem, then the fix.',
                            owner='boss')
            store.save_org(org)

    def get(self, etag: str | None = None):
        headers = dict(OP)
        if etag:
            headers['If-None-Match'] = etag
        return self.client.get(self.url, headers=headers)

    def test_unchanged_org_answers_304_with_no_body(self) -> None:
        first = self.get()
        self.assertEqual(first.status_code, 200, first.text[:300])
        etag = first.headers.get('etag')
        self.assertTrue(etag, 'no ETag on the list')
        self.assertIn('first-item', first.text)
        again = self.get(etag)
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.content, b'')

    def test_a_save_retires_the_etag(self) -> None:
        etag = self.get().headers['etag']
        self._add('second-item')
        after = self.get(etag)
        self.assertEqual(after.status_code, 200, 'a changed docket was answered 304')
        self.assertIn('second-item', after.text)
        self.assertNotEqual(after.headers['etag'], etag)

    def test_the_clock_bucket_retires_the_etag(self) -> None:
        # the archive and backlog groups are derived from the clock, so an
        # unchanged document must still be rebuilt once the bucket turns
        etag = self.get().headers['etag']
        real = api.time.time
        with patch.object(api.time, 'time', lambda: real() + 2 * api._WORK_STALE_BUCKET_S):
            later = self.get(etag)
        self.assertEqual(later.status_code, 200)

    def test_http_body_matches_the_direct_payload(self) -> None:
        body = json.loads(self.get().content)
        direct = json.loads(json.dumps(api.work_items_list(self.slug, archived=1, backlogged=1)))
        # `now` is the build's own clock reading, the one field two builds differ in
        self.assertTrue(body.pop('now') and direct.pop('now'))
        self.assertEqual(body, direct)

    def test_flags_have_separate_validators(self) -> None:
        full = self.get().headers['etag']
        plain = self.client.get(f'/api/orgs/{self.slug}/work-items',
                                headers={**OP, 'If-None-Match': full})
        self.assertEqual(plain.status_code, 200, 'another query was answered from the wrong ETag')

    # ── eviction: a cached body is tens of MB on a big org ──────────────────
    def _key(self) -> tuple[str, int, int, int]:
        return (self.slug, 1, 1, 0)

    def test_recently_requested_body_is_kept(self) -> None:
        self.assertEqual(self.get().status_code, 200)
        self.assertIn(self._key(), api._work_list_cache, 'the body was never cached')
        api._work_list_sweep()
        self.assertIn(self._key(), api._work_list_cache, 'a body in use was evicted')

    def test_idle_body_is_evicted(self) -> None:
        self.assertEqual(self.get().status_code, 200)
        hit = api._work_list_cache[self._key()]
        hit.used -= api._WORK_CACHE_IDLE_S + 1
        self.assertGreaterEqual(api._work_list_sweep(), 1)
        self.assertNotIn(self._key(), api._work_list_cache, 'an idle body was kept')
        again = self.get()
        self.assertEqual(again.status_code, 200)
        self.assertIn('first-item', again.text)

    def test_serving_a_body_keeps_it_alive(self) -> None:
        frozen = api.time.time()            # no clock-bucket turn between the two requests
        with patch.object(api.time, 'time', lambda: frozen):
            self.assertEqual(self.get().status_code, 200)
            hit = api._work_list_cache[self._key()]
            hit.used -= api._WORK_CACHE_IDLE_S + 1
            served = self.get()             # another poller, no validator: served from cache
        self.assertEqual(served.headers['etag'], hit.etag)
        self.assertIs(api._work_list_cache.get(self._key()), hit, 'the body was rebuilt, not served')
        api._work_list_sweep()
        self.assertIn(self._key(), api._work_list_cache, 'a body just served was evicted as idle')

    def test_superseded_body_is_evicted_without_a_request(self) -> None:
        self.assertEqual(self.get().status_code, 200)
        self._add('second-item')           # the org seq moves on
        self.assertGreaterEqual(api._work_list_sweep(), 1)
        self.assertNotIn(self._key(), api._work_list_cache, 'a body that can never be served was kept')

    def test_the_sweep_runs_by_itself_and_stops_when_empty(self) -> None:
        with patch.object(api, '_WORK_CACHE_SWEEP_S', 0.05), \
                patch.object(api, '_WORK_CACHE_IDLE_S', 0.2):
            api._work_list_sweep()          # start from an empty cache
            with api._work_list_cache_lock:
                api._work_list_cache.clear()
            self.assertEqual(self.get().status_code, 200)
            self.assertIn(self._key(), api._work_list_cache)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and (
                    api._work_list_cache or api._work_list_sweeper is not None):
                time.sleep(0.05)
            self.assertNotIn(self._key(), api._work_list_cache, 'no sweep evicted the idle body')
            self.assertIsNone(api._work_list_sweeper, 'the sweep kept running on an empty cache')

    def test_unknown_org_is_still_404(self) -> None:
        r = self.client.get('/api/orgs/no-such-org/work-items', headers=OP)
        self.assertEqual(r.status_code, 404)


if __name__ == '__main__':
    unittest.main()
