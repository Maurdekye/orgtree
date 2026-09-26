"""Fence-off S5, the receipt plumbing: OP_EPOCH, OP_LOOKUP and the legacy
seat_id mint run as org_tx row transactions when the door is on
(FENCE-OFF-PLAN S5; row plan S5-ROW-PLAN.md, docket item
fence-off-s5-operator-door-plumbing-and-reads-of).

What these prove, on PG-0's SeamBackend fake, door on, transition fence off:
  * none of the three waits on store.DOC_LOCK (another thread holds it; the
    old `write_org` / `with DOC_LOCK` bodies block until it lets go);
  * each holds exactly the row its answer depends on:
      - the epoch preflight waits while another transaction holds the
        receipt counter (op_receipts_meta) FOR UPDATE — the keyed call it
        must not read beside;
      - a lookup waits on the same row, so a keyed call with the same key
        and the lookup's fence serialise: either the call commits first and
        the lookup finds it applied, or the fence commits first and the
        call is refused;
      - the mint waits on the caller's node row, and two racing mints give
        ONE seat_id;
  * the behaviour is the legacy path's: tests/test_state_receipt_lookup_
    boundary.py runs again on the door in test_fence_s5_receipts_parity.py.

Run:  python tools/run-python-verification.py tests/test_fence_s5_receipts_door.py
"""
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='fence-s5-rcpt-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=str(Path(_temp.name)), ORGTREE_STORE='sqlite',
                  ORGTREE_PGDOOR='1', ORGTREE_STEER_HOOK='0')
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, opreceipts, orgtx, pgdoor, store, supervisor  # noqa: E402

orgtx.TRANSITION_FENCE = False      # what is proven is the row locks

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
RA = 'orgtree_reallocate'
ARGS = {'node': 'kid', 'delta': 1}
REQUEST = SimpleNamespace(state=SimpleNamespace())
FREE_S = 5.0
BLOCKED_S = 0.5
_N = [0]


def _org() -> str:
    _N[0] += 1
    slug = f'fs5c{_N[0]}'
    org = store.create_org(slug)
    org.hire(U, None, 'luna', 20, 'root')
    org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    org.hire('mid', 'mid', 'luna', 0, 'kid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    store.save_org(org)
    return slug


class _Held:
    """Hold a context manager (DOC_LOCK, or an org_tx on named rows) in a thread."""

    def __init__(self, cm_factory) -> None:
        self._f = cm_factory

    def __enter__(self) -> '_Held':
        self._in, self._out, self._err = threading.Event(), threading.Event(), []

        def run() -> None:
            try:
                with self._f():
                    self._in.set()
                    self._out.wait(30)
            except BaseException as e:            # noqa: BLE001
                self._err.append(e)
                self._in.set()
        self._t = threading.Thread(target=run, daemon=True)
        self._t.start()
        assert self._in.wait(10), 'holder never entered'
        assert not self._err, self._err
        return self

    def __exit__(self, *a) -> None:
        self._out.set()
        self._t.join(10)


def _run(fn, timeout: float):
    out: list = []

    def go() -> None:
        try:
            out.append(fn())
        except BaseException as e:                # noqa: BLE001
            out.append(e)
    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(timeout)
    return (not t.is_alive()), out, t


def call(slug, node, tool, args):
    return api.agent_call(api.AgentCall(org=slug, node=node, tool=tool, args=args),
                          REQUEST)


class _Base(unittest.TestCase):
    def setUp(self):
        self.assertTrue(pgdoor.enabled())
        self.slug = _org()
        self.p = [patch.object(supervisor, 'send_message', lambda *a, **k: {}),
                  patch.object(supervisor, 'delivery_note', lambda *a, **k: ''),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(api, 'mail_notify', lambda *a, **k: None)]
        for x in self.p:
            x.start()
        self.epoch = call(self.slug, 'mid', opreceipts.OP_EPOCH, {})['epoch']

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def lookup(self, key, node='mid'):
        return call(self.slug, node, opreceipts.OP_LOOKUP,
                    {'op_key': key, 'op_epoch': self.epoch, 'for_tool': RA,
                     'for_args': ARGS})

    def keyed(self, key, node='mid'):
        return call(self.slug, node, opreceipts.OP_CALL,
                    {'tool': RA, 'args': ARGS, 'op_key': key,
                     'op_epoch': self.epoch})

    def unminted(self):
        """The seat as the identity check sees it WITHOUT a seat_id, so the
        mint branch really runs (a load mints every missing seat_id itself —
        ledger's seat-id migration — so a stored node never lacks one). The
        mint's own transaction still loads the stored node, which has one:
        what it must return is that stored id, from its locked row. Returns
        the list the mint's org_tx calls are recorded in."""
        real_cached, real_tx = store.cached_org, orgtx.org_tx_call
        stored = store.load_org(self.slug).node('kid')['seat_id']
        self.stored_seat = stored
        calls: list = []

        def cached(slug):
            org = store.load_org(slug)
            org.node('kid').pop('seat_id', None)
            return org

        def tx_call(slug, fn, **names):
            calls.append(names)
            return real_tx(slug, fn, **names)
        for x in (patch.object(store, 'cached_org', cached),
                  patch.object(orgtx, 'org_tx_call', tx_call)):
            x.start()
            self.addCleanup(x.stop)
        return calls

    def rows(self, key):
        d = store.load_org(self.slug).d
        return [r for r in (d.get(opreceipts.SECTION) or []) if r.get('key') == key]


class NeverWaitsOnDocLock(_Base):
    def test_the_epoch_preflight(self):
        with _Held(lambda: store.DOC_LOCK):
            done, out, _t = _run(lambda: call(self.slug, 'mid', opreceipts.OP_EPOCH, {}),
                                 FREE_S)
        self.assertTrue(done, 'OP_EPOCH waited on DOC_LOCK')
        self.assertEqual(out[0]['epoch'], self.epoch)
        self.assertEqual(out[0]['minted'], '')

    def test_a_lookup_that_fences(self):
        key = opreceipts.mint_key()
        with _Held(lambda: store.DOC_LOCK):
            done, out, _t = _run(lambda: self.lookup(key), FREE_S)
        self.assertTrue(done, 'OP_LOOKUP waited on DOC_LOCK')
        self.assertEqual(out[0]['state'], 'not_applied', out)
        [row] = self.rows(key)
        self.assertEqual((row['node'], row['outcome']), ('mid', 'fenced'))

    def test_the_seat_id_mint(self):
        calls = self.unminted()
        body = api.AgentCall(org=self.slug, node='kid', tool='orgtree_status', args={})
        with _Held(lambda: store.DOC_LOCK):
            done, out, _t = _run(lambda: api._agent_identity(body, REQUEST, durable=True),
                                 FREE_S)
        self.assertTrue(done, 'the seat_id mint waited on DOC_LOCK')
        self.assertEqual(calls, [{'nodes': ['kid']}])     # the branch ran
        self.assertEqual(out[0].get('seat_id'), self.stored_seat)


class HoldsItsRow(_Base):
    def test_the_epoch_waits_for_a_writer_of_the_receipt_counter(self):
        with _Held(lambda: orgtx.org_tx(self.slug, sections=[opreceipts.META])):
            done, out, t = _run(lambda: call(self.slug, 'mid', opreceipts.OP_EPOCH, {}),
                                BLOCKED_S)
            self.assertFalse(done, 'OP_EPOCH read beside a META writer')
        t.join(FREE_S)
        self.assertFalse(t.is_alive())
        self.assertEqual(out[0]['epoch'], self.epoch)

    def test_the_epoch_does_not_wait_for_a_reader_of_it(self):
        with _Held(lambda: orgtx.org_tx(self.slug, share_sections=[opreceipts.META])):
            done, out, _t = _run(lambda: call(self.slug, 'mid', opreceipts.OP_EPOCH, {}),
                                 FREE_S)
        self.assertTrue(done, 'two epoch reads excluded each other')

    def test_a_lookup_waits_for_a_writer_of_the_receipt_counter(self):
        key = opreceipts.mint_key()
        with _Held(lambda: orgtx.org_tx(self.slug, sections=[opreceipts.META])):
            done, out, t = _run(lambda: self.lookup(key), BLOCKED_S)
            self.assertFalse(done, 'a lookup fenced beside a META writer')
        t.join(FREE_S)
        self.assertFalse(t.is_alive())
        self.assertEqual(out[0]['state'], 'not_applied', out)

    def test_the_mint_waits_for_the_seat_row(self):
        calls = self.unminted()
        body = api.AgentCall(org=self.slug, node='kid', tool='orgtree_status', args={})
        with _Held(lambda: orgtx.org_tx(self.slug, nodes=['kid'])):
            done, out, t = _run(lambda: api._agent_identity(body, REQUEST, durable=True),
                                BLOCKED_S)
            self.assertFalse(done, 'the mint wrote a seat row it did not hold')
        t.join(FREE_S)
        self.assertFalse(t.is_alive())
        self.assertEqual(calls, [{'nodes': ['kid']}])
        self.assertEqual(out[0].get('seat_id'), self.stored_seat)


class LookupAtTheCeiling(_Base):
    def test_a_fence_that_evicts_commits_and_the_watermark_rises(self):
        # p01 (S5 review, Q3): the fence append is the one that crosses
        # CEILING, so it also evicts (a slice rewrite of the receipt log) —
        # logs=[op_receipts] admits it, META FOR UPDATE orders it
        import time
        org = store.load_org(self.slug)
        d = org.d
        now = int(time.time() * 1000)
        for i in range(opreceipts.CEILING):
            opreceipts.append(d, opreceipts.row(
                op_id=opreceipts.new_id(), node='mid', generation=0,
                key=f'fill-{i}', mint_ms=now - 60_000 + i, tool=RA, args=ARGS,
                cls='applied', outcome='applied', at=ledger.now()))
        store.save_org(org)
        before = dict(store.load_org(self.slug).d[opreceipts.META])
        self.assertEqual(len(store.load_org(self.slug).d[opreceipts.SECTION]),
                         opreceipts.CEILING)
        key = opreceipts.mint_key()
        self.assertEqual(self.lookup(key)['state'], 'not_applied')
        after_d = store.load_org(self.slug).d
        log, meta = after_d[opreceipts.SECTION], after_d[opreceipts.META]
        self.assertEqual(len(log), opreceipts.TRIM_TO)        # evicted, persisted
        self.assertEqual([r['outcome'] for r in log if r.get('key') == key], ['fenced'])
        self.assertGreater(int(meta['from_ms']), int(before.get('from_ms') or 0))
        self.assertEqual(int(meta['seq']), int(before['seq']) + 1)


class LookupAgainstTheCall(_Base):
    """The one property the lookup exists for: a keyed call and a lookup for
    the SAME key never both succeed and never both miss."""

    def test_the_call_first_then_the_lookup_finds_it(self):
        key = opreceipts.mint_key()
        self.keyed(key)
        self.assertEqual(self.lookup(key)['state'], 'applied')

    def test_the_fence_first_then_the_call_is_refused(self):
        key = opreceipts.mint_key()
        self.assertEqual(self.lookup(key)['state'], 'not_applied')
        with self.assertRaises(HTTPException) as cm:
            self.keyed(key)
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('op_key refused (fenced)', str(cm.exception.detail))
        self.assertEqual(store.load_org(self.slug).node('kid')['grant'], 0)

    def test_racing_they_serialise_on_the_counter(self):
        # both start while a third transaction holds META: when it lets go
        # they run one after the other, whichever goes first
        for _ in range(4):
            key = opreceipts.mint_key()
            res: dict = {}
            with _Held(lambda: orgtx.org_tx(self.slug, sections=[opreceipts.META])):
                a = threading.Thread(target=lambda: res.__setitem__(
                    'call', _catch(lambda: self.keyed(key))), daemon=True)
                b = threading.Thread(target=lambda: res.__setitem__(
                    'look', _catch(lambda: self.lookup(key))), daemon=True)
                a.start()
                b.start()
                a.join(BLOCKED_S)
                self.assertTrue(a.is_alive() and b.is_alive())
            a.join(FREE_S)
            b.join(FREE_S)
            call_ok = not isinstance(res['call'], BaseException)
            state = res['look']['state']
            # exactly one of: applied-and-found, or fenced-and-refused
            self.assertIn((call_ok, state), {(True, 'applied'), (False, 'not_applied'),
                                             (True, 'running')}, res)
            outcomes = sorted(r['outcome'] for r in self.rows(key))
            self.assertEqual(len(outcomes), 1, outcomes)


def _catch(fn):
    try:
        return fn()
    except BaseException as e:                    # noqa: BLE001
        return e


if __name__ == '__main__':
    unittest.main()
