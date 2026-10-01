"""Adopted from review-astra's F3b-1 probe (review finding f4, 0100b10): the kept context was accepted under a
clock-dependent rule. foreground_context refuses a context whose fable_lock has
expired (time.time() >= until_ts), so the full build falls back to the whole-org
path, which releases the lock in memory (limit_locked goes). A runtime-only
refresh after the expiry, with NO commit, must still equal a fresh full build."""
import copy
import time
import types
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_cache, foreground_context, ledger, store


def tearDownModule():
    fixture.tearDownModule()


def _clock(fn):
    ns = {k: getattr(time, k) for k in dir(time) if not k.startswith('__')}
    ns['time'] = fn
    return types.SimpleNamespace(**ns)


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ReprojectClock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        self.t0 = time.time()
        org = store.create_org('fg-clock-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss', charter='Visible charter')
        org.hire(ledger.USER, 'boss', 'fable', 0, 'locked')
        org.d['fable_lock'] = {'at': ledger.now(), 'detail': 'probe', 'until_ts': self.t0 + 600}
        org.nodes['locked']['limit_locked'] = True
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.clock = self.t0
        self.client = TestClient(TokenGate(api.app, 'fg-clock'))
        self.headers = {'X-Orgtree-Desktop-Token': 'fg-clock', 'Accept-Encoding': 'identity'}
        self.url = f'/api/orgs/{self.slug}/foreground-tree'
        self.runtime = ['first']
        foreground_cache._cache.clear()
        self.addCleanup(foreground_cache._cache.clear)

    def get(self, etag=None):
        headers = dict(self.headers)
        if etag:
            headers['If-None-Match'] = etag
        clock = _clock(lambda: self.clock)
        with patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: tuple(self.runtime)), \
                patch.object(foreground_context, 'time', clock), patch.object(ledger, '_time', clock):
            return self.client.get(self.url, headers=headers)

    def fresh(self):
        foreground_cache._cache.clear()
        r = self.get()
        self.assertEqual(r.status_code, 200, r.text)
        return r

    def test_runtime_only_refresh_after_fable_lock_expiry_equals_a_full_build(self):
        first = self.fresh()
        self.assertTrue(first.json()['nodes']['locked'].get('limit_locked'), 'setup: lock not shown')
        self.clock = self.t0 + 1200
        self.runtime = ['second']
        self.get(first.headers['etag'])
        kept = self.get()
        foreground_cache._cache.clear()
        control = self.get()                                  # fresh build, same clock/runtime
        def lock(r):
            return r.json().get('nodes', {}).get('locked', {}).get('limit_locked') if r.status_code == 200 else None
        print('LOCK first', lock(first), 'kept', kept.status_code, lock(kept),
              'fresh', control.status_code, lock(control), control.text[:200])
        # control: expiry really changes what a fresh build answers
        self.assertTrue(control.status_code != 200 or not lock(control), 'expiry changed nothing: probe inert')
        self.assertEqual((kept.status_code, lock(kept)), (control.status_code, lock(control)),
                         'runtime-only refresh kept serving an expired fable lock')

    def test_status_patch_after_fable_lock_expiry_equals_a_full_build(self):
        # The cheap status patch reuses kept content too; it must not outlive
        # the clock deadline either.
        first = self.fresh()
        self.clock = self.t0 + 1200
        org = store.load_org(self.slug)
        org.nodes['boss']['last_status'] = {'status': 'working', 'summary': 'after expiry'}
        store.save_org(org)
        self.get(first.headers['etag'])
        kept = self.get()
        foreground_cache._cache.clear()
        control = self.get()
        def lock(r):
            return r.json().get('nodes', {}).get('locked', {}).get('limit_locked') if r.status_code == 200 else None
        self.assertTrue(control.status_code != 200 or not lock(control), 'expiry changed nothing: probe inert')
        self.assertEqual((kept.status_code, lock(kept)), (control.status_code, lock(control)))


if __name__ == '__main__':
    unittest.main()
