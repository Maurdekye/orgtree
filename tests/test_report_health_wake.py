"""A report whose work has STOPPED must WAKE its superior, not queue quietly.

User ruling 2026-09-17 21:29, after `toolbar-polish` was walled at 21:19:19Z
holding an assigned, in-progress ticket and its coordinator — idle, with
nothing else to wake it — did not find out for ten minutes, and then only
because the user noticed: *"your report was frozen. it seems the notification
was only queued, and it didnt wake you. something like that should always wake
you."*

Both announcers used to deposit durable mail and stop. `_limit_announce` said
so in the notice itself ("You have NOT been woken for this") and `_parked_announce`
said so in its docstring ("PASSIVE, like `_limit_announce`: mail, never a drive").

WHAT IS DELIBERATELY *NOT* CHANGED, and is pinned here so a later edit cannot
quietly take it:
  · the one-notice-per-episode bound (`limit_run` / `parked_run`). A walled lane
    refuses attempt after attempt and auto-resume keeps re-driving the node into
    it; one wake per attempt would destroy the channel.
  · the firehose bound. One account hitting its limit walls every report on that
    lane at once, so the WAKE is throttled per superior while the durable mail is
    still deposited every time.
  · genuinely informational notices stay passive; only stopped-work wakes.
"""
import contextlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-report-health-")
os.environ["ORGTREE_DATA"] = _ROOT.name
os.environ["ORGTREE_WARM"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, supervisor as sup  # noqa: E402

WALL = ("You've reached your usage limit for Claude Opus. "
        "Your limit resets at 2026-09-19T09:00:00Z.")

#: `mcp` is a LIST of server names, not a flag — norm_tools iterates it.
NO_TOOLS = {"bash": False, "web": False, "edit": False, "subagents": False,
            "mcp": []}

#: module-level, NOT a class attribute. As a class attribute each subclass
#: inherits its own copy starting from 0, so the third test of one class and
#: the third of another both ask for `health-wake-3` and the second one dies
#: on "org already exists".
_SEQ = 0


def _hire(org, actor, parent, name, grant=0):
    """Hires have no defaults — every field is stated explicitly. The superior
    needs a grant of its own or it cannot pay for the report's seat."""
    return org.hire(actor, parent, "opus", grant, name, add_dirs=[],
                    tools=NO_TOOLS, org_visibility="self", charter="fixture")


class _Base(unittest.TestCase):
    """A real two-node org: a superior with one report under it."""

    def setUp(self):
        global _SEQ
        _SEQ += 1
        self.slug = f"health-wake-{_SEQ}"
        self.sup = "boss"
        self.nid = "worker"
        org = store.create_org(self.slug)
        _hire(org, ledger.USER, None, self.sup, grant=20)
        _hire(org, self.sup, self.sup, self.nid)
        store.save_org(org)
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(sup, "notify"))
        self.stack.enter_context(patch.object(sup, "mail_spark"))
        # Every test starts with an empty drive-throttle bucket, or an earlier
        # test's wake would suppress this one's and it would read as a failure
        # to drive rather than as the throttle working.
        #
        # ⚠ getattr, NOT a bare attribute access, and the reason is about what
        # this suite PROVES. Run against the pre-fix engine, `sup._stopped_drove`
        # does not exist, and a bare access made all twelve tests die in setUp
        # with AttributeError — which demonstrates only that the tests did not
        # run. A negative control that never executes is worth nothing. Degrading
        # here instead lets every test run to its real assertion and fail on the
        # behaviour ("the superior must be DRIVEN, not merely mailed"), which is
        # the thing actually being claimed.
        getattr(sup, "_stopped_drove", {}).clear()
        self.drives = []
        self.stack.enter_context(
            patch.object(sup, "send_message",
                         side_effect=lambda slug, nid, text, **kw:
                         self.drives.append((nid, text)) or {}))

    def node(self):
        return store.load_org(self.slug).node(self.nid)

    def freeze(self, *, until_ts, error=WALL, cause=None):
        """Write the frozen record the announcers read, exactly as the freeze
        path leaves it. They read the record rather than taking arguments."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            fz = {"limit": True, "error": error, "at": time.time()}
            if until_ts is not None:
                fz["until_ts"] = until_ts
                fz["until"] = "2026-09-19T09:00:00Z"
            if cause:
                fz["cause"] = cause
            org.node(self.nid)["frozen"] = fz
            store.save_org(org)

    def superior_mail(self):
        box = (store.load_org(self.slug).d.get("mail") or {}).get(self.sup) or []
        return [m for m in box if m.get("from") == "@system"]


class UsageLimitWakesTests(_Base):
    """`_limit_announce` — the case the user actually hit."""

    def test_a_walled_report_wakes_its_superior(self):
        """THE RULING. Not read off the call site: the drive is observed."""
        self.freeze(until_ts=time.time() + 3600)

        told = sup._limit_announce(self.slug, self.nid, "Claude · opus")

        self.assertTrue(told)
        self.assertEqual([d[0] for d in self.drives], [self.sup],
                         "the superior must be DRIVEN, not merely mailed")
        self.assertIn("FROZEN", self.drives[0][1])
        self.assertEqual(len(self.superior_mail()), 1,
                         "the durable mail must still be deposited")

    def test_the_durable_mail_still_lands_when_the_drive_is_throttled(self):
        """Loud once, complete always: throttling the WAKE must never cost a
        notice. This is what makes bounding the drive safe."""
        self.freeze(until_ts=time.time() + 3600)
        sup._limit_announce(self.slug, self.nid, "Claude · opus")
        self.assertEqual(len(self.drives), 1)

        # a second, different report of the same superior walls moments later
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            _hire(org, self.sup, self.sup, "worker2")
            org.node("worker2")["frozen"] = {
                "limit": True, "error": WALL, "until_ts": time.time() + 3600,
                "until": "2026-09-19T09:00:00Z", "at": time.time()}
            store.save_org(org)

        sup._limit_announce(self.slug, "worker2", "Claude · opus")

        self.assertEqual(len(self.drives), 1,
                         "one account wall breaks a whole team at once — the "
                         "second report must NOT buy a second wake")
        self.assertEqual(len(self.superior_mail()), 2,
                         "but its durable notice must still be in the box")

    def test_a_repeatedly_walled_report_cannot_wake_its_superior_repeatedly(self):
        """⚠ THE EPISODE BOUND. Auto-resume re-drives a frozen node into the
        same wall over and over; if each wall woke the superior the channel
        would be worthless. A failure here means the dedupe was lost."""
        self.freeze(until_ts=time.time() + 3600)
        self.assertTrue(sup._limit_announce(self.slug, self.nid, "Claude · opus"))
        self.assertEqual(len(self.drives), 1)
        self.assertEqual(self.node()["limit_run"], 1)

        # walled again, and again, inside the same episode
        for expected_run in (2, 3, 4):
            self.freeze(until_ts=time.time() + 3600)
            self.assertFalse(
                sup._limit_announce(self.slug, self.nid, "Claude · opus"),
                "a wall inside an episode already announced must stay quiet")
            self.assertEqual(self.node()["limit_run"], expected_run,
                             "the run counter must still advance on every wall")

        self.assertEqual(len(self.drives), 1, "still exactly one wake")
        self.assertEqual(len(self.superior_mail()), 1, "and one notice")

    def test_the_episode_bound_is_not_the_drive_throttle_in_disguise(self):
        """⚠ CONTROL for the test above. Its assertion would also pass if the
        drive throttle alone were suppressing the wake, which would be a much
        weaker guarantee that expires after two minutes. Clearing the throttle
        between walls isolates the EPISODE bound as the thing doing the work."""
        self.freeze(until_ts=time.time() + 3600)
        self.assertTrue(sup._limit_announce(self.slug, self.nid, "Claude · opus"))

        for _ in range(3):
            getattr(sup, "_stopped_drove", {}).clear()          # throttle cannot be the reason
            self.freeze(until_ts=time.time() + 3600)
            self.assertFalse(sup._limit_announce(self.slug, self.nid, "Claude · opus"))

        self.assertEqual(len(self.drives), 1,
                         "with the throttle cleared, only the episode bound is "
                         "left to stop the second wake — and it must")

    def test_a_completed_turn_re_arms_the_wake_for_a_genuinely_new_episode(self):
        """The bound must not be a permanent mute. A turn that actually RUNS
        ends the episode, so the next wall is new and must wake again."""
        self.freeze(until_ts=time.time() + 3600)
        sup._limit_announce(self.slug, self.nid, "Claude · opus")
        self.assertEqual(len(self.drives), 1)

        with store.DOC_LOCK:                     # what `_after_turn` does
            org = store.load_org(self.slug)
            org.node(self.nid).pop("limit_run", None)
            store.save_org(org)
        getattr(sup, "_stopped_drove", {}).clear()               # and enough time has passed
        self.freeze(until_ts=time.time() + 3600)

        self.assertTrue(sup._limit_announce(self.slug, self.nid, "Claude · opus"))
        self.assertEqual(len(self.drives), 2,
                         "a wall after a completed turn is a NEW episode")


class ParkedWakesTests(_Base):
    """`_parked_announce` — no reset time at all, so nothing will ever wake it."""

    def test_a_parked_report_wakes_its_superior(self):
        self.freeze(until_ts=None, error="401 rejected", cause="auth")

        told = sup._parked_announce(self.slug, self.nid, "auth", "Claude · opus")

        self.assertTrue(told)
        self.assertEqual([d[0] for d in self.drives], [self.sup])
        self.assertIn("STOPPED", self.drives[0][1])

    def test_a_parked_report_stays_bounded_to_one_wake_per_episode(self):
        self.freeze(until_ts=None, error="401 rejected", cause="auth")
        self.assertTrue(sup._parked_announce(self.slug, self.nid, "auth", "Claude · opus"))

        getattr(sup, "_stopped_drove", {}).clear()
        self.freeze(until_ts=None, error="401 rejected", cause="auth")
        self.assertFalse(sup._parked_announce(self.slug, self.nid, "auth", "Claude · opus"))

        self.assertEqual(len(self.drives), 1)


class NegativeControlTests(_Base):
    """⚠ The judgement this ticket turns on: only STOPPED-WORK wakes."""

    def test_a_report_that_is_not_frozen_announces_nothing(self):
        """No freeze record at all — nothing to say, nobody woken."""
        self.assertFalse(sup._limit_announce(self.slug, self.nid, "Claude · opus"))
        self.assertEqual(self.drives, [])
        self.assertEqual(self.superior_mail(), [])

    def test_a_non_limit_freeze_does_not_wake_through_the_limit_door(self):
        """A freeze that is not a usage limit must not reach this announcer."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node(self.nid)["frozen"] = {
                "limit": False, "error": "connection reset",
                "until_ts": time.time() + 60, "at": time.time()}
            store.save_org(org)

        self.assertFalse(sup._limit_announce(self.slug, self.nid, "Claude · opus"))
        self.assertEqual(self.drives, [])

    def test_a_balance_refusal_is_not_announced_as_a_wall(self):
        """A 402 is a declined request, not a wall: it is probed quietly and
        announced by `_parked_announce` only once it runs up to its cap."""
        self.freeze(until_ts=time.time() + 3600, cause="balance")

        self.assertFalse(sup._limit_announce(self.slug, self.nid, "Claude · opus"))
        self.assertEqual(self.drives, [])

    def test_a_parked_report_with_a_reset_time_is_not_parked(self):
        """`_parked_announce` asserts 'nothing will wake it'. A freeze that HAS
        a reset time contradicts that, so it must decline rather than say
        something untrue."""
        self.freeze(until_ts=time.time() + 3600, cause="auth")

        self.assertFalse(sup._parked_announce(self.slug, self.nid, "auth", "Claude · opus"))
        self.assertEqual(self.drives, [])


class NoSuperiorTests(_Base):
    """A top-level report has no superior to wake — the user is told instead."""

    def test_a_top_level_report_tells_the_user_and_drives_nothing(self):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node(self.nid)["parent"] = None
            store.save_org(org)
        self.freeze(until_ts=time.time() + 3600)

        told = sup._limit_announce(self.slug, self.nid, "Claude · opus")

        self.assertTrue(told, "the user must still be told")
        self.assertEqual(self.drives, [],
                         "orgtree cannot drive a person, and must not try")
        d = store.load_org(self.slug).d
        # ⚠ IT LANDS ALREADY READ, and that is worth knowing rather than
        # assuming. `to_user_inbox` routes kind="notice" straight past
        # `user_inbox` — which IS the unread set — into `user_mail_log`, on the
        # rule that a notice is passive by construction. So a top-level report
        # freezing produces NO unread badge for the user. Pinned as the CURRENT
        # behaviour, not endorsed as correct: raised with coordinator-opus,
        # because whether the user should see an unread mark here is a product
        # decision and not mine to make.
        self.assertEqual(d.get("user_inbox") or [], [],
                         "current behaviour: a notice is not in the unread set")
        log = d.get("user_mail_log") or []
        self.assertTrue(log, "but it must be in the user's mail log")
        self.assertIn("out of provider capacity", log[-1]["body"])


if __name__ == "__main__":
    unittest.main()
