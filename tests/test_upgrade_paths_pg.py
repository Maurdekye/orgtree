"""Published release fixtures -> converter CLI -> independent relational verifier.

Heavy run: P03 -Wait, disposable PostgreSQL only. Missing URLs skip the PG cases.
Fixture regeneration and the isolated-cluster launcher are documented beside the fixtures.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlsplit, urlunsplit

import child_python
from orgtree import ledger

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/upgrade-paths'
ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '')
PG_BIN = os.environ.get('ORGTREE_TEST_PG_BIN', '')
spec = importlib.util.spec_from_file_location('upgrade_independent_verifier', ROOT / 'tools/orgdb_verify.py')
verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = verifier
spec.loader.exec_module(verifier)


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def with_db(url, database):
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, '/' + database, p.query, p.fragment))


def files(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def inventory(database):
    """Independent checksum of every source table, including its migration registry."""
    import psycopg
    from psycopg import sql
    with psycopg.connect(with_db(ADMIN, database)) as c:
        tables = c.execute("SELECT table_schema, table_name FROM information_schema.tables "
                           "WHERE table_type = 'BASE TABLE' AND "
                           "(table_schema = 'public' OR table_schema LIKE 'org\\_%' ESCAPE '\\') "
                           "ORDER BY table_schema, table_name").fetchall()
        result = {}
        for schema, table in tables:
            rows = c.execute(sql.SQL('SELECT row_to_json(t)::text FROM {}.{} t '
                                     'ORDER BY row_to_json(t)::text COLLATE "C"')
                             .format(sql.Identifier(schema), sql.Identifier(table))).fetchall()
            result[schema + '.' + table] = (len(rows), sha(rows))
        return result


class FixtureIntegrity(unittest.TestCase):
    def test_release_documents_and_files_match_committed_manifests(self):
        for release in ('2.1.14', '3.0.9', '3.1.0'):
            folder = FIXTURES / release
            manifest = json.loads((folder / 'manifest.json').read_text())
            with self.subTest(release=release):
                self.assertEqual(manifest['tag'], 'v' + release)
                self.assertRegex(manifest['commit'], r'^[0-9a-f]{40}$')
                self.assertEqual({p.name for p in folder.iterdir() if p.is_file()},
                                 set(manifest['files']) | {'manifest.json'})
                for name, checksum in manifest['files'].items():
                    data = (folder / name).read_bytes()
                    if Path(name).suffix in ('.json', '.pg', '.sql'):
                        data = data.replace(b'\r\n', b'\n')
                    self.assertEqual(hashlib.sha256(data).hexdigest(), checksum, name)
                for slug, sections in manifest['orgs'].items():
                    doc = json.loads((folder / (slug + '.json')).read_text())
                    self.assertEqual(set(manifest['normalized_away']), {'account_token_uuid', 'default_dirs'})
                    self.assertEqual(set(manifest['not_written_by_release']),
                                     {'turn_log', 'work_scope_log'} if release == '2.1.14' else set())
                    covered = set(doc) | set(manifest['normalized_away']) | set(manifest['not_written_by_release'])
                    self.assertFalse(set(ledger.NODE_KEYED_SECTIONS) - covered)
                    self.assertEqual(set(sections), set(doc))
                    for key, value in doc.items():
                        self.assertEqual(sections[key], {'count': len(value) if isinstance(value, (dict, list))
                                                         else 1, 'sha256': sha(value)}, key)


class UpgradePath:
    release = None

    def setUp(self):
        import psycopg
        from psycopg import sql
        self.temp = tempfile.TemporaryDirectory(prefix='upgrade-path-', ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        (self.data / 'orgs').mkdir(parents=True)
        self.prefix = f'up{os.getpid()}_{self.release.replace(".", "")}_'
        self.database = self.prefix + 'legacy'
        self.addCleanup(self.drop_databases)
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(self.database)))
        self.folder = FIXTURES / self.release
        self.manifest = json.loads((self.folder / 'manifest.json').read_text())
        self.docs = {s: json.loads((self.folder / (s + '.json')).read_text())
                     for s in self.manifest['orgs']}
        if self.release == '2.1.14':
            # This is the landed first-launch import's one-org CLI, through PgSink.
            # It applies 0001-0020 only to this NEW legacy database.
            for slug in self.docs:
                source = self.data / 'pre-postgres/orgs' / (slug + '.db')
                source.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.folder / source.name, source)
                self.child(str(ROOT / 'tools/pypg/pgimport.py'), 'import-held', '--file', str(source),
                           '--slug', slug, '--orgs-dir', str(self.data / 'orgs'),
                           extra={'ORGTREE_PGIMPORT_CONNINFO': with_db(ADMIN, self.database)})
        else:
            psql = str(Path(PG_BIN) / 'psql.exe') if PG_BIN else shutil.which('psql')
            self.assertTrue(psql, 'set ORGTREE_TEST_PG_BIN to the disposable PostgreSQL binaries')
            done = subprocess.run([psql, '--dbname', with_db(ADMIN, self.database), '--set', 'ON_ERROR_STOP=1',
                                   '--file', str(self.folder / 'legacy.sql')], capture_output=True,
                                  text=True, timeout=120)
            self.assertEqual(done.returncode, 0, done.stderr[-4000:])
            for slug in self.docs:
                shutil.copyfile(self.folder / (slug + '.pg'), self.data / 'orgs' / (slug + '.pg'))
        with psycopg.connect(with_db(ADMIN, self.database)) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM public.schema_migrations').fetchone()[0],
                             19 if self.release == '3.0.9' else 20)

    def drop_databases(self):
        import psycopg
        from psycopg import sql
        with psycopg.connect(ADMIN, autocommit=True) as c:
            dbs = c.execute('SELECT datname FROM pg_database').fetchall()
            for (db,) in dbs:
                if db.startswith(self.prefix):
                    c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))

    def child(self, *args, extra=None):
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
            ('ORGTREE_', 'PYTHON', 'OPENAI_', 'CLAUDE_', 'CODEX_', 'ANTHROPIC_', 'GEMINI_'))}
        env.update(ORGTREE_DATA=str(self.data), ORGTREE_PG_CONNINFO=with_db(RUNTIME, self.database),
                   ORGTREE_PG_ADMIN_CONNINFO=ADMIN, ORGTREE_ORGDB_PREFIX=self.prefix,
                   HOME=self.temp.name, USERPROFILE=self.temp.name, PYTHONIOENCODING='utf-8')
        env.update(extra or {})
        done = subprocess.run(child_python.argv(*args), env=env, capture_output=True, text=True, timeout=180)
        self.assertEqual(done.returncode, 0, done.stdout[-1000:] + done.stderr[-5000:])
        return done

    def convert(self, mode='first-pass', *args):
        report = Path(tempfile.mkdtemp(dir=self.temp.name))
        source_dir = report / 'source'
        self.load_started = datetime.now(timezone.utc)
        self.child(str(ROOT / 'tools/run-upgrade-converter.py'), str(source_dir), mode,
                   *args, '--data-root', str(self.data),
                   '--report-dir', str(report), '--build', 'upgrade-path-test')
        self.load_finished = datetime.now(timezone.utc)
        self.sources = {p.stem: json.loads(p.read_text()) for p in source_dir.glob('*.json')}
        return json.loads((report / 'run.json').read_text())

    def expected_source(self, slug, source):
        """Fixed tag values plus only the measured current-loader additions.

        2.1.14 predates Argon defaults and the principal-seat migration. Its
        fixture already has a seat, so that migration must report zero changes.
        Validate the generated timestamp before including it in the oracle;
        no other value comes from the loaded or converted document.
        """
        expected = json.loads(json.dumps(self.docs[slug]))
        if self.release == '2.1.14':
            self.assertNotIn('argon', expected['models'])
            self.assertNotIn('argon', expected['tiers'])
            self.assertNotIn('principal_seat_ids', expected['_migrations'])
            expected['models']['argon'] = 'gemini-4-argon'
            expected['tiers']['argon'] = 2
            stamp = source['_migrations']['principal_seat_ids']['at']
            self.assertRegex(stamp, r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
            at = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            # The ledger's timestamp has millisecond precision.
            self.assertGreaterEqual(at.timestamp(), self.load_started.timestamp() - 0.001)
            self.assertLessEqual(at, self.load_finished)
            expected['_migrations']['principal_seat_ids'] = {'at': stamp, 'minted': 0, 'shared': 0}
        return expected

    def registry(self):
        import psycopg
        from psycopg.rows import dict_row
        with psycopg.connect(with_db(RUNTIME, self.prefix + 'app'), row_factory=dict_row) as c:
            return {r['slug']: r for r in c.execute('SELECT * FROM orgs')}

    def verify(self, slug, row):
        import psycopg
        self.assertEqual(row['state'], 'active')
        source = self.sources[slug]
        expected_source = self.expected_source(slug, source)
        changed = {key: {'expected': expected_source.get(key), 'loaded': source.get(key)}
                   for key in set(source) | set(expected_source)
                   if sha(source.get(key)) != sha(expected_source.get(key))}
        self.assertEqual(sha(source), sha(expected_source),
                         'source loader changed fixture values: ' + json.dumps(changed)[:6000])
        dest = with_db(RUNTIME, row['database'])
        with psycopg.connect(dest) as c:
            actual_keys = [r[0] for r in c.execute('SELECT key FROM orgtree.org_sections ORDER BY ord')]
        expected_keys = [k for k in source if k not in verifier.IGNORED_DEFAULT]
        if actual_keys != expected_keys:
            differences = [(i, a, b) for i, (a, b) in enumerate(zip(expected_keys, actual_keys)) if a != b]
            self.fail(f'top-level order: source-only={set(expected_keys) - set(actual_keys)}, '
                      f'destination-only={set(actual_keys) - set(expected_keys)}, '
                      f'first differences={differences[:8]}')
        report = verifier.verify_report(source, dest)
        self.assertEqual(report['problems'], [], json.dumps(report['problems'])[:5000])
        self.assertGreater(report['stats'].get('records agents', 0), 0)
        with psycopg.connect(dest) as c:
            actual = {kind: [sc, dc, ss, ds] for kind, sc, dc, ss, ds in c.execute(
                'SELECT kind, source_count, dest_count, source_sha256, dest_sha256 FROM '
                'orgtree.conversion_run_kinds')}
        expected = {key: [len(v) if isinstance(v, (dict, list)) else 1,
                          len(v) if isinstance(v, (dict, list)) else 1, sha(v), sha(v)]
                    for key, v in expected_source.items() if key not in verifier.IGNORED_DEFAULT}
        self.assertEqual(actual, expected)

    def test_upgrade_checks_counts_checksums_and_independent_values(self):
        import psycopg
        before, before_files = inventory(self.database), files(self.data)
        report = self.convert()
        self.assertTrue(report['finished'])
        rows = self.registry()
        self.assertEqual(set(rows), {'alpha', 'beta'})
        for slug, row in rows.items():
            self.verify(slug, row)
        self.assertEqual(inventory(self.database), before)
        self.assertEqual(files(self.data), before_files)
        # Count-preserving corruption must be rejected by the independent verifier.
        dest = with_db(ADMIN, rows['alpha']['database'])
        with psycopg.connect(dest) as c:
            count = c.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0]
            changed = c.execute("UPDATE orgtree.agents SET title = 'Corrupted title' "
                                "WHERE name = 'lead'").rowcount
            self.assertEqual(changed, 1)
            self.assertEqual(c.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0], count)
        self.assertTrue(verifier.verify(self.sources['alpha'], with_db(RUNTIME, rows['alpha']['database'])))

    def test_fault_isolates_one_org_keeps_legacy_unchanged_and_retry_succeeds(self):
        import psycopg
        from psycopg import sql
        marker = json.loads((self.data / 'orgs/beta.pg').read_text())
        schema = 'org_' + str(marker['org_id'])
        with psycopg.connect(with_db(ADMIN, self.database)) as c:
            c.execute('SET session_replication_role = replica')
            q = sql.SQL('SELECT key, val FROM {}.doc WHERE val LIKE %s').format(sql.Identifier(schema))
            planted = c.execute(q, ('%second-task%',)).fetchall()
            self.assertTrue(planted, 'fault must change an actual source docket row')
            for key, val in planted:
                c.execute(sql.SQL('UPDATE {}.doc SET val = %s WHERE key = %s').format(sql.Identifier(schema)),
                          (val.replace('second-task', 'synthetic-task'), key))
        before, before_files = inventory(self.database), files(self.data)
        report = self.convert()
        self.assertTrue(report['finished'])
        rows = self.registry()
        self.verify('alpha', rows['alpha'])
        self.assertEqual(rows['beta']['state'], 'unavailable')
        self.assertEqual(rows['beta']['unavailable_step'], 'conversion')
        self.assertTrue(rows['beta']['state_reason'])
        self.assertTrue(Path(rows['beta']['report_path']).is_file())
        self.assertEqual(inventory(self.database), before)
        self.assertEqual(files(self.data), before_files)
        with psycopg.connect(with_db(ADMIN, self.database)) as c:
            c.execute('SET session_replication_role = replica')
            for key, val in planted:
                c.execute(sql.SQL('UPDATE {}.doc SET val = %s WHERE key = %s').format(sql.Identifier(schema)),
                          (val, key))
        clean = inventory(self.database)
        self.convert('retry', '--org-id', str(rows['beta']['org_id']))
        self.verify('beta', self.registry()['beta'])
        self.assertEqual(inventory(self.database), clean)
        self.assertEqual(files(self.data), before_files)


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable PG admin and runtime URLs')
class From2114(UpgradePath, unittest.TestCase):
    release = '2.1.14'


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable PG admin and runtime URLs')
class From309(UpgradePath, unittest.TestCase):
    release = '3.0.9'


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable PG admin and runtime URLs')
class From310(UpgradePath, unittest.TestCase):
    release = '3.1.0'


if __name__ == '__main__':
    unittest.main()
