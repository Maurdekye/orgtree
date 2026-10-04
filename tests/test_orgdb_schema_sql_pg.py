"""SQL-only migration codec against independent Python codec values on owned PG.

Needs ORGTREE_TEST_PG_ADMIN_URL on a disposable cluster; run under heavy P03.
These controls are only the backfill foundation, not full G1-G11 acceptance.
"""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import datetime
import importlib.util
import json
import os
from pathlib import Path
import unittest

from orgtree.orgdb import codec, conn, docket_relations, turns
from orgtree.orgdb.mappers import agents as A, docket as D
from orgtree.orgdb.mappers import records as N

ROOT = Path(__file__).resolve().parents[1]
ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DB = f't{os.getpid()}_schema_sql'
loader = importlib.util.spec_from_file_location('schema_conformance_sql', ROOT / 'tools/schema_conformance_sql.py')
SQL = importlib.util.module_from_spec(loader)
loader.loader.exec_module(SQL)


def exact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def setUpModule():
    if ADMIN:
        from psycopg import sql
        with conn.connect(ADMIN, 'postgres') as raw:
            raw.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))


def tearDownModule():
    if ADMIN:
        from psycopg import sql
        with conn.connect(ADMIN, 'postgres') as raw:
            raw.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(DB)))


@unittest.skipUnless(ADMIN, 'needs owned disposable ORGTREE_TEST_PG_ADMIN_URL')
class BackfillCodec(unittest.TestCase):
    def setUp(self):
        from psycopg.types.json import Json
        self.Json = lambda value: Json(value, dumps=lambda v: json.dumps(v, ensure_ascii=True, allow_nan=False))
        self.raw = conn.connect(ADMIN, DB)
        self.raw.execute("SET timezone='UTC'")
        self.raw.execute('CREATE SCHEMA IF NOT EXISTS orgtree')
        source = (ROOT / 'engine/backend/orgtree/pg_migrations/org/0007_docket_readers.sql').read_text(encoding='utf-8')
        # The shipped escape helper is part of the alpha contract, not a new
        # dependency on the authoring tool. Its DDL is installed independently.
        start = source.index('CREATE FUNCTION orgtree.docket_safe(')
        end = source.index('CREATE FUNCTION orgtree.docket_scope_meta(')
        self.raw.execute(source[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'))
        self.raw.execute(SQL.HELPERS)
        self.compiler = SQL.Compiler()
        self.addCleanup(self.raw.close)

    def compile(self, spec, prefix=''):
        start = len(self.compiler.statements)
        name = self.compiler.function(spec, prefix)
        self.raw.execute('\n'.join(self.compiler.statements[start:]))
        return name

    def check(self, spec, cases, prefix=''):
        name = self.compile(spec, prefix)
        for value in cases:
            with self.subTest(value=exact(value)):
                pack = self.raw.execute(f'SELECT pg_temp.{name}_encode(%s)', (self.Json(value),)).fetchone()[0]
                restored = self.raw.execute(f'SELECT pg_temp.{name}_decode(%s,%s,%s)',
                    (self.Json(pack['row']),self.Json(pack['extra']),self.Json(pack['children']))).fetchone()[0]
                self.assertEqual(exact(restored), exact(value))
                expected = {}
                codec.encode(codec.Spec('fixture', spec.fields), value, {}, expected)
                row = expected['fixture'][0]
                for col, kind in codec.columns(spec, prefix):
                    actual = pack['row'].get(col)
                    want = row.get(col)
                    if hasattr(want,'obj'):
                        want = want.obj
                    if isinstance(want, datetime.datetime):
                        actual = codec.parse_ts(actual)
                    self.assertEqual(exact(actual) if kind=='json' else actual,
                                     exact(want) if kind=='json' else want, col)
                extra = row.get('extra')
                self.assertEqual(exact(pack['extra']), exact(extra.obj if hasattr(extra,'obj') else extra))
                for child, values in pack['children'].items():
                    child_values = [r['value'] for r in expected.get(child,())]
                    self.assertEqual(exact(values), exact(child_values), child)

    def test_alpha_foundation_backfills_existing_ids_and_both_turn_sources(self):
        from psycopg.rows import dict_row
        from orgtree.orgdb.convert import rowio
        for statement in A.TOOL_LISTS_DDL:
            self.raw.execute(statement)
        oldtables=(A.LEGACY_AGENTS,N._lifecycle().migration_tables[0],N._turns().migration_tables[0])
        for table in oldtables:
            for statement in table.ddl():
                self.raw.execute(statement)
        self.raw.execute("ALTER TABLE orgtree.agents ADD CONSTRAINT agents_state_enum CHECK(state IN ('live','archived','unrecoverable'))")
        common={'n':3,'cost':-0.0,'ms':None,'cost_unknown_fields':['x','x'],
                'model_usage_key':{'asked':'model','matched':True,'keys':['b','a']},
                'unknown':{'raw':'\0\ud800\U0001f600'}}
        log=[{'n':1,'cost':1.0},common,{'n':3,'cost':0.0},common]
        node={'state':'live','turn_est_cost':['f',1e16,1.0],'turn_est_toks':['i',10**100],
              'turns':[{'n':0,'model_usage_key':['old']},common,common],
              'unknown':{'keep':'\0\ud800'}}
        lifecycle={'current_candidate':['unusual','\0'],'kind':'runtime-edit'}
        rows={}
        codec.encode(A.LEGACY_HOT,node,dict(id=1,name='worker',ord=0,tombstone=False),rows,link=A.LEGACY_AGENTS.link)
        for pos,value in enumerate(log):
            codec.encode(N.AGENT_TURNS,value,dict(id=17+pos*13,agent_id=1,idx=pos),rows,
                         link=N._turns().migration_tables[0].link)
        codec.encode(N.LEGACY_LIFECYCLE,lifecycle,dict(id=29,ord=0),rows)
        order=[name for table in oldtables for name in table.layout()]
        rowio.write(self.raw,rows,order=order)
        self.raw.execute("SELECT setval(pg_get_serial_sequence('orgtree.agent_turns','id'),100,true)")
        draft=SQL.generate().render().replace('CREATE FUNCTION pg_temp.','CREATE OR REPLACE FUNCTION pg_temp.')
        # A late error rolls all DDL/data back in the same migration transaction.
        from psycopg.errors import RaiseException
        with self.assertRaises(RaiseException),self.raw.transaction():
            self.raw.execute(draft+"DO $fault$ BEGIN RAISE EXCEPTION 'late fault'; END $fault$;")
        self.assertIsNotNone(self.raw.execute("SELECT to_regclass('orgtree.agent_recent_turns')").fetchone()[0])
        self.assertEqual(self.raw.execute('SELECT count(*) FROM orgtree.agent_turns').fetchone()[0],4)
        with self.raw.transaction():
            self.raw.execute(draft)
        self.assertIsNone(self.raw.execute("SELECT to_regclass('orgtree.agent_recent_turns')").fetchone()[0])
        with self.raw.cursor(row_factory=dict_row) as cursor:
            stored=cursor.execute('SELECT * FROM orgtree.agent_turns ORDER BY id').fetchall()
            agent=cursor.execute('SELECT * FROM orgtree.agents WHERE id=1').fetchone()
            life=cursor.execute('SELECT * FROM orgtree.lifecycle_events WHERE id=29').fetchone()
            kids={table:cursor.execute(f'SELECT * FROM orgtree.{table}').fetchall()
                  for table in ('agent_turn_cost_unknown_fields','agent_turn_model_usage_keys')}
        children=codec.Children(kids,turns.TABLE.layout())
        afterlog=[codec.decode(turns.SPEC,row,children,(row['id'],))
                  for row in sorted(stored,key=lambda r:r['idx'] if r['idx'] is not None else 10**20)
                  if row['idx'] is not None]
        self.assertEqual(exact(afterlog),exact(log))
        self.assertEqual([r['id'] for r in stored if r['idx'] is not None],[17,30,43,56])
        after=codec.decode(A.NODE_BODY,agent,codec.Children({},A.AGENTS.layout()))
        after['turns']=turns.read_recent(self.raw,[1])[1]
        self.assertEqual(exact(after),exact(node))
        self.assertEqual(exact(codec.decode(N.LIFECYCLE,life,None)),exact(lifecycle))
        self.assertEqual(len(stored),5)
        list_only=[r for r in stored if r['idx'] is None]
        self.assertEqual(len(list_only),1)
        # PostgreSQL sequences advance even when the first attempt rolls back.
        # Only retained alpha log identities must stay exactly unchanged.
        self.assertGreater(list_only[0]['id'],100)
        self.assertEqual([r['id'] for r in sorted(stored,key=lambda r:r['recent_pos'] or 0)
                          if r['recent_pos'] is not None],[list_only[0]['id'],30,56])

    def test_estimates_keep_integer_float_compensation_and_misfits(self):
        spec = SQL.subset(A.HOT, ('turn_est_cost','turn_est_toks'))
        values = [None, ['i',0], ['i',10**100], ['i',-(10**100)], ['f',1e16,1.0],
                  ['f',-0.0,-0.0], ['i',True], ['f',1,1.0], ['f',1.0,0],
                  ['f',5e-324,1.7976931348623157e308], False, {'raw':'\0\ud800'}]
        self.check(spec, [{}]+[dict(turn_est_cost=v,turn_est_toks=v) for v in values])

    def test_numeric_scalars_keep_float_scale_integer_type_and_misfits(self):
        spec=codec.Spec('',(codec.Field('amount','num',nullable=True),))
        name=self.compile(spec)
        self.raw.execute('CREATE TEMP TABLE number_fixture (amount numeric)')
        for value in [None,0,10**100,1.0,1e20,1e-20,5e-324,-0.0,False,'bad']:
            with self.subTest(value=repr(value)):
                original={'amount':value}
                pack=self.raw.execute(f'SELECT pg_temp.{name}_encode(%s)',
                                      (self.Json(original),)).fetchone()[0]
                if codec.fits('num',value):
                    self.raw.execute('TRUNCATE number_fixture')
                    self.raw.execute(f"INSERT INTO number_fixture SELECT "
                        f"pg_temp.sc_get(pg_temp.sc_get(pg_temp.{name}_encode(%s),'row'),'amount')::text::numeric",
                        (self.Json(original),))
                    physical=self.raw.execute('SELECT amount,to_json(amount) FROM number_fixture').fetchone()
                    expected=codec.to_column('num',value)
                    self.assertEqual(physical[0],expected)
                    self.assertEqual(isinstance(physical[1],float),isinstance(value,float))
                    pack['row']['amount']=physical[1]
                restored=self.raw.execute(f'SELECT pg_temp.{name}_decode(%s,%s,%s)',
                    (self.Json(pack['row']),self.Json(pack['extra']),self.Json(pack['children']))).fetchone()[0]
                self.assertEqual(exact(restored),exact(original))

    def test_historical_principals_preserve_nulls_shapes_and_aliases(self):
        spec = codec.Spec('', (codec.Field('by','principal',principal_aliases=(('node','by_node'),)),))
        values = [None,False,0,1.0,'','user','orgtree','@net:peer','worker', '\0\ud800', [], {},
                  dict(node=None,generation=None,born=None,deleted=None),
                  dict(node='worker',generation=2,born='seat',deleted=False,unknown={'raw':'\0'}),
                  dict(node='\0\ud800',generation=True,born=False,deleted=0)]
        self.check(spec,[{}]+[{'by':v} for v in values])

    def test_attention_acceptance_and_evidence_gap_keep_nested_extra(self):
        spec = SQL.subset(D.WORK_ITEM, ('manual_attention','accepted'))
        values = [None,False,0,[],{},dict(reason=None,at='bad',by='user',set_rev=True,unknown='\0'),
                  dict(at='2026-10-04T08:00:00.000Z',by=dict(node='user',generation=2),
                       note=None,via='accept',evidence_gap=dict(unclassified=0,total=4,summary='x',raw='\ud800'))]
        self.check(spec,[{}]+[dict(manual_attention=v,accepted=v,untouched={'s':'\0'}) for v in values])

    def test_turn_metadata_keeps_old_bare_lists_and_whole_list_misfits(self):
        spec = SQL.subset(turns.SPEC, ('cost_unknown_fields','model_usage_key'))
        values = [None,False,0,'',[],['a','b'],['a','\0'],['a',False],{},
                  dict(asked='model',matched=True,keys=['b','a','b'],raw='\ud800'),
                  dict(asked=None,matched=None,keys=None),dict(asked=2,matched=1,keys=[])]
        self.check(spec,[{}]+[dict(cost_unknown_fields=v,model_usage_key=v) for v in values])

    def test_seat_delivery_and_grant_columns_follow_the_reviewed_specs(self):
        for spec in (docket_relations.SEAT,docket_relations.DELIVERY,docket_relations.GRANT):
            cases = [{},{f.key:None for f in spec.fields},
                     {f.key:False for f in spec.fields},
                     dict(reviewer='worker',holder=dict(node='worker',born='seat'),
                          granted_by='user',by={'node':'user'},claimed_by='orgtree',
                          at='2026-10-04T08:00:00.1234567Z',to='worker',state='granted',raw='\0')]
            self.check(spec,cases)

    def test_timestamp_fitting_agrees_with_python_iso_parser(self):
        times = ['2026-10-04T08:15:13.123Z','2026-10-04T08:15:13.1234567z',
                 '20261004T081513+02','2026-W40-7T08:15:13+02:30:01.123',
                 '2026W407X0815.123456+0230','2026-10-04 08.5+00:00',
                 '2026-10-04T08:15:13+00:00:00.5','2026-10-04T08:15:13+00:60',
                 '0001-01-01T00:00:00+00:00','9999-12-31T23:59:59+00:00',
                 '2026-10-04T08:15:13','October 4 2026 08:15+00','2026-10-04T25:00Z',
                 '2026-10-04T08:15+24:00','2026-W53-1T08:00Z','2026-10-04T08:15\0Z']
        for value in times:
            with self.subTest(value=value):
                actual = self.raw.execute('SELECT pg_temp.sc_timestamp(%s)',(self.Json(value),)).fetchone()[0]
                want = codec.parse_ts(value)
                # PostgreSQL accepts a wider UTC year after timezone conversion;
                # compare the ISO source's UTC instant, not its lexical spelling.
                self.assertEqual(actual,want)

    def test_exact_matching_distinguishes_types_but_normalizes_string_escapes(self):
        for a,b,equal in [(False,0,False),(0,0.0,False),(0.0,-0.0,False),
                          ({'a':1,'b':2},{'b':2,'a':1},True),
                          ({'raw':'\0\ud800\U0001f600'},{'raw':'\0\ud800\U0001f600'},True),
                          (['x','x'],['x'],False)]:
            aa,bb=self.raw.execute('SELECT pg_temp.sc_canonical(%s),pg_temp.sc_canonical(%s)',
                                   (self.Json(a),self.Json(b))).fetchone()
            self.assertEqual(aa==bb,equal)
        a,b=self.raw.execute("SELECT pg_temp.sc_canonical(%s::json),pg_temp.sc_canonical(%s::json)",
                            ('"\\uD800\\uD83D\\uDE00"','"\\ud800\\ud83d\\ude00"')).fetchone()
        self.assertEqual(a,b)

    def test_exact_assertion_detects_changed_compensation_or_missing_value(self):
        from psycopg.errors import RaiseException
        for a,b in [(['f',1e16,1.0],['f',1e16,0.0]),({'note':None},{}),({'x':'\0'},{'x':''})]:
            with self.subTest(value=a),self.raw.transaction():
                with self.assertRaises(RaiseException),self.raw.transaction():
                    self.raw.execute('SELECT pg_temp.sc_assert(%s,%s,%s)',(self.Json(a),self.Json(b),'planted fault'))


if __name__ == '__main__':
    unittest.main()
