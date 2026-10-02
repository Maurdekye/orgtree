"""Legacy org-list payload, funding and spend contracts for summary readers."""
import unittest
from unittest.mock import patch

import test_org_discovery_behavior_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, store

tearDownModule = fixture.tearDownModule


@unittest.skipUnless(fixture.fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class SummaryBehavior(unittest.TestCase):
    setUpClass = fixture.DiscoveryBehavior.__dict__['setUpClass']
    setUp = fixture.DiscoveryBehavior.setUp
    query = fixture.DiscoveryBehavior.query
    setting = fixture.DiscoveryBehavior.setting

    def row(self):
        with patch.object(api.supervisor, 'working_count', return_value=7):
            return next(row for row in api.orgs_list(None) if row['slug'] == self.slug)

    def seed(self):
        full = store.load_org(self.slug)
        worker = full.node('worker')
        worker.update(grant=2, cost_usd=0.1)
        full.nodes['broken'] = dict(worker, state='unrecoverable', grant=3, cost_usd=0.2,
                                    seat_id='broken-seat')
        full.nodes['archived'] = dict(worker, state='archived', grant=400, cost_usd=0.00005,
                                      seat_id='archived-seat')
        full.d['deleted_cost_usd'] = 1.25
        store.save_org(full)
        # Persist the load normalization so this is a native current-format
        # fixture.
        store.save_org(store.load_org(self.slug))
        return store.load_org(self.slug)

    def test_admin_spend_keeps_deleted_cost_and_unrecoverable_seats(self):
        self.seed()
        row = self.row()
        self.assertEqual((row['nodes'], row['live'], row['working']), (3, 1, 7))
        decimal_total = self.query('SELECT cost FROM foreground_meta WHERE singleton=1')[0][0]
        self.assertEqual(row['cost_usd_total'], round(float(decimal_total) + 1.25, 4))

    def test_cost_rounding_matches_tree_decimal_total_at_half_boundary(self):
        self.seed()
        self.setting('deleted_cost_usd', 0)
        row = self.row()
        legacy = round(sum([0.1, 0.2, 0.00005]), 4)
        # Coordinator decision 4: match tree-header decimal display instead
        # of reloading history to preserve a float half-boundary artifact.
        decimal_total = self.query('SELECT cost FROM foreground_meta WHERE singleton=1')[0][0]
        self.assertNotEqual(legacy, round(float(decimal_total), 4))
        self.assertEqual(row['cost_usd_total'], round(float(decimal_total), 4))


if __name__ == '__main__': unittest.main()
