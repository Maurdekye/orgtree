"""Bounded exact agent identities on actual PG and the real HTTP gateways."""
from contextlib import contextmanager
import copy
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import test_pgstore as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request
from orgtree import api, foreground_api, foreground_store as fg, ledger, store


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ForegroundReferencesPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('references-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 100, 'boss')
        prototype = copy.deepcopy(org.nodes['boss'])
        for nid, extra in [('old', {}), ('bearer', {'successor': 'boss'}),
                           ('revived', {'successor': 'boss', 'state': 'live'})]:
            org.nodes[nid] = {**prototype, 'id': nid, 'parent': 'boss', 'state': 'archived',
                             'grant': 0, 'session_id': 'PRIVATE-SESSION',
                             'charter': 'PRIVATE-HISTORY-' * 2000, **extra}
        store.save_org(org)
        self.prototype = prototype
        self.client = TestClient(TokenGate(api.app, 'references-token'))
        self.headers = {'X-Orgtree-Desktop-Token': 'references-token', 'Accept-Encoding': 'identity'}
        self.path = f'/api/orgs/{self.slug}/foreground-tree/references'

    def get(self, ids, **headers):
        return self.client.get(self.path + '?' + urlencode([('include', nid) for nid in ids]),
                               headers={**self.headers, **headers})

    def direct(self, nid, **changes):
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            value = json.loads(conn.execute('SELECT val FROM nodes WHERE id=?', (nid,)).fetchone()[0])
            value.update(changes)
            conn.execute('UPDATE nodes SET val=? WHERE id=?', (store._dumps(value), nid))
            conn.execute('COMMIT')

    def test_exact_minimal_identity_and_explicit_missing_with_bounded_inputs(self):
        with patch.object(store, 'cached_org', side_effect=AssertionError('whole Org read')), \
             patch.object(fg, '_graph', side_effect=AssertionError('history graph built')):
            response = self.get(['old', 'bearer', 'revived', 'gone', 'old'])
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload['kind'], 'references')
        self.assertEqual(payload['missing'], ['gone'])
        self.assertEqual(set(payload['references']), {'old', 'bearer', 'revived'})
        for row in payload['references'].values():
            self.assertEqual(set(row), {'id', 'tier', 'state', 'generation', 'axis', 'successor'})
            self.assertEqual(row['tier'], 'luna')
        self.assertEqual(payload['references']['bearer']['axis'], 'lineage')
        self.assertEqual(payload['references']['revived']['axis'], 'org')
        # A plain retiree (archived, no successor) stays on the org axis.
        self.assertEqual(payload['references']['old']['state'], 'archived')
        self.assertIsNone(payload['references']['old']['successor'])
        self.assertEqual(payload['references']['old']['axis'], 'org')
        self.assertNotIn('PRIVATE', response.text)
        self.assertEqual(self.get([]).json()['references'], {})
        self.assertEqual(self.get(['old'] * 129).status_code, 400)
        self.assertEqual(self.get(['']).status_code, 400)
        self.assertEqual(self.get(['bad\x00id']).status_code, 400)

    def test_public_kiosk_and_operator_authority_keep_private_fields_out(self):
        with patch.object(fg, 'read_references', side_effect=AssertionError('unauthorized storage')):
            self.assertEqual(self.client.get(self.path).status_code, 401)
        public = TestClient(api.PublicGateway(api.app))
        with patch.object(api, '_kiosk_token_map', return_value={'validtoken': self.slug}):
            result = public.get('/k/validtoken' + self.path + '?include=old&include=gone')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(set(result.json()['references']['old']),
                             {'id', 'tier', 'state', 'generation', 'axis', 'successor'})
            self.assertNotIn('PRIVATE', result.text)
            self.assertEqual(public.get('/k/invalidtoken' + self.path).status_code, 404)
            self.assertEqual(public.get('/k/validtoken/api/orgs/another/foreground-tree/references?include=old').status_code, 404)
        # Exercise the route's own defense too, rather than letting the outer
        # gateway mask a broken cross-org check in foreground_api.read.
        request = Request({'type': 'http', 'method': 'GET', 'path': self.path,
                           'headers': [], 'query_string': b'include=old',
                           'state': {'public_slug': 'another'}})
        with patch.object(fg, 'read_references', side_effect=AssertionError('cross-org storage')):
            with self.assertRaises(HTTPException) as caught:
                foreground_api.read(self.slug, request, mode='references')
        self.assertEqual(caught.exception.status_code, 404)

    def test_same_names_and_missing_are_scoped_to_the_requested_org(self):
        other = store.create_org('other-reference-org')
        other.hire(ledger.USER, None, 'luna', 0, 'other-only')
        other.nodes['old'] = {**self.prototype, 'id': 'old', 'model': 'opus', 'parent': None}
        store.save_org(other)
        response = self.get(['old', 'other-only'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['references']['old']['tier'], 'luna')
        self.assertEqual(response.json()['missing'], ['other-only'])

    def test_catalog_revalidation_tracks_remote_identity_writes_and_rollback(self):
        first = self.get(['old'])
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(self.get(['old'], **{'If-None-Match': first.headers['etag']}).status_code, 304)
        self.direct('old', model='opus', generation=7)
        second = self.get(['old'], **{'If-None-Match': first.headers['etag']})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()['references']['old']['tier'], 'opus')
        self.assertEqual(second.json()['references']['old']['generation'], 7)
        self.assertNotEqual(second.json()['catalog_revision'], first.json()['catalog_revision'])
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            conn.execute('DELETE FROM nodes WHERE id=?', ('old',))
            conn.execute('ROLLBACK')
        same = self.get(['old'])
        self.assertEqual(same.json(), second.json())
        for field, header in [('org_rev', 'x-orgtree-org-rev'), ('sync_rev', 'x-orgtree-sync-rev'),
                              ('catalog_revision', 'x-orgtree-catalog-rev')]:
            self.assertEqual(str(same.json()[field]), same.headers[header])

    def test_concurrent_commit_cannot_mix_identity_and_catalog_snapshots(self):
        original = fg._snapshot
        errors = []
        @contextmanager
        def racing(slug):
            with original(slug) as (raw, stamp):
                def write():
                    try:
                        self.direct('old', model='opus')
                    except BaseException as error:
                        errors.append(error)
                worker = threading.Thread(target=write)
                worker.start()
                worker.join(5)
                self.assertFalse(worker.is_alive(), 'bounded writer must finish')
                self.assertEqual(errors, [])
                yield raw, stamp
        before = self.get(['old']).json()
        with patch.object(fg, '_snapshot', racing):
            raced = self.get(['old']).json()
        self.assertEqual(raced['references'], before['references'])
        self.assertEqual(raced['catalog_revision'], before['catalog_revision'])
        after = self.get(['old']).json()
        self.assertEqual(after['references']['old']['tier'], 'opus')
        self.assertNotEqual(after['catalog_revision'], raced['catalog_revision'])

    def test_corrupt_index_is_an_error_not_explicit_absence(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.raw.execute("DELETE FROM node_index WHERE id='old'")
        response = self.get(['old'])
        self.assertEqual(response.status_code, 503, response.text)
        self.assertNotIn('missing', response.json())

    def test_fixed_ids_read_equal_rows_and_identity_bytes_with_tenfold_history(self):
        observations = []
        for count in (20, 200):
            org = store.load_org(self.slug)
            # old + bearer are the two fixed archived identities in setup.
            for index in range(count - 2):
                nid = f'archive-{index:04d}'
                org.nodes[nid] = {**self.prototype, 'id': nid, 'state': 'archived', 'parent': 'boss',
                                 'grant': 0, 'charter': 'UNREAD-HISTORY-' * 1000}
            store.save_org(org)
            original = fg._snapshot
            read_rows = []
            class Raw:
                def __init__(self, raw):
                    self.raw = raw
                def execute(self, query, args=None):
                    self_outer.assertNotIn('n.val', query)
                    cursor = self.raw.execute(query, args)
                    class Cursor:
                        def fetchall(self):
                            rows = cursor.fetchall()
                            read_rows.append(len(rows))
                            return rows
                    return Cursor()
            self_outer = self
            @contextmanager
            def measured(slug):
                with original(slug) as (raw, stamp):
                    yield Raw(raw), stamp
            with patch.object(fg, '_snapshot', measured), \
                 patch.object(fg, '_graph', side_effect=AssertionError('history graph')), \
                 patch.object(store, 'cached_org', side_effect=AssertionError('whole Org')):
                response = self.get(['old', 'bearer', 'gone'])
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(read_rows, [3], 'one bounded exact-ID read must do work')
            observations.append({'history': count, 'sql_rows': sum(read_rows),
                'identity_rows': len(body['references']), 'wire_bytes': len(response.content),
                'identity_bytes': len(json.dumps([body['references'], body['missing']], sort_keys=True).encode())})
        self.assertEqual(observations[0]['identity_bytes'], observations[1]['identity_bytes'])
        self.assertLessEqual(abs(observations[0]['wire_bytes'] - observations[1]['wire_bytes']), 8)
        print('REFERENCE_VOLUME ' + json.dumps(observations), flush=True)


if __name__ == '__main__':
    unittest.main()
