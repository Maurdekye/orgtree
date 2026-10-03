"""Native account transactions. Creates databases: take the heavy P03 lock."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import asyncio
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from orgtree import registry, registry_migration
from orgtree.orgdb import accounts, conn, lifecycle, mappers, sections
from orgtree.orgdb.convert import rowio
import child_python

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f'wa{os.getpid()}_'


@unittest.skipUnless(ADMIN and RUNTIME, 'disposable runtime/admin PG required; skip is not a pass')
class NativeAccounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = patch.dict(os.environ, {'ORGTREE_ORGDB_PREFIX': PREFIX,
                                        'ORGTREE_PG_CONNINFO': RUNTIME,
                                        'ORGTREE_STORAGE': 'orgdb'})
        cls.env.start()
        cls.addClassCleanup(cls.env.stop)
        cls.root = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.root.cleanup)
        cls.rollback_file = Path(cls.root.name) / 'accounts-registry.json'
        cls.rollback_file.write_bytes(b'poison rollback copy')
        cls.path_patch = patch.object(registry, 'registry_path', return_value=str(cls.rollback_file))
        cls.path_patch.start()
        cls.addClassCleanup(cls.path_patch.stop)
        from orgtree.orgdb import registry as org_registry
        cls.org_registry = org_registry
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build='test')
        cls.lc.bootstrap()
        cls.addClassCleanup(cls.drop_databases)
        for slug in ('a5-b', 'a5-a'):
            oid = cls.lc.register_org(slug, state='converting')
            build = cls.lc.open_build(oid, 'convert')
            rows, _, _ = sections.encode_document({'slug': slug, 'nodes': {}}, mappers.sections(),
                                                  ignored=mappers.ignored_keys())
            with conn.connect(RUNTIME, build.database, autocommit=False) as raw:
                rowio.write(raw, rows)
            cls.lc.mark_filled(build)
            cls.lc.publish(build)
        cls.lc.register_org('a5-held', state='unavailable', unavailable_step='conversion',
                            state_reason='Bad record')

    @classmethod
    def drop_databases(cls):
        from psycopg import sql
        cls.org_registry.close_idle()
        cls.org_registry.close_registry()
        with conn.connect(ADMIN, 'postgres') as raw:
            dbs = raw.execute('SELECT datname FROM pg_database WHERE left(datname, %s) = %s',
                              (len(PREFIX), PREFIX)).fetchall()
            for (db,) in dbs:
                raw.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))

    def make(self, org=None, mode='subscription'):
        credential = {'kind': 'apikey', 'token_ref': 'test-ref'} if mode == 'apikey' else {
            'kind': 'managed', 'path': 'test-profile'}
        return registry.create_account('claude', '', credential, origin_org=org, mode=mode)

    def test_json_is_never_read_or_written(self):
        with patch.object(registry, 'registry_path', side_effect=AssertionError('JSON opened')):
            row = self.make()
            registry.set_auth(row['id'], 'authenticated')
            self.assertEqual(registry.get_account(row['id'])['auth'], 'authenticated')
            registry.load(strict=True)
            self.assertTrue(registry.remove_account(row['id']))
            with self.assertRaises(registry.RegistryUnreadable):
                registry.save(registry._blank())
        self.assertEqual(self.rollback_file.read_bytes(), b'poison rollback copy')

    def test_scoped_reads_and_machine_then_org_order(self):
        machine, b, a = self.make(), self.make('a5-b'), self.make('a5-a')
        wanted = {r['id'] for r in (machine, b, a)}
        self.assertEqual([r['id'] for r in registry.list_accounts() if r['id'] in wanted],
                         [machine['id'], a['id'], b['id']])
        self.assertEqual([r['id'] for r in registry.list_accounts('a5-a') if r['id'] in wanted],
                         [machine['id'], a['id']])
        with self.assertRaises(registry.UnknownAccount):
            registry.get_account(b['id'], org='a5-a')
        self.assertEqual(registry.get_account(a['id'], org='a5-a')['origin_org'], 'a5-a')
        self.assertEqual(registry.list_accounts('a5-held'), registry.list_accounts('missing'))

    def test_typed_columns_and_only_target_account_changes(self):
        row, other = self.make(mode='apikey'), self.make()
        with accounts.connection() as raw:
            before = raw.execute('SELECT row_version FROM orgtree.accounts WHERE id = %s',
                                  (other['id'],)).fetchone()[0]
        registry.set_auth(row['id'], 'authenticated')
        registry.set_identity(row['id'], {'email': 'a@example.test'})
        registry.set_enabled(row['id'], False)
        registry.add_spend(row['id'], 0.25, now=123.5)
        registry.record_mark(row['id'], 'opus', 9999999999, now=123.5)
        with accounts.connection() as raw:
            got = raw.execute('SELECT auth, enabled, credential_kind, extra FROM orgtree.accounts WHERE id = %s',
                               (row['id'],)).fetchone()
            self.assertEqual(got, ('authenticated', False, 'apikey', None))
            self.assertEqual(raw.execute('SELECT usd_total, turns FROM orgtree.account_spend WHERE account_id = %s',
                                         (row['id'],)).fetchone(), (0.25, 1))
            self.assertEqual(raw.execute('SELECT row_version FROM orgtree.accounts WHERE id = %s',
                                         (other['id'],)).fetchone()[0], before)

    def test_accounts_api_keeps_keys_and_requested_org_filter(self):
        from orgtree import api, accountusage
        machine, own, other = self.make(), self.make('a5-a'), self.make('a5-b')
        wanted = {r['id'] for r in (machine, own, other)}
        with patch.object(registry_migration, 'observe_ambient', return_value={}), \
             patch.object(accountusage, 'host_identities', return_value={}):
            result = asyncio.run(api.accounts_list('a5-a'))
        self.assertEqual(set(result), {'accounts', 'primary', 'host_identity'})
        self.assertEqual([r['id'] for r in result['accounts'] if r['id'] in wanted],
                         [machine['id'], own['id']])

    def test_marks_clear_cas_and_audit_are_atomic(self):
        row = self.make()
        until = time.time() + 10000
        registry.record_mark(row['id'], 'opus', until)
        expected = registry.describe_marks(row['id'])[0]['expected']
        mismatch = {**expected, 'until': until + 1}
        self.assertEqual(registry.clear_mark(row['id'], 'pooled', mismatch, actor='a', via='test')['result'], 'changed')
        self.assertEqual(registry.clear_mark(row['id'], 'pooled', expected, actor='a', via='test')['result'], 'cleared')
        self.assertEqual(registry.get_account(row['id'])['marks'], {})
        audit = [r for r in registry.load()['mark_audit'] if r['account'] == row['id']]
        self.assertEqual(len(audit), 1)
        self.assertIn('fable', audit[0]['cleared'])

    def test_correction_and_expiration_preserve_unrelated_marks(self):
        row = self.make()
        until = time.time() + 10000
        registry.record_mark(row['id'], 'opus', until)
        self.assertTrue(registry.correct_mark(row['id'], 'opus', until, until + 10, provenance='observed'))
        self.assertFalse(registry.correct_mark(row['id'], 'opus', until, until + 20, provenance='observed'))
        registry.record_mark(row['id'], 'other', until + 100)
        registry.clear_expired(until + 20)
        self.assertEqual(set(registry.get_account(row['id'])['marks']), {'other'})

    def test_restricted_alias_and_clear_audit_stay_in_org_database(self):
        row = self.make('a5-a')
        with registry.transaction(row['id'], org='a5-a') as doc:
            doc['aliases']['private-alias'] = row['id']
        self.assertEqual(registry.resolve_alias('private-alias', org='a5-a'), row['id'])
        self.assertEqual(registry.resolve_alias('private-alias', org='a5-b'), 'private-alias')
        registry.record_mark(row['id'], 'opus', time.time() + 10000)
        fp = registry.describe_marks(row['id'])[0]['expected']
        registry.clear_mark(row['id'], 'pooled', fp, actor='a', via='test', org='a5-a')
        with accounts.connection() as raw:
            for table, col in (('accounts', 'id'), ('account_aliases', 'account_id'), ('account_mark_audit', 'account')):
                self.assertEqual(raw.execute(f'SELECT count(*) FROM orgtree.{table} WHERE {col} = %s',
                                             (row['id'],)).fetchone()[0], 0)
        self.assertTrue(registry.remove_account(row['id']))
        self.assertEqual(registry.resolve_alias('private-alias', org='a5-a'), 'private-alias')

    def test_failed_restricted_creation_burns_id_without_fallback(self):
        before = self.make()
        with self.assertRaises(self.org_registry.OrgUnavailable):
            self.make('a5-held')
        after = self.make()
        self.assertEqual(int(after['id'].split('-')[-1]), int(before['id'].split('-')[-1]) + 2)
        self.assertEqual(self.rollback_file.read_bytes(), b'poison rollback copy')

    def test_app_transaction_refuses_restricted_rows_and_aliases(self):
        row = self.make('a5-a')
        with self.assertRaises(ValueError):
            with registry.transaction() as doc:
                doc['aliases']['leaked-alias'] = row['id']
        with self.assertRaises(ValueError):
            with registry.transaction() as doc:
                doc['accounts'].append({**row, 'id': 'must-not-leak'})
        with accounts.connection() as raw:
            self.assertEqual(raw.execute("SELECT count(*) FROM orgtree.account_aliases WHERE alias = 'leaked-alias'").fetchone()[0], 0)
            self.assertEqual(raw.execute("SELECT count(*) FROM orgtree.accounts WHERE id = 'must-not-leak'").fetchone()[0], 0)

    def test_exception_and_secret_rejection_roll_back_without_notification(self):
        row = self.make()
        before = copy.deepcopy(registry.get_account(row['id']))
        with patch.object(registry, 'availability_changed') as changed:
            with self.assertRaises(ValueError):
                with registry.transaction(row['id']) as doc:
                    doc['accounts'][0]['auth'] = 'authenticated'
                    raise ValueError('refuse')
            with self.assertRaises(ValueError):
                registry.set_identity(row['id'], {'access_token': 'secret'})
        changed.assert_not_called()
        self.assertEqual(registry.get_account(row['id']), before)

    def test_invalidation_happens_once_after_commit(self):
        row = self.make()
        observed = []
        with patch.object(registry, 'availability_changed', side_effect=lambda reason: observed.append(
                registry.get_account(row['id'])['auth'])):
            registry.set_auth(row['id'], 'authenticated')
        self.assertEqual(observed, ['authenticated'])

    def test_metadata_migration_and_alias_are_database_writes(self):
        row = self.make()
        registry_migration.mark_migrated(123.5)
        with registry.transaction() as doc:
            doc['aliases']['primary'] = row['id']
            doc['apikey_cutover_at'] = 456.25
            doc[registry_migration.FORMER_SANDBOX_MARKER] = 789.5
        loaded = registry.load()
        self.assertEqual(loaded['migrated_at'], 123.5)
        self.assertEqual(loaded['apikey_cutover_at'], 456.25)
        self.assertEqual(loaded[registry_migration.FORMER_SANDBOX_MARKER], 789.5)
        self.assertEqual(registry.resolve_alias('primary'), row['id'])

    def test_sparse_values_round_trip_during_unrelated_change(self):
        row = self.make()
        with registry.transaction(row['id']) as doc:
            r = doc['accounts'][0]
            r['identity'] = None
            r['mode'] = None
            r['legacy_note'] = {'nested': [None, 'kept']}
        before = registry.get_account(row['id'])
        registry.set_auth(row['id'], 'authenticated')
        after = registry.get_account(row['id'])
        self.assertEqual({k: v for k, v in after.items() if k != 'auth'},
                         {k: v for k, v in before.items() if k != 'auth'})

    def test_processes_accumulate_spend_and_allocate_unique_ids(self):
        row = self.make(mode='apikey')
        worker = Path(__file__).with_name('orgdb_account_worker.py')
        barrier = Path(self.root.name) / ('go-' + str(time.time_ns()))
        env = dict(os.environ)
        processes = [subprocess.Popen(child_python.argv(str(worker), row['id'], str(barrier)),
                                      env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)) for _ in range(3)]
        try:
            barrier.touch()
            for process in processes:
                stdout, stderr = process.communicate(timeout=90)
                self.assertEqual(process.returncode, 0, stderr.decode('utf-8', errors='replace'))
            spent = registry.get_account(row['id'])['spend']
            self.assertEqual((spent['turns'], spent['usd_total']), (30, 7.5))
            with accounts.connection() as raw:
                ids = [r[0] for r in raw.execute("SELECT id FROM orgtree.accounts WHERE registered_from = 'concurrent-a5'").fetchall()]
            self.assertEqual(len(ids), 9)
            self.assertEqual(len(set(ids)), 9)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)


if __name__ == '__main__':
    unittest.main()
