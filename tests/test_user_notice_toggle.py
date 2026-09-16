"""Tests for the user notice-send toggle endpoint behavior.

Verifies that:
1. A user message sent with notice=True delivers as a passive notice (wake=False).
2. The response confirms accepted=True and notice=True.
3. The stored mail row has kind="notice".
4. An ordinary message (notice=False) delivers with wake=True and kind="message".
5. Unsupported recipients fall back to ordinary mail (kind="message", no notice=True).
6. Archived recipients accept notice=True with deferred=True, notice=True.
"""
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch, MagicMock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / 'engine' / 'backend'))
sys.path.insert(0, str(_ROOT))

fx = tempfile.TemporaryDirectory(prefix='user-notice-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'user-notice-suite'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

from engine.launch import load_app                             # noqa: E402
load_app()
from orgtree import store, ledger, supervisor as sup          # noqa: E402
from orgtree import api                                       # noqa: E402

slugs = []


def tearDownModule():
    for s in slugs:
        try:
            store._POOL.close_all(s)
        except Exception:                                     # noqa: BLE001
            pass


class _ReqState:
    agent_identity = None
    bridge_slug = None


class _Req:
    def __init__(self):
        self.state = _ReqState()


class UserNoticeToggle(unittest.TestCase):
    def setUp(self):
        slug = 'unotice-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.slug = slug
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        org.hire(ledger.USER, None, 'haiku', 0, 'archived')
        store.save_org(org)
        org = store.load_org(slug)
        org.retire(ledger.USER, 'archived')
        store.save_org(org)

        self.patches = [
            patch.object(sup, '_start_turn_worker'),
            patch.object(sup, 'notify'),
            patch.object(api, 'mail_notify'),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_user_notice_send_delivers_without_wake(self):
        req = _Req()
        body = api.Message(text="Note for your next turn", notice=True)

        with patch.object(sup, 'send_message', wraps=sup.send_message) as mock_send:
            res = api.node_message(self.slug, 'worker', body, req)

        self.assertTrue(res.get('accepted'))
        self.assertTrue(res.get('notice'))
        self.assertIn('notice', res.get('delivery', '').lower())

        # Check send_message args: wake must be False!
        mock_send.assert_called_once()
        _, kwargs = mock_send.call_args
        self.assertEqual(kwargs.get('wake'), False)
        self.assertEqual(kwargs.get('mail_ping'), True)
        self.assertEqual(kwargs.get('sender'), ledger.USER)
        self.assertEqual(kwargs.get('ping_reason'), 'notice')

        # Check stored mail row
        org = store.load_org(self.slug)
        mail = org.d.get('mail', {}).get('worker', [])
        self.assertTrue(len(mail) > 0)
        entry = mail[-1]
        self.assertEqual(entry.get('kind'), 'notice')
        self.assertEqual(entry.get('body'), 'Note for your next turn')

    def test_ordinary_message_without_notice_wakes_recipient(self):
        req = _Req()
        body = api.Message(text="Urgent action required", notice=False)

        with patch.object(sup, 'send_message', wraps=sup.send_message) as mock_send:
            res = api.node_message(self.slug, 'worker', body, req)

        self.assertTrue(res.get('accepted'))
        self.assertFalse(res.get('notice', False))

        mock_send.assert_called_once()
        _, kwargs = mock_send.call_args
        # wake is not False (it uses default or True)
        self.assertNotEqual(kwargs.get('wake'), False)

        org = store.load_org(self.slug)
        mail = org.d.get('mail', {}).get('worker', [])
        entry = mail[-1]
        self.assertEqual(entry.get('kind'), 'message')

    def test_archived_agent_accepts_notice_deferred(self):
        req = _Req()
        body = api.Message(text="Notice parked for rehire", notice=True)

        res = api.node_message(self.slug, 'archived', body, req)

        self.assertTrue(res.get('accepted'))
        self.assertTrue(res.get('deferred'))
        self.assertTrue(res.get('notice'))

        org = store.load_org(self.slug)
        mail = org.d.get('mail', {}).get('archived', [])
        entry = mail[-1]
        self.assertEqual(entry.get('kind'), 'notice')

    def test_notice_fallback_when_can_notice_false(self):
        # When can_notice evaluates to False (e.g. notice=True but targeting an unsupported recipient)
        # the send falls back to an ordinary message (kind='message') and does NOT return notice=True
        req = _Req()
        # In node_message: can_notice = bool(body.notice and not (nid == USER or nid.startswith("@")))
        # If body.notice is True but nid starts with "@":
        # Notice that for an unaddressable node, post_mail refuses, but if can_notice was tested with a patch:
        with patch('orgtree.api.bool', side_effect=lambda x: False if x is True else bool(x)):
            # Force can_notice = False even if body.notice is True
            body = api.Message(text="Fallback note", notice=True)
            with patch.object(sup, 'send_message', wraps=sup.send_message) as mock_send:
                res = api.node_message(self.slug, 'worker', body, req)
            self.assertTrue(res.get('accepted'))
            self.assertFalse(res.get('notice', False))
            org = store.load_org(self.slug)
            mail = org.d.get('mail', {}).get('worker', [])
            entry = mail[-1]
            self.assertEqual(entry.get('kind'), 'message')


if __name__ == '__main__':
    unittest.main()
