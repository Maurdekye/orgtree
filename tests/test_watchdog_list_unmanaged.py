"""`orgtree_watchdog action=list` takes the ordinary agent-call path, not the
managed-wait one (orgtree-watchdog-list-pays-the-managed-wait-jour).

Every `orgtree_watchdog` call used to go through `toolwait.invoke`: the
global journal lock, three fsync'd `tool-waits.db` writes, a new thread and a
MAX_RUNNING slot, for a read of a few rows (measured ~400-500 ms server p50).
`list` spawns nothing and waits on nothing, so it now runs like `orgtree_work
get`; create/pause/resume/remove/supersede stay managed.

  * DISPATCH: `toolwait.managed_call` says list is not managed, plain or
    wrapped in a keyed `orgtree_op_call`, and every other watchdog action and
    managed tool still is.
  * THE ROUTE: a list through `/api/agent` never reaches `toolwait.invoke` and
    journals nothing; a pause (the control) does both.
  * SAME ANSWERS: the rows are the `wd_list_row` projection, scoped to the
    caller's own dogs and its subtree's; a bad credential is still refused.

Run:  python tools/run-python-verification.py tests/test_watchdog_list_unmanaged.py
"""
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-wd-list-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1', ORGTREE_PGDOOR='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, mcptool, orgtx, pgdoor, store, supervisor, toolwait  # noqa: E402

TOOLS = {'bash': True, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule() -> None:
    root.cleanup()


def call(tool, args):
    return SimpleNamespace(tool=tool, args=args)


class Dispatch(unittest.TestCase):

    def test_list_is_not_managed(self) -> None:
        self.assertFalse(toolwait.managed_call(call('orgtree_watchdog', {'action': 'list'})))

    def test_keyed_list_is_judged_by_the_call_it_wraps(self) -> None:
        body = call('orgtree_op_call', {'tool': 'orgtree_watchdog',
                                        'args': {'action': 'list'}, 'op_key': 'k'})
        self.assertFalse(toolwait.managed_call(body))

    def test_every_other_watchdog_action_stays_managed(self) -> None:
        for action in ('create', 'pause', 'resume', 'remove', 'supersede', '', 'LIST'):
            with self.subTest(action=action):
                self.assertTrue(toolwait.managed_call(
                    call('orgtree_watchdog', {'action': action})))
                self.assertTrue(toolwait.managed_call(call('orgtree_op_call', {
                    'tool': 'orgtree_watchdog', 'args': {'action': action}})))
        self.assertTrue(toolwait.managed_call(call('orgtree_watchdog', {})))
        self.assertTrue(toolwait.managed_call(call('orgtree_op_call', {
            'tool': 'orgtree_watchdog', 'args': 'not a dict'})))

    def test_other_managed_tools_stay_managed_and_others_stay_unmanaged(self) -> None:
        for tool in mcptool.MANAGED_WAIT_TOOLS - {'orgtree_watchdog'}:
            with self.subTest(tool=tool):
                self.assertTrue(toolwait.managed_call(call(tool, {'action': 'list'})))
        self.assertFalse(toolwait.managed_call(call('orgtree_work', {'action': 'get'})))
        self.assertFalse(toolwait.managed_call(call('orgtree_op_call', {
            'tool': 'orgtree_chart', 'args': {}})))

    def test_the_read_actions_are_only_reads(self) -> None:
        # widening this table sends a call around the journal: only a real
        # read with no spawn and no wait belongs in it
        self.assertEqual(toolwait.READ_ACTIONS,
                         {'orgtree_watchdog': frozenset({'list'})})


class Route(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
        orgtx.TRANSITION_FENCE = False
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)
        type(self).seq += 1
        self.slug = f'wdlist{self.seq}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 6, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'x', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='a test agent')
        org.hire(ledger.USER, None, 'haiku', 0, 'other')
        store.save_org(org)
        self.enterContext(patch.object(
            supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(supervisor, 'mail_spark'))
        self.enterContext(patch.object(api, 'mail_notify'))
        self.enterContext(patch.object(api, 'hub_changed'))
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('boss', 'x', 'other')}
        pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.invoke = self.enterContext(patch.object(
            toolwait, 'invoke', wraps=toolwait.invoke))
        self.saves = self.enterContext(patch.object(toolwait, '_save', wraps=toolwait._save))

    def dog(self, owner: str, name: str) -> str:
        org = store.load_org(self.slug)
        r = org.watchdog_create(owner, name, 'command', 'echo hi', 'hi', 60,
                                False, None, False)
        store.save_org(org)
        return str(r['id'])

    def agent(self, node: str, args: dict, token: str | None = None):
        return self.client.post('/api/agent', json=dict(
            org=self.slug, node=node, tool='orgtree_watchdog', args=args),
            headers={'X-Orgtree-Agent-Token': token or self.tokens[node]})

    def test_list_skips_the_journal_and_pause_still_uses_it(self) -> None:
        wid = self.dog('x', 'mine')
        r = self.agent('x', {'action': 'list'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([w['id'] for w in r.json()['watchdogs']], [wid])
        self.assertEqual((self.invoke.call_count, self.saves.call_count), (0, 0),
                         'list went through the managed-wait journal')
        # the control: the same route and tool, a writing action, is managed
        r = self.agent('x', {'action': 'pause', 'id': wid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json().get('state'), 'paused', r.text)
        self.assertEqual(self.invoke.call_count, 1, 'pause left the managed path')
        self.assertGreaterEqual(self.saves.call_count, 1, 'pause journaled nothing')

    def test_list_answers_are_the_list_rows_scoped_to_the_subtree(self) -> None:
        mine = self.dog('x', 'mine')
        boss = self.dog('boss', 'bosss')
        self.dog('other', 'theirs')
        org = store.load_org(self.slug)
        rows = {w['id']: supervisor.wd_list_row(w) for w in org.d['watchdogs']}
        r = self.agent('boss', {'action': 'list'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()['watchdogs'], key=lambda w: w['id']),
                         sorted([rows[mine], rows[boss]], key=lambda w: w['id']))
        r = self.agent('x', {'action': 'list'})
        self.assertEqual(r.json()['watchdogs'], [rows[mine]])
        self.assertEqual(self.invoke.call_count, 0)

    def test_a_bad_credential_is_still_refused(self) -> None:
        self.dog('x', 'mine')
        r = self.agent('x', {'action': 'list'}, token='not-a-token')
        self.assertIn(r.status_code, (401, 403), r.text)
        self.assertNotIn('watchdogs', r.text)
        r = self.agent('x', {'action': 'list'}, token=self.tokens['other'])
        self.assertIn(r.status_code, (401, 403), r.text)


if __name__ == '__main__':
    unittest.main()
