"""Exact turn conversion, independent memberships and normalized metadata."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
import random
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from orgtree.orgdb import codec, mappers, sections, turns
from orgtree.orgdb.mappers import agents
from orgtree.orgdb.compat import rows as R


def round_trip(document, row_order=None):
    rows, _, _ = sections.encode_document(document, mappers.sections(), row_order=row_order)
    back = sections.decode_document(rows, mappers.sections(), sections.Context())
    if turns.exact(back) != turns.exact(document):
        raise AssertionError((back, document))
    return rows


def extra(row):
    value = row.get('extra')
    return value.obj if hasattr(value, 'obj') else value or {}


class TurnMembership(unittest.TestCase):
    def test_membership_edits_do_not_change_the_other_source(self):
        history = [{'n': n, 'model_usage_key': {'keys': ['m', 'm']}} for n in range(10)]
        db = MemoryTurns(round_trip({'nodes': {'a': {'turns': copy.deepcopy(history[-8:])}},
                                     'turn_log': {'a': history}}))
        with db.hooks():
            before_ids = [r['id'] for r in db.rows.values() if r['idx'] is not None]
            db.writes.clear()
            turns.reconcile_recent(db, 1, history[-7:] + [{'n': 10}])
            self.assertEqual(db.log(), history)
            self.assertEqual(db.recent(), history[-7:] + [{'n': 10}])
            self.assertEqual(sum(count for sql, count in db.writes if 'recent_pos=' in sql or
                                 sql.startswith('INSERT') or sql.startswith('DELETE')), 2)
            self.assertEqual([r['id'] for r in db.rows.values() if r['idx'] is not None], before_ids)
            # Editing just the recent copy of n=9 cannot edit the logged n=9.
            records = history[-7:-1] + [{'n': 9, 'cost': 88.0}, {'n': 10}]
            turns.reconcile_recent(db, 1, records)
            self.assertEqual(db.log(), history)
            self.assertEqual(db.recent(), records)
            turns.clear_recent(db, 1)
            self.assertEqual(db.log(), history)
            self.assertEqual(db.recent(), [])
            self.assertFalse(any(r['idx'] is None for r in db.rows.values()))

    def test_log_edit_forks_recent_and_log_delete_retains_recent_metadata(self):
        record = {'n': 3, 'model_usage_key': {'asked': 'm', 'keys': ['a', 'a']},
                  'cost_unknown_fields': ['cost', 'cost']}
        db = MemoryTurns(round_trip({'nodes': {'a': {'turns': [record]}},
                                     'turn_log': {'a': [copy.deepcopy(record)]}}))
        with db.hooks():
            original = copy.deepcopy(db.rows[1])
            changed = dict(record, cost=15.0)
            turns.rewrite_log(db, original, record, changed)
            self.assertEqual(db.log(), [changed])
            self.assertEqual(db.recent(), [record])
            self.assertEqual(db.rows[1]['idx'], 0)
            self.assertIsNone(db.rows[1]['recent_pos'])
            self.assertEqual(turns.remove_log(db, [1]), 1)
            self.assertEqual(db.log(), [])
            self.assertEqual(db.recent(), [record])
            self.assertEqual(turns.remove_log(db, list(db.rows)), 0)
            turns.clear_recent(db, 1)
            self.assertEqual(db.rows, {})
            self.assertTrue(all(not children for children in db.children.values()))

    def test_log_append_consolidates_occurrences_with_fresh_log_identity(self):
        record = {'n': 1, 'model_usage_key': ['a', 'a']}
        db = MemoryTurns(round_trip({'nodes': {'a': {'turns': [record, copy.deepcopy(record)]}}}))
        with db.hooks():
            turns.attach_log(db, 1, 12, 12, record)
            self.assertEqual(len(db.rows), 2)
            self.assertEqual(db.rows[12]['recent_pos'], 0)
            self.assertEqual(db.recent(), [record, record])
            turns.attach_log(db, 1, 13, 13, record)
            self.assertEqual(sorted(db.rows), [12, 13])
            self.assertEqual(db.rows[13]['recent_pos'], 1)
            self.assertEqual(db.log(), [record, record])
            self.assertEqual(db.recent(), [record, record])
            self.assertEqual(sum(len(child) for child in db.children.values()), 4)
            turns.remove_log(db, [12, 13])
            self.assertEqual(db.log(), [])
            self.assertEqual(db.recent(), [record, record])
            self.assertEqual(sum(len(child) for child in db.children.values()), 4)

    def test_noop_recent_save_does_not_probe_or_rewrite_history(self):
        records = [{'n': 1}, {'n': 2}]
        db = MemoryTurns(round_trip({'nodes': {'a': {'turns': records}}, 'turn_log': {'a': records}}))
        with db.hooks(), patch.object(turns, '_log_candidates', side_effect=AssertionError('cold probe')):
            turns.reconcile_recent(db, 1, copy.deepcopy(records))
        self.assertEqual(db.writes, [])

    def test_control_missing_agent_lock_rejects_every_membership_writer(self):
        record = {'n': 3, 'model_usage_key': {'keys': ['m']}}
        for operation in ['recent', 'append', 'rewrite', 'remove']:
            with self.subTest(operation=operation):
                db = MemoryTurns(round_trip({'nodes': {'a': {'turns': [record]}},
                                             'turn_log': {'a': [copy.deepcopy(record)]}}))
                before = copy.deepcopy((db.rows, db.children))
                with db.hooks(), patch.object(turns, 'lock_agents'):
                    with self.assertRaisesRegex(AssertionError, 'agent tier'):
                        if operation == 'recent':
                            turns.reconcile_recent(db, 1, [{'n': 4}])
                        elif operation == 'append':
                            turns.attach_log(db, 1, 12, 12, record)
                        elif operation == 'rewrite':
                            turns.rewrite_log(db, copy.deepcopy(db.rows[1]), record, {'n': 4})
                        else:
                            turns.remove_log(db, [1])
                self.assertEqual((db.rows, db.children), before)
                self.assertEqual(db.writes, [])

    def test_multiple_agents_lock_in_physical_id_order_before_turn_rows(self):
        calls = []
        class Raw:
            def execute(self, sql, params):
                calls.append((sql, params))
                return SimpleNamespace(fetchall=lambda: [])
        turns.lock_agents(Raw(), [8, 1, 8, 3])
        self.assertEqual(calls[0][1], ([1, 3, 8],))
        self.assertIn('ORDER BY id FOR UPDATE', calls[0][0])
        self.assertIn('orgtree.agents', calls[0][0])

    def test_ring_append_keeps_survivors_and_changes_at_most_two_memberships(self):
        for list_only in [False, True]:
            before = [({'id': n + 1, 'idx': None if list_only else n,
                        'recent_pos': 10 + 7 * n}, {'n': n}) for n in range(8)]
            records = [{'n': n} for n in range(1, 9)]
            candidates = [({'id': 20, 'idx': 20, 'recent_pos': None}, {'n': 8})]
            plan = turns.recent_plan(before, records, candidates)
            self.assertEqual(plan[:-1], [(row['id'], row['recent_pos']) for row, _ in before[1:]])
            self.assertEqual(plan[-1], (20, 60))
            old_positions = {row['id']: row['recent_pos'] for row, _ in before}
            new_positions = dict(plan)
            changed = {rid for rid in old_positions if new_positions.get(rid) != old_positions[rid]}
            changed |= {rid for rid, position in plan if old_positions.get(rid) != position}
            self.assertEqual(changed, {1, 20})

    def test_recent_rewrite_releases_keys_and_retains_exact_payload_ids(self):
        old = [({'id': i + 1, 'idx': i, 'recent_pos': i}, {'n': i}) for i in range(3)]
        records = [{'n': 9}, {'n': 0}, {'n': 1}, {'n': 2}]
        candidates = [({'id': 9, 'idx': 9, 'recent_pos': None}, {'n': 9})]
        self.assertEqual(turns.recent_plan(old, records, candidates),
                         [(None, 3), (1, 4), (2, 5), (3, 6)])
        records = [{'n': 2}, {'n': 1}, {'n': 0}, {'n': 1}]
        candidates = [(row, value) for row, value in old]
        plan = turns.recent_plan(old, records, candidates)
        selected = [rid for rid, _ in plan if rid is not None]
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual([position for _, position in plan], sorted(position for _, position in plan))
        # A new older log match cannot precede an unchanged newer shared anchor.
        old = [({'id': 20, 'idx': 20, 'recent_pos': 0}, {'n': 20})]
        candidates = [({'id': 5, 'idx': 5, 'recent_pos': None}, {'n': 5})]
        self.assertEqual(turns.recent_plan(old, [{'n': 20}, {'n': 5}], candidates),
                         [(20, 0), (None, 1)])

    def test_selected_reader_bounds_payload_and_child_reach(self):
        rows = round_trip({'nodes': {'a': {'turns': [{'n': n, 'model_usage_key': ['m']} for n in range(10)]}},
                           'turn_log': {'a': [{'n': 99}]}})
        selected = [r for r in rows['agent_turns'] if r['recent_pos'] is not None][-3:]
        wanted = {r['id'] for r in selected}
        captured = []
        def query(raw, statement, params):
            captured.append((statement, params))
            if 'CROSS JOIN LATERAL' in statement:
                self.assertEqual(params, ([1], 3))
                self.assertIn('recent_pos IS NOT NULL', statement)
                self.assertIn('ORDER BY recent_pos DESC', statement)
                return selected
            table = statement.split('FROM orgtree.')[1].split(' ')[0]
            self.assertEqual(set(params[0]), wanted)
            self.assertIn('WHERE turn_id=ANY(%s)', statement)
            return [r for r in rows.get(table, []) if r['turn_id'] in wanted]
        with patch.object(turns, '_dict_rows', side_effect=query):
            recent = turns.read_recent(None, [1], limit=3)
        self.assertEqual([record['n'] for record in recent[1]], [7, 8, 9])
        self.assertEqual(len(captured), 3)
        self.assertEqual(turns.read_recent(None, []), {})
        with self.assertRaises(ValueError):
            turns.read_recent(None, [1], limit=-1)

    def test_log_surfaces_exclude_list_only_members(self):
        ls = R.model().logs['turn_log']
        self.assertEqual(R._scope(ls), 'idx IS NOT NULL')
        self.assertEqual(R._scope(ls, ' AND id=%s'), 'idx IS NOT NULL AND id=%s')
        sqls = []
        class Raw:
            def execute(self, sql, params=()):
                sqls.append(sql)
                return SimpleNamespace(fetchone=lambda: (0,), fetchall=lambda: [], rowcount=0)
        raw = Raw()
        self.assertFalse(R.log_has(raw, ls))
        self.assertEqual(R.log_count(raw, ls), 0)
        self.assertEqual(R.log_owner_tail(raw, ls, 1, 3, None), [])
        self.assertEqual(R.log_owners_by_first(raw, ls), [])
        self.assertTrue(all('idx IS NOT NULL' in sql for sql in sqls))

    def test_common_tail_shares_payload_and_metadata_once(self):
        history = [{'n': n, 'cost': float(n), 'cost_unknown_fields': ['cost', 'cost'],
                    'model_usage_key': {'asked': 'model', 'matched': True, 'keys': ['a', 'a']}}
                   for n in range(19)]
        document = {'nodes': {'a': {'turns': copy.deepcopy(history[-8:])}},
                    'turn_log': {'a': history}}
        rows = round_trip(document)
        self.assertEqual(len(rows['agent_turns']), 19)
        self.assertEqual([r['idx'] for r in rows['agent_turns'] if r['recent_pos'] is not None],
                         list(range(11, 19)))
        self.assertEqual(len(rows['agent_turn_model_usage_keys']), 38)
        self.assertEqual(len(rows['agent_turn_cost_unknown_fields']), 38)
        self.assertNotIn('agent_recent_turns', rows)
        self.assertNotIn('agent_recent_turns', agents.AGENTS.layout())
        self.assertEqual(tuple(turns.TABLE.link.values()), ('turn_id',))
        for child in ('agent_turn_model_usage_keys', 'agent_turn_cost_unknown_fields'):
            self.assertTrue(all(set(r) == {'turn_id', 'pos', 'value'} for r in rows[child]))

    def test_pre_log_and_conflicting_number_time_keep_separate_occurrences(self):
        recent = [{'n': 1, 'at': 'old', 'cost': 1.0}, {'n': 2, 'at': 'same', 'cost': 2.0}]
        logged = [{'n': 2, 'at': 'same', 'cost': 99.0}]
        rows = round_trip({'nodes': {'a': {'turns': recent}}, 'turn_log': {'a': logged}})
        self.assertEqual(len(rows['agent_turns']), 3)
        self.assertEqual(sum(r['idx'] is None for r in rows['agent_turns']), 2)
        # No log container is fabricated for a recent-only owner.
        rows = round_trip({'nodes': {'before': {'turns': recent}}, 'turn_log': {'empty': []}})
        self.assertEqual(len(rows['agent_turns']), 2)
        self.assertEqual([r['state'] for r in rows['org_section_owners']], ['l'])

    def test_matching_is_type_exact_ordered_and_occurrence_preserving(self):
        logged = [(1, {'x': 1}), (2, {'x': 1.0}), (3, {'x': True}),
                  (4, {'x': -0.0}), (5, {'x': 0.0}), (6, {'x': 1}), (7, {'x': 1})]
        recent = [{'x': 1}, {'x': 1}, {'x': 1.0}, {'x': True}, {'x': -0.0}, {'x': 0.0}]
        selected = turns.match(recent, logged)
        self.assertEqual(selected, [None, 1, 2, 3, 4, 5])
        self.assertEqual(turns.match([{'x': 1}] * 3, logged), [1, 6, 7])
        self.assertEqual(turns.match([{'x': '\0\ud800', 'y': [0, 0.0]}],
                                    [(9, {'y': [0, 0.0], 'x': '\0\ud800'})]), [9])
        self.assertEqual(turns.match([{'n': 1, 'unknown': 2}], [(1, {'n': 1})]), [None])

    def test_log_ids_and_cross_owner_source_order_are_retained(self):
        document = {'nodes': {'a': {'turns': [{'n': 2}]}, 'b': {'turns': [{'n': 1}, {'n': 7}]}},
                    'turn_log': {'a': [{'n': 1}, {'n': 2}], 'b': [{'n': 1}]}}
        rows = round_trip(document, {'turn_log': {'a': [1, 3], 'b': [2]}})
        logged = sorted((r['id'], r['agent_id'], r['idx']) for r in rows['agent_turns']
                        if r['idx'] is not None)
        self.assertEqual(logged, [(1, 1, 0), (2, 2, 0), (3, 1, 1)])
        self.assertEqual(next(r['id'] for r in rows['agent_turns'] if r['idx'] is None), 4)

    def test_recent_gaps_preserve_full_list_without_implied_trim(self):
        document = {'nodes': {'a': {'turns': [{'n': n} for n in range(12)]}},
                    'turn_log': {'a': [{'n': n} for n in range(13)]}}
        rows, _, _ = sections.encode_document(document, mappers.sections())
        for row in rows['agent_turns']:
            if row['recent_pos'] is not None:
                row['recent_pos'] = 10 + 7 * row['recent_pos']
        rows['agent_turns'].reverse()
        back = sections.decode_document(rows, mappers.sections(), sections.Context())
        self.assertEqual(turns.exact(back), turns.exact(document))
        self.assertEqual(len(back['nodes']['a']['turns']), 12)

    def test_absent_null_empty_and_malformed_containers_remain_distinct(self):
        values = [codec.MISSING, None, [], False, 0, {}, ['not a record'], [{'n': None}]]
        for value in values:
            for logged in [codec.MISSING, None, {}, {'a': None}, {'a': []}]:
                with self.subTest(recent=value, logged=logged):
                    node = {} if value is codec.MISSING else {'turns': copy.deepcopy(value)}
                    document = {'nodes': {'a': node}}
                    if logged is not codec.MISSING:
                        document['turn_log'] = copy.deepcopy(logged)
                    rows = round_trip(document)
                    self.assertNotIn('agent_recent_turns', rows)

    def test_metadata_shapes_keep_exact_values_and_use_children_when_fitting(self):
        values = [codec.MISSING, None, [], {}, '', False, 0, 1.0, ['a', 'a'],
                  [None], ['a', 2], ['\0\ud800'], {'asked': None, 'matched': None},
                  {'asked': 'm', 'matched': False, 'keys': []},
                  {'asked': 1.0, 'matched': 0, 'keys': [True], 'unknown': ['\0\ud800']},
                  {'keys': ['a', 'a'], 'unknown': {'value': 0.0}}]
        for field in ['cost_unknown_fields', 'model_usage_key']:
            for value in values:
                with self.subTest(field=field, value=value):
                    record = {'n': 1}
                    if value is not codec.MISSING:
                        record[field] = copy.deepcopy(value)
                    rows = round_trip({'nodes': {'a': {'turns': [record]}},
                                       'turn_log': {'a': [copy.deepcopy(record)]}})
                    row = rows['agent_turns'][0]
                    self.assertNotIn(field, row)
                    if value == ['a', 'a'] or (field == 'model_usage_key' and
                            value == {'keys': ['a', 'a'], 'unknown': {'value': 0.0}}):
                        self.assertNotEqual(extra(row).get(field), value)
                        child = 'agent_turn_cost_unknown_fields' if field == 'cost_unknown_fields' \
                                else 'agent_turn_model_usage_keys'
                        self.assertEqual([r['value'] for r in rows[child]], ['a', 'a'])

    def test_randomized_occurrences_round_trip_without_log_or_recent_loss(self):
        rng = random.Random(107008)
        choices = [{'n': 1}, {'n': 1.0}, {'n': True}, {'n': None}, {},
                   {'n': 3, 'cost_unknown_fields': ['x', 'x']},
                   {'model_usage_key': {'asked': 'm', 'keys': ['x'], 'matched': False}},
                   {'n': '\0\ud800', 'unknown': {'v': -0.0}}]
        for iteration in range(120):
            nodes, logs = {}, {}
            for name in ['a', 'b']:
                history = [copy.deepcopy(rng.choice(choices)) for _ in range(rng.randrange(25))]
                recent = copy.deepcopy(history[-rng.randrange(1, 12):])
                if rng.randrange(2):
                    recent.insert(0, copy.deepcopy(rng.choice(choices)))
                if rng.randrange(3) == 0:
                    recent.reverse()
                nodes[name] = {'turns': recent}
                logs[name] = history
            with self.subTest(iteration=iteration):
                rows = round_trip({'nodes': nodes, 'turn_log': logs})
                self.assertEqual(sum(r['idx'] is not None for r in rows['agent_turns']),
                                 sum(map(len, logs.values())))

    def test_metadata_schema_and_frozen_migration_keep_separate_contracts(self):
        fields = dict(codec.columns(turns.SPEC))
        expected = {'cost_unknown_fields_is': 'char(1)', 'model_usage_key_is': 'char(1)',
                    'model_usage_asked': 'text', 'model_usage_asked_null': 'boolean',
                    'model_usage_matched': 'boolean', 'model_usage_matched_null': 'boolean',
                    'model_usage_keys_is': 'char(1)'}
        self.assertEqual({key: fields[key] for key in expected}, expected)
        self.assertNotIn('model_usage_key', fields)
        self.assertNotIn('cost_unknown_fields', fields)
        frozen = '\n'.join(mappers.ddl())
        self.assertIn('CREATE TABLE orgtree.agent_recent_turns', frozen)
        self.assertNotIn('recent_pos bigint', frozen)
        self.assertIn('"model_usage_key" json', frozen)
        self.assertIn('"cost_unknown_fields" json', frozen)
        self.assertNotIn('agent_turn_model_usage_keys', frozen)

    def test_membership_codec_requires_an_explicit_reader(self):
        with self.assertRaisesRegex(ValueError, 'membership reader'):
            codec.decode(agents.HOT, {'turns_is': 'l'}, None, (1,))
        with self.assertRaises(codec.ShapeError):
            round_trip({'nodes': {'a': {'turns': [{'n': float('nan')}]}}})


class MemoryTurns:
    """Strict in-memory executor for mutation unit controls; PostgreSQL is a separate gate."""
    def __init__(self, rows):
        self.rows = {r['id']: copy.deepcopy(r) for r in rows.get('agent_turns', [])}
        self.children = {name: copy.deepcopy(rows.get(name, [])) for name in turns.TABLE.layout()
                         if name != 'agent_turns'}
        self.next_id = max(self.rows, default=0) + 1
        self.writes = []
        self.locked_agents = set()

    def hooks(self):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(R, 'fetch', side_effect=self.fetch))
        stack.enter_context(patch.object(R, 'new_ids', side_effect=self.ids))
        stack.enter_context(patch.object(R, 'store_encoded', side_effect=self.store))
        stack.enter_context(patch.object(turns, '_log_candidates', side_effect=lambda *args:
            [(row, turns.payload(row, codec.Children(self.children, turns.TABLE.layout())))
             for row in self.rows.values() if row['idx'] is not None]))
        return stack

    def ids(self, raw, table, count):
        result = list(range(self.next_id, self.next_id + count))
        self.next_id += count
        return result

    def store(self, raw, table, encoded, ids):
        for row in encoded.get('agent_turns', []):
            if row['agent_id'] not in self.locked_agents:
                raise AssertionError('turn mutation precedes the agent tier')
            rid = row['id']
            if rid in self.rows:
                raise AssertionError('duplicate turn ID')
            if row['recent_pos'] is not None and any(
                    other['agent_id'] == row['agent_id'] and other['recent_pos'] == row['recent_pos']
                    for other in self.rows.values()):
                raise AssertionError('recent unique key was not cleared')
            self.rows[rid] = copy.deepcopy(row)
            self.next_id = max(self.next_id, rid + 1)
            self.writes.append(('INSERT payload', 1))
        for name in self.children:
            self.children[name].extend(copy.deepcopy(encoded.get(name, [])))

    def fetch(self, raw, table, where, params, **kwargs):
        if where != 'agent_id=%s AND recent_pos IS NOT NULL':
            raise AssertionError(where)
        if kwargs.get('lock') and params[0] not in self.locked_agents:
            raise AssertionError('turn row lock precedes the agent tier')
        picked = sorted((r for r in self.rows.values() if r['agent_id'] == params[0]
                         and r['recent_pos'] is not None), key=lambda r: r['recent_pos'])
        return picked, codec.Children(self.children, turns.TABLE.layout())

    def execute(self, sql, params=()):
        if sql.startswith('SELECT id FROM orgtree.agents'):
            if 'ORDER BY id FOR UPDATE' not in sql:
                raise AssertionError('agent tier must lock rows in physical id order')
            self.locked_agents.update(params[0])
            return SimpleNamespace(fetchall=lambda: [(aid,) for aid in params[0]])
        if sql.startswith('SELECT DISTINCT agent_id FROM orgtree.agent_turns'):
            return SimpleNamespace(fetchall=lambda: [(r['agent_id'],) for r in self.rows.values()
                                   if r['id'] in params[0] and r['idx'] is not None])
        if not (sql.startswith('UPDATE orgtree.agent_turns') or sql.startswith('DELETE FROM orgtree.agent_turns')):
            raise AssertionError(sql)
        if 'recent_pos=%s' in sql:
            row = self.rows[params[1]]
            if row['agent_id'] not in self.locked_agents:
                raise AssertionError('turn mutation precedes the agent tier')
            row['recent_pos'] = params[0]
            count = 1
        else:
            wanted = params[0] if 'id=ANY(%s)' in sql else [params[0]]
            picked = [r for r in self.rows.values() if r['id'] in wanted]
            if 'AND idx IS NULL' in sql:
                picked = [r for r in picked if r['idx'] is None]
            if 'AND idx IS NOT NULL' in sql:
                picked = [r for r in picked if r['idx'] is not None]
            if 'AND recent_pos IS NOT NULL' in sql:
                picked = [r for r in picked if r['recent_pos'] is not None]
            if 'AND recent_pos IS NULL' in sql:
                picked = [r for r in picked if r['recent_pos'] is None]
            count = len(picked)
            if any(r['agent_id'] not in self.locked_agents for r in picked):
                raise AssertionError('turn mutation precedes the agent tier')
            for row in picked:
                if sql.startswith('DELETE'):
                    del self.rows[row['id']]
                    for name in self.children:
                        self.children[name] = [r for r in self.children[name] if r['turn_id'] != row['id']]
                elif 'SET idx=NULL' in sql:
                    row['idx'] = None
                elif 'SET recent_pos=NULL' in sql:
                    row['recent_pos'] = None
                else:
                    raise AssertionError(sql)
        self.writes.append((sql, count))
        return SimpleNamespace(rowcount=count)

    def recent(self):
        return turns.recent_values(dict(self.children, agent_turns=list(self.rows.values()))).get(1, [])

    def log(self):
        children = codec.Children(self.children, turns.TABLE.layout())
        return [turns.payload(r, children) for r in sorted(
            (row for row in self.rows.values() if row['idx'] is not None), key=lambda r: r['idx'])]


if __name__ == '__main__':
    unittest.main()
