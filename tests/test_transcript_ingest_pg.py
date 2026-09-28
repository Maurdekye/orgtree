"""Transcript source projection and bounded reconciliation on real PostgreSQL."""
import os
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_ingest_projection_t{os.getpid()}'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import test_transcript_ingest as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PostgresTranscriptCapture(fixture.CaptureTests):
    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    def test_warm_source_projection_is_revision_checked_and_detached(self):
        from orgtree import store,pgstore
        from unittest.mock import patch
        slug=self.org.d['slug'];first=store.read_transcript_source(slug,'agent')
        original=pgstore.PgConn.execute;sqls=[]
        def observe(conn,sql,*a,**kw):
            sqls.append(sql);return original(conn,sql,*a,**kw)
        with patch.object(pgstore.PgConn,'execute',observe):
            second=store.read_transcript_source(slug,'agent')
        self.assertTrue(sqls)
        self.assertFalse(any('__source_node' in sql for sql in sqls),'warm cache must skip JSON projection')
        second['nodes']['agent']['session_id']='poison'
        self.assertEqual(store.read_transcript_source(slug,'agent'),first)

    def test_source_cache_observes_external_revision_without_local_feed(self):
        from orgtree import store
        slug=self.org.d['slug'];store.read_transcript_source(slug,'agent');seq=store.org_seq(slug)
        # A real separate writer commits data+revision without this process's
        # local invalidation or LISTEN callback.
        with store._POOL.acquire(slug) as pc:
            schema="org_"+str(int(pc.org_id))
            oid=pc.org_id
        with psycopg.connect(os.environ['ORGTREE_PG_URL']) as conn:
            conn.execute(f"UPDATE {schema}.nodes SET val=jsonb_set(val::jsonb,'{{session_id}}','\"outside\"'::jsonb)::text WHERE id='agent'")
            conn.execute('UPDATE public.orgs SET revision=revision+1 WHERE org_id=%s',(oid,))
        self.assertEqual(store.org_seq(slug),seq)
        self.assertEqual(store.read_transcript_source(slug,'agent')['nodes']['agent']['session_id'],'outside')

    def test_uncommitted_source_never_reuses_or_populates_shared_cache(self):
        from orgtree import store,orgtx
        slug=self.org.d['slug'];committed=store.read_transcript_source(slug,'agent')
        for warm in (True,False):
            with self.subTest(warm=warm):
                if not warm:
                    with store._transcript_source_cache_lock:store._transcript_source_cache.clear()
                with self.assertRaisesRegex(RuntimeError,'rollback probe'):
                    with orgtx.org_tx(slug,nodes=['agent']):
                        with store._POOL.acquire(slug) as pc:
                            self.assertTrue(pc.pinned,'must exercise pinned transaction')
                            pc.execute("UPDATE nodes SET val=jsonb_set(val::jsonb,'{session_id}','\"uncommitted\"'::jsonb)::text WHERE id='agent'")
                        seen=store.read_transcript_source(slug,'agent')
                        self.assertEqual(seen['nodes']['agent']['session_id'],'uncommitted')
                        raise RuntimeError('rollback probe')
                self.assertEqual(store.read_transcript_source(slug,'agent'),committed)

    def test_cache_miss_tags_payload_with_same_statement_revision(self):
        from orgtree import store,pgstore
        from unittest.mock import patch
        slug=self.org.d['slug'];fired=[];original=pgstore.PgConn.execute
        with store._transcript_source_cache_lock:store._transcript_source_cache.clear()
        def between(conn,sql,*a,**kw):
            if sql == 'BEGIN':
                result=original(conn,sql,*a,**kw)
                conn.raw.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
                return result
            if '__source_node' in sql and not fired:
                fired.append(True)
                with psycopg.connect(os.environ['ORGTREE_PG_URL']) as writer:
                    writer.execute(f"UPDATE org_{int(conn.org_id)}.nodes SET val=jsonb_set(val::jsonb,'{{session_id}}','\"raced\"'::jsonb)::text WHERE id='agent'")
                    writer.execute('UPDATE public.orgs SET revision=revision+1 WHERE org_id=%s',(conn.org_id,))
            return original(conn,sql,*a,**kw)
        with patch.object(pgstore.PgConn,'execute',between):
            result=store.read_transcript_source(slug,'agent')
        self.assertEqual(fired,[True],'actual commit must cross revision check and payload read')
        self.assertEqual(result['nodes']['agent']['session_id'],'raced')
        def forbid_payload(conn,sql,*a,**kw):
            self.assertNotIn('__source_node',sql,'coherent payload revision must be reusable immediately')
            return original(conn,sql,*a,**kw)
        with patch.object(pgstore.PgConn,'execute',forbid_payload):
            self.assertEqual(store.read_transcript_source(slug,'agent'),result)

    def test_source_projection_cache_is_bounded_and_org_settings_invalidate(self):
        from orgtree import store
        from unittest.mock import patch
        slug=self.org.d['slug']
        with store._transcript_source_cache_lock:store._transcript_source_cache.clear()
        with patch.object(store,'_TRANSCRIPT_SOURCE_CACHE_LIMIT',2):
            for i in range(3):
                other=store.create_org('cache-'+str(i)+'-'+__import__('uuid').uuid4().hex[:8])
                other.hire(fixture.ledger.USER,None,'haiku',0,'agent');store.save_org(other)
                store.read_transcript_source(other.d['slug'],'agent')
            self.assertEqual(len(store._transcript_source_cache),2)
        before=store.read_transcript_source(slug,'agent')
        org=store.load_org(slug);org.d['reply_incarnation']='new-org-inc';store.save_org(org)
        after=store.read_transcript_source(slug,'agent')
        self.assertNotEqual(before['reply_incarnation'],after['reply_incarnation'])
        self.assertEqual(after['reply_incarnation'],'new-org-inc')

    def test_keyset_page_has_exact_bounded_membership(self):
        from orgtree import store
        slug = self.org.d['slug']
        org = store.load_org(slug)
        for i in range(23):
            node = dict(org.node('agent'))
            node.update(id=f'old{i:03d}', state='archived')
            org.d['nodes'][node['id']] = node
        store.save_org(org)
        after = ''
        found = []
        while True:
            page = store.read_transcript_nodes_page(slug, after, 8)
            self.assertLessEqual(len(page['rows']), 8)
            found.extend(nid for nid, state in page['rows'])
            if not page['more']:
                break
            after = page['rows'][-1][0]
        self.assertEqual(found, sorted(org.nodes))
        self.assertEqual(len(found), len(set(found)))

    def test_active_page_reads_only_live_nodes_in_bounded_pages(self):
        from orgtree import store
        slug = self.org.d['slug']
        org = store.load_org(slug)
        for i in range(30):
            node = dict(org.node('agent'))
            node.update(id=f'hist-{i:03d}', state='archived')
            org.d['nodes'][node['id']] = node
        for i in range(7):
            node = dict(org.node('agent'))
            node.update(id=f'worker-{i:03d}', state='live')
            org.d['nodes'][node['id']] = node
        store.save_org(org)
        expected = sorted(nid for nid, n in store.load_org(slug).nodes.items()
                          if n.get('state') != 'archived')
        self.assertGreaterEqual(len(expected), 8, 'control: live nodes exist beside history')
        found, pages, after = [], 0, None
        while True:
            page = store.read_active_transcript_nodes(slug, after, 3)
            self.assertIsNotNone(page, 'postgres must answer from node_index')
            self.assertLessEqual(len(page['rows']), 3)
            pages += 1
            found.extend(nid for nid, _ in page['rows'])
            if not page['more']:
                break
            after = (page['rows'][-1][1], page['rows'][-1][0])
        self.assertEqual(sorted(found), expected)
        self.assertEqual(len(found), len(set(found)))
        self.assertFalse(any(n.startswith('hist-') for n in found))
        self.assertEqual(pages, -(-len(expected) // 3))


def tearDownModule():
    if ADMIN:
        from orgtree import pgstore, transcript_records
        transcript_records.close_all()
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
