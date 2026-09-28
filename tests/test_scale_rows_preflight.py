"""The N1000 controller's rows preflight verdict (tools/scale/rows_preflight.py)."""
from pathlib import Path
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
from rows_preflight import (ITEM_JUDGED, ITEMS, SIZES, bytes_verdict, decide, judge,
                            seeded_items, verdict)


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


class ItemStep(unittest.TestCase):
    """The item step judges ITEMS[1] vs ITEMS[0] active items at fixed N with
    the same rules (message-send-reads-grow-above-n-100-985-rows-1-2)."""
    def test_the_steps_change_one_axis_each(self):
        self.assertEqual(ITEMS, (20, 180))
        self.assertEqual(SIZES, (10, 100))

    def test_reads_that_follow_the_item_count_fail_the_item_step(self):
        small, large = sized(), sized()
        large["message"]["rows"] = small["message"]["rows"] * 3
        passed, ratios, _, _ = judge({20: small, 180: large}, steps=ITEMS)
        self.assertFalse(passed)
        self.assertEqual(ratios["message"], 3.0)

    def test_the_docket_view_is_recorded_not_judged_on_the_item_step(self):
        # it shows every active item by design; everything else is judged
        small, large = sized(), sized()
        large["work_items"]["rows"] = small["work_items"]["rows"] * 9
        self.assertNotIn("work_items", ITEM_JUDGED)
        self.assertTrue(judge({20: small, 180: large}, steps=ITEMS, calls=ITEM_JUDGED)[0])
        self.assertFalse(judge({20: small, 180: large}, steps=ITEMS)[0])

    def test_either_step_failing_alone_fails_the_preflight(self):
        ok, bad = {"passed": True}, {"passed": False}
        self.assertEqual(decide({"agents": ok, "items": ok}), (True, []))
        self.assertEqual(decide({"agents": ok, "items": bad}), (False, ["items"]))
        self.assertEqual(decide({"agents": bad, "items": ok}), (False, ["agents"]))

    def test_the_receipt_carries_the_seeded_count_and_refuses_a_short_seed(self):
        descriptor = {"seed": {"summary": {"work_items": 180}}}
        self.assertEqual(seeded_items(descriptor, 180), 180)
        with self.assertRaises(RuntimeError):
            seeded_items({"seed": {"summary": {"work_items": 40}}}, 180)
        with self.assertRaises(RuntimeError):
            seeded_items({"seed": {}}, 20)

    def test_flat_item_step_passes(self):
        passed, _, _, fell = judge({20: sized(), 180: sized()}, steps=ITEMS)
        self.assertTrue(passed)
        self.assertEqual(fell, {})


if __name__ == "__main__":
    unittest.main()
