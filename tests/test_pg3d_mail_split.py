"""PG-3d: the per-owner split of the mail queues (store.SPLIT_SECTIONS).

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * `mail`, `delivering` and `notices` are stored as a container `doc` row
    plus one row per owner, and load back to exactly the same value;
  * a pre-split whole-section blob loads as it is and the next save turns it
    into rows (the blob row becomes the empty container);
  * a save that changes one owner's queue writes that owner's row only, and
    removing an owner deletes its row;
  * `org_tx(sections=[("mail", a)])` may write a's queue and is refused
    (UnlockedWrite, nothing lands) when it writes b's;
  * two transactions on different owners' queues hold their locks AT THE
    SAME TIME, while the same owner, or the whole section, waits (the
    controls, each of which must actually time out);
  * the snapshot/resident caches see an owner-row change.

Run:  python tools/run-python-verification.py tests/test_pg3d_mail_split.py
"""

import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-pg3d-split-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402

# row-lock behaviour; the transition fence would serialize it away
orgtx.TRANSITION_FENCE = False

SEP = store.SPLIT_SEP


def tearDownModule() -> None:
    _temp.cleanup()


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in ('a', 'b'):
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
    org.d['mail'] = {'a': [{'id': 'm1', 'body': 'x'}], 'b': [{'id': 'm2', 'body': 'y'}]}
    org.d['delivering'] = {'a': []}
    org.d['notices'] = {'b': [{'text': 'n'}]}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _doc_rows(slug: str) -> dict[str, str]:
    with store._POOL.acquire(slug) as conn:
        return {k: v for k, v in conn.execute("SELECT key, val FROM doc").fetchall()}


class SplitStorage(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = _fresh_org(f'split-{self._testMethodName}'[:58].replace('_', '-'))

    def test_rows_and_round_trip(self) -> None:
        rows = _doc_rows(self.slug)
        self.assertEqual(rows['mail'], '{}')
        self.assertEqual(json.loads(rows['mail' + SEP + 'a']), [{'id': 'm1', 'body': 'x'}])
        self.assertEqual(json.loads(rows['mail' + SEP + 'b']), [{'id': 'm2', 'body': 'y'}])
        self.assertEqual(json.loads(rows['delivering' + SEP + 'a']), [])
        self.assertEqual(rows['notices'], '{}')
        self.assertIn('notices' + SEP + 'b', rows)
        d = store.load_org(self.slug).d
        self.assertEqual(dict(d['mail']), {'a': [{'id': 'm1', 'body': 'x'}],
                                           'b': [{'id': 'm2', 'body': 'y'}]})
        self.assertEqual(dict(d['delivering']), {'a': []})
        self.assertEqual(dict(d['notices']), {'b': [{'text': 'n'}]})

    def test_one_owner_change_writes_one_row_and_removal_deletes(self) -> None:
        org = store.load_org(self.slug)
        org.d['mail']['a'].append({'id': 'm3', 'body': 'z'})
        seen: list[dict] = []
        orig = store._publish_changes

        def spy(slug, changes):
            seen.append(changes.as_dict())
            return orig(slug, changes)
        store._publish_changes = spy
        try:
            store.save_org(org)
            self.assertEqual(seen[-1]['doc_upserts'], ['mail' + SEP + 'a'])
            org = store.load_org(self.slug)
            org.d['mail'].pop('b')
            store.save_org(org)
            self.assertEqual(seen[-1]['doc_deletes'], ['mail' + SEP + 'b'])
            self.assertEqual(seen[-1]['doc_upserts'], [])
        finally:
            store._publish_changes = orig
        rows = _doc_rows(self.slug)
        self.assertNotIn('mail' + SEP + 'b', rows)
        self.assertEqual(len(json.loads(rows['mail' + SEP + 'a'])), 2)

    def test_legacy_blob_loads_and_converts(self) -> None:
        blob = {'a': [{'id': 'old'}], 'c': []}
        with store._POOL.acquire(self.slug) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM doc WHERE substr(key,1,5)=?", ('mail' + SEP,))
            conn.execute("UPDATE doc SET val=? WHERE key='mail'", (json.dumps(blob),))
            conn.execute("COMMIT")
        store._resident.pop(self.slug, None)
        store._publish_changes_unknown(self.slug)
        org = store.load_org(self.slug)
        self.assertEqual(dict(org.d['mail']), blob)
        org.d['mail']['a'].append({'id': 'new'})
        store.save_org(org)
        rows = _doc_rows(self.slug)
        self.assertEqual(rows['mail'], '{}')
        self.assertEqual(json.loads(rows['mail' + SEP + 'a']), [{'id': 'old'}, {'id': 'new'}])
        self.assertEqual(json.loads(rows['mail' + SEP + 'c']), [])
        self.assertEqual(dict(store.load_org(self.slug).d['mail']),
                         {'a': [{'id': 'old'}, {'id': 'new'}], 'c': []})

    def test_owner_lock_admits_own_row_refuses_another(self) -> None:
        with orgtx.org_tx(self.slug, sections=[('mail', 'a')]) as tx:
            tx.d['mail']['a'].append({'id': 'ok'})
        self.assertEqual(store.load_org(self.slug).d['mail']['a'][-1], {'id': 'ok'})
        before = _doc_rows(self.slug)
        with self.assertRaises(orgtx.UnlockedWrite) as cm:
            with orgtx.org_tx(self.slug, sections=[('mail', 'a')]) as tx:
                tx.d['mail']['a'].append({'id': 'a2'})
                tx.d['mail']['b'].append({'id': 'b2'})
        self.assertIn(('section', 'mail' + SEP + 'b'), cm.exception.rows)
        self.assertEqual(_doc_rows(self.slug), before)         # nothing landed
        # a whole-section lock may write any owner, and add one
        with orgtx.org_tx(self.slug, sections=['mail']) as tx:
            tx.d['mail']['b'].append({'id': 'b3'})
            tx.d['mail']['new'] = []
        self.assertIn('mail' + SEP + 'new', _doc_rows(self.slug))

    def test_bad_names_refused(self) -> None:
        for bad in ([('events', 'a')], [('mail',)], ['mail' + SEP + 'a'], [('mail', '')]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                with orgtx.org_tx(self.slug, sections=bad):
                    pass

    def test_owner_rows_lock_in_parallel_and_same_owner_or_whole_waits(self) -> None:
        inside = threading.Event()
        release = threading.Event()
        errors: list[BaseException] = []

        def holder() -> None:
            try:
                with orgtx.org_tx(self.slug, sections=[('mail', 'a')]) as tx:
                    tx.d['mail']['a'].append({'id': 'held'})
                    inside.set()
                    release.wait(10)
            except BaseException as e:           # pragma: no cover - reported below
                errors.append(e)

        t = threading.Thread(target=holder, daemon=True)
        t.start()
        self.assertTrue(inside.wait(5), 'holder never got its lock')
        try:
            # another owner: granted while a's lock is held
            with orgtx.org_tx(self.slug, sections=[('mail', 'b')], lock_timeout=2,
                              retries=0) as tx:
                tx.d['mail']['b'].append({'id': 'parallel'})
            parallel_committed = True
            # CONTROLS: the same owner, and the whole section, must wait
            timed_out = []
            for spec in ([('mail', 'a')], ['mail']):
                try:
                    with orgtx.org_tx(self.slug, sections=spec, lock_timeout=0.5,
                                      retries=0):
                        pass
                except orgtx.LockTimeout:
                    timed_out.append(repr(spec))
        finally:
            release.set()
            t.join(10)
        self.assertEqual(errors, [])
        self.assertTrue(parallel_committed)
        self.assertEqual(timed_out, [repr([('mail', 'a')]), repr(['mail'])])
        mail = store.load_org(self.slug).d['mail']
        self.assertEqual(mail['a'][-1], {'id': 'held'})
        self.assertEqual(mail['b'][-1], {'id': 'parallel'})

    def test_shared_snapshot_refresh_reads_owner_rows(self) -> None:
        store.cached_org(self.slug)                          # first build
        assembled: list[bool] = []
        orig = store._assemble_snapshot

        def spy(slug, prev):
            out = orig(slug, prev)
            assembled.append(out is not None)
            return out
        store._assemble_snapshot = spy
        try:
            with orgtx.org_tx(self.slug, sections=[('mail', 'b')]) as tx:
                tx.d['mail']['b'].append({'id': 'tx1'})
            snap = store.cached_org(self.slug)
        finally:
            store._assemble_snapshot = orig
        self.assertEqual(assembled, [True])     # the section-granular path ran
        self.assertEqual(snap.d['mail']['b'][-1], {'id': 'tx1'})
        self.assertEqual(snap.d['mail']['a'], [{'id': 'm1', 'body': 'x'}])

    def test_resident_cold_start_advance_reads_owner_rows(self) -> None:
        store._resident.pop(self.slug, None)
        advanced: list[bool] = []
        orig_pin, orig_adv = store._load_pinned, store._advance_resident

        def pin(slug):
            out = orig_pin(slug)
            if slug == self.slug and not advanced:
                # a commit AFTER the pin: the advance must re-read it
                with orgtx.org_tx(slug, sections=[('mail', 'b')]) as tx:
                    tx.d['mail']['b'].append({'id': 'late'})
            return out

        def adv(slug, d):
            ok = orig_adv(slug, d)
            advanced.append(ok)
            return ok
        store._load_pinned, store._advance_resident = pin, adv
        try:
            with store.write_org(self.slug) as org:
                mail = {k: list(v) for k, v in org.d['mail'].items()}
        finally:
            store._load_pinned, store._advance_resident = orig_pin, orig_adv
        self.assertEqual(advanced, [True])      # the advance ran and was trusted
        self.assertIs(store._resident.get(self.slug) is not None, True)
        self.assertEqual(mail['b'][-1], {'id': 'late'})
        self.assertEqual(mail['a'], [{'id': 'm1', 'body': 'x'}])


if __name__ == '__main__':
    unittest.main()
