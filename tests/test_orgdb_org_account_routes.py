"""Org/account API projections against the agreed runtime registry interface.

These tests use a registry seam until 1-B lands. They do not create databases;
real org-database coverage is a separate heavy run after integration.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
from contextlib import contextmanager
from decimal import Decimal
import datetime as dt
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

from orgtree import api, ledger, orgdb, registry, registry_migration, accountusage
from orgtree.orgdb import lifecycle


class OrgUnavailable(RuntimeError):
    pass


def entry(slug='ready', state='active', org_id=1):
    return dict(org_id=org_id, slug=slug, state=state,
                unavailable_step='conversion' if state == 'unavailable' else None,
                state_reason='Bad agent record' if state == 'unavailable' else None,
                attempts=2, report_path='conversion/test/run.json')


class ProjectionConnection:
    def __init__(self, bound=()):
        self.bound = bound
        self.queries = []
        self.answer = None

    @contextmanager
    def transaction(self):
        yield self

    @contextmanager
    def cursor(self, **kwargs):
        yield self

    def execute(self, sql):
        self.queries.append(sql)
        if 'org_settings' in sql:
            self.answer = dict(name='Available org', created=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc),
                               created_text='2026-01-01T00:00:00.000Z', net_identity={'slug': 'public-org'},
                               deleted_cost_usd=Decimal('0.12345'), extra={})
        elif 'count(*)' in sql:
            self.answer = (3, 1)
        elif 'cost_usd' in sql:
            self.answer = [(Decimal('0.10005'), None), (Decimal('0.10005'), None),
                           (Decimal('0.10005'), None)]
        elif 'account' in sql:
            self.answer = self.bound
        return self

    def fetchone(self):
        return self.answer

    def fetchall(self):
        return self.answer


class OrgAccountRoutes(unittest.TestCase):
    def setUp(self):
        self.rows = [entry(), entry('held', 'unavailable', 2), entry('trash', 'trashed', 3)]
        self.c = ProjectionConnection([
            ('live', 'machine', 'live'), ('bearer@0', 'machine', 'archived'),
            ('missing', 'missing:openai', 'live')])
        self.opened = []
        self.fake = types.ModuleType('orgtree.orgdb.registry')
        self.fake.rows = Mock(side_effect=lambda: self.rows)
        self.fake.retry = Mock()
        self.fake.OrgUnavailable = OrgUnavailable
        self.fake.connection = self.connection
        self.enterContext(patch.dict(sys.modules, {'orgtree.orgdb.registry': self.fake}))
        self.enterContext(patch.object(orgdb, 'registry', self.fake, create=True))
        self.enterContext(patch.object(orgdb, 'enabled', return_value=True))
        self.enterContext(patch.object(api.supervisor, 'working_count', return_value=1))

    @contextmanager
    def connection(self, slug):
        self.opened.append(slug)
        if slug != 'ready':
            raise AssertionError('an unavailable database was opened')
        yield self.c

    def test_org_list_shape_and_order_without_opening_unavailable_or_trash(self):
        rows = api.orgs_list(None)
        self.assertEqual([r['slug'] for r in rows], ['held', 'ready'])
        held, ready = rows
        self.assertEqual(ready['name'], 'Available org')
        self.assertEqual(ready['created'], '2026-01-01T00:00:00.000Z')
        self.assertEqual(ready['net_slug'], 'public-org')
        self.assertEqual((ready['nodes'], ready['live'], ready['working']), (3, 1, 1))
        oracle = ledger.Org(dict(slug='oracle', nodes={
            'a': dict(state='live', cost_usd=0.10005),
            'b': dict(state='archived', cost_usd=0.10005),
            'c': dict(state='unrecoverable', cost_usd=0.10005)}, deleted_cost_usd=0.12345))
        self.assertEqual(ready['cost_usd_total'], oracle.cost_total())
        self.assertEqual(held['name'], 'held')
        self.assertEqual((held['nodes'], held['live'], held['working']), (0, 0, 0))
        self.assertEqual(held['state_reason'], 'Bad agent record')
        self.assertEqual(held['attempts'], 2)
        self.assertEqual(self.opened, ['ready'])
        self.assertTrue(all('NOT tombstone' in q for q in self.c.queries if 'orgtree.agents' in q))

    def test_registry_fence_race_refreshes_unavailable_state(self):
        old = self.rows[0].copy()
        self.rows[0] = entry('ready', 'unavailable')
        self.fake.connection = Mock(side_effect=OrgUnavailable('fenced'))
        self.assertEqual(api._orgdb_org_row(old)['state'], 'unavailable')

    def test_trashed_during_fanout_never_becomes_an_openable_list_row(self):
        snapshot = [r.copy() for r in self.rows]
        self.fake.rows.side_effect = [snapshot, [entry('ready', 'trashed'), self.rows[1]]]
        self.fake.connection = Mock(side_effect=OrgUnavailable('fenced'))
        self.assertEqual([r['slug'] for r in api.orgs_list(None)], ['held'])

    def test_bindings_preserve_archived_and_skip_missing_unavailable_and_trash(self):
        self.assertEqual(api._account_bindings(), {'machine': [
            {'org': 'ready', 'node': 'live', 'state': 'live'},
            {'org': 'ready', 'node': 'bearer@0', 'state': 'archived'}]})
        self.assertEqual(self.opened, ['ready'])

    def test_org_and_binding_order_stays_alphabetical_when_ids_are_not(self):
        self.rows = [entry('z', org_id=1), entry('a', org_id=2)]
        @contextmanager
        def connection(slug):
            yield self.c
        self.fake.connection = connection
        self.assertEqual([r['slug'] for r in api.orgs_list(None)], ['a', 'z'])
        self.assertEqual([r['org'] for r in api._account_bindings()['machine']], ['a', 'a', 'z', 'z'])

    def test_retry_success_returns_final_normal_row_and_uses_registry_id(self):
        def retry(org_id):
            self.assertEqual(org_id, 2)
            self.rows[1] = entry('held', 'active', 2)
        self.fake.retry.side_effect = retry
        @contextmanager
        def connection(slug):
            self.assertEqual(slug, 'held')
            yield self.c
        self.fake.connection = connection
        result = asyncio.run(api.orgs_retry('held'))
        self.assertEqual(result['state'], 'active')
        self.assertEqual(result['name'], 'Available org')
        self.fake.retry.assert_called_once_with(2)

    def test_failed_retry_keeps_new_reason_and_never_opens_database(self):
        def retry(org_id):
            self.rows[1]['state_reason'] = 'Still cannot convert'
        self.fake.retry.side_effect = retry
        result = asyncio.run(api.orgs_retry('held'))
        self.assertEqual(result['state'], 'unavailable')
        self.assertEqual(result['state_reason'], 'Still cannot convert')
        self.assertEqual(self.opened, [])

    def test_busy_retry_is_409_and_does_not_edit_lifecycle(self):
        self.fake.retry.side_effect = lifecycle.Busy('another operation holds this org')
        with self.assertRaises(api.HTTPException) as e:
            asyncio.run(api.orgs_retry('held'))
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(self.rows[1]['state'], 'unavailable')

    def test_available_or_unknown_retry_refuses_before_converter(self):
        for slug, status in [('ready', 409), ('absent', 404), ('trash', 404)]:
            with self.subTest(slug=slug), self.assertRaises(api.HTTPException) as e:
                asyncio.run(api.orgs_retry(slug))
            self.assertEqual(e.exception.status_code, status)
        self.fake.retry.assert_not_called()

    def test_retry_lifecycle_races_map_to_404_or_409(self):
        for state, status in [('active', 409), ('trashed', 404), (None, 404)]:
            with self.subTest(state=state):
                self.rows[1] = entry('held', 'unavailable', 2)
                def retry(org_id):
                    self.rows[1] = entry('held', state, 2) if state else entry('other', 'active', 99)
                    raise lifecycle.LifecycleError('org changed during retry')
                self.fake.retry.side_effect = retry
                with self.assertRaises(api.HTTPException) as e:
                    asyncio.run(api.orgs_retry('held'))
                self.assertEqual(e.exception.status_code, status)

    def test_switch_off_preserves_org_reader_and_disables_retry(self):
        org = Mock()
        org.cost_total.return_value = 3.0
        from orgtree import org_summary
        with patch.object(orgdb, 'enabled', return_value=False), \
             patch.object(org_summary, 'admin_rows', return_value=[({'slug': 'old'}, org)]):
            self.assertEqual(api.orgs_list(None), [{'slug': 'old', 'cost_usd_total': 3.0, 'working': 1}])
            with self.assertRaises(api.HTTPException) as e:
                asyncio.run(api.orgs_retry('held'))
            self.assertEqual(e.exception.status_code, 404)
        self.fake.rows.assert_not_called()

    def test_accounts_keep_registry_filter_and_do_not_expose_other_org_keys(self):
        machine = dict(id='machine', provider='openai', credential={}, identity={})
        own = dict(id='own-key', origin_org='ready', provider='openai', credential={}, identity={})
        other = dict(id='other-key', origin_org='held', provider='openai', credential={}, identity={})
        with patch.object(registry, 'load', return_value={'accounts': [machine, own, other]}), \
             patch.object(registry, 'list_accounts', wraps=registry.list_accounts) as read, \
             patch.object(registry, 'resolve_alias', return_value=''), \
             patch.object(registry_migration, 'observe_ambient', return_value={}), \
             patch.object(accountusage, 'host_identities', return_value={}):
            result = asyncio.run(api.accounts_list('ready'))
        read.assert_called_once_with('ready')
        self.assertEqual([r['id'] for r in result['accounts']], ['machine', 'own-key'])
        self.assertEqual(result['accounts'][0]['bound'][1]['state'], 'archived')
        self.assertEqual(set(result), {'accounts', 'primary', 'host_identity'})

    def test_switch_off_keeps_accounts_payload_and_binding_reader(self):
        placed = {'org': 'old', 'node': 'bearer@0', 'state': 'archived'}
        with patch.object(orgdb, 'enabled', return_value=False), \
             patch.object(registry, 'list_accounts', return_value=[{'id': 'machine', 'provider': 'openai'}]), \
             patch.object(registry, 'resolve_alias', return_value=''), \
             patch.object(registry_migration, 'observe_ambient', return_value={}), \
             patch.object(accountusage, 'host_identities', return_value={}), \
             patch.object(api, '_account_bindings', return_value={'machine': [placed]}):
            result = asyncio.run(api.accounts_list())
        self.assertEqual(set(result), {'accounts', 'primary', 'host_identity'})
        self.assertEqual(result['accounts'][0]['bound'], [placed])
        self.fake.rows.assert_not_called()

    def test_fanout_is_at_most_eight_and_preserves_order(self):
        lock, gate = threading.Lock(), threading.Event()
        current = maximum = 0
        def read(row):
            nonlocal current, maximum
            with lock:
                current += 1
                maximum = max(maximum, current)
                if current == 8:
                    gate.set()
            if not gate.wait(3):
                raise AssertionError('control: eight readers did not run')
            with lock:
                current -= 1
            return row['org_id']
        self.assertEqual(api._orgdb_fanout(read, [entry(org_id=i) for i in range(16)]), list(range(16)))
        self.assertEqual(maximum, 8)


if __name__ == '__main__':
    unittest.main()
