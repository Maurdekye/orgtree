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
    def setUp(self) -> None:
        orgtx.use_backend(orgtx.SeamBackend())
        self.slug = f'pg3d{self._testMethodName[-12:].replace("_", "")}'.lower()
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        org.hire('boss', 'boss', 'haiku', 0, 'deep')
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
            rows['sections'] = [s for s in rows['sections'] if s != 'mail']
            under.ran = True
            return rows

        under.ran = False
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}), \
                patch.object(mailtx, 'send_rows', under):
            with self.assertRaises(orgtx.UnlockedWrite):
                self._send('must not land')
        self.assertTrue(under.ran, 'the under-declared control never ran')
        d = store.load_org(self.slug).d
        self.assertFalse(d['mail'].get('deep'), 'CONTROL FAILED AS DESIGNED: nothing may land')

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


if __name__ == '__main__':
    unittest.main()
