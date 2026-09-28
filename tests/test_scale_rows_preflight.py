"""The N1000 controller's rows preflight verdict (tools/scale/rows_preflight.py)."""
from pathlib import Path
import sys
import unittest

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
from rows_preflight import bytes_verdict, decide, judge, large_judge, verdict


def arm(read, message, tokens=1, harness=5):
    return {"tokens": {"rows": tokens}, "settlement": {"rows": harness}, "work_items": {"rows": read},
            "chat": {"rows": read}, "notifications": {"rows": read}, "org_list": {"rows": read},
            "message": {"rows": message}}


class Verdict(unittest.TestCase):
    def test_flat_rows_pass(self):
        passed, ratios = verdict({10: arm(40, 90), 100: arm(44, 120, tokens=100)})
        self.assertTrue(passed)
        self.assertAlmostEqual(ratios["message"], 120 / 90)

    def test_whole_org_load_per_request_fails(self):
        # Shape of efb74da at N1000: rows track the node count on every call.
        passed, ratios = verdict({10: arm(45, 180), 100: arm(415, 1660)})
        self.assertFalse(passed)
        self.assertGreater(ratios["chat"], 2)

    def test_one_growing_call_is_enough_to_fail(self):
        passed, _ = verdict({10: arm(40, 90), 100: arm(40, 900)})
        self.assertFalse(passed)
        grown = arm(40, 90)
        grown["notifications"] = {"rows": 238}
        passed, ratios = verdict({10: arm(40, 90) | {"notifications": {"rows": 69}}, 100: grown})
        self.assertFalse(passed)
        self.assertGreater(ratios["notifications"], 2)

    def test_harness_and_per_agent_calls_are_not_judged(self):
        passed, ratios = verdict({10: arm(40, 90, tokens=10, harness=97),
                                  100: arm(40, 90, tokens=1000, harness=359)})
        self.assertTrue(passed)
        self.assertEqual(set(ratios), {"work_items", "chat", "notifications", "org_list", "message"})

    def test_no_measured_work_refuses_a_verdict(self):
        with self.assertRaises(ValueError):
            verdict({10: arm(0, 90), 100: arm(0, 90)})
        with self.assertRaises(ValueError):
            verdict({10: {"message": {"rows": 4}}, 100: {"message": {"rows": 4}}})


def sized(**mb):
    calls = ("work_items", "chat", "notifications", "org_list", "message")
    return {c: {"rows": 10, "value_bytes": int(mb.get(c, 1) * 1e6)} for c in calls}


class BytesVerdict(unittest.TestCase):
    def test_flat_rows_but_growing_bytes_fails(self):
        # node_chat before 1ecc1a9 in a steered-log-heavy seed: rows flat, bytes grow.
        passed, ratios = bytes_verdict({10: sized(chat=1.0), 100: sized(chat=3.5)})
        self.assertFalse(passed)
        self.assertAlmostEqual(ratios["chat"], 3.5)

    def test_moderate_byte_growth_passes(self):
        # message on 74291b4: 0.40 -> 0.75 MB (1.88x), fixed in rows.
        passed, _ = bytes_verdict({10: sized(message=0.40), 100: sized(message=0.75)})
        self.assertTrue(passed)

    def test_tiny_reads_are_exempt_from_the_bytes_ratio(self):
        # notifications on a9a96e6: 8.3 KB -> 29.3 KB (3.53x), flat rows.
        passed, ratios = bytes_verdict({10: sized(notifications=0.0083), 100: sized(notifications=0.0293)})
        self.assertTrue(passed)
        self.assertGreater(ratios["notifications"], 3)

    def test_growth_crossing_the_floor_fails(self):
        passed, _ = bytes_verdict({10: sized(org_list=0.37), 100: sized(org_list=3.25)})
        self.assertFalse(passed)
        # just above the 256 KB floor still counts; just below does not
        passed, _ = bytes_verdict({10: sized(chat=0.05), 100: sized(chat=0.3)})
        self.assertFalse(passed)
        passed, _ = bytes_verdict({10: sized(chat=0.05), 100: sized(chat=0.2)})
        self.assertTrue(passed)

    def test_zero_bytes_refuses_a_verdict(self):
        with self.assertRaises(ValueError):
            bytes_verdict({10: sized(org_list=0), 100: sized()})


class Judge(unittest.TestCase):
    """preflight() decides through judge(): each check alone must fail it."""

    def test_flat_everything_passes(self):
        passed, _, _, fell = judge({10: sized(), 100: sized()})
        self.assertTrue(passed)
        self.assertEqual(fell, {})

    def test_bytes_alone_fail_it(self):
        passed, ratios, byte_ratios, _ = judge({10: sized(chat=1.0), 100: sized(chat=3.5)})
        self.assertFalse(passed)
        self.assertEqual(ratios["chat"], 1.0)

    def test_rows_alone_fail_it(self):
        large = sized()
        large["org_list"]["rows"] = 50
        passed, ratios, byte_ratios, _ = judge({10: sized(), 100: large})
        self.assertFalse(passed)
        self.assertEqual(byte_ratios["org_list"], 1.0)

    def test_a_lazy_fallback_alone_fails_it(self):
        large = sized()
        large["message"]["lazy_fallbacks"] = 1
        passed, _, _, fell = judge({10: sized(), 100: large})
        self.assertFalse(passed)
        self.assertEqual(fell, {"100:message": 1})


class LargeStep(unittest.TestCase):
    """--preflight-large: chat and message judged again from N=100 to N=1000."""

    def test_attempt_4_message_growth_fails_it(self):
        big = sized(message=1.2)
        big["message"]["rows"] = 29          # 10 -> 29 rows: the 335 -> ~985 shape
        passed, ratios, _, _ = large_judge({10: sized(), 100: sized(), 1000: big})
        self.assertFalse(passed)
        self.assertGreater(ratios["message"], 2)

    def test_flat_large_step_passes_and_judges_only_chat_and_message(self):
        big = sized(org_list=9.0)            # not judged at the large step
        big["org_list"]["rows"] = 100
        passed, ratios, byte_ratios, fell = large_judge({10: sized(), 100: sized(), 1000: big})
        self.assertTrue(passed)
        self.assertEqual(set(ratios), {"chat", "message"})
        self.assertEqual(set(byte_ratios), {"chat", "message"})

    def test_decide_fails_when_only_the_large_step_fails(self):
        big = sized()
        big["message"]["rows"] = 29
        self.assertTrue(decide({10: sized(), 100: sized()})["passed"])
        summary = decide({10: sized(), 100: sized(), 1000: big})
        self.assertFalse(summary["passed"])
        self.assertEqual(summary["large"]["message"]["rows_n1000"], 29)
        self.assertTrue(decide({10: sized(), 100: sized(), 1000: sized()})["passed"])

    def test_decide_without_the_large_step_reports_none(self):
        self.assertIsNone(decide({10: sized(), 100: sized()})["large"])

    def test_a_fallback_at_n1000_fails_it(self):
        big = sized()
        big["chat"]["lazy_fallbacks"] = 2
        passed, _, _, fell = large_judge({10: sized(), 100: sized(), 1000: big})
        self.assertFalse(passed)
        self.assertEqual(fell, {"100:chat": 2})


if __name__ == "__main__":
    unittest.main()
