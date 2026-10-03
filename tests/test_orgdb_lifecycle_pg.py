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
    refused and changes nothing; a held org is Busy;
  * trash (piece A3): admission closes and the runtime is fenced before the
    drain; the database is renamed to a trash name the runtime cannot reach;
    the folders move to the trash; the name is free; restore brings data and
    folders back, is refused while another org has the name, and leaves the org
    unavailable when its identity does not match; purge leaves nothing and only
    empties the trash; a refused step leaves the org closed and claimed (Busy to
    others) and the same operation asked again finishes it; a crash after (and
    before recording) every step of trash, restore and purge is finished by the
    next host.

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


class Trash(Base):
    """§2.13 Trash, Restore and Purge (piece A3): every step recorded and repeatable."""

    def setUp(self) -> None:
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix='orgdb-trash-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.trash_dir = str(Path(self.tmp) / 'data' / 'deleted')

    def folders(self, slug: str) -> tuple:
        root = Path(self.tmp) / 'data'
        return (('workspace', str(root / 'workspaces' / slug)),
                ('scratch', str(root / 'scratch' / slug)))

    def make(self, slug: str, lc=None) -> int:
        """An active org with content in its database and in both folders."""
        lc = lc or self.lc
        org_id = lc.create_org(slug)
        for label, path in self.folders(slug):
            os.makedirs(path)
            Path(path, f'{label}.txt').write_text(label, encoding='utf-8')
        with conn.connect(ADMIN, lc.row(org_id)['database']) as c:
            c.execute("INSERT INTO orgtree.org_extra (key, val) VALUES ('mark', '\"kept\"')")
        return org_id

    def assert_trashed(self, lc, org_id: int, slug: str = 'alpha') -> str:
        row = lc.row(org_id)
        self.assertEqual((row['state'], row['op_kind']), ('trashed', None))
        target = row['database']
        self.assertEqual(names.kind(target, PREFIX), 'trash')
        self.assertIsNotNone(row['trashed_at'])
        present = _prefixed()
        self.assertIn(target, present)
        self.assertNotIn(names.org(org_id, PREFIX), present)
        self.assert_runtime_refused(target)
        keep = lc.trash_folder(self.trash_dir, slug, target, org_id)
        for label, path in self.folders(slug):
            self.assertFalse(os.path.exists(path), path)
            self.assertEqual(Path(keep, label, f'{label}.txt').read_text(encoding='utf-8'), label)
        return target

    def assert_restored(self, lc, org_id: int, slug: str = 'alpha') -> None:
        row = lc.row(org_id)
        self.assertEqual((row['state'], row['op_kind'], row['trashed_at']), ('active', None, None))
        self.assertEqual(row['database'], names.org(org_id, PREFIX))
        with self.runtime(row['database']) as r:
            self.assertEqual(r.execute("SELECT val::text FROM org_extra WHERE key = 'mark'"
                                       ).fetchone()[0], '"kept"')
            self.assertEqual(r.execute('SELECT slug FROM org_identity').fetchone()[0], slug)
        for label, path in self.folders(slug):
            self.assertEqual(Path(path, f'{label}.txt').read_text(encoding='utf-8'), label)

    def test_trash_closes_fences_moves_renames_and_frees_the_name(self) -> None:
        org_id = self.make('alpha')
        seen = []

        def drain() -> None:
            # admission is closed and the runtime is fenced off before the drain runs
            seen.append(self.lc.row(org_id)['state'])
            self.assert_runtime_refused(self.lc.row(org_id)['database'])
        self.lc.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir, drain=drain)
        self.assertEqual(seen, ['closing'])
        self.assert_trashed(self.lc, org_id)
        other = self.lc.create_org('alpha')
        self.assertNotEqual(other, org_id)
        with self.assertRaises(lifecycle.LifecycleError):
            self.lc.trash(org_id, trash_dir=self.trash_dir)   # trashed already: not active

    def test_restore_brings_the_org_back_and_is_refused_while_its_name_is_used(self) -> None:
        org_id = self.make('alpha')
        self.lc.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        other = self.lc.create_org('alpha')
        with self.assertRaises(lifecycle.LifecycleError) as cm:
            self.lc.restore(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        self.assertNotIsInstance(cm.exception, lifecycle.Busy)
        self.assertIn('another org', str(cm.exception))
        self.assert_trashed(self.lc, org_id)                    # refused: nothing moved
        self.lc.trash(other, trash_dir=self.trash_dir)          # the name is free again
        self.lc.restore(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        self.assert_restored(self.lc, org_id)

    def test_restore_checks_the_identity_before_the_runtime_comes_back(self) -> None:
        org_id = self.make('alpha')
        target = self.lc.trash(org_id, trash_dir=self.trash_dir)
        self.lc._allow_connections(target, True)
        with conn.connect(ADMIN, target) as c:
            c.execute("UPDATE orgtree.org_identity SET slug = 'someone-else'")
        self.lc._allow_connections(target, False)
        self.lc.restore(org_id, trash_dir=self.trash_dir)
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'identity'))
        self.assert_runtime_refused(row['database'])

    def test_purge_leaves_nothing_and_only_from_the_trash(self) -> None:
        org_id = self.make('alpha')
        with self.assertRaises(lifecycle.LifecycleError) as cm:
            self.lc.purge(org_id, trash_dir=self.trash_dir)     # active
        self.assertNotIsInstance(cm.exception, lifecycle.Busy)
        target = self.lc.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        self.lc.purge(org_id, trash_dir=self.trash_dir)
        self.assertNotIn(target, _prefixed())
        self.assertFalse(os.path.exists(self.lc.trash_folder(self.trash_dir, 'alpha', target, org_id)))
        self.assertEqual(self.lc.rows(), [])

    def test_a_second_operation_is_busy_and_the_same_one_asked_again_finishes_it(self) -> None:
        org_id = self.make('alpha')
        held = Path(self.folders('alpha')[0][1])

        def refuse(src: str, dst: str) -> None:
            raise OSError(f'{src} is held open')
        with patch.object(lifecycle.Lifecycle, '_move_once', staticmethod(refuse)):
            with self.assertRaises(OSError):
                self.lc.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['op_kind'], row['op_step']), ('closing', 'trash', 'closed'))
        self.assertTrue(held.is_dir())
        with self.assertRaises(lifecycle.Busy):
            self.lc.claim(org_id, 'purge')
        self.lc.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
        self.assert_trashed(self.lc, org_id)

    def test_a_second_request_is_busy_while_the_first_runs(self) -> None:
        # review A3 f1: a request arriving while this engine still runs an operation on the
        # org is Busy and moves nothing (the claim is this instance's either way, so the claim
        # alone cannot refuse it); the first then completes normally
        import threading
        org_id = self.make('alpha')
        db = self.lc.row(org_id)['database']
        draining, release = threading.Event(), threading.Event()
        out: dict = {}

        def drain() -> None:
            draining.set()
            release.wait(30)

        def first() -> None:
            try:
                out['first'] = self.lc.trash(org_id, folders=self.folders('alpha'),
                                             trash_dir=self.trash_dir, drain=drain)
            except BaseException as e:       # noqa: BLE001  the outcome under test
                out['first'] = e
        th = threading.Thread(target=first)
        th.start()
        try:
            self.assertTrue(draining.wait(30), 'the first trash never reached its drain')
            for op in (lambda: self.lc.trash(org_id, folders=self.folders('alpha'),
                                             trash_dir=self.trash_dir),
                       lambda: self.lc.restore(org_id, folders=self.folders('alpha'),
                                               trash_dir=self.trash_dir),
                       lambda: self.lc.purge(org_id, trash_dir=self.trash_dir)):
                with self.assertRaises(lifecycle.Busy):
                    op()
            self.assertIn(db, _prefixed())                 # nothing moved meanwhile
            for _, path in self.folders('alpha'):
                self.assertTrue(os.path.isdir(path), path)
            self.assertEqual(self.lc.row(org_id)['state'], 'closing')
        finally:
            release.set()
            th.join(60)
        self.assertEqual(out['first'], self.lc.row(org_id)['database'])
        self.assert_trashed(self.lc, org_id)

    def test_a_crash_after_every_step_is_finished_by_the_next_host(self) -> None:
        L = lifecycle.Lifecycle
        cases = ([('trash', s, b) for s in L._TRASH_STEPS[1:] for b in (False, True)]
                 + [('restore', s, b) for s in L._RESTORE_STEPS[1:] for b in (False, True)]
                 + [('purge', s, b) for s in L._PURGE_STEPS[1:] for b in (False, True)])
        for kind, at, before in cases:
            with self.subTest(kind=kind, at=at, before=before):
                _drop_all()
                shutil.rmtree(Path(self.tmp) / 'data', ignore_errors=True)
                first = self.host()
                org_id = self.make('alpha', first)
                if kind != 'trash':
                    first.trash(org_id, folders=self.folders('alpha'), trash_dir=self.trash_dir)
                op = getattr(first, kind)
                args = ({} if kind == 'purge' else {'folders': self.folders('alpha')})
                with patch.object(L, '_step', crashing_step(at, before=before)):
                    with self.assertRaises(Crash):
                        op(org_id, trash_dir=self.trash_dir, **args)
                second = self.host()
                (claim,) = second.take_over()
                self.assertEqual(claim.kind, kind)
                second.resume_lifecycle(claim, folders=self.folders('alpha'),
                                        trash_dir=self.trash_dir)
                if kind == 'trash':
                    self.assert_trashed(second, org_id)
                elif kind == 'restore':
                    self.assert_restored(second, org_id)
                else:
                    self.assertEqual(second.rows(), [])
                    self.assertEqual([d for d in _prefixed()
                                      if names.kind(d, PREFIX) in ('org', 'trash')], [])
                    self.assertEqual(os.listdir(self.trash_dir), [])


if __name__ == '__main__':
    unittest.main()
