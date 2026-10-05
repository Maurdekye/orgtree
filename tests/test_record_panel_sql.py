"""Panel migration composition keeps prior capture and the frozen core intact."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from pathlib import Path
import unittest

from orgtree.orgdb import record_derivations as D, record_sql as S
from orgtree.orgdb import record_panel_sql as P, record_panels


class Composition(unittest.TestCase):
    def test_panel_migration_is_exact_and_all_changes_inserts_name_owned_columns(self):
        path = Path(__file__).resolve().parents[1]/'engine/backend/orgtree/pg_migrations/org/0019_record_panels.sql'
        sql = P.migration_sql((),record_panels.EXTENSIONS)
        self.assertEqual(path.read_text(encoding='utf-8'), sql)
        self.assertNotIn('INSERT INTO orgtree.changes VALUES', sql)
        self.assertIn('event_refs_record_window', sql)
        self.assertIn('user_mail_log_record_window', sql)
        import test_orgdb_lock_order as locks
        self.assertEqual(locks.violations(locks._migrations()), [])

    def test_frozen_migration_stays_byte_equivalent(self):
        path = Path(__file__).resolve().parents[1]/'engine/backend/orgtree/pg_migrations/org/0018_records.sql'
        self.assertEqual(path.read_text(encoding='utf-8'),S.migration_sql())

    def test_second_panel_preserves_first_window_and_shared_source_dependencies(self):
        def more(base):
            result = dict(base)
            result['events'] = D.Source((*result['events'].names,D.scope('gallery','r.id')))
            return result
        gallery = P.Extension('gallery',more,(D.Window('gallery',10,(
            D.Stream('documents',"'shared'",'r.id::text',('r.id',)),)),))
        previous = record_panels.EXTENSIONS
        current = (*previous,gallery)
        sql = P.migration_sql(previous,current)
        for name in ('event','user_mail_log','user_outbox','gallery'):
            self.assertIn('window:'+name+':',sql)
        source = P.sources(current)['events']
        self.assertIn(D.Name("'org'","'events_count'"),source.names)
        self.assertIn(D.scope('gallery','r.id'),source.names)
        self.assertIn("'event:'", D.capture_function('events',source))
        self.assertEqual(D.capture_violations(sql.replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION')),[])

    def test_extensions_cannot_duplicate_or_drop_predecessors(self):
        extensions = record_panels.EXTENSIONS
        with self.assertRaisesRegex(ValueError,'duplicate'):
            P.sources(extensions*2)
        with self.assertRaisesRegex(ValueError,'cannot drop'):
            P.migration_sql(extensions,())

    def test_shared_registration_keeps_existing_org_groups(self):
        from orgtree.orgdb.record_registry import Registry, Entity, Selection
        from orgtree.orgdb import record_shared_panels
        registry = Registry()
        registry.register(Entity('org',lambda s,q:frozenset(('settings',)),
            lambda s,ids:{key:{'existing':True} for key in ids}))
        record_shared_panels.register(registry)
        self.assertEqual(registry.entities['org'].members(None,Selection()),
            frozenset(('settings','events_count')))
        self.assertEqual(registry.bodies(None,'org',frozenset(('settings',))),
            {'settings':{'existing':True}})


if __name__ == '__main__':
    unittest.main()
