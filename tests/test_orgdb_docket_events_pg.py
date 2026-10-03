"""Stable docket parents, retained event differences and transaction cleanup."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from contextlib import contextmanager
import json
import unittest
from unittest.mock import patch

import test_orgdb_docket_pg as fixture
from test_orgdb_docket_events import item as event_record
from orgtree.ledger import USER
from orgtree.orgdb import conn, docket
from orgtree.orgdb.compat import conn as compat_conn, rows as R

SLUG = 'event-item'
KEY = 'work_items\x1f'+SLUG


def setUpModule():
    original = fixture.seed
    def seed():
        value = original()
        value['work_items'].append(event_record())
        return value
    with patch.object(fixture,'seed',seed):
        fixture.setUpModule()


@unittest.skipUnless(fixture.ADMIN and fixture.RUNTIME,'disposable PostgreSQL URLs required')
class StableWrites(unittest.TestCase):
    @contextmanager
    def view(self, *, begin=True):
        raw = conn.connect(fixture.RUNTIME,fixture.DATABASE)
        view = compat_conn.OrgDbConn(raw,fixture.SLUG,fixture.OID,fixture.DATABASE)
        if begin:
            view.execute('BEGIN IMMEDIATE')
        try:
            yield view
        finally:
            if view.in_transaction:
                view.execute('ROLLBACK')
            raw.close()

    def put(self, view, record):
        view.execute('INSERT INTO doc(key,val) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET val=excluded.val',
                     ('work_items\x1f'+record['slug'],R.dumps(record)))

    def row(self, view, slug=SLUG):
        return view.raw.execute('SELECT id,list_key,archive_seq,current_verdict_event_id,'
                                'current_review_packet_event_id FROM orgtree.work_items WHERE slug=%s',(slug,)).fetchone()

    def events(self, view, rid):
        return view.raw.execute('SELECT id,seq,source,xmin::text,extra FROM orgtree.work_item_events '
                                'WHERE item_id=%s ORDER BY seq',(rid,)).fetchall()

    def test_real_save_append_fold_and_scope_rewrite_keep_unaffected_rows(self):
        with self.view() as view:
            record = event_record()
            record['history'] = [{'at':fixture.AT,'op':str(n)} for n in range(5)]
            self.put(view,record)
            rid = self.row(view)[0]
            old = self.events(view,rid)
            record['history'] = [{'kind':'folded','count':3},*record['history'][3:],
                                 {'at':fixture.AT,'op':'new'}]
            record['scope'][0]['superseded_by'] = 2
            record['scope'].append({'seq':2,'kind':'decision','text':'new'})
            self.put(view,record)
            self.assertEqual(self.row(view)[0],rid)
            new = self.events(view,rid)
            self.assertEqual([r[:3] for r in new if r[0] in (old[3][0],old[4][0])],
                             [old[3][:3],old[4][:3]])
            self.assertTrue(all(row in new for row in old[5:] if row[2]!='scope'))
            self.assertFalse(any(r[0] in (old[1][0],old[2][0]) for r in new))
            self.assertEqual(json.loads(R.item(view.raw,SLUG)[1]),record)
            native = docket.Snapshot(view.raw,fixture.OID,viewer=USER,now_ts=fixture.NOW)
            self.assertEqual(native.body(native.lookup(SLUG)),record)

    def test_archive_reopen_same_id_exact_original_cas_and_append_order(self):
        with self.view() as view:
            rid = self.row(view)[0]
            old_events = self.events(view,rid)
            original = R.item(view.raw,SLUG)[1]
            archived = event_record()
            archived.update(status='done',archived_at=fixture.AT)
            self.assertEqual(view.execute('DELETE FROM doc WHERE key=? AND val=?',(KEY,original)).rowcount,1)
            self.assertIsNone(R.item(view.raw,SLUG))
            added = view.execute('INSERT INTO log_l(sect, at, val) VALUES(?,?,?)',
                                 ('work_items_archive',None,R.dumps(archived)))
            position = added.lastrowid
            self.assertEqual(self.row(view)[0],rid)
            self.assertEqual(self.row(view)[1],'archive')
            self.assertEqual(self.events(view,rid),old_events)
            reopened = copy.deepcopy(archived)
            reopened.pop('archived_at')
            reopened.update(status='in_progress',candidate_verdict=None,review_packet=None)
            self.put(view,reopened)
            self.assertEqual(view.execute('DELETE FROM log_l WHERE seq=? AND val=?',
                                         (position,R.dumps({'wrong':True}))).rowcount,0)
            self.assertEqual(view.execute('DELETE FROM log_l WHERE seq=? AND val=?',
                                         (position,R.dumps(archived))).rowcount,1)
            self.assertEqual(self.row(view)[:2],(rid,'active'))
            self.assertEqual(self.events(view,rid),old_events)
            self.assertEqual(json.loads(R.item(view.raw,SLUG)[1]),reopened)
            R.docket_finish(view.raw,view.tx)
            self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})

    def test_clear_currents_preserves_history_and_pointer_kind_is_restricted(self):
        import psycopg
        with self.view() as view:
            rid,_,_,verdict,packet = self.row(view)
            old = self.events(view,rid)
            with self.assertRaises(psycopg.errors.ForeignKeyViolation),view.raw.transaction():
                view.raw.execute('UPDATE orgtree.work_items SET current_verdict_event_id=%s WHERE id=%s',(packet,rid))
                view.raw.execute('SET CONSTRAINTS current_verdict_event_id_fk IMMEDIATE')
            with self.assertRaises(psycopg.errors.RestrictViolation),view.raw.transaction():
                view.raw.execute('DELETE FROM orgtree.work_item_events WHERE id=%s',(verdict,))
            record = event_record()
            record.update(candidate_verdict=None,review_packet=None)
            self.put(view,record)
            self.assertEqual(self.row(view)[3:],(None,None))
            self.assertEqual(self.events(view,rid),old)
            self.assertEqual(json.loads(R.item(view.raw,SLUG)[1]),record)

    def test_savepoint_and_full_rollback_discard_pending_moves_on_reused_connection(self):
        with self.view() as view:
            rid = self.row(view)[0]
            view.raw.execute('SAVEPOINT docket_probe')
            view.execute('DELETE FROM doc WHERE key=?',(KEY,))
            self.assertIn(rid,R.docket_pending(view.raw)['deleted'])
            view.raw.execute('ROLLBACK TO SAVEPOINT docket_probe')
            self.assertIsNotNone(R.item(view.raw,SLUG))
            self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})
            view.execute('DELETE FROM doc WHERE key=?',(KEY,))
            view.execute('ROLLBACK')
            view.execute('BEGIN IMMEDIATE')
            R.docket_finish(view.raw,view.tx)
            self.assertIsNotNone(R.item(view.raw,SLUG))
            self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})

    def test_unmatched_delete_cascades_events_and_atomic_cleanup_does_not_leak(self):
        record = event_record()
        record['slug'] = 'atomic-event-delete'
        with self.view(begin=False) as view:
            self.put(view,record)
            rid = self.row(view,record['slug'])[0]
            self.assertTrue(self.events(view,rid))
            view.execute('DELETE FROM doc WHERE key=?',('work_items\x1f'+record['slug'],))
            self.assertIsNone(self.row(view,record['slug']))
            self.assertFalse(self.events(view,rid))
            self.assertFalse(view.tx.docket_touched)
            view.execute('BEGIN IMMEDIATE')
            self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})

    def test_archive_replace_updates_parent_and_only_appends_one_event(self):
        with self.view() as view:
            record = event_record()
            record.update(slug='new-archived-event',status='done',archived_at=fixture.AT)
            seq = view.execute('INSERT INTO log_l(sect, at, val) VALUES(?,?,?)',
                               ('work_items_archive',None,R.dumps(record))).lastrowid
            rid = self.row(view,record['slug'])[0]
            old = self.events(view,rid)
            record['history'].append({'at':fixture.AT,'op':'archive-replacement'})
            changed = view.execute('UPDATE log_l SET at=?, val=? WHERE seq=?',
                                  (None,R.dumps(record),seq))
            self.assertEqual(changed.rowcount,1)
            self.assertEqual(self.row(view,record['slug'])[0],rid)
            self.assertEqual(self.events(view,rid)[:len(old)],old)
            archive = R.model().logs['work_items_archive']
            rows = R.log_rows(view.raw,archive,ids=[seq//R.SLOTS])
            self.assertEqual(json.loads(rows[0][3]),record)
            self.assertEqual(rows[0][0],seq)


if __name__=='__main__':
    unittest.main()
