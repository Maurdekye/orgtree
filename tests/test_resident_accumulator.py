"""The resident and the shared snapshot each drain their OWN change set.

The lost update (reproduced 2026-09-26 by tools/pg5_load.py's sqlite arm: a
concurrent orgtree_work evidence row lost while its call answered 200): both
caches used to drain ONE accumulator. A warm resident is pinned, a commit
publishes its keys, a reader's snapshot refresh drains them, and the
resident's advance then finds nothing to re-read, installs a document missing
that commit, and the next write cycle saves over it. The reverse order starved
the snapshot the same way. These force each interleaving deterministically.

Run:  python tools/run-python-verification.py tests/test_resident_accumulator.py
"""

import os
from pathlib import Path
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-resident-accum-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402

# the late commit runs inside the pin hook, on the thread that will take the
# fence next; with the fence on it would wait on itself
orgtx.TRANSITION_FENCE = False


def tearDownModule() -> None:
    _temp.cleanup()


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in ('a', 'b'):
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    org.d['mail'] = {'a': [{'id': 'm1'}], 'b': [{'id': 'm2'}]}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _late_commit(slug: str) -> None:
    with orgtx.org_tx(slug, sections=[('mail', 'b')]) as tx:
        tx.d['mail']['b'].append({'id': 'late'})


class ResidentAccumulator(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'accum-{self._testMethodName}'[:58].replace('_', '-'))
        store.cached_org(self.slug)                     # the snapshot exists
        store._resident.pop(self.slug, None)
        store._warm_pending.pop(self.slug, None)

    def test_reader_refresh_between_pin_and_advance_loses_nothing(self) -> None:
        advanced: list[bool] = []
        orig_pin, orig_adv = store._load_pinned, store._advance_resident

        def pin(slug, **kw):
            out = orig_pin(slug, **kw)
            if slug == self.slug and not advanced:
                _late_commit(slug)
                # a reader's refresh lands before the writer takes the lock:
                # the same call cached_org makes (it holds the rebuild mutex,
                # which this thread already holds, so it is called directly)
                hit = store._doc_cache[slug]
                self.assertIsNotNone(store._assemble_snapshot(slug, hit[1]))
            return out

        def adv(slug, d):
            ok = orig_adv(slug, d)
            advanced.append(ok)
            return ok
        store._load_pinned, store._advance_resident = pin, adv
        try:
            with store.write_org(self.slug) as org:
                # the SAME row the late commit wrote, as two evidence calls
                # on one work item are
                org.d['mail']['b'].append({'id': 'legacy'})
                store.save_org(org)
        finally:
            store._load_pinned, store._advance_resident = orig_pin, orig_adv
        self.assertEqual(advanced, [True])          # the advance ran and was trusted
        # read what was STORED: drop the resident so the next cycle reloads
        store._resident.pop(self.slug, None)
        with store.write_org(self.slug) as fresh:
            mail = {k: list(v) for k, v in fresh.d['mail'].items()}
        # the late commit survived the legacy cycle that ran on the resident
        self.assertEqual(mail['b'], [{'id': 'm2'}, {'id': 'late'}, {'id': 'legacy'}])

    def test_resident_pin_does_not_starve_the_snapshot(self) -> None:
        _late_commit(self.slug)                     # published for the snapshot
        with store.write_org(self.slug) as org:     # cold start: pins, advances
            self.assertEqual(org.d['mail']['b'][-1], {'id': 'late'})
        snap = store.cached_org(self.slug)
        self.assertEqual(snap.d['mail']['b'], [{'id': 'm2'}, {'id': 'late'}])


if __name__ == '__main__':
    unittest.main()
