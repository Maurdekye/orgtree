"""Actual native reader plans and work with 1x/10x retained history.

Run through run-python-verification.py under the P03 heavy lock. This module
creates disposable databases. Query output alone is not a work bound: capture
the complete public call, including stamps/counts, and replay its SELECTs with
EXPLAIN ANALYZE. Existing codec/parity tests remain the result-shape oracle.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import Mock, patch

import test_orgdb_compat_pg as fixture
from orgtree import (desktop_notifications as notices, foreground_store as foreground,
                     identity_context, policy_candidates, policy_context, policy_reads,
                     settingstx, store, tree_ui, turn_inputs)
from orgtree.orgdb import registry
from orgtree.ledger import Org

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule

BASE_HISTORY = 2048
BIG_TABLE_ROWS = 256
JSON_LOOKUP = re.compile(r"->|#>>?|json(?:b)?_extract_path|::\s*json(?:b)?\b", re.I)
# Only predicates and ordering, never Output: exact body decoding may use JSON.
HOT_CLAUSES = ('Filter', 'Index Cond', 'Recheck Cond', 'Join Filter', 'Hash Cond',
               'Merge Cond', 'Sort Key', 'Presorted Key', 'Order By')


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


def examined(plan):
    """Physical table/index rows, including rejected rows and repeated probes.

    Do not count aggregate output (one row can hide a full scan), CTE/worktable
    output twice, or a bitmap index's output again at its heap node.
    """
    return sum((node.get('Actual Rows', 0) + node.get('Rows Removed by Filter', 0)
                + node.get('Rows Removed by Index Recheck', 0))
               * node.get('Actual Loops', 0)
               for node in nodes(plan) if 'Relation Name' in node)


def violations(plan, big_tables, statement):
    failures = []
    for node in nodes(plan):
        table = node.get('Relation Name')
        if table in big_tables and node['Node Type'] == 'Seq Scan':
            failures.append(f"sequential scan of {table}")
        for clause in HOT_CLAUSES:
            # DISTINCT may sort a projected body value without ordering the
            # reader's hot selection (watchdog owner codec preservation).
            if clause in ('Sort Key', 'Presorted Key', 'Order By') and not re.search(
                    r'\bORDER\s+BY\b', statement, re.I):
                continue
            value = node.get(clause)
            if value is not None and JSON_LOOKUP.search(str(value)):
                failures.append(f"JSON lookup in {clause}: {value}")
    return failures


class RecordingCursor:
    def __init__(self, cursor, record):
        self._cursor, self._record = cursor, record

    def execute(self, statement, params=None, **kwargs):
        self._record(statement, params)
        self._cursor.execute(statement, params, **kwargs)
        return self

    def __enter__(self):
        self._cursor.__enter__()
        return self

    def __exit__(self, *exc):
        return self._cursor.__exit__(*exc)

    def __iter__(self):
        return iter(self._cursor)

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class RecordingConnection:
    def __init__(self, raw, queries):
        object.__setattr__(self, '_raw', raw)
        object.__setattr__(self, '_queries', queries)

    def _record(self, statement, params):
        sql = statement if isinstance(statement, str) else statement.as_string(self._raw)
        # The app registry uses a different connection; capture all org SELECTs,
        # including nested/recursive queries and the common snapshot prefix.
        if re.match(r'\s*(SELECT|WITH)\b', sql, re.I):
            self._queries.append((sql, copy.deepcopy(params)))

    def execute(self, statement, params=None, **kwargs):
        self._record(statement, params)
        return self._raw.execute(statement, params, **kwargs)

    def cursor(self, *args, **kwargs):
        return RecordingCursor(self._raw.cursor(*args, **kwargs), self._record)

    def __setattr__(self, name, value):
        setattr(self._raw, name, value)

    def __getattr__(self, name):
        return getattr(self._raw, name)


@contextmanager
def capture(queries):
    checkout, release = registry.checkout, registry.release
    registry.close_idle()
    with patch.object(registry, 'checkout', lambda *a: RecordingConnection(checkout(*a), queries)), \
            patch.object(registry, 'release', lambda raw, db: release(raw._raw, db)):
        yield


def seeded_document(template, slug, history, *, stray_names=False):
    """Real codec records; archive rows precede active rows in stored order.

    Active nodes, relationships, current mail, recent turns, presentation
    headers and policy settings stay fixed. Old mail/events/turn logs, closed
    requests and physical archives grow. Do not rely on a favourable history
    position or seed tombstones in place of real retained bodies.
    """
    doc = copy.deepcopy(template)
    doc['slug'] = slug
    # The primary fixture comes from the engine's actual constructor. Names
    # belong to the outer node map, never to the node body. Keep the supported
    # stray-name shape separately so rare-extra correction is guarded too.
    seed = Org(copy.deepcopy(template))
    seed.d['nodes'] = {}
    for name, parent in (('boss', None), ('dev', 'boss'), ('ops', 'boss')):
        seed._new_node('opus', parent, 10, name, [],
                       copy.deepcopy(seed.d['default_tools']), 'self', 'guard fixture')
    prototypes = seed.nodes
    doc['nodes'] = {}
    for i in range(history):
        name = f'archive-{i:06}'
        node = copy.deepcopy(prototypes['dev'])
        node.update(state='archived', archived_at=fixture.AT, title=name,
                    seat_id=f'seat-{name}', session_id=f'session-{name}', lineage=name,
                    cost_usd=0.25, turns=[dict(n=j, at=fixture.AT) for j in range(8)],
                    ui_order=-i-1)
        if stray_names:
            node['name'] = name
        doc['nodes'][name] = node
    for name, parent in (('boss', None), ('dev', 'boss'), ('ops', 'boss')):
        node = copy.deepcopy(prototypes[name])
        node.update(cost_usd=0.25, turns=[dict(n=j, at=fixture.AT) for j in range(8)])
        if stray_names:
            node['name'] = name
        doc['nodes'][name] = node
    doc['nodes']['ops']['frozen'] = {'reason': 'usage'}
    doc['mail'] = {'dev': [dict(id='current', **{'from': 'boss'}, body='current', at=fixture.AT)]}
    doc['delivering'] = {'dev': []}
    doc['mail_log'] = {owner: [dict(id=f'old-mail-{owner}-{i}', **{'from': sender},
                                  body='retained mail', at=fixture.AT) for i in range(history)]
                       for owner, sender in (('dev', 'ops'), ('ops', 'dev'))}
    doc['user_mail_log'] = [dict(id=f'old-user-mail-{i}', **{'from': 'dev'},
                                body='retained user mail', at=fixture.AT) for i in range(history)]
    doc['turn_log'] = {'dev': [dict(n=i, at=fixture.AT, cost=0.1, ms=50)
                              for i in range(history)]}
    doc['events'] = [dict(op='hire', actor='dev', at=fixture.AT, detail={'node': 'dev'})
                     for _ in range(history)]
    doc['notice_log'] = [dict(node='dev', at=fixture.AT, text='old notice')
                         for _ in range(history)]
    doc['org_inbox'] = [dict(id=f'inbox-{i}', **{'from': 'outside'},
                            body='old org message', at=fixture.AT) for i in range(history)]
    doc['org_inbox_read'] = 0
    doc['asks'] = [dict(id=f'closed-{i}', node='dev', question='retained question',
                        at=fixture.AT, status='answered', resolved_at=fixture.AT)
                    for i in range(history)]
    doc['asks'].append(dict(id='open', node='dev', question='current', at=fixture.AT, status='open'))
    doc['work_items_archive'] = [dict(fixture.item(f'archive-work-{i}', 'Old work'),
                                  status='done', archived_at=fixture.AT)
                                for i in range(history)]
    doc['work_items'] = [fixture.item('current-work', 'Current work')]
    doc['documents'] = [dict(id=f'document-{i}', node='dev', title='Current presentation',
                            at=fixture.AT, body='authored text', format='markdown') for i in range(10)]
    doc['watchdogs'] = [dict(id='current-dog', owner='dev', name='check', kind='file',
                            target='test.log', state='armed', at=fixture.AT)]
    doc['audiences'] = [dict(grantee='dev', grantor='user', reason='current')]
    doc.setdefault('_migrations', {})['pm_plan_stamp_heal'] = dict(at=fixture.AT, healed=[])
    return doc


def publish(doc):
    rows, _, _ = fixture.sections.encode_document(doc, fixture.mappers.sections(),
                                                  ignored=fixture.mappers.ignored_keys())
    lc = fixture.LC[0]
    org_id = lc.register_org(doc['slug'], state='converting')
    build = lc.open_build(org_id, 'convert')
    with fixture.dbconn.connect(fixture.RUNTIME, build.database, autocommit=False) as raw:
        fixture.rowio.write(raw, rows, order=fixture.rowio.tables(fixture.mappers.sections()))
        raw.commit()
    lc.mark_filled(build)
    lc.publish(build)
    with fixture.dbconn.connect(fixture.ADMIN, registry.lookup(doc['slug'])[1]) as raw:
        # Statistics belong to the owner/admin, never the runtime reader.
        raw.execute('ANALYZE')
    return {table: len(values) for table, values in rows.items()}


def readers():
    selected = {
        'a1_foreground': lambda slug: foreground.read_foreground(slug),
        'a1_exact': lambda slug: foreground.read_exact(slug, 'dev'),
        'a1_references': lambda slug: foreground.read_references(slug, ['dev', 'boss']),
        'a1_discovery': lambda slug: foreground.discover(slug, limit=2),
        'a1_funding': lambda slug: foreground.read_snapshot(slug,
            lambda raw, stamp: foreground.read_funding(raw)),
        'a1_identity': lambda slug: identity_context.load(slug, 'dev'),
        'a1_turn_inputs': lambda slug: turn_inputs.load(slug, 'dev', mail=True),
        'a1_cards': lambda slug: foreground.read_snapshot(slug,
            lambda raw, stamp: foreground.read_card_windows(raw, ['dev'], header=True)),
        'a1_inbox': lambda slug: foreground.read_snapshot(slug,
            lambda raw, stamp: foreground.read_org_inbox_window(raw)),
        'a4_policy_graph': policy_candidates.read,
        'a4_policy_context': policy_context.read,
        'a4_watchdog': policy_reads.watchdog_org,
        'a4_stamp_heal': settingstx._plan_stamp_heal_completed,
        'a4_notification_probe': notices._probe,
        'a4_notification_frozen': lambda slug: notices._frozen_direct(slug, fixture.AT),
        'a4_tree_revision': tree_ui._committed,
        'a6_mail': lambda slug: store.read_node_inbox(slug, 'dev', keep=3, slack=0),
        'a6_user_inbox': store.read_user_inbox,
        'a6_history': lambda slug: store.read_node_history_rows(slug, 'dev', cap=3),
        'a6_events': lambda slug: store.read_events_page(slug, last=3),
        'a6_gallery': store.read_document_gallery,
        'a6_document': lambda slug: store.read_document(slug, 'document-0'),
    }
    selected.update({'robust_' + name: reader for name, reader in list(selected.items())
                     if name.startswith('a1_')})
    return selected


def measure(slug, reader, sizes, *, plan_options=()):
    queries = []
    with patch.multiple(store,
            cached_org=Mock(side_effect=AssertionError('whole-org fallback')),
            load_org=Mock(side_effect=AssertionError('whole-org fallback')),
            load_runtime_org=Mock(side_effect=AssertionError('whole-org fallback'))):
        # Warm schema/codec discovery equally at both sizes. A once-per-process
        # information_schema probe is bootstrap work, not history-dependent
        # native data work. Do not omit any query from the measured public call.
        reader(slug)
        with capture(queries):
            result = reader(slug)
    if result is None or result is store.DOCUMENT_READ_FALLBACK or not queries:
        raise AssertionError('reader did not execute the native path')
    records = []
    with registry.connection(slug) as raw:
        with raw.transaction():
            raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            for option in plan_options:
                raw.execute(option)
            for statement, params in queries:
                plan = raw.execute('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) '
                                   + statement, params).fetchone()[0][0]['Plan']
                records.append(dict(sql=statement, plan=plan, rows=examined(plan),
                    violations=violations(plan, {table for table, count in sizes.items()
                                                if count >= BIG_TABLE_ROWS}, statement)))
    return dict(statements=len(queries), rows=sum(record['rows'] for record in records), queries=records)


@fixture.needs_pg
class HotReaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = {}
        cls.sizes = {}
        with fixture.storage(False):
            template = store.create_org('hot-template').d
        with fixture.storage(True):
            for stray_names in (False, True):
                for multiplier in (1, 10):
                    slug = f'hot-robust-{multiplier}' if stray_names else f'hot-history-{multiplier}'
                    doc = seeded_document(template, slug, BASE_HISTORY * multiplier,
                                          stray_names=stray_names)
                    if not stray_names and any('name' in n or 'id' in n for n in doc['nodes'].values()):
                        raise AssertionError('primary fixture must use engine-shaped node bodies')
                    sizes = publish(doc)
                    if not stray_names:
                        cls.sizes[multiplier] = sizes
                        cls.results[multiplier] = {}
                    for name, reader in readers().items():
                        if name.startswith('robust_') != stray_names:
                            continue
                        try:
                            cls.results[multiplier][name] = measure(slug, reader, sizes)
                        except Exception as exc:
                            cls.results[multiplier][name] = dict(error=f'{type(exc).__name__}: {exc}')
        if destination := os.environ.get('ORGTREE_HOT_PATH_REPORT'):
            Path(destination).write_text(json.dumps(cls.results, indent=2, default=str), encoding='utf-8')

    def _records(self, name):
        records = [self.results[multiplier][name] for multiplier in (1, 10)]
        for record in records:
            self.assertNotIn('error', record, f'{name}: {record}')
        return records

    def assert_plan(self, name):
        for record in self._records(name):
            faults = [dict(sql=query['sql'], faults=query['violations'], plan=query['plan'])
                      for query in record['queries'] if query['violations']]
            self.assertFalse(faults, f'{self._label(name)}: {json.dumps(faults, default=str)}')

    def assert_growth(self, name):
        before, after = self._records(name)
        self.assertEqual(after['statements'], before['statements'], self._label(name))
        # The same selected active records and fixed tail limits may pay a tiny
        # planner/rounding difference, never work proportional to old history.
        self.assertLessEqual(after['rows'], before['rows'] * 1.05 + 32,
                             f"{self._label(name)}: examined rows {before['rows']} -> {after['rows']}")

    @staticmethod
    def _label(name):
        # These remain ordinary assertions, never skips/expectedFailure. The
        # finding points to the product remedy; a fixed path must turn green.
        finding = ('f1' if name.startswith(('a1_', 'robust_a1_')) else
                   'f2' if name in ('a6_mail', 'a6_history', 'a6_events', 'a6_gallery') else
                   'f3' if name == 'a4_policy_context' else None)
        return f'{name} (known product finding {finding})' if finding else name

    def test_control_disabled_indexes_are_caught_on_real_policy_queries(self):
        with fixture.storage(True):
            result = measure('hot-history-10', policy_candidates.read, self.sizes[10],
                plan_options=('SET LOCAL enable_indexscan=off',
                              'SET LOCAL enable_bitmapscan=off',
                              'SET LOCAL enable_indexonlyscan=off'))
        self.assertTrue(any('sequential scan of agents' in fault for query in result['queries']
                            for fault in query['violations']), result)

    def test_control_json_predicate_is_caught_on_real_selected_agent_query(self):
        from orgtree.orgdb import reader_rows
        original = reader_rows._rows
        changed = []

        def fault(raw, statement, params=()):
            if statement.startswith('SELECT * FROM orgtree.agents WHERE NOT tombstone'):
                statement = statement.replace(' ORDER BY',
                    " AND coalesce(extra->>'future-field','') <> 'never' ORDER BY")
                changed.append(statement)
            return original(raw, statement, params)

        with fixture.storage(True), patch.object(reader_rows, '_rows', fault):
            result = measure('hot-history-10', policy_candidates.read, self.sizes[10])
        self.assertTrue(changed, 'fault did not reach the real reader')
        self.assertTrue(any('JSON lookup' in fault for query in result['queries']
                            for fault in query['violations']), result)

    def test_control_lost_child_bound_is_caught_by_examined_rows(self):
        from orgtree.orgdb import reader_rows
        original = reader_rows._rows
        changed = []

        def fault(raw, statement, params=()):
            if statement == 'SELECT * FROM orgtree.agent_texts WHERE agent_id = ANY(%s)':
                changed.append(statement)
                return original(raw, 'SELECT * FROM orgtree.agent_texts')
            return original(raw, statement, params)

        with fixture.storage(True), patch.object(reader_rows, '_rows', fault):
            results = [measure(f'hot-history-{m}', policy_candidates.read, self.sizes[m])
                       for m in (1, 10)]
        self.assertEqual(len(changed), 4, 'fault must reach warmup and captured calls at both sizes')
        self.assertGreater(results[1]['rows'], results[0]['rows'] * 1.05 + 32, results)

    def test_control_json_body_projection_remains_allowed(self):
        before, after = self._records('a4_watchdog')
        for result in (before, after):
            self.assertTrue(any("extra->>'owner'" in query['sql'] for query in result['queries']))
            self.assertFalse(any('JSON lookup' in fault for query in result['queries']
                                 for fault in query['violations']), result)


def _plan_test(name):
    def test(self):
        self.assert_plan(name)
    return test


def _growth_test(name):
    def test(self):
        self.assert_growth(name)
    return test


for _name in readers():
    setattr(HotReaders, 'test_plan_' + _name, _plan_test(_name))
    setattr(HotReaders, 'test_growth_' + _name, _growth_test(_name))


if __name__ == '__main__':
    unittest.main()
