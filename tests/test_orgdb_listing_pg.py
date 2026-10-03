"""Org listing reads with the storage switch on (piece A7b, batch 2): org discovery
(`org_listing`, G2-C2) and the /api/orgs row (G2-A1, G2-A2; A7b decision 2).

Needs a DISPOSABLE PostgreSQL (never a live one), as tests/test_orgdb_compat_pg.py, whose
fixture this module uses (its legacy database, prefix, data root and lifecycle):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves:
  * discovery reads an org's public metadata (slug, name, its net identity's slug) from the
    org's own database, and only those keys; the exact local lookup finds the org and not a
    missing one;
  * an ordinary org's /api/orgs row is the org summary's: its counts and the DECIMAL cost
    total (coordinator decision 4), never every agent's cost row (the complete reader);
  * an org whose costs need the legacy conversion (a non-numeric cost) keeps the complete
    reader and its rule.

Run:  python tools/run-python-verification.py tests/test_orgdb_listing_pg.py
"""

import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_orgdb_compat_pg as fx
from orgtree import api, ledger, org_listing, org_summary, store
from orgtree.orgdb import registry

setUpModule = fx.setUpModule
tearDownModule = fx.tearDownModule

ROW_KEYS = {'slug', 'name', 'nodes', 'live', 'created', 'net_slug', 'cost_usd_total', 'working',
            'state', 'unavailable_step', 'state_reason', 'attempts', 'report_path'}


def org_with(name: str, costs: list, **settings) -> str:
    """A new org with one live agent per cost (the first at the root, the others under it),
    and ``settings`` as top-level keys."""
    org = store.create_org(name)
    for i, cost in enumerate(costs):
        org.hire(ledger.USER, None if i == 0 else 'a0', 'luna', 0, f'a{i}')
        org.d['nodes'][f'a{i}']['cost_usd'] = cost
    org.d.update(settings)
    store.save_org(org)
    return org.d['slug']


def row_of(slug: str) -> dict:
    """The org's /api/orgs row, as the listing's fan-out reads it."""
    return api._orgdb_org_row(next(r for r in registry.rows() if r['slug'] == slug))


@fx.needs_pg
class Discovery(unittest.TestCase):
    def test_discovery_reads_the_public_metadata_from_the_org_database(self) -> None:
        with fx.storage(True):
            slug = org_with('Disco One', [],
                            net_identity={'slug': 'local.peer', 'secret': 'MUST-NOT-LEAK'})
            rows = [r for r in org_listing.discovery_rows() if r['slug'] == slug]
            self.assertEqual(rows, [{'slug': slug, 'name': 'Disco One', 'net_slug': 'local.peer'}])
            self.assertEqual(org_listing.local_candidates(slug), [slug])
            self.assertEqual(org_listing.local_candidates('no-such-org'), [])

    def test_an_org_without_a_net_identity_has_no_net_slug(self) -> None:
        with fx.storage(True):
            slug = org_with('Disco Two', [])
            self.assertIn({'slug': slug, 'name': 'Disco Two', 'net_slug': None},
                          org_listing.discovery_rows())


@fx.needs_pg
class OrgsList(unittest.TestCase):
    def test_the_row_is_the_org_summary_with_the_decimal_total(self) -> None:
        # 0.1 + 0.2 + 0.00005: the decimal total rounds to 0.3, the float sum in ord order to 0.3001
        with fx.storage(True):
            slug = org_with('Half Cent', [0.1, 0.2, 0.00005])
            with patch.object(api, '_orgdb_org_row_complete',
                              side_effect=AssertionError('the complete reader ran')):
                row = row_of(slug)
            _summary, totals = org_summary._read(slug)
        self.assertEqual(set(row), ROW_KEYS)
        self.assertEqual(row['cost_usd_total'], 0.3)
        self.assertEqual(row['cost_usd_total'], totals.cost_total())
        self.assertEqual((row['slug'], row['name'], row['nodes'], row['live'], row['state']),
                         (slug, 'Half Cent', 3, 3, 'active'))

    def test_an_org_whose_costs_need_the_legacy_conversion_keeps_the_complete_reader(self) -> None:
        with fx.storage(True):
            slug = org_with('Text Cost', ['1.5', 0.25])
            with patch.object(api, '_orgdb_org_row_complete',
                              wraps=api._orgdb_org_row_complete) as complete:
                row = row_of(slug)
        self.assertEqual(complete.call_count, 1)
        self.assertEqual(set(row), ROW_KEYS)
        self.assertEqual((row['cost_usd_total'], row['nodes']), (1.75, 2))


if __name__ == '__main__':
    unittest.main()
