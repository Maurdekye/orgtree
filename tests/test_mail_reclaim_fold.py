"""Document-only fold invariants and ownership-aware runtime cleanup.

The primitive composes into the caller's transaction. Runtime cleanup now
uses the shared classifier, so fixtures explicitly create old, stamped orphan
batches; active, young and uncertain custody is covered by runtime tests.
The stale-document control demonstrates why transaction callers must use the
primitive rather than mutating a previously loaded document after cleanup.
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

_root = tempfile.TemporaryDirectory(prefix='mail-reclaim-fold-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, supervisor

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()

CHECKOUT = Path(__file__).resolve().parents[1]
SLUGS: list[str] = []


def tearDownModule():
    """Close every pool under the slug `create_org` actually minted, then
    remove the data root here rather than leaving it to the interpreter's exit
    finalizer — where a still-open handle surfaces as a `WinError 32` long
    after the runner has already summarised the module as passing. Both
    removals are strict."""
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class Base(unittest.TestCase):
    """Fixture and helpers. Holds no test methods on purpose: a TestCase that
    subclasses another TestCase re-runs the parent's tests under the child's
    name and collides on the per-method org slug."""

    def setUp(self):
        self.org = store.create_org(self._testMethodName.replace('_', '-')[:60])
        self.slug = self.org.d['slug']       # what was minted, not what was asked for
        SLUGS.append(self.slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        self.org.hire(ledger.USER, None, 'haiku', 0, 'bystander')
        self.org.mailbox_identity('worker')
        self.org.mailbox_identity('bystander')
        store.save_org(self.org)

    def tearDown(self):
        supervisor._state.pop((self.slug, 'worker'), None)
        supervisor._state.pop((self.slug, 'bystander'), None)
        store._POOL.close_all(self.slug)

    # -- helpers ---------------------------------------------------------
    def post(self, body, to='worker'):
        return self.org.post_mail(ledger.USER, to, body)

    def box(self, to='worker', org=None):
        return ((org or self.org).d.get('mail') or {}).get(to) or []

    def journal(self, to='worker', org=None):
        return ((org or self.org).d.get('delivering') or {}).get(to) or []

    def drain(self, bodies, *, to='worker', via='steer', mode=None, notices=()):
        """Take the pending box into a journal batch the way a turn does, and
        return the minted token."""
        for body in bodies:
            self.post(body, to=to)
        taken = list(self.box(to))
        (self.org.d.setdefault('mail', {}))[to] = []
        tok = supervisor._journal_drain(self.org, to, taken, list(notices),
                                        via, mode=mode, segments=[])
        self.org.d['delivering'][to][-1]['at'] = '2000-01-01T00:00:00Z'
        return tok

    def persist(self):
        store.save_org(self.org)

    def durable(self):
        return store.load_org(self.slug)

    def document(self, org=None):
        """The durable document as plain comparable data. A loaded `d` is a
        `LazyDoc` whose sections materialise on first touch, so two of them
        can hold the same document and still not compare equal; the round
        trip forces every section and removes the question."""
        import json
        return json.loads(json.dumps((org or self.durable()).d, default=str))

    def ids(self, rows):
        return [r.get('id') for r in rows]


class TheDocumentOnlyPrimitive(Base):
    """What `_fold_back_locked` does, and the four things it refuses to do."""

    def test_it_moves_exactly_the_selected_tokens(self):
        first = self.drain(['one'])
        second = self.drain(['two'])
        folded, preserved = supervisor._fold_back_locked(
            self.org, 'worker', only_toks=[first])
        self.assertEqual(folded, frozenset({first}))
        self.assertEqual(preserved, frozenset({second}))
        self.assertEqual([r['body'] for r in self.box()], ['one'])
        self.assertEqual([b['tok'] for b in self.journal()], [second])

    def test_keep_tokens_stay_journaled(self):
        kept = self.drain(['riding a carrier'])
        folded, preserved = supervisor._fold_back_locked(
            self.org, 'worker', keep_toks=[kept])
        self.assertEqual(folded, frozenset())
        self.assertEqual(preserved, frozenset({kept}))
        self.assertEqual(self.box(), [])
        self.assertEqual([b['tok'] for b in self.journal()], [kept])

    def test_halt_held_tokens_are_subtracted_from_an_explicit_only(self):
        """A halt hold is a fact of this document, so the primitive reads it
        here rather than making every caller remember to."""
        first, second = self.drain(['one']), self.drain(['two'])
        self.org.node('worker')['halt_queue'] = [{'toks': [second]}]
        folded, preserved = supervisor._fold_back_locked(
            self.org, 'worker', only_toks=[first, second])
        self.assertEqual(folded, frozenset({first}))
        self.assertEqual(preserved, frozenset({second}))

    def test_it_never_reaches_for_a_lock_a_load_a_save_or_the_state(self):
        """Every door the wrapper owns is replaced with one that raises. The
        primitive completes, so it opened none of them."""
        tok = self.drain(['one'])
        exploding = mock.Mock(side_effect=AssertionError('the primitive did I/O'))
        with mock.patch.object(store, 'load_org', exploding), \
                mock.patch.object(store, 'save_org', exploding), \
                mock.patch.object(store, 'DOC_LOCK', _Forbidden()), \
                mock.patch.object(supervisor, 'state', exploding), \
                mock.patch.object(supervisor, '_state_lock', _Forbidden()):
            folded, _preserved = supervisor._fold_back_locked(
                self.org, 'worker', only_toks=[tok])
        self.assertEqual(folded, frozenset({tok}))
        self.assertEqual(exploding.call_count, 0)

    def test_it_leaves_the_durable_document_alone(self):
        tok = self.drain(['one'])
        self.persist()
        before = self.document()
        supervisor._fold_back_locked(self.org, 'worker', only_toks=[tok])
        self.assertEqual([r['body'] for r in self.box()], ['one'])   # in memory
        self.assertEqual(self.document(), before)                    # and nowhere else

    def test_a_no_op_reports_every_token_as_preserved(self):
        first, second = self.drain(['one']), self.drain(['two'])
        folded, preserved = supervisor._fold_back_locked(
            self.org, 'worker', only_toks=[])
        self.assertEqual(folded, frozenset())
        self.assertEqual(preserved, frozenset({first, second}))
        self.assertEqual(self.box(), [])

    def test_the_two_sets_are_complementary_over_the_journal(self):
        toks = {self.drain(['one']), self.drain(['two']), self.drain(['three'])}
        chosen = sorted(toks)[0]
        folded, preserved = supervisor._fold_back_locked(
            self.org, 'worker', only_toks=[chosen])
        self.assertEqual(folded | preserved, toks)
        self.assertEqual(folded & preserved, frozenset())

    def test_it_raises_when_the_reinsertion_fails(self):
        """The strict half of the contract. The wrapper's callers want this
        swallowed; a transaction caller must not be told the mail came back
        when it did not."""
        tok = self.drain(['one'])
        with mock.patch.object(type(self.org), 'reinsert_mail',
                               side_effect=RuntimeError('injected')):
            with self.assertRaises(RuntimeError):
                supervisor._fold_back_locked(self.org, 'worker', only_toks=[tok])

    def test_a_missing_recipient_drops_the_journal_without_reboxing(self):
        """Unchanged behaviour: there is no mailbox to put the rows in, and
        inventing one is not this function's call."""
        tok = self.drain(['one'])
        del self.org.d['nodes']['worker']
        folded, _preserved = supervisor._fold_back_locked(
            self.org, 'worker', only_toks=[tok])
        self.assertEqual(folded, frozenset({tok}))
        self.assertEqual(self.journal(), [])
        self.assertEqual(self.box(), [])


class _Forbidden:
    """A stand-in for a lock that must not be entered."""

    def __enter__(self):
        raise AssertionError('the primitive took a lock')

    def __exit__(self, *exc):
        return False


class OwnershipAwareCleanup(Base):
    """The three production callers — turn-end cleanup, `send_message`'s
    no-wake steer race, and `maildrain` — see exactly what they saw before."""

    def fold(self, **kw):
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', **kw)
        return self.durable()

    def test_turn_end_cleanup_folds_old_orphans_it_does_not_keep(self):
        kept = self.drain(['riding'])
        dropped = self.drain(['stranded'])
        after = self.fold(keep_toks=[kept])
        self.assertEqual([r['body'] for r in self.box(org=after)], ['stranded'])
        self.assertEqual([b['tok'] for b in self.journal(org=after)], [kept])
        self.assertEqual(dropped, dropped)

    def test_the_no_wake_race_folds_exactly_its_own_batch(self):
        mine = self.drain(['mine'])
        theirs = self.drain(['theirs'])
        after = self.fold(only_toks=[mine])
        self.assertEqual([r['body'] for r in self.box(org=after)], ['mine'])
        self.assertEqual([b['tok'] for b in self.journal(org=after)], [theirs])

    def test_cleanup_folds_each_old_unowned_batch(self):
        self.drain(['one'])
        self.drain(['two'])
        after = self.fold()
        self.assertEqual(sorted(r['body'] for r in self.box(org=after)), ['one', 'two'])
        self.assertEqual(self.journal(org=after), [])

    def test_a_confirmed_token_is_kept_even_when_only_names_it(self):
        confirmed = self.drain(['confirmed'])
        other = self.drain(['other'])
        supervisor.state(self.slug, 'worker')['mail_confirmed'] = {confirmed}
        try:
            after = self.fold(only_toks=[confirmed, other])
        finally:
            supervisor.state(self.slug, 'worker').pop('mail_confirmed', None)
        self.assertEqual([r['body'] for r in self.box(org=after)], ['other'])
        self.assertEqual([b['tok'] for b in self.journal(org=after)], [confirmed])

    def test_it_saves_once_and_only_when_something_folded(self):
        self.drain(['one'])
        self.persist()
        with mock.patch.object(store, 'save_org', wraps=store.save_org) as saved:
            supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[])
            self.assertEqual(saved.call_count, 0)
            supervisor._fold_back_undelivered(self.slug, 'worker')
            self.assertEqual(saved.call_count, 1)

    def test_it_still_swallows_a_failure_and_returns_none(self):
        tok = self.drain(['one'])
        self.persist()
        with mock.patch.object(ledger.Org, 'reinsert_mail',
                               side_effect=RuntimeError('injected')):
            self.assertIsNone(
                supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok]))
        after = self.durable()
        self.assertEqual([b['tok'] for b in self.journal(org=after)], [tok])
        self.assertEqual(self.box(org=after), [])

    def test_a_save_failure_leaves_the_journal_recoverable(self):
        """The durable journal is the only copy while a batch is in flight. A
        failed save must leave it there — not half-moved, and not cleaned up
        on the strength of an exception."""
        tok = self.drain(['one'])
        self.persist()
        with mock.patch.object(store, 'save_org', side_effect=RuntimeError('injected')):
            supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        stalled = self.durable()
        self.assertEqual([b['tok'] for b in self.journal(org=stalled)], [tok])
        self.assertEqual(self.box(org=stalled), [])
        self.assertNotIn('mail_confirmed', supervisor.state(self.slug, 'worker'))

        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        recovered = self.durable()
        self.assertEqual([r['body'] for r in self.box(org=recovered)], ['one'])
        self.assertEqual(self.journal(org=recovered), [])

    def test_the_wrapper_keeps_its_signature(self):
        import inspect
        signature = inspect.signature(supervisor._fold_back_undelivered)
        self.assertEqual(list(signature.parameters), ['slug', 'nid', 'keep_toks', 'only_toks'])
        self.assertIsNone(signature.parameters['only_toks'].default)


class TheStaleDocumentHazard(Base):
    """Why the split exists. Both halves are measured on the same shape."""

    def caller_row(self):
        return {'id': 'callers-own-row', 'body': "the caller's own change"}

    def test_the_self_loading_wrapper_loses_the_mail_it_recovered(self):
        """THE NEGATIVE CONTROL — and what it loses is mail.

        A caller holds a document and adds a row to the same mailbox, then
        calls the wrapper. The wrapper loads a SECOND document, folds the
        batch into that one and saves it. The caller then commits its own,
        whose `mail` section predates the fold: the recovered message is gone
        from the mailbox, and the journal that was its only other copy has
        already been cleared. Nothing raised, and the wrapper returns `None`
        either way, so no caller can tell it happened.

        The collision is per section — this store writes only what a document
        actually touched, so a caller that never touches `mail` or
        `delivering` does not clobber the fold. That narrows the hazard; it
        does not remove it, because a reclaim caller is by definition writing
        the mailbox the fold writes."""
        tok = self.drain(['one'])
        self.persist()

        held = self.durable()
        held.d.setdefault('mail', {}).setdefault('worker', []).append(self.caller_row())

        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        if store.STORE_BACKEND == 'postgres':
            # PG-0 compare-and-set (plan decision, lead 18:32Z): the stale
            # section is REFUSED loudly instead of overwriting the fold
            with self.assertRaises(store.StaleWrite):
                store.save_org(held)
            rows = self.box(org=self.durable())
            self.assertNotIn('callers-own-row', self.ids(rows),
                             'the refused save wrote nothing')
            self.assertEqual([r['body'] for r in rows], ['one'],
                             'and the recovered mail is where the fold put it')
            return
        store.save_org(held)          # the caller commits its own transaction

        after = self.durable()
        self.assertEqual(self.ids(self.box(org=after)), ['callers-own-row'],
                         "the caller's stale mail section overwrote the fold")
        self.assertEqual(self.journal(org=after), [],
                         'and the journal holding the only other copy is already gone')

    def test_the_primitive_composes_into_one_transaction(self):
        """The same shape through the primitive: one document, one save, both
        changes durable and the recovered mail exactly where the fold put it."""
        tok = self.drain(['one'])
        self.persist()

        with store.DOC_LOCK:
            held = store.load_org(self.slug)
            held.d.setdefault('mail', {}).setdefault('worker', []).append(self.caller_row())
            folded, preserved = supervisor._fold_back_locked(
                held, 'worker', only_toks=[tok])
            store.save_org(held)

        self.assertEqual(folded, frozenset({tok}))
        self.assertEqual(preserved, frozenset())
        after = self.durable()
        rows = self.box(org=after)
        self.assertIn('callers-own-row', self.ids(rows))
        self.assertEqual([r['body'] for r in rows if r['id'] != 'callers-own-row'], ['one'])
        self.assertEqual(self.journal(org=after), [])

    def test_a_failure_inside_the_transaction_reaches_the_caller(self):
        """The caller can decline to commit, which the swallowing wrapper
        never gave it the chance to do."""
        tok = self.drain(['one'])
        self.persist()
        before = self.document()

        with store.DOC_LOCK:
            held = store.load_org(self.slug)
            with mock.patch.object(ledger.Org, 'reinsert_mail',
                                   side_effect=RuntimeError('injected')):
                with self.assertRaises(RuntimeError):
                    supervisor._fold_back_locked(held, 'worker', only_toks=[tok])
            # the caller chose not to save, so nothing about the failure is durable

        self.assertEqual(self.document(), before)


class ReceiveOrderSurvivesTheFold(Base):
    """M0a, re-pinned through the extraction. `redelivered` is the only field
    the fold may move."""

    def rows(self, org=None):
        return {r['id']: r for r in self.box(org=org)}

    def test_identity_ordinal_and_provenance_come_back_unchanged(self):
        self.post('one')
        self.post('two')
        original = copy.deepcopy(self.box())
        tok = self.drain([])
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])

        after = self.rows(self.durable())
        self.assertEqual(sorted(after), sorted(r['id'] for r in original))
        for was in original:
            now = after[was['id']]
            for field in ('id', 'body', 'mailbox', 'recv_seq', 'seq_origin', 'from'):
                if field in was:
                    self.assertEqual(now.get(field), was.get(field),
                                     f'the fold moved {field}')
            self.assertEqual(int(now.get('redelivered') or 0),
                             int(was.get('redelivered') or 0) + 1)

    def test_a_repeated_fold_increments_redelivered_each_time_and_nothing_else(self):
        self.post('one')
        ordinal = self.box()[0].get('recv_seq')
        for expected in (1, 2, 3):
            tok = self.drain([])
            self.persist()
            supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
            self.org = self.durable()
            row = self.box()[0]
            self.assertEqual(row['redelivered'], expected)
            self.assertEqual(row.get('recv_seq'), ordinal, 'the ordinal was re-minted')

    def test_a_legacy_row_without_an_ordinal_does_not_acquire_one(self):
        """A recovery path is the worst imaginable place to invent an order
        nobody observed."""
        self.post('numbered')
        legacy = {'id': 'legacy-1', 'body': 'legacy', 'from': ledger.USER}
        self.org.d['mail']['worker'].append(legacy)
        tok = self.drain([])
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])

        after = self.rows(self.durable())
        self.assertNotIn('recv_seq', after['legacy-1'])
        self.assertNotIn('seq_origin', after['legacy-1'])
        self.assertNotIn('mailbox', after['legacy-1'])
        self.assertIn('recv_seq', [k for row in after.values() for k in row
                                   if row['id'] != 'legacy-1'])

    def test_the_stored_sequence_floor_is_not_rewound(self):
        self.post('one')
        floor = self.org.node('worker').get('mail_seq')
        tok = self.drain([])
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        self.assertEqual(self.durable().node('worker').get('mail_seq'), floor)

    def test_no_second_archive_copy_is_appended(self):
        self.post('one')
        self.persist()
        archive_before = copy.deepcopy((self.durable().d.get('mail_log') or {}).get('worker'))
        tok = self.drain([])
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        archive_after = (self.durable().d.get('mail_log') or {}).get('worker')
        self.assertEqual(archive_after, archive_before,
                         'these rows were archived at deposit; a second copy shows '
                         'the message twice in the inbox tab')

    def test_an_unsupported_redelivered_value_is_not_quietly_normalised(self):
        """`int('unsupported')` raises, the wrapper catches it, and the batch
        stays journaled. The important half is that nothing was half-written:
        the row is not folded AND renumbered."""
        self.post('one')
        tok = self.drain([])
        self.org.d['delivering']['worker'][0]['mail'][0]['redelivered'] = 'unsupported'
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        after = self.durable()
        self.assertEqual([b['tok'] for b in self.journal(org=after)], [tok])
        self.assertEqual(self.box(org=after), [])


class NothingElseMoved(Base):
    """Scope, checked rather than assumed."""

    def test_unrelated_nodes_notices_and_journals_are_untouched(self):
        self.post('for the bystander', to='bystander')
        mine = self.drain(['mine'])
        other = supervisor._journal_drain(self.org, 'bystander', [], [], 'steer', segments=[])
        self.persist()
        before = copy.deepcopy(self.durable().d)

        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[mine])

        after = self.durable().d
        self.assertEqual(after['mail']['bystander'], before['mail']['bystander'])
        self.assertEqual([b['tok'] for b in after['delivering']['bystander']], [other])
        self.assertEqual(after['nodes']['bystander'], before['nodes']['bystander'])

    def test_notices_fold_back_to_the_front_without_touching_other_nodes(self):
        self.org.d.setdefault('notices', {})['worker'] = [{'id': 'already-here'}]
        tok = self.drain([], notices=[{'id': 'folded-back'}])
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        after = self.durable()
        self.assertEqual([n['id'] for n in after.d['notices']['worker']],
                         ['folded-back', 'already-here'])


class RuntimeEntryPoints(Base):
    def test_a_young_unowned_batch_remains_journaled(self):
        tok = self.drain(['young'])
        self.org.d['delivering']['worker'][0]['at'] = ledger.now()
        self.persist()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        self.assertEqual([b['tok'] for b in self.journal(org=self.durable())], [tok])
        self.assertEqual(self.box(org=self.durable()), [])

    def test_an_unstamped_historical_batch_is_preserved(self):
        tok = self.drain(['legacy unknown custody'])
        self.org.d['delivering']['worker'][0].pop('custody')
        self.persist()
        before = self.document()
        supervisor._fold_back_undelivered(self.slug, 'worker', only_toks=[tok])
        self.assertEqual(self.document(), before)


if __name__ == '__main__':
    unittest.main()
