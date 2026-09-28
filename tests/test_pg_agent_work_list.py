"""The agent's `orgtree_work list` from the PG docket index equals Org.work_list.

agent-orgtree-work-list-still-reads-the-whole-or: the tool used to answer from
`store.cached_org`, a whole-org snapshot. The oracle here is the canonical
ledger on the complete raw data, for every viewer role and argument shape.
"""
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import test_pgstore as f
import test_pg_work_read as fixture
from orgtree import api, store, worklist, workrows
from orgtree.ledger import USER, LedgerError


def tearDownModule():
    f.tearDownModule()


def _stamp(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class AgentList(unittest.TestCase):
    tearDown = fixture.Counts.tearDown
    add = fixture.Counts.add
    refresh = fixture.Counts.refresh
    asks = fixture.Counts.asks

    #: self (a), ancestor (b), participant (c), reviewer (d), unrelated (e)
    VIEWERS = ('a', 'b', 'c', 'd', 'e')
    SHAPES = ({}, {'include_archived': True}, {'include_backlogged': True},
              {'include_archived': True, 'include_backlogged': True},
              {'projection': 'full'}, {'projection': 'compact'}, {'compact': True},
              {'fields': ['status', 'candidate', 'parent', 'dependencies']},
              {'fields': 'slug,title'})

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        fixture.Counts.setUp(self)
        org = store.load_org(self.slug)
        for nid in ('d', 'e'):
            org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': []}
        store.save_org(org)
        # the second load normalises the new nodes (seat_id), as _fresh_org does
        store.save_org(store.load_org(self.slug))
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"live\"')::text")
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{parent}}','\"b\"')::text WHERE id='a'")

    def item(self, slug, owner='a', **kw):
        org = store.load_org(self.slug)
        it = org.work_create(owner, 'Agent list ' + slug, 'Description of ' + slug)['created']
        row = dict(org._work_find(it)[0])
        row.update(slug=slug, owner={'node': owner, 'generation': 0}, **kw)
        return row

    def docket(self):
        packet = {'candidate': 'abc1234', 'note': 'look'}
        old = _stamp(self.now - 7200)
        self.add(self.item('hidden', owner='e', created_by={'node': 'e'}))
        self.add(self.item('one', participants=['c'], parent='hidden',
                           dependencies=['hidden', 'rev'], docket_at=_stamp(self.now - 5),
                           delivery={'committed': {'ref': 'abc1234'}},
                           review_packet=packet, review_packets=[packet],
                           artifacts=[{'id': 'artifact-1', 'name': 'secret.txt',
                                       'scope': 'named', 'grants': []}]))
        self.add(self.item('rev', owner='c', created_by={'node': 'c'}, status='review',
                           reviewer={'node': 'd', 'generation': 0}, docket_at=_stamp(self.now - 5)))
        self.add(self.item('backlog', status='backlogged'))
        self.add(self.item('flagged', status='backlogged', manual_attention={'reason': 'look'}))
        self.add(self.item('closed', status='done', docket_at=old, updated_at=old, status_at=old))
        self.add(self.item('old', status='done', docket_at=old), True)
        self.add(self.item('archive', status='done'), True)
        self.add(self.item('secret-old', owner='e', created_by={'node': 'e'}, status='done'), True)
        self.asks()
        self.refresh()

    def oracle(self, viewer, kw):
        kw = dict(kw)
        kw.setdefault('projection', 'summary')
        out = store.load_org(self.slug).work_list(viewer, now_ts=self.now, **kw)
        out.pop('now')
        return out

    def indexed(self, viewer, kw):
        kw = dict(kw)
        kw.setdefault('projection', 'summary')
        with patch.object(store, 'load_org', side_effect=AssertionError('whole load')), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole cache')):
            out = worklist.agent_list(self.slug, viewer, now_ts=self.now, **kw)
        self.assertIsNotNone(out, 'the indexed reader fell back')
        out.pop('now')
        return out

    def test_every_role_and_shape_equals_the_ledger(self):
        self.docket()
        for viewer in self.VIEWERS:
            for kw in self.SHAPES:
                with self.subTest(viewer=viewer, kw=kw):
                    self.assertEqual(self.indexed(viewer, kw), self.oracle(viewer, kw))

    def test_the_fixture_exercises_what_it_claims(self):
        # a surprising pass is only worth something if the control ran
        self.docket()
        out = self.indexed('a', {'include_archived': True, 'include_backlogged': True})
        names = {g: [r['slug'] for r in out[g]] for g in ('items', 'archived', 'backlogged')}
        self.assertEqual(sorted(names['items']), ['archive', 'flagged', 'one'])
        self.assertEqual(sorted(names['archived']), ['closed', 'old'])
        self.assertEqual(names['backlogged'], ['backlog'])
        one = next(r for r in out['items'] if r['slug'] == 'one')
        self.assertIsNone(one['parent'])
        self.assertFalse(one['parent_visible'])
        self.assertEqual(one['candidate']['sha'], 'abc1234')
        full = self.indexed('a', {'projection': 'full'})
        one = next(r for r in full['items'] if r['slug'] == 'one')
        self.assertEqual(one['dependencies'][0], {'visible': False})
        self.assertIn('review_packets_newest_same_as', one)
        self.assertEqual(one['artifacts'], [{'visible': False, 'scope': 'named'}])
        for viewer, served in (('b', 6), ('c', 2), ('d', 1), ('e', 2)):
            got = self.indexed(viewer, {'include_archived': True, 'include_backlogged': True})
            with self.subTest(viewer=viewer):
                self.assertEqual(sum(len(got[g]) for g in ('items', 'archived', 'backlogged')), served)
        self.assertEqual(self.indexed('e', {})['groups']['archived']['count'], 1)
        self.assertEqual(self.indexed('c', {})['groups']['archived']['count'], 0)

    def test_statements_do_not_grow_with_the_readable_items(self):
        # one read per location, whatever the list holds: no per-item body,
        # question, scope, pointer or actor statement
        import test_worklist_statements_pg as st
        self.docket()
        totals = []
        for more in (0, 12):
            with self.c.transaction():
                for n in range(more):
                    self.add(self.item(f'more-{n}', participants=['c', f'gone-{n}'],
                                       dependencies=['rev', f'more-{n - 1}'], parent='one', scope_logged=0,
                                       history=[{'op': 'move', 'from': 'one', 'to': 'hidden'}]))
                self.add(self.item(f'old-{more}', status='done'), True)
            self.refresh()
            with st._Count() as count:
                self.indexed('a', {'include_archived': True, 'projection': 'full'})
            totals.append(count.total)
        self.assertEqual(totals[0], totals[1])

    def test_refusals_equal_the_ledger(self):
        self.docket()
        for kw in ({'fields': ['not_a_field']}, {'fields': 17}, {'projection': 'bogus'}):
            with self.subTest(kw=kw):
                with self.assertRaises(LedgerError) as old:
                    self.oracle('a', kw)
                with self.assertRaises(LedgerError) as new:
                    self.indexed('a', kw)
                self.assertEqual(str(new.exception), str(old.exception))
        self.c.execute(f"UPDATE {self.s}.nodes SET val=jsonb_set(val::jsonb,'{{state}}','\"retired\"')::text WHERE id='c'")
        self.refresh()
        with self.assertRaisesRegex(LedgerError, 'not live'):
            worklist.agent_list(self.slug, 'c', now_ts=self.now)

    def test_operator_dirty_index_and_disagreement_fall_back(self):
        self.docket()
        self.assertIsNone(worklist.agent_list(self.slug, USER, now_ts=self.now))
        self.add(self.item('late'))
        self.assertIsNone(worklist.agent_list(self.slug, 'a', now_ts=self.now))
        self.refresh()
        self.assertIsNotNone(worklist.agent_list(self.slug, 'a', now_ts=self.now))
        with patch.object(worklist.AgentContext, '_work_archived', return_value=True):
            self.assertIsNone(worklist.agent_list(self.slug, 'a', now_ts=self.now))
        self.assertIsNotNone(worklist.agent_list(self.slug, 'a', now_ts=self.now))
        # a body that is not the one the index stamped is never served
        # (triggers off, so the index keeps the old stamp)
        with self.c.transaction():
            self.c.execute("SET LOCAL session_replication_role=replica")
            self.c.execute(f"UPDATE {self.s}.doc SET val=jsonb_set(val::jsonb,'{{title}}','\"changed\"')::text "
                           "WHERE key=%s", (workrows.PREFIX + 'one',))
        self.assertIsNone(worklist.agent_list(self.slug, 'a', now_ts=self.now))

    def test_agent_tool_serves_the_index_and_keeps_the_exact_fallback(self):
        self.docket()
        call = api.AgentCall(org=self.slug, node='a', tool='orgtree_work', args={})
        args = {'action': 'list', 'include_backlogged': True}
        with patch.object(store, 'load_org', side_effect=AssertionError('whole load')), \
                patch.object(store, 'cached_org', side_effect=AssertionError('whole cache')):
            served = api._work_read_call(call, args)
        with patch.object(worklist, 'agent_list', return_value=None), \
                patch.object(store, 'cached_org', wraps=store.cached_org) as legacy:
            fallback = api._work_read_call(call, args)
            self.assertEqual(legacy.call_count, 1)
        served.pop('now'); fallback.pop('now')
        self.assertEqual(served, fallback)
        self.assertEqual(served['items'][0]['ref'], fallback['items'][0]['ref'])


if __name__ == '__main__':
    unittest.main()
