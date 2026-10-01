"""GET /api/providers answers from a short cache that no real change outlives.

N1000 read shortcuts: the desk polls /api/providers about ten times a second;
each poll took a trip through the shared 40-worker pool (p50 52 ms, p95 291 ms)
to compose a document whose inputs already cache for 60 s. The route now keeps
the composed document for api.PROVIDERS_CACHE_S. A preference write, anything
registry.availability_changed announces, and a forced read must each end it at
once, and a document composed across such a change must never be kept.
Pure unit test: no CLI, no network, no credentials touched.
Run:  python tools/run-python-verification.py tests/test_providers_cache.py
"""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-providers-cache-')
os.environ['ORGTREE_DATA'] = _root.name
assert not Path(_root.name).resolve().is_relative_to((Path.home() / 'orgtree').resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import api, appsettings, registry, staffcache   # noqa: E402


class ProvidersCache(unittest.TestCase):
    def setUp(self):
        api._providers_invalidate()
        self.addCleanup(api._providers_invalidate)
        self.composed = []

        def compose(force=False, force_provider=None):
            self.composed.append(force)
            return {'n': len(self.composed), 'force': force}
        p = patch.object(api, '_providers_payload', side_effect=compose)
        p.start()
        self.addCleanup(p.stop)
        # the staffing cache is told on availability changes; keep its refresh
        # (provider discovery) out of a unit test
        s = patch.object(staffcache, '_spawn_refresh', lambda: None)
        s.start()
        self.addCleanup(s.stop)

    def get(self, **kw):
        return asyncio.run(api.providers_info(**kw))

    def test_a_warm_read_composes_nothing(self):
        first = self.get()
        self.assertEqual(self.get(), first)
        self.assertEqual(self.get(), first)
        self.assertEqual(self.composed, [False])

    def test_it_expires(self):
        self.get()
        with patch.object(api, 'PROVIDERS_CACHE_S', 0.0):
            self.get()
        self.assertEqual(self.composed, [False, False])

    def test_a_forced_read_never_reads_it_and_refills_it(self):
        self.get()
        forced = self.get(force=True)
        self.assertEqual(self.composed, [False, True])
        self.assertEqual(self.get(), forced, 'the forced document is the newest state')
        self.assertEqual(self.composed, [False, True])

    def test_availability_changed_ends_it(self):
        self.get()
        registry.availability_changed('test: account removed')
        self.get()
        self.assertEqual(self.composed, [False, False])

    def test_each_preference_write_ends_it(self):
        routes = [(api.provider_preference, 'set_provider_enabled'),
                  (api.provider_apikey_fallback, 'set_apikey_fallback_enabled'),
                  (api.provider_subscription_inference, 'set_subscription_inference_enabled')]
        for route, setter in routes:
            with self.subTest(route=route.__name__):
                api._providers_invalidate()     # not the previous subtest's document
                self.composed.clear()
                self.get()
                with patch.object(appsettings, setter, lambda *a, **k: None), \
                     patch.object(registry, 'availability_changed', lambda *a, **k: None):
                    asyncio.run(route('claude', api.ProviderPreference(enabled=True)))
                self.get()
                # write response composes once, the next GET composes again
                self.assertEqual(self.composed, [False, False, False])

    def test_a_failed_preference_write_still_ends_it(self):
        self.get()
        def broken(*a, **k):
            raise OSError('disk')
        with patch.object(appsettings, 'set_apikey_fallback_enabled', broken):
            with self.assertRaises(api.HTTPException):
                asyncio.run(api.provider_apikey_fallback('claude', api.ProviderPreference(enabled=True)))
        self.get()
        self.assertEqual(self.composed, [False, False])

    def test_a_forced_document_composed_across_a_preference_write_is_not_kept(self):
        # transcript-db-review-astra f1: the forced branch re-read the whole
        # key after composing, folding a mid-compose write into it
        def compose(force=False, force_provider=None):
            self.composed.append(force)
            if force:
                api._providers_invalidate()       # a PUT lands while composing
            return {'n': len(self.composed)}
        with patch.object(api, '_providers_payload', side_effect=compose):
            self.get(force=True)
            self.get()
        self.assertEqual(self.composed, [True, False])

    def test_a_document_composed_across_a_change_is_not_kept(self):
        def compose(force=False, force_provider=None):
            self.composed.append(force)
            api._providers_invalidate()       # a write lands while composing
            return {'n': len(self.composed)}
        with patch.object(api, '_providers_payload', side_effect=compose):
            self.get()
            self.get()
        self.assertEqual(self.composed, [False, False])


if __name__ == '__main__':
    unittest.main()
