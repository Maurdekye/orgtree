"""Actual-PG: how an org_tx transaction opens.

BEGIN and both SET LOCALs go as ONE statement, then the org lock, then the
one lock block, in that order: no lock is taken before the timeouts are set.
The timeouts hold inside the transaction and die with it, so a pooled
connection never carries them into a later transaction (review B3)."""
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Prologue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()
        orgtx.use_backend(orgtx.PgBackend())

    def setUp(self):
        orgtx.TRANSITION_FENCE = False
        self.slug = f._fresh_org(f'pro-{self._testMethodName}'[:60])

    def recording(self):
        seen = []
        real_checkout, real_release = pgstore._checkout, pgstore._release

        class Rec:
            def __init__(self, raw):
                object.__setattr__(self, '_raw', raw)

            def execute(self, q, *a, **k):
                seen.append(' '.join((q if isinstance(q, str) else str(q)).split()))
                return self._raw.execute(q, *a, **k)

            def __getattr__(self, n):
                return getattr(self._raw, n)

        def release(raw):
            return real_release(getattr(raw, '_raw', raw))
        return seen, patch.multiple(pgstore, _checkout=lambda: Rec(real_checkout()),
                                    _release=release)

    def test_one_statement_opens_the_transaction_before_any_lock(self):
        seen, p = self.recording()
        with p:
            with orgtx.org_tx(self.slug, nodes=['a'], lock_timeout=7) as tx:
                tx.d['nodes']['a']['name'] = 'A'
        self.assertEqual(seen[0], "BEGIN; SET LOCAL lock_timeout = '7000ms'; "
                                  "SET LOCAL idle_in_transaction_session_timeout = "
                                  f"'{int(orgtx.IDLE_IN_TX_TIMEOUT_S * 1000)}ms'")
        self.assertIn('pg_advisory_xact_lock_shared', seen[1])      # the org lock
        self.assertTrue(seen[2].startswith('DO $orgtx_'), seen[2][:40])
        self.assertFalse(any(q.startswith(('BEGIN', 'SET LOCAL')) for q in seen[1:]), seen)
        # every lock of this node-only write is in those two statements
        self.assertEqual([q[:60] for q in seen[3:] if 'pg_advisory' in q], [])
        self.assertEqual(f._node(self.slug, 'a')['name'], 'A')

    @staticmethod
    def ms(raw, name):
        return int(raw.execute('SELECT setting FROM pg_settings WHERE name=%s', (name,)).fetchone()[0])

    def test_the_timeouts_hold_inside_and_die_with_the_transaction(self):
        with orgtx.org_tx(self.slug, nodes=['a'], lock_timeout=7) as tx:
            raw = store._orgtx_local.pinned[self.slug].raw
            self.assertEqual(self.ms(raw, 'lock_timeout'), 7000)
            self.assertEqual(self.ms(raw, 'idle_in_transaction_session_timeout'),
                             int(orgtx.IDLE_IN_TX_TIMEOUT_S * 1000))
            tx.d['nodes']['a']['name'] = 'A'
        raw = pgstore._checkout()
        try:
            self.assertEqual(self.ms(raw, 'lock_timeout'), 0)
        finally:
            pgstore._release(raw)


if __name__ == '__main__':
    unittest.main()
