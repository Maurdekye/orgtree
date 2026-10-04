"""Real supervisor exception cleanup through durable admission and native writes."""
import import_provenance  # noqa: F401

from contextlib import ExitStack
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import test_orgdb_compat_pg as fixture
from orgtree import ledger, orgtx, store, supervisor as sup, turnslots
from orgtree.orgdb import turn_context, turn_requests, turn_runtime

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Lifetime(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(fixture.storage(True))
        store.claim_data_root()
        self.slug = 'lifetime-' + uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'luna', 0, 'worker')
        org.node('worker')['session_id'] = str(uuid4())
        store.save_org(org)
        self.stack.enter_context(patch.multiple(
            turnslots, _database_queue=None, _database_instance=None,
            _database_resolver=None, _host_slots=None, _host_limit=None,
            _activation_callbacks=list(turnslots._activation_callbacks)))
        self.host = turn_runtime.Host(fixture.RUNTIME, fixture.LC[0].instance_id,
                                      prefix=fixture.PREFIX)
        self.stack.enter_context(patch.object(turn_runtime, '_host', self.host))
        self.host.start(limit=1)
        self.stack.callback(self.host.stop)
        self.runs = []
        self.observed = []

    def provider(self, cancelled):
        def fail(*args, **kwargs):
            run = turn_context.current()
            if run is None:
                raise AssertionError('actual provider seam has no admitted run')
            self.runs.append(run)
            if cancelled:
                self.host.cancel(self.slug, run.request_id)
            raise RuntimeError('lifetime provider failure')
        return fail

    def observe_error(self, slug, nid, text):
        run = self.runs[0]
        with self.host.org_connection(self.host.org(slug)) as c:
            request = turn_requests.get(c, run.request_id)
        self.observed.append((turn_context.current(), request.state,
                              self.host.queue.snapshot()['held']))
        self.real_error(slug, nid, text)

    def run_failure(self, cancelled=False):
        self.real_error = sup._log_turn_error
        with patch.object(sup, '_codex_leg', self.provider(cancelled)), \
                patch.object(sup, '_log_turn_error', self.observe_error), \
                patch.object(sup, 'spawn_env', return_value={}), \
                patch.object(sup.subprocess, 'Popen', side_effect=FileNotFoundError(
                    'external provider process forbidden')):
            answer = sup._run_one_turn(self.slug, 'worker', 'lifetime request')
        self.assertEqual(len(self.runs), 1, sup.state(self.slug, 'worker').get('last_error'))
        self.assertIsNone(answer)
        self.assertIsNone(turn_context.current())
        self.assertFalse(sup.state(self.slug, 'worker')['busy'])
        return self.runs[0]

    def test_exception_bookkeeping_keeps_original_running_claim(self):
        run = self.run_failure()
        self.assertEqual(self.observed, [(run, 'running', 1)])
        saved = orgtx.org_read(self.slug)
        errors = saved.d.get('turn_error_log', {}).get('worker', [])
        self.assertEqual([row['text'] for row in errors], ['lifetime provider failure'])
        self.assertEqual(self.host.queue.get(run.request_id).state, 'done')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)

    def test_cancelled_provider_cannot_write_late_native_error(self):
        run = self.run_failure(cancelled=True)
        saved = orgtx.org_read(self.slug)
        self.assertEqual(saved.d.get('turn_error_log', {}).get('worker', []), [])
        self.assertEqual(self.observed, [(run, 'stopping', 1)])
        self.assertEqual(self.host.queue.get(run.request_id).state, 'cancelled')
        self.assertEqual(self.host.queue.snapshot()['held'], 0)


if __name__ == '__main__':
    unittest.main()
