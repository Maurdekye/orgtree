"""P04a-2: the process credential names the seat, and a delete cleans the seat's records.

A node key is a reusable name. Before P04a-2 the signed credential was
`[slug, nid, generation]`, so a deleted seat's token was byte-identical to a
same-name successor's at the same generation and was accepted for it within
one backend run. The credential is now `[slug, nid, generation, seat_id]` and
`api._agent_identity` requires the live node's `seat_id`; in the same change a
user delete purges the seat's private records (receipts included, which is
safe only because the fence lands with it). Synthetic stores in one process,
no restart; every assertion that matters reads the document back from disk.
The negative-control harness in the author's scratch removes one guarantee at
a time and shows the test that names it fails.
"""
import ast
import base64
import hashlib
import hmac
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='seat-credential-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_V2_TOKEN'] = 'test-operator'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app, TokenGate
load_app()
from fastapi import HTTPException
from fastapi.testclient import TestClient
from orgtree import agentauth, api, inbox, ledger, opreceipts, store, supervisor as sup

assert Path(api.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1])
W = 'worker'
OLD = '2000-01-01T00:00:00Z'
KEY = b'seat-credential-fixture-key'
_SERIAL = itertools.count()
SLUGS = []
#: every agent-credential issuer in the backend, per file (census)
ISSUERS = {'supervisor.py': 8, 'warmpool.py': 1, 'antigravity_session.py': 2}


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


def backend_sources():
    root = Path(agentauth.__file__).resolve().parent
    return {p.name: p.read_text(encoding='utf-8') for p in sorted(root.glob('*.py'))}


def issuer_calls(sources):
    """`[(file, line, form)]` for every `agentauth.child_env` / `node_env`
    call. `form` is `node` (a held record), `store` (child_env loads both
    generation and seat) or `explicit` (both passed); anything else is
    `mixed:<kwargs>` — a snapshot generation paired with another read's
    seat, or a seat without its generation."""
    out = []
    for name, text in sources.items():
        for node in ast.walk(ast.parse(text)):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and isinstance(node.func.value, ast.Name) and node.func.value.id == 'agentauth'
                    and node.func.attr in ('child_env', 'node_env')):
                continue
            kw = sorted(k.arg or '**' for k in node.keywords)
            if node.func.attr == 'node_env':
                form = 'node' if len(node.args) == 3 and not kw else f'mixed:{kw}'
            elif not kw and len(node.args) == 2:
                form = 'store'
            elif kw == ['generation', 'seat_id'] and len(node.args) == 2:
                form = 'explicit'
            else:
                form = f'mixed:{kw}'
            out.append((name, node.lineno, form))
    return out


class SeatCredentialTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"sc-{self._testMethodName.replace('_', '-')[:40]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        store.save_org(org)
        self.key = patch.object(agentauth, '_key', KEY)
        self.key.start()
        self.wake = patch.object(sup, 'send_message', return_value={'accepted': True})
        self.wake.start()

    def tearDown(self):
        patch.stopall()
        for nid in (W, 'renamed', 'other'):
            sup._state.pop((self.slug, nid), None)
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def token(self, nid=W):
        return agentauth.node_env(self.slug, nid, self.load().node(nid))['ORGTREE_AGENT_TOKEN']

    @staticmethod
    def request(identity):
        return SimpleNamespace(state=SimpleNamespace(agent_identity=identity))

    def refusal(self, token, node=W, *, durable=False):
        """None when `_agent_identity` accepts `token` for `node`, else the
        refusal text (so a wrong acceptance is an assertion failure)."""
        identity = agentauth.verify(token)
        if identity is None:
            return 'unverified'
        body = api.AgentCall(org=self.slug, node=node, tool='orgtree_status', args={})
        try:
            caller = api._agent_identity(body, self.request(identity), durable=durable)
        except HTTPException as exc:
            return str(exc.detail)
        self.assertEqual(caller.get('seat_id'), identity[3])
        return None

    def steer_refusal(self, token, node=W):
        try:
            api._validate_steer_actor(self.request(agentauth.verify(token)), self.slug, node)
        except HTTPException as exc:
            return str(exc.detail)
        return None

    def own_rows(self, nid):
        """One row naming `nid` in every section a delete now purges."""
        org = self.load()
        org.d.setdefault('delivering', {}).setdefault(nid, []).append(
            {'tok': 't-' + nid, 'at': OLD, 'mail': [], 'via': 'turn'})
        org.d.setdefault('turn_error_log', {}).setdefault(nid, []).append({'at': OLD, 'text': nid})
        org.d.setdefault('mail_transitions', {}).setdefault(nid, {})['op-' + nid] = {
            'node': nid, 'operation': 'op-' + nid, 'outcome': 'reclaimed', 'before': {}}
        sup._steer_attempts(org, nid)['d-' + nid] = {'tok': 's-' + nid, 'at': OLD}
        org.d.setdefault('manual_attempts', {}).setdefault(nid, {})['mf-' + nid] = {
            'v': 1, 'at': OLD, 'tok': 'm-' + nid, 'delivery_id': 'mf-' + nid}
        opreceipts.append(org.d, opreceipts.row(
            op_id='r-' + nid, node=nid, generation=0, key='k-' + nid, mint_ms=0,
            tool=inbox.TOOL, args={'action': 'fetch'}, cls=opreceipts.TX,
            outcome='applied', at=OLD, result={'ok': True}))
        org.d.setdefault('documents', []).append(
            {'id': 'doc-' + nid, 'node': nid, 'title': 't', 'body': 'b', 'at': OLD})
        org.d.setdefault('watchdog_tombs', []).append(
            {'id': 'dog-' + nid, 'owner': nid, 'name': 'spent', 'spent_at': OLD})
        store.save_org(org)

    def rows_of(self, org, nid):
        """`{section: canonical rows}` filed under `nid`, every purge section."""
        out = {}
        for key, field in ledger.Org.DELETE_PURGE_SECTIONS.items():
            sec = org.d.get(key)
            if field is None:
                got = (sec or {}).get(nid)
            else:
                got = [r for r in sec or [] if r.get(field) == nid] or None
            out[key] = json.dumps(got, sort_keys=True, default=str) if got else None
        return out

    # ------------------------------------------------------------ credential
    def test_token_payload_has_seat(self):
        org = self.load()
        seat = org.node(W)['seat_id']
        self.assertTrue(seat)
        token = self.token()
        payload = token.split('.')[0]
        claim = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        self.assertEqual(claim, [self.slug, W, 0, seat])
        self.assertEqual(agentauth.verify(token), (self.slug, W, 0, seat))
        self.assertIsNone(self.refusal(token))
        # the store-loading form signs the same seat as the held record
        self.assertEqual(agentauth.child_env(self.slug, W)['ORGTREE_AGENT_TOKEN'], token)
        # a validly SIGNED three-field (pre-P04a-2) payload does not verify,
        # and a three-field identity context is refused outright
        legacy = base64.urlsafe_b64encode(json.dumps([self.slug, W, 0], separators=(',', ':'))
                                          .encode()).decode().rstrip('=')
        signed = legacy + '.' + hmac.new(KEY, legacy.encode(), hashlib.sha256).hexdigest()
        self.assertIsNone(agentauth.verify(signed))
        body = api.AgentCall(org=self.slug, node=W, tool='orgtree_status', args={})
        with self.assertRaises(HTTPException) as err:
            api._agent_identity(body, self.request((self.slug, W, 0)))
        self.assertIn('unsupported', err.exception.detail)
        for bad in ('', 7, None):
            forged = base64.urlsafe_b64encode(json.dumps([self.slug, W, 0, bad]).encode()).decode().rstrip('=')
            self.assertIsNone(agentauth.verify(
                forged + '.' + hmac.new(KEY, forged.encode(), hashlib.sha256).hexdigest()))

    def test_deleted_seat_token_refused_for_namesake(self):
        old_seat = self.load().node(W)['seat_id']
        old = self.token()
        self.assertIsNone(self.refusal(old))
        org = self.load()
        org.delete(ledger.USER, W)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        org = self.load()
        self.assertNotEqual(org.node(W)['seat_id'], old_seat)
        self.assertEqual(org.node(W)['generation'], 0)       # same key, same generation
        new = self.token()
        self.assertNotEqual(new, old)
        self.assertIn('names another seat', self.refusal(old) or '')
        self.assertIn('names another seat', self.refusal(old, durable=True) or '')
        self.assertIsNone(self.refusal(new))
        self.assertIsNotNone(self.steer_refusal(old))
        self.assertIsNone(self.steer_refusal(new))
        # and through the real middleware + route
        client = TestClient(TokenGate(api.app, 'test-operator'))
        call = {'org': self.slug, 'node': W, 'tool': 'orgtree_status',
                'args': {'status': 'working', 'summary': 'fixture'}}
        refused = client.post('/api/agent', headers={'x-orgtree-agent-token': old}, json=call)
        self.assertEqual(refused.status_code, 403, refused.text)
        self.assertIn('names another seat', refused.text)
        self.assertEqual(client.post('/api/agent', headers={'x-orgtree-agent-token': new},
                                     json=call).status_code, 200)

    def test_renamed_seat_token_refused_after_key_reuse(self):
        seat = self.load().node(W)['seat_id']
        old = self.token()
        org = self.load()
        org.rename(ledger.USER, W, 'renamed')
        store.save_org(org)
        self.assertIn('missing', self.refusal(old) or '')
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, W)             # the old key, reused
        store.save_org(org)
        self.assertIn('names another seat', self.refusal(old) or '')
        self.assertIn('mismatch', self.refusal(old, 'renamed') or '')
        # the renamed seat is re-issued a token for its new key on its next spawn
        reissued = self.token('renamed')
        self.assertEqual(agentauth.verify(reissued)[3], seat)
        self.assertIsNone(self.refusal(reissued, 'renamed'))
        self.assertIsNone(self.refusal(self.token(W)))

    def test_predecessor_token_distinct_by_key(self):
        org = self.load()
        org._archive_session_in_place(W)                       # W@0 shares the seat
        store.save_org(org)
        org = self.load()
        pred = next(k for k in org.nodes if k.startswith(W + '@'))
        self.assertEqual(org.node(pred)['seat_id'], org.node(W)['seat_id'])
        live, bearer = self.token(W), self.token(pred)
        self.assertNotEqual(live, bearer)
        self.assertEqual(agentauth.verify(bearer)[:2], (self.slug, pred))
        self.assertIsNone(self.refusal(live))
        self.assertIn('mismatch', self.refusal(bearer, W) or '')
        self.assertIn('archived', self.refusal(bearer, pred) or '')

    def test_generation_bump_refuses_old_token(self):
        seat = self.load().node(W)['seat_id']
        old = self.token()
        org = self.load()
        org._compact_split_apply(W, 'replacement-session')
        store.save_org(org)
        self.assertIn('generation changed', self.refusal(old) or '')
        fresh = self.token()
        self.assertIsNone(self.refusal(fresh))
        self.assertEqual(agentauth.verify(fresh)[3], seat)

    def test_every_issuer_signs_the_seat(self):
        calls = issuer_calls(backend_sources())
        per_file = {}
        for name, _line, form in calls:
            per_file[name] = per_file.get(name, 0) + 1
        self.assertEqual(per_file, ISSUERS)
        self.assertEqual([c for c in calls if c[2] not in ('node', 'store', 'explicit')], [])
        # the spawn environment, a held-record issuer, signs the live seat
        org = self.load()
        env = sup.spawn_env(org, None, W)
        self.assertEqual(agentauth.verify(env['ORGTREE_AGENT_TOKEN']),
                         (self.slug, W, 0, org.node(W)['seat_id']))

    # ------------------------------------------------------------ cleanup
    def test_delete_purges_classified_sections(self):
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, 'other')
        org._archive_session_in_place(W)                       # a lineage key goes too
        org.node(W)['cost_usd'] = 1.5
        store.save_org(org)
        pred = next(k for k in self.load().nodes if k.startswith(W + '@'))
        for nid in (W, pred, 'other', 'gone', W + '#orphan-0123456789ab'):
            self.own_rows(nid)                                 # 'gone': an earlier delete's leftovers
        org = self.load()
        org.d.setdefault('user_inbox', []).append({'id': 'ui-1', 'from': W, 'body': 'kept'})
        store.save_org(org)
        org = self.load()
        keep = {nid: self.rows_of(org, nid) for nid in ('other', 'gone', W + '#orphan-0123456789ab')}
        for nid in (W, pred):
            self.assertTrue(all(self.rows_of(org, nid).values()), nid)
        events = len(org.d['events'])
        out = org.delete(ledger.USER, W)
        self.assertEqual(sorted(out['deleted']), sorted([W, pred]))
        store.save_org(org)
        org = self.load()
        for nid in (W, pred):
            self.assertEqual({k for k, v in self.rows_of(org, nid).items() if v}, set(), nid)
        for nid, rows in keep.items():
            self.assertEqual(self.rows_of(org, nid), rows, nid)
        # history, accounting and the user's inbox stay
        self.assertGreater(len(org.d['events']), events)
        self.assertEqual(org.d['deleted_cost_usd'], 1.5)
        self.assertIn('ui-1', [r.get('id') for r in org.d['user_inbox']])
        purged = org.d['events'][-1]['detail']['purged']
        self.assertEqual(purged, {k: 2 for k in ledger.Org.DELETE_PURGE_SECTIONS})
        # the census names the same sections as purged on delete
        self.assertEqual({k for k in ledger.Org.DELETE_PURGE_SECTIONS},
                         {k for k, (_c, _s, d) in ledger.NODE_KEYED_SECTIONS.items()
                          if d == 'purged'} - {'nodes', 'mail', 'mail_log', 'notices', 'steered_log',
                                               'asks', 'credit_requests', 'scope_requests',
                                               'watchdogs', 'audiences', 'audience_requests'})
        # the report-only detector still sees the untouched old corpus, only it
        self.assertEqual({f['key'] for f in org.orphans()},
                         {'gone', W + '#orphan-0123456789ab'})

    def test_delete_purge_requires_fence(self):
        """A delayed call from the deleted seat must meet the credential,
        not a missing receipt it could read as fresh execution authority."""
        self.own_rows(W)
        old = self.token()
        self.assertIsNotNone(opreceipts.find(self.load().d, W, 'k-' + W))
        org = self.load()
        org.delete(ledger.USER, W)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        org = self.load()
        self.assertIsNone(opreceipts.find(org.d, W, 'k-' + W))   # purged with its seat
        self.assertIn('names another seat', self.refusal(old, durable=True) or '')

    def test_save_reload_and_restart_format(self):
        token = self.token()
        self.assertIsNone(self.refusal(token))
        store._POOL.close_all(self.slug)
        self.assertIsNone(self.refusal(token))                 # the seat is durable
        text = self.load().d
        self.assertNotIn(token.split('.')[0], json.dumps(text, default=str))
        self.assertNotIn('ORGTREE_AGENT_TOKEN', json.dumps(text, default=str))
        # a backend restart mints a new signing key: every earlier token dies,
        # so there is nothing to convert and no three-field acceptance to keep
        agentauth.enable()
        self.assertIsNone(agentauth.verify(token))
        self.assertIsNone(self.refusal(self.token()))
        # a delete adds no unclassified section and no node field (rollback)
        org = self.load()
        other = dict(org.node('boss'))
        org.delete(ledger.USER, W)
        store.save_org(org)
        org = self.load()
        self.assertEqual([k for k in org.d if k not in ledger.NODE_KEYED_SECTIONS], [])
        self.assertEqual(sorted(org.node('boss')), sorted(other))


if __name__ == '__main__':
    unittest.main()
