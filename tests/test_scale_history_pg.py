"""Small actual-PG history restore, ordinal and indexed-state controls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_pgstore as fixture
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "scale"))
import history_fixture as hf
import history_pg as hp
from orgtree import foreground_store, ledger, pgstore, store, workread


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, "disposable PG required: NOT RUN")
class HistoryStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def test_restore_and_independent_source_validation_with_analyzed_indexes(self):
        root = fixture.data.parent
        slug = "history-storage"
        # The one intended run-root is fixed before source creation. Paired
        # engines restore into it sequentially, never rewrite active path text.
        base = ledger.Org.create("History storage", dirs=[], workspace=str(root / "data/workspaces" / slug))
        base.hire(ledger.USER, None, "haiku", 0, "boss")
        base.d["mail_log"] = {"boss": [dict(id="recent", at="2026-09-27", body="read tail", read=True)]}
        base.d["mail"] = {"boss": [dict(id="unread", body="fixed pending") ]}
        base.work_create("boss", title="Active work", objective="Keep this body unchanged", owner="boss")
        frozen = hf.prepare_base(base.d)
        recipe = hf.Recipe(retired_agents=2, archived_items=2, read_mail=2, old_transcripts=2,
                           node_chars=128, item_chars=128, mail_chars=128, transcript_chars=128)
        with tempfile.TemporaryDirectory(prefix="history-pg-bundle-") as folder:
            bundle = Path(folder) / "pair"
            hf.build_pair(frozen, bundle, recipe)
            # fixture.py already owns this temporary data/home tree and DB.
            (root / "history-destination.json").write_text(json.dumps(dict(
                format=hf.FORMAT, root=str(root.resolve()), slug=slug,
                database_sha256=hashlib.sha256(pgstore.url().encode()).hexdigest())))
            receipt = hp.restore(bundle, "large", root)
            self.assertTrue(hp.verify_restored(bundle, "large", root)["verified"])
            self.assertEqual(receipt["statistics"]["statistics_state"], "analyzed_after_seed")
            self.assertEqual(receipt["cold_statistics"]["statistics_state"], "fresh_unanalyzed")
            self.assertTrue(receipt["statistics"]["tables"])
            self.assertTrue(all(x[1] >= 0 for x in receipt["statistics"]["estimates"]))
            self.assertEqual(set(foreground_store.read_foreground(slug)["rows"]), {"boss"})
            loaded = store.load_org(slug)
            self.assertEqual(loaded.nodes["boss"], frozen["nodes"]["boss"])
            self.assertEqual(loaded.d["mail"]["boss"], frozen["mail"]["boss"])
            self.assertEqual(loaded.d["mail_log"]["boss"][-1]["id"], "recent")
            self.assertEqual(loaded.mail_seq_state("boss")["base"], hf.MAIL_FLOOR)
            with store._POOL.acquire(slug) as conn:
                conn.use()
                oid = conn.raw.execute("SELECT org_id FROM public.orgs WHERE slug=%s", (slug,)).fetchone()[0]
                self.assertTrue(workread.reconcile(conn.raw, oid))
                self.assertEqual(workread.counts_raw(conn.raw, oid, viewer=ledger.USER, now_ts=1800000000)["active"], 1)
                value = json.loads(conn.raw.execute("SELECT val FROM nodes WHERE id='boss'").fetchone()[0])
                value["charter"] = "intentional corruption"
                conn.raw.execute("UPDATE nodes SET val=%s WHERE id='boss'", (store._dumps(value),))
                conn.raw.commit()
            with self.assertRaisesRegex(ValueError, "fixed records changed"):
                hp.verify_restored(bundle, "large", root)


if __name__ == "__main__":
    unittest.main()
