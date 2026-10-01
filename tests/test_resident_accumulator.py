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

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-resident-accum-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  # the SHIPPING SQLite setting: no row compare-and-set, so a
                  # save on a stale resident overwrites silently (with it on,
                  # the same interleaving raises StaleWrite instead)
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='0')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

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


def _legacy_commit(slug: str, mutate) -> None:
    """Another writer's cycle on a PRIVATE copy: a load outside DOC_LOCK is
    never the resident, so this save publishes like any other."""
    org = store.load_org(slug)
    mutate(org.d)
    with store.DOC_LOCK:
        store.save_org(org)


def _raw_mail_b(slug: str, entry: dict) -> None:
    """A write the change sets never hear of (a migration or restore does
    this, then calls _invalidate_snapshot): straight into the database."""
    con = sqlite3.connect(store._db_path(slug))
    try:
        sep = getattr(store, 'SPLIT_SEP', None)
        split = None if sep is None else 'mail' + sep
        row = (None if split is None else
               con.execute('SELECT val FROM doc WHERE key=?', (split + 'b',)).fetchone())
        if row is not None:                     # v3: one row per owner
            con.execute('UPDATE doc SET val=? WHERE key=?',
                        (json.dumps(json.loads(row[0]) + [entry]), split + 'b'))
        else:                                   # 2.1.x: the whole section
            (val,) = con.execute("SELECT val FROM doc WHERE key='mail'").fetchone()
            mail = json.loads(val)
            mail['b'].append(entry)
            con.execute("UPDATE doc SET val=? WHERE key='mail'", (json.dumps(mail),))
        con.commit()
    finally:
        con.close()


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


    def _with_pin_hook(self, after_pin):
        """Run one write_org cold start with `after_pin` fired right after the
        warm pin; returns the advance results and what the cycle saw."""
        advanced: list[bool] = []
        orig_pin, orig_adv = store._load_pinned, store._advance_resident

        def pin(slug, **kw):
            out = orig_pin(slug, **kw)
            if slug == self.slug and not advanced:
                after_pin(slug)
            return out

        def adv(slug, d):
            ok = orig_adv(slug, d)
            advanced.append(ok)
            return ok
        store._load_pinned, store._advance_resident = pin, adv
        try:
            with store.write_org(self.slug) as org:
                seen = {k: list(v) for k, v in org.d['mail'].items()}
        finally:
            store._load_pinned, store._advance_resident = orig_pin, orig_adv
        return advanced, seen

    def test_invalidate_between_pin_and_advance_refuses_the_advance(self) -> None:
        # ws2's R1: an invalidation (a write the change sets never saw)
        # landing after the warm pin must make the advance refuse, so the
        # cycle falls back to a fresh load instead of a partial delta
        def after_pin(slug):
            _raw_mail_b(slug, {'id': 'raw'})
            store._invalidate_snapshot(slug)
        advanced, seen = self._with_pin_hook(after_pin)
        self.assertEqual(advanced, [False])
        self.assertEqual(seen['b'], [{'id': 'm2'}, {'id': 'raw'}])

    def test_node_insert_between_pin_and_advance_reaches_the_snapshot(self) -> None:
        # ws2's R2: the resident's advance must not consume the snapshot's
        # structural (insert/delete) flag, or the next refresh keeps the old
        # node order and the inserted node is missing from reads
        def after_pin(slug):
            _legacy_commit(slug, lambda d: d['nodes'].__setitem__(
                'c', {'id': 'c', 'name': 'c', 'parent': None, 'children': []}))
        advanced, _ = self._with_pin_hook(after_pin)
        self.assertEqual(advanced, [True])
        self.assertIn('c', store.cached_org(self.slug).d['nodes'])

if __name__ == '__main__':
    unittest.main()
