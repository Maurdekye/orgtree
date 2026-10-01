"""PG-3e-A: turn admission's DRAIN transaction really runs on `org_tx`.

The mail-drain tests (test_mail_drain.py and friends) stub `_run_one_turn`,
so they never reach the slot gate; dropping "mail" from the drain
transaction's locked sections left all of them green. These tests run the
real `_run_one_turn_recorded` over a real boxed message and stop it one
statement after the drain transaction commits (`_mail_block` is the first
call past it), then read what was COMMITTED:

  * the positive case: the message left the box and a delivery-journal row
    for it exists, written by exactly one org_tx commit whose change set
    names `mail` and `delivering`;
  * the negative control: with `mail` removed from the drain's locked
    sections, the commit is refused (`UnlockedWrite`), the sentinel is never
    reached and the message is still boxed. It proves the row set is
    enforced here, not merely declared.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='pg3e-admission-tx-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import halt, ledger, orgtx, store, supervisor as sup

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class Reached(RuntimeError):
    """Raised by the sentinel just past the drain transaction."""


class DrainTxTests(unittest.TestCase):

    def setUp(self):
        self.slug = 'drain-' + self._testMethodName[5:].replace('_', '-')[-24:].strip('-')
        org = store.create_org(self.slug)
        store.load_org(self.slug)  # the slug round-trips, or setUp fails here
        org.hire(ledger.USER, None, 'opus', 0, 'worker')
        m = org.post_mail(ledger.USER, 'worker', 'hello from the user')
        self.mail_id = str(m['id'])
        store.save_org(org)
        self.reached = 0
        self.at_sentinel: dict = {}
        self.commits: list[orgtx.Committed] = []
        orgtx.commit_listeners.append(self.commits.append)
        self.patches = [
            patch.object(sup, 'spawn_env', return_value={}),
            patch.object(sup, '_deployment_org_gate'),
            # turn-tx merge S2: the envelope is composed INSIDE the admission
            # transaction now; the first call past its commit is the state block
            patch.object(sup, '_envelope_state_block', side_effect=self._sentinel),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        orgtx.commit_listeners.remove(self.commits.append)
        store._POOL.close_all(self.slug)

    def _sentinel(self, *a, **kw):
        # Read what is COMMITTED at this instant, before the turn's own
        # failure handling folds anything back.
        self.reached += 1
        org = store.load_org(self.slug)
        self.at_sentinel = {
            'box': [str(m.get('id')) for m in
                    (org.d.get('mail') or {}).get('worker') or []],
            'journal': list((org.d.get('delivering') or {}).get('worker') or []),
        }
        raise Reached('past the drain transaction')

    def admit(self):
        try:
            sup._run_one_turn_recorded(self.slug, 'worker', 'go')
        except Exception:                                    # noqa: BLE001
            pass

    def test_the_drain_commits_on_org_tx(self):
        self.admit()
        self.assertEqual(self.reached, 1, 'the turn never got past the drain')
        self.assertNotIn(self.mail_id, self.at_sentinel['box'])
        self.assertEqual(len(self.at_sentinel['journal']), 1,
                         self.at_sentinel['journal'])
        drains = [c for c in self.commits
                  if c.slug == self.slug
                  # PG-3d 24f4117 splits mail/delivering per owner: the
                  # doc row key is 'mail\x1fworker', not 'mail', and the
                  # emptied box is a row DELETE rather than an upsert
                  and {'mail', 'delivering'} <= {k.split('\x1f')[0] for k
                                                 in [*c.changes.doc_upserts,
                                                     *c.changes.doc_deletes]}]
        self.assertEqual(len(drains), 1, [(c.changes.doc_upserts, c.changes.doc_deletes) for c in self.commits])

    def test_an_unlocked_mailbox_write_is_refused(self):
        real = sup._admission_rows

        def without_mail(slug, nid, *, compact=False):
            rows = real(slug, nid, compact=compact)
            if not compact:
                # PG-3d names the box per owner, ('mail', nid); strip either
                # spelling, and count only a strip that removed something
                kept = [s for s in rows['sections']
                        if s != 'mail' and not (isinstance(s, tuple)
                                                and s[0] == 'mail')]
                if len(kept) < len(rows['sections']):
                    self.stripped += 1
                rows['sections'] = kept
            return rows
        self.stripped = 0
        with patch.object(sup, '_admission_rows', side_effect=without_mail):
            self.admit()
        self.assertEqual(self.stripped, 1, 'the drain transaction never asked '
                                           'for a mailbox row: the control '
                                           'did not run')
        self.assertEqual(self.reached, 0,
                         'the drain committed without locking `mail`')
        org = store.load_org(self.slug)
        box = [str(m.get('id')) for m in
               (org.d.get('mail') or {}).get('worker') or []]
        self.assertIn(self.mail_id, box)
        self.assertFalse((org.d.get('delivering') or {}).get('worker'))

    def test_a_phantom_ping_is_dropped_without_an_inflight_marker(self):
        """turn-tx merge S2: the phantom decision is made INSIDE the merged
        admission transaction; the in-flight record must not be written
        for a turn that is then dropped (a stale marker would be resumed
        by reconcile as if the turn had been interrupted)."""
        org = store.load_org(self.slug)
        org.d['mail']['worker'] = []          # the box emptied during the slot wait
        org.node('worker')['last_status'] = {'state': 'done', 'text': 'fixture'}
        store.save_org(org)
        dropped = []
        with patch.object(sup, '_drop_ping',
                          side_effect=lambda s, n: dropped.append(n) or None):
            sup._run_one_turn_recorded(
                self.slug, 'worker',
                sup._mark_ping('(orgtree) new mail', mail_ids=[self.mail_id]))
        self.assertEqual(dropped, ['worker'], 'the phantom ping was not dropped')
        self.assertEqual(self.reached, 0)
        node = store.load_org(self.slug).node('worker')
        self.assertIsNone(node.get('inflight'),
                          'a dropped phantom turn left an in-flight marker')
        # the in-flight record also retires the status chip; a turn that
        # never ran must leave it alone
        self.assertEqual(node.get('last_status'), {'state': 'done', 'text': 'fixture'})

    def test_user_images_load_outside_the_admission_transaction(self):
        """turn-tx merge S2 (review f1): the envelope is composed inside the
        admission transaction, which locks org-wide `mail_transitions`; the
        user's inline images must be read and encoded BEFORE it opens, never
        under its locks."""
        import os
        from PIL import Image
        from orgtree import imgblock
        up = os.path.join(sup.scratch_dir(self.slug, 'worker'), 'uploads')
        os.makedirs(up, exist_ok=True)
        Image.new('RGB', (8, 8), (200, 10, 10)).save(os.path.join(up, 'pic.png'))
        size = os.path.getsize(os.path.join(up, 'pic.png'))
        org = store.load_org(self.slug)
        org.post_mail(ledger.USER, 'worker', 'look at this',
                      attachments=[{'path': 'uploads/pic.png', 'bytes': size,
                                    'name': 'pic.png'}])
        store.save_org(org)
        loads = []
        real = imgblock._load_image_io

        def spy(path):
            loads.append(orgtx.current_tx(self.slug))
            return real(path)
        with patch.object(imgblock, '_load_image_io', side_effect=spy):
            self.admit()
        self.assertEqual(self.reached, 1, 'the turn never got past the drain')
        self.assertTrue(loads, 'the image was never loaded: the control did not run')
        self.assertTrue(all(tx is None for tx in loads),
                        f'an image was read inside a transaction: {loads}')


class CompactionRowsTests(unittest.TestCase):
    """Review N1: the compaction transaction (tx1) runs on every ordinary
    admission, so it names the agent's own and its planned parent's
    `notices` rows, never the whole container; and it compacts only when
    every row the compaction writes is actually locked."""

    def setUp(self):
        self.slug = 'n1-' + self._testMethodName[5:].replace('_', '-')[-24:].strip('-')
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 0, 'boss')
        org.hire(ledger.USER, None, 'opus', 0, 'other')
        org.hire(ledger.USER, 'boss', 'opus', 0, 'child')
        store.save_org(org)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def test_tx1_names_own_and_parent_notices_rows_only(self):
        rows = sup._admission_rows(self.slug, 'child', compact=True)
        self.assertNotIn('notices', rows['sections'])
        self.assertEqual(sorted(rows['sections']),
                         [('notices', 'boss'), ('notices', 'child')])
        top = sup._admission_rows(self.slug, 'boss', compact=True)
        self.assertEqual(top['sections'], [('notices', 'boss')])

    def test_planned_rows_are_locked(self):
        with halt.txn(self.slug, **sup._admission_rows(
                self.slug, 'child', compact=True)) as tx:
            self.assertTrue(sup._admission_pred_locked(tx, tx.org, 'child'))

    def test_a_parent_moved_after_planning_skips_the_compaction(self):
        rows = sup._admission_rows(self.slug, 'child', compact=True)
        org = store.load_org(self.slug)
        org.move(ledger.USER, 'child', 'other')
        store.save_org(org)
        with halt.txn(self.slug, **rows) as tx:
            self.assertEqual(tx.org.node('child').get('parent'), 'other')
            self.assertFalse(sup._admission_pred_locked(tx, tx.org, 'child'))

    def test_a_held_notices_container_covers_the_parent_row(self):
        rows = sup._admission_rows(self.slug, 'child', compact=True)
        rows['sections'] = ['notices']
        with halt.txn(self.slug, **rows) as tx:
            self.assertTrue(sup._admission_pred_locked(tx, tx.org, 'child'))


if __name__ == '__main__':
    unittest.main()
