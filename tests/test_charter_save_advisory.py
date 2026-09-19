"""The long-charter note is an ADVISORY, and a save never pops it.

Ticket `remove-the-long-charter-warning-popup-from-agent`. `set_scope` returns
two kinds of text:

  * `warnings`   — something the save had to do that the user must see (a
                   ceiling clamp, a cascade, a subtree clamp, a bridge). Every
                   settings surface POPS these.
  * `advisories` — facts about a save that SUCCEEDED, carrying no action.

The long-charter note used to ride `warnings`, and the settings panel re-sends
the whole charter on every save — so an agent that already had a long charter
raised that popup again on EVERY save, over text the user had not touched. It
now rides `advisories`.

WHAT IS PINNED HERE, and why each half matters on its own:

  * the text is still stored WHOLE (the 2026-09-04 "uncap it" ruling) — the
    ticket must not have reintroduced a cut, and a test that only checked the
    popup would not notice if it had;
  * the note is in `advisories` and NOT in `warnings` — this is the negative
    control: the assertion is not "the save was quiet", it is "the note landed
    in the other field", so a backend that dropped the note entirely would
    fail here rather than pass by silence;
  * a genuine warning still lands in `warnings` on the SAME call that carries
    the note — so the two channels are proven to be independent, not one list
    that happens to be empty in this fixture;
  * a short charter produces no `advisories` key at all, so the response shape
    of an ordinary save is exactly what it always was.

The renderer half — that a settings save pops `warnings` and not `advisories`
— is `apps/desktop/renderer/tests/chartersave.test.tsx`. Neither file can see
the other's half, which is why both exist.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# The ledger imports the store lazily while constructing an Org.  Give the
# development guard an independent disposable root before that import.
_DATA = tempfile.TemporaryDirectory(prefix="charter-advisory-")
os.environ["ORGTREE_DATA"] = _DATA.name
sys.path.insert(0, str(REPO / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

#: past ledger.CHARTER_LONG (4000) — the threshold above which the note is
#: raised.  Built from a repeating sentence so a mid-word cut is visible, and
#: stripped so that it is already in the form storage keeps: the ledger has
#: always stored `value.strip()`, so a fixture with padding would be comparing
#: against the wrong text and reading the strip as an alteration.
LONG = ("rule: never end a charter mid-sentence. " * 110).strip()
assert LONG == LONG.strip() and len(LONG) > 4000, len(LONG)


class CharterSaveAdvisoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.org = ledger.Org.create(f"charter-adv-{self.id().rsplit('.', 1)[-1]}")
        self.org.hire(USER, None, "haiku", 60, "top")
        self.org.hire(USER, "top", "haiku", 4, "kid")
        # a folder both of them hold, so shrinking the parent's set has
        # something to clamp in the subtree (the genuine-warning case below)
        self.dir = tempfile.TemporaryDirectory(prefix="charter-adv-dir-")
        self.addCleanup(self.dir.cleanup)
        self.org.set_scope(USER, "top",
                           add_dirs=[{"path": self.dir.name, "mode": "rw"}])
        self.org.set_scope(USER, "kid",
                           add_dirs=[{"path": self.dir.name, "mode": "rw"}])

    # -- the text itself ----------------------------------------------------
    def test_a_long_charter_is_stored_whole_and_byte_for_byte(self):
        """The ruling this whole area exists to protect: no cap, no cut.

        The ticket says the change must not truncate, rewrite or clear the
        charter — so the stored text is compared to the sent text directly,
        not merely by length.
        """
        self.assertGreater(len(LONG), ledger.CHARTER_LONG)
        self.org.set_scope(USER, "top", charter=LONG)
        self.assertEqual(self.org.node("top")["charter"], LONG,
                         "the charter was altered on its way to storage")

    def test_the_strip_contract_is_unchanged(self):
        """CONTROL for the line above: the ledger has always stored the
        STRIPPED text, and this ticket is not the place to change that.  If a
        future change makes storage raw, the byte-for-byte test above still
        passes and this one fails — which is the point."""
        self.org.set_scope(USER, "top", charter="  padded  ")
        self.assertEqual(self.org.node("top")["charter"], "padded")

    # -- which channel the note rides ---------------------------------------
    def test_the_length_note_is_an_advisory_and_not_a_warning(self):
        """THE REQUIREMENT, and the negative control in one assertion.

        `warnings` is what a settings surface pops; it must be EMPTY here.  The
        note must still exist — in `advisories` — so this cannot be satisfied
        by quietly deleting the note.
        """
        out = self.org.set_scope(USER, "top", charter=LONG)
        self.assertEqual(out["warnings"], [],
                         "a successful long-charter save must raise no popup")
        self.assertIn("advisories", out,
                      "the note was dropped instead of moved to advisories")
        self.assertEqual(len(out["advisories"]), 1)
        note = out["advisories"][0]
        self.assertIn(f"charter is {len(LONG)} chars", note)
        self.assertIn("Stored WHOLE", note)
        for line in out["warnings"]:
            self.assertNotIn("Stored WHOLE", line)

    def test_team_charter_rides_the_same_channel(self):
        """The same note exists for `team_charter`; a fix that only moved the
        agent charter would leave the popup reachable through the other box."""
        out = self.org.set_scope(USER, "top", team_charter=LONG)
        self.assertEqual(out["warnings"], [])
        self.assertIn("team_charter is", out["advisories"][0])

    def test_a_short_charter_adds_no_field_at_all(self):
        """CONTROL: an ordinary save's response keeps the exact shape it had
        before this change — no empty `advisories` key riding along."""
        out = self.org.set_scope(USER, "top", charter="short enough")
        self.assertEqual(out["warnings"], [])
        self.assertNotIn("advisories", out,
                         "the key must appear only when there is something in it")

    def test_the_two_channels_are_independent_on_one_call(self):
        """The strong form of the control: a call that raises a REAL warning
        still carries the note in `advisories`, and the real warning is not
        displaced.  Without this, the empty `warnings` above could be an
        artifact of a fixture in which nothing ever warns.

        Shrinking the parent's folder set to nothing sweeps the subtree and
        clamps the child's grant, which is a genuine warning.
        """
        out = self.org.set_scope(USER, "top", add_dirs=[], charter=LONG)
        self.assertTrue(out["warnings"],
                        "the subtree clamp did not warn — the control is dead")
        self.assertTrue(any("clamped" in w for w in out["warnings"]),
                        f"unexpected warning set: {out['warnings']}")
        self.assertIn("advisories", out)
        self.assertIn("Stored WHOLE", out["advisories"][0])
        self.assertFalse(any("Stored WHOLE" in w for w in out["warnings"]),
                         "the note leaked back into the popping channel")

    def test_a_refused_save_still_refuses(self):
        """CONTROL the other way: the ticket removes an advisory popup, not
        errors.  A hard validation failure must still raise."""
        with self.assertRaises(ledger.LedgerError):
            self.org.set_scope(USER, "top", permission_mode="not-a-mode")
        with self.assertRaises(ledger.LedgerError):
            self.org.set_scope(USER, "top", effort="not-an-effort")


if __name__ == "__main__":
    unittest.main()
