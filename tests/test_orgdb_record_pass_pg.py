"""Snapshot-local reuse, changed-only runtime inputs, and move parity."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import test_orgdb_record_tree_pg as seed
from orgtree import foreground_context, api, ledger
from orgtree.orgdb import record_reads as Q, record_host as H, record_tree as T
from orgtree.orgdb.record_pass import BodyPass
from orgtree.orgdb.record_registry import Registry, Selection, Snapshot

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Pass(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        seed.Tree.setUpClass()
        cls.twin, cls.database = seed.Tree.twin, seed.Tree.database

    def fresh(self, state):
        return Snapshot(state.raw, state.slug, state.stamp, state.now)

    def test_shared_context_parity_and_copy_on_emit_through_moves(self):
        registry = T.register(Registry())
        with fixture.storage(True):
            for parent in (None, 'boss', None, 'boss'):
                with Q.snapshot(self.twin.copy) as state:
                    before = Q.cursor(state)
                api.org_op(self.twin.copy, api.Op(op='move', actor=ledger.USER,
                           node='ops',new_parent=parent), None)
                with Q.snapshot(self.twin.copy) as state:
                    key = str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='retired-2'").fetchone()[0])
                    selections = (Selection(),Selection('sub:1',(key,)),Selection('sub:2',(key,)))
                    expected = Q.catchup(registry,self.fresh(state),before,selections=selections)
                    plan = BodyPass(registry,state)
                    frame = Q.catchup(plan,state,before,selections=selections)
                    refs = plan.bodies(state,'agent',frozenset((key,)))
                    with patch.object(foreground_context,'build',wraps=foreground_context.build) as builds:
                        plan.build()
                        context = T.runtime_contexts(state,frozenset((key,)))[key]
                        self.assertEqual(builds.call_count,1)
                    self.assertIn('predecessor',context.nodes)
                    self.assertEqual(plan.emit(frame),expected)
                    first,second = plan.emit(refs)[key],plan.emit(refs)[key]
                    first['title']='mutated returned copy'
                    self.assertNotEqual(first['title'],second['title'])
                    self.assertNotEqual(first['title'],context.node('retired-2')['title'])

    def test_next_pass_reads_new_body_and_uses_new_context(self):
        registry = T.register(Registry())
        with fixture.storage(True):
            with Q.snapshot(self.twin.copy) as state:
                key=str(state.raw.execute("SELECT id FROM orgtree.agents WHERE name='ops'").fetchone()[0])
                plan=BodyPass(registry,state)
                ref=plan.bodies(state,'agent',frozenset((key,)))
                plan.build()
                before=plan.emit(ref)[key]
                first_context=state.cache['tree_pass_context'][1]
            with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                raw.execute("UPDATE orgtree.agents SET title=title||' next-pass' WHERE name='ops'")
            with Q.snapshot(self.twin.copy) as state:
                other=BodyPass(registry,state)
                ref=other.bodies(state,'agent',frozenset((key,)))
                other.build()
                after=other.emit(ref)[key]
                self.assertEqual(after['title'],before['title']+' next-pass')
                self.assertIsNot(state.cache['tree_pass_context'][1],first_context)
                with self.assertRaisesRegex(ValueError,'crossed a snapshot'):
                    plan.select(state,Selection())

    def test_runtime_rebuilds_only_dirty_held_agents_and_retains_other_bodies(self):
        host=H.OrgHost(self.twin.copy,lambda error: self.fail(str(error)))
        with fixture.storage(True):
            frame,initial=host._worker('baseline',None,None,(Selection(),))
            keys=frozenset(initial.bodies)
            with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                key=str(raw.execute("SELECT id FROM orgtree.agents WHERE name='ops'").fetchone()[0])
                raw.execute("UPDATE orgtree.agents SET title=title||' dirty' WHERE name='ops'")
            with patch.object(foreground_context,'build',wraps=foreground_context.build) as builds:
                frame,partial=host._worker('changes',initial.cursor,(),(Selection(),),
                                          previous=(initial.cursor,keys))
                self.assertEqual(builds.call_count,1)
            self.assertIn(key,partial.bodies)
            self.assertLess(len(partial.bodies),len(keys))
            self.assertEqual(partial.held,keys)
            _,unchanged=host._worker('changes',partial.cursor,(),(Selection(),),
                                    previous=(partial.cursor,keys))
            self.assertEqual(unchanged.bodies,{})
            self.assertEqual(unchanged.contexts,{})
            self.assertEqual(unchanged.held,keys)

    def test_runtime_cursor_catches_changes_not_in_http_interval(self):
        host=H.OrgHost(self.twin.copy,lambda error: self.fail(str(error)))
        with fixture.storage(True):
            _,initial=host._worker('baseline',None,None,(Selection(),))
            with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                key=str(raw.execute("SELECT id FROM orgtree.agents WHERE name='ops'").fetchone()[0])
                raw.execute("UPDATE orgtree.agents SET title=title||' ahead' WHERE name='ops'")
            with Q.snapshot(self.twin.copy) as state:
                client_cursor=Q.cursor(state)
            frame,inputs=host._worker('changes',client_cursor,(),(Selection(),),
                previous=(initial.cursor,frozenset(initial.bodies)))
            self.assertEqual(frame['upserts'],[])
            self.assertIn(key,inputs.bodies)
            self.assertTrue(inputs.bodies[key]['title'].endswith(' ahead'))

    def test_reset_does_not_build_context_or_any_bodies(self):
        host=H.OrgHost(self.twin.copy,lambda error: self.fail(str(error)))
        with fixture.storage(True),patch.object(foreground_context,'build',side_effect=AssertionError('reset built')):
            frame,inputs=host._worker('changes',Q.Cursor('wrong','identity',0),(),(Selection(),))
            self.assertEqual(frame,{'type':'record_reset'})
            self.assertFalse(inputs.complete)


if __name__=='__main__':
    unittest.main()
