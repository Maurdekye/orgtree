"""Shared panel endpoint parity and real commit-boundary window changes."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import unittest

import test_orgdb_compat_pg as fixture
from orgtree import api
from orgtree.orgdb import record_reads as Q, record_panel_sql, record_panels
from orgtree.orgdb import record_shared_panels as P
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class SharedPanels(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for section in ('user_inbox', 'user_mail_log', 'user_outbox'):
                org.d[section] = [dict(id=f'{section}-{i}', body=f'body {i}',
                    at=fixture.AT, kind='message', **{'from': 'dev', 'to': 'ops'},
                    attachments=[dict(name='a.txt', path='a.txt', bytes=3)])
                    for i in range(54)]
            org.d['events'] = [dict(op='test', actor='dev', at=fixture.AT,
                detail=dict(node='ops', index=i), warnings=[f'warning {i}']) for i in range(304)]
            fixture.store.save_org(org)
        self.twin = fixture.Twins('shared panels '+self._testMethodName, seed)
        self.database = fixture.registry.lookup(self.twin.copy)[1]
        self.raw = fixture.dbconn.connect(fixture.ADMIN, self.database)
        self.addCleanup(self.raw.close)
        self.raw.execute("SET statement_timeout='10s'")
        # Install the exact declaration-generated extension on this disposable
        # database until the combined panel migration is assembled for landing.
        self.raw.execute(record_panel_sql.migration_sql((), record_panels.EXTENSIONS))
        self.registry = P.register(Registry())
        self.enterContext(fixture.storage(True))

    def baseline(self):
        with Q.snapshot(self.twin.copy) as state:
            rows = Q.records(self.registry, state)
            return {(r['entity'],r['id']):r['body'] for r in rows}, Q.cursor(state)

    def advance(self, held, after):
        with Q.snapshot(self.twin.copy) as state:
            frame = Q.catchup(self.registry, state, after)
            self.assertEqual(frame['type'], 'record_changes')
            for row in frame['tombstones']:
                held.pop((row['entity'],row['id']), None)
            for row in frame['upserts']:
                held[row['entity'],row['id']] = row['body']
            expected = {(r['entity'],r['id']):r['body'] for r in Q.records(self.registry,state)}
            self.assertEqual(held, expected)
            return held, Q.cursor(state), frame

    @staticmethod
    def rows(held, entity):
        return [v for (e,k),v in sorted(held.items(), key=lambda p:int(p[0][1]) if p[0][1].isdigit() else -1)
                if e == entity]

    def test_records_equal_endpoints_and_subscription_does_not_copy_shared_panels(self):
        held, _ = self.baseline()
        inbox = api.user_inbox(self.twin.copy)
        for folder, entity in (('pending','user_inbox'),('delivered','user_mail_log:shared'),('sent','user_outbox:shared')):
            self.assertEqual(self.rows(held,entity),inbox[folder])
        events = api.org_events(self.twin.copy, None, last=300)
        self.assertEqual(self.rows(held,'event:shared'),events['events'])
        self.assertEqual(held['org','events_count'],{'events_count':events['total']})
        with Q.snapshot(self.twin.copy) as state:
            self.assertEqual(Q.records(self.registry,state,(Selection('sub:1'),)),[])

    def test_insert_pushout_delete_promotion_and_outside_body_edit(self):
        held, after = self.baseline()
        key = self.raw.execute("INSERT INTO orgtree.events(ord,op,actor) VALUES(999999,'new','dev') RETURNING id").fetchone()[0]
        held, after, frame = self.advance(held,after)
        self.assertTrue(frame['tombstones'])
        self.assertEqual(held['event:shared',str(key)]['op'],'new')
        self.raw.execute('DELETE FROM orgtree.events WHERE id=%s',(key,))
        held, after, frame = self.advance(held,after)
        self.assertTrue(any(r['entity']=='event:shared' for r in frame['upserts']))
        self.raw.execute("UPDATE orgtree.event_warnings SET value='outside' WHERE events_id=(SELECT min(id) FROM orgtree.events)")
        held, after, frame = self.advance(held,after)
        self.assertEqual(frame['upserts'],[])

    def test_child_body_edits_reach_held_rows(self):
        held, after = self.baseline()
        self.raw.execute("UPDATE orgtree.user_outbox_attachments SET name='updated' WHERE user_outbox_id=(SELECT max(id) FROM orgtree.user_outbox)")
        held, after, frame = self.advance(held,after)
        self.assertEqual(len(frame['upserts']),1)
        self.assertEqual(frame['upserts'][0]['body']['attachments'][0]['name'],'updated')

    def test_two_captured_inserts_both_commit_orders_need_no_later_write(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse), ExitStack() as stack:
                writers = [stack.enter_context(fixture.dbconn.connect(fixture.ADMIN,self.database)) for _ in range(2)]
                keys = []
                for i, raw in enumerate(writers):
                    raw.execute("SET statement_timeout='10s'")
                    raw.execute('BEGIN')
                    keys.append(raw.execute('INSERT INTO orgtree.user_mail_log(ord,body) VALUES(%s,%s) RETURNING id',
                        (2000000+int(reverse)*2+i, f'writer {i}')).fetchone()[0])
                order = list(reversed(writers)) if reverse else writers
                try:
                    order[0].execute('COMMIT')
                    held, after = self.baseline()  # deliberately BETWEEN the commits
                    order[1].execute('COMMIT')
                    held, after, frame = self.advance(held,after)
                    self.assertEqual(len(self.rows(held,'user_mail_log:shared')),50)
                    for key in keys:
                        self.assertIn(('user_mail_log:shared',str(key)),held)
                finally:
                    for raw in writers:
                        raw.execute('ROLLBACK')


if __name__ == '__main__':
    unittest.main()
