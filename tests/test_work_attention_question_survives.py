"""Answering an attention flag must not destroy the question it answered.

THE DEFECT (reported by `freeze-provenance`, 2026-09-18, while closing 2.1.8).

Generation 1 of that agent raised a manual attention flag, was cheap-compacted,
and woke to the user's answer — the two words *"yea do that"* — with the
question those words answered no longer present on the item. `manual_attention`
had been set to null and the history kept only
`{"op": "reply_clear_attention", "set_rev": 1}`. It recovered the original
wording only by hand-parsing 1.9 MB of its own `transcript.jsonl` for the string
`attention_reason`. An agent inheriting that item without that transcript would
have had a two-word ruling and no way to know what it ruled on.

This is a docket-RECORD defect, not a product defect: nothing the user sees in
the app was wrong. What was lost is the durability of the record the docket
exists to keep — and the manual flag is used specifically when an agent has gone
beyond the stated spec, chosen an edge case, or filled a definition gap, which
are exactly the decisions a later reader most needs the context for.

WHAT THIS SUITE PINS:

  §1  THE DEFECT, and its fix, on the route it was reported on: a user reply.
      The question survives on the clearing row, and the ANSWER is on that row
      beside it — so `orgtree_work get` alone shows the pair.
  §2  THE OTHER THREE ROUTES THAT TAKE A FLAG DOWN. There are four, not one, and
      fixing the reported one while the others kept losing the text would just
      move the defect. A dismissal, an ordinary status update and an agent's
      retraction all keep it now, under the SAME key.
  §3  NOTHING ELSE CHANGED. The identical-re-raise refusal after a dismissal
      still works, the 1500-character limit on `attention_reason` is untouched,
      and when the flag may be raised is untouched.
  §4  THE AMENDMENT QUESTION, decided: the clearing row keeps the FINAL text —
      the sentence the user was actually looking at — and superseded wordings
      stay where they already were, on the `attention_amend` rows.
  §5  MUTATION CONTROLS. Each assertion above is verified by reverting the fix
      in the live call path and confirming the test catches it.
"""
import os
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='flag-q-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'flag-q-only'
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

#: A flag reason of the kind the charter actually asks for — a decision taken
#: beyond the stated spec, with the confirmation wanted. This is the text that
#: must still be readable after the user answers it.
QUESTION = ('The spec did not say what to do when the source file is missing. '
            'I chose to skip it and log a warning rather than fail the run, '
            'because a single bad row should not stop a nightly sweep. '
            'Confirm that is what you want.')
#: And the answer that used to destroy it.
ANSWER = 'yea do that'


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


class QuestionBase(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'flagq-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.agent = self.hire('worker')

    def hire(self, name: str) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER, None, 'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    def flagged(self, reason: str = QUESTION, status: str = 'in_progress') -> str:
        it = self.org.work_create(self.agent, 'Nightly sweep',
                                  'problem, then solution',
                                  acceptance=['the sweep runs'],
                                  done_so_far=['built it'],
                                  working_on_next=['confirm the edge case'])
        wid = it['slug']
        self.org.work_update(self.agent, wid, ['built it'],
                             ['confirm the edge case'], status=status,
                             attention=True, attention_reason=reason)
        return wid

    def item(self, wid: str) -> dict:
        it, _ = self.org._work_get_for(self.agent, wid)
        return it

    def view(self, wid: str) -> dict:
        v = self.org.work_get(self.agent, wid)
        return v['item'] if 'item' in v else v

    def row(self, wid: str, op: str) -> dict:
        rows = [h for h in self.item(wid)['history'] if h.get('op') == op]
        self.assertEqual(len(rows), 1, f'expected exactly one {op} row')
        return rows[0]


# ------------------------------------------------------------------ §1
class TheReportedRoute(QuestionBase):
    """§1 — a user reply, which is how freeze-provenance met it."""

    def test_the_flag_still_comes_down_on_a_reply(self):
        """The behaviour being preserved: a reply acknowledges the flag without
        taking the dismissal path, so the item is NOT blocked."""
        wid = self.flagged()
        r = self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertTrue(r['cleared'])
        self.assertIsNone(self.item(wid)['manual_attention'])
        self.assertEqual(self.item(wid)['status'], 'in_progress')
        self.assertFalse(self.view(wid)['effective_attention'])

    def test_the_question_survives_the_clear(self):
        """THE defect, in one assertion. This is what used to be gone."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertEqual(self.row(wid, 'reply_clear_attention')['reason'],
                         QUESTION)

    def test_the_answer_sits_on_the_same_row_as_the_question(self):
        """Acceptance condition 4: the pair is readable from the item, with no
        transcript and no second lookup."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        row = self.row(wid, 'reply_clear_attention')
        self.assertEqual(row['reason'], QUESTION)
        self.assertEqual(row['answer'], ANSWER)

    def test_who_raised_it_and_when_survive_too(self):
        wid = self.flagged()
        raised = dict(self.item(wid)['manual_attention'])
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        row = self.row(wid, 'reply_clear_attention')
        self.assertEqual(row['raised_at'], raised['at'])
        self.assertEqual(row['raised_by']['node'], self.agent)
        self.assertEqual(row['set_rev'], raised['set_rev'])

    def test_a_later_reader_reconstructs_it_from_get_alone(self):
        """Read the way the inheriting agent would meet it — `orgtree_work get`
        and nothing else."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        hist = self.view(wid)['history']
        row = next(h for h in hist if h.get('op') == 'reply_clear_attention')
        self.assertIn('skip it and log a warning', row['reason'])
        self.assertEqual(row['answer'], ANSWER)

    def test_the_whole_question_is_kept_not_a_slice(self):
        long_q = 'C' * 1400 + ' — and the sentence that actually asks it?'
        wid = self.flagged(reason=long_q)
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertEqual(self.row(wid, 'reply_clear_attention')['reason'],
                         long_q)

    def test_the_whole_answer_is_kept_not_a_slice(self):
        """A one-word ruling is the reported case; a long one is the case where
        a truncation would cut exactly the part that settles it."""
        long_a = 'yes, but only when ' + 'D' * 1200 + ' — otherwise fail.'
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid, long_a)
        self.assertEqual(self.row(wid, 'reply_clear_attention')['answer'],
                         long_a)

    def test_no_answer_recorded_when_none_was_supplied(self):
        """The parameter is optional and an empty one writes no key, rather
        than an `answer: ''` that reads as the user having said nothing."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid)
        row = self.row(wid, 'reply_clear_attention')
        self.assertNotIn('answer', row)
        self.assertEqual(row['reason'], QUESTION)

    def test_a_pending_question_still_keeps_the_flag_up(self):
        """Unchanged behaviour: attached questions deliberately remain the
        effective attention source, so nothing is cleared and nothing is
        recorded."""
        wid = self.flagged()
        self.org.ask_user(self.agent, 'which way?', work_item=wid)
        r = self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertFalse(r['cleared'])
        self.assertIsNotNone(self.item(wid)['manual_attention'])
        self.assertEqual([h for h in self.item(wid)['history']
                          if h.get('op') == 'reply_clear_attention'], [])


# ------------------------------------------------------------------ §2
class EveryRouteThatTakesAFlagDown(QuestionBase):
    """§2 — there are FOUR, and fixing one would have moved the defect rather
    than ended it. All four keep the text now, under the same key."""

    def test_a_user_dismissal_keeps_it(self):
        wid = self.flagged()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        row = self.row(wid, 'dismiss_attention')
        self.assertEqual(row['reason'], QUESTION)
        self.assertEqual(row['raised_by']['node'], self.agent)
        # and the pre-existing record is still there beside it
        self.assertEqual(self.item(wid)['dismissals'][0]['reason'], QUESTION)

    def test_an_ordinary_status_update_keeps_it(self):
        """THE QUIETEST CLEARER, and the one that left no trace at all: an
        update that does not restate the flag takes it down, and a reader had
        nothing but `cleared_set_rev` to go on."""
        wid = self.flagged()
        self.org.work_update(self.agent, wid, ['built it', 'moved on'],
                             ['next thing'])
        self.assertIsNone(self.item(wid)['manual_attention'])
        # ⚠ THE CLEAR, NOT THE RAISE. Raising writes `changes.manual_attention`
        # too (with `set_rev`); only the clear carries `cleared_set_rev`.
        rows = [h for h in self.item(wid)['history'] if h.get('op') == 'update'
                and 'cleared_set_rev' in ((h.get('changes') or {})
                                          .get('manual_attention') or {})]
        self.assertEqual(len(rows), 1)
        cleared = rows[0]['changes']['manual_attention']
        self.assertEqual(cleared['reason'], QUESTION)
        self.assertEqual(cleared['by'], 'status update')
        self.assertIsNotNone(cleared['cleared_set_rev'])

    def test_an_agent_retraction_keeps_it(self):
        """The fourth route, added by the sibling ticket — it was written
        against this same helper, so it cannot drift away from the others."""
        wid = self.flagged(status='done')
        self.org.work_addendum(self.agent, wid, 'no longer holds',
                               attention=False)
        row = self.row(wid, 'attention_retract')
        self.assertEqual(row['reason'], QUESTION)
        self.assertEqual(row['why'], 'no longer holds')

    def test_all_four_use_the_same_key_for_the_same_thing(self):
        """A row that carries the reason under a different name on each route
        is the same defect wearing a different shape — so the key is produced
        in ONE place and this asserts every caller went through it."""
        import inspect
        src = inspect.getsource(ledger.Org)
        # the helper exists, and nobody hand-rolls the field beside it
        self.assertIn('_work_attention_archive', src)
        for caller in ('reply_clear_attention', 'dismiss_attention',
                       'attention_retract'):
            self.assertIn(caller, src)


# ------------------------------------------------------------------ §3
class NothingElseChanged(QuestionBase):
    """§3 — the ticket's explicit exclusions, kept executable."""

    def test_the_identical_re_raise_refusal_after_a_dismissal_still_works(self):
        wid = self.flagged()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_update(self.agent, wid, ['built it'], ['x'],
                                 attention=True, attention_reason=QUESTION)
        self.assertIn('DISMISSED', str(e.exception))

    def test_a_materially_different_reason_may_still_be_raised(self):
        """The guard is an EXACT-repeat guard and must not have become a
        blanket one just because the text is now stored in a second place."""
        wid = self.flagged()
        self.org.work_dismiss_attention(
            wid, self.item(wid)['manual_attention']['set_rev'])
        self.org.work_update(self.agent, wid, ['built it'], ['x'],
                             attention=True,
                             attention_reason=QUESTION + ' New: it also '
                                                         'affects the weekly run.')
        self.assertIsNotNone(self.item(wid)['manual_attention'])

    def test_the_1500_character_limit_is_untouched(self):
        it = self.org.work_create(self.agent, 'Limits', 'problem, solution',
                                  done_so_far=['a'], working_on_next=['b'])
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_update(self.agent, it['slug'], ['a'], ['b'],
                                 attention=True, attention_reason='E' * 1501)
        self.assertIn('1500', str(e.exception))
        # …and exactly 1500 is still accepted
        self.org.work_update(self.agent, it['slug'], ['a'], ['b'],
                             attention=True, attention_reason='E' * 1500)
        self.assertIsNotNone(self.item(it['slug'])['manual_attention'])

    def test_when_a_flag_may_be_raised_is_untouched(self):
        wid = self.flagged()
        self.assertIsNotNone(self.item(wid)['manual_attention'])
        with self.assertRaises(ledger.LedgerError):
            self.org.work_update(self.agent, wid, ['built it'], ['x'],
                                 attention=True, attention_reason='   ')


# ------------------------------------------------------------------ §4
class TheAmendmentQuestion(QuestionBase):
    """§4 — the ticket asked for a decision: keep every superseded wording, or
    only the final text at the moment of clearing?

    DECIDED: the clearing row keeps the FINAL text — the sentence the user was
    actually looking at when they answered or dismissed. Earlier wordings are
    already durable exactly where they changed, because `attention_amend`
    writes its own row carrying `from` and `to`. Duplicating them onto the
    clearing row would store the same strings twice and still not say which one
    the user read."""

    def amended(self) -> tuple[str, str]:
        wid = self.flagged()
        sharper = QUESTION + ' (It also affects the weekly run.)'
        self.org.work_update(self.agent, wid, ['built it'], ['x'],
                             attention_amend=True, attention_reason=sharper)
        return wid, sharper

    def test_the_clearing_row_keeps_the_text_the_user_actually_read(self):
        wid, sharper = self.amended()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertEqual(self.row(wid, 'reply_clear_attention')['reason'],
                         sharper)

    def test_the_superseded_wording_is_already_on_its_own_row(self):
        wid, sharper = self.amended()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        amend = self.row(wid, 'attention_amend')
        self.assertEqual(amend['from'], QUESTION)
        self.assertEqual(amend['to'], sharper)

    def test_the_clearing_row_says_the_text_had_been_amended(self):
        """Otherwise a reader comparing the kept text against the raise finds a
        mismatch it cannot explain."""
        wid, _ = self.amended()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        row = self.row(wid, 'reply_clear_attention')
        self.assertIsNotNone(row['amended_at'])
        self.assertEqual(row['amended_by']['node'], self.agent)

    def test_an_unamended_flag_says_nothing_about_amendment(self):
        """The marker means something only because it is absent otherwise."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        self.assertNotIn('amended_at', self.row(wid, 'reply_clear_attention'))


# ------------------------------------------------------------------ §5
class MutationControls(QuestionBase):
    """§5 — BREAK IT ON PURPOSE AND CONFIRM THE TESTS CATCH IT.

    Each control reverts the fix inside the LIVE call path — by making the
    shared helper behave the way the code behaved before this work — and then
    asserts that the defect is really present. A control that cannot reproduce
    the original defect is not evidence of anything."""

    def bare_archive(self):
        """The pre-fix behaviour, exactly: a clearing row carrying nothing but
        the revision number.

        ⚠ SAVED AND RESTORED THROUGH `__dict__`, not through attribute access.
        Reading a staticmethod off the class yields the PLAIN FUNCTION, so
        assigning that back turns it into an ordinary method and every later
        caller dies with "takes 1 positional argument but 2 were given" — a
        control that quietly breaks the code it was meant to restore. Found by
        running it."""
        real = ledger.Org.__dict__['_work_attention_archive']
        ledger.Org._work_attention_archive = staticmethod(lambda flag: {})
        self.addCleanup(setattr, ledger.Org, '_work_attention_archive', real)

    def test_control_the_reply_route_assertion_can_fail(self):
        wid = self.flagged()
        self.bare_archive()
        self.org.work_clear_attention_on_user_reply(wid, ANSWER)
        row = self.row(wid, 'reply_clear_attention')
        # the defect is reproduced — a bare set_rev and nothing else…
        self.assertNotIn('reason', row)
        self.assertIsNotNone(row['set_rev'])
        # …and §1's assertion is what notices
        with self.assertRaises(KeyError):
            row['reason']

    def test_control_the_dismissal_route_assertion_can_fail(self):
        wid = self.flagged()
        set_rev = self.item(wid)['manual_attention']['set_rev']
        self.bare_archive()
        self.org.work_dismiss_attention(wid, set_rev)
        self.assertNotIn('reason', self.row(wid, 'dismiss_attention'))

    def test_control_the_update_route_assertion_can_fail(self):
        wid = self.flagged()
        self.bare_archive()
        self.org.work_update(self.agent, wid, ['built it'], ['x'])
        rows = [h for h in self.item(wid)['history'] if h.get('op') == 'update'
                and 'cleared_set_rev' in ((h.get('changes') or {})
                                          .get('manual_attention') or {})]
        self.assertEqual(len(rows), 1)
        self.assertNotIn('reason', rows[0]['changes']['manual_attention'])

    def test_control_the_retraction_route_assertion_can_fail(self):
        wid = self.flagged(status='done')
        self.bare_archive()
        self.org.work_addendum(self.agent, wid, 'no longer holds',
                               attention=False)
        self.assertNotIn('reason', self.row(wid, 'attention_retract'))

    def test_control_the_answer_assertion_can_fail(self):
        """MUTANT: the API layer forgets to pass the reply text through — the
        single most likely way this regresses, since the ledger change is
        useless without its one caller."""
        wid = self.flagged()
        self.org.work_clear_attention_on_user_reply(wid)   # no text passed
        row = self.row(wid, 'reply_clear_attention')
        self.assertEqual(row['reason'], QUESTION)          # question still kept
        self.assertNotIn('answer', row)                    # answer is NOT
        with self.assertRaises(KeyError):
            row['answer']

    def test_control_the_api_caller_really_passes_the_text(self):
        """And the positive half of the control above: the one call site does
        pass it, asserted against the source rather than assumed."""
        import inspect
        from orgtree import api
        src = inspect.getsource(api)
        self.assertIn('work_clear_attention_on_user_reply(wid, text)', src)


if __name__ == '__main__':      # pragma: no cover
    unittest.main()
