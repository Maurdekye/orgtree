"""Migration of populated alpha current pointers on a disposable cluster only."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree.orgdb import conn, migrate

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')
DB = f't{os.getpid()}_migration_pointers'


@unittest.skipUnless(ADMIN, 'requires disposable ORGTREE_TEST_PG_ADMIN_URL')
class MigrationPointers(unittest.TestCase):
    def test_populated_current_pointers_survive_schema_upgrade(self):
        from psycopg import sql
        with conn.connect(ADMIN, 'postgres') as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
        try:
            with conn.connect(ADMIN, DB) as c, tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                for p in migrate.files(migrate.ORG_DIR):
                    if p.name <= '0015_turn_requests.sql':
                        shutil.copyfile(p, folder / p.name)
                migrate.migrate(c, folder, migrate.ORG_LOCK)
                with c.transaction():
                    item = c.execute("INSERT INTO orgtree.work_items(list_key,ord,slug,docket_manual,docket_order) "
                                     "VALUES ('active',0,'upgrade-fixture',false,'') RETURNING id").fetchone()[0]
                    verdict = c.execute("INSERT INTO orgtree.work_item_events "
                        "(item_id,seq,source,kind,status_change) "
                        "VALUES (%s,1,'candidate_verdicts','verdict',false) RETURNING id", (item,)).fetchone()[0]
                    review = c.execute("INSERT INTO orgtree.work_item_events "
                        "(item_id,seq,source,kind,status_change) "
                        "VALUES (%s,2,'review_packets','review_packet',false) RETURNING id", (item,)).fetchone()[0]
                    c.execute("UPDATE orgtree.work_items SET current_verdict_event_id=%s, "
                        "current_verdict_event_id_is='v',current_review_packet_event_id=%s, "
                        "current_review_packet_event_id_is='v' WHERE id=%s", (verdict, review, item))
                # Negative control: the unpatched execution order must fail on
                # this fixture, and its whole migration must roll back.
                class LegacyOrder:
                    def __getattr__(self, name):
                        return getattr(c, name)

                    def execute(self, query, *args, **kwargs):
                        if query.startswith('SET CONSTRAINTS orgtree.current_verdict_event_id_fk'):
                            return c.execute('SELECT 1')
                        return c.execute(query, *args, **kwargs)

                before = c.execute('SELECT to_json(t)::text FROM orgtree.work_items t').fetchall()
                from psycopg.errors import ObjectInUse
                with self.assertRaises(ObjectInUse):
                    migrate.migrate(LegacyOrder(), migrate.ORG_DIR, migrate.ORG_LOCK)
                self.assertEqual(c.execute('SELECT to_json(t)::text FROM orgtree.work_items t').fetchall(), before)
                self.assertNotIn('0016_schema_conformance.sql', migrate.applied(c))
                report = migrate.migrate(c, migrate.ORG_DIR, migrate.ORG_LOCK)
                self.assertEqual(report['applied'], ['0016_schema_conformance.sql', '0017_agent_graph.sql'])
                self.assertEqual(c.execute("SELECT current_verdict_event_id,current_review_packet_event_id "
                                           "FROM orgtree.work_items WHERE id=%s", (item,)).fetchone(),
                                 (verdict, review))
                self.assertEqual(c.execute('SELECT count(*) FROM orgtree.work_item_events').fetchone()[0], 2)
                constraints = c.execute("SELECT condeferrable,condeferred FROM pg_constraint "
                    "WHERE conname IN ('current_verdict_event_id_fk','current_review_packet_event_id_fk')").fetchall()
                self.assertEqual(constraints, [(True, True), (True, True)])
                with c.transaction():
                    # After migration, a temporary invalid link is deferred as
                    # before, and repairing it before commit succeeds.
                    c.execute('UPDATE orgtree.work_items SET current_verdict_event_id=-1 WHERE id=%s', (item,))
                    c.execute('UPDATE orgtree.work_items SET current_verdict_event_id=%s WHERE id=%s', (verdict,item))
                self.assertEqual(migrate.migrate(c, migrate.ORG_DIR, migrate.ORG_LOCK)['applied'], [])
        finally:
            with conn.connect(ADMIN, 'postgres') as admin:
                admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(DB)))


if __name__ == '__main__':
    unittest.main()
