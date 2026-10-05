"""Two-session record membership barriers and seeded snapshot parity on real PG.

Both writers finish their source statements before either commit; reads at the
middle cursor and final cursor need no later write or client prior-member list.
The SQL-generated trace also reaches the actual renderer RecordFeed.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import json
import os
from pathlib import Path
import random
import subprocess
import tempfile
import unittest

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_derivations as D, record_sql as S
from orgtree.orgdb import record_reads as Q, record_tree as T
from orgtree.orgdb.record_registry import Entity, Registry, Selection, WindowKind

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule
WINDOWS = tuple(D.Window(name,k,(
    D.Stream('documents','r.node','r.id::text',('r.ord','r.id'),predicate),))
    for name,k,predicate in (('barrier_latest1',1,'true'),('barrier_latest4',4,'true'),
        ('barrier_visible4',4,"coalesce(r.format,'markdown')='markdown'")))
ROOT = Path(__file__).resolve().parents[1]


@fixture.needs_pg
class Membership(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for name,parent,state,order in (
                ('P',None,'live',10),('Q',None,'live',20),('X','P','archived',30),
                ('C','X','archived',40),('D','X','live',50),
                *((f'pile-{i}','P','archived',100+i) for i in range(8)),
                ('old-name',None,'archived',200),('joined','old-name','live',210),
                ('lineage-a',None,'archived',220),('lineage-b',None,'archived',230),
                ('lineage-head',None,'live',240)):
                org.nodes[name]={**fixture.node(name,parent),'state':state,'ui_order':order,
                    'session_id':'barrier-'+name,'bearer_state':None}
            for name,node in org.nodes.items():
                node.setdefault('session_id','barrier-'+name)
                node.setdefault('bearer_state',None)
            for ask in org.d['asks']:
                ask['questions']=[{'id':'q','question':ask['question']}]
            org.nodes['lineage-head']['predecessor']='lineage-a'
            org.nodes['lineage-a']['successor']='lineage-head'
            fixture.store.save_org(org)
        self.twin=fixture.Twins('membership '+self._testMethodName,seed)
        self.database=fixture.registry.lookup(self.twin.copy)[1]
        self.raw=fixture.dbconn.connect(fixture.ADMIN,self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute("SET statement_timeout='10s'")
        self.ids=dict(self.raw.execute('SELECT name,id::text FROM orgtree.agents'))
        self.registry=T.register(Registry())
        self.selections=(Selection(),Selection('sub:1',(self.ids['C'],self.ids['lineage-head'])))
        self.trace=[]
        self.ordinal=1100000
        # The fixture declares real extension windows using the same generator
        # and one snapshot/body builder contract the panel pieces will use.
        sql=S.migration_sql(windows=WINDOWS)
        start=sql.index('CREATE FUNCTION orgtree.resolve_scopes')
        stop=sql.index('CREATE FUNCTION orgtree.record_flush')
        self.raw.execute(sql[start:stop].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'))
        self.raw.execute(D.capture_function('documents',D.with_windows(D.SOURCES,WINDOWS)['documents'])
            .replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))

    def rev(self,raw=None):
        return (raw or self.raw).execute('SELECT rev FROM orgtree.org_revision').fetchone()[0]

    @staticmethod
    def table(rows):
        return {(r['set'],r['entity'],r['id']):r for r in rows}

    def initial(self,label):
        with Q.snapshot(self.twin.copy) as state:
            rows=Q.records(self.registry,state,self.selections)
            case=dict(label=label,cursor=Q.cursor(state).wire(),before=rows,
                declarations=[dict(agents=list(s.agents),windows=list(s.windows))
                    for s in self.selections if s.set!='shared'],updates=[])
            self.trace.append(case)
            return self.table(rows),Q.cursor(state),case

    def compare(self,held,cursor,case):
        with Q.snapshot(self.twin.copy) as state:
            frame=Q.catchup(self.registry,state,cursor,selections=self.selections)
            self.assertEqual(frame['type'],'record_changes')
            self.assertEqual(frame['from'],cursor.rev)
            current=Q.cursor(state)
            self.assertEqual(frame['to'],current.rev)
            for replacement in frame.get('replacements',()):
                held={k:v for k,v in held.items() if k[0]!=replacement['set']}
                held.update(self.table(replacement['records']))
            for row in frame['tombstones']:
                held.pop((row['set'],row['entity'],row['id']),None)
            held.update(self.table(frame['upserts']))
            expected=Q.records(self.registry,state,self.selections)
            self.assertEqual(held,self.table(expected),case['label'])
            self.assertNotIn('~scope',str(frame))
            case['updates'].append(dict(frame=frame,expected=expected))
            # Equality reads at the same cursor are empty without another commit.
            empty=Q.catchup(self.registry,state,current,selections=self.selections)
            self.assertEqual(empty['upserts'],[])
            self.assertEqual(empty['tombstones'],[])
            self.assertNotIn('replacements',empty)
            return held,current

    def barrier(self,label,statements,reverse=False):
        before,cursor,case=self.initial(label)
        with ExitStack() as stack:
            conns=[stack.enter_context(fixture.dbconn.connect(fixture.ADMIN,self.database))
                for _ in range(2)]
            try:
                for raw in conns:
                    raw.execute("SET statement_timeout='10s'")
                    raw.execute('BEGIN')
                for raw,commands in zip(conns,statements):
                    for command,params in commands: raw.execute(command,params)
                # This is the source-statement barrier: both sessions have
                # returned, neither commit/revision has happened yet.
                self.assertEqual(self.rev(),cursor.rev)
                first,second=(1,0) if reverse else (0,1)
                conns[first].execute('COMMIT')
                self.assertEqual(self.rev(),cursor.rev+1)
                middle,middle_cursor=self.compare(before.copy(),cursor,case)
                middle_case=dict(label=label+' middle',cursor=middle_cursor.wire(),
                    before=list(middle.values()),declarations=case['declarations'],updates=[])
                self.trace.append(middle_case)
                conns[second].execute('COMMIT')
                self.assertEqual(self.rev(),cursor.rev+2)
                self.compare(middle,middle_cursor,middle_case)
                self.compare(before,cursor,case)
            finally:
                for raw in conns: raw.execute('ROLLBACK')

    def window_registry(self,partition):
        registry=Registry()
        for window in WINDOWS:
            kind=window.name
            def members(state,args,size=window.size,predicate=window.streams[0].predicate):
                return frozenset(str(r[0]) for r in state.raw.execute(
                    'SELECT r.id FROM orgtree.documents r WHERE r.node=%s AND '+predicate+
                    ' ORDER BY r.ord DESC,r.id DESC LIMIT %s',
                    (args['node'],size)))
            def bodies(state,ids):
                return {str(key):dict(id=str(key),node=node,ord=ordinal,format=fmt) for key,node,ordinal,fmt
                    in state.raw.execute('SELECT id,node,ord,format FROM orgtree.documents WHERE id=ANY(%s::bigint[])',
                        (list(map(int,ids)),))}
            registry.register_window(WindowKind(kind,lambda args:args,
                lambda state,args,name=kind:name+':'+args['node'],members,bodies))
        self.registry=registry
        self.selections=(Selection(),Selection('sub:1',windows=tuple(
            dict(kind=window.name,node=partition) for window in WINDOWS)))

    def test_newest_one_and_four_insert_delete_barriers_in_both_orders(self):
        with fixture.storage(True):
            for reverse in (False,True):
                for deleting in (False,True,'mixed'):
                    partition=f'barrier-window-{reverse}-{deleting}'
                    self.window_registry(partition)
                    ids=[]
                    for _ in range(7):
                        self.ordinal+=1
                        ids.append(self.raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                            (self.ordinal,partition)).fetchone()[0])
                    if deleting == 'mixed':
                        self.ordinal+=1
                        statements=((('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s)',
                            (self.ordinal,partition)),),
                            (('DELETE FROM orgtree.documents WHERE id=%s',(ids[-1],)),))
                    elif deleting:
                        statements=tuple(((('DELETE FROM orgtree.documents WHERE id=%s',(key,)),))
                            for key in ids[-2:])
                    else:
                        statements=[]
                        for offset in (1,2):
                            statements.append((('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s)',
                                (self.ordinal+offset,partition)),))
                        self.ordinal+=2
                    self.barrier(partition,statements,reverse)
            self.renderer()

    def test_pile_archives_and_unarchives_converge_from_middle_cursor_in_both_orders(self):
        with fixture.storage(True):
            # X brings its own live child, so keep it live here: otherwise X
            # remains the first retired edge and neither writer displaces it.
            self.raw.execute("UPDATE orgtree.agents SET state='live' WHERE id=%s",(int(self.ids['X']),))
            for reverse in (False,True):
                for archiving in (False,True):
                    state='live' if archiving else 'archived'
                    self.raw.execute('UPDATE orgtree.agents SET state=%s WHERE id=ANY(%s::bigint[])',
                        (state,[self.ids['pile-0'],self.ids['pile-1']]))
                    target='archived' if archiving else 'live'
                    statements=tuple(((('UPDATE orgtree.agents SET state=%s WHERE id=%s',
                        (target,int(self.ids[name]))),)) for name in ('pile-0','pile-1'))
                    self.barrier(f'pile {reverse} {archiving}',statements,reverse)
                self.raw.execute("UPDATE orgtree.agents SET state='live' WHERE id=%s",(int(self.ids['pile-0']),))
                self.raw.execute("UPDATE orgtree.agents SET state='archived' WHERE id=%s",(int(self.ids['pile-1']),))
                self.barrier('pile mixed '+str(reverse),(
                    (("UPDATE orgtree.agents SET state='archived' WHERE id=%s",(int(self.ids['pile-0']),)),),
                    (("UPDATE orgtree.agents SET state='live' WHERE id=%s",(int(self.ids['pile-1']),)),)),reverse)
            self.renderer()

    def test_parent_move_and_descendant_unarchive_capture_current_and_old_chains(self):
        with fixture.storage(True):
            for reverse in (False,True):
                self.raw.execute("UPDATE orgtree.agents SET parent_id=%s,parent='P' WHERE id=%s",
                    (int(self.ids['P']),int(self.ids['X'])))
                self.raw.execute("UPDATE orgtree.agents SET state='archived' WHERE id=%s",(int(self.ids['C']),))
                statements=((('UPDATE orgtree.agents SET parent_id=%s,parent=%s WHERE id=%s',
                    (int(self.ids['Q']),'Q',int(self.ids['X']))),),
                    (("UPDATE orgtree.agents SET state='live' WHERE id=%s",(int(self.ids['C']),)),))
                self.barrier('move/unarchive '+str(reverse),statements,reverse)
            self.renderer()

    def test_name_reference_and_in_place_rename_resolve_at_commit_snapshot(self):
        # Add a dependency sentinel to real renderer agent bodies. It proves
        # name resolution against the final state, not a panel implementation.
        original=self.registry.entities['agent']
        def bodies(state,ids):
            result=original.bodies(state,ids)
            for key,name,count in state.raw.execute('SELECT a.id,a.name,count(d.id) '
                'FROM orgtree.agents a LEFT JOIN orgtree.documents d ON d.node=a.name '
                'WHERE a.id=ANY(%s::bigint[]) GROUP BY a.id,a.name',(list(map(int,ids)),)):
                result[str(key)]={**result[str(key)],'test_document_count':count}
            return result
        self.registry.entities['agent']=Entity('agent',original.members,bodies)
        with fixture.storage(True):
            for reverse in (False,True):
                # Pin the archived name target so its resolved detail/body is held.
                self.selections=(Selection(),Selection('sub:1',(self.ids['old-name'],self.ids['joined'])))
                new='renamed-'+str(reverse)
                self.ordinal+=1
                statements=((('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s)',
                    (self.ordinal,new)),),
                    (('UPDATE orgtree.agents SET name=%s WHERE id=%s',(new,int(self.ids['old-name']))),))
                self.barrier('name/reference '+str(reverse),statements,reverse)
            self.renderer()

    def test_lineage_rewire_and_off_set_predecessor_rename_resolve_both_orders(self):
        with fixture.storage(True):
            for reverse in (False,True):
                self.raw.execute('UPDATE orgtree.agents SET predecessor_id=%s WHERE id=%s',
                    (int(self.ids['lineage-a']),int(self.ids['lineage-head'])))
                statements=((('UPDATE orgtree.agents SET predecessor_id=%s WHERE id=%s',
                    (int(self.ids['lineage-b']),int(self.ids['lineage-head']))),),
                    (('UPDATE orgtree.agents SET name=%s WHERE id=%s',
                    ('lineage-renamed-'+str(reverse),int(self.ids['lineage-b']))),))
                self.barrier('lineage '+str(reverse),statements,reverse)
            self.renderer()

    def test_seeded_membership_changes_equal_fresh_snapshot_after_every_commit(self):
        rng=random.Random(32004)
        with fixture.storage(True):
            held,cursor,case=self.initial('seed 32004')
            older,older_cursor,older_case=self.initial('seed 32004 older HTTP cursor')
            changed=[self.ids['pile-'+str(i)] for i in range(8)]
            for step in range(48):
                key=int(rng.choice(changed))
                if step%3==0:
                    self.raw.execute('UPDATE orgtree.agents SET parent_id=%s WHERE id=%s',
                        (int(rng.choice((self.ids['P'],self.ids['Q']))),key))
                elif step%3==1:
                    self.raw.execute('UPDATE orgtree.agents SET state=%s WHERE id=%s',
                        (rng.choice(('live','archived')),key))
                else:
                    self.raw.execute('UPDATE orgtree.agents SET ui_order=%s WHERE id=%s',
                        (rng.randrange(90,120),key))
                held,cursor=self.compare(held,cursor,case)
                self.compare(older.copy(),older_cursor,older_case)
            self.renderer()

    def test_seeded_windows_with_predicate_edges_equal_live_and_older_http_snapshots(self):
        rng=random.Random(32005)
        partition='seeded-window'
        self.window_registry(partition)
        with fixture.storage(True):
            ids=[]
            for _ in range(7):
                self.ordinal+=1
                ids.append(self.raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                    (self.ordinal,partition)).fetchone()[0])
            held,cursor,case=self.initial('seed 32005')
            older,older_cursor,older_case=self.initial('seed 32005 older HTTP cursor')
            for step in range(48):
                if step%4==0 or not ids:
                    self.ordinal+=1
                    ids.append(self.raw.execute('INSERT INTO orgtree.documents(ord,node) VALUES(%s,%s) RETURNING id',
                        (self.ordinal,partition)).fetchone()[0])
                else:
                    key=rng.choice(ids)
                    if step%4==1:
                        self.raw.execute('DELETE FROM orgtree.documents WHERE id=%s',(key,))
                        ids.remove(key)
                    elif step%4==2:
                        self.raw.execute('UPDATE orgtree.documents SET format=%s WHERE id=%s',
                            (rng.choice(('markdown','html')),key))
                    else:
                        self.raw.execute('UPDATE orgtree.documents SET node=%s WHERE id=%s',
                            (rng.choice((partition,partition+'-away')),key))
                held,cursor=self.compare(held,cursor,case)
                self.compare(older.copy(),older_cursor,older_case)
            self.renderer()

    def test_seeded_lineage_names_equal_live_and_older_http_snapshots(self):
        rng=random.Random(32006)
        with fixture.storage(True):
            held,cursor,case=self.initial('seed 32006')
            older,older_cursor,older_case=self.initial('seed 32006 older HTTP cursor')
            predecessors=(self.ids['lineage-a'],self.ids['lineage-b'])
            for step in range(24):
                key=int(rng.choice(predecessors))
                if step%3==0:
                    self.raw.execute('UPDATE orgtree.agents SET predecessor_id=%s WHERE id=%s',
                        (key,int(self.ids['lineage-head'])))
                elif step%3==1:
                    self.raw.execute('UPDATE orgtree.agents SET name=%s WHERE id=%s',
                        ('seed-predecessor-'+str(step),key))
                else:
                    self.raw.execute('UPDATE orgtree.agents SET title=%s WHERE id=%s',
                        ('seed predecessor title '+str(step),key))
                held,cursor=self.compare(held,cursor,case)
                self.compare(older.copy(),older_cursor,older_case)
            self.renderer()

    def renderer(self):
        packet=dict(cases=self.trace)
        output=os.environ.get('ORGTREE_RECORD_MEMBERSHIP_OUTPUT')
        if output:
            Path(output).with_name(self._testMethodName+'.json').write_text(json.dumps(packet),encoding='utf-8')
        with tempfile.TemporaryDirectory(prefix='record-membership-') as root:
            path=Path(root)/'fixture.json'
            path.write_text(json.dumps(packet),encoding='utf-8')
            result=subprocess.run(['node','tests/run.mjs','recordpgmembership'],
                cwd=ROOT/'apps/desktop/renderer',env={**os.environ,'ORGTREE_RECORD_MEMBERSHIP_FIXTURE':str(path)},
                capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120)
            print(result.stdout.encode('ascii','backslashreplace').decode('ascii'))
            self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
            self.assertRegex(result.stdout,r'(?:#|\u2139) pass 1\b')
            self.assertRegex(result.stdout,r'(?:#|\u2139) skipped 0\b')


if __name__=='__main__':
    unittest.main()
