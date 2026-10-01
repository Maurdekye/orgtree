"""One snapshot read carries every visible retired pile's edge rows (`piles=1`).

The renderer used to page each visible pile's first and last retired child
and re-read until no new pile showed (N1000 attempt 7b: about 2000 child
pages per refresh, then a fall-back to the whole legacy tree past 128 ids).
Every test here compares the one read with that old paged algorithm, ported
from treeview.ts, run over the real routes on the same committed state.
"""
import copy
import json
import unittest
from unittest.mock import patch
from urllib.parse import quote

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_cache, foreground_store, ledger, store


def tearDownModule():
    fixture.tearDownModule()


def visible_parents(snapshot, fronts):
    """treeview.ts visibleParents (before this change), on the wire snapshot."""
    nodes, result = snapshot['nodes'], []

    def walk(ids, parent, omitted):
        rows = [nodes[i] for i in ids]
        retired = [row for row in rows if row['state'] == 'archived']
        if omitted + len(retired) > 0:
            result.append(parent)
        saved = fronts.get(parent)
        front = next((row for row in retired if row['id'] == saved), retired[-1] if retired else None)
        for row in rows:
            if row['state'] == 'archived' and row is not front:
                continue
            walk(row['children'], row['id'], row['hidden_retired_children'])
    walk(snapshot['roots'], '', snapshot['header']['hidden_retired_roots'])
    return result


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ForegroundPilesPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-piles-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 1000, 'boss')
        for nid in ('root-r1', 'root-r2'):
            org.hire(ledger.USER, None, 'luna', 10, nid)
        org.hire(ledger.USER, 'boss', 'luna', 100, 'a')
        for nid in ('b', 'r1', 'r2', 'r3'):
            org.hire(ledger.USER, 'boss', 'luna', 10, nid)
        for nid in ('a-r1', 'a-r2', 'a-r3'):
            org.hire(ledger.USER, 'a', 'luna', 10, nid)
        # a pile's front has its own live child, whose pile shows only once
        # that front is selected: the fixed point needs a second round
        org.hire(ledger.USER, 'a-r3', 'luna', 5, 'x')
        for nid in ('x-r1', 'x-r2'):
            org.hire(ledger.USER, 'x', 'luna', 1, nid)
        org.hire(ledger.USER, 'r1', 'luna', 1, 'r1-kid')
        # the default front of boss's pile (its last retiree) holds a pile of
        # its own, known only after the first round selects it: a second round
        org.hire(ledger.USER, 'r3', 'luna', 1, 'r3-kid')
        for nid in ('root-r1', 'root-r2', 'r1', 'r2', 'r3', 'a-r1', 'a-r2', 'a-r3', 'x-r1', 'x-r2',
                    'r1-kid', 'r3-kid'):
            org.nodes[nid]['state'] = 'archived'
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.client = TestClient(TokenGate(api.app, 'fg-piles'))
        self.headers = {'X-Orgtree-Desktop-Token': 'fg-piles', 'Accept-Encoding': 'identity'}
        self.base = f'/api/orgs/{self.slug}/foreground-tree'
        foreground_cache._cache.clear()
        self.addCleanup(foreground_cache._cache.clear)

    def http(self, url):
        with patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: ('fixed',)):
            response = self.client.get(url, headers=self.headers)
        self.assertEqual(response.status_code, 200, (url, response.text))
        return response.json()

    def snapshot(self, include=(), fronts=None):
        query = [('include', nid) for nid in sorted(set(include))]
        if fronts is not None:
            query += [('piles', '1'), ('fronts', json.dumps(fronts))]
        suffix = '&'.join(f'{k}={quote(v, safe="")}' for k, v in query)
        return self.http(self.base + ('?' + suffix if suffix else ''))

    def paged(self, include=(), fronts=None):
        """The old renderer plan: first/last child pages per visible pile."""
        fronts = fronts or {}
        requested = set(include) | set(fronts.values())
        answer = self.snapshot(requested)
        resolved, pages = set(), 0
        while True:
            for parent in [p for p in visible_parents(answer, fronts) if p not in resolved]:
                resolved.add(parent)
                first = self.http(f'{self.base}/children?parent={quote(parent, safe="")}&limit=1')
                requested.update(first['matches'])
                saved = answer['nodes'].get(fronts.get(parent, ''))
                if (not saved or saved['axis'] != 'org' or saved['state'] != 'archived'
                        or (saved['parent'] or '') != parent):
                    last = self.http(f'{self.base}/children?parent={quote(parent, safe="")}&limit=1&edge=last')
                    requested.update(last['matches'])
                pages += 1
            answer = self.snapshot(requested)
            if all(p in resolved for p in visible_parents(answer, fronts)):
                return answer, pages

    def same(self, fronts=None, include=(), label=''):
        old, pages = self.paged(include, fronts)
        # the renderer always sends the saved fronts as protected includes too
        new = self.snapshot(set(include) | set((fronts or {}).values()), fronts or {})
        self.assertGreater(pages, 0, label + ': the old plan paged nothing, so this compares nothing')
        for key in ('roots', 'nodes', 'header', 'catalog_revision'):
            self.assertEqual(new[key], old[key], f'{label}: {key}')
        return new

    def test_one_read_selects_exactly_what_the_paged_plan_selected(self):
        new = self.same(label='default fronts')
        self.assertIn('x-r2', new['nodes'])
        self.assertIn('x-r1', new['nodes'])
        self.assertIn('r3-kid', new['nodes'], 'the fixed point reached the pile under a default front')
        self.assertNotIn('r1-kid', new['nodes'], 'a pile member that is not the front shows no subtree')

    def test_saved_fronts_and_a_stale_saved_front(self):
        self.same({'boss': 'r2'}, label='saved front')
        self.same({'boss': 'r1'}, label='front with a subtree')
        self.same({'a': 'gone', '': 'root-r1'}, label='stale and root fronts')
        self.same({'boss': 'a'}, label='a live row is no front')

    def test_saved_front_with_a_later_sibling_included(self):
        # boss's retired rows in view: r1 (first), r2 (saved front), r3 (explicit
        # include). The front must be r2, so r3's own pile (r3-kid) stays hidden.
        new = self.same({'boss': 'r2'}, include=['r3'], label='saved front before an included later sibling')
        self.assertNotIn('r3-kid', new['nodes'])

    def test_saved_front_that_belongs_to_another_parent(self):
        # a-r1 is a retiree of `a`, not of boss: boss still needs its default front
        new = self.same({'boss': 'a-r1'}, label='front of another parent')
        self.assertIn('r3', new['nodes'])

    def test_reordering_retirees_moves_the_default_front(self):
        # only the order changes: the catalog moves, so the warm answer rebuilds
        self.snapshot(fronts={})
        org = store.load_org(self.slug)
        org.nodes['r1']['ui_order'] = 99
        store.save_org(org)
        warm = self.snapshot(fronts={})
        foreground_cache._cache.clear()
        cold = self.snapshot(fronts={})
        self.assertIn('r1-kid', cold['nodes'], 'probe inert: r1 did not become the default front')
        self.assertEqual(warm['nodes'], cold['nodes'])

    def test_explicit_includes_travel_with_the_piles(self):
        self.same(include=['a-r2', 'r1-kid'], label='includes')

    def test_hidden_retirees_select_no_piles(self):
        plain = self.snapshot()
        # only live rows and their ancestors (a-r3 holds live x)
        self.assertEqual({nid for nid, row in plain['nodes'].items() if row['state'] == 'archived'}, {'a-r3'})

    def test_warm_piles_answer_equals_a_cold_build_after_writes(self):
        self.snapshot(fronts={})
        # a catalog write: a new retiree becomes boss's pile's last row
        org = store.load_org(self.slug)
        org.hire(ledger.USER, 'boss', 'luna', 1, 'r4')
        store.save_org(org)
        org = store.load_org(self.slug)
        org.nodes['r4']['state'] = 'archived'
        store.save_org(org)
        warm = self.snapshot(fronts={})
        foreground_cache._cache.clear()
        self.assertEqual(warm, self.snapshot(fronts={}))
        self.assertIn('r4', warm['nodes'], 'the new last retiree is the default front')
        # a status write (no catalog change): the delta path keeps the piles
        org = store.load_org(self.slug)
        org.nodes['x']['last_status'] = {'status': 'working', 'summary': 'moved'}
        store.save_org(org)
        warm = self.snapshot(fronts={})
        foreground_cache._cache.clear()
        self.assertEqual(warm['nodes'], self.snapshot(fronts={})['nodes'])

    def test_fronts_are_part_of_the_cached_answer(self):
        default = self.snapshot(fronts={})
        saved = self.snapshot(['r2'], fronts={'boss': 'r2'})
        self.assertNotEqual(set(default['nodes']), set(saved['nodes']))
        self.assertIn('r2', saved['nodes'])
        self.assertNotIn('r2', default['nodes'])
        self.assertIn('r3', default['nodes'])
        self.assertNotIn('r3', saved['nodes'], 'a valid saved front replaces the default front')

    def test_bad_fronts_are_refused(self):
        for suffix in ('?piles=1&fronts=%5B%5D', '?piles=1&fronts=nope', '?fronts=%7B%7D',
                       '?piles=1&fronts=' + quote(json.dumps({'boss': ''}))):
            with patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: ('fixed',)):
                self.assertEqual(self.client.get(self.base + suffix, headers=self.headers).status_code, 400, suffix)

    def test_edges_are_read_in_one_statement_per_round(self):
        statements = []
        real = foreground_store._pile_edges

        def counted(raw, ids, fronts):
            execute = raw.execute

            class Counting:
                def execute(self, sql, *args):
                    if 'unnest(' in sql:
                        statements.append(sql)
                    return execute(sql, *args)
            return real(Counting(), ids, fronts)
        with patch.object(foreground_store, '_pile_edges', side_effect=counted):
            self.snapshot(fronts={})
        self.assertEqual(len(statements), 2, 'two rounds (the pile under a front), one edge statement each')


if __name__ == '__main__':
    unittest.main()
