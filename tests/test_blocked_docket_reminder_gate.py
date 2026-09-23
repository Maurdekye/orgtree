"""Blocked docket items earn a reminder only while the WHOLE organization is
blocked — and only when the option is on.

The user's rule (2026-09-13), as finally settled. The option
`blocked_docket_reminders_enabled` ships DEFAULT OFF because its long-term
implications are not yet known, and it is PURELY ADDITIVE:

  · OFF — exactly today's behaviour. Each eligible agent is reminded about its
    own actionable (nonterminal, non-blocked) items; blocked items are
    excluded per item and earn nothing.
  · ON  — that actionable reminder continues UNCHANGED whenever actionable
    work exists. The single addition is that when the organization's remaining
    nonterminal set is non-empty and ALL of it is blocked, each agent is
    additionally reminded of its OWN blocked items.
  · A mixed organization keeps today's actionable reminders and still excludes
    blocked items. The option is NOT a global suppression gate.
  · Only status `blocked` counts. An item held by an open user question or an
    attention flag is ACTIONABLE for this question.

The tests that carry the most weight here are the ones separating org-wide
from per-agent, and the ones proving the option never withholds an actionable
reminder — a suppression-style implementation passes most single-agent cases.
"""
import os
import tempfile
import unittest
from unittest import mock

_data = tempfile.TemporaryDirectory(prefix="orgtree-blocked-reminder-gate-")
os.environ["ORGTREE_DATA"] = _data.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import appsettings, ledger, store, supervisor  # noqa: E402
assert str(store.DATA_ROOT).lower().startswith(_data.name.lower())


def option(on):
    """Force the machine-wide option for one block. Patched explicitly in both
    directions, so no test is silently measuring the default."""
    return mock.patch.object(
        appsettings, "blocked_docket_reminders_enabled", return_value=on)


class BlockedDocketReminderSelectionTests(unittest.TestCase):
    """The ledger selection used when the option is ON."""

    def setUp(self):
        self.org = ledger.Org.create("blocked-reminder-test")
        for nid in ("worker", "other"):
            self.org.nodes[nid] = {
                "state": "live", "parent": None, "generation": 1,
                "last_status": {"status": "working", "at": "1970-01-01T00:16:40Z"}}

    def ticket(self, title, status, owner="worker"):
        self.org.work_create(owner, title, "test", owner=owner)
        it = self.org._work_active()[-1]
        it["status"] = status
        return it

    def slugs(self, nid="worker"):
        return [r["slug"] for r in self.org.work_docket_reminder_items(nid)]

    # ---- blocked items are admitted only when the organization is all blocked

    def test_all_blocked_is_reminded_about_the_blocked_work(self):
        self.ticket("Alpha task", "blocked")
        self.ticket("Beta task", "blocked")
        rows = self.org.work_docket_reminder_items("worker")
        self.assertEqual([r["slug"] for r in rows], ["alpha-task", "beta-task"])
        self.assertEqual({r["status"] for r in rows}, {"blocked"})
        self.assertTrue(self.org.work_org_all_blocked())

    def test_mixed_keeps_the_actionable_reminder_and_still_excludes_blocked(self):
        """THE CORRECTION. A mixed docket behaves exactly like today: the
        actionable row is reminded about, the blocked row is not, and nothing
        is suppressed."""
        self.ticket("Alpha task", "blocked")
        self.ticket("Beta task", "in_progress")
        self.assertFalse(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs(), ["beta-task"])

    def test_actionable_only_is_unchanged(self):
        self.ticket("Beta task", "in_progress")
        self.assertEqual(self.slugs(), ["beta-task"])

    def test_every_actionable_status_keeps_its_reminder_and_hides_blocked(self):
        self.ticket("Alpha task", "blocked")
        other = self.ticket("Beta task", "open")
        for status in ("open", "in_progress", "review", "deploy_ready"):
            other["status"] = status
            self.assertEqual(self.slugs(), ["beta-task"], status)
        other["status"] = "blocked"
        self.assertEqual(self.slugs(), ["alpha-task", "beta-task"])

    def test_empty_nonterminal_set_sends_nothing(self):
        self.assertEqual(self.slugs(), [])
        self.assertFalse(self.org.work_org_all_blocked(),
                         "an organization with no work is not 'all blocked'")

    # ---- ORG-WIDE: the cases a per-agent condition would get wrong

    def test_another_agents_actionable_ticket_withholds_blocked_rows(self):
        """THE distinguishing test. `worker`'s own docket is entirely blocked,
        so a per-agent condition would list its blocked rows. The user's answer
        is org-wide: while `other` holds actionable work, nobody hears about
        blocked work. `other` still gets its own actionable reminder."""
        self.ticket("Alpha task", "blocked", owner="worker")
        self.ticket("Beta task", "blocked", owner="worker")
        self.assertEqual(self.slugs("worker"), ["alpha-task", "beta-task"])
        self.ticket("Gamma task", "in_progress", owner="other")
        self.assertFalse(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs("worker"), [],
                         "another agent's actionable ticket withholds this "
                         "agent's blocked rows")
        self.assertEqual(self.slugs("other"), ["gamma-task"],
                         "but that agent's own actionable reminder is intact")

    def test_another_agents_blocked_ticket_does_not_withhold(self):
        self.ticket("Alpha task", "blocked", owner="worker")
        self.ticket("Gamma task", "blocked", owner="other")
        self.assertTrue(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs("worker"), ["alpha-task"])
        self.assertEqual(self.slugs("other"), ["gamma-task"],
                         "each recipient hears only its OWN blocked rows")

    def test_an_agent_owing_nothing_hears_nothing(self):
        self.ticket("Alpha task", "blocked", owner="worker")
        self.assertTrue(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs("other"), [])

    # ---- user-held rows are ACTIONABLE unless the status is blocked

    def test_a_user_held_row_counts_as_actionable(self):
        """It is excluded from the actionable list (nagging achieves nothing)
        AND it keeps the organization from reading as all-blocked, so the
        blocked row beside it stays unmentioned."""
        self.ticket("Alpha task", "blocked")
        held = self.ticket("Beta task", "in_progress")
        held["manual_attention"] = {"reason": "waiting on the user"}
        self.assertFalse(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs(), [])

    def test_a_blocked_row_holding_an_attention_flag_is_still_blocked(self):
        it = self.ticket("Alpha task", "blocked")
        it["manual_attention"] = {"reason": "waiting on the user"}
        self.assertTrue(self.org.work_org_all_blocked())
        self.assertEqual(self.slugs(), ["alpha-task"])

    # ---- terminal and backlogged rows are outside the question

    def test_terminal_rows_neither_admit_nor_withhold(self):
        for status in ("done", "dropped", "backlogged"):
            with self.subTest(status=status):
                self.org = ledger.Org.create(f"terminal-{status}")
                self.org.nodes["worker"] = {
                    "state": "live", "parent": None, "generation": 1}
                self.ticket("Closed task", status)
                self.assertEqual(self.slugs(), [],
                                 "a terminal row alone is not a non-empty "
                                 "nonterminal set")
                self.ticket("Alpha task", "blocked")
                self.assertEqual(self.slugs(), ["alpha-task"],
                                 "a terminal row beside blocked work does not "
                                 "count as actionable")

    def test_a_terminal_row_cannot_stand_in_for_the_actionable_one(self):
        self.ticket("Alpha task", "blocked")
        done = self.ticket("Beta task", "in_progress")
        self.assertEqual(self.slugs(), ["beta-task"])
        done["status"] = "done"
        self.assertEqual(self.slugs(), ["alpha-task"],
                         "once the only actionable row closes the organization "
                         "is all blocked and the blocked row is admitted")

    # ---- the reported-working checkup is a different mechanism

    def test_the_working_checkup_is_unchanged(self):
        """`_working_checkup_eligible` asks `work_idle_reminder_items`, and it
        must keep asking that: this rule governs the periodic docket reminder
        only."""
        self.ticket("Alpha task", "blocked")
        self.assertEqual(self.org.work_idle_reminder_items("worker"), [])
        self.assertFalse(supervisor._working_checkup_eligible(self.org, "worker"),
                         "an all-blocked agent still earns no working checkup")
        self.assertEqual(self.slugs(), ["alpha-task"],
                         "but with the option on it does earn the reminder")

    def test_the_checkup_still_fires_for_actionable_work(self):
        self.ticket("Beta task", "in_progress")
        self.assertTrue(supervisor._working_checkup_eligible(self.org, "worker"))


class BlockedDocketReminderSweepTests(unittest.TestCase):
    """END TO END through the real fleet sweep, at both option settings.

    `_idle_docket_reminder_pass` is what actually runs, and it reads the org
    through `store.cached_list` / `store.cached_org` — a different pair from
    the ones the selection tests use. A rule that is right in the ledger and
    never reached by the sweep would look green everywhere else in this file.
    """

    def build(self, *tickets):
        """`tickets` are (title, status) pairs, all owned by `worker`."""
        org = ledger.Org.create("sweep-" + "-".join(s for _, s in tickets))
        org.nodes["worker"] = {
            "state": "live", "parent": None, "generation": 1,
            "last_status": {"status": "working", "at": "1970-01-01T00:16:40Z"}}
        for title, status in tickets:
            org.work_create("worker", title, "test", owner="worker")
            org._work_active()[-1]["status"] = status
        return org

    def sweep(self, org, on):
        wake = mock.Mock(return_value={"accepted": True})
        with option(on), \
             mock.patch.object(store, "cached_list",
                               return_value=[{"slug": org.d["slug"]}]), \
             mock.patch.object(store, "cached_org", return_value=org), \
             mock.patch.object(store, "load_org", return_value=org), \
             mock.patch.object(store, "save_org"), \
             mock.patch.object(supervisor, "state", return_value={}), \
             mock.patch.object(supervisor, "mail_spark"), \
             mock.patch.object(supervisor, "_auto_wake_gates_clear", return_value=True), \
             mock.patch.object(supervisor, "_working_cache_idle", return_value=True):
            supervisor._idle_docket_reminder_pass(
                wake=wake, now=1_800_000_000.0, mode_enabled=True)
        return wake

    # -- option OFF: the shipped default, today's behaviour exactly

    def test_off_still_nudges_actionable_work(self):
        wake = self.sweep(self.build(("Alpha task", "open")), on=False)
        self.assertEqual(wake.call_count, 1)
        self.assertEqual(wake.call_args.args[1], "worker")

    def test_off_never_nudges_blocked_work(self):
        wake = self.sweep(self.build(("Alpha task", "blocked")), on=False)
        self.assertEqual(wake.call_count, 0,
                         "off, the 2026-09-07 rule stands untouched")

    # -- option ON: additive, never subtractive

    def test_on_nudges_blocked_work_when_everything_is_blocked(self):
        wake = self.sweep(self.build(("Alpha task", "blocked")), on=True)
        self.assertEqual(wake.call_count, 1)
        self.assertEqual(wake.call_args.args[1], "worker")

    def test_on_still_nudges_actionable_work(self):
        """The option must never cost an agent a reminder it would have had."""
        wake = self.sweep(self.build(("Alpha task", "open")), on=True)
        self.assertEqual(wake.call_count, 1)

    def test_on_keeps_the_actionable_reminder_in_a_mixed_docket(self):
        wake = self.sweep(
            self.build(("Alpha task", "blocked"), ("Beta task", "in_progress")),
            on=True)
        self.assertEqual(wake.call_count, 1,
                         "mixed is not suppressed — the actionable row still "
                         "earns its ordinary reminder")


class BlockedDocketReminderOptionTests(unittest.TestCase):
    """The option itself: default off, and an explicit choice is preserved."""

    def setUp(self):
        appsettings.store.DATA_ROOT = _data.name
        path = appsettings.path()
        if os.path.exists(path):
            os.remove(path)

    def test_missing_defaults_off(self):
        self.assertFalse(appsettings.blocked_docket_reminders_enabled(),
                         "the user asked for this off until its long-term "
                         "implications are known")

    def test_explicit_saved_preference_wins_both_ways(self):
        appsettings.set_blocked_docket_reminders_enabled(True)
        self.assertTrue(appsettings.blocked_docket_reminders_enabled())
        appsettings.set_blocked_docket_reminders_enabled(False)
        self.assertFalse(appsettings.blocked_docket_reminders_enabled())

    def test_it_does_not_disturb_the_neighbouring_reminder_switch(self):
        appsettings.set_idle_docket_reminders_enabled(True)
        appsettings.set_blocked_docket_reminders_enabled(True)
        self.assertTrue(appsettings.idle_docket_reminders_enabled(),
                        "the two reminder switches are independent")


if __name__ == "__main__":
    unittest.main()
