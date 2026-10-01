"""Real second-process PostgreSQL revocation, with the old cache held back.

Needs ORGTREE_TEST_PG_ADMIN_URL; creates and drops its own database.
The writer imports this checkout's engine and commits through store.save_org.
The HTTP reader receives no cache invalidation before checking the token.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_steer_credential_t{os.getpid()}'
REPO = Path(__file__).resolve().parents[1]
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    p = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((p.scheme, p.netloc, '/' + DBNAME, p.query, p.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import test_steer_poll_cost as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

WRITER = '''
import json, os, sys
sys.path.insert(0, str(__import__('pathlib').Path(sys.argv[1]) / 'tools'))
from assert_repo_import import assert_repo_import
prov = assert_repo_import(sys.argv[1])
from orgtree import store
slug, nid, kind = sys.argv[2:5]
with store.DOC_LOCK:
    org = store.load_org(slug)
    node = org.node(nid)
    if kind == 'generation': node['generation'] = int(node['generation']) + 1
    elif kind == 'seat': node['seat_id'] = 'foreign-process-seat'
    elif kind == 'archive': node['state'] = 'archived'
    else: raise AssertionError(kind)
    store.save_org(org)
current = store.load_org(slug).node(nid)
print(json.dumps({'pid': os.getpid(), 'file': store.__file__, 'state': current['state'],
                  'generation': current['generation'], 'seat_id': current['seat_id']}))
'''


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class ExternalRevocationTests(unittest.TestCase):
    CHEAP = True

    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    setUp = fixture.SteerPollCostTests.setUp
    tearDown = fixture.SteerPollCostTests.tearDown
    token = fixture.SteerPollCostTests.token
    poll = fixture.SteerPollCostTests.poll
    carrier = fixture.SteerPollCostTests.carrier

    def revoked(self, kind):
        token = self.token()
        self.assertEqual(self.poll(token).status_code, 200)
        self.carrier('must stay private after foreign revoke')
        old = fixture.store.cached_org(self.slug)
        result = subprocess.run([sys.executable, '-c', WRITER, str(REPO), self.slug, fixture.W, kind],
                                cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        written = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertNotEqual(written['pid'], os.getpid())
        self.assertTrue(Path(written['file']).resolve().is_relative_to(REPO))
        current = fixture.orgtx.org_read(self.slug).node(fixture.W)
        fields = ('state', 'generation', 'seat_id')
        self.assertEqual([current[k] for k in fields], [written[k] for k in fields])
        self.assertNotEqual([old.node(fixture.W)[k] for k in fields], [written[k] for k in fields])
        with patch.object(fixture.store, 'cached_org', return_value=old):
            response = self.poll(token)
        self.assertEqual(response.status_code, 403, response.text)
        self.assertTrue(self.st['steer'], 'revoked poll consumed the pending carrier')

    def test_generation_revoke_from_other_process(self):
        self.revoked('generation')

    def test_seat_replacement_from_other_process(self):
        self.revoked('seat')

    def test_archive_from_other_process(self):
        self.revoked('archive')


def tearDownModule():
    fixture.tearDownModule()
    if ADMIN:
        from orgtree import pgstore
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')


if __name__ == '__main__':
    unittest.main()
