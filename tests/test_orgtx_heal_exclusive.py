"""S9 (p01, WRITER-LEDGER-e9007a8): an org_tx load-heal commits inside
`orgtx.org_exclusive`, not in a bare save.

On the SeamBackend over a throwaway SQLite root, fence OFF:

  * two writers of different rows that BOTH find the heal pending: the heals
    serialize, the second finds nothing left to heal (exactly one heal save),
    both writes land and neither raises. (Without the hold both heals save;
    no StaleWrite was observed on SQLite, so the heal-save count is the
    assertion that catches it);
  * the DOC_LOCK tripwire (raising) records no save for a heal: a save of an
    org held exclusively by this thread is covered;
  * with the transition fence ON the heal still commits (the fence is
    re-entrant under the writer's own fence hold).

Run:  python tools/run-python-verification.py tests/test_orgtx_heal_exclusive.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-heal-excl-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402

orgtx.TRANSITION_FENCE = False


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in ('a', 'b'):
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _unheal(slug: str) -> None:
    """Store the org WITHOUT the ledger's `_migrations` marker: the next
    org_tx load heals it (a row the tx did not name)."""
    org = store.load_org(slug)
    assert dict.pop(org.d, '_migrations', None) is not None
    store.save_org(org)


def _caller() -> str:
    return sys._getframe(2).f_code.co_name


class HealExclusive(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        orgtx.TRANSITION_FENCE = False
        self.slug = _fresh_org(f'heal-{self._testMethodName}'[:60])

    def tearDown(self) -> None:
        orgtx.TRANSITION_FENCE = False

    def test_two_writers_healing_together_serialize(self) -> None:
        _unheal(self.slug)
        both_loaded = threading.Barrier(2, timeout=5)
        heal_race = threading.Barrier(2, timeout=1.5)
        first_check = threading.local()
        heal_saves: list[str] = []
        real_check, real_load, real_save = orgtx._check_heal, store._load_sqlite_org, store._save_org

        def check(tx):
            # both writers load the UNHEALED org before either heals
            if not getattr(first_check, 'done', False):
                first_check.done = True
                both_loaded.wait()
            return real_check(tx)

        def load(slug, *a, **k):
            org = real_load(slug, *a, **k)
            if _caller() == '_heal':
                # give a second heal the chance to load beside this one; with
                # the exclusive hold it cannot, and the barrier just times out
                try:
                    heal_race.wait()
                except threading.BrokenBarrierError:
                    pass
            return org

        def save(org):
            if _caller() == '_heal':
                heal_saves.append(org.d.get('slug'))
            return real_save(org)

        errors: list[BaseException] = []

        def writer(nid: str) -> None:
            try:
                with orgtx.org_tx(self.slug, nodes=[nid], lock_timeout=10) as tx:
                    tx.d['nodes'][nid]['name'] = f'written-{nid}'
            except BaseException as e:
                errors.append(e)

        with patch.object(orgtx, '_check_heal', check), \
                patch.object(store, '_load_sqlite_org', load), \
                patch.object(store, '_save_org', save):
            ts = [threading.Thread(target=writer, args=(n,), daemon=True) for n in 'ab']
            for t in ts:
                t.start()
            for t in ts:
                t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(heal_saves, [self.slug], 'exactly one heal save; the waiter re-checks')
        org = store.load_org(self.slug)
        self.assertIn('_migrations', org.d)
        self.assertEqual(org.d['nodes']['a']['name'], 'written-a')
        self.assertEqual(org.d['nodes']['b']['name'], 'written-b')

    def test_tripwire_records_no_save_for_a_heal(self) -> None:
        _unheal(self.slug)
        with store.doc_lock_tripwire(raising=True) as counts:
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'after-heal'
            self.assertEqual(counts['save'], {})
            self.assertEqual(counts['legacy'], {})
        self.assertIn('_migrations', store.load_org(self.slug).d)

    def test_a_save_of_another_org_under_the_hold_still_counts(self) -> None:
        other = _fresh_org(f'other-{self._testMethodName}'[:60])
        with store.doc_lock_tripwire(raising=False) as counts:
            with orgtx.org_exclusive(self.slug):
                store._save_org(store.load_org(other))
            self.assertEqual(sum(counts['save'].values()), 1)

    def test_heal_under_the_transition_fence(self) -> None:
        orgtx.TRANSITION_FENCE = True
        _unheal(self.slug)
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['nodes']['a']['name'] = 'fenced'
        org = store.load_org(self.slug)
        self.assertIn('_migrations', org.d)
        self.assertEqual(org.d['nodes']['a']['name'], 'fenced')


if __name__ == '__main__':
    unittest.main()
