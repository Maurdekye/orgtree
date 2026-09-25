"""P01 S3 legacy boundary contracts for credit requests, reallocation and the credit decision.

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, the UI
spark and the tree broadcast are spies; the agent door, the desktop token gate, the
ledger, save and reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (funding.*) against
docs/state-system/funding-boundary.json.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-funding-boundary-')
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
from orgtree import agentauth, api, ledger, opreceipts, store  # noqa: E402

RC, RA = 'orgtree_request_credits', 'orgtree_reallocate'
OP = {'X-Orgtree-Desktop-Token': 'operator'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'retained', 'ping',
          'legacy_defects', 'scope'}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/funding-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.funding-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {'credits.request', 'credits.reallocate', 'credits.decide'} \
            or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every funding contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # reads and instrumentation were specified from P02 rows (S2f); conflicts and wire stay open
        for name in ('conflicts', 'wire'):
            self.assertEqual(registry['facets']['funding.' + name]['status'], 'unresolved', name)
        for name in ('effects', 'reads', 'instrumentation'):
            self.assertEqual(registry['facets']['funding.' + name]['status'], 'specified', name)

    def test_decision_branches_are_mapped_once_the_batch_submit_is_contracted(self):
        # S3 decision 5: Org.resolve_batch (the inbox batch submit) also reaches
        # credit_request_action; P01 F3 contracted that entry (asks.batch-resolve), so
        # both branches are mapped to both callers
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        rows = {r['id'][:8]: r for r in registry['dispatch']}
        for wid in ('c590e76e', 'b62b2f45'):
            with self.subTest(witness=wid):
                self.assertEqual((rows[wid]['disposition'], rows[wid]['contracts']),
                                 ('mapped', ['asks.batch-resolve', 'credits.decide']))

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('credits.decide'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class FundingBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-funding-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top')
        org.hire(ledger.USER, 'top', 'haiku', 6, 'mid')
        org.hire(ledger.USER, 'mid', 'haiku', 2, 'kid')
        org.hire(ledger.USER, None, 'haiku', 5, 'top2')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN'] for n in ('top', 'mid', 'kid', 'top2')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))

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

    def agent(self, tool, args, actor, key=None, epoch=None):
        body = dict(org=self.slug, node=actor, tool=tool, args=args)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL, args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch))
        return self.client.post('/api/agent', json=body, headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def decide(self, body, headers=OP):
        return self.client.post(f'/api/orgs/{self.slug}/credit-requests', json=body, headers=headers)

    def act(self, request):
        for spy in (self.drive, self.notify, self.hub):
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after

    def refused(self, request, detail, code=422):
        r, changed, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])

    # -- credits.request -------------------------------------------------------
    def test_request_is_top_level_only_amends_and_withdraws(self):
        spec = self.spec
        r, changed, after = self.act(lambda: self.agent(RC, {'new_limit': 30, 'reason': 'more'}, 'top'))
        self.assertEqual((r.json()['requested'], r.json()['increase']), (30, 10))
        self.assertEqual((sorted(r.json()), changed), (spec['results']['request'], spec['sections']['request']))
        [req] = after['credit_requests']
        self.assertEqual((req['id'], req['old'], req['new'], req['status'], req['rev']), ('cr1', 20, 30, 'pending', 1))
        r, _, after = self.act(lambda: self.agent(RC, {'new_limit': 35.2, 'reason': 'even more'}, 'top'))
        self.assertIn('amended', r.json()['status'])
        [req] = after['credit_requests']
        self.assertEqual((req['new'], req['rev']), (36, 2))          # rounded UP to a whole credit, one row
        r, changed, after = self.act(lambda: self.agent(RC, {'new_limit': 20, 'reason': 'x'}, 'top'))
        self.assertEqual((sorted(r.json()), after['credit_requests'][0]['status']), (spec['results']['request_noop'], 'withdrawn'))
        r, changed, _ = self.act(lambda: self.agent(RC, {'new_limit': 5, 'reason': 'x'}, 'top2'))
        self.assertEqual((r.json(), changed), ({'status': 'your grant is already 5 — nothing to request'}, []))
        self.refused(lambda: self.agent(RC, {'new_limit': 40}, 'top2'), 'a reason is required')
        self.refused(lambda: self.agent(RC, {'new_limit': 'lots', 'reason': 'x'}, 'top2'), 'new_limit must be a number')
        self.refused(lambda: self.agent(RC, {'new_limit': 40, 'reason': 'x'}, 'mid'), 'only top-level agents')
        self.drive.assert_not_called()

    # -- credits.reallocate --------------------------------------------------
    def test_reallocate_is_downward_rounds_up_and_notifies(self):
        spec = self.spec
        r, changed, after = self.act(lambda: self.agent(RA, {'node': 'mid', 'delta': 2}, 'top'))
        self.assertEqual((r.json(), changed), ({'grant': 8, 'warnings': []}, spec['sections']['reallocate']))
        self.assertEqual(sorted(r.json()), spec['results']['reallocate'])
        noticed = {n for n, rows in after['notices'].items()
                   if any((x.get('ev') or {}).get('variant') == 'access.grant_changed' for x in rows)}
        self.assertEqual(noticed, {'mid'})                       # the parent is the caller, so only the target
        r, _, after = self.act(lambda: self.agent(RA, {'node': 'mid', 'delta': 0.3}, 'top'))
        self.assertEqual(after['nodes']['mid']['grant'], 9)       # +0.3 moved a whole credit
        r, changed, _ = self.act(lambda: self.agent(RA, {'node': 'mid', 'delta': 0}, 'top'))
        self.assertEqual((r.status_code, changed), (200, spec['sections']['reallocate_zero']))
        r, _, after = self.act(lambda: self.agent(RA, {'node': 'kid', 'delta': 1}, 'top'))
        self.assertEqual(after['nodes']['kid']['grant'], 3)
        self.refused(lambda: self.agent(RA, {'node': 'mid', 'delta': -100}, 'top'), 'unused; the rest is committed')
        self.refused(lambda: self.agent(RA, {'node': 'top', 'delta': 1}, 'mid'), 'mid has no authority over top')
        self.refused(lambda: self.agent(RA, {'node': 'mid', 'delta': 1}, 'mid'), 'mid has no authority over mid')
        self.refused(lambda: self.agent(RA, {'node': 'mid', 'delta': 'x'}, 'top'), 'delta must be a number')
        self.drive.assert_not_called()
        self.notify.assert_not_called()

    def test_keyed_receipts_retain_too_little(self):
        spec = self.spec
        epoch = self.agent(opreceipts.OP_EPOCH, {}, 'top').json()['epoch']
        for tool, args in ((RA, {'node': 'mid', 'delta': 1}), (RC, {'new_limit': 30, 'reason': 'k'})):
            with self.subTest(tool=tool):
                key = opreceipts.mint_key()
                self.assertEqual(self.agent(tool, args, 'top', key=key, epoch=epoch).status_code, 200)
                after = self.durable()
                [row] = [x for x in after[opreceipts.SECTION] if x.get('key') == key]
                self.assertEqual(sorted(row['result']), spec['retained'][tool])
                replay = self.agent(tool, args, 'top', key=key, epoch=epoch).json()
                self.assertTrue(replay['replayed'])
                self.assertEqual(self.durable(), after)

    # -- credits.decide --------------------------------------------------------
    def test_decision_counter_deny_moot_and_dry_run(self):
        spec = self.spec
        self.agent(RC, {'new_limit': 30, 'reason': 'more'}, 'top')
        r, changed, _ = self.act(lambda: self.decide({'id': 'cr1', 'action': 'approve', 'granted': 25, 'dry': True}))
        self.assertEqual((sorted(r.json()), changed), (spec['results']['dry'], []))
        self.refused(lambda: self.decide({'id': 'cr1', 'action': 'approve', 'dry': True}), 'dry run needs `granted`')
        self.refused(lambda: self.decide({'id': 'cr1', 'action': 'maybe'}), 'action must be approve|deny')
        agent = agentauth.child_env(self.slug, 'top')['ORGTREE_AGENT_TOKEN']
        self.assertEqual(self.decide({'id': 'cr1', 'action': 'approve'}, {'X-Orgtree-Agent-Token': agent}).status_code, 401)
        r, changed, after = self.act(lambda: self.decide({'id': 'cr1', 'action': 'approve', 'granted': 25}))
        self.assertEqual((r.json()['status'], r.json()['granted'], changed), ('answered', 25, spec['sections']['decide_grant']))
        self.assertNotIn('ev', r.json())
        self.assertEqual(after['nodes']['top']['grant'], 25)
        row = after['mail']['top'][-1]
        self.assertEqual((row['from'], row['ev']['variant'], row['ev']['outcome']), (ledger.USER, 'decision.credit', 'counter'))
        self.notify.assert_called_once_with(self.slug, ledger.USER, 'top')
        args, kwargs = self.drive.call_args
        self.assertEqual((args[1], kwargs['ping_reason']), ('top', spec['ping']['ping_reason']))
        self.refused(lambda: self.decide({'id': 'cr1', 'action': 'approve'}), "no pending credit request 'cr1'")
        self.agent(RC, {'new_limit': 9, 'reason': 'x'}, 'top2')
        r, changed, after = self.act(lambda: self.decide({'id': 'cr2', 'action': 'deny'}))
        self.assertEqual((r.json()['status'], changed, after['nodes']['top2']['grant']), ('denied', spec['sections']['decide_deny'], 5))
        self.agent(RC, {'new_limit': 8, 'reason': 'x'}, 'top2')
        with store.write_org(self.slug) as org:
            org.node('top2')['state'] = 'archived'
            store.save_org(org)
        r, changed, _ = self.act(lambda: self.decide({'id': 'cr3', 'action': 'approve'}))
        self.assertEqual((r.json()['status'], changed), ('moot', spec['sections']['decide_moot']))
        self.drive.assert_not_called()
        self.hub.assert_called_once_with(self.slug)


if __name__ == '__main__':
    unittest.main()
