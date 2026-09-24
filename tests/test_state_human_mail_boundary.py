"""P01 S3 legacy boundary contracts for the human send and the inbox routes.

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, session
commands, the UI spark and the tree broadcast are spies; the desktop token gate,
the routes, the ledger, save and reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (human-mail.* and inbox.*) against
docs/state-system/human-mail-boundary.json.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

_temp = tempfile.TemporaryDirectory(prefix='p01-human-mail-boundary-')
_data = Path(_temp.name) / 'data'
_home = Path(_temp.name) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, store  # noqa: E402

OP = {'X-Orgtree-Desktop-Token': 'operator'}
CARRIER = {'delivered': True, 'queued': 1}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'routes', 'carrier', 'results', 'sections', 'ping',
          'legacy_defects', 'scope'}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/human-mail-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.human-mail-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['routes']) != {'mail.human-send', 'mail.user-inbox', 'mail.user-inbox-read', 'mail.node-inbox'} \
            or not set(d['routes']) <= set(registry['contracts']):
        raise ValueError('every human-mail contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(result['qualification'], contracts.GATES)
        for name in ('human-mail.effects', 'human-mail.reads', 'human-mail.conflicts', 'human-mail.wire',
                     'human-mail.instrumentation', 'inbox.reads', 'inbox.writes', 'inbox.conflicts', 'inbox.wire',
                     'inbox.instrumentation'):
            self.assertEqual(registry['facets'][name]['status'], 'unresolved', name)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['routes'].pop('mail.node-inbox'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class HumanMailBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-human-mail-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 10, 'top')
        org.hire(ledger.USER, 'top', 'haiku', 6, 'mid')
        org.hire(ledger.USER, 'mid', 'haiku', 0, 'deep')
        org.hire(ledger.USER, 'top', 'haiku', 0, 'gone')
        org.retire(ledger.USER, 'gone')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value=dict(CARRIER)))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.immediate = self.enterContext(patch.object(api.supervisor, 'immediate_command', return_value=False))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    def reset(self):
        for spy in (self.drive, self.notify, self.hub, self.immediate):
            spy.reset_mock()

    def send(self, nid, **body):
        self.reset()
        before = self.durable()
        r = self.client.post(f'/api/orgs/{self.slug}/nodes/{nid}/message', json=body, headers=OP)
        after = self.durable()
        return r, self.changed(before, after), before, after

    def refuses(self, nid, body, code, detail):
        r, changed, _, _ = self.send(nid, **body)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        for spy in (self.drive, self.notify, self.immediate):
            spy.assert_not_called()

    # -- the door -------------------------------------------------------------
    def test_desktop_token_gates_every_route(self):
        agent = agentauth.child_env(self.slug, 'top')['ORGTREE_AGENT_TOKEN']
        for method, path, body in (('POST', f'/api/orgs/{self.slug}/nodes/top/message', {'text': 'x'}),
                                   ('GET', f'/api/orgs/{self.slug}/inbox', None),
                                   ('POST', f'/api/orgs/{self.slug}/inbox/read', {'ids': []}),
                                   ('GET', f'/api/orgs/{self.slug}/nodes/top/inbox', None)):
            with self.subTest(path=path):
                for headers in ({}, {'X-Orgtree-Agent-Token': agent}):
                    self.assertEqual(self.client.request(method, path, json=body, headers=headers).status_code, 401)
        self.assertEqual(self.client.get(f'/api/orgs/{self.slug}/nodes/nobody/inbox', headers=OP).status_code, 404)

    # -- the human send -------------------------------------------------------
    def test_mail_to_a_top_level_node_files_a_typed_row_a_sent_copy_and_pings(self):
        spec = self.spec
        r, changed, before, after = self.send('top', text='hello top', client_op='op-1')
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()
        self.assertEqual(sorted(result), sorted(spec['carrier'] + spec['results']['mail']))
        self.assertEqual(changed, spec['sections']['top'])
        row = after['mail']['top'][-1]
        self.assertEqual((row['from'], row['kind'], row['body'], row['relationship'], row['client_op'], row['ev']['variant']),
                         (ledger.USER, 'message', 'hello top', 'USER', 'op-1', 'ordinary.message'))
        self.assertEqual(after['user_outbox'][-1]['to'], 'top')
        self.notify.assert_called_once_with(self.slug, ledger.USER, 'top')
        args, kwargs = self.drive.call_args
        self.assertEqual((args[1], kwargs['mail_ping'], kwargs['ping_reason']), ('top', True, spec['ping']['mail']['ping_reason']))
        # client_op is not an idempotency key: the same request posts again
        r2, _, _, again = self.send('top', text='hello top', client_op='op-1')
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(len(again['mail']['top']), len(after['mail']['top']) + 1)

    def test_deep_reach_grants_once_and_notifies_the_chain_even_when_deferred(self):
        spec = self.spec
        r, changed, before, after = self.send('deep', text='hello deep')
        self.assertEqual(changed, spec['sections']['deep_first'])
        self.assertEqual([(a['grantee'], a['grantor']) for a in after['audiences']], [('deep', ledger.USER)])
        reached = {n for n, rows in after['notices'].items()
                   if any((x.get('ev') or {}).get('variant') == 'context.deep_reach' for x in rows)}
        self.assertEqual(reached, {'top', 'mid'})
        r, changed, _, _ = self.send('deep', text='again')
        self.assertEqual(changed, spec['sections']['deep'])        # no second grant
        r, changed, _, after = self.send('gone', text='to the archive')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sorted(r.json()), spec['results']['deferred'])
        self.assertTrue(r.json()['deferred'])
        self.assertIn(('gone', ledger.USER), [(a['grantee'], a['grantor']) for a in after['audiences']])
        self.drive.assert_not_called()
        self.notify.assert_called_once_with(self.slug, ledger.USER, 'gone')

    def test_notice_flag_steers_without_waking(self):
        spec = self.spec
        r, changed, _, after = self.send('mid', text='fyi', notice=True)
        self.assertEqual(sorted(r.json()), sorted(spec['carrier'] + spec['results']['mail'] + spec['results']['notice_adds']))
        self.assertEqual(after['mail']['mid'][-1]['kind'], 'notice')
        args, kwargs = self.drive.call_args
        self.assertEqual((kwargs['wake'], kwargs['ping_reason']), (spec['ping']['notice']['wake'], spec['ping']['notice']['ping_reason']))

    def test_refusals_write_nothing(self):
        self.refuses('top', {'text': '   '}, 422, 'empty message')
        self.refuses('top', {'text': 'x', 'target': {'kind': 'mail'}, 'reply_to': {}}, 422, 'send one of target, reply_to')
        self.refuses('top', {'text': 'x', 'client_op': 'c' * 129}, 422, 'client_op is 129 characters and the limit is 128')
        self.refuses('nobody', {'text': 'x'}, 422, 'NOT DELIVERED')
        self.refuses('gone', {'text': '/model sonnet'}, 409, 'a session command runs nothing there')

    def test_session_command_is_not_mail_but_is_direct_contact(self):
        spec = self.spec
        r, changed, _, after = self.send('mid', text='/model sonnet')
        self.assertEqual(r.json(), CARRIER)
        self.assertEqual(changed, spec['sections']['command_first'])
        self.assertNotIn('mid', after.get('mail', {}))
        self.immediate.assert_called_once_with(self.slug, 'mid', '/model sonnet')
        args, kwargs = self.drive.call_args
        self.assertEqual((args[1], args[2], kwargs), ('mid', '/model sonnet', {'command': True}))
        # a path-shaped first token is correspondence, not a command
        r, changed, _, after = self.send('top', text='/e/Libraries/x.md please')
        self.assertEqual(after['mail']['top'][-1]['body'], '/e/Libraries/x.md please')
        self.immediate.assert_not_called()

    def test_missing_attachment_is_recorded_on_the_row_and_warned(self):
        r, _, _, after = self.send('top', text='see file', attachments=['nope.txt'])
        self.assertEqual(r.status_code, 200)
        row = after['mail']['top'][-1]
        self.assertEqual(len(row['attachments_missing']), 1)
        self.assertIn('nope.txt', row['attachments_missing'][0])
        self.assertIn('did NOT reach top', ' '.join(r.json()['warnings']))

    # -- the inbox routes ----------------------------------------------------------
    def test_user_inbox_read_moves_rows_and_always_broadcasts(self):
        spec = self.spec
        with store.write_org(self.slug) as org:
            org.post_mail('top', 'user', 'report for you')
            store.save_org(org)
        box = self.client.get(f'/api/orgs/{self.slug}/inbox', headers=OP).json()
        self.assertEqual(sorted(box), spec['results']['inbox'])
        [row] = box['pending']
        self.assertEqual(sorted(row), spec['results']['pending_row'])
        before = self.durable()
        self.reset()
        read = self.client.post(f'/api/orgs/{self.slug}/inbox/read', json={'ids': [row['id']]}, headers=OP).json()
        after = self.durable()
        self.assertEqual((read, self.changed(before, after)), ({'read': 1}, spec['sections']['read']))
        self.assertEqual(after['user_mail_log'][-1]['id'], row['id'])
        self.hub.assert_called_once_with(self.slug)
        self.reset()
        again = self.client.post(f'/api/orgs/{self.slug}/inbox/read', json={'ids': [row['id'], 'nope']}, headers=OP).json()
        self.assertEqual((again, self.durable()), ({'read': 0}, after))
        self.hub.assert_called_once_with(self.slug)             # broadcast even though nothing was read
        box = self.client.get(f'/api/orgs/{self.slug}/inbox', headers=OP).json()
        self.assertEqual(([m['id'] for m in box['delivered']], box['pending']), ([row['id']], []))

    def test_node_inbox_lists_pending_delivered_and_sent(self):
        spec = self.spec
        self.send('top', text='from the user')
        with store.write_org(self.slug) as org:
            org.post_mail('top', 'mid', 'to my report')
            store.save_org(org)
        before = self.durable()
        box = self.client.get(f'/api/orgs/{self.slug}/nodes/top/inbox', headers=OP).json()
        self.assertEqual(sorted(box), spec['results']['inbox'])
        self.assertEqual([m['body'] for m in box['pending']], ['from the user'])
        self.assertEqual([(m['to'], m['body']) for m in box['sent']], [('mid', 'to my report')])
        self.assertEqual(self.durable(), before)


if __name__ == '__main__':
    unittest.main()
