"""Snapshot protocol controls independent of the tree's body producers."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
import json

from orgtree.orgdb import record_reads as Q
from orgtree.orgdb.record_registry import Entity, Registry, Selection, Snapshot, ScopeResult


class Raw:
    def __init__(self,changed):
        self.changed,self.calls = changed,[]

    def execute(self,sql,params):
        self.calls.append((sql,params))
        return self

    def fetchall(self):
        return self.changed


class Reads(unittest.TestCase):
    def setUp(self):
        self.raw = Raw([])
        self.state = Snapshot(self.raw,'org',dict(org_uuid='uuid',incarnation='inc',
            org_revision=8,floor=3),123.0)
        self.built = []
        self.registry = Registry()
        def members(state,selection):
            self.assertIs(state,self.state)
            return frozenset(('1','2') if selection.set == 'shared' else selection.agents)
        def bodies(state,ids):
            self.assertIs(state,self.state)
            self.built.append(ids)
            return {key:dict(name='node'+key) for key in ids}
        self.registry.register(Entity('agent',members,bodies))

    def test_shared_baseline_and_unchanged_subscription_need_no_change_log_or_commit(self):
        baseline = Q.baseline(self.registry,self.state)
        self.assertEqual(baseline['cursor'],dict(org_uuid='uuid',incarnation='inc',rev=8))
        self.assertEqual({r['id'] for r in baseline['records']},{'1','2'})
        answer = Q.subscribed(self.registry,self.state,Selection('sub:7',('2','9')))
        self.assertEqual(answer['sub'],7)
        self.assertEqual(answer['rev'],8)
        self.assertEqual({r['set'] for r in answer['records']},{'sub:7'})
        self.assertEqual(self.raw.calls,[])

    def test_reset_identity_floor_and_future_cursor_before_selecting_or_building(self):
        for after in (Q.Cursor('other','inc',8),Q.Cursor('uuid','replaced',1),
                      Q.Cursor('uuid','inc',2),Q.Cursor('uuid','inc',9)):
            self.assertEqual(Q.catchup(self.registry,self.state,after),{'type':'record_reset'})
        self.assertEqual(self.built,[])
        self.assertEqual(self.raw.calls,[])

    def test_equal_cursor_is_empty_and_does_not_read_sources(self):
        answer = Q.catchup(self.registry,self.state,Q.cursor(self.state))
        self.assertEqual((answer['from'],answer['to']),(8,8))
        self.assertEqual(answer['upserts'],[])
        self.assertEqual(answer['tombstones'],[])
        self.assertEqual(self.raw.calls,[])
        self.assertEqual(self.built,[])

    def test_overlap_is_built_once_but_upserts_and_tombstones_keep_each_set(self):
        self.raw.changed = [('agent','1'),('agent','2'),('agent','9'),('agent','gone')]
        selections = (Selection(),Selection('sub:4',('2','9')))
        answer = Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),selections=selections)
        self.assertEqual(self.built,[frozenset(('1','2','9'))])
        self.assertEqual({(r['set'],r['id']) for r in answer['upserts']},
                         {('shared','1'),('shared','2'),('sub:4','2'),('sub:4','9')})
        self.assertIn(dict(entity='agent',id='9',set='shared'),answer['tombstones'])
        self.assertIn(dict(entity='agent',id='1',set='sub:4'),answer['tombstones'])
        sql,params = self.raw.calls[0]
        self.assertIn("c.entity<>'~scope'",sql)
        self.assertEqual(params,(4,8,2001))

    def test_wildcard_expands_all_current_sets_and_bound_counts_distinct_records(self):
        self.raw.changed = [('agent','*')]
        selections = (Selection(),Selection('sub:4',('2','9')))
        answer = Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),
                           selections=selections,bound=3)
        self.assertEqual(len(answer['upserts']),4)
        self.assertEqual(self.built,[frozenset(('1','2','9'))])
        self.built.clear()
        self.assertEqual(Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),
            selections=selections,bound=2),{'type':'record_reset'})
        self.assertEqual(self.built,[])

    def test_change_bound_and_bulk_marker_reset_without_building_bodies(self):
        for changed in ([('agent','1'),('agent','2')],[('reset','*')]):
            self.raw.changed = changed
            self.assertEqual(Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),bound=1),
                             {'type':'record_reset'})
        self.assertEqual(self.built,[])

    def test_missing_membership_body_fails_instead_of_silently_dropping_a_record(self):
        registry = Registry()
        registry.register(Entity('broken',lambda state,selection:frozenset(('7',)),
                                 lambda state,ids:{}))
        with self.assertRaisesRegex(RuntimeError,'membership/body'):
            Q.baseline(registry,self.state)

    def test_subscription_input_is_declarations_only_and_bounded_per_set(self):
        selected = Q.subscriptions([dict(sub=4,agents=['1','2','1'],windows=[]),dict(sub=5)])
        self.assertEqual(selected[0],Selection('sub:4',('1','2')))
        invalid = (None,[dict(sub=True)],[dict(sub=-1)],[dict(sub=1),dict(sub=1)],
                   [dict(sub=1,agents=['dev'])],[dict(sub=1,agents=['01'])],
                   [dict(sub=1,agents=['1',2])],[dict(sub=1,windows=['history'])],
                   [dict(sub=1,previous_members=['7'])],
                   [dict(sub=1,agents=[str(n) for n in range(1,130)])])
        for args in invalid:
            with self.subTest(args=args),self.assertRaises(ValueError):
                Q.subscriptions(args)

    def test_300_includes_split_into_bounded_declarations_are_accepted(self):
        args = [dict(sub=n//128+1,agents=[str(i+1) for i in range(n,min(n+128,300))])
                for n in range(0,300,128)]
        selections = Q.subscriptions(args)
        self.assertEqual([len(s.agents) for s in selections],[128,128,44])
        self.assertEqual(len({a for s in selections for a in s.agents}),300)

    def test_paged_subscription_is_same_snapshot_and_not_the_catchup_bound(self):
        ids = tuple(str(i+1) for i in range(300))
        registry = Registry()
        registry.register(Entity('agent',lambda state,s:frozenset(ids),
            lambda state,wanted:{key:dict(name=key) for key in wanted}))
        pages = Q.subscribed_pages(registry,self.state,Selection('sub:9'),page_records=128)
        self.assertEqual([len(p['records']) for p in pages],[128,128,44])
        self.assertEqual([p['page'] for p in pages],[0,1,2])
        self.assertEqual([p['final'] for p in pages],[False,False,True])
        self.assertEqual({(p['sub'],p['rev'],p['org_uuid'],p['incarnation']) for p in pages},
                         {(9,8,'uuid','inc')})
        self.assertEqual({r['id'] for p in pages for r in p['records']},set(ids))
        self.raw.changed = [('agent',key) for key in ids]
        self.assertEqual(Q.catchup(registry,self.state,Q.Cursor('uuid','inc',4),bound=2),
                         {'type':'record_reset'})
        empty = Q.subscribed_pages(self.registry,self.state,Selection('sub:10'))
        self.assertEqual(len(empty),1)
        self.assertEqual((empty[0]['page'],empty[0]['final'],empty[0]['records']),(0,True,[]))

    def test_pages_limit_actual_escaped_wire_bytes_as_well_as_record_count(self):
        registry = Registry()
        ids = tuple(str(i+1) for i in range(20))
        registry.register(Entity('agent',lambda state,s:frozenset(ids),
            lambda state,wanted:{key:dict(text='\U0001f600\ud800'*100) for key in wanted}))
        pages = Q.subscribed_pages(registry,self.state,Selection('sub:9'),page_bytes=4096)
        self.assertGreater(len(pages),1)
        self.assertEqual(sum(len(page['records']) for page in pages),20)
        for page in pages:
            wire = json.dumps(page,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('utf-8')
            self.assertLessEqual(len(wire),4096)
            self.assertEqual(json.loads(wire),page)

    def test_read_scope_replaces_whole_subscriptions_and_batches_overlapping_bodies_once(self):
        self.raw.changed = [('~scope','subtree:6'),('agent','2')]
        def affected(state,roots,held):
            self.assertIs(state,self.state)
            self.assertEqual(roots,frozenset(('6',)))
            self.assertEqual(held['sub:4']['agent'],frozenset(('2','9')))
            return ScopeResult(frozenset((('agent','2'),('agent','9'))),frozenset(('sub:4',)))
        self.registry.register_scope('subtree',affected)
        answer = Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),
            selections=(Selection(),Selection('sub:4',('2','9'))))
        self.assertEqual(self.built,[frozenset(('2','9'))])
        self.assertEqual([(r['set'],r['id']) for r in answer['upserts']],[('shared','2')])
        self.assertFalse(any(r['set']=='sub:4' for r in answer['tombstones']))
        self.assertEqual(answer['replacements'],[dict(set='sub:4',records=[
            dict(entity='agent',id=key,set='sub:4',body=dict(name='node'+key)) for key in ('2','9')])])
        self.assertNotIn('~scope',str(answer))
        self.assertEqual(self.raw.calls[0][1],(4,8,['subtree'],2001))

    def test_replacement_bound_counts_all_members_and_rejects_shared_replacement(self):
        self.raw.changed = [('~scope','subtree:6')]
        self.registry.register_scope('subtree',lambda state,roots,held:
            ScopeResult(replacements=frozenset(('sub:4',))))
        self.assertEqual(Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4),
            selections=(Selection(),Selection('sub:4',('2','9','10'))),bound=2),{'type':'record_reset'})
        self.assertEqual(self.built,[])
        self.registry.scopes['subtree'] = lambda state,roots,held: ScopeResult(replacements=frozenset(('shared',)))
        with self.assertRaisesRegex(RuntimeError,'invalid replacement'):
            Q.catchup(self.registry,self.state,Q.Cursor('uuid','inc',4))

    def test_scope_registration_is_owned_and_unique(self):
        reader = lambda state,roots,held: ScopeResult()
        for kind in ('','subtree:1','bad-kind','\u00e9'):
            with self.assertRaises(ValueError):
                self.registry.register_scope(kind,reader)
        self.registry.register_scope('subtree',reader)
        with self.assertRaises(ValueError):
            self.registry.register_scope('subtree',reader)


if __name__ == '__main__':
    unittest.main()
