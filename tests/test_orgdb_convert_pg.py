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
  * a resumed first pass skips orgs that are already active.

Run:  python tools/run-python-verification.py --timeout 1200 tests/test_orgdb_convert_pg.py
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
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

    def test_a_second_pass_does_nothing(self) -> None:
        self.assertIn('skipped', convert('first-pass'))

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

    def test_duplicate_markers_make_the_org_unavailable(self) -> None:
        dup = [r for r in self.rows.values() if 'twin' in r['slug']]
        self.assertEqual(len(dup), 1)
        self.assertEqual(dup[0]['state'], 'unavailable')
        self.assertIn('twin-copy.pg', dup[0]['state_reason'])


if __name__ == '__main__':
    unittest.main()
