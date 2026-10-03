"""Archive counters and point authorization must stay independent of retained history.

Uses the existing native docket fixture in this checkout. Requires the P03
heavy lock and disposable PostgreSQL admin/runtime URLs.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import json
import random
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

import test_orgdb_docket_pg as fixture
from orgtree.ledger import USER
from orgtree.orgdb import conn, docket


setUpModule = fixture.setUpModule


class Cursor:
    def __init__(self, cur, calls):
        self.cur, self.calls = cur, calls

    def __enter__(self):
        self.cur.__enter__()
        return self

    def __exit__(self, *args):
        return self.cur.__exit__(*args)

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return self.cur.execute(sql, params)

    def __getattr__(self, key):
        return getattr(self.cur, key)


class Trace:
    def __init__(self, raw):
        self.raw, self.calls = raw, []

    def cursor(self, **kwargs):
        return Cursor(self.raw.cursor(**kwargs), self.calls)

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return self.raw.execute(sql, params)

    def __getattr__(self, key):
        return getattr(self.raw, key)


def scans(plan):
    if plan.get('Relation Name') in ('agents', 'work_items', 'docket_counters'):
        yield plan
    for child in plan.get('Plans', []):
        yield from scans(child)


def clone(raw, table, template, start, stop):
    """Populate native retained rows without copying authored detail children."""
    columns = [r[0] for r in raw.execute("SELECT attname FROM pg_attribute "
        "WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped "
        "AND attgenerated='' ORDER BY attnum", ('orgtree.' + table,))]
    values = {c: 'original.' + fixture.codec.quote(c) for c in columns}
    values.update(id='1000000 + n', ord='1000000 + n')
    if table == 'agents':
        values.update(name="'growth-agent-' || n", parent_id='NULL', parent='NULL',
                      parent_null='true', state="'archived'")
        key = 'name'
    else:
        values.update(slug="'growth-item-' || n", list_key="'archive'",
                      status="'in_progress'", docket_deadline='NULL')
        if 'archive_seq' in columns:
            values['archive_seq'] = '1000000 + n'
        key = 'slug'
    raw.execute('INSERT INTO orgtree.' + table + ' (' + fixture.codec.quoted(columns) +
                ') SELECT ' + ','.join(values[c] for c in columns) +
                ' FROM orgtree.' + table + ' original CROSS JOIN generate_series(%s,%s) n '
                'WHERE original.' + key + '=%s', (start, stop, template))


@unittest.skipUnless(fixture.ADMIN and fixture.RUNTIME, 'needs disposable URLs: NOT EXECUTED')
class DocketGrowth(unittest.TestCase):
    def setUp(self):
        self.switch = fixture.patch.dict(fixture.os.environ, {'ORGTREE_STORAGE': 'orgdb'})
        self.switch.start()
        self.addCleanup(self.switch.stop)

    def test_archive_counter_matches_random_changes_and_rollback(self):
        rng = random.Random(71845)
        with fixture.writer() as raw:
            before = raw.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='archive'").fetchone()[0]
            counted = raw.execute("SELECT n FROM orgtree.docket_counters WHERE kind='archive'").fetchone()[0]
            self.assertEqual(counted, before)
            clone(raw, 'work_items', 'secret', 1, 12)
            # All statement deltas are still pending until the deferred flush.
            self.assertEqual(raw.execute("SELECT n FROM orgtree.docket_counters WHERE kind='archive'").fetchone()[0], before)
        try:
            for _ in range(64):
                n = rng.randrange(1, 13)
                action = rng.randrange(3)
                rollback = rng.randrange(4) == 0
                savepoint = rng.randrange(3) == 0
                with conn.connect(fixture.RUNTIME, fixture.DATABASE) as raw:
                    raw.execute('BEGIN')
                    if savepoint:
                        raw.execute('SAVEPOINT discarded')
                    if action == 0:
                        raw.execute("UPDATE orgtree.work_items SET list_key=CASE list_key WHEN 'archive' THEN 'active' ELSE 'archive' END WHERE id=%s", (1000000+n,))
                    elif action == 1:
                        raw.execute('DELETE FROM orgtree.work_items WHERE id=%s', (1000000+n,))
                    elif not raw.execute('SELECT 1 FROM orgtree.work_items WHERE id=%s', (1000000+n,)).fetchone():
                        clone(raw, 'work_items', 'secret', n, n)
                    if savepoint:
                        raw.execute('ROLLBACK TO SAVEPOINT discarded')
                    raw.execute('ROLLBACK' if rollback else 'COMMIT')
                with fixture.snapshot() as q:
                    expected = q.raw.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='archive'").fetchone()[0]
                    actual = q.raw.execute("SELECT n FROM orgtree.docket_counters WHERE kind='archive'").fetchone()[0]
                    self.assertEqual(actual, expected)
                    # Attention can pull a physical archive row onto the main list.
                    self.assertEqual(q.counts()['archived'], expected + 1 - 2)
        finally:
            with fixture.writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE id BETWEEN 1000001 AND 1000012')

    def test_archive_counter_and_policy_share_the_repeatable_snapshot(self):
        with fixture.snapshot() as old:
            before = old.counts()
            with fixture.writer() as raw:
                clone(raw, 'work_items', 'secret', 20, 20)
            try:
                self.assertEqual(old.counts(), before)
                with fixture.snapshot() as new:
                    self.assertEqual(new.counts()['archived'], before['archived'] + 1)
            finally:
                with fixture.writer() as raw:
                    raw.execute('DELETE FROM orgtree.work_items WHERE id=1000020')

    def test_concurrent_commits_do_not_lose_archive_deltas(self):
        barrier = threading.Barrier(2)
        with fixture.snapshot() as q:
            before = q.raw.execute("SELECT n FROM orgtree.docket_counters WHERE kind='archive'").fetchone()[0]

        def add(n):
            with fixture.writer() as raw:
                clone(raw, 'work_items', 'secret', n, n)
                barrier.wait(timeout=10)

        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(add, n) for n in (30, 31)]
                for future in futures:
                    future.result(timeout=20)
            with fixture.snapshot() as q:
                actual = q.raw.execute("SELECT n FROM orgtree.docket_counters WHERE kind='archive'").fetchone()[0]
                self.assertEqual(actual, before + 2)
                self.assertEqual(actual, q.raw.execute("SELECT count(*) FROM orgtree.work_items WHERE list_key='archive'").fetchone()[0])
        finally:
            with fixture.writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE id IN (1000030,1000031)')

    def test_deferred_flush_updates_once_and_zero_net_work_does_not_update(self):
        with conn.connect(fixture.ADMIN, fixture.DATABASE) as raw:
            raw.execute('CREATE TABLE orgtree.test_docket_counter_writes(n bigint)')
            raw.execute('GRANT SELECT,INSERT ON orgtree.test_docket_counter_writes TO ' + fixture.codec.quote(conn.role_of(fixture.RUNTIME)))
            raw.execute("CREATE FUNCTION orgtree.test_docket_counter_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO orgtree.test_docket_counter_writes VALUES(NEW.n); RETURN NEW; END$$")
            raw.execute('CREATE TRIGGER test_docket_counter_write AFTER UPDATE ON orgtree.docket_counters FOR EACH ROW EXECUTE FUNCTION orgtree.test_docket_counter_write()')
        try:
            with fixture.writer() as raw:
                clone(raw, 'work_items', 'secret', 40, 40)
                clone(raw, 'work_items', 'secret', 41, 41)
                clone(raw, 'work_items', 'secret', 42, 42)
                self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.test_docket_counter_writes').fetchone()[0], 0)
            with fixture.writer() as raw:
                self.assertEqual(raw.execute('SELECT count(*) FROM orgtree.test_docket_counter_writes').fetchone()[0], 1)
                raw.execute("UPDATE orgtree.work_items SET list_key='active' WHERE id=1000040")
                raw.execute("UPDATE orgtree.work_items SET list_key='archive' WHERE id=1000040")
                raw.execute("UPDATE orgtree.work_items SET title=title WHERE id=1000041")
                raw.execute('DELETE FROM orgtree.work_items WHERE id=-1')
                raw.execute('SAVEPOINT discarded')
                raw.execute('DELETE FROM orgtree.work_items WHERE id=1000042')
                raw.execute('ROLLBACK TO SAVEPOINT discarded')
            with fixture.snapshot() as q:
                self.assertEqual(q.raw.execute('SELECT count(*) FROM orgtree.test_docket_counter_writes').fetchone()[0], 1)
        finally:
            with conn.connect(fixture.ADMIN, fixture.DATABASE) as raw:
                raw.execute('DROP TRIGGER test_docket_counter_write ON orgtree.docket_counters')
                raw.execute('DROP FUNCTION orgtree.test_docket_counter_write()')
                raw.execute('DROP TABLE orgtree.test_docket_counter_writes')
            with fixture.writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE id BETWEEN 1000040 AND 1000042')

    def test_all_point_reads_have_flat_scan_work_with_retained_history(self):
        record = next(r for r in fixture.DOC['work_items'] if r['slug'] == 'one')
        samples = {}
        probes = {
            'desktop_counts': (USER, lambda q: q.counts()),
            'ancestor_lookup': ('boss', lambda q: q.lookup('one')),
            'ancestor_foreground': ('boss', lambda q: q.foreground()),
            'identity_parents': ('boss', lambda q: q.identities(['worker', 'worker@0'])),
        }
        try:
            with fixture.writer() as raw:
                fixture.NativePaths.replace_record(raw, dict(record, created_by={'node': 'other'}))
            start = 1
            for size in (2048, 20480):
                with fixture.writer() as raw:
                    clone(raw, 'agents', 'other', start, size)
                    clone(raw, 'work_items', 'secret', start, size)
                start = size + 1
                with conn.connect(fixture.ADMIN, fixture.DATABASE) as raw:
                    raw.execute('ANALYZE orgtree.agents')
                    raw.execute('ANALYZE orgtree.work_items')
                for label, (viewer, probe) in probes.items():
                    with self.subTest(size=size, probe=label), fixture.snapshot(viewer) as q:
                        traced = Trace(q.raw)
                        query = docket.Snapshot(traced, fixture.OID, viewer=viewer, now_ts=fixture.NOW)
                        result = probe(query)
                        if label == 'ancestor_lookup':
                            self.assertEqual(result.summary['slug'], 'one')
                        elif label == 'ancestor_foreground':
                            self.assertIn('one', {r.summary['slug'] for r in result})
                        elif label == 'identity_parents':
                            self.assertEqual(result['worker']['parent'], 'boss')
                        plans = []
                        for sql, params in traced.calls:
                            if str(sql).lstrip().startswith(('SELECT', 'WITH')):
                                plans.extend(scans(q.raw.execute('EXPLAIN (ANALYZE,FORMAT JSON) ' + sql, params).fetchone()[0][0]['Plan']))
                        examined = sum((p.get('Actual Rows', 0) + p.get('Rows Removed by Filter', 0) +
                                        p.get('Rows Removed by Index Recheck', 0)) * p.get('Actual Loops', 1) for p in plans)
                        self.assertTrue(plans, 'real native SQL must execute')
                        samples.setdefault(label, []).append((len(traced.calls), examined))
                        self.assertFalse(any(p['Node Type'] == 'Seq Scan' for p in plans
                                             if p.get('Relation Name') in ('agents', 'work_items')), plans)
            print('DOCKET_GROWTH=' + json.dumps(samples, sort_keys=True))
            for label, pair in samples.items():
                self.assertEqual(pair[0], pair[1], label)
        finally:
            with fixture.writer() as raw:
                raw.execute('DELETE FROM orgtree.work_items WHERE id BETWEEN 1000001 AND 1020480')
                raw.execute('DELETE FROM orgtree.agents WHERE id BETWEEN 1000001 AND 1020480')
                fixture.NativePaths.replace_record(raw, record)


if __name__ == '__main__':
    unittest.main()
