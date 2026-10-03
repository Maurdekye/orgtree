"""Shared-database queue: real processes, leases, fairness, fencing and UI seam.

Needs both ORGTREE_TEST_PG_*_URL values on a disposable cluster. One app
database is created per module and dropped at the end: run with the P03 heavy
lock. All actions use the runtime role after lifecycle bootstrap.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import dataclasses
from contextlib import contextmanager
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

    @contextmanager
    def adapter(self):
        with patch.dict(os.environ, {'ORGTREE_STORAGE': 'orgdb'}), \
                patch.object(turnslots, '_database_queue', None), \
                patch.object(turnslots, '_database_instance', None):
            turnslots.configure(self.instance, runtime)
            slots = turnslots.FairSlots()
            try:
                yield slots, turnslots._database_queue
            finally:
                slots.close()

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

    def test_committed_enqueue_lost_reply_cleans_its_waiting_ticket(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            enqueue = queue.enqueue
            def lost_reply(*args, **kwargs):
                enqueue(*args, **kwargs)
                raise ConnectionError('enqueue reply lost after commit')
            with turnslots.bind_request(request), patch.object(queue, 'enqueue', side_effect=lost_reply):
                with self.assertRaisesRegex(ConnectionError, 'enqueue reply lost'):
                    slots.acquire('a')
            self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
            self.assertEqual(self.queue.snapshot()['waiting'], 0)
            self.assertEqual(slots.pending_recovery(), [])

    def test_committed_claim_lost_reply_cancels_only_its_unstarted_claim(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            claim = queue.claim
            committed = []
            def lost_reply(*args, **kwargs):
                committed.append(claim(*args, **kwargs))
                raise ConnectionError('claim reply lost after commit')
            with turnslots.bind_request(request), patch.object(queue, 'claim', side_effect=lost_reply):
                with self.assertRaisesRegex(ConnectionError, 'claim reply lost'):
                    slots.acquire('a')
            self.assertIsNotNone(committed[0], 'control: the real claim committed')
            current = self.queue.get(request.request_id)
            self.assertEqual(current.state, 'cancelled')
            self.assertEqual(current.token, committed[0].token)
            self.assertEqual(current.epoch, committed[0].epoch + 1)
            self.assertEqual(self.queue.snapshot()['held'], 0)
            self.assertIsNone(slots.current_claim)
            self.assertEqual(slots.pending_recovery(), [])

    def test_recovery_never_cancels_another_callers_same_owner_claim(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            claim = queue.claim
            committed = []
            def another_caller_won(instance_id, request_id, **_kwargs):
                committed.append(claim(instance_id, request_id, claim_token=str(uuid.uuid4())))
                raise ConnectionError('our claim outcome was lost')
            with turnslots.bind_request(request), patch.object(queue, 'claim', side_effect=another_caller_won):
                with self.assertRaises(ConnectionError):
                    slots.acquire('a')
            self.assertEqual(self.queue.get(request.request_id), committed[0])
            self.assertEqual(self.queue.snapshot()['held'], 1)
            self.assertEqual(slots.pending_recovery(), [])
            self.assertTrue(self.queue.finish(committed[0]))

    def test_pre_sql_finish_failure_keeps_exact_claim_for_retry(self):
        with self.adapter() as (slots, queue):
            for error_type in (ConnectionError, turnqueue.LostClaim):
                with self.subTest(error_type=error_type):
                    request = self.request()
                    with turnslots.bind_request(request):
                        slots.acquire('a')
                    ticket = slots.current_claim
                    with patch.object(queue, 'finish', side_effect=error_type('finish not sent')):
                        with self.assertRaisesRegex(error_type, 'finish not sent'):
                            slots.release()
                        self.assertEqual(slots.current_claim, ticket)
                        self.assertEqual(self.queue.get(request.request_id), ticket)
                        self.assertEqual(len(slots.pending_recovery()), 1)
                    slots.release()
                    self.assertIsNone(slots.current_claim)
                    self.assertEqual(slots.pending_recovery(), [])
                    self.assertEqual(self.queue.get(request.request_id).state, 'done')

    def test_committed_finish_and_stop_ack_lost_replies_are_reconciled(self):
        with self.adapter() as (slots, queue):
            for stopping in (False, True):
                request = self.request()
                with turnslots.bind_request(request):
                    slots.acquire('a')
                if stopping:
                    self.queue.cancel(request)
                method = 'acknowledge_stop' if stopping else 'finish'
                write = getattr(queue, method)
                committed = []
                def lost_reply(*args, **kwargs):
                    committed.append(write(*args, **kwargs))
                    raise ConnectionError('terminal reply lost after commit')
                with patch.object(queue, method, side_effect=lost_reply):
                    slots.release()
                self.assertEqual(committed, [True])
                self.assertEqual(self.queue.get(request.request_id).state, 'cancelled' if stopping else 'done')
                self.assertEqual(self.queue.snapshot()['held'], 0)
                self.assertIsNone(slots.current_claim)
                self.assertEqual(slots.pending_recovery(), [])

    def test_cleanup_unreachable_then_listener_recovers_without_a_new_turn(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            enqueue = queue.enqueue
            def lost_reply(*args, **kwargs):
                enqueue(*args, **kwargs)
                raise ConnectionError('enqueue committed')
            with turnslots.bind_request(request), patch.object(queue, 'enqueue', side_effect=lost_reply), \
                    patch.object(queue, 'cancel_unstarted', side_effect=ConnectionError('DB unreachable during cleanup')):
                with self.assertRaisesRegex(ConnectionError, 'enqueue committed'):
                    slots.acquire('a')
                self.assertEqual(self.queue.get(request.request_id).state, 'waiting')
                self.assertEqual(len(slots.pending_recovery()), 1)
                slots.recover_pending()
                self.assertEqual(len(slots.pending_recovery()), 1, 'failed cleanup retains identity')
            # No new acquire/release repairs it. The existing listener retries.
            slots.wake()
            deadline = time.monotonic() + 10
            while slots.pending_recovery() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(slots.pending_recovery(), [])
            self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')

    def test_cleanup_lost_reply_and_shutdown_preserve_unresolved_identity(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            enqueue, cancel_unstarted = queue.enqueue, queue.cancel_unstarted
            def lost_enqueue(*args, **kwargs):
                enqueue(*args, **kwargs)
                raise ConnectionError('enqueue reply lost')
            def lost_cleanup(*args, **kwargs):
                cancel_unstarted(*args, **kwargs)
                raise ConnectionError('cleanup reply lost')
            with turnslots.bind_request(request), patch.object(queue, 'enqueue', side_effect=lost_enqueue), \
                    patch.object(queue, 'cancel_unstarted', side_effect=lost_cleanup):
                with self.assertRaises(ConnectionError):
                    slots.acquire('a')
                self.assertEqual(self.queue.get(request.request_id).state, 'cancelled')
                self.assertEqual(len(slots.pending_recovery()), 1)
                with self.assertRaisesRegex(RuntimeError, 'unresolved database outcomes'):
                    slots.close()
                self.assertEqual(len(slots.pending_recovery()), 1)
            slots.recover_pending()
            self.assertEqual(slots.pending_recovery(), [])

    def test_failed_release_and_read_are_retried_after_db_recovery(self):
        request = self.request()
        with self.adapter() as (slots, queue), turnslots.bind_request(request):
            slots.acquire('a')
            ticket = slots.current_claim
            with patch.object(queue, 'finish', side_effect=ConnectionError('DB unreachable')), \
                    patch.object(queue, 'get', side_effect=ConnectionError('DB unreachable')):
                with self.assertRaises(ConnectionError):
                    slots.release()
                self.assertEqual(slots.current_claim, ticket)
                self.assertEqual(len(slots.pending_recovery()), 1)
            slots.wake()
            deadline = time.monotonic() + 10
            while slots.pending_recovery() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(slots.pending_recovery(), [])
            self.assertEqual(self.queue.get(request.request_id).state, 'done')
            slots.release()  # caller may resolve its retained exact token too
            self.assertIsNone(slots.current_claim)

    def test_recovered_release_allows_same_thread_next_acquire(self):
        request = self.request()
        with self.adapter() as (slots, queue):
            with turnslots.bind_request(request):
                slots.acquire('a')
            with patch.object(queue, 'finish', side_effect=ConnectionError('DB unreachable')), \
                    patch.object(queue, 'get', side_effect=ConnectionError('DB unreachable')):
                with self.assertRaises(ConnectionError):
                    slots.release()
                self.assertEqual(len(slots.pending_recovery()), 1)
            slots.recover_pending()
            self.assertEqual(self.queue.get(request.request_id).state, 'done')
            self.assertEqual(slots.pending_recovery(), [])
            # A worker whose previous release raised has already unwound.
            # It can serve the next request without manually repeating it.
            another = self.request()
            with turnslots.bind_request(another):
                slots.acquire('a')
            self.assertEqual(slots.current_claim.request_id, another.request_id)
            slots.release()
            self.assertEqual(self.queue.get(another.request_id).state, 'done')
            self.assertEqual(self.queue.snapshot()['held'], 0)

    def test_stale_instance_plan_excludes_retired_history_and_catches_missing_index(self):
        class RecordingConnection:
            def __init__(self, connection):
                self.connection = connection
            def execute(self, statement, args):
                self.statement, self.args = statement, args
                return self.connection.execute(statement, args)
        def leaves(node):
            return [node] if not node.get('Plans') else [leaf for child in node['Plans'] for leaf in leaves(child)]
        def table_scans(node):
            own = [node] if node.get('Relation Name') == 'engine_instances' else []
            return own + [scan for child in node.get('Plans', []) for scan in table_scans(child)]
        def assert_indexed(plan):
            scans = leaves(plan['Plan'])
            self.assertEqual([node.get('Index Name') for node in scans], ['engine_instances_live_heartbeat'])
            self.assertIn('heartbeat_at', scans[0]['Index Cond'])
            relation_scans = table_scans(plan['Plan'])
            self.assertEqual(len(relation_scans), 1)
            self.assertEqual(relation_scans[0].get('Rows Removed by Filter', 0), 0)
            # A bitmap index leaf also counts invisible old row versions.
            # The table scan counts visible rows for both plan strategies.
            self.assertEqual(relation_scans[0]['Actual Rows'], 2)
        with runtime() as c, conn.connect(ADMIN, APP) as admin:
            c.execute('UPDATE orgtree.engine_instances SET dead_at = now() WHERE id <> %s', (self.instance,))
            stale = [c.execute("INSERT INTO orgtree.engine_instances(host,pid,heartbeat_at) "
                               "VALUES ('stale', 1, now() - interval '2 minutes') RETURNING id").fetchone()[0]
                     for _ in range(2)]
            plans = []
            for history in (1000, 9000):
                c.execute("INSERT INTO orgtree.engine_instances(host,pid,heartbeat_at,dead_at) "
                          "SELECT 'retired', 1, now() - interval '1 day', now() FROM generate_series(1, %s)", (history,))
                admin.execute('ANALYZE orgtree.engine_instances')
                recorded = RecordingConnection(c)
                self.assertEqual([r[0] for r in turnqueue.stale_instances(recorded)], stale)
                plan = c.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + recorded.statement,
                                 recorded.args).fetchone()[0][0]
                assert_indexed(plan)
                plans.append(plan)
            self.assertEqual([table_scans(p['Plan'])[0]['Actual Rows'] for p in plans], [2, 2])
            with admin.transaction(force_rollback=True):
                admin.execute('DROP INDEX orgtree.engine_instances_live_heartbeat')
                control = admin.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + recorded.statement,
                                        recorded.args).fetchone()[0][0]
                with self.assertRaises(AssertionError):
                    assert_indexed(control)
                self.assertGreater(sum(n.get('Rows Removed by Filter', 0) for n in leaves(control['Plan'])), 1000)


if __name__ == '__main__':
    unittest.main()
