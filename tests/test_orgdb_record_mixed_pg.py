"""Actual mixed scalar/rename saves and effective tree records on disposable PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from dataclasses import replace
import unittest
from unittest.mock import patch

import test_orgdb_schema_rename_pg as fixture
import test_orgdb_record_tree_pg as legacy_tree
from orgtree import ledger, lifecycle_tx, orgtx, store
from orgtree.orgdb import graph, native_move, registry
from orgtree.orgdb import record_reads as Q, record_tree as T
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


def seed(slug):
    org = fixture.populate(store.load_org(slug))
    retained = copy.deepcopy(org.nodes['child'])
    retained.update(parent='worker@0', state='archived', seat_id='retained-seat',
                    session_id='retained-session', bearer_state=None)
    org.nodes['bearer-child'] = retained
    for name in ('boss', 'worker', 'worker@0', 'child', 'bearer-child'):
        org.nodes[name]['scope']['tools']['bash'] = True
    org.nodes['owner']['scope']['tools']['bash'] = False
    store.save_org(org)


@fixture.f.needs_pg
class Mixed(unittest.TestCase):
    def setUp(self):
        self.twins = fixture.f.Twins('records-mixed-' + self._testMethodName, before=seed)
        self.slug = self.twins.copy
        self.keys = {name: str(key) for name, key in fixture.ids(self.slug).items()}
        self.registry = T.register(Registry())
        self.selections = (Selection(), Selection('sub:1', (self.keys['child'],)),
                           Selection('sub:2', (self.keys['bearer-child'],)))

    def plan(self):
        updates, shares, sections, logs = lifecycle_tx.rename_rows(
            self.slug, ledger.USER, 'worker', 'renamed')
        move_updates, move_shares = native_move.planned_rows(self.slug, lambda org:
            native_move.rows(org, ledger.USER, [('worker', 'owner')]))
        updates = set(updates) | move_updates
        shares = (set(shares) | move_shares) - updates
        spec = lifecycle_tx.SPECS['move']
        return dict(nodes=sorted(updates), share_nodes=sorted(shares),
                    structural_roots=sorted(updates | shares),
                    sections=sorted(set(sections) | set(spec.sections) | {'work_items'}),
                    share_sections=spec.share_sections, logs=list(logs) + list(spec.logs))

    @staticmethod
    def table(rows):
        return {(row['set'], row['entity'], row['id']): row for row in rows}

    def initial(self):
        with Q.snapshot(self.slug) as state:
            state = replace(state, now=1791158400.)
            rows = self.table(Q.records(self.registry, state, self.selections))
            context, _ = T._context(state, frozenset(row['id'] for row in rows.values()
                                                   if row['entity'] == 'agent'))
            for name in ('child', 'bearer-child'):
                # Archived cards omit details exactly as the foreground does.
                # Exercise the real formatter before that summary step too.
                body = context.tree_node(name, descend=False, lineage=False)
                self.assertTrue(body['scope']['tools']['bash'], name)
                self.assertTrue(body['configured_scope']['tools']['bash'], name)
            return rows, Q.cursor(state)

    def assert_lock_modes(self, raw):
        from psycopg.errors import LockNotAvailable
        plan = graph.current_plan(raw)
        self.assertFalse(plan['whole'])
        self.assertTrue({int(self.keys[n]) for n in ('worker', 'worker@0', 'boss', 'owner')}
                        <= set(plan['agents']))
        self.assertTrue({'worker', 'worker@0', 'owner'} <= set(plan['updates']))
        self.assertNotIn('boss', plan['updates'])
        with registry.connection(self.slug) as observer:
            for name in ('worker', 'worker@0', 'owner'):
                with self.assertRaises(LockNotAvailable), observer.transaction():
                    observer.execute('SELECT id FROM orgtree.agents WHERE id=%s FOR SHARE NOWAIT',
                                     (int(self.keys[name]),)).fetchall()
            with self.assertRaises(LockNotAvailable), observer.transaction():
                observer.execute('SELECT id FROM orgtree.agents WHERE id=%s FOR UPDATE NOWAIT',
                                 (int(self.keys['boss']),)).fetchall()
            with observer.transaction():
                self.assertEqual(observer.execute('SELECT id FROM orgtree.agents WHERE id=%s '
                                 'FOR SHARE NOWAIT', (int(self.keys['boss']),)).fetchone(),
                                 (int(self.keys['boss']),))

    def write(self, *, fail=False, witness=False):
        with orgtx.org_tx(self.slug, **self.plan()) as tx:
            if witness:
                self.assert_lock_modes(native_move.connection(tx.org))
            tx.org.move(ledger.USER, 'worker', 'owner')
            tx.org.rename(ledger.USER, 'worker', 'renamed')
            tx.org.nodes['renamed']['charter'] = 'Mixed scalar and ordinary payload'
            fixture.item(tx.org, 'owned-item')['title'] = 'Mixed docket payload'
            if fail:
                raise RuntimeError('rollback after scalar, rename and payload')

    def compare(self, before, cursor, *, state=None):
        if state is None:
            with Q.snapshot(self.slug) as current:
                return self.compare(before, cursor, state=replace(current, now=1791158400.))
        frame = Q.catchup(self.registry, state, cursor, selections=self.selections)
        self.assertEqual(frame['type'], 'record_changes')
        result = dict(before)
        for replacement in frame.get('replacements', ()):
            result = {key: row for key, row in result.items() if key[0] != replacement['set']}
            result.update(self.table(replacement['records']))
        for row in frame['tombstones']:
            result.pop((row['set'], row['entity'], row['id']), None)
        result.update(self.table(frame['upserts']))
        self.assertEqual(result, self.table(Q.records(self.registry, state, self.selections)))
        return result, Q.cursor(state), frame

    def assert_effective_bodies(self, rows, bash=False):
        with Q.snapshot(self.slug) as state:
            state = replace(state, now=1791158400.)
            expected = legacy_tree.Tree.foreground(self, state, ['child', 'bearer-child'])['nodes']
            ids = frozenset(row['id'] for row in rows.values() if row['entity'] == 'agent')
            context, selected = T._context(state, ids)
            from orgtree import foreground_context
            legacy_context = foreground_context.build(state.raw, state.slug, selected, now_ts=state.now)
            for name in ('child', 'bearer-child'):
                bodies = [row['body'] for row in rows.values()
                          if row['entity'] == 'agent' and row['id'] == self.keys[name]]
                self.assertTrue(bodies)
                for body in bodies:
                    self.assertEqual(body.get('scope'), expected[name].get('scope'))
                    self.assertEqual(body.get('configured_scope'), expected[name].get('configured_scope'))
                full = context.tree_node(name, descend=False, lineage=False)
                legacy_full = legacy_context.tree_node(name, descend=False, lineage=False)
                self.assertEqual(full['scope'], legacy_full['scope'])
                self.assertEqual(full['configured_scope'], legacy_full['configured_scope'])
                self.assertEqual(full['scope']['tools']['bash'], bash)
                self.assertTrue(full['configured_scope']['tools']['bash'])
            self.assertEqual(expected['child']['parent'], 'renamed')
            self.assertEqual(expected['bearer-child']['parent'], 'renamed@0')

    def test_scalar_rename_payload_keeps_ids_roles_and_refreshes_both_effective_children(self):
        with fixture.f.storage(True):
            before, cursor = self.initial()
            links = fixture.role_links(self.slug)
            with registry.connection(self.slug) as raw:
                children = raw.execute('SELECT id,parent_id,row_version FROM orgtree.agents '
                    "WHERE name IN ('child','bearer-child') ORDER BY id").fetchall()
            self.write(witness=True)
            rows, current, frame = self.compare(before, cursor)
            self.assertEqual(current.rev, cursor.rev + 1)
            self.assertEqual({r['set'] for r in frame['replacements']}, {'sub:1', 'sub:2'})
            key = ('sub:2', 'agent', self.keys['bearer-child'])
            self.assertNotEqual(rows[key]['body']['detail_rev'], before[key]['body']['detail_rev'])
            after = fixture.ids(self.slug)
            self.assertEqual(after['renamed'], int(self.keys['worker']))
            self.assertEqual(after['renamed@0'], int(self.keys['worker@0']))
            self.assertNotIn('worker', after)
            self.assertEqual(fixture.role_links(self.slug), links)
            with registry.connection(self.slug) as raw:
                self.assertEqual(raw.execute('SELECT id,parent_id,row_version FROM orgtree.agents '
                    "WHERE name IN ('child','bearer-child') ORDER BY id").fetchall(), children)
                self.assertEqual(graph.verify_stats(raw), [])
                captured = set(raw.execute('SELECT c.entity_id FROM orgtree.changes c '
                    'JOIN orgtree.revisions r USING(xid) WHERE r.rev=%s AND c.entity=\'~scope\'',
                    (current.rev,)).fetchall())
                for name in ('worker', 'worker@0'):
                    self.assertIn(('subtree:' + self.keys[name],), captured)
            loaded = store.load_org(self.slug)
            self.assertEqual(loaded.nodes['renamed']['charter'], 'Mixed scalar and ordinary payload')
            self.assertEqual(fixture.item(loaded, 'owned-item')['title'], 'Mixed docket payload')
            self.assert_effective_bodies(rows)

    def test_failed_mixed_body_rolls_back_data_stats_cursor_then_fresh_retry_succeeds(self):
        with fixture.f.storage(True):
            before, cursor = self.initial()
            physical = fixture.rows(self.slug)
            with self.assertRaisesRegex(RuntimeError, 'rollback after scalar'):
                self.write(fail=True)
            self.assertEqual(fixture.rows(self.slug), physical)
            with Q.snapshot(self.slug) as state:
                self.assertEqual(Q.cursor(state), cursor)
            self.write()
            rows, current, _ = self.compare(before, cursor)
            self.assertEqual(current.rev, cursor.rev + 1)
            self.assert_effective_bodies(rows)

    def test_omitted_scalar_baseline_seam_is_detected_and_restored_save_succeeds(self):
        with fixture.f.storage(True):
            before, cursor = self.initial()
            physical = fixture.rows(self.slug)
            with patch.object(graph, 'save_baselines', side_effect=lambda conn, d, lazy, changes: lazy), \
                    self.assertRaises(store.StaleWrite):
                self.write()
            self.assertEqual(fixture.rows(self.slug), physical)
            self.write()
            rows, current, _ = self.compare(before, cursor)
            self.assertEqual(current.rev, cursor.rev + 1)
            self.assert_effective_bodies(rows)

    def test_delayed_snapshot_and_scope_edit_then_move_out_use_final_current_chains(self):
        with fixture.f.storage(True):
            lifecycle_tx.move(self.slug, ledger.USER, 'owner', None)
            before, cursor = self.initial()
            # Owner starts restrictive. Shrink the old parent in an ordinary
            # scope save, then relax owner and move out in a later revision.
            with orgtx.org_tx(self.slug, nodes=['boss', 'owner']) as tx:
                tx.org.nodes['boss']['scope']['tools']['bash'] = False
                tx.org.nodes['owner']['scope']['tools']['bash'] = True
            with Q.snapshot(self.slug) as old:
                old = replace(old, now=1791158400.)
                old_rows = self.table(Q.records(self.registry, old, self.selections))
                self.write()
                delayed, old_cursor, _ = self.compare(before, cursor, state=old)
                self.assertEqual(delayed, old_rows)
                self.assertEqual(old_cursor.rev, cursor.rev + 1)
            rows, current, frame = self.compare(before, cursor)
            self.assertEqual(current.rev, cursor.rev + 2)
            self.assertEqual({r['set'] for r in frame['replacements']}, {'sub:1', 'sub:2'})
            self.assert_effective_bodies(rows, bash=True)


if __name__ == '__main__':
    unittest.main()
