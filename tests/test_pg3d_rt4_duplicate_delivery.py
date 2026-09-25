"""RT4 (PYPG race test 4, owned by PG-3d): duplicate mail delivery.

A drained batch sits in the delivery journal (`delivering`). Two things can
race to settle it: the provider's confirmation (`_confirm_delivered`: it WAS
delivered) and the recovery fold-back (`reclaim_orphans`: put it back in the
box to be delivered again — a crash between send and delivery, or a
redelivered hint). Whatever the interleaving, the mail must be delivered
ONCE: either confirmed, or back in the box exactly once — never both — and a
second confirmation of the same batch writes no second receipt.

Each schedule is FORCED with PG-0's test pause hook: the first transaction
is held at `before_commit` while the second is started, and the test
asserts the second WAITS (it has not finished while the first is held).

CONTROL: the same confirm-first schedule with the fake's row locks disabled
(recorded as having run) lets the fold-back run beside the held
confirmation, and the mail is then both confirmed and back in the box — the
duplicate the row lock prevents.

Run:  python tools/run-python-verification.py tests/test_pg3d_rt4_duplicate_delivery.py
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

_root = tempfile.TemporaryDirectory(prefix='pg3d-rt4-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402

from orgtree import halt, ledger, maildrain, mailruntime, orgtx, store, supervisor as sup  # noqa: E402

# row-lock behaviour (and a lockless control that must NOT wait), which the
# transition fence (plan decision 19) would serialize away
orgtx.TRANSITION_FENCE = False

SLUGS: list[str] = []


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class Hold:
    """Hold the first transaction matching `pred` at before_commit."""

    def __init__(self, pred) -> None:
        self.pred = pred
        self.arrived = threading.Event()
        self.release = threading.Event()
        self.taken = False
        self.lock = threading.Lock()

    def __call__(self, point: str, tx: orgtx.OrgTx) -> None:
        if point != 'before_commit':
            return
        with self.lock:
            if self.taken or not self.pred(tx):
                return
            self.taken = True
        self.arrived.set()
        self.release.wait(30)


def is_confirm(tx: orgtx.OrgTx) -> bool:
    return 'delivering' in tx.lock_sections and 'mail' not in tx.lock_sections


def is_reclaim(tx: orgtx.OrgTx) -> bool:
    return 'delivering' in tx.lock_sections and 'mail' in tx.lock_sections


class RT4DuplicateDelivery(unittest.TestCase):
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(f'rt4-{self._testMethodName[-40:]}'.replace('_', '-'))
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        org.post_mail(ledger.USER, 'worker', 'deliver me once')
        maildrain.request(org, 'worker')
        mails = list(org.d['mail']['worker'])
        self.message = copy.deepcopy(mails[0])
        org.d['mail']['worker'] = []
        self.tok = sup._journal_drain(org, 'worker', mails, [], via='steer')
        org.d['delivering']['worker'][0]['at'] = '2000-01-01T00:00:00Z'   # stale: reclaimable
        store.save_org(org)
        self.st = sup.state(self.slug, 'worker')

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)
        maildrain._forget(self.slug, 'worker')
        halt._workers.pop((self.slug, 'worker'), None)
        sup._state.pop((self.slug, 'worker'), None)
        store._POOL.close_all(self.slug)

    # ---- the two racers
    def confirm(self) -> None:
        sup._confirm_delivered(self.slug, 'worker', [self.tok])

    def reclaim(self) -> None:
        # the fold-back runs as ANOTHER ENGINE would: with none of this
        # process's in-memory confirmation evidence (the row lock, not a
        # shared dict, is what must keep the two apart under PostgreSQL)
        sup._state.pop((self.slug, 'worker'), None)
        sup.reclaim_orphans(self.slug, 'worker', now=time.time())

    def race(self, hold: Hold, first, second) -> None:
        orgtx.set_pause_hook(hold)
        errors: list[BaseException] = []

        def run(fn):
            def go() -> None:
                try:
                    fn()
                except BaseException as e:   # noqa: BLE001
                    errors.append(e)
            t = threading.Thread(target=go, daemon=True)
            t.start()
            return t

        t1 = run(first)
        self.assertTrue(hold.arrived.wait(10), 'the first transaction never reached before_commit')
        t2 = run(second)
        t2.join(0.5)
        self.second_waited = t2.is_alive()
        hold.release.set()
        t1.join(20)
        t2.join(20)
        self.assertFalse(t1.is_alive() or t2.is_alive(), 'a racer did not finish')
        self.assertEqual(errors, [])

    # ---- the outcome
    def copies(self) -> tuple[int, int, int]:
        """(times confirmed, copies back in the box, journal rows left)"""
        d = store.load_org(self.slug).d
        confirmed = 1 if self.tok in mailruntime.confirmed_tokens(store.load_org(self.slug), 'worker') else 0
        boxed = sum(1 for m in (d.get('mail') or {}).get('worker') or []
                    if m.get('id') == self.message['id'])
        journal = len((d.get('delivering') or {}).get('worker') or [])
        return confirmed, boxed, journal

    def test_a_second_confirmation_waits_and_writes_no_second_receipt(self) -> None:
        self.race(Hold(is_confirm), self.confirm, self.confirm)
        self.assertTrue(self.second_waited, 'the second confirmation did not wait on the journal row')
        self.assertEqual(self.copies(), (1, 0, 0))
        d = store.load_org(self.slug).d
        rows = (d.get('mail_transitions') or {}).get('worker') or []
        rows = list(rows.values()) if isinstance(rows, dict) else list(rows)
        receipts = [r for r in rows if isinstance(r, dict) and self.tok in (r.get('before') or [])]
        self.assertEqual(len(receipts), 1, receipts)

    def test_confirm_first_then_fold_back_delivers_once(self) -> None:
        self.race(Hold(is_confirm), self.confirm, self.reclaim)
        self.assertTrue(self.second_waited, 'the fold-back did not wait on the held confirmation')
        self.assertEqual(self.copies(), (1, 0, 0), 'confirmed, and NOT back in the box')

    def test_fold_back_first_then_confirm_delivers_once(self) -> None:
        self.race(Hold(is_reclaim), self.reclaim, self.confirm)
        self.assertTrue(self.second_waited, 'the confirmation did not wait on the held fold-back')
        confirmed, boxed, journal = self.copies()
        self.assertEqual((confirmed, boxed, journal), (0, 1, 0), 'back in the box once, never confirmed too')
        row = next(m for m in store.load_org(self.slug).d['mail']['worker'] if m['id'] == self.message['id'])
        self.assertEqual(row.get('redelivered'), 1)
        self.assertEqual(row.get('recv_seq'), self.message.get('recv_seq'), 'receive order preserved')

    def test_control_without_row_locks_the_mail_is_delivered_twice(self) -> None:
        b = orgtx.SeamBackend()
        ran = {'skipped': 0}

        def no_lock(owner, key, exclusive, timeout) -> None:
            ran['skipped'] += 1

        b.locks.acquire = no_lock      # the unsafe control: no row locks at all
        orgtx.use_backend(b)
        self.race(Hold(is_confirm), self.confirm, self.reclaim)
        self.assertGreater(ran['skipped'], 0, 'the lock-skipping control never ran')
        self.assertFalse(self.second_waited, 'without locks the fold-back must not wait')
        confirmed, boxed, _ = self.copies()
        self.assertEqual((confirmed, boxed), (1, 1),
                         'CONTROL FAILED AS DESIGNED: confirmed AND back in the box = delivered twice')


if __name__ == '__main__':
    unittest.main()
