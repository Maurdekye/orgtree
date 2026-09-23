"""Authenticated legacy-seat delivery, with isolated storage and inert wakes."""
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='send-file-seat-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_V2_TOKEN'] = 'test-operator'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app, TokenGate
load_app()
from fastapi.testclient import TestClient
from orgtree import api, agentauth, ledger, store, supervisor, toolwait
assert Path(api.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1])


class SendFileSeatTests(unittest.TestCase):
    """The api's lazy legacy-seat mint (`_agent_identity`, durable=True).

    P04a-1 gives every legacy seat its `seat_id` at load
    (`Org._backfill_seat_ids`), which makes that mint unreachable from an
    ordinary load. It is kept as a defence. Since P04a-2 an agent credential
    names its seat (`agentauth.child_env` signs `seat_id`), so a seatless node
    can never present a valid agent token: the mint is reachable only from an
    identity-less (desktop) request. The LAZY tests switch the load-time
    backfill off and pin the defence through that door; every other test runs
    with the backfill, as production does, and signs the stored seat."""

    LAZY = {'test_exact_legacy_failure_and_authenticated_positive_control',
            'test_missing_invalid_cross_org_archived_and_stale_refused',
            'test_identity_must_persist_before_any_copy',
            'test_other_managed_operations_backfill_the_same_legacy_seat',
            'test_missing_seat_and_bad_context_are_actionable'}
    DESKTOP = {'x-orgtree-desktop-token': 'test-operator'}

    def setUp(self):
        self.backfill = patch.object(ledger.Org, '_backfill_seat_ids', lambda org: None)
        if self._testMethodName in self.LAZY:
            self.backfill.start()
        self.slug = self._testMethodName.replace('_', '-')
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'sender')
        org.node('sender').pop('seat_id', None)  # actual pre-seat_id storage shape
        store.save_org(org)
        self.source = Path(supervisor.scratch_dir(self.slug, 'sender')) / 'sample.txt'
        self.source.parent.mkdir(parents=True, exist_ok=True)
        self.source.write_text('harmless fixture', encoding='utf-8')
        self.key = patch.object(agentauth, '_key', b'isolated-fixture-key')
        self.key.start()
        self.wake = patch.object(supervisor, 'send_message', return_value={'accepted': True})
        self.wake.start()
        self.client = TestClient(TokenGate(api.app, 'test-operator'))
        self.headers = dict(self.DESKTOP) if self._testMethodName in self.LAZY else self.token()

    def tearDown(self):
        self.client.close()
        self.wake.stop()
        self.key.stop()
        patch.stopall()
        store._POOL.close_all(self.slug)

    def token(self, generation=None, seat=None):
        # a seatless (LAZY) node has no seat to sign: a fixture seat stands in,
        # and the refusals these tests pin fire before the seat is compared
        seat = seat or store.load_org(self.slug).node('sender').get('seat_id') or 'unminted-fixture-seat'
        return {'x-orgtree-agent-token': agentauth.child_env(
            self.slug, 'sender', generation=generation, seat_id=seat)['ORGTREE_AGENT_TOKEN']}

    def call(self, tool='orgtree_send_file', args=None, **extra):
        return self.client.post('/api/agent', headers=self.headers,
            json={'org': self.slug, 'node': 'sender', 'tool': tool,
                  'args': args if args is not None else {'path': 'sample.txt'}, **extra})

    def test_exact_legacy_failure_and_authenticated_positive_control(self):
        self.assertEqual(self.call('orgtree_status', {'status': 'working', 'summary': 'fixture'}).status_code, 200)
        self.assertFalse(store.load_org(self.slug).node('sender').get('seat_id'))
        identity = api._agent_identity
        # Restores only the old omission. Same signed request and real live
        # stored seat; the old managed adapter refuses before copying bytes.
        with patch.object(api, '_agent_identity', side_effect=lambda b, r, **kw: identity(b, r)), \
                patch.object(toolwait, 'TOOLS', toolwait.TOOLS | {'orgtree_send_file'}):
            old = self.call()
        self.assertEqual(old.status_code, 409)
        self.assertIn('no durable seat identity', old.text)
        self.assertFalse((self.source.parent / 'outbox').exists())
        fixed = self.call()
        self.assertEqual(fixed.status_code, 200, fixed.text)
        self.assertEqual(fixed.json()['sent']['bytes'], len(b'harmless fixture'))
        self.assertTrue(store.load_org(self.slug).node('sender')['seat_id'])

    def test_identity_survives_reload_compaction_and_fresh_credentials(self):
        self.assertEqual(self.call().status_code, 200)
        seat = store.load_org(self.slug).node('sender')['seat_id']
        store._POOL.close_all(self.slug)
        self.assertEqual(self.call().status_code, 200)
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org._compact_split_apply('sender', 'replacement-session')
            store.save_org(org)
        stale = self.call()
        self.assertEqual(stale.status_code, 403)
        self.assertIn('generation changed', stale.text)
        self.headers = self.token()
        self.assertEqual(self.call().status_code, 200)
        self.assertEqual(store.load_org(self.slug).node('sender')['seat_id'], seat)
        with patch.object(agentauth, '_key', b'restarted-engine-key'):
            self.headers = self.token()
            self.assertEqual(self.call().status_code, 200)
        self.assertEqual(store.load_org(self.slug).node('sender')['seat_id'], seat)

    def test_missing_invalid_cross_org_archived_and_stale_refused(self):
        self.headers = {}
        self.assertEqual(self.call().status_code, 401)
        self.headers = {'x-orgtree-agent-token': 'forged'}
        self.assertEqual(self.call().status_code, 401)
        self.headers = self.token()
        self.assertEqual(self.call(org='another-org').status_code, 403)
        self.headers = self.token(generation=99)
        self.assertIn('generation changed', self.call().text)
        self.headers = self.token()
        org = store.load_org(self.slug)
        org.node('sender')['state'] = 'archived'
        store.save_org(org)
        refused = self.call()
        self.assertEqual(refused.status_code, 403)
        self.assertIn('archived', refused.text)
        self.assertFalse(store.load_org(self.slug).node('sender').get('seat_id'))

    def test_unauthorized_path_remains_refused(self):
        outside = Path(_root.name) / 'private.txt'
        outside.write_text('private fixture')
        refused = self.call(args={'path': str(outside), 'seat_id': 'forged'})
        self.assertEqual(refused.status_code, 422, refused.text)
        self.assertIn('only files', refused.text)
        self.assertNotEqual(store.load_org(self.slug).node('sender')['seat_id'], 'forged')

    def test_idempotent_retry_reuses_bytes_after_receipt_failure_and_reload(self):
        from orgtree import filedelivery
        key = 'retry-one-operation'
        original = filedelivery._hash
        with patch.object(filedelivery, '_hash', side_effect=OSError('receipt boundary crash')):
            with self.assertRaises(OSError):
                self.call(args={'path': 'sample.txt', 'delivery_id': key})
        self.assertEqual(len(list((self.source.parent / 'outbox').glob('delivery-*/*'))), 1)
        first = self.call(args={'path': 'sample.txt', 'delivery_id': key})
        self.assertEqual(first.status_code, 200, first.text)
        store._POOL.close_all(self.slug)
        again = self.call(args={'path': 'sample.txt', 'delivery_id': key})
        self.assertEqual(again.json(), first.json())
        self.assertEqual(len(list((self.source.parent / 'outbox').glob('delivery-*/*'))), 1)
        conflict = self.call(args={'path': 'sample.txt', 'note': 'different', 'delivery_id': key})
        self.assertEqual(conflict.status_code, 422)

    def test_retry_id_never_bypasses_revoked_path_or_changed_snapshot(self):
        key = 'same-delivery-control'
        response = self.call(args={'path': 'sample.txt', 'delivery_id': key})
        self.assertEqual(response.status_code, 200)
        sent = response.json()['sent']
        target = self.source.parent / sent['path']
        target.write_text('changed bytes')
        refusal = self.call(args={'path': 'sample.txt', 'delivery_id': key})
        self.assertEqual(refusal.status_code, 422)
        self.assertIn('missing or changed', refusal.text)

    def test_corrupt_receipt_is_actionable_and_never_recopies(self):
        from contextlib import closing
        import json
        import sqlite3
        from orgtree import filedelivery
        args = {'path': 'sample.txt', 'delivery_id': 'corrupt-receipt-delivery'}
        first = self.call(args=args)
        self.assertEqual(first.status_code, 200, first.text)
        sent = first.json()['sent']
        target = self.source.parent / sent['path']
        original_bytes = target.read_bytes()
        # NULL is the intentional unfinished state, but JSON null, empty text,
        # wrong shapes and card fields inconsistent with this request are not.
        invalid = ['{broken', '', 'null', '[]', '{}', '"text"']
        for field, value in [('bytes', True), ('bytes', -1), ('bytes', '16'),
                             ('sha256', None), ('sha256', 'invalid'),
                             ('name', 'other.txt'), ('path', '../private.txt'),
                             ('delivery_id', 'other'), ('extra', 'unexpected')]:
            invalid.append(json.dumps({**sent, field: value}))
        with closing(sqlite3.connect(Path(store.DATA_ROOT) / 'file-deliveries.db')) as db:
            for raw in invalid:
                with self.subTest(receipt=raw):
                    db.execute('UPDATE deliveries SET result=? WHERE id=?', (raw, sent['delivery_id']))
                    db.commit()
                    with patch.object(filedelivery.shutil, 'copyfileobj', side_effect=AssertionError('recopy')):
                        refused = self.call(args=args)
                    self.assertEqual(refused.status_code, 422, refused.text)
                    self.assertIn('saved delivery receipt is invalid', refused.text)
                    self.assertIn('no file was resent', refused.text)
                    self.assertNotIn('sent', refused.json())
                    self.assertEqual(target.read_bytes(), original_bytes)
                    self.assertEqual(db.execute('SELECT result FROM deliveries WHERE id=?',
                                               (sent['delivery_id'],)).fetchone()[0], raw)
            db.execute('UPDATE deliveries SET result=? WHERE id=?', (json.dumps(sent), sent['delivery_id']))
            db.commit()
        self.assertEqual(self.call(args=args).json(), first.json())
        self.assertEqual(len(list((self.source.parent / 'outbox').glob('delivery-*/*'))), 1)

    def test_one_card_on_replayed_response_and_card_after_lost_response(self):
        from orgtree import filedelivery
        response = self.call(args={'path': 'sample.txt', 'delivery_id': 'one-visible-download'})
        sent = response.json()['sent']
        payload = {'messages': [{'tools': [{'file': sent}]}, {'tools': [{'file': sent}]}]}
        projected = filedelivery.unique_cards(payload)
        self.assertEqual(sum('file' in tool for m in projected['messages'] for tool in m['tools']), 1)
        self.assertIn('file', payload['messages'][1]['tools'][0])  # cache is not mutated
        retry_only = filedelivery.unique_cards({'messages': [{'tools': []}, {'tools': [{'file': sent}]}]})
        self.assertIn('file', retry_only['messages'][1]['tools'][0])
        self.assertEqual(filedelivery.unique_cards({'messages': [{'tools': [None]}]})['messages'][0]['tools'], [None])

        import json
        rows = []
        for i, name in enumerate(('orgtree_send_file', 'mcp__orgtree__orgtree_send_file')):
            rows.extend([
                {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                    {'type': 'tool_use', 'id': str(i), 'name': name, 'input': {'path': 'sample.txt'}}]}},
                {'type': 'user', 'message': {'role': 'user', 'content': [
                    {'type': 'tool_result', 'tool_use_id': str(i), 'content': response.text}]}},
            ])
        org = store.load_org(self.slug)
        parsed = supervisor._read_chat_source(org, 'sender', hold_back=False,
            _path=Path(_root.name) / 'fixture.jsonl',
            _lines=[json.dumps(r) + '\n' for r in rows], _prompt_views={})
        with patch('orgtree.chat_window.read_window', return_value=parsed):
            chat = supervisor.read_chat(org, 'sender')
        cards = [t['file'] for m in chat['messages'] for t in m.get('tools', []) if t.get('file')]
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]['path'], sent['path'])
        download = self.client.get(f'/api/orgs/{self.slug}/nodes/sender/file',
            params={'path': sent['path']}, headers={'x-orgtree-desktop-token': 'test-operator'})
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, b'harmless fixture')

    def test_user_mail_fallback_keeps_working(self):
        response = self.call('orgtree_message', {'to': 'user', 'body': 'fixture', 'attachments': ['sample.txt']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(store.load_org(self.slug).d['user_inbox'][-1]['attachments']), 1)

    def test_other_managed_operations_backfill_the_same_legacy_seat(self):
        with patch.object(api, 'agent_call', return_value={'safe': True}):
            response = self.call('orgtree_staff', {})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(store.load_org(self.slug).node('sender').get('seat_id'))

    def test_missing_seat_and_bad_context_are_actionable(self):
        from types import SimpleNamespace
        from fastapi import HTTPException
        body = api.AgentCall(org=self.slug, node='sender', tool='orgtree_send_file', args={})
        with self.assertRaises(HTTPException) as error:
            api._agent_identity(body, SimpleNamespace(state=SimpleNamespace(agent_identity=('broken',))), durable=True)
        self.assertIn('unsupported', error.exception.detail)
        org = store.load_org(self.slug)
        del org.nodes['sender']
        store.save_org(org)
        response = self.call()
        self.assertEqual(response.status_code, 403)
        self.assertIn('missing', response.text)

    def test_client_preserves_retry_identity_when_transport_loses_response(self):
        from orgtree import mcptool
        import json
        with patch.object(mcptool, '_post', return_value=('lost', 'response lost')) as post:
            result = json.loads(mcptool.call_api('orgtree_send_file', {'path': 'sample.txt'}))
            sent_id = post.call_args.args[0]['args']['delivery_id']
            self.assertEqual(post.call_args.args[0]['tool'], 'orgtree_send_file_once')
            self.assertEqual(result['delivery_id'], sent_id)
            mcptool.call_api('orgtree_send_file', {'path': 'sample.txt', 'delivery_id': sent_id})
            self.assertEqual(post.call_args.args[0]['args']['delivery_id'], sent_id)

    def test_concurrent_same_delivery_has_one_snapshot_and_seat(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.call(args={
                'path': 'sample.txt', 'delivery_id': 'concurrent-one-delivery'}), range(4)))
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertEqual(len({r.json()['sent']['path'] for r in results}), 1)
        self.assertEqual(len(list((self.source.parent / 'outbox').glob('delivery-*/*'))), 1)

    def test_completed_retry_rechecks_removed_folder_grant(self):
        granted = Path(_root.name) / ('grant-' + self.slug)
        granted.mkdir()
        file = granted / 'granted.txt'
        file.write_text('fixture')
        org = store.load_org(self.slug)
        org.node('sender')['scope']['add_dirs'] = [{'path': str(granted), 'mode': 'ro'}]
        store.save_org(org)
        args = {'path': str(file), 'delivery_id': 'granted-file-delivery'}
        self.assertEqual(self.call(args=args).status_code, 200)
        org = store.load_org(self.slug)
        org.node('sender')['scope']['add_dirs'] = []
        store.save_org(org)
        self.assertEqual(self.call(args=args).status_code, 422)

    def test_eager_backfill_supplies_the_legacy_seat(self):
        # P04a-1: the legacy seat is present from the first load, derived
        # deterministically, so every construction and the managed call agree
        org = store.load_org(self.slug)
        seat = org.node('sender')['seat_id']
        self.assertEqual(seat, ledger.Org.legacy_seat_id('sender', org.node('sender')))
        response = self.call()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(store.load_org(self.slug).node('sender')['seat_id'], seat)
        org = store.load_org(self.slug)
        store.save_org(org)
        self.assertEqual(store.load_org(self.slug).node('sender')['seat_id'], seat)

    def test_identity_must_persist_before_any_copy(self):
        with patch.object(store, 'save_org', side_effect=OSError('identity persistence refused')):
            with self.assertRaises(OSError):
                self.call()
        self.assertFalse((self.source.parent / 'outbox').exists())
        self.assertFalse(store.load_org(self.slug).node('sender').get('seat_id'))

    def test_file_response_never_turns_into_generic_managed_result_mail(self):
        with patch.object(toolwait, 'invoke', side_effect=AssertionError('file lost its card response')):
            response = self.call(args={'path': 'sample.txt', 'delivery_id': 'real-download-result'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('sent', response.json())

    def test_retry_transport_uses_identical_auth_and_path_gates(self):
        key = {'path': 'sample.txt', 'delivery_id': 'transport-test-delivery'}
        response = self.call('orgtree_send_file_once', key)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.call('orgtree_send_file_once', key).json())
        self.assertEqual(self.call('orgtree_send_file_once', key, org='other-org').status_code, 403)
        self.assertEqual(self.call('orgtree_send_file_once', {'path': 'sample.txt'}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
