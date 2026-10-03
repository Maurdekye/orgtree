"""Current policy inputs preserve outputs without reading retained history."""
import copy
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_orgdb_compat_pg as fixture
from orgtree import policy_candidates, policy_context, store, supervisor, warmpool
from orgtree.ledger import Org, USER
from orgtree.orgdb import registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class RecordingCursor:
    def __init__(self, cursor, queries):
        self.cursor, self.queries = cursor, queries

    def execute(self, statement, params=None, **kw):
        if isinstance(statement, str) and re.match(r'\s*(SELECT|WITH)\b', statement, re.I):
            self.queries.append((statement, copy.deepcopy(params)))
        self.cursor.execute(statement, params, **kw)
        return self

    def __enter__(self):
        self.cursor.__enter__()
        return self

    def __exit__(self, *args):
        return self.cursor.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.cursor, name)


class RecordingConnection:
    def __init__(self, raw, queries):
        self.raw, self.queries = raw, queries

    def execute(self, statement, params=None, **kw):
        return RecordingCursor(self.raw.cursor(), self.queries).execute(statement, params, **kw)

    def cursor(self, **kw):
        return RecordingCursor(self.raw.cursor(**kw), self.queries)

    def __getattr__(self, name):
        return getattr(self.raw, name)


def plan_nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from plan_nodes(child)


def seed(slug):
    org = store.load_org(slug)
    org.d['custom_identity'] = {'unknown': [None, False, {'text': 'kept'}]}
    org.d['default_effort'] = None
    org.d['asks'] = [dict(id='q-open', node='dev', status='open', question='which?',
                          at=fixture.AT, options=[{'label': 'yes', 'description': [1]}],
                          questions=[{'question': 'tab'}], work_items=['fix-the-thing']),
                     dict(id='q-closed', node='dev', status='answered', question='old',
                          answer={'kept': True}, at=fixture.AT)]
    org.d['scope_requests'] = [dict(id='s-pending', node='dev', status='pending',
                                   items=[dict(kind='tool', tool='bash', reason={'x': 1})]),
                              dict(id='s-closed', node='dev', status='denied')]
    org.d['audience_requests'] = [dict(id='a-open', node='dev', status='open', target=USER),
                                 dict(id='a-closed', node='dev', status='denied')]
    org.d['audiences'] = [dict(grantee='dev', grantor=USER, reason={'x': [1]}),
                          dict(grantee='retired', grantor=USER)]
    org.d['nodes']['retired'] = dict(fixture.node('retired', None), state='archived')
    org.d['orphan_keys'] = {'old': dict(cause='retire', at=fixture.AT)}
    org.d['user_inbox'] = [dict(id='old-inbox', body='history')]
    store.save_org(org)


@fixture.needs_pg
class CurrentPolicy(unittest.TestCase):
    def setUp(self):
        self.twins = fixture.Twins('policy-' + self._testMethodName[5:], before=seed)

    def projected(self, *, docket=False):
        with fixture.storage(True), patch.object(store, 'cached_org',
                side_effect=AssertionError('whole-org fallback')):
            return policy_context.read(self.twins.copy, docket=docket)

    def outputs(self, org):
        return (supervisor.identity_prompt(org, 'dev'), warmpool.eligible(org, 'dev'),
                supervisor._working_checkup_decision(org, 'dev', 100),
                org.work_org_all_blocked(), org.work_idle_reminder_items('dev'),
                org.work_docket_reminder_items('dev'),
                org._has_audience('dev', USER),
                [getattr(org, method)('dev') for method in ('model_for', 'versions_for',
                 'harness_for', 'prefer_reserve_for', 'effective_effort', 'account_fallback_for')])

    def test_exact_outputs_and_selected_children_match_legacy_policy(self):
        with fixture.storage(False):
            legacy = policy_context.read(self.twins.legacy, docket=True)
        got = self.projected(docket=True)
        self.assertIsInstance(got, policy_context.PolicyContext)
        self.assertEqual(self.outputs(got), self.outputs(legacy))
        self.assertEqual(got.d['asks'], [legacy.d['asks'][0]])
        self.assertEqual(got.d['scope_requests'], [legacy.d['scope_requests'][0]])
        self.assertEqual(got.d['audience_requests'], [legacy.d['audience_requests'][0]])
        self.assertEqual(got.d['audiences'], [legacy.d['audiences'][0]])
        self.assertEqual(got.d['custom_identity'], legacy.d['custom_identity'])
        self.assertIsNone(got.d['default_effort'])
        self.assertNotIn('orphan_keys', got.d)
        self.assertNotIn('user_inbox', got.d)

    def test_closed_history_edit_changes_no_policy_output_or_native_fingerprint(self):
        before = self.projected(docket=True)
        def edit(doc):
            doc['asks'][1]['question'] = 'edited closed history'
            doc['scope_requests'][1]['reason'] = 'closed reason'
            doc['audience_requests'][1]['reason'] = 'closed reason'
        self.twins.edit(edit)
        after = self.projected(docket=True)
        self.assertEqual(self.outputs(before), self.outputs(after))
        self.assertEqual(warmpool._org_fingerprint(before), warmpool._org_fingerprint(after))
        with fixture.storage(False):
            legacy = policy_context.read(self.twins.legacy, docket=True)
        self.assertEqual(self.outputs(after), self.outputs(legacy))

    def test_ask_create_edit_and_answer_each_change_native_fingerprint(self):
        fingerprints = [warmpool._org_fingerprint(self.projected())]
        for edit in (lambda d: d['asks'].append(dict(id='new', node='ops', status='open',
                                                   question='new', at=fixture.AT)),
                     lambda d: d['asks'][-1].update(question='edited'),
                     lambda d: d['asks'][-1].update(status='answered', answer='done')):
            self.twins.edit(edit)
            fingerprints.append(warmpool._org_fingerprint(self.projected()))
        for before, after in zip(fingerprints, fingerprints[1:]):
            self.assertNotEqual(before, after)

    def test_selected_sections_keep_missing_null_empty_and_misfit_records(self):
        for value in ('missing', None, []):
            with fixture.storage(True), registry.connection(self.twins.copy) as raw:
                # Conversion supports these containers, although legacy save's
                # docket hook cannot write a null asks list. Establish the
                # exact native section shape before exercising the reader.
                for pos, (key, table) in enumerate((('asks', 'asks'),
                        ('scope_requests', 'scope_requests'),
                        ('audience_requests', 'audience_requests'),
                        ('audiences', 'audience_grants'))):
                    raw.execute(f'DELETE FROM orgtree.{table}')
                    raw.execute('DELETE FROM orgtree.org_sections WHERE key=%s', (key,))
                    if value != 'missing':
                        raw.execute('INSERT INTO orgtree.org_sections(key,ord,state) '
                                    'VALUES(%s,%s,%s)', (key, 900 + pos,
                                                       'n' if value is None else 'v'))
                with raw.transaction():
                    raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    got = policy_candidates.settings(SimpleNamespace(raw=raw, orgdb=True),
                                                       owners=['dev'])
            for key in ('asks', 'scope_requests', 'audience_requests', 'audiences'):
                if value == 'missing':
                    self.assertNotIn(key, got)
                else:
                    self.assertEqual(got[key], value)

    def test_request_edit_between_graph_and_settings_stays_in_same_snapshot(self):
        with fixture.storage(True):
            def project(conn, graph):
                with registry.connection(self.twins.copy) as writer:
                    writer.execute("UPDATE orgtree.asks SET status='answered' "
                                   "WHERE public_id='q-open'")
                got = policy_context._build(conn, graph, docket=False)
                self.assertEqual([row['id'] for row in got.d['asks']], ['q-open'])
                self.assertEqual(conn.raw.execute('SHOW transaction_read_only').fetchone()[0], 'on')
                self.assertEqual(conn.raw.execute('SHOW transaction_isolation').fetchone()[0],
                                 'repeatable read')
                return got
            policy_candidates.read(self.twins.copy, project)
        self.assertEqual(self.projected().d['asks'], [])

    def test_complete_policy_read_indexes_current_inputs_with_large_retained_sections(self):
        with fixture.storage(False):
            template = fixture.document(self.twins.legacy)
        measurements = []
        for history in (2048, 20480):
            doc = copy.deepcopy(template)
            doc['slug'] = f'{self.twins.copy}-h{history}'
            for key in ('asks', 'scope_requests', 'audience_requests'):
                doc[key].extend(dict(id=f'old-{i}', node='dev', status='answered',
                                     at=fixture.AT, reason='closed',
                                     **({'options': [{'label': 'old'}]} if key == 'asks' else {}))
                                for i in range(history))
            doc['audiences'].extend(dict(grantee='retired', grantor=USER) for _ in range(history))
            doc['orphan_keys'].update({f'old-{i}': dict(cause='retire', at=fixture.AT)
                                       for i in range(history)})
            doc['user_inbox'].extend(dict(id=f'old-{i}', body='retained') for i in range(history))
            rows, _, _ = fixture.sections.encode_document(doc, fixture.mappers.sections(),
                                                         ignored=fixture.mappers.ignored_keys())
            lc = fixture.LC[0]
            build = lc.open_build(lc.register_org(doc['slug'], state='converting'), 'convert')
            with fixture.dbconn.connect(fixture.RUNTIME, build.database, autocommit=False) as raw:
                fixture.rowio.write(raw, rows)
                raw.commit()
            lc.mark_filled(build)
            lc.publish(build)
            with fixture.dbconn.connect(fixture.ADMIN, registry.lookup(doc['slug'])[1]) as raw:
                raw.execute('ANALYZE')
            queries = []
            checkout, release = registry.checkout, registry.release
            with fixture.storage(True), patch.object(store, 'cached_org',
                    side_effect=AssertionError('whole-org fallback')):
                policy_context.read(doc['slug'])  # equal warmup before each capture
                with patch.object(registry, 'checkout',
                                  lambda *a: RecordingConnection(checkout(*a), queries)), \
                     patch.object(registry, 'release', lambda raw, db: release(raw.raw, db)):
                    got = policy_context.read(doc['slug'])
            self.assertEqual([row['id'] for row in got.d['asks']], ['q-open'])
            self.assertEqual(len(got.d['audiences']), 1)
            self.assertNotIn('orphan_keys', got.d)
            examined = 0
            plans = []
            big_tables = {table for table, values in rows.items() if len(values) >= 256}
            with fixture.storage(True), registry.connection(doc['slug']) as raw:
                with raw.transaction():
                    raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    for statement, params in queries:
                        plan = raw.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '
                                           + statement, params).fetchone()[0][0]['Plan']
                        plans.append(dict(statement=statement, plan=plan))
                        for node in plan_nodes(plan):
                            if node.get('Relation Name') in big_tables:
                                self.assertNotEqual(node['Node Type'], 'Seq Scan',
                                                    json.dumps(plans[-1], default=str))
                            for clause in ('Filter', 'Index Cond', 'Recheck Cond', 'Join Filter',
                                           'Hash Cond', 'Sort Key', 'Order By'):
                                self.assertNotRegex(str(node.get(clause, '')),
                                    r'->|#>>?|json(?:b)?_extract_path|::\s*json(?:b)?\b')
                            if 'Relation Name' in node:
                                examined += (node.get('Actual Rows', 0)
                                    + node.get('Rows Removed by Filter', 0)
                                    + node.get('Rows Removed by Index Recheck', 0)) * node['Actual Loops']
            measurements.append(dict(history=history, statements=len(queries),
                                      examined=examined, plans=plans))
        if os.environ.get('ORGTREE_POLICY_REPORT'):
            Path(os.environ['ORGTREE_POLICY_REPORT']).write_text(
                json.dumps(measurements, default=str, indent=2), encoding='utf-8')
        self.assertGreater(measurements[0]['statements'], 20, 'capture must include child reads')
        self.assertEqual(measurements[0]['statements'], measurements[1]['statements'])
        # Rows/plans are diagnostic. The revised5000-agent-hour acceptance is
        # added latency <=100ms, measured by the shared A8 fixture.


if __name__ == '__main__':
    unittest.main()
