"""Public reset paths must stop before body work on disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_orgdb_record_tree_pg as tree_fixture
from orgtree import record_api as A
from orgtree.orgdb import record_reads as Q
from orgtree.orgdb.record_registry import Selection
from orgtree.orgdb.record_transport import SocketRequest

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class ResetWork(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        tree_fixture.Tree.setUpClass()
        cls.slug = tree_fixture.Tree.twin.copy
        cls.database = tree_fixture.Tree.database
        # Use the normal writer: every node needs its texts/runtime companion
        # rows and field-presence metadata before membership can decode it.
        with fixture.storage(True):
            org = fixture.store.load_org(cls.slug)
            for n in range(2001):
                name = f'reset-history-{n}'
                org.nodes[name] = {**fixture.node(name,'boss'), 'state':'archived',
                    'session_id':name, 'bearer_state':None, 'ui_order':950000+n}
            fixture.store.save_org(org)
        with fixture.storage(True), Q.snapshot(cls.slug) as state:
            cls.after = Q.cursor(state)
        with fixture.dbconn.connect(fixture.ADMIN, cls.database) as raw:
            raw.execute("INSERT INTO orgtree.changes(xid,entity,entity_id) "
                        "VALUES(pg_current_xact_id(),'agent','*')")

    async def asyncSetUp(self):
        self.storage = fixture.storage(True)
        self.storage.__enter__()
        self.hosts = patch.dict(A.hosts, {}, clear=True)
        self.hosts.__enter__()
        self.large = Selection('sub:1', windows=({'kind':'archived_all'},))

    async def asyncTearDown(self):
        try:
            await A.close()
        finally:
            self.hosts.__exit__(None, None, None)
            self.storage.__exit__(None, None, None)

    async def test_public_http_bound_reset_builds_no_record_or_runtime_body(self):
        with patch.object(A.registry, 'bodies', side_effect=AssertionError('body after reset')):
            response = await A.changes(self.slug, str(self.after.rev), self.after.org_uuid,
                self.after.incarnation, json.dumps([dict(sub=1, windows=[{'kind':'archived_all'}])]))
        self.assertEqual(json.loads(response.body), {'type':'record_reset'})
        self.assertIsNone(A.host(self.slug).overlay)

    async def test_all_reset_socket_batch_builds_no_runtime_body_or_answer(self):
        requests = {'large':SocketRequest((Selection(), self.large), frozenset())}
        with patch.object(A.registry, 'bodies', side_effect=AssertionError('body after reset')):
            batch = await A.host(self.slug)._load_batch(self.after, requests)
        self.assertEqual(batch.changes, {'large':{'type':'record_reset'}})
        self.assertEqual(batch.answers, {'large':()})
        self.assertFalse(batch.runtime)
        self.assertIsNone(A.host(self.slug).overlay)

    async def test_mixed_socket_batch_excludes_reset_subscription_from_runtime(self):
        requests = {'large':SocketRequest((Selection(), self.large), frozenset()),
                    'small':SocketRequest((Selection(),), frozenset())}
        original = A.registry.bodies
        counts = []
        def bounded(state, entity, ids):
            counts.append((entity,len(ids)))
            self.assertLessEqual(len(ids),Q.BOUND,'reset client runtime bodies')
            return original(state,entity,ids)
        with patch.object(A.registry, 'bodies', side_effect=bounded):
            batch = await A.host(self.slug)._load_batch(self.after, requests)
        self.assertEqual(batch.changes['large'], {'type':'record_reset'})
        self.assertEqual(batch.answers['large'], ())
        self.assertEqual(batch.changes['small']['type'], 'record_changes')
        self.assertTrue(counts)
        self.assertIsNotNone(A.host(self.slug).overlay)
        self.assertLessEqual(len(A.host(self.slug).overlay._bodies),Q.BOUND)


if __name__ == '__main__':
    unittest.main()
