"""A skipped seat must count as SETTLED, or the `finally` resurrects a marker.

User ruling 2026-09-19: when restart recovery finds an agent has already
started a newer turn, the older interrupted replay is SKIPPED rather than
queued behind it. `reconcile` implements that with a `continue` — and with a
`dispatched += 1` beside it that is easy to read as bookkeeping and is not.

WHY THE COUNTER IS LOAD-BEARING. `reconcile`'s `finally` restores
`inflight[dispatched:]` — every seat the loop did not resolve — so that a
marker spent by a dispatch that then RAISED is not lost. `dispatched` is a
SLICE INDEX, not a tally, so a skip that does not advance it does not merely
forget one seat: it shifts the window, and the `finally` then restores the
marker of a LATER seat whose turn really was dispatched and whose marker was
legitimately spent. That seat is replayed a second time at the next boot.

That is a nastier failure than the one it looks like, and the existing
spend-race probe cannot see it: its victim is the LAST seat in the loop, so
nothing runs after the skip and the window never gets a chance to misalign.
This suite exists to put a seat AFTER the skipped one.

  §1  THE CLAIM. Three seats, the middle one skipped because a newer turn
      owns its marker. After the pass NO seat carries a stale marker — not
      the skipped one, and not the seat behind it in the loop.
  §2  THE CONTROL. The same three seats with nothing concurrent: every
      marker is spent and every seat is dispatched. Without this, §1 would
      pass just as well against a reconcile that had stopped working
      entirely and touched nothing.

    python -B tests/test_restart_skip_settles_the_seat.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_fx = tempfile.TemporaryDirectory(prefix='drop-replay-')
os.environ['ORGTREE_DATA'] = str(Path(_fx.name) / 'data')
os.environ['HOME'] = str(Path(_fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'drop-replay-only'
for _k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, supervisor as sup     # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

#: hire order IS loop order, and the point of this suite is that BEHIND is a
#: position that exists: the skipped seat must not be last.
SEATS = ('ahead', 'dropped', 'behind')
OLD_AT = '2026-09-19T00:00:00.000Z'
NEW_AT = '2026-09-19T05:55:55.555Z'


class DroppedReplaySettlesTheSeat(unittest.TestCase):

    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'drop-replay-{self.seq}'
        org = store.create_org(self.slug)
        for nid in SEATS:
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        store.save_org(org)
        with store.DOC_LOCK:
            o = store.load_org(self.slug)
            for nid in SEATS:
                o.node(nid)['inflight'] = {'at': OLD_AT,
                                           'text': f'OLD interrupted turn for {nid}',
                                           'view': f'OLD interrupted turn for {nid}'}
            store.save_org(o)
        self.addCleanup(store._POOL.close_all, self.slug)

    def run_pass(self, *, concurrent):
        """Run the real startup pass with the provider seam recorded.

        In the `concurrent` arm the world moves under the loop exactly as it
        does in production: while 'ahead' is being driven, a newer turn
        starts on 'dropped'; and while 'behind' is being driven, that newer
        turn ENDS and clears its own marker. The second half is what makes a
        misaligned restore window observable at all.
        """
        driven = []

        def drive(_slug, nid, text, **kw):
            driven.append(nid)
            if concurrent and nid == 'ahead':
                with store.DOC_LOCK:
                    o = store.load_org(_slug)
                    o.node('dropped')['inflight'] = {
                        'at': NEW_AT, 'text': 'a NEWER turn, running right now',
                        'view': 'a NEWER turn, running right now'}
                    store.save_org(o)
            if concurrent and nid == 'behind':
                with store.DOC_LOCK:
                    o = store.load_org(_slug)
                    o.node('dropped').pop('inflight', None)
                    store.save_org(o)
            return {'accepted': True, 'queued': 0}

        real = sup.send_message
        sup.send_message = drive
        try:
            sup.reconcile(self.slug, active_only=True)
        finally:
            sup.send_message = real
        store._POOL.close_all(self.slug)
        org = store.load_org(self.slug)
        return driven, {n: org.node(n).get('inflight') for n in SEATS}

    def test_1_no_seat_is_left_holding_a_stale_marker(self):
        """§1 THE CLAIM. The dropped seat is settled, so the restore
        window stays aligned and the seat BEHIND it keeps its marker spent."""
        driven, markers = self.run_pass(concurrent=True)

        self.assertNotIn('dropped', driven,
                         'the stale replay must not be dispatched once a '
                         'newer turn owns the seat')
        self.assertEqual(['ahead', 'behind'], driven, driven)

        stale = {n: m for n, m in markers.items()
                 if isinstance(m, dict) and m.get('at') == OLD_AT}
        self.assertEqual({}, stale,
                         'a pre-restart marker was put back on disk; the next '
                         f'boot would replay it again. markers={markers}')

    def test_2_CONTROL_the_ordinary_pass_still_spends_and_dispatches(self):
        """§2 THE CONTROL. Without it, §1 passes against a reconcile that
        stopped doing anything at all — no dispatches, nothing restored,
        and therefore no stale markers either."""
        driven, markers = self.run_pass(concurrent=False)
        self.assertEqual(list(SEATS), driven,
                         'every interrupted seat should be replayed when '
                         'nothing else has claimed it')
        self.assertEqual({n: None for n in SEATS},
                         {n: (m or None) for n, m in markers.items()},
                         f'every marker should be spent by its dispatch: {markers}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
