"""Reached clock publication, rollback and restart controls on disposable PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from datetime import timedelta
import asyncio
import threading
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_clock as C, record_time as T
from orgtree.orgdb import record_time_sources as S

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class Failure:
    def __init__(self, raw):
        self.raw = raw

    def __getattr__(self, name):
        return getattr(self.raw,name)

    def execute(self, sql, params=()):
        if sql.startswith('UPDATE orgtree.record_time_state'):
            raise RuntimeError('planted checkpoint failure')
        return self.raw.execute(sql,params)


class LockRequested(Failure):
    def __init__(self,raw,requested):
        super().__init__(raw)
        self.requested = requested

    def execute(self,sql,params=()):
        if sql.startswith('SELECT watermark'):
            self.requested.set()
        return self.raw.execute(sql,params)


@fixture.needs_pg
class Clock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record clock')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    def connect(self):
        return fixture.dbconn.connect(fixture.ADMIN,self.database)

    def checkpoint(self, raw, stamp):
        raw.execute('UPDATE orgtree.record_time_state SET watermark=%s',(stamp,))

    def state(self, raw):
        return raw.execute('SELECT rev,(SELECT watermark FROM orgtree.record_time_state),'
            '(SELECT count(*) FROM orgtree.revisions) FROM orgtree.org_revision').fetchone()

    def source(self, raw):
        now = raw.execute('SELECT clock_timestamp()').fetchone()[0]
        self.checkpoint(raw,now-timedelta(hours=2))
        keys = frozenset((('org','watchdogs'),('org','work_summary')))
        return lambda connection:[T.Boundary(now-timedelta(minutes=1),keys)],keys

    def test_missed_crossing_publishes_one_revision_and_notify_with_no_other_write(self):
        with self.connect() as raw,self.connect() as listener:
            provider,keys = self.source(raw)
            before = self.state(raw)
            listener.execute('LISTEN org_rev')
            received = []
            def same_connection(connection):
                self.assertIs(connection,raw)
                received.append(1)
                return provider(connection)
            answer = C.publish(raw,candidates=same_connection)
            after = self.state(raw)
            self.assertEqual(answer.records,keys)
            self.assertEqual(received,[1])
            self.assertEqual((after[0],after[2]),(before[0]+1,before[2]+1))
            self.assertGreater(after[1],before[1])
            captured = raw.execute('SELECT entity,entity_id FROM orgtree.changes c '
                'JOIN orgtree.revisions r USING(xid) WHERE r.rev=%s',(after[0],)).fetchall()
            self.assertEqual(set(captured),set(keys))
            self.assertEqual([int(n.payload.rsplit(':',1)[1]) for n in listener.notifies(timeout=.1)],
                             [after[0]])
        # A fresh connection simulates restart: no boot-time revision and no
        # repeated crossing once its durable checkpoint committed.
        with self.connect() as raw:
            before = self.state(raw)
            self.assertEqual(C.publish(raw,candidates=provider).records,frozenset())
            self.assertEqual(self.state(raw)[::2],before[::2])

    def test_checkpoint_failure_rolls_back_capture_and_retry_reaches_crossing(self):
        with self.connect() as raw,self.connect() as listener:
            provider,keys = self.source(raw)
            before = self.state(raw)
            listener.execute('LISTEN org_rev')
            with self.assertRaisesRegex(RuntimeError,'checkpoint'):
                C.publish(Failure(raw),candidates=provider)
            self.assertEqual(self.state(raw),before)
            self.assertEqual(list(listener.notifies(timeout=.1)),[])
            self.assertEqual(C.publish(raw,candidates=provider).records,keys)

    def test_two_workers_serialize_checkpoint_and_publish_only_once(self):
        reached,release,requested = threading.Event(),threading.Event(),threading.Event()
        errors,answers = [],[]
        with self.connect() as raw:
            provider,keys = self.source(raw)
            before = self.state(raw)
        def first_source(raw):
            reached.set()
            if not release.wait(10):
                raise TimeoutError('second worker did not release first')
            return provider(raw)
        def run(source,observe=False):
            try:
                with self.connect() as raw:
                    connection = LockRequested(raw,requested) if observe else raw
                    answers.append(C.publish(connection,candidates=source))
            except BaseException as exc:
                errors.append(exc)
        first = threading.Thread(target=run,args=(first_source,))
        second = threading.Thread(target=run,args=(provider,True))
        first.start()
        try:
            self.assertTrue(reached.wait(10))
            second.start()
            self.assertTrue(requested.wait(10),'second worker never requested checkpoint')
        finally:
            release.set()
            first.join(15)
            if second.ident is not None:
                second.join(15)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual(sorted(len(a.records) for a in answers),[0,len(keys)])
        with self.connect() as raw:
            self.assertEqual(self.state(raw)[0],before[0]+1)

    def test_backwards_clock_never_regresses_checkpoint_or_replays_and_nested_owner_refuses(self):
        with self.connect() as raw:
            provider,keys = self.source(raw)
            future = raw.execute("SELECT clock_timestamp()+interval '1 day'").fetchone()[0]
            self.checkpoint(raw,future)
            before = self.state(raw)
            self.assertEqual(C.publish(raw,candidates=provider).records,frozenset())
            self.assertEqual(self.state(raw),before)
            with raw.transaction():
                with self.assertRaisesRegex(ValueError,'own its transaction'):
                    C.publish(raw,candidates=provider)

    def test_native_request_tomb_docket_and_fable_sources_name_exact_clock_dependencies(self):
        with self.connect() as raw:
            now = raw.execute('SELECT clock_timestamp()').fetchone()[0]
            old = now-timedelta(seconds=2)
            with raw.transaction():
                raw.execute("UPDATE orgtree.asks SET status='answered',resolved_at=%s,"
                    "resolved_at_text=NULL WHERE node='dev'",(old-timedelta(seconds=900),))
                raw.execute('INSERT INTO orgtree.watchdog_tombs(ord,spent_at) VALUES (500,%s)',
                            (old-timedelta(seconds=15),))
                raw.execute("UPDATE orgtree.work_items SET docket_deadline=%s,docket_manual=false "
                            "WHERE slug='fix-the-thing'",(old.timestamp(),))
                raw.execute("UPDATE orgtree.work_items SET docket_deadline=%s,docket_manual=true "
                            "WHERE slug='second-item'",(old.timestamp(),))
                from psycopg.types.json import Json
                from orgtree import limits
                raw.execute("UPDATE orgtree.agents SET is_frozen=true WHERE name='boss'")
                raw.execute("UPDATE orgtree.agent_runtime SET frozen=%s,frozen_null=false "
                    "WHERE agent_id=(SELECT id FROM orgtree.agents WHERE name='boss')",
                    (Json(dict(until_ts=old.timestamp()+limits.MAX_HORIZON,
                               reset_src='provider',reason='network disconnected')),))
                raw.execute('UPDATE orgtree.org_settings SET fable_lock=%s,fable_lock_null=false',
                            (Json(dict(until_ts=old.timestamp())),))
                raw.execute("INSERT INTO orgtree.org_sections(key,ord,state) "
                    "SELECT 'fable_lock',coalesce(max(ord),-1)+1,'v' FROM orgtree.org_sections "
                    "ON CONFLICT(key) DO UPDATE SET state='v'")
            ids = dict(raw.execute('SELECT name,id FROM orgtree.agents WHERE NOT tombstone').fetchall())
            item = raw.execute("SELECT id FROM orgtree.work_items WHERE slug='fix-the-thing'").fetchone()[0]
            plan = T.Plan(S.boundaries(raw))
            expected = frozenset((('agent',str(ids['dev'])),('agent',str(ids['boss'])),('org','watchdogs'),
                ('org','work_summary'),('work_item',str(item)),('org','foreground'),('agent','*')))
            self.assertEqual(plan.due(now-timedelta(seconds=10),now),expected)
            self.checkpoint(raw,now-timedelta(seconds=10))
            before = self.state(raw)[0]
            self.assertEqual(C.publish(raw).records,expected)
            self.assertEqual(self.state(raw)[0],before+1)
            self.assertEqual(C.publish(raw).records,frozenset())
            # An open batch hides linger even when a resolved card is newer.
            raw.execute("UPDATE orgtree.asks SET status='open' WHERE node='dev'")
            self.assertNotIn(('agent',str(ids['dev'])),
                             T.Plan(S.boundaries(raw)).due(now-timedelta(seconds=10),now))


@fixture.needs_pg
class HostClock(unittest.TestCase):
    def test_automatic_expiry_catchup_matches_legacy_and_restart_makes_no_revision(self):
        from orgtree.orgdb import record_clock_host as H, record_reads as Q, record_tree as Tree
        from orgtree.orgdb.record_registry import Registry
        from orgtree import ledger
        def seed(slug):
            org = fixture.store.load_org(slug)
            for name,node in org.nodes.items():
                node.setdefault('session_id','clock-'+name)
                node.setdefault('bearer_state',None)
            for ask in org.d['asks']:
                ask['questions'] = [{'id':'clock-question','question':ask['question']}]
            fixture.store.save_org(org)
        twin = fixture.Twins('automatic clock',seed)
        database = fixture.registry.lookup(twin.copy)[1]
        builder = Tree.register(Registry())
        with fixture.storage(True),fixture.dbconn.connect(fixture.ADMIN,database) as raw:
            spent = raw.execute("SELECT clock_timestamp()-interval '10 seconds'").fetchone()[0]
            raw.execute("INSERT INTO orgtree.watchdog_tombs(ord,public_id,owner,name,kind,spent_at) "
                        "VALUES (501,'clock-dog','dev','automatic expiry','process',%s)",(spent,))
            raw.execute("INSERT INTO orgtree.org_sections(key,ord,state) "
                "SELECT 'watchdog_tombs',coalesce(max(ord),-1)+1,'v' FROM orgtree.org_sections "
                "ON CONFLICT(key) DO UPDATE SET state='v'")
            raw.execute('UPDATE orgtree.record_time_state SET watermark=clock_timestamp()')
            with Q.snapshot(twin.copy) as state:
                before = Q.cursor(state)
                initial = Tree.org_bodies(state,frozenset(('watchdogs',)))['watchdogs']
                self.assertIn('clock-dog',[w.get('id') for w in initial['watchdogs']])
            original = C.publish
            async def automatic():
                loop = asyncio.get_running_loop()
                published = asyncio.Event()
                errors = []
                def observe(connection,**kwargs):
                    result = original(connection,**kwargs)
                    if ('org','watchdogs') in result.records:
                        loop.call_soon_threadsafe(published.set)
                    return result
                with patch.object(H.registry,'active_slugs',return_value=[twin.copy]), \
                        patch.object(C,'publish',side_effect=observe):
                    timer = H.Timer(errors.append,discovery=60)
                    timer.start()
                    try:
                        await asyncio.wait_for(published.wait(),10)
                    finally:
                        await timer.close()
                self.assertEqual(errors,[])
            asyncio.run(automatic())
            with Q.snapshot(twin.copy) as state:
                frame = Q.catchup(builder,state,before)
                self.assertEqual(frame['type'],'record_changes')
                self.assertEqual(frame['to'],before.rev+1)
                updated = next(row['body'] for row in frame['upserts']
                               if row['entity']=='org' and row['id']=='watchdogs')
                doc = fixture.sections.decode_document(fixture.rowio.read(state.raw),
                    fixture.mappers.sections(),fixture.sections.Context())
                legacy = ledger.Org(doc).tree()['watchdogs']
                self.assertEqual(updated['watchdogs'],legacy)
                self.assertNotIn('clock-dog',[w.get('id') for w in legacy])
                after = Q.cursor(state)
            # Fresh host/connection reads the committed checkpoint; no boot
            # revision and no duplicate expiry, even without a later write.
            async def restart():
                loop,reached = asyncio.get_running_loop(),asyncio.Event()
                errors = []
                def worker(slugs):
                    result = H.sweep(slugs)
                    loop.call_soon_threadsafe(reached.set)
                    return result
                with patch.object(H.registry,'active_slugs',return_value=[twin.copy]):
                    timer = H.Timer(errors.append,worker=worker,discovery=60)
                    timer.start()
                    try:
                        await asyncio.wait_for(reached.wait(),3)
                    finally:
                        await timer.close()
                self.assertEqual(errors,[])
            asyncio.run(restart())
            with Q.snapshot(twin.copy) as state:
                self.assertEqual(Q.cursor(state),after)
            self.assertEqual(raw.execute("SELECT spent_at FROM orgtree.watchdog_tombs "
                "WHERE public_id='clock-dog'").fetchone()[0],spent)


if __name__ == '__main__':
    unittest.main()
