"""Independent retained-body checks and corruption controls for migration0010."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import importlib.util
import os
from pathlib import Path
import sys
import unittest

from orgtree.orgdb import conn, lifecycle, mappers, sections
from orgtree.orgdb.convert import rowio

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '')
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '')
PREFIX = f've{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX
spec = importlib.util.spec_from_file_location('verify_events', Path(__file__).resolve().parents[1] / 'tools/orgdb_verify.py')
ov = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ov
spec.loader.exec_module(ov)


def document():
    verdict = {'at': 'not a timestamp', 'by': {'node': 'boss', 'generation': 2, 'born': 'birth'},
               'candidate': 'a' * 40, 'decision': 'approve_stage', 'note': None,
               'evidence': ['r1'], 'next_actor': {'node': 'next', 'generation': 3, 'born': 'next-birth'}}
    packet = {'at': '2026-10-02T10:00:00.000Z', 'by': {'node': 'reviewer', 'generation': 1},
              'candidate': None, 'base': None, 'note': 'packet', 'evidence': [True, 1, 1.0]}
    return {'slug': 'events', 'nodes': {}, 'work_items': [
        {'slug': 'retained', 'kind': 'code', 'status': 'in_progress',
         'history': [{'id': 'legacy-first', 'at': '2026-10-02T10:00:00.000Z',
                      'by': {'node': 'boss', 'generation': 2}, 'op': 'update',
                      'changes': {'status': {'from': 'open', 'to': 'in_progress'}},
                      'from': None, 'note': 'first'},
                     {'id': 'legacy-second', 'at': 'unparseable', 'by': 'older',
                      'op': 'accept', 'note': 'second\0note'}, None, ['wrong-shape']],
         'evidence': [{'at': None, 'by': {'node': 7}, 'kind': 'file', 'ref': 'kept',
                       'note': 'evidence', 'receipt': {'num': 1.0}}],
         'scope': [{'seq': 3, 'at': '2026-10-02T12:00:00+02:00', 'kind': 'decision',
                    'mode': 'append', 'text': 'ruling', 'supersedes': None}],
         'candidate_verdicts': [verdict, copy.deepcopy(verdict)], 'candidate_verdict': verdict,
         'review_packets': [packet], 'review_packet': packet,
         'dismissals': [{'at': 'bad-time', 'by': 'boss', 'set_rev': 7, 'reason': 'dismissed'}],
         'scope_archive': [{'seq': 1, 'kind': 'objective', 'before': 'old', 'after': 'new'}],
         'quick_staff_receipts': [None, {'legacy': [True, 1, 1.0]}, 'scalar']},
        {'slug': 'empty', 'history': [], 'evidence': None, 'scope': {'legacy': 'shape'},
         'candidate_verdict': None, 'review_packet': None},
    ], 'work_items_archive': [{'slug': 'archived', 'history': [{'id': 'archived-event', 'op': 'edit'}]}]}


def tearDownModule():
    if ADMIN and RUNTIME:
        from psycopg import sql
        with conn.connect(ADMIN, 'postgres') as raw:
            for (name,) in raw.execute('SELECT datname FROM pg_database WHERE starts_with(datname,%s)', (PREFIX,)):
                raw.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


@unittest.skipUnless(ADMIN and RUNTIME, 'requires a disposable PostgreSQL cluster')
class RetainedEvents(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        unittest.addModuleCleanup(tearDownModule)
        cls.doc = document()
        manager = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build='events-verifier')
        manager.bootstrap()
        org_id = manager.register_org('events', state='converting')
        build = manager.open_build(org_id, 'convert')
        # Production constructs only the destination. The fixed legacy document
        # above remains the oracle consumed by the independent verifier.
        rows, _, _ = sections.encode_document(copy.deepcopy(cls.doc), mappers.sections(), ignored=mappers.ignored_keys())
        with conn.connect(RUNTIME, build.database, autocommit=False) as raw:
            rowio.write(raw, rows)
            raw.commit()
        manager.mark_filled(build)
        cls.database = manager.publish(build)

    def verify(self, raw):
        checker = ov.Verifier(ov.Dest(raw), self.doc, ov.IGNORED_DEFAULT)
        checker.run()
        return checker

    def test_all_sources_shapes_headers_and_current_values_verify(self):
        with conn.connect(RUNTIME, self.database) as raw:
            check = self.verify(raw)
        self.assertEqual([], check.problems)
        self.assertEqual(15, check.stats['records work_item_events'])
        self.assertGreater(check.stats['typed work_item_events'], 20)
        self.assertGreater(sum(n for name, n in check.stats.items() if name.startswith('extra work_item_events')), 0)

    def rejected(self, statements, field=None):
        with conn.connect(ADMIN, self.database, autocommit=False) as raw:
            for statement in statements:
                changed = raw.execute(statement)
                if not statement.startswith('SET '):
                    self.assertGreater(changed.rowcount, 0)
            check = self.verify(raw)
            self.assertTrue(check.problems, 'planted corruption escaped verification')
            if field:
                self.assertTrue(any(p['field'] == field for p in check.problems), check.problems)
            raw.rollback()
        with conn.connect(RUNTIME, self.database) as raw:
            self.assertEqual([], self.verify(raw).problems, 'rollback did not restore the clean conversion')

    def test_deleted_event_is_rejected(self):
        self.rejected(["DELETE FROM orgtree.work_item_events WHERE id=1"])

    def test_same_count_sequence_swap_is_rejected(self):
        self.rejected(["UPDATE orgtree.work_item_events SET seq=999 WHERE id=1",
                       "UPDATE orgtree.work_item_events SET seq=1 WHERE id=2",
                       "UPDATE orgtree.work_item_events SET seq=2 WHERE id=1"], 'seq')

    def test_each_source_body_and_retained_legacy_identity_is_checked(self):
        for column, value, predicate in (
                ('extra', "'{\"history\":{\"id\":\"changed\"}}'::json", 'id=1'),
                ('evidence_ref', "'changed'", "source='evidence'"),
                ('scope_text', "'changed'", "source='scope'"),
                ('candidate_verdicts_candidate', "'changed'", "source='candidate_verdicts'"),
                ('review_packets_note', "'changed'", "source='review_packets'"),
                ('dismissals_reason', "'changed'", "source='dismissals'"),
                ('scope_archive_before', "'changed'", "source='scope_archive'"),
                ('quick_staff_receipts', "'false'::json", "source='quick_staff_receipts'")):
            with self.subTest(column=column):
                self.rejected([f'UPDATE orgtree.work_item_events SET {column}={value} WHERE {predicate}'])

    def test_current_pointer_must_choose_last_matching_event(self):
        self.rejected(["UPDATE orgtree.work_items SET current_verdict_event_id="
                       "(SELECT min(id) FROM orgtree.work_item_events WHERE source='candidate_verdicts') "
                       "WHERE slug='retained'"], 'current_verdict_event_id')

    def test_empty_item_cannot_gain_a_current_pointer(self):
        self.rejected(["SET LOCAL session_replication_role=replica",
                       "UPDATE orgtree.work_items SET current_verdict_event_id_is='v',current_verdict_event_id="
                       "(SELECT max(id) FROM orgtree.work_item_events WHERE source='candidate_verdicts') "
                       "WHERE slug='empty'"], 'current_verdict_event_id')

    def test_derived_event_headers_are_checked_independently(self):
        for column, value in (('content', "'changed'"), ('status_change', 'false'),
                              ('original_at', "'false'::json"), ('by_generation', '9')):
            with self.subTest(column=column):
                self.rejected([f'UPDATE orgtree.work_item_events SET {column}={value} WHERE id=1'], column)


if __name__ == '__main__':
    unittest.main()
