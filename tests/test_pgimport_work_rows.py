"""SQLite and legacy JSON -> per-item PG rows, using the real importer."""
import json
from unittest.mock import patch
import unittest
import test_pgimport as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import workrows
from test_work_item_rows import items


class WorkImport(f.Base):
    def populate(self):
        a=f.sample_doc(); a['work_items']=items()
        f.write_db(self.orgs()/'acme.db',a)
        b=f.sample_doc('Beta'); b['work_items']=items()
        (self.orgs()/'beta.json').write_text(json.dumps(b),encoding='utf-8')

    def test_both_sources_destination_manifests_and_resume(self):
        self.populate(); before=f.tree_digest(self.orgs())
        report=f.pgimport.dry_run(self.root)
        self.assertTrue(report['importable'],report['refused'])
        for row in report['orgs'].values():
            self.assertEqual(row['work_items'],workrows.checksum(items()))
            self.assertNotEqual(row['source_manifest_sha256'],row['manifest_sha256'])
            self.assertEqual(row['manifest']['tables']['doc']['count'],row['source_manifest']['tables']['doc']['count']+2)
        result=f.pgimport.import_root(self.root,self.sink())
        for slug in result['orgs']:
            doc=dict(self.sink().read_org(slug)['doc'])
            rows={k:v for k,v in doc.items() if k=='work_items' or k.startswith(workrows.PREFIX)}
            self.assertEqual(workrows.assemble(rows),items())
            self.assertEqual(f.pgimport.manifest(self.sink().read_org(slug)),report['orgs'][slug]['manifest'])
        again=f.pgimport.import_root(self.root,self.sink())
        self.assertTrue(all(v['action']=='already_imported' for v in again['orgs'].values()))
        self.assertEqual(f.tree_digest(self.orgs()),before)

    def test_duplicate_slugs_refuse_before_sink_write(self):
        self.populate()
        path=self.orgs()/'beta.json'; doc=json.loads(path.read_text());doc['work_items'].append(doc['work_items'][0]);path.write_text(json.dumps(doc))
        sink=self.sink()
        with self.assertRaisesRegex(f.ImportRefused,'duplicate'):
            f.pgimport.import_root(self.root,sink)
        self.assertIsNone(sink.recorded('acme'))

    def test_missing_item_readback_refuses_marker(self):
        self.populate(); sink=self.sink(); original=sink.read_org; fired=[]
        def corrupted(slug):
            value=original(slug)
            value['doc']=[row for row in value['doc'] if row[0]!=workrows.PREFIX+'one']
            fired.append(slug); return value
        sink.read_org=corrupted
        with self.assertRaisesRegex(f.ImportRefused,'read-back'):
            f.pgimport.import_root(self.root,sink)
        self.assertEqual(fired,['acme']); self.assertEqual(sink.finished,[])


class RealWorkImport(f.Base):
    @unittest.skipUnless(__import__('os').environ.get('ORGTREE_TEST_PG_ADMIN_URL'), 'disposable PG required: NOT RUN')
    def test_real_copy_both_sources_checksums_stamp_and_resume(self):
        import os
        import psycopg
        from urllib.parse import urlsplit,urlunsplit
        admin=os.environ['ORGTREE_TEST_PG_ADMIN_URL']; name='work_import_'+str(os.getpid())
        url=urlsplit(admin); target=urlunsplit((url.scheme,url.netloc,'/'+name,url.query,url.fragment))
        with psycopg.connect(admin,autocommit=True) as c: c.execute('CREATE DATABASE '+name)
        sink=None
        try:
            doc=f.sample_doc();doc['work_items']=items();f.write_db(self.orgs()/'acme.db',doc)
            doc=f.sample_doc('Beta');doc['work_items']=items();(self.orgs()/'beta.json').write_text(json.dumps(doc))
            before={p.name:p.read_bytes() for p in self.orgs().iterdir()}
            sink=f.pgimport.PgSink(target,self.orgs())
            result=f.pgimport.import_root(self.root,sink)
            for slug in ('acme','beta'):
                self.assertEqual(result['orgs'][slug]['work_items'],workrows.checksum(items()))
                rows=dict(sink.read_org(slug)['doc'])
                self.assertEqual(workrows.assemble({k:v for k,v in rows.items() if k=='work_items' or k.startswith(workrows.PREFIX)}),items())
                rev,stamp=sink.conn.execute('SELECT revision,work_revision FROM public.orgs WHERE slug=%s',(slug,)).fetchone()
                self.assertGreater(rev,0);self.assertEqual(stamp,rev)
                self.assertTrue((self.orgs()/(slug+'.pg')).exists())
            again=f.pgimport.import_root(self.root,sink)
            self.assertTrue(all(v['action']=='already_imported' for v in again['orgs'].values()))
            for name_,raw in before.items(): self.assertEqual((self.orgs()/name_).read_bytes(),raw)
        finally:
            if sink: sink.close()
            with psycopg.connect(admin,autocommit=True) as c: c.execute('DROP DATABASE '+name+' WITH (FORCE)')


if __name__=='__main__': unittest.main()
