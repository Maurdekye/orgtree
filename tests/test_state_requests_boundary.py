"""P01 F3 legacy boundary contracts for asks, reports, scope requests, watchdogs and audiences.

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, the watchdog
smoke run and the broadcasts are patched (spies); the agent door, the operator routes,
the ledger, the receipts, save and reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (asks.*, watchdogs.*, audiences.* and the
lifecycle.operator-scope clauses) against docs/state-system/requests-boundary.json.
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
_temp = tempfile.mkdtemp(prefix='p01-requests-boundary-')
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
from orgtree import agentauth, api, ledger, opreceipts, store  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'case_of', 'receipts',
          'legacy_defects', 'scope'}
FAMILIES = ('asks.', 'watchdogs.', 'audiences.')
OPTIONS = [{'label': 'yes', 'description': 'go'}, {'label': 'no', 'description': 'stop'}]
DOG = {'action': 'create', 'name': 'd1', 'kind': 'file', 'target': 'notes.txt', 'pattern': 'done', 'interval_s': 60}


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/requests-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.requests-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    names = {k for k in registry['contracts'] if k.startswith(FAMILIES)} | {'lifecycle.operator-scope'}
    if set(d['contracts']) != names or set(d['case_of']) != names:
        raise ValueError('every F3 contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 22)
        for fam in ('asks', 'watchdogs', 'audiences'):
            for d in contracts.DIMENSIONS:
                # instrumentation: asks and audiences closed, watchdogs narrowed to the smoke run, from P02's rows
                # (P01 F3/F2 instrumentation follow-up; asserted in tests/test_state_p02_contact_facets.py)
                open_dims = ('conflicts', 'wire') + (('instrumentation',) if fam == 'watchdogs' else ())
                want = 'unresolved' if d in open_dims else 'specified'
                self.assertEqual(registry['facets'][fam + '.' + d]['status'], want, fam + '.' + d)
        # the operator scope route joins lifecycle.* (a retool by the operator)
        self.assertEqual(registry['contracts']['lifecycle.operator-scope']['dimensions'],
                         {d: ['lifecycle.' + d] for d in contracts.DIMENSIONS})

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('watchdogs.create'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_per_action_selectors(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        for tool, fam, acts in (('orgtree_watchdog', 'watchdogs', ('create', 'list', 'pause', 'resume', 'remove',
                                                                  'supersede')),
                                ('orgtree_audience', 'audiences', ('request', 'forward', 'grant', 'deny', 'revoke'))):
            [card] = {e for n, c in registry['contracts'].items() if tool in c['tools'] for e in c['entry_ids']}
            for act in acts:
                with self.subTest(tool=tool, action=act):
                    self.assertEqual(contracts.select(registry, card, {'action': act}), [fam + '.' + act])
            self.assertEqual(contracts.select(registry, card, {'action': 'nope'}), [])
        # an omitted watchdog action normalises to '' and selects nothing, as the door refuses it
        [card] = {e for c in registry['contracts'].values() if 'orgtree_watchdog' in c['tools'] for e in c['entry_ids']}
        self.assertEqual(contracts.select(registry, card, {}), [])


class RequestsBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-requests-{self.seq}')
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
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('top', 'mid', 'leaf', 'sib', 'top2')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.smoke = self.enterContext(patch.object(api.supervisor, 'wd_smoke', return_value={'ok': True}))
        self.live_effort = self.enterContext(patch.object(api.supervisor, 'send_live_effort', return_value='sent'))
        self.spies = (self.drive, self.notify, self.hub, self.smoke, self.live_effort)
        self.ids = {}

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def fresh(self):
        self.doCleanups()
        self.setUp()

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    @staticmethod
    def new_rows(before, after, section, fields):
        out = {}
        for n, rows in after.get(section, {}).items():
            new = [x for x in rows if x not in before.get(section, {}).get(n, [])]
            if new:
                out[n] = [[f(x) for f in fields] for x in new]
        return out

    def agent(self, tool, args, actor):
        return lambda: self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=tool, args=args),
                                        headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def keyed(self, tool, args, actor):
        key = opreceipts.mint_key()

        def go():
            head = {'X-Orgtree-Agent-Token': self.tokens[actor]}
            epoch = self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=opreceipts.OP_EPOCH,
                                                             args={}), headers=head).json()['epoch']
            return self.client.post('/api/agent', json=dict(
                org=self.slug, node=actor, tool=opreceipts.OP_CALL,
                args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch)), headers=head)
        return go

    def route(self, method, path, body=None):
        return lambda: self.client.request(method, path.format(slug=self.slug, **self.ids), json=body, headers=OP)

    def act(self, request):
        for spy in self.spies:
            spy.reset_mock()
        before = self.durable()
        r = request()
        after = self.durable()
        ev = lambda x: (x.get('ev') or {}).get('variant')                                   # noqa: E731
        rel = lambda x: (x.get('ev') or {}).get('relation') or (x.get('ev') or {}).get('role')  # noqa: E731
        return (r, self.changed(before, after), after,
                self.new_rows(before, after, 'notices', (ev, rel)),
                self.new_rows(before, after, 'mail', (lambda m: m.get('from'), lambda m: m.get('kind'))))

    def refused(self, request, detail, code=422):
        r, changed, _, _, _ = self.act(request)
        self.assertEqual(r.status_code, code, r.text)
        self.assertIn(detail, r.json()['detail'])
        self.assertEqual(changed, [])
        self.drive.assert_not_called()
        self.hub.assert_not_called()

    # -- setups ---------------------------------------------------------------------------------------------------
    def ask_top(self):
        with patch.object(api, 'hub_changed'):
            self.agent('orgtree_ask', {'question': 'Proceed?', 'options': OPTIONS}, 'top')()
        org = store.load_org(self.slug)
        ask = next(a for a in org.d['asks'] if a['node'] == 'top' and a['status'] == 'open')
        self.ids.update(aid=ask['id'], arev=ask.get('rev') or 1)

    def dog(self, once=False, paused=False):
        with patch.object(api, 'hub_changed'):
            r = self.agent('orgtree_watchdog', {**DOG, **({'once': True} if once else {})}, 'mid')()
            self.ids['wid'] = r.json()['id']
            if paused:
                self.agent('orgtree_watchdog', {'action': 'pause', 'id': self.ids['wid']}, 'mid')()

    def aud_request(self):
        with patch.object(api, 'hub_changed'):
            self.agent('orgtree_audience', {'action': 'request', 'target': 'top', 'reason': 'need'}, 'leaf')()

    def aud_grant(self):
        self.aud_request()
        with patch.object(api, 'hub_changed'):
            self.agent('orgtree_audience', {'action': 'grant', 'from': 'leaf'}, 'top')()

    # -- every contract: its fixtured shape ------------------------------------------------------------------------
    def calls(self):
        wid = lambda: self.ids['wid']                                                     # noqa: E731
        return {
            'asks.ask': (None, lambda: self.agent('orgtree_ask', {'question': 'Proceed?'}, 'top')),
            'asks.withdraw': (self.ask_top, lambda: self.agent('orgtree_withdraw_ask', {}, 'top')),
            'asks.present': (None, lambda: self.agent('orgtree_present', {'title': 'Plan', 'body': '# plan'}, 'top')),
            'asks.submit-report': (None, lambda: self.agent('orgtree_submit_report', {'title': 'Report', 'body': '# r'},
                                                            'leaf')),
            'asks.request-scope': (None, lambda: self.agent('orgtree_request_scope', {
                'items': [{'kind': 'dir', 'path': 'C:/x'}], 'reason': 'need'}, 'top')),
            'watchdogs.create': (None, lambda: self.agent('orgtree_watchdog', DOG, 'mid')),
            'watchdogs.list': (self.dog, lambda: self.agent('orgtree_watchdog', {'action': 'list'}, 'mid')),
            'watchdogs.pause': (self.dog, lambda: self.agent('orgtree_watchdog', {'action': 'pause', 'id': wid()},
                                                             'mid')),
            'watchdogs.resume': (lambda: self.dog(paused=True),
                                 lambda: self.agent('orgtree_watchdog', {'action': 'resume', 'id': wid()}, 'mid')),
            'watchdogs.remove': (self.dog, lambda: self.agent('orgtree_watchdog', {'action': 'remove', 'id': wid()},
                                                              'mid')),
            'watchdogs.supersede': (lambda: self.dog(once=True), lambda: self.agent(
                'orgtree_watchdog', {'action': 'supersede', 'id': wid(), 'reason': 'obsolete'}, 'mid')),
            'audiences.request': (None, lambda: self.agent('orgtree_audience', {'action': 'request', 'target': 'top',
                                                                                'reason': 'need'}, 'leaf')),
            'audiences.forward': (self.aud_request, lambda: self.agent('orgtree_audience', {
                'action': 'forward', 'from': 'leaf', 'target': 'top'}, 'mid')),
            'audiences.grant': (self.aud_request, lambda: self.agent('orgtree_audience', {'action': 'grant',
                                                                                         'from': 'leaf'}, 'top')),
            'audiences.deny': (self.aud_request, lambda: self.agent('orgtree_audience', {
                'action': 'deny', 'from': 'leaf', 'target': 'top'}, 'mid')),
            'audiences.revoke': (self.aud_grant, lambda: self.agent('orgtree_audience', {'action': 'revoke',
                                                                                        'grantee': 'leaf'}, 'top')),
            'asks.answer': (self.ask_top, lambda: self.route('POST', '/api/orgs/{slug}/asks/{aid}/answer',
                                                             {'selected': ['yes'], 'rev': self.ids['arev']})),
            'asks.batch-resolve': (self.ask_top, lambda: self.route('POST', '/api/orgs/{slug}/nodes/top/batch',
                                                                    {'revs': {'ask': self.ids['arev']},
                                                                     'answers': ['yes']})),
            'lifecycle.operator-scope': (None, lambda: self.route('POST', '/api/orgs/{slug}/nodes/leaf/scope',
                                                                  {'charter': 'op charter'})),
            'watchdogs.operator-action': (self.dog, lambda: self.route('POST', '/api/orgs/{slug}/watchdogs',
                                                                       {'id': wid(), 'action': 'pause'})),
            'audiences.operator-action': (self.aud_request, lambda: self.route(
                'POST', '/api/orgs/{slug}/audiences', {'action': 'grant', 'node': 'leaf', 'target': 'top'})),
            'audiences.list': (self.aud_grant, lambda: self.route('GET', '/api/orgs/{slug}/audiences')),
        }

    def test_every_contract_matches_its_fixtured_shape(self):
        for name, (pre, call) in self.calls().items():
            with self.subTest(contract=name):
                self.fresh()
                if pre:
                    pre()
                r, changed, _, told, mail = self.act(call())
                self.assertEqual(r.status_code, 200, r.text)
                want = self.spec['cases'][self.spec['case_of'][name]]
                self.assertEqual(sorted(r.json()), want['results'])
                self.assertEqual(changed, want['sections'])
                self.assertEqual(told, want['told'])
                self.assertEqual(mail, want['mail'])

    # -- asks family ----------------------------------------------------------------------------------------------
    def test_the_user_mail_gate_routes_asks_and_scope_requests_and_refuses_presentations(self):
        for tool, args in (('orgtree_ask', {'question': 'Proceed?'}),
                           ('orgtree_request_scope', {'items': [{'kind': 'dir', 'path': 'C:/x'}], 'reason': 'r'})):
            with self.subTest(tool=tool):
                r, _, _, _, mail = self.act(self.agent(tool, args, 'leaf'))
                self.assertEqual((r.json()['routed'], list(mail)), ('mid', ['mid']))
                # the routed request drives the superior once
                self.assertEqual([c.args[1] for c in self.drive.call_args_list], ['mid'])
        self.refused(self.agent('orgtree_present', {'title': 'P', 'body': 'b'}, 'leaf'),
                     'presenting a document needs a DIRECT user audience')

    def test_a_forwarded_report_mails_the_superior_and_drives_nobody(self):
        # recorded legacy defect: the report's class is TX_POST and its result says delivery_accepted, but the
        # superior it mailed is not woken
        r, changed, _, _, mail = self.act(self.agent('orgtree_submit_report', {'title': 'R', 'body': 'b'}, 'leaf'))
        self.assertEqual((r.json()['forwarded'], r.json()['delivery_accepted'], mail),
                         (True, True, {'mid': [['leaf', 'request']]}))
        self.drive.assert_not_called()
        self.assertNotIn('documents', changed)
        # a top-level report presents to the user instead and mails the user's inbox
        want = self.spec['cases']['submit_top']
        r, changed, _, _, _ = self.act(self.agent('orgtree_submit_report', {'title': 'R', 'body': 'b'}, 'top'))
        self.assertEqual((sorted(r.json()), changed), (want['results'], want['sections']))

    def test_withdraw_without_an_open_ask_is_a_broadcast_no_op(self):
        r, changed, _, _, _ = self.act(self.agent('orgtree_withdraw_ask', {}, 'top'))
        self.assertEqual((r.status_code, changed, self.hub.call_count), (200, [], 1))

    def test_answer_dismiss_and_batch_drive_the_asker_with_their_own_reasons(self):
        for body, reason, text in (({'selected': ['yes']}, 'ask_answer', 'answers the question'),
                                   ({'dismiss': True}, 'ask_answer', 'dismissed your')):
            with self.subTest(body=body):
                self.fresh()
                self.ask_top()
                if 'selected' in body:
                    body = {**body, 'rev': self.ids['arev']}
                r, _, _, _, mail = self.act(self.route('POST', '/api/orgs/{slug}/asks/{aid}/answer', body))
                self.assertEqual((r.status_code, mail), (200, {'top': [['@user', 'message']]}), r.text)
                [call] = self.drive.call_args_list
                self.assertEqual((call.args[1], call.kwargs['ping_reason']), ('top', reason))
                self.assertIn(text, call.args[2])
                self.assertEqual([c.args[1:] for c in self.notify.call_args_list], [('@user', 'top')])
        self.fresh()
        self.ask_top()
        self.act(self.route('POST', '/api/orgs/{slug}/nodes/top/batch', {'revs': {'ask': self.ids['arev']},
                                                                          'answers': ['yes']}))
        self.assertEqual([c.kwargs['ping_reason'] for c in self.drive.call_args_list], ['batch'])

    def test_asks_refusals_write_nothing(self):
        self.refused(self.agent('orgtree_ask', {'question': ''}, 'top'), 'a question is required')
        self.refused(self.agent('orgtree_request_scope', {'items': [], 'reason': 'r'}, 'top'),
                     'items must be a non-empty list')
        self.refused(self.route('POST', '/api/orgs/{slug}/nodes/top/batch', {'revs': {}}), 'top has no open request batch')
        self.ask_top()
        self.refused(self.route('POST', '/api/orgs/{slug}/asks/{aid}/answer', {'selected': ['yes'], 'rev': 99}),
                     'the card changed after it rendered (answer against revision 99')
        self.refused(self.route('POST', '/api/orgs/{slug}/nodes/top/batch', {'revs': {'ask': 99}, 'answers': ['yes']}),
                     'a request was appended or amended')

    # -- watchdogs ------------------------------------------------------------------------------------------------
    def test_watchdog_create_runs_one_smoke_and_list_goes_through_the_write_cycle(self):
        r, _, _, _, _ = self.act(self.agent('orgtree_watchdog', DOG, 'mid'))
        self.assertEqual((r.json()['smoke'], [c.args[1:3] for c in self.smoke.call_args_list]),
                         ({'ok': True}, [('mid', 'file')]))
        # recorded legacy behaviour: list is a read that saves and broadcasts
        r, changed, _, _, _ = self.act(self.agent('orgtree_watchdog', {'action': 'list'}, 'mid'))
        self.assertEqual((len(r.json()['watchdogs']), changed, self.hub.call_count), (1, [], 1))
        r, _, _, _, _ = self.act(self.agent('orgtree_watchdog', {'action': 'list'}, 'top'))
        self.assertEqual(len(r.json()['watchdogs']), 1)                  # an ancestor sees its descendants' dogs
        r, _, _, _, _ = self.act(self.agent('orgtree_watchdog', {'action': 'list'}, 'sib'))
        self.assertEqual(r.json()['watchdogs'], [])

    def test_watchdog_authority_and_refusals(self):
        self.refused(self.agent('orgtree_watchdog', {**DOG, 'kind': 'command', 'target': 'echo hi'}, 'mid'),
                     'it needs the bash you do not hold')
        self.refused(self.agent('orgtree_watchdog', {**DOG, 'target': 'C:/Windows/win.ini'}, 'mid'),
                     'only files in your working folder')
        self.refused(self.agent('orgtree_watchdog', {**DOG, 'kind': 'nope'}, 'mid'), 'kind must be one of')
        self.dog()
        self.refused(self.agent('orgtree_watchdog', {'action': 'pause', 'id': self.ids['wid']}, 'sib'),
                     'sib has no authority over mid')
        self.refused(self.agent('orgtree_watchdog', {'action': 'supersede', 'id': self.ids['wid'], 'reason': 'x'},
                                'mid'), 'only a one-shot watchdog can be superseded')
        self.refused(self.route('POST', '/api/orgs/{slug}/watchdogs', {'id': 'nope', 'action': 'pause'}),
                     "no watchdog 'nope'")
        r, _, after, _, _ = self.act(self.agent('orgtree_watchdog', {'action': 'pause', 'id': self.ids['wid']}, 'top'))
        self.assertEqual((r.status_code, r.json()['state']), (200, 'paused'))    # an ancestor of the owner may
        self.fresh()
        self.dog(once=True)
        self.refused(self.agent('orgtree_watchdog', {'action': 'supersede', 'id': self.ids['wid']}, 'mid'),
                     'supersede requires a reason')

    # -- audiences ------------------------------------------------------------------------------------------------
    def test_audience_drives_and_the_operator_grant_that_mails_nothing(self):
        cases = [(None, {'action': 'request', 'target': 'top', 'reason': 'r'}, 'leaf', ['mid']),
                 (self.aud_request, {'action': 'forward', 'from': 'leaf', 'target': 'top'}, 'mid', ['top']),
                 (self.aud_request, {'action': 'grant', 'from': 'leaf'}, 'top', ['leaf']),
                 (self.aud_request, {'action': 'deny', 'from': 'leaf', 'target': 'top'}, 'mid', ['leaf']),
                 (self.aud_grant, {'action': 'revoke', 'grantee': 'leaf'}, 'top', [])]
        for pre, args, actor, driven in cases:
            with self.subTest(action=args['action']):
                self.fresh()
                if pre:
                    pre()
                r, _, _, _, _ = self.act(self.agent('orgtree_audience', args, actor))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual([c.args[1] for c in self.drive.call_args_list], driven)
        # recorded legacy behaviour: the operator grant tells both parties by notice, posts no mail, and still drives
        # the grantee with "new mail above"
        self.fresh()
        self.aud_request()
        r, changed, _, told, mail = self.act(self.route('POST', '/api/orgs/{slug}/audiences',
                                                        {'action': 'grant', 'node': 'leaf', 'target': 'top'}))
        self.assertEqual((mail, 'mail' in changed, sorted(told)), ({}, False, ['leaf', 'top']))
        [call] = self.drive.call_args_list
        self.assertEqual((call.args[1:3], call.kwargs['ping_reason']),
                         (('leaf', '(orgtree) You have new mail above.'), 'audience'))

    def test_audience_refusals_and_no_ops(self):
        self.refused(self.agent('orgtree_audience', {'action': 'request', 'target': 'sib'}, 'leaf'),
                     'audience requests climb your own chain')
        self.refused(self.agent('orgtree_audience', {'action': 'nope'}, 'top'),
                     'action must be request|forward|grant|deny|revoke')
        self.refused(self.route('POST', '/api/orgs/{slug}/audiences', {'action': 'nope', 'node': 'leaf'}),
                     'action must be grant|deny|revoke')
        r, changed, _, _, _ = self.act(self.agent('orgtree_audience', {'action': 'request', 'target': 'mid'}, 'leaf'))
        self.assertEqual((r.json()['already_reachable'], changed, self.hub.call_count), (True, [], 1))

    # -- receipts -------------------------------------------------------------------------------------------------
    def test_receipt_classes_and_what_they_keep(self):
        want = self.spec['receipts']
        cases = [('orgtree_ask', None, {'question': 'Q?'}, 'top', 'orgtree_ask'),
                 ('orgtree_withdraw_ask', self.ask_top, {}, 'top', 'orgtree_withdraw_ask'),
                 ('orgtree_present', None, {'title': 'P', 'body': 'b'}, 'top', 'orgtree_present'),
                 ('orgtree_submit_report', None, {'title': 'R', 'body': 'b'}, 'leaf', 'orgtree_submit_report'),
                 ('orgtree_request_scope', None, {'items': [{'kind': 'dir', 'path': 'C:/x'}], 'reason': 'r'}, 'top',
                  'orgtree_request_scope'),
                 ('orgtree_watchdog', None, DOG, 'mid', 'orgtree_watchdog:create'),
                 ('orgtree_watchdog', self.dog, {'action': 'list'}, 'mid', 'orgtree_watchdog:list'),
                 ('orgtree_audience', None, {'action': 'request', 'target': 'top', 'reason': 'r'}, 'leaf',
                  'orgtree_audience:request'),
                 ('orgtree_audience', self.aud_request, {'action': 'grant', 'from': 'leaf'}, 'top',
                  'orgtree_audience:grant')]
        for tool, pre, args, actor, label in cases:
            with self.subTest(case=label):
                self.fresh()
                if pre:
                    pre()
                r, changed, after, _, _ = self.act(self.keyed(tool, args, actor))
                self.assertEqual(r.status_code, 200, r.text)
                self.assertTrue({'op_receipts', 'op_receipts_meta'} <= set(changed))
                [row] = [x for x in after['op_receipts'] if x.get('tool') == tool][-1:]
                cls, kept = want[label]
                self.assertEqual((row['cls'], sorted(row['result']) if isinstance(kept, list) else row['result']),
                                 (cls, kept))
        self.fresh()
        self.dog()
        r, _, after, _, _ = self.act(self.keyed('orgtree_watchdog', {'action': 'pause', 'id': self.ids['wid']}, 'mid'))
        [row] = [x for x in after['op_receipts'] if x.get('tool') == 'orgtree_watchdog'][-1:]
        self.assertEqual([row['cls'], sorted(row['result'])], want['orgtree_watchdog:pause'])

    # -- the operator scope route and the audience list ------------------------------------------------------------
    def test_operator_scope_route(self):
        r, _, after, _, _ = self.act(self.route('POST', '/api/orgs/{slug}/nodes/leaf/scope', {'effort': 'low'}))
        self.assertEqual((r.status_code, r.json()['effort_delivery']), (200, 'sent'), r.text)
        self.assertEqual(self.live_effort.call_count, 1)
        self.hub.assert_not_called()                  # no explicit broadcast: store.save_org announces the write
        self.refused(self.route('POST', '/api/orgs/{slug}/nodes/leaf/scope', {'org_visibility': 'bogus'}),
                     'org_visibility must be one of')

    def test_audience_list_is_a_plain_read(self):
        self.aud_grant()
        r, changed, _, _, _ = self.act(self.route('GET', '/api/orgs/{slug}/audiences'))
        self.assertEqual((sorted(r.json()), changed, self.hub.call_count), (['audiences', 'requests'], [], 0))
        self.assertEqual([a['grantee'] for a in r.json()['audiences']], ['leaf'])


if __name__ == '__main__':
    unittest.main()
