"""PostgreSQL Sent projection ordering, source preservation and bounded plans."""
import json
import unittest
from unittest.mock import patch

import test_mail_archive_bounds_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class MailSentIndex(unittest.TestCase):
    setUpClass = classmethod(fixture.MailArchiveBounds.setUpClass.__func__)
    setUp = fixture.MailArchiveBounds.setUp
    query = fixture.MailArchiveBounds.query

    def insert(self, owner, sender, at, seq=None):
        raw = json.dumps({'from': sender, 'at': at, 'body': f'{owner}/{at}/{seq}'})
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            if seq is None:
                conn.execute("INSERT INTO log_d(sect,owner,val) VALUES('mail_log',?,?)", (owner, raw))
            else:
                conn.execute("INSERT INTO log_d(seq,sect,owner,val) VALUES(?,'mail_log',?,?)", (seq, owner, raw))
            conn.execute('COMMIT')

    def assert_projection(self):
        want = self.query("SELECT seq,owner,json_extract(val,'$.from'),coalesce(json_extract(val,'$.at'),''),"
                          "min(seq) OVER(PARTITION BY owner) FROM log_d WHERE sect='mail_log' ORDER BY seq")
        self.assertEqual(self.query('SELECT seq,owner,sender,sent_at,owner_pos FROM mail_sent ORDER BY seq'), want)

    def test_equal_time_owner_order_and_user_merge_match_existing_query(self):
        for owner in ('earlier', 'later'):
            for _ in range(7): self.insert(owner, 'sender', 'same')
        for _ in range(3): self.insert('earlier', 'sender', 'same')
        self.insert('later', 'other', 'zzzz')
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("INSERT INTO log_l(sect,val) VALUES('user_mail_log',?)",
                         (json.dumps({'from': 'sender', 'at': 'same', 'body': 'user'}),))
            conn.execute('COMMIT')
        want = [dict(json.loads(raw), to=owner) for owner,raw in self.query(
            "SELECT l.owner,l.val FROM log_d l JOIN (SELECT owner,min(seq) pos FROM log_d "
            "WHERE sect='mail_log' GROUP BY owner) o ON o.owner=l.owner "
            "WHERE l.sect='mail_log' AND json_extract(l.val,'$.from')='sender' "
            "ORDER BY coalesce(json_extract(l.val,'$.at'),''),o.pos,l.seq")]
        want.append({'from': 'sender', 'at': 'same', 'body': 'user', 'to': '@user'})
        want.sort(key=lambda row: row.get('at') or '')
        self.assertEqual(store.read_mail_tails(self.slug, 'sender', keep=5, slack=0)[3], want[-5:])
        self.assert_projection()

    def test_first_row_delete_move_and_earlier_restore_repair_only_owner_order(self):
        self.insert('other', 'sender', 'same')
        self.insert('other', 'sender', 'same')
        self.insert('other', 'sender', 'same', seq=-10)
        self.assert_projection()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("UPDATE log_d SET owner='worker' WHERE seq=-10")
            conn.execute('COMMIT')
        self.assert_projection()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('DELETE FROM log_d WHERE seq=-10')
            conn.execute('COMMIT')
        self.assert_projection()

    def test_rebuild_and_rollback_preserve_source_and_projection(self):
        before = self.query('SELECT seq,owner,val FROM log_d ORDER BY seq')
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            for _ in range(2): conn.execute('SELECT public.orgtree_install_mail_sent(?)', (conn.org_id,))
            conn.execute('COMMIT')
            conn.execute('BEGIN')
            conn.execute('TRUNCATE log_d')
            self.assertEqual(conn.execute('SELECT count(*) FROM mail_sent').fetchone()[0], 0)
            conn.execute('ROLLBACK')
        self.assertEqual(self.query('SELECT seq,owner,val FROM log_d ORDER BY seq'), before)
        self.assert_projection()

    def test_sender_index_bounds_equal_timestamp_history(self):
        self.check_bounded_plan(1000)

    def test_sender_index_bounds_tenfold_equal_timestamp_history(self):
        self.check_bounded_plan(10000)

    def check_bounded_plan(self, history):
        # A large same-time group is the adversarial case for a partial index
        # followed by owner-tie sorting. The complete projection key avoids it.
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute("INSERT INTO log_d(sect,owner,val) SELECT 'mail_log','history',? "
                         "FROM generate_series(1,?)", (json.dumps({'from': 'sender', 'at': 'same'}), history))
            conn.execute('ANALYZE mail_sent')
            conn.execute('COMMIT')
        statements = []
        original = pgstore.PgConn.execute
        def observed(conn, sql, params=()):
            if 'l.owner' in sql and 'l.val' in sql:
                statements.append((sql, params))
            return original(conn, sql, params)
        with patch.object(pgstore.PgConn, 'execute', observed):
            self.assertEqual(len(store.read_mail_tails(self.slug, 'sender', keep=5, slack=0)[3]), 5)
        self.assertEqual(len(statements), 1)
        with store._POOL.acquire(self.slug) as conn:
            plan = conn.execute('EXPLAIN (ANALYZE,FORMAT JSON) ' + statements[0][0],
                                statements[0][1]).fetchone()[0]
        if isinstance(plan, str): plan = json.loads(plan)
        root = plan[0]['Plan']
        nodes = []
        def walk(node):
            nodes.append(node)
            for child in node.get('Plans', []): walk(child)
        walk(root)
        # Sorting the capped five output rows is fine; a history-sized source
        # scan/sort is not. Check the actual endpoint SQL, not a spare index.
        self.assertFalse(any(n.get('Actual Rows', 0) > 5 for n in nodes), plan)
        index = next(n for n in nodes if n.get('Index Name') == 'ix_mail_sent_tail')
        self.assertEqual(index['Actual Rows'], 5)
        self.assert_projection()

    def test_runtime_can_read_and_update_projection(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('SET LOCAL ROLE orgtree_runtime')
            conn.execute("INSERT INTO log_d(sect,owner,val) VALUES('mail_log','worker',?)",
                         (json.dumps({'from': 'sender', 'at': 'runtime'}),))
            rows = conn.execute("SELECT seq FROM mail_sent WHERE sender='sender' "
                                "ORDER BY sent_at DESC,owner_pos DESC,seq DESC LIMIT 2").fetchall()
            self.assertEqual(len(rows), 2)
            conn.execute('COMMIT')
        self.assert_projection()


if __name__ == '__main__': unittest.main()
