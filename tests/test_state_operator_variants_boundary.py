"""P01 F1b legacy boundary contracts for the operator ops door's remaining operations and its preview.

Disposable SQLite only; the app's lifecycle is not started. The provider gate, turn
delivery, the pre-archive interrupt, the remote reap, the transcript copy, forget and
the broadcasts are patched (spies); the desktop token gate, the ops handler, the
ledger, the preview, save and reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (operator-ops.*, the F1b clauses) against
docs/state-system/operator-variants-boundary.json.
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
_temp = tempfile.mkdtemp(prefix='p01-operator-variants-boundary-')
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
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'sections', 'told',
          'legacy_defects', 'scope'}
OPS = {'operator.rename': 'rename', 'operator.retire': 'retire', 'operator.rescind': 'rescind',
       'operator.cheap-compact': 'cheap_compact', 'operator.rehire': 'rehire', 'operator.dissolve': 'dissolve',
       'operator.delete': 'delete', 'operator.switch-model': 'switch_model', 'operator.promote': 'promote',
       'operator.demote': 'demote', 'operator.move': 'move', 'operator.reseed': 'reseed',
       'operator.revoke-dir': 'revoke_dir'}
NAMES = set(OPS) | {'operator.preview'}
# the successful call per contract, and the setup it needs (as recorded in the fixture)
CASES = {'operator.rename': (None, {'op': 'rename', 'node': 'leaf', 'name': 'leafy'}),
         'operator.retire': (None, {'op': 'retire', 'node': 'leaf'}),
         'operator.rescind': (None, {'op': 'rescind', 'node': 'leaf'}),
         'operator.cheap-compact': (None, {'op': 'cheap_compact', 'node': 'mid'}),
         'operator.rehire': ('retire_leaf', {'op': 'rehire', 'node': 'leaf'}),
         'operator.dissolve': (None, {'op': 'dissolve', 'node': 'mid'}),
         'operator.delete': (None, {'op': 'delete', 'node': 'leaf'}),
         'operator.switch-model': (None, {'op': 'switch_model', 'node': 'leaf', 'tier': 'sonnet'}),
         'operator.promote': (None, {'op': 'promote', 'node': 'leaf', 'new_parent': None}),
         'operator.demote': (None, {'op': 'demote', 'node': 'sib', 'new_parent': 'mid'}),
         'operator.move': (None, {'op': 'move', 'node': 'leaf', 'new_parent': 'sib'}),
         'operator.reseed': ('unrecoverable_mid', {'op': 'reseed', 'node': 'mid'}),
         'operator.revoke-dir': ('grant_dir', {'op': 'revoke_dir', 'node': 'mid', 'dir': 'C:/fixture-dir'}),
         'operator.preview': (None, {'op': 'retire', 'node': 'mid', 'preview': True})}


def ops_entry(registry):
    [row] = [r for r in registry['entries'] if r['id'].startswith('58c040d3')]
    return row


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(
        ROOT / 'docs/state-system/operator-variants-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.operator-variants-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every operator variant contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # the variants reuse the operator-ops facets except conflicts and instrumentation, which are their own
        # (the S3 conflicts schedules and the P02 rows cover hire and reallocate only)
        for name in NAMES:
            dims = registry['contracts'][name]['dimensions']
            self.assertEqual((dims['conflicts'], dims['instrumentation']),
                             (['operator-ops.variant-conflicts'], ['operator-ops.variant-instrumentation']))
            self.assertEqual({d for d, v in dims.items() if v[0].startswith('operator-ops.variant-')},
                             {'conflicts', 'instrumentation'})
        for name in ('variant-conflicts', 'wire'):
            self.assertEqual(registry['facets']['operator-ops.' + name]['status'], 'unresolved', name)
        # closed from P02's rows by the P01 F1/F1b follow-up (asserted in tests/test_state_p02_contact_facets.py)
        self.assertEqual(registry['facets']['operator-ops.variant-instrumentation']['status'], 'specified')
        # the door is mapped now that every op it dispatches is contracted
        row = ops_entry(registry)
        self.assertEqual((row['disposition'], row['contracts']),
                         ('mapped', sorted(NAMES | {'operator.hire', 'operator.reallocate'})))

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('operator.delete'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_each_op_selects_exactly_its_contract_and_previews_split_off(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        ops = ops_entry(registry)['id']
        for name, op in OPS.items():
            with self.subTest(op=op):
                self.assertEqual(contracts.select(registry, ops, {'op': op, 'node': 'x'}), [name])
                self.assertEqual(contracts.select(registry, ops, {'op': op, 'preview': False}), [name])
                # a preview of hire, rename, cheap_compact or rehire is refused inside its own contract
                want = [name] if op in ('rename', 'cheap_compact', 'rehire') else ['operator.preview']
                self.assertEqual(contracts.select(registry, ops, {'op': op, 'preview': True}), want)
        self.assertEqual(contracts.select(registry, ops, {'op': 'reallocate', 'preview': True}), ['operator.preview'])
        self.assertEqual(contracts.select(registry, ops, {'op': 'hire', 'preview': True}), ['operator.hire'])
        self.assertEqual(contracts.select(registry, ops, {}), [])

    def test_dropping_a_preview_exclusion_is_caught(self):
        # negative control: without the conjunction the write contract also claims the read preview
        registry = copy.deepcopy(contracts.load(ROOT / 'docs/state-system/operation-contracts.json'))
        registry['contracts']['operator.delete']['when'] = {'equals': {'key': 'op', 'value': 'delete'}}
        ops = ops_entry(registry)['id']
        self.assertEqual(sorted(contracts.select(registry, ops, {'op': 'delete', 'preview': True})),
                         ['operator.delete', 'operator.preview'])


class OperatorVariantsBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-operator-variants-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[], tools={}, charter='fixture')
        org.hire('top', 'top', 'haiku', 6, 'mid', **SCOPE)
        org.hire('top', 'mid', 'haiku', 2, 'leaf', **SCOPE)
        org.hire('top', 'top', 'haiku', 3, 'sib', **SCOPE)
        org.hire(ledger.USER, None, 'haiku', 5, 'top2', add_dirs=[], tools={}, charter='fixture')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.agent_token = agentauth.child_env(self.slug, 'top')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.enterContext(patch.object(api, 'provider_hire_gate', lambda *a, **k: None))
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.interrupt = self.enterContext(patch.object(api.supervisor, 'interrupt_before_archive', return_value=[]))
        self.reap = self.enterContext(patch.object(api.supervisor, 'remote_reap'))
        self.export = self.enterContext(patch.object(api.supervisor, 'export_predecessor_transcript'))
        self.forget = self.enterContext(patch.object(api.supervisor, 'forget'))
        self.notify = self.enterContext(patch.object(api.supervisor, 'notify'))
        self.spies = (self.drive, self.hub, self.interrupt, self.reap, self.export, self.forget, self.notify)

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

    @staticmethod
    def told(before, after):
        out = {}
        for n, rows in after.get('notices', {}).items():
            new = [x for x in rows if x not in before.get('notices', {}).get(n, [])]
            if new:
                out[n] = [[(x.get('ev') or {}).get('variant'),
                           (x.get('ev') or {}).get('relation') or (x.get('ev') or {}).get('role')] for x in new]
        return out

    def prepare(self, pre):
        org = store.load_org(self.slug)
        if pre in ('retire_leaf', 'retire_leaf_mail'):
            org.retire('mid', 'leaf')
            if pre == 'retire_leaf_mail':
                org.post_mail('mid', 'leaf', 'waiting work')
        elif pre == 'unrecoverable_mid':
            org.node('mid')['state'] = 'unrecoverable'
        elif pre == 'grant_dir':
            for n in ('mid', 'leaf'):
                org.node(n)['scope']['add_dirs'] = [{'path': 'C:/fixture-dir', 'mode': 'rw'}]
        store.save_org(org)

    def op(self, body, headers=OP):
        return lambda: self.client.post(f'/api/orgs/{self.slug}/ops', json=body, headers=headers)

    def act(self, request):
        for spy in self.spies:
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        return r, self.changed(before, after), after, self.told(before, after)

    def refused(self, body, detail, code=422, headers=OP):
        r, changed, _, _ = self.act(self.op(body, headers))
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        self.drive.assert_not_called()
        self.hub.assert_not_called()

    def test_moves_rewrite_the_seats_on_the_credit_path_up_to_the_common_ancestor(self):
        # P02 finding on this family (F1b), measured by P01 (follow-up item): ledger._move releases the moved stake
        # hop by hop from the old parent up to the lowest common ancestor and acquires it down to the new parent, so
        # it rewrites the grant of every seat strictly between them. A promotion's common ancestor is @user: the
        # WHOLE old chain up to the top-level seat is rewritten, and an ancestor above the old parent is told
        # nothing unless it is also a new peer. Here deep sits under leaf (top > mid > leaf > deep).
        def rows_and_told(body):
            self.doCleanups()
            self.setUp()
            org = store.load_org(self.slug)
            org.hire('top', 'leaf', 'haiku', 1, 'deep', **SCOPE)
            store.save_org(org)
            before = self.durable()
            r = self.op(body)()
            after = self.durable()
            self.assertEqual(r.status_code, 200, r.text)
            rows = {n: sorted(k for k in set(before['nodes'][n]) | set(v) if before['nodes'][n].get(k) != v.get(k))
                    for n, v in after['nodes'].items() if v != before['nodes'].get(n)}
            return rows, set(self.told(before, after))
        rows, told = rows_and_told({'op': 'promote', 'node': 'deep', 'new_parent': None})
        self.assertEqual(rows, {'deep': ['parent'], 'leaf': ['grant'], 'mid': ['grant'], 'top': ['grant']})
        self.assertEqual(told, {'deep', 'leaf', 'top', 'top2'})     # mid: written, told nothing
        rows, told = rows_and_told({'op': 'move', 'node': 'deep', 'new_parent': 'mid'})
        self.assertEqual(rows, {'deep': ['parent'], 'leaf': ['grant']})       # mid is the common ancestor
        rows, _ = rows_and_told({'op': 'move', 'node': 'leaf', 'new_parent': 'sib'})
        self.assertEqual(rows, {'leaf': ['parent'], 'mid': ['grant'], 'sib': ['grant']})    # not top
        rows, _ = rows_and_told({'op': 'demote', 'node': 'sib', 'new_parent': 'mid'})
        self.assertEqual(rows, {'sib': ['parent'], 'mid': ['grant']})       # top, the old parent, is the ancestor

    def test_every_operation_writes_its_fixtured_sections_and_tells_its_fixtured_nodes(self):
        for name, (pre, body) in CASES.items():
            with self.subTest(contract=name):
                self.doCleanups()
                self.setUp()
                if pre:
                    self.prepare(pre)
                r, changed, after, told = self.act(self.op(body))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(sorted(r.json()), self.spec['results'][name])
                self.assertEqual(changed, self.spec['sections'][name])
                self.assertEqual(told, self.spec['told'][name])
                # the operator door files no receipt for any of them
                self.assertNotIn('op_receipts', changed)
                self.assertEqual(self.hub.call_count, 0 if name == 'operator.preview' else 1)

    def test_rename_reaps_broadcasts_and_notifies(self):
        r, _, after, _ = self.act(self.op({'op': 'rename', 'node': 'leaf', 'name': 'leafy'}))
        self.assertEqual(r.json()['node'], 'leafy')
        self.assertEqual((self.reap.call_count, self.hub.call_count), (1, 1))
        self.assertEqual([c.args[1:3] for c in self.notify.call_args_list], [('leafy', 'renamed')])

    def test_archiving_operations_interrupt_first_and_delete_does_not(self):
        for body, target in (({'op': 'retire', 'node': 'leaf'}, 'leaf'), ({'op': 'dissolve', 'node': 'mid'}, 'mid'),
                             ({'op': 'rescind', 'node': 'sib'}, 'sib')):
            with self.subTest(op=body['op']):
                self.act(self.op(body))
                self.assertEqual([c.args[2] for c in self.interrupt.call_args_list], [target])
                self.assertEqual(self.reap.call_count, 1)
        r, _, _, _ = self.act(self.op({'op': 'delete', 'node': 'top2'}))
        self.assertEqual(r.status_code, 200, r.text)
        self.interrupt.assert_not_called()
        self.assertEqual([sorted(c.args[1]) for c in self.forget.call_args_list], [['top2']])
        self.assertEqual(self.reap.call_count, 1)

    def test_refused_after_the_interrupt(self):
        # the agent door's recorded legacy defect holds on this door too
        self.refused({'op': 'rescind', 'node': 'leaf', 'actor': 'mid'}, 'only the user may rescind')
        self.assertEqual([c.args[2] for c in self.interrupt.call_args_list], ['leaf'])
        self.refused({'op': 'retire', 'node': 'mid', 'actor': 'mid'}, 'you have live reports')
        self.assertEqual([c.args[2] for c in self.interrupt.call_args_list], ['mid'])
        # the pre-guard alone refuses before it
        self.refused({'op': 'retire', 'node': 'mid', 'actor': 'leaf'}, 'leaf has no authority over mid')
        self.interrupt.assert_not_called()

    def test_rehire_with_waiting_mail_is_driven_with_its_own_wording(self):
        self.prepare('retire_leaf_mail')
        r, _, _, _ = self.act(self.op({'op': 'rehire', 'node': 'leaf'}))
        self.assertEqual(r.status_code, 200, r.text)
        [call] = self.drive.call_args_list
        self.assertEqual((call.args[1], call.kwargs.get('mail_ping'), call.kwargs.get('ping_reason')),
                         ('leaf', True, 'rehire_waited'))
        self.assertIn('Mail above arrived while you were archived', call.args[2])

    def test_no_ops_and_previews(self):
        r, changed, _, _ = self.act(self.op({'op': 'reseed', 'node': 'mid'}))
        self.assertEqual((r.status_code, changed, self.hub.call_count), (200, [], 1))
        self.assertIn('nothing to re-seed', r.json()['warnings'][0])
        for body in ({'op': 'delete', 'node': 'leaf', 'preview': True},
                     {'op': 'reallocate', 'node': 'mid', 'delta': 1, 'preview': True},
                     {'op': 'switch_model', 'node': 'leaf', 'tier': 'sonnet', 'preview': True},
                     {'op': 'retire', 'node': 'leaf', 'preview': True, 'actor': 'mid'}):
            with self.subTest(body=body):
                r, changed, _, _ = self.act(self.op(body))
                self.assertEqual((r.status_code, r.json()['applied'], changed, self.hub.call_count),
                                 (200, False, [], 0), r.text)

    def test_refusals_write_nothing(self):
        self.refused({'op': 'rename', 'node': 'leaf'}, 'rename needs node and name')
        self.refused({'op': 'rename', 'node': 'leaf', 'name': 'sib'}, "the name 'sib' is already taken")
        self.refused({'op': 'rename', 'node': 'top', 'name': 'x', 'actor': 'mid'}, 'mid has no authority over top')
        self.refused({'op': 'delete', 'node': 'leaf', 'actor': 'mid'}, 'only the user may delete agents')
        self.refused({'op': 'switch_model', 'node': 'leaf'}, 'switch_model needs tier')
        self.refused({'op': 'promote', 'node': 'leaf', 'new_parent': None, 'actor': 'top'},
                     'only the user promotes agents to top level')
        self.refused({'op': 'demote', 'node': 'sib'}, 'demote needs new_parent')
        self.refused({'op': 'revoke_dir', 'node': 'mid'}, 'revoke_dir needs dir')
        self.refused({'op': 'frobnicate', 'node': 'mid'}, "unknown op 'frobnicate'")
        self.refused({'op': 'rename', 'node': 'leaf', 'name': 'x', 'preview': True},
                     "preview does not support operator operation 'rename'")
        self.refused({'op': 'rehire', 'node': 'leaf', 'preview': True},
                     "preview does not support operator operation 'rehire'")
        self.refused({'op': 'retire', 'node': 'leaf'}, 'agent credential is invalid or expired', code=401,
                     headers={'X-Orgtree-Agent-Token': self.agent_token})
        self.prepare('retire_leaf')
        self.refused({'op': 'cheap_compact', 'node': 'leaf'}, "replaces a LIVE agent's session")


if __name__ == '__main__':
    unittest.main()
