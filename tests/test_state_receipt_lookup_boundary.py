"""P01 S3 legacy boundary contracts for receipt lookup (orgtree_op_lookup) and the client's reading of it.

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, the UI spark
and the tree broadcast are spies; the agent door, the receipt log, admission, the
fence, save and reload are real. The client branch runs mcptool.call_api with its
transport patched. Each test pins a fact stated in
docs/state-system/operation-contracts.json (receipt-lookup.*) against
docs/state-system/receipt-lookup-boundary.json.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-receipt-lookup-boundary-', ignore_cleanup_errors=True)
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
from orgtree import agentauth, api, ledger, mcptool, opreceipts, store  # noqa: E402

RA = 'orgtree_reallocate'
ARGS = {'node': 'mid', 'delta': 1}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'legacy_defects', 'scope'}
AGENT = '7ed4d9f68b5237fde64e698be4f15ad9b91726dafd376a7d6e16aff49b4ab8e3'


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/receipt-lookup-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.receipt-lookup-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {'receipt.lookup'} or 'receipt.lookup' not in registry['contracts']:
        raise ValueError('the receipt.lookup contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # reads and instrumentation were specified from P02 rows (S2i); conflicts and wire stay open
        for name in ('conflicts', 'wire'):
            self.assertEqual(registry['facets']['receipt-lookup.' + name]['status'], 'unresolved', name)
        for name in ('reads', 'instrumentation'):
            self.assertEqual(registry['facets']['receipt-lookup.' + name]['status'], 'specified', name)
        # the agent door stays pending by precedent; only the lookup verb is selected
        [door] = [r for r in registry['entries'] if r['id'] == AGENT]
        self.assertEqual((door['disposition'], door['contracts']), ('pending', []))
        self.assertEqual(contracts.select(registry, AGENT, {'tool': 'orgtree_op_lookup'}), ['receipt.lookup'])
        for tool in ('orgtree_op_call', 'orgtree_op_epoch', RA):
            self.assertEqual(contracts.select(registry, AGENT, {'tool': tool}), [])

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('receipt.lookup'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class ReceiptLookupBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-receipt-lookup-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 4, 'mid', add_dirs=[], tools=NO_TOOLS, org_visibility='team', charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN'] for n in ('top', 'mid')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.epoch = self.post('top', opreceipts.OP_EPOCH, {}).json()['epoch']

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    def post(self, actor, tool, args, headers=None):
        return self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=tool, args=args),
                                headers=headers or {'X-Orgtree-Agent-Token': self.tokens[actor]})

    def lookup(self, key, actor='top', tool=RA, args=ARGS, epoch=None):
        body = {'op_key': key, 'op_epoch': self.epoch if epoch is None else epoch, 'for_tool': tool, 'for_args': args}
        return self.post(actor, opreceipts.OP_LOOKUP, body)

    def act(self, request):
        for spy in (self.drive, self.notify, self.hub):
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        self.assertEqual((self.drive.call_count, self.notify.call_count, self.hub.call_count), (0, 0, 0))
        return r, self.changed(before, after), after

    def test_a_missed_lookup_fences_and_the_delayed_original_is_refused(self):
        spec = self.spec
        key = opreceipts.mint_key()
        r, changed, after = self.act(lambda: self.lookup(key))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()['state'], r.json()['fenced'], sorted(r.json())), ('not_applied', True, spec['results']['not_applied']))
        self.assertEqual(changed, spec['sections']['fence'])
        [row] = [x for x in after[opreceipts.SECTION] if x.get('key') == key]
        self.assertEqual((row['node'], row['outcome']), ('top', 'fenced'))
        # the lost original arrives late: refused at admission, nothing changes
        r, changed, after = self.act(lambda: self.post('top', opreceipts.OP_CALL,
                                                       {'tool': RA, 'args': ARGS, 'op_key': key, 'op_epoch': self.epoch}))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn('op_key refused (fenced)', r.json()['detail'])
        self.assertEqual((changed, after['nodes']['mid']['grant']), ([], 4))
        # asking again answers from the fence and writes nothing
        r, changed, _ = self.act(lambda: self.lookup(key))
        self.assertEqual((r.json()['state'], changed), ('not_applied', []))
        self.assertIn('at', r.json())

    def test_applied_conflict_and_rotated_epoch_write_nothing(self):
        spec = self.spec
        key = opreceipts.mint_key()
        self.assertEqual(self.post('top', opreceipts.OP_CALL, {'tool': RA, 'args': ARGS, 'op_key': key,
                                                              'op_epoch': self.epoch}).status_code, 200)
        r, changed, _ = self.act(lambda: self.lookup(key))
        self.assertEqual((r.json()['state'], sorted(r.json()), changed), ('applied', spec['results']['applied'], []))
        r, changed, _ = self.act(lambda: self.lookup(key, args={'node': 'mid', 'delta': 2}))
        self.assertEqual((r.json()['state'], changed), ('conflict', []))
        # a rotated epoch: an applied row is still positive evidence, an absent one proves nothing and is NOT fenced
        r, changed, _ = self.act(lambda: self.lookup(key, epoch='rotated'))
        self.assertEqual((r.json()['state'], changed), ('applied', []))
        r, changed, _ = self.act(lambda: self.lookup(opreceipts.mint_key(), epoch='rotated'))
        self.assertEqual((r.json()['state'], r.json()['reason'], r.json()['fenced'], changed), ('unknown', 'epoch_rotated', False, []))

    def test_coverage_classes_decide_what_a_fence_can_prove(self):
        r, changed, _ = self.act(lambda: self.lookup(opreceipts.mint_key(), tool='orgtree_chart', args={}))
        self.assertEqual((r.json()['state'], r.json()['reason'], changed), ('unknown', 'unsupported_operation', []))
        # a verb that also works before the transaction is fenced, but cannot be proven absent
        r, changed, _ = self.act(lambda: self.lookup(opreceipts.mint_key(), tool='orgtree_retire', args={'node': 'mid'}))
        self.assertEqual((r.json()['state'], r.json()['reason'], r.json()['fenced']), ('unknown', 'pre_transaction_step', True))
        self.assertEqual(changed, self.spec['sections']['fence'])

    def test_authority_and_refusals(self):
        key = opreceipts.mint_key()
        self.assertEqual(self.post('top', opreceipts.OP_CALL, {'tool': RA, 'args': ARGS, 'op_key': key,
                                                              'op_epoch': self.epoch}).status_code, 200)
        # another agent asking about top's key finds nothing in ITS namespace, and fences it there
        r, _, after = self.act(lambda: self.lookup(key, actor='mid'))
        self.assertEqual(r.json()['state'], 'not_applied')
        self.assertEqual(sorted(x['node'] for x in after[opreceipts.SECTION] if x.get('key') == key), ['mid', 'top'])
        # like every agent tool, refused while the caller is halted (the halt gate runs first)
        with patch.object(api.supervisor.halt, 'blocked', return_value='halt'):
            r, changed, _ = self.act(lambda: self.lookup(key))
        self.assertEqual((r.status_code, changed), (409, []))
        self.assertIn('agent is halted', r.json()['detail'])
        for body, detail in (({'op_epoch': self.epoch, 'for_tool': RA, 'for_args': ARGS}, 'a lookup needs the `op_key`'),
                             ({'op_key': opreceipts.mint_key(), 'op_epoch': self.epoch, 'for_args': ARGS}, 'a lookup needs `for_tool`')):
            with self.subTest(detail=detail):
                r, changed, _ = self.act(lambda: self.post('top', opreceipts.OP_LOOKUP, body))
                self.assertEqual((r.status_code, changed), (422, []))
                self.assertIn(detail, r.json()['detail'])
        r, changed, _ = self.act(lambda: self.post('top', opreceipts.OP_LOOKUP, {'op_key': key},
                                                   headers={'X-Orgtree-Agent-Token': 'nope'}))
        self.assertEqual((r.status_code, changed), (401, []))

    def test_the_client_reads_a_refused_lookup_as_an_unsupported_build(self):
        spec = self.spec
        sent = []

        def transport(payload, timeout=30):
            sent.append(payload['tool'])
            if payload['tool'] == opreceipts.OP_CALL:
                return ('lost', 'read timed out')
            return ('refused', "HTTP 422: unknown orgtree tool 'orgtree_op_lookup'")

        with patch.object(mcptool, '_post', side_effect=transport), patch.object(mcptool, '_epoch', return_value=('E1', '')):
            answer = json.loads(mcptool.call_api(RA, ARGS))
        self.assertEqual(sent, [opreceipts.OP_CALL, opreceipts.OP_LOOKUP])     # asked once, never reissued
        self.assertEqual((sorted(answer), answer['state'], answer['reason']),
                         (spec['results']['client_unsupported_build'], 'unknown', 'unsupported_build'))


if __name__ == '__main__':
    unittest.main()
