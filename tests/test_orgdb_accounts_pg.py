"""The machine-wide accounts through a real app database (design §2.10, §5.2 "Accounts").

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module creates is named with
                               its own prefix t<pid>_ and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves, on an app database the lifecycle bootstrapped (0001 and 0002 applied, the
runtime role granted), with the RUNTIME role in one transaction the caller owns:
  * an absent registry file converts nothing;
  * convert_accounts writes test_orgdb_accounts' registry; rolled back, nothing stays;
  * a read-back that differs from the file refuses (AccountsMismatch);
  * committed, read_accounts rebuilds exactly the file's machine-wide part (canonical JSON):
    floats to the last digit, U+0000 inside a json column and inside extra, nulls, containers
    kept whole, the top-level key order; the restricted rows come back per org and leave no
    row here; app_settings holds the instants and their exact numbers;
  * a second conversion refuses (AccountsAlreadyConverted);
  * every 0002 table has exactly the columns and types its spec writes;
  * the registry file is unchanged.

Run:  python tools/run-python-verification.py tests/test_orgdb_accounts_pg.py
"""

import datetime as dt
import hashlib
import json
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

from orgtree.orgdb import conn, lifecycle, names  # noqa: E402
from orgtree.orgdb.convert import accounts  # noqa: E402
from test_orgdb_accounts import canon, registry  # noqa: E402
from test_orgdb_sidefiles_pg import expected_columns  # noqa: E402

EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def _drop_all() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


def table_counts(c) -> dict[str, int]:
    return {t: c.execute(f'SELECT count(*) FROM orgtree.{t}').fetchone()[0] for t in accounts.APP_TABLES}


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class ThroughTheAppDatabase(unittest.TestCase):
    def test_convert_in_one_transaction_then_refuse_a_second_time(self) -> None:
        _drop_all()
        tmp = Path(tempfile.mkdtemp(prefix='orgdb-accounts-pg-'))
        self.addCleanup(shutil.rmtree, tmp, True)
        path = tmp / accounts.REGISTRY_FILE
        doc = registry()
        path.write_text(json.dumps(doc, indent=1), encoding='utf-8')
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build='test')
        lc.bootstrap()
        app = names.app(PREFIX)
        empty = {t: 0 for t in accounts.APP_TABLES}

        with conn.connect(RUNTIME, app, autocommit=False) as c:
            out = accounts.convert_accounts(c, str(tmp / 'absent.json'))
            self.assertEqual((out['machine_wide'], out['restricted'], out['report']['present']),
                             (0, {}, False))
            self.assertEqual(table_counts(c), empty)
            c.rollback()

        with conn.connect(RUNTIME, app, autocommit=False) as c:
            out = accounts.convert_accounts(c, str(path))
            self.assertEqual(out['machine_wide'], 4)
            c.rollback()
        with conn.connect(RUNTIME, app) as c:
            self.assertEqual(table_counts(c), empty)
            self.assertEqual(accounts.read_accounts(c), {})
            self.assertIsNone(c.execute('SELECT apikey_cutover_at FROM app_settings').fetchone()[0])

        with conn.connect(RUNTIME, app, autocommit=False) as c:
            with patch.object(accounts, 'read_accounts', lambda conn_: {**doc, 'version': 2}):
                with self.assertRaises(accounts.AccountsMismatch):
                    accounts.convert_accounts(c, str(path))
            c.rollback()

        with conn.connect(RUNTIME, app, autocommit=False) as c:
            out = accounts.convert_accounts(c, str(path))
            c.commit()
        self.assertEqual({k: [r['id'] for r in v['accounts']] for k, v in out['restricted'].items()},
                         {'acme': ['claude-2'], 'beta': ['claude-3']})
        self.assertEqual(out['report']['verified']['source'], out['report']['verified']['dest'])

        machine = accounts.split_registry(doc)[0]
        with conn.connect(RUNTIME, app) as c:
            back = accounts.read_accounts(c)
            self.assertEqual(canon(back), canon(machine))
            self.assertEqual(list(back), list(doc))
            self.assertEqual(c.execute("SELECT count(*) FROM accounts WHERE id IN ('claude-2', 'claude-3')")
                             .fetchone()[0], 0)
            version, cutover, cutover_text, migrated, migrated_text = c.execute(
                'SELECT accounts_version, apikey_cutover_at, apikey_cutover_at_text, '
                'accounts_migrated_at, accounts_migrated_at_text FROM app_settings').fetchone()
            self.assertEqual(version, 1)
            self.assertEqual(cutover, EPOCH + dt.timedelta(seconds=1759400000.1234567))
            self.assertEqual(json.loads(cutover_text), 1759400000.1234567)
            self.assertEqual((migrated, migrated_text), (EPOCH + dt.timedelta(seconds=1759300000), '1759300000'))
            identity = c.execute("SELECT identity FROM accounts WHERE id = 'claude-4'").fetchone()[0]
            self.assertEqual(identity, {'nul': 'x\x00y'})
            for t in (accounts.ACCOUNTS, accounts.MARKS, accounts.SPENDS, accounts.ALIASES,
                      accounts.COUNTERS, accounts.AUDITS):
                got = dict(c.execute("SELECT column_name, data_type FROM information_schema.columns "
                                     "WHERE table_schema = 'orgtree' AND table_name = %s",
                                     (t.spec.table,)).fetchall())
                self.assertEqual(got, expected_columns(t), t.spec.table)

        with conn.connect(RUNTIME, app, autocommit=False) as c:
            with self.assertRaises(accounts.AccountsAlreadyConverted):
                accounts.convert_accounts(c, str(path))
            c.rollback()
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)


if __name__ == '__main__':
    unittest.main()
