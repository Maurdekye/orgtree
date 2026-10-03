"""A real legacy bad-state org converts ACTIVE + EQUAL with a named report."""

import json
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import test_orgdb_convert_pg as legacy_case
from orgtree import store
from orgtree.orgdb import conn
from orgtree.orgdb.compat.conn import OrgDbConn


LIVE_IDS = ("SELECT id FROM nodes WHERE id IN "
            "(SELECT id FROM node_index WHERE meta->>'state' = 'live') ORDER BY ord")
FROZEN_IDS = ("SELECT id FROM nodes WHERE strpos(val, ?) > 0 AND "
              "jsonb_typeof((val::jsonb)->'frozen') IS NOT NULL AND "
              "jsonb_typeof((val::jsonb)->'frozen') <> 'null' AND "
              "coalesce((val::jsonb)->>'state', 'live') = 'live' ORDER BY ord")


def reader_results(connection):
    return (store._node_counts(connection),
            connection.execute(LIVE_IDS).fetchall(),
            connection.execute(FROZEN_IDS, ('\"frozen\"',)).fetchall())


def setUpModule():
    legacy_case.setUpModule()


def tearDownModule():
    legacy_case.tearDownModule()


@unittest.skipUnless(legacy_case.ADMIN and legacy_case.RUNTIME,
                     'needs own disposable PostgreSQL URLs')
class BadEnumConversion(unittest.TestCase):
    def setUp(self):
        # Each method exercises a fresh first pass, never a skipped cutover.
        legacy_case._drop_new()

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

    def test_compat_live_readers_preserve_real_conversion_state_defaults_and_misfits(self):
        slug = legacy_case.make_org('Enum Reader Parity')
        org = store.load_org(slug)
        states = dict(live='live', archived='archived', unrecoverable='unrecoverable',
                      unknown='zz-state', deleted='deleted', empty='', number=7,
                      boolean=False, array=[], object={}, null=None)
        nodes = {}
        for name, state in states.items():
            nodes[name] = dict(id=name, name=name, state=state, parent=None,
                               children=[], frozen={'reason': 'reader probe'})
        nodes['missing'] = dict(id='missing', name='missing', parent=None,
                                children=[], frozen={'reason': 'reader probe'})
        org.d['nodes'] = nodes
        store.save_org(org)
        want = legacy_case.legacy_document(slug)
        with store._POOL.acquire(slug) as legacy:
            expected = reader_results(legacy)
        self.assertEqual((12, 3), expected[0])
        self.assertEqual([('live',), ('null',), ('missing',)], expected[1])
        self.assertEqual(expected[1], expected[2])
        report = legacy_case.convert('first-pass')
        outcome = next(r for r in report['orgs'] if r['slug'] == slug)
        row = legacy_case.registry()[slug]
        self.assertEqual('active', outcome['outcome'])
        self.assertEqual('active', row['state'])
        self.assertEqual(legacy_case.canon(want),
                         legacy_case.canon(legacy_case.new_document(row['database'])))
        with conn.connect(legacy_case.RUNTIME, row['database']) as raw:
            actual = reader_results(OrgDbConn(raw, slug, row['org_id'], row['database']))
        for label, old, new in zip(('counts', 'live IDs', 'frozen IDs'), expected, actual):
            with self.subTest(reader=label):
                self.assertEqual(old, new)

    def test_compat_live_readers_tolerate_nul_and_surrogate_neighbors_in_extra(self):
        slug = legacy_case.make_org('Enum Unicode Neighbor')
        org = store.load_org(slug)
        org.nodes['lead']['state'] = 'zz-state'
        org.nodes['lead']['frozen'] = {'reason': 'reader probe'}
        store.save_org(org)
        with store._POOL.acquire(slug) as legacy:
            expected = reader_results(legacy)
        self.assertEqual(((1, 0), [], []), expected)
        legacy_case.convert('first-pass')
        row = legacy_case.registry()[slug]
        self.assertEqual('active', row['state'])
        # Legacy JSONB node-index writes themselves reject NUL/surrogate text.
        # Plant the exact codec-preserved JSON in the converted private database,
        # without changing the legacy state oracle. INSERT exercises native triggers.
        with conn.connect(legacy_case.RUNTIME, row['database']) as raw:
            extra_live = []
            for index, (kind, text) in enumerate((('nul', 'a\x00b'),
                                                   ('surrogate', '\ud800'),
                                                   ('emoji', '\U0001f600'))):
                for offset, state in enumerate(('zz-state', None, 'missing')):
                    name = f'{kind}-{offset}'
                    extra = dict(title=text, frozen={'reason': 'reader probe'})
                    if state != 'missing':
                        extra['state'] = state
                    raw.execute('INSERT INTO orgtree.agents (name, ord, is_frozen, extra) '
                                'VALUES (%s,%s,true,%s::json)',
                                (name, 100 + index * 3 + offset, json.dumps(extra)))
                    if state != 'zz-state':
                        extra_live.append((name,))
            actual = reader_results(OrgDbConn(raw, slug, row['org_id'], row['database']))
            # All JSON bytes remain intact: sanitizing the projection never rewrites extra.
            for name, extra in raw.execute("SELECT name, extra FROM orgtree.agents "
                                            "WHERE name <> 'lead' ORDER BY ord").fetchall():
                kind = name.split('-')[0]
                self.assertEqual(dict(nul='a\x00b', surrogate='\ud800', emoji='\U0001f600')[kind],
                                 extra['title'])
        for label, old, new in zip(('counts', 'live IDs', 'frozen IDs'),
                                   ((10, 6), extra_live, extra_live), actual):
            with self.subTest(reader=label):
                self.assertEqual(old, new)


if __name__ == '__main__':
    unittest.main()
