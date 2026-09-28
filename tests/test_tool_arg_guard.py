"""A tool call with misnamed or missing arguments fails LOUDLY, and sends nothing.

THE DEFECT THIS PINS (docket: orgtree-message-send-notice-silently-send-an-emp).
On 2026-09-28 the coordinator called `orgtree_message` and
`orgtree_send_notice` with the text under `message` instead of `body`. The
unknown field was dropped, `a.get("body", "")` found nothing, and about nine
EMPTY mails were delivered with no error. Agents sat idle waiting on
instructions that never arrived.

The guard has three parts and all are pinned here:

  * the MCP client (`mcptool.tool_call`, Claude and Antigravity lanes) refuses
    any field the tool's card does not declare, a missing required field, and
    a blank mail body — before anything is posted, so no receipt, no mail, no
    wake;
  * the Codex lane, whose calls never pass through mcptool (they are answered
    in-process by `_run_codex_turn`'s `_tool_call`), runs the same check
    through `supervisor.codex_arg_guard`;
  * the backend (`api.agent_call`) repeats the check for the two mail verbs,
    so an older client or a direct caller still cannot send a blank mail.

    python tools/run-python-verification.py tests/test_tool_arg_guard.py
"""
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / 'engine' / 'backend'))
sys.path.insert(0, str(_ROOT))

fx = tempfile.TemporaryDirectory(prefix='tool-arg-guard-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'tool-arg-guard-suite'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                             # noqa: E402
load_app()
from orgtree import store, ledger, supervisor as sup           # noqa: E402
from orgtree import api, mcptool, toolargs                     # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'
assert Path(toolargs.__file__).resolve().is_relative_to(_ROOT), \
    'another checkout shadowed this one — the suite would test the wrong code'

slugs = []


def tearDownModule():
    for s in slugs:
        try:
            store._POOL.close_all(s)
        except Exception:                                        # noqa: BLE001
            pass


class _ReqState:
    agent_identity = None
    bridge_slug = None


class _Req:
    def __init__(self):
        self.state = _ReqState()


class _Wire:
    """Stands in for the backend: records every POST the client makes."""

    def __init__(self):
        self.posts = []

    def post(self, payload, timeout=30):
        self.posts.append(payload)
        return 'ok', json.dumps({'delivered': 'x'})


class ClientRefuses(unittest.TestCase):
    """`mcptool.tool_call` — the MCP `tools/call` of the Claude and Antigravity lanes."""

    def setUp(self):
        self.wire = _Wire()
        self.patches = [patch.object(mcptool, '_post', self.wire.post),
                        patch.object(mcptool, '_epoch', lambda refresh=False: ('e1', ''))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def refused(self, tool, args):
        out = json.loads(mcptool.tool_call(tool, args))
        self.assertIn('error', out, f'{tool} {args} was not refused: {out}')
        self.assertEqual(out.get('state'), 'not_applied')
        self.assertEqual(self.wire.posts, [], 'a refused call must post NOTHING')
        return out['error']

    def test_message_under_message_is_refused_with_the_hint(self):
        for tool in ('orgtree_message', 'orgtree_send_notice'):
            err = self.refused(tool, {'to': 'boss', 'message': 'do the thing'})
            self.assertIn('unknown field `message`', err)
            self.assertIn('did you mean `body`?', err)
            self.assertIn('nothing was sent', err)

    def test_other_text_misnamings_get_the_same_hint(self):
        for wrong in ('text', 'content', 'msg'):
            err = self.refused('orgtree_message', {'to': 'boss', wrong: 'x'})
            self.assertIn(f'unknown field `{wrong}` — did you mean `body`?', err)

    def test_empty_and_blank_bodies_are_refused(self):
        for body in ('', '   \n\t'):
            for tool in ('orgtree_message', 'orgtree_send_notice'):
                err = self.refused(tool, {'to': 'boss', 'body': body})
                self.assertIn('`body` is empty', err)

    def test_missing_body_names_the_field(self):
        err = self.refused('orgtree_message', {'to': 'boss'})
        self.assertIn('required field `body` is missing', err)

    def test_every_unknown_field_is_named(self):
        err = self.refused('orgtree_message',
                           {'to': 'boss', 'body': 'ok', 'urgnt': True, 'zzz': 1})
        self.assertIn('unknown field `urgnt` — did you mean `urgent`?', err)
        self.assertIn('unknown field `zzz`', err)

    def test_unknown_field_on_another_tool_is_refused(self):
        err = self.refused('orgtree_status', {'status': 'done', 'summry': 'x'})
        self.assertIn('did you mean `summary`?', err)

    def test_a_valid_message_still_goes_out(self):
        out = json.loads(mcptool.tool_call('orgtree_message',
                                          {'to': 'boss', 'body': 'hello'}))
        self.assertNotIn('error', out)
        self.assertEqual(len(self.wire.posts), 1)
        sent = self.wire.posts[0]['args']
        self.assertEqual(sent['tool'], 'orgtree_message')
        self.assertEqual(sent['args'], {'to': 'boss', 'body': 'hello'})

    def test_the_stdio_tools_call_goes_through_the_check(self):
        # the path a real agent takes: one JSON-RPC line into main()
        import io
        line = json.dumps({'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call',
                           'params': {'name': 'orgtree_message',
                                      'arguments': {'to': 'boss', 'message': 'hi'}}})
        out = io.StringIO()
        with patch.object(mcptool.sys, 'stdin', io.StringIO(line + '\n')), \
                patch.object(mcptool.sys, 'stdout', out):
            mcptool.main()
        answer = json.loads(out.getvalue())['result']
        self.assertTrue(answer['isError'])
        self.assertIn('did you mean `body`?', answer['content'][0]['text'])
        self.assertEqual(self.wire.posts, [])

    def test_accepted_undeclared_spelling_still_passes(self):
        # `sha` is read by the review branch beside `candidate`; refusing it
        # would break callers that worked before this guard
        out = json.loads(mcptool.tool_call(
            'orgtree_work', {'action': 'review', 'slug': 's', 'sha': 'abc1234'}))
        self.assertNotIn('error', out)
        self.assertEqual(len(self.wire.posts), 1)


class CodexLaneRefuses(unittest.TestCase):
    """`supervisor.codex_arg_guard` — the Codex lane's dispatcher."""

    def setUp(self):
        self.calls = []
        self.guarded = sup.codex_arg_guard(
            lambda tool, args: self.calls.append((tool, args)) or '{"ok": true}')

    def test_misnamed_field_on_a_non_mail_tool_never_dispatches(self):
        out = self.guarded('orgtree_status', {'status': 'done', 'summry': 'x'})
        self.assertIn('did you mean `summary`?', out)
        self.assertIn('nothing was sent', out)
        self.assertEqual(self.calls, [], 'a refused call must reach no backend')

    def test_message_under_message_never_dispatches(self):
        out = self.guarded('orgtree_message', {'to': 'boss', 'message': 'x'})
        self.assertIn('did you mean `body`?', out)
        self.assertEqual(self.calls, [])

    def test_a_valid_call_is_dispatched_unchanged(self):
        out = self.guarded('orgtree_status', {'status': 'done', 'summary': 'x'})
        self.assertEqual(out, '{"ok": true}')
        self.assertEqual(self.calls, [('orgtree_status', {'status': 'done', 'summary': 'x'})])

    def test_the_codex_turn_installs_the_guard(self):
        # the turn hands `tool_dispatch` to CodexTurn in exactly one place;
        # without the wrapper there, the guard above guards nothing
        import inspect
        src = inspect.getsource(sup._codex_leg_attempt)
        self.assertIn('tool_dispatch=codex_arg_guard(_tool_call)', src)
        self.assertNotIn('tool_dispatch=_tool_call', src)


class Catalogue(unittest.TestCase):
    def test_cards_are_not_rewritten(self):
        # no `additionalProperties` on the advertised cards: enforcement is
        # the check above, and Gemini (Antigravity lane) has rejected that
        # keyword in function declarations
        for card in mcptool.available_tools():
            self.assertNotIn('additionalProperties', card['inputSchema'], card['name'])

    def test_accepted_undeclared_names_real_tools(self):
        names = {c['name'] for c in mcptool.TOOLS}
        for tool in toolargs.ACCEPTED_UNDECLARED:
            self.assertIn(tool, names)


class ServerRefuses(unittest.TestCase):
    """`api.agent_call` — the backend half, for a client without the check."""

    def setUp(self):
        slug = 'targ-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.slug = slug
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        org.hire(ledger.USER, 'boss', 'haiku', 0, 'worker')
        store.save_org(org)
        self.patches = [patch.object(sup, '_start_turn_worker'),
                        patch.object(sup, 'notify')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def call(self, tool, args):
        body = api.AgentCall(org=self.slug, node='worker', tool=tool, args=args)
        return api.agent_call(body, _Req())

    def mailbox(self, nid):
        return list((store.load_org(self.slug).d.get('mail') or {}).get(nid, []))

    def test_misnamed_body_is_refused_and_nothing_is_delivered(self):
        for tool in ('orgtree_message', 'orgtree_send_notice'):
            with self.assertRaises(api.HTTPException) as cm:
                self.call(tool, {'to': 'boss', 'message': 'do the thing'})
            self.assertEqual(cm.exception.status_code, 422)
            self.assertIn('did you mean `body`?', str(cm.exception.detail))
        self.assertEqual(self.mailbox('boss'), [])

    def test_blank_body_is_refused_and_nothing_is_delivered(self):
        for tool in ('orgtree_message', 'orgtree_send_notice'):
            for body in ('', '  '):
                with self.assertRaises(api.HTTPException) as cm:
                    self.call(tool, {'to': 'boss', 'body': body})
                self.assertIn('`body` is empty', str(cm.exception.detail))
        self.assertEqual(self.mailbox('boss'), [])

    def test_a_valid_message_and_notice_still_deliver(self):
        self.call('orgtree_message', {'to': 'boss', 'body': 'hello'})
        self.call('orgtree_send_notice', {'to': 'boss', 'body': 'fyi'})
        self.assertEqual([m.get('body') for m in self.mailbox('boss')],
                         ['hello', 'fyi'])


if __name__ == '__main__':
    unittest.main()
