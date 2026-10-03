"""The runtime's registry module, orgdb.registry (design §2.11, §2.13).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module creates is named
                               with its own prefix t<pid>_ and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves:
  * the registry reads, as the runtime role: every row in any state, lookup (trashed aside),
    exists, active orgs by slug;
  * connection(slug): a runtime connection to that org's own database; a transaction the
    caller leaves open is rolled back; a missing or unavailable org is refused;
  * identity on every checkout (review f22), with no private state cleared by the test: after
    a warm open, a database whose identity changed is refused (idle connection or fresh), a
    database renamed under the org's name is refused, a connection the server terminated is
    replaced transparently and the replacement is checked too; a refused one is never pooled;
  * the idle pool keeps at most 2 per database and closes a connection idle past its limit;
  * lifecycle(): bootstrapped once, with the runtime role the engine's conninfo logs in as;
  * retry(): an org unavailable at 'identity' is retried in place and becomes active; an org
    another operation holds is Busy before anything runs; an active org is refused.

Run:  python tools/run-python-verification.py tests/test_orgdb_registry_pg.py
"""

import os
import time
import unittest
from unittest import mock

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX
if RUNTIME:
    os.environ['ORGTREE_PG_URL'] = RUNTIME          # the engine's runtime conninfo
os.environ.pop('ORGTREE_PG_CONNINFO', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import conn, lifecycle, names, registry  # noqa: E402

needs_pg = unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and '
                                                  'ORGTREE_TEST_PG_RUNTIME_URL')


def _drop_all() -> None:
    from psycopg import sql
    registry.close_idle()
    registry.close_registry()
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


@needs_pg
class Registry(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _drop_all()
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX,
                                     build='test-build')
        cls.lc.bootstrap()
        cls.a = cls.lc.create_org('a')
        cls.b = cls.lc.create_org('b')
        cls.gone = cls.lc.register_org('gone', state='unavailable', unavailable_step='conversion',
                                       state_reason='planted')

    def setUp(self) -> None:
        p = mock.patch.object(registry, '_lc', [self.lc])
        p.start()
        self.addCleanup(p.stop)

    def admin_exec(self, org_id: int, statement: str) -> None:
        with conn.connect(ADMIN, self.lc.row(org_id)['database']) as c:
            c.execute(statement)

    def test_reads(self) -> None:
        rows = registry.rows()
        self.assertEqual([r['slug'] for r in rows], ['a', 'b', 'gone'])
        self.assertEqual(rows[2]['state'], 'unavailable')
        self.assertEqual(rows[2]['unavailable_step'], 'conversion')
        self.assertEqual(rows[2]['state_reason'], 'planted')
        org_id, db, state, uuid = registry.lookup('a')
        self.assertEqual((org_id, db, state), (self.a, names.org(self.a, PREFIX), 'active'))
        self.assertEqual(uuid, str(self.lc.row(self.a)['org_uuid']))
        self.assertIsNone(registry.lookup('never'))
        self.assertTrue(registry.exists('a'))
        self.assertFalse(registry.exists('gone'))
        self.assertEqual([s for s, _, _, _ in registry.active()], ['a', 'b'])
        self.assertEqual(registry.active_slugs(), ['a', 'b'])
        # the registry is read as the runtime role, which cannot write it
        import psycopg
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            registry.query("UPDATE orgtree.orgs SET state_reason = 'x'")

    def test_connection(self) -> None:
        with registry.connection('a') as c:
            self.assertEqual(c.execute('SELECT current_user').fetchone()[0], conn.role_of(RUNTIME))
            self.assertEqual(c.execute('SELECT slug FROM orgtree.org_identity').fetchone()[0], 'a')
            before = c.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
            c.execute('BEGIN')
            c.execute('UPDATE orgtree.org_revision SET rev = rev + 1')
        with registry.connection('a') as c:             # the open transaction was rolled back
            self.assertEqual(c.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0], before)
        for slug in ('gone', 'never'):
            with self.assertRaises(registry.OrgUnavailable):
                with registry.connection(slug):
                    pass

    def slug_of(self, slug: str) -> str:
        with registry.connection(slug) as c:
            return c.execute('SELECT slug FROM orgtree.org_identity').fetchone()[0]

    def terminate(self, pid: int) -> None:
        """The server ends one session; returns once it is gone."""
        with conn.connect(ADMIN, 'postgres') as c:
            c.execute('SELECT pg_terminate_backend(%s)', (pid,))
            end = time.monotonic() + 15
            while c.execute('SELECT 1 FROM pg_stat_activity WHERE pid = %s', (pid,)).fetchone():
                self.assertLess(time.monotonic(), end, f'session {pid} never ended')
                time.sleep(0.05)

    def test_a_database_holding_another_identity_is_refused_after_a_warm_open(self) -> None:
        db = self.lc.row(self.b)['database']
        self.assertEqual(self.slug_of('b'), 'b')          # warm: checked, and left idle
        self.assertTrue(registry._idle.get(db))
        self.admin_exec(self.b, "UPDATE orgtree.org_identity SET slug = 'someone-else'")
        try:
            with self.assertRaises(registry.OrgUnavailable):       # the idle one is rechecked
                with registry.connection('b'):
                    pass
            self.assertEqual(registry._idle.get(db, []), [])        # and never pooled again
            with self.assertRaises(registry.OrgUnavailable):       # a fresh open is checked
                with registry.connection('b'):
                    pass
            self.assertEqual(registry._idle.get(db, []), [])
        finally:
            self.admin_exec(self.b, "UPDATE orgtree.org_identity SET slug = 'b'")
        self.assertEqual(self.slug_of('b'), 'b')

    def test_another_orgs_database_renamed_under_the_name_is_refused_after_a_warm_open(self) -> None:
        from psycopg import sql
        a_db, b_db = self.lc.row(self.a)['database'], self.lc.row(self.b)['database']
        self.assertEqual(self.slug_of('a'), 'a')          # warm
        registry.close_idle()                             # a rename needs the database unused
        spare = PREFIX + 'spare'

        def rename(old: str, new: str) -> None:
            with conn.connect(ADMIN, 'postgres') as c:
                c.execute(sql.SQL('ALTER DATABASE {} RENAME TO {}').format(
                    sql.Identifier(old), sql.Identifier(new)))
        rename(a_db, spare)
        rename(b_db, a_db)                                # b's database now answers to a's name
        try:
            with self.assertRaises(registry.OrgUnavailable):
                with registry.connection('a'):
                    pass
        finally:
            registry.close_idle()
            rename(a_db, b_db)
            rename(spare, a_db)
        self.assertEqual(self.slug_of('a'), 'a')
        self.assertEqual(self.slug_of('b'), 'b')

    def test_a_terminated_connection_is_replaced_and_the_replacement_is_checked(self) -> None:
        db = self.lc.row(self.b)['database']
        registry.close_idle(db)
        with registry.connection('b') as c:
            first = c.info.backend_pid
        self.terminate(first)                             # the server drops it while idle
        with registry.connection('b') as c:               # replaced, transparently
            second = c.info.backend_pid
            self.assertEqual(c.execute('SELECT slug FROM orgtree.org_identity').fetchone()[0], 'b')
        self.assertNotEqual(second, first)
        self.terminate(second)
        self.admin_exec(self.b, "UPDATE orgtree.org_identity SET slug = 'someone-else'")
        try:
            with self.assertRaises(registry.OrgUnavailable):       # the reconnect is checked
                with registry.connection('b'):
                    pass
            self.assertEqual(registry._idle.get(db, []), [])
        finally:
            self.admin_exec(self.b, "UPDATE orgtree.org_identity SET slug = 'b'")
        self.assertEqual(self.slug_of('b'), 'b')

    def test_idle_pool_bounds_and_expiry(self) -> None:
        db = self.lc.row(self.a)['database']
        registry.close_idle()
        uuid = str(self.lc.row(self.a)['org_uuid'])
        held = [registry.checkout('a', db, uuid) for _ in range(3)]
        for raw in held:
            registry.release(raw, db)
        self.assertEqual(len(registry._idle[db]), registry.IDLE_PER_DB)
        self.assertTrue(held[2].closed)                  # the third had no room
        kept = [raw for raw, _ in registry._idle[db]]
        with mock.patch.object(registry, 'IDLE_SECONDS', 0.0):
            fresh = registry.checkout('a', db, uuid)     # every idle one is past the limit
        self.assertTrue(all(raw.closed for raw in kept))
        self.assertNotIn(fresh, kept)
        registry.release(fresh, db)

    def test_lifecycle_is_bootstrapped_once_with_the_engines_runtime_role(self) -> None:
        with mock.patch.object(registry, '_lc', []), \
                mock.patch.dict(os.environ, {lifecycle.ADMIN_ENV: ADMIN}):
            first = registry.lifecycle()
            self.assertIs(registry.lifecycle(), first)
            self.assertEqual(first.runtime_role, conn.role_of(RUNTIME))
            self.assertIsNotNone(first.instance_id)

    def test_retry_in_place_busy_and_refused(self) -> None:
        self.admin_exec(self.a, "UPDATE orgtree.org_identity SET slug = 'someone-else'")
        self.assertFalse(self.lc.check_identity(self.a))
        self.admin_exec(self.a, "UPDATE orgtree.org_identity SET slug = 'a'")
        # another operation holds it: Busy before anything runs
        other = self.lc.claim(self.a, 'retry')
        with mock.patch.object(lifecycle.Lifecycle, 'retry_in_place') as ran:
            with self.assertRaises(lifecycle.Busy):
                registry.retry(self.a)
        ran.assert_not_called()
        self.lc.abandon(other, step='identity', reason='given back')
        out = registry.retry(self.a)
        self.assertEqual((out['org_id'], out['outcome'], out['reason']), (self.a, 'active', ''))
        with registry.connection('a') as c:              # unfenced again
            self.assertEqual(c.execute('SELECT slug FROM orgtree.org_identity').fetchone()[0], 'a')
        with self.assertRaises(lifecycle.LifecycleError):
            registry.retry(self.a)                       # active: nothing to retry


if __name__ == '__main__':
    unittest.main()
