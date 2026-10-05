"""One snapshot for UI name resolution and one-shot search, never tree bodies."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from orgtree.orgdb import record_selection as S


class Selection(unittest.TestCase):
    def test_name_bound_and_search_validation_before_any_database(self):
        self.assertEqual(S.arguments({'names':['same','same'],'search':{'query':' OLD ', 'state':'archived'}}),
                         (('same',),dict(query='old',state='archived')))
        for args in ({'names':'a'},{'names':[None]},{'names':['']},{'extra':1},
                {'names':['a']*16385},{'search':{'query':' '}},{'search':{'query':'x','state':'wrong'}},
                {'search':{'query':'x','extra':1}}):
            with self.assertRaises(ValueError):
                S.arguments(args)

    def test_every_search_page_and_mapping_use_same_snapshot_and_stamp(self):
        raw = object()
        state = SimpleNamespace(raw=raw,stamp=dict(org_uuid='u',incarnation='i',org_revision=7))
        snapshots = []
        @contextmanager
        def snapshot(slug):
            snapshots.append(slug)
            yield state
        def page(conn, query, status, after, limit):
            self.assertIs(conn,raw)
            self.assertEqual((query,status,limit),('old','archived',1000))
            return [(f'old-{n:04}',) for n in range(1000)] if after is None else [('old-last',)]
        def identities(got, names):
            self.assertIs(got,state)
            self.assertEqual(len(names),1004)
            return {name:str(n+1) for n,name in enumerate(names) if name!='missing'}
        with patch.object(S.Q,'snapshot',snapshot),patch.object(S.agents,'search_page',side_effect=page) as pages, \
                patch.object(S.T,'_identities',side_effect=identities):
            result = S.resolve('slug',('pin','missing','\ud800'),dict(query='old',state='archived'))
        self.assertEqual(snapshots,['slug'])
        self.assertEqual(pages.call_args_list[1].args[3],'old-0999')
        self.assertEqual(result['cursor'],dict(org_uuid='u',incarnation='i',rev=7))
        self.assertEqual(result['missing'],['missing'])
        self.assertEqual(result['names'],{'pin':'1','\ud800':'3'})
        self.assertEqual(len(result['matches']),1001)


if __name__ == '__main__':
    unittest.main()
