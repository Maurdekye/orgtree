"""The `orgtree_inbox` door: an agent lists and reads its OWN waiting mail
through the real agent gateway (user ruling 2026-09-29, item
let-agents-manually-check-their-unread-inbox; SIMPLE version, Claude and
Codex first).

What this module pins, each through `api.agent_call` (the one request both
lanes make):
  1. list shows the caller's own waiting mail and changes nothing;
  2. any agent/org/mailbox-shaped or unknown argument gets the one fixed
     refusal, and nothing is read;
  3. the user is not an inbox owner;
  4. fetch without the caller's own running turn is refused (custody);
  5. a fetch during the turn drains exactly those ids; with no proof the
     agent received them, turn end returns them to the mailbox, counted as a
     redelivery (never lost);
  6. an unkeyed chunk read is refused at the door (decision42 D1);
  7. both lanes are offered the tool: the MCP catalogue and the Codex
     dynamic-tool catalogue carry the card, with exactly the arguments
     `inbox.check_args` accepts.

The supervisor semantics behind the door (budget, chunking, receipts,
reclaim, confirmation) are covered by test_manual_inbox*.py and
test_codex_*.py.

Run:  python tools/run-python-verification.py tests/test_inbox_door.py
"""
import itertools
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='inbox-door-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from fastapi import HTTPException                                    # noqa: E402
from starlette.requests import Request                               # noqa: E402
from orgtree import (api, inbox, ledger, mailruntime, mcptool,       # noqa: E402
                     store, supervisor as sup)

SLUGS = []
LIVE = 'op-live'
W = 'worker'
_SERIAL = itertools.count()


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class InboxDoorTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"door-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.hire(ledger.USER, None, 'haiku', 0, 'peer')
        store.save_org(org)
        self.st = sup.state(self.slug, W)
        self.n = 0

    def tearDown(self):
        sup._state.pop((self.slug, W), None)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def deposit(self, to=W, body='hello', count=1):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'{to[0]}{self.n:04d}'
            org.deposit_mail(to, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                  'from': 'boss', 'kind': 'message', 'body': body,
                                  'at': ledger.now()})
            ids.append(mid)
        store.save_org(org)
        return ids

    def box(self, nid=W):
        return [m['id'] for m in (self.load().d.get('mail') or {}).get(nid) or []]

    def begin(self):
        org = self.load()
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = LIVE
            self.st['busy'] = True
            mailruntime.register(self.st, org, W, attempt=LIVE, toks=[])

    def end(self):
        """The turn-end order `_run_one_turn_recorded` uses: release custody,
        then the ordinary fold, while the node's busy flags are still set."""
        with sup._state_lock:
            mailruntime.release(self.st, attempt=LIVE)
        sup._fold_back_undelivered(self.slug, W, keep_toks=[])
        with sup._state_lock:
            self.st.pop('lifecycle_operation_id', None)
            self.st['busy'] = False

    def call(self, args, node=W, op_key=''):
        body = api.AgentCall(org=self.slug, node=node, tool=inbox.TOOL, args=args,
                             op_key=op_key)
        return api.agent_call(body, Request({'type': 'http', 'headers': []}))

    # --------------------------------------------------------------- tests
    def test_1_list_shows_own_mail_and_changes_nothing(self):
        mine = self.deposit(count=2)
        self.deposit(to='peer')
        before = self.load().d.get('mail')
        out = self.call({'action': 'list'})
        self.assertTrue(out.get('ok'), out)
        self.assertEqual([r['message_id'] for r in out['rows']], mine,
                         "exactly the caller's own mail, none of the peer's")
        self.assertEqual(self.load().d.get('mail'), before, 'list is inspection')

    def test_2_target_shaped_and_unknown_arguments_are_refused(self):
        self.deposit(to='peer')
        for extra in ({'node': 'peer'}, {'org': 'x'}, {'mailbox': 'peer'},
                      {'to': 'peer'}, {'bogus': 1}):
            out = self.call({'action': 'list', **extra})
            self.assertFalse(out.get('ok'), extra)
            self.assertEqual(out.get('text'), inbox.TARGET_REFUSAL, extra)
        out = self.call({'action': 'peek'})
        self.assertEqual(out.get('error'), 'unknown_action')

    def test_3_the_user_has_no_manual_inbox(self):
        with self.assertRaises(HTTPException) as cm:
            self.call({'action': 'list'}, node=ledger.USER)
        self.assertEqual(cm.exception.status_code, 422)

    def test_4_fetch_needs_the_callers_own_running_turn(self):
        ids = self.deposit()
        out = self.call({'action': 'fetch', 'message_ids': ids})
        self.assertEqual(out.get('error'), 'custody_unproven', out)
        self.assertEqual(self.box(), ids, 'nothing moved')

    def test_5_fetch_drains_and_unproven_mail_is_redelivered(self):
        ids = self.deposit(body='the text', count=2)
        self.begin()
        out = self.call({'action': 'fetch', 'message_ids': ids[:1]})
        self.assertTrue(out.get('ok'), out)
        self.assertEqual([m['message_id'] for m in out['fetched']], ids[:1])
        self.assertEqual(out['fetched'][0]['content'], 'the text')
        self.assertTrue(out.get('will_redeliver'), 'the answer says it may come again')
        self.assertEqual(self.box(), ids[1:], 'only the fetched id left the mailbox')
        self.end()
        box = (self.load().d.get('mail') or {}).get(W) or []
        self.assertEqual(sorted(m['id'] for m in box), sorted(ids), 'nothing lost')
        back = next(m for m in box if m['id'] == ids[0])
        self.assertEqual(back.get('redelivered'), 1, 'counted as a redelivery')

    def test_6_an_unkeyed_chunk_read_is_refused(self):
        out = self.call({'action': 'chunk', 'delivery_id': 'mf-x', 'message_id': 'w0001',
                         'chunk_index': 0})
        self.assertEqual(out.get('error'), 'op_key_required', out)

    def test_7_both_lanes_are_offered_the_tool(self):
        claude = [t for t in mcptool.available_tools() if t['name'] == inbox.TOOL]
        self.assertEqual(len(claude), 1, 'the MCP catalogue (Claude lane) has the card')
        codex = [t for t in sup._orgtree_tool_catalogue() if t['name'] == inbox.TOOL]
        self.assertEqual(len(codex), 1, 'the Codex dynamic-tool catalogue has it')
        props = set(claude[0]['inputSchema']['properties'])
        allowed = {'action'}.union(*inbox._ARGS.values())
        self.assertEqual(props, allowed,
                         'the card offers exactly the arguments check_args accepts')


if __name__ == '__main__':
    unittest.main()
