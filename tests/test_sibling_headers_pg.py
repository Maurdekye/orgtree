"""Temporary scalar children preserve decoded values and the staged view on PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
import unittest
from unittest.mock import patch

import test_child_candidates_pg as fixture
import test_orgdb_record_selection_queries_pg as selection
import test_orgdb_hot_paths_pg as hot
from orgtree import ledger, orgtx, store
from orgtree.orgdb import agents, conn, registry
from orgtree.orgdb import record_reads as Q, reader_rows
from orgtree.orgdb.compat import rows as R
from orgtree.orgdb.mappers import agents as M

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class Headers(fixture.ChildCandidates):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        row = registry.lookup(cls.twins.copy)
        with conn.connect(fixture.fixture.ADMIN, row[1], autocommit=False) as raw:
            raw.execute("UPDATE orgtree.agents SET created='2026-01-01T00:00:00Z',"
                        "model='haiku',credit_grant=2 WHERE NOT tombstone AND created IS NULL")
            raw.execute("UPDATE orgtree.agents SET state='live' WHERE NOT tombstone AND state IS NULL "
                        "AND NOT state_misfit")
            raw.commit()

    def reached_headers(self, parent, edit=None, expect_error=None, *, order_only=False):
        class Discard(Exception):
            pass
        reference = ledger.Org(fixture.fixture.document(self.slug))
        if edit:
            edit(reference.nodes)
        try:
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                if edit:
                    edit(nodes)
                before = copy.deepcopy(getattr(tx.org.d, '_snap_nodes'))
                held = set(dict.keys(nodes))
                with patch.object(M, 'decode_node', wraps=M.decode_node) as bodies:
                    if expect_error:
                        with self.assertRaises(expect_error):
                            store.lazy_sibling_headers(tx.org, parent, **({"order_only": True} if order_only else {}))
                        with self.assertRaises(expect_error):
                            reference.children(parent, live_only=False)
                        result = None
                    else:
                        result = store.lazy_sibling_headers(tx.org, parent, **({"order_only": True} if order_only else {}))
                        self.assertIsNotNone(result)
                        self.assertEqual([name for name, value in result],
                                         reference.children(parent, live_only=False))
                        for name, value in result:
                            for key in (('parent', 'state', 'model', 'ui_order', 'created') if order_only else
                                        ('parent', 'state', 'model', 'grant', 'ui_order',
                                         'created', 'bearer_state', 'predecessor', 'successor')):
                                expected = reference.nodes[name]
                                self.assertEqual(key in value, key in expected, (name, key))
                                if key in value:
                                    self.assertEqual(value[key], expected[key], (name, key))
                    self.assertEqual(bodies.call_count, 0, 'temporary headers materialized a body')
                self.assertEqual(set(dict.keys(nodes)), held)
                self.assertEqual(getattr(tx.org.d, '_snap_nodes'), before)
                self.assertFalse(nodes._complete)
                raise Discard()
        except Discard:
            return result

    def test_order_projection_has_five_fields_and_full_default_is_unchanged(self):
        row = registry.lookup(self.slug)
        keys = {'parent', 'state', 'model', 'ui_order', 'created'}
        with conn.connect(fixture.fixture.RUNTIME, row[1]) as raw:
            for parent in ('boss', None, '', 'no-such-parent'):
                full = agents.sibling_headers(raw, parent)
                with patch.object(agents, '_dicts', wraps=agents._dicts) as selected:
                    narrow = agents.sibling_headers(raw, parent, order_only=True)
                self.assertEqual(len(narrow), len(full))
                for small, old in zip(narrow, full):
                    self.assertEqual(small[:3], old[:3])
                    self.assertEqual(small[4], old[4])
                    self.assertEqual(small[3], {k:v for k,v in old[3].items() if k in keys},
                                     "order projection is not narrow")
                    self.assertLessEqual(set(small[3]), keys, 'order projection is not narrow')
                sql = selected.call_args.args[1]
                for forbidden in ('credit_grant', 'bearer_state', 'predecessor_id', 'successor_id'):
                    self.assertNotIn(forbidden, sql, 'order projection is not narrow')
                self.assertEqual(agents.sibling_headers(raw, parent), full)

    def test_order_projection_preserves_rare_alias_staged_values_and_errors(self):
        for parent in ('boss', None, '', 'no-such-parent'):
            self.reached_headers(parent, order_only=True)
        def edit(nodes):
            nodes['dev']['parent'] = 'destination'
            nodes['unknown-only']['parent'] = 'boss'
            nodes['unknown-only']['ui_order'] = 300
            nodes['archived-child']['state'] = 'live'
            nodes.pop('ops')
            nodes['new-child'] = fixture.fixture.node('new-child', 'boss')
            nodes['new-child']['ui_order'] = 400
        self.reached_headers('boss', edit, order_only=True)
        self.reached_headers('boss', lambda n: n['dev'].__setitem__('ui_order', None),
                             expect_error=TypeError, order_only=True)
        self.reached_headers('boss', lambda n: n['dev'].pop('created'),
                             expect_error=KeyError, order_only=True)
        self.reached_headers(None, lambda n: n['top-child'].pop('parent'),
                             expect_error=KeyError, order_only=True)

    def test_only_new_node_requests_narrow_headers(self):
        with patch.object(store, 'lazy_sibling_headers', wraps=store.lazy_sibling_headers) as headers:
            self.consumers()
        modes = [c.kwargs.get('order_only', False) for c in headers.call_args_list]
        self.assertIn(True, modes, 'new-node projection was not reached')
        self.assertIn(False, modes, 'full stranding projection was not reached')

    def test_order_projection_gpt6_fold_matches_full_before_and_after(self):
        row = registry.lookup(self.slug)
        with conn.connect(fixture.fixture.ADMIN, row[1], autocommit=True) as raw:
            old = raw.execute("SELECT model FROM orgtree.agents WHERE name='archived-child' "
                              "AND NOT tombstone").fetchone()[0]
            try:
                raw.execute("UPDATE orgtree.agents SET model='gpt-6-sol' "
                            "WHERE name='archived-child' AND NOT tombstone")
                full = self.reached_headers('boss')
                narrow = self.reached_headers('boss', order_only=True)
                for found in (full, narrow):
                    header = dict(found)['archived-child']
                    self.assertEqual(header['model'], 'sol')
                    self.assertEqual(header['scope']['model_version'], '6')
            finally:
                raw.execute("UPDATE orgtree.agents SET model=%s "
                            "WHERE name='archived-child' AND NOT tombstone", (old,))

    def test_order_healing_rereads_full_before_existing_null_scope_failure(self):
        class Discard(Exception):
            pass
        row = registry.lookup(self.slug)
        with conn.connect(fixture.fixture.ADMIN, row[1], autocommit=True) as raw:
            old = raw.execute("SELECT scope_is FROM orgtree.agents WHERE name='archived-child' "
                              "AND NOT tombstone").fetchone()[0]
            try:
                raw.execute("UPDATE orgtree.agents SET scope_is='n' "
                            "WHERE name='archived-child' AND NOT tombstone")
                try:
                    with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                        with patch.object(agents, 'sibling_headers', wraps=agents.sibling_headers) as read:
                            self.assertIsNone(store.lazy_sibling_headers(tx.org, 'boss', order_only=True))
                        self.assertEqual([c.kwargs.get('order_only', False) for c in read.call_args_list],
                                         [True, False], 'healing did not reread the full header')
                        with self.assertRaises(AttributeError):
                            with patch.object(tx.org, '_quarantine_freed_key'):
                                tx.org._new_node('haiku', 'boss', 0, 'bad-heal', [], {}, 'full', None)
                        raise Discard()
                except Discard:
                    pass
            finally:
                raw.execute("UPDATE orgtree.agents SET scope_is=%s "
                            "WHERE name='archived-child' AND NOT tombstone", (old,))

    def test_removed_order_projection_is_caught_and_restored(self):
        original = agents.sibling_headers
        def full_only(raw, parent, **kwargs):
            return original(raw, parent)
        with patch.object(agents, 'sibling_headers', side_effect=full_only):
            with self.assertRaisesRegex(AssertionError, 'order projection is not narrow'):
                self.test_order_projection_has_five_fields_and_full_default_is_unchanged()
        self.test_order_projection_has_five_fields_and_full_default_is_unchanged()

    def test_header_decoding_matches_exact_codec_and_physical_namesakes(self):
        row = registry.lookup(self.slug)
        with conn.connect(fixture.fixture.RUNTIME, row[1]) as raw:
            for parent in ('boss', None, '', 'no-such-parent'):
                found = agents.sibling_headers(raw, parent)
                names = [name for aid, name, ordinal, value, ordinary in found]
                exact = {name: json.loads(text) for name, text, xmin in R.nodes(raw, names)}
                for aid, name, ordinal, value, ordinary in found:
                    self.assertFalse(ordinary)
                    for key in value:
                        self.assertEqual(value[key], exact[name][key], (parent, name, key))
                    self.assertNotIn('unknown', value)
                if parent == 'boss':
                    self.assertIn('first-name-bearer-child', names)
                    self.assertIn('second-name-bearer-child', names)

    def test_current_headers_are_temporary_and_preserve_all_state_order(self):
        for parent in ('boss', None, '', 'no-such-parent'):
            self.reached_headers(parent)

    def test_staged_parent_state_model_grant_order_birth_and_deletion(self):
        def edit(nodes):
            nodes['dev']['parent'] = 'destination'
            nodes['unknown-only']['parent'] = 'boss'
            nodes['unknown-only']['model'] = 'sol'
            nodes['unknown-only']['grant'] = 3.5
            nodes['unknown-only']['ui_order'] = 300
            nodes['archived-child']['state'] = 'live'
            nodes['parent-overlap']['state'] = 'archived'
            nodes.pop('ops')
            nodes['new-child'] = fixture.fixture.node('new-child', 'boss')
            nodes['new-child']['ui_order'] = 400
        self.reached_headers('boss', edit)
        self.assertNotIn('new-child', fixture.fixture.document(self.slug)['nodes'])

    def test_live_sibling_bad_order_still_raises_before_warning_filter(self):
        self.reached_headers('boss', lambda nodes: nodes['dev'].__setitem__('ui_order', None),
                             expect_error=TypeError)

    def test_missing_created_keeps_existing_key_error(self):
        self.reached_headers('boss', lambda nodes: nodes['dev'].pop('created'),
                             expect_error=KeyError)

    def test_staged_missing_top_parent_keeps_existing_key_error(self):
        self.reached_headers(None, lambda nodes: nodes['top-child'].pop('parent'),
                             expect_error=KeyError)

    def consumers(self, edit=None, expect_error=None):
        class Discard(Exception):
            pass
        reference = ledger.Org(fixture.fixture.document(self.slug))
        if edit:
            edit(reference.nodes)

        def exercise(org):
            with patch.object(org, '_notify') as notices:
                warnings = org._stranding_warnings('boss', 100, 0, actor=ledger.USER)
                notice_args = [(copy.deepcopy(call.args), copy.deepcopy(call.kwargs))
                               for call in notices.call_args_list]
            with patch.object(org, '_quarantine_freed_key'):
                name = org._new_node('haiku', 'boss', 0, 'header-new', [], {}, 'full', None)
            return warnings, notice_args, org.nodes[name]['ui_order']

        try:
            with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                nodes = dict.__getitem__(tx.org.d, 'nodes')
                if edit:
                    edit(nodes)
                held = set(dict.keys(nodes))
                with patch.object(M, 'decode_node', wraps=M.decode_node) as bodies:
                    if expect_error:
                        with self.assertRaises(expect_error):
                            exercise(tx.org)
                        with self.assertRaises(expect_error):
                            exercise(reference)
                    else:
                        self.assertEqual(exercise(tx.org), exercise(reference))
                    self.assertEqual(bodies.call_count, 0)
                self.assertLessEqual(set(dict.keys(nodes)) - held, {'header-new'})
                raise Discard()
        except Discard:
            pass

    def test_actual_warning_notice_and_new_node_max_match_decoded_consumers(self):
        self.consumers()

    def test_actual_consumers_merge_ties_birth_parent_and_archived_bearer_edits(self):
        def edit(nodes):
            nodes['dev']['parent'] = 'destination'
            nodes['archived-child']['bearer_state'] = 'knowledge'
            nodes['archived-child']['grant'] = 1.125
            nodes['archived-child']['ui_order'] = 500
            nodes['ops']['ui_order'] = 500
            nodes['new-sibling'] = fixture.fixture.node('new-sibling', 'boss')
            nodes['new-sibling']['ui_order'] = 500
        self.consumers(edit)

    def test_archived_affordability_errors_outside_interval_are_not_skipped(self):
        self.consumers(lambda nodes: nodes['archived-child'].__setitem__('grant', None),
                       expect_error=TypeError)

    def test_live_order_error_precedes_both_native_consumers(self):
        self.consumers(lambda nodes: nodes['dev'].__setitem__('ui_order', None),
                       expect_error=TypeError)

    def test_null_stored_scope_preserves_ordinary_load_healing_failure(self):
        class Discard(Exception):
            pass
        row = registry.lookup(self.slug)
        with conn.connect(fixture.fixture.ADMIN, row[1], autocommit=True) as raw:
            original = raw.execute("SELECT scope_is FROM orgtree.agents "
                                   "WHERE name='archived-child' AND NOT tombstone").fetchone()[0]
            try:
                raw.execute("UPDATE orgtree.agents SET scope_is='n' "
                            "WHERE name='archived-child' AND NOT tombstone")
                try:
                    with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                        self.assertIsNone(store.lazy_sibling_headers(tx.org, 'boss'))
                        with self.assertRaises(AttributeError):
                            tx.org._stranding_warnings('boss', 100, 0)
                        raise Discard()
                except Discard:
                    pass
            finally:
                raw.execute("UPDATE orgtree.agents SET scope_is=%s "
                            "WHERE name='archived-child' AND NOT tombstone", (original,))

    def test_body_materialization_mutant_is_caught_by_the_actual_header_control(self):
        original = agents.sibling_headers
        def materialize(raw, parent):
            # Evict only this disposable fixture's compatibility-body cache so
            # the injected ordinary read actually reaches the body decoder.
            R._NODE_TEXTS.pop(R._node_slot(raw), None)
            list(R.nodes(raw, ['archived-child']))
            return original(raw, parent)
        with patch.object(agents, 'sibling_headers', side_effect=materialize):
            with self.assertRaisesRegex(AssertionError, 'temporary headers materialized a body'):
                self.reached_headers('boss')

    def test_missing_stored_order_uses_ordinary_full_heal_and_matches_legacy(self):
        class Discard(Exception):
            pass
        row = registry.lookup(self.slug)
        with conn.connect(fixture.fixture.ADMIN, row[1], autocommit=True) as raw:
            original = raw.execute("SELECT ui_order FROM orgtree.agents "
                                   "WHERE name='archived-child' AND NOT tombstone").fetchone()[0]
            try:
                raw.execute("UPDATE orgtree.agents SET ui_order=NULL "
                            "WHERE name='archived-child' AND NOT tombstone")
                expected = ledger.Org(fixture.fixture.document(self.slug))
                expected_warnings = expected._stranding_warnings('boss', 100, 0)
                try:
                    with orgtx.org_tx(self.slug, nodes=['boss']) as tx:
                        nodes = dict.__getitem__(tx.org.d, 'nodes')
                        self.assertFalse(nodes._complete)
                        self.assertIsNone(store.lazy_sibling_headers(tx.org, 'boss'))
                        self.assertEqual(tx.org._stranding_warnings('boss', 100, 0),
                                         expected_warnings)
                        self.assertTrue(nodes._complete)
                        raise Discard()
                except Discard:
                    pass
            finally:
                raw.execute("UPDATE orgtree.agents SET ui_order=%s "
                            "WHERE name='archived-child' AND NOT tombstone", (original,))

    def test_inapplicable_plain_or_complete_document_keeps_ordinary_path(self):
        org = ledger.Org(fixture.fixture.document(self.slug))
        self.assertIsNone(store.lazy_sibling_headers(org, 'boss'))


@fixture.fixture.needs_pg
class HeaderPlans(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selection.SelectionQueries.setUpClass.__func__(cls)

    measure = selection.SelectionQueries.measure

    def test_large_sibling_headers_use_typed_candidates_and_requested_key_plans(self):
        measured = self.measure(lambda state: agents.sibling_headers(state.raw, 'boss'))
        self.assertGreaterEqual(measured['relation_pages']['agents'], hot.MIN_SCAN_PAGES)
        for query in measured['queries']:
            if query['violations']:
                print('header plan failure:', json.dumps(query, default=str))
        self.assertFalse([v for query in measured['queries'] for v in query['violations']])
        direct = [query for query in measured['queries'] if 'healing_scope_extra' in query['sql']]
        self.assertEqual(len(direct), 1)
        # The physical-work metric also counts the two distinct parent-name
        # probes. The separate decoder control asserts 2051 returned headers.
        self.assertEqual(direct[0]['rows'], 2053)
        reader_queries = [query for query in measured['queries'] if
            query['sql'].startswith('SELECT id FROM orgtree.agents WHERE name=%s') or
            (query['sql'].startswith('SELECT ') and ' LIMIT 128' in query['sql']) or
            'healing_scope_extra' in query['sql']]
        reader_work = sum(query['rows'] for query in reader_queries)
        snapshot_work = measured['rows'] - reader_work
        pages = [query for query in reader_queries if ' LIMIT 128' in query['sql']]
        for page in pages:
            # An inclusive seek rechecks the previous boundary and an
            # incremental sort can read one next-key lookahead row.
            self.assertLessEqual(page['rows'], 128 + 2)
        print('header work:', json.dumps({'examined_rows': measured['rows'],
              'reader_rows': reader_work, 'snapshot_rows': snapshot_work,
              'header_query_rows': direct[0]['rows'], 'queries': len(measured['queries']),
              'page_rows': [page['rows'] for page in pages]}))
        # Identities plus headers, boundary and sort-lookahead per page,
        # one selected parent and two referenced parents. Snapshot setup is
        # measured separately; it must remain a fixed small amount of work.
        self.assertLessEqual(reader_work, 2050 + 2051 + 2 * 17 + 1 + 2)
        self.assertLessEqual(snapshot_work, 32)

    def test_disabled_index_fault_reaches_the_actual_header_plan_oracle(self):
        measured = self.measure(lambda state: agents.sibling_headers(state.raw, 'boss'),
            plan_options=('SET LOCAL enable_indexscan=off',
                          'SET LOCAL enable_indexonlyscan=off',
                          'SET LOCAL enable_bitmapscan=off'))
        direct = [query for query in measured['queries'] if 'healing_scope_extra' in query['sql']]
        self.assertEqual(len(direct), 1)
        self.assertIn('sequential scan of agents', direct[0]['violations'])

    def test_large_headers_decode_only_requested_scalars_and_preserve_names(self):
        with fixture.fixture.storage(True), Q.snapshot(self.twin.copy) as state:
            with patch.object(M, 'decode_node', wraps=M.decode_node) as bodies:
                found = agents.sibling_headers(state.raw, 'boss')
            self.assertEqual(bodies.call_count, 0)
            self.assertEqual(len(found), 2051)
            self.assertEqual(set(name for aid, name, ordinal, value, ordinary in found),
                             set(self.selected[:2048]) | {'dev', 'ops', 'rare-parent'})
            self.assertTrue(all(not ordinary for aid, name, ordinal, value, ordinary in found))
            self.assertTrue(all(set(value) <= {'parent', 'state', 'model', 'grant', 'ui_order',
                'created', 'bearer_state', 'predecessor', 'successor'}
                for aid, name, ordinal, value, ordinary in found))


if __name__ == '__main__':
    unittest.main()
