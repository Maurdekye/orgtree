"""G1-G11 populated rows and reached verifier faults on an owned PostgreSQL cluster."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
import unittest

from orgtree.orgdb import conn, lifecycle, mappers, sections
from orgtree.orgdb.convert import rowio
from test_orgdb_schema_verifier import document
from test_orgdb_verify_pg import ADMIN, RUNTIME, PREFIX, ov, _drop_all, fingerprint


class UndoFault(Exception):
    """Exit a test transaction without committing the planted row changes."""


def tearDownModule():
    if ADMIN and RUNTIME:
        _drop_all()


@unittest.skipUnless(ADMIN and RUNTIME, 'needs owned disposable PostgreSQL URLs')
class NormalizedFamilies(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _drop_all()
        cls.doc = document()
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX,
                                 build='test')
        lc.bootstrap()
        build = lc.open_build(lc.register_org('schema-families', state='converting'), 'convert')
        rows, _, _ = sections.encode_document(copy.deepcopy(cls.doc), mappers.sections())
        with conn.connect(RUNTIME, build.database, autocommit=False) as c:
            rowio.write(c, rows)
            c.commit()
        lc.mark_filled(build)
        cls.final = lc.publish(build)
        cls.dest = conn.with_db(RUNTIME, cls.final)
        cls.clean = fingerprint(cls.final)

    def check(self, c):
        verifier = ov.Verifier(ov.Dest(c), self.doc, ov.IGNORED_DEFAULT)
        verifier.run()
        return verifier

    def test_populated_families_round_trip_and_verify_against_original_source(self):
        report = ov.verify_report(self.doc, self.dest)
        self.assertEqual(report['problems'], [], report['problems'][:8])
        for table in ('work_item_review_seats', 'work_item_artifact_grants', 'work_item_delivery',
                      'agent_turns', 'work_item_holders', 'work_item_events', 'lifecycle_events'):
            self.assertGreater(report['stats']['records ' + table], 0, table)
        self.assertGreater(report['stats']['current links verified'], 7)
        self.assertEqual(report['stats']['docket projections verified'], 2)
        with conn.connect(ADMIN, self.final) as c:
            back = sections.decode_document(rowio.read(c), mappers.sections(), sections.Context())
            for table in ('agent_turn_cost_unknown_fields', 'agent_turn_model_usage_keys'):
                self.assertGreater(c.execute(f'SELECT count(*) FROM orgtree.{table}').fetchone()[0], 0)
        self.assertEqual(json.dumps(back, sort_keys=True), json.dumps(self.doc, sort_keys=True))

    def test_each_normalized_family_has_a_reached_fault_and_exact_rollback(self):
        faults = (
            ('G1', 'work_item_review_seats', "UPDATE orgtree.work_item_review_seats SET note='wrong'"),
            ('G2', 'work_item_artifact_grants', 'DELETE FROM orgtree.work_item_artifact_grants WHERE pos=0'),
            ('G3', 'work_item_delivery', "UPDATE orgtree.work_item_delivery SET stage='deployed' WHERE stage='implemented'"),
            ('G4', 'work_items', 'UPDATE orgtree.work_items SET accepted_evidence_gap_total=99'),
            ('G5', 'work_item_events', "UPDATE orgtree.work_item_events SET history_next_actor_kind='outside'"),
            ('G6', 'agents', 'UPDATE orgtree.agents SET turn_est_cost_compensation=2 WHERE NOT tombstone'),
            ('G7', 'agent_turns', 'UPDATE orgtree.agent_turns SET recent_pos=99 WHERE idx IS NULL'),
            ('G8', 'agent_turn_model_usage_keys', "UPDATE orgtree.agent_turn_model_usage_keys SET value='wrong' WHERE pos=0"),
            ('G9', 'work_items', 'UPDATE orgtree.work_items SET extra=replace(extra::text,%s,%s)::json'),
            ('G10', 'lifecycle_events', "UPDATE orgtree.lifecycle_events SET current_candidate='wrong'"),
            ('G11', 'work_items', 'UPDATE orgtree.work_items SET owner_agent_id=reviewer_agent_id'),
        )
        with conn.connect(ADMIN, self.final) as c:
            for gap, table, statement in faults:
                with self.subTest(gap=gap):
                    with self.assertRaises(UndoFault), c.transaction():
                        if gap == 'G3':
                            c.execute("DELETE FROM orgtree.work_item_delivery WHERE stage='deployed'")
                        args = (json.dumps(self.doc['work_items'][0]['title']), json.dumps('wrong')) \
                            if gap == 'G9' else ()
                        self.assertGreater(c.execute(statement, args).rowcount, 0, 'fault did not execute')
                        problems = self.check(c).problems
                        self.assertTrue(any(p['table'] == table for p in problems), problems[:8])
                        if gap == 'G9':
                            for field in ('docket_policy_extra', 'docket_list_extra'):
                                self.assertTrue(any(p['field'] == field for p in problems), problems[:8])
                        raise UndoFault()
                    self.assertEqual(fingerprint(self.final), self.clean, gap)
                    self.assertEqual(self.check(c).problems, [], gap)


if __name__ == '__main__':
    unittest.main()
