"""The engine's start with 3.2.0's storage switched on (piece A7a; orgtree.orgdb.startup).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. The legacy database t<pid>_legacy and every new
                               database (prefix t<pid>_) are created and dropped by this module.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every database test SKIPS: a skip is not a pass.

The legacy store is made with today's own code (store.create_org and save_org on
ORGTREE_STORE=postgres). The start runs as the packaged engine's bracket runs it
(``startup.start`` with the admin conninfo), and its first pass is the converter's child
process.

What it proves:
  * the first start converts every legacy org before it returns (each org a
    ``database-convert`` phase) and writes the marker; a second start does not run the pass;
  * neither start changes the legacy database: its schema_migrations and every table's rows
    are the same before and after (design §5.1 rev 4.1: 3.2.0 never migrates it);
  * a root with no legacy database, or an empty one, starts and writes the marker;
  * the admin conninfo is never put in this process's environment;
  * claims a stopped engine left are finished at the next start: a create whose first save
    committed is published, one whose save never committed is removed; a trash, a restore and
    a purge are finished from their recorded step (folders included); an interrupted Retry
    goes back to unavailable, its reason saying so;
  * at start every active org is migrated; a failing org becomes unavailable and fenced while
    the others start with the new file applied;
  * an unavailable org is retried automatically once per new build: not again by the same
    build, and a later build that has the fix brings it back;
  * restore brings an org trashed under an older level up to this build's level before it is
    active; a failing migration leaves it unavailable at step 'migration' with its folders
    back in place, and Retry recovers it;
  * without a database: the start's org folders and build are the store's.

Run:  python tools/run-python-verification.py --timeout 1500 tests/test_orgdb_startup_pg.py
"""

import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
LEGACY = f'{PREFIX}legacy'

_temp = tempfile.TemporaryDirectory(prefix='v3-orgdb-startup-', ignore_cleanup_errors=True)
DATA = Path(_temp.name) / 'data'
DATA.mkdir()
HOME = Path(_temp.name) / 'home'
HOME.mkdir()


def _with_db(url: str, db: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, '/' + db, p.query, p.fragment))


if ADMIN and RUNTIME:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS {LEGACY} WITH (FORCE)')
        c.execute(f'CREATE DATABASE {LEGACY}')
    os.environ['ORGTREE_PG_URL'] = _with_db(ADMIN, LEGACY)
os.environ.update(ORGTREE_DATA=str(DATA), HOME=str(HOME), USERPROFILE=str(HOME),
                  ORGTREE_STORE='postgres', ORGTREE_ORGDB_PREFIX=PREFIX)
os.environ.pop('ORGTREE_STORAGE', None)
os.environ.pop('ORGTREE_PG_ADMIN_CONNINFO', None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import pgstore, store, workitems  # noqa: E402
from orgtree.orgdb import conn, lifecycle, migrate, names, registry, startup  # noqa: E402

needs_pg = unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and '
                                                  'ORGTREE_TEST_PG_RUNTIME_URL')

#: an org migration that fails only in an org database holding the table planted_fault: the
#: fault is planted and removed without changing the file (whose checksum is recorded)
PLANTED = """DO $$ BEGIN
  IF to_regclass('orgtree.planted_fault') IS NOT NULL THEN
    RAISE EXCEPTION 'planted fault';
  END IF;
END $$;
CREATE TABLE orgtree.after_planted (x int);
"""


def setUpModule() -> None:
    if ADMIN and RUNTIME:
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_new()
        import psycopg
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS {LEGACY} WITH (FORCE)')


def _drop_new() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s "
                               "AND datname <> %s", (PREFIX + '%', LEGACY)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def child_env() -> dict:
    """What the converter child starts from: no orgtree, provider or Python variables of this
    process (the start adds the runtime and admin conninfos itself)."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
        ('ORGTREE_', 'OPENAI_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'GEMINI_', 'PYTHON'))}
    env.update(ORGTREE_ORGDB_PREFIX=PREFIX, HOME=str(HOME), USERPROFILE=str(HOME),
               PYTHONIOENCODING='utf-8')
    return env


def run_start(*, build: str, legacy: str = LEGACY, phases: list | None = None) -> dict:
    """One engine start, as the packaged bracket runs it."""
    return startup.start(admin=ADMIN, runtime=_with_db(RUNTIME, legacy), data_root=str(DATA),
                         env=child_env(), build=build,
                         progress=(phases.append if phases is not None else None))


def host(build: str = 'old') -> lifecycle.Lifecycle:
    """An engine instance that will 'stop' (its claims are left behind)."""
    lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build=build)
    lc.bootstrap()
    return lc


def set_marker(lc: lifecycle.Lifecycle) -> None:
    """The first pass finished earlier (these tests are about what follows it)."""
    with conn.connect(ADMIN, names.app(PREFIX)) as c:
        c.execute("UPDATE orgtree.app_settings SET legacy_cutover_at = now()")


def rows() -> dict:
    with conn.connect(ADMIN, names.app(PREFIX)) as c:
        cur = c.execute('SELECT * FROM orgtree.orgs ORDER BY org_id')
        cols = [d.name for d in cur.description]
        return {r[cols.index('slug')]: dict(zip(cols, r)) for r in cur.fetchall()}


def applied(database: str) -> list:
    with conn.connect(ADMIN, database) as c:
        return [r[0] for r in c.execute(
            'SELECT name FROM orgtree.schema_migrations ORDER BY name').fetchall()]


def legacy_digest() -> dict:
    """Every legacy table's rows (an order-free digest) and the legacy migrations."""
    out = {}
    with conn.connect(ADMIN, LEGACY) as c:
        tables = c.execute(
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = "
            "'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') "
            "ORDER BY 1, 2").fetchall()
        for schema, table in tables:
            out[f'{schema}.{table}'] = c.execute(
                f'SELECT count(*), md5(coalesce(string_agg(md5(t::text), \'\' ORDER BY md5(t::text)), \'\')) '
                f'FROM "{schema}"."{table}" t').fetchone()
        out['schema_migrations'] = [r[0] for r in c.execute(
            'SELECT name FROM public.schema_migrations ORDER BY name').fetchall()]
    return out


def make_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['lead'] = {'id': 'lead', 'name': 'lead', 'parent': None, 'children': [],
                              'state': 'live', 'seat_id': f'seat-{slug}'}
    org.d['work_items'] = [{'slug': 'first-thing', 'title': 'first thing', 'status': 'open',
                            'owner': {'node': 'lead', 'generation': 0}}]
    store.save_org(org)
    return slug


class Crash(Exception):
    """A simulated engine stop at a chosen step."""


def crashing_step(at: str):
    """A Lifecycle._step that stops the engine right after recording ``at``."""
    original = lifecycle.Lifecycle._step

    def step(self, claim, name, **cols):
        original(self, claim, name, **cols)
        if name == at:
            raise Crash(name)
    return step


def planted_folder() -> Path:
    """This build's org migrations plus PLANTED, as a later build's would be."""
    folder = Path(tempfile.mkdtemp(dir=_temp.name)) / 'org'
    shutil.copytree(migrate.ORG_DIR, folder)
    (folder / '0099_planted.sql').write_text(PLANTED, encoding='utf-8')
    return folder


def plant_fault(database: str) -> None:
    with conn.connect(ADMIN, database) as c:
        c.execute('CREATE TABLE orgtree.planted_fault (x int)')


def remove_fault(database: str) -> None:
    with conn.connect(ADMIN, database) as c:
        c.execute('DROP TABLE orgtree.planted_fault')


# ----------------------------------------------------------------- without a database

class SameRulesAsTheStore(unittest.TestCase):
    def test_org_folders_are_the_stores(self) -> None:
        for slug in ('alpha', 'a-b'):
            self.assertEqual(startup.org_folders(store.DATA_ROOT, slug), store.org_folders(slug))

    def test_the_build_is_the_one_the_engine_reports(self) -> None:
        self.assertEqual(startup.this_build(), workitems.build_identity())


# ----------------------------------------------------------------- the first start

@needs_pg
class FirstStart(unittest.TestCase):
    """One legacy store; the first start converts it, the second leaves it."""

    @classmethod
    def setUpClass(cls) -> None:
        _drop_new()
        cls.alpha = make_org('Alpha')
        cls.beta = make_org('Beta')
        cls.before = legacy_digest()
        cls.phases: list = []
        cls.first = run_start(build='b1', phases=cls.phases)
        cls.registry_after_first = rows()
        cls.second = run_start(build='b1')
        cls.after = legacy_digest()

    def test_the_first_start_converts_every_org_before_it_returns(self) -> None:
        self.assertTrue(self.first['first_pass']['ran'])
        outcomes = {o['slug']: o['outcome'] for o in self.first['first_pass']['orgs']}
        self.assertEqual(outcomes, {self.alpha: 'active', self.beta: 'active'})
        self.assertEqual({s: r['state'] for s, r in self.registry_after_first.items()},
                         {self.alpha: 'active', self.beta: 'active'})
        for phase in ('database-convert: new storage', f'database-convert: {self.alpha}',
                      f'database-convert: {self.beta}'):
            self.assertIn(phase, self.phases)
        self.assertLess(self.phases.index('database-orgdb'),
                        self.phases.index('database-convert: new storage'))
        report = Path(self.first['first_pass']['report_dir'])
        self.assertTrue((report / 'run.json').is_file())
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            at, level, build = c.execute('SELECT legacy_cutover_at, legacy_cutover_level, '
                                         'legacy_cutover_build FROM orgtree.app_settings').fetchone()
        self.assertIsNotNone(at)
        self.assertEqual(level, self.before['schema_migrations'][-1])
        self.assertEqual(build, 'b1')

    def test_a_second_start_does_not_run_the_first_pass(self) -> None:
        self.assertFalse(self.second['first_pass']['ran'])
        self.assertEqual(self.second['resumed'], [])
        self.assertEqual(self.second['retried'], [])
        self.assertEqual({s: r['state'] for s, r in rows().items()},
                         {self.alpha: 'active', self.beta: 'active'})

    def test_no_start_changes_the_legacy_database(self) -> None:
        self.assertEqual(self.after, self.before)

    def test_the_admin_conninfo_never_reaches_this_process_environment(self) -> None:
        self.assertNotIn(lifecycle.ADMIN_ENV, os.environ)
        # (this test's own input variable holds the admin URL; nothing else may)
        self.assertEqual([k for k, v in os.environ.items()
                          if v == ADMIN and k != 'ORGTREE_TEST_PG_ADMIN_URL'], [])

    def test_the_registry_serves_the_starts_lifecycle(self) -> None:
        self.assertEqual(registry.lifecycle().build, 'b1')


@needs_pg
class FreshRoot(unittest.TestCase):
    def setUp(self) -> None:
        _drop_new()

    def test_no_legacy_database_starts_and_writes_the_marker(self) -> None:
        out = run_start(build='b1', legacy=f'{PREFIX}nolegacy')
        self.assertTrue(out['first_pass']['ran'])
        self.assertEqual(out['first_pass']['orgs'], [])
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            at, level = c.execute('SELECT legacy_cutover_at, legacy_cutover_level '
                                  'FROM orgtree.app_settings').fetchone()
        self.assertIsNotNone(at)
        self.assertIsNone(level)
        self.assertEqual(rows(), {})

    def test_an_empty_legacy_database_starts_and_writes_the_marker(self) -> None:
        empty = f'{PREFIX}emptylegacy'
        with conn.connect(ADMIN, 'postgres') as c:
            c.execute(f'CREATE DATABASE {empty}')
        out = run_start(build='b1', legacy=empty)
        self.assertTrue(out['first_pass']['ran'])
        self.assertEqual(out['first_pass']['orgs'], [])
        self.assertFalse(run_start(build='b1', legacy=empty)['first_pass']['ran'])


# ----------------------------------------------------------------- what a stopped engine left

@needs_pg
class ClaimsLeftBehind(unittest.TestCase):
    """One stopped engine leaves one claim of every kind; the next start finishes them."""

    @classmethod
    def setUpClass(cls) -> None:
        _drop_new()
        shutil.rmtree(DATA / 'workspaces', ignore_errors=True)
        shutil.rmtree(DATA / 'deleted', ignore_errors=True)
        lc = host('old')
        set_marker(lc)
        trash_dir = str(DATA / 'deleted')

        def folders(slug: str):
            ws = DATA / 'workspaces' / slug
            ws.mkdir(parents=True, exist_ok=True)
            (ws / 'note.txt').write_text(slug, encoding='utf-8')
            return startup.org_folders(str(DATA), slug)
        # a create whose first save committed in its staging database, and one whose did not
        made = lc.begin_create('made')
        with conn.connect(RUNTIME, made.database) as r:
            r.execute('UPDATE orgtree.org_revision SET rev = rev + 1')
        lc.begin_create('never')
        # a trash stopped after its runtime fence
        cls.trashed_id = lc.create_org('trashme')
        with mock.patch.object(lifecycle.Lifecycle, '_step', crashing_step('fenced')):
            try:
                lc.trash(cls.trashed_id, folders=folders('trashme'), trash_dir=trash_dir)
            except Crash:
                pass
        # a restore stopped after its database was opened
        cls.restored_id = lc.create_org('back')
        lc.trash(cls.restored_id, folders=folders('back'), trash_dir=trash_dir)
        with mock.patch.object(lifecycle.Lifecycle, '_step', crashing_step('opened')):
            try:
                lc.restore(cls.restored_id, folders=startup.org_folders(str(DATA), 'back'),
                           trash_dir=trash_dir)
            except Crash:
                pass
        # a purge stopped after its database was dropped
        cls.purged_id = lc.create_org('gone')
        lc.trash(cls.purged_id, trash_dir=trash_dir)
        with mock.patch.object(lifecycle.Lifecycle, '_step', crashing_step('dropped')):
            try:
                lc.purge(cls.purged_id, trash_dir=trash_dir)
            except Crash:
                pass
        # a Retry the engine stopped in
        cls.stuck_id = lc.create_org('stuck')
        assert lc._mark_unavailable(cls.stuck_id, 'migration', 'planted')
        lc.claim(cls.stuck_id, 'retry', expect_state='unavailable', expect_steps=('migration',))
        cls.left = {r['slug']: (r['op_kind'], r['op_step']) for r in rows().values() if r['op_kind']}
        cls.report = run_start(build='new')
        cls.after = rows()

    def test_every_kind_was_left_claimed(self) -> None:
        self.assertEqual(self.left, {'made': ('create', 'identity'), 'never': ('create', 'identity'),
                                     'trashme': ('trash', 'fenced'), 'back': ('restore', 'opened'),
                                     'gone': ('purge', 'dropped'), 'stuck': ('retry', 'claimed')})

    def test_no_claim_is_left_after_the_start(self) -> None:
        self.assertEqual([s for s, r in self.after.items() if r['op_kind']], [])
        outcomes = {e['slug']: e['outcome'] for e in self.report['resumed']}
        self.assertEqual(outcomes, {'made': 'active', 'never': 'removed', 'trashme': 'trashed',
                                    'back': 'active', 'gone': 'purged', 'stuck': 'unavailable'})

    def test_a_create_whose_save_committed_is_published(self) -> None:
        row = self.after['made']
        self.assertEqual((row['state'], row['database']), ('active', names.org(row['org_id'], PREFIX)))
        with conn.connect(RUNTIME, row['database']) as r:
            self.assertEqual(r.execute('SELECT rev FROM org_revision').fetchone()[0], 1)

    def test_a_create_whose_save_never_committed_leaves_nothing(self) -> None:
        self.assertNotIn('never', self.after)
        with conn.connect(ADMIN, 'postgres') as c:
            stages = [d for (d,) in c.execute('SELECT datname FROM pg_database').fetchall()
                      if names.kind(d, PREFIX) == 'stage']
        self.assertEqual(stages, [])

    def test_the_trash_is_finished_with_its_folders(self) -> None:
        row = self.after['trashme']
        self.assertEqual(row['state'], 'trashed')
        self.assertEqual(names.kind(row['database'], PREFIX), 'trash')
        self.assertFalse((DATA / 'workspaces' / 'trashme').exists())
        keep = lifecycle.Lifecycle.trash_folder(str(DATA / 'deleted'), 'trashme', row['database'],
                                                self.trashed_id)
        self.assertEqual((Path(keep) / 'workspace' / 'note.txt').read_text(encoding='utf-8'), 'trashme')

    def test_the_restore_is_finished_with_its_folders(self) -> None:
        row = self.after['back']
        self.assertEqual((row['state'], row['database']), ('active', names.org(self.restored_id, PREFIX)))
        self.assertEqual((DATA / 'workspaces' / 'back' / 'note.txt').read_text(encoding='utf-8'), 'back')
        self.assertEqual(applied(row['database']), sorted(p.name for p in migrate.files(migrate.ORG_DIR)))

    def test_the_purge_is_finished(self) -> None:
        self.assertNotIn('gone', self.after)

    def test_an_interrupted_retry_goes_back_to_unavailable_and_says_so(self) -> None:
        row = self.after['stuck']
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'migration'))
        self.assertIn('interrupted', row['state_reason'])
        self.assertEqual(row['attempted_build'], 'new')
        self.assertEqual(self.report['retried'], [], 'an org this build just released is not retried at once')


# ----------------------------------------------------------------- migrations and Retry at start

@needs_pg
class MigrationsAtStart(unittest.TestCase):
    def setUp(self) -> None:
        _drop_new()
        self.lc = host('old')
        set_marker(self.lc)
        self.good = self.lc.create_org('good')
        self.bad = self.lc.create_org('bad')
        self.db = {s: r['database'] for s, r in rows().items()}
        plant_fault(self.db['bad'])
        self.folder = planted_folder()

    def start(self, build: str) -> dict:
        with mock.patch.object(migrate, 'ORG_DIR', self.folder):
            return run_start(build=build)

    def test_a_failing_org_becomes_unavailable_and_the_others_start_migrated(self) -> None:
        out = self.start('new')
        after = rows()
        self.assertEqual(after['good']['state'], 'active')
        self.assertIn('0099_planted.sql', applied(self.db['good']))
        self.assertEqual((after['bad']['state'], after['bad']['unavailable_step']),
                         ('unavailable', 'migration'))
        self.assertIn('planted fault', after['bad']['state_reason'])
        self.assertNotIn('0099_planted.sql', applied(self.db['bad']), 'the failing file rolled back')
        self.assertEqual(list(out['migrations']['unavailable']), [self.bad])
        import psycopg
        with self.assertRaises(psycopg.OperationalError):
            conn.connect(RUNTIME, self.db['bad']).close()   # fenced

    def test_retry_runs_once_per_new_build(self) -> None:
        self.start('new')
        first = rows()['bad']
        self.assertEqual(first['attempted_build'], 'new')
        # the same build starting again does not retry
        again = self.start('new')
        self.assertEqual(again['retried'], [])
        self.assertEqual(rows()['bad']['attempts'], first['attempts'])
        # a new build retries once; the fault is still there, so it stays unavailable
        newer = self.start('newer')
        self.assertEqual([(e['slug'], e['outcome']) for e in newer['retried']], [('bad', 'unavailable')])
        self.assertEqual(rows()['bad']['attempts'], first['attempts'] + 1)
        self.assertEqual(rows()['bad']['attempted_build'], 'newer')
        self.assertEqual(self.start('newer')['retried'], [])
        # a later build with the fix (here: the fault removed) brings it back at start
        remove_fault_while_fenced(self.db['bad'])
        fixed = self.start('fixed')
        self.assertEqual([(e['slug'], e['outcome']) for e in fixed['retried']], [('bad', 'active')])
        self.assertEqual(rows()['bad']['state'], 'active')
        self.assertIn('0099_planted.sql', applied(self.db['bad']))
        with conn.connect(RUNTIME, self.db['bad']) as r:
            r.execute('SELECT count(*) FROM after_planted').fetchone()


def remove_fault_while_fenced(database: str) -> None:
    """The admin still reaches a fenced org database (only the runtime is fenced)."""
    remove_fault(database)


# ----------------------------------------------------------------- restore migrates

@needs_pg
class RestoreMigrates(unittest.TestCase):
    def setUp(self) -> None:
        _drop_new()
        shutil.rmtree(DATA / 'workspaces', ignore_errors=True)
        shutil.rmtree(DATA / 'deleted', ignore_errors=True)
        self.lc = host('b1')
        self.trash_dir = str(DATA / 'deleted')
        self.org = self.lc.create_org('old')
        ws = DATA / 'workspaces' / 'old'
        ws.mkdir(parents=True)
        (ws / 'note.txt').write_text('kept', encoding='utf-8')
        self.folders = startup.org_folders(str(DATA), 'old')
        self.folder = planted_folder()

    def test_an_org_trashed_at_an_older_level_is_restored_at_this_one(self) -> None:
        self.lc.trash(self.org, folders=self.folders, trash_dir=self.trash_dir)
        with mock.patch.object(migrate, 'ORG_DIR', self.folder):
            final = self.lc.restore(self.org, folders=self.folders, trash_dir=self.trash_dir)
        self.assertEqual(rows()['old']['state'], 'active')
        self.assertIn('0099_planted.sql', applied(final))
        with conn.connect(RUNTIME, final) as r:
            self.assertEqual(r.execute('SELECT count(*) FROM after_planted').fetchone()[0], 0)
        self.assertEqual((DATA / 'workspaces' / 'old' / 'note.txt').read_text(encoding='utf-8'), 'kept')

    def test_a_failing_migration_leaves_it_unavailable_with_its_folders_back(self) -> None:
        plant_fault(rows()['old']['database'])
        self.lc.trash(self.org, folders=self.folders, trash_dir=self.trash_dir)
        with mock.patch.object(migrate, 'ORG_DIR', self.folder):
            final = self.lc.restore(self.org, folders=self.folders, trash_dir=self.trash_dir)
            row = rows()['old']
            self.assertEqual((row['state'], row['unavailable_step'], row['database']),
                             ('unavailable', 'migration', final))
            self.assertIn('planted fault', row['state_reason'])
            self.assertIsNone(row['op_kind'])
            self.assertEqual((DATA / 'workspaces' / 'old' / 'note.txt').read_text(encoding='utf-8'), 'kept')
            import psycopg
            with self.assertRaises(psycopg.OperationalError):
                conn.connect(RUNTIME, final).close()     # still fenced
            remove_fault(final)
            self.assertTrue(self.lc.retry_in_place(self.org))
        self.assertEqual(rows()['old']['state'], 'active')
        self.assertIn('0099_planted.sql', applied(final))


if __name__ == '__main__':
    unittest.main()
