"""The docket foreground list runs a bounded number of statements.

docket-foreground-list-runs-565-sql-statements-p: at N1000 the foreground
route ran 565 statements per request (p95 3.3 s): per listed item one
work_list_summary read, three work_read_questions reads (`_work_view`,
`_work_attention`, `_work_archived`), one lookup per visible pointer and one
nodes read per actor. The view is unchanged; this pins it to the complete
ledger oracle on a real-shaped docket (questions, attention flags, pointers,
many distinct actors, archived rows) and the statement count to a constant.

Run:  python tools/run-python-verification.py tests/test_worklist_statements_pg.py
"""
from collections import Counter
import json
import re
import sys
import unittest
from unittest.mock import patch

import psycopg

import test_pgstore as f
import test_pg_work_list_view as lists
from orgtree import worklist
from orgtree.ledger import USER


def tearDownModule():
    f.tearDownModule()


class _Count:
    def __init__(self):
        self.sql = Counter()

    def __enter__(self):
        original = psycopg.Connection.execute
        count = self.sql

        def execute(conn, query, *a, **kw):
            text = query if isinstance(query, str) else str(query)
            count[re.sub(r'\s+', ' ', text)[:90]] += 1
            return original(conn, query, *a, **kw)
        self.patch = patch.object(psycopg.Connection, 'execute', execute)
        self.patch.__enter__()
        return self

    def __exit__(self, *exc):
        return self.patch.__exit__(*exc)

    @property
    def total(self):
        return sum(self.sql.values())


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class Statements(unittest.TestCase):
    setUp = lists.Lists.setUp
    tearDown = lists.Lists.tearDown
    add = lists.Lists.add
    refresh = lists.Lists.refresh
    item = lists.Lists.item
    foreground = lists.Lists.foreground
    oracle = lists.Lists.oracle

    @classmethod
    def setUpClass(cls):
        lists.store.claim_data_root()

    def actor(self, nid):
        self.c.execute(
            f'INSERT INTO {self.s}.nodes(id,ord,val) VALUES(%s,99,%s) ON CONFLICT(id) DO NOTHING',
            (nid, json.dumps(dict(id=nid, name=nid, parent='a', children=[], state='live',
                                  seat_id='seat-' + nid, generation=1))))

    def docket(self, start, end):
        """Items start..end-1: distinct owners, reviewers and participants,
        a parent and a dependency chain, a hidden pointer, questions on some,
        attention on some, and archived rows beside them."""
        for n in range(start, end):
            for who in ('own', 'rev', 'mem'):
                self.actor(f'{who}-{n}')
            extra = {}
            if n % 3 == 0:
                extra['manual_attention'] = {'reason': 'look ' + str(n)}
            if n > start:
                extra['parent'] = f'w-{n - 1}'
                extra['dependencies'] = [f'w-{n - 1}', 'secret', 'nowhere']
            if n % 4 == 1:
                extra['superseded_by'] = 'secret'
            self.add(self.item(f'w-{n}', owner={'node': f'own-{n}', 'generation': 0},
                               created_by={'node': f'own-{n}'},
                               reviewer={'node': f'rev-{n}', 'generation': 0},
                               participants=[f'mem-{n}', 'b'],
                               status=('review' if n % 2 else 'open'), **extra))
            self.add(self.item(f'old-{n}', status='done', docket_at='2020-01-01',
                               owner={'node': f'own-{n}', 'generation': 0}), True)

    def ask_on(self, slugs):
        value = [dict(id='ask-' + s, node='a', status='open',
                      questions=[dict(work_item=s, question='why ' + s + '?')]) for s in slugs]
        self.c.execute(f'INSERT INTO {self.s}.doc VALUES(%s,%s) ON CONFLICT(key) '
                       f'DO UPDATE SET val=excluded.val', ('asks', json.dumps(value)))

    def measure(self, viewer=USER, **kw):
        with _Count() as count:
            got = self.foreground(viewer, **kw)
        return got, count

    def test_view_equals_the_ledger_and_statements_do_not_grow_with_items(self):
        self.add(self.item('secret', owner={'node': 'c'}, created_by={'node': 'c'}), True)
        totals = {}
        for start, end in ((0, 4), (4, 24)):
            self.docket(start, end)
            self.ask_on([f'w-{n}' for n in range(0, end, 5)] + ['old-2'])
            self.refresh()
            for viewer in (USER, 'a', 'b'):
                for kw in ({}, {'backlogged': True}, {'archive_limit': 10}):
                    with self.subTest(n=end, viewer=viewer, kw=kw):
                        expected = self.oracle(viewer)
                        got, count = self.measure(viewer, **kw)
                        self.assertEqual(got['items'], expected['items'])
                        self.assertEqual(got['counts'], expected['counts'])
                        self.assertEqual(got['attention'], [r for r in expected['items']
                                                            if r.get('manual_attention')])
                        if 'archive_limit' in kw:
                            self.assertEqual(got['archived'], expected['archived'][:10])
                        totals[(end, viewer, tuple(kw))] = count
        print('statements per request (4 items, 24 items):', {
            f'{v}/{"+".join(k) or "plain"}': (totals[(4, v, k)].total, totals[(24, v, k)].total)
            for v in (USER, 'a', 'b') for k in ((), ('backlogged',), ('archive_limit',))},
            file=sys.stderr)
        for viewer in (USER, 'a', 'b'):
            for kw in ((), ('backlogged',), ('archive_limit',)):
                small, large = totals[(4, viewer, kw)], totals[(24, viewer, kw)]
                with self.subTest(viewer=viewer, kw=kw):
                    self.assertGreaterEqual(len(self.foreground(viewer)['items']), 1)
                    self.assertEqual(large.total, small.total,
                                     f'statements grew with the docket: {small.total} -> '
                                     f'{large.total}\n' + '\n'.join(
                                         f'{n:4d} {q}' for q, n in (large.sql - small.sql).most_common(8)))


if __name__ == '__main__':
    unittest.main()
