"""Exercise the actual narrow HTTP/MCP functions without starting a server."""
import import_provenance  # noqa: F401

import ast
from contextlib import contextmanager
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.request
from uuid import uuid4

from orgtree.orgdb import turn_context, turn_runtime

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
        self.host = SimpleNamespace(key_for=lambda owner: self.key if owner == 3 else None)

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


class Refused(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status


if __name__ == '__main__':
    unittest.main()
