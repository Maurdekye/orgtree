"""Committed PG docket validators with stale resident/feed state excluded."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import json
import os
import unittest
from unittest.mock import patch

NATIVE = os.environ.get('ORGTREE_STORAGE') == 'orgdb'
if NATIVE:
    import test_orgdb_compat_pg as f
else:
    import test_pgstore as f
from orgtree import ledger, pgstore, store, work_ui, workrows


def setUpModule():
    if NATIVE:
        f.setUpModule()
        os.environ['ORGTREE_STORAGE'] = 'orgdb'


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, "disposable PG not configured: NOT RUN")
class CommittedWorkUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org("ui-" + self._testMethodName)
        self.slug = org.d["slug"]
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.work_create("boss", "Original title", objective="Searchable description", owner="boss")
        store.save_org(org)
        self.item = org.d["work_items"][0]["slug"]
        self.before, _ = work_ui.read(self.slug)

    def test_unrelated_committed_status_uses_revision_without_full_org_read(self):
        org = store.load_org(self.slug)
        org.nodes["boss"]["last_status"] = {"summary": "irrelevant"}
        store.save_org(org)
        with patch.object(store, "load_org", side_effect=AssertionError("loaded entire org")):
            revision, body = work_ui.read(self.slug, since=self.before)
        self.assertEqual(revision, self.before)
        self.assertIsNone(body)

    def test_external_connection_commit_invalidates_without_feed_notification(self):
        import psycopg
        old = store.load_org(self.slug)
        row = dict(old.d["work_items"][0], title="External commit", rev=2)
        if NATIVE:
            from orgtree.orgdb import registry
            with registry.connection(self.slug) as conn:
                conn.execute('UPDATE orgtree.work_items SET title=%s,rev=%s WHERE slug=%s',
                             (row['title'], row['rev'], self.item))
        else:
            self.external_legacy_commit(row)
        revision, body = work_ui.read(self.slug, since=self.before)
        self.assertNotEqual(revision, self.before)
        self.assertEqual(body["delta"]["items"]["upsert"][0]["title"], "External commit")
        self.assertEqual(old.d["work_items"][0]["title"], "Original title")

    def external_legacy_commit(self, row):
        import psycopg
        with psycopg.connect(os.environ["ORGTREE_PG_URL"], autocommit=True) as conn:
            oid = conn.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (self.slug,)).fetchone()[0]
            with conn.transaction():
                conn.execute(f"UPDATE org_{int(oid)}.doc SET val=%s WHERE key=%s",
                             (json.dumps(row), workrows.PREFIX + self.item))
                conn.execute("UPDATE public.orgs SET revision=revision+1,work_revision=revision+1 WHERE org_id=%s", (oid,))

    def work_revision(self):
        if NATIVE:
            from orgtree.orgdb import registry
            with registry.connection(self.slug) as raw:
                return raw.execute('SELECT docket_rev FROM orgtree.org_revision').fetchone()[0]
        return store.read_work_items_rows(self.slug, [])["work_revision"]

    def test_question_and_owner_state_invalidate_independently_of_work_revision(self):
        # An external node change does not increment the work counter.
        org = store.load_org(self.slug)
        before = self.work_revision()
        org.nodes["boss"]["state"] = "archived"
        store.save_org(org)
        self.assertEqual(self.work_revision(), before)
        revision, body = work_ui.read(self.slug, since=self.before)
        self.assertEqual(body["delta"]["items"]["upsert"][0]["owner_state"], "retired")
        # Direct committed ask mimics another process while no live feed runs.
        with store._POOL.acquire(self.slug) as conn:
            conn.execute("INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val", ('asks', json.dumps([{
                "id": "q", "node": "boss", "status": "open", "kind": "question", "rev": 1,
                "questions": [{"question": "Decision?", "work_item": self.item}]}]),))
        self.assertEqual(store.read_doc_sections(self.slug, ["asks"])["asks"][0]["id"], "q")
        _, asked = work_ui.read(self.slug, since=revision)
        self.assertTrue(asked["delta"]["items"]["upsert"][0]["questions"])


if __name__ == "__main__":
    unittest.main()
