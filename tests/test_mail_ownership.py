"""Ownership of a drained mail batch is a fact about evidence, not about mood.

`mailownership.classify` exists because `_delivery_stages` answers with one
node-wide bit: a token in no carrier at all is labelled `steer` because the
node is busy with something else. These tests pin the replacement, and the
ones that matter are the DIVERGENCES — the nine frozen source witnesses below
are copied verbatim from the approved `m0b-proposal/source-evidence.json`
(sha256 4a76dab17bb4d75be3b5b7d51a074a18490e42f0afbd2fb13571781d2edcb06c),
and four of them are cases where the new classifier deliberately says
something else. Each is asserted individually, so a future edit that quietly
re-adopts the node-wide bit fails here by name rather than by a count.

Nothing in this module creates an org, opens storage, starts a process or
reads a clock. That is not incidental tidiness: the module under test is a
leaf, every fact it judges arrives inside one frozen snapshot including the
time, and a test that supplied any of those from the environment would be
unable to tell a pure classifier from an impure one. `APureFunctionStaysPure`
checks that property directly rather than trusting it.

The negative controls are the load-bearing half. `TheEvidenceIsNotFabricated`
fails against the plausible wrong implementation — one that reads `busy`, that
accepts a mode label, that upgrades a stale membership on a new turn, that
treats an unreadable lease as an expired one, or that reads a missing journal
row as a confirmation — and passes only against one that keeps each of those
distinctions.
"""
import copy
import dataclasses
import datetime as _dtm
import itertools
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import mailownership as mo

CHECKOUT = Path(__file__).resolve().parents[1]

NOW = 1_800_000_000.0          # an injected instant; no wall clock anywhere here


def iso(epoch: float) -> str:
    """Epoch seconds as the ISO stamp `now_iso()` would have written. Every
    drain stamp in this module goes through it, because the classifier's stamp
    domain is a string and a test that handed it a float would be exercising a
    shape the journal never contains."""
    return _dtm.datetime.fromtimestamp(epoch, _dtm.timezone.utc).isoformat()


OLD = iso(NOW - 100.0)         # drained well past the ten-second grace
YOUNG = iso(NOW - 1.0)         # drained one second ago

CURRENT = mo.CustodyRef(mailbox_id='mb-worker', generation=3,
                         session='sess-7', turn_token='turn-42')


# ---------------------------------------------------------------------------
# The frozen source witness. `stage` is what `supervisor._delivery_stages`
# returns at d35044d for the same situation; `diverges` records whether the
# classifier deliberately disagrees. Copied, not computed: this module must not
# import the supervisor, and a witness that recomputed itself would drift with
# the code it is supposed to pin.
# ---------------------------------------------------------------------------
FROZEN_WITNESS = {
    'busy_unrelated_old_orphan': ('steer', True),
    'responding_unrelated_old_orphan': ('steer', True),
    'live_turn_tokens_old': ('turn', True),
    'queue_without_live_consumer': ('stranded', False),
    'queue_with_live_consumer': ('queued', False),
    'young_unowned': ('steer', False),
    'idle_old_orphan': ('stranded', False),
    'lease_boolean_without_membership': ('steer', False),
    'manual_mode_with_unrelated_response': ('steer', True),
}


class Case(unittest.TestCase):
    """Shared builders. Deliberately holds NO test methods: a TestCase that
    subclasses another TestCase re-runs the parent's methods under the child's
    name, which is how the M0a fixture ended up minting two orgs per method."""

    def snap(self, *, batches=None, now=NOW, current=CURRENT, **kw):
        return mo.OwnershipSnapshot(
            current=current, now=now,
            batches=tuple(batches if batches is not None else (self.batch(),)),
            **kw)

    def batch(self, token='tok-a', at=OLD, mode='steer', message_ids=()):
        return mo.JournalBatch(token=token, drained_at=at, mode=mode,
                               message_ids=tuple(message_ids))

    def verdict(self, snapshot, token='tok-a'):
        return mo.classify(snapshot).by_token[token]

    def assertReasons(self, verdict, *expected):
        for reason in expected:
            self.assertIn(reason, verdict.reasons,
                          f'{reason.value} missing from {[r.value for r in verdict.reasons]}')

    def assertRefused(self, verdict):
        """Both non-eligible dispositions are refusals. They say different
        things and permit exactly the same thing: nothing."""
        self.assertFalse(verdict.reclaimable)
        self.assertIsNot(verdict.disposition, mo.Disposition.ELIGIBLE)


class ABusyNodeOwnsNothingInParticular(Case):
    """Rule 1. The four flags are on the snapshot and are not consulted."""

    def test_the_old_orphan_a_busy_node_called_steer_is_eligible(self):
        snap = self.snap(activity=mo.NodeActivity(busy=True))
        verdict = self.verdict(snap)
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertIs(verdict.owner, mo.OwnerEvidence.NONE)
        self.assertReasons(verdict, mo.Reason.UNOWNED_PAST_GRACE)

    def test_every_combination_of_the_four_flags_classifies_identically(self):
        """Sixteen sweeps over a snapshot that also carries a live carrier, a
        claim, a lease and a halt hold, so the flags are toggled against a
        populated matrix rather than an empty one."""
        base = dict(
            batches=(self.batch('tok-a'), self.batch('tok-b'), self.batch('tok-c', at=YOUNG)),
            carriers=(mo.CarrierHold(mo.CarrierKind.QUEUE, frozenset({'tok-b'}), live=False),),
            claims=(mo.Claim(tokens=frozenset({'tok-c'}), delivery_id='d-1'),),
            retentions=(mo.Retention(mo.RetentionKind.HALT, frozenset({'tok-b'})),),
        )
        reference = None
        for flags in itertools.product((False, True), repeat=4):
            activity = mo.NodeActivity(*flags)
            result = mo.classify(self.snap(activity=activity, **base))
            shape = {tok: (v.disposition, v.reasons, v.owner, v.retained_carrier)
                     for tok, v in result.by_token.items()}
            if reference is None:
                reference = shape
            self.assertEqual(shape, reference, f'activity {activity} moved a verdict')
        self.assertIs(reference['tok-a'][0], mo.Disposition.ELIGIBLE)

    def test_the_flags_are_recorded_so_a_reader_can_see_them_ignored(self):
        activity = mo.NodeActivity(busy=True, waiting=True, responding=True, proc_control=True)
        self.assertIs(self.snap(activity=activity).activity, activity)


class OnlyAMatchingTupleIsTheCurrentTurn(Case):
    """Rule 2. Positive current owner/generation/turn membership, whole."""

    def member(self, kind, owner=CURRENT, tokens=('tok-a',)):
        return mo.Membership(kind=kind, owner=owner, tokens=frozenset(tokens))

    def test_a_matching_turn_membership_protects_a_batch_older_than_the_grace(self):
        verdict = self.verdict(self.snap(
            memberships=(self.member(mo.MembershipKind.TURN),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.PROVEN)
        self.assertReasons(verdict, mo.Reason.CURRENT_TURN_MEMBERSHIP)
        self.assertLess(verdict.grace_remaining, 0)   # age did not save it; the tuple did

    def test_a_matching_manual_fetch_membership_protects_the_same_way(self):
        verdict = self.verdict(self.snap(
            batches=(self.batch(mode='manual_fetch'),),
            memberships=(self.member(mo.MembershipKind.MANUAL_FETCH),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.PROVEN)
        self.assertReasons(verdict, mo.Reason.MANUAL_FETCH_MEMBERSHIP)

    def test_each_part_of_the_tuple_is_load_bearing(self):
        """One field changed is a different holder, not the current one. This
        is the whole content of "stale membership is not upgraded by an
        unrelated new turn"."""
        for field, value in (('mailbox_id', 'mb-other'), ('generation', 4),
                             ('session', 'sess-8'), ('turn_token', 'turn-43')):
            with self.subTest(field=field):
                stale = dataclasses.replace(CURRENT, **{field: value})
                verdict = self.verdict(self.snap(
                    memberships=(self.member(mo.MembershipKind.MANUAL_FETCH, owner=stale),)))
                self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
                self.assertReasons(verdict, mo.Reason.OWNER_MEMBERSHIP_STALE)

    def test_an_incomplete_tuple_protects_without_proving_an_owner(self):
        """Three of four is not "mostly the current turn". It is unresolved,
        and unresolved is protected — but it never reports a proven owner."""
        partial = dataclasses.replace(CURRENT, turn_token=mo.Gap.ABSENT)
        verdict = self.verdict(self.snap(
            memberships=(self.member(mo.MembershipKind.TURN, owner=partial),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
        self.assertReasons(verdict, mo.Reason.OWNER_MEMBERSHIP_UNSUPPORTED)

    def test_a_membership_protects_its_own_tokens_and_no_others(self):
        result = mo.classify(self.snap(
            batches=(self.batch('tok-a'), self.batch('tok-b')),
            memberships=(self.member(mo.MembershipKind.TURN, tokens=('tok-a',)),)))
        self.assertIs(result.by_token['tok-a'].disposition, mo.Disposition.PROTECTED)
        self.assertIs(result.by_token['tok-b'].disposition, mo.Disposition.ELIGIBLE)


class TheCarrierMatrix(Case):
    """Rule 3. Each carrier protects its exact tokens; none lends to a
    neighbour."""

    def carrier_case(self, **kw):
        return self.snap(batches=(self.batch('tok-a'), self.batch('tok-b')), **kw)

    def test_a_live_carrier_protects_its_tokens(self):
        for kind, reason in ((mo.CarrierKind.QUEUE, mo.Reason.QUEUE_CARRIER_LIVE),
                             (mo.CarrierKind.STEER, mo.Reason.STEER_CARRIER_LIVE),
                             (mo.CarrierKind.LIMBO, mo.Reason.STEER_LIMBO_REQUESTED),
                             (mo.CarrierKind.PUMP, mo.Reason.LIVE_PUMP)):
            with self.subTest(carrier=kind.value):
                result = mo.classify(self.carrier_case(carriers=(
                    mo.CarrierHold(kind, frozenset({'tok-a'}), live=True),)))
                self.assertIs(result.by_token['tok-a'].disposition, mo.Disposition.PROTECTED)
                self.assertReasons(result.by_token['tok-a'], reason)
                self.assertIs(result.by_token['tok-b'].disposition, mo.Disposition.ELIGIBLE)

    def test_a_queued_carrier_with_nothing_to_pop_it_is_as_stranded_as_any_other(self):
        """`_delivery_stages` review round 2, preserved exactly."""
        verdict = self.verdict(self.carrier_case(carriers=(
            mo.CarrierHold(mo.CarrierKind.QUEUE, frozenset({'tok-a'}), live=False),)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertReasons(verdict, mo.Reason.QUEUE_CARRIER_NO_CONSUMER)

    def test_unknown_liveness_protects_rather_than_guesses(self):
        verdict = self.verdict(self.carrier_case(carriers=(
            mo.CarrierHold(mo.CarrierKind.QUEUE, frozenset({'tok-a'}), live=mo.Gap.UNKNOWN),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
        self.assertReasons(verdict, mo.Reason.CARRIER_LIVENESS_UNKNOWN)

    def test_a_claim_protects_its_tokens_whether_or_not_it_was_acked(self):
        for acked in (True, False):
            with self.subTest(acked=acked):
                verdict = self.verdict(self.carrier_case(claims=(
                    mo.Claim(frozenset({'tok-a'}), delivery_id='d-1', acked=acked),)))
                self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                self.assertReasons(verdict, mo.Reason.CLAIM_HELD)

    def test_an_unexpired_lease_with_token_membership_proves_its_owner(self):
        verdict = self.verdict(self.carrier_case(leases=(
            mo.Lease(frozenset({'tok-a'}), expires_at=iso(NOW + 30.0), owner=CURRENT),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.PROVEN)
        self.assertReasons(verdict, mo.Reason.LEASE_HELD)

    def test_an_expired_lease_stops_protecting(self):
        verdict = self.verdict(self.carrier_case(leases=(
            mo.Lease(frozenset({'tok-a'}), expires_at=iso(NOW - 30.0)),)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertReasons(verdict, mo.Reason.LEASE_EXPIRED)

    def test_halt_and_native_retention_protect_and_mark_the_carrier_retained(self):
        for kind, reason in ((mo.RetentionKind.HALT, mo.Reason.HALT_HELD),
                             (mo.RetentionKind.NATIVE, mo.Reason.NATIVE_HELD)):
            with self.subTest(kind=kind.value):
                result = mo.classify(self.carrier_case(retentions=(
                    mo.Retention(kind, frozenset({'tok-a'})),)))
                held = result.by_token['tok-a']
                self.assertIs(held.disposition, mo.Disposition.PROTECTED)
                self.assertTrue(held.retained_carrier,
                                'a retained self-contained carrier must never be discarded '
                                'merely to make its mail retrievable')
                self.assertReasons(held, reason)
                self.assertFalse(result.by_token['tok-b'].retained_carrier)


class ConfirmationIsEvidenceNotAnAbsence(Case):
    """Rule 7, and the docket's missing-row constraint."""

    def test_confirmation_in_flight_is_protected_even_if_its_save_failed(self):
        verdict = self.verdict(self.snap(
            confirmations={'tok-a': mo.Confirmation.IN_FLIGHT}))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.confirmation, mo.Confirmation.IN_FLIGHT)
        self.assertReasons(verdict, mo.Reason.CONFIRMATION_IN_FLIGHT)

    def test_matched_evidence_confirms_and_an_acknowledgment_does_not(self):
        confirmed = self.verdict(self.snap(
            confirmations={'tok-a': mo.Confirmation.CONFIRMED}))
        self.assertIs(confirmed.disposition, mo.Disposition.PROTECTED)
        self.assertReasons(confirmed, mo.Reason.CONFIRMED_BY_MATCHED_EVIDENCE)

        acked = self.verdict(self.snap(
            confirmations={'tok-a': mo.Confirmation.ACKNOWLEDGED}))
        self.assertIs(acked.confirmation, mo.Confirmation.ACKNOWLEDGED)
        self.assertIs(acked.disposition, mo.Disposition.ELIGIBLE)
        self.assertReasons(acked, mo.Reason.ACKNOWLEDGED_NOT_CONFIRMED)

    def test_an_unreadable_confirmation_value_is_unknown_and_protected(self):
        verdict = self.verdict(self.snap(confirmations={'tok-a': 'yes'}))
        self.assertIs(verdict.confirmation, mo.Confirmation.UNKNOWN)
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertReasons(verdict, mo.Reason.CONFIRMATION_UNKNOWN)

    def test_a_missing_journal_row_confirms_nothing(self):
        """The row is gone. That is not a confirmation, not a fold-back and
        not permission to drain again — it is an absence of content, reported
        as one, with the original identity intact."""
        selection = mo.select(self.snap(batches=()), ['m-1'])
        self.assertEqual(selection.unresolved_messages, ('m-1',))
        self.assertEqual(selection.verdicts, ())
        self.assertEqual(selection.reclaimable_tokens, frozenset())

    def test_content_is_present_exactly_when_a_row_is(self):
        self.assertIs(self.verdict(self.snap()).content, mo.Content.PRESENT)


class TheGraceIsTheOneThatAlreadyExists(Case):
    """Rule 5. Ten seconds, from the drain stamp, measured on an injected
    clock."""

    def test_the_module_restates_the_supervisors_own_constant(self):
        source = (CHECKOUT / 'engine/backend/orgtree/supervisor.py').read_text(
            encoding='utf-8', errors='strict')
        match = re.search(r'^STRANDED_GRACE_S\s*=\s*([0-9.]+)\s*$', source, re.M)
        self.assertIsNotNone(match, 'supervisor.STRANDED_GRACE_S no longer parses')
        self.assertEqual(float(match.group(1)), mo.DRAIN_GRACE_S,
                         'the classifier introduced a second grace duration')

    def test_both_sides_of_the_boundary(self):
        inside = self.verdict(self.snap(batches=(self.batch(at=iso(NOW - 9.999)),)))
        self.assertIs(inside.disposition, mo.Disposition.PROTECTED)
        self.assertReasons(inside, mo.Reason.WITHIN_DRAIN_GRACE)

        exactly = self.verdict(self.snap(batches=(self.batch(at=iso(NOW - 10.0)),)))
        self.assertIs(exactly.disposition, mo.Disposition.ELIGIBLE)
        self.assertNotIn(mo.Reason.WITHIN_DRAIN_GRACE, exactly.reasons)

    def test_the_clock_is_the_injected_one(self):
        batch = self.batch(at=iso(NOW - 5.0))
        self.assertIs(self.verdict(self.snap(batches=(batch,))).disposition,
                      mo.Disposition.PROTECTED)
        later = mo.classify(self.snap(batches=(batch,), now=NOW + 60.0)).by_token['tok-a']
        self.assertIs(later.disposition, mo.Disposition.ELIGIBLE)

    def test_an_absent_or_unreadable_stamp_is_not_young(self):
        """`_batch_is_young`'s deliberate behaviour, preserved: an old-shape
        batch nobody owns is exactly what the label exists for. The two cases
        are still told apart in the reasons, which `_batch_is_young` cannot."""
        absent = self.verdict(self.snap(batches=(self.batch(at=None),)))
        self.assertIs(absent.disposition, mo.Disposition.ELIGIBLE)
        self.assertIsNone(absent.grace_remaining)
        self.assertReasons(absent, mo.Reason.GRACE_STAMP_ABSENT)

        for junk in ('not-a-date', '', 0, False, [], {'at': 1},
                     '2027-01-15T07:58:20'):   # parses, states no offset (f4)
            with self.subTest(stamp=repr(junk)):
                verdict = self.verdict(self.snap(batches=(self.batch(at=junk),)))
                self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
                self.assertReasons(verdict, mo.Reason.GRACE_STAMP_UNREADABLE)

    def test_an_iso_stamp_parses_the_way_the_supervisor_parses_it(self):
        verdict = self.verdict(self.snap(
            batches=(self.batch(at='2027-01-15T07:58:20Z'),),
            now=1_800_000_000.0))
        self.assertIsNotNone(verdict.grace_remaining)

    def test_the_stamp_the_product_actually_writes_carries_its_offset(self):
        """The `Z` form above is not a convenience of this test: `ledger.now()`
        is what stamps every `delivering` row, and it ends in `Z` on every
        path. That is why requiring an offset (f4) refuses nothing the product
        produces — a stamp without one can only come from a hand-edited or
        corrupt document."""
        source = (CHECKOUT / 'engine/backend/orgtree/ledger.py').read_text(
            encoding='utf-8', errors='strict')
        body = re.search(r'^def now\(\) -> str:\n(.*?)^\S', source,
                         re.M | re.S)
        self.assertIsNotNone(body, 'ledger.now() no longer parses')
        self.assertIn('Z"', body.group(1),
                      'ledger.now() stopped stamping an explicit zone')


class TheEvidenceIsNotFabricated(Case):
    """Rules 4 and 6. Everything uncertain refuses, says why, and changes
    nothing."""

    def test_an_unsupported_current_identity_refuses_the_whole_snapshot(self):
        for broken in (mo.CustodyRef(mailbox_id='', generation=3, session='s', turn_token='t'),
                       mo.CustodyRef(mailbox_id='mb', generation=True, session='s', turn_token='t'),
                       mo.CustodyRef(mailbox_id='mb', generation=-1, session='s', turn_token='t'),
                       mo.CustodyRef()):
            with self.subTest(current=broken):
                verdict = self.verdict(self.snap(current=broken))
                self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
                self.assertReasons(verdict, mo.Reason.CURRENT_IDENTITY_UNSUPPORTED)
                self.assertRefused(verdict)

    def test_an_unsupported_token_is_not_a_batch_without_an_owner(self):
        for junk in (None, '', 0, False, 17, b'tok', ['tok']):
            with self.subTest(token=repr(junk)):
                result = mo.classify(self.snap(batches=(self.batch(token=junk),)))
                self.assertEqual(result.by_token, {})
                self.assertIs(result.verdicts[0].disposition, mo.Disposition.UNAVAILABLE)
                self.assertRefused(result.verdicts[0])
                if junk is None:
                    continue
                self.assertReasons(result.verdicts[0], mo.Reason.UNSUPPORTED_TOKEN)

    def test_two_rows_carrying_one_token_are_both_unavailable(self):
        result = mo.classify(self.snap(batches=(
            self.batch('dup', at=OLD), self.batch('dup', at=YOUNG), self.batch('tok-b'))))
        self.assertNotIn('dup', result.by_token)
        for verdict in result.verdicts[:2]:
            self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
            self.assertReasons(verdict, mo.Reason.DUPLICATE_TOKEN_RECORDS)
        self.assertIs(result.by_token['tok-b'].disposition, mo.Disposition.ELIGIBLE)

    def test_two_holders_naming_one_token_is_unavailable_not_a_winner(self):
        other = dataclasses.replace(CURRENT, session='sess-9')
        verdict = self.verdict(self.snap(memberships=(
            mo.Membership(mo.MembershipKind.TURN, CURRENT, frozenset({'tok-a'})),
            mo.Membership(mo.MembershipKind.MANUAL_FETCH, other, frozenset({'tok-a'})))))
        self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
        self.assertReasons(verdict, mo.Reason.AMBIGUOUS_OWNERSHIP)

    def test_two_claims_with_different_delivery_ids_are_unavailable(self):
        verdict = self.verdict(self.snap(claims=(
            mo.Claim(frozenset({'tok-a'}), delivery_id='d-1'),
            mo.Claim(frozenset({'tok-a'}), delivery_id='d-2'))))
        self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
        self.assertReasons(verdict, mo.Reason.CLAIM_CONFLICT)

    def test_a_claim_without_a_delivery_id_is_unresolved_not_expired(self):
        for broken in (None, '', 0, False, 5):
            with self.subTest(delivery_id=repr(broken)):
                verdict = self.verdict(self.snap(claims=(
                    mo.Claim(frozenset({'tok-a'}), delivery_id=broken),)))
                self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
                self.assertReasons(verdict, mo.Reason.CLAIM_UNRESOLVED)

    def test_a_malformed_lease_expiry_is_unresolved_not_expired(self):
        for broken in (None, 'soon', '', [], {}):
            with self.subTest(expires_at=repr(broken)):
                verdict = self.verdict(self.snap(leases=(
                    mo.Lease(frozenset({'tok-a'}), expires_at=broken),)))
                self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
                self.assertReasons(verdict, mo.Reason.LEASE_UNRESOLVED)

    def test_the_bare_legacy_drive_lease_blocks_reclaim_without_naming_an_owner(self):
        """Rule 4's two halves, kept apart. The flag is not proof of THIS
        token's owner, and it is also not permission to take the token
        anyway. One field carries each half."""
        result = mo.classify(self.snap(
            batches=(self.batch('tok-a'), self.batch('tok-b')),
            leases=(mo.Lease(tokens=mo.Gap.ABSENT),)))
        for token in ('tok-a', 'tok-b'):
            verdict = result.by_token[token]
            self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
            self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
            self.assertReasons(verdict, mo.Reason.LEASE_WITHOUT_TOKEN_MEMBERSHIP)

    def test_an_unreadable_token_list_protects_every_batch(self):
        """A carrier whose token list has a `None` in it is not a carrier
        whose tokens are known — so it might be holding any of them."""
        result = mo.classify(self.snap(
            batches=(self.batch('tok-a'), self.batch('tok-b')),
            memberships=(mo.Membership(mo.MembershipKind.TURN, CURRENT,
                                       ['tok-a', None]),)))
        for token in ('tok-a', 'tok-b'):
            self.assertIs(result.by_token[token].disposition, mo.Disposition.PROTECTED)
            self.assertIs(result.by_token[token].owner, mo.OwnerEvidence.UNPROVEN)

    def test_a_mode_label_is_not_a_carrier(self):
        """The old `manual_fetch && responding` rule, declined by name."""
        verdict = self.verdict(self.snap(
            batches=(self.batch(mode='manual_fetch'),),
            activity=mo.NodeActivity(responding=True)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertReasons(verdict, mo.Reason.MODE_LABEL_ONLY)

    def test_every_reason_that_applies_is_reported_not_just_the_first(self):
        verdict = self.verdict(self.snap(
            batches=(self.batch(at=YOUNG, mode='manual_fetch'),),
            carriers=(mo.CarrierHold(mo.CarrierKind.QUEUE, frozenset({'tok-a'}), live=True),),
            retentions=(mo.Retention(mo.RetentionKind.HALT, frozenset({'tok-a'})),),
            confirmations={'tok-a': mo.Confirmation.IN_FLIGHT}))
        self.assertReasons(verdict, mo.Reason.QUEUE_CARRIER_LIVE, mo.Reason.HALT_HELD,
                           mo.Reason.CONFIRMATION_IN_FLIGHT, mo.Reason.WITHIN_DRAIN_GRACE)


class AWholeBatchIsTheUnit(Case):
    """Rule 8."""

    def populated(self):
        return self.snap(batches=(
            self.batch('tok-a', message_ids=('m-1', 'm-2', 'm-3')),
            self.batch('tok-b', at=YOUNG, message_ids=('m-4', 'm-5'))))

    def test_naming_one_message_reaches_its_whole_batch(self):
        selection = mo.select(self.populated(), ['m-1'])
        self.assertEqual({v.token for v in selection.verdicts}, {'tok-a'})
        self.assertEqual(selection.reclaimable_tokens, frozenset({'tok-a'}))
        self.assertEqual(selection.partial_batches, frozenset({'tok-a'}))

    def test_naming_one_message_of_a_protected_batch_frees_no_sibling(self):
        selection = mo.select(self.populated(), ['m-4'])
        self.assertEqual(selection.reclaimable_tokens, frozenset())
        self.assertIs(selection.verdicts[0].disposition, mo.Disposition.PROTECTED)
        self.assertEqual(selection.partial_batches, frozenset({'tok-b'}))

    def test_naming_every_message_of_a_batch_is_not_partial(self):
        selection = mo.select(self.populated(), ['m-1', 'm-2', 'm-3'])
        self.assertEqual(selection.partial_batches, frozenset())
        self.assertEqual(selection.reclaimable_tokens, frozenset({'tok-a'}))

    def test_an_unknown_message_is_reported_not_dropped(self):
        selection = mo.select(self.populated(), ['m-1', 'm-99'])
        self.assertEqual(selection.unresolved_messages, ('m-99',))
        self.assertEqual(selection.requested, ('m-1', 'm-99'))

    def test_an_unhashable_message_id_does_not_take_the_request_down(self):
        """It is reported as an UNSUPPORTED identity, which is a different
        statement from "no such row" — see `AMessageIdentityIsCompared`."""
        selection = mo.select(self.populated(), [['m-1']])
        self.assertEqual(selection.unsupported_messages, (['m-1'],))
        self.assertEqual(selection.unresolved_messages, ())


class APureFunctionStaysPure(Case):
    """The property the whole slice rests on, checked rather than asserted in
    prose."""

    def rich(self):
        return self.snap(
            batches=(self.batch('tok-a', message_ids=('m-1',)), self.batch('tok-b', at=YOUNG)),
            memberships=(mo.Membership(mo.MembershipKind.TURN, CURRENT, frozenset({'tok-a'})),),
            carriers=(mo.CarrierHold(mo.CarrierKind.STEER, frozenset({'tok-b'}), live=True),),
            claims=(mo.Claim(frozenset({'tok-b'}), delivery_id='d-1'),),
            leases=(mo.Lease(frozenset({'tok-a'}), expires_at=iso(NOW + 5.0)),),
            retentions=(mo.Retention(mo.RetentionKind.NATIVE, frozenset({'tok-b'})),),
            confirmations={'tok-a': mo.Confirmation.NONE},
            activity=mo.NodeActivity(busy=True))

    def test_the_snapshot_is_unchanged_by_classification(self):
        """Compared by `repr` rather than by a deep copy: since the input
        boundary resolves every collection at construction, a snapshot holds a
        `mappingproxy`, and `copy.deepcopy` cannot copy one. That is the
        immutability doing its job, so the check reads the whole structure
        instead of duplicating it."""
        snapshot = self.rich()
        before = repr(snapshot)
        mo.classify(snapshot)
        mo.select(snapshot, ['m-1'])
        self.assertEqual(repr(snapshot), before)

    def test_the_same_snapshot_classifies_identically_every_time(self):
        snapshot = self.rich()
        first, second = mo.classify(snapshot), mo.classify(snapshot)
        self.assertEqual(first.verdicts, second.verdicts)

    def test_the_module_imports_no_sibling_and_reaches_for_no_clock(self):
        forbidden = ('time', 'uuid', 'os', 'random', 'store', 'ledger',
                     'supervisor', 'halt', 'schema', 'maildrain', 'events')
        present = sorted(name for name in vars(mo) if name in forbidden)
        self.assertEqual(present, [], f'the classifier is not a leaf: {present}')
        pulled = sorted(name for name in sys.modules
                        if name.startswith('orgtree.') and name != 'orgtree.mailownership')
        self.assertEqual(pulled, [], f'importing it pulled in {pulled}')

    def test_the_results_are_immutable(self):
        verdict = self.verdict(self.rich())
        with self.assertRaises(dataclasses.FrozenInstanceError):
            verdict.disposition = mo.Disposition.ELIGIBLE      # type: ignore[misc]
        with self.assertRaises(TypeError):
            mo.classify(self.rich()).by_token['x'] = verdict   # type: ignore[index]

    def test_reclaimable_is_eligible_and_nothing_else(self):
        """Swept across the whole matrix: no input combination produces a
        reclaimable verdict from any other disposition."""
        for verdict in self._every_verdict():
            self.assertEqual(verdict.reclaimable,
                             verdict.disposition is mo.Disposition.ELIGIBLE)

    def _every_verdict(self):
        out = []
        variants = (
            {},
            dict(memberships=(mo.Membership(mo.MembershipKind.TURN, CURRENT,
                                            frozenset({'tok-a'})),)),
            dict(carriers=(mo.CarrierHold(mo.CarrierKind.QUEUE, frozenset({'tok-a'}),
                                          live=mo.Gap.UNKNOWN),)),
            dict(claims=(mo.Claim(frozenset({'tok-a'}), delivery_id=None),)),
            dict(leases=(mo.Lease(tokens=mo.Gap.ABSENT),)),
            dict(retentions=(mo.Retention(mo.RetentionKind.HALT, frozenset({'tok-a'})),)),
            dict(confirmations={'tok-a': mo.Confirmation.UNKNOWN}),
            dict(current=mo.CustodyRef()),
        )
        for variant in variants:
            for stamp in (OLD, YOUNG, None, 'junk'):
                snapshot = self.snap(batches=(self.batch(at=stamp),), **variant)
                out.extend(mo.classify(snapshot).verdicts)
        return out


class TheFrozenSourceWitness(Case):
    """The nine `source-evidence.json` observations, each replayed against the
    classifier, each stating in its own assertion whether the answer moved."""

    def replay(self, name, **kw):
        snapshot = self.snap(**kw)
        verdict = mo.classify(snapshot).by_token['tok-a']
        stage, diverges = FROZEN_WITNESS[name]
        self.assertIn(stage, ('turn', 'steer', 'queued', 'stranded', 'requested'))
        return verdict, stage, diverges

    def test_busy_and_responding_orphans_diverge_from_the_frozen_stage(self):
        for name, activity in (
                ('busy_unrelated_old_orphan', mo.NodeActivity(busy=True)),
                ('responding_unrelated_old_orphan', mo.NodeActivity(responding=True))):
            with self.subTest(case=name):
                verdict, stage, diverges = self.replay(name, activity=activity)
                self.assertTrue(diverges)
                self.assertEqual(stage, 'steer')          # what the source says today
                self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)

    def test_a_bare_attempt_token_list_is_not_a_current_turn(self):
        """`live_turn_tokens_old`. The source reads `owned` and `via`; the
        token list it is named for is not consulted by `_delivery_stages` at
        all, and on its own it is not the matching tuple either."""
        verdict, stage, diverges = self.replay(
            'live_turn_tokens_old',
            batches=(self.batch(mode='turn'),),
            activity=mo.NodeActivity(responding=True))
        self.assertTrue(diverges)
        self.assertEqual(stage, 'turn')
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)

        # ...and with the complete tuple supplied, it is protected — which is
        # the whole difference the later runtime slice has to actually build.
        owned = self.verdict(self.snap(
            batches=(self.batch(mode='turn'),),
            memberships=(mo.Membership(mo.MembershipKind.TURN, CURRENT,
                                       frozenset({'tok-a'})),)))
        self.assertIs(owned.disposition, mo.Disposition.PROTECTED)

    def test_the_manual_mode_label_diverges(self):
        verdict, stage, diverges = self.replay(
            'manual_mode_with_unrelated_response',
            batches=(self.batch(mode='manual_fetch'),),
            activity=mo.NodeActivity(responding=True))
        self.assertTrue(diverges)
        self.assertEqual(stage, 'steer')
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertReasons(verdict, mo.Reason.MODE_LABEL_ONLY)

    def test_the_five_agreeing_witnesses_still_agree(self):
        agreed = {
            'queue_without_live_consumer': (
                dict(carriers=(mo.CarrierHold(mo.CarrierKind.QUEUE,
                                              frozenset({'tok-a'}), live=False),)),
                mo.Disposition.ELIGIBLE),
            'queue_with_live_consumer': (
                dict(carriers=(mo.CarrierHold(mo.CarrierKind.QUEUE,
                                              frozenset({'tok-a'}), live=True),),
                     activity=mo.NodeActivity(busy=True)),
                mo.Disposition.PROTECTED),
            'young_unowned': (dict(batches=(self.batch(at=YOUNG),)), mo.Disposition.PROTECTED),
            'idle_old_orphan': ({}, mo.Disposition.ELIGIBLE),
            'lease_boolean_without_membership': (
                dict(leases=(mo.Lease(tokens=mo.Gap.ABSENT),)), mo.Disposition.PROTECTED),
        }
        for name, (kw, expected) in agreed.items():
            with self.subTest(case=name):
                verdict, _stage, diverges = self.replay(name, **kw)
                self.assertFalse(diverges)
                self.assertIs(verdict.disposition, expected)

    def test_all_nine_witnesses_are_covered(self):
        self.assertEqual(len(FROZEN_WITNESS), 9)


class OnlyTheRuntimeAdapterCallsThis(Case):
    """The runtime batch's boundary. M0b shipped the classifier with no live
    reader; the runtime ownership batch activates exactly one production
    consumer, the `mailruntime` adapter, and every other module reaches the
    classifier only through it. A second direct importer would be a second
    place deciding custody, which is what the shared resolver exists to
    prevent."""

    def test_the_runtime_adapter_is_the_only_production_importer(self):
        roots = [CHECKOUT / 'engine', CHECKOUT / 'tools']
        callers = []
        for root in roots:
            if not root.exists():
                continue
            for path in root.rglob('*.py'):
                if path.name == 'mailownership.py':
                    continue
                text = path.read_text(encoding='utf-8', errors='replace')
                if 'mailownership' in text:
                    callers.append(str(path.relative_to(CHECKOUT)).replace('\\', '/'))
        self.assertEqual(sorted(callers), ['engine/backend/orgtree/mailruntime.py'],
                         'only the runtime adapter may consume the classifier')

    def test_test_readers_are_the_classifier_and_adapter_suites(self):
        tests = CHECKOUT / 'tests'
        readers = sorted(p.name for p in tests.rglob('*.py')
                         if 'mailownership' in p.read_text(encoding='utf-8', errors='replace'))
        self.assertEqual(readers, ['test_mail_ownership.py',
                                   'test_mail_runtime_ownership.py'])


class UnreadableCustodyStillHolds(Case):
    """Owner preflight, finding 1. A claim whose token membership cannot be
    read is a claim that might be holding this token, and skipping it made a
    valid old batch reclaimable — the exact outcome rule 4 forbids.

    The two controls at the bottom are what keep this from degenerating into
    "any claim protects everything": a claim that names an empty set, and one
    that names somebody else's token, still protect nothing."""

    UNREADABLE = {
        'gap-unknown': mo.Gap.UNKNOWN,
        'gap-unsupported': mo.Gap.UNSUPPORTED,
        'present-null': None,
        'bool': False,
        'scalar-string': 'tok-a',          # a string is one value, not an iterable of tokens
        'one-invalid-entry': ('tok-a', None),
    }

    def test_a_claim_with_an_unreadable_token_list_protects_every_batch(self):
        for label, value in self.UNREADABLE.items():
            with self.subTest(tokens=label):
                result = mo.classify(self.snap(
                    batches=(self.batch('tok-a'), self.batch('tok-b')),
                    claims=(mo.Claim(tokens=value, delivery_id='d-1'),)))
                for token in ('tok-a', 'tok-b'):
                    verdict = result.by_token[token]
                    self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                    self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
                    self.assertFalse(verdict.reclaimable)

    def test_absent_and_unreadable_claim_membership_are_reported_apart(self):
        absent = self.verdict(self.snap(claims=(mo.Claim(tokens=None, delivery_id='d-1'),)))
        self.assertReasons(absent, mo.Reason.CLAIM_WITHOUT_TOKEN_MEMBERSHIP)

        unreadable = self.verdict(self.snap(
            claims=(mo.Claim(tokens=mo.Gap.UNSUPPORTED, delivery_id='d-1'),)))
        self.assertReasons(unreadable, mo.Reason.CLAIM_UNRESOLVED)

    def test_an_unreadable_carrier_or_retention_says_which_it_was(self):
        carrier = self.verdict(self.snap(carriers=(
            mo.CarrierHold(mo.CarrierKind.QUEUE, tokens=None, live=True),)))
        self.assertIs(carrier.disposition, mo.Disposition.PROTECTED)
        self.assertReasons(carrier, mo.Reason.CARRIER_TOKENS_UNRESOLVED)

        retention = self.verdict(self.snap(retentions=(
            mo.Retention(mo.RetentionKind.HALT, tokens=('tok-a', None)),)))
        self.assertIs(retention.disposition, mo.Disposition.PROTECTED)
        self.assertReasons(retention, mo.Reason.RETENTION_TOKENS_UNRESOLVED)
        self.assertFalse(retention.retained_carrier,
                         'which tokens are retained is exactly what is unreadable')

    def test_a_claim_naming_no_tokens_protects_nothing(self):
        verdict = self.verdict(self.snap(
            claims=(mo.Claim(tokens=frozenset(), delivery_id='d-1'),)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)

    def test_a_claim_naming_another_token_protects_nothing(self):
        verdict = self.verdict(self.snap(
            claims=(mo.Claim(tokens=frozenset({'somebody-else'}), delivery_id='d-1'),)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)


class TheHolderIsNotAlwaysTheAskingTurn(Case):
    """Owner preflight, the diagnostics finding. A durable claim carrying a
    complete tuple from a session that has ended still protects its tokens —
    and reporting that as `proven` said the batch belonged to the very turn
    asking about it."""

    def claim_owned_by(self, holder):
        return self.verdict(self.snap(claims=(
            mo.Claim(frozenset({'tok-a'}), delivery_id='d-1', owner=holder),)))

    def test_a_matching_holder_is_proven(self):
        verdict = self.claim_owned_by(CURRENT)
        self.assertIs(verdict.owner, mo.OwnerEvidence.PROVEN)
        self.assertNotIn(mo.Reason.OWNER_RESOLVED_ELSEWHERE, verdict.reasons)

    def test_a_stale_or_foreign_holder_is_resolved_elsewhere(self):
        for label, holder in (
                ('stale', mo.CustodyRef('mb-worker', 2, 'sess-6', 'turn-41')),
                ('foreign', mo.CustodyRef('mb-other', 3, 'sess-7', 'turn-42'))):
            with self.subTest(holder=label):
                verdict = self.claim_owned_by(holder)
                self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                self.assertIs(verdict.owner, mo.OwnerEvidence.RESOLVED_ELSEWHERE)
                self.assertReasons(verdict, mo.Reason.OWNER_RESOLVED_ELSEWHERE)

    def test_an_unnamed_or_unreadable_holder_stays_unproven(self):
        for holder in (None, mo.CustodyRef(), mo.CustodyRef('mb-worker', True, 's', 't')):
            with self.subTest(holder=repr(holder)):
                self.assertIs(self.claim_owned_by(holder).owner,
                              mo.OwnerEvidence.UNPROVEN)

    def test_a_proven_holder_is_not_downgraded_by_an_unresolved_one_beside_it(self):
        verdict = self.verdict(self.snap(
            memberships=(mo.Membership(mo.MembershipKind.TURN, CURRENT,
                                       frozenset({'tok-a'})),),
            leases=(mo.Lease(tokens=mo.Gap.ABSENT),)))
        self.assertIs(verdict.owner, mo.OwnerEvidence.PROVEN)


class TheInputBoundaryIsImmutable(Case):
    """Owner preflight, finding 2. `frozen=True` freezes the dataclass's own
    attributes and says nothing about what they point at, so a snapshot could
    hold a one-shot iterator or a list the caller still owned. Evidence that
    can be spent by reading it, or edited after it was submitted, is not
    evidence: the same snapshot answered PROTECTED and then ELIGIBLE."""

    def member(self, tokens):
        return mo.Membership(mo.MembershipKind.TURN, CURRENT, tokens)

    def test_a_one_shot_iterator_is_not_spent_by_the_first_classification(self):
        snapshot = self.snap(memberships=(self.member(iter(['tok-a'])),))
        first, second = self.verdict(snapshot), self.verdict(snapshot)
        self.assertIs(first.disposition, mo.Disposition.PROTECTED)
        self.assertEqual(first, second)

    def test_editing_the_list_afterwards_cannot_change_the_answer(self):
        tokens = ['tok-a']
        snapshot = self.snap(memberships=(self.member(tokens),))
        first = self.verdict(snapshot)
        tokens.clear()
        tokens.append('something-else')
        self.assertEqual(self.verdict(snapshot), first)

    def test_every_token_collection_is_taken_by_value(self):
        for label, build in (
                ('membership', lambda t: dict(memberships=(self.member(t),))),
                ('carrier', lambda t: dict(carriers=(
                    mo.CarrierHold(mo.CarrierKind.QUEUE, t, live=True),))),
                ('claim', lambda t: dict(claims=(mo.Claim(t, delivery_id='d-1'),))),
                ('lease', lambda t: dict(leases=(
                    mo.Lease(t, expires_at=iso(NOW + 30.0)),))),
                ('retention', lambda t: dict(retentions=(
                    mo.Retention(mo.RetentionKind.HALT, t),))),
        ):
            with self.subTest(record=label):
                tokens = ['tok-a']
                snapshot = self.snap(**build(tokens))
                first = self.verdict(snapshot)
                self.assertIs(first.disposition, mo.Disposition.PROTECTED)
                tokens.clear()
                self.assertEqual(self.verdict(snapshot), first)

    def test_a_generator_of_batches_survives_being_classified_twice(self):
        snapshot = self.snap(batches=iter([self.batch('tok-a')]))
        self.assertEqual(mo.classify(snapshot).verdicts,
                         mo.classify(snapshot).verdicts)
        self.assertEqual(len(mo.classify(snapshot).verdicts), 1)

    def test_the_confirmation_map_is_copied_not_aliased(self):
        confirmations = {'tok-a': mo.Confirmation.IN_FLIGHT}
        snapshot = self.snap(confirmations=confirmations)
        first = self.verdict(snapshot)
        confirmations.clear()
        self.assertEqual(self.verdict(snapshot), first)

    def test_a_resolved_token_set_is_what_the_record_stores(self):
        """The resolution happens once, at construction, so every rule reads
        the same answer instead of each re-deriving it."""
        self.assertEqual(mo.Claim(tokens=['a', 'b']).tokens, frozenset({'a', 'b'}))
        self.assertIs(mo.Claim(tokens='a').tokens, mo.Gap.UNSUPPORTED)
        self.assertIs(mo.Claim(tokens=None).tokens, mo.Gap.ABSENT)


class TheClockIsEvidenceToo(Case):
    """Owner preflight, finding 3. Every ordering comparison against NaN is
    False, so a NaN clock silently reported that no grace was left and that
    every lease had expired — an unreadable clock arguing for reclaim."""

    UNSUPPORTED = {'nan': float('nan'), 'infinity': float('inf'),
                   'negative-infinity': float('-inf'), 'null': None,
                   'bool': True, 'text': '2026-09-22T00:00:00+00:00', 'list': []}

    def test_an_unreadable_clock_refuses_instead_of_expiring_things(self):
        for label, value in self.UNSUPPORTED.items():
            with self.subTest(now=label):
                verdict = self.verdict(self.snap(now=value))
                self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
                self.assertFalse(verdict.reclaimable)
                self.assertIsNone(verdict.grace_remaining)
                self.assertReasons(verdict, mo.Reason.CLOCK_UNSUPPORTED)

    def test_an_unreadable_clock_does_not_expire_a_lease(self):
        verdict = self.verdict(self.snap(
            now=float('nan'),
            leases=(mo.Lease(frozenset({'tok-a'}), expires_at=iso(NOW - 30.0)),)))
        self.assertReasons(verdict, mo.Reason.LEASE_UNRESOLVED)
        self.assertNotIn(mo.Reason.LEASE_EXPIRED, verdict.reasons)

    def test_an_unreadable_clock_never_raises(self):
        for value in self.UNSUPPORTED.values():
            with self.subTest(now=repr(value)):
                mo.classify(self.snap(now=value))
                mo.select(self.snap(now=value), ['m-1'])

    def test_a_finite_instant_is_still_accepted_as_an_int_or_a_float(self):
        for value in (NOW, int(NOW), 0, 0.0):
            with self.subTest(now=value):
                self.assertNotIn(mo.Reason.CLOCK_UNSUPPORTED,
                                 self.verdict(self.snap(now=value)).reasons)


#: Classify one frozen snapshot in a CHILD whose CRT timezone has been set,
#: and report what came back. It runs in a child on purpose: the thing under
#: test is a process-global, and a suite that set its own would leak the
#: setting into every test that ran after it if a restore ever failed. The
#: child restores in a `finally` anyway, and then exits.
_TZ_CHILD = r'''
import ctypes, json, os, sys, time

tz, backend = sys.argv[1], sys.argv[2]
previous = os.environ.get('TZ')


def apply(value):
    if value is None:
        os.environ.pop('TZ', None)
    else:
        os.environ['TZ'] = value
    if hasattr(time, 'tzset'):
        time.tzset()
    else:
        crt = ctypes.CDLL('msvcrt', use_errno=True)
        crt._putenv_s(b'TZ', (value or '').encode('ascii'))
        crt._tzset()


try:
    apply(tz)
    sys.path.insert(0, backend)
    from orgtree import mailownership as mo

    current = mo.CustodyRef(mailbox_id='mb', generation=3,
                            session='sess', turn_token='turn')
    batch = mo.JournalBatch(token='tok', drained_at='2026-09-22T11:59:30+00:00',
                            mode='steer', message_ids=('good',))
    out = {}
    for label, expiry in (('lease_naive', '2026-09-22T13:00:00'),
                          ('lease_aware_utc', '2026-09-22T13:00:00+00:00'),
                          ('lease_aware_offset', '2026-09-22T22:00:00+09:00')):
        snap = mo.OwnershipSnapshot(
            current=current, now=1790078400.0, batches=(batch,),
            leases=(mo.Lease(tokens=['tok'], expires_at=expiry, owner=current),))
        first = mo.classify(snap).by_token['tok']
        again = mo.classify(snap).by_token['tok']
        out[label] = {
            'disposition': first.disposition.value,
            'owner': first.owner.value,
            'reasons': [r.value for r in first.reasons],
            'reclaimable': first.reclaimable,
            'select': sorted(mo.select(snap, ['good']).reclaimable_tokens),
            'repeat_identical': (first.disposition is again.disposition
                                 and first.reasons == again.reasons),
            'snapshot_repr': repr(snap),
        }
    for label, stamp in (('drain_naive', '2026-09-22T11:59:55'),
                         ('drain_aware', '2026-09-22T11:59:55+00:00')):
        snap = mo.OwnershipSnapshot(
            current=current, now=1790078400.0,
            batches=(mo.JournalBatch(token='tok', drained_at=stamp, mode='steer',
                                     message_ids=('good',)),))
        verdict = mo.classify(snap).by_token['tok']
        out[label] = {'disposition': verdict.disposition.value,
                      'reasons': [r.value for r in verdict.reasons],
                      'grace_remaining': verdict.grace_remaining}
    sys.stdout.write(json.dumps(out, sort_keys=True))
finally:
    apply(previous)
'''

TZ_SETTINGS = ('UTC0', 'JST-9', 'EST5')


class AnAmbientSettingIsNotEvidence(Case):
    """Review finding f4. `_instant` read a timezone-free stamp through
    `.timestamp()`, which resolves it in the PROCESS timezone. One frozen
    snapshot therefore classified a lease as held under `TZ=UTC0` and as
    EXPIRED — reclaimable, owner none — under `TZ=JST-9`, with the snapshot
    byte-identical throughout. A destructive permission was being decided by an
    environment variable.

    The correction is to require a stated offset, so the classifier refuses to
    resolve what it was not told. What a refusal MEANS was already settled for
    an unreadable stamp and is unchanged: an unresolved lease stays protected
    and unproven, and an unresolved drain stamp is "not young", exactly as
    `_batch_is_young` already treats one. No new grace policy is introduced."""

    def child(self, tz):
        backend = str(CHECKOUT / 'engine/backend')
        proc = subprocess.run(
            [sys.executable, '-c', _TZ_CHILD, tz, backend],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0,
                         f'tz child {tz} failed: {proc.stdout}\n{proc.stderr}')
        return json.loads(proc.stdout)

    def test_one_frozen_snapshot_classifies_identically_in_three_timezones(self):
        results = {tz: self.child(tz) for tz in TZ_SETTINGS}
        baseline = results[TZ_SETTINGS[0]]
        for case in baseline:
            with self.subTest(case=case):
                for tz in TZ_SETTINGS[1:]:
                    self.assertEqual(
                        results[tz][case], baseline[case],
                        f'{case} moved between TZ={TZ_SETTINGS[0]} and TZ={tz}')

    def test_the_snapshot_is_the_same_snapshot_in_every_timezone(self):
        """The control that makes the test above mean something: if the input
        itself changed with the timezone, identical verdicts would prove
        nothing about the classifier."""
        reprs = {self.child(tz)['lease_naive']['snapshot_repr']
                 for tz in TZ_SETTINGS}
        self.assertEqual(len(reprs), 1)

    def test_the_timezone_free_lease_is_protected_and_never_expired(self):
        """Direction matters. Agreeing on ELIGIBLE in all three zones would
        also be timezone-independent, and would be the dangerous answer."""
        for tz in TZ_SETTINGS:
            with self.subTest(tz=tz):
                case = self.child(tz)['lease_naive']
                self.assertEqual(case['disposition'], 'protected')
                self.assertEqual(case['owner'], 'unproven')
                self.assertIn('lease_unresolved', case['reasons'])
                self.assertNotIn('lease_expired', case['reasons'])
                self.assertFalse(case['reclaimable'])
                self.assertEqual(case['select'], [])
                self.assertTrue(case['repeat_identical'])

    def test_a_stated_offset_is_still_read_and_still_expires(self):
        """The refusal is not a blanket one. A lease that says where it is
        keeps working, from any offset, in any process timezone."""
        for tz in TZ_SETTINGS:
            with self.subTest(tz=tz):
                result = self.child(tz)
                for case in ('lease_aware_utc', 'lease_aware_offset'):
                    self.assertEqual(result[case]['disposition'], 'protected')
                    self.assertIn('lease_held', result[case]['reasons'])
                    self.assertEqual(result[case]['owner'], 'proven')
                self.assertEqual(result['drain_aware']['disposition'], 'protected')
                self.assertIn('within_drain_grace', result['drain_aware']['reasons'])

    # --- the same domain, asserted without spawning anything ---------------

    def test_a_timezone_free_lease_expiry_is_unresolved_not_expired(self):
        verdict = self.verdict(self.snap(leases=(
            mo.Lease(tokens=['tok-a'], expires_at='2026-09-22T13:00:00',
                     owner=CURRENT),)))
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertIs(verdict.owner, mo.OwnerEvidence.UNPROVEN)
        self.assertReasons(verdict, mo.Reason.LEASE_UNRESOLVED)
        self.assertNotIn(mo.Reason.LEASE_EXPIRED, verdict.reasons)

    def test_a_timezone_free_drain_stamp_keeps_the_not_young_answer(self):
        """`_batch_is_young` calls a stamp it cannot read "not young". An
        unresolved stamp is unreadable, so it gets that same answer — this is
        the existing characterisation, not a new grace."""
        verdict = self.verdict(self.snap(batches=(
            self.batch(at=iso(NOW - 1.0).replace('+00:00', '')),)))
        self.assertIs(verdict.disposition, mo.Disposition.ELIGIBLE)
        self.assertIsNone(verdict.grace_remaining)
        self.assertReasons(verdict, mo.Reason.GRACE_STAMP_UNREADABLE)
        self.assertNotIn(mo.Reason.WITHIN_DRAIN_GRACE, verdict.reasons)

    def test_the_offset_is_what_is_required_not_a_particular_zone(self):
        """Two spellings of one instant classify the same, and a third that
        genuinely is an hour later classifies differently. The rule is that the
        stamp states its offset, not that the offset is zero."""
        for expiry in ('2026-09-22T13:00:00+00:00', '2026-09-22T13:00:00Z',
                       '2026-09-22T22:00:00+09:00', '2026-09-22T08:00:00-05:00'):
            with self.subTest(expiry=expiry):
                verdict = self.verdict(self.snap(
                    now=1_790_078_400.0,
                    leases=(mo.Lease(tokens=['tok-a'], expires_at=expiry,
                                     owner=CURRENT),)))
                self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
                self.assertReasons(verdict, mo.Reason.LEASE_HELD)

        past = self.verdict(self.snap(
            now=1_790_078_400.0,
            leases=(mo.Lease(tokens=['tok-a'], expires_at='2026-09-22T11:00:00+00:00',
                             owner=CURRENT),)))
        self.assertReasons(past, mo.Reason.LEASE_EXPIRED)

    def test_the_expiry_boundary_is_unmoved(self):
        """`clock < expiry`, exactly as before: an expiry equal to now has
        passed. The f4 fix changed the DOMAIN of the stamp, not the comparison
        made with it."""
        at_boundary = self.verdict(self.snap(
            now=1_790_078_400.0,
            leases=(mo.Lease(tokens=['tok-a'],
                             expires_at='2026-09-22T12:00:00+00:00',
                             owner=CURRENT),)))
        self.assertReasons(at_boundary, mo.Reason.LEASE_EXPIRED)

        just_ahead = self.verdict(self.snap(
            now=1_790_078_400.0,
            leases=(mo.Lease(tokens=['tok-a'],
                             expires_at='2026-09-22T12:00:01+00:00',
                             owner=CURRENT),)))
        self.assertReasons(just_ahead, mo.Reason.LEASE_HELD)

    def test_the_instant_domain_refuses_only_what_it_cannot_resolve(self):
        """`_instant` directly, because the reason codes above are two layers
        of interpretation away from the domain that actually moved."""
        self.assertIs(mo._instant(None), mo.Gap.ABSENT)
        for unsupported in ('2026-09-22T13:00:00', 'not-a-date', '', 0, False,
                            [], 17, {'at': 1}):
            with self.subTest(value=repr(unsupported)):
                self.assertIs(mo._instant(unsupported), mo.Gap.UNSUPPORTED)
        for supported in ('2026-09-22T12:00:00+00:00', '2026-09-22T12:00:00Z',
                          '2026-09-22T21:00:00+09:00'):
            with self.subTest(value=supported):
                self.assertEqual(mo._instant(supported), 1_790_078_400.0)

    def test_the_classifier_still_reads_no_clock_of_its_own(self):
        """f4 was an ambient read. The module-level check that no wall clock is
        reachable is in `APureFunctionStaysPure`; this one states the narrower
        fact that the fix did not smuggle a timezone in to compensate."""
        source = (CHECKOUT / 'engine/backend/orgtree/mailownership.py').read_text(
            encoding='utf-8', errors='strict')
        body = source.split('"""', 2)[2]    # past the module docstring
        for forbidden in ('astimezone(', 'tzlocal', 'localtime', 'time.time(',
                          'datetime.now(', 'utcnow('):
            self.assertNotIn(forbidden, body,
                             f'{forbidden} reaches for an ambient time source')


class AMessageIdentityIsCompared(Case):
    """Owner preflight, finding 4. `select` fell back to `repr()` for an
    unhashable id, so a stored `[]` and a requested `'[]'` became the same
    message and a request naming a string reclaimed a batch whose identity was
    a list. Identity is now compared, never coerced."""

    def test_a_stored_and_a_requested_value_of_different_types_never_alias(self):
        snapshot = self.snap(batches=(self.batch('tok-a', message_ids=([],)),))
        selection = mo.select(snapshot, ('[]',))
        self.assertEqual(selection.reclaimable_tokens, frozenset())
        self.assertEqual(selection.unresolved_messages, ('[]',))

    def test_a_batch_with_an_unreadable_identity_is_named_and_not_reclaimable(self):
        snapshot = self.snap(batches=(
            self.batch('tok-a', message_ids=('m-1', 17)),))
        selection = mo.select(snapshot, ['m-1'])
        self.assertEqual(selection.unreadable_identity_batches, frozenset({'tok-a'}))
        self.assertEqual(selection.reclaimable_tokens, frozenset())
        self.assertIn('tok-a', selection.partial_batches)
        self.assertReasons(self.verdict(snapshot),
                           mo.Reason.UNSUPPORTED_MESSAGE_IDENTITY)


class OneRefusalNotTwoOpinions(Case):
    """Review finding f3. An unsupported stored message identity was a
    diagnostic and nothing more, so `classify` returned ELIGIBLE for a batch
    that `select` refused through its own unreadable set — two exported answers
    disagreeing about one permission, and the primary classifier held the more
    permissive one. The refusal now lives in the shared verdict, so all four
    answers come from the same place.

    The eight stored values below are the reviewer's reproduction. They are
    written out rather than generated because each is a distinct way a stored
    id can be present and unreadable, and a loop over a list nobody reads is
    how a case quietly stops being covered."""

    MALFORMED = (17, None, False, 0, '', [], {}, ['m-1'])

    def snapshot_with(self, stored):
        return self.snap(batches=(
            self.batch('tok-a', message_ids=('m-1', stored)),))

    def test_every_malformed_identity_is_refused_by_all_four_answers(self):
        for stored in self.MALFORMED:
            with self.subTest(stored=repr(stored)):
                snapshot = self.snapshot_with(stored)
                result = mo.classify(snapshot)
                verdict = result.by_token['tok-a']
                selection = mo.select(snapshot, ['m-1'])

                # 1. the per-batch verdict
                self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
                self.assertFalse(verdict.reclaimable)
                self.assertReasons(verdict, mo.Reason.UNSUPPORTED_MESSAGE_IDENTITY)
                # 2. the aggregate the verdict feeds
                self.assertEqual(result.reclaimable_tokens, frozenset())
                # 3. the selector's own answer
                self.assertEqual(selection.reclaimable_tokens, frozenset())
                # 4. and the verdict the selector hands back inside it, which
                #    is the one that used to say the opposite
                self.assertTrue(selection.verdicts)
                for embedded in selection.verdicts:
                    self.assertFalse(embedded.reclaimable)

    def test_the_residual_eligible_marker_stops_firing_when_it_stops_being_true(self):
        """`UNOWNED_PAST_GRACE` means "nothing holds this and it may be taken".
        On a batch that may NOT be taken it would be a false statement, so it
        goes — the same way it already goes for an unsupported token. Every
        EVIDENCE reason is untouched; only the disposition marker moves."""
        verdict = self.verdict(self.snapshot_with(17))
        self.assertNotIn(mo.Reason.UNOWNED_PAST_GRACE, verdict.reasons)

    def test_the_refusal_does_not_silence_the_evidence(self):
        """Integrity outranks a holder here, as it already did for a bad token.
        The holder is still reported, because the reasons say what is true
        about the batch and not merely what decided its disposition."""
        snapshot = self.snap(
            batches=(self.batch('tok-a', message_ids=('m-1', 17)),),
            retentions=(mo.Retention(kind=mo.RetentionKind.HALT,
                                     tokens=frozenset({'tok-a'})),))
        verdict = self.verdict(snapshot)
        self.assertIs(verdict.disposition, mo.Disposition.UNAVAILABLE)
        self.assertReasons(verdict, mo.Reason.HALT_HELD,
                           mo.Reason.UNSUPPORTED_MESSAGE_IDENTITY)
        self.assertTrue(verdict.retained_carrier)

    def test_a_fully_readable_batch_is_still_reclaimable_in_both_answers(self):
        """The control that makes the refusal mean something. Without it, a
        classifier that refused everything would pass the assertions above."""
        snapshot = self.snap(batches=(
            self.batch('tok-a', message_ids=('m-1', 'm-2')),))
        result = mo.classify(snapshot)
        self.assertIs(result.by_token['tok-a'].disposition, mo.Disposition.ELIGIBLE)
        self.assertEqual(result.reclaimable_tokens, frozenset({'tok-a'}))
        self.assertEqual(mo.select(snapshot, ['m-1', 'm-2']).reclaimable_tokens,
                         frozenset({'tok-a'}))

    def test_an_actual_hold_is_still_told_apart_from_the_refusal(self):
        """Held and unreadable are different answers. Both refuse; only one of
        them says a holder exists."""
        snapshot = self.snap(
            batches=(self.batch('tok-a', message_ids=('m-1',)),),
            retentions=(mo.Retention(kind=mo.RetentionKind.HALT,
                                     tokens=frozenset({'tok-a'})),))
        verdict = self.verdict(snapshot)
        self.assertIs(verdict.disposition, mo.Disposition.PROTECTED)
        self.assertNotIn(mo.Reason.UNSUPPORTED_MESSAGE_IDENTITY, verdict.reasons)
        self.assertEqual(mo.select(snapshot, ['m-1']).reclaimable_tokens,
                         frozenset())

    def test_one_unreadable_batch_does_not_contaminate_its_neighbours(self):
        """Rule 8 is about whole BATCHES, not whole documents. A sibling keeps
        its own answer — the protected one stays protected rather than
        inheriting the refusal, and the clean one stays reclaimable."""
        snapshot = self.snap(
            batches=(self.batch('tok-bad', message_ids=('m-1', 17)),
                     self.batch('tok-held', message_ids=('m-2',)),
                     self.batch('tok-free', message_ids=('m-3',))),
            retentions=(mo.Retention(kind=mo.RetentionKind.HALT,
                                     tokens=frozenset({'tok-held'})),))
        result = mo.classify(snapshot)
        self.assertIs(result.by_token['tok-bad'].disposition,
                      mo.Disposition.UNAVAILABLE)
        self.assertIs(result.by_token['tok-held'].disposition,
                      mo.Disposition.PROTECTED)
        self.assertIs(result.by_token['tok-free'].disposition,
                      mo.Disposition.ELIGIBLE)
        self.assertEqual(result.reclaimable_tokens, frozenset({'tok-free'}))
        selection = mo.select(snapshot, ['m-1', 'm-2', 'm-3'])
        self.assertEqual(selection.reclaimable_tokens, frozenset({'tok-free'}))
        self.assertEqual(selection.unreadable_identity_batches,
                         frozenset({'tok-bad'}))

    def test_nothing_is_repaired_coerced_or_minted(self):
        """The refusal is a refusal. The stored value is still whatever it was,
        and no id was invented to stand in for it."""
        stored = ['m-1']
        batch = self.batch('tok-a', message_ids=('m-1', stored))
        snapshot = self.snap(batches=(batch,))
        mo.classify(snapshot)
        self.assertEqual(list(snapshot.batches[0].message_ids), ['m-1', ['m-1']])
        self.assertIs(snapshot.batches[0].message_ids[1], stored)
        # and the request still cannot reach the batch by spelling the list
        self.assertEqual(mo.select(snapshot, ["['m-1']"]).reclaimable_tokens,
                         frozenset())

    def test_an_unsupported_requested_id_is_reported_apart_from_an_unknown_one(self):
        snapshot = self.snap(batches=(self.batch('tok-a', message_ids=('m-1',)),))
        selection = mo.select(snapshot, ['m-1', 'm-99', 17, None, '', ['m-1']])
        self.assertEqual(selection.unresolved_messages, ('m-99',))
        self.assertEqual(selection.unsupported_messages, (17, None, '', ['m-1']))
        self.assertEqual(selection.reclaimable_tokens, frozenset({'tok-a'}))

    def test_an_unsupported_request_matches_nothing_at_all(self):
        snapshot = self.snap(batches=(self.batch('tok-a', message_ids=('m-1',)),))
        selection = mo.select(snapshot, [17])
        self.assertEqual(selection.verdicts, ())
        self.assertEqual(selection.reclaimable_tokens, frozenset())

    def test_a_single_string_request_is_one_id_not_a_run_of_characters(self):
        snapshot = self.snap(batches=(self.batch('tok-a', message_ids=('m-1',)),))
        self.assertEqual(mo.select(snapshot, 'm-1').reclaimable_tokens,
                         frozenset({'tok-a'}))


if __name__ == '__main__':
    unittest.main()
