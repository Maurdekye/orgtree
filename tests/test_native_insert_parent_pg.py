"""Public native rehire-and-insert preserves a valid final graph atomically."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_native_move_endpoints_pg as endpoints
from orgtree import api, ledger, store
from orgtree.orgdb import graph
from orgtree.orgdb.compat import rows as R


def setUpModule():
    fixture.setUpModule()


def tearDownModule():
    fixture.tearDownModule()


@fixture.needs_pg
class NativeInsertParent(unittest.TestCase):
    setUp = endpoints.NativeMoveEndpoints.setUp
    values = endpoints.NativeMoveEndpoints.values

    def snapshot(self):
        with store._POOL.acquire(self.slug) as conn:
            revision = conn.raw.execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]
            rows = conn.raw.execute('SELECT id,name,tombstone,state,parent_id,row_version '
                                    'FROM orgtree.agents ORDER BY id').fetchall()
        return revision, rows

    def test_public_rehire_insert_preserves_identity_credit_and_one_revision(self):
        org = store.load_org(self.slug)
        org.retire('boss', 'leaf')
        store.save_org(org)
        before, rows = self.snapshot()
        identities = {row[1]: row[0] for row in rows if not row[2]}
        before_values = self.values()
        reference = ledger.Org(fixture.document(self.slug))
        args = dict(node='leaf', target='a', hire_type='superior')
        drive = []
        expected = api._rehire_seat(reference, self.slug, 'boss', args, drive, None, [])
        self.assertEqual(drive, [])
        writes = []
        original = R.node_put

        def trace_put(raw, name, value, *rest, **kwargs):
            writes.append((name, value.get('parent'), value.get('state')))
            return original(raw, name, value, *rest, **kwargs)

        try:
            with patch.object(R, 'node_put', side_effect=trace_put):
                result = api.agent_call(api.AgentCall(org=self.slug, node='boss',
                    tool='orgtree_rehire', args=args), endpoints.REQUEST)
        except Exception:
            self.assertEqual(self.snapshot(), (before, rows))
            self.assertEqual(self.values(), before_values)
            print('native insertion node writes before refusal:', writes, flush=True)
            raise
        self.assertNotIn('error', result)
        for key, value in expected.items():
            self.assertEqual(result.get(key), value, key)
        after, changed = self.snapshot()
        self.assertEqual(after, before + 1)
        self.assertEqual({row[1]: row[0] for row in changed if not row[2]}, identities)
        self.assertEqual(self.values(), {name: (node['parent'], node['grant'])
                                        for name, node in reference.nodes.items()})
        self.assertEqual(self.values()['leaf'][0], 'boss')
        self.assertEqual(self.values()['a'][0], 'leaf')
        with store._POOL.acquire(self.slug) as conn:
            self.assertEqual(graph.verify_stats(conn.raw), [])


if __name__ == '__main__':
    unittest.main()
