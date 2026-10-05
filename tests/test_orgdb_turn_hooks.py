"""Exercise the actual narrow HTTP/MCP functions without starting a server."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import ast
from contextlib import contextmanager
import json
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.request
from uuid import uuid4

from orgtree.orgdb import turn_context, turn_requests, turn_runtime

ROOT = Path(__file__).resolve().parents[1] / 'engine' / 'backend' / 'orgtree'


def function(module, name, globals_):
    """Compile the checkout's actual function; do not import the entire API."""
    path = ROOT / module
    tree = ast.parse(path.read_text(encoding='utf-8'))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    code = ast.Module(body=[node], type_ignores=[])
    env = {'__name__': 'orgtree.turn_hook_test', '__package__': 'orgtree',
           'Any': object, 'AgentCall': object, 'Request': object, **globals_}
    exec(compile(code, str(path), 'exec'), env)
    return env[name]


class Hooks(unittest.TestCase):
    def setUp(self):
        self.run = turn_context.Run('org', 'seat', 1, 2, str(uuid4()), 1, 3, str(uuid4()))
        self.key = b'x' * 32
        self.authorized = []
        self.host = SimpleNamespace(key_for=lambda owner: self.key if owner == 3 else None,
                                    authorize=self.authorized.append)

    def api(self, body):
        def inner(actual, request):
            self.assertIs(actual, body)
            return {'run': turn_context.current()}

        return function('api.py', 'agent_call', {
            'USER': 'user', 'HTTPException': Refused, '_agent_call_in_run': inner})

    def test_http_binds_signed_run_for_full_existing_dispatch_and_resets_it(self):
        body = SimpleNamespace(org='org', node='seat')
        request = SimpleNamespace(headers={turn_context.HEADER: turn_context.sign(self.run, self.key)})
        with patch.object(turn_runtime, 'current', return_value=self.host):
            self.assertEqual(self.api(body)(body, request), {'run': self.run})
        self.assertIsNone(turn_context.current())
        self.assertEqual(self.authorized, [self.run])

    def test_final_provider_rows_and_activated_slots_have_no_unfenced_fallback(self):
        from orgtree import turnslots
        tree = ast.parse((ROOT / 'supervisor.py').read_text(encoding='utf-8'))
        # Check the actual two provider footer calls, including the visible
        # fallback row. The database method exercises this helper's lock.
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name)
                 and node.args and isinstance(node.args[0], ast.Name)
                 and node.args[0].id == 'final_recs']
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(node.func.id == '_publish_turn_records' for node in calls))
        with patch.dict(os.environ, ORGTREE_STORAGE='orgdb'), \
                patch.multiple(turnslots, _database_queue=object(), _host_slots=object()):
            with self.assertRaisesRegex(RuntimeError, 'durable request admission'):
                turnslots.bind_agent('org', 'seat')

    def test_signed_cancelled_run_and_transaction_race_are_http_refusals(self):
        body = SimpleNamespace(org='org', node='seat')
        request = SimpleNamespace(headers={turn_context.HEADER: turn_context.sign(self.run, self.key)})
        with patch.object(turn_runtime, 'current', return_value=self.host), \
                patch.object(self.host, 'authorize', side_effect=turn_requests.StaleRun('cancelled')):
            with self.assertRaises(Refused) as caught:
                self.api(body)(body, request)
            self.assertEqual(caught.exception.status, 409)
        api = function('api.py', 'agent_call', {
            'USER': 'user', 'HTTPException': Refused,
            '_agent_call_in_run': lambda *a: (_ for _ in ()).throw(turn_requests.StaleRun('race'))})
        with patch.object(turn_runtime, 'current', return_value=self.host):
            with self.assertRaises(Refused) as caught:
                api(body, request)
            self.assertEqual(caught.exception.status, 409)
        self.assertIsNone(turn_context.current())

    def test_missing_mutated_and_wrong_agent_run_headers_never_reach_dispatch(self):
        body = SimpleNamespace(org='org', node='seat')
        exact = turn_context.sign(self.run, self.key)
        with patch.object(turn_runtime, 'current', return_value=self.host):
            for token in (None, '', exact + 'a'):
                with self.assertRaises(Refused):
                    self.api(body)(body, SimpleNamespace(headers={turn_context.HEADER: token}))
            body.node = 'other'
            with self.assertRaises(Refused):
                self.api(body)(body, SimpleNamespace(headers={turn_context.HEADER: exact}))

    def test_user_and_unconfigured_alpha_dispatch_clear_an_inherited_context(self):
        request = SimpleNamespace(headers={})
        with turn_context.bind(self.run):
            body = SimpleNamespace(org='org', node='user')
            with patch.object(turn_runtime, 'current', return_value=self.host):
                self.assertEqual(self.api(body)(body, request), {'run': None})
            body.node = 'seat'
            with patch.object(turn_runtime, 'current', return_value=None):
                self.assertEqual(self.api(body)(body, request), {'run': None})
            self.assertEqual(turn_context.current(), self.run)

    def test_mcp_forwards_immutable_run_beside_unchanged_seat_token(self):
        captured = []

        @contextmanager
        def opened(request, **kwargs):
            captured.append(request)
            yield SimpleNamespace(read=lambda: b'answer')

        post = function('mcptool.py', '_post', {
            'os': os, 'json': json, 'urllib': urllib, 'BASE': 'http://localhost:1',
            '_lost_kind': lambda error: 'lost'})
        token = turn_context.sign(self.run, self.key)
        with patch.dict(os.environ, ORGTREE_AGENT_TOKEN='seat-unchanged', ORGTREE_TURN_TOKEN=token), \
                patch.object(urllib.request, 'urlopen', side_effect=opened):
            self.assertEqual(post({'tool': 'test'}), ('ok', 'answer'))
        headers = {key.lower(): value for key, value in captured[0].header_items()}
        self.assertEqual(headers['x-orgtree-agent-token'], 'seat-unchanged')
        self.assertEqual(headers['x-orgtree-turn-token'], token)

    def test_child_transport_drops_inherited_credentials_and_signs_only_current_run(self):
        env = function('supervisor.py', '_turn_transport_env', {})
        with patch.object(turn_runtime, 'current', return_value=SimpleNamespace(
                credential=lambda run: turn_context.sign(run, self.key))):
            self.assertEqual(env({turn_context.ENV: 'inherited', 'ORGTREE_AGENT_TOKEN': 'seat'}),
                             {'ORGTREE_AGENT_TOKEN': 'seat'})
            with turn_context.bind(self.run):
                child = env({turn_context.ENV: 'inherited', 'ORGTREE_AGENT_TOKEN': 'seat'})
                self.assertEqual(turn_context.verify(child[turn_context.ENV], self.host.key_for), self.run)
                self.assertEqual(child['ORGTREE_AGENT_TOKEN'], 'seat')

    def test_callback_captures_origin_on_worker_thread_and_never_relabels_successor(self):
        from dataclasses import replace
        capture = function('supervisor.py', '_turn_callback', {})
        seen = []
        active = [True]

        @contextmanager
        def operation(run):
            if not active[0]:
                raise turn_requests.StaleRun('original request ended')
            with turn_context.bind(run):
                yield

        host = SimpleNamespace(operation=operation)
        with patch.object(turn_runtime, 'current', return_value=host), turn_context.bind(self.run):
            callback = capture(lambda: seen.append(turn_context.current()), publication=True)
            pump = capture(lambda: seen.append(turn_context.current()))
        successor = replace(self.run, request_id=str(uuid4()), token=str(uuid4()))
        with turn_context.bind(successor):
            thread = threading.Thread(target=callback)
            thread.start()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            pump()
            self.assertEqual(turn_context.current(), successor)
            active[0] = False
            callback()
            self.assertEqual(seen, [self.run, self.run])
        self.assertIsNone(turn_context.current())

    def test_environment_overrides_cannot_inject_run_or_seat_credentials(self):
        overrides = function('supervisor.py', 'env_overrides', {
            'time': time, '_ENV_OVERRIDES_TTL': 2,
            '_ENV_OVERRIDES_CACHE': {'at': time.time(), 'val': {'org/seat': {
                turn_context.ENV: 'forged', 'ORGTREE_AGENT_TOKEN': 'forged-seat', 'TASK_FLAG': 'yes'}}}})
        self.assertEqual(overrides('org', 'seat'), {'TASK_FLAG': 'yes'})

    def test_inventory_waits_outside_fence_and_discards_cancelled_result(self):
        capture = function('supervisor.py', '_turn_callback', {})
        fenced, seen = [], []
        live = [True]

        @contextmanager
        def operation(run):
            if not live[0]:
                raise turn_requests.StaleRun('cancelled while inventory was pending')
            fenced.append(run)
            try:
                with turn_context.bind(run):
                    yield
            finally:
                fenced.pop()

        refresh = function('supervisor.py', '_refresh_turn_codex_inventory', {
            '_turn_callback': capture,
            '_mcp_tool_count_names': lambda *args: seen.append(('names', list(fenced))),
            '_mcp_tool_count_unknown': lambda *args: seen.append(('unknown', list(fenced)))})

        def fetch():
            self.assertEqual(fenced, [], 'provider wait must not hold a request fence')
            self.assertEqual(turn_context.current(), self.run)
            return ['tool']

        host = SimpleNamespace(operation=operation)
        with patch.object(turn_runtime, 'current', return_value=host), turn_context.bind(self.run):
            refresh(SimpleNamespace(mcp_tool_names=fetch), object(), 'org', 'seat', threading.Lock())
            def failed():
                fetch()
                raise TimeoutError('inventory stalled')
            refresh(SimpleNamespace(mcp_tool_names=failed), object(), 'org', 'seat', threading.Lock())
            def cancelled():
                fetch()
                live[0] = False
                return ['stale']
            refresh(SimpleNamespace(mcp_tool_names=cancelled), object(), 'org', 'seat', threading.Lock())
        self.assertEqual(seen, [('names', [self.run]), ('unknown', [self.run])])

    def test_inventory_notification_workers_do_not_reserve_publication_slots(self):
        # Execute the actual notification's Thread constructor, including its
        # callback wrapper. Sixteen requests used to occupy all 16 host slots
        # while waiting for a response that the reader could no longer consume.
        tree = ast.parse((ROOT / 'supervisor.py').read_text(encoding='utf-8'))
        thread_call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                           and isinstance(node.func, ast.Attribute) and node.func.attr == 'Thread'
                           and any(k.arg == 'name' and isinstance(k.value, ast.JoinedStr)
                                   and isinstance(k.value.values[0], ast.Constant)
                                   and k.value.values[0].value == 'codexmcp-'
                                   for k in node.keywords))
        slots = threading.BoundedSemaphore(16)
        entered = threading.Barrier(17)
        release = threading.Event()
        errors = []

        @contextmanager
        def operation(run):
            with slots, turn_context.bind(run):
                yield

        def fetch():
            try:
                self.assertEqual(turn_context.current(), self.run)
                entered.wait(5)
                self.assertTrue(release.wait(5))
            except BaseException as error:
                errors.append(error)

        capture = function('supervisor.py', '_turn_callback', {})
        env = dict(threading=threading, _turn_callback=capture, _refresh_codex_mcp=fetch,
                   slug='org', nid='seat')
        code = compile(ast.Expression(thread_call), '<notification thread>', 'eval')
        threads = []
        with patch.object(turn_runtime, 'current', return_value=SimpleNamespace(operation=operation)), \
                turn_context.bind(self.run):
            try:
                for _ in range(16):
                    thread = eval(code, env)
                    threads.append(thread)
                    thread.start()
                entered.wait(5)
                acquired = slots.acquire(timeout=.5)
                if acquired:
                    slots.release()
                self.assertTrue(acquired, 'inventory workers starved the response reader')
            finally:
                release.set()
                for thread in threads:
                    thread.join(5)
        self.assertEqual(errors, [])


class Refused(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status


if __name__ == '__main__':
    unittest.main()
