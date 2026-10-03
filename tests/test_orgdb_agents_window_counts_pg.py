"""Real-owner retained-document and resolved-credit window growth controls."""
import import_provenance  # noqa: F401  assert checkout imports before any database

import copy
import re
import unittest
from unittest.mock import Mock, patch

import test_orgdb_compat_pg as fixture
from orgtree import foreground_store as F

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class CapturedCursor:
    def __init__(self, cursor, queries):
        self.cursor, self.queries = cursor, queries

    def execute(self, statement, params=None, **kwargs):
        if isinstance(statement,str) and re.match(r'\s*(SELECT|WITH)\b',statement,re.I):
            self.queries.append((statement,copy.deepcopy(params)))
        self.cursor.execute(statement,params,**kwargs)
        return self

    def __enter__(self):
        self.cursor.__enter__()
        return self

    def __exit__(self,*args):
        return self.cursor.__exit__(*args)

    def __iter__(self):
        return iter(self.cursor)

    def __getattr__(self,name):
        return getattr(self.cursor,name)


class CapturedConnection:
    def __init__(self, raw, queries):
        self.raw,self.queries=raw,queries

    def execute(self, statement, params=None, **kwargs):
        if isinstance(statement,str) and re.match(r'\s*(SELECT|WITH)\b',statement,re.I):
            self.queries.append((statement,copy.deepcopy(params)))
        return self.raw.execute(statement,params,**kwargs)

    def cursor(self,*args,**kwargs):
        return CapturedCursor(self.raw.cursor(*args,**kwargs),self.queries)

    def __getattr__(self,name):
        return getattr(self.raw,name)


def scanned(plan):
    total=0
    if plan.get('Relation Name') in ('documents','credit_requests'):
        total=(plan.get('Actual Rows',0)+plan.get('Rows Removed by Filter',0))*plan.get('Actual Loops',1)
    return total+sum(scanned(child) for child in plan.get('Plans',[]))


@fixture.needs_pg
class OwnerHistoryWindows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twins={}
        for size in (2048,20480):
            def seed(slug, size=size):
                org=fixture.store.load_org(slug)
                org.d['documents']=[dict(id=f'owned-{i}',node='dev',title=f'Presentation {i}',
                    at=fixture.AT,format='markdown',body='retained authored text') for i in range(size)]
                org.d['credit_requests']=[dict(id=f'credits-{i}',node='dev',old=10,new=11,
                    at=fixture.AT,status='granted',resolved_at=fixture.AT,unrelated='preserved') for i in range(size)]
                fixture.store.save_org(org)
            cls.twins[size]=fixture.Twins(f'owner history {size}',seed)
            with fixture.storage(True):
                database=fixture.registry.lookup(cls.twins[size].copy)[1]
                with fixture.dbconn.connect(fixture.ADMIN,database) as raw:
                    raw.execute('ANALYZE')

    def measure(self,size,disabled=False):
        twin=self.twins[size]
        queries=[]
        with fixture.storage(True), patch.multiple(fixture.store,
                load_org=Mock(side_effect=AssertionError('whole-org fallback')),
                cached_org=Mock(side_effect=AssertionError('whole-org fallback'))):
            database=fixture.registry.lookup(twin.copy)[1]
            with fixture.dbconn.connect(fixture.RUNTIME,database) as raw:
                raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                # Cache/column discovery is bootstrap work, not archive work.
                F.read_card_windows(raw,['dev'],header=True)
                result=F.read_card_windows(CapturedConnection(raw,queries),['dev'],header=True)
                if disabled:
                    for kind in ('indexscan','bitmapscan','indexonlyscan'):
                        raw.execute(f'SET LOCAL enable_{kind}=off')
                plans=[raw.execute('EXPLAIN (ANALYZE, FORMAT JSON) '+sql,params).fetchone()[0][0]['Plan']
                       for sql,params in queries]
                raw.execute('ROLLBACK')
        self.assertEqual(result['document_counts']['dev'],size)
        self.assertEqual([d['id'] for d in result['documents']['dev']],
                         [f'owned-{i}' for i in range(size-10,size)])
        self.assertTrue(result['asks']['credit_requests'])
        self.assertTrue(all(r['resolved_at']==fixture.AT and r['unrelated']=='preserved'
                            for r in result['asks']['credit_requests']))
        self.assertTrue(queries)
        return len(queries),sum(scanned(plan) for plan in plans)

    def test_owned_document_and_resolved_credit_history_work_is_bounded(self):
        small=self.measure(2048)
        large=self.measure(20480)
        self.assertEqual(small[0],large[0])
        self.assertLessEqual(large[1],small[1]*1.05+32,f'examined relation rows {small} -> {large}')
        self.assertLess(large[1],500,'a retained-owner total must not scan its history')

    def test_disabling_indexes_is_caught_on_actual_window_queries(self):
        normal=self.measure(20480)
        broken=self.measure(20480,disabled=True)
        self.assertGreater(broken[1],normal[1]*5+32,'deliberate index removal did not exercise the real guard')


if __name__=='__main__':
    unittest.main()
