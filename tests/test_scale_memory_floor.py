"""memory_floor: judge the per-minute floor, report the peak (attempt 6 square wave)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "scale"))

from baseline_measurement import memory_floor  # noqa: E402

MB = 2 ** 20


def square_wave(seconds, low_mb, high_mb, period=21.5, floor_growth_mb_per_s=0.0):
    """1 Hz samples: high for the first half of each period, low for the rest."""
    return [(t, int((high_mb if (t % period) < period / 2 else low_mb) * MB + floor_growth_mb_per_s * t * MB))
            for t in range(seconds)]


class MemoryFloor(unittest.TestCase):
    def test_attempt_6_square_wave_over_a_flat_floor_is_flat(self):
        # Samples start high and end high, so a raw end-minus-start or slope
        # reads as growth; the per-minute floor does not move.
        r = memory_floor(square_wave(600, 430, 640))
        self.assertEqual(len(r["floors_mb"]), 10)
        self.assertEqual(set(r["floors_mb"]), {430.0})
        self.assertEqual(r["peak_mb"], 640.0)
        self.assertTrue(r["floor_flat"])
        self.assertEqual(r["floor_slope_mb_per_min"], 0.0)

    def test_a_rising_floor_fails(self):
        # +0.1 MB/s = 6 MB/min on a 430 MB floor: about 12 % over 9 minutes.
        r = memory_floor(square_wave(600, 430, 640, floor_growth_mb_per_s=0.1))
        self.assertFalse(r["floor_flat"])
        self.assertGreater(r["floor_growth_pct"], 5.0)
        self.assertAlmostEqual(r["floor_slope_mb_per_min"], 6.0, delta=0.2)

    def test_small_growth_within_the_limit_passes(self):
        r = memory_floor(square_wave(600, 430, 640, floor_growth_mb_per_s=0.02))
        self.assertTrue(r["floor_flat"])
        self.assertGreater(r["floor_growth_pct"], 0.0)

    def test_trailing_partial_bucket_is_dropped(self):
        # 10 s of a partial minute sitting on the high half of the wave would
        # read as a floor of 640 MB.
        points = square_wave(600, 430, 640) + [(t, 640 * MB) for t in range(600, 610)]
        r = memory_floor(points)
        self.assertEqual(len(r["floors_mb"]), 10)
        self.assertTrue(r["floor_flat"])

    def test_too_short_to_judge(self):
        r = memory_floor(square_wave(90, 430, 640))
        self.assertIsNone(r["floor_flat"])
        self.assertEqual(r["peak_mb"], 640.0)
        self.assertIsNone(memory_floor([]))


if __name__ == "__main__":
    unittest.main()
