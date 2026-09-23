"""Which marker may reconcile's spend erase, and which must it leave alone?

`reconcile` spends a turn marker immediately before the dispatch it pays for.
Between collection and that spend, a live agent can start a real turn on the
seat and write it a NEW marker. The spend must erase only the marker it
collected — erasing the other one destroys a running turn's only record of
itself, which is the stranding bug this module was changed to fix, re-entered
through the fix.

THE PREDICATE HAS TWO HALVES AND EACH ONE ALONE IS WRONG. Both were shipped
alone at some point in this ticket's history and both were caught in review:

  §1  `at` identifies the turn, so an in-place EDIT of the marker still
      counts as the same marker. ⚠ NO LIVE PATH PERFORMS SUCH AN EDIT TODAY
      and this suite does not claim one: `desktop_import.py:461-462` does pop
      `cache_attempt` and rewrite `text` on an existing marker, but it runs
      against a STAGED document during the V1→V2 import, before that org is
      published and reconcilable, so it cannot fall between a collection and
      its spend. §1 pins the behaviour for the case where such an edit ever
      DOES land inside that window. An earlier version of this file called it
      a live hazard; restart-mail traced the staging and corrected that, and
      the correction matters because a test asserting a hazard the world does
      not have is this ticket's own original defect wearing a new hat.
  §2  a marker from an older build has NO `at`, and comparing None to None
      would make two DIFFERENT turns look like one. That is the unsafe
      direction — a destroyed marker — so with no `at` to go on, nothing
      less than full equality will do. This one is reachable.
  §3  the ordinary cases, including the one the whole guard exists for.

WHY IDENTITY MATTERS MORE SINCE THE USER'S 2026-09-19 RULING. A false
"different" verdict no longer merely leaks a marker: the seat is now SKIPPED
and its interrupted turn is DROPPED. Asking a stricter question than "is this
the same turn" therefore costs work, which is why `at` leads and full
equality is only the fallback for markers that have no `at` to compare.

    python -B tests/test_restart_marker_identity.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_fx = tempfile.TemporaryDirectory(prefix='marker-identity-')
os.environ['ORGTREE_DATA'] = str(Path(_fx.name) / 'data')
os.environ['HOME'] = str(Path(_fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'marker-identity-only'
for _k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store, supervisor as sup          # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

SAME_AT = '2026-09-18T21:41:00.000Z'
OTHER_AT = '2026-09-19T05:55:55.555Z'


class MarkerIdentity(unittest.TestCase):

    def test_1_an_in_place_edit_is_still_the_same_marker(self):
        """§1 An edit that keeps `at` is the same turn's marker. Full dict
        equality called it a different marker — which under the current
        ruling would SKIP the seat and drop its interrupted turn.

        ⚠ NOT A LIVE HAZARD TODAY. The only in-place editor,
        `desktop_import.py:461-462`, runs against a staged document before
        the org is reconcilable. This pins the rule, not a reachable bug."""
        collected = {'at': SAME_AT, 'text': 'the original drive',
                     'view': 'v', 'cache_attempt': 3}
        edited = {'at': SAME_AT, 'text': '[V1 COPY IMPORT] rewritten', 'view': 'v'}
        self.assertTrue(sup._marker_is_same(edited, collected),
                        'an edited marker with the same start time is the '
                        'same turn and must still be spendable')

    def test_2_two_at_less_markers_are_not_assumed_identical(self):
        """§2 THE UNSAFE DIRECTION. Older builds wrote no `at`. Comparing
        `at` alone would compare None to None and spend a marker belonging to
        a different turn — destroying a running turn's only record."""
        collected = {'text': 'an older build\'s interrupted turn', 'view': 'v'}
        newer = {'text': 'a completely different turn', 'view': 'v2'}
        self.assertFalse(sup._marker_is_same(newer, collected),
                         'with no `at` to identify it by, a different marker '
                         'must never be treated as the same one')
        self.assertTrue(sup._marker_is_same(dict(collected), collected),
                        'the same at-less marker is still spendable')

    def test_3a_a_newer_turns_marker_is_never_spent(self):
        """§3a THE WHOLE POINT. The seat started a fresh turn while the
        dispatch loop was elsewhere; that turn owns its marker."""
        collected = {'at': SAME_AT, 'text': 'the interrupted turn', 'view': 'v'}
        newer = {'at': OTHER_AT, 'text': 'a turn that started just now', 'view': 'v'}
        self.assertFalse(sup._marker_is_same(newer, collected))

    def test_3b_the_unchanged_marker_is_spent(self):
        """§3b THE CONTROL. A guard that refused everything would pass every
        test above and spend nothing, which strands every seat by leaking."""
        collected = {'at': SAME_AT, 'text': 'the interrupted turn', 'view': 'v'}
        self.assertTrue(sup._marker_is_same(dict(collected), collected))

    def test_3c_an_absent_or_malformed_marker_is_not_spendable(self):
        """§3c Nothing to spend, and nothing to crash on. `inflight` is a key
        that legitimately holds None (a reseeded bearer), so the absent case
        is real rather than defensive."""
        collected = {'at': SAME_AT, 'text': 't', 'view': 'v'}
        for absent in (None, '', [], 'inflight'):
            self.assertFalse(sup._marker_is_same(absent, collected), repr(absent))
        self.assertFalse(sup._marker_is_same(collected, None))


if __name__ == '__main__':
    unittest.main(verbosity=2)
