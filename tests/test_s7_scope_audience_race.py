"""Fence-off S7 follow-up (p01's L1 review; coordinator decision 4 on
s7-sessions-and-accounts-off-doc-lock-reconcile): the READ side of
orgtree_request_scope on the door.

`Org.request_scope` decides whether a deep agent's request ROUTES to its
superior as mail or is FILED as a `scope_requests` row by asking whether the
agent holds a user audience. On the door (accountdoor) it holds `audiences`
FOR SHARE for the whole transaction, and an audience grant (maildoor's
orgtree_audience) writes that row FOR UPDATE. So the two are ordered by the
row lock and the decision always matches the committed audience state:

  * grant first  — the request parks on the audiences row until the grant
    commits, then sees the audience and FILES (nothing is mailed);
  * request first — the grant parks until the request commits; the request
    saw no audience and ROUTED to the superior (nothing is filed).

FINDING (reported to p01): with today's writers the two are ordered by the
superior's NODE row first (maildoor's grant locks the caller; the routed
request locks its superior), and a user-route grant locks the grantee's node
row, which the request's caller row also is. So the audiences FOR SHARE is a
second guarantee for them; the third test pins it on its own, with a writer
that holds nothing but the audiences row. (A request planned while the agent
had NO audience plans to route, and the mail rows take audiences FOR UPDATE —
stronger still; the FOR SHARE case is the filing plan.)

Each wait is proven from the lock manager (racekit.blocked), never slept for,
and the achieved order is checked. Converted racers, so the transition fence
is off (plan decision 19). Negative control: drop `audiences` from the door's
FOR SHARE set and the third test's request is never blocked — racekit fails.

Run:  python tools/run-python-verification.py tests/test_s7_scope_audience_race.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='s7-scope-race-', ignore_cleanup_errors=True)
_data = Path(_temp.name) / 'data'
_data.mkdir()
_home = Path(_temp.name) / 'home'
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_TEST_HOOKS='1',
                  ORGTREE_PGDOOR='1', ORGTREE_STEER_HOOK='0')
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402
import racekit  # noqa: E402

if hasattr(orgtx, 'TRANSITION_FENCE'):
    orgtx.TRANSITION_FENCE = False

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
STEP_S = 15.0
ITEMS = [{'kind': 'dir', 'path': 'C:/s7-race-not-held', 'mode': 'ro'}]
_N = [0]


def tearDownModule():
    _temp.cleanup()


class ScopeRequestVsAudienceGrant(unittest.TestCase):
    def setUp(self):
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)
        _N[0] += 1
        self.slug = f's7race{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'opus', 20, 'boss')
        org.hire('boss', 'boss', 'opus', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        self.p = [patch.object(supervisor, 'send_message', return_value={}),
                  patch.object(api, 'hub_changed', lambda *a, **k: None)]
        for x in self.p:
            x.start()
        # warm both doors' cold paths outside the race, on another org
        self.assertFalse(store.load_org(self.slug)._has_audience('worker', U))

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def _request(self):
        return api.agent_call(api.AgentCall(
            org=self.slug, node='worker', tool='orgtree_request_scope',
            args={'items': ITEMS, 'reason': 'need it'}), REQUEST)

    def _grant(self):
        return api.agent_call(api.AgentCall(
            org=self.slug, node='boss', tool='orgtree_audience',
            args={'action': 'grant', 'from': 'worker', 'target': 'user'}), REQUEST)

    def _watch_keys(self):
        """The last row key each thread ASKED the lock manager for: when an
        actor is proven blocked, this is the row it is waiting on."""
        locks = orgtx.backend().locks
        orig = locks.acquire
        self.asked = {}

        def acquire(owner, key, exclusive, timeout):
            self.asked[threading.current_thread().ident] = (key, exclusive)
            return orig(owner, key, exclusive, timeout)
        return patch.object(locks, 'acquire', acquire)

    def _waited_on(self, actor):
        return self.asked.get(actor.thread.ident)

    def _state(self):
        org = store.load_org(self.slug)
        filed = [r for r in org.d.get('scope_requests') or [] if r.get('node') == 'worker']
        mailed = [m for m in (org.d.get('mail') or {}).get('boss') or []
                  if m.get('kind') == 'request']
        return org._has_audience('worker', U), filed, mailed

    def test_a_grant_that_commits_first_makes_the_request_file(self):
        with racekit.Race(wait=STEP_S, pair='converted') as race, self._watch_keys():
            g = race.actor('G', self._grant)
            r = race.actor('R', self._request)
            gg = race.hold(g, 'before_commit')     # G holds audiences FOR UPDATE
            race.start(g)
            race.reached(gg)
            race.start(r)
            race.blocked(r)
            on = self._waited_on(r)                   # R waits on the audiences row
            race.release(gg)
            race.join(g, r)
            race.expect_order('G.before_commit', 'R.blocked', 'G.after_commit',
                              'R.after_lock', 'R.after_commit')
        # FINDING: the real grant and the (routed-at-plan) request are ordered
        # by the superior's NODE row, which both lock before any section —
        # the audiences FOR SHARE is a second guarantee here, not the first
        self.assertEqual(on, ((self.slug, 'node', 'boss'), True), on)
        self.assertNotIn('routed', r.result, r.result)
        self.assertIn('requested', r.result, r.result)
        audience, filed, mailed = self._state()
        self.assertTrue(audience)
        self.assertEqual(len(filed), 1)
        self.assertEqual(mailed, [])

    def test_a_request_that_commits_first_routes_and_the_grant_waits(self):
        with racekit.Race(wait=STEP_S, pair='converted') as race, self._watch_keys():
            r = race.actor('R', self._request)
            g = race.actor('G', self._grant)
            gr = race.hold(r, 'before_commit')     # R holds audiences FOR SHARE
            race.start(r)
            race.reached(gr)
            race.start(g)
            race.blocked(g)
            on = self._waited_on(g)                   # G waits to write the row
            race.release(gr)
            race.join(r, g)
            race.expect_order('R.before_commit', 'G.blocked', 'R.after_commit',
                              'G.after_lock', 'G.after_commit')
        self.assertEqual(on, ((self.slug, 'node', 'boss'), True), on)
        self.assertEqual(r.result.get('routed'), 'boss', r.result)
        audience, filed, mailed = self._state()
        self.assertTrue(audience)                  # granted, after the request
        self.assertEqual(filed, [])
        self.assertEqual(len(mailed), 1)

    def test_a_writer_of_only_the_audiences_row_still_orders_the_request(self):
        """No current audience writer is ordered against request_scope by the
        audiences row alone (each also locks a party's node row). This pins
        the door's FOR SHARE on its own, for a future writer that touches
        nothing else. The worker HOLDS a user audience, so the request plans
        to FILE (audiences SHARED, no mail rows); a transaction holding ONLY
        `audiences` FOR UPDATE revokes it. The request must wait for that
        commit, then re-derive its plan under the lock (`rcdoor.require`
        widens to the superior's mail rows) and ROUTE."""
        org = store.load_org(self.slug)
        org.d['audiences'].append({'grantee': 'worker', 'grantor': U})
        store.save_org(org)

        def revoke_only_audiences():
            with orgtx.org_tx(self.slug, sections=['audiences']) as tx:
                tx.org.d['audiences'][:] = [
                    x for x in tx.org.d['audiences']
                    if not (x.get('grantee') == 'worker' and x.get('grantor') == U)]

        with racekit.Race(wait=STEP_S, pair='converted') as race, self._watch_keys():
            g = race.actor('G', revoke_only_audiences)
            r = race.actor('R', self._request)
            gg = race.hold(g, 'before_commit')
            race.start(g)
            race.reached(gg)
            race.start(r)
            race.blocked(r)
            on = self._waited_on(r)
            race.release(gg)
            race.join(g, r)
            race.expect_order('G.before_commit', 'R.blocked', 'G.after_commit')
        self.assertEqual(on[0][1:], ('section', 'audiences'), on)
        self.assertFalse(on[1], 'a filing plan holds audiences SHARED')
        self.assertEqual(r.result.get('routed'), 'boss', r.result)
        audience, filed, mailed = self._state()
        self.assertFalse(audience)
        self.assertEqual(filed, [])
        self.assertEqual(len(mailed), 1)

if __name__ == '__main__':
    unittest.main()
