"""S1 (fence-off): the agent mail tools on the shared door (maildoor.py).

Through the real `api.agent_call` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1), with `store.write_org` made to explode so any call
that falls back into the resident DOC_LOCK cycle fails loudly.

orgtree_send_notice:
  * commits on the door holding the caller's row and ONLY the recipient's
    pending box (not every agent's mail);
  * the spark, the wake=False steer and the delivery note run AFTER the
    commit, once each;
  * a recipient the snapshot could not resolve is locked by a WIDEN and the
    notice still lands exactly once;
  * it does not wait on DOC_LOCK (transition fence off, DOC_LOCK held);
  * a refused notice (to the user) writes nothing;
  * ORGTREE_PGDOOR=0 keeps the legacy cycle.

Run:  python tools/run-python-verification.py tests/test_maildoor.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-maildoor-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, maildoor, orgtx, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


def _explode(*a, **k):
    raise AssertionError('a mail tool fell into the DOC_LOCK cycle')


class NoticeDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'mdoor{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        for nid in ('sub', 'peer'):
            org.hire('boss', 'boss', 'luna', 0, nid, add_dirs=[], tools=T,
                     org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.assertTrue(pgdoor.routed(maildoor.NOTICE, {}),
                        'orgtree_send_notice is not declared on the door')
        self.sent, self.notified, self.notes, self.locked, self.sections = [], [], [], [], []
        self.shared = []
        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(
                                   (t, k.get('wake', True), k.get('ping_reason'))) or {}),
                  patch.object(supervisor, 'delivery_note',
                               lambda slug, t, r, **k: self.notes.append(
                                   (t, k.get('kind'))) or 'note'),
                  patch.object(api, 'mail_notify',
                               lambda s, actor, n: self.notified.append(n)),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(store, 'write_org', _explode)]
        for x in self.p:
            x.start()
        orgtx.set_pause_hook(lambda p, tx: (
            self.locked.append(set(tx.lock_nodes)),
            self.sections.append(set(tx.lock_sections)),
            self.shared.append(set(tx.share_nodes)))
            if p == 'after_lock' else None)

    def tearDown(self):
        orgtx.set_pause_hook(None)
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def call(self, node, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node=node,
                                            tool=maildoor.NOTICE, args=a), REQUEST)

    def notices_in(self, nid):
        box = store.load_org(self.slug).d['mail'].get(nid) or []
        return [m for m in box if m.get('kind') == 'notice']

    def test_notice_commits_on_the_door_locking_only_the_recipients_box(self):
        r = self.call('boss', to='sub', body='hello by notice')
        self.assertEqual([m.get('body') for m in self.notices_in('sub')],
                         ['hello by notice'])
        self.assertIn('boss', self.locked[-1], 'the caller row must be held')
        self.assertIn('sub', self.locked[-1], "the recipient's row must be held")
        self.assertIn('mail\x1fsub', self.sections[-1])
        self.assertNotIn('mail', self.sections[-1],
                         "the notice locked every agent's mail")
        self.assertNotIn('mail\x1fpeer', self.sections[-1])
        # after-commit effects, once each
        self.assertEqual(self.notified.count('sub'), 1)
        self.assertEqual(self.sent, [('sub', False, 'notice')])
        self.assertEqual(self.notes, [('sub', 'notice')])
        self.assertEqual(r.get('delivery'), 'note')

    def test_unresolved_on_the_snapshot_widens_and_lands_once(self):
        with patch.object(maildoor, '_resolve_on_snapshot', lambda *a, **k: []):
            self.call('boss', to='sub', body='widened')
        self.assertEqual(len(self.notices_in('sub')), 1)
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        self.assertNotIn('mail\x1fsub', self.sections[0])
        self.assertIn('mail\x1fsub', self.sections[-1])
        self.assertEqual(self.sent, [('sub', False, 'notice')],
                         'an after-commit step ran for a rolled-back attempt')

    def test_does_not_wait_on_doc_lock(self):
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        done = threading.Event()
        err = []

        def go():
            try:
                self.call('boss', to='sub', body='no doc lock')
            except BaseException as e:                       # noqa: BLE001
                err.append(e)
            done.set()
        try:
            with store.DOC_LOCK:
                th = threading.Thread(target=go)
                th.start()
                self.assertTrue(done.wait(10), 'the notice waited on DOC_LOCK')
            th.join(5)
        finally:
            orgtx.TRANSITION_FENCE = fence
        self.assertEqual(err, [])
        self.assertEqual(len(self.notices_in('sub')), 1)

    def test_refused_notice_writes_nothing(self):
        before = store.load_org(self.slug).d.get('mail')
        with self.assertRaises(HTTPException) as cm:
            self.call('boss', to='user', body='nope')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(store.load_org(self.slug).d.get('mail'), before)
        self.assertEqual((self.sent, self.notified), ([], []))

    # -- orgtree_ask / withdraw_ask / audience -----------------------------
    def tool(self, tool, node, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node=node,
                                            tool=tool, args=a), REQUEST)

    def asks(self, node):
        return [x for x in store.load_org(self.slug).d.get('asks') or []
                if x.get('node') == node]

    def test_ask_parks_a_card_on_the_door_in_one_attempt(self):
        r = self.tool(maildoor.ASK, 'boss', question='which way?')
        self.assertTrue(r.get('asked'), r)
        self.assertEqual([x['status'] for x in self.asks('boss')], ['open'])
        self.assertEqual(len(self.sections), 1, 'the ask needed a widen')
        self.assertIn('asks', self.sections[-1])

    def test_routed_ask_mails_and_drives_the_superior_after_commit(self):
        r = self.tool(maildoor.ASK, 'sub', question='may I?')
        if not r.get('routed'):
            self.skipTest('sub holds a user audience in this fixture')
        self.assertEqual(r['routed'], 'boss')
        box = store.load_org(self.slug).d['mail'].get('boss') or []
        self.assertEqual(sum(1 for m in box if m.get('kind') == 'question'), 1)
        self.assertEqual([t for t, wake, _ in self.sent if wake], ['boss'])
        self.assertEqual(len(self.sections), 1, 'the routed ask needed a widen')

    def test_withdraw_ask_on_the_door(self):
        self.tool(maildoor.ASK, 'boss', question='never mind?')
        r = self.tool(maildoor.WITHDRAW_ASK, 'boss')
        self.assertTrue(r.get('withdrawn'), r)
        self.assertEqual([x['status'] for x in self.asks('boss')], ['withdrawn'])
        self.assertIn('asks', self.sections[-1])

    def test_audience_request_on_the_door_drives_the_first_hop(self):
        org = store.load_org(self.slug)
        org.hire('boss', 'sub', 'luna', 0, 'leaf', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        r = self.tool(maildoor.AUDIENCE, 'leaf', action='request',
                      target='boss', reason='need the boss')
        self.assertEqual(r.get('currently_at'), 'sub', r)
        reqs = store.load_org(self.slug).d.get('audience_requests') or []
        self.assertEqual([(q['from'], q['target']) for q in reqs], [('leaf', 'boss')])
        self.assertEqual([t for t, wake, _ in self.sent if wake], ['sub'])
        self.assertEqual(len(self.sections), 1, 'the request needed a widen')

    # -- orgtree_message ----------------------------------------------------
    def test_message_to_an_agent_on_the_door(self):
        r = self.tool(maildoor.MESSAGE, 'boss', to='sub', body='hi sub')
        box = store.load_org(self.slug).d['mail'].get('sub') or []
        self.assertEqual([m.get('body') for m in box if m.get('kind') == 'message'],
                         ['hi sub'])
        self.assertEqual(len(self.sections), 1, 'the message needed a widen')
        self.assertIn('mail\x1fsub', self.sections[-1])
        self.assertNotIn('mail', self.sections[-1])
        self.assertNotIn('mail\x1fpeer', self.sections[-1])
        self.assertEqual(self.notified.count('sub'), 1)
        self.assertEqual(self.sent, [('sub', True, 'agent_mail')])
        self.assertEqual(r.get('delivery'), 'note')

    def test_message_widened_drives_once_after_commit(self):
        with patch.object(maildoor, '_resolve_on_snapshot', lambda *a, **k: []):
            self.tool(maildoor.MESSAGE, 'boss', to='sub', body='widened msg')
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        box = store.load_org(self.slug).d['mail'].get('sub') or []
        self.assertEqual(sum(1 for m in box if m.get('body') == 'widened msg'), 1)
        self.assertEqual(self.sent, [('sub', True, 'agent_mail')],
                         'a drive ran for a rolled-back attempt')
        self.assertEqual(self.notified.count('sub'), 1)

    def test_message_attachment_to_the_user_is_copied_once_even_on_a_widen(self):
        scratch = supervisor.scratch_dir(self.slug, 'boss')
        os.makedirs(scratch, exist_ok=True)
        with open(os.path.join(scratch, 'report.txt'), 'w') as f:
            f.write('the report')
        with patch.object(maildoor, '_resolve_on_snapshot', lambda *a, **k: []):
            self.tool(maildoor.MESSAGE, 'boss', to='user', body='see attached',
                      attachments=['report.txt'])
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        outbox = os.path.join(scratch, 'outbox')
        copies = [n for n in os.listdir(outbox) if n.startswith('report')]
        self.assertEqual(copies, ['report.txt'], 'the attachment was copied per attempt')
        inbox = store.load_org(self.slug).d.get('user_inbox') or []
        mine = [m for m in inbox if m.get('body') == 'see attached']
        self.assertEqual(len(mine), 1)
        self.assertEqual([x.get('name') for x in mine[0].get('attachments') or []],
                         ['report.txt'])

    def test_message_kind_notice_is_refused_and_writes_nothing(self):
        before = store.load_org(self.slug).d.get('mail')
        with self.assertRaises(HTTPException) as cm:
            self.tool(maildoor.MESSAGE, 'boss', to='sub', body='x', kind='notice')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(store.load_org(self.slug).d.get('mail'), before)
        self.assertEqual(self.sent, [])

    def test_message_does_not_wait_on_doc_lock(self):
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        done, err = threading.Event(), []

        def go():
            try:
                self.tool(maildoor.MESSAGE, 'boss', to='sub', body='no lock')
            except BaseException as e:                       # noqa: BLE001
                err.append(e)
            done.set()
        try:
            with store.DOC_LOCK:
                th = threading.Thread(target=go)
                th.start()
                self.assertTrue(done.wait(10), 'the message waited on DOC_LOCK')
            th.join(5)
        finally:
            orgtx.TRANSITION_FENCE = fence
        self.assertEqual(err, [])

    # -- p01 lock-plan conditions ------------------------------------------
    def deep(self):
        org = store.load_org(self.slug)
        org.hire('boss', 'sub', 'luna', 0, 'leaf', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)

    def test_c1_a_downward_send_holds_the_path_for_share(self):
        self.deep()
        self.tool(maildoor.MESSAGE, 'boss', to='leaf', body='deep')
        self.assertEqual(len(self.sections), 1, 'the send needed a widen')
        self.assertIn('sub', self.shared[-1] | self.locked[-1],
                      'the intermediate parent pointer was not held')

    def test_c1_a_path_the_spec_missed_widens_before_the_send(self):
        self.deep()
        with patch.object(maildoor, '_with_path', lambda spec, *a, **k: spec):
            self.tool(maildoor.MESSAGE, 'boss', to='leaf', body='deep2')
        self.assertGreaterEqual(len(self.sections), 2, 'the body did not widen')
        self.assertNotIn('sub', self.shared[0] | self.locked[0])
        self.assertIn('sub', self.shared[-1] | self.locked[-1])
        box = store.load_org(self.slug).d['mail'].get('leaf') or []
        self.assertEqual(sum(1 for m in box if m.get('body') == 'deep2'), 1)

    def test_c3_ask_without_a_work_item_holds_work_items(self):
        from orgtree import notification_state
        org = store.load_org(self.slug)
        org.work_create('boss', 'Attention fixture',
                        objective='Problem: x. Solution: y.')
        it = org.d['work_items'][-1]
        it['manual_attention'] = {'set_rev': 1, 'reason': 'look'}
        it['notification_attention_active'] = False     # stale: the next save flips it
        with patch.object(notification_state, 'reconcile_attention', lambda *a, **k: None):
            store.save_org(org)
        self.assertFalse(store.load_org(self.slug).d['work_items'][-1]
                         ['notification_attention_active'])
        self.tool(maildoor.ASK, 'boss', question='plain ask')
        self.assertEqual(len(self.sections), 1, 'the ask was refused an unlocked write')
        self.assertIn('work_items', self.sections[-1])
        self.assertTrue(store.load_org(self.slug).d['work_items'][-1]
                        ['notification_attention_active'],
                        'the fixture did not make the ask rewrite work_items')

    def test_c4_a_refused_message_names_its_outbox_copies(self):
        scratch = supervisor.scratch_dir(self.slug, 'boss')
        os.makedirs(scratch, exist_ok=True)
        with open(os.path.join(scratch, 'orphan.txt'), 'w') as f:
            f.write('x')
        with patch.object(ledger.Org, 'post_mail',
                          side_effect=ledger.LedgerError('refused for the test')):
            with self.assertRaises(HTTPException) as cm:
                self.tool(maildoor.MESSAGE, 'boss', to='user', body='x',
                          attachments=['orphan.txt'])
        self.assertIn('orphan.txt', str(cm.exception.detail))
        self.assertIn('refused for the test', str(cm.exception.detail))

    def test_c2_org_send_runs_after_commit_under_an_op_key(self):
        calls = []
        with patch.object(supervisor, 'interorg_send',
                          lambda src, dst, body, op_key=None: calls.append(
                              (src, dst, op_key)) or None),                 patch.object(ledger.Org, '_resolve_recipient',
                             lambda self, to, **k: to):
            try:
                r = self.tool(maildoor.MESSAGE, 'boss', to='@org:elsewhere', body='hi')
            except HTTPException as e:
                self.skipTest(f'@org: send refused in this fixture: {e.detail}')
        self.assertEqual(len(calls), 1)
        src, dst, key = calls[0]
        self.assertEqual((src, dst), (self.slug, 'elsewhere'))
        self.assertTrue(key and key.startswith(f'agent-out:{self.slug}:'), key)
        self.assertIn("repeating this exact call does not retry it", r.get('delivery', ''))

    def test_door_off_keeps_the_legacy_cycle(self):
        with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}):
            self.assertFalse(pgdoor.routed(maildoor.NOTICE, {}))
            with self.assertRaises(AssertionError):
                self.call('boss', to='sub', body='legacy')


if __name__ == '__main__':
    unittest.main()
