"""Stable docket parents, retained event differences and transaction cleanup."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_orgdb_docket_pg as fixture
from test_orgdb_docket_events import item as event_record
from orgtree.orgdb import conn
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
            self.assertTrue(all(row in new for row in old if row[2]=='history' and
                                row[0] not in [r[0] for r in old if r[2]=='history'][:3]))
            self.assertTrue(all(row in new for row in old if row[2] not in ('history','scope')))
            removed = [r[0] for r in old if r[2]=='history'][1:3]
            self.assertFalse(any(r[0] in removed for r in new))
            self.assertEqual(json.loads(R.item(view.raw,SLUG)[1]),record)

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
            other = event_record()
            other['slug'] = 'pointer-other-item'
            self.put(view,other)
            other_verdict = self.row(view,other['slug'])[3]
            with self.assertRaises(psycopg.errors.ForeignKeyViolation),view.raw.transaction():
                view.raw.execute('UPDATE orgtree.work_items SET current_verdict_event_id=%s WHERE id=%s',(other_verdict,rid))
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

    def test_whole_docket_replacement_keeps_parent_ids_and_other_list(self):
        from orgtree.orgdb.mappers.docket import Docket
        with self.view() as view:
            rid = self.row(view)[0]
            old = self.events(view,rid)
            archive = view.raw.execute("SELECT id,slug,archive_seq FROM orgtree.work_items "
                                       "WHERE list_key='archive' ORDER BY ord").fetchall()
            records = list(json.loads(v[1]) for v in R.items(view.raw).values())
            record = next(r for r in records if r['slug']==SLUG)
            record['history'].append({'at':fixture.AT,'op':'whole-save'})
            R.section_put(view.raw,Docket(),'work_items',records,R.Names(view.raw),tx=view.tx)
            self.assertEqual(self.row(view)[0],rid)
            self.assertEqual(self.events(view,rid)[:len(old)],old)
            self.assertEqual(view.raw.execute("SELECT id,slug,archive_seq FROM orgtree.work_items "
                                             "WHERE list_key='archive' ORDER BY ord").fetchall(),archive)

            self.assertEqual(json.loads(R.item(view.raw,SLUG)[1]),record)
            R.section_clear(view.raw,Docket(),'work_items',tx=view.tx)
            R.docket_finish(view.raw,view.tx)
            self.assertFalse(view.raw.execute("SELECT 1 FROM orgtree.work_items WHERE list_key='active'").fetchone())
            self.assertEqual(view.raw.execute("SELECT id,slug,archive_seq FROM orgtree.work_items "
                                             "WHERE list_key='archive' ORDER BY ord").fetchall(),archive)

    def test_direct_event_commit_moves_docket_catalog_once_and_rollback_does_not(self):
        with conn.connect(fixture.ADMIN,fixture.DATABASE) as raw:
            row = raw.execute("SELECT id,item_id FROM orgtree.work_item_events WHERE source='history' "
                              'ORDER BY id LIMIT 1').fetchone()
            before = raw.execute('SELECT docket_rev,view_rev FROM orgtree.org_revision').fetchone()
            with raw.transaction():
                raw.execute('UPDATE orgtree.work_item_events SET status_change=NOT status_change WHERE id=%s',(row[0],))
                raw.execute('UPDATE orgtree.work_item_events SET status_change=NOT status_change WHERE id=%s',(row[0],))
                self.assertEqual(raw.execute('SELECT docket_rev,view_rev FROM orgtree.org_revision').fetchone(),before)
            after = raw.execute('SELECT docket_rev,view_rev FROM orgtree.org_revision').fetchone()
            self.assertEqual(after,tuple(v+1 for v in before))
            raw.execute('BEGIN')
            raw.execute('UPDATE orgtree.work_item_events SET status_change=NOT status_change WHERE id=%s',(row[0],))
            raw.execute('ROLLBACK')
            self.assertEqual(raw.execute('SELECT docket_rev,view_rev FROM orgtree.org_revision').fetchone(),after)

    def test_real_migration_refuses_old_populated_database_and_preserves_it(self):
        from orgtree.orgdb import codec, migrate
        database = fixture.PREFIX+'pre_events'
        with tempfile.TemporaryDirectory(prefix='docket-pre-event-migrations-') as folder:
            old = Path(folder)
            for path in migrate.files(migrate.ORG_DIR):
                if path.name<'0010':
                    (old/path.name).write_bytes(path.read_bytes())
            try:
                with conn.connect(fixture.ADMIN,'postgres') as admin:
                    admin.execute('CREATE DATABASE '+codec.quote(database))
                with conn.connect(fixture.ADMIN,database) as admin:
                    migrate.migrate(admin,old,migrate.ORG_LOCK)
                    admin.execute("INSERT INTO orgtree.work_items(list_key,ord,slug,docket_manual,docket_order) "
                                  "VALUES('active',0,'pre-events',false,'')")
                    with self.assertRaisesRegex(Exception,'converted before 0010: re-convert it from its legacy data'):
                        migrate.migrate(admin,migrate.ORG_DIR,migrate.ORG_LOCK)
                    self.assertNotIn('0010_docket_events.sql',migrate.applied(admin))
                    self.assertIsNone(admin.execute("SELECT to_regclass('orgtree.work_item_events')").fetchone()[0])
                    self.assertEqual(admin.execute('SELECT slug FROM orgtree.work_items').fetchall(),[('pre-events',)])
                    admin.execute('DELETE FROM orgtree.work_items')
                    self.assertIn('0010_docket_events.sql',migrate.migrate(admin,migrate.ORG_DIR,migrate.ORG_LOCK)['applied'])
            finally:
                with conn.connect(fixture.ADMIN,'postgres') as admin:
                    admin.execute('DROP DATABASE IF EXISTS '+codec.quote(database)+' WITH (FORCE)')

    def test_savepoint_reopen_discards_original_archive_cas_then_retries_exactly(self):
        with self.view() as view:
            archived = event_record()
            archived.update(slug='savepoint-archive',status='done',archived_at=fixture.AT)
            seq = view.execute('INSERT INTO log_l(sect, at, val) VALUES(?,?,?)',
                ('work_items_archive',None,R.dumps(archived))).lastrowid
            rid = self.row(view,archived['slug'])[0]
            old = self.events(view,rid)
            reopened = dict(archived,status='in_progress',candidate_verdict=None,review_packet=None)
            reopened.pop('archived_at')
            view.raw.execute('SAVEPOINT archive_move')
            self.put(view,reopened)
            self.assertTrue(R.docket_pending(view.raw)['moved'])
            view.raw.execute('ROLLBACK TO SAVEPOINT archive_move')
            self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})
            self.assertEqual(self.row(view,archived['slug'])[:2],(rid,'archive'))
            self.assertEqual(self.events(view,rid),old)
            self.put(view,reopened)
            self.assertEqual(view.execute('DELETE FROM log_l WHERE seq=? AND val=?',
                (seq,R.dumps(archived))).rowcount,1)
            R.docket_finish(view.raw,view.tx)
            self.assertEqual(self.row(view,archived['slug'])[:2],(rid,'active'))
            self.assertEqual(self.events(view,rid),old)

    def test_unfinished_reopen_commit_rolls_back_and_reused_connection_is_clean(self):
        with self.view(begin=False) as view:
            archived = event_record()
            archived.update(slug='unfinished-reopen',status='done',archived_at=fixture.AT)
            seq = view.execute('INSERT INTO log_l(sect, at, val) VALUES(?,?,?)',
                ('work_items_archive',None,R.dumps(archived))).lastrowid
            rid = self.row(view,archived['slug'])[0]
            old = self.events(view,rid)
            try:
                view.execute('BEGIN IMMEDIATE')
                reopened = dict(archived,status='in_progress')
                reopened.pop('archived_at')
                self.put(view,reopened)
                with self.assertRaisesRegex(R.CompatError,'original archive row unremoved'):
                    view.execute('COMMIT')
                self.assertFalse(view.in_transaction)
                view.execute('BEGIN IMMEDIATE')
                self.assertEqual(R.docket_pending(view.raw),{'deleted':[],'moved':{}})
                self.assertEqual(self.row(view,archived['slug'])[:2],(rid,'archive'))
                self.assertEqual(self.events(view,rid),old)
                view.execute('COMMIT')
            finally:
                if view.in_transaction:
                    view.execute('ROLLBACK')
                view.execute('DELETE FROM log_l WHERE seq=? AND val=?',(seq,R.dumps(archived)))


if __name__=='__main__':
    unittest.main()
