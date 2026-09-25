"""P01 S3 legacy boundary contracts for the strict work-item reads (S3 ruling 2).

Disposable SQLite only; the app's lifecycle is not started. Turn delivery, the UI spark
and the tree broadcast are spies; the desktop token gate, the routes, the ledger and
reload are real. Each test pins a fact stated in
docs/state-system/operation-contracts.json (work-read.*) against
docs/state-system/work-read-boundary.json.
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
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

_temp = tempfile.TemporaryDirectory(prefix='p01-work-read-boundary-', ignore_cleanup_errors=True)
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
from orgtree import agentauth, api, ledger, store  # noqa: E402

OP = {'X-Orgtree-Desktop-Token': 'operator'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'results', 'refusals', 'legacy_defects', 'scope'}
NAMES = {'work.item-list', 'work.item-get'}
CARD = '53052a77187a9676a3c5b772ea0209d6483f16a972cb43b044699b822ee36690'


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/work-read-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.work-read-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != NAMES or not set(d['contracts']) <= set(registry['contracts']):
        raise ValueError('every work-read contract is required')
    return d


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        # reads and instrumentation were specified from P02 rows (S2i); conflicts and wire stay open
        for name in ('conflicts', 'wire'):
            self.assertEqual(registry['facets']['work-read.' + name]['status'], 'unresolved', name)
        for name in ('reads', 'instrumentation'):
            self.assertEqual(registry['facets']['work-read.' + name]['status'], 'specified', name)

    def test_the_orgtree_work_card_stays_pending_with_ruling_2(self):
        # S3 ruling 2: the card (36 actions) is the P05 work family; its selectors wait with it
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        rows = {r['id'][:8]: r for g in ('entries', 'dispatch') for r in registry[g]}
        for wid in ('53052a77', '58225fdc', 'f797075e', 'b2e49e97', 'c5c737b3'):
            with self.subTest(witness=wid):
                self.assertEqual((rows[wid]['disposition'], rows[wid]['contracts']), ('pending', []))
                self.assertIn('S3 ruling 2', rows[wid]['reason'])
        self.assertFalse([k for k, c in registry['contracts'].items() if CARD in c['entry_ids']])

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('work.item-get'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)


class WorkReadBoundary(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.spec = boundary()
        org = store.create_org(f'p01-work-read-{self.seq}')
        self.slug = str(org.d['slug'])
        self.addCleanup(self.cleanup_org)
        org.hire(ledger.USER, None, 'haiku', 4, 'mgr', add_dirs=[], tools={}, charter='fixture')
        self.open = org.work_create('mgr', 'Open item', 'P. F.', status='open', owner='mgr')['slug']
        self.back = org.work_create('mgr', 'Backlog item', 'P. F.', status='backlogged', owner='mgr')['slug']
        self.done = org.work_create('mgr', 'Done item', 'P. F.', status='open', owner='mgr')['slug']
        org.work_update('mgr', self.done, ['finished'], [], status='done')
        store.save_org(org)
        self.agent_token = agentauth.child_env(self.slug, 'mgr')['ORGTREE_AGENT_TOKEN']
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
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

    def read(self, path, headers=OP):
        """GET, and prove it committed nothing and signalled nobody."""
        before = self.durable()
        r = self.client.get(f'/api/orgs/{self.slug}{path}', headers=headers)
        self.assertEqual(self.durable(), before)
        self.assertEqual((self.drive.call_count, self.notify.call_count, self.hub.call_count), (0, 0, 0))
        return r

    @staticmethod
    def slugs(rows):
        return [r['slug'] for r in rows]

    def test_list_splits_by_derived_state_and_writes_nothing(self):
        spec = self.spec
        r = self.read('/work-items')
        self.assertEqual((r.status_code, sorted(r.json())), (200, spec['results']['list']))
        self.assertEqual(sorted(r.json()['counts']), spec['results']['counts'])
        self.assertEqual(set(self.slugs(r.json()['items'])), {self.open, self.done})     # backlog kept out
        self.assertEqual((r.json()['counts']['backlogged'], r.json()['counts']['active']), (1, 1))
        self.assertNotIn('archived', r.json())
        self.assertNotIn('backlogged', r.json())
        self.assertEqual(self.slugs(self.read('/work-items?backlogged=1').json()['backlogged']), [self.back])
        self.assertEqual(self.read('/work-items?archived=1').json()['archived'], [])
        self.assertIn('compact', self.read('/work-items?compact=1').json())

    def test_a_read_derives_the_archive_but_never_sweeps_it(self):
        # the done item's docket update is two hours old: the list derives it archived,
        # and the stored record stays exactly where it is (read() asserts no write)
        old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
        with store.write_org(self.slug) as org:
            item = org._work_find(self.done)[0]
            item['docket_at'] = item['updated_at'] = old
            store.save_org(org)
        stored = [w['slug'] for w in self.durable()['work_items']]
        r = self.read('/work-items?archived=1')
        self.assertNotIn(self.done, self.slugs(r.json()['items']))
        self.assertEqual(self.slugs(r.json()['archived']), [self.done])
        self.assertEqual([w['slug'] for w in self.durable()['work_items']], stored)

    def test_item_read_stamps_the_ref(self):
        spec = self.spec
        r = self.read(f'/work-items/{self.open}')
        self.assertEqual((r.status_code, sorted(r.json())), (200, spec['results']['get']))
        self.assertEqual((r.json()['item']['slug'], r.json()['item']['ref']), (self.open, f'@item:{self.slug}/{self.open}'))
        self.assertEqual(r.json()['item']['status'], 'open')
        self.assertIn('omissions', self.read(f'/work-items/{self.open}?compact=1').json()['item'])

    def test_refusals(self):
        codes = self.spec['refusals']
        self.assertEqual(self.read('/work-items/nope').status_code, codes['unknown_item'])
        self.assertEqual(self.client.get('/api/orgs/nope/work-items', headers=OP).status_code, codes['unknown_org'])
        for path in ('/work-items', f'/work-items/{self.open}'):
            with self.subTest(path=path):
                r = self.read(path, headers={'X-Orgtree-Agent-Token': self.agent_token})
                self.assertEqual(r.status_code, codes['agent_token'])
        # a document with an unnamed item is legacy identity: refused, never served or converted
        with store.write_org(self.slug) as org:
            org._work_find(self.back)[0].pop('slug')
            store.save_org(org)
        for path in ('/work-items', f'/work-items/{self.open}'):
            with self.subTest(path=path):
                r = self.read(path)
                self.assertEqual(r.status_code, codes['identity'])
                self.assertIn('migrate-work-identity', r.json()['detail'])


if __name__ == '__main__':
    unittest.main()
