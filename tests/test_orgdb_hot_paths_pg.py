"""Native reader plans and added latency at 5000 recorded agent-hours.

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
import orgdb_history_fixture as history_fixture
from test_orgdb_hot_paths_static import (hot_sql_violations, is_read_statement,
                                        large_relations, MIN_SCAN_PAGES, BIG_TABLE_ROWS)
from orgtree import (desktop_notifications as notices, foreground_store as foreground,
                     identity_context, policy_candidates, policy_context, policy_reads,
                     settingstx, store, tree_ui, turn_inputs, workdetail, worklist, work_ui)
from orgtree.orgdb import docket, registry
from orgtree.ledger import Org, USER

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule

NOW = 1791028800.0  # fixed classification clock; old completed rows stay archived
JSON_LOOKUP = re.compile(r"->|#>>?|json(?:b)?_extract_path|::\s*json(?:b)?\b", re.I)
# Only predicates and ordering, never Output: exact body decoding may use JSON.
HOT_CLAUSES = ('Filter', 'Index Cond', 'Recheck Cond', 'Join Filter', 'Hash Cond',
               'Merge Cond', 'Sort Key', 'Presorted Key', 'Order By')
FIXTURE_MAINTENANCE = {}


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
    failures = hot_sql_violations(statement)
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
        if is_read_statement(sql):
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
    doc['asks'].append(dict(id='open', node='dev', question='current', at=fixture.AT,
                           status='open', questions=[dict(question='current question',
                                                        work_item='current-work')]))
    doc['work_items_archive'] = [dict(fixture.item(f'archive-work-{i}', 'Old work'),
                                  status='done', archived_at=fixture.AT,
                                  updated_at='2099-01-01T00:00:00Z')
                                for i in range(history)]
    # Keep the archive in front of current rows in sort order, with retired
    # descendants and direct/participant history inside the viewer's subtree.
    # Attention on a physical archive is a current candidate, not a cold page.
    doc['work_items_archive'].append(dict(fixture.item('held-work', 'Held archive'),
        status='done', archived_at=fixture.AT, manual_attention=dict(reason='read', set_rev=1)))
    doc['work_items'] = [fixture.item('current-work', 'Current work'),
                        dict(fixture.item('backlog-work', 'Backlog'), status='backlogged')]
    doc['work_identity'] = 'slug'
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
    maintenance = []
    with fixture.dbconn.connect(fixture.ADMIN, registry.lookup(doc['slug'])[1],
                                autocommit=True) as raw:
        # Statistics belong to the owner/admin, never the runtime reader.
        raw.execute('ANALYZE')
        # Measure retained committed history after ordinary heap maintenance,
        # rather than the bulk loader's dead tuples and unset visibility map.
        # Do not force indexes or require every page to be all-visible: actual
        # reader plans still decide whether the unchanged size rule is met.
        for table in ('org_inbox', 'work_items'):
            before = raw.execute("SELECT pg_relation_size(c.oid) "
                "/ current_setting('block_size')::int, c.relallvisible "
                "FROM pg_class c WHERE c.oid=%s::regclass",
                ('orgtree.' + table,)).fetchone()
            commits = raw.execute('SELECT pg_xact_status(xmin::text::xid8), count(*) '
                'FROM orgtree.' + table + ' GROUP BY xmin').fetchall()
            if any(status != 'committed' for status, count in commits):
                raise AssertionError(f'{table}: fixture rows are not committed: {commits}')
            raw.execute('VACUUM (FREEZE, ANALYZE, DISABLE_PAGE_SKIPPING) orgtree.' + table)
            after = raw.execute("SELECT pg_relation_size(c.oid) "
                "/ current_setting('block_size')::int, c.relallvisible "
                "FROM pg_class c WHERE c.oid=%s::regclass",
                ('orgtree.' + table,)).fetchone()
            maintenance.append(dict(table=table, committed_rows=sum(n for _, n in commits),
                transaction_status=commits, heap_pages=[before[0], after[0]],
                all_visible_pages=[before[1], after[1]]))
    FIXTURE_MAINTENANCE[doc['slug']] = maintenance
    return {table: len(values) for table, values in rows.items()}


def docket_counts(slug):
    with docket.read(slug, viewer=USER, now_ts=NOW) as snapshot:
        return snapshot.counts(include_archived=True)


def desktop_build(slug):
    # Exercise the real cold-cache initial screen call. A warmed cache would
    # measure only its stamp, concealing a history scan in the first build.
    with work_ui._lock:
        work_ui._cache.clear()
    return work_ui.read(slug, backlogged=True)


def scaled_document(template, slug, census, *, hours=history_fixture.TARGET_HOURS,
                    stray_names=False):
    current = seeded_document(template, slug, 0, stray_names=stray_names)
    return history_fixture.build_document(current, history_fixture.targets(census, hours))


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
        'a2_lookup': lambda slug: worklist.lookup(slug, 'dev', 'current-work', now_ts=NOW),
        'a2_archive_reference': lambda slug: worklist.lookup(slug, 'boss', 'archive-work-0', now_ts=NOW),
        'a2_lookup_many': lambda slug: worklist.lookup_many(slug, 'dev',
            ['current-work', 'archive-work-0', 'absent-work'], now_ts=NOW),
        'a2_foreground_leaf': lambda slug: worklist.foreground(slug, 'dev', backlogged=True, now_ts=NOW),
        'a2_foreground_coordinator': lambda slug: worklist.foreground(slug, 'boss', backlogged=True, now_ts=NOW),
        'a2_foreground_user': lambda slug: worklist.foreground(slug, USER, backlogged=True, now_ts=NOW),
        'a2_agent_list': lambda slug: worklist.agent_list(slug, 'dev', include_backlogged=True, now_ts=NOW),
        'a2_counts_user': docket_counts,
        'a2_policy_context': lambda slug: policy_context.read(slug, docket=True),
        'a2_get': lambda slug: workdetail.get(slug, 'dev', 'current-work', now_ts=NOW),
        'a2_desktop_build': desktop_build,
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
            # A small heap can be cheaper to scan even with a selective index.
            # Record physical pages rather than treating 427 narrow rows as a
            # large history relation. JSON predicates remain forbidden always.
            pages = dict(raw.execute("SELECT c.relname, pg_relation_size(c.oid) "
                "/ current_setting('block_size')::int FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='orgtree' AND c.relkind IN ('r','p')").fetchall())
            large = large_relations(sizes, pages)
            for option in plan_options:
                raw.execute(option)
            for statement, params in queries:
                plan = raw.execute('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) '
                                   + statement, params).fetchone()[0][0]['Plan']
                records.append(dict(sql=statement, params=copy.deepcopy(params),
                    plan=plan, rows=examined(plan),
                    violations=violations(plan, large, statement),
                    sequential_scans=[dict(table=node['Relation Name'],
                        pages=pages[node['Relation Name']],
                        small_relation=node['Relation Name'] not in large)
                        for node in nodes(plan) if node['Node Type'] == 'Seq Scan'
                        and node.get('Schema') == 'orgtree']))
    return dict(statements=len(queries), rows=sum(record['rows'] for record in records),
                queries=records, relation_pages=pages, min_scan_pages=MIN_SCAN_PAGES,
                big_table_rows=BIG_TABLE_ROWS)


@fixture.needs_pg
class CommentedReads(unittest.TestCase):
    """Real public-reader controls, independent of the full scale setup."""
    @classmethod
    def setUpClass(cls):
        with fixture.storage(False):
            template = store.create_org('hot-comments-template').d
        cls.slug = 'hot-comments'
        with fixture.storage(True):
            cls.sizes = publish(scaled_document(template, cls.slug,
                history_fixture.load_census(), hours=history_fixture.BASELINE_HOURS))

    def assert_comment_capture(self, prefix, path, command):
        from orgtree.orgdb import reader_rows
        original, changed = reader_rows._rows, []

        def fault(raw, statement, params=()):
            if statement.startswith('SELECT * FROM orgtree.agents WHERE NOT tombstone'):
                statement = statement.replace(' ORDER BY',
                    " AND coalesce(extra->>'capture-field','') <> 'never' ORDER BY")
                if command == 'with':
                    statement = 'WITH selected AS (' + statement + ') SELECT * FROM selected'
                statement = prefix + statement
                changed.append((statement, copy.deepcopy(params)))
                if path == 'connection':
                    with raw.execute(statement, params) as cursor:
                        columns = [column.name for column in cursor.description]
                        return [row if isinstance(row, dict) else dict(zip(columns, row))
                                for row in cursor.fetchall()]
            return original(raw, statement, params)

        with fixture.storage(True), patch.object(reader_rows, '_rows', fault):
            result = measure(self.slug, policy_candidates.read, self.sizes)
        self.assertEqual(len(changed), 2, 'fault must reach warmup and measured public calls')
        statement, params = changed[-1]
        self.assertTrue(hot_sql_violations(statement), 'authored fault must contain hot JSON')
        with registry.connection(self.slug) as raw:
            with raw.transaction():
                raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                plan = raw.execute('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) '
                                   + statement, params).fetchone()[0][0]['Plan']
        self.assertTrue(any(JSON_LOOKUP.search(str(node.get(clause, '')))
            for node in nodes(plan) for clause in HOT_CLAUSES),
            'independent executed plan must expose the hot JSON fault')
        captured = [query for query in result['queries'] if query['sql'] == statement]
        self.assertEqual(len(captured), 1,
            'comment-prefixed read executed but was omitted from the complete call')
        self.assertEqual(captured[0]['params'], params, 'original bindings must be retained')
        self.assertTrue(any('JSON lookup' in fault for fault in captured[0]['violations']),
                        'captured reader guard must catch the actual hot JSON predicate')


@fixture.needs_pg
class HotReaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = {}
        cls.sizes = {}
        cls.census = history_fixture.load_census(os.environ.get('ORGTREE_HISTORY_CENSUS'))
        with fixture.storage(False):
            template = store.create_org('hot-template').d
        with fixture.storage(True):
            for stray_names in (False, True):
                for multiplier in (1, 10):
                    slug = f'hot-robust-{multiplier}' if stray_names else f'hot-history-{multiplier}'
                    hours = history_fixture.BASELINE_HOURS if multiplier == 1 else history_fixture.TARGET_HOURS
                    doc = scaled_document(template, slug, cls.census, hours=hours,
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
                            measured = measure(slug, reader, sizes)
                            with patch.object(store, 'cached_org', side_effect=AssertionError('full fallback')), \
                                 patch.object(store, 'load_org', side_effect=AssertionError('full fallback')), \
                                 patch.object(store, 'load_runtime_org', side_effect=AssertionError('full fallback')):
                                measured.update(history_fixture.sample(reader, slug))
                            measured.update(agent_hours=hours, target_counts=history_fixture.targets(cls.census, hours))
                            cls.results[multiplier][name] = measured
                        except Exception as exc:
                            cls.results[multiplier][name] = dict(error=f'{type(exc).__name__}: {exc}')
        if destination := os.environ.get('ORGTREE_HOT_PATH_REPORT'):
            report = dict(cls.results, fixture_maintenance=FIXTURE_MAINTENANCE)
            Path(destination).write_text(json.dumps(report, indent=2, default=str), encoding='utf-8')

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
        self.assertEqual(len(before['samples_ms']), 9)
        self.assertEqual(len(after['samples_ms']), 9)
        added = history_fixture.added_latency(before, after)
        self.assertLessEqual(added, 100,
            f"{self._label(name)}: added {added:.3f} ms at 5000 agent-hours "
            f"(median {before['median_ms']:.3f} -> {after['median_ms']:.3f} ms; "
            f"diagnostic examined rows {before['rows']} -> {after['rows']})")

    @staticmethod
    def _label(name):
        # These remain ordinary assertions, never skips/expectedFailure. The
        # finding points to the product remedy; a fixed path must turn green.
        finding = ('f1' if name.startswith(('a1_', 'robust_a1_')) else
                   'f2' if name in ('a6_mail', 'a6_history', 'a6_events', 'a6_gallery') else
                   'f3' if name in ('a4_policy_context', 'a2_policy_context') else
                   'f4' if name.startswith('a2_') else None)
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

    def test_docket_fixture_reaches_current_archive_and_question_paths(self):
        with fixture.storage(True):
            for multiplier in (1, 10):
                slug = f'hot-history-{multiplier}'
                self.assertTrue(worklist.lookup(slug, 'dev', 'current-work', now_ts=NOW)['found'])
                self.assertTrue(worklist.lookup(slug, 'boss', 'archive-work-0', now_ts=NOW)['found'])
                self.assertFalse(worklist.lookup(slug, 'dev', 'absent-work', now_ts=NOW)['found'])
                for viewer in ('dev', 'boss', USER):
                    body = worklist.foreground(slug, viewer, backlogged=True, now_ts=NOW)
                    self.assertEqual({r['slug'] for r in body['items']}, {'current-work', 'held-work'})
                    self.assertEqual({r['slug'] for r in body['backlogged']}, {'backlog-work'})
                    current = next(r for r in body['items'] if r['slug'] == 'current-work')
                    self.assertTrue(current['questions'], 'open question link was not seeded')

    def test_scaled_fixture_reaches_real_owner_document_and_closed_credit_windows(self):
        with fixture.storage(True):
            for multiplier in (1, 10):
                slug = f'hot-history-{multiplier}'
                cards = foreground.read_snapshot(slug, lambda raw, stamp:
                    foreground.read_card_windows(raw, ['dev'], header=True))
                self.assertEqual(len(cards['documents']['dev']), 10)
                self.assertEqual({row['id'] for row in cards['documents']['dev']},
                                 {f'document-{i}' for i in range(10)})
                credits = cards['asks']['credit_requests']
                self.assertTrue(credits, 'closed credits were not selected for the real owner')
                self.assertTrue(all(row['node'] == 'dev' and row['status'] == 'denied' for row in credits))

    def test_control_docket_lost_slug_bound_is_caught(self):
        original = docket._dicts
        changed = []

        def fault(raw, statement, params=()):
            if 'WHERE i.slug=ANY(%s)' in statement:
                # Remove the actual reader's SQL bound, then filter output in
                # Python. Result parity alone cannot detect this regression.
                changed.append(statement)
                wanted = set(params[-1])
                statement = statement.replace('WHERE i.slug=ANY(%s)', 'WHERE TRUE')
                return [row for row in original(raw, statement, params[:-1]) if row['slug'] in wanted]
            return original(raw, statement, params)

        with fixture.storage(True), patch.object(docket, '_dicts', fault):
            results = [measure(f'hot-history-{m}', readers()['a2_lookup'], self.sizes[m])
                       for m in (1, 10)]
        self.assertTrue(changed, 'fault did not reach the public lookup')
        self.assertGreater(results[1]['rows'], results[0]['rows'] * 1.05 + 32, results)

    def test_control_docket_json_predicate_is_caught(self):
        original = docket._dicts
        changed = []

        def fault(raw, statement, params=()):
            if 'WHERE i.slug=ANY(%s)' in statement:
                statement = statement.replace('WHERE i.slug=ANY(%s)',
                    "WHERE i.slug=ANY(%s) AND coalesce(i.extra->>'future-field','') <> 'never'")
                changed.append(statement)
            return original(raw, statement, params)

        with fixture.storage(True), patch.object(docket, '_dicts', fault):
            result = measure('hot-history-10', readers()['a2_lookup'], self.sizes[10])
        self.assertTrue(changed, 'fault did not reach the public lookup')
        self.assertTrue(any('JSON lookup' in fault for query in result['queries']
                            for fault in query['violations']), result)


def _plan_test(name):
    def test(self):
        self.assert_plan(name)
    return test


def _growth_test(name):
    def test(self):
        self.assert_growth(name)
    return test


def _comment_test(prefix, path, command):
    def test(self):
        self.assert_comment_capture(prefix, path, command)
    return test


for _form, _prefix in (('line', '-- reader annotation\n'),
                        ('block', '/* reader annotation */ ')):
    for _path in ('connection', 'cursor'):
        for _command in ('select', 'with'):
            setattr(CommentedReads, f'test_{_form}_{_path}_{_command}',
                    _comment_test(_prefix, _path, _command))


for _name in readers():
    setattr(HotReaders, 'test_plan_' + _name, _plan_test(_name))
    setattr(HotReaders, 'test_growth_' + _name, _growth_test(_name))


if __name__ == '__main__':
    unittest.main()
