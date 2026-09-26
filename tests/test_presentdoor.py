"""S2 slice 4 (fence-off): orgtree_present and orgtree_submit_report on the
shared door (presentdoor.py).

Through the real `api.agent_call` (throwaway SQLite root, PG-0's SeamBackend
org_tx, ORGTREE_PGDOOR=1), with `store.write_org` made to explode so any call
that falls back into the resident DOC_LOCK cycle fails loudly.

  * present (markdown) commits one card on the door, holding no agent's mail;
  * present by path copies the file ONCE even when the transaction widens
    and re-runs (lead condition C6), and a refusal on the locked document
    names the copy it left (p01 condition C4); a gate refusal copies nothing;
  * submit_report presents and mails the user (top-level caller), or only
    forwards to the superior (nested caller), exactly once even on a widen;
    it drives nobody (legacy parity);
  * neither waits on DOC_LOCK (transition fence off, DOC_LOCK held);
  * ORGTREE_PGDOOR=0 keeps the legacy cycle.

Run:  python tools/run-python-verification.py tests/test_presentdoor.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-presentdoor-', ignore_cleanup_errors=True)
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '1'
os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = '1'
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, presentdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]
PAGE = '<!doctype html><title>m</title><p>mock</p>'


def _explode(*a, **k):
    raise AssertionError('present/submit_report fell into the DOC_LOCK cycle')


class PresentDoor(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'pdoor{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        for nid in ('sub', 'peer'):
            org.hire('boss', 'boss', 'luna', 0, nid, add_dirs=[], tools=T,
                     org_visibility='full', charter='c')
        store.save_org(org)
        pgdoor.use_org_tx(None)
        for tool in (presentdoor.PRESENT, presentdoor.SUBMIT_REPORT):
            self.assertTrue(pgdoor.routed(tool, {}), f'{tool} is not on the door')
        self.sent, self.sections, self.shared, self.attempts = [], [], [], [0]
        self.p = [patch.object(supervisor, 'send_message',
                               lambda slug, t, *a, **k: self.sent.append(t) or {}),
                  patch.object(api, 'mail_notify', lambda *a, **k: None),
                  patch.object(api, 'hub_changed', lambda *a, **k: None),
                  patch.object(store, 'write_org', _explode)]
        for x in self.p:
            x.start()

        def hook(p, tx):
            if p == 'after_lock':
                self.sections.append(set(tx.lock_sections))
                self.shared.append(set(tx.share_sections))
        orgtx.set_pause_hook(hook)

    def tearDown(self):
        orgtx.set_pause_hook(None)
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)

    def tool(self, tool, node, **a):
        return api.agent_call(api.AgentCall(org=self.slug, node=node,
                                            tool=tool, args=a), REQUEST)

    def docs(self):
        return store.load_org(self.slug).d.get('documents') or []

    def mockup(self, node='boss', name='mock.html'):
        scratch = supervisor.scratch_dir(self.slug, node)
        os.makedirs(scratch, exist_ok=True)
        with open(os.path.join(scratch, name), 'w', encoding='utf-8') as f:
            f.write(PAGE)
        return scratch

    def outbox(self, scratch):
        box = os.path.join(scratch, 'outbox')
        return sorted(os.listdir(box)) if os.path.isdir(box) else []

    def widen_once(self, tool):
        """The first attempt holds only what agent_spec adds, so the body's
        first write is refused (UnlockedWrite) and the door widens."""
        return patch.dict(pgdoor.LOCKS, {tool: pgdoor.TxSpec()})

    # -- orgtree_present ---------------------------------------------------
    def test_markdown_present_commits_one_card_on_the_door(self):
        r = self.tool(presentdoor.PRESENT, 'boss', title='T', body='# hi')
        self.assertTrue(r['ref'].startswith('@doc:'), r)
        self.assertEqual([d['title'] for d in self.docs()], ['T'])
        self.assertIn('audiences', self.shared[-1])
        self.assertFalse({s for s in self.sections[-1] if str(s).startswith('mail')},
                         'a present locked mail rows')

    def test_present_by_path_copies_once_even_on_a_widen(self):
        scratch = self.mockup()
        with self.widen_once(presentdoor.PRESENT):
            r = self.tool(presentdoor.PRESENT, 'boss', title='M', path='mock.html')
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        # present-by-path bundles each copy in its own outbox/presentation-*/
        copies = self.outbox(scratch)
        self.assertEqual(len(copies), 1, f'the mockup was copied per attempt: {copies}')
        docs = self.docs()
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].get('format'), 'html')
        self.assertEqual(docs[0].get('file'), f'outbox/{copies[0]}/mock.html')
        self.assertEqual(r.get('format'), 'html')

    def test_present_refused_after_the_copy_names_the_copy(self):
        scratch = self.mockup()
        with patch.object(ledger.Org, 'present_document',
                          side_effect=ledger.LedgerError('refused for the test')):
            with self.assertRaises(HTTPException) as cm:
                self.tool(presentdoor.PRESENT, 'boss', title='M', path='mock.html')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('refused for the test', str(cm.exception.detail))
        copies = self.outbox(scratch)
        self.assertEqual(len(copies), 1)
        self.assertIn(f'outbox/{copies[0]}/mock.html', str(cm.exception.detail))
        self.assertEqual(self.docs(), [])

    def test_present_gate_refusal_copies_nothing(self):
        scratch = self.mockup('sub')
        with self.assertRaises(HTTPException) as cm:
            self.tool(presentdoor.PRESENT, 'sub', title='M', path='mock.html')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('DIRECT user audience', str(cm.exception.detail))
        self.assertEqual(self.outbox(scratch), [])
        self.assertEqual(self.docs(), [])

    # -- orgtree_submit_report ---------------------------------------------
    def test_top_level_report_presents_and_mails_the_user_once(self):
        with self.widen_once(presentdoor.SUBMIT_REPORT):
            r = self.tool(presentdoor.SUBMIT_REPORT, 'boss', title='R', body='findings')
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        self.assertFalse(r['forwarded'])
        self.assertTrue(r['ref'].startswith('@doc:'), r)
        org = store.load_org(self.slug)
        self.assertEqual(len(org.d.get('documents') or []), 1)
        self.assertEqual(sum(1 for m in org.d.get('user_inbox') or []
                             if 'REPORT SUBMITTED: R' in str(m.get('body'))), 1)
        self.assertNotIn('_mail_to', r)
        self.assertEqual(self.sent, [], 'submit_report drove somebody')

    def test_nested_report_forwards_to_the_superior_once(self):
        with self.widen_once(presentdoor.SUBMIT_REPORT):
            r = self.tool(presentdoor.SUBMIT_REPORT, 'sub', title='R', body='details')
        self.assertGreaterEqual(len(self.sections), 2, 'no widen happened')
        self.assertTrue(r['forwarded'])
        self.assertEqual(r['mail']['recipient'], 'boss')
        org = store.load_org(self.slug)
        box = (org.d.get('mail') or {}).get('boss') or []
        self.assertEqual(sum(1 for m in box
                             if 'REPORT FORWARDING ACTION: R' in str(m.get('body'))), 1)
        self.assertEqual(org.d.get('documents') or [], [])
        self.assertEqual(self.sent, [], 'submit_report drove somebody')

    def test_nested_report_holds_only_the_superiors_mail(self):
        self.tool(presentdoor.SUBMIT_REPORT, 'sub', title='R', body='details')
        self.assertEqual(len(self.sections), 1, 'the prediction widened')
        mail = {s for s in self.sections[-1] if str(s).startswith('mail')}
        self.assertEqual(mail, {'mail\x1fboss'})

    def test_a_refused_report_writes_nothing(self):
        before = store.load_org(self.slug).d.get('mail')
        with self.assertRaises(HTTPException) as cm:
            self.tool(presentdoor.SUBMIT_REPORT, 'sub', title='', body='x')
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(store.load_org(self.slug).d.get('mail'), before)

    # -- DOC_LOCK / door off -------------------------------------------------
    def test_neither_waits_on_doc_lock(self):
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        done, err = threading.Event(), []

        def go():
            try:
                self.tool(presentdoor.PRESENT, 'boss', title='P', body='x')
                self.tool(presentdoor.SUBMIT_REPORT, 'sub', title='R', body='y')
            except BaseException as e:                       # noqa: BLE001
                err.append(e)
            done.set()
        try:
            with store.DOC_LOCK:
                th = threading.Thread(target=go)
                th.start()
                self.assertTrue(done.wait(10), 'a call waited on DOC_LOCK')
            th.join(5)
        finally:
            orgtx.TRANSITION_FENCE = fence
        self.assertEqual(err, [])
        self.assertEqual(len(self.docs()), 1)

    def test_door_off_keeps_the_legacy_cycle(self):
        with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}):
            for tool in (presentdoor.PRESENT, presentdoor.SUBMIT_REPORT):
                self.assertFalse(pgdoor.routed(tool, {}))
            with self.assertRaises(AssertionError):
                self.tool(presentdoor.PRESENT, 'boss', title='P', body='x')


if __name__ == '__main__':
    unittest.main()
