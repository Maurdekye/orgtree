"""PG-3c: the agent watchdogs on the door (plan decision 22) — the
`orgtree_watchdog` tool and the supervisor's `_wd_*` writers
(`supervisor._wd_write`) — over PG-0's SeamBackend fake (orgtx).

  * OFF DOC_LOCK: with the door on, an engine watchdog write completes while
    another thread holds DOC_LOCK. CONTROL: with the door off the same write
    waits for DOC_LOCK (the old path is still the old path).
  * A FIRE IS ONE TRANSACTION: `_wd_fire` names the owner's mail rows up
    front, so it makes exactly ONE transaction attempt (pgdoor widens and
    re-runs a refused write, so a wrong declaration still ends right — only
    the attempt count shows it). The owner's mail lands; a one-shot NOTICE
    dog is removed and does NOT wake its owner (D-200 survives the move).
  * THE TOOL IS ON THE DOOR: `orgtree_watchdog` create goes through the real
    agent door while another thread holds DOC_LOCK, persists the dog and
    still returns its smoke run (moved to the post-commit tail). A pause by
    the owner's ANCESTOR (downward authority) is one attempt too.
  * NO LOST UPDATE between the tool and the engine: an engine stats write is
    held at `before_commit`; a tool pause of the same dog is observed parked
    on the `watchdogs` row, then both land.

Run:  python tools/run-python-verification.py tests/test_pg3c_watchdog_tx.py
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-pg3c-wd-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402

TOOLS = {'bash': True, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    root.cleanup()


class Attempts:
    """Pause hook: counts transaction attempts; optionally holds the FIRST
    transaction at `before_commit` until `release` is set."""

    def __init__(self, hold_first: bool = False) -> None:
        self.hold_first = hold_first
        self.attempts = 0
        self.commits = 0
        self.first_in = threading.Event()
        self.release = threading.Event()
        self._c = threading.Lock()

    def __call__(self, point, tx) -> None:
        if point == 'before_lock':
            with self._c:
                self.attempts += 1
        elif point == 'before_commit':
            with self._c:
                self.commits += 1
                first = self.commits == 1
            if first and self.hold_first:
                self.first_in.set()
                self.release.wait(20)


class HeldDocLock:
    """DOC_LOCK held by ANOTHER thread (it is reentrant, so holding it here
    would prove nothing) until `stop()`."""

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

    def stop(self) -> None:
        self.done.set()
        self.t.join(5)

    def __exit__(self, *exc):
        self.stop()


def stack_of(t) -> str:
    import sys
    import traceback
    f = sys._current_frames().get(t.ident)
    return ''.join(traceback.format_stack(f)[-12:]) if f else '(thread gone)'


def run_bg(fn):
    out: dict = {}

    def go():
        try:
            out['value'] = fn()
        except BaseException as e:  # noqa: BLE001
            out['error'] = e
    t = threading.Thread(target=go, daemon=True)
    t.start()
    return t, out


class WatchdogDoor(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)
        type(self).seq += 1
        self.slug = f'pg3cwd{self.seq}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 6, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'x', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='a test agent')
        store.save_org(org)
        self.env('1')
        self.sent: list = []
        self.enterContext(patch.object(
            supervisor, 'send_message',
            side_effect=lambda *a, **k: self.sent.append((a, k)) or {'delivered': True}))
        self.enterContext(patch.object(supervisor, 'mail_spark'))
        self.enterContext(patch.object(api, 'mail_notify'))
        self.enterContext(patch.object(api, 'hub_changed'))
        # PG-0's first org_tx on an org heals with one plain save; do it now
        pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    def env(self, v: str) -> None:
        old = os.environ.get('ORGTREE_PGDOOR')
        os.environ['ORGTREE_PGDOOR'] = v
        self.addCleanup(lambda: os.environ.__setitem__('ORGTREE_PGDOOR', old)
                        if old is not None else os.environ.pop('ORGTREE_PGDOOR', None))

    def durable(self) -> dict:
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    def dog(self, **kw) -> str:
        org = store.load_org(self.slug)
        r = org.watchdog_create('x', kw.pop('name', 'd'), 'command', 'echo hi',
                                kw.pop('pattern', None), 60, kw.pop('notice', False),
                                None, kw.pop('once', False))
        store.save_org(org)
        return str(r['id'])

    def the_dog(self, wid: str) -> dict | None:
        return next((w for w in self.durable().get('watchdogs') or [] if w['id'] == wid), None)

    def box(self, nid: str) -> list:
        d = self.durable()
        return [m for m in (d.get('mail') or []) + (d.get('mail_log') or [])
                if isinstance(m, dict) and m.get('to') == nid]

    # ------------------------------------------------------------ DOC_LOCK

    def test_engine_write_does_not_wait_for_doc_lock(self) -> None:
        wid = self.dog()
        with HeldDocLock():
            t, out = run_bg(lambda: supervisor._wd_pause(self.slug, wid, 'owner gone'))
            t.join(10)
            self.assertFalse(t.is_alive(), 'the door write waited for DOC_LOCK')
        self.assertNotIn('error', out)
        w = self.the_dog(wid)
        self.assertEqual((w['state'], w['paused_why']), ('paused', 'owner gone'))

    def test_control_door_off_waits_for_doc_lock(self) -> None:
        self.env('0')
        wid = self.dog()
        with HeldDocLock() as held:
            t, out = run_bg(lambda: supervisor._wd_pause(self.slug, wid, 'owner gone'))
            t.join(1.0)
            self.assertTrue(t.is_alive(), 'control: the DOC_LOCK path did not wait')
            held.stop()
            t.join(10)
        self.assertFalse(t.is_alive())
        self.assertEqual(self.the_dog(wid)['state'], 'paused')

    # ---------------------------------------------------------------- fire

    def test_fire_is_one_transaction_and_mails_the_owner(self) -> None:
        wid = self.dog()
        before = len(self.box('x'))
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        with HeldDocLock():
            supervisor._wd_fire(self.slug, wid, 'd', ['hit one'])
        orgtx.set_pause_hook(None)
        self.assertEqual(hook.attempts, 1, 'the fire was under-declared (it widened)')
        self.assertEqual(hook.commits, 1)
        self.assertEqual(len(self.box('x')), before + 1, 'the owner got no mail')
        self.assertEqual(self.the_dog(wid)['fired'], 1)
        wakes = [k.get('wake') for a, k in self.sent if a[1] == 'x']
        self.assertEqual(wakes, [True])

    def test_one_shot_notice_dog_is_removed_and_does_not_wake(self) -> None:
        wid = self.dog(notice=True, once=True)
        supervisor._wd_fire(self.slug, wid, 'd', ['hit'])
        self.assertIsNone(self.the_dog(wid), 'a one-shot dog outlived its fire')
        self.assertIn(wid, [t['id'] for t in self.durable().get('watchdog_tombs') or []])
        wakes = [k.get('wake') for a, k in self.sent if a[1] == 'x']
        self.assertEqual(wakes, [False], 'a NOTICE dog woke its owner')

    def test_alert_is_one_transaction_and_pauses(self) -> None:
        wid = self.dog()
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        supervisor._wd_alert(self.slug, wid, {'why': 'quiet', 'pause': True,
                                              'headline': 'went quiet', 'advice': 'look'})
        orgtx.set_pause_hook(None)
        self.assertEqual(hook.attempts, 1)
        w = self.the_dog(wid)
        self.assertEqual((w['state'], w['alerted_why']), ('paused', 'quiet'))
        # once per episode: the same reason again writes and sends nothing
        n = len(self.sent)
        supervisor._wd_alert(self.slug, wid, {'why': 'quiet', 'pause': False,
                                              'headline': 'went quiet', 'advice': 'look'})
        self.assertEqual(len(self.sent), n)

    # ---------------------------------------------------------------- tool

    def token(self, nid: str) -> str:
        return agentauth.child_env(self.slug, nid)['ORGTREE_AGENT_TOKEN']

    def call(self, actor: str, args: dict):
        c = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(c.close)
        return c.post('/api/agent', json=dict(org=self.slug, node=actor, tool='orgtree_watchdog',
                                              args=args),
                      headers={'X-Orgtree-Agent-Token': self.token(actor)})

    def test_tool_create_is_on_the_door_and_keeps_its_smoke_run(self) -> None:
        tokx = self.token('x')  # noqa: F841  minted before DOC_LOCK is taken
        with HeldDocLock():
            box: dict = {}
            t, out = run_bg(lambda: self.call('x', {'action': 'create', 'name': 'w',
                                                    'kind': 'command', 'target': 'echo hello',
                                                    'pattern': 'hello'}))
            t.join(30)
            self.assertFalse(t.is_alive(), 'the tool waited for DOC_LOCK:
' + stack_of(t))
            box.update(out)
        self.assertNotIn('error', box)
        r = box['value']
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()
        res = res.get('result', res)
        self.assertIn('smoke', res, 'the smoke run was lost in the move')
        self.assertTrue(res['smoke'].get('ran'), res['smoke'])
        self.assertIn('w', [w['name'] for w in self.durable().get('watchdogs') or []])

    def test_tool_pause_by_an_ancestor_is_one_transaction(self) -> None:
        wid = self.dog()
        self.token('boss')
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        r = self.call('boss', {'action': 'pause', 'id': wid})
        orgtx.set_pause_hook(None)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.the_dog(wid)['state'], 'paused')
        self.assertEqual(hook.attempts, 1, 'the ancestor pause widened')

    # ------------------------------------------------------ no lost update

    def test_tool_and_engine_writes_to_one_dog_both_land(self) -> None:
        wid = self.dog()
        for n in ('x',):
            self.token(n)
        hook = Attempts(hold_first=True)
        orgtx.set_pause_hook(hook)
        ent = {'seen': 7, 'last_line': 'seven', 'pushed': -1, 'pushed_at': 0.0}
        t1, o1 = run_bg(lambda: supervisor._wd_stream_stats(self.slug, wid, ent))
        self.assertTrue(hook.first_in.wait(10), 'the engine write never reached its commit')
        t2, o2 = run_bg(lambda: self.call('x', {'action': 'pause', 'id': wid}))
        time.sleep(0.5)
        self.assertTrue(t2.is_alive(), 'the tool pause did not wait for the dog row')
        self.assertEqual(hook.commits, 1, 'the tool pause committed past the held row')
        hook.release.set()
        t1.join(10)
        t2.join(30)
        orgtx.set_pause_hook(None)
        self.assertNotIn('error', o1)
        self.assertEqual(o2['value'].status_code, 200, o2['value'].text)
        w = self.the_dog(wid)
        self.assertEqual(w['state'], 'paused', 'the tool pause was lost')
        self.assertEqual((w['checks_run'], w['last_output']), (7, 'seven'),
                         'the engine stats were lost')


if __name__ == '__main__':
    unittest.main()
