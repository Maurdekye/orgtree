"""The restart notice keeps the whole mail archive and never loads it; archive
deletes keep the derived Sent keys and bounds exact."""
import json
import unittest
from unittest.mock import patch

import test_mail_archive_bounds_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import orgtx, restart_wake, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class RestartArchiveTrim(unittest.TestCase):
    setUpClass = classmethod(fixture.MailArchiveBounds.setUpClass.__func__)
    setUp = fixture.MailArchiveBounds.setUp
    query = fixture.MailArchiveBounds.query

    def install_counter(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('CREATE TABLE trim_updates(seq bigint)')
            conn.execute("CREATE FUNCTION count_trim_updates() RETURNS trigger LANGUAGE plpgsql AS $$ "
                         "BEGIN IF NEW.owner_pos IS DISTINCT FROM OLD.owner_pos THEN "
                         "INSERT INTO trim_updates VALUES(NEW.seq); END IF; RETURN NULL; END $$")
            conn.execute('CREATE TRIGGER count_trim_updates AFTER UPDATE ON mail_sent '
                         'FOR EACH ROW EXECUTE FUNCTION count_trim_updates()')
            conn.execute('COMMIT')

    def test_restart_deposit_keeps_every_archive_row_and_repairs_no_owner(self):
        # 2026-09-29: the notice no longer trims the archive to 100 rows (user
        # ruling 2026-09-07: mail is kept until manual removal), and it appends
        # without loading the agent's archive (engine-startup-cost-must-not-
        # grow-with-retired-h: 1.5 GB at N1000 with 10x history)
        self.install_counter()
        loaded = []
        real = store.SectionMap._load_owner

        def spy(sec, owner):
            loaded.append((sec._sect, owner))
            return real(sec, owner)
        for extra in (130, 300):
            with self.subTest(extra=extra):
                with store._POOL.acquire(self.slug) as conn:
                    conn.execute('BEGIN')
                    conn.execute("INSERT INTO log_d(sect,owner,val) SELECT 'mail_log','worker',? "
                                 'FROM generate_series(1,?)',
                                 (json.dumps({'from': 'sender', 'at': 'same', 'body': 'retained'}), extra))
                    conn.execute('TRUNCATE trim_updates')
                    conn.execute('COMMIT')
                old = self.query("SELECT seq,val FROM log_d WHERE sect='mail_log' AND owner='worker' ORDER BY seq")
                with patch.object(store.SectionMap, '_load_owner', spy):
                    with orgtx.org_tx(self.slug, **restart_wake._notice_rows(['worker'])) as tx:
                        row = dict(tx.org.deposit_mail('worker', {'id': 'restart-'+str(extra), 'from': 'orgtree',
                            'kind': 'notice', 'body': 'restart'},
                            supersede=lambda m: m.get('kind') == 'notice'))
                self.assertNotIn(('mail_log', 'worker'), loaded, 'the archive was loaded')
                after = self.query("SELECT seq,val FROM log_d WHERE sect='mail_log' AND owner='worker' ORDER BY seq")
                self.assertEqual(after[:-1], old)
                self.assertEqual(json.loads(after[-1][1]), row)
                self.assertGreater(row['recv_seq'], 9)
                self.assertEqual(self.query('SELECT count(*) FROM trim_updates')[0][0], 0)
                self.assertEqual(self.query('SELECT seq,owner_pos FROM mail_sent ORDER BY seq'),
                                 [(seq, after[0][0]) for seq, _ in after])
                self.assertEqual(self.query("SELECT nrows,assigned_max,unknown_rows FROM mail_archive_bounds "
                                            "WHERE owner='worker'")[0], (len(after), row['recv_seq'], 0))
                pending = store.load_org(self.slug).d['mail']['worker']
                self.assertEqual([m['id'] for m in pending], [row['id']])

    def test_stale_prefix_conflict_rolls_back_prior_deletes_and_indexes(self):
        old = self.query("SELECT seq,val FROM log_d WHERE sect='mail_log' AND owner='worker' ORDER BY seq")
        log = store.AppendLog((json.loads(raw) for _, raw in old), rows=old)
        del log[:-2]
        newer = json.dumps({'id': 'changed-concurrently', 'recv_seq': 50})
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('UPDATE log_d SET val=? WHERE seq=?', (newer, old[0][0]))
            conn.execute('COMMIT')
        before = self.query('SELECT seq,val FROM log_d ORDER BY seq')
        projection = self.query('SELECT * FROM mail_sent ORDER BY seq')
        bounds = self.query('SELECT * FROM mail_archive_bounds')
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            try:
                with self.assertRaises(store.StaleWrite):
                    store._write_log_rows(conn, 'log_d', 'sect=? AND owner=?', ('mail_log','worker'),
                        'INSERT INTO log_d(sect,owner,at,val) VALUES(?,?,?,?)', ('mail_log','worker'),
                        log, old, incremental=log)
            finally:
                conn.execute('ROLLBACK')
        self.assertEqual(self.query('SELECT seq,val FROM log_d ORDER BY seq'), before)
        self.assertEqual(self.query('SELECT * FROM mail_sent ORDER BY seq'), projection)
        self.assertEqual(self.query('SELECT * FROM mail_archive_bounds'), bounds)

    def test_complete_archive_delete_preserves_other_owner(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("INSERT INTO log_d(sect,owner,val) VALUES('mail_log','other',?)", ('{"id":"other"}',))
            conn.execute('COMMIT')
        other = self.query("SELECT seq,val FROM log_d WHERE owner='other'")
        with orgtx.org_tx(self.slug, **restart_wake._notice_rows(['worker'])) as tx:
            tx.d['mail_log']['worker'].clear()
        self.assertEqual(self.query("SELECT seq,val FROM log_d WHERE owner='other'"), other)
        self.assertEqual(self.query("SELECT count(*) FROM mail_sent WHERE owner='worker'")[0][0], 0)
        self.assertEqual(self.query("SELECT nrows,assigned_max FROM mail_archive_bounds WHERE owner='worker'")[0], (0,0))


if __name__ == '__main__':
    unittest.main()
