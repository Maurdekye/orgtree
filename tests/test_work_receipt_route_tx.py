"""PG-3w: the agent `receipt` action's two phases off DOC_LOCK.

`api._work_receipt_call` reads the item's rev (lock-free `org_read`), measures
the tree with NO lock held, then writes in one `org_tx` with a compare-and-set
on that rev. These drive the REAL call path (`api._work_read_call`) with the
tree measurement faked, and prove:
  * an unchanged item takes the receipt row, once, and its rev advances;
  * an item another writer changed DURING the measurement is refused with
    `stale` and NOTHING is written — the property the two-phase shape exists
    for. (Mutating the compare-and-set away must fail this test.)

Run:  python tools/run-python-verification.py tests/test_work_receipt_route_tx.py
"""

import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

_temp = tempfile.TemporaryDirectory(prefix='v3-receipt-tx-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import events, events_render  # noqa: E402,F401
from orgtree import api, orgtx, store, worktx  # noqa: E402
from orgtree import workevidence as we  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

_n = 0
_real_receipt = we.receipt


def _tree():
    return {"checkout": ".", "commit": "a" * 40, "base": None,
            "state": we.TREE_CLEAN, "dirty_paths": [], "dirty_count": 0,
            "in_progress": "", "fingerprint": "sha256:fixed",
            "observed_at": "2026-09-25T00:00:00+00:00", "detail": ""}


class ReceiptRouteTx(unittest.TestCase):
    def setUp(self):
        global _n
        _n += 1
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(f'rcpt-{_n}')
        self.slug = org.d['slug']
        org.hire(USER, None, 'haiku', 0, 'own')
        org.work_create('own', 'Receipt fixture',
                        objective='Problem: receipts under DOC_LOCK. Solution: org_tx.')
        store.save_org(org)
        store.save_org(store.load_org(self.slug))
        self.wid = store.load_org(self.slug).d['work_items'][-1]['slug']
        self.during = None       # a write another agent makes mid-measurement
        self.stack = __import__('contextlib').ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(api, '_work_checkout',
                                                   return_value='.'))
        self.stack.enter_context(mock.patch.object(api, '_work_receipt_logs',
                                                   return_value=[]))
        self.stack.enter_context(mock.patch.object(we, 'receipt', self._measure))

    def _measure(self, **kw):
        # the slow outside-world phase: no lock is held here, so another
        # writer CAN commit — and when the test says so, one does
        if self.during is not None:
            self.during()
        kw['tree'] = _tree()
        return _real_receipt(**kw)

    def item(self):
        return next(i for i in store.load_org(self.slug).d['work_items']
                    if i['slug'] == self.wid)

    def call(self):
        body = SimpleNamespace(org=self.slug, node='own', tool='orgtree_work', op_key='')
        return api._work_read_call(body, {
            'action': 'receipt', 'slug': self.wid, 'checkout': '.',
            'candidate': 'abc1234', 'command': ['pytest', '-k', 'x'],
            'execution': 'independent', 'result': 'passed'})

    def test_unchanged_item_takes_the_receipt_once(self):
        r0 = int(self.item()['rev'])
        out = self.call()
        self.assertNotIn('stale', out)
        it = self.item()
        self.assertEqual(int(it['rev']), r0 + 1)
        rows = [e for e in it.get('evidence') or [] if e.get('receipt')]
        self.assertEqual(len(rows), 1)

    def test_item_changed_during_measurement_is_stale_and_writes_nothing(self):
        def other_writer():
            worktx.run(self.slug, lambda o: o.work_decision(
                'own', self.wid, 'Changed while the tree was measured.'))
        self.during = other_writer
        out = self.call()
        self.assertTrue(out.get('stale'), out)
        it = self.item()
        self.assertFalse([e for e in it.get('evidence') or [] if e.get('receipt')],
                         'a stale receipt was written')
        self.assertTrue(any('Changed while' in str(s) for s in it.get('scope') or []),
                        'the control write never happened, so this proved nothing')


if __name__ == '__main__':
    unittest.main()
