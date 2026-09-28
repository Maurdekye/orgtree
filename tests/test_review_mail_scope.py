"""Marking stale review requests reads only the boxes that can hold one.

A review request (docket.review_requested) is mailed to the reviewer being
named, and every naming is in the item's history, so the stale walk reads
those reviewers' pending mail and mail_log only — not every agent's whole mail
history (N1000 item desk-chat-read-and-other-request-paths-still-loa). When the
history was folded past WORK_HISTORY_MAX an older naming may be gone, and the
walk reads every box as before.

In-memory Org fixtures (test_authorized_review_workflow's), no database.
"""
import unittest

from test_authorized_review_workflow import fixture, item, review
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree.ledger import USER


class Trap(list):
    """A box the scoped walk must never read."""
    def __iter__(self):
        raise AssertionError('an unrelated mailbox was read')


def request_row(slug, rev):
    return {'id': 'req-x', 'from': 'owner-a', 'kind': 'request', 'at': '2026-09-28T00:00:00Z',
            'body': '', 'operation_id': 'op-x',
            'ev': {'variant': 'docket.review_requested', 'object': {'slug': slug},
                   'revision': rev}}


class ReviewMailScope(unittest.TestCase):
    def test_a_delivered_request_in_mail_log_still_goes_stale(self):
        org, slug = fixture()
        review(org, slug)
        request = org.d['mail']['peer-b'].pop()
        org.d.setdefault('mail_log', {}).setdefault('peer-b', []).append(request)
        org.work_update('owner-a', slug, ['more'], [], status='review', reviewer='peer-b')
        self.assertTrue(request['stale'])

    def test_unrelated_mailboxes_are_never_read(self):
        org, slug = fixture()
        review(org, slug)
        org.d['mail']['outsider-c'] = Trap([{'id': 'x'}])
        org.d.setdefault('mail_log', {})['outsider-c'] = Trap([{'id': 'y'}])
        request = org.d['mail']['peer-b'][-1]
        org.work_update('owner-a', slug, ['more'], [], status='review', reviewer='peer-b')
        self.assertTrue(request['stale'])

    def test_a_former_reviewer_still_gets_the_marker(self):
        org, slug = fixture()
        review(org, slug, reviewer='peer-b')
        first = org.d['mail']['peer-b'][-1]
        org.hire(USER, None, 'haiku', 0, 'peer-d')
        org.work_update('owner-a', slug, ['changes'], [], status='in_progress')
        # the user may name any reviewer
        org.work_update(USER, slug, ['ready again'], [], status='review', reviewer='peer-d',
                        owner='owner-a')
        self.assertTrue(first['stale'])
        # a request still in the FORMER reviewer's box (peer-b is no longer
        # current) must still be found through the item's history
        late = request_row(slug, 0)
        org.d['mail']['peer-b'].append(late)
        org.work_update('owner-a', slug, ['progress'], [])
        self.assertTrue(late['stale'])
        second = org.d['mail']['peer-d'][-1]
        org.work_update(USER, slug, ['again'], [], status='review', reviewer='peer-d',
                        owner='owner-a')
        self.assertTrue(second['stale'])

    def test_a_renamed_reviewer_request_still_goes_stale(self):
        # pg-supervisor-a's case: history keeps the OLD id after a rename, so
        # only the current reviewer (re-keyed to the new id) covers this box
        org, slug = fixture()
        review(org, slug, reviewer='peer-b')
        req = org.d['mail']['peer-b'][-1]
        org.rename(USER, 'peer-b', 'peer-bb')
        org.hire(USER, None, 'haiku', 0, 'peer-d')
        org.work_update(USER, slug, ['re-seat'], [], status='review', reviewer='peer-d',
                        owner='owner-a')
        self.assertTrue(req.get('stale'))

    def test_a_folded_history_reads_every_box_as_before(self):
        org, slug = fixture()
        review(org, slug)
        it = item(org, slug)
        it['history'] = [{'kind': 'folded', 'count': 200, 'first_at': 'x', 'last_at': 'y'}]
        it['reviewer'] = None
        stray = request_row(slug, 0)
        org.d['mail']['outsider-c'] = [stray]       # named before the fold
        org.work_update('owner-a', slug, ['more'], [])
        self.assertTrue(stray['stale'])

    def test_owners_are_the_history_reviewers_plus_the_current_one(self):
        org, slug = fixture()
        review(org, slug)
        self.assertEqual(org._work_review_mail_owners(item(org, slug)), ['peer-b'])
        it = item(org, slug)
        it['history'].insert(0, {'kind': 'folded', 'count': 1})
        self.assertIsNone(org._work_review_mail_owners(it))


if __name__ == '__main__':
    unittest.main()
