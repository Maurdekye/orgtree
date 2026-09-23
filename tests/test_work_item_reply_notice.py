"""notice-toggle parity (user 2026-09-17): the notice-send toggle existed in
the desk composer only, so every other message box could send nothing but
ordinary waking mail. Three composers gained it — mail reply, presentation
reply, ticket reply — and of those only the TICKET reply needed a backend
change: it posts to /work-items/{wid}/reply, which had no `notice` field at
all, while the other two already flow through /message (Message.notice, since
b38d9d9) and needed frontend wiring only.

WHAT A NOTICE IS DID NOT CHANGE, and that is what this file pins. The endpoint
gained one flag and reuses the identical two halves node_message already used:
the mail row is stored with kind='notice', and the recipient is nudged with
wake=False so an idle agent stays idle. Both halves are asserted separately —
storing the row as a notice while still waking the agent would be a notice in
name only, and is exactly the mistake that is invisible in a response payload.

Same directness as test_work_item_reply_attachments.py: the real endpoint via
TestClient, the canonical stored state read back, the provider send patched
out because driving the CLI is not this test's job. Patching it out is also
how the WAKE is observed — the call's own kwargs are the evidence.

⚠ Run it through the repo's runner, never a bare `python -m unittest`:
    python tools/run-python-verification.py tests/test_work_item_reply_notice.py
PYTHONPATH on the build machine points at the INSTALLED app, so a bare run can
pass green against shipped code that does not contain this change.
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-work-reply-notice-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
app, *_ = load_app()
from orgtree import ledger, store, supervisor


_orgs_created: list[str] = []
HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


class WorkItemReplyNoticeTests(unittest.TestCase):
    def _org_with_item(self, slug: str):
        # one org per test: store.create_org refuses a repeat name and this
        # module never resets one mid-run
        _orgs_created.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'owner')
        created = org.work_create('owner', 'Ship it', 'objective text', owner='owner')
        store.save_org(org)
        return created['slug'] if isinstance(created, dict) and 'slug' in created else created

    def _reply(self, slug: str, wid: str, **body):
        client = TestClient(app)
        with patch.object(supervisor, 'send_message',
                          return_value={'accepted': True}) as drive:
            sent = client.post(f'/api/orgs/{slug}/work-items/{wid}/reply',
                               headers=HEADERS, json={'body': 'a reply', **body})
        return sent, drive

    def test_an_armed_reply_is_stored_as_a_notice_and_does_not_wake_the_agent(self):
        slug = 'workreply-notice'
        wid = self._org_with_item(slug)
        sent, drive = self._reply(slug, wid, notice=True)
        self.assertEqual(sent.status_code, 200, sent.text)
        payload = sent.json()
        self.assertIs(payload.get('notice'), True,
                      f'the response must report the delivery it made: {payload}')

        row = store.load_org(slug).d['mail']['owner'][-1]
        self.assertEqual(row['kind'], 'notice',
                         f'the stored mail row is what the UI reads to draw the '
                         f'dotted border: {row}')
        # the typed linkage is untouched — this is still a reply TO the item
        self.assertEqual(row['ev']['variant'], 'reply.docket')
        self.assertIn('a reply', row['body'])

        # THE HALF THAT IS INVISIBLE IN THE PAYLOAD. A row marked 'notice'
        # that still woke the recipient is a notice in name only.
        drive.assert_called_once()
        self.assertIs(drive.call_args.kwargs.get('wake'), False,
                      f'a notice must not start a turn: {drive.call_args}')
        self.assertEqual(drive.call_args.kwargs.get('ping_reason'), 'notice')
        self.assertIs(drive.call_args.kwargs.get('mail_ping'), True,
                      'it still lands in the mailbox — a notice is mail minus the wake')

    def test_CONTROL_an_unarmed_reply_is_ordinary_waking_mail_exactly_as_before(self):
        # The anti-vacuity pair: same request, one field removed. Without
        # this, "it sends a notice" would be indistinguishable from "it now
        # always sends a notice", which would have silently stopped every
        # docket reply in the product from reaching a running agent.
        slug = 'workreply-ordinary'
        wid = self._org_with_item(slug)
        sent, drive = self._reply(slug, wid)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertIs(sent.json().get('notice'), False)

        row = store.load_org(slug).d['mail']['owner'][-1]
        self.assertEqual(row['kind'], 'message')
        drive.assert_called_once()
        self.assertNotIn('wake', drive.call_args.kwargs,
                         'the ordinary path does not pass wake at all — it wakes '
                         f'by default: {drive.call_args}')
        self.assertEqual(drive.call_args.kwargs.get('ping_reason'), 'docket_reply')
        self.assertIn('act on it now', drive.call_args.args[2],
                      'and the ordinary instruction is unchanged')

    def test_notice_false_is_the_same_as_omitting_it(self):
        slug = 'workreply-explicit-false'
        wid = self._org_with_item(slug)
        sent, drive = self._reply(slug, wid, notice=False)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertIs(sent.json().get('notice'), False)
        self.assertEqual(store.load_org(slug).d['mail']['owner'][-1]['kind'], 'message')
        self.assertNotIn('wake', drive.call_args.kwargs)

    def test_an_addressed_participant_reply_can_be_a_notice_too(self):
        # `to` picks a participant rather than the owner; the two features are
        # independent and must compose — the recipient moves, the delivery
        # mode does not change with it
        slug = 'workreply-notice-participant'
        _orgs_created.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'owner')
        org.hire(ledger.USER, None, 'haiku', 0, 'helper')
        created = org.work_create('owner', 'Ship it', 'objective text', owner='owner')
        wid = created['slug'] if isinstance(created, dict) and 'slug' in created else created
        org.work_participants('owner', wid, add=['helper'])
        store.save_org(org)

        sent, drive = self._reply(slug, wid, to='helper', notice=True)
        self.assertEqual(sent.status_code, 200, sent.text)
        payload = sent.json()
        self.assertEqual(payload.get('to'), 'helper')
        self.assertEqual(payload.get('role'), 'participant')
        self.assertIs(payload.get('notice'), True)
        self.assertEqual(store.load_org(slug).d['mail']['helper'][-1]['kind'], 'notice')
        self.assertIs(drive.call_args.kwargs.get('wake'), False)

    def test_a_deferred_archived_recipient_reports_the_notice_it_asked_for(self):
        # an archived recipient never gets driven at all; the mail waits for
        # the rehire. The response still has to say which KIND is waiting.
        slug = 'workreply-notice-deferred'
        _orgs_created.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'owner')
        created = org.work_create('owner', 'Ship it', 'objective text', owner='owner')
        wid = created['slug'] if isinstance(created, dict) and 'slug' in created else created
        org.retire(ledger.USER, 'owner')
        store.save_org(org)

        client = TestClient(app)
        with patch.object(supervisor, 'send_message',
                          return_value={'accepted': True}) as drive:
            sent = client.post(f'/api/orgs/{slug}/work-items/{wid}/reply',
                               headers=HEADERS, json={'body': 'a reply', 'notice': True})
        self.assertEqual(sent.status_code, 200, sent.text)
        payload = sent.json()
        self.assertIs(payload.get('deferred'), True, payload)
        self.assertIs(payload.get('notice'), True, payload)
        drive.assert_not_called()
        self.assertEqual(store.load_org(slug).d['mail']['owner'][-1]['kind'], 'notice')


if __name__ == '__main__':
    unittest.main()
