"""The org lifecycle of the one-database-per-org layout (design §2.12–2.13).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module
                               creates is named with its own prefix t<pid>_
                               and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves:
  * bootstrap: the app database is created and migrated once; the runtime
    role reads the registry and cannot write it;
  * create: published last, under its final name, with org_identity; the
    runtime cannot write org_identity and cannot reach a staging database;
  * claims: a second operation on a claimed org is Busy;
  * a crash after every create step, the rename included, is finished by the
    next host; no staging database is left behind;
  * a stale claim never drops a newer attempt's or the active database;
  * builds: fill as the runtime, publish; abandon leaves the org unavailable
    with its reason; a build renamed before a crash is only published; a
    resumed build is redone in a new staging database; a legacy trashed org is
    published under its trash name, fenced, and its slug is free again;
  * migrations: a partly migrated set is finished; a failing file makes only
    that org unavailable (rolled back, fenced) and Retry recovers it; an org
    newer than the build is unavailable; a newer app database refuses;
  * identity: a mismatch makes the org unavailable and fenced;
  * a Retry claims only while the org is still unavailable at a step it may
    retry: one that read the row before another Retry made the org active is
    refused and changes nothing; a held org is Busy.

Run:  python tools/run-python-verification.py tests/test_orgdb_lifecycle_pg.py
"""

import datetime
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import conn, lifecycle, migrate, names  # noqa: E402

needs_pg = unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and '
                                                  'ORGTREE_TEST_PG_RUNTIME_URL')


def _prefixed() -> list[str]:
    with conn.connect(ADMIN, 'postgres') as c:
        return sorted(r[0] for r in c.execute(
            "SELECT datname FROM pg_database WHERE datname LIKE %s", (PREFIX + '%',)).fetchall())


def _drop_all() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for db in _prefixed():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


class Crash(Exception):
    """A simulated host crash at a chosen step."""


def crashing_step(at: str, *, before: bool = False):
    """A Lifecycle._step that crashes right after recording ``at`` (or right
    before recording it, when the work of that step is already done)."""
    original = lifecycle.Lifecycle._step

    def step(self, claim, name, **cols):
        if before and name == at:
            raise Crash(name)
        original(self, claim, name, **cols)
        if not before and name == at:
            raise Crash(name)
    return step


@needs_pg
class Base(unittest.TestCase):
    def setUp(self) -> None:
        _drop_all()
        self.lc = self.host()

    def host(self) -> lifecycle.Lifecycle:
        """A fresh engine host (a new engine instance), bootstrapped."""
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX,
                                 build='test-build')
        lc.bootstrap()
        return lc

    def stages(self) -> list[str]:
        return [d for d in _prefixed() if names.kind(d, PREFIX) == 'stage']

    def runtime(self, db: str):
        return conn.connect(RUNTIME, db)

    def assert_runtime_refused(self, db: str) -> None:
        import psycopg
        with self.assertRaises(psycopg.OperationalError):
            self.runtime(db).close()


class Bootstrap(Base):
    def test_bootstrap_once_and_runtime_rights(self) -> None:
        import psycopg
        again = self.host()
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            self.assertEqual(migrate.state(c, migrate.APP_DIR),
                             {'pending': [], 'ahead': [], 'drift': []})
        self.assertNotEqual(again.instance_id, self.lc.instance_id)
        with self.runtime(names.app(PREFIX)) as r:
            self.assertEqual(r.execute('SELECT count(*) FROM orgs').fetchone()[0], 0)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                r.execute("INSERT INTO orgs (slug, org_uuid, database, state) "
                          "VALUES ('x', gen_random_uuid(), 'x', 'active')")

    def test_unnamed_staging_database_is_swept(self) -> None:
        stray = names.stage(99, 1, PREFIX)
        self.lc._create_db(stray)
        self.assertIn(stray, self.stages())
        self.host()
        self.assertEqual(self.stages(), [])


class Create(Base):
    def test_create_publishes_last(self) -> None:
        import psycopg
        org_id = self.lc.create_org('alpha')
        row = self.lc.row(org_id)
        self.assertEqual(row['state'], 'active')
        self.assertIsNone(row['op_kind'])
        self.assertEqual(row['database'], names.org(org_id, PREFIX))
        self.assertEqual(self.stages(), [])
        with self.runtime(row['database']) as r:
            self.assertEqual(r.execute('SHOW search_path').fetchone()[0], 'orgtree')
            uuid_, slug = r.execute('SELECT org_uuid::text, slug FROM org_identity').fetchone()
            self.assertEqual((uuid_, slug), (str(row['org_uuid']), 'alpha'))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                r.execute("UPDATE org_identity SET slug = 'other'")

    def test_duplicate_slug_refused(self) -> None:
        self.lc.create_org('alpha')
        with self.assertRaises(lifecycle.LifecycleError):
            self.lc.create_org('alpha')

    def test_second_claim_is_busy(self) -> None:
        org_id = self.lc.create_org('alpha')
        self.lc.claim(org_id, 'retry')
        with self.assertRaises(lifecycle.Busy):
            self.lc.claim(org_id, 'trash')

    def test_runtime_cannot_reach_a_create_stage(self) -> None:
        with patch.object(lifecycle.Lifecycle, '_step', crashing_step('identity')):
            with self.assertRaises(Crash):
                self.lc.create_org('alpha')
        (stage,) = self.stages()
        self.assert_runtime_refused(stage)

    def test_crash_after_every_step_is_finished_by_the_next_host(self) -> None:
        points = [('claimed', False), ('database', False), ('migrated', False),
                  ('identity', False), ('folder', False), ('renamed', True), ('renamed', False)]
        for at, before in points:
            with self.subTest(at=at, before=before):
                _drop_all()
                first = self.host()
                folders = []
                with patch.object(lifecycle.Lifecycle, '_step', crashing_step(at, before=before)):
                    with self.assertRaises(Crash):
                        first.create_org('alpha', prepare_folder=folders.append)
                second = self.host()
                (claim,) = second.take_over()
                self.assertEqual(claim.kind, 'create')
                second.resume_create(claim, prepare_folder=folders.append)
                (row,) = second.rows()
                self.assertEqual(row['state'], 'active')
                self.assertEqual(self.stages(), [])
                self.assertEqual([d for d in _prefixed() if names.kind(d, PREFIX) == 'org'],
                                 [row['database']])
                with self.runtime(row['database']) as r:
                    self.assertEqual(r.execute('SELECT slug FROM org_identity').fetchone()[0], 'alpha')

    def test_stale_claim_never_drops_a_newer_attempt_or_the_active_database(self) -> None:
        first = self.host()
        with patch.object(lifecycle.Lifecycle, '_step', crashing_step('database')):
            with self.assertRaises(Crash):
                first.create_org('alpha')
        (old,) = first.rows()
        stale = lifecycle.Claim(old['org_id'], 'create', old['op_epoch'])
        second = self.host()
        (claim,) = second.take_over()
        with patch.object(lifecycle.Lifecycle, '_step', crashing_step('migrated')):
            with self.assertRaises(Crash):
                second.resume_create(claim)
        newer = self.stages()
        self.assertEqual(newer, [names.stage(old['org_id'], claim.epoch, PREFIX)])
        with self.assertRaises(lifecycle.LostClaim):
            first.abandon(stale, step='conversion', reason='stale')
        self.assertEqual(self.stages(), newer)
        second.resume_create(claim)
        with self.assertRaises(lifecycle.LostClaim):
            first.abandon(stale, step='conversion', reason='stale')
        (row,) = second.rows()
        self.assertEqual(row['state'], 'active')
        self.assertIn(row['database'], _prefixed())


class Builds(Base):
    def fill(self, build: lifecycle.Build, key: str = 'k') -> None:
        with self.runtime(build.database) as r:
            r.execute("INSERT INTO org_extra (key, val) VALUES (%s, '{\"a\": 1}')", (key,))

    def test_fill_and_publish(self) -> None:
        org_id = self.lc.register_org('beta', state='converting', legacy_database='orgtree',
                                      legacy_org_id=7)
        build = self.lc.open_build(org_id, 'convert')
        self.fill(build)
        self.lc.mark_filled(build)
        final = self.lc.publish(build)
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['database'], row['legacy_org_id']), ('active', final, 7))
        self.assertEqual(self.stages(), [])
        with self.runtime(final) as r:
            self.assertEqual(r.execute('SELECT key FROM org_extra').fetchall(), [('k',)])

    def test_abandon_leaves_the_org_unavailable(self) -> None:
        org_id = self.lc.register_org('beta', state='converting')
        build = self.lc.open_build(org_id, 'convert')
        self.fill(build)
        self.lc.abandon(build.claim, step='conversion', reason='planted mismatch',
                        report_path='conversion/x')
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['unavailable_step'], row['state_reason'],
                          row['attempts'], row['attempted_build'], row['report_path']),
                         ('unavailable', 'conversion', 'planted mismatch', 1, 'test-build',
                          'conversion/x'))
        self.assertIsNone(row['op_kind'])
        self.assertEqual(self.stages(), [])
        self.assertNotIn(row['database'], _prefixed())

    def test_build_renamed_before_a_crash_is_only_published(self) -> None:
        org_id = self.lc.register_org('beta', state='converting')
        build = self.lc.open_build(org_id, 'convert')
        self.fill(build)
        self.lc.mark_filled(build)
        with patch.object(lifecycle.Lifecycle, '_step', crashing_step('renamed', before=True)):
            with self.assertRaises(Crash):
                self.lc.publish(build)
        second = self.host()
        (claim,) = second.take_over()
        again = second.resume_build(claim)
        self.assertTrue(again.ready)
        final = second.publish(again)
        with self.runtime(final) as r:
            self.assertEqual(r.execute('SELECT key FROM org_extra').fetchall(), [('k',)])

    def test_resumed_build_is_redone_in_a_new_staging_database(self) -> None:
        org_id = self.lc.register_org('beta', state='converting')
        build = self.lc.open_build(org_id, 'convert')
        self.fill(build, 'half')
        second = self.host()
        (claim,) = second.take_over()
        again = second.resume_build(claim)
        self.assertFalse(again.ready)
        self.assertNotEqual(again.database, build.database)
        self.assertEqual(self.stages(), [again.database])
        with self.runtime(again.database) as r:
            self.assertEqual(r.execute('SELECT count(*) FROM org_extra').fetchone()[0], 0)

    def test_legacy_trashed_org_is_published_fenced_under_its_trash_name(self) -> None:
        when = datetime.datetime(2026, 9, 30, 12, 0, 5, tzinfo=datetime.timezone.utc)
        org_id = self.lc.register_org('gamma', state='converting', trashed_at=when)
        build = self.lc.open_build(org_id, 'convert')
        self.fill(build)
        self.lc.mark_filled(build)
        final = self.lc.publish(build, state='trashed', trashed_at=when)
        self.assertEqual(final, names.trash(org_id, '20260930t120005', PREFIX))
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['trashed_at']), ('trashed', when))
        self.assert_runtime_refused(final)
        self.lc.create_org('gamma')          # a trashed org's name is free again


class Migrations(Base):
    def setUp(self) -> None:
        super().setUp()
        self.folder = Path(tempfile.mkdtemp(prefix='orgdb-mig-'))
        for p in migrate.files(migrate.ORG_DIR):
            shutil.copy(p, self.folder / p.name)
        patcher = patch.object(migrate, 'ORG_DIR', self.folder)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.a = self.lc.create_org('a')
        self.b = self.lc.create_org('b')

    def add(self, name: str, text: str) -> None:
        (self.folder / name).write_text(text, encoding='utf-8')

    def level(self, org_id: int) -> set[str]:
        with conn.connect(ADMIN, self.lc.row(org_id)['database']) as c:
            return set(migrate.applied(c))

    def admin_exec(self, org_id: int, statement: str) -> None:
        with conn.connect(ADMIN, self.lc.row(org_id)['database']) as c:
            c.execute(statement)

    def test_partly_migrated_set_is_finished(self) -> None:
        self.add('0099_extra.sql', 'CREATE TABLE orgtree.extra_t (x int);')
        self.lc._migrate_org_db(self.lc.row(self.a)['database'])
        self.assertIn('0099_extra.sql', self.level(self.a))
        self.assertNotIn('0099_extra.sql', self.level(self.b))
        report = self.lc.migrate_orgs()
        self.assertEqual(report['unavailable'], {})
        self.assertEqual(self.level(self.a), self.level(self.b))

    def test_failing_file_makes_only_that_org_unavailable_and_retry_recovers(self) -> None:
        self.admin_exec(self.b, 'CREATE TABLE orgtree.block_me (x int)')
        self.add('0099_extra.sql',
                 "CREATE TABLE orgtree.extra_t (x int);\n"
                 "DO $$ BEGIN IF to_regclass('orgtree.block_me') IS NOT NULL THEN "
                 "RAISE EXCEPTION 'planted failure'; END IF; END $$;")
        report = self.lc.migrate_orgs()
        self.assertEqual(list(report['unavailable']), [self.b])
        self.assertIn('0099_extra.sql', self.level(self.a))
        self.assertNotIn('0099_extra.sql', self.level(self.b))
        row = self.lc.row(self.b)
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'migration'))
        self.assertIn('planted failure', row['state_reason'])
        self.assert_runtime_refused(row['database'])
        with conn.connect(ADMIN, row['database']) as c:   # rolled back: no half table
            self.assertIsNone(c.execute("SELECT to_regclass('orgtree.extra_t')").fetchone()[0])
        self.assertFalse(self.lc.retry_in_place(self.b))
        self.assertEqual(self.lc.row(self.b)['attempts'], 1)
        self.admin_exec(self.b, 'DROP TABLE orgtree.block_me')
        self.assertTrue(self.lc.retry_in_place(self.b))
        self.assertEqual(self.lc.row(self.b)['state'], 'active')
        with self.runtime(row['database']) as r:
            self.assertEqual(r.execute("SELECT to_regclass('orgtree.extra_t')::text").fetchone()[0],
                             'extra_t')

    def test_newer_org_is_unavailable_and_newer_app_refuses(self) -> None:
        self.admin_exec(self.b, "INSERT INTO orgtree.schema_migrations (name, sha256) "
                                "VALUES ('9999_future.sql', 'x')")
        report = self.lc.migrate_orgs()
        self.assertEqual(list(report['unavailable']), [self.b])
        self.assertIn('newer Orgtree', self.lc.row(self.b)['state_reason'])
        self.assertEqual(self.lc.row(self.a)['state'], 'active')
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            c.execute("INSERT INTO orgtree.schema_migrations (name, sha256) "
                      "VALUES ('9999_future.sql', 'x')")
        with self.assertRaises(migrate.NewerDatabase):
            self.host()

    def test_identity_mismatch_is_unavailable_and_fenced(self) -> None:
        self.admin_exec(self.a, "UPDATE orgtree.org_identity SET slug = 'someone-else'")
        self.assertFalse(self.lc.check_identity(self.a))
        row = self.lc.row(self.a)
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'identity'))
        self.assert_runtime_refused(row['database'])
        self.assertTrue(self.lc.check_identity(self.b))
        self.admin_exec(self.a, "UPDATE orgtree.org_identity SET slug = 'a'")
        self.assertTrue(self.lc.retry_in_place(self.a))

    def test_a_retry_claims_only_while_the_org_is_still_unavailable(self) -> None:
        # a Retry that read the row just before another Retry made the org active: its claim
        # carries the state, so it is refused (not Busy: nothing holds the org) and changes
        # nothing
        stale = dict(self.lc.row(self.a), state='unavailable', unavailable_step='identity')
        real_row = self.lc.row
        calls: list[int] = []

        def row_once_stale(org_id: int):
            calls.append(org_id)
            return stale if len(calls) == 1 else real_row(org_id)
        with patch.object(self.lc, 'row', row_once_stale):
            with self.assertRaises(lifecycle.LifecycleError) as cm:
                self.lc.retry_in_place(self.a)
        self.assertNotIsInstance(cm.exception, lifecycle.Busy)
        self.assertIn('is active', str(cm.exception))
        now = self.lc.row(self.a)
        self.assertEqual((now['state'], now['op_kind'], now['attempts']), ('active', None, 0))
        # an org another operation holds is Busy, whatever its state
        self.lc.claim(self.b, 'trash')
        with self.assertRaises(lifecycle.Busy):
            self.lc.claim(self.b, 'retry', expect_state='unavailable')
        # and an unavailable org at another step is refused, not claimed
        self.admin_exec(self.a, "UPDATE orgtree.org_identity SET slug = 'someone-else'")
        self.assertFalse(self.lc.check_identity(self.a))
        with self.assertRaises(lifecycle.LifecycleError) as cm:
            self.lc.claim(self.a, 'retry', expect_state='unavailable',
                          expect_steps=('conversion', 'import'))
        self.assertNotIsInstance(cm.exception, lifecycle.Busy)
        self.assertIsNone(self.lc.row(self.a)['op_kind'])


if __name__ == '__main__':
    unittest.main()
