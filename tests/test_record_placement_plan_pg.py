"""Isolate the actual placement plan control so errors retain their traceback."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest

import test_record_placement_pg as controls

setUpModule = controls.setUpModule
tearDownModule = controls.tearDownModule
Placement = controls.Placement

if __name__ == '__main__':
    unittest.main(argv=[__file__,
        'Placement.test_complete_placement_reads_are_indexed_and_decode_no_bodies_at_scale'],
        verbosity=2)
