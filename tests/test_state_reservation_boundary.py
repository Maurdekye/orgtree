"""P01 legacy public-boundary contracts, on disposable SQLite only.

The app's lifecycle is not started. Provider delivery is replaced with spies;
domain mutation, authentication, receipt admission, save and reload are real.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-reservation-boundary-')
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
from orgtree import agentauth, api, ledger, opreceipts, reservations, store  # noqa: E402

TOOLS = ('orgtree_reservation', 'orgtree_resource_reservation')


def boundary(document=None):
    """Refuse incomplete/stale fixture binding before the API cases run."""
    d = document if document is not None else contracts.load(
        ROOT / 'docs/state-system/reservation-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != {'schema','source_contract_sha256','qualification','tools','variants','receipt','scope'}:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.reservation-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if d['tools'] != list(TOOLS):
        raise ValueError('both aliases are required')
    wanted = {k for k in registry['contracts'] if k.startswith('reservation.')}
    if set(d['variants']) != wanted:
        raise ValueError('missing or unknown reservation variants')
    for name, v in d['variants'].items():
        if set(v) != {'action','fresh_fields','row_fields','state'}:
            raise ValueError('variant fields')
        if v['action'] != registry['contracts'][name]['action']:
            raise ValueError('variant action mismatch')
        for field in ('fresh_fields', 'row_fields'):
            rows = v[field]
            if not isinstance(rows, list) or not rows or len(rows) != len(set(rows)) or not all(isinstance(s,str) and s for s in rows):
                raise ValueError('invalid response fields')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding_and_all_variants(self):
        d = boundary()
        self.assertEqual(len(d['variants']), 11)
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertFalse(result['contract_coverage_complete'])
        self.assertEqual(result['qualification'], contracts.GATES)

    def test_missing_variant_alias_unknown_field_and_false_qualification_refuse(self):
        mutations = [lambda d:d['variants'].pop('reservation.land'),
                     lambda d:d['tools'].pop(),
                     lambda d:d.update(covered=True),
                     lambda d:d['qualification'].update(runtime_census=True),
                     lambda d:d.update(source_contract_sha256='0'*64)]
        for edit in mutations:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class ReservationBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-reservation-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        for name in ('owner','peer','outsider'):
            org.hire(ledger.USER, None, 'haiku', 10, name)
        org.hire(ledger.USER, 'owner', 'haiku', 4, 'child')
        org.hire(ledger.USER, 'child', 'haiku', 0, 'deep')
        # The other branch is not directly addressable by owner.
        org.hire(ledger.USER, 'outsider', 'haiku', 0, 'cousin')
        self.item = org.work_create('owner','Boundary scope','Fixture scope',
            owner='owner',participants=['peer','deep','cousin'])['slug']
        org.d['mail'] = {}  # isolate release mail from fixture participation notices
        org.d['audiences'] = []
        store.save_org(org)
        self.tokens = {n:agentauth.child_env(self.slug,n)['ORGTREE_AGENT_TOKEN']
                       for n in ('owner','peer','outsider','child','deep','cousin')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.clock = self.enterContext(patch.object(reservations, '_now', return_value=100.0))
        self.drive = self.enterContext(patch.object(api.supervisor,'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api.supervisor,'delivery_note', return_value='fixture carrier accepted; read unknown'))
        self.notify = self.enterContext(patch.object(api,'mail_notify'))

    def cleanup_org(self):
        store._POOL.close_all(self.slug)
        store.delete_org(self.slug)
        opreceipts.forget_custody(str(store.DATA_ROOT), self.slug)

    def call(self, args, *, tool=TOOLS[0], actor='owner', key=None, epoch=None, token=None, envelope=None):
        body = dict(org=self.slug,node=actor,tool=tool,args=args)
        if key is not None:
            body.update(tool=opreceipts.OP_CALL,args=dict(tool=tool,args=args,op_key=key,op_epoch=epoch))
        if envelope:
            body.update(envelope)
        return self.client.post('/api/agent',json=body,
            headers={'X-Orgtree-Agent-Token':token if token is not None else self.tokens[actor]})

    def okay(self, response):
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def refused(self, response, text, code=422):
        self.assertEqual(response.status_code,code,response.text)
        self.assertEqual(set(response.json()),{'detail'})
        self.assertIn(text,response.json()['detail'])

    def fresh_key(self):
        epoch = self.okay(self.call({},tool=opreceipts.OP_EPOCH))['epoch']
        return opreceipts.mint_key(), epoch

    def acquire(self, *, tool=TOOLS[0], resource='slot', actor='owner', **extra):
        args = dict(action='acquire', resource=resource,item=self.item,candidate='a'*40,
                    base='b'*40,paths=['engine/api.py'],lease_s=1,stale_s=1)
        args.update(extra)
        return self.okay(self.call(args,tool=tool,actor=actor))['reservation']

    def snapshot(self):
        org = store.load_org(self.slug)
        return {k:copy.deepcopy(org.d.get(k)) for k in
                ('reservations','mail','audiences',opreceipts.SECTION,opreceipts.META)}

    def row(self, rid):
        return next(r for r in self.snapshot()['reservations'] if r['id'] == rid)

    def test_full_fresh_shapes_all_eleven_variants_both_aliases(self):
        for tool in TOOLS:
            for identity, spec in self.spec['variants'].items():
                with self.subTest(tool=tool,variant=identity):
                    short = identity.removeprefix('reservation.')
                    resource = tool + ':' + short
                    self.clock.return_value = 100
                    row = None if short == 'acquire' else self.acquire(tool=tool,resource=resource)
                    args = dict(action=spec['action'],resource=resource,item=self.item)
                    if row:
                        args['reservation'] = row['id']
                    if short == 'acquire':
                        args.update(candidate='a'*40,base='b'*40,paths=['engine/api.py'])
                    elif short in ('list-scope','invalidate'):
                        self.clock.return_value = 105
                        args.update(candidate='c'*40,base='b'*40)
                    elif short == 'recover':
                        self.clock.return_value = 105
                    elif short == 'landing':
                        self.okay(self.call(dict(action='land',reservation=row['id']),tool=tool))
                    elif short == 'overlap':
                        args['paths'] = ['engine']
                    elif short == 'release-notify':
                        args['successor'] = 'peer'
                    result = self.okay(self.call(args,tool=tool))
                    self.assertEqual(set(result),set(spec['fresh_fields']),result)
                    if spec['action'] == 'list':
                        self.assertEqual(result['count'],1)
                        out = result['reservations'][0]
                        self.assertEqual(result['stale'],[row['id']] if short == 'list-scope' else [])
                    elif short == 'landing':
                        out = next(r for r in result['landed'] if r['id'] == row['id'])
                    elif short == 'overlap':
                        self.assertEqual(result['count'],1)
                        self.assertEqual(result['overlaps'][0]['overlap'],['engine'])
                        out = result['overlaps'][0]['reservation']
                    else:
                        out = result['reservation']
                    self.assertEqual(set(out),set(spec['row_fields']),out)
                    self.assertEqual(out['state'],spec['state'])
                    self.assertEqual(out['owner'],'owner')
                    self.assertRegex(out['id'],r'^res-[0-9a-f]{20}$')
                    self.assertEqual(out['candidate'],'a'*40)
                    if short.startswith('release'):
                        self.assertEqual(result['notified'],'peer' if short.endswith('notify') else None)
                        self.assertIs(result['released'],True)
                    for flag in ('renewed','recovered','landed'):
                        if flag in result and isinstance(result[flag],bool):
                            self.assertIs(result[flag],True)
                    if short == 'acquire':
                        self.assertIs(result['replayed'],False)
                    if short == 'invalidate':
                        self.assertIs(result['stale'],True)

    def test_normalization_defaults_and_declarations(self):
        result = self.okay(self.call(dict(action='  AcQuIrE ',resource='  fixture  ',
            item=self.item,candidate='a'*7,base='b'*7,lease_s=0,stale_s=0,
            paths=['engine\\api.py','engine//api.py','engine/'])))
        row = self.row(result['reservation']['id'])
        self.assertEqual(row['resource'],'fixture')
        self.assertEqual(row['paths'],['engine/api.py','engine'])
        self.assertEqual(row['expires_ts'],100+900)
        self.assertEqual(row['stale_s'],300)
        # Explicit null candidate is dropped by the API and remains a read.
        self.okay(self.call(dict(action='list',candidate=None,base=None)))
        self.refused(self.call(dict(action='list',candidate='')), 'candidate must be a commit SHA')
        self.refused(self.call(dict(action=['list'])), 'action must be text')
        self.refused(self.call(dict(action='acquire',resource='x',candidate='a'*40,base='b'*40,lease_s=-1)), 'positive and bounded')

    def test_item_read_closure_participant_reviewer_creator_ancestor_and_archive(self):
        # A separate reservation owner ensures item rights, rather than claim
        # ownership, are what make owner/peer/child/deep metadata visible.
        row = self.acquire(actor='cousin')
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='peer'))['count'],1)
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='outsider'))['count'],0)

        # Move ownership to the other branch. The original creator's access is
        # now independent of ancestry; the unrelated child still has no access.
        with store.write_org(self.slug) as org:
            item,_ = org._work_get_for('owner',self.item)
            item['owner'] = {'node':'cousin','generation':0}
            store.save_org(org)
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='owner'))['count'],1)
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='outsider'))['count'],1)
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='child'))['count'],0)
        with store.write_org(self.slug) as org:
            item,_ = org._work_get_for('owner',self.item)
            item['participants'] = []
            item['owner'] = {'node':'deep','generation':0}
            item['reviewer'] = {'node':'peer','generation':0}
            # Physical archive affects placement, not reservation metadata rights.
            org.d['work_items'].remove(item)
            org.d.setdefault('work_items_archive',[]).append(item)
            store.save_org(org)
        for actor in ('owner','peer','child','deep'):
            with self.subTest(actor=actor):
                visible = self.okay(self.call(dict(action='list'),actor=actor))
                self.assertEqual(visible['reservations'][0]['id'],row['id'])
        self.assertEqual(self.okay(self.call(dict(action='list'),actor='outsider'))['count'],0)

    def test_unknown_and_unreadable_items_share_reservation_refusal(self):
        responses = [self.call(dict(action='acquire',resource='x',item=item,
            candidate='a'*40,base='b'*40),actor='outsider') for item in (self.item,'absent')]
        self.assertEqual(responses[0].json(),responses[1].json())
        for response in responses:
            self.refused(response,'reservation is not visible')

    def test_contention_is_public_only_for_named_held_resource_and_cannot_renew(self):
        row = self.acquire()
        result = self.okay(self.call(dict(action='list',resource='slot'),actor='outsider'))
        public = result['reservations'][0]
        self.assertEqual(public['view'],'contention')
        for field in ('paths','item','integration_key','release_receipt'):
            self.assertNotIn(field,public)
        self.refused(self.call(dict(action='renew',reservation=row['id']),actor='peer'),'only the reservation owner')
        self.okay(self.call(dict(action='release',reservation=row['id'])))
        self.assertEqual(self.okay(self.call(dict(action='list',resource='slot'),actor='outsider'))['count'],0)

    def test_unrelated_recovery_uses_stored_heartbeat_and_safe_projection(self):
        row = self.acquire(stale_s=10)
        self.clock.return_value = 102
        self.refused(self.call(dict(action='recover',reservation=row['id'],stale_s=0.1),actor='outsider'),'heartbeat is active')
        self.clock.return_value = 111
        result = self.okay(self.call(dict(action='recover',reservation=row['id']),actor='outsider'))
        self.assertEqual(result['reservation']['view'],'contention')
        self.assertNotIn('paths',result['reservation'])
        self.assertEqual(self.row(row['id'])['recovered_by'],'outsider')

    def assert_failed_land_is_discarded(self):
        row = self.acquire(resource='rollback')
        before = self.row(row['id'])
        key,epoch = self.fresh_key()
        self.refused(self.call(dict(action='land',reservation=row['id'],candidate='c'*40),key=key,epoch=epoch),'reservation is stale')
        self.assertEqual(self.row(row['id']),before)
        self.assertFalse(self.snapshot()[opreceipts.SECTION])
        # A later independent save must not pick up an abandoned resident edit.
        self.acquire(resource='after-rollback')
        store._POOL.close_all(self.slug)
        self.assertEqual(self.row(row['id']),before)

    def test_failed_land_discards_mutation_and_receipt_even_across_later_save(self):
        self.assert_failed_land_is_discarded()

    def test_unsafe_save_on_refusal_fails_the_same_discard_check(self):
        original = reservations.execute
        committed = []
        def unsafe(document, *args, **kwargs):
            try:
                return original(document, *args, **kwargs)
            except reservations.ReservationError:
                store.save_org(ledger.Org(document))
                committed.append(True)
                raise
        with patch.object(reservations,'execute',side_effect=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_failed_land_is_discarded()
        self.assertEqual(committed,[True])
        self.assertEqual(self.snapshot()['reservations'][0]['state'],'stale')

    def test_release_mail_addressing_refusal_rolls_back_domain_change(self):
        row = self.acquire()
        before = self.snapshot()
        self.refused(self.call(dict(action='release',reservation=row['id'],successor='cousin')),'may not address cousin')
        self.assertEqual(self.snapshot(),before)
        self.drive.assert_not_called()

    def test_release_commits_mail_reply_grant_and_receipt_before_drive(self):
        row = self.acquire()
        key,epoch = self.fresh_key()
        observed = []
        def after_save(*args,**kwargs):
            snapshot = self.snapshot()
            self.assertEqual(self.row(row['id'])['state'],'released')
            self.assertEqual(len(snapshot[opreceipts.SECTION]),1)
            self.assertEqual(len(snapshot['mail']['deep']),1)
            self.assertTrue(any(a['grantee']=='deep' and a['grantor']=='owner' for a in snapshot['audiences']))
            observed.append(args[1])
            return {'delivered':True}
        self.drive.side_effect = after_save
        args = dict(action='release',reservation=row['id'],successor='deep')
        result = self.okay(self.call(args,key=key,epoch=epoch))
        self.assertEqual(observed,['deep'])
        self.assertIn('delivery',result)
        receipt = self.snapshot()[opreceipts.SECTION][0]
        self.assertNotIn('delivery',receipt['result'])
        self.assertEqual(receipt['post_effects'],{'expected':['drive'],'observed':'unknown'})
        replay = self.okay(self.call(args,key=key,epoch=epoch))
        self.assertEqual(set(replay),set(self.spec['receipt']['replay_fields']))
        self.assertEqual(observed,['deep'])
        unkeyed = self.okay(self.call(args))
        self.assertTrue(unkeyed['replayed'])
        self.assertIsNone(unkeyed['notified'])
        self.assertEqual(len(self.snapshot()['mail']['deep']),1)

    def test_precommit_save_failure_keeps_state_mail_audience_and_receipt_unchanged(self):
        row = self.acquire()
        key,epoch = self.fresh_key()
        before = self.snapshot()
        with patch.object(api.store,'save_org',side_effect=OSError('injected precommit failure')):
            response = self.call(dict(action='release',reservation=row['id'],successor='deep'),key=key,epoch=epoch)
        self.assertEqual(response.status_code,500,response.text)
        self.assertEqual(self.snapshot(),before)
        self.drive.assert_not_called()
        # mail_notify is an early UI hint, not proof of committed custody.
        self.notify.assert_called_once()

    def test_postcommit_drive_failure_does_not_reexecute_release_on_keyed_retry(self):
        row = self.acquire()
        key,epoch = self.fresh_key()
        args = dict(action='release',reservation=row['id'],successor='peer')
        self.drive.side_effect = RuntimeError('injected after commit')
        response = self.call(args,key=key,epoch=epoch)
        self.assertEqual(response.status_code,500,response.text)
        self.assertEqual(self.row(row['id'])['state'],'released')
        self.assertEqual(len(self.snapshot()['mail']['peer']),1)
        self.drive.reset_mock(side_effect=True)
        self.assertTrue(self.okay(self.call(args,key=key,epoch=epoch))['replayed'])
        self.drive.assert_not_called()

    # -- notify-effect: the whole release notification, as committed ---------
    def durable(self):
        """The committed document, read cold: the resident copy is evicted so
        nothing an abandoned cycle left in memory can answer for the store."""
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    @staticmethod
    def changed(before, after):
        return sorted(k for k in set(before)|set(after) if before.get(k) != after.get(k))

    def test_release_notification_is_one_status_mail_log_and_lifecycle_row_then_one_ping(self):
        row = self.acquire()
        before = self.durable()
        key,epoch = self.fresh_key()
        result = self.okay(self.call(dict(action='release',reservation=row['id'],successor='deep'),key=key,epoch=epoch))
        after = self.durable()
        [mail] = after['mail']['deep']
        self.assertEqual((mail['from'],mail['kind']),('owner','status'))
        self.assertEqual(mail['body'],f"Reservation {row['id']} was released; its release receipt is {result['release_receipt']}.")
        self.assertEqual(mail['message_id'],mail['id'])
        self.assertEqual(mail['seq_origin'],'deposit')
        self.assertIsInstance(mail['recv_seq'],int)
        self.assertNotIn('ev',mail)      # an untyped legacy row, not a typed event
        self.assertEqual(after['mail_log']['deep'][-1]['id'],mail['id'])
        new_events = after['events'][len(before['events']):]
        mail_events = [e for e in new_events if e['op']=='mail']
        self.assertEqual([(e['actor'],e['detail']['to'],e['detail']['kind']) for e in mail_events],[('owner','deep','status')])
        self.assertEqual(mail_events[0]['warnings'],['audience granted: deep may now reply to owner directly'])
        life = [r for r in after['lifecycle'] if r['operation_id']==mail['operation_id']]
        self.assertEqual([(r['state'],r['delivery'],r['recipient'],r['sender']) for r in life],[('accepted','mailbox','deep','owner')])
        self.assertEqual(after['audiences'],[{'grantee':'deep','grantor':'owner','granted_at':after['audiences'][0]['granted_at'],
                                               'reason':'owner messaged directly'}])
        # post_mail's warnings stay in the event log; the tool result does not carry them
        self.assertNotIn('warnings',result)
        self.assertEqual(result['notified'],'deep')
        self.notify.assert_called_once_with(self.slug,'owner','deep')
        self.drive.assert_called_once()
        args,kwargs = self.drive.call_args
        self.assertEqual(args[:2],(self.slug,'deep'))
        self.assertEqual((kwargs['mail_ping'],kwargs['sender'],kwargs['ping_reason']),(True,'owner','agent_mail'))

    def test_reply_grant_only_for_a_deeper_report_once_and_unreadable_or_archived_successors_refuse(self):
        for resource,successor in (('g1','peer'),('g2','deep'),('g3','deep')):
            row = self.acquire(resource=resource)
            self.okay(self.call(dict(action='release',reservation=row['id'],successor=successor)))
        grants = [(a['grantee'],a['grantor']) for a in self.durable()['audiences']]
        self.assertEqual(grants,[('deep','owner')])   # none for a sibling, one for the deeper report
        # a direct report without item access is refused before any mail
        row = self.acquire(resource='g4')
        before = self.durable()
        self.refused(self.call(dict(action='release',reservation=row['id'],successor='child')),'successor is not a live collaborator')
        self.assertEqual(self.durable(),before)
        # an archived successor is refused too, so release never takes post_mail's deferred branch
        with store.write_org(self.slug) as org:
            org.node('peer')['state'] = 'archived'
            store.save_org(org)
        before = self.durable()
        self.refused(self.call(dict(action='release',reservation=row['id'],successor='peer')),'successor is not a live collaborator')
        self.assertEqual(self.durable(),before)
        self.assertEqual([c.args[1] for c in self.drive.call_args_list],['peer','deep','deep'])

    # -- wrapper-writes: what one public call commits, by outcome -------------
    def test_wrapper_commits_exactly_these_sections_by_outcome(self):
        self.maxDiff = None
        row = self.acquire(resource='wrapper')
        receipts, meta = opreceipts.SECTION, opreceipts.META
        cases, state = [], [self.durable()]
        def run(name, request, code):
            before_calls = self.drive.call_count
            response = request()
            self.assertEqual(response.status_code,code,response.text)
            after = self.durable()
            nodes = sorted((n,f) for n in after['nodes'] for f in set(after['nodes'][n])|set(state[0]['nodes'].get(n,{}))
                           if after['nodes'][n].get(f) != state[0]['nodes'].get(n,{}).get(f))
            cases.append((name,self.changed(state[0],after),nodes,self.drive.call_count-before_calls))
            state[0] = after
        run('unkeyed read', lambda: self.call(dict(action='list')), 200)
        run('unkeyed refusal', lambda: self.call(dict(action='release',reservation=row['id'],successor='cousin')), 422)
        key,epoch = self.fresh_key()
        run('keyed read', lambda: self.call(dict(action='list'),key=key,epoch=epoch), 200)
        key,epoch = self.fresh_key()
        run('keyed refusal', lambda: self.call(dict(action='release',reservation=row['id'],successor='cousin'),key=key,epoch=epoch), 422)
        key,epoch = self.fresh_key()
        run('keyed renew', lambda: self.call(dict(action='renew',reservation=row['id']),key=key,epoch=epoch), 200)
        run('keyed replay', lambda: self.call(dict(action='renew',reservation=row['id']),key=key,epoch=epoch), 200)
        run('conflicting key', lambda: self.call(dict(action='list'),key=key,epoch=epoch), 409)
        with patch.object(api.supervisor.halt,'blocked',return_value='halt'):
            run('halted caller', lambda: self.call(dict(action='list')), 409)
        key,epoch = self.fresh_key()
        run('keyed release', lambda: self.call(dict(action='release',reservation=row['id'],successor='deep'),key=key,epoch=epoch), 200)
        self.assertEqual(cases,[
            ('unkeyed read',[],[],0),
            ('unkeyed refusal',[],[],0),
            ('keyed read',sorted([receipts,meta]),[],0),
            ('keyed refusal',[],[],0),
            ('keyed renew',sorted([receipts,meta,'reservations']),[],0),
            ('keyed replay',[],[],0),
            ('conflicting key',[],[],0),
            ('halted caller',[],[],0),
            # the receiver's mailbox ordinal is the only node field a release touches
            ('keyed release',sorted(['audiences','events','lifecycle','mail','mail_log','nodes',receipts,meta,'reservations']),
             [('deep','mail_seq')],1),
        ])

    def test_slow_request_trace_is_the_only_durable_diagnostic_and_carries_no_arguments(self):
        from orgtree import slowtrace
        path = Path(slowtrace.path())
        before = path.read_text(encoding='utf-8') if path.exists() else ''
        with patch.object(slowtrace,'THRESHOLD_MS',0.0):
            self.okay(self.call(dict(action='acquire',resource='marker-resource-7f3',item=self.item,candidate='a'*40,
                                     base='b'*40,paths=['marker/path-7f3.py'],lease_s=1,stale_s=1)))
        added = path.read_text(encoding='utf-8')[len(before):]
        rows = [json.loads(line) for line in added.splitlines()]
        self.assertEqual([(r['route'],r['method'],r['status']) for r in rows],[('/api/agent','POST',200)])
        self.assertNotIn('marker',added)
        self.assertNotIn(self.item,added)

    def assert_replay_skips_helper(self):
        row = self.acquire()
        key,epoch = self.fresh_key()
        args = dict(action='renew',reservation=row['id'])
        self.okay(self.call(args,key=key,epoch=epoch))
        before = self.snapshot()
        with patch.object(reservations,'execute',side_effect=AssertionError('duplicate execution')), \
             patch.object(api.store,'save_org',wraps=api.store.save_org) as save:
            result = self.okay(self.call(args,key=key,epoch=epoch))
        save.assert_not_called()
        self.assertTrue(result['replayed'])
        self.assertEqual(self.snapshot(),before)

    def test_keyed_replay_bypasses_helper_and_does_not_save(self):
        self.assert_replay_skips_helper()

    def test_unsafe_replay_bypass_is_detected_by_the_same_boundary_check(self):
        original = api._op_admit
        bypassed = []
        def unsafe(org,body,args):
            result = original(org,body,args)
            if result is not None and 'replay' in result:
                bypassed.append(True)
                return None
            return result
        with patch.object(api,'_op_admit',side_effect=unsafe):
            with self.assertRaises(AssertionError):
                self.assert_replay_skips_helper()
        self.assertEqual(bypassed,[True])

    def test_keyed_domain_read_writes_receipt_but_not_reservations(self):
        row = self.acquire()
        before = self.row(row['id'])
        key,epoch = self.fresh_key()
        self.okay(self.call(dict(action='list'),key=key,epoch=epoch))
        self.assertEqual(self.row(row['id']),before)
        receipt = self.snapshot()[opreceipts.SECTION][0]
        self.assertEqual(receipt['cls'],self.spec['receipt']['class'])
        self.assertEqual(receipt['post_effects']['observed'],'unknown')

    def test_alias_and_action_spelling_are_distinct_keyed_fingerprints(self):
        key,epoch = self.fresh_key()
        self.okay(self.call(dict(action='list'),key=key,epoch=epoch))
        self.refused(self.call(dict(action='list'),tool=TOOLS[1],key=key,epoch=epoch),'op_key conflict',409)
        self.refused(self.call(dict(action=' LIST '),key=key,epoch=epoch),'op_key conflict',409)
        # candidate:null is normalized away, while base:null is preserved.
        self.okay(self.call(dict(action='list',candidate=None),key=key,epoch=epoch))
        self.refused(self.call(dict(action='list',base=None),key=key,epoch=epoch),'op_key conflict',409)

    def test_unprotected_envelope_and_missing_epoch_refuse_without_mutation(self):
        before = self.snapshot()
        key = opreceipts.mint_key()
        args = dict(action='acquire',resource='slot',candidate='a'*40,base='b'*40)
        self.refused(self.call(args,envelope={'op_key':key}),'on the request envelope')
        self.refused(self.call(args,key=key,epoch=''),'needs the `op_epoch`')
        self.assertEqual(self.snapshot(),before)

    def test_rotated_epoch_and_expired_key_cannot_become_fresh_execution(self):
        key,epoch = self.fresh_key()
        opreceipts.forget_custody(str(store.DATA_ROOT),self.slug)
        self.refused(self.call(dict(action='list'),key=key,epoch=epoch),'stale_epoch')
        _,epoch = self.fresh_key()
        old = opreceipts.mint_key(int(opreceipts.time.time()*1000)-opreceipts.HORIZON_MS-1)
        self.refused(self.call(dict(action='list'),key=old,epoch=epoch),'key_stale')
        self.assertFalse(self.snapshot()[opreceipts.SECTION])

    def test_authentication_rejects_mismatched_identity_before_receipt_replay(self):
        key,epoch = self.fresh_key()
        self.okay(self.call(dict(action='list'),key=key,epoch=epoch))
        response = self.call(dict(action='list'),key=key,epoch=epoch,token=self.tokens['peer'])
        self.assertEqual(response.status_code,403,response.text)

    def test_legacy_replay_precedes_item_revocation_but_fresh_read_obeys_it(self):
        self.acquire()
        key,epoch = self.fresh_key()
        args = dict(action='list')
        self.assertEqual(self.okay(self.call(args,actor='peer',key=key,epoch=epoch))['count'],1)
        with store.write_org(self.slug) as org:
            item,_ = org._work_get_for('owner',self.item)
            item['participants'].remove('peer')
            store.save_org(org)
        self.assertEqual(self.okay(self.call(args,actor='peer'))['count'],0)
        replay = self.okay(self.call(args,actor='peer',key=key,epoch=epoch))
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt']['result']['count'],1)
        # A legacy behavior fixture, not approval to omit v6 disclosure checks.
        self.assertEqual(replay['receipt']['result']['reservations'][0]['paths'],['engine/api.py'])

    def test_lookup_fences_absent_key_before_delayed_original_can_execute(self):
        key,epoch = self.fresh_key()
        args = dict(action='acquire',resource='delayed',item=self.item,
                    candidate='a'*40,base='b'*40)
        request = dict(op_key=key,op_epoch=epoch,for_tool=TOOLS[0],for_args=args)
        lookup = self.okay(self.call(request,tool=opreceipts.OP_LOOKUP))
        self.assertEqual(lookup['state'],'not_applied')
        self.assertTrue(lookup['fenced'])
        self.assertEqual(lookup['coverage'],'transaction+post')
        self.assertEqual(self.snapshot()[opreceipts.SECTION][0]['outcome'],'fenced')
        before = self.snapshot()
        self.refused(self.call(args,key=key,epoch=epoch),'fenced')
        self.assertEqual(self.snapshot(),before)
        self.assertFalse(self.snapshot()['reservations'])
        self.assertEqual(self.okay(self.call(request,tool=opreceipts.OP_LOOKUP))['state'],'not_applied')

    def test_lookup_after_epoch_rotation_keeps_positive_proof_and_refuses_absence_proof(self):
        applied,epoch = self.fresh_key()
        absent = opreceipts.mint_key()
        args = dict(action='list')
        self.okay(self.call(args,key=applied,epoch=epoch))
        opreceipts.forget_custody(str(store.DATA_ROOT),self.slug)
        before = self.snapshot()
        for key,expected in ((applied,'applied'),(absent,'unknown')):
            result = self.okay(self.call(dict(op_key=key,op_epoch=epoch,
                for_tool=TOOLS[0],for_args=args),tool=opreceipts.OP_LOOKUP))
            self.assertEqual(result['state'],expected)
            if key == absent:
                self.assertEqual(result['reason'],'epoch_rotated')
                self.assertFalse(result['fenced'])
        self.assertEqual(self.snapshot(),before)

    def test_receipt_eviction_uses_largest_evicted_mint_and_never_reopens_old_key(self):
        doc = {}
        now_ms = 1800000000000
        evicted_mint = now_ms + 20000
        evicted_key = opreceipts.mint_key(evicted_mint)
        args = dict(action='list')
        for index in range(opreceipts.CEILING + 1):
            mint = evicted_mint if index == 0 else now_ms + index
            key = evicted_key if index == 0 else opreceipts.mint_key(mint)
            opreceipts.append(doc,opreceipts.row(op_id=str(index),node='owner',
                generation=0,key=key,mint_ms=mint,tool=TOOLS[0],args=args,
                cls='transaction+post',outcome='applied',at='synthetic',result={}),
                now_ms=now_ms)
        self.assertEqual(len(doc[opreceipts.SECTION]),opreceipts.TRIM_TO)
        self.assertEqual(opreceipts.seq(doc),opreceipts.CEILING+1)
        self.assertEqual(opreceipts.watermark(doc),evicted_mint+1)
        decision,info = opreceipts.admit(doc,'owner',0,evicted_key,TOOLS[0],args,
                                       now_ms=now_ms,epoch_ok=True)
        self.assertEqual(decision,opreceipts.REFUSE)
        self.assertEqual(info['reason'],'horizon_evicted')
        retained_key = doc[opreceipts.SECTION][-1]['key']
        self.assertEqual(opreceipts.admit(doc,'owner',0,retained_key,TOOLS[0],args,
            now_ms=now_ms,epoch_ok=True)[0],opreceipts.REPLAY)
        # A later eviction with smaller mints cannot roll this floor back.
        for index in range(opreceipts.CEILING-opreceipts.TRIM_TO+1):
            opreceipts.append(doc,dict(mint_ms=now_ms-100),now_ms=now_ms-100)
        self.assertEqual(opreceipts.watermark(doc),evicted_mint+1)

    def test_result_slice_is_bounded_not_full_result_and_omits_private_extras(self):
        row = self.acquire()
        for tool in TOOLS:
            with self.subTest(tool=tool):
                wide = dict(row,arbitrary='secret',integration_key='private')
                result = opreceipts.result_slice(tool,dict(reservations=[wide]*129,count=129,
                    stale=['lost-id'],landed=[wide],delivery='postcommit',arbitrary='secret'))
                self.assertEqual(set(result),{'reservations','count'})
                self.assertEqual(result['count'],129)
                self.assertEqual(len(result['reservations']),self.spec['receipt']['max_list_rows'])
                self.assertEqual(set(result['reservations'][0]),set(row)&set(self.spec['receipt']['nested_fields']))
                self.assertNotIn('created_at',result['reservations'][0])


if __name__ == '__main__':
    unittest.main()
