"""Explicit rename prepass, working baselines and once-only CAS handoff."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import contextlib
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from orgtree import store
from orgtree.orgdb import codec, renames as N
from orgtree.orgdb.compat import rows as R, sql as S
from orgtree.orgdb.mappers import agents as A


class Result:
    def __init__(self, rows=(), rowcount=0):
        self.rows, self.rowcount = list(rows), rowcount

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class Database:
    def __init__(self):
        self.agents = {4: {'name': 'a', 'body': {'title': 'A'}, 'parent': None},
                       5: {'name': 'a@0', 'body': {'title': 'A'}, 'parent': 4},
                       6: {'name': 'child', 'body': {'title': 'Child'}, 'parent': 4},
                       7: {'name': 'b', 'body': {}, 'parent': None, 'tombstone': True}}
        self.children = {4: ['mailbox', 'tools', 'turns'], 5: ['bearer history']}
        self.calls = []

    def live(self):
        return {row['name']: aid for aid, row in self.agents.items()
                if not row.get('tombstone')}

    def nodes(self, _c, wanted, **kwargs):
        self.calls.append(('bodies', tuple(wanted)))
        out = []
        for name, aid in self.live().items():
            if name not in wanted:
                continue
            record = copy.deepcopy(self.agents[aid]['body'])
            parent = self.agents[aid]['parent']
            if parent is not None:
                record['parent'] = self.agents[parent]['name']
            out.append((name, R.dumps(record), 'version'))
        return out

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if sql.startswith('SELECT id FROM orgtree.agents WHERE name=ANY'):
            return Result([(aid,) for name, aid in self.live().items() if name in params[0]])
        if sql.startswith('SELECT name,id FROM orgtree.agents'):
            return Result([(name, aid) for name, aid in self.live().items() if name in params[0]])
        if sql.startswith('SELECT id FROM orgtree.agents WHERE name=%s'):
            aid = self.live().get(params[0])
            return Result([(aid,)] if aid is not None else [])
        if sql.startswith('UPDATE orgtree.agents SET name='):
            new, aid, old = params
            if self.agents[aid]['name'] != old:
                return Result(rowcount=0)
            self.agents[aid]['name'] = new
            return Result(rowcount=1)
        if sql.startswith('SELECT id,extra FROM orgtree.agents'):
            aid = self.live()[params[0]]
            return Result([(aid, {'unknown': [1, False]})])
        if sql.startswith('UPDATE orgtree.agents SET title='):
            title, extra, aid = params
            self.agents[aid]['body']['title'] = title
            self.agents[aid]['extra'] = extra
            return Result(rowcount=1)
        raise AssertionError(sql)


def fixture():
    db = Database()
    doc = store.LazyDoc('test')
    doc._snap_nodes = {name: raw for name, raw, _ in db.nodes(db, db.live())}
    dict.__setitem__(doc, 'nodes', {})
    return db, doc, SimpleNamespace(raw=db, tx=R.Tx(), orgdb=True,
                                    atomic=lambda **kw: contextlib.nullcontext())


class NativeRename(unittest.TestCase):
    def test_intent_tracks_chained_generations_and_return_to_original(self):
        intent = N.Intent(None)
        base = {'a': '{}', 'a@0': '{}'}
        intent.add({'a': 'b', 'a@0': 'b@0'}, base)
        intent.add({'b': 'a', 'b@0': 'a@0'}, base)
        self.assertEqual(intent.destinations, {'a': 'a', 'a@0': 'a@0'})
        self.assertEqual(len(intent.steps), 4)

    def test_new_hire_of_freed_name_is_not_the_persisted_origin(self):
        intent = N.Intent(None)
        intent.add({'a': 'b'}, {'a': '{}'})
        intent.add({'a': 'new-hire'}, {'a': '{}'})
        self.assertEqual(intent.steps, [('a', 'a', 'b')])

    def test_registration_is_transient_and_legacy_is_unchanged(self):
        doc = store.LazyDoc('s')
        doc._snap_nodes = {'a': '{}'}
        org = SimpleNamespace(d=doc)
        with patch.object(store, '_orgdb_on', return_value=False):
            self.assertIsNone(N.register(org, {'a': 'b'}))
            self.assertFalse(hasattr(org, '_native_rename_intent'))
        with patch.object(store, '_orgdb_on', return_value=True):
            self.assertIs(N.register(org, {'a': 'b'}).document, doc)
        self.assertNotIn('_native_rename_intent', dict(doc))
        org.d = store.rollback_copy(doc)
        with patch.object(store, '_orgdb_on', return_value=True):
            fresh = N.register(org, {'a': 'c'})
        self.assertEqual(fresh.steps, [('a', 'a', 'c')])
        N.clear(org)
        self.assertFalse(hasattr(org, '_native_rename_intent'))

    def test_prepass_keeps_ids_children_and_deleted_target_tombstone(self):
        db, doc, conn = fixture()
        children, tombstone = copy.deepcopy(db.children), copy.deepcopy(db.agents[7])
        snapshots = dict(doc._snap_nodes)
        intent = N.Intent(doc)
        intent.add({'a': 'b', 'a@0': 'b@0'}, snapshots)
        with patch.object(R, 'nodes', side_effect=db.nodes), patch.object(
                R.Names, 'lock', side_effect=lambda name: db.calls.append(('name-lock', name))):
            work = N.prepass(conn, doc, doc, intent, None)
        self.assertEqual(db.live(), {'b': 4, 'b@0': 5, 'child': 6})
        self.assertEqual(db.children, children)
        self.assertEqual(db.agents[7], tombstone)
        self.assertEqual(doc._snap_nodes, snapshots)
        self.assertEqual(json.loads(work._snap_nodes['child'])['parent'], 'b')
        self.assertEqual(conn.tx.rename_nodes, {'b', 'b@0'})
        self.assertEqual(set(conn.tx.rename_checked), {'b', 'b@0', 'child'})
        operations = [call[0] for call in db.calls]
        lock = next(i for i, sql in enumerate(operations) if 'FOR UPDATE' in sql)
        name_lock = operations.index('name-lock')
        update = next(i for i, sql in enumerate(operations) if sql.startswith('UPDATE'))
        self.assertLess(lock, name_lock)
        self.assertLess(name_lock, update)

    def test_stale_body_refuses_before_updates_and_preserves_baselines(self):
        db, doc, conn = fixture()
        baseline = dict(doc._snap_nodes)
        intent = N.Intent(doc)
        intent.add({'a': 'b'}, baseline)
        db.agents[4]['body']['concurrent'] = True
        with patch.object(R, 'nodes', side_effect=db.nodes):
            with self.assertRaises(store.StaleWrite):
                N.prepass(conn, doc, doc, intent, None)
        self.assertFalse(any(sql.startswith('UPDATE') for sql, _ in db.calls))
        self.assertEqual(doc._snap_nodes, baseline)
        self.assertEqual(conn.tx.rename_checked, {})

    def test_live_target_deleted_only_in_memory_is_explicitly_refused(self):
        db, doc, conn = fixture()
        db.agents[7]['tombstone'] = False
        intent = N.Intent(doc)
        intent.add({'a': 'b'}, doc._snap_nodes)
        with patch.object(R, 'nodes', side_effect=db.nodes), patch.object(R.Names, 'lock'):
            with self.assertRaisesRegex(store.StaleWrite, 'still taken'):
                N.prepass(conn, doc, doc, intent, None)
        self.assertEqual(db.agents[4]['name'], 'a')

    def test_repeated_rename_keeps_original_and_generation_ids(self):
        db, doc, conn = fixture()
        intent = N.Intent(doc)
        intent.add({'a': 'b', 'a@0': 'b@0'}, doc._snap_nodes)
        intent.add({'b': 'a', 'b@0': 'a@0'}, doc._snap_nodes)
        with patch.object(R, 'nodes', side_effect=db.nodes), patch.object(R.Names, 'lock'):
            work = N.prepass(conn, doc, doc, intent, None)
        self.assertEqual(db.live(), {'a': 4, 'a@0': 5, 'child': 6})
        self.assertEqual(work._snap_nodes, doc._snap_nodes)

    def test_working_split_and_log_baselines_are_copies(self):
        _, doc, _ = fixture()
        owner_key = 'mail' + store.SPLIT_SEP + 'a'
        doc._snap_doc = {owner_key: '[]', 'work_items': '[]'}
        section = store.SectionMap(sect='turn_log', owners=['a'])
        log = store.AppendLog([{'n': 1}], rows=[(66, '{"n":1}')])
        dict.__setitem__(section, 'a', log)
        section._snaps = {'a': log._rows}
        doc._snap_logs = {'turn_log': section._snaps}
        dict.__setitem__(doc, 'turn_log', section)
        N.move_owner(section, 'a', 'b')
        work = N.working(doc, {'a': 'b'}, {'b': '{}'})
        self.assertIn('mail' + store.SPLIT_SEP + 'b', work._snap_doc)
        self.assertIn(owner_key, doc._snap_doc)
        self.assertEqual(set(section._snaps), {'a'})
        self.assertEqual(set(work._snap_logs['turn_log']), {'b'})
        self.assertIs(dict.__getitem__(dict.__getitem__(work, 'turn_log'), 'b'), log)
        self.assertEqual(section._replaced, set())
        self.assertEqual(section._added, set())
        self.assertEqual(section._dropped, set())

    def test_prior_owner_replacement_is_not_lost_by_native_move(self):
        section = store.SectionMap(sect='turn_log', owners=['a'])
        section['a'] = [{'n': 2}]
        N.move_owner(section, 'a', 'b')
        self.assertEqual(section._replaced, {'b'})

    def test_once_only_cas_uses_handoff_without_a_second_body_read(self):
        _, _, conn = fixture()
        conn.tx.rename_checked['b'] = '{"title":"A"}'
        conn.tx.rename_nodes.add('b')
        with patch.object(R, 'nodes', side_effect=AssertionError('second baseline read')), patch.object(
                N, 'write_title_only', return_value=True) as write:
            self.assertEqual(S._node_cas(conn, ('{"title":"B"}', 'b', '{"title":"A"}')).rowcount, 1)
        write.assert_called_once()
        self.assertEqual(conn.tx.rename_checked, {})

    def test_wrong_handoff_baseline_is_not_a_cas_bypass(self):
        _, _, conn = fixture()
        conn.tx.rename_checked['b'] = '{"title":"A"}'
        with patch.object(R, 'node_put', side_effect=AssertionError('unsafe write')):
            self.assertEqual(S._node_cas(conn, ('{}', 'b', '{"title":"wrong"}')).rowcount, 0)

    def test_batch_cas_reads_only_unchecked_nodes(self):
        _, _, conn = fixture()
        conn.tx.rename_checked['b'] = '{}'
        with patch.object(R, 'nodes', return_value=[('other', '{}', 'v')]) as read, patch.object(
                R, 'node_put'):
            got = S._nodes_cas_batch(conn, (['b', 'other'], ['{}', '{}'], ['{}', '{}']))
        self.assertEqual(got.rowcount, 2)
        self.assertEqual(read.call_args.args[1], ['other'])

    def test_title_write_keeps_child_rows_and_unrelated_extra(self):
        db = Database()
        child_rows = copy.deepcopy(db.children)
        self.assertTrue(N.write_title_only(db, 'a', '{"title":"New"}', '{"title":"A"}'))
        self.assertEqual(db.children, child_rows)
        self.assertEqual(db.agents[4]['body']['title'], 'New')
        self.assertEqual(codec.from_column('json', db.agents[4]['extra']), {'unknown': [1, False]})
        self.assertFalse(any(sql.startswith('DELETE') or sql.startswith('INSERT') for sql, _ in db.calls))

    def test_real_non_title_changes_use_the_ordinary_writer(self):
        db = Database()
        self.assertFalse(N.write_title_only(db, 'a', '{"title":"New","grant":1}', '{"title":"A"}'))
        self.assertEqual(db.calls, [])

    def test_success_consumes_intent_after_baseline_adoption(self):
        doc = store.LazyDoc('rename-save')
        dict.__setitem__(doc, 'slug', 'rename-save')
        org = SimpleNamespace(d=doc)
        org._native_rename_intent = N.Intent(doc)
        conn = SimpleNamespace(execute=lambda *args: None, orgdb=True, tx=R.Tx())
        adopted = ({'slug': '"rename-save"'}, {'b': '{}'}, {}, ['slug', 'nodes'])

        def write(*args):
            conn.tx.rename_checked['b'] = '{}'
            conn.tx.rename_nodes.add('b')
            return adopted

        def verify(document, lazy):
            self.assertEqual(lazy._snap_nodes, {'b': '{}'})
            self.assertFalse(hasattr(org, '_native_rename_intent'))
            self.assertEqual(conn.tx.rename_checked, {})
            self.assertEqual(conn.tx.rename_nodes, set())

        with patch.object(store, '_ensure_migrated'), patch.object(store._POOL, 'acquire',
                return_value=contextlib.nullcontext(conn)), patch.object(store, '_write_doc',
                side_effect=write), patch.object(store, 'STORE_BACKEND', 'sqlite'), patch.object(
                store, '_SCOPED_VERIFY', True), patch.object(store, '_verify_scoped_save',
                side_effect=verify) as check, patch.object(store, '_resident', {}), patch.object(
                store, '_snap_gate', return_value=contextlib.nullcontext()), patch.object(
                store, '_publish_changes'), patch.object(store, '_bump_org_seq'):
            store._save_sqlite(org)
        check.assert_called_once()

    def test_failed_save_rolls_back_and_clears_intent_without_adoption(self):
        doc = store.LazyDoc('rename-failure')
        dict.__setitem__(doc, 'slug', 'rename-failure')
        doc._snap_nodes = {'a': '{"title":"A"}'}
        original = doc._snap_nodes
        org = SimpleNamespace(d=doc, _native_rename_intent=N.Intent(doc))
        calls = []
        conn = SimpleNamespace(execute=lambda sql: calls.append(sql), orgdb=True, tx=R.Tx())
        conn.tx.rename_checked['b'] = '{}'
        conn.tx.rename_nodes.add('b')
        with patch.object(store, '_ensure_migrated'), patch.object(store._POOL, 'acquire',
                return_value=contextlib.nullcontext(conn)), patch.object(store, '_write_doc',
                side_effect=store.StaleWrite('forced CAS failure')):
            with self.assertRaisesRegex(store.StaleWrite, 'forced CAS'):
                store._save_sqlite(org)
        self.assertEqual(calls, ['BEGIN IMMEDIATE', 'ROLLBACK'])
        self.assertIs(doc._snap_nodes, original)
        self.assertEqual(doc._snap_nodes, {'a': '{"title":"A"}'})
        self.assertFalse(hasattr(org, '_native_rename_intent'))
        self.assertEqual(conn.tx.rename_checked, {})
        self.assertEqual(conn.tx.rename_nodes, set())
        with patch.object(store, '_orgdb_on', return_value=True):
            retry = N.register(org, {'a': 'b'})
        self.assertEqual(retry.steps, [('a', 'a', 'b')])

    def test_rename_then_delete_compares_its_baseline_once(self):
        _, _, conn = fixture()
        conn.tx.rename_checked['b'] = '{"title":"A"}'
        with patch.object(R, 'nodes', side_effect=AssertionError('second baseline read')), patch.object(
                R, 'node_delete', return_value=1) as delete:
            self.assertEqual(S._node_cas_delete(conn, ('b', '{"title":"A"}')).rowcount, 1)
        delete.assert_called_once_with(conn.raw, 'b')
        self.assertEqual(conn.tx.rename_checked, {})

    def test_finished_save_cannot_bypass_a_later_cas_after_rollback_to_savepoint(self):
        _, _, conn = fixture()
        conn.tx.rename_checked['b'] = '{}'
        conn.tx.rename_nodes.add('b')
        N.finish(conn)               # before the enclosing savepoint can roll back
        with patch.object(R, 'nodes', return_value=[('b', '{"concurrent":true}', 'v')]) as read,\
                patch.object(R, 'node_put', side_effect=AssertionError('stale bypass')):
            self.assertEqual(S._node_cas(conn, ('{}', 'b', '{}')).rowcount, 0)
        read.assert_called_once()

    def test_reference_name_change_invalidates_a_cached_node_body(self):
        slot = ('test-server', 'rename-cache', 'test-incarnation')
        state = {'parent': 'a', 'stamp': '1'}
        heads = SimpleNamespace(execute=lambda *args: Result([
            (6, 'child', state['stamp'], '(0,6)', state['parent'], None, None)]))
        row = {'id': 6, 'tool_list_id': None, 'parent_id': 4,
               'predecessor_id': None, 'successor_id': None, '_xmin': '1', '_ctid': '(0,6)'}
        names = SimpleNamespace(load=lambda ids: list(ids), name=lambda aid: state['parent'])

        def decode(*args):
            return {'title': 'Child', 'parent': state['parent']}

        with patch.object(R, '_NODE_TEXTS', {}), patch.object(R, '_node_slot', return_value=slot),\
                patch.object(R, 'dict_rows', return_value=[row]), patch.object(R, '_node_children',
                return_value=(None, None, {}, {})), patch.object(A, 'decode_node', side_effect=decode) as read:
            first = R.nodes(heads, ['child'], names=names)[0][1]
            self.assertEqual(R.nodes(heads, ['child'], names=names)[0][1], first)
            self.assertEqual(read.call_count, 1)
            state['parent'] = 'b'      # child's own xmin/ctid did not change
            second = R.nodes(heads, ['child'], names=names)[0][1]
            self.assertEqual(json.loads(second)['parent'], 'b')
            self.assertNotEqual(second, first)
            self.assertEqual(read.call_count, 2)


if __name__ == '__main__':
    unittest.main()
