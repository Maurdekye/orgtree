"""Inbox tails remain bounded and coherent while another writer commits."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix="orgtree-inbox-projection-")
os.environ["ORGTREE_DATA"] = root.name
os.environ["ORGTREE_STORE"] = "sqlite"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import store
assert Path(store.DATA_ROOT).resolve() == Path(root.name).resolve()

class InboxProjectionTests(unittest.TestCase):
    def setUp(self):
        self.slug = "inbox-" + self._testMethodName.replace("_", "-")
        org = store.create_org(self.slug)
        org.d["user_inbox"] = [{"id": "pending", "body": "pending"}]
        org.d["user_mail_log"] = [{"id": str(i), "body": "mail-" + str(i)} for i in range(1000)]
        org.d["user_outbox"] = [{"id": str(i), "body": "sent-" + str(i)} for i in range(1000)]
        org.d["notices"] = {"idle": ["unused" * 100000]}
        store.save_org(org)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def test_only_requested_tail_rows_are_decoded(self):
        real = json.loads
        with patch.object(store.json, "loads", wraps=real) as decode:
            data = store.read_user_inbox(self.slug)
        self.assertEqual(decode.call_count, 101)
        self.assertEqual([r["id"] for r in data["delivered"]], [str(i) for i in range(950,1000)])
        self.assertEqual([r["body"] for r in data["sent"]], ["sent-"+str(i) for i in range(950,1000)])
        self.assertEqual(data["pending"], [{"id":"pending","body":"pending"}])
        with patch.object(store.json, "loads", wraps=real) as control:
            store.load_org_snapshot(self.slug, ("user_mail_log","user_outbox"))
        self.assertGreater(control.call_count, 2000, "positive control sees full-history parsing")

    def test_pending_and_tails_share_snapshot_during_a_commit(self):
        real = json.loads
        written = False
        def decode(raw, *args, **kwargs):
            nonlocal written
            if not written:
                written = True
                with closing(sqlite3.connect(store._db_path(self.slug))) as writer, writer:
                    writer.execute("UPDATE doc SET val=? WHERE key='user_inbox'", (json.dumps([{"id":"new"}]),))
                    for sect in ("user_mail_log","user_outbox"):
                        writer.execute("INSERT INTO log_l(sect,at,val) VALUES (?,?,?)", (sect,"",json.dumps({"id":"new"})))
            return real(raw,*args,**kwargs)
        with patch.object(store.json,"loads",side_effect=decode):
            old = store.read_user_inbox(self.slug)
        self.assertTrue(written)
        self.assertEqual(old["pending"][0]["id"],"pending")
        self.assertEqual(old["delivered"][-1]["id"],"999")
        self.assertEqual(old["sent"][-1]["id"],"999")
        fresh = store.read_user_inbox(self.slug)
        self.assertEqual([fresh[k][-1]["id"] for k in ("pending","delivered","sent")],["new"]*3)

    def test_json_rollback_and_blobbed_history_match(self):
        expected = store.read_user_inbox(self.slug)
        org = store.load_org(self.slug)
        with patch.object(store,"STORE_BACKEND","json"), patch.object(store,"load_org",return_value=org):
            self.assertEqual(store.read_user_inbox(self.slug),expected)
        with closing(sqlite3.connect(store._db_path(self.slug))) as conn, conn:
            conn.execute("INSERT OR REPLACE INTO doc(key,val) VALUES (?,?)",("user_mail_log",json.dumps(list(org.d["user_mail_log"]))))
        self.assertEqual(store.read_user_inbox(self.slug),expected)

    def test_gallery_reads_metadata_and_keeps_legacy_eviction_order(self):
        org = store.load_org(self.slug)
        org.hire('@user', None, 'haiku', 0, 'presenter')
        org.d['documents'] = [{'id':f'doc-{i}', 'node':'presenter', 'title':str(i),
                               'body':'unrelated body '*10000, 'format':'html' if i==9 else 'markdown',
                               'bytes':42, 'at':'2026-09-10T19:00:00.000Z'} for i in range(10)]
        org.d['events'] = [{'op':'message','at':'2026-09-10T19:00:00.000Z','detail':{'body':'unused'*100}} for _ in range(1000)]
        org.d['events'][900] = {'op':'present_evicted','actor':'deleted-presenter','at':'2026-09-10T19:00:00.000Z',
                                'detail':{'id':'evicted','title':'old'}}
        store.save_org(org)
        expected = store.load_org(self.slug).document_gallery()
        real = json.loads
        with patch.object(store.json,'loads',wraps=real) as decode:
            actual = store.read_document_gallery(self.slug)
        self.assertEqual(actual,expected)
        self.assertEqual(actual[0]['id'],'evicted','original event ordinal wins equal timestamp tie')
        self.assertEqual(actual[0]['node_state'],'deleted')
        self.assertEqual(actual[1]['bytes'],42)
        self.assertEqual(actual[1]['tier'],'haiku')
        self.assertEqual(decode.call_count,11,'only ten metadata rows and one eviction are decoded')
        self.assertFalse(any('body' in row for row in actual))
        with patch.object(store.json,'loads',wraps=real) as control:
            store.load_org(self.slug).document_gallery()
        self.assertGreater(control.call_count,1000)
        with patch.object(store,'STORE_BACKEND','json'),patch.object(store,'load_org',return_value=org):
            self.assertEqual(store.read_document_gallery(self.slug),expected)
        with closing(sqlite3.connect(store._db_path(self.slug))) as conn, conn:
            for section in ('documents','events','nodes'):
                conn.execute('INSERT OR REPLACE INTO doc(key,val) VALUES (?,?)',(section,json.dumps(org.d[section])))
        self.assertEqual(store.read_document_gallery(self.slug),expected,'legacy blob sections preserve the same metadata')

    def test_missing_or_damaged_database_never_appears_empty(self):
        with self.assertRaises(store.LedgerError): store.read_user_inbox("missing-inbox-fixture")
        with self.assertRaises(store.LedgerError): store.read_document_gallery("missing-gallery-fixture")
        with closing(sqlite3.connect(store._db_path(self.slug))) as conn, conn:
            conn.execute("DELETE FROM meta WHERE key='schema_version'")
        with self.assertRaisesRegex(store.LedgerError,"not an intact"):
            store.read_user_inbox(self.slug)
        with self.assertRaisesRegex(store.LedgerError,"not an intact"):
            store.read_document_gallery(self.slug)

if __name__ == "__main__": unittest.main()
