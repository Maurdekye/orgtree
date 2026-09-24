"""P01 S3 legacy public-boundary contracts for orgtree_message and orgtree_send_notice.

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, the UI
spark, the tree broadcast, the cross-org transport and the net daemon kick are
spies; the door, addressing, the write cycle, save and reload are real. Each test
pins a fact stated in docs/state-system/operation-contracts.json (agent-mail.*)
against docs/state-system/agent-mail-boundary.json.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-agent-mail-boundary-')
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

M, N = 'orgtree_message', 'orgtree_send_notice'
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'tools', 'results', 'sections', 'retained', 'ping',
          'legacy_defects', 'scope'}
NODES = ('top', 'mid', 'sib', 'kid', 'deep', 'cousin')


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/agent-mail-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.agent-mail-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if d['tools'] != {M: 'mail.message', N: 'mail.notice'}:
        raise ValueError('tool/contract binding')
    for tool, name in d['tools'].items():
        if registry['contracts'].get(name, {}).get('tools') != [tool]:
            raise ValueError('registry does not bind ' + name)
    if set(d['results']) != {'agent', 'user', 'org', 'mcp', 'replay'}:
        raise ValueError('every recipient class is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(result['qualification'], contracts.GATES)
        # reads and instrumentation were specified from P02 rows (S2e); effects stays with P07
        for name in ('conflicts', 'wire', 'effects'):
            self.assertEqual(registry['facets']['agent-mail.' + name]['status'], 'unresolved', name)
        for name in ('reads', 'instrumentation'):
            self.assertEqual(registry['facets']['agent-mail.' + name]['status'], 'specified', name)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['results'].pop('mcp'), lambda d: d['tools'].update(orgtree_message='mail.notice'),
                     lambda d: d.update(covered=True), lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class AgentMailBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-agent-mail-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org, self.slug)
        org.hire(ledger.USER, None, 'haiku', 10, 'top')
        org.hire(ledger.USER, 'top', 'haiku', 6, 'mid')
        org.hire(ledger.USER, 'top', 'haiku', 0, 'sib')
        org.hire(ledger.USER, 'mid', 'haiku', 2, 'kid')
        org.hire(ledger.USER, 'kid', 'haiku', 0, 'deep')
        org.hire(ledger.USER, 'sib', 'haiku', 0, 'cousin')
        org.hire(ledger.USER, 'top', 'haiku', 0, 'gone')
        org.retire(ledger.USER, 'gone')
        org.d['mail'] = {}
        org.d['audiences'] = []
        store.save_org(org)
        other = store.create_org(f'p01-agent-mail-dest-{self.seq}')
        self.other = str(other.d['slug'])
        self.addCleanup(self.cleanup_org, self.other)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN'] for n in NODES}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor, 'delivery_note', return_value='fixture carrier'))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub = self.enterContext(patch.object(api, 'hub_changed'))
        self.inter = self.enterContext(patch.object(api.supervisor, 'interorg_send', return_value=None))
        self.kick = self.enterContext(patch.object(api.net, 'kick'))

    def cleanup_org(self, slug):
        store._POOL.close_all(slug)
        store.delete_org(slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), slug)

    def call(self, tool, args, actor, key=None, epoch=None):
        body = dict(org=self.slug, node=actor, tool=tool, args=args)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL, args=dict(tool=tool, args=args, op_key=key, op_epoch=epoch))
        return self.client.post('/api/agent', json=body, headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def okay(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def refused(self, response, text, code=422):
        self.assertEqual(response.status_code, code, response.text)
        self.assertIn(text, response.json()['detail'])

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))

    def reset(self):
        for spy in (self.drive, self.notify, self.hub, self.inter, self.kick):
            spy.reset_mock()

    def send(self, tool, to, actor, **extra):
        """(result, changed sections, new audiences, the committed documents before and after)."""
        self.reset()
        before = self.durable()
        result = self.okay(self.call(tool, dict(to=to, body='hello', **extra), actor))
        after = self.durable()
        grants = [(a['grantee'], a['grantor']) for a in after.get('audiences', []) if a not in before.get('audiences', [])]
        return result, self.changed(before, after), grants, before, after

    def refuses_cleanly(self, tool, args, actor, text):
        self.reset()
        before = self.durable()
        self.refused(self.call(tool, args, actor), text)
        self.assertEqual(self.durable(), before)
        for spy in (self.drive, self.notify, self.hub, self.inter, self.kick):
            spy.assert_not_called()

    # -- authority: §7.2 addressing and §7.3 grants ------------------------
    def test_in_org_addressing_matrix(self):
        spec = self.spec
        for to, actor, relationship, sections, grants in (
                ('top', 'mid', 'your report', 'agent', []),
                ('kid', 'mid', 'your superior', 'agent', []),
                ('sib', 'mid', 'your peer', 'agent', []),
                ('mid', 'mid', 'yourself', 'agent', []),
                ('deep', 'mid', 'a superior above your chain', 'agent_with_grant', [('deep', 'mid')]),
                ('deep', 'mid', 'a superior above your chain', 'agent', []),          # granted once only
                ('mid', 'deep', 'an agent', 'agent', [])):                            # the reply the grant opened
            with self.subTest(to=to, actor=actor):
                result, changed, new, before, after = self.send(M, to, actor)
                self.assertEqual(sorted(result), spec['results']['agent'])
                self.assertEqual((result['delivered'], result['deferred'], result['recipient_state']), (to, False, 'live'))
                self.assertEqual(result['ref'], f"@mail:{self.slug}/node/{to}/{result['id']}")
                self.assertEqual(changed, spec['sections'][sections])
                self.assertEqual(new, grants)
                row = after['mail'][to][-1]
                self.assertEqual((row['id'], row['from'], row['kind'], row['body'], row['relationship']),
                                 (result['id'], actor, 'message', 'hello', relationship))
                self.notify.assert_called_once_with(self.slug, actor, to)
                self.drive.assert_called_once()
                args, kwargs = self.drive.call_args
                self.assertEqual((args[1], kwargs.get('wake', True), kwargs['mail_ping'], kwargs['ping_reason']),
                                 (to, spec['ping'][M]['wake'], True, spec['ping'][M]['ping_reason']))
                self.hub.assert_called_once_with(self.slug)
        self.refuses_cleanly(M, dict(to='cousin', body='x'), 'mid', 'mid may not address cousin')
        self.refuses_cleanly(M, dict(to='top', body='x'), 'kid', 'kid may not address top')
        self.refuses_cleanly(N, dict(to='cousin', body='x'), 'mid', 'mid may not address cousin')

    def test_user_mail_only_from_the_top_and_urgency_rules(self):
        spec = self.spec
        result, changed, _, _, after = self.send(M, 'user', 'top')
        self.assertEqual(sorted(result), spec['results']['user'])
        self.assertEqual((result['delivered'], result['ref']), ('user_inbox', f"@mail:{self.slug}/user/{result['id']}"))
        self.assertEqual(changed, spec['sections']['user'])
        self.notify.assert_called_once_with(self.slug, 'top', ledger.USER)
        self.drive.assert_not_called()
        result, _, _, _, after = self.send(M, 'user', 'top', urgent=True, urgent_reason='now')
        row = next(m for m in after['user_inbox'] if m['id'] == result['id'])
        self.assertEqual((row['urgent'], row['urgent_reason']), (True, 'now'))
        self.refuses_cleanly(M, dict(to='user', body='x'), 'mid', 'only top-level agents')
        self.refuses_cleanly(M, dict(to='top', body='x', urgent=True, urgent_reason='r'), 'mid', 'only mail to the user can be urgent')
        self.refuses_cleanly(M, dict(to='user', body='x', urgent=True), 'top', 'urgent mail needs a reason')
        self.refuses_cleanly(M, dict(to='user', body='x', urgent_reason='r'), 'top', 'urgent_reason was given without urgent=true')

    # -- predicates ---------------------------------------------------------
    def test_argument_and_recipient_predicates(self):
        self.refuses_cleanly(M, dict(to='top', body='x', kind='notice'), 'mid', "kind 'notice' is minted by orgtree_send_notice")
        self.refuses_cleanly(M, dict(to='nobody-here', body='x'), 'mid', 'NOT DELIVERED')
        self.refuses_cleanly(M, dict(to=['top'], body='x'), 'mid', 'to must be text, not list')
        self.refuses_cleanly(M, dict(to='top', body='x', attachments=['a.txt']), 'mid', 'attachments ride mail to the user or @net:')
        result, _, _, _, after = self.send(M, 'top', 'mid', kind='weird')
        self.assertEqual(after['mail']['top'][-1]['kind'], 'weird')

    def test_empty_bodies_are_delivered_and_drive(self):
        for args in (dict(to='top', body=''), dict(to='top', body='   '), dict(to='top')):
            with self.subTest(args=args):
                self.reset()
                result = self.okay(self.call(M, args, 'mid'))
                self.assertEqual(self.durable()['mail']['top'][-1]['body'], args.get('body', ''))
                self.drive.assert_called_once()

    def test_archived_recipient_is_deferred_and_never_pinged(self):
        for tool in (M, N):
            with self.subTest(tool=tool):
                result, changed, _, _, after = self.send(tool, 'gone', 'top')
                self.assertEqual((result['deferred'], result['recipient_state']), (True, 'archived'))
                self.assertIn('NOTHING WILL READ IT until somebody rehires gone', result['warnings'][0])
                self.assertEqual(changed, self.spec['sections']['agent'])
                self.notify.assert_called_once_with(self.slug, 'top', 'gone')
                self.drive.assert_not_called()

    # -- outside parties ----------------------------------------------------
    def test_outside_addressing(self):
        spec = self.spec
        self.refuses_cleanly(M, dict(to='@ext:foo', body='x'), 'top', 'the @ext: address form is retired')
        self.refuses_cleanly(M, dict(to='@net:foo', body='x'), 'top', 'no mailserver is configured')
        self.refuses_cleanly(M, dict(to=f'@org:{self.other}', body='x'), 'mid', 'only ORG-INBOX audience holders')
        self.refuses_cleanly(M, dict(to=f'@org:{self.slug}', body='x'), 'top', 'that address is this organization itself')
        self.refuses_cleanly(N, dict(to=f'@org:{self.other}', body='x'), 'top', 'notices are for agents in this org')
        self.refuses_cleanly(N, dict(to='user', body='x'), 'top', 'notices are for agents in this org')
        result, changed, grants, _, after = self.send(M, f'@org:{self.other}', 'top')
        self.assertEqual(sorted(result), spec['results']['org'])
        self.assertEqual(changed, spec['sections']['org_first'])
        self.assertEqual(grants, [('top', '@extern')])
        self.assertIn('auto-granted by this send', result['warnings'][0])
        self.assertEqual({k: after['org_inbox'][-1][k] for k in ('dir', 'peer', 'body', 'by')},
                         {'dir': 'out', 'peer': f'@org:{self.other}', 'body': 'hello', 'by': 'top'})
        self.notify.assert_called_once_with(self.slug, 'top', 'org_inbox')
        self.inter.assert_called_once_with(self.slug, self.other, 'hello')
        self.drive.assert_not_called()
        # a bare name that is a local org resolves to @org:, now with the audience already held
        result, changed, grants, _, _ = self.send(M, self.other, 'top')
        self.assertEqual((result['delivered'], changed, grants), (f'@org:{self.other}', spec['sections']['org'], []))
        result, changed, _, _, _ = self.send(M, '@mcp:peer1', 'top')
        self.assertEqual(sorted(result), spec['results']['mcp'])
        self.assertEqual((result['delivered'], result['filed'], changed), (False, '@mcp:peer1', spec['sections']['mcp']))
        self.assertIn('has NEVER polled this machine', result['status'])
        self.inter.assert_not_called()

    def test_net_send_stages_the_spool_in_the_same_save_and_kicks_the_daemon(self):
        with store.write_org(self.slug) as org:
            org.d['net_hubs'] = [{'id': 'h1', 'address': 'http://hub.invalid', 'enabled': True}]
            store.save_org(org)
        with patch.object(api.net, 'probe_peer', return_value=True):
            result, changed, _, _, after = self.send(M, '@net:peer9', 'top')
        # the org's first outside send: the top-level sender is auto-granted the org-inbox audience too
        self.assertEqual(changed, self.spec['sections']['net_first'])
        [entry] = after['net_spool']['h1']
        self.assertEqual(after['org_inbox'][-1]['peer'], '@net:peer9')
        self.assertEqual(result['delivered'], '@net:peer9')
        self.assertIn('queued for the mail hub', ' '.join(result['warnings']))
        self.kick.assert_called_once_with()
        self.drive.assert_not_called()

    # -- notices ------------------------------------------------------------
    def test_notice_steers_without_waking_and_grants_like_mail(self):
        spec = self.spec
        result, changed, grants, _, after = self.send(N, 'sib', 'mid')
        self.assertEqual(sorted(result), spec['results']['agent'])
        self.assertEqual((changed, grants, after['mail']['sib'][-1]['kind']), (spec['sections']['agent'], [], 'notice'))
        self.drive.assert_called_once()
        args, kwargs = self.drive.call_args
        self.assertEqual((args[1], kwargs['wake'], kwargs['mail_ping'], kwargs['ping_reason']),
                         ('sib', spec['ping'][N]['wake'], True, spec['ping'][N]['ping_reason']))
        result, changed, grants, _, _ = self.send(N, 'kid', 'top')
        self.assertEqual((changed, grants), (spec['sections']['agent_with_grant'], [('kid', 'top')]))

    # -- receipts and the door --------------------------------------------
    def test_keyed_sends_file_their_receipt_and_replay_without_effects(self):
        spec = self.spec
        epoch = self.okay(self.call(opreceipts.OP_EPOCH, {}, 'mid'))['epoch']
        for tool, to in ((M, 'top'), (N, 'sib')):
            with self.subTest(tool=tool):
                key = opreceipts.mint_key()
                before = self.durable()
                first = self.okay(self.call(tool, dict(to=to, body='k'), 'mid', key=key, epoch=epoch))
                after = self.durable()
                self.assertEqual(self.changed(before, after), sorted(spec['sections']['agent'] + [opreceipts.SECTION, opreceipts.META]))
                [row] = [r for r in after[opreceipts.SECTION] if r.get('key') == key]
                self.assertEqual(sorted(row['result']), spec['retained'])
                self.assertEqual(row['result']['id'], first['id'])
                self.reset()
                replay = self.okay(self.call(tool, dict(to=to, body='k'), 'mid', key=key, epoch=epoch))
                self.assertEqual(sorted(replay), spec['results']['replay'])
                self.assertEqual(self.durable(), after)
                for spy in (self.drive, self.notify, self.hub):
                    spy.assert_not_called()

    def test_halted_sender_is_refused_before_anything_records(self):
        with store.write_org(self.slug) as org:
            org.node('mid')['halt'] = {'at': 'fixture'}
            store.save_org(org)
        before = self.durable()
        self.assertEqual(self.call(M, dict(to='top', body='x'), 'mid').status_code, 409)
        self.assertEqual(self.durable(), before)


if __name__ == '__main__':
    unittest.main()
