"""Structural per-tick read volume at fixed active population, no timing claim."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_policy_candidates_pg as fixture
from orgtree import policy_context, store, supervisor as sup, warmpool

tearDownModule = fixture.tearDownModule


class StopTick(BaseException):
    pass


def resume_tick():
    targets = []
    class Thread:
        def __init__(self, target, **kw): targets.append(target)
        def start(self): pass
    with patch.object(sup, '_auto_resume_started', False), \
            patch.object(sup.threading, 'Thread', Thread):
        sup.start_auto_resume_loop()
        with patch.object(sup.time, 'sleep', side_effect=[None, StopTick]):
            try: targets[0]()
            except StopTick: pass


@unittest.skipUnless(fixture.fixture.ADMIN, 'private PostgreSQL required: NOT RUN')
class LoopVolume(unittest.TestCase):
    setUpClass = fixture.CandidateReads.__dict__['setUpClass']
    setUp = fixture.CandidateReads.setUp
    query = fixture.CandidateReads.query

    def test_archived_growth_does_not_grow_periodic_read_rows_or_bytes(self):
        import psycopg
        seed = store.load_org(self.slug).node('worker')
        results = []
        for archived in (1154, 11540):
            with store._POOL.acquire(self.slug) as conn:
                conn.execute('BEGIN')
                conn.execute("DELETE FROM nodes WHERE id<>'worker'")
                rows = []
                for i in range(29 + archived):
                    node = dict(seed, state='live' if i < 29 else 'archived',
                                seat_id=f'seat-{i}', charter='retained content ' * 64)
                    rows.append((f'node-{i:05}', i+10, json.dumps(node)))
                conn.executemany('INSERT INTO nodes(id,ord,val) VALUES(?,?,?)', rows)
                conn.execute('COMMIT')
                conn.execute('ANALYZE nodes')
                conn.execute('ANALYZE doc')
            loops = {
                'working': lambda: sup._working_checkup_pass(now=1900000000, mode_enabled=True),
                'reminder': lambda: sup._idle_docket_reminder_pass(now=1900000000, mode_enabled=True),
                'cache_keeper': lambda: sup._working_cache_keeper_pass(now=1900000000, checkup_mode_enabled=False),
                'invariant': lambda: sup._invariant_sweep_org(self.slug),
                'resume_tick_including_invariant': resume_tick,
                'warm_keeper': warmpool._keeper_pass,
                'warm_snapshot': warmpool._pool_snapshot,
            }
            for mode in ('legacy_cold', 'projected'):
                for name, run in loops.items():
                    count = {'rows': 0, 'bytes': 0}
                    scalars = []
                    one, many = psycopg.Cursor.fetchone, psycopg.Cursor.fetchall
                    def record(rows):
                        count['rows'] += len(rows)
                        count['bytes'] += sum(len(json.dumps(r, default=str, ensure_ascii=False).encode()) for r in rows)
                        scalars.extend(r for r in rows if len(r)==1 and isinstance(r[0], (int, float)))
                    def fetchone(cur):
                        row = one(cur)
                        if row is not None: record([row])
                        return row
                    def fetchall(cur):
                        rows = many(cur); record(rows); return rows
                    with store._doc_cache_lock:
                        store._doc_cache.pop(self.slug, None)
                    with ExitStack() as stack:
                        stack.enter_context(patch.object(store, 'org_slugs', return_value=[self.slug]))
                        stack.enter_context(patch.object(warmpool, 'warm_enabled', return_value=True))
                        stack.enter_context(patch.object(warmpool, '_pool', {}))
                        stack.enter_context(patch.object(warmpool, '_serving', {}))
                        stack.enter_context(patch.object(warmpool, '_busy', return_value=True))
                        stack.enter_context(patch.object(warmpool, 'node_excluded', return_value=False))
                        stack.enter_context(patch.object(warmpool, '_journal'))
                        stack.enter_context(patch.object(sup, '_working_cache_idle', return_value=True))
                        reserve = stack.enter_context(patch.object(sup, '_working_checkup_reserve'))
                        remind = stack.enter_context(patch.object(sup, '_idle_docket_reminder_reserve'))
                        repair = stack.enter_context(patch.object(sup, '_computed_tx'))
                        resume = stack.enter_context(patch.object(sup, '_auto_resume_org'))
                        if mode == 'legacy_cold':
                            stack.enter_context(patch.object(policy_context, 'read', side_effect=lambda slug, **kw: store.cached_org(slug)))
                            stack.enter_context(patch.object(policy_context, 'org_rows', side_effect=store.cached_list))
                        else:
                            stack.enter_context(patch.object(store, 'cached_org', side_effect=AssertionError('history fallback')))
                        stack.enter_context(patch.object(psycopg.Cursor, 'fetchone', fetchone))
                        stack.enter_context(patch.object(psycopg.Cursor, 'fetchall', fetchall))
                        run()
                        for action in (reserve, remind, repair, resume): action.assert_not_called()
                    self.assertGreater(count['rows'], 0, (mode, name))
                    results.append(dict(archived=archived, live=30, mode=mode, loop=name, scalar_reads=scalars, **count))
        dest = os.environ.get('POLICY_LOOP_VOLUME_OUTPUT')
        if dest: Path(dest).write_text(json.dumps(results, indent=2), encoding='utf-8')
        print('POLICY_LOOP_VOLUME ' + json.dumps(results), flush=True)
        for name in loops:
            tip = [r for r in results if r['mode']=='projected' and r['loop']==name]
            self.assertEqual(tip[0]['rows'], tip[1]['rows'], (name, tip))
            # Revision/count scalar decimal widths can move; no source bodies
            # or result cardinality may grow with unrelated node history.
            self.assertLessEqual(abs(tip[0]['bytes']-tip[1]['bytes']), 32, (name, tip))
            old = [r for r in results if r['mode']=='legacy_cold' and r['loop']==name]
            self.assertGreater(old[1]['bytes'], old[0]['bytes'] * 5)


if __name__ == '__main__': unittest.main()
