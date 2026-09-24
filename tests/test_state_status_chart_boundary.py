"""P01 S3 legacy public-boundary contracts for orgtree_status and orgtree_chart.

Disposable SQLite only. The app's lifecycle is not started. Turn delivery,
the UI mail spark and the tree broadcast are replaced with spies; the door's
authentication, admission, the write cycle, save and reload are real. Each test
pins a fact stated in docs/state-system/operation-contracts.json (status.* and
chart.* facets) against docs/state-system/status-chart-boundary.json.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-status-chart-boundary-')
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

FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'tools', 'status', 'chart', 'legacy_defects', 'scope'}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any API case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/status-chart-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.status-chart-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if d['tools'] != {'orgtree_status': 'status.report', 'orgtree_chart': 'chart.read'}:
        raise ValueError('tool/contract binding')
    for tool, name in d['tools'].items():
        if registry['contracts'].get(name, {}).get('tools') != [tool]:
            raise ValueError('registry does not bind ' + name)
    if set(d['chart']['visibility']) != {'self', 'team', 'subtree', 'full'}:
        raise ValueError('every visibility level is required')
    if set(d['status']['results']) != {'plain', 'reported', 'top_level'}:
        raise ValueError('every status result shape is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(result['qualification'], contracts.GATES)
        # the status and chart facets P01 could not close carry an owner line
        # conflicts and wire stay with the native stages; reads, instrumentation and the
        # chart's cold/migration writes were specified from P02 rows (S2d)
        for name in ('conflicts', 'wire'):
            for family in ('status', 'chart'):
                self.assertEqual(registry['facets'][f'{family}.{name}']['status'], 'unresolved')
        for name in ('status.reads', 'status.instrumentation', 'chart.reads', 'chart.writes', 'chart.instrumentation'):
            self.assertEqual(registry['facets'][name]['status'], 'specified', name)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        mutations = [lambda d: d['chart']['visibility'].pop('self'),
                     lambda d: d['status']['results'].pop('top_level'),
                     lambda d: d['tools'].update(orgtree_status='chart.read'),
                     lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]
        for edit in mutations:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class _Door(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-status-chart-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 10, 'boss')
        org.hire(ledger.USER, 'boss', 'haiku', 4, 'worker')
        org.hire(ledger.USER, 'boss', 'haiku', 0, 'sib')
        org.hire(ledger.USER, 'worker', 'haiku', 0, 'deep')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('boss', 'worker', 'sib', 'deep')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def call(self, tool, args, *, actor='worker', key=None, epoch=None):
        body = dict(org=self.slug, node=actor, tool=tool, args=args)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL, args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch))
        return self.client.post('/api/agent', json=body, headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def okay(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def fresh_key(self):
        return opreceipts.mint_key(), self.okay(self.call(opreceipts.OP_EPOCH, {}))['epoch']

    def durable(self):
        """The committed document, read cold (resident copy evicted)."""
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    @staticmethod
    def node_fields(before, after):
        return sorted((n, f) for n in after['nodes'] for f in set(after['nodes'][n]) | set(before['nodes'].get(n, {}))
                      if after['nodes'][n].get(f) != before['nodes'].get(n, {}).get(f))

    def edit(self, fn):
        with store.write_org(self.slug) as org:
            fn(org)
            store.save_org(org)

    def quiet(self):
        self.drive.assert_not_called()
        self.notify.assert_not_called()
        self.hub.assert_not_called()


class StatusBoundary(_Door):
    def status(self, args, **kw):
        return self.call('orgtree_status', args, **kw)

    def test_non_reporting_values_write_only_the_callers_node_row(self):
        spec = self.spec['status']
        cases = [({'status': 'working', 'summary': 's'}, 'working', 's'),
                 ({'status': 'idle', 'summary': 'i'}, 'idle', 'i'),
                 ({}, spec['default'], ''),
                 ({'status': None, 'summary': None}, spec['default'], ''),
                 ({'status': 5, 'summary': 7}, '5', '7')]
        cases += [({'status': v, 'summary': 'u'}, v, 'u') for v in spec['unvalidated_examples'] if v != '5']
        for args, stored, summary in cases:
            with self.subTest(args=args):
                self.hub.reset_mock()
                before = self.durable()
                result = self.okay(self.status(args))
                after = self.durable()
                self.assertEqual(result, {'recorded': stored})
                self.assertEqual(sorted(result), spec['results']['plain'])
                self.assertEqual(self.changed(before, after), ['nodes'])
                touched = {n for n, _ in self.node_fields(before, after)}
                self.assertEqual(touched, {'worker'})
                row = after['nodes']['worker']
                self.assertEqual((row['last_status']['status'], row['last_status']['summary']), (stored, summary))
                # exactly 'working' anchors the activity clock; everything else drops it
                self.assertEqual('working_activity_at' in row, stored == spec['activity_value'])
                self.drive.assert_not_called()
                self.notify.assert_not_called()
                self.hub.assert_called_once_with(self.slug)

    def test_done_and_blocked_report_once_to_the_parent_and_nowhere_else(self):
        spec = self.spec['status']
        for state in spec['reporting']:
            with self.subTest(state=state):
                self.drive.reset_mock(); self.notify.reset_mock(); self.hub.reset_mock()
                before = self.durable()
                result = self.okay(self.status({'status': state, 'summary': 'finished'}))
                after = self.durable()
                self.assertEqual(sorted(result), sorted(spec['results']['reported']))
                self.assertEqual((result['recorded'], result['reported_to'], result['delivered'], result['warnings']),
                                 (state, 'boss', 'boss', []))
                self.assertEqual(result['ref'], f"@mail:{self.slug}/node/boss/{result['id']}")
                self.assertEqual(self.changed(before, after), spec['report_sections'])
                self.assertEqual({n for n, _ in self.node_fields(before, after)}, {'worker', 'boss'})
                self.assertTrue({f for n, f in self.node_fields(before, after) if n == 'boss'} <= {'mail_seq', 'mailbox_id'})
                self.assertEqual(after['nodes']['worker']['last_status']['status'], spec['stored_as'].get(state, state))
                [mail] = after['mail']['boss'][len(before['mail'].get('boss', [])):]
                self.assertEqual((mail['id'], mail['from'], mail['kind']), (result['id'], 'worker', spec['mail']['kind']))
                self.assertEqual(mail['body'], spec['mail']['prefix'][state] + 'finished')
                self.assertEqual((mail['ev']['variant'], mail['ev']['state'], mail['ev']['summary']),
                                 (spec['mail']['variant'], state, 'finished'))
                self.assertEqual(after['mail_log']['boss'][-1]['id'], mail['id'])
                [event] = after['events'][len(before['events']):]
                self.assertEqual((event['op'], event['actor'], event['detail']['to'], event['detail']['kind']),
                                 ('mail', 'worker', 'boss', 'status'))
                [life] = after['lifecycle'][len(before.get('lifecycle', [])):]
                self.assertEqual((life['state'], life['delivery'], life['recipient'], life['sender']),
                                 ('accepted', 'mailbox', 'boss', 'worker'))
                self.assertEqual(after['audiences'], [])       # the superior needs no grant
                self.notify.assert_called_once_with(self.slug, 'worker', 'boss')
                self.drive.assert_called_once()
                args, kwargs = self.drive.call_args
                self.assertEqual(args[:2], (self.slug, 'boss'))
                self.assertEqual((kwargs['mail_ping'], kwargs['sender'], kwargs['ping_reason']), (True, 'worker', None))
                self.hub.assert_called_once_with(self.slug)

    def test_top_level_report_posts_no_mail(self):
        spec = self.spec['status']
        before = self.durable()
        result = self.okay(self.status({'status': 'done', 'summary': 'top'}, actor='boss'))
        after = self.durable()
        self.assertEqual(result, {'recorded': 'done', 'reported_to': spec['top_level_reported_to']})
        self.assertEqual(sorted(result), sorted(spec['results']['top_level']))
        self.assertEqual(self.changed(before, after), ['nodes'])
        self.assertEqual(after['nodes']['boss']['last_status']['status'], 'idle')
        self.drive.assert_not_called()
        self.notify.assert_not_called()

    def test_a_node_argument_cannot_redirect_the_report(self):
        before = self.durable()
        self.okay(self.status({'status': 'blocked', 'summary': 'x', 'node': 'sib', 'to': 'deep'}))
        after = self.durable()
        self.assertEqual({n for n, _ in self.node_fields(before, after)}, {'worker', 'boss'})
        self.assertEqual(after['nodes']['sib'], before['nodes']['sib'])
        self.assertEqual(sorted(after['mail']), ['boss'])

    def test_summary_is_stored_and_mailed_without_a_cap(self):
        text = 'y' * 100000
        self.okay(self.status({'status': 'done', 'summary': text}))
        after = self.durable()
        self.assertEqual(after['nodes']['worker']['last_status']['summary'], text)
        self.assertEqual(after['mail']['boss'][-1]['body'], '[DONE] ' + text)

    def test_refusals_commit_and_signal_nothing(self):
        before = self.durable()
        response = self.status({'status': ['done'], 'summary': 'x'})
        self.assertEqual((response.status_code, response.json()), (422, {'detail': 'status must be text, not list'}))
        self.assertEqual(self.durable(), before)
        self.edit(lambda org: org.node('sib').update(halt={'at': 'fixture'}))
        before = self.durable()
        response = self.status({'status': 'done', 'summary': 'x'}, actor='sib')
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.durable(), before)
        self.edit(lambda org: org.node('deep').update(state='archived'))
        mid = self.durable()
        response = self.status({'status': 'done', 'summary': 'x'}, actor='deep')
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.durable(), mid)
        self.assertEqual(self.changed(before, mid), ['nodes'])     # only the fixture's own archive edit
        self.quiet()

    def test_keyed_report_files_its_receipt_with_the_effect_and_replays_without_effects(self):
        spec = self.spec['status']
        key, epoch = self.fresh_key()
        before = self.durable()
        first = self.okay(self.status({'status': 'done', 'summary': 'k'}, key=key, epoch=epoch))
        after = self.durable()
        self.assertEqual(self.changed(before, after),
                         sorted(spec['report_sections'] + [opreceipts.SECTION, opreceipts.META]))
        [row] = [r for r in after[opreceipts.SECTION] if r.get('key') == key]
        self.assertEqual((row['tool'], row['outcome']), ('orgtree_status', 'applied'))
        self.assertEqual(sorted(row['result']), sorted(spec['retained']))
        self.assertEqual(row['result']['delivered'], first['delivered'])
        self.drive.reset_mock(); self.notify.reset_mock(); self.hub.reset_mock()
        replay = self.okay(self.status({'status': 'done', 'summary': 'k'}, key=key, epoch=epoch))
        self.assertEqual(sorted(replay), sorted(spec['replay']))
        self.assertTrue(replay['replayed'])
        self.assertEqual(self.durable(), after)
        self.quiet()


class ChartBoundary(_Door):
    def chart(self, args=None, **kw):
        return self.call('orgtree_chart', args or {}, **kw)

    def test_chart_is_one_text_field_that_writes_and_signals_nothing_even_when_keyed(self):
        before = self.durable()
        result = self.okay(self.chart())
        self.assertEqual(sorted(result), self.spec['chart']['result'])
        self.assertIsInstance(result['chart'], str)
        self.assertIn('[ORG STATE', result['chart'])
        key, epoch = self.fresh_key()
        self.okay(self.chart(key=key, epoch=epoch))
        self.okay(self.chart(key=key, epoch=epoch))     # NONE class: re-executes, never replays
        self.assertEqual(self.durable(), before)
        self.quiet()

    def test_each_visibility_level_discloses_exactly_its_sections(self):
        for level, marks in self.spec['chart']['visibility'].items():
            with self.subTest(level=level):
                self.edit(lambda org: org.node('worker')['scope'].update(org_visibility=level))
                text = self.okay(self.chart())['chart']
                for mark in marks['present']:
                    self.assertIn(mark, text)
                for mark in marks['absent']:
                    self.assertNotIn(mark, text)
                self.assertEqual('Your superior: boss' in text, level != 'self')

    def test_self_visibility_still_names_the_superior_in_the_claude_md_caveat(self):
        # recorded legacy defect (S2d correction of chart.authority): the identity prompt says the
        # superior is not disclosed, and the live guidance in the same answer names it
        self.edit(lambda org: org.node('worker')['scope'].update(org_visibility='self'))
        text = self.okay(self.chart())['chart']
        self.assertIn('its identity is not disclosed to you', text)
        self.assertIn('as directed at your direct superior (boss) instead', text)
        self.assertEqual(text.count('boss'), 1)

    def test_missing_visibility_is_backfilled_as_full_before_the_chart_reads_it(self):
        self.edit(lambda org: org.node('worker')['scope'].pop('org_visibility'))
        text = self.okay(self.chart())['chart']
        for mark in self.spec['chart']['visibility']['full']['present']:
            self.assertIn(mark, text)

    def test_standing_charters_default_on_only_when_the_key_is_absent(self):
        def charters(org):
            org.node('boss')['team_charter'] = 'BOSS-TEAM-RULE'
            org.node('worker')['team_charter'] = 'WORKER-TEAM-RULE'
            org.node('worker')['charter'] = 'WORKER-OWN-ROLE'
        self.edit(charters)
        text = self.okay(self.chart())['chart']
        for mark in ('WORKER-OWN-ROLE', 'WORKER-TEAM-RULE', 'BOSS-TEAM-RULE'):
            self.assertIn(mark, text)
        for flag in self.spec['chart']['false_flags']:
            with self.subTest(flag=flag):
                text = self.okay(self.chart({'include_standing_charter': flag}))['chart']
                self.assertIn('WORKER-OWN-ROLE', text)          # the own charter is always included
                self.assertNotIn('WORKER-TEAM-RULE', text)
                self.assertNotIn('BOSS-TEAM-RULE', text)
        for flag in self.spec['chart']['true_flags']:
            with self.subTest(flag=flag):
                self.assertIn('BOSS-TEAM-RULE', self.okay(self.chart({'include_standing_charter': flag}))['chart'])

    def test_tail_carries_the_callers_credits(self):
        text = self.okay(self.chart())['chart']
        self.assertIn('Credits: seat ', text)
        self.assertIn(', grant 4, free ', text)

    def test_halted_caller_is_refused(self):
        self.edit(lambda org: org.node('worker').update(halt={'at': 'fixture'}))
        self.assertEqual(self.chart().status_code, 409)
        self.quiet()


if __name__ == '__main__':
    unittest.main()
