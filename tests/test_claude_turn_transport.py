"""Run-fenced transport rotation: no provider, database or live state."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import ast
from contextlib import contextmanager
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from orgtree import claude_transport as ct
from orgtree.orgdb import turn_context as ctx, turn_requests, turn_runtime


class Host:
    key = b'k' * 32

    def __init__(self):
        self.closed = set()

    def credential(self, run):
        return ctx.sign(run, self.key)

    def authorize(self, run):
        if run.request_id in self.closed:
            raise turn_requests.StaleRun('closed')


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.one = ctx.Run('example', 'worker', 1, 2, str(uuid4()), 1, 3, str(uuid4()))
        self.two = ctx.Run('example', 'worker', 1, 2, str(uuid4()), 1, 3, str(uuid4()))
        self.servers = {'orgtree': {'command': 'python', 'args': ['-m', 'orgtree.mcptool'],
                                   'env': {'ORGTREE_AGENT_TOKEN': 'seat'}}}
        self.tokens = []
        self.commands = []
        self.catalogue = [{'name': 'orgtree_status', 'inputSchema': {'type': 'object'}}]
        self.ack = True
        self.reply = True
        self.pid = 0
        self.child = SimpleNamespace(parents=lambda: [SimpleNamespace(pid=123)],
                                     create_time=lambda: 1, wait=lambda timeout: 0,
                                     children=lambda recursive: [])
        self.proc = SimpleNamespace(pid=123)
        self.rotation = ct.Rotation(self.proc, self.send)
        self.patcher = patch('psutil.Process', return_value=self.child)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def send(self, line):
        message = json.loads(line)
        self.commands.append(message['request'])
        server = message['request']['servers'].get('orgtree')
        if server:
            env = server['env']
            run = ctx.verify(env[ctx.ENV], lambda owner: self.host.key)
            self.host.authorize(run)
            self.tokens.append(env[ctx.ENV])
            self.pid += 1
            if self.ack:
                ct.acknowledge(run, {'nonce': env[ct.READY_ENV], 'pid': 1000 + self.pid,
                                     'tools_digest': ct.digest(self.catalogue)})
        if self.reply:
            self.rotation.observe(json.dumps({'type': 'control_response', 'response': {
                'subtype': 'success', 'request_id': message['request_id'],
                'response': {'added': [], 'removed': [], 'errors': {}}}}))

    def begin(self, run):
        self.rotation.begin(run, self.host, self.servers, lambda: None)

    def end(self, **values):
        args = dict(result_ok=True, tasks=0, bg_tasks=0, check=lambda: None)
        args.update(values)
        return self.rotation.end(**args)

    def test_second_turn_uses_new_claim_old_transport_stays_stale(self):
        self.begin(self.one)
        old_token = self.tokens[-1]
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        self.begin(self.two)
        self.assertEqual(ctx.verify(self.tokens[-1], lambda owner: self.host.key), self.two)
        with self.assertRaises(turn_requests.StaleRun):
            self.host.authorize(ctx.verify(old_token, lambda owner: self.host.key))
        self.assertNotEqual(self.tokens[-1], old_token)
        self.assertEqual(self.rotation.proc.pid, 123)
        self.assertNotIn(ctx.ENV, self.servers['orgtree']['env'])

    def test_previous_run_must_be_closed_before_replacement(self):
        self.begin(self.one)
        self.assertTrue(self.end())
        with self.assertRaisesRegex(RuntimeError, 'still authorized'):
            self.begin(self.two)
        self.assertEqual(len(self.tokens), 1)

    def test_background_agent_or_shell_cannot_receive_successor_authority(self):
        self.begin(self.one)
        for key in ('tasks', 'bg_tasks'):
            self.assertFalse(self.end(**{key: 1}))
        self.rotation.observe(json.dumps({'type': 'system', 'subtype': 'background_tasks_changed',
                                          'tasks': [{'task_id': 'old-subagent'}]}))
        self.assertFalse(self.end())
        self.host.closed.add(self.one.request_id)
        with self.assertRaises(RuntimeError):
            self.begin(self.two)
        self.assertEqual(len(self.tokens), 1)

    def test_outstanding_tool_must_return_before_child_is_removed(self):
        self.begin(self.one)
        self.rotation.observe(json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'tool_use', 'id': 'slow', 'name': 'mcp__orgtree__test'}]}}))
        self.assertFalse(self.end())
        self.assertEqual(len(self.commands), 1)
        self.rotation.observe(json.dumps({'type': 'user', 'message': {'content': [
            {'type': 'tool_result', 'tool_use_id': 'slow'}]}}))
        self.assertTrue(self.end())
        self.assertNotIn('orgtree', self.commands[-1]['servers'])

    def test_background_notifications_cannot_clear_missing_snapshot(self):
        self.begin(self.one)
        for subtype in ('task_started', 'task_notification'):
            self.rotation.observe(json.dumps({'type': 'system', 'subtype': subtype,
                                              'task_id': 'old-task'}))
        self.assertFalse(self.end())
        self.rotation.observe(json.dumps({'type': 'system', 'subtype': 'background_tasks_changed', 'tasks': []}))
        self.assertTrue(self.end())

    def test_missing_authenticated_roundtrip_fails_closed(self):
        self.ack = False
        with patch.object(ct, 'TIMEOUT', .001), self.assertRaises(RuntimeError):
            self.begin(self.one)
        self.assertIsNone(self.rotation.run)
        self.assertFalse(ct._pending)

    def test_control_timeout_fails_closed(self):
        self.reply = False
        with patch.object(ct, 'TIMEOUT', .001), self.assertRaises(RuntimeError):
            self.begin(self.one)
        self.assertFalse(self.rotation.waiters)

    def test_tool_definitions_stay_identical_and_change_refuses_reuse(self):
        self.begin(self.one)
        before = self.rotation.tools_digest
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        self.catalogue.append({'name': 'unexpected'})
        with self.assertRaisesRegex(RuntimeError, 'catalogue changed'):
            self.begin(self.two)
        self.assertEqual(self.rotation.tools_digest, before)

    def test_late_tool_after_end_taints_the_cli(self):
        self.begin(self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        self.rotation.observe(json.dumps({'type': 'assistant', 'message': {'content': [
            {'type': 'tool_use', 'id': 'late'}]}}))
        with self.assertRaises(RuntimeError):
            self.begin(self.two)

    def test_halt_or_cancel_during_handshake_refuses_reuse(self):
        checks = [0]
        def check():
            checks[0] += 1
            if checks[0] == 2:
                raise RuntimeError('halted')
        with self.assertRaisesRegex(RuntimeError, 'halted'):
            self.rotation.begin(self.one, self.host, self.servers, check)
        self.assertIsNone(self.rotation.run)

    def test_wrong_run_cannot_acknowledge_a_pending_child(self):
        pending = ct.Pending(self.two)
        with patch.dict(ct._pending, {'nonce': pending}):
            with self.assertRaises(ValueError):
                ct.acknowledge(self.one, {'nonce': 'nonce', 'pid': 5, 'tools_digest': 'f' * 64})
            self.assertFalse(pending.ready.is_set())

    def test_transport_process_must_really_exit_before_park(self):
        import psutil
        self.begin(self.one)
        def wait(timeout):
            raise psutil.TimeoutExpired(timeout)
        self.child.wait = wait
        self.assertFalse(self.end())

    def test_untracked_background_process_refuses_parking(self):
        self.begin(self.one)
        self.child.children = lambda recursive: [SimpleNamespace(pid=777, create_time=lambda: 2)]
        self.assertFalse(self.end())

    def test_child_started_during_removal_prevents_park(self):
        self.begin(self.one)
        prior_send = self.rotation.send
        def send(line):
            if 'orgtree' not in json.loads(line)['request']['servers']:
                self.child.children = lambda recursive: [SimpleNamespace(pid=777, create_time=lambda: 2)]
            prior_send(line)
        self.rotation.send = send
        self.assertFalse(self.end())

    def test_child_started_while_parked_prevents_reuse(self):
        self.begin(self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        self.child.children = lambda recursive: [SimpleNamespace(pid=777, create_time=lambda: 2)]
        with self.assertRaisesRegex(RuntimeError, 'while Claude was parked'):
            self.begin(self.two)
        self.assertEqual(len(self.tokens), 1)

    def test_child_started_during_replacement_is_not_absorbed_into_baseline(self):
        self.begin(self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        prior_send = self.rotation.send
        def send(line):
            prior_send(line)
            self.child.children = lambda recursive: [SimpleNamespace(pid=777, create_time=lambda: 2)]
        self.rotation.send = send
        with self.assertRaisesRegex(RuntimeError, 'during Claude transport rotation'):
            self.begin(self.two)
        self.assertEqual(self.rotation.run, self.one)

    def test_known_other_mcp_child_is_preserved_across_rotation(self):
        other = SimpleNamespace(pid=777, create_time=lambda: 2)
        self.child.children = lambda recursive: [other]
        self.begin(self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        self.begin(self.two)
        self.assertEqual(self.rotation.run, self.two)
        self.assertIn((777, 2), self.rotation.process_baseline)

    def admission(self, run, ack=True):
        # Execute the production admission block, not a test copy. It includes
        # the former cold-only guard and the current handoff/fallback branch.
        source = (Path(__file__).parents[1] / 'engine/backend/orgtree/supervisor.py').read_text(encoding='utf-8')
        start = source.index('            warm_on, warm_lbl = warmpool.warm_decision()')
        end = source.index('            _spawn_t0 = time.monotonic()', start)
        import textwrap
        tree = ast.parse(textwrap.dedent(source[start:end]))
        discarded = []
        wp = SimpleNamespace(rotation=self.rotation)
        pool = SimpleNamespace(warm_decision=lambda: (True, True), eligible=lambda *_: (True, ''),
                               _journal=lambda *a, **k: None,
                               identity_snapshot=lambda *a, **k: ('stable', {}),
                               claim_snapshot=lambda *a: (wp, 'warm-hit'),
                               discard=lambda *a: discarded.append(a))
        values = dict(__name__='orgtree.supervisor', __package__='orgtree',
                      warmpool=pool, org=SimpleNamespace(node=lambda nid: {}), nid='worker',
                      slug='example', env={}, env_overrides=lambda *a: {},
                      _build_cmd=lambda *a, **k: ['claude', '--mcp-config', json.dumps({'mcpServers': self.servers})],
                      json=json, halt=SimpleNamespace(check=lambda *a: None), wp_turn=None, turn_hash=None,
                      _check_warm_turn=lambda *a: self.host.authorize(run))
        self.ack = ack
        with ctx.bind(run), patch.object(turn_runtime, 'current', return_value=self.host), patch.object(ct, 'TIMEOUT', .001):
            exec(compile(tree, 'production-Claude-admission', 'exec'), values)
        return values['wp_turn'], values['_adm_reason'], discarded

    def test_production_admission_second_turn_is_warm_with_new_credential(self):
        wp, reason, discarded = self.admission(self.one)
        self.assertIsNotNone(wp)
        self.assertEqual(reason, 'warm-hit')
        self.assertTrue(self.tokens, 'warm admission must install an authenticated transport')
        self.assertEqual(ctx.verify(self.tokens[-1], lambda owner: self.host.key), self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        wp, reason, discarded = self.admission(self.two)
        self.assertIsNotNone(wp)
        self.assertEqual(reason, 'warm-hit')
        self.assertEqual(ctx.verify(self.tokens[-1], lambda owner: self.host.key), self.two)
        self.assertFalse(discarded)

    def test_production_admission_does_not_reuse_previous_run_credential(self):
        self.begin(self.one)
        self.assertTrue(self.end())
        self.host.closed.add(self.one.request_id)
        wp, reason, discarded = self.admission(self.two)
        self.assertIsNotNone(wp)
        self.assertEqual(ctx.verify(self.tokens[-1], lambda owner: self.host.key), self.two,
                         'a warm hit must not keep the previous MCP run credential')

    def test_actual_http_gate_refuses_late_old_transport_and_missing_parent_token(self):
        from test_orgdb_turn_hooks import function, Refused
        body = SimpleNamespace(org='example', node='worker')
        self.host.key_for = lambda owner: self.host.key
        api = function('api.py', 'agent_call', {
            'USER': 'user', 'HTTPException': Refused,
            '_agent_call_in_run': lambda *a: ctx.current()})
        self.host.closed.add(self.one.request_id)
        with patch.object(turn_runtime, 'current', return_value=self.host):
            for token, status in ((None, 403), (self.host.credential(self.one), 409)):
                with self.assertRaises(Refused) as caught:
                    api(body, SimpleNamespace(headers={ctx.HEADER: token}))
                self.assertEqual(caught.exception.status, status)
            self.assertEqual(api(body, SimpleNamespace(headers={ctx.HEADER: self.host.credential(self.two)})), self.two)

    def test_production_warm_spawn_drops_inherited_run_credentials(self):
        import textwrap
        path = Path(__file__).parents[1] / 'engine/backend/orgtree/warmpool.py'
        source = path.read_text(encoding='utf-8')
        start = source.index('        env["ORGTREE_ORG"], env["ORGTREE_NODE"] = slug, nid')
        end = source.index('        _journal_proc("respawn-start"', start)
        env = {ctx.ENV: 'old-run', ct.READY_ENV: 'old-challenge'}
        values = dict(env=env, slug='example', nid='worker', os=os,
                      agentauth=SimpleNamespace(child_env=lambda *a: {'ORGTREE_AGENT_TOKEN': 'seat'}),
                      sup=SimpleNamespace(BACKEND_DIR='backend'))
        exec(compile(ast.parse(textwrap.dedent(source[start:end])), str(path), 'exec'), values)
        self.assertNotIn(ctx.ENV, env)
        self.assertNotIn(ct.READY_ENV, env)
        self.assertEqual(env['ORGTREE_AGENT_TOKEN'], 'seat')

    def test_production_admission_never_uses_an_unacknowledged_child(self):
        wp, reason, discarded = self.admission(self.one, ack=False)
        self.assertIsNone(wp)
        self.assertEqual(reason, 'turn-transport-unavailable')
        self.assertEqual(len(discarded), 1)


if __name__ == '__main__':
    unittest.main()
