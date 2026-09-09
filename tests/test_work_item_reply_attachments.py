"""allow-attachments-in-contextual-reply-composers: the docket item ("ticket")
reply box's own endpoint, /work-items/{wid}/reply, never had an attachments
field at all — the ordinary mail composer's /message endpoint already did
(Message.attachments, resolved unconditionally before its target/reply_to
branch split). This is the one path that needed a real backend change; the
other two contextual reply composers (mail, presentation) already flow
through /message and needed no backend change, just frontend wiring.

Same directness as test_pending_reply.py: hit the real endpoint via
TestClient, read the canonical stored state back, no mocked provider send
(patched out, same as that file, since driving the CLI is not this test's
job)."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-work-reply-attach-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app
app, *_ = load_app()
from orgtree import ledger, store, supervisor


_orgs_created: list[str] = []


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


class WorkItemReplyAttachmentTests(unittest.TestCase):
    def _org_with_item(self, slug: str):
        # each test gets its OWN org slug — store.create_org refuses a
        # repeat name, and this repo's tests never delete/reset an org
        # mid-module (test_pending_reply.py's own module never needed to,
        # having only one test)
        _orgs_created.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'owner')
        created = org.work_create('owner', 'Ship it', 'objective text', owner='owner')
        store.save_org(org)
        return created['slug'] if isinstance(created, dict) and 'slug' in created else created

    def _stage_file(self, slug: str, nid: str, name: str, content: bytes) -> str:
        # mimics what the ordinary /upload endpoint leaves behind: a real
        # file inside the node's own scratch dir, ready to be referenced by
        # its relative path — this test skips driving /upload itself since
        # the attachment RESOLUTION is what's under test, not the upload
        base = supervisor.scratch_dir(slug, nid)
        os.makedirs(base, exist_ok=True)
        path = os.path.join(base, name)
        with open(path, 'wb') as f:
            f.write(content)
        return name

    def test_reply_with_a_real_staged_file_attaches_it_to_the_mail_entry(self):
        slug = 'workreply-positive'
        wid = self._org_with_item(slug)
        rel = self._stage_file(slug, 'owner', 'notes.txt', b'attachment body')
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token': 'operator'}
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}) as drive:
            sent = client.post(f'/api/orgs/{slug}/work-items/{wid}/reply', headers=headers,
                               json={'body': 'see attached', 'attachments': [rel]})
        self.assertEqual(sent.status_code, 200, sent.text)
        drive.assert_called_once()
        payload = sent.json()
        self.assertNotIn('warnings', payload, f'a real, present file must not warn: {payload}')
        row = store.load_org(slug).d['mail']['owner'][-1]
        # typed reply.docket: the stored body is the renderer's own rendition
        # of the minted event (header + instruction prose), which includes
        # the user's own text rather than being a bare echo of it
        self.assertIn('see attached', row['body'])
        atts = row.get('attachments') or []
        self.assertEqual(len(atts), 1, f'attachment did not reach the mail entry: {row}')
        self.assertEqual(atts[0]['name'], 'notes.txt')
        self.assertEqual(atts[0]['bytes'], len(b'attachment body'))

    def test_a_path_the_composer_never_actually_uploaded_is_reported_missing_not_guessed(self):
        # D-171, same rule as node_message's own attachment resolution: a
        # caller-supplied path that resolves to nothing is REPORTED, never
        # silently dropped or guessed at — this is the anti-vacuity pair for
        # the positive test above (same shape, one fact changed: the file
        # was never staged)
        slug = 'workreply-missing'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token': 'operator'}
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}):
            sent = client.post(f'/api/orgs/{slug}/work-items/{wid}/reply', headers=headers,
                               json={'body': 'see attached', 'attachments': ['never-uploaded.png']})
        self.assertEqual(sent.status_code, 200, sent.text)
        payload = sent.json()
        self.assertIn('warnings', payload, 'a missing attachment must be reported to the caller')
        self.assertTrue(any('never-uploaded.png' in w for w in payload['warnings']), payload['warnings'])
        row = store.load_org(slug).d['mail']['owner'][-1]
        self.assertEqual(row.get('attachments') or [], [], 'nothing was actually attached')

    def test_reply_context_survives_alongside_an_attachment(self):
        # acceptance wording: "preserving reply context and drafts" — the
        # typed reply.docket linkage (this IS a reply to the work item, not
        # an ordinary message) must not be disturbed by adding an attachment
        slug = 'workreply-context'
        wid = self._org_with_item(slug)
        rel = self._stage_file(slug, 'owner', 'evidence.png', b'\x89PNG fake bytes')
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token': 'operator'}
        with patch.object(supervisor, 'send_message', return_value={'accepted': True}):
            sent = client.post(f'/api/orgs/{slug}/work-items/{wid}/reply', headers=headers,
                               json={'body': 'progress update', 'attachments': [rel]})
        self.assertEqual(sent.status_code, 200, sent.text)
        row = store.load_org(slug).d['mail']['owner'][-1]
        self.assertEqual(row['ev']['variant'], 'reply.docket',
                         'the typed reply-to-item linkage must survive attaching a file')
        self.assertEqual((row.get('attachments') or [{}])[0].get('name'), 'evidence.png')


if __name__ == '__main__':
    unittest.main()
