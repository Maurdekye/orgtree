"""The engine debug view shows whether loads really go on demand.

A load that falls back to a whole-org decode (heal epoch not stamped yet, or a
walk) costs ~9x the memory of an on-demand one (measured on the live org: a
chat read 64 MB vs 7 MB), and nothing showed it. GET
/api/diagnostics/engine-stats now carries `lazy_rows`: the switch, the
store's counters, the orgs whose last load was whole for a stale epoch, and
the last few fallbacks.

Actual PostgreSQL (disposable, via test_pgstore).
Run:  python tools/run-python-verification.py tests/test_lazy_rows_debug_view.py
"""
import asyncio
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
from orgtree import api, orgtx, store


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class LazyRowsDebugView(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass
    setUp = lazy.LazyRows.setUp
    raw = lazy.LazyRows.raw
    epoch = lazy.LazyRows.epoch

    def report(self):
        return asyncio.run(api.engine_stats())['lazy_rows']

    def test_an_org_loading_whole_for_a_stale_epoch_is_named_until_stamped(self):
        self.assertIsNone(self.epoch())
        before = dict(store.LAZY_ROWS_STATS)
        store.load_runtime_org(self.slug)
        r = self.report()
        self.assertTrue(r['enabled'])
        self.assertEqual(r['epoch'], store.heal_epoch())
        self.assertIn(self.slug, r['stale_epoch_orgs'])
        self.assertEqual(r['counts']['epoch_fallbacks'] - before.get('epoch_fallbacks', 0), 1)
        with orgtx.org_tx(self.slug, nodes=['n0']):
            pass
        self.assertEqual(self.epoch(), store.heal_epoch())
        store.load_runtime_org(self.slug)
        r = self.report()
        self.assertNotIn(self.slug, r['stale_epoch_orgs'])
        self.assertEqual(r['counts']['loads'] - before.get('loads', 0), 1)

    def test_the_block_is_json_and_lists_at_most_five_fallbacks(self):
        for i in range(8):
            store._lazy_fallback(f'probe walk {i}')
        r = self.report()
        json.dumps(r)
        self.assertEqual([x['why'] for x in r['recent_fallbacks']],
                         [f'probe walk {i}' for i in range(3, 8)])
        self.assertTrue(all(isinstance(x['stack'], list) for x in r['recent_fallbacks']))

    def test_enabled_follows_the_switch(self):
        with patch.object(store, 'LAZY_ROWS', False):
            self.assertFalse(self.report()['enabled'])
        self.assertTrue(self.report()['enabled'])


if __name__ == '__main__':
    unittest.main()
