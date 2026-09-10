"""Ticket attachments (user feature 2026-09-10): files and images attached
TO a work item itself — records on the item via the ledger, bytes under
DATA_ROOT/work-attachments/<org>/<item>/, served by record id.

Same directness as test_work_item_reply_attachments.py: the real endpoints
via TestClient, canonical stored state read back. Every rule is asserted in
both polarities where it could pass vacuously: the round-trip proves the GET
can serve real bytes before any 404 assertion is trusted, and the cap test
proves uploads succeed right up to the cap before the refusal is read as the
cap working."""
import os
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-work-attach-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app
app, *_ = load_app()
from orgtree import ledger, store

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
_orgs_created: list[str] = []


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


class WorkAttachmentTests(unittest.TestCase):
    def _org_with_item(self, slug: str) -> str:
        _orgs_created.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'owner')
        created = org.work_create('owner', 'Ship it', 'objective text',
                                  owner='owner')
        store.save_org(org)
        return str(created['slug'])

    def _attach(self, client, slug, wid, name, body):
        return client.post(
            f'/api/orgs/{slug}/work-items/{wid}/attachments?name={name}',
            headers=HEADERS, content=body)

    def test_attach_list_serve_roundtrip(self):
        slug = 'workattach-round'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        png = b'\x89PNG fake image bytes'
        r = self._attach(client, slug, wid, 'shot.png', png)
        self.assertEqual(r.status_code, 200, r.text)
        rec = r.json()['attachment']
        self.assertEqual(rec['name'], 'shot.png')
        self.assertEqual(rec['bytes'], len(png))
        # the record is listed on the item's ordinary read
        got = client.get(f'/api/orgs/{slug}/work-items/{wid}', headers=HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        atts = got.json()['item']['attachments']
        self.assertEqual([a['name'] for a in atts], ['shot.png'])
        # and the GET serves the exact bytes back — the positive control every
        # later 404 assertion rests on
        served = client.get(
            f'/api/orgs/{slug}/work-items/{wid}/attachments/{rec["id"]}',
            headers=HEADERS)
        self.assertEqual(served.status_code, 200, served.text)
        self.assertEqual(served.content, png)

    def test_same_name_twice_dedupes_instead_of_overwriting(self):
        slug = 'workattach-dedupe'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        a = self._attach(client, slug, wid, 'notes.txt', b'first').json()['attachment']
        b = self._attach(client, slug, wid, 'notes.txt', b'second').json()['attachment']
        self.assertEqual(a['name'], 'notes.txt')
        self.assertEqual(b['name'], 'notes-2.txt', 'the second copy is renamed, never overwritten')
        first = client.get(f'/api/orgs/{slug}/work-items/{wid}/attachments/{a["id"]}',
                           headers=HEADERS)
        self.assertEqual(first.content, b'first', 'the first upload survives the second')

    def test_detach_removes_record_and_bytes(self):
        slug = 'workattach-detach'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        rec = self._attach(client, slug, wid, 'gone.txt', b'bytes').json()['attachment']
        stored = data / 'work-attachments' / slug / wid / 'gone.txt'
        self.assertTrue(stored.is_file(), 'control: the bytes were stored')
        r = client.delete(f'/api/orgs/{slug}/work-items/{wid}/attachments/{rec["id"]}',
                          headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        got = client.get(f'/api/orgs/{slug}/work-items/{wid}', headers=HEADERS)
        self.assertEqual(got.json()['item']['attachments'], [])
        self.assertFalse(stored.exists(), 'the stored bytes were deleted with the record')
        after = client.get(f'/api/orgs/{slug}/work-items/{wid}/attachments/{rec["id"]}',
                           headers=HEADERS)
        self.assertEqual(after.status_code, 404)

    def test_empty_upload_and_unknown_id_are_refused(self):
        slug = 'workattach-refuse'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        r = self._attach(client, slug, wid, 'empty.txt', b'')
        self.assertEqual(r.status_code, 422)
        r = client.get(f'/api/orgs/{slug}/work-items/{wid}/attachments/a999',
                       headers=HEADERS)
        self.assertEqual(r.status_code, 404)
        r = client.delete(f'/api/orgs/{slug}/work-items/{wid}/attachments/a999',
                          headers=HEADERS)
        self.assertEqual(r.status_code, 404)

    def test_cap_refuses_the_21st_after_20_succeed(self):
        slug = 'workattach-cap'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        for i in range(ledger.Org.WORK_ATTACHMENTS_MAX):
            r = self._attach(client, slug, wid, f'f{i}.txt', b'x')
            self.assertEqual(r.status_code, 200,
                             f'upload {i} must succeed before the cap: {r.text}')
        over = self._attach(client, slug, wid, 'over.txt', b'x')
        self.assertEqual(over.status_code, 422, over.text)
        self.assertIn('cap', over.json()['detail'])
        # the refused upload's bytes must not linger unlisted on disk
        self.assertFalse((data / 'work-attachments' / slug / wid / 'over.txt').exists())

    def test_item_delete_sweeps_its_attachment_dir(self):
        slug = 'workattach-sweep'
        wid = self._org_with_item(slug)
        client = TestClient(app)
        self._attach(client, slug, wid, 'doomed.txt', b'x')
        adir = data / 'work-attachments' / slug / wid
        self.assertTrue(adir.is_dir(), 'control: the dir exists before delete')
        r = client.delete(f'/api/orgs/{slug}/work-items/{wid}', headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(adir.exists(), 'a deleted item leaves no orphan bytes')


if __name__ == '__main__':
    unittest.main()
