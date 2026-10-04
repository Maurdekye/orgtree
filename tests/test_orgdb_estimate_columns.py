"""G6 exact values and faults before integration into the new org migration."""

import import_provenance  # noqa: F401  asserts this checkout, not the installed app

from decimal import Decimal
import math
import unittest

from orgtree.orgdb import codec, estimate_columns as E


class EstimateColumns(unittest.TestCase):
    def test_absent_null_and_integer_values(self):
        for key in ('turn_est_cost', 'turn_est_toks'):
            for value in (codec.MISSING, None, ['i', 0], ['i', -(10 ** 120)], ['i', 10 ** 120]):
                with self.subTest(key=key, value=value):
                    row, extra = E.encode(key, value)
                    actual = E.decode(key, row, extra)
                    if value is codec.MISSING:
                        self.assertIs(actual, codec.MISSING)
                    else:
                        self.assertEqual(actual, value)
                    if isinstance(value, list):
                        self.assertIsInstance(row[key + '_integer'], Decimal)
                        self.assertIs(type(actual[1]), int)
                        self.assertEqual(extra, {})

    def test_float_compensation_and_signed_zero_are_separate(self):
        # Removing this residual changes the estimate after cancellation.
        # Both doubles, including their signs, must survive a database round trip.
        for value in (['f', 1e16, 1.0], ['f', -0.0, -0.0], ['f', 0.1, 1.3877787807814457e-17]):
            with self.subTest(value=value):
                row, extra = E.encode('turn_est_cost', value)
                actual = E.decode('turn_est_cost', row, extra)
                self.assertEqual(actual, value)
                self.assertIsNone(row['turn_est_cost_integer'])
                self.assertEqual(extra, {})
                for before, after in zip(value[1:], actual[1:]):
                    self.assertIs(type(after), float)
                    self.assertEqual(math.copysign(1, before), math.copysign(1, after))

    def test_exceptional_shapes_stay_original(self):
        values = (False, 0, '', {}, [], ['i', True], ['i', 2.0], ['i', 1, 0],
                  ['f', 1.0], ['f', 1, 0.0], ['f', 1.0, 0], ['other', 3],
                  {'unknown': '\0\ud800'})
        for value in values:
            with self.subTest(value=value):
                row, extra = E.encode('turn_est_toks', value)
                self.assertEqual(row['turn_est_toks_is'], 'x')
                self.assertEqual(codec.from_column('json', codec.to_column('json', extra)), extra)
                self.assertEqual(E.decode('turn_est_toks', row, extra), value)

    def test_nonfinite_state_keeps_existing_shape_refusal(self):
        for value in (['f', float('nan'), 0.0], ['f', 1.0, float('inf')]):
            with self.subTest(value=value):
                with self.assertRaises(codec.ShapeError):
                    E.encode('turn_est_cost', value)

    def test_damaged_typed_rows_are_refused(self):
        row, extra = E.encode('turn_est_cost', ['f', 1e16, 1.0])
        # Faults represent a missing compensation and contradictory integer storage.
        for change in ({'turn_est_cost_compensation': None},
                       {'turn_est_cost_integer': Decimal(3)},
                       {'turn_est_cost_is': 'n'}, {'turn_est_cost_kind': 'i'}):
            with self.subTest(change=change):
                with self.assertRaises(codec.ShapeError):
                    E.decode('turn_est_cost', {**row, **change}, extra)
        int_row, int_extra = E.encode('turn_est_toks', ['i', 5])
        with self.assertRaises(codec.ShapeError):
            E.decode('turn_est_toks', {**int_row, 'turn_est_toks_integer': Decimal('5.5')}, int_extra)
        with self.assertRaises(codec.ShapeError):
            E.decode('turn_est_toks', {**int_row, 'turn_est_toks_integer': Decimal('NaN')}, int_extra)


if __name__ == '__main__':
    unittest.main()
