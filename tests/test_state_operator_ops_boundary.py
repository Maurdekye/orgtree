"""P01 S3 legacy boundary contracts for the operator ops door's hire and reallocate.

Disposable SQLite only; the app's lifecycle is not started. The provider gate
(machine state), turn delivery, the UI spark and the tree broadcast are patched; the
desktop token gate, the ops handler, the ledger, save and reload are real. Each test
pins a fact stated in docs/state-system/operation-contracts.json (operator-ops.*)
against docs/state-system/operator-ops-boundary.json.
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

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-operator-ops-boundary-')
_data = Path(_temp) / 'data'
_home = Path(_temp) / 'home'
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

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'legacy_defects', 'scope'}
NAMES = {'operator.hire', 'operator.reallocate'}


def ops_entry(registry):
    [row] = [r for r in registry['entries'] if r['id'].startswith('58c040d3')]
    return row


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/operator-ops-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.operator-ops-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every operator ops contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # reads and instrumentation were specified from P02 rows (S2h); conflicts and wire stay open
        for name in ('conflicts', 'wire'):
            self.assertEqual(registry['facets']['operator-ops.' + name]['status'], 'unresolved', name)
        for name in ('reads', 'instrumentation'):
            self.assertEqual(registry['facets']['operator-ops.' + name]['status'], 'specified', name)
        # the route stays pending: its other ops are uncontracted
        row = ops_entry(registry)
        self.assertEqual((row['disposition'], row['contracts']), ('pending', []))
        self.assertIn('rename', row['reason'])

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('operator.reallocate'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_selectors_split_the_ops_and_exclude_the_preview(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        ops = ops_entry(registry)['id']
        cases = [({'op': 'hire'}, ['operator.hire']), ({'op': 'hire', 'preview': True}, ['operator.hire']),
                 ({'op': 'reallocate', 'delta': 1}, ['operator.reallocate']),
                 ({'op': 'reallocate', 'preview': False}, ['operator.reallocate']),
                 ({'op': 'reallocate', 'preview': True}, []), ({'op': 'retire'}, []), ({}, [])]
        for args, want in cases:
            with self.subTest(args=args):
                self.assertEqual(contracts.select(registry, ops, args), want)

    def test_dropping_the_preview_exclusion_is_caught(self):
        # negative control: without the conjunction the write contract claims the read preview
        registry = copy.deepcopy(contracts.load(ROOT / 'docs/state-system/operation-contracts.json'))
        registry['contracts']['operator.reallocate']['when'] = {'equals': {'key': 'op', 'value': 'reallocate'}}
        ops = ops_entry(registry)['id']
        self.assertEqual(contracts.select(registry, ops, {'op': 'reallocate', 'preview': True}), ['operator.reallocate'])


class OperatorOpsBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-operator-ops-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 6, 'mid', add_dirs=[], tools=NO_TOOLS, org_visibility='team', charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.agent_token = agentauth.child_env(self.slug, 'top')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.enterContext(patch.object(api, 'provider_hire_gate', lambda *a, **k: None))
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
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

    def op(self, body, headers=OP):
        return lambda: self.client.post(f'/api/orgs/{self.slug}/ops', json=body, headers=headers)

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
        self.assertEqual((changed, self.hub.call_count), ([], 0))
        self.drive.assert_not_called()

    def quiet(self):
        """The operator door drives nobody and sparks nothing; it broadcasts once."""
        self.assertEqual((self.drive.call_count, self.notify.call_count, self.hub.call_count), (0, 0, 1))

    # -- operator.hire -----------------------------------------------------------
    def test_user_hire_at_top_level_and_under_a_parent(self):
        spec = self.spec
        r, changed, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 't2', 'grant': 3}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), changed), (spec['results']['hire'], spec['sections']['hire']))
        self.assertEqual((after['nodes']['t2']['parent'], after['nodes']['t2']['grant']), (None, 3))
        self.quiet()
        # below the top level the user's hire takes the parent's scope, clamped leniently with warnings
        r, _, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'u1', 'parent': 'mid', 'charter': 'x'}))
        self.assertEqual((r.status_code, after['nodes']['u1']['parent']), (200, 'mid'))
        self.assertEqual(after['nodes']['u1']['scope']['tools'], NO_TOOLS)
        self.assertTrue(any('clamped' in w for w in r.json()['warnings']))
        told = [x for x in after['notices'].get('mid', []) if (x.get('ev') or {}).get('variant') == 'lifecycle.hired']
        self.assertTrue(told, 'the parent is told')
        # effort rides the same save
        r, _, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'e1', 'parent': 'mid', 'effort': 'low'}))
        self.assertEqual(after['nodes']['e1']['scope'].get('effort'), 'low')
        # no receipt on this door: the same hire again seats a second agent
        r, _, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 't2'}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotEqual(r.json()['node'], 't2')
        self.assertIn(r.json()['node'], after['nodes'])

    def test_hire_above_takes_the_anchor_scope(self):
        spec = self.spec
        r, changed, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'boss', 'parent': 'top',
                                              'above': 'mid', 'charter': 'x', 'tools': {**NO_TOOLS, 'bash': True}}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()), spec['results']['hire_above'])
        self.assertEqual((r.json()['inserted_above'], r.json()['reports_to'], r.json()['scope_from_anchor']), ('mid', 'top', 'mid'))
        self.assertEqual((after['nodes']['boss']['parent'], after['nodes']['mid']['parent']), ('top', 'boss'))
        self.assertEqual(after['nodes']['boss']['scope']['tools'], NO_TOOLS)          # the sent tools were dropped
        self.assertTrue(any('was NOT applied' in w for w in r.json()['warnings']))
        self.assertEqual(changed, spec['sections']['hire'])
        self.quiet()
        self.refused(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'x', 'parent': None, 'above': 'mid'}),
                     'insert-superior: mid does not report to the top level')

    def test_hire_refusals_write_nothing(self):
        self.refused(self.op({'op': 'hire', 'tier': 'haiku'}), 'hire needs tier and name')
        self.refused(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'p', 'preview': True}),
                     "preview does not support operator operation 'hire'")
        self.refused(self.op({'op': 'hire', 'tier': 'nope', 'name': 'x'}), "unknown tier 'nope'")
        self.refused(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'x'}, headers={'X-Orgtree-Agent-Token': self.agent_token}),
                     'agent credential is invalid or expired', code=401)
        # an agent named as the actor gets that agent's rules, not the user's defaults
        self.refused(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'x', 'actor': 'mid', 'parent': 'mid'}),
                     'agent hires have no defaults')

    def test_kiosk_visitors_reach_hire_and_reallocate_as_sent(self):
        # the 6b reviewer's note: the public-gateway path, pinned (S3 candidate 7a)
        with store.write_org(self.slug) as org:
            org.d['kiosk'] = {'enabled': True, 'token': 'kioskOPS123',
                              'max_scope': {**org.default_kiosk_ceiling(), 'org_visibility': 'team'}}
            store.save_org(org)
        api._token_cache['at'] = 0.0
        public = TestClient(api.PublicGateway(api.app), raise_server_exceptions=False)
        self.addCleanup(public.close)
        visit = lambda body: lambda: public.post(f'/k/kioskOPS123/api/orgs/{self.slug}/ops', json=body)  # noqa: E731
        # the admin gets the ceiling bridge offer; a visitor's is stripped and its raise_ceiling ignored
        r, _, after = self.act(self.op({'op': 'hire', 'tier': 'haiku', 'name': 'adm'}))
        self.assertEqual((r.json().get('bridge'), after['nodes']['adm']['scope']['org_visibility']),
                         ({'raise_ceiling': True}, 'team'))
        r, _, after = self.act(visit({'op': 'hire', 'tier': 'haiku', 'name': 'vis', 'raise_ceiling': True}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn('bridge', r.json())
        self.assertEqual(after['nodes']['vis']['scope']['org_visibility'], 'team')
        self.quiet()
        r, _, after = self.act(visit({'op': 'reallocate', 'node': 'mid', 'delta': 1}))
        self.assertEqual((r.status_code, after['nodes']['mid']['grant']), (200, 7))
        self.refused(visit({'op': 'reallocate', 'node': 'mid', 'delta': 1, 'preview': True}),
                     'kiosk: operator previews are available from the admin side', code=403)

    # -- operator.reallocate -------------------------------------------------------
    def test_user_reallocate_rounds_up_and_notifies(self):
        spec = self.spec
        r, changed, after = self.act(self.op({'op': 'reallocate', 'node': 'mid', 'delta': 2}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((sorted(r.json()), r.json()['grant'], changed),
                         (spec['results']['reallocate'], 8, spec['sections']['reallocate']))
        self.quiet()
        r, _, after = self.act(self.op({'op': 'reallocate', 'node': 'mid', 'delta': 0.5}))
        self.assertEqual(after['nodes']['mid']['grant'], 9)                   # +0.5 moved a whole credit
        r, _, after = self.act(self.op({'op': 'reallocate', 'node': 'top', 'delta': 1}))
        self.assertEqual(after['nodes']['top']['grant'], 21)                  # the user's pool tops a top-level seat

    def test_reallocate_refusals_and_the_preview_read(self):
        spec = self.spec
        self.refused(self.op({'op': 'reallocate', 'node': 'mid'}), 'reallocate needs delta')
        self.refused(self.op({'op': 'reallocate', 'node': 'mid', 'delta': -100}), 'mid has only 6 unused; the rest is committed')
        self.refused(self.op({'op': 'reallocate', 'node': 'top', 'delta': 1, 'actor': 'mid'}), 'mid has no authority over top')
        # preview is a different, read-only operation: nothing written, nothing broadcast
        r, changed, _ = self.act(self.op({'op': 'reallocate', 'node': 'mid', 'delta': 1, 'preview': True}))
        self.assertEqual((r.status_code, r.json()['applied'], changed, self.hub.call_count), (200, False, [], 0))
        self.assertEqual(sorted(r.json()), spec['results']['preview'])


if __name__ == '__main__':
    unittest.main()
