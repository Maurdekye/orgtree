"""A stale attention flag must be withdrawable — without costing anything else.

THE DEFECT (reported by `contention-probe`, 2026-09-18, as gap #7 in its
suggestion box, found while retracting its OWN finding).

An earlier generation of that agent raised a manual attention flag on
`eighteen-async-handlers-do-locked-document-io-on` reading, in capitals, "YOUR
5-10 SECOND DELAY IS STILL UNEXPLAINED". The team's later measurements made that
false. It went to retract it and found every route closed:

  · `orgtree_work update` is refused outright on a done item.
  · `addendum` — what that refusal suggests instead — did not touch attention at
    all: it reported `touched: [done_so_far, working_on_next]` and
    `effective_attention` stayed true.
  · `attention_amend` is an ARGUMENT to `update`, so it was unreachable for
    exactly the same reason.
  · The only route that cleared the flag was `update` with `reopen=true`
    carrying `done`, which CLEARS THE ITEM'S ENTIRE ACCEPTANCE RECORD — six
    checked conditions with their evidence — to remove one stale sentence.

It judged that trade not worth making and left the flag standing. So the user
kept looking at a sentence the team had already disproved.

WHAT THIS SUITE PINS:

  §1  THE TRAP, reproduced, and the new way out of it. Both closed doors still
      behave exactly as they did — §1 is the reason the fix exists, kept
      executable — and `addendum` now opens a third one.
  §2  THE THING THAT MUST NOT BE TRADED AWAY. Read the item back after the
      retraction: status, acceptance conditions, their checks, `accepted`,
      evidence and BOTH progress lists are byte-for-byte what they were. This is
      the acceptance condition the ticket leads with, and it is asserted by
      comparison against a snapshot rather than by re-reading a docstring.
  §3  THE RETRACTION IS VISIBLE. A history row carrying the sentence that came
      down AND the reason it came down — because a flag that silently vanishes
      leaves the user unable to tell a withdrawal from a bug.
  §4  A CALL THAT WOULD ALTER ANYTHING ELSE IS REFUSED, NOT QUIETLY OBEYED IN
      PART. Raising is refused; the two flag ops are refused together; a
      retraction with no flag standing is refused; and every refusal leaves the
      item completely untouched.
  §5  AMENDING on finished work, and the dismissal guard that still applies
      to it.
  §6  WHAT A USER DISMISSAL MEANS FOR THIS PATH — the judgement call the ticket
      asked to be made deliberately and recorded.
  §7  THE TOOL SURFACE: an agent reaches this through `orgtree_work
      action=addendum`, and a path unreachable from the tool is a path nobody
      uses.
  §8  THE MUTATION CONTROLS. Every equivalence assertion in §2 is itself
      verified by breaking the code on purpose and confirming the test catches
      it — an equivalence test that has never failed may be asserting nothing.
"""
import copy
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='flag-clear-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'flag-clear-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import events, ledger, store                            # noqa: E402,F401
from orgtree import events_render                                    # noqa: E402,F401
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs: list[str] = []

#: The sentence the real flag carried, kept verbatim: this suite exists because
#: of it, and a fixture that reads like the real thing is one a later reader can
#: line up against the ticket.
STALE = 'YOUR 5-10 SECOND DELAY IS STILL UNEXPLAINED'
WHY = ('the team disproved this — the delay was the installer, measured at '
       '2026-09-18; withdrawing the flag rather than leaving it on screen')


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


class RetractBase(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'flagclear-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug
        self.agent = self.hire('worker')
        self.other = self.hire('peer')

    def hire(self, name: str, parent: str | None = None) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER if parent is None else parent, parent,
                      'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    def flagged_done_item(self, reason: str = STALE) -> str:
        """EXACTLY the shape contention-probe was stuck in: a completed item
        carrying a real acceptance record — conditions, a check with its
        evidence — and a manual attention flag that has since gone stale."""
        it = self.org.work_create(
            self.agent, 'Explain the delay', 'problem, then solution',
            acceptance=['the delay is explained', 'the fix is measured'],
            done_so_far=['measured it'],
            working_on_next=['write it up'])
        wid = it['slug']
        self.org.work_evidence(self.agent, wid, 'note', 'probe.log',
                               'the contention run')
        self.org.work_check(self.agent, wid, 0, 'probe.log', 'measured',
                            classification='met', execution='independent',
                            artifact='probe.log', runner='python',
                            result='passed')
        # the flag goes up on the LAST live update, which also completes it —
        # which is precisely how a flag ends up standing on finished work
        self.org.work_update(self.agent, wid, ['measured it'], ['write it up'],
                             status='done', attention=True,
                             attention_reason=reason)
        return wid

    def item(self, wid: str) -> dict:
        it, _ = self.org._work_get_for(self.agent, wid)
        return it

    def view(self, wid: str) -> dict:
        v = self.org.work_get(self.agent, wid)
        return v['item'] if 'item' in v else v

    #: EVERYTHING THE TICKET SAYS MUST SURVIVE A RETRACTION. Named once, used
    #: by every equivalence assertion in the suite and by the mutation controls
    #: in §8, so a field added here is checked everywhere at once.
    PRESERVED = ('status', 'accepted', 'acceptance', 'evidence',
                 'done_so_far', 'working_on_next', 'candidate_verdict',
                 'candidate_verdicts', 'review_packet', 'review_packets',
                 'owner', 'docket_at', 'status_at', 'last_updater',
                 'dropped_reason', 'archived_at', 'dismissals',
                 'manual_attention_rev', 'blocked_reason', 'post_completion')

    def snapshot(self, wid: str, keys=None) -> str:
        it = self.item(wid)
        return json.dumps({k: it.get(k) for k in (keys or self.PRESERVED)},
                          sort_keys=True, default=str)


# ------------------------------------------------------------------ §1
class TheTrap(RetractBase):
    """§1 — the three closed doors, kept executable, plus the one that opens."""

    def test_update_is_still_refused_on_a_done_item(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_update(self.agent, wid, ['measured it'], [],
                                 attention=False)
        self.assertIn('done', str(e.exception))
        self.assertTrue(self.view(wid)['effective_attention'])

    def test_attention_amend_is_unreachable_through_update_for_the_same_reason(self):
        """It is an ARGUMENT to `update`, so the closed-item refusal takes it
        down with everything else — which is why the fix could not simply be
        'tell agents to use attention_amend'."""
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError):
            self.org.work_update(self.agent, wid, ['measured it'], [],
                                 attention_amend=True,
                                 attention_reason='a corrected sentence')
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_reopen_still_clears_the_acceptance_record(self):
        """The horn the agent refused to take. Unchanged on purpose: the ticket
        says do not change what reopen does, only stop it being the only way.

        ⚠ MEASURED, AND NARROWER THAN THE TICKET SAYS. The ticket describes
        reopen as destroying "six checked conditions with their evidence". What
        it actually clears is `accepted` — the completion record — together with
        `candidate_verdict` and `review_packet`; the per-condition `checked`
        marks survive. The loss is real and is still the reason this feature
        exists, but it is the COMPLETION that goes, not the checks, and a test
        asserting the ticket's wording rather than the code's behaviour would
        have been asserting nothing."""
        wid = self.flagged_done_item()
        self.assertIsNotNone(self.item(wid)['accepted'])
        self.org.work_update(self.agent, wid, ['measured it'], [],
                             reopen=True, status='in_progress')
        self.assertIsNone(self.item(wid)['accepted'])
        self.assertIsNone(self.item(wid)['candidate_verdict'])
        row = next(h for h in self.item(wid)['history']
                   if h.get('op') == 'reopen')
        self.assertIsNotNone(row['accepted_was'])
        # and the per-condition checks do NOT go with it — recorded here so the
        # next reader does not repeat the ticket's imprecision
        self.assertIsNotNone(self.item(wid)['acceptance'][0]['checked'])

    def test_the_addendum_route_takes_the_flag_down(self):
        """THE FIX, in one call."""
        wid = self.flagged_done_item()
        self.assertTrue(self.view(wid)['effective_attention'])
        r = self.org.work_addendum(self.agent, wid, WHY, attention=False)
        self.assertIsNone(r['manual_attention'])
        self.assertEqual(r['attention']['op'], 'retract')
        self.assertFalse(self.view(wid)['effective_attention'])
        self.assertIsNone(self.item(wid)['manual_attention'])

    def test_a_retraction_needs_no_list_argument_at_all(self):
        """The old `addendum` refused a call that named no list. A retraction
        corrects no summary, so requiring one would force the caller to restate
        a finished record it had no reason to touch."""
        wid = self.flagged_done_item()
        before = self.item(wid)
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        after = self.item(wid)
        self.assertEqual(after['done_so_far'], before['done_so_far'])
        self.assertEqual(after['working_on_next'], before['working_on_next'])
        self.assertEqual(after['touched'] if 'touched' in after else [], [])


# ------------------------------------------------------------------ §2
class NothingElseIsTraded(RetractBase):
    """§2 — THE acceptance condition. The existing only-route destroys the
    acceptance record, which is why this feature is needed; a fix that trades
    one silent loss for another would be worse than no fix."""

    def test_reading_the_item_back_shows_everything_else_unchanged(self):
        wid = self.flagged_done_item()
        before = self.snapshot(wid)
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        self.assertEqual(self.snapshot(wid), before)

    def test_the_acceptance_record_and_its_checks_survive_in_detail(self):
        """Spelled out field by field as well as by snapshot, because the
        snapshot's value depends on PRESERVED being right and this does not."""
        wid = self.flagged_done_item()
        before = copy.deepcopy(self.item(wid))
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        after = self.item(wid)
        self.assertEqual(after['status'], 'done')
        self.assertEqual(after['accepted'], before['accepted'])
        self.assertEqual(after['acceptance'], before['acceptance'])
        self.assertIsNotNone(after['acceptance'][0]['checked'])
        self.assertEqual(after['acceptance'][0]['check_history'],
                         before['acceptance'][0]['check_history'])
        self.assertEqual(after['evidence'], before['evidence'])
        self.assertEqual(after['done_so_far'], ['measured it'])
        self.assertEqual(after['working_on_next'], ['write it up'])

    def test_the_served_view_agrees_with_the_stored_item(self):
        """The user reads the VIEW, not the row — a fix that only holds at the
        storage layer would still show them the wrong thing."""
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        v = self.view(wid)
        self.assertFalse(v['effective_attention'])
        self.assertEqual(v['attention_sources'], [])
        self.assertIsNone(v['manual_attention'])
        self.assertEqual(v['status'], 'done')
        self.assertIsNotNone(v['accepted'])
        self.assertEqual(v['done_so_far'], ['measured it'])

    def test_no_post_completion_stamp_for_a_flag_only_call(self):
        """That stamp says the SUMMARY was corrected after the outcome. A
        retraction corrects no summary, and a stamp that claimed otherwise
        would be the same class of false record this path exists to avoid."""
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        self.assertIsNone(self.view(wid)['post_completion'])

    def test_the_only_count_that_moves_is_the_attention_count(self):
        """Which is the point. `active`, `archived` and `backlogged` are
        untouched; the one number that changes is the badge the stale flag was
        inflating."""
        wid = self.flagged_done_item()
        before = self.org.work_counts()
        self.assertEqual(before['attention'], 1)
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        after = self.org.work_counts()
        self.assertEqual(after['attention'], 0)
        self.assertEqual({k: v for k, v in after.items() if k != 'attention'},
                         {k: v for k, v in before.items() if k != 'attention'})

    def test_the_stale_flag_was_pinning_the_item_to_the_users_main_list(self):
        """⚠ A CONSEQUENCE THE TICKET DOES NOT MENTION, found by writing this
        suite. `_work_archived` returns False for ANY item holding attention,
        and `work_archive_now` refuses one outright. So a stale flag does not
        merely sit on the user's screen — it keeps the finished item OUT of the
        archive and ON the main list indefinitely, and no amount of waiting
        clears it. Retracting is therefore the only thing that lets the item
        finish finishing, which makes this feature worth more than the one
        sentence it removes."""
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_archive_now(self.agent, wid)
        self.assertIn('still holds attention', str(e.exception))
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        # …and now it can archive, without anything else having changed
        acc = copy.deepcopy(self.item(wid)['accepted'])
        self.org.work_archive_now(self.agent, wid)
        self.assertTrue(any(i['slug'] == wid for i in self.org._work_archive()))
        self.assertEqual(self.item(wid)['status'], 'done')
        self.assertEqual(self.item(wid)['accepted'], acc)

    def test_a_dropped_item_can_have_its_flag_retracted_too(self):
        it = self.org.work_create(self.agent, 'Abandoned', 'problem, solution',
                                  done_so_far=['tried'],
                                  working_on_next=['retry'])
        wid = it['slug']
        self.org.work_update(self.agent, wid, ['tried'], ['retry'],
                             status='dropped', dropped_reason='cancelled',
                             attention=True, attention_reason='look at this')
        before = self.item(wid)['dropped_reason']
        self.org.work_addendum(self.agent, wid, 'no longer relevant',
                               attention=False)
        self.assertEqual(self.item(wid)['status'], 'dropped')
        self.assertEqual(self.item(wid)['dropped_reason'], before)
        self.assertIsNone(self.item(wid)['manual_attention'])

    def test_a_retraction_claims_nothing_and_moves_no_clock(self):
        wid = self.flagged_done_item()
        self.org.work_participants(self.agent, wid, add=[self.other])
        before = self.item(wid)
        clocks = (before['docket_at'], before['status_at'],
                  copy.deepcopy(before['last_updater']),
                  copy.deepcopy(before['owner']))
        self.org.work_addendum(self.other, wid, WHY, attention=False)
        after = self.item(wid)
        self.assertEqual((after['docket_at'], after['status_at'],
                          after['last_updater'], after['owner']), clocks)

    def test_a_combined_call_corrects_the_summary_and_the_flag_together(self):
        """Both at once is allowed, and each still obeys its own rules: the
        lists change, the stamp appears because they did, and the acceptance is
        still untouched."""
        wid = self.flagged_done_item()
        acc = copy.deepcopy(self.item(wid)['accepted'])
        r = self.org.work_addendum(
            self.agent, wid, 'wrote it up, and the flag no longer holds',
            ['measured it', 'wrote it up'], [], attention=False)
        self.assertEqual(r['done_so_far'], ['measured it', 'wrote it up'])
        self.assertEqual(r['working_on_next'], [])
        self.assertIsNone(r['manual_attention'])
        self.assertEqual(r['post_completion']['count'], 1)
        self.assertEqual(self.item(wid)['accepted'], acc)


# ------------------------------------------------------------------ §3
class TheRetractionIsVisible(RetractBase):
    """§3 — a flag that silently vanishes leaves the user unable to tell a
    withdrawal from a bug."""

    def rows(self, wid: str, op: str) -> list[dict]:
        return [h for h in self.item(wid)['history'] if h.get('op') == op]

    def test_history_records_the_retraction_with_its_reason(self):
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        rows = self.rows(wid, 'attention_retract')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['why'], WHY)
        self.assertEqual(rows[0]['by']['node'], self.agent)

    def test_history_also_keeps_the_sentence_that_came_down(self):
        """The reason alone reads as an unexplained edit; the retracted text
        alone reads as a deletion. The pair is what makes it a withdrawal."""
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        row = self.rows(wid, 'attention_retract')[0]
        self.assertEqual(row['reason'], STALE)
        self.assertIsNotNone(row['raised_at'])
        self.assertEqual(row['raised_by']['node'], self.agent)
        self.assertEqual(row['set_rev'],
                         self.item(wid)['manual_attention_rev'])

    def test_the_whole_reason_is_kept_not_a_slice_of_it(self):
        long_reason = 'A' * 1400 + ' — the tail that matters'
        wid = self.flagged_done_item(reason=long_reason)
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        self.assertEqual(self.rows(wid, 'attention_retract')[0]['reason'],
                         long_reason)

    def test_a_reader_can_reconstruct_the_flag_from_get_alone(self):
        """Acceptance condition 2, read the way a later agent would meet it:
        `orgtree_work get` and nothing else — no transcript, no scratch."""
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        hist = self.view(wid)['history']
        row = next(h for h in hist if h.get('op') == 'attention_retract')
        self.assertEqual(row['reason'], STALE)
        self.assertEqual(row['why'], WHY)

    def test_the_call_returns_the_proof_without_a_second_read(self):
        wid = self.flagged_done_item()
        r = self.org.work_addendum(self.agent, wid, WHY, attention=False)
        self.assertEqual(r['attention'],
                         {'op': 'retract', 'set_rev': 1,
                          'reason': STALE, 'why': WHY})
        self.assertIsNone(r['manual_attention'])
        self.assertEqual(r['accepted'], self.item(wid)['accepted'])
        self.assertIn('history', r['note'])


# ------------------------------------------------------------------ §4
class RefusedNotPartlyObeyed(RetractBase):
    """§4 — acceptance condition 3. A call that would alter status, acceptance
    or the stored summaries while clearing attention is REFUSED. Silently
    dropping the extra argument would teach the caller a wrong model of the
    tool; refusing tells them they asked for something impossible."""

    def test_the_path_still_has_no_status_reopen_or_owner_argument(self):
        """The narrow surface W-post-done bought is unchanged: there is still
        no expression here for making a finished item unfinished. `attention`
        is the ONE addition, and it only ever takes a flag down."""
        import inspect
        sig = inspect.signature(self.org.work_addendum)
        for forbidden in ('status', 'reopen', 'owner', 'reviewer', 'accept',
                          'acceptance', 'evidence', 'title', 'objective'):
            self.assertNotIn(forbidden, sig.parameters)

    def test_raising_a_new_flag_is_refused(self):
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        before = self.snapshot(wid)
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'a new thing to look at',
                                   attention=True,
                                   attention_reason='please look')
        self.assertIn('cannot RAISE', str(e.exception))
        self.assertIsNone(self.item(wid)['manual_attention'])
        self.assertEqual(self.snapshot(wid), before)

    def test_retract_and_amend_together_are_refused(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, WHY, attention=False,
                                   attention_amend=True,
                                   attention_reason='x')
        self.assertIn('opposite acts', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_retracting_when_no_flag_stands_is_refused(self):
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        before = self.snapshot(wid)
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'again', attention=False)
        self.assertIn('nothing to retract', str(e.exception))
        self.assertEqual(self.snapshot(wid), before)

    def test_a_retraction_may_not_carry_a_second_reason_field(self):
        """Two reasons on one act is how the durable one ends up blank."""
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, WHY, attention=False,
                                   attention_reason='the real reason')
        self.assertIn('`note`', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_a_retraction_still_needs_its_note(self):
        """The note IS the retraction reason, so the existing requirement is
        load-bearing here rather than incidental."""
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, '   ', attention=False)
        self.assertIn('note', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_an_open_item_is_still_refused(self):
        """A live item already has `update`, which states the complete current
        summary — routing a live retraction through here would let an agent
        take a flag down without restating where the work got to."""
        it = self.org.work_create(self.agent, 'Live', 'problem, solution',
                                  done_so_far=['a'], working_on_next=['b'])
        self.org.work_update(self.agent, it['slug'], ['a'], ['b'],
                             attention=True, attention_reason='look')
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, it['slug'], WHY,
                                   attention=False)
        self.assertIn('not closed', str(e.exception))
        self.assertIsNotNone(self.item(it['slug'])['manual_attention'])

    def test_compare_and_set_refuses_a_stale_retraction_before_writing(self):
        wid = self.flagged_done_item()
        rev = self.item(wid)['rev']
        self.org.work_evidence(self.agent, wid, 'note', 'r2', 'moved it')
        with self.assertRaises(ledger.LedgerError):
            self.org.work_addendum(self.agent, wid, WHY, attention=False,
                                   expected_rev=rev)
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_a_call_that_changes_neither_lists_nor_flag_is_still_refused(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'restating it',
                                   ['measured it'], ['write it up'])
        self.assertIn('neither list', str(e.exception))

    def test_emptying_both_lists_is_still_refused_even_beside_a_retraction(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, WHY, [], [],
                                   attention=False)
        self.assertIn('both lists', str(e.exception))
        self.assertEqual(self.item(wid)['done_so_far'], ['measured it'])
        self.assertIsNotNone(self.item(wid)['manual_attention'])


# ------------------------------------------------------------------ §5
class AmendingFinishedWork(RetractBase):
    """§5 — the other half of the ticket's scope: lower OR amend."""

    def test_the_standing_reason_is_replaced_in_place(self):
        wid = self.flagged_done_item()
        sharper = 'the delay was the installer, not the event loop'
        before = self.snapshot(wid)
        r = self.org.work_addendum(self.agent, wid, 'correcting the wording',
                                   attention_amend=True,
                                   attention_reason=sharper)
        self.assertEqual(r['attention']['op'], 'amend')
        self.assertEqual(self.item(wid)['manual_attention']['reason'], sharper)
        self.assertTrue(self.view(wid)['effective_attention'])
        self.assertEqual(self.snapshot(wid), before)

    def test_an_amendment_keeps_set_rev_so_it_is_not_a_second_nag(self):
        wid = self.flagged_done_item()
        was = self.item(wid)['manual_attention']['set_rev']
        self.org.work_addendum(self.agent, wid, 'sharper', attention_amend=True,
                               attention_reason='a sharper sentence')
        self.assertEqual(self.item(wid)['manual_attention']['set_rev'], was)
        self.assertEqual(self.item(wid)['manual_attention_rev'], was)

    def test_history_keeps_both_wordings(self):
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, 'sharper', attention_amend=True,
                               attention_reason='a sharper sentence')
        row = next(h for h in self.item(wid)['history']
                   if h.get('op') == 'attention_amend')
        self.assertEqual(row['from'], STALE)
        self.assertEqual(row['to'], 'a sharper sentence')
        self.assertEqual(row['why'], 'sharper')

    def test_an_amendment_needs_a_nonblank_reason(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'note',
                                   attention_amend=True, attention_reason='  ')
        self.assertIn('nonblank', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)

    def test_amending_with_no_flag_standing_is_refused(self):
        wid = self.flagged_done_item()
        self.org.work_addendum(self.agent, wid, WHY, attention=False)
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'note',
                                   attention_amend=True,
                                   attention_reason='x')
        self.assertIn('nothing to amend', str(e.exception))

    def test_an_over_length_reason_is_refused_whole_not_truncated(self):
        wid = self.flagged_done_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'note',
                                   attention_amend=True,
                                   attention_reason='B' * 2000)
        self.assertIn('2000', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)


# ------------------------------------------------------------------ §6
class WhatADismissalMeansHere(RetractBase):
    """§6 — THE JUDGEMENT CALL, made deliberately and pinned.

    A dismissal is not a quieter kind of retraction and must not become one. The
    facts, read from `work_dismiss_attention`: the dismissal ITSELF takes the
    flag down, moves the item to `blocked`, and un-archives it if it was
    archived. So after a dismissal there is nothing left for an agent to
    retract, and the item is no longer closed — two independent refusals, both
    correct rather than a gap. What the retraction route must never become is a
    way to erase the record that the user rejected something."""

    def dismissed(self) -> str:
        wid = self.flagged_done_item()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        return wid

    def test_a_dismissal_already_took_the_flag_down_and_blocked_the_item(self):
        wid = self.dismissed()
        it = self.item(wid)
        self.assertIsNone(it['manual_attention'])
        self.assertEqual(it['status'], 'blocked')
        self.assertEqual(len(it['dismissals']), 1)

    def test_so_the_retraction_route_refuses_a_dismissed_flag(self):
        wid = self.dismissed()
        before = self.snapshot(wid)
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'taking it back',
                                   attention=False)
        # the item is blocked, which is not closed — the first of the two
        self.assertIn('not closed', str(e.exception))
        self.assertEqual(self.snapshot(wid), before)

    def test_and_refuses_it_again_once_the_item_is_finished_afterwards(self):
        """Closing the second door explicitly: complete the item so the
        'not closed' refusal cannot be what fires, and confirm the missing
        flag is refused on its own terms with the dismissal called out."""
        wid = self.dismissed()
        self.org.work_update(self.agent, wid, ['measured it'], [],
                             status='done')
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'taking it back',
                                   attention=False)
        msg = str(e.exception)
        self.assertIn('nothing to retract', msg)
        self.assertIn('DISMISSED', msg)
        self.assertEqual(len(self.item(wid)['dismissals']), 1)

    def test_amending_is_not_a_way_around_a_dismissal(self):
        """The dismissed-repeat guard runs on this path exactly as it does on
        `update`: re-raise only with material new information."""
        wid = self.flagged_done_item()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        # a fresh flag, then finish the item, then try to amend it BACK to the
        # exact sentence the user already rejected
        self.org.work_update(self.agent, wid, ['measured it'], ['x'],
                             attention=True, attention_reason='something else')
        self.org.work_update(self.agent, wid, ['measured it'], ['x'],
                             status='done', attention=True,
                             attention_reason='something else')
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'reverting the wording',
                                   attention_amend=True,
                                   attention_reason=STALE)
        self.assertIn('DISMISSED', str(e.exception))
        self.assertEqual(self.item(wid)['manual_attention']['reason'],
                         'something else')

    def test_a_retraction_never_touches_the_dismissal_record(self):
        """An item that was dismissed once, worked on, re-flagged and finished:
        withdrawing the NEW flag must leave the old rejection standing."""
        wid = self.flagged_done_item()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        self.org.work_update(self.agent, wid, ['measured it'], ['x'],
                             status='done', attention=True,
                             attention_reason='a different question')
        dismissals = copy.deepcopy(self.item(wid)['dismissals'])
        blocked_was = self.item(wid)['blocked_reason']
        self.org.work_addendum(self.agent, wid, 'withdrawing the new one',
                               attention=False)
        self.assertEqual(self.item(wid)['dismissals'], dismissals)
        self.assertEqual(self.item(wid)['blocked_reason'], blocked_was)
        self.assertEqual(dismissals[0]['reason'], STALE)


# ------------------------------------------------------------------ §7
class TheToolSurface(RetractBase):
    """§7 — an agent reaches this through `orgtree_work action=addendum`."""

    def call(self, **a) -> dict:
        from orgtree import api
        return api._work_mutate(self.org, self.agent, dict(a))

    def test_the_action_retracts_through_the_tool(self):
        wid = self.flagged_done_item()
        r = self.call(action='addendum', slug=wid, note=WHY, attention=False)
        self.assertEqual(r['item'], wid)
        self.assertEqual(r['status'], 'done')
        self.assertIsNone(r['manual_attention'])
        self.assertEqual(r['attention']['op'], 'retract')
        self.assertEqual(r['accepted'], self.item(wid)['accepted'])

    def test_an_absent_attention_argument_is_not_a_false_one(self):
        """⚠ THE TRISTATE. `attention` absent means 'do not touch the flag';
        `attention: false` means 'take it down'. Folding them together at the
        API layer would make every ordinary addendum silently clear the flag —
        the exact silent loss this ticket exists to prevent."""
        wid = self.flagged_done_item()
        r = self.call(action='addendum', slug=wid, note='just the summary',
                      done_so_far=['measured it', 'wrote it up'],
                      working_on_next=[])
        self.assertIsNone(r['attention'])
        self.assertIsNotNone(r['manual_attention'])
        self.assertEqual(self.item(wid)['manual_attention']['reason'], STALE)
        self.assertTrue(self.view(wid)['effective_attention'])

    def test_amending_reaches_it_through_the_tool(self):
        wid = self.flagged_done_item()
        r = self.call(action='addendum', slug=wid, note='sharper',
                      attention_amend=True,
                      attention_reason='a sharper sentence')
        self.assertEqual(r['attention']['to'], 'a sharper sentence')

    def test_raising_is_refused_through_the_tool_too(self):
        wid = self.flagged_done_item()
        self.call(action='addendum', slug=wid, note=WHY, attention=False)
        with self.assertRaises(ledger.LedgerError) as e:
            self.call(action='addendum', slug=wid, note='new',
                      attention=True, attention_reason='look')
        self.assertIn('cannot RAISE', str(e.exception))

    def test_the_attention_arguments_are_declared_on_this_action(self):
        """The per-action read set is asserted against the dispatch source by
        tests/test_docket_action_args.py — an argument the dispatch reads and
        this list omits would otherwise be refused as unknown."""
        from orgtree import api
        for name in ('attention', 'attention_amend', 'attention_reason'):
            self.assertIn(name, api._WORK_ACTION_ARGS['addendum'])

    def test_the_tool_card_tells_an_agent_this_route_exists(self):
        """A route nobody can find is a route nobody uses — and the agent that
        hit this defect went looking in the tool description first."""
        from orgtree import mcptool
        tool = next(t for t in mcptool.TOOLS
                    if t['name'].endswith('orgtree_work'))
        desc = tool['description']
        self.assertIn('WITHDRAW A STALE ATTENTION FLAG', desc)
        props = tool['inputSchema']['properties']
        self.assertIn('addendum', props['attention']['description'])
        self.assertIn('addendum', props['attention_amend']['description'])


# ------------------------------------------------------------------ §8
class MutationControls(RetractBase):
    """§8 — BREAK THE CODE ON PURPOSE AND CONFIRM THE TESTS CATCH IT.

    An equivalence test that has never failed may be asserting nothing. Each
    control below monkey-patches a deliberate defect into the real call path,
    runs the assertion that is supposed to catch it, and fails if the assertion
    passes anyway. A control that cannot make its own test fail is itself
    evidence the test is empty.

    ⚠ AND EACH CONTROL VERIFIES ITS DEFECT ACTUALLY RAN, by asserting the
    damage is present on the item, before concluding anything from the fact
    that the assertion tripped. A control that silently never fired would
    otherwise 'pass' for the same reason a suite that dies in setUp does."""

    def patched(self, mutate):
        """Run `work_addendum` with `mutate(item)` applied just after it — the
        cheapest faithful stand-in for a clear path that touched one more
        field than it promised to."""
        real = self.org.work_addendum

        def wrapper(*a, **k):
            r = real(*a, **k)
            it, _ = self.org._work_get_for(self.agent, a[1])
            mutate(it)
            return r
        return wrapper

    def test_control_the_acceptance_equivalence_assertion_can_fail(self):
        """MUTANT: the clear path also clears the acceptance record — exactly
        what `reopen=true` does, and exactly the trade this ticket refuses."""
        wid = self.flagged_done_item()
        before = self.snapshot(wid)

        def wipe_acceptance(it):
            it['accepted'] = None
            for c in it['acceptance']:
                c['checked'] = None
        self.patched(wipe_acceptance)(self.agent, wid, WHY, attention=False)
        # the defect really happened…
        self.assertIsNone(self.item(wid)['accepted'])
        # …and §2's assertion is what notices
        self.assertNotEqual(self.snapshot(wid), before)

    def test_control_the_progress_list_assertion_can_fail(self):
        """MUTANT: the clear path also empties `working_on_next`."""
        wid = self.flagged_done_item()
        before = self.snapshot(wid)
        self.patched(lambda it: it.__setitem__('working_on_next', []))(
            self.agent, wid, WHY, attention=False)
        self.assertEqual(self.item(wid)['working_on_next'], [])
        self.assertNotEqual(self.snapshot(wid), before)

    def test_control_the_status_assertion_can_fail(self):
        """MUTANT: the clear path also reopens the item."""
        wid = self.flagged_done_item()
        before = self.snapshot(wid)
        self.patched(lambda it: it.__setitem__('status', 'in_progress'))(
            self.agent, wid, WHY, attention=False)
        self.assertEqual(self.item(wid)['status'], 'in_progress')
        self.assertNotEqual(self.snapshot(wid), before)

    def test_control_the_evidence_assertion_can_fail(self):
        wid = self.flagged_done_item()
        before = self.snapshot(wid)
        self.patched(lambda it: it.__setitem__('evidence', []))(
            self.agent, wid, WHY, attention=False)
        self.assertEqual(self.item(wid)['evidence'], [])
        self.assertNotEqual(self.snapshot(wid), before)

    def test_control_the_dismissal_record_assertion_can_fail(self):
        wid = self.flagged_done_item()
        before = self.snapshot(wid)
        self.patched(lambda it: it.__setitem__('dismissals', [{'x': 1}]))(
            self.agent, wid, WHY, attention=False)
        self.assertEqual(self.item(wid)['dismissals'], [{'x': 1}])
        self.assertNotEqual(self.snapshot(wid), before)

    def test_control_the_history_assertion_can_fail_when_the_row_is_skipped(self):
        """MUTANT: the flag comes down and NO history row is written — the
        silent vanish the ticket names as the failure mode worse than the bug.
        §3 must be what catches it."""
        wid = self.flagged_done_item()

        def drop_the_row(it):
            it['history'] = [h for h in it['history']
                             if h.get('op') != 'attention_retract']
        self.patched(drop_the_row)(self.agent, wid, WHY, attention=False)
        self.assertIsNone(self.item(wid)['manual_attention'])   # flag IS down
        rows = [h for h in self.item(wid)['history']
                if h.get('op') == 'attention_retract']
        self.assertEqual(rows, [])                              # row IS gone
        with self.assertRaises(AssertionError):
            self.assertEqual(len(rows), 1)

    def test_control_the_history_assertion_can_fail_when_the_reason_is_dropped(self):
        """MUTANT: the row is written but carries only a revision number —
        which is exactly the shape every clearing row had before this work."""
        wid = self.flagged_done_item()

        def strip_the_text(it):
            for h in it['history']:
                if h.get('op') == 'attention_retract':
                    h.pop('reason', None)
                    h.pop('why', None)
        self.patched(strip_the_text)(self.agent, wid, WHY, attention=False)
        row = next(h for h in self.item(wid)['history']
                   if h.get('op') == 'attention_retract')
        self.assertIsNotNone(row['set_rev'])
        self.assertNotIn('reason', row)
        self.assertNotIn('why', row)

    def test_control_the_sealed_drift_guard_itself_fires(self):
        """The guard inside `work_addendum` is the belt to the suite's braces.
        Prove IT is live too, by giving the real call a way to alter a sealed
        field from inside — if the guard were dead, this would return
        successfully instead of raising."""
        wid = self.flagged_done_item()
        real_hist = self.org._work_hist

        def sabotage(it, actor, op, detail):
            if op == 'attention_retract':
                it['status'] = 'in_progress'      # a sealed field, from inside
            return real_hist(it, actor, op, detail)
        self.org._work_hist = sabotage
        try:
            with self.assertRaises(ledger.LedgerError) as e:
                self.org.work_addendum(self.agent, wid, WHY, attention=False)
            self.assertIn('INTERNAL', str(e.exception))
            self.assertIn('status', str(e.exception))
        finally:
            self.org._work_hist = real_hist


if __name__ == '__main__':      # pragma: no cover
    unittest.main()
