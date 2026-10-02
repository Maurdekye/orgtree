"""Jobs policy validation without a database. Run through the verification runner."""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
from orgtree.orgdb import jobs


class RetryPolicy(unittest.TestCase):
    def test_backoff_doubles_and_caps(self):
        self.assertEqual([jobs.backoff(i, base_seconds=2, cap_seconds=10)
                          for i in range(1, 7)], [2, 4, 8, 10, 10, 10])
        self.assertEqual(jobs.backoff(10**6), 300)

    def test_bad_limits_and_times_are_refused_before_query(self):
        for invalid in (0, -1, float('nan'), float('inf')):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    jobs.claim(None, 1, lease_seconds=invalid)
                with self.assertRaises(ValueError):
                    jobs.Worker({}, owner=1, active_orgs=lambda: [], connect=lambda o: None,
                                sweep_seconds=invalid)
        for invalid in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                jobs.sweep(None, limit=invalid)
            with self.assertRaises(ValueError):
                jobs.enqueue(None, 'test', 'key', max_attempts=invalid)


if __name__ == '__main__':
    unittest.main()
