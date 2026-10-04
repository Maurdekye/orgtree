"""Actual per-org recovery fences, Retry, crash gaps and global capacity."""
import import_provenance  # noqa: F401

from contextlib import contextmanager
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from orgtree import turnqueue, turnslots
from orgtree.orgdb import conn, jobs, lifecycle, names, turn_context, turn_forwarder
from orgtree.orgdb import turn_requests as requests, turn_runtime

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f'trec{os.getpid()}_'


def drop_owned():
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute('SELECT datname FROM pg_database WHERE datname LIKE %s',
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))


@unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable admin and runtime URLs')
class Recovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        drop_owned()
        cls.lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
        cls.lc.bootstrap()
        cls.owner = cls.lc.instance_id
        cls.orgs, cls.agents = {}, {}
        for slug in ('alpha', 'beta'):
            oid = cls.lc.create_org(slug)
            row = cls.lc.row(oid)
            cls.orgs[slug] = jobs.Org(oid, slug, row['database'], str(row['org_uuid']))
            with conn.connect(ADMIN, row['database']) as c:
                cls.agents[slug] = c.execute("INSERT INTO orgtree.agents(name,state) "
                                            "VALUES('seat','live') RETURNING id").fetchone()[0]
        cls.runtime = jobs.Runtime(RUNTIME, prefix=PREFIX)
        cls.queue = turnqueue.Queue(lambda: conn.connect(RUNTIME, names.app(PREFIX)))

    @classmethod
    def tearDownClass(cls):
        drop_owned()

    def setUp(self):
        for org in self.orgs.values():
            self.lc.unfence_runtime(org.database)
            with conn.connect(ADMIN, org.database) as c:
                c.execute('TRUNCATE orgtree.jobs, orgtree.turn_requests')
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            c.execute('TRUNCATE orgtree.turn_tickets, orgtree.turn_queue_orgs, orgtree.turn_recovery')
            c.execute("DELETE FROM orgtree.orgs WHERE slug NOT IN ('alpha','beta')")
            c.execute("UPDATE orgtree.orgs SET state='active',op_kind=NULL,op_owner=NULL,"
                      'op_step=NULL,unavailable_step=NULL,state_reason=NULL')
            c.execute('UPDATE orgtree.engine_instances SET dead_at=clock_timestamp()')
            c.execute('UPDATE orgtree.engine_instances SET dead_at=NULL,heartbeat_at=clock_timestamp() '
                      'WHERE id=%s', (self.owner,))
        self.lc.instance_id = self.owner
        self.queue.set_limit(1)

    def new_owner(self):
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            return c.execute('INSERT INTO orgtree.engine_instances(host,pid) VALUES(%s,%s) '
                             'RETURNING id', ('owned-recovery-test', os.getpid())).fetchone()[0]

    @contextmanager
    def host(self, *, proof=True):
        host = turn_runtime.Host(RUNTIME, self.new_owner(), prefix=PREFIX)
        # Actual start/stop and publication; deterministic scheduling lets the
        # test inspect Retry's gap before invoking the real heartbeat step.
        with patch.multiple(turnslots, _database_queue=None, _database_instance=None,
                            _database_resolver=None, _host_slots=None, _host_limit=None,
                            _activation_callbacks=[]), patch.object(host, '_loop', host._stop.wait):
            try:
                host.start(limit=1, previous_tree_stopped=proof)
                yield host
            finally:
                host.stop()
                if host._thread is not None:
                    self.assertFalse(host._thread.is_alive())

    def old_running(self, slug='alpha'):
        org = self.orgs[slug]
        with self.runtime.connect(org) as c, c.transaction():
            request = requests.create(c, str(uuid4()), self.agents[slug], 'turn', self.owner)
        bridge = turn_forwarder.Bridge(self.runtime.connect, self.queue, self.owner)
        bridge.step(org)
        ticket = self.queue.claim(self.owner, request.request_id)
        self.assertIsNotNone(ticket)
        with self.runtime.connect(org) as c, c.transaction():
            request = requests.activate(c, request.request_id, ticket)
        self.assertIsNotNone(request)
        return turn_context.Run(slug, 'seat', org.org_id, request.agent_id, request.request_id,
                                request.epoch, request.owner, request.token)

    def read(self, run):
        with conn.connect(ADMIN, self.orgs[run.org].database) as c:
            return requests.get(c, run.request_id)

    def fences(self, slug='alpha'):
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            return c.execute('SELECT instance_id FROM orgtree.turn_recovery WHERE org_id=%s '
                             'ORDER BY instance_id', (self.orgs[slug].org_id,)).fetchall()

    def refuse(self, host, run):
        with self.assertRaises(requests.StaleRun):
            host.org(run.org)
        with self.assertRaises(requests.StaleRun):
            host.authorize(run)
        org = self.orgs[run.org]
        request = turnqueue.Request(str(uuid4()), org.org_id, self.agents[run.org], 'seat', 'turn')
        with self.assertRaises(turnqueue.LostClaim):
            host.queue.enqueue(request, host.instance_id)

    def admit(self, host, slug='beta'):
        org, request = host.prepare(slug, 'seat', 'turn', str(uuid4()))
        ticket = host.queue.claim(host.instance_id, request.request_id)
        self.assertIsNotNone(ticket)
        run = host.begin(org, 'seat', request.request_id, ticket, lambda: None)
        host.authorize(run)
        self.assertEqual(host.queue.snapshot()['held'], 1)
        host.complete(org, run)
        self.assertEqual(host.queue.get(run.request_id).state, 'done')
        return run

    def test_unavailable_fence_survives_restart_and_retry_without_holding_capacity(self):
        old = self.old_running()
        self.assertEqual(self.queue.snapshot()['held'], 1)
        self.lc.fence_runtime(self.orgs['alpha'].database)
        self.assertTrue(self.lc._mark_unavailable(old.org_id, 'migration', 'owned permission fault'))
        with self.host() as host:
            self.assertEqual(self.fences(), [(self.owner,)])
            self.assertEqual(self.queue.get(old.request_id).state, 'lost')
            self.assertEqual(self.queue.snapshot()['held'], 0)
            self.assertEqual(self.read(old).state, 'running')
            self.refuse(host, old)
            self.admit(host)
        # A new host cannot forget a fence merely because its owner is dead.
        with self.host() as restarted:
            self.assertIn((self.owner,), self.fences())
            self.refuse(restarted, old)
            self.lc.instance_id = restarted.instance_id
            self.assertTrue(self.lc.retry_in_place(old.org_id))
            self.assertEqual(self.lc.row(old.org_id)['state'], 'active')
            self.assertIn((self.owner,), self.fences())
            self.assertEqual(self.read(old).state, 'running')
            self.refuse(restarted, old)
            restarted.tick()
            self.assertEqual(self.fences(), [])
            self.assertEqual((self.read(old).state, self.read(old).epoch), ('lost', old.epoch + 1))
            with self.assertRaises(requests.StaleRun):
                restarted.authorize(old)
            self.admit(restarted, 'alpha')

    def test_active_permission_failure_isolated_and_fence_held_through_org_commit(self):
        old = self.old_running()
        # It is still active in the registry; opening the actual runtime DB fails.
        self.lc.fence_runtime(self.orgs['alpha'].database)
        with self.host() as host:
            self.assertEqual(self.fences(), [(self.owner,)])
            self.refuse(host, old)
            self.admit(host)
            self.lc.unfence_runtime(self.orgs['alpha'].database)
            real_reclaim = requests.reclaim_owner
            observed = []

            def reclaim(c, owner, **kw):
                result = real_reclaim(c, owner, **kw)
                if result:
                    # Another connection sees the old row until this actual
                    # org transaction commits, and the app fence must remain.
                    observed.append((self.fences(), self.read(old).state))
                return result

            with patch.object(requests, 'reclaim_owner', reclaim):
                host.tick()
            self.assertEqual(observed, [([(self.owner,)], 'running')])
            self.assertEqual(self.fences(), [])
            self.assertEqual(self.read(old).state, 'lost')
            self.admit(host, 'alpha')
            with self.assertRaises(requests.StaleRun):
                host.authorize(old)

    def test_lost_org_commit_reply_keeps_fence_until_idempotent_recovery(self):
        old = self.old_running()
        self.lc.fence_runtime(self.orgs['alpha'].database)
        with self.host() as host:
            self.lc.unfence_runtime(self.orgs['alpha'].database)
            real_reconcile = host._reconcile_org

            def commit_then_lose_reply(org, owner):
                real_reconcile(org, owner)
                raise OSError('owned lost org commit reply')

            with patch.object(host, '_reconcile_org', commit_then_lose_reply):
                host.tick()
            self.assertEqual(self.read(old).state, 'lost')
            self.assertEqual(self.fences(), [(self.owner,)])
            self.refuse(host, old)
            host.tick()
            self.assertEqual(self.fences(), [])
            self.assertEqual(self.read(old).epoch, old.epoch + 1)
            self.admit(host, 'alpha')

    def test_unfinished_create_is_left_to_lifecycle_and_never_opened_for_turn_recovery(self):
        old = self.old_running('beta')
        unfinished = self.lc._register_claimed('unfinished', 'create')
        self.lc._step(unfinished, 'owned-unknown-create-step')
        row = self.lc.row(unfinished.org_id)
        with conn.connect(ADMIN, 'postgres') as c:
            self.assertIsNone(c.execute('SELECT 1 FROM pg_database WHERE datname=%s',
                                       (row['database'],)).fetchone())
        with self.host() as host:
            self.assertEqual(self.read(old).state, 'lost')
            self.assertEqual(self.lc.row(unfinished.org_id)['op_step'], 'owned-unknown-create-step')
            self.assertEqual(self.lc.row(unfinished.org_id)['op_owner'], self.owner)
            with conn.connect(ADMIN, names.app(PREFIX)) as c:
                self.assertIsNone(c.execute('SELECT 1 FROM orgtree.turn_recovery WHERE org_id=%s',
                                            (unfinished.org_id,)).fetchone())
            self.admit(host)

    def test_open_failure_and_stale_heartbeat_never_substitute_for_tree_death_proof(self):
        old = self.old_running()
        self.lc.fence_runtime(self.orgs['alpha'].database)
        with conn.connect(ADMIN, names.app(PREFIX)) as c:
            c.execute("UPDATE orgtree.engine_instances SET heartbeat_at=clock_timestamp()-interval '1 day' "
                      'WHERE id=%s', (self.owner,))
        with self.host(proof=False) as host:
            host.tick()
            self.assertEqual(self.fences(), [])
            self.assertEqual(self.queue.get(old.request_id).state, 'running')
            self.assertEqual(self.queue.snapshot()['held'], 1)
            org, request = host.prepare('beta', 'seat', 'turn', str(uuid4()))
            self.assertIsNone(host.queue.claim(host.instance_id, request.request_id))
            with conn.connect(ADMIN, names.app(PREFIX)) as c:
                self.assertIsNone(c.execute('SELECT dead_at FROM orgtree.engine_instances WHERE id=%s',
                                            (self.owner,)).fetchone()[0])
            self.assertEqual(self.read(old).state, 'running')

    def test_restored_running_request_cannot_revive_a_verified_dead_owner(self):
        old = self.old_running()
        with self.host() as host:
            self.assertEqual(self.fences(), [])
            self.assertEqual(self.read(old).state, 'lost')
            # Restore the exact old running claim fields, as an older org
            # database snapshot can. The app's dead identity is authoritative.
            with conn.connect(ADMIN, self.orgs['alpha'].database) as c:
                c.execute("UPDATE orgtree.turn_requests SET state='running',claim_epoch=%s,"
                          'stopped_at=NULL,ended_at=NULL,end_reason=NULL WHERE request_id=%s',
                          (old.epoch, old.request_id))
            self.assertEqual(self.read(old).state, 'running')
            with self.assertRaises(requests.StaleRun):
                host.authorize(old)


if __name__ == '__main__':
    unittest.main()
