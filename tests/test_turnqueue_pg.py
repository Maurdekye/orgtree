"""Shared-database queue: real processes, leases, fairness, fencing and UI seam.

Needs both ORGTREE_TEST_PG_*_URL values on a disposable cluster. One app
database is created per module and dropped at the end: run with the P03 heavy
lock. All actions use the runtime role after lifecycle bootstrap.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import dataclasses
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import child_python

from orgtree import turnqueue, turnslots
from orgtree.orgdb import conn, lifecycle, migrate, names

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '')
PREFIX = f'tq{os.getpid()}_'
APP = names.app(PREFIX)
needs_pg = unittest.skipUnless(ADMIN and RUNTIME, 'needs disposable admin and runtime PostgreSQL URLs')
LC = None


def runtime():
    return conn.connect(RUNTIME, APP)


def setUpModule():
    global LC
    if ADMIN and RUNTIME:
        LC = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX)
        LC.bootstrap()


def tearDownModule():
    if LC is not None:
        LC._drop_db(APP)


class Worker:
    def __init__(self):
        self.p = subprocess.Popen(child_python.argv(str(Path(__file__).with_name('turnqueue_worker.py')), APP, flags=('-I',)),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, env=os.environ.copy())
        self.ready = self.read()

    def write(self, command):
        self.p.stdin.write(json.dumps(command) + '\n')
        self.p.stdin.flush()

    def read(self):
        line = self.p.stdout.readline()
        if not line:
            raise AssertionError('worker exited: ' + self.p.stderr.read())
        return json.loads(line)

    def close(self):
        if self.p.poll() is None:
            self.write({'op': 'close'})
        try:
            out, err = self.p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.communicate()
            raise
        if self.p.returncode:
            raise AssertionError(err)


@needs_pg
class QueueTests(unittest.TestCase):
    def setUp(self):
        with conn.connect(ADMIN, APP) as c:
            c.execute('TRUNCATE orgtree.turn_tickets, orgtree.turn_queue_orgs, orgtree.orgs RESTART IDENTITY CASCADE')
            c.execute('UPDATE orgtree.turn_admission SET slot_limit = 16, last_org_id = NULL')
            for slug in ('b', 'a', 'c'):
                c.execute("INSERT INTO orgtree.orgs(slug, org_uuid, database, state) "
                          "VALUES (%s, %s, %s, 'active')", (slug, str(uuid.uuid4()), slug))
        with runtime() as c:
            self.orgs = dict(c.execute('SELECT slug, org_id FROM orgtree.orgs').fetchall())
            self.instance = c.execute("INSERT INTO orgtree.engine_instances(host, pid) "
                                      "VALUES ('test', %s) RETURNING id", (os.getpid(),)).fetchone()[0]
        self.queue = turnqueue.Queue(runtime)

    def request(self, org='a', agent=1):
        return turnqueue.Request(str(uuid.uuid4()), self.orgs[org], agent, f'{org}{agent}', 'test')

    def enqueue(self, org='a', agent=1):
        request = self.request(org, agent)
        self.queue.enqueue(request, self.instance)
        return request

    def expire(self):
        with runtime() as c:
            c.execute("UPDATE orgtree.engine_instances SET heartbeat_at = now() - interval '31 seconds' "
                      "WHERE id = %s", (self.instance,))

    def test_migration_idempotent_runtime_rights_and_default(self):
        with conn.connect(ADMIN, APP) as c:
            report = migrate.migrate(c, migrate.APP_DIR, migrate.APP_LOCK)
        self.assertEqual(report['applied'], [])
        self.assertIn('0003_turn_queue.sql', report['current'])
        self.assertEqual(self.queue.snapshot(), {'limit': 16, 'held': 0, 'waiting': 0, 'waiting_by_org': {}})
        request = self.enqueue()
        self.assertEqual(self.queue.get(request.request_id).owner, self.instance)

    def test_first_arrival_ring_and_fifo_survive_new_queue_object(self):
        self.queue.set_limit(1)
        first = self.enqueue('a', 99)
        self.queue.finish(self.queue.claim(self.instance))
        requests = [self.enqueue('a', i) for i in range(1, 5)]
        b, c = self.enqueue('b'), self.enqueue('c')
        other = turnqueue.Queue(runtime)
        order = []
        for _ in range(6):
            ticket = other.claim(self.instance)
            self.assertIsNotNone(ticket)
            order.append(ticket.request_id)
            self.assertTrue(other.finish(ticket))
        self.assertEqual(order, [b.request_id, c.request_id] + [r.request_id for r in requests])
        self.assertEqual(self.queue.get(first.request_id).state, 'done')

    def test_limit_raise_lower_and_request_specific_claim(self):
        self.queue.set_limit(0)
        a, b, c = self.enqueue('a'), self.enqueue('b'), self.enqueue('c')
        self.assertIsNone(self.queue.claim(self.instance))
        self.queue.set_limit(2)
        self.assertIsNone(self.queue.claim(self.instance, b.request_id), 'b must not pass a')
        t1 = self.queue.claim(self.instance, a.request_id)
        t2 = self.queue.claim(self.instance, b.request_id)
        self.assertEqual(self.queue.snapshot()['held'], 2)
        self.queue.set_limit(1)
        self.assertIsNone(self.queue.claim(self.instance))
        self.queue.finish(t1)
        self.assertIsNone(self.queue.claim(self.instance), 'lowering does not preempt')
        self.queue.finish(t2)
        self.assertEqual(self.queue.claim(self.instance).request_id, c.request_id)

    def test_terminal_request_is_never_requeued_and_open_agent_is_unique(self):
        request = self.enqueue()
        with self.assertRaises(turnqueue.AgentBusy):
            self.enqueue()
        ticket = self.queue.claim(self.instance)
        self.assertTrue(self.queue.finish(ticket))
        self.assertEqual(self.queue.enqueue(request, self.instance).state, 'done')
        self.assertIsNone(self.queue.claim(self.instance))
        changed = dataclasses.replace(request, agent_id=99)
        with self.assertRaises(ValueError):
            self.queue.enqueue(changed, self.instance)
        self.assertIsNotNone(self.enqueue())

    def test_cancel_tombstone_blocks_late_insert_and_start(self):
        request = self.request()
        self.assertEqual(self.queue.cancel(request).state, 'cancelled')
        self.assertEqual(self.queue.enqueue(request, self.instance).state, 'cancelled')
        self.assertIsNone(self.queue.claim(self.instance))
        next_request = self.enqueue()
        ticket = self.queue.claim(self.instance)
        self.assertTrue(self.queue.cancel_before_start(ticket))
        self.assertFalse(self.queue.finish(ticket))
        self.assertFalse(self.queue.cancel_before_start(ticket))
        self.assertEqual(self.queue.snapshot()['held'], 0)
        self.assertEqual(self.queue.get(next_request.request_id).epoch, ticket.epoch + 1)

    def test_stopping_keeps_slot_and_agent_until_exact_owner_acknowledges(self):
        self.queue.set_limit(1)
        request = self.enqueue()
        ticket = self.queue.claim(self.instance)
        stopped = self.queue.cancel(request)
        self.assertEqual(stopped.state, 'stopping')
        self.assertEqual(stopped.epoch, ticket.epoch + 1)
        self.assertEqual(self.queue.cancel(request).epoch, stopped.epoch)
        self.assertEqual(self.queue.snapshot()['held'], 1)
        self.enqueue('b')
        self.assertIsNone(self.queue.claim(self.instance))
        with self.assertRaises(turnqueue.AgentBusy):
            self.enqueue()
        self.assertFalse(self.queue.finish(ticket), 'stale finish must not free the slot')
        self.assertFalse(self.queue.acknowledge_stop(request.request_id, self.instance + 999, stopped.epoch))
        self.assertFalse(self.queue.acknowledge_stop(request.request_id, self.instance, ticket.epoch))
        self.assertTrue(self.queue.acknowledge_stop(request.request_id, self.instance, stopped.epoch))
        self.assertIsNotNone(self.queue.claim(self.instance))

    def test_expired_lease_alone_does_not_free_running_or_waiting_turns(self):
        running = self.enqueue()
        ticket = self.queue.claim(self.instance)
        waiting = self.enqueue('a', 2)
        self.expire()
        checked = []
        self.assertEqual(self.queue.reclaim_expired(self.instance, lambda row: checked.append(row) or False), [])
        self.assertEqual(len(checked), 1)
        self.assertEqual(checked[0]['pid'], os.getpid())
        self.assertEqual(self.queue.snapshot()['held'], 1)
        with runtime() as c:
            stale = turnqueue.stale_instances(c)
        self.assertIn(self.instance, [r[0] for r in stale])
        reclaimed = self.queue.reclaim_expired(self.instance, lambda row: True)
        self.assertEqual({t.request_id for t in reclaimed}, {running.request_id, waiting.request_id})
        self.assertTrue(all(t.state == 'lost' for t in reclaimed))
        self.assertFalse(self.queue.finish(ticket))
        with self.assertRaises(turnqueue.LostClaim):
            self.queue.heartbeat(self.instance)
        self.assertEqual(self.queue.snapshot()['waiting'], 0)

    def test_refreshed_lease_blocks_reclaim_and_startup_host_can_reclaim_fresh_dead_tree(self):
        self.enqueue()
        self.expire()
        def refresh_then_confirm(_identity):
            self.queue.heartbeat(self.instance)
            return True
        self.assertEqual(self.queue.reclaim_expired(self.instance, refresh_then_confirm), [])
        self.assertEqual(self.queue.snapshot()['waiting'], 1)
        with runtime() as c:
            counts = turnqueue.reclaim_instance(c, self.instance)
            again = turnqueue.reclaim_instance(c, self.instance)
        self.assertEqual(counts, {'waiting': 1, 'running': 0, 'stopping': 0})
        self.assertEqual(again, {'waiting': 0, 'running': 0, 'stopping': 0})
        with self.assertRaises(turnqueue.LostClaim):
            self.queue.enqueue(self.request('a', 2), self.instance)

    def test_host_reclaims_stopping_and_heartbeat_rereads_cancellation(self):
        request = self.enqueue()
        ticket = self.queue.claim(self.instance)
        stopped = self.queue.cancel(request)
        with runtime() as c:
            self.assertEqual(turnqueue.heartbeat(c, self.instance), [stopped])
            self.assertEqual(turnqueue.reclaim_instance(c, self.instance),
                             {'waiting': 0, 'running': 0, 'stopping': 1})
        self.assertFalse(self.queue.finish(ticket))
        self.assertEqual(self.queue.snapshot()['held'], 0)

    def test_skip_locked_head_never_overtakes_within_org(self):
        a1 = self.enqueue('a', 1)
        self.enqueue('a', 2)
        b = self.enqueue('b')
        with runtime() as locked, locked.transaction():
            locked.execute('SELECT id FROM orgtree.turn_tickets WHERE request_id = %s FOR UPDATE', (a1.request_id,))
            ticket = self.queue.claim(self.instance)
            self.assertEqual(ticket.request_id, b.request_id)
        self.assertEqual(self.queue.claim(self.instance).request_id, a1.request_id)

    def test_busy_admission_gate_does_not_block(self):
        self.enqueue()
        with runtime() as locked, locked.transaction():
            locked.execute('SELECT singleton FROM orgtree.turn_admission FOR UPDATE')
            started = time.monotonic()
            self.assertIsNone(self.queue.claim(self.instance))
            self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(self.queue.claim(self.instance))

    def workers(self):
        workers = [Worker(), Worker()]
        for worker in workers:
            self.addCleanup(worker.close)
        self.assertNotEqual(workers[0].ready['pid'], workers[1].ready['pid'])
        self.assertNotEqual(workers[0].ready['ready'], workers[1].ready['ready'])
        return workers

    def test_two_processes_never_double_admit_the_same_request(self):
        request = self.enqueue()
        workers = self.workers()
        for worker in workers:
            worker.write({'op': 'claim', 'request': request.request_id})
        claims = [worker.read() for worker in workers]
        winners = [claim for claim in claims if claim is not None]
        self.assertEqual(len(winners), 1, 'positive control: one real process must claim')
        self.assertEqual(winners[0]['request_id'], request.request_id)
        self.assertEqual(self.queue.snapshot()['held'], 1)
        winner = workers[0] if claims[0] else workers[1]
        winner.write({'op': 'finish', 'ticket': winners[0]})
        self.assertTrue(winner.read())
        self.assertEqual(self.queue.enqueue(request, self.instance).state, 'done')

    def test_two_processes_share_one_limit_not_one_limit_each(self):
        self.queue.set_limit(2)
        for i in range(12):
            self.enqueue('a' if i % 2 else 'b', i)
        workers = self.workers()
        for worker in workers:
            worker.write({'op': 'fill'})
        claims = [worker.read() for worker in workers]
        flat = [ticket for group in claims for ticket in group]
        self.assertEqual(len(flat), 2)
        self.assertEqual(len({t['request_id'] for t in flat}), 2)
        self.assertEqual(self.queue.snapshot()['held'], 2)

    def test_switch_adapter_wait_banner_remote_limit_and_duplicate_release(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None), \
                patch.object(turnslots, '_database_resolver', None):
            turnslots.configure(self.instance, runtime, lambda org, agent: (self.orgs[org], 42))
            slots = turnslots.FairSlots(16)
            self.assertIsInstance(slots, turnslots.DatabaseSlots)
            slots.set_limit(0)
            queued, entered, finish = threading.Event(), threading.Event(), threading.Event()
            banners, errors, claims = [], [], []
            def run():
                try:
                    with turnslots.bind_agent('a', 'agent'):
                        slots.acquire('a', on_queued=lambda info: (banners.append(info), queued.set()))
                        claims.append(slots.current_claim)
                        entered.set()
                        finish.wait(10)
                        slots.release()
                        with self.assertRaises(RuntimeError):
                            slots.release()
                except BaseException as exc:
                    errors.append(exc)
                    entered.set()
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                self.assertTrue(queued.wait(10), 'positive control: queued callback ran')
                self.assertEqual(banners[0]['limit'], 0)
                self.assertEqual(banners[0]['waiting'], 1)
                self.assertIn('since', banners[0])
                self.assertFalse(entered.is_set())
                # A different engine/Queue writes the setting; NOTIFY wakes this adapter.
                turnqueue.Queue(runtime).set_limit(1)
                self.assertTrue(entered.wait(10))
                self.assertEqual(errors, [])
                self.assertEqual(slots.snapshot()['held'], 1)
            finally:
                finish.set()
                slots.close()
                thread.join(10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(self.queue.get(claims[0].request_id).state, 'done')

    def test_adapter_cancel_wakeup_and_callback_error_do_not_strand_ticket(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            turnslots.configure(self.instance, runtime)
            slots = turnslots.FairSlots()
            slots.set_limit(0)
            queued, cancel = threading.Event(), threading.Event()
            out = []
            request = self.request()
            def run():
                with turnslots.bind_request(request):
                    try:
                        slots.acquire('a', cancel.is_set, lambda info: queued.set(), max_wait=30)
                    except turnslots.Cancelled:
                        out.append('cancelled')
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                self.assertTrue(queued.wait(10))
                cancel.set()
                started = time.monotonic()
                slots.wake()
                thread.join(10)
                self.assertLess(time.monotonic() - started, 3)
                self.assertEqual(out, ['cancelled'])
                self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
                def broken_banner(_info):
                    raise ValueError('banner failed')
                another = self.request()
                with turnslots.bind_request(another), self.assertRaisesRegex(ValueError, 'banner failed'):
                    slots.acquire('a', on_queued=broken_banner)
                self.assertEqual(self.queue.get(another.request_id).state, 'cancelled')
            finally:
                slots.close()
                thread.join(10)

    def test_duplicate_cancelled_adapter_call_cannot_cancel_running_provider(self):
        request = self.enqueue()
        ticket = self.queue.claim(self.instance)
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            turnslots.configure(self.instance, runtime)
            slots = turnslots.FairSlots()
            try:
                with turnslots.bind_request(request), self.assertRaises(turnqueue.LostClaim):
                    slots.acquire('a', cancelled=lambda: True)
                self.assertEqual(self.queue.get(request.request_id), ticket)
            finally:
                slots.close()

    def test_owner_release_acknowledges_stopping_after_provider_scope_exits(self):
        request = self.request()
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            turnslots.configure(self.instance, runtime)
            slots = turnslots.FairSlots()
            try:
                with turnslots.bind_request(request):
                    slots.acquire('a')
                    ticket = slots.current_claim
                    self.queue.cancel(request)
                    self.assertEqual(self.queue.snapshot()['held'], 1)
                    slots.release()
                    self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
                    self.assertFalse(self.queue.finish(ticket))
                    self.assertEqual(self.queue.snapshot()['held'], 0)
            finally:
                slots.close()

    def test_remote_limit_change_refreshes_a_still_waiting_banner(self):
        request = self.request()
        occupied = self.enqueue('b')
        self.queue.claim(self.instance)
        self.queue.set_limit(1)
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            turnslots.configure(self.instance, runtime)
            slots = turnslots.FairSlots()
            queued, updated, cancel = threading.Event(), threading.Event(), threading.Event()
            banners = []
            def banner(info):
                banners.append(info)
                (queued if info['limit'] == 1 else updated).set()
            def run():
                with turnslots.bind_request(request):
                    try:
                        slots.acquire('a', cancel.is_set, banner)
                    except turnslots.Cancelled:
                        pass
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                self.assertTrue(queued.wait(10))
                self.queue.set_limit(0)
                self.assertTrue(updated.wait(10), 'remote lowering must refresh the banner')
                self.assertEqual(banners[-1]['limit'], 0)
                self.assertEqual(banners[0]['since'], banners[-1]['since'])
                self.assertEqual(self.queue.get(occupied.request_id).state, 'running')
            finally:
                cancel.set()
                slots.wake()
                slots.close()
                thread.join(10)
            self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
