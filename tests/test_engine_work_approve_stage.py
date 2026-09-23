"""Regression coverage for `approve_stage`, the THIRD review outcome.

The defect this closes: `work_review_decide(decision="approve")` completed the
item outright, but review always happens BEFORE the rebase, the fast-forward
and the push — so the docket read `done` for code `git` said was not in the
product.  About twenty-five agents reported that window last release; one
counted it four times on a single item.

`approve_stage` approves ONE EXACT COMMIT without completing the item: the item
goes to the `approved` status, keeps its owner, records the sha, and is
completed only after the landing is recorded.  These tests pin the new path,
pin that the existing two are untouched, and pin the no-self-approval rule that
keeps `approved` meaning "a reviewer checked this".
"""
import os
from pathlib import Path
import tempfile
import unittest

# ORGTREE_DATA must be set, in system Temp, OUTSIDE both live roots, BEFORE
# anything that imports `store` — `store.DATA_ROOT` binds at import time.
# `load_app()` also puts THIS WORKTREE's engine/backend on sys.path ahead of
# any installed copy, so `from orgtree import ...` resolves to the source under
# test rather than a live installation.
_root = tempfile.TemporaryDirectory(prefix='v2-approve-stage-')
data = Path(_root.name) / 'data'; data.mkdir()
home = Path(_root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='test-token')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402  (import after env is set)
load_app()
from orgtree import ledger, mcptool  # noqa: E402  (import after env is set)
from orgtree.ledger import LedgerError, USER  # noqa: E402

# ⚠ THE ISOLATION ASSERTION THE TICKET ASKS FOR, made before any test runs.
# A suite that silently bound a live data root would mutate real docket items,
# and the failure would look like a passing test.
from orgtree import store  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == data.resolve(), (
    f"test data root did not take effect: store.DATA_ROOT is "
    f"{store.DATA_ROOT!r}, expected {str(data)!r}")

SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
SHA2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f098765432'


def tearDownModule():
    _root.cleanup()


def fixture(name: str):
    """One item, one owner, one separate reviewer — the shape every review
    needs, since self-review is prohibited."""
    org = ledger.Org.create(name)
    for node in ('owner-a', 'reviewer-b'):
        org.hire(USER, None, 'haiku', 0, node)
    created = org.work_create(
        'owner-a', 'Land the thing',
        objective='Problem: approval completed the item before the push. '
                  'Solution: approve the commit, land it, then complete.',
        owner='owner-a', participants=['reviewer-b'],
        acceptance=['the approved commit is on main'])
    return org, str(created['slug'])


def item(org, slug):
    for row in org.d.get('work_items', []):
        if row['slug'] == slug:
            return row
    for row in org.d.get('work_items_archive', []):
        if row['slug'] == slug:
            return row
    raise AssertionError(slug)


def under_review(org, slug):
    org.work_update('owner-a', slug, ['implemented'], ['review this commit'],
                    status='review', reviewer='reviewer-b')


class ApproveStageTests(unittest.TestCase):
    """Acceptance 1, 2 and 3: approve a commit without completing the item,
    record the exact sha, and read honestly in the docket."""

    def test_approve_stage_does_not_complete_the_item(self):
        org, slug = fixture('stage-not-done')
        under_review(org, slug)
        out = org.work_review_decide('reviewer-b', slug, 'approve_stage',
                                     'commit reads correct', candidate=SHA)
        row = item(org, slug)
        # ACCEPTANCE 1: not done, and not closed by any other name either.
        self.assertEqual(out['decision'], 'approve_stage')
        self.assertEqual(row['status'], 'approved')
        self.assertNotIn(row['status'], ledger.Org.WORK_CLOSED)
        # the acceptance record is NOT written — the item was not completed,
        # and a provisional one would be the same untrue record in a quieter
        # place
        self.assertIsNone(row['accepted'])
        # ACCEPTANCE 3 (half): it did not stay untouched either. The status
        # moved off `review` and the status clock stamped the transition.
        self.assertNotEqual(row['status'], 'review')
        self.assertEqual(row['status_at'], row['status_at'])
        self.assertIsNotNone(row['status_at'])

    def test_exact_sha_is_recorded_on_the_item(self):
        org, slug = fixture('stage-sha')
        under_review(org, slug)
        out = org.work_review_decide('reviewer-b', slug, 'approve_stage',
                                     candidate=SHA)
        row = item(org, slug)
        # ACCEPTANCE 2: the exact sha, on the item, in the one shape the
        # nonterminal candidate verdict already uses.
        self.assertEqual(out['candidate'], SHA)
        self.assertEqual(row['candidate_verdict']['candidate'], SHA)
        self.assertEqual(row['candidate_verdict']['decision'], 'approve_stage')
        self.assertEqual(row['candidate_verdict']['by']['node'], 'reviewer-b')
        # and it is APPEND-ONLY history, not a single overwritable pointer
        self.assertEqual([v['candidate'] for v in row['candidate_verdicts']],
                         [SHA])
        # a re-review after an amend appends rather than replacing the record
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA2)
        row = item(org, slug)
        self.assertEqual([v['candidate'] for v in row['candidate_verdicts']],
                         [SHA, SHA2])
        self.assertEqual(row['candidate_verdict']['candidate'], SHA2)

    def test_approve_stage_requires_an_exact_commit(self):
        org, slug = fixture('stage-needs-sha')
        under_review(org, slug)
        for bad in (None, '', 'HEAD', 'main', 'zzzzzzz', 'a1b2c3'):
            with self.assertRaises(LedgerError) as caught:
                org.work_review_decide('reviewer-b', slug, 'approve_stage',
                                       candidate=bad)
            self.assertIn('candidate', str(caught.exception))
            # nothing was written on the way to the refusal
            self.assertEqual(item(org, slug)['status'], 'review')
            self.assertIsNone(item(org, slug)['candidate_verdict'])

    def test_owner_keeps_the_item_and_owes_the_next_action(self):
        org, slug = fixture('stage-owner')
        under_review(org, slug)
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA)
        row = item(org, slug)
        # the verdict never claims the item for the reviewer
        self.assertEqual(row['owner']['node'], 'owner-a')
        served = org.work_get('owner-a', slug)
        self.assertEqual(served['next_action']['node'], 'owner-a')
        self.assertEqual(served['next_action']['role'], 'owner')

    def test_approved_counts_active_and_does_not_auto_archive(self):
        org, slug = fixture('stage-active')
        under_review(org, slug)
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA)
        # ACCEPTANCE 3: it is neither Done nor invisible. It sits in the
        # ACTIVE count, which is what stops an approved-not-landed item from
        # quietly leaving the user's screen the way a completed one does.
        counts = org.work_counts()
        self.assertEqual(counts['active'], 1)
        self.assertEqual(counts['archived'], 0)
        self.assertEqual(counts['backlogged'], 0)
        self.assertNotIn('approved', ledger.Org.WORK_ARCHIVES_ITSELF)
        self.assertNotIn('approved', ledger.Org.WORK_UNCOUNTED)
        served = org.work_list('owner-a')['items'][0]
        self.assertEqual(served['status'], 'approved')
        self.assertFalse(served['archived'])

    def test_state_reasons_are_cleared_so_the_pane_cannot_lie(self):
        org, slug = fixture('stage-clears')
        org.work_update('owner-a', slug, ['stuck'], ['unstick'],
                        status='blocked',
                        blocked_reason='waiting on the build; the build '
                                       'notification is how I will hear')
        org.work_update('owner-a', slug, ['implemented'], ['review it'],
                        status='review', reviewer='reviewer-b')
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA)
        row = item(org, slug)
        # an item reading "BLOCKED BECAUSE ..." while sitting at `approved`
        # is a pane that lies, and nothing else would fail
        self.assertIsNone(row['blocked_reason'])
        self.assertIsNone(row['dropped_reason'])


class NoSelfApprovalTests(unittest.TestCase):
    """`approved` must keep meaning "a reviewer checked this"."""

    def test_agents_cannot_assert_approved_through_an_update(self):
        org, slug = fixture('stage-no-self')
        self.assertNotIn('approved', ledger.Org.WORK_AGENT_STATUSES)
        for who in ('owner-a', 'reviewer-b'):
            with self.assertRaises(LedgerError) as caught:
                org.work_update(who, slug, ['done really'], [],
                                status='approved')
            self.assertIn('status must be one of', str(caught.exception))
        self.assertNotEqual(item(org, slug)['status'], 'approved')

    def test_an_item_cannot_be_created_directly_as_approved(self):
        org, _ = fixture('stage-no-create')
        with self.assertRaises(LedgerError):
            org.work_create('owner-a', 'Sneak it in', objective='problem; fix',
                            owner='owner-a', status='approved')

    def test_the_owner_cannot_stage_approve_its_own_item(self):
        org, slug = fixture('stage-no-owner-verdict')
        under_review(org, slug)
        with self.assertRaises(LedgerError) as caught:
            org.work_review_decide('owner-a', slug, 'approve_stage',
                                   candidate=SHA)
        self.assertIn('self-review is prohibited', str(caught.exception))
        self.assertEqual(item(org, slug)['status'], 'review')


class LandingThenCompletionTests(unittest.TestCase):
    """Acceptance 5: the landing is recorded AFTER approval, and completion
    happens only then — with the acceptance record undiminished."""

    def test_owner_updates_an_approved_item_and_completes_it_after_landing(self):
        org, slug = fixture('stage-land')
        under_review(org, slug)
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA)
        # the owner can still write to the item — this is the whole reason the
        # state has to be an open one
        org.work_update('owner-a', slug, ['approved at ' + SHA[:7]],
                        ['rebase and push'])
        self.assertEqual(item(org, slug)['status'], 'approved',
                         'an update that names no status leaves it alone')
        # the landing is recorded on the item
        org.work_claim('owner-a', slug, 'pushed', ref=SHA)
        row = item(org, slug)
        self.assertEqual(row['delivery']['pushed']['ref'], SHA)
        self.assertEqual(row['status'], 'approved',
                         'recording the push does not complete the item')
        # ...and completion happens only then
        org.work_check('owner-a', slug, index=0, evidence_ref=SHA,
                       classification='met', execution='independent',
                       artifact='git log --oneline main',
                       runner='git 2.45', result='passed')
        org.work_accept('owner-a', slug, 'landed at ' + SHA)
        row = item(org, slug)
        self.assertEqual(row['status'], 'done')
        # ACCEPTANCE 5 / the "not weakened" requirement: the completed item
        # carries the same acceptance record it always did.
        self.assertEqual(row['accepted']['via'], 'accept')
        self.assertEqual(row['accepted']['by']['node'], 'owner-a')
        self.assertEqual(row['accepted']['note'], 'landed at ' + SHA)
        self.assertIsNotNone(row['accepted']['at'])
        # and the approved sha is still readable beside the completion
        self.assertEqual(row['candidate_verdict']['candidate'], SHA)

    def test_acceptance_guard_is_not_spent_by_a_staged_approval(self):
        """A staged approval must not buy a completion the guard would refuse."""
        org, slug = ledger.Org.create('stage-guard'), None
        for node in ('owner-a', 'reviewer-b'):
            org.hire(USER, None, 'haiku', 0, node)
        created = org.work_create(
            'owner-a', 'Guarded', objective='problem; solution',
            owner='owner-a', participants=['reviewer-b'],
            acceptance=['the push is on main', 'the suite is green'])
        slug = str(created['slug'])
        org.work_update('owner-a', slug, ['implemented'], ['review'],
                        status='review', reviewer='reviewer-b')
        org.work_review_decide('reviewer-b', slug, 'approve_stage',
                               candidate=SHA)
        # one condition checked, but only as qualified evidence
        org.work_check('owner-a', slug, index=0, evidence_ref=SHA,
                       classification='not_exercised', execution='independent',
                       artifact='git log --oneline main', runner='git 2.45',
                       result='not_executed')
        with self.assertRaises(LedgerError) as caught:
            org.work_accept('owner-a', slug)
        self.assertIn('acceptance condition', str(caught.exception))
        self.assertEqual(item(org, slug)['status'], 'approved')


class ExistingOutcomesUnchangedTests(unittest.TestCase):
    """Acceptance 4: `approve` and `changes` behave exactly as before."""

    def test_approve_still_completes_the_item_the_same_way(self):
        org, slug = fixture('stage-approve-unchanged')
        under_review(org, slug)
        out = org.work_review_decide('reviewer-b', slug, 'approve',
                                     'checked and landed')
        row = item(org, slug)
        self.assertEqual(out['decision'], 'approve')
        self.assertEqual(out['accepted'], slug)
        self.assertEqual(row['status'], 'done')
        self.assertEqual(row['accepted']['via'], 'review_approve')
        self.assertEqual(row['accepted']['by']['node'], 'reviewer-b')
        self.assertEqual(row['accepted']['note'], 'checked and landed')
        # `approve` still takes no candidate and is not made to want one
        self.assertIsNone(row['candidate_verdict'])

    def test_changes_still_sends_it_back_as_in_progress(self):
        org, slug = fixture('stage-changes-unchanged')
        under_review(org, slug)
        out = org.work_review_decide('reviewer-b', slug, 'changes',
                                     'fix the off-by-one')
        row = item(org, slug)
        self.assertEqual(out['decision'], 'changes')
        self.assertEqual(row['status'], 'in_progress')
        self.assertIsNone(row['accepted'])
        self.assertIsNone(row['candidate_verdict'])
        self.assertEqual(row['owner']['node'], 'owner-a')
        # the full note survives in history, uncut
        notes = [h for h in row['history'] if h.get('op') == 'review_changes']
        self.assertEqual(notes[-1]['note'], 'fix the off-by-one')

    def test_an_unknown_decision_is_still_refused_and_names_all_three(self):
        org, slug = fixture('stage-bad-decision')
        under_review(org, slug)
        with self.assertRaises(LedgerError) as caught:
            org.work_review_decide('reviewer-b', slug, 'looks_good')
        msg = str(caught.exception)
        for word in ('approve', 'approve_stage', 'changes'):
            self.assertIn(word, msg)
        self.assertEqual(item(org, slug)['status'], 'review')

    def test_nonterminal_candidate_verdict_is_untouched(self):
        """`work_candidate_verdict` still records approve/changes and still
        changes no status — `approve_stage` did not re-point it."""
        org, slug = fixture('stage-verdict-untouched')
        under_review(org, slug)
        before = item(org, slug)['status']
        org.work_candidate_verdict('reviewer-b', slug, SHA, 'approve')
        row = item(org, slug)
        self.assertEqual(row['status'], before)
        self.assertEqual(row['candidate_verdict']['decision'], 'approve')
        with self.assertRaises(LedgerError):
            org.work_candidate_verdict('reviewer-b', slug, SHA,
                                       'approve_stage')


class SurfaceTests(unittest.TestCase):
    """The verdict has to be reachable and described where agents read."""

    def test_mcp_schema_offers_the_third_decision(self):
        tool = next(t for t in mcptool.TOOLS if t['name'] == 'orgtree_work')
        props = tool['inputSchema']['properties']
        self.assertEqual(props['decision']['enum'],
                         ['approve', 'approve_stage', 'changes'])
        self.assertIn('approve_stage', props['decision']['description'])
        self.assertIn('approve_stage', props['candidate']['description'])
        self.assertIn('approved', props['status']['description'])

    def test_status_vocabulary_holds_approved_between_review_and_deploy(self):
        statuses = list(ledger.Org.WORK_STATUSES)
        self.assertIn('approved', statuses)
        self.assertEqual(statuses.index('approved'), statuses.index('review') + 1)
        self.assertEqual(statuses.index('approved'),
                         statuses.index('deploy_ready') - 1)
        self.assertEqual(ledger.Org.WORK_STAGED_STATUS, 'approved')

    def test_the_owner_is_told_which_commit_was_approved(self):
        org, slug = fixture('stage-mail')
        under_review(org, slug)
        out = org.work_review_decide('reviewer-b', slug, 'approve_stage',
                                     'reads correct', candidate=SHA)
        self.assertEqual(out['notified'], 'owner-a')
        box = org.d['mail']['owner-a']
        ev = next(m['ev'] for m in reversed(box)
                  if m.get('ev', {}).get('variant')
                  == 'docket.review_approved_stage')
        self.assertEqual(ev['candidate'], SHA)
        self.assertEqual(ev['reviewer'], 'reviewer-b')
        self.assertEqual(ev['owner'], 'owner-a')
        from orgtree import events
        body = events.render_agent(ev)
        self.assertIn(SHA, body)
        self.assertIn('NOT done', body)


if __name__ == '__main__':
    unittest.main()
