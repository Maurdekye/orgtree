"""An unmatched current value isolates its org at the real converter boundary."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest

import test_orgdb_startup_pg as fixture
from orgtree import store
from orgtree.orgdb import conn


def setUpModule():
    unittest.addModuleCleanup(fixture.tearDownModule)
    fixture.setUpModule()


@fixture.needs_pg
class CurrentValueIsolation(unittest.TestCase):
    def test_unmatched_verdict_leaves_other_org_active_at_first_start(self):
        slugs = []
        for bad in (False,True):
            org = store.create_org('unmatched current' if bad else 'matching current')
            slugs.append(org.d['slug'])
            verdict = dict(candidate='a'*40,decision='approve_stage',note='matched')
            record = dict(slug='pointer-input',kind='code',status='in_progress',title='Pointer input',
                          objective='Conversion must preserve the explicit current event.',
                          history=[],evidence=[],scope=[],candidate_verdict=verdict,
                          candidate_verdicts=[dict(verdict)],review_packet=None,review_packets=[])
            if bad:
                record['candidate_verdict'] = dict(verdict,note='matches no event')
            org.d['work_items'] = [record]
            store.save_org(org)
        result = fixture.run_start(build='docket-events-q12')
        self.assertTrue(result['first_pass']['ran'])
        outcomes = {row['slug']:row['outcome'] for row in result['first_pass']['orgs']}
        self.assertEqual(outcomes[slugs[0]],'active')
        self.assertEqual(outcomes[slugs[1]],'unavailable')
        rows = fixture.rows()
        good,bad = (rows[slug] for slug in slugs)
        self.assertEqual(good['state'],'active')
        self.assertEqual(bad['state'],'unavailable')
        self.assertEqual(bad['unavailable_step'],'conversion')
        self.assertIn('pointer-input',bad['state_reason'])
        self.assertIn('candidate_verdict',bad['state_reason'])
        with conn.connect(fixture.RUNTIME,good['database']) as raw:
            pointer = raw.execute('SELECT current_verdict_event_id FROM orgtree.work_items '
                                  "WHERE slug='pointer-input'").fetchone()[0]
            self.assertIsNotNone(pointer)
            self.assertEqual(raw.execute('SELECT kind FROM orgtree.work_item_events WHERE id=%s',(pointer,)).fetchone()[0],
                             'verdict')


if __name__=='__main__':
    unittest.main()
