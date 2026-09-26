"""Fence-off S10: the user's watchdog control (`POST /api/orgs/{slug}/watchdogs`,
`api.watchdog_action`) runs as ONE operator transaction on the dog rows, not
DOC_LOCK + a whole-document save. Over PG-0's SeamBackend fake (orgtx), with
the transition fence OFF (plan decision 19).

  * OFF DOC_LOCK: every action completes while another thread holds DOC_LOCK.
  * ONE ATTEMPT: pgdoor widens and re-runs a refused write, so an
    under-declared row plan still ends right; only the attempt count shows
    it. pause, resume, remove (with a reason: a lifecycle record) and
    supersede (a tomb + a lifecycle record) are each exactly one attempt.
  * SAME ANSWERS: each action's response and durable effect are what the
    DOC_LOCK route gave; refusals (unknown dog, bad action, supersede with no
    reason, supersede of a persistent dog) are 422 and write nothing.
  * THE AGENT DOOR: a supersede by the owner's ancestor pre-declares the
    authority chain (rcdoor.watchdog_spec), so it is one attempt too.

Run:  python tools/run-python-verification.py tests/test_s10_watchdog_route.py
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-s10-wd-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1', ORGTREE_PGDOOR='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402

TOOLS = {'bash': True, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
OP = {'X-Orgtree-Desktop-Token': 'operator'}


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    root.cleanup()


class Attempts:
    """Pause hook: counts transaction attempts and commits."""

    def __init__(self) -> None:
        self.attempts = 0
        self.commits = 0
        self._c = threading.Lock()

    def __call__(self, point, tx) -> None:
        with self._c:
            if point == 'before_lock':
                self.attempts += 1
            elif point == 'before_commit':
                self.commits += 1


class HeldDocLock:
    """DOC_LOCK held by ANOTHER thread (it is reentrant, so holding it here
    would prove nothing) until exit."""

    def __enter__(self):
        self.got = threading.Event()
        self.done = threading.Event()

        def hold():
            with store.DOC_LOCK:
                self.got.set()
                self.done.wait(30)
        self.t = threading.Thread(target=hold, daemon=True)
        self.t.start()
        assert self.got.wait(5), 'fixture: could not take DOC_LOCK'
        return self

    def __exit__(self, *exc):
        self.done.set()
        self.t.join(5)


class WatchdogRoute(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
        orgtx.TRANSITION_FENCE = False
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)
        type(self).seq += 1
        self.slug = f's10wd{self.seq}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 6, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'x', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='a test agent')
        store.save_org(org)
        self.enterContext(patch.object(
            supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(supervisor, 'mail_spark'))
        self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('boss', 'x')}
        # PG-0's first org_tx on an org heals with one plain save; do it now
        pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    # ---------------------------------------------------------------- helpers

    def durable(self) -> dict:
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    def dog(self, once: bool = False) -> str:
        org = store.load_org(self.slug)
        r = org.watchdog_create('x', f'd{len(org.d.get("watchdogs") or [])}',
                                'command', 'echo hi', 'hi', 60, False, None, once)
        store.save_org(org)
        return str(r['id'])

    def the_dog(self, wid: str) -> dict | None:
        return next((w for w in self.durable().get('watchdogs') or []
                     if w['id'] == wid), None)

    def lifecycle_for(self, wid: str) -> list:
        d = self.durable().get('lifecycle') or {}
        rows = d.values() if isinstance(d, dict) else d
        return [r for r in rows if isinstance(r, dict)
                and (r.get('watchdog_id') == wid or wid in json.dumps(r))]

    def post(self, wid: str, action: str, reason: str = ''):
        """The route, under a held DOC_LOCK, counting transaction attempts.
        Returns (response, attempts, commits)."""
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        out: dict = {}
        try:
            with HeldDocLock():
                t = threading.Thread(target=lambda: out.__setitem__(
                    'r', self.client.post(f'/api/orgs/{self.slug}/watchdogs',
                                          json={'id': wid, 'action': action,
                                                'reason': reason},
                                          headers=OP)), daemon=True)
                t.start()
                t.join(20)
                self.assertFalse(t.is_alive(),
                                 f'{action}: the route waited for DOC_LOCK')
        finally:
            orgtx.set_pause_hook(None)
        return out['r'], hook.attempts, hook.commits

    # ------------------------------------------------------------ the actions

    def test_pause_then_resume(self) -> None:
        wid = self.dog()
        r, n, c = self.post(wid, 'pause')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {'id': wid, 'name': 'd0', 'state': 'paused'})
        self.assertEqual((n, c), (1, 1), 'pause was under-declared (it widened)')
        self.assertEqual(self.the_dog(wid)['state'], 'paused')
        r, n, c = self.post(wid, 'resume')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['state'], 'armed')
        self.assertEqual((n, c), (1, 1), 'resume was under-declared (it widened)')
        self.assertEqual(self.the_dog(wid)['state'], 'armed')
        self.assertEqual(self.hub.call_count, 2, 'hub_changed after each commit')

    def test_remove_with_a_reason_records_lifecycle(self) -> None:
        wid = self.dog()
        r, n, c = self.post(wid, 'remove', 'no longer needed')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {'id': wid, 'name': 'd0', 'state': 'removed',
                                    'reason': 'no longer needed'})
        self.assertEqual((n, c), (1, 1), 'remove was under-declared (it widened)')
        self.assertIsNone(self.the_dog(wid))
        self.assertTrue(self.lifecycle_for(wid), 'the cancellation was not recorded')

    def test_supersede_tombs_the_dog_and_records_lifecycle(self) -> None:
        wid = self.dog(once=True)
        r, n, c = self.post(wid, 'supersede', 'the build already finished')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['state'], 'superseded')
        self.assertEqual((n, c), (1, 1), 'supersede was under-declared (it widened)')
        self.assertIsNone(self.the_dog(wid))
        tomb = [t for t in self.durable().get('watchdog_tombs') or []
                if t['id'] == wid]
        self.assertEqual(len(tomb), 1, 'no tomb for the superseded dog')
        self.assertEqual((tomb[0]['state'], tomb[0]['reason']),
                         ('superseded', 'the build already finished'))
        self.assertTrue(self.lifecycle_for(wid), 'the supersession was not recorded')

    def test_events_log_the_action(self) -> None:
        wid = self.dog()
        self.post(wid, 'pause')
        self.assertIn('watchdog_pause',
                      json.dumps(self.durable().get('events') or []))

    # --------------------------------------------------------------- refusals

    def refused(self, wid: str, action: str, reason: str = '') -> None:
        before = self.durable()
        r, _n, c = self.post(wid, action, reason)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(c, 0, f'{action}: a refused action committed')
        after = self.durable()
        for sec in ('watchdogs', 'watchdog_tombs', 'lifecycle'):
            self.assertEqual(before.get(sec), after.get(sec), sec)

    def test_refusals_write_nothing(self) -> None:
        wid = self.dog()
        self.refused('nope', 'pause')
        self.refused(wid, 'explode')
        self.refused(wid, 'supersede', '')           # no reason
        self.refused(wid, 'supersede', 'why not')    # a persistent dog
        self.assertEqual(self.hub.call_count, 0)

    def test_remove_at_the_lifecycle_cap_commits_the_eviction(self) -> None:
        # p01 note 1: lifecycle is a row log (MOVED_TO_LOGS) but record() also
        # EVICTS at its cap — a delete of existing rows, not only an append
        from orgtree import lifecycle
        wid = self.dog()
        org = store.load_org(self.slug)
        rows = org.d.setdefault('lifecycle', [])
        while len(rows) < lifecycle.MAX_RECORDS:
            rows.append({'operation_id': f'filler:{len(rows)}', 'kind': 'filler',
                         'state': 'seen', 'at': '2026-01-01T00:00:00Z', 'count': 1})
        store.save_org(org)
        self.assertEqual(len(self.durable()['lifecycle']), lifecycle.MAX_RECORDS)
        r, n, c = self.post(wid, 'remove', 'cap test')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((n, c), (1, 1), 'remove at the cap widened')
        # S8 (lead decision 8): the route's commit only APPENDS its row; the
        # eviction is the one serialized pruner's, off the request path
        self.assertTrue(lifecycle.idle.wait(10))
        lifecycle.prune(self.slug)                 # idempotent if it already ran
        after = self.durable()['lifecycle']
        self.assertEqual(len(after), lifecycle.PRUNE_TO, 'the eviction did not persist')
        self.assertEqual(after[-1].get('watchdog_id'), wid, 'the new row is not last')
        self.assertNotIn('filler:0', [x.get('operation_id') for x in after])

    def test_unknown_org_is_422(self) -> None:
        # p01 note 2: the DOC_LOCK route answered 422 (load_org's LedgerError)
        r = self.client.post('/api/orgs/no-such-org/watchdogs',
                             json={'id': 'x', 'action': 'pause'}, headers=OP)
        self.assertEqual(r.status_code, 422, r.text)

    # ------------------------------------------------------------- agent door

    def test_tool_supersede_by_an_ancestor_is_one_transaction(self) -> None:
        wid = self.dog(once=True)
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        try:
            r = self.client.post('/api/agent', json=dict(
                org=self.slug, node='boss', tool='orgtree_watchdog',
                args={'action': 'supersede', 'id': wid, 'reason': 'obsolete'}),
                headers={'X-Orgtree-Agent-Token': self.tokens['boss']})
        finally:
            orgtx.set_pause_hook(None)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(self.the_dog(wid))
        self.assertEqual(hook.attempts, 1, 'the ancestor supersede widened')


if __name__ == '__main__':
    unittest.main()
