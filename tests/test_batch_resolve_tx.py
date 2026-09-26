"""fence-off S2: resolving a request batch is ONE row transaction.

`batch_resolve` (FR-14: an agent's open ask, credit request and scope request
answered by one submit) used to run in `store.write_org`. It is now one door
transaction on `api._batch_rows` — never split: the answers, the credit
decision, the scope grant and the composed mail commit together or not at
all. What must hold (fence off):

  1. a full batch resolves with no DOC_LOCK taken, and every part lands;
  2. a batch that GREW between the lock-free read and the lock (a credit
     request filed in between) widens and re-runs instead of writing an
     unlocked row or refusing (lead C3);
  3. when the lock set keeps growing past the bound, the answer is 409 and
     NOTHING was applied.

Run:  python tools/run-python-verification.py tests/test_batch_resolve_tx.py
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='batch-resolve-tx-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class _NoDocLock:
    def _boom(self, *a, **k):
        raise AssertionError('DOC_LOCK was taken')
    acquire = __enter__ = _boom

    def __exit__(self, *a):
        return False

    def release(self):
        raise AssertionError('DOC_LOCK was released without being taken')

    def _is_owned(self):
        return False


class BatchTx(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:60]
        self.dir = tempfile.mkdtemp(dir=_root.name)
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 20, 'top')
        org.hire('top', 'top', 'haiku', 2, 'mid')
        store.save_org(org)
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        self.addCleanup(store._POOL.close_all, self.slug)
        for p in (patch.object(api, 'hub_changed'), patch.object(api, 'mail_notify'),
                  patch.object(supervisor, 'send_message', return_value={'accepted': True})):
            p.start()
            self.addCleanup(p.stop)

    def file(self, *, ask=True, credit=True, scope=True):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            if ask:
                org.ask_user('mid', 'Proceed?', options=[{'label': 'yes'}, {'label': 'no'}])
            if credit:
                org.request_credits('mid', 5, 'need more')
            if scope:
                org.request_scope('mid', [{'kind': 'dir', 'path': self.dir, 'mode': 'ro'}],
                                  'need the folder')
            store.save_org(org)

    def revs(self, org=None):
        org = org or orgtx.org_read(self.slug)
        out = {}
        for key, table, open_ in (('ask', 'asks', 'open'),
                                  ('credits', 'credit_requests', 'pending'),
                                  ('scope', 'scope_requests', 'pending')):
            row = next((r for r in org.d.get(table, [])
                        if r['node'] == 'mid' and r['status'] == open_), None)
            if row is not None:
                out[key] = row.get('rev') or 1
        return out

    def body(self, revs):
        return api.BatchResolve(revs=revs,
                                answers=['yes'] if 'ask' in revs else None,
                                credits={'granted': 5} if 'credits' in revs else None,
                                scope=['approve'] if 'scope' in revs else None)

    def state(self):
        org = orgtx.org_read(self.slug)
        return ({r['status'] for r in org.d.get('asks', []) if r['node'] == 'mid'},
                {r['status'] for r in org.d.get('credit_requests', []) if r['node'] == 'mid'},
                {r['status'] for r in org.d.get('scope_requests', []) if r['node'] == 'mid'},
                [d['path'] for d in org.node('mid')['scope']['add_dirs']])

    def test_a_full_batch_resolves_without_doc_lock(self):
        self.file()
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            r = api.batch_resolve(self.slug, 'mid', self.body(self.revs()))
        self.assertEqual(r, {'resolved': 'mid'})
        asks, credits, scopes, dirs = self.state()
        self.assertNotIn('open', asks)
        self.assertNotIn('pending', credits)
        self.assertNotIn('pending', scopes)
        self.assertIn(self.dir, dirs)

    def test_a_batch_that_grew_since_the_read_widens_and_lands(self):
        """The lock-free read sees only the ask; the credit and scope
        requests are already committed when the transaction locks. The
        submit carries all three (the user's card was newer than the read).
        The transaction must widen to their rows and apply everything."""
        self.file(credit=False, scope=False)
        stale = orgtx.org_read(self.slug)
        self.file(ask=False)
        revs = self.revs()
        real = orgtx.org_read
        reads = []

        def read(slug):
            reads.append(slug)
            return copy.deepcopy(stale) if len(reads) == 1 else real(slug)
        seen = []
        rows = api._batch_rows

        def counted(org, nid):
            seen.append(bool(org.d.get('credit_requests')))
            return rows(org, nid)
        with patch.object(orgtx, 'org_read', side_effect=read), \
                patch.object(api, '_batch_rows', side_effect=counted):
            api.batch_resolve(self.slug, 'mid', self.body(revs))
        self.assertEqual(seen[0], False, 'the transaction was not opened from the stale read')
        self.assertGreaterEqual(len(seen), 3, f'no widening re-run happened: {seen}')
        asks, credits, scopes, dirs = self.state()
        self.assertNotIn('pending', credits)
        self.assertIn(self.dir, dirs)

    def test_a_lock_set_that_keeps_growing_is_409_and_applies_nothing(self):
        self.file(credit=False, scope=False)
        stale = orgtx.org_read(self.slug)
        self.file(ask=False)
        revs = self.revs()
        real = orgtx.org_read
        reads = []

        def read(slug):
            reads.append(slug)
            return copy.deepcopy(stale) if len(reads) == 1 else real(slug)
        before = self.state()
        with patch.object(orgtx, 'org_read', side_effect=read), \
                patch.object(pgdoor, 'MAX_WIDEN', 0):
            with self.assertRaises(api.HTTPException) as e:
                api.batch_resolve(self.slug, 'mid', self.body(revs))
        self.assertEqual(e.exception.status_code, 409, e.exception.detail)
        self.assertEqual(self.state(), before, 'a refused batch applied something')
        supervisor.send_message.assert_not_called()


if __name__ == '__main__':
    unittest.main()
