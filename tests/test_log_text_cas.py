"""Formatting-only log saves must avoid SQL without weakening stored-value/CAS checks."""
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='log-text-cas-')
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_STORE='sqlite')
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store


class LogTextCAS(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:', isolation_level=None)
        self.conn.execute('CREATE TABLE log_l(seq INTEGER PRIMARY KEY AUTOINCREMENT, sect TEXT, at TEXT, val TEXT)')
        self.addCleanup(self.conn.close)
        self.cas = patch.object(store, '_ROW_CAS', True)
        self.cas.start()
        self.addCleanup(self.cas.stop)
        self.sql = []
        self.conn.set_trace_callback(self.sql.append)

    def seed(self, values):
        rows = []
        for value in values:
            raw = json.dumps(value, ensure_ascii=False, indent=1)
            seq = self.conn.execute('INSERT INTO log_l(sect,at,val) VALUES(?,?,?)', ('events', None, raw)).lastrowid
            rows.append((seq, raw))
        self.sql.clear()
        return rows, store.AppendLog((json.loads(raw) for _, raw in rows), rows=rows)

    def save(self, cur, snap, incremental=True):
        self.conn.execute('BEGIN')
        try:
            out = store._write_log_rows(self.conn, 'log_l', 'sect=?', ('events',),
                'INSERT INTO log_l(sect,at,val) VALUES(?,?,?)', ('events',), cur, snap,
                incremental=cur if incremental else None)
            self.conn.execute('COMMIT')
            return out
        except BaseException:
            self.conn.execute('ROLLBACK')
            raise

    def stored(self):
        return self.conn.execute('SELECT seq,val FROM log_l ORDER BY seq').fetchall()

    def writes(self):
        return [sql for sql in self.sql if sql.startswith(('UPDATE ', 'DELETE ', 'INSERT '))]

    def test_incremental_noop_preserves_exact_rows_and_snapshot(self):
        snap, cur = self.seed([{'name': 'caf\u00e9', 'nested': [1, True, None]}, {'name': 'second'}])
        result = self.save(cur, snap)
        self.assertEqual(self.writes(), [])
        self.assertEqual(result, snap)
        self.assertEqual(self.stored(), snap)

    def test_plain_replacement_noop_preserves_raw_rows(self):
        snap, cur = self.seed([{'a': 1}, {'a': 2}])
        self.assertEqual(self.save(list(cur), snap, incremental=False), snap)
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.stored(), snap)

    def test_real_edit_after_noop_uses_original_raw_cas_token(self):
        snap, cur = self.seed([{'nested': {'value': 1}}])
        adopted = self.save(cur, snap)
        cur[0]['nested']['value'] = 9
        result = self.save(cur, adopted)
        self.assertEqual(json.loads(self.stored()[0][1])['nested']['value'], 9)
        self.assertEqual(result, self.stored())
        self.assertEqual(len(self.writes()), 1)

    def test_type_changes_are_not_python_equality_noops(self):
        for before, after in ((True, 1), (1, True), (1, 1.0), (1.0, 1), (0.0, -0.0)):
            with self.subTest(before=before, after=after):
                self.conn.execute('DELETE FROM log_l')
                snap, cur = self.seed([{'value': before}])
                cur[0]['value'] = after
                self.save(cur, snap)
                self.assertEqual(self.stored()[0][1], store._dumps({'value': after}))
                self.assertEqual(len(self.writes()), 1)

    def test_conflict_after_noop_is_detected(self):
        snap, cur = self.seed([{'value': 1}])
        adopted = self.save(cur, snap)
        newer = store._dumps({'value': 77})
        self.conn.execute('UPDATE log_l SET val=? WHERE seq=?', (newer, snap[0][0]))
        cur[0]['value'] = 2
        with self.assertRaises(store.StaleWrite):
            self.save(cur, adopted)
        self.assertEqual(self.stored(), [(snap[0][0], newer)])

    def test_later_row_conflict_rolls_back_prior_real_edit(self):
        snap, cur = self.seed([{'value': 1}, {'value': 2}])
        newer = store._dumps({'value': 77})
        self.conn.execute('UPDATE log_l SET val=? WHERE seq=?', (newer, snap[1][0]))
        cur[0]['value'] = 8
        cur[1]['value'] = 9
        with self.assertRaises(store.StaleWrite):
            self.save(cur, snap)
        self.assertEqual(self.stored(), [snap[0], (snap[1][0], newer)])

    def test_append_does_not_rewrite_existing_noncompact_rows(self):
        snap, cur = self.seed([{'value': 1}])
        cur.append({'value': 2})
        result = self.save(cur, snap)
        self.assertEqual(result[0], snap[0])
        self.assertEqual(self.stored()[0], snap[0])
        self.assertEqual(json.loads(self.stored()[1][1]), {'value': 2})
        self.assertEqual(len(self.writes()), 1)
        self.assertTrue(self.writes()[0].startswith('INSERT '))

    def test_reorder_and_delete_still_persist(self):
        snap, cur = self.seed([{'value': 1}, {'value': 2}, {'value': 3}])
        cur.reverse()
        del cur[1]
        self.save(cur, snap)
        self.assertEqual([json.loads(raw) for _, raw in self.stored()], [{'value': 3}, {'value': 1}])

    def test_stale_noop_does_not_overwrite_newer_row(self):
        snap, cur = self.seed([{'value': 1}])
        newer = store._dumps({'value': 77})
        self.conn.execute('UPDATE log_l SET val=? WHERE seq=?', (newer, snap[0][0]))
        self.sql.clear()
        self.save(cur, snap)
        self.assertEqual(self.stored(), [(snap[0][0], newer)])
        self.assertEqual(self.writes(), [])


if __name__ == '__main__':
    unittest.main()
