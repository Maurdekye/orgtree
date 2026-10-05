"""Snapshot-side subtree invalidation, independent of the pending O1 capture.

Writes name changed roots explicitly with capture off. The measured contract
is the read side; these controls do not claim final O1 move/flush composition.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
import json
import os
from pathlib import Path
import subprocess
import tempfile

import test_orgdb_compat_pg as fixture
from orgtree import foreground_store as F
from orgtree.orgdb import agents, record_reads as Q, record_tree as T
from orgtree.orgdb.record_registry import Entity, Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Subtrees(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for name,parent in (('P',None),('Q',None),('X','P'),('B','P'),('C','B'),('D','X')):
                org.nodes[name] = {**fixture.node(name,parent),'session_id':'subtree-'+name,
                    'bearer_state':None,'state':'archived','title':name+' scope'}
            fixture.store.save_org(org)
        self.twin = fixture.Twins('subtree '+self._testMethodName,seed)
        self.database = fixture.registry.lookup(self.twin.copy)[1]
        self.raw = fixture.dbconn.connect(fixture.ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.ids = dict(self.raw.execute('SELECT name,id::text FROM orgtree.agents'))
        self.registry = Registry()
        self.registry.register(Entity('agent',self.members,self.bodies))
        self.registry.register_scope('subtree',T.subtree_members)
        self.selections = (Selection(),Selection('sub:1',(self.ids['C'],)),
                           Selection('sub:2',(self.ids['D'],)))

    def members(self,state,selection):
        if selection.set == 'shared':
            return frozenset((self.ids['C'],self.ids['D']))
        return T.members(state,selection)

    def bodies(self,state,ids):
        # Effective-value sentinel read through the SAME ancestry as the real
        # formatter. Final configured-scope fields belong to the O1 composition.
        self.assertEqual(state.raw.execute("SELECT current_setting('transaction_isolation'),"
            "current_setting('transaction_read_only')").fetchone(),('repeatable read','on'))
        out = {}
        for key in ids:
            path = state.raw.execute('WITH RECURSIVE chain(id,parent_id,name,title,depth) AS ('
                'SELECT id,parent_id,name,title,0 FROM orgtree.agents WHERE id=%s UNION ALL '
                'SELECT a.id,a.parent_id,a.name,a.title,c.depth+1 FROM chain c '
                'JOIN orgtree.agents a ON a.id=c.parent_id) SELECT name,title FROM chain ORDER BY depth',
                (int(key),)).fetchall()
            out[key] = dict(name=path[0][0],effective_path=path)
        return out

    def write(self,parents=(),titles=(),roots=None):
        self.raw.execute('BEGIN')
        try:
            self.raw.execute("SET LOCAL orgtree.capture='off'")
            for name,parent in parents:
                self.raw.execute('UPDATE orgtree.agents SET parent_id=%s,parent=%s WHERE id=%s',
                    (int(self.ids[parent]),parent,int(self.ids[name])))
            for name,title in titles:
                self.raw.execute('UPDATE orgtree.agents SET title=%s WHERE id=%s',(title,int(self.ids[name])))
            names = roots if roots is not None else [name for name,_ in (*parents,*titles)]
            for name in names:
                self.raw.execute("INSERT INTO orgtree.changes(xid,entity,entity_id) VALUES "
                    "(pg_current_xact_id(),'~scope',%s) ON CONFLICT DO NOTHING",('subtree:'+self.ids[name],))
            self.raw.execute('COMMIT')
        except BaseException:
            self.raw.execute('ROLLBACK')
            raise

    @staticmethod
    def table(rows):
        return {(r['set'],r['entity'],r['id']):r for r in rows}

    def compare(self,before,after):
        with Q.snapshot(self.twin.copy) as state:
            frame = Q.catchup(self.registry,state,after,selections=self.selections)
            self.assertEqual(frame['type'],'record_changes')
            for replacement in frame.get('replacements',()):
                before = {key:value for key,value in before.items() if key[0]!=replacement['set']}
                before.update(self.table(replacement['records']))
            for row in frame['tombstones']:
                before.pop((row['set'],row['entity'],row['id']),None)
            before.update(self.table(frame['upserts']))
            expected = self.table(Q.records(self.registry,state,self.selections))
            self.assertEqual(before,expected)
            self.assertNotIn('~scope',str(frame))
            return before,Q.cursor(state),frame

    def initial(self):
        with Q.snapshot(self.twin.copy) as state:
            return self.table(Q.records(self.registry,state,self.selections)),Q.cursor(state)

    def test_every_moved_bearer_root_refreshes_retained_child_and_replaces_old_ancestors(self):
        with fixture.storage(True):
            before,after = self.initial()
            self.write(parents=(('X','Q'),('B','Q')))
            held,cursor,frame = self.compare(before,after)
            self.assertEqual({r['set'] for r in frame['replacements']},{'sub:1','sub:2'})
            self.assertNotIn(('sub:1','agent',self.ids['P']),held)
            self.assertIn(('sub:1','agent',self.ids['Q']),held)
            for key in (self.ids['C'],self.ids['D']):
                self.assertTrue(any(r['id']==key and r['set']=='shared' for r in frame['upserts']))
            self.assertEqual(cursor.rev,after.rev+1)
            named = self.raw.execute('SELECT c.entity,c.entity_id FROM orgtree.changes c '
                'JOIN orgtree.revisions r USING(xid) WHERE r.rev=%s',(cursor.rev,)).fetchall()
            self.assertEqual(set(named),{('~scope','subtree:'+self.ids[n]) for n in ('X','B')})
            packet = dict(cursor=after.wire(),before=list(before.values()),frame=frame,
                          expected=list(held.values()))
            output = os.environ.get('ORGTREE_RECORD_SUBTREE_OUTPUT')
            if output:
                Path(output).write_text(json.dumps(packet),encoding='utf-8')
            with tempfile.TemporaryDirectory(prefix='record-subtree-') as root:
                path = Path(root)/'fixture.json'
                path.write_text(json.dumps(packet),encoding='utf-8')
                result = subprocess.run(['node','tests/run.mjs','recordpgsubtree'],
                    cwd=Path(__file__).resolve().parents[1]/'apps/desktop/renderer',
                    env={**os.environ,'ORGTREE_RECORD_SUBTREE_FIXTURE':str(path)},
                    capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120)
                # Verification's Windows stdout may use cp1252; Node's check
                # marks must not turn a successful reached control into an error.
                print(result.stdout.encode('ascii','backslashreplace').decode('ascii'))
                self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
                self.assertRegex(result.stdout,r'(?:#|\u2139) pass 1\b')
                self.assertRegex(result.stdout,r'(?:#|\u2139) skipped 0\b')

    def test_scope_edit_then_move_out_and_two_moves_catch_up_at_final_snapshot(self):
        with fixture.storage(True):
            before,after = self.initial()
            self.write(titles=(('P','changed ancestor'),))
            self.write(parents=(('B','X'),))
            self.write(parents=(('X','Q'),))
            held,cursor,frame = self.compare(before,after)
            self.assertEqual(cursor.rev,after.rev+3)
            self.assertEqual({r['set'] for r in frame['replacements']},{'sub:1','sub:2'})
            self.assertEqual(held[('shared','agent',self.ids['C'])]['body']['effective_path'],
                [('C','C scope'),('B','B scope'),('X','X scope'),('Q','Q scope')])

    def test_automatic_parent_capture_replaces_both_bearer_subscriptions(self):
        with fixture.storage(True):
            before,after = self.initial()
            self.raw.execute('BEGIN')
            self.raw.execute("UPDATE orgtree.agents SET parent_id=%s,parent='Q' WHERE id=ANY(%s::bigint[])",
                (int(self.ids['Q']),[int(self.ids[n]) for n in ('X','B')]))
            self.raw.execute('COMMIT')
            held,cursor,frame = self.compare(before,after)
            self.assertEqual(cursor.rev,after.rev+1)
            self.assertEqual({r['set'] for r in frame['replacements']},{'sub:1','sub:2'})
            self.assertEqual(held[('shared','agent',self.ids['C'])]['body']['effective_path'],
                [('C','C scope'),('B','B scope'),('Q','Q scope')])

    def check_tombstoned_parent(self,parent):
        self.registry.entities['agent'] = Entity('agent',self.members,self.exact_bodies)
        before,after = self.initial()
        self.raw.execute('UPDATE orgtree.agents SET tombstone=true WHERE id=%s',(int(self.ids[parent]),))
        held,cursor,frame = self.compare(before,after)
        self.assertEqual(cursor.rev,after.rev+1)
        self.assertIn('sub:1',{r['set'] for r in frame['replacements']})
        self.assertEqual(held[('shared','agent',self.ids['C'])]['body']['ancestors'],['C'])
        for name in (parent,'P'):
            self.assertNotIn(('sub:1','agent',self.ids[name]),held)

    def test_tombstoned_typed_parent_replaces_departed_ancestor_membership(self):
        with fixture.storage(True):
            self.check_tombstoned_parent('B')

    def test_tombstoned_preserved_parent_replaces_departed_ancestor_membership(self):
        with fixture.storage(True):
            self.rare_parent()
            self.check_tombstoned_parent('false')

    def test_move_during_read_keeps_old_snapshot_and_reconnect_needs_no_later_write(self):
        with fixture.storage(True):
            before,after = self.initial()
            self.write(titles=(('B','first scope edit'),))
            with Q.snapshot(self.twin.copy) as old:
                old_expected = self.table(Q.records(self.registry,old,self.selections))
                self.write(parents=(('B','Q'),))
                frame = Q.catchup(self.registry,old,after,selections=self.selections)
                self.assertEqual(frame['to'],after.rev+1)
                replacement = next(r for r in frame['replacements'] if r['set']=='sub:1')
                self.assertIn(self.ids['P'],{r['id'] for r in replacement['records']})
                self.assertNotIn(self.ids['Q'],{r['id'] for r in replacement['records']})
                self.assertEqual(self.table(Q.records(self.registry,old,self.selections)),old_expected)
            held,cursor,frame = self.compare(before,after)
            self.assertEqual(cursor.rev,after.rev+2)
            self.assertIn(('sub:1','agent',self.ids['Q']),held)
            with Q.snapshot(self.twin.copy) as state:
                self.assertEqual(Q.catchup(self.registry,state,after,selections=self.selections,bound=2),
                                 {'type':'record_reset'})

    def rare_parent(self, parent=False, cycle=False):
        def edit(doc):
            doc['nodes']['false'] = {**fixture.node('false','B'),
                'session_id':'subtree-false','bearer_state':None,'state':'archived'}
            doc['nodes']['C']['parent'] = parent
            if cycle:
                doc['nodes']['C']['parent'] = 'B'
                doc['nodes']['B']['parent'] = False
        self.twin.edit(edit)
        self.ids = dict(self.raw.execute('SELECT name,id::text FROM orgtree.agents'))

    def exact_bodies(self,state,ids):
        # This sentinel uses the reached existing tree ancestry, not a second
        # typed-only walk. It tests scope routing, not final effective scopes.
        return {key:dict(name=name,ancestors=sorted(agents.ancestors(state.raw,[name])))
                for key,name in state.raw.execute('SELECT id::text,name FROM orgtree.agents '
                    'WHERE NOT tombstone AND id=ANY(%s::bigint[])',(list(ids),))}

    def test_preserved_parent_name_crossing_refreshes_child_and_replaces_ancestors(self):
        self.rare_parent()
        self.registry.entities['agent'] = Entity('agent',self.members,self.exact_bodies)
        old_names = []
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on):
                old_names.append(set(F.read_exact(slug,'C')['rows']))
        self.assertEqual(old_names[0],old_names[1])
        self.assertEqual(old_names[1],{'C','false','B','P'})
        with fixture.storage(True):
            before,after = self.initial()
            self.write(parents=(('B','Q'),))
            held,_cursor,frame = self.compare(before,after)
            self.assertEqual(held[('shared','agent',self.ids['C'])]['body']['ancestors'],
                             ['B','C','Q','false'])
            self.assertEqual({r['set'] for r in frame['replacements']},{'sub:1'})
            self.assertNotIn(('sub:1','agent',self.ids['P']),held)
            self.assertIn(('sub:1','agent',self.ids['Q']),held)

    def test_missing_preserved_parent_and_mixed_cycle_follow_existing_ancestry(self):
        self.rare_parent(parent=True)
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            held = {s.set:{'agent':self.members(state,s)} for s in self.selections}
            result = T.subtree_members(state,frozenset((self.ids['B'],)),held)
            self.assertNotIn(('agent',self.ids['C']),result.touched)
            self.assertNotIn('sub:1',result.replacements)
            self.assertEqual(set(agents.ancestors(state.raw,['C'])),{'C'})
        self.rare_parent(cycle=True)
        names = []
        for on,slug in ((False,self.twin.legacy),(True,self.twin.copy)):
            with fixture.storage(on): names.append(set(F.read_exact(slug,'C')['rows']))
        self.assertEqual(names[0],names[1])
        self.assertEqual(names[1],{'C','B','false'})
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            held = {s.set:{'agent':self.members(state,s)} for s in self.selections}
            result = T.subtree_members(state,frozenset((self.ids['false'],)),held)
            self.assertIn(('agent',self.ids['C']),result.touched)
            self.assertEqual(result.replacements,frozenset(('sub:1',)))


if __name__ == '__main__':
    unittest.main()
