"""PG-5: the race harness (tests/racekit.py) on PostgreSQL (PG-0's PgBackend).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL  a superuser URL; racekit.disposable_pg creates and
                             drops its own database `orgtree_pg5_t<pid>`
  ORGTREE_TEST_PYDEPS        (optional) a folder holding psycopg
Without the URL every test SKIPS — a skip is not a pass.

What it proves: the harness's PostgreSQL probe sees a real server-side lock
wait (pg_stat_activity wait_event_type 'Lock' for the actor's own backend
pid) when two actors write one node row, and sees none for another row; the
forced order is achieved and no update is lost.

Run:  python tools/run-python-verification.py tests/test_racekit_pg.py
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DEPS = os.environ.get('ORGTREE_TEST_PYDEPS', '').strip()
if DEPS:
    sys.path.insert(0, DEPS)
sys.path.insert(0, str(Path(__file__).resolve().parent))

_temp = tempfile.TemporaryDirectory(prefix='v3-racekit-pg-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()

import racekit  # noqa: E402  (imports no orgtree module)

URL = racekit.disposable_pg(ADMIN, 'orgtree_pg5') if ADMIN else ''
if URL:
    os.environ['ORGTREE_PG_URL'] = URL
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='postgres', ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402


def tearDownModule() -> None:
    if URL:
        racekit.drop_disposable_pg(ADMIN, URL)     # WITH (FORCE) ends our sessions


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class RaceKitPg(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        store.claim_data_root()          # migrates
        orgtx.use_backend(orgtx.PgBackend())

    def setUp(self) -> None:
        org = store.create_org(f'rkpg-{self._testMethodName}')
        self.slug = org.d['slug']
        for nid in ('a', 'b'):
            org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None,
                                   'children': [], 'n': 0}
        store.save_org(org)
        store.save_org(store.load_org(self.slug))

    def bump(self, nid: str) -> None:
        with orgtx.org_tx(self.slug, nodes=[nid]) as tx:
            tx.d['nodes'][nid]['n'] += 1

    def n(self, nid: str) -> int:
        return store.load_org(self.slug).d['nodes'][nid]['n']

    def test_facts_name_the_disposable_database(self) -> None:
        with racekit.Race() as race:
            pass
        self.assertEqual(race.facts['pg_database'], f'orgtree_pg5_t{os.getpid()}')
        self.assertEqual(race.facts['backend'], 'postgres')

    def test_same_row_wait_is_seen_by_the_server(self) -> None:
        with racekit.Race() as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'a')
            ga = race.hold(a, 'after_lock')
            race.start(a)
            race.reached(ga)
            race.start(b)
            how = race.blocked(b)
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.blocked', 'A.after_commit',
                              'B.after_lock', 'B.after_commit')
        self.assertIn('postgres Lock/', how)
        self.assertEqual(self.n('a'), 2)

    def test_other_row_is_not_blocked(self) -> None:
        with racekit.Race() as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'b')
            ga = race.hold(a, 'after_lock')
            gb = race.hold(b, 'after_commit')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.not_blocked(b, gb)
            race.release(gb)
            race.release(ga)
            race.join(a, b)
            race.expect_order('A.after_lock', 'B.after_commit', 'A.after_commit')
        self.assertEqual((self.n('a'), self.n('b')), (1, 1))

    def test_blocked_on_a_free_row_fails(self) -> None:
        with racekit.Race(wait=0.5) as race:
            a = race.actor('A', self.bump, 'a')
            b = race.actor('B', self.bump, 'b')
            ga = race.hold(a, 'after_lock')
            gb = race.hold(b, 'after_lock')
            race.start(a)
            race.reached(ga)
            race.start(b)
            race.reached(gb)
            with self.assertRaisesRegex(racekit.RaceFailure, 'never seen waiting'):
                race.blocked(b)
            race.release(ga)
            race.release(gb)
            race.join(a, b)


if __name__ == '__main__':
    unittest.main()
