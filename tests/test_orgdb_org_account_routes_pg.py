"""Real runtime-registry fan-out. Creates org databases: take the HEAVY P03 lock."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import os
import unittest
from unittest.mock import patch

from orgtree import api, ledger
from orgtree.orgdb import conn, lifecycle, mappers, sections
from orgtree.orgdb.convert import rowio

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f'wu{os.getpid()}_'


@unittest.skipUnless(ADMIN and RUNTIME, 'disposable runtime/admin PostgreSQL required; skip is not a pass')
class RuntimeOrgLists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = patch.dict(os.environ, {'ORGTREE_ORGDB_PREFIX': PREFIX,
                                        'ORGTREE_PG_CONNINFO': RUNTIME,
                                        'ORGTREE_STORAGE': 'orgdb'})
        cls.env.start()
        cls.addClassCleanup(cls.env.stop)
        # Only the landed runtime registry is imported here. No replacement registry
        # is injected: these checks exercise its real pool and identity boundary.
        from orgtree.orgdb import registry as org_registry
        cls.registry = org_registry
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build='test')
        cls.lc.bootstrap()
        lc_patch = patch.object(cls.registry, '_lc', [cls.lc])
        lc_patch.start()
        cls.addClassCleanup(lc_patch.stop)
        cls.addClassCleanup(cls.drop_databases)
        cls.docs = []
        cls.ids = []
        for n in range(2):
            slug = f'api-org-{n}'
            org_id = cls.lc.register_org(slug, state='converting')
            build = cls.lc.open_build(org_id, 'convert')
            doc = dict(slug=slug, name=f'Organization {n}', created='2026-01-01T00:00:00.000Z',
                       deleted_cost_usd=0.12345, net_identity={'slug': f'public-{n}'}, nodes={
                           'live': dict(state='live', account='machine', cost_usd=0.10005),
                           'bearer@0': dict(state='archived', account='machine', cost_usd=0.10005),
                           'missing': dict(state='live', account='missing:openai', cost_usd=0.10005)})
            rows, _, _ = sections.encode_document(doc, mappers.sections(), ignored=mappers.ignored_keys())
            with conn.connect(RUNTIME, build.database, autocommit=False) as c:
                rowio.write(c, rows)
                c.commit()
            cls.lc.mark_filled(build)
            cls.lc.publish(build)
            cls.docs.append(doc)
            cls.ids.append(org_id)
        cls.held_id = cls.lc.register_org('held-api', state='unavailable',
                                        unavailable_step='conversion', state_reason='Bad record')

    @classmethod
    def drop_databases(cls):
        from psycopg import sql
        cls.registry.close_idle()
        cls.registry.close_registry()
        with conn.connect(ADMIN, 'postgres') as c:
            for (db,) in c.execute('SELECT datname FROM pg_database WHERE left(datname, %s) = %s',
                                   (len(PREFIX), PREFIX)).fetchall():
                c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))

    def test_available_and_unavailable_rows_match_current_api_meanings(self):
        with patch.object(api.supervisor, 'working_count', return_value=0):
            rows = api.orgs_list(None)
        self.assertEqual(len(rows), 3)
        for row, doc in zip(rows, self.docs):
            self.assertEqual(row['name'], doc['name'])
            self.assertEqual(row['created'], doc['created'])
            self.assertEqual((row['nodes'], row['live']), (3, 2))
            self.assertEqual(row['cost_usd_total'], ledger.Org(doc).cost_total())
        self.assertEqual(rows[-1]['state'], 'unavailable')
        self.assertEqual(rows[-1]['state_reason'], 'Bad record')
        self.assertEqual(rows[-1]['nodes'], 0)

    def test_bindings_fan_out_and_include_archived_without_loading_documents(self):
        from orgtree import store
        with patch.object(store, 'load_org', side_effect=AssertionError('whole-org load')):
            bindings = api._account_bindings()
        self.assertEqual(bindings, {'machine': [
            {'org': f'api-org-{n}', 'node': node, 'state': state}
            for n in range(2) for node, state in [('live', 'live'), ('bearer@0', 'archived')]]})

    def test_retry_refusal_keeps_unavailable_registry_reason(self):
        # A real lifecycle Busy guard; the endpoint itself never edits lifecycle state.
        claim = self.lc.claim(self.held_id, 'retry')
        try:
            with self.assertRaises(api.HTTPException) as e:
                asyncio.run(api.orgs_retry('held-api'))
            self.assertEqual(e.exception.status_code, 409)
            self.assertEqual(self.lc.row(self.held_id)['state_reason'], 'Bad record')
        finally:
            self.lc.abandon(claim, step='conversion', reason='Bad record')

    def set_identity_slug(self, slug):
        with conn.connect(ADMIN, self.lc.row(self.ids[0])['database']) as c:
            c.execute('UPDATE orgtree.org_identity SET slug = %s', (slug,))

    def test_retry_success_uses_real_runtime_service_and_makes_org_normal(self):
        self.set_identity_slug('wrong-identity')
        try:
            self.assertFalse(self.lc.check_identity(self.ids[0]))
            self.set_identity_slug('api-org-0')
            result = asyncio.run(api.orgs_retry('api-org-0'))
            self.assertEqual(result['state'], 'active')
            self.assertEqual(result['name'], self.docs[0]['name'])
            self.assertEqual(result['nodes'], 3)
        finally:
            self.set_identity_slug('api-org-0')
            if self.lc.row(self.ids[0])['state'] == 'unavailable':
                self.lc.retry_in_place(self.ids[0])

    def test_retry_failure_uses_real_service_and_returns_new_reason(self):
        self.set_identity_slug('wrong-identity')
        try:
            self.assertFalse(self.lc.check_identity(self.ids[0]))
            before = self.lc.row(self.ids[0])['state_reason']
            result = asyncio.run(api.orgs_retry('api-org-0'))
            self.assertEqual(result['state'], 'unavailable')
            self.assertNotEqual(result['state_reason'], before)
            self.assertIn('org_identity does not match', result['state_reason'])
            self.assertEqual(result['nodes'], 0)
        finally:
            self.set_identity_slug('api-org-0')
            if self.lc.row(self.ids[0])['state'] == 'unavailable':
                self.lc.retry_in_place(self.ids[0])


if __name__ == '__main__':
    unittest.main()
