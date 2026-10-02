"""The converter's first pass and Retry, on a legacy store built by today's code (design §5.2).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. The legacy database t<pid>_legacy and every new
                               database (prefix t<pid>_) are created and dropped by this module.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

The legacy store is made with today's own code (store.create_org, save_org, delete_org on
ORGTREE_STORE=postgres). The converter then runs as the host runs it: a child process,
`python -m orgtree.orgdb.convert`, whose loader reads the legacy database read-only.

What it proves:
  * two orgs convert, publish active, and their new databases decode to exactly the document
    today's loader gives (minus the ignored keys); the cutover marker is written;
  * a second first pass does nothing (the marker is set);
  * Q12: an org with a planted fault (a duplicated docket slug, which the new unique index
    refuses) becomes unavailable with its report while the other converts; its legacy rows are
    unchanged; Retry after the fault is removed converts it;
  * a legacy trashed org (today's delete_org) converts as trashed, fenced, under its trash name;
  * a legacy row with no marker is not converted and is listed;
  * two markers naming one org make it unavailable, naming both;
  * a non-null kiosk value is listed as ignored; an unregistered top-level key is kept and listed;
  * a resumed first pass skips orgs that are already active;
  * the accounts registry converts in the first pass: the machine-wide account to the app
    database, the one restricted to an org to that org's database; a resumed pass checks them
    against the file again, and a file that no longer matches refuses.
  * review f18 (OrgFaultIsolation, in this process): a failure while building one org's
    staging database leaves only that org unavailable, with its report and no staging
    database left, the other active, the cutover marker written and the legacy inputs
    unchanged; Retry converts it. A crash after the rename, then a failing publication by the
    next engine instance, leaves the org unavailable without its unpublished build; Retry
    converts and publishes it. A claim another operation holds is never cleaned up (Busy).

Run:  python tools/run-python-verification.py --timeout 1200 tests/test_orgdb_convert_pg.py
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest import mock
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
LEGACY = f'{PREFIX}legacy'

_temp = tempfile.TemporaryDirectory(prefix='v3-orgdb-convert-', ignore_cleanup_errors=True)
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

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import child_python  # noqa: E402
from orgtree import pgstore, store  # noqa: E402
from orgtree.orgdb import conn, mappers, names, sections  # noqa: E402
from orgtree.orgdb.convert import rowio  # noqa: E402


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


def convert(*args: str) -> dict:
    """Run the converter as the host does: a child process. Returns its run report."""
    report = Path(tempfile.mkdtemp(dir=_temp.name)) / 'conversion'
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
        ('ORGTREE_', 'OPENAI_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'GEMINI_', 'PYTHON'))}
    env.update(ORGTREE_PG_CONNINFO=_with_db(RUNTIME, LEGACY), ORGTREE_PG_ADMIN_CONNINFO=ADMIN,
               ORGTREE_ORGDB_PREFIX=PREFIX, HOME=str(HOME), USERPROFILE=str(HOME),
               PYTHONIOENCODING='utf-8')
    code = 'import sys; from orgtree.orgdb.convert.__main__ import main; sys.exit(main(sys.argv[1:]))'
    r = subprocess.run(child_python.argv('-c', code, *args, '--data-root', str(DATA),
                                         '--report-dir', str(report), '--build', 'test-build'),
                       env=env, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise AssertionError(f'converter exit {r.returncode}\n{r.stdout[-3000:]}\n{r.stderr[-6000:]}')
    return json.loads((report / 'run.json').read_text(encoding='utf-8'))


def write_v2_org(path: Path, name: str) -> None:
    """A 2.x SQLite org file, written by today's SQLite store in a child process (this
    process's store is configured for PostgreSQL)."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('ORGTREE_', 'PYTHON'))}
    env.update(ORGTREE_DATA=str(Path(_temp.name) / 'v2data'), HOME=str(HOME), USERPROFILE=str(HOME))
    code = ('import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; '
            'import test_pgimport as t; t.write_db(Path(sys.argv[2]), t.sample_doc(sys.argv[3]))')
    subprocess.run(child_python.argv('-c', code, str(Path(__file__).resolve().parent), str(path), name),
                   env=env, check=True, capture_output=True, timeout=120)


def registry() -> dict:
    with conn.connect(RUNTIME, names.app(PREFIX)) as c:
        cur = c.execute('SELECT * FROM orgs ORDER BY org_id')
        cols = [d.name for d in cur.description]
        return {r[cols.index('slug')]: dict(zip(cols, r)) for r in cur.fetchall()}


def new_document(database: str) -> dict:
    with conn.connect(RUNTIME, database) as c:
        return sections.decode_document(rowio.read(c), mappers.sections(), sections.Context())


def legacy_document(slug: str) -> dict:
    d = store.load_org(slug).d
    if hasattr(d, 'materialize_all'):
        d.materialize_all()
    out = {}
    for k in list(d.keys()):
        v = d[k]
        if hasattr(v, 'materialize'):
            v.materialize('test')
        out[k] = v
    out = json.loads(json.dumps(out))
    return {k: v for k, v in out.items() if k not in mappers.ignored_keys()}


def canon(v) -> str:
    return json.dumps(v, sort_keys=True)


def make_org(name: str, *, items=('first-thing',)) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['lead'] = {'id': 'lead', 'name': 'lead', 'parent': None, 'children': [],
                              'state': 'live', 'seat_id': f'seat-{slug}'}
    org.d['work_items'] = [{'slug': s, 'title': s, 'status': 'open',
                            'owner': {'node': 'lead', 'generation': 0}} for s in items]
    store.save_org(org)
    return slug


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class FirstPass(unittest.TestCase):
    """One legacy store, converted once; each test reads the outcome for its own orgs."""

    @classmethod
    def setUpClass(cls) -> None:
        _drop_new()
        cls.alpha = make_org('Alpha')
        cls.beta = make_org('Beta', items=('same-slug', 'other'))
        org = store.load_org(cls.beta)
        org.d['kiosk'] = {'token': 'kept in the legacy data only'}
        org.d['hand_edited'] = {'from': 'defaults.json'}
        store.save_org(org)
        # Q12 planted fault: a duplicated docket slug (bypassing today's trigger)
        cls.faulty = make_org('Faulty', items=('dup', 'dup-2'))
        with pgstore.connect() as c:
            org_id = pgstore.read_marker(str(DATA / 'orgs' / f'{cls.faulty}.pg'))
            c.execute(f'SET search_path = org_{org_id}')
            c.execute("SET session_replication_role = replica")
            cls.planted = {}
            for key, val in c.execute("SELECT key, val FROM doc WHERE val LIKE '%dup-2%'").fetchall():
                cls.planted[key] = val
                c.execute('UPDATE doc SET val = %s WHERE key = %s', (val.replace('dup-2', 'dup'), key))
            assert cls.planted, 'the planted fault found no docket row'
            cls.faulty_legacy = org_id
        cls.trashed = make_org('Trashed')
        store.delete_org(cls.trashed)
        cls.orphan = make_org('Orphan')
        (DATA / 'orgs' / f'{cls.orphan}.pg').unlink()
        cls.twin = make_org('Twin')
        shutil.copy(DATA / 'orgs' / f'{cls.twin}.pg', DATA / 'orgs' / 'twin-copy.pg')
        cls.want = {s: legacy_document(s) for s in (cls.alpha, cls.beta)}
        # what a 2.1.14 first-launch import with --hold-back records (pgimport.write_cutover);
        # `later` has a real 2.x file that this build's importer accepts (a Retry imports it)
        later = DATA / 'pre-postgres' / 'orgs' / 'later.db'
        later.parent.mkdir(parents=True, exist_ok=True)
        write_v2_org(later, 'Later')
        (DATA / 'store-backend.json').write_text(json.dumps({
            'schema': 'orgtree.store-backend/v1', 'backend': 'postgres',
            'held_back': {'held': {'reasons': ["unrecognised section 'x'"],
                                   'source': str(DATA / 'orgs' / 'held.json')},
                          'later': {'reasons': ["refused by an older importer"],
                                    'source': str(DATA / 'orgs' / 'later.db')}}}), encoding='utf-8')
        # one machine-wide account and one restricted to alpha (design §5.2 "Accounts")
        cls.accounts = {'version': 1, 'accounts': [
            {'id': 'claude-1', 'provider': 'claude', 'label': 'everywhere', 'enabled': True},
            {'id': 'claude-2', 'provider': 'claude', 'origin_org': cls.alpha, 'mode': 'apikey'}],
            'aliases': {'primary': 'claude-1'}, 'id_counters': {'claude': 2},
            'tint_counters': {'claude': 2}}
        (DATA / 'accounts-registry.json').write_text(json.dumps(cls.accounts), encoding='utf-8')
        cls.report = convert('first-pass')
        cls.rows = registry()

    def outcome(self, slug: str) -> dict:
        return next(o for o in self.report['orgs'] if o['slug'] == slug)

    def test_orgs_convert_exactly_and_the_marker_is_written(self) -> None:
        for slug in (self.alpha, self.beta):
            row = self.rows[slug]
            self.assertEqual(row['state'], 'active')
            self.assertEqual(canon(new_document(row['database'])), canon(self.want[slug]))
        with conn.connect(RUNTIME, names.app(PREFIX)) as c:
            self.assertIsNotNone(c.execute('SELECT legacy_cutover_at FROM app_settings').fetchone()[0])
        self.assertTrue(self.report['finished'])
        # these test nodes carry fields real agents do not (`children`): kept exactly, counted
        self.assertEqual(self.outcome(self.alpha)['kept_in_extra']['agents'].get('children'), 1)

    def test_a_second_pass_does_nothing(self) -> None:
        self.assertIn('skipped', convert('first-pass'))

    def test_accounts_convert_once_and_an_org_only_account_goes_to_its_org(self) -> None:
        from orgtree.orgdb.convert import accounts, run
        got = self.report['accounts']
        self.assertEqual((got['present'], got['machine_wide']), (True, 1))
        with conn.connect(RUNTIME, names.app(PREFIX)) as c:
            self.assertEqual(c.execute('SELECT id FROM accounts').fetchall(), [('claude-1',)])
        with conn.connect(RUNTIME, self.rows[self.alpha]['database']) as c:
            self.assertEqual(c.execute('SELECT id, origin_org FROM org_accounts').fetchall(),
                             [('claude-2', self.alpha)])
        with conn.connect(RUNTIME, self.rows[self.beta]['database']) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM org_accounts').fetchone()[0], 0)
        self.assertEqual(self.outcome(self.alpha)['side']['org_accounts'], 1)
        # a pass resumed after a crash finds them converted and checks them against the file
        cfg = types.SimpleNamespace(data_root=str(DATA), runtime_base=RUNTIME)
        lc = types.SimpleNamespace(prefix=PREFIX)
        self.assertIn('resumed', run._accounts(cfg, lc))
        path = DATA / 'accounts-registry.json'
        original = path.read_bytes()
        try:
            path.write_text(json.dumps(dict(self.accounts, aliases={'primary': 'claude-9'})),
                            encoding='utf-8')
            with self.assertRaises(accounts.AccountsMismatch):
                run._accounts(cfg, lc)
        finally:
            path.write_bytes(original)

    def test_ignored_and_unregistered_keys_are_listed(self) -> None:
        o = self.outcome(self.beta)
        self.assertEqual(o['ignored_with_values'], ['kiosk'])
        self.assertEqual(o['unregistered_keys'], ['hand_edited'])
        self.assertNotIn('kiosk', new_document(self.rows[self.beta]['database']))

    def test_planted_fault_leaves_only_that_org_unavailable_and_retry_recovers(self) -> None:
        row = self.rows[self.faulty]
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'conversion'))
        self.assertTrue(row['state_reason'])
        report = json.loads(Path(row['report_path']).read_text(encoding='utf-8'))
        self.assertEqual(report['org']['org_id'], self.faulty_legacy)
        self.assertEqual(report['error'], row['state_reason'])
        with conn.connect(ADMIN, 'postgres') as c:
            self.assertIsNone(c.execute('SELECT 1 FROM pg_database WHERE datname = %s',
                                        (row['database'],)).fetchone())
        with pgstore.connect() as c:           # repair exactly the planted rows, then Retry
            c.execute(f'SET search_path = org_{self.faulty_legacy}')
            c.execute("SET session_replication_role = replica")
            for key, val in self.planted.items():
                c.execute('UPDATE doc SET val = %s WHERE key = %s', (val, key))
        out = convert('retry', '--org-id', str(row['org_id']))
        self.assertEqual(out['outcome'], 'active', out)
        self.assertEqual(registry()[self.faulty]['attempts'], 1)

    def test_legacy_trashed_org_is_trashed_and_fenced(self) -> None:
        row = self.rows[self.trashed]
        self.assertEqual(row['state'], 'trashed')
        self.assertEqual(names.kind(row['database'], PREFIX), 'trash')
        import psycopg
        with self.assertRaises(psycopg.OperationalError):
            conn.connect(RUNTIME, row['database']).close()

    def test_orphan_is_listed_and_not_converted(self) -> None:
        self.assertNotIn(self.orphan, self.rows)
        self.assertIn(self.orphan, [o['slug'] for o in self.report['not_converted']])

    def test_an_org_the_first_launch_import_held_back_is_unavailable_at_import(self) -> None:
        row = self.rows['held']
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'import'))
        self.assertIn("unrecognised section 'x'", row['state_reason'])
        self.assertEqual(Path(row['legacy_file']), DATA / 'pre-postgres' / 'orgs' / 'held.json')

    def test_retry_imports_a_held_back_org_and_converts_it(self) -> None:
        row = self.rows['later']
        self.assertEqual((row['state'], row['unavailable_step']), ('unavailable', 'import'))
        out = convert('retry', '--org-id', str(row['org_id']))
        self.assertEqual(out['outcome'], 'active', out)
        now = registry()['later']
        self.assertEqual(now['state'], 'active')
        self.assertIsNotNone(now['legacy_org_id'])
        self.assertTrue((DATA / 'orgs' / 'later.pg').is_file())         # its marker, new
        self.assertEqual(sorted(new_document(now['database'])['nodes']), ['n1', 'n2'])
        # a file the importer still refuses stays unavailable at 'import', with the reason
        held = self.rows['held']
        out = convert('retry', '--org-id', str(held['org_id']))
        self.assertEqual(out['outcome'], 'unavailable')
        self.assertEqual(registry()['held']['unavailable_step'], 'import')

    def test_duplicate_markers_make_the_org_unavailable(self) -> None:
        dup = [r for r in self.rows.values() if 'twin' in r['slug']]
        self.assertEqual(len(dup), 1)
        self.assertEqual(dup[0]['state'], 'unavailable')
        self.assertIn('twin-copy.pg', dup[0]['state_reason'])


class Crash(BaseException):
    """A process dying mid-step: no handler in the converter catches it."""


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class OrgFaultIsolation(unittest.TestCase):
    """Review finding f18: every step after an org's claim is that org's (Q12). A failure
    while building one org's staging database, or while publishing a build renamed before a
    crash, leaves only that org unavailable with its report, and Retry recovers it. The
    converter runs in this process, so the faults can be planted; its registry (prefix) and
    data root (markers of its own orgs only) are its own."""

    @classmethod
    def setUpClass(cls) -> None:
        from orgtree.orgdb import lifecycle
        from orgtree.orgdb.convert import run
        cls.prefix = PREFIX + 'f_'
        cls.steady, cls.brittle, cls.resumed = make_org('Steady'), make_org('Brittle'), make_org('Resumed')
        tmp = Path(tempfile.mkdtemp(dir=_temp.name))
        cls.root = tmp / 'data'
        (cls.root / 'orgs').mkdir(parents=True)
        for slug in (cls.steady, cls.brittle):
            shutil.copy(DATA / 'orgs' / f'{slug}.pg', cls.root / 'orgs' / f'{slug}.pg')
        cls.cfg = run.Config(data_root=str(cls.root), work_root=str(tmp / 'work'),
                             report_dir=str(tmp / 'conversion'), build='f18',
                             legacy_base=_with_db(RUNTIME, LEGACY), runtime_base=RUNTIME)
        cls.lc = cls.lifecycle()
        cls.before = cls.inventory()
        real = lifecycle.Lifecycle._migrate_org_db
        brittle = cls.brittle

        def flaky(self, dbname):
            out = real(self, dbname)
            if [r['slug'] for r in self.rows() if r['op_target_db'] == dbname] == [brittle]:
                raise RuntimeError('planted: migrating the staging database failed')
            return out

        with mock.patch.object(lifecycle.Lifecycle, '_migrate_org_db', flaky):
            cls.report = run.first_pass(cls.lc, cls.cfg)

    @classmethod
    def lifecycle(cls):
        """A new engine instance on this class's registry."""
        from orgtree.orgdb import lifecycle
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=cls.prefix,
                                 build='f18')
        lc.bootstrap()
        return lc

    @classmethod
    def inventory(cls) -> dict:
        from orgtree.orgdb.convert import legacy
        ids = {s: pgstore.read_marker(str(DATA / 'orgs' / f'{s}.pg'))
               for s in (cls.steady, cls.brittle, cls.resumed)}
        with conn.connect(_with_db(RUNTIME, LEGACY), LEGACY, autocommit=False) as c:
            c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                return {s: legacy.inventory(c, i) for s, i in ids.items()}
            finally:
                c.rollback()

    def databases(self) -> set:
        with conn.connect(ADMIN, 'postgres') as c:
            return {d for (d,) in c.execute('SELECT datname FROM pg_database WHERE datname LIKE %s',
                                            (self.prefix + '%',)).fetchall()}

    def test_a_failing_staging_database_leaves_only_that_org_unavailable(self) -> None:
        from orgtree.orgdb.convert import run
        self.assertTrue(self.report['finished'])
        bad = next(o for o in self.report['orgs'] if o['slug'] == self.brittle)
        self.assertEqual(bad['outcome'], 'unavailable', bad)
        self.assertIn('planted', bad['reason'])
        self.assertTrue(Path(bad['report']).is_file())
        rows = {r['slug']: r for r in self.lc.rows()}
        row = rows[self.brittle]
        self.assertEqual((row['state'], row['unavailable_step'], row['op_kind']),
                         ('unavailable', 'conversion', None))
        self.assertEqual(row['report_path'], bad['report'])
        self.assertEqual(rows[self.steady]['state'], 'active')
        self.assertEqual(canon(new_document(rows[self.steady]['database'])),
                         canon(legacy_document(self.steady)))
        self.assertFalse([d for d in self.databases() if '_stage_' in d])   # no lingering stage
        with conn.connect(RUNTIME, names.app(self.prefix)) as c:
            self.assertIsNotNone(c.execute('SELECT legacy_cutover_at FROM app_settings').fetchone()[0])
        self.assertEqual(self.inventory(), self.before)                    # legacy inputs untouched
        # Retry, with nothing planted, converts it
        out = run.retry(self.lc, self.cfg, int(row['org_id']))
        self.assertEqual(out['outcome'], 'active', out)
        self.assertEqual(canon(new_document(self.lc.row(int(row['org_id']))['database'])),
                         canon(legacy_document(self.brittle)))

    def test_a_failing_resumed_publication_is_that_orgs_and_retry_recovers(self) -> None:
        from orgtree.orgdb import lifecycle
        from orgtree.orgdb.convert import legacy, run
        shutil.copy(DATA / 'orgs' / f'{self.resumed}.pg', self.root / 'orgs' / f'{self.resumed}.pg')
        with conn.connect(self.cfg.legacy_base, LEGACY) as c:
            org = next(o for o in legacy.classify(c, str(self.root)) if o.slug == self.resumed)
        legacy.prepare_root(self.cfg.work_root, [org])
        org_id = run._register(self.lc, self.cfg, org)
        # 1. the process dies right after the rename: the claim stays at step 'renamed'
        with mock.patch.object(lifecycle.Lifecycle, '_release', side_effect=Crash('died')), \
                self.assertRaises(Crash):
            run.convert_org(self.lc, self.cfg, org, org_id)
        row = self.lc.row(org_id)
        self.assertEqual((row['state'], row['op_step']), ('converting', 'renamed'))
        self.assertIn(row['database'], self.databases())
        # 2. the next engine instance takes it over, and publishing the renamed build fails
        lc2 = self.lifecycle()
        claim = next(c for c in lc2.take_over() if c.org_id == org_id)
        with mock.patch.object(lifecycle.Lifecycle, 'publish',
                               side_effect=RuntimeError('planted: publishing failed')):
            out = run.convert_org(lc2, self.cfg, org, org_id, claim=claim)
        self.assertEqual(out['outcome'], 'unavailable', out)
        self.assertIn('planted', out['reason'])
        row = lc2.row(org_id)
        self.assertEqual((row['state'], row['unavailable_step'], row['op_kind']),
                         ('unavailable', 'conversion', None))
        left = self.databases()
        self.assertNotIn(row['database'], left)          # the unpublished build went with it
        self.assertFalse([d for d in left if '_stage_' in d])
        # 3. Retry converts it again and publishes it
        out = run.retry(lc2, self.cfg, org_id)
        self.assertEqual(out['outcome'], 'active', out)
        row = lc2.row(org_id)
        self.assertEqual(row['state'], 'active')
        self.assertEqual(canon(new_document(row['database'])), canon(legacy_document(self.resumed)))

    def test_a_claim_another_operation_holds_is_not_cleaned_up(self) -> None:
        from orgtree.orgdb import lifecycle
        from orgtree.orgdb.convert import legacy, run
        with conn.connect(self.cfg.legacy_base, LEGACY) as c:
            org = next(o for o in legacy.classify(c, str(self.root)) if o.slug == self.steady)
        org_id = next(int(r['org_id']) for r in self.lc.rows() if r['slug'] == self.steady)
        other = self.lifecycle().claim(org_id, 'retry')          # another operation's claim
        before = self.lc.row(org_id)
        try:
            with self.assertRaises(lifecycle.Busy):
                run.convert_org(self.lc, self.cfg, org, org_id, kind='retry')
            self.assertEqual(self.lc.row(org_id), before)        # untouched
            self.assertEqual((before['op_kind'], before['op_epoch']), (other.kind, other.epoch))
            self.assertEqual(before['state'], 'active')
        finally:                                                 # that other operation ends
            with conn.connect(ADMIN, names.app(self.prefix)) as c:
                c.execute('UPDATE orgtree.orgs SET op_kind = NULL, op_step = NULL, op_owner = NULL, '
                          'op_target_db = NULL, op_started_at = NULL WHERE org_id = %s', (org_id,))


if __name__ == '__main__':
    unittest.main()
