"""Org registry readers with no marker files, on disposable PostgreSQL.

Reuse the compatibility suite's isolated legacy/app/org databases and lifecycle.
These tests exercise the reader doors, not a mocked registry. Both disposable
role URLs are required; absent URLs mean skipped, never passed.
"""
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

os.environ['ORGTREE_V2_TOKEN'] = 'operator'
import test_orgdb_compat_pg as fixture  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import (account_removal, api, desktop_notifications, halt,
                     reply_events, settingstx, store, transcript_records)  # noqa: E402
from orgtree.ledger import USER  # noqa: E402
from orgtree.orgdb import registry  # noqa: E402

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class RegistryReaders(unittest.TestCase):
    def setUp(self):
        self.storage = fixture.storage(True)
        self.storage.__enter__()
        self.addCleanup(self.storage.__exit__, None, None, None)
        desktop_notifications._cache.clear()

    def org(self, slug):
        org = store.create_org(slug)
        org.d['nodes']['dev'] = fixture.node('dev', None)
        store.save_org(org)
        self.assertFalse(Path(store.org_path(slug)).exists())
        self.assertTrue(registry.exists(slug))
        return store.load_org(slug)

    def state(self, slug, state):
        # Only the fixture's app database, through its disposable admin role.
        with fixture.dbconn.connect(fixture.ADMIN, fixture.names.app()) as conn:
            conn.execute(
                "UPDATE orgtree.orgs SET state=%s, unavailable_step=%s, "
                "trashed_at=CASE WHEN %s='trashed' THEN now() ELSE NULL END "
                "WHERE slug=%s",
                (state, 'migration' if state == 'unavailable' else None, state, slug))

    def test_json_file_readers_remain_unchanged_with_switch_off(self):
        # _org_stored is a row-store helper: a direct swap would silently
        # break JSON, where .json exists but the .db path does not.
        with fixture.storage(False), patch.object(store, 'STORE_BACKEND', 'json'):
            slug = 'reader-json-control'
            org = store.create_org(slug)
            org.d['nodes']['dev'] = fixture.node('dev', None)
            org.node('dev')['frozen'] = {'at': '2026-10-03T02:00:00Z', 'limit': True}
            store.save_org(org)
            self.assertTrue(Path(store.org_path(slug)).exists())
            self.assertFalse(Path(store._db_path(slug)).exists())
            with patch.object(store, '_org_stored', side_effect=AssertionError('row-store check')):
                identity = reply_events.incarnation(store.load_org(slug), 'dev')
                self.assertEqual(reply_events.incarnation(store.load_org(slug), 'dev'), identity)
                transcript = transcript_records.incarnation(store.load_org(slug), 'dev')
                self.assertEqual(store.load_org(slug).node('dev')['transcript_incarnation'], transcript)
                with patch.object(store, 'cached_org', side_effect=AssertionError('unnecessary load')):
                    self.assertFalse(halt._no_org(slug))
                made = api._work_route_tx(slug, lambda doc: doc.work_create(
                    USER, 'JSON control', 'The original JSON path still works.', owner='dev'))
                uploaded = TestClient(api.app).post(
                    f"/api/orgs/{slug}/work-items/{made['slug']}/attachments?name=json.txt",
                    content=b'JSON bytes', headers=HEADERS)
                self.assertEqual(uploaded.status_code, 200, uploaded.text)
                self.assertIn(slug, account_removal.org_slugs())
                rows = [r for r in desktop_notifications.notices()['notices'] if r['org'] == slug]
                self.assertEqual([(r['kind'], r['agent']) for r in rows], [('agent-frozen', 'dev')])
                self.assertFalse(settingstx._plan_stamp_heal_completed(slug))

    def test_reply_identity_survives_independent_loads_without_a_file(self):
        org = self.org('reader-reply')
        first = reply_events.incarnation(org, 'dev')
        loaded = store.load_org('reader-reply')
        self.assertEqual(loaded.d.get('reply_incarnation'), first.split(':')[0])
        self.assertEqual(reply_events.incarnation(loaded, 'dev'), first)

    def test_transcript_identity_is_persisted_without_a_file(self):
        org = self.org('reader-transcript')
        # Pre-seed reply identity: this test independently catches the
        # transcript file check even when reply_events is still unfixed.
        org.d['reply_incarnation'] = 'org-reply'
        org.node('dev')['reply_incarnation'] = 'agent-reply'
        store.save_org(org)
        value = transcript_records.incarnation(store.load_org('reader-transcript'), 'dev')
        loaded = store.load_org('reader-transcript')
        self.assertEqual(loaded.node('dev').get('transcript_incarnation'), value)
        self.assertEqual(transcript_records.incarnation(loaded, 'dev'), value)

    def test_work_route_writes_an_item_without_a_file(self):
        self.org('reader-work')
        made = api._work_route_tx('reader-work', lambda org: org.work_create(
            USER, 'Registry item', 'A real item through the route transaction.', owner='dev'))
        loaded, _ = store.load_org('reader-work')._work_find(made['slug'])
        self.assertEqual(loaded['title'], 'Registry item')

    def test_attachment_upload_download_and_record_without_a_file(self):
        org = self.org('reader-attachment')
        made = org.work_create(USER, 'Attachment item', 'The file belongs to this item.', owner='dev')
        store.save_org(org)
        client = TestClient(api.app)
        url = f"/api/orgs/reader-attachment/work-items/{made['slug']}/attachments"
        uploaded = client.post(url + '?name=sample.txt', content=b'registry bytes',
                               headers={**HEADERS, 'Content-Type': 'text/plain'})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        rec = uploaded.json()['attachment']
        downloaded = client.get(url + '/' + rec['id'], headers=HEADERS)
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, b'registry bytes')
        self.assertEqual(store.load_org('reader-attachment')._work_find(made['slug'])[0]
                         ['attachments'][0]['id'], rec['id'])

    def test_unavailable_work_route_and_upload_refuse_even_with_stale_file(self):
        self.org('reader-unavailable-work')
        self.state('reader-unavailable-work', 'unavailable')
        marker = Path(store.org_path('reader-unavailable-work'))
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        with patch.object(api.worktx, 'run', side_effect=AssertionError('must not write')):
            with self.assertRaises(api.HTTPException) as raised:
                api._work_route_tx('reader-unavailable-work', lambda org: None, sweep=False)
        self.assertEqual(raised.exception.status_code, 404)
        uploaded = TestClient(api.app).post(
            '/api/orgs/reader-unavailable-work/work-items/missing/attachments?name=x.txt',
            content=b'no write', headers=HEADERS)
        self.assertEqual(uploaded.status_code, 404, uploaded.text)
        self.assertFalse(Path(store.DATA_ROOT, 'work-attachments', 'reader-unavailable-work').exists())

    def test_halt_existence_uses_registry_without_loading_org(self):
        self.org('reader-halt')
        with patch.object(store, 'cached_org', side_effect=AssertionError('unnecessary load')):
            self.assertFalse(halt._no_org('reader-halt'))
            self.assertTrue(halt._no_org('reader-halt-missing'))

    def test_halt_treats_unavailable_as_absent_despite_stale_file(self):
        self.org('reader-unavailable-halt')
        self.state('reader-unavailable-halt', 'unavailable')
        marker = Path(store.org_path('reader-unavailable-halt'))
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        self.assertTrue(halt._no_org('reader-unavailable-halt'))

    def test_removal_keeps_unavailable_org_and_refuses_unknown_bindings(self):
        self.org('reader-removal-active')
        self.org('reader-removal-unavailable')
        self.org('reader-removal-trash')
        self.state('reader-removal-unavailable', 'unavailable')
        self.state('reader-removal-trash', 'trashed')
        slugs = account_removal.org_slugs()
        self.assertIn('reader-removal-active', slugs)
        self.assertIn('reader-removal-unavailable', slugs)
        self.assertNotIn('reader-removal-trash', slugs)
        row = {'id': 'reader-unused-secondary', 'provider': 'claude'}
        with patch.object(account_removal.registry, 'get_account', return_value=row), \
                patch.object(account_removal, 'is_primary_row', return_value=False):
            plan = account_removal.plan_removal(row['id'])
        self.assertTrue(any('reader-removal-unavailable' in x and 'could not be read' in x
                            for x in plan['blockers']), plan['blockers'])

    def test_notifications_load_active_org_without_using_legacy_raw_queries(self):
        org = self.org('reader-notifications')
        org.node('dev')['frozen'] = {'at': '2026-10-03T02:00:00Z', 'limit': True}
        store.save_org(org)
        with patch.object(desktop_notifications, '_CACHE_ON', True), \
                patch.object(desktop_notifications, '_RUNTIME_VIEWS', True), \
                patch.object(fixture.pgstore.PgConn, 'execute', side_effect=AssertionError('legacy SQL')):
            rows = [r for r in desktop_notifications.notices()['notices']
                    if r['org'] == 'reader-notifications']
        self.assertEqual([(r['kind'], r['agent']) for r in rows], [('agent-frozen', 'dev')])

    def test_stamp_heal_avoids_legacy_sql_even_with_stale_marker(self):
        self.org('reader-heal')
        marker = Path(store.org_path('reader-heal'))
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        with patch.object(store, '_bounded_read', side_effect=AssertionError('legacy SQL')):
            settingstx.heal_plan_stamps('reader-heal')
        self.assertIn('pm_plan_stamp_heal', store.load_org('reader-heal').d['_migrations'])


if __name__ == '__main__':
    unittest.main()
