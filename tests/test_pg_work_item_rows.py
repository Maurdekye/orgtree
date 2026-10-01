"""Actual PG row/layout/migration controls. Missing PG is a skip, never a pass."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore, store, orgtx, workrows
from test_work_item_rows import items


def tearDownModule(): f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class LiveRows(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    def setUp(self):
        self.slug=f._fresh_org('item-'+self._testMethodName)
        org=store.load_org(self.slug); org.d['work_items']=items(); store.save_org(org)

    def raw(self):
        with store._POOL.acquire(self.slug) as c:
            return dict(c.execute('SELECT key,val FROM doc WHERE key=? OR starts_with(key,?)',('work_items',workrows.PREFIX)).fetchall())

    def test_bootstrap_single_row_revision_and_bounded_read(self):
        before=self.raw(); rev=f._rev(self.slug)
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            tx.d['work_items'][0]['nested']['values'].append(9)
        after=self.raw()
        self.assertEqual({k for k in before if before[k]!=after[k]}, {workrows.PREFIX+'one'})
        self.assertEqual(f._rev(self.slug),rev+1)
        result=store.read_work_items_rows(self.slug,['one','absent'])
        self.assertEqual(set(result['items']),{'one'})
        self.assertEqual(result['items']['one']['nested']['values'],[1,9])
        self.assertEqual(result['revision'],rev+1)
        self.assertEqual(result['ids'],['one','two'])

    def test_work_stamp_stable_for_unrelated_saves_and_tracks_logs(self):
        def stamp(): return store.read_work_items_rows(self.slug,[])['work_revision']
        initial=stamp(); self.assertGreater(initial,0)
        org=store.load_org(self.slug); org.d['nodes']['a']['last_status']={'summary':'changed'}
        store.save_org(org); self.assertEqual(stamp(),initial)
        org=store.load_org(self.slug); org.d.setdefault('work_items_archive',[]).append({'slug':'arch','value':1})
        store.save_org(org); archived=stamp(); self.assertGreater(archived,initial)
        org=store.load_org(self.slug); org.d.setdefault('work_scope_log',{}).setdefault('arch',[]).append({'seq':1,'text':'scope'})
        store.save_org(org); self.assertGreater(stamp(),archived)
        a=store.load_org(self.slug); b=store.load_org(self.slug)
        a.d['work_items'][0]['rev']=2; store.save_org(a); before=stamp()
        b.d['work_items'][0]['rev']=3
        with self.assertRaises(store.StaleWrite): store.save_org(b)
        self.assertEqual(stamp(),before)

    def test_assignment_and_archive_reopen_keep_stored_rows(self):
        from orgtree import worktx
        from orgtree.ledger import USER
        org=store.create_org('actual-assignment-archive')
        org.hire(USER,None,'haiku',0,'own'); org.hire(USER,'own','haiku',0,'sub')
        org.work_create('own','Durable work row',objective='Keep assignment and archived body atomic.')
        store.save_org(org); slug=org.d['slug']; item=org.d['work_items'][-1]['slug']
        worktx.run(slug,lambda o:o.work_assign('own',item,'sub'))
        fresh=store.load_org(slug); self.assertEqual(fresh.d['work_items'][-1]['owner']['node'],'sub')
        with orgtx.org_tx(slug,sections=['work_items','asks'],logs=['work_items_archive']) as tx:
            row=tx.d['work_items'].pop(); tx.d.setdefault('work_items_archive',[]).append(row)
        self.assertEqual(store.read_work_items_rows(slug,[item])['ids'],[])
        fresh=store.load_org(slug); self.assertEqual(fresh.d['work_items_archive'][-1]['slug'],item)
        with orgtx.org_tx(slug,sections=['work_items','asks'],logs=['work_items_archive']) as tx:
            tx.d['work_items'].append(tx.d['work_items_archive'].pop())
        restored=store.read_work_items_rows(slug,[item])['items'][item]
        self.assertEqual(restored['owner']['node'],'sub')

    def test_bounded_reader_stamp_and_body_share_one_snapshot(self):
        import psycopg
        before=store.read_work_items_rows(self.slug,['one']); original=pgstore.PgConn.execute; fired=[]
        def execute(conn,sql,params=()):
            cur=original(conn,sql,params)
            if sql == 'SELECT val FROM doc WHERE key=?' and params == ('work_items',) and not fired:
                fired.append(True)
                with psycopg.connect(os.environ['ORGTREE_PG_URL'],autocommit=True) as other:
                    with other.transaction():
                        raw=json.dumps({**before['items']['one'],'rev':77})
                        other.execute(f'UPDATE org_{conn.org_id}.doc SET val=%s WHERE key=%s',(raw,workrows.PREFIX+'one'))
                        other.execute('UPDATE public.orgs SET revision=revision+1,work_revision=revision+1 WHERE org_id=%s',(conn.org_id,))
            return cur
        with patch.object(pgstore.PgConn,'execute',execute): read=store.read_work_items_rows(self.slug,['one'])
        self.assertEqual(fired,[True]);self.assertEqual(read,before)
        after=store.read_work_items_rows(self.slug,['one'])
        self.assertEqual(after['items']['one']['rev'],77);self.assertGreater(after['work_revision'],before['work_revision'])

    def test_old_nested_reference_after_save_and_external_alias(self):
        org=store.load_org(self.slug); row=org.d['work_items'][0]; values=row['nested']['values']
        store.save_org(org); values.append(7); store.save_org(org)
        ext={'v':1}; row['nested']['external']=ext; store.save_org(org)
        observed=row['nested']['external']; ext['v']=2; store.save_org(org)
        fresh=store.load_org(self.slug).d['work_items'][0]
        self.assertEqual(fresh['nested']['values'],[1,7]); self.assertEqual(fresh['nested']['external'],{'v':2})

    def test_conflict_rolls_back_items_and_revision(self):
        a=store.load_org(self.slug); b=store.load_org(self.slug)
        a.d['work_items'][0]['rev']=2; store.save_org(a); rev=f._rev(self.slug)
        b.d['work_items'][1]['rev']=99; b.d['work_items'][0]['rev']=3; b.d['work_items'].reverse()
        with self.assertRaises(store.StaleWrite): store.save_org(b)
        self.assertEqual(f._rev(self.slug),rev)
        self.assertEqual([v['rev'] for v in workrows.assemble(self.raw())],[2,1])

    def test_unlocked_item_edit_refuses(self):
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug,sections=['asks']) as tx:
                tx.d['work_items'][0]['rev']=9
        self.assertEqual(workrows.assemble(self.raw())[0]['rev'],1)

    def test_attention_changed_by_ask_is_same_atomic_commit(self):
        with orgtx.org_tx(self.slug,sections=['work_items','asks']) as tx:
            tx.d['asks']=[{'id':'q','status':'open','questions':[{'work_item':'one'}]}]
        fresh=store.load_org(self.slug)
        self.assertTrue(fresh.d['work_items'][0]['notification_attention_active'])
        self.assertFalse(fresh.d['work_items'][1]['notification_attention_active'])
        self.assertEqual(fresh.d['asks'][0]['id'],'q')


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Upgrade(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.name='work_upgrade_'+str(os.getpid())
        with psycopg.connect(f.ADMIN,autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS {self.name} WITH (FORCE)'); c.execute(f'CREATE DATABASE {self.name}')
        self.c=pgstore.connect(f._with_db(f.ADMIN,self.name))
        self.directory=tempfile.TemporaryDirectory()
        d=Path(self.directory.name)
        for name in ('0001_base.sql','0002_runtime_grants.sql'): shutil.copy(pgstore.MIGRATIONS_DIR/name,d/name)
        pgstore.migrate(self.c,d)
        self.c.execute("INSERT INTO orgs(slug) VALUES('upgrade')")
        self.c.execute('SELECT orgtree_create_org_schema(1)')
        self.original=json.dumps(items(),indent=2,ensure_ascii=False)
        self.c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',('work_items',self.original))

    def tearDown(self):
        self.c.close(); self.directory.cleanup()
        import psycopg
        with psycopg.connect(f.ADMIN,autocommit=True) as c: c.execute(f'DROP DATABASE {self.name} WITH (FORCE)')

    def check_rollback(self):
        self.assertEqual(self.c.execute('SELECT key,val FROM org_1.doc').fetchall(),[('work_items',self.original)])
        self.assertEqual(self.c.execute('SELECT count(*) FROM schema_migrations').fetchone()[0],2)
        self.assertEqual(self.c.execute('SELECT revision FROM orgs').fetchone()[0],0)

    def test_upgrade_readback_checksum_and_idempotence(self):
        result=pgstore.migrate(self.c)
        self.assertIn('0003_work_item_rows.sql',result['applied'])
        rows=dict(self.c.execute('SELECT key,val FROM org_1.doc').fetchall())
        self.assertEqual(workrows.assemble(rows),items())
        receipt=json.loads(self.c.execute("SELECT result FROM receipts WHERE op_key='work-items-layout/v1'").fetchone()[0])
        self.assertEqual(receipt['count'],2)
        self.assertEqual(receipt['source_sha256'],hashlib.sha256(self.original.encode()).hexdigest())
        self.assertEqual(len(receipt['items_sha256']),64)
        self.assertEqual(pgstore.migrate(self.c)['applied'],[])
        with self.assertRaises(pgstore.MigrationDrift): pgstore.migrate(self.c,Path(self.directory.name))

    def test_unknown_shape_duplicate_and_orphan_refuse(self):
        for bad in ('{}','null','[{"slug":"same"},{"slug":"same"}]','[{"slug":""}]'):
            self.c.execute("UPDATE org_1.doc SET val=%s WHERE key='work_items'",(bad,))
            with self.subTest(bad=bad),self.assertRaises(Exception): pgstore.migrate(self.c)
            self.assertEqual(self.c.execute('SELECT count(*) FROM schema_migrations').fetchone()[0],2)
        self.c.execute("UPDATE org_1.doc SET val=%s WHERE key='work_items'",(self.original,))
        self.c.execute('INSERT INTO org_1.doc VALUES(%s,%s)',(workrows.PREFIX+'orphan','{}'))
        with self.assertRaisesRegex(Exception,'mixed/orphan'): pgstore.migrate(self.c)

    def trigger(self,body):
        self.c.execute('CREATE FUNCTION public.corrupt_work() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+body+' RETURN NEW; END $$')
        self.c.execute('CREATE TRIGGER corrupt BEFORE INSERT ON org_1.doc FOR EACH ROW EXECUTE FUNCTION public.corrupt_work()')

    def test_count_control_catches_extra_unindexed_row(self):
        self.trigger("IF NEW.key='work_items' || chr(31) || 'one' THEN INSERT INTO org_1.doc VALUES('work_items' || chr(31) || 'extra','{\"slug\":\"extra\"}'); END IF;")
        with self.assertRaisesRegex(Exception,'count/checksum mismatch'): pgstore.migrate(self.c)
        self.check_rollback()

    def test_checksum_control_catches_changed_value_same_count(self):
        self.trigger("IF NEW.key='work_items' || chr(31) || 'one' THEN NEW.val='{\"slug\":\"one\",\"rev\":999}'; END IF;")
        with self.assertRaisesRegex(Exception,'count/checksum mismatch'): pgstore.migrate(self.c)
        self.check_rollback()


if __name__=='__main__': unittest.main()
