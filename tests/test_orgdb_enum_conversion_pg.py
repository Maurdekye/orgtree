"""A real legacy bad-state org converts ACTIVE + EQUAL with a named report."""

import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import test_orgdb_convert_pg as legacy_case
from orgtree import store
from orgtree.orgdb import conn


def setUpModule():
    legacy_case.setUpModule()


def tearDownModule():
    legacy_case.tearDownModule()


@unittest.skipUnless(legacy_case.ADMIN and legacy_case.RUNTIME,
                     'needs own disposable PostgreSQL URLs')
class BadEnumConversion(unittest.TestCase):
    def test_bad_agent_state_converts_active_equal_and_report_names_field(self):
        slug = legacy_case.make_org('Bad Enum Agent')
        org = store.load_org(slug)
        org.nodes['lead']['state'] = 'zz-state'
        store.save_org(org)
        want = legacy_case.legacy_document(slug)
        self.assertEqual('zz-state', want['nodes']['lead']['state'])
        report = legacy_case.convert('first-pass')
        row = legacy_case.registry()[slug]
        self.assertEqual('active', row['state'])
        back = legacy_case.new_document(row['database'])
        self.assertEqual(legacy_case.canon(want), legacy_case.canon(back))
        outcome = next(r for r in report['orgs'] if r['slug'] == slug)
        self.assertEqual('active', outcome['outcome'])
        named = [r for r in outcome['enum_misfits'] if r['table'] == 'agents']
        self.assertEqual([dict(org=slug, table='agents', record={'id': 1},
                               field='state', column='state')], named)
        with conn.connect(legacy_case.RUNTIME, row['database']) as c:
            state, extra = c.execute("SELECT state, extra FROM orgtree.agents WHERE name='lead'").fetchone()
            self.assertIsNone(state)
            self.assertEqual('zz-state', extra['state'])


if __name__ == '__main__':
    unittest.main()
