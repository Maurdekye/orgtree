"""PG-3d: the mail routes on row transactions (mailtx.py + orgtx.org_tx).

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * a user send to a deep node lands (mail, mail_log, the chain's notices,
    the user audience) and completes WHILE ANOTHER THREAD HOLDS DOC_LOCK —
    the converted route never waits on the process-wide lock;
  * CONTROL: the same send with `mail` left out of the declaration is
    refused (UnlockedWrite) and NOTHING lands — the declaration is what the
    route is protected by, not an accident;
  * the user read mark, mark-all-read and the org-inbox read mark commit
    while DOC_LOCK is held elsewhere.

Run:  python tools/run-python-verification.py tests/test_pg3d_mail_tx.py
"""

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v3-pg3d-mail-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from orgtree import ledger, mailtx, orgtx, store, supervisor  # noqa: E402

# These prove the converted routes never wait on DOC_LOCK, which the
# transition fence (plan decision 19: every org_tx behind DOC_LOCK until the
# last writer converts) deliberately undoes; it has its own tests in PG-0.
orgtx.TRANSITION_FENCE = False

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}


def tearDownModule() -> None:
    root.cleanup()


class DocLockHeld:
    """Hold DOC_LOCK on another thread for the duration of the block; records
    that it really held it (so a pass cannot come from a hold that never
    happened)."""

    def __init__(self) -> None:
        self.held = threading.Event()
        self.release = threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        with store.DOC_LOCK:
            self.held.set()
            self.release.wait(30)

    def __enter__(self) -> 'DocLockHeld':
        self.t.start()
        assert self.held.wait(10), 'DOC_LOCK holder never acquired the lock'
        return self

    def __exit__(self, *exc: object) -> None:
        self.release.set()
        self.t.join(10)


def call_with_timeout(fn, seconds: float = 20.0):
    """Run fn on a worker; fail (not hang) if it waits on DOC_LOCK."""
    out: dict = {}

    def run() -> None:
        try:
            out['v'] = fn()
        except BaseException as e:   # noqa: BLE001
            out['e'] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise AssertionError('the call waited on DOC_LOCK (did not finish while it was held)')
    if 'e' in out:
        raise out['e']
    return out['v']


class MailTx(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        MailTx.n += 1
        self.slug = f'pg3dmail{MailTx.n}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 3, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'deep', add_dirs=[],
                 tools={'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []},
                 org_visibility='self', charter='a deep test agent')
        store.save_org(org)
        self.client = TestClient(app)

    def _send(self, text: str):
        return self.client.post(f'/api/orgs/{self.slug}/nodes/deep/message', headers=HEADERS,
                                json={'text': text})

    def test_user_send_to_a_deep_node_lands_without_doc_lock(self) -> None:
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}):
            with DocLockHeld():
                r = call_with_timeout(lambda: self._send('hello deep'))
        self.assertEqual(r.status_code, 200, r.text)
        d = store.load_org(self.slug).d
        self.assertEqual([m['body'] for m in d['mail']['deep']], ['hello deep'])
        self.assertTrue(any(m.get('body') == 'hello deep' for m in d['mail_log']['deep']))
        self.assertTrue(d['notices'].get('boss'), 'the superior chain was noticed')
        self.assertTrue(any(a.get('grantee') == 'deep' or a.get('holder') == 'deep'
                            or 'deep' in str(a) for a in d['audiences']), d['audiences'])

    def test_control_a_send_missing_its_mail_declaration_is_refused_and_writes_nothing(self) -> None:
        real = mailtx.send_rows

        def under(*recipients: str):
            rows = real(*recipients)
            # the recipient's box: ('mail', nid) since the per-owner split
            kept = [s for s in rows['sections']
                    if s != 'mail' and not (isinstance(s, tuple) and s[0] == 'mail')]
            under.removed += len(rows['sections']) - len(kept)
            rows['sections'] = kept
            under.ran = True
            return rows

        under.ran = False
        under.removed = 0
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}), \
                patch.object(mailtx, 'send_rows', under):
            with self.assertRaises(orgtx.UnlockedWrite):
                self._send('must not land')
        self.assertTrue(under.ran, 'the under-declared control never ran')
        self.assertGreater(under.removed, 0, 'the control removed no mail declaration')
        d = store.load_org(self.slug).d
        self.assertFalse((d.get('mail') or {}).get('deep'), 'CONTROL FAILED AS DESIGNED: nothing may land')

    def test_clear_reply_events_commits_the_new_incarnation_in_its_own_tx(self) -> None:
        # plan decision 29: reply_events.clear() inside the route's org_tx
        # must NOT save on its own — the transaction's one commit carries the
        # cleared node row
        from orgtree import reply_events
        org = store.load_org(self.slug)
        before = reply_events.incarnation(org, 'deep')
        old_node = store.load_org(self.slug).d['nodes']['deep'].get('reply_incarnation')
        saves: list[str] = []
        real_save = store.save_org

        def counting(o):
            saves.append(o.d['slug'])
            return real_save(o)
        with patch.object(store, 'save_org', counting), DocLockHeld():
            r = call_with_timeout(lambda: self.client.delete(
                f'/api/orgs/{self.slug}/nodes/deep/reply-events', headers=HEADERS))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(saves, [self.slug], 'exactly one save: the org_tx commit')
        new_node = store.load_org(self.slug).d['nodes']['deep'].get('reply_incarnation')
        self.assertTrue(new_node)
        self.assertNotEqual(new_node, old_node)
        self.assertNotEqual(reply_events.incarnation(store.load_org(self.slug), 'deep'), before)

    def test_inbound_org_inbox_delivery_and_interorg_send_without_doc_lock(self) -> None:
        other = store.create_org(f'{self.slug}src')
        other.hire(ledger.USER, None, 'haiku', 0, 'sender')
        store.save_org(other)
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}):
            with DocLockHeld():
                got = call_with_timeout(lambda: supervisor.deliver_org_inbox(
                    self.slug, '@net:someone', 'hello org'))
                err = call_with_timeout(lambda: supervisor.interorg_send(
                    other.d['slug'], self.slug, 'org to org'))
        self.assertEqual(got, ['boss'])            # first contact bootstraps a holder
        self.assertIsNone(err)
        d = store.load_org(self.slug).d
        self.assertEqual([m['body'] for m in d['mail']['boss']], ['hello org', 'org to org'])
        self.assertEqual([m['from'] for m in d['mail']['boss']],
                         ['@net:someone', f"@org:{other.d['slug']}"])
        inbox = [str(e) for e in d['org_inbox']]
        self.assertTrue(any('hello org' in e for e in inbox), inbox)
        self.assertTrue(any('org to org' in e for e in inbox), inbox)

    def test_org_send_crash_between_the_two_commits_then_retry_no_loss_no_duplicate(self) -> None:
        # plan decision 38: the destination commits first under its receipt,
        # the source records the send after; a crash between them + a retry
        # with the same op_key must leave exactly one delivery and one record
        dst = store.create_org(f'{self.slug}dst')
        dst.hire(ledger.USER, None, 'haiku', 0, 'holder')
        store.save_org(dst)
        dslug = dst.d['slug']
        real_log = ledger.Org._org_inbox_log
        crashes = {'n': 0}

        def crash_once(org, direction, *a, **kw):
            if direction == 'out' and crashes['n'] == 0:
                crashes['n'] += 1
                raise RuntimeError('crash between the destination and the source commit')
            return real_log(org, direction, *a, **kw)

        def outs() -> list:
            return [e for e in store.load_org(self.slug).d['org_inbox']
                    if e.get('dir') == 'out' and e.get('body') == 'cross-org hello']

        def copies() -> int:
            return sum(1 for m in (store.load_org(dslug).d.get('mail') or {}).get('holder') or []
                       if m.get('body') == 'cross-org hello')

        send = {'to': f'@org:{dslug}', 'body': 'cross-org hello', 'op_key': 'retry-key-1'}
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}), \
                patch.object(ledger.Org, '_org_inbox_log', crash_once):
            r1 = client.post(f'/api/orgs/{self.slug}/org_inbox/send', headers=HEADERS, json=send)
            self.assertEqual(crashes['n'], 1, 'the crash was never injected')
            self.assertEqual(r1.status_code, 500, r1.text)
            self.assertEqual(copies(), 1, 'the destination committed before the crash')
            self.assertEqual(outs(), [], 'the source must not have recorded the send')
            r2 = client.post(f'/api/orgs/{self.slug}/org_inbox/send', headers=HEADERS, json=send)
            self.assertEqual(r2.status_code, 200, r2.text)
            r3 = client.post(f'/api/orgs/{self.slug}/org_inbox/send', headers=HEADERS, json=send)
            self.assertEqual(r3.status_code, 200, r3.text)
        self.assertEqual(copies(), 1, 'no duplicate delivery on retry')
        self.assertEqual(len(outs()), 1, 'the send recorded exactly once')
        self.assertEqual(r2.json()['id'], r3.json()['id'])

    def test_inbound_retries_when_the_holders_moved(self) -> None:
        real = orgtx.org_read
        calls = {'n': 0, 'stale': 0}

        class Stale:
            def extern_recipients_preview(self):
                return ['deep']                    # wrong: boss will be bootstrapped

        def reader(slug, **kw):
            calls['n'] += 1
            if calls['stale'] == 0:
                calls['stale'] += 1
                return Stale()
            return real(slug, **kw)
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}), \
                patch.object(orgtx, 'org_read', reader):
            got = supervisor.deliver_org_inbox(self.slug, '@net:x', 'retry me')
        self.assertEqual(calls['stale'], 1, 'the stale prediction was never served')
        self.assertEqual(got, ['boss'])
        d = store.load_org(self.slug).d
        self.assertEqual([m['body'] for m in d['mail']['boss']], ['retry me'])
        self.assertFalse(d['mail'].get('deep'))

    def test_control_inbound_under_declared_is_refused_and_writes_nothing(self) -> None:
        real = mailtx.inbound_rows

        def under(recipients):
            rows = real(recipients)
            kept = [s for s in rows['sections'] if not (isinstance(s, tuple) and s[0] == 'mail')]
            under.removed = len(rows['sections']) - len(kept)
            rows['sections'] = kept
            return rows
        under.removed = 0
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}), \
                patch.object(mailtx, 'inbound_rows', under):
            with self.assertRaises(orgtx.UnlockedWrite):
                supervisor.deliver_org_inbox(self.slug, '@net:x', 'must not land')
        self.assertGreater(under.removed, 0, 'the control removed no mail declaration')
        d = store.load_org(self.slug).d
        self.assertFalse((d.get('mail') or {}).get('boss'), 'CONTROL FAILED AS DESIGNED')

    def test_read_marks_commit_without_doc_lock(self) -> None:
        org = store.load_org(self.slug)
        a = org.to_user_inbox({'id': 'u1', 'from': 'boss', 'at': '2026-09-25T00:00:01Z', 'body': 'one'})
        org.to_user_inbox({'id': 'u2', 'from': 'boss', 'at': '2026-09-25T00:00:02Z', 'body': 'two'})
        store.save_org(org)
        with DocLockHeld():
            r = call_with_timeout(lambda: self.client.post(
                f'/api/orgs/{self.slug}/inbox/read', headers=HEADERS, json={'ids': [a['id']]}))
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()['read'], 1)
            r = call_with_timeout(lambda: self.client.get(
                f'/api/orgs/{self.slug}/org_inbox', headers=HEADERS))
            self.assertEqual(r.status_code, 200, r.text)
        d = store.load_org(self.slug).d
        self.assertEqual([m['id'] for m in d['user_inbox']], ['u2'])
        self.assertIn('u1', [m['id'] for m in d['user_mail_log']])
        with DocLockHeld():
            r = call_with_timeout(lambda: self.client.post(
                f'/api/orgs/{self.slug}/inbox/clear', headers=HEADERS))
            self.assertEqual(r.status_code, 200, r.text)
        d = store.load_org(self.slug).d
        self.assertEqual(d['user_inbox'], [])
        self.assertEqual({'u1', 'u2'} & {m['id'] for m in d['user_mail_log']}, {'u1', 'u2'})

    def test_ask_answer_audience_revoke_and_retract_commit_without_doc_lock(self) -> None:
        org = store.load_org(self.slug)
        ask = org.ask_user('boss', 'Proceed?')
        store.save_org(org)
        aid = ask['asked']
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}):
            with DocLockHeld():
                r = call_with_timeout(lambda: self.client.post(
                    f'/api/orgs/{self.slug}/asks/{aid}/answer', headers=HEADERS,
                    json={'text': 'yes, go'}))
                self.assertEqual(r.status_code, 200, r.text)
                sent = call_with_timeout(lambda: self._send('retract me'))
                self.assertEqual(sent.status_code, 200, sent.text)
        d = store.load_org(self.slug).d
        self.assertNotEqual(next(a for a in d['asks'] if a['id'] == aid)['status'], 'open')
        mid = next(m['id'] for m in d['mail']['deep'] if m.get('body') == 'retract me')
        self.assertTrue(any(True for a in d['audiences'] if 'deep' in str(a)), 'a user audience exists')
        with DocLockHeld():
            r = call_with_timeout(lambda: self.client.delete(
                f'/api/orgs/{self.slug}/nodes/deep/mail/{mid}', headers=HEADERS))
            self.assertEqual(r.status_code, 200, r.text)
            r = call_with_timeout(lambda: self.client.post(
                f'/api/orgs/{self.slug}/audiences', headers=HEADERS,
                json={'action': 'revoke', 'node': 'deep', 'target': 'user'}))
            self.assertIn(r.status_code, (200, 422), r.text)
        d = store.load_org(self.slug).d
        self.assertFalse(any(m.get('id') == mid for m in d['mail']['deep']), 'retracted')
        self.assertTrue(any(m.get('id') == mid and m.get('retracted') for m in d['mail_log']['deep']))


if __name__ == '__main__':
    unittest.main()
