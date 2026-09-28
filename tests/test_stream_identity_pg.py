"""The stream projection and races on PostgreSQL, in an owned database."""
import os
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_stream_identity_t{os.getpid()}'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import test_stream_identity_reads as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PostgresStreamIdentity(fixture.StreamIdentityReads):
    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])


def tearDownModule():
    if ADMIN:
        from orgtree import pgstore, transcript_records
        transcript_records.close_all()
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
