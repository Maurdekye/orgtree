"""Synthetic scale and sample protocol controls; no database or engine boot."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
from unittest.mock import patch
import orgdb_history_fixture as fixture


class HistoryScale(unittest.TestCase):
    def test_builder_scales_each_history_category_and_preserves_current_inputs(self):
        current = dict(nodes={'dev': dict(state='live', parent=None)},
                       asks=[dict(id='open', status='open')], documents=[dict(id='current')],
                       work_items_archive=[dict(slug='held-work', manual_attention={'reason': 'read'})])
        counts = dict(archived_agents=2, closed_asks=3, closed_credit_requests=4,
                      turn_log=5, deduplicated_turns=14, documents=6,
                      archived_docket=2, docket_history=7)
        doc = fixture.build_document(current, counts)
        self.assertEqual(current['nodes'], {'dev': dict(state='live', parent=None)})
        self.assertEqual(len(doc['nodes']), 3)
        self.assertEqual([len(doc['nodes'][f'archive-{i:06}']['turns']) for i in range(2)], [8, 1])
        self.assertEqual(len(doc['turn_log']['dev']), 5)
        self.assertEqual(doc['asks'][-1], current['asks'][0])
        self.assertEqual(len(doc['credit_requests']), 4)
        self.assertEqual(doc['documents'][-1]['id'], 'current')
        self.assertEqual(len(doc['documents']), 7)
        self.assertEqual(sum(len(row['history']) for row in doc['work_items_archive'][:-1]), 7)
        self.assertEqual(doc['work_items_archive'][-1], current['work_items_archive'][0])

    def test_rates_target_5000_hours_and_keep_small_baseline(self):
        census = dict(measured_agent_hours=20, rows_per_agent_hour={'archived_agents': 2.5, 'asks': 0.1})
        self.assertEqual(fixture.targets(census), {'archived_agents': 12500, 'asks': 500})
        self.assertEqual(fixture.targets(census, fixture.BASELINE_HOURS), {'archived_agents': 3, 'asks': 1})
        with self.assertRaises(ValueError):
            fixture.targets(dict(measured_agent_hours=0))
        measured = fixture.load_census()
        self.assertEqual(fixture.targets(measured), measured['target_5000_hours'])
        self.assertEqual(measured['duration_counts']['unknown_duration_turns'], 532)

    def test_nine_complete_calls_after_one_warmup_and_added_latency(self):
        calls = []
        clock = iter(value for i in range(9) for value in (i, i + 0.012))
        with patch.object(fixture.time, 'perf_counter', side_effect=lambda: next(clock)):
            result = fixture.sample(lambda slug: calls.append(slug) or [], 'synthetic')
        self.assertEqual(calls, ['synthetic'] * 10)
        self.assertEqual(len(result['samples_ms']), 9)
        self.assertAlmostEqual(result['median_ms'], 12)
        self.assertEqual(fixture.added_latency(dict(median_ms=5), dict(median_ms=105)), 100)


if __name__ == '__main__':
    unittest.main()
