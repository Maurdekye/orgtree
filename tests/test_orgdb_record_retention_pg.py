"""Retention boundaries, rollback and read/bulk races on disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import threading
import unittest

import test_orgdb_compat_pg as fixture
from orgtree.orgdb import record_reads as Q, record_retention as R
from orgtree.orgdb.record_registry import Entity, Registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class BeforeFloor:
    """Delegate the real transaction, pausing only before its last write."""
    def __init__(self, raw, hook):
        self.raw, self.hook = raw, hook

    def __getattr__(self, name):
        return getattr(self.raw, name)

    def execute(self, sql, params=()):
        if sql.startswith('UPDATE orgtree.org_revision SET floor='):
            self.hook()
        return self.raw.execute(sql, params)


@fixture.needs_pg
class Retention(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record retention')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    def connect(self):
        return fixture.dbconn.connect(fixture.ADMIN, self.database)

    def seed(self, raw, *, old=10020):
        # Build committed history without 10,020 individual fixture commits.
        # Only this disposable database's change trigger is suspended, and it
        # is restored before exercising the real prune / bulk revision door.
        with raw.transaction():
            raw.execute('ALTER TABLE orgtree.changes DISABLE TRIGGER record_flush')
            raw.execute('TRUNCATE orgtree.changes,orgtree.revisions')
            raw.execute('UPDATE orgtree.org_revision SET rev=10020,floor=0')
            raw.execute("INSERT INTO orgtree.revisions(rev,xid,at) "
                "SELECT n,(n+500000)::text::xid8,clock_timestamp()- "
                "CASE WHEN n <= %s THEN interval '25 hours' ELSE interval '1 hour' END "
                "FROM generate_series(1,10020) n", (old,))
            raw.execute("INSERT INTO orgtree.changes(xid,entity,entity_id) "
                "SELECT xid,'org','watchdogs' FROM orgtree.revisions")
            raw.execute('ALTER TABLE orgtree.changes ENABLE TRIGGER record_flush')

    def state(self, raw):
        return raw.execute('SELECT rev,floor,(SELECT count(*) FROM orgtree.changes),'
                           '(SELECT count(*) FROM orgtree.revisions) '
                           'FROM orgtree.org_revision').fetchone()

    def registry(self):
        result = Registry()
        result.register(Entity('org',lambda state,selection:frozenset(('watchdogs',)),
            lambda state,ids:{key:dict(watchdogs=[]) for key in ids}))
        return result

    def test_both_age_and_revision_distance_apply_and_floor_itself_is_kept(self):
        with self.connect() as raw:
            for old, floor in ((10,10),(10020,20)):
                self.seed(raw,old=old)
                self.assertEqual(R.prune(raw),R.Pruned(floor,floor-1,floor-1))
                self.assertEqual(self.state(raw),(10020,floor,10021-floor,10021-floor))
                self.assertEqual(raw.execute('SELECT min(rev) FROM orgtree.revisions').fetchone()[0],floor)
                self.assertEqual(R.prune(raw),R.Pruned(None))

    def test_old_snapshot_keeps_complete_log_and_new_snapshot_resets_without_later_write(self):
        with self.connect() as raw, fixture.storage(True):
            self.seed(raw)
            with Q.snapshot(self.twin.copy) as old:
                cursor = Q.Cursor(old.stamp['org_uuid'],old.stamp['incarnation'],1)
                before = Q.catchup(self.registry(),old,cursor)
                self.assertEqual(before['to'],10020)
                self.assertEqual(len(before['upserts']),1)
                R.prune(raw)
                self.assertEqual(old.raw.execute('SELECT count(*) FROM orgtree.revisions').fetchone()[0],10020)
                self.assertEqual(Q.catchup(self.registry(),old,cursor),before)
            with Q.snapshot(self.twin.copy) as new:
                self.assertEqual(new.stamp['org_revision'],10020)
                self.assertEqual(new.stamp['floor'],20)
                self.assertEqual(Q.catchup(self.registry(),new,cursor),{'type':'record_reset'})

    def test_prune_last_floor_write_cannot_lower_a_concurrent_bulk_reset(self):
        reached, release = threading.Event(), threading.Event()
        errors, answers = [], []
        def pause():
            reached.set()
            if not release.wait(10):
                raise TimeoutError('bulk reset did not release prune')
        def prune():
            try:
                with self.connect() as raw:
                    answers.append(R.prune(BeforeFloor(raw,pause)))
            except BaseException as exc:
                errors.append(exc)
        with self.connect() as raw, self.connect() as listener:
            self.seed(raw)
            listener.execute('LISTEN org_rev')
            worker = threading.Thread(target=prune)
            worker.start()
            try:
                self.assertTrue(reached.wait(10),'prune never reached floor write')
                raw.execute('SELECT orgtree.invalidate_cursors()')
                self.assertEqual(self.state(raw)[:2],(10021,10021))
            finally:
                release.set()
                worker.join(15)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors,[])
            self.assertEqual(answers,[R.Pruned(10021,19,19)])
            self.assertEqual(self.state(raw),(10021,10021,10002,10002))
            notifications = list(listener.notifies(timeout=.2))
            self.assertEqual([int(n.payload.rsplit(':',1)[1]) for n in notifications],[10021])

    def test_failure_before_floor_rolls_back_both_deletes_and_rejects_nested_owner(self):
        def fail():
            raise RuntimeError('planted final-write failure')
        with self.connect() as raw:
            self.seed(raw)
            before = self.state(raw)
            with self.assertRaisesRegex(RuntimeError,'planted'):
                R.prune(BeforeFloor(raw,fail))
            self.assertEqual(self.state(raw),before)
            with raw.transaction():
                with self.assertRaisesRegex(ValueError,'own its transaction'):
                    R.prune(raw)
            self.assertEqual(R.prune(raw),R.Pruned(20,19,19))

    def test_young_history_is_noop_without_revision_or_notification(self):
        with self.connect() as raw, self.connect() as listener:
            self.seed(raw,old=0)
            listener.execute('LISTEN org_rev')
            before = self.state(raw)
            self.assertEqual(R.prune(raw),R.Pruned(None))
            self.assertEqual(self.state(raw),before)
            self.assertEqual(list(listener.notifies(timeout=.1)),[])


if __name__ == '__main__':
    unittest.main()
