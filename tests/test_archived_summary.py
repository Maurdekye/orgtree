"""§4.8 — an archived seat travels as a summary, its detail on request.

The tree payload is what the desk repaints from, and the app refetches all of
it on every lifecycle operation and every 6 s heartbeat. MEASURED 2026-09-11 on
the operator's org: 1,281,721 bytes, of which 242 archived seats were 1,232,054
(96%) and the two live ones 18,478 — for a screen that draws those 242 as one
collapsed pile badge. About 11 MB per 30 idle seconds.

So `org_tree` now leaves two groups off an archived node: the supervisor-derived
runtime fields, which are constants for a seat with no turn and no process, and
the per-seat detail only an OPENED seat needs. `GET …/nodes/{nid}/detail`
answers the whole node.

THE LOAD-BEARING TEST IS `test_summary_plus_detail_is_the_whole_node`. Dropping
a field from a payload is easy; dropping one nobody notices until a card renders
blank is the failure mode. So the assertion is a KEY-SET IDENTITY against a live
seat's own entry: whatever the tree carries for a live node must be reachable
for an archived one, either in its summary or in its detail. A field that falls
out of both lists fails it, which is the only way this can be got wrong quietly.
"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix='v2-archived-summary-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    raise unittest.SkipTest(
        'store.DATA_ROOT already bound elsewhere in this process; '
        'run this file on its own (see tests/test_lazydoc_bool.py)')

from orgtree import api  # noqa: E402

_SLUGS = []


def tearDownModule():
    for slug in list(_SLUGS):
        store._POOL.close_all(slug)
    _root.cleanup()


class _Req:
    def __init__(self):
        self.state = types.SimpleNamespace()
        self.headers = {}
        self.url = types.SimpleNamespace(path='/api/orgs/x')


class ArchivedSummaryTests(unittest.TestCase):

    def setUp(self):
        org = store.create_org('Archived ' + self._testMethodName[:24])
        store.save_org(org)
        self.slug = org.d['slug']
        _SLUGS.append(self.slug)
        o = store.load_org(self.slug)
        o.hire(USER, None, 'haiku', 0, 'boss', charter='the live one\nsecond line')
        o.hire(USER, 'boss', 'haiku', 0, 'gone',
               charter='retired seat\nwith a second line and more text')
        o.hire(USER, 'boss', 'haiku', 0, 'kid', charter='a child of the retired one')
        store.save_org(o)
        o = store.load_org(self.slug)
        n = o.nodes['gone']
        n['turns'] = [{'at': f'2026-01-0{i + 1}T00:00:00Z', 'cost': 0.1, 'n': i}
                      for i in range(8)]
        n['last_status'] = {'status': 'done', 'summary': 'finished the thing'}
        n['prev_status'] = {'status': 'working', 'summary': 'was doing it'}
        n['team_charter'] = 'the team standing order'
        # a presented document, so the card's presentation controls have
        # something to be gated on — they read `documents` AS THE CARD RENDERS.
        # Appended to the doc rather than presented through `present_document`,
        # which gates on a user audience this fixture's seats do not hold.
        o.d.setdefault('documents', []).append(
            {'id': 'doc1', 'node': 'gone', 'title': 'a paper',
             'at': '2026-01-09T00:00:00Z', 'body': 'the body of the paper'})
        o.retire(USER, 'kid')
        o.retire(USER, 'gone')
        store.save_org(o)

    def tree(self):
        return api.org_tree(self.slug, _Req())

    def nodes(self, tree):
        out = {}

        def walk(ns):
            for n in ns:
                out[n['id']] = n
                walk(n.get('children') or [])

        walk(tree['roots'])
        return out

    # -- the contract -----------------------------------------------------
    def test_summary_plus_detail_is_the_whole_node(self):
        ns = self.nodes(self.tree())
        live, arch = ns['boss'], ns['gone']
        self.assertEqual(live['state'], 'live')
        self.assertEqual(arch['state'], 'archived')
        detail = api.org_node_detail(self.slug, 'gone', _Req())
        # the summary's own markers stand for fields rather than being them,
        # so they are not allowed to satisfy this identity; `children` is
        # deliberately absent from a detail answer
        reachable = (set(arch) | set(detail)) - {
            'charter_line', 'detail', 'lineage_count', 'read_only',
            'detail_rev'}
        expected = set(live)
        self.assertEqual(
            expected - reachable, set(),
            'these fields are on a LIVE node but reachable on neither the '
            'archived summary nor its detail — a card that renders one of '
            'them would render blank')

    def test_the_omitted_fields_really_are_omitted(self):
        arch = self.nodes(self.tree())['gone']
        for f in api._ARCHIVED_RUNTIME_FIELDS + api._ARCHIVED_DETAIL_FIELDS:
            self.assertNotIn(f, arch, f'{f} is still riding the tree payload')
        self.assertIs(arch['detail'], False)

    def test_a_live_node_is_untouched(self):
        live = self.nodes(self.tree())['boss']
        for marker in ('detail', 'charter_line', 'lineage_count', 'read_only',
                       'detail_rev'):
            self.assertNotIn(marker, live,
                             f'{marker} is a SUMMARY marker and has no business '
                             f'on a live seat, which carries the real fields')
        for f in api._ARCHIVED_RUNTIME_FIELDS + api._ARCHIVED_DETAIL_FIELDS:
            if f == 'last_approvals':
                # conditionally present by design: `Org.tree()` omits it
                # entirely when the lane cannot report approvals, because a
                # `[]` there would read as "the seam ran and approved nothing"
                continue
            self.assertIn(f, live, f'{f} vanished from a LIVE node')
        self.assertEqual(live['charter'], 'the live one\nsecond line')

    # -- what the tray draws must survive ---------------------------------
    def test_the_tray_fields_stay_on_the_summary(self):
        arch = self.nodes(self.tree())['gone']
        self.assertEqual(arch['last_status']['summary'], 'finished the thing')
        self.assertEqual(arch['prev_status']['summary'], 'was doing it')
        self.assertEqual(arch['charter_line'], 'retired seat')
        # the row reads turns[turns.length - 1]; one is all it can use
        self.assertEqual(len(arch['turns']), 1)
        self.assertEqual(arch['turns'][0]['n'], 7)
        for f in ('id', 'title', 'tier', 'state', 'seat', 'grant',
                  'occupancy', 'context_window', 'pending_switch', 'frozen'):
            self.assertIn(f, arch, f'the tray needs {f}')

    def test_every_archived_seat_is_summarised_wherever_it_sits(self):
        """Retiring a seat reparents its reports, so an archived node can turn
        up anywhere in the walk. The reduction has to follow the node, not the
        position — a summary applied only at the top level would leave the
        deeper ones full and the payload unchanged."""
        ns = self.nodes(self.tree())
        archived = {k: v for k, v in ns.items() if v['state'] == 'archived'}
        self.assertEqual(set(archived), {'gone', 'kid'})
        for nid, n in archived.items():
            self.assertIs(n['detail'], False, f'{nid} was not summarised')
            self.assertNotIn('charter', n)
        self.assertIn('boss', ns)          # the live parent still nests them

    # -- the detail answer -------------------------------------------------
    def test_detail_carries_the_full_values(self):
        d = api.org_node_detail(self.slug, 'gone', _Req())
        self.assertEqual(d['charter'],
                         'retired seat\nwith a second line and more text')
        self.assertEqual(d['team_charter'], 'the team standing order')
        self.assertEqual(len(d['turns']), 8)
        self.assertIn('scope', d)
        self.assertIn('lineage', d)
        self.assertEqual(d['children'], [])
        self.assertNotIn('detail', d)

    def test_detail_of_a_live_node_matches_its_tree_entry(self):
        """The detail endpoint is not a second rendering: for a node the tree
        already carries whole, both answers must agree field for field."""
        live = self.nodes(self.tree())['boss']
        d = api.org_node_detail(self.slug, 'boss', _Req())
        for k, v in d.items():
            if k in ('children', 'activity'):
                continue        # children blanked by design; activity is a clock
            self.assertEqual(v, live[k], f'detail disagrees with the tree on {k}')

    # -- stale and missing -------------------------------------------------
    def test_a_node_that_is_gone_is_a_404_not_a_blank(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as caught:
            api.org_node_detail(self.slug, 'never-existed', _Req())
        self.assertEqual(caught.exception.status_code, 404)

    def test_a_node_deleted_after_the_tree_listed_it_is_a_404(self):
        self.assertIn('gone', self.nodes(self.tree()))
        o = store.load_org(self.slug)
        o.delete(USER, 'kid')
        o.delete(USER, 'gone')
        store.save_org(o)
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as caught:
            api.org_node_detail(self.slug, 'gone', _Req())
        self.assertEqual(caught.exception.status_code, 404)

    def test_an_unknown_org_is_a_404(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as caught:
            api.org_node_detail('no-such-org-at-all', 'gone', _Req())
        self.assertEqual(caught.exception.status_code, 404)

    # -- the hydration constants are checked, not asserted ------------------
    def test_every_runtime_default_matches_a_real_full_annotation(self):
        """`archived_defaults` is what the client refills an archived seat's
        omitted runtime fields with. Each one is checked here against what a
        FULL annotation of that same seat actually produces, so a constant that
        is merely plausible fails rather than rendering a wrong card."""
        tree = self.tree()
        defaults = tree['archived_defaults']
        self.assertEqual(set(defaults), set(api._ARCHIVED_RUNTIME_FIELDS))
        detail = api.org_node_detail(self.slug, 'gone', _Req())
        for k, v in defaults.items():
            self.assertIn(k, detail, f'{k} is not a field a full node has')
            self.assertEqual(
                detail[k], v,
                f'archived_defaults[{k!r}] is {v!r} but a full annotation of '
                f'an archived seat produces {detail[k]!r}')

    def test_the_defaults_ride_the_payload_once(self):
        import json
        tree = self.tree()
        self.assertLess(len(json.dumps(tree['archived_defaults'])), 900)

    # -- what a CARD decides while it is being drawn ------------------------
    #
    # Review finding, 2026-09-12. The first cut of §4.8 sent `documents` and
    # `lineage` to the detail endpoint, and a retired agent's card quietly lost
    # its "Open presentations" entry, its presentation button, its doc chips,
    # its "Show lineage" entry and its stacked-card look — because `NodeSquare`
    # renders straight off the tree entry and cannot await a fetch. Every test
    # above passed, because they all asked whether the FIELD was recoverable
    # and none asked what was already reading it. These do.

    def test_the_fields_a_card_reads_directly_stay_on_the_summary(self):
        """`documents` and `session_id` came back OFF the omitted list. They
        feed the card's presentation controls, the gallery's fallback rows and
        the canvas's session-identity map, none of which can wait for a fetch,
        and together they were 14,024 of 1,214,593 archived bytes on the
        operator's org — 1.15%. The saving never justified the breakage."""
        arch = self.nodes(self.tree())['gone']
        for f in ('documents', 'documents_count', 'session_id'):
            self.assertIn(f, arch,
                          f'{f} is read while a card renders and cannot be '
                          f'fetched on demand')
        # and they are real values, not empty husks left by a reducer
        self.assertEqual(arch['documents_count'], 1)
        self.assertEqual([d['title'] for d in arch['documents']], ['a paper'])

    def test_lineage_count_is_the_lineage_it_stands_in_for(self):
        """The card offers "Show lineage" and wears `stack1/2/3` off this
        number. It has to equal what counting the real generations would give,
        or the card and the panel behind it disagree."""
        o = store.load_org(self.slug)
        # a predecessor chain is what `lineage_stack` walks; compaction mints
        # one, and poking the doc is how the rest of this file builds fixtures
        o.nodes['gone']['predecessor'] = 'kid'
        store.save_org(o)
        arch = self.nodes(self.tree())['gone']
        detail = api.org_node_detail(self.slug, 'gone', _Req())
        self.assertEqual(arch['lineage_count'], len(detail['lineage']))
        self.assertEqual(arch['lineage_count'], 1,
                         'positive control: a seat with no predecessor would '
                         'pass the equality above with two zeroes')
        self.assertNotIn('lineage', arch)

    def test_read_only_is_the_scope_it_stands_in_for(self):
        """`scope.tools.edit is False` is the card's dashed `ro-agent` border
        (styles.css). `scope` is 81 KB of the payload and stays omitted, so the
        one bit the card needs travels on its own."""
        o = store.load_org(self.slug)
        o.hire(USER, 'boss', 'haiku', 0, 'ro', charter='a read-only seat',
               tools={'edit': False}, add_dirs=[], org_visibility='full')
        store.save_org(o)
        o = store.load_org(self.slug)
        o.retire(USER, 'ro')
        store.save_org(o)
        ns = self.nodes(self.tree())
        self.assertIs(ns['ro']['read_only'], True)
        self.assertIs(ns['gone']['read_only'], False,
                      'positive control: a seat that CAN edit must read False, '
                      'or the marker is just a constant')
        detail = api.org_node_detail(self.slug, 'ro', _Req())
        self.assertIs(detail['scope']['tools']['edit'], False)
        self.assertNotIn('scope', ns['ro'])

    # -- the detail cache has to be invalidatable --------------------------
    #
    # Review finding, 2026-09-12. The client cached a fetched detail under
    # slug/id/generation and dropped it only after ITS OWN non-GET. Neither
    # part moves when another window — or an agent's retool — edits an
    # archived seat: the tree refreshes, the summary is identical, and an open
    # panel goes on showing the charter it cached. `detail_rev` is the token
    # that moves, and these say what it is allowed to move for.

    def test_detail_rev_is_the_same_token_on_both_answers(self):
        arch = self.nodes(self.tree())['gone']
        detail = api.org_node_detail(self.slug, 'gone', _Req())
        self.assertTrue(arch['detail_rev'])
        self.assertEqual(arch['detail_rev'], detail['detail_rev'],
                         'the summary promises a revision and the detail answer '
                         'has to agree, or a client can never confirm a hit')

    def test_detail_rev_is_stable_while_the_seat_is(self):
        """Positive control for the two tests below: a token that changed on
        every build would pass them and defeat the cache entirely."""
        first = self.nodes(self.tree())['gone']['detail_rev']
        second = self.nodes(self.tree())['gone']['detail_rev']
        self.assertEqual(first, second)

    def test_detail_rev_moves_when_an_omitted_field_changes(self):
        before = self.nodes(self.tree())['gone']['detail_rev']
        o = store.load_org(self.slug)
        o.nodes['gone']['charter'] = 'edited from another window entirely'
        store.save_org(o)
        after = self.nodes(self.tree())['gone']
        self.assertNotEqual(before, after['detail_rev'])
        # and the new charter really is what a fetch would now return
        self.assertEqual(api.org_node_detail(self.slug, 'gone', _Req())['charter'],
                         'edited from another window entirely')

    def test_detail_rev_ignores_what_the_summary_already_carries(self):
        """It covers the OMITTED fields, not the document. A seat whose
        `last_status` changed needs no refetch — that value rode the summary —
        and moving the token for it would throw away a good cache entry on
        every status write, which is most of what a busy org does."""
        before = self.nodes(self.tree())['gone']['detail_rev']
        o = store.load_org(self.slug)
        o.nodes['gone']['last_status'] = {'status': 'done', 'summary': 'moved on'}
        store.save_org(o)
        after = self.nodes(self.tree())['gone']
        self.assertEqual(after['last_status']['summary'], 'moved on')
        self.assertEqual(before, after['detail_rev'])

    def test_detail_rev_covers_every_field_it_is_responsible_for(self):
        """The load-bearing one. A field on the omitted list that the token
        does not hash is a field that can be edited remotely without the cache
        ever noticing — the exact bug this was added for. Asserted over the
        list itself, so adding a field to it cannot quietly skip this."""
        base = {f: None for f in api._ARCHIVED_DETAIL_FIELDS}
        base_rev = api._archived_detail_rev(base)
        for f in api._ARCHIVED_DETAIL_FIELDS:
            moved = dict(base, **{f: 'something else entirely'})
            self.assertNotEqual(
                api._archived_detail_rev(moved), base_rev,
                f'{f} is omitted from the payload but not hashed into '
                f'detail_rev — a remote edit to it would never invalidate')

    # -- the point of the whole exercise -----------------------------------
    def test_the_summary_is_substantially_smaller(self):
        """Positive control for the contract tests above: they would all pass
        against a change that omitted nothing."""
        import json
        arch = self.nodes(self.tree())['gone']
        detail = api.org_node_detail(self.slug, 'gone', _Req())
        summary_bytes = len(json.dumps({k: v for k, v in arch.items()
                                        if k != 'children'}))
        whole_bytes = len(json.dumps({**detail, **{k: v for k, v in arch.items()
                                                   if k != 'children'}}))
        self.assertLess(summary_bytes * 2, whole_bytes,
                        f'summary {summary_bytes} B vs whole {whole_bytes} B — '
                        f'the split is not actually saving anything')


if __name__ == '__main__':
    unittest.main()
