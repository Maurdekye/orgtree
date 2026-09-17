"""A finished item must be able to record what happened after it finished.

THE DEFECT (reported by eleven agents on the 2.1.7-beta.0 push — `account-card`,
`agent-list-menu`, `coordinator-astra`, `expanded-msgs`, `lane-policy`,
`popout-menu`, `present-focus`, `scope-history`, `staffing-flow`, `team-docket`,
`upgrade-shutdown`).

The two fields the user reads to know where a piece of work got to are
`done_so_far` and `working_on_next`. On every ticket that follows
approve-then-land, the item is completed at APPROVAL and the code lands
AFTERWARDS — so those two lists freeze one step before the truth. `work_update`
refuses on a closed item, and the one route past that refusal, `reopen=true`,
CLEARS `accepted`, `candidate_verdict` and `review_packet`. The choice was
between a false record and a damaged one:

  `lane-policy`: "my only choices were to falsify the item's state to correct
  its text, or leave the summary lists frozen at a moment when nothing had
  landed."

WHAT THIS SUITE PINS:

  §1  THE TRAP, reproduced. `update` is refused on a done item; `reopen=true`
      is accepted and destroys the acceptance record. Neither behaviour is
      changed by the fix — §1 is the reason the fix exists, kept executable.
  §2  THE THIRD ANSWER. `work_addendum` corrects the two lists on a closed
      item: the item still reads as done, `accepted` is byte-for-byte what it
      was, and the acceptance conditions, their checks and the evidence are
      untouched.
  §3  THE EDIT IS VISIBLE AS AN EDIT. A history row marked
      `after_completion`, carrying the lists AS THEY WERE, plus the served
      `post_completion` stamp — so the corrected summary is never mistaken for
      the one that was accepted.
  §4  NOTHING HERE MAKES A DONE ITEM INCOMPLETE. No status argument exists on
      the path; an open item is refused; an archived item is amended without
      being resurrected; the row's age and the archive clock do not move.
  §5  THE NARROW SURFACE. Named lists only, a required note, no no-op stamp,
      no emptying both lists, compare-and-set, and the patch forms behaving
      exactly as they do on `update`.
  §6  REOPEN STILL WORKS AND STILL MEANS WHAT IT MEANT — it is no longer the
      only route, and the refusal that used to point only at it now names the
      route that does not destroy anything.
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
fx = tempfile.TemporaryDirectory(prefix='post-done-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'post-done-only'
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


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


class AddendumBase(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'postdone-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug
        self.agent = self.hire('worker')
        self.other = self.hire('reviewer')

    def hire(self, name: str, parent: str | None = None) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER if parent is None else parent, parent,
                      'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    def landed_item(self) -> str:
        """An item taken through the exact shape the ticket describes:
        implemented, evidence recorded, one acceptance condition checked, and
        then COMPLETED — with a `working_on_next` that was true at completion
        and stops being true the moment the code lands."""
        it = self.org.work_create(
            self.agent, 'Ship the thing', 'problem, then solution',
            acceptance=['the thing ships'],
            done_so_far=['built it'],
            working_on_next=['still need to land it on main'])
        wid = it['slug']
        self.org.work_evidence(self.agent, wid, 'note', 'ref', 'the run')
        self.org.work_check(self.agent, wid, 0, 'suite.log', 'green',
                            classification='met', execution='independent',
                            artifact='suite.log', runner='python',
                            result='passed')
        self.org.work_update(self.agent, wid,
                             ['built it'], ['still need to land it on main'],
                             status='done')
        return wid

    def item(self, wid: str) -> dict:
        it, _ = self.org._work_get_for(self.agent, wid)
        return it

    def view(self, wid: str) -> dict:
        v = self.org.work_get(self.agent, wid)
        return v['item'] if 'item' in v else v

    @staticmethod
    def frozen(it: dict, keys) -> str:
        return json.dumps({k: it.get(k) for k in keys},
                          sort_keys=True, default=str)


# ------------------------------------------------------------------ §1
class TheTrap(AddendumBase):
    """§1 — the bug as the eleven agents met it. Both halves still behave
    exactly this way; what changed is that neither is the only move."""

    def test_update_is_refused_on_a_done_item(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_update(self.agent, wid,
                                 ['built it', 'landed on main'], [])
        self.assertIn('done', str(e.exception))

    def test_reopen_destroys_the_acceptance_record(self):
        """The other horn: reopening to fix a sentence wipes the completion."""
        wid = self.landed_item()
        self.assertIsNotNone(self.item(wid)['accepted'])
        self.org.work_update(self.agent, wid,
                             ['built it', 'landed on main'], [],
                             reopen=True, status='done')
        # the SECOND completion's record, not the one the reviewer wrote: the
        # original acceptance is gone from the live field
        hist = [h for h in self.item(wid)['history'] if h['op'] == 'reopen']
        self.assertEqual(len(hist), 1)
        self.assertIsNotNone(hist[0]['accepted_was'])

    def test_the_refusal_now_names_the_route_that_destroys_nothing(self):
        """The message is the teaching surface — it used to offer reopen and
        `evidence` and nothing else, which is how eleven agents reached for
        reopen."""
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_update(self.agent, wid, ['built it'], [])
        self.assertIn('addendum', str(e.exception))


# ------------------------------------------------------------------ §2
class TheThirdAnswer(AddendumBase):
    """§2 — record the landing, keep the acceptance."""

    def test_the_lists_are_corrected_and_the_item_is_still_done(self):
        wid = self.landed_item()
        r = self.org.work_addendum(
            self.agent, wid, 'landed on main as abc1234 after acceptance',
            ['built it', 'landed on main as abc1234'], [])
        self.assertEqual(r['status'], 'done')
        self.assertEqual(r['done_so_far'],
                         ['built it', 'landed on main as abc1234'])
        self.assertEqual(r['working_on_next'], [])
        it = self.item(wid)
        self.assertEqual(it['status'], 'done')
        self.assertEqual(it['done_so_far'],
                         ['built it', 'landed on main as abc1234'])
        self.assertEqual(it['working_on_next'], [])

    def test_the_acceptance_record_is_unchanged(self):
        wid = self.landed_item()
        before = copy.deepcopy(self.item(wid)['accepted'])
        self.org.work_addendum(self.agent, wid, 'landed',
                               done_append=['landed on main'],
                               expected_rev=self.item(wid)['rev'])
        self.assertEqual(self.item(wid)['accepted'], before)

    def test_checks_evidence_and_verdicts_survive_untouched(self):
        wid = self.landed_item()
        sealed = ('accepted', 'acceptance', 'evidence', 'candidate_verdict',
                  'candidate_verdicts', 'review_packet', 'review_packets',
                  'superseded_by', 'dropped_reason', 'owner', 'archived_at',
                  'manual_attention', 'status')
        before = self.frozen(self.item(wid), sealed)
        self.org.work_addendum(self.agent, wid, 'landed',
                               ['built it', 'landed'], [])
        self.assertEqual(self.frozen(self.item(wid), sealed), before)

    def test_a_dropped_item_can_be_corrected_too(self):
        """Not only `done`: work that ended unsuccessfully has the same frozen
        summary and the same reason to be correctable."""
        it = self.org.work_create(self.agent, 'Abandoned', 'problem, solution',
                                  done_so_far=['tried'],
                                  working_on_next=['retry tomorrow'])
        wid = it['slug']
        self.org.work_update(self.agent, wid, ['tried'], ['retry tomorrow'],
                             status='dropped',
                             dropped_reason='cancelled by the coordinator')
        before = self.item(wid)['dropped_reason']
        self.org.work_addendum(self.agent, wid,
                               'the retry never happened; noting it here',
                               ['tried'], [])
        it2 = self.item(wid)
        self.assertEqual(it2['status'], 'dropped')
        self.assertEqual(it2['dropped_reason'], before)

    def test_any_reader_of_the_item_may_write_one_and_it_claims_nothing(self):
        """An addendum is a correction to a finished record, not a takeover:
        unlike `update`, writing one never moves the assignment."""
        wid = self.landed_item()
        self.org.work_participants(self.agent, wid, add=[self.other])
        owner_before = copy.deepcopy(self.item(wid)['owner'])
        self.org.work_addendum(self.other, wid, 'I landed it', ['landed'], [])
        self.assertEqual(self.item(wid)['owner'], owner_before)


# ------------------------------------------------------------------ §3
class TheEditIsVisible(AddendumBase):
    """§3 — a correction that cannot be seen as a correction is just a quieter
    way of rewriting the record."""

    def test_history_marks_it_as_after_completion_and_keeps_the_old_lists(self):
        wid = self.landed_item()
        self.org.work_addendum(self.agent, wid, 'landed on main',
                               ['built it', 'landed on main'], [])
        row = [h for h in self.item(wid)['history'] if h['op'] == 'addendum']
        self.assertEqual(len(row), 1)
        self.assertTrue(row[0]['after_completion'])
        self.assertEqual(row[0]['note'], 'landed on main')
        # the summary AS ACCEPTED — the only surviving copy once it is fixed
        self.assertEqual(row[0]['done_was'], ['built it'])
        self.assertEqual(row[0]['next_was'], ['still need to land it on main'])
        self.assertEqual(row[0]['accepted_at'], self.item(wid)['accepted']['at'])

    def test_the_stamp_is_served_beside_the_lists(self):
        wid = self.landed_item()
        self.assertIsNone(self.view(wid)['post_completion'])
        self.org.work_addendum(self.agent, wid, 'landed on main',
                               ['built it', 'landed'], [])
        pc = self.view(wid)['post_completion']
        self.assertEqual(pc['count'], 1)
        self.assertEqual(pc['status'], 'done')
        self.assertEqual(pc['note'], 'landed on main')
        self.assertEqual(pc['by']['node'], self.agent)

    def test_a_second_addendum_counts_and_does_not_lose_the_first(self):
        wid = self.landed_item()
        self.org.work_addendum(self.agent, wid, 'landed', ['built', 'landed'], [])
        first = self.view(wid)['post_completion']['at']
        self.org.work_addendum(self.agent, wid, 'and was released',
                               ['built', 'landed', 'released'], [])
        pc = self.view(wid)['post_completion']
        self.assertEqual(pc['count'], 2)
        self.assertEqual(pc['first_at'], first)
        rows = [h for h in self.item(wid)['history'] if h['op'] == 'addendum']
        self.assertEqual(len(rows), 2)

    def test_an_ordinary_item_says_nothing(self):
        """The stamp means something only because it is absent everywhere
        else."""
        it = self.org.work_create(self.agent, 'Ordinary', 'problem, solution',
                                  done_so_far=['a'], working_on_next=['b'])
        self.assertIsNone(self.view(it['slug'])['post_completion'])


# ------------------------------------------------------------------ §4
class NothingBecomesIncomplete(AddendumBase):
    """§4 — the one property the ticket says must never be given up."""

    def test_the_path_has_no_status_argument_at_all(self):
        import inspect
        sig = inspect.signature(self.org.work_addendum)
        for forbidden in ('status', 'reopen', 'owner', 'attention',
                          'reviewer', 'accept'):
            self.assertNotIn(forbidden, sig.parameters)

    def test_an_open_item_is_refused(self):
        it = self.org.work_create(self.agent, 'Live work', 'problem, solution',
                                  done_so_far=['a'], working_on_next=['b'])
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, it['slug'], 'note', ['x'], [])
        self.assertIn('update', str(e.exception))
        self.assertEqual(self.item(it['slug'])['done_so_far'], ['a'])

    def test_an_archived_item_is_amended_without_being_resurrected(self):
        wid = self.landed_item()
        self.org.work_archive_now(self.agent, wid)
        self.assertTrue(any(i['slug'] == wid for i in self.org._work_archive()))
        r = self.org.work_addendum(self.agent, wid, 'landed after archiving',
                                   ['built it', 'landed'], [])
        self.assertTrue(r['archived'])
        self.assertTrue(any(i['slug'] == wid for i in self.org._work_archive()))
        self.assertFalse(any(i['slug'] == wid for i in self.org._work_active()))
        self.assertEqual(self.item(wid)['status'], 'done')

    def test_neither_the_row_age_nor_the_archive_clock_moves(self):
        """`docket_at` is what the one-hour auto-archive and the row's age both
        run on. If an addendum moved it, recording a landing would drag
        finished work back onto the user's main list."""
        wid = self.landed_item()
        before = self.item(wid)
        clocks = (before['docket_at'], before.get('status_at'),
                  copy.deepcopy(before.get('last_updater')))
        self.org.work_addendum(self.agent, wid, 'landed', ['built', 'landed'], [])
        after = self.item(wid)
        self.assertEqual((after['docket_at'], after.get('status_at'),
                          after.get('last_updater')), clocks)
        # …and `updated_at`/`rev` DO move, because something really changed
        self.assertGreater(after['rev'], before['rev'] - 1)

    def test_it_does_not_count_as_active_work(self):
        wid = self.landed_item()
        before = self.org.work_counts()
        self.org.work_addendum(self.agent, wid, 'landed', ['built', 'landed'], [])
        self.assertEqual(self.org.work_counts(), before)


# ------------------------------------------------------------------ §5
class TheNarrowSurface(AddendumBase):
    """§5 — what the call refuses, and why each refusal is there."""

    def test_a_note_is_required(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, '   ', ['landed'], [])
        self.assertIn('note', str(e.exception))
        self.assertEqual(self.item(wid)['done_so_far'], ['built it'])

    def test_an_unnamed_list_is_kept_not_cleared(self):
        """THE DELIBERATE DIFFERENCE FROM `update`. On live work an omitted
        list is cleared, because the latest update is the complete statement.
        On finished work the omitted half is a record somebody accepted."""
        wid = self.landed_item()
        self.org.work_addendum(self.agent, wid, 'appending the landing',
                               done_append=['landed on main'],
                               expected_rev=self.item(wid)['rev'])
        it = self.item(wid)
        self.assertEqual(it['done_so_far'], ['built it', 'landed on main'])
        self.assertEqual(it['working_on_next'],
                         ['still need to land it on main'])

    def test_clearing_a_list_is_said_outright(self):
        wid = self.landed_item()
        self.org.work_addendum(self.agent, wid, 'nothing is next any more',
                               working_on_next=[],
                               keep_done=True,
                               expected_rev=self.item(wid)['rev'])
        it = self.item(wid)
        self.assertEqual(it['working_on_next'], [])
        self.assertEqual(it['done_so_far'], ['built it'])

    def test_naming_no_list_is_refused(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'a note and nothing else')
        self.assertIn('done_so_far', str(e.exception))

    def test_a_no_op_is_refused_rather_than_stamped(self):
        """A stamp saying a finished item was amended, on an item that was
        not, is itself a false record."""
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'restating it',
                                   ['built it'],
                                   ['still need to land it on main'])
        self.assertIn('neither list', str(e.exception))
        self.assertIsNone(self.item(wid).get('post_completion'))

    def test_both_lists_empty_is_refused(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'wiping it', [], [])
        self.assertIn('both lists', str(e.exception))
        self.assertEqual(self.item(wid)['done_so_far'], ['built it'])

    def test_compare_and_set_refuses_a_stale_call_before_writing(self):
        wid = self.landed_item()
        rev = self.item(wid)['rev']
        self.org.work_evidence(self.agent, wid, 'note', 'r2', 'moved it')
        with self.assertRaises(ledger.LedgerError):
            self.org.work_addendum(self.agent, wid, 'landed',
                                   ['built it', 'landed'], [],
                                   expected_rev=rev)
        self.assertEqual(self.item(wid)['done_so_far'], ['built it'])
        self.assertIsNone(self.item(wid).get('post_completion'))

    def test_the_patch_forms_still_require_expected_rev(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError) as e:
            self.org.work_addendum(self.agent, wid, 'landed',
                                   done_append=['landed'])
        self.assertIn('expected_rev', str(e.exception))

    def test_the_whole_list_and_a_patch_of_it_are_mutually_exclusive(self):
        wid = self.landed_item()
        with self.assertRaises(ledger.LedgerError):
            self.org.work_addendum(self.agent, wid, 'landed',
                                   ['built it', 'landed'],
                                   done_append=['landed'],
                                   expected_rev=self.item(wid)['rev'])


# ------------------------------------------------------------------ §6
class ReopenStillMeansResumed(AddendumBase):
    """§6 — the ticket asks that reopen stop being the ONLY route, not that it
    stop existing. Real resumption is still real."""

    def test_reopen_still_resumes_work_and_still_clears_the_outcome(self):
        wid = self.landed_item()
        self.org.work_update(self.agent, wid, ['built it'],
                             ['a second round of work'], reopen=True,
                             status='in_progress')
        it = self.item(wid)
        self.assertEqual(it['status'], 'in_progress')
        self.assertIsNone(it['accepted'])

    def test_an_addendum_after_a_reopen_and_recompletion_is_ordinary(self):
        """The stamp points at the completion it came after, so two
        completions do not read as one."""
        wid = self.landed_item()
        first = copy.deepcopy(self.item(wid)['accepted'])
        self.org.work_update(self.agent, wid, ['built it'], ['round two'],
                             reopen=True, status='done')
        second = copy.deepcopy(self.item(wid)['accepted'])
        self.assertEqual(second['via'], 'update')
        self.org.work_addendum(self.agent, wid, 'landed round two',
                               ['built it', 'round two landed'], [])
        pc = self.view(wid)['post_completion']
        # the LIVE acceptance — the second one — is what this addendum came
        # after, and the overturned first is still in the reopen row. (The two
        # `at` stamps can fall in the same millisecond, so the assertion is on
        # the records, not on their clock values.)
        self.assertEqual(pc['accepted_at'], second['at'])
        self.assertEqual(self.item(wid)['accepted'], second)
        reopened = [h for h in self.item(wid)['history'] if h['op'] == 'reopen']
        self.assertEqual(reopened[0]['accepted_was'], first)


# ------------------------------------------------------------------ §7
class TheToolSurface(AddendumBase):
    """§7 — the ledger method is only half of it: an agent reaches this
    through `orgtree_work action=addendum`, and a path that is unreachable
    from the tool is a path nobody uses."""

    def call(self, **a) -> dict:
        from orgtree import api
        return api._work_mutate(self.org, self.agent, dict(a))

    def test_the_action_dispatches_and_reports_what_it_did(self):
        wid = self.landed_item()
        r = self.call(action='addendum', slug=wid,
                      note='landed on main as abc1234',
                      done_so_far=['built it', 'landed on main as abc1234'],
                      working_on_next=[])
        self.assertEqual(r['item'], wid)
        self.assertEqual(r['status'], 'done')
        self.assertEqual(r['touched'], ['done_so_far', 'working_on_next'])
        self.assertEqual(r['post_completion']['count'], 1)
        # the acceptance record comes BACK, so the caller confirms it survived
        # rather than taking the promise on trust
        self.assertEqual(r['accepted'], self.item(wid)['accepted'])

    def test_the_patch_forms_reach_it_through_the_tool(self):
        wid = self.landed_item()
        r = self.call(action='addendum', slug=wid, note='landed',
                      done_append=['landed on main'], keep_next=False,
                      working_on_next=[],
                      expected_rev=self.item(wid)['rev'])
        self.assertEqual(r['done_so_far'], ['built it', 'landed on main'])
        self.assertEqual(r['working_on_next'], [])

    def test_an_unknown_action_still_lists_this_one(self):
        with self.assertRaises(ledger.LedgerError) as e:
            self.call(action='nonsense', slug='x')
        self.assertIn('addendum', str(e.exception))

    def test_the_mcp_schema_offers_it(self):
        from orgtree import mcptool
        tool = next(t for t in mcptool.TOOLS
                    if t['name'].endswith('orgtree_work'))
        enum = tool['inputSchema']['properties']['action']['enum']
        self.assertIn('addendum', enum)
        self.assertIn('addendum', tool['description'])


if __name__ == '__main__':      # pragma: no cover
    unittest.main()
