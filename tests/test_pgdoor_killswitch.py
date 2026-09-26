"""D2 (plan decision 26): the org killswitch against an in-flight door call.

The door holds the `killswitch` row FOR SHARE for the whole transaction and
checks it on the locked copy; a latch takes the same row FOR UPDATE
(halt.killswitch_latch, through org_tx). So the two can never BOTH commit
with the door's work landing after the latch:

  · latch DURING a door call — the latch parks on the row until the door
    commits (the wait is PROVEN from the lock manager / pg_stat_activity, not
    slept for), and only then latches;
  · door call DURING a latch — the door parks, and once the latch commits it
    refuses (KILLSWITCHED) without running its body.

Each is run on a FRESH org (killswitch never set) and on a RELEASED one
(latched then released). Before PG-0b neither had a killswitch row, and
FOR SHARE on an absent row locks nothing on PostgreSQL: the latch inserted
straight past the door (native-design-review's P6a). PG-0b's ALWAYS_ROWS
keeps the row present (null when released), which is what these prove.

Backends:
  · Seam (always runs): PG-0's SeamBackend, in-process RowLocks.
  · Pg (needs ORGTREE_TEST_PG_ADMIN_URL, a disposable loopback server; SKIPS
    otherwise — a skip is not a pass): the real PgBackend, where an absent
    row really does lock nothing.
Both run with the transition fence OFF, which would otherwise serialize the
two behind DOC_LOCK and hide the row locks this is about.

Run:  python tools/run-python-verification.py tests/test_pgdoor_killswitch.py
"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DEPS = os.environ.get('ORGTREE_TEST_PYDEPS', '').strip()
if DEPS:
    sys.path.insert(0, DEPS)
sys.path.insert(0, str(Path(__file__).resolve().parent))

_temp = tempfile.TemporaryDirectory(prefix='pgdoor-ks-', ignore_cleanup_errors=True)
_data = Path(_temp.name) / 'data'
_data.mkdir()
_home = Path(_temp.name) / 'home'
_home.mkdir()

URL = ''
if ADMIN:
    import racekit  # noqa: E402  (imports no orgtree module)
    URL = racekit.disposable_pg(ADMIN, 'orgtree_pgdoor_ks')
    os.environ['ORGTREE_PG_URL'] = URL
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_STORE='postgres' if URL else 'sqlite')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from orgtree import halt, ledger, orgtx, pgdoor, store  # noqa: E402
from orgtree.ledger import LedgerError  # noqa: E402

orgtx.TRANSITION_FENCE = False

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]
WAIT = 10.0


def tearDownModule():
    if URL:
        racekit.drop_disposable_pg(ADMIN, URL)


class Body:
    def __init__(self, slug, node, tool='orgtree_pgdoor_test', op_key=None):
        self.org, self.node, self.tool, self.op_key = slug, node, tool, op_key


def _admit(org, body, a):
    return None


def _file(*_a):
    raise AssertionError('no receipt rides these calls')


class _KillswitchVsDoor:
    """Shared cases; a subclass supplies `parked()` for its backend."""

    def setUp(self):
        _N[0] += 1
        self.slug = f'ks{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'boss')
        org.hire('boss', 'boss', 'luna', 0, 'worker', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        store.save_org(org)
        # PG-0's real org_tx, counted: every transaction the DOOR opens is
        # recorded with whether it held the killswitch. One attempt holding it
        # is the claim; a lock set healed by a widening re-run is not.
        self.opens = []

        def counted(slug, **k):
            self.opens.append('killswitch' in (k.get('share_sections') or ()))
            return orgtx.org_tx(slug, **k)
        pgdoor.use_org_tx(counted)
        self.order = []

    def tearDown(self):
        pgdoor.use_org_tx(None)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ helpers
    def released(self):
        """Latch and release, so the row is the CLEARED value, not absent."""
        halt.killswitch_latch(self.slug)
        self.assertTrue(halt.killswitch_release(self.slug)['released'])
        self.assertFalse(store.load_org(self.slug).d.get('killswitch'))

    def settle(self, go, *threads):
        """A failing case must not leave a thread (and the rows it holds)
        running into the next one: release it and join it."""
        def done():
            go.set()
            for th in threads:
                if th.is_alive() or th.ident is not None:
                    th.join(WAIT)
        self.addCleanup(done)

    def wait_parked(self, what):
        end = time.monotonic() + WAIT
        while time.monotonic() < end:
            if self.parked():
                return
            time.sleep(0.005)
        self.fail(f'{what} never parked on a row lock')

    def door(self, body, out):
        def run():
            try:
                out['r'] = pgdoor.agent_tx(
                    Body(self.slug, 'worker'), {}, body, admit=_admit,
                    file=_file, spec=pgdoor.TxSpec(),
                    on_commit=lambda *_: self.order.append('door'))
            except LedgerError as e:
                out['e'] = str(e)
        return threading.Thread(target=run)

    # -------------------------------------------- latch during a door call
    def latch_waits_for_the_door(self, latch_fn=None):
        inside, go, out, lout = threading.Event(), threading.Event(), {}, {}

        def body(tx):
            inside.set()
            self.assertTrue(go.wait(WAIT))
            tx.org.node('worker')['charter'] = 'door wrote'
            return 'ok'

        def latch():
            lout['r'] = (latch_fn or halt.killswitch_latch)(self.slug)
            self.order.append('latch')

        td = self.door(body, out)
        tl = threading.Thread(target=latch)
        self.settle(go, td, tl)
        td.start()
        self.assertTrue(inside.wait(WAIT))
        tl.start()
        self.wait_parked('the latch')           # waits on the door's FOR SHARE
        self.assertEqual(self.order, [])        # and nothing has committed
        go.set()
        td.join(WAIT)
        tl.join(WAIT)
        self.assertFalse(td.is_alive() or tl.is_alive())
        self.assertEqual(out, {'r': 'ok'})
        self.assertTrue(lout['r']['latched'])
        self.assertEqual(self.order, ['door', 'latch'])
        self.assertEqual(self.opens, [True])    # ONE attempt, holding the row
        org = store.load_org(self.slug)
        self.assertTrue(org.d.get('killswitch'))
        self.assertEqual(org.node('worker')['charter'], 'door wrote')

    # -------------------------------------------- door call during a latch
    def door_refuses_after_the_latch(self):
        held, go, out, ran = threading.Event(), threading.Event(), {}, []

        def latch():
            with orgtx.org_tx(self.slug, sections=['killswitch']) as h:
                held.set()
                self.assertTrue(go.wait(WAIT))
                h.org.d['killswitch'] = {'at': 't', 'by': U}
            self.order.append('latch')

        tl = threading.Thread(target=latch)
        td = self.door(lambda tx: ran.append(1), out)
        self.settle(go, td, tl)
        tl.start()
        self.assertTrue(held.wait(WAIT))
        td.start()
        self.wait_parked('the door')             # waits on the latch's FOR UPDATE
        go.set()
        tl.join(WAIT)
        td.join(WAIT)
        self.assertFalse(td.is_alive() or tl.is_alive())
        self.assertIn('killswitch', out.get('e', ''), out)
        self.assertEqual(ran, [])
        self.assertEqual(self.order, ['latch'])
        self.assertEqual(self.opens, [True])

    def test_latch_during_a_door_call_on_a_fresh_org_waits_for_it(self):
        self.latch_waits_for_the_door()

    def test_latch_during_a_door_call_on_a_released_org_waits_for_it(self):
        self.released()
        self.latch_waits_for_the_door()

    def test_legacy_whole_document_latch_during_a_door_call_waits_for_it(self):
        """native-design-review's P6a: a latch written by a legacy
        whole-document save (DOC_LOCK, no org_tx). Released org: the row is
        the cleared value. How it is made to wait is the backend's — see
        `legacy_guard` in each subclass."""
        self.released()
        self.legacy_guard()

        def legacy(slug):
            with store.DOC_LOCK:
                org = store.load_org(slug)
                org.d['killswitch'] = {'at': 't', 'by': U}
                store.save_org(org)
            return {'latched': True}
        self.latch_waits_for_the_door(legacy)

    def test_door_call_during_a_latch_on_a_fresh_org_refuses(self):
        self.door_refuses_after_the_latch()

    def test_door_call_during_a_latch_on_a_released_org_refuses(self):
        self.released()
        self.door_refuses_after_the_latch()


class SeamKillswitch(_KillswitchVsDoor, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if URL:
            raise unittest.SkipTest('this process runs the PostgreSQL arm')

    def legacy_guard(self):
        """On the SQLite seam a legacy save takes no row lock at all (with
        the fence off it commits straight through an open door call —
        measured). What serializes it is the TRANSITION FENCE (plan decision
        19, default on): every org_tx holds DOC_LOCK to commit, and a legacy
        writer needs DOC_LOCK. So this case runs with the fence ON, and
        `parked` proves the open door call holds DOC_LOCK."""
        orgtx.TRANSITION_FENCE = True
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', False)

    def parked(self):
        """Some transaction waits on an owner that holds THIS org's
        killswitch row — not merely any wait in the process. With the fence
        on: the door call holds DOC_LOCK (this thread cannot take it)."""
        if orgtx.TRANSITION_FENCE:
            if store.DOC_LOCK.acquire(blocking=False):
                store.DOC_LOCK.release()
                return False
            return True
        locks = orgtx.backend().locks
        key = (self.slug, 'section', 'killswitch')
        with locks._cv:
            return any(key in locks._held.get(b, ())
                       for bs in locks._waits.values() for b in bs)


@unittest.skipUnless(URL, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PgKillswitch(_KillswitchVsDoor, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        store.claim_data_root()
        orgtx.use_backend(orgtx.PgBackend())
        cls.probe = psycopg.connect(URL, autocommit=True)

    @classmethod
    def tearDownClass(cls):
        cls.probe.close()

    def legacy_guard(self):
        """Fence OFF: only the row lock can stop the legacy save. PG-0's
        advisory lock is org_tx's own and a legacy save never asks for it;
        the door's FOR SHARE blocks the save's UPDATE only because the
        killswitch ROW exists (PG-0b ALWAYS_ROWS; before it, the save
        INSERTed the row and nothing conflicted — P6a)."""

    def parked(self):
        """A session of this (disposable, per-process) database waits on a
        row lock held by another. The cases join their threads, so the only
        sessions are the door's and the latch's."""
        row = self.probe.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
            " AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'"
            " AND cardinality(pg_blocking_pids(pid)) > 0").fetchone()
        return bool(row and row[0])


if __name__ == '__main__':
    unittest.main()
