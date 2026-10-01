"""`GET …/nodes/{nid}/detail` (Show lineage, an archived seat's card) builds one
node, not the whole tree.

The detail answer is one tree entry, but the route used to build `org.tree()`
for every node plus the header (docket counts) and then pick one out: ~45 ms
idle on a copy of the live org (480 reachable nodes), more under load, and
reported by the user as a 1-2 s "Show lineage" open. It now builds
`tree_node(nid, descend=False)` after checking the node is reachable on the
org axis. These tests pin that the answer is the same as the full-tree path
for every node — including the ids the full walk does not reach, which must
stay 404 — and that the full tree is not built.
"""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-node-detail-single-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from fastapi import HTTPException  # noqa: E402
from orgtree import api, store  # noqa: E402
from orgtree.ledger import USER, Org  # noqa: E402

_SLUGS = []


def tearDownModule():
    for slug in list(_SLUGS):
        store._POOL.close_all(slug)


class _Req:
    def __init__(self):
        self.state = types.SimpleNamespace()
        self.headers = {}
        self.url = types.SimpleNamespace(path='/api/orgs/x')


def full_tree_detail(slug, nid):
    """The route as it was: the whole tree, then one entry picked out."""
    org = store.cached_org(slug)
    return api._annotate_org_view(org, org.tree(), _Req(), nid)


def outcome(fn, slug, nid):
    try:
        row = {k: v for k, v in fn(slug, nid).items() if k != 'cache_forecast'}
        return 'ok', json.dumps(row, sort_keys=True, default=str)
    except HTTPException as e:
        return 'http', e.status_code, e.detail


def new_detail(slug, nid):
    return api.org_node_detail(slug, nid, _Req())


class NodeDetailSingle(unittest.TestCase):
    def setUp(self):
        org = store.create_org('Detail ' + self._testMethodName[:24])
        store.save_org(org)
        self.slug = org.d['slug']
        _SLUGS.append(self.slug)
        o = store.load_org(self.slug)
        o.hire(USER, None, 'haiku', 0, 'boss', charter='the live one')
        o.hire(USER, 'boss', 'haiku', 0, 'gone', charter='a retired seat')
        o.hire(USER, 'gone', 'haiku', 0, 'kid', charter='child of the retired one')
        o.hire(USER, 'boss', 'haiku', 0, 'aide', charter='a live report')
        o.hire(USER, None, 'haiku', 0, 'solo', charter='a second root')
        store.save_org(o)
        o = store.load_org(self.slug)
        o.retire(USER, 'kid')
        o.retire(USER, 'gone')
        # an archived predecessor with a successor steps off the org axis
        # (`org_children`), and so does everything below it
        pred = json.loads(json.dumps(o.nodes['aide']))
        pred.update(id='aide@1', state='archived', successor='aide', generation=0)
        o.d['nodes']['aide@1'] = pred
        under = json.loads(json.dumps(o.nodes['kid']))
        under.update(id='under-pred', parent='aide@1')
        o.d['nodes']['under-pred'] = under
        o.nodes['aide']['generation'] = 1
        o.nodes['aide']['predecessor'] = 'aide@1'
        store.save_org(o)

    def ids(self):
        return list(store.load_org(self.slug).nodes) + ['no-such-node']

    def test_every_node_matches_the_full_tree_path(self):
        results = {nid: outcome(new_detail, self.slug, nid) for nid in self.ids()}
        for nid, got in results.items():
            self.assertEqual(got, outcome(full_tree_detail, self.slug, nid), nid)
        # the control: both kinds of answer are exercised
        self.assertEqual(results['boss'][0], 'ok')
        self.assertEqual(results['gone'][0], 'ok')          # archived, on the axis
        self.assertEqual(results['kid'][0], 'ok')           # below an archived seat
        self.assertEqual(results['aide@1'][:2], ('http', 404))
        self.assertEqual(results['under-pred'][:2], ('http', 404))
        self.assertEqual(results['no-such-node'][:2], ('http', 404))

    def test_the_whole_tree_is_not_built(self):
        with patch.object(Org, 'tree', side_effect=AssertionError('whole tree built')), \
                patch.object(Org, 'tree_header', side_effect=AssertionError('header built')):
            for nid in ('boss', 'gone', 'kid', 'solo'):
                self.assertEqual(new_detail(self.slug, nid)['id'], nid)

    def test_archived_detail_keeps_its_revision_token(self):
        self.assertIn('detail_rev', new_detail(self.slug, 'gone'))
        self.assertNotIn('detail_rev', new_detail(self.slug, 'boss'))
        self.assertEqual(new_detail(self.slug, 'boss')['children'], [])

    def test_a_parent_cycle_is_404_not_a_hang(self):
        o = store.load_org(self.slug)
        o.nodes['boss']['parent'] = 'aide'
        store.save_org(o)
        for nid in ('boss', 'aide'):
            self.assertEqual(outcome(new_detail, self.slug, nid)[:2], ('http', 404))
            self.assertEqual(outcome(new_detail, self.slug, nid),
                             outcome(full_tree_detail, self.slug, nid))


if __name__ == '__main__':
    unittest.main()
