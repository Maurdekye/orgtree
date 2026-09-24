"""P01 S3 legacy public-boundary contracts for the org tree, node detail and org feed.

Disposable SQLite only; the app's lifecycle is not started. The desktop token gate,
the kiosk PublicGateway, the view build and the websocket hub are real. Each test
pins a fact stated in docs/state-system/operation-contracts.json (org-view.* and
org-feed.* facets) against docs/state-system/org-view-boundary.json.
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

_temp = tempfile.TemporaryDirectory(prefix='p01-org-view-boundary-')
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
from starlette.websockets import WebSocketDisconnect  # noqa: E402
from orgtree import agentauth, api, ledger, store  # noqa: E402

FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'routes', 'tree_fields', 'archived_summary_fields',
          'archived_summary_marker', 'public', 'refusals', 'frames', 'legacy_defects', 'scope'}
OP = {'X-Orgtree-Desktop-Token': 'operator'}
KIOSK = 'kioskTOKEN123'


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/org-view-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.org-view-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['routes']) != {'org.tree', 'org.node-detail', 'org.feed'} or not set(d['routes']) <= set(registry['contracts']):
        raise ValueError('every org-view contract is required')
    if set(d['frames']) != {'changed', 'node_event', 'mail'}:
        raise ValueError('every frame shape is required')
    if not d['tree_fields'] or not d['archived_summary_fields']:
        raise ValueError('field sets required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(result['qualification'], contracts.GATES)
        for name in ('org-view.reads', 'org-view.writes', 'org-view.conflicts', 'org-view.wire',
                     'org-view.instrumentation', 'org-feed.conflicts', 'org-feed.wire', 'org-feed.instrumentation'):
            self.assertEqual(registry['facets'][name]['status'], 'unresolved', name)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['routes'].pop('org.feed'), lambda d: d['frames'].pop('mail'),
                     lambda d: d.update(covered=True), lambda d: d['qualification'].update(conversion_authorized=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class _Org(unittest.TestCase):
    """The shared synthetic org and helpers; no tests of its own."""
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-org-view-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org, self.slug)
        org.hire(ledger.USER, None, 'haiku', 10, 'boss')
        org.hire(ledger.USER, 'boss', 'haiku', 4, 'worker')
        org.hire(ledger.USER, 'boss', 'haiku', 0, 'gone')
        org.retire(ledger.USER, 'gone')
        store.save_org(org)
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.drive = self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.notify = self.enterContext(patch.object(api, 'mail_notify'))
        self.hub_changed = self.enterContext(patch.object(api, 'hub_changed'))
        # a fixed ETag bucket, so a revalidation cannot straddle the 30 s boundary
        self.enterContext(patch.object(api, '_TREE_STALE_BUCKET_S', 1e9))

    def cleanup_org(self, slug):
        store._POOL.close_all(slug)
        store.delete_org(slug)

    def durable(self):
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    def get(self, path, headers=OP, client=None):
        return (client or self.client).get(path, headers=headers)

    def quiet(self):
        self.drive.assert_not_called()
        self.notify.assert_not_called()
        self.hub_changed.assert_not_called()

    def enable_kiosk(self):
        with store.write_org(self.slug) as org:
            org.d['kiosk'] = {'enabled': True, 'token': KIOSK}
            store.save_org(org)
        api._token_cache['at'] = 0.0
        public = TestClient(api.PublicGateway(api.app), raise_server_exceptions=False)
        self.addCleanup(public.close)
        return public

    @staticmethod
    def nodes(tree):
        out, stack = {}, list(tree['roots'])
        while stack:
            n = stack.pop()
            out[n['id']] = n
            stack.extend(n['children'])
        return out


class OrgViewBoundary(_Org):
    # -- authority --------------------------------------------------------
    def test_desktop_token_gates_both_routes_and_an_agent_token_is_refused_as_invalid(self):
        refusals = self.spec['refusals']
        agent = agentauth.child_env(self.slug, 'worker')['ORGTREE_AGENT_TOKEN']
        for path in (f'/api/orgs/{self.slug}', f'/api/orgs/{self.slug}/nodes/worker/detail'):
            with self.subTest(path=path):
                for headers, key in (({}, 'missing'), ({'X-Orgtree-Desktop-Token': 'x'}, 'invalid'),
                                     ({'X-Orgtree-Agent-Token': agent}, 'agent_token')):
                    r = self.get(path, headers)
                    self.assertEqual((r.status_code, r.json()), (refusals[key][0], {'detail': refusals[key][1]}))
                self.assertEqual(self.get(path).status_code, 200)

    def test_unknown_org_and_foreign_node_are_404(self):
        self.assertEqual(self.get('/api/orgs/no-such-org').status_code, 404)
        r = self.get(f'/api/orgs/{self.slug}/nodes/nobody/detail')
        self.assertEqual((r.status_code, r.json()), (404, {'detail': "no such node: 'nobody'"}))
        other = store.create_org(f'p01-org-view-other-{self.seq}')
        self.addCleanup(self.cleanup_org, str(other.d['slug']))
        self.assertEqual(self.get(f"/api/orgs/{other.d['slug']}/nodes/worker/detail").status_code, 404)

    def test_kiosk_gateway_serves_only_its_own_org_and_scrubs(self):
        public = self.enable_kiosk()
        other = store.create_org(f'p01-org-view-kother-{self.seq}')
        self.addCleanup(self.cleanup_org, str(other.d['slug']))
        admin = self.get(f'/api/orgs/{self.slug}').json()
        r = public.get(f'/k/{KIOSK}/api/orgs/{self.slug}')
        self.assertEqual(r.status_code, 200)
        tree = r.json()
        self.assertEqual(sorted(set(tree) - set(admin)), self.spec['public']['adds'])
        self.assertEqual(sorted(set(admin) - set(tree)), self.spec['public']['drops'])
        self.assertIs(tree['public'], True)
        for row in self.nodes(tree).values():
            for field in self.spec['public']['row_drops']:
                self.assertNotIn(field, row)
        detail = public.get(f'/k/{KIOSK}/api/orgs/{self.slug}/nodes/worker/detail').json()
        for field in self.spec['public']['row_drops']:
            self.assertNotIn(field, detail)
        self.assertEqual(public.get(f"/k/{KIOSK}/api/orgs/{other.d['slug']}").status_code, 404)
        self.assertEqual(public.get(f'/k/nopenopenope/api/orgs/{self.slug}').status_code, 404)

    # -- predicates -------------------------------------------------------
    def test_first_etag_of_a_cold_org_is_stale_then_revalidation_answers_304(self):
        first = self.get(f'/api/orgs/{self.slug}')
        tag1 = first.headers['etag']
        second = self.get(f'/api/orgs/{self.slug}', {**OP, 'If-None-Match': tag1})
        self.assertEqual(second.status_code, 200)            # the first tag went stale during its own build
        tag2 = second.headers['etag']
        self.assertNotEqual(tag1, tag2)
        third = self.get(f'/api/orgs/{self.slug}', {**OP, 'If-None-Match': tag2})
        self.assertEqual((third.status_code, third.content), (304, b''))
        self.assertEqual(third.headers['etag'], tag2)

    def test_archived_seats_are_summarised_in_the_tree_and_complete_in_detail(self):
        tree = self.get(f'/api/orgs/{self.slug}').json()
        self.assertEqual(sorted(tree), sorted(self.spec['tree_fields']))
        gone = self.nodes(tree)['gone']
        self.assertEqual(sorted(gone), sorted(self.spec['archived_summary_fields']))
        self.assertIs(gone['detail'], self.spec['archived_summary_marker']['detail'])
        self.assertIn('detail', gone)
        self.assertNotIn('detail', self.nodes(tree)['worker'])
        detail = self.get(f'/api/orgs/{self.slug}/nodes/gone/detail').json()
        self.assertEqual(detail['children'], [])
        self.assertEqual(detail['detail_rev'], gone['detail_rev'])
        self.assertNotIn('detail', detail)
        live = self.get(f'/api/orgs/{self.slug}/nodes/boss/detail').json()
        self.assertEqual(live['children'], [])
        self.assertNotIn('detail_rev', live)

    # -- writes / effects ---------------------------------------------------
    def test_tree_detail_and_public_views_commit_and_signal_nothing(self):
        public = self.enable_kiosk()
        before = self.durable()
        self.get(f'/api/orgs/{self.slug}')
        self.get(f'/api/orgs/{self.slug}/nodes/worker/detail')
        self.get(f'/api/orgs/{self.slug}/nodes/gone/detail')
        public.get(f'/k/{KIOSK}/api/orgs/{self.slug}')
        self.assertEqual(self.durable(), before)
        self.quiet()


class OrgFeedBoundary(_Org):

    def test_socket_without_the_desktop_token_is_closed_4401(self):
        with self.assertRaises(WebSocketDisconnect) as caught:
            with self.client.websocket_connect(f'/api/orgs/{self.slug}/ws'):
                pass
        self.assertEqual(caught.exception.code, self.spec['refusals']['ws_close'])

    def test_frames_have_the_fixtured_shapes_and_revs_increase(self):
        frames = self.spec['frames']
        before = self.durable()
        with self.client.websocket_connect(f'/api/orgs/{self.slug}/ws', headers=OP) as ws:
            self.assertEqual(len(api.hub.rooms[self.slug]), 1)
            ws.portal.call(api.hub.changed, self.slug)
            changed = ws.receive_json()
            ws.portal.call(api.hub.node_event, self.slug, 'worker', 'turn_started', {'extra': 1})
            event = ws.receive_json()
            ws.portal.call(api.hub._send, self.slug, {'type': 'mail', 'org': self.slug, 'from': 'worker', 'to': 'boss'})
            mail = ws.receive_json()
            ws.send_text('ignored')                              # client text is ignored
            ws.portal.call(api.hub.changed, self.slug)
            again = ws.receive_json()
        self.assertEqual(sorted(changed), frames['changed'])
        self.assertEqual(sorted(k for k in event if k != 'extra'), frames['node_event'])
        self.assertEqual(event['extra'], 1)
        self.assertEqual(sorted(mail), frames['mail'])
        self.assertEqual((event['rev'], again['rev']), (changed['rev'] + 1, changed['rev'] + 2))
        self.assertEqual(api.hub.rooms[self.slug], set())       # a disconnect leaves the room
        self.assertEqual(self.durable(), before)
        self.quiet()

    def test_route_accepts_a_socket_for_an_org_that_does_not_exist(self):
        with self.client.websocket_connect('/api/orgs/no-such-org/ws', headers=OP):
            self.assertEqual(len(api.hub.rooms['no-such-org']), 1)

    def test_kiosk_socket_joins_flagged_public(self):
        public = self.enable_kiosk()
        with public.websocket_connect(f'/k/{KIOSK}/api/orgs/{self.slug}/ws') as ws:
            [sock] = api.hub.rooms[self.slug]
            self.assertIn(sock, api.hub.public)
        self.assertEqual(api.hub.public, set())


if __name__ == '__main__':
    unittest.main()
