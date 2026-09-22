"""Receive order is the RECEIVER's fact: minted once, preserved through every
move, and never invented for rows nobody observed arriving.

Array position in `mail[node]` is not that fact and never was — the fold-back
paths PREPEND, so a row that arrived last sits first. These tests pin the three
things M0a adds instead: an ordinal allocated at the one deposit door, a
high-water that survives everything keeping the same mailbox and dies with the
mailbox, and an explicitly-invoked migration that produces a TOTAL order while
labelling it unproven rather than dressing it up as recovered history.

The negative controls matter more than the positive ones here. Each of the
LosesTheEvidence cases fails loudly against a plausible wrong implementation —
a counter read without the assigned maximum, an ordinal re-minted on fold-back,
a migration that relabels itself `deposit` — and passes only against one that
keeps the distinction.
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='mail-receive-order-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class Base(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:60]
        self.org = store.create_org(self.slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'worker')

    def tearDown(self):
        store._POOL.close_all(self.slug)

    # -- helpers ---------------------------------------------------------
    def send(self, body, to='worker'):
        return self.org.post_mail(ledger.USER, to, body)

    def box(self, to='worker'):
        return (self.org.d.get('mail') or {}).get(to) or []

    def archive(self, to='worker'):
        return (self.org.d.get('mail_log') or {}).get(to) or []

    def seqs(self, rows):
        return [r.get('recv_seq') for r in rows]

    def row(self, entry_id, to='worker'):
        return next(r for r in self.box(to) if r['id'] == entry_id)

    def legacy(self, to, *rows):
        """Rows as a pre-M0a document holds them: no ordinal, no mailbox."""
        box = self.org.d.setdefault('mail', {}).setdefault(to, [])
        log = self.org.d.setdefault('mail_log', {}).setdefault(to, [])
        for r in rows:
            box.append(dict(r))
            log.append(dict(r))


class Allocation(Base):
    def test_deposit_mints_one_ascending_ordinal_per_message(self):
        ids = [self.send(f'body {i}')['id'] for i in range(4)]
        self.assertEqual(self.seqs(self.box()), [1, 2, 3, 4])
        self.assertEqual([self.row(i)['seq_origin'] for i in ids],
                         ['deposit'] * 4)
        self.assertEqual(self.org.node('worker')['mail_seq'], 4)

    def test_the_archive_copy_carries_the_same_ordinal(self):
        self.send('one')
        self.send('two')
        self.assertEqual(self.seqs(self.archive()), [1, 2])
        for boxed, logged in zip(self.box(), self.archive()):
            self.assertEqual(boxed['recv_seq'], logged['recv_seq'])
            self.assertEqual(boxed['id'], logged['id'])

    def test_each_mailbox_counts_for_itself(self):
        self.org.hire(ledger.USER, None, 'haiku', 0, 'other')
        self.send('a')
        self.send('b')
        self.send('c', to='other')
        self.assertEqual(self.seqs(self.box()), [1, 2])
        self.assertEqual(self.seqs(self.box('other')), [1])
        self.assertEqual(self.org.node('other')['mail_seq'], 1)

    def test_the_mailbox_stamp_is_the_same_for_every_row_of_one_mailbox(self):
        self.send('a')
        self.send('b')
        stamps = {r['mailbox'] for r in self.box()}
        self.assertEqual(len(stamps), 1)
        self.assertEqual(stamps.pop(), self.org.node('worker')['mailbox_id'])

    def test_a_stale_stored_high_water_cannot_produce_a_collision(self):
        # the failure this exists for: a counter BEHIND its own rows (a
        # document written before the mechanism, a partial migration, a
        # restored snapshot). Reading the counter alone hands out 6 twice.
        self.send('a')
        self.send('b')
        self.org.node('worker')['mail_seq'] = 0
        self.box()[1]['recv_seq'] = 9
        self.send('c')
        self.assertEqual(self.seqs(self.box()), [1, 9, 10])
        self.assertEqual(self.org.node('worker')['mail_seq'], 10)

    def test_assigned_ordinals_in_the_journal_also_hold_the_floor(self):
        # a drained batch is OUT of the box; its ordinals are still assigned
        self.send('a')
        drained = self.org.d['mail'].pop('worker')
        self.org.d.pop('mail_log', None)
        self.org.node('worker')['mail_seq'] = 0
        self.org.d.setdefault('delivering', {})['worker'] = [
            {'tok': 't1', 'mail': drained}]
        self.send('b')
        self.assertEqual(self.seqs(self.box()), [2])

    def test_an_ahead_counter_is_respected_rather_than_rewound(self):
        self.org.node('worker')['mail_seq'] = 40
        self.send('a')
        self.assertEqual(self.seqs(self.box()), [41])

    def test_mail_seq_state_is_a_pure_read(self):
        before = dict(self.org.node('worker'))
        state = self.org.mail_seq_state('worker')
        self.assertEqual(state['stored'], None)
        self.assertIsNone(state['mailbox'])
        self.assertEqual(state['base'], 0)
        self.assertEqual(self.org.node('worker'), before)
        self.assertEqual(self.box(), [])

    def test_an_unresolved_mailbox_is_marked_not_dropped_and_not_invented(self):
        entry = {'id': 'ff01', 'from': ledger.SYSTEM, 'kind': 'notice',
                 'at': '2026-09-22T00:00:00.000Z', 'body': 'x'}
        self.org.deposit_mail('no-such-node', entry)
        rows = self.box('no-such-node')
        self.assertEqual(len(rows), 1)
        self.assertNotIn('recv_seq', rows[0])
        self.assertEqual(rows[0]['seq_origin'], 'unresolved_mailbox')

    def test_receive_order_view_puts_unordered_rows_after_ordered_ones(self):
        self.legacy('worker', {'id': 'old', 'from': 'x', 'kind': 'message',
                               'at': '2020-01-01T00:00:00.000Z', 'body': 'old'})
        self.send('new')
        ordered = self.org.mailbox_in_receive_order('worker')
        self.assertEqual([r['id'] for r in ordered][-1], 'old')
        self.assertNotIn('recv_seq', ordered[-1])


class MovementIsNotArrival(Base):
    def test_reinsert_preserves_ordinals_and_allocates_nothing(self):
        self.send('a')
        self.send('b')
        drained = self.org.d['mail'].pop('worker')
        high = self.org.node('worker')['mail_seq']
        self.org.reinsert_mail('worker', drained)
        self.assertEqual(self.seqs(self.box()), [1, 2])
        self.assertEqual(self.org.node('worker')['mail_seq'], high)

    def test_reinsert_prepends_and_the_ordinal_still_says_what_arrived_first(self):
        first = self.send('a')['id']
        drained = self.org.d['mail'].pop('worker')
        second = self.send('b')['id']
        self.org.reinsert_mail('worker', drained)
        # POSITION now lies: the older message sits first only by accident of
        # the prepend, and would sit first either way. The ORDINAL does not.
        self.assertEqual([r['id'] for r in self.box()], [first, second])
        ordered = self.org.mailbox_in_receive_order('worker')
        self.assertEqual([r['id'] for r in ordered], [first, second])
        self.assertEqual(self.seqs(ordered), [1, 2])

    def test_reinsert_does_not_invent_an_ordinal_for_a_legacy_row(self):
        row = {'id': 'old', 'from': 'x', 'kind': 'message',
               'at': '2020-01-01T00:00:00.000Z', 'body': 'old'}
        self.org.reinsert_mail('worker', [row])
        self.assertNotIn('recv_seq', self.box()[0])
        self.assertNotIn('mail_seq', self.org.node('worker'))

    def test_reinsert_writes_no_second_archive_copy(self):
        self.send('a')
        drained = self.org.d['mail'].pop('worker')
        self.org.reinsert_mail('worker', drained)
        self.assertEqual(len(self.archive()), 1)


class Lifecycle(Base):
    def test_rehire_after_retire_keeps_the_counter_and_the_mailbox(self):
        self.send('a')
        before = dict(mailbox=self.org.node('worker')['mailbox_id'],
                      seq=self.org.node('worker')['mail_seq'])
        self.org.retire(ledger.USER, 'worker')
        self.org.rehire(ledger.USER, 'worker')
        self.assertEqual(self.org.node('worker')['mailbox_id'], before['mailbox'])
        self.assertEqual(self.org.node('worker')['mail_seq'], before['seq'])
        self.send('b')
        self.assertEqual(self.seqs(self.box())[-1], 2)

    def test_cheap_compact_keeps_the_counter_and_the_mailbox(self):
        self.send('a')
        before = dict(self.org.node('worker'))
        self.org.cheap_compact(ledger.USER, 'worker')
        self.assertEqual(self.org.node('worker')['mailbox_id'],
                         before['mailbox_id'])
        self.assertEqual(self.org.node('worker')['mail_seq'], before['mail_seq'])

    def test_rename_moves_one_mailbox_and_keeps_one_identity(self):
        self.send('a')
        mid = self.org.node('worker')['mailbox_id']
        self.org.rename(ledger.USER, 'worker', 'worker-two')
        self.assertEqual(self.org.node('worker-two')['mailbox_id'], mid)
        self.assertEqual(self.org.node('worker-two')['mail_seq'], 1)
        self.send('b', to='worker-two')
        self.assertEqual(self.seqs(self.box('worker-two')), [1, 2])

    # -- the bearer is a DIFFERENT mailbox ------------------------------
    #
    # Every lineage split builds its archived predecessor as `dict(n)` under a
    # new `nid@gen` key. The SEAT survives at `nid` and rightly keeps the
    # mailbox; the bearer is separately addressable and ordinary mail lands in
    # it. Owner preflight of b8efd35 reproduced the consequence of cloning the
    # two authority fields: a message to the successor and a message to the
    # bearer, two genuinely different messages in two genuinely different
    # mailboxes, carrying the SAME (mailbox, recv_seq) pair.

    def assertSeparateMailbox(self, successor, bearer):
        self.assertNotIn('mail_seq', self.org.node(bearer))
        self.assertNotIn('mailbox_id', self.org.node(bearer))
        a = self.row(self.send('to the successor', to=successor)['id'],
                     successor)
        b = self.row(self.send('to the bearer', to=bearer)['id'], bearer)
        self.assertNotEqual(a['id'], b['id'])
        self.assertNotEqual((a['mailbox'], a['recv_seq']),
                            (b['mailbox'], b['recv_seq']))
        self.assertEqual(b['recv_seq'], 1)           # its own order, from 1
        return a, b

    def test_a_cheap_compact_bearer_does_not_inherit_the_mailbox(self):
        self.send('a')
        kept = dict(self.org.node('worker'))
        self.org.cheap_compact(ledger.USER, 'worker')
        bearer = self.org.node('worker')['predecessor']
        succ, _ = self.assertSeparateMailbox('worker', bearer)
        # …and the successor's own identity and counter are untouched
        self.assertEqual(succ['mailbox'], kept['mailbox_id'])
        self.assertEqual(succ['recv_seq'], kept['mail_seq'] + 1)

    def test_a_compact_split_bearer_does_not_inherit_the_mailbox(self):
        self.send('a')
        bearer = self.org.compact_split('worker', 'fresh-session-id')
        self.assertSeparateMailbox('worker', bearer)

    def test_a_cli_compaction_bearer_does_not_inherit_the_mailbox(self):
        self.send('a')
        bearer = self.org.record_cli_compaction('worker')
        self.assertSeparateMailbox('worker', bearer)

    def test_a_reseed_bearer_does_not_inherit_the_mailbox(self):
        self.send('a')
        self.org.node('worker')['state'] = 'unrecoverable'   # reseed's entry
        bearer = self.org.reseed(ledger.USER, 'worker',
                                 'fresh-session-id')['predecessor']
        self.assertSeparateMailbox('worker', bearer)

    def test_a_bearers_own_mail_stays_its_own_across_a_second_split(self):
        self.send('a')
        self.org.cheap_compact(ledger.USER, 'worker')
        first = self.org.node('worker')['predecessor']
        self.send('to the first bearer', to=first)
        held = dict(self.org.node(first))
        self.org.cheap_compact(ledger.USER, 'worker')
        second = self.org.node('worker')['predecessor']
        self.assertNotEqual(first, second)
        # the older bearer is not disturbed by a later generation splitting
        self.assertEqual(self.org.node(first)['mailbox_id'], held['mailbox_id'])
        self.assertEqual(self.org.node(first)['mail_seq'], held['mail_seq'])
        ids = {self.org.node(x).get('mailbox_id')
               for x in ('worker', first, second) if self.org.node(x).get('mailbox_id')}
        self.assertEqual(len(ids), 2)   # second has none until it receives

    def test_every_predecessor_COPY_site_strips_mailbox_authority(self):
        # a structural guard, not a behavioural one: a fifth lineage split
        # written later must not reintroduce the clone. It fails the moment a
        # `dict(n)` predecessor reaches `self.nodes[...]` without the strip.
        src = Path(ledger.__file__).read_text(encoding='utf-8').splitlines()
        sites = [i for i, line in enumerate(src)
                 if 'pred = cast(NodeDoc, dict(n))' in line]
        self.assertEqual(len(sites), 4, 'lineage split count changed')
        for i in sites:
            end = next(j for j in range(i, len(src))
                       if 'self.nodes[pred_id] = pred' in src[j])
            self.assertIn('self._strip_mailbox_authority(pred)',
                          '\n'.join(src[i:end + 1]),
                          f'unstripped predecessor copy at ledger.py:{i + 1}')

    def test_delete_and_rehire_at_the_same_name_FENCES(self):
        # the invariant a stale cursor depends on: a new mailbox at an old
        # name must not look like the old mailbox continuing
        self.send('a')
        old = self.org.node('worker')['mailbox_id']
        self.org.delete(ledger.USER, 'worker')
        self.org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        self.assertNotIn('mail_seq', self.org.node('worker'))
        self.send('b')
        self.assertEqual(self.seqs(self.box()), [1])
        self.assertNotEqual(self.org.node('worker')['mailbox_id'], old)


class Migration(Base):
    def rows(self, *specs):
        return [{'id': i, 'from': 'x', 'kind': 'message', 'at': at,
                 'body': i} for i, at in specs]

    def test_it_assigns_a_total_order_and_labels_every_ordinal_unproven(self):
        self.legacy('worker', *self.rows(
            ('c', '2026-01-03T00:00:00.000Z'),
            ('a', '2026-01-01T00:00:00.000Z'),
            ('b', '2026-01-02T00:00:00.000Z')))
        report = self.org.migrate_mail_receive_order(['worker'])
        by_id = {r['id']: r for r in self.box()}
        self.assertEqual([by_id[i]['recv_seq'] for i in ('a', 'b', 'c')], [1, 2, 3])
        self.assertTrue(all(r['seq_origin'] == 'migration_unproven'
                            for r in self.box()))
        self.assertEqual(report['unproven'], 3)
        self.assertEqual(report['allocated'], 3)

    def test_it_never_calls_what_it_assigned_a_real_deposit(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        self.org.migrate_mail_receive_order(['worker'])
        self.assertNotEqual(self.box()[0]['seq_origin'], 'deposit')

    def test_every_physical_copy_of_one_message_gets_ONE_ordinal(self):
        row = self.rows(('a', '2026-01-01T00:00:00.000Z'))[0]
        self.legacy('worker', row)
        self.org.d.setdefault('delivering', {})['worker'] = [
            {'tok': 't1', 'mail': [dict(row)]}]
        self.org.migrate_mail_receive_order(['worker'])
        seen = {self.box()[0]['recv_seq'], self.archive()[0]['recv_seq'],
                self.org.d['delivering']['worker'][0]['mail'][0]['recv_seq']}
        self.assertEqual(seen, {1})

    def test_a_second_pass_changes_nothing(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z'),
                                         ('b', '2026-01-02T00:00:00.000Z')))
        self.org.migrate_mail_receive_order(['worker'])
        snapshot = [dict(r) for r in self.box()]
        high = self.org.node('worker')['mail_seq']
        again = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual(again['allocated'], 0)
        self.assertEqual(self.box(), snapshot)
        self.assertEqual(self.org.node('worker')['mail_seq'], high)

    def test_an_empty_pass_changes_nothing(self):
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual(report['allocated'], 0)
        self.assertNotIn('mail_seq', self.org.node('worker'))

    def test_an_already_assigned_ordinal_is_preserved_not_renumbered(self):
        self.legacy('worker', *self.rows(('b', '2026-01-02T00:00:00.000Z')))
        self.box()[0]['recv_seq'] = 7
        self.box()[0]['seq_origin'] = 'deposit'
        self.archive()[0]['recv_seq'] = 7
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        self.org.migrate_mail_receive_order(['worker'])
        by_id = {r['id']: r for r in self.box()}
        self.assertEqual(by_id['b']['recv_seq'], 7)
        self.assertEqual(by_id['b']['seq_origin'], 'deposit')
        # and the new one allocates ABOVE it rather than colliding with it
        self.assertEqual(by_id['a']['recv_seq'], 8)

    def test_it_does_not_rewrite_identity_or_content(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        before = {k: v for k, v in self.box()[0].items()}
        self.org.migrate_mail_receive_order(['worker'])
        after = self.box()[0]
        for key in ('id', 'from', 'kind', 'at', 'body'):
            self.assertEqual(after[key], before[key])

    def test_a_row_with_no_durable_id_is_counted_and_left_alone(self):
        self.legacy('worker', {'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'n'})
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertNotIn('recv_seq', self.box()[0])
        self.assertGreaterEqual(report['ambiguous'], 1)

    def test_a_row_with_no_usable_stamp_is_ordered_but_counted_ambiguous(self):
        self.legacy('worker', {'id': 'nostamp', 'from': 'x',
                               'kind': 'message', 'body': 'n'})
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual(self.box()[0]['recv_seq'], 1)
        self.assertEqual(self.box()[0]['seq_origin'], 'migration_unproven')
        self.assertGreaterEqual(report['ambiguous'], 1)

    def test_CAS_refuses_a_mailbox_whose_stored_value_moved(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        observed = self.org.mail_seq_state('worker')['stored']
        self.org.node('worker')['mail_seq'] = 12      # somebody else wrote
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': observed})
        self.assertEqual(report['allocated'], 0)
        self.assertEqual([s['mailbox'] for s in report['stale']], ['worker'])
        self.assertNotIn('recv_seq', self.box()[0])

    def test_CAS_admits_a_mailbox_whose_stored_value_held(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        observed = self.org.mail_seq_state('worker')['stored']
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': observed})
        self.assertEqual(report['allocated'], 1)
        self.assertEqual(report['stale'], [])

    def test_one_stale_mailbox_does_not_stop_the_others(self):
        self.org.hire(ledger.USER, None, 'haiku', 0, 'other')
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        self.legacy('other', *self.rows(('b', '2026-01-01T00:00:00.000Z')))
        self.org.node('worker')['mail_seq'] = 12
        report = self.org.migrate_mail_receive_order(
            ['worker', 'other'], expect_stored={'worker': None, 'other': None})
        self.assertEqual([s['mailbox'] for s in report['stale']], ['worker'])
        self.assertEqual(self.box('other')[0]['recv_seq'], 1)

    def test_a_stale_counter_BEHIND_its_rows_does_not_permanently_fail(self):
        # decision 9's two-quantity rule, stated as a test: the CAS compares
        # the OBSERVED stored value, allocation starts above the maximum of it
        # and every assigned ordinal. A counter of 0 under rows numbered to 5
        # must neither refuse forever nor hand out 1 again.
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z')))
        self.box()[0]['recv_seq'] = 5
        self.archive()[0]['recv_seq'] = 5
        self.legacy('worker', *self.rows(('b', '2026-01-02T00:00:00.000Z')))
        self.org.node('worker')['mail_seq'] = 0
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 0})
        self.assertEqual(report['stale'], [])
        by_id = {r['id']: r for r in self.box()}
        self.assertEqual(by_id['b']['recv_seq'], 6)

    def test_a_mailbox_with_no_node_is_skipped_and_reported(self):
        self.org.d.setdefault('mail', {})['ghost'] = [
            {'id': 'g', 'from': 'x', 'kind': 'message',
             'at': '2026-01-01T00:00:00.000Z', 'body': 'g'}]
        report = self.org.migrate_mail_receive_order()
        self.assertIn('ghost', report['skipped_no_node'])
        self.assertNotIn('recv_seq', self.org.d['mail']['ghost'][0])

    def test_deposits_after_a_migration_continue_above_it(self):
        self.legacy('worker', *self.rows(('a', '2026-01-01T00:00:00.000Z'),
                                         ('b', '2026-01-02T00:00:00.000Z')))
        self.org.migrate_mail_receive_order(['worker'])
        self.send('fresh')
        fresh = self.box()[-1]
        self.assertEqual(fresh['recv_seq'], 3)
        self.assertEqual(fresh['seq_origin'], 'deposit')


class PartiallyStampedCopies(Base):
    """One message, three physical copies, and only one of them numbered.

    That is not a conflict — it is ONE assignment recorded in one place, and a
    migration that leaves the other two bare hands every later reader a
    different answer depending on which table it happened to look in. Owner
    preflight of b8efd35 found exactly that: `preserved=1`, `ambiguous=0`, and
    an archive copy with no ordinal at all."""

    def mixed(self, mid='same', seq=5, origin='deposit', mailbox='mbox'):
        self.org.node('worker')['mail_seq'] = seq
        self.org.node('worker')['mailbox_id'] = mailbox
        stamped = {'id': mid, 'from': 'x', 'kind': 'message',
                   'at': '2026-01-01T00:00:00.000Z', 'body': 'b',
                   'recv_seq': seq, 'mailbox': mailbox}
        if origin is not None:
            stamped['seq_origin'] = origin
        bare = {k: v for k, v in stamped.items()
                if k not in ('recv_seq', 'seq_origin', 'mailbox')}
        self.org.d['mail'] = {'worker': [dict(stamped)]}
        self.org.d['mail_log'] = {'worker': [dict(bare)]}
        self.org.d['delivering'] = {'worker': [{'tok': 't', 'mail': [dict(bare)]}]}

    def copies(self):
        return [self.org.d['mail']['worker'][0],
                self.org.d['mail_log']['worker'][0],
                self.org.d['delivering']['worker'][0]['mail'][0]]

    def test_the_existing_assignment_is_carried_to_every_copy(self):
        self.mixed()
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 5})
        self.assertEqual(report['refused'], [])
        self.assertEqual([c.get('recv_seq') for c in self.copies()], [5, 5, 5])
        self.assertEqual([c.get('seq_origin') for c in self.copies()],
                         ['deposit'] * 3)
        self.assertEqual([c.get('mailbox') for c in self.copies()], ['mbox'] * 3)

    def test_it_reconciles_WITHOUT_allocating_a_second_ordinal(self):
        self.mixed()
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 5})
        self.assertEqual(report['allocated'], 0)
        self.assertEqual(report['unproven'], 0)
        self.assertEqual(report['mailboxes']['worker']['preserved'], 1)
        self.assertEqual(report['mailboxes']['worker']['reconciled_copies'], 2)
        self.assertEqual(self.org.node('worker')['mail_seq'], 5)

    def test_it_does_not_invent_an_origin_the_copies_never_stated(self):
        # an ordinal with no origin anywhere stays an ordinal with no origin.
        # Labelling it `migration_unproven` would claim the enumeration
        # produced it; labelling it `deposit` would claim a door did.
        self.mixed(origin=None)
        self.org.migrate_mail_receive_order(['worker'],
                                            expect_stored={'worker': 5})
        self.assertEqual([c.get('recv_seq') for c in self.copies()], [5, 5, 5])
        self.assertEqual([c.get('seq_origin') for c in self.copies()],
                         [None, None, None])

    def test_reconciling_is_idempotent(self):
        self.mixed()
        self.org.migrate_mail_receive_order(['worker'],
                                            expect_stored={'worker': 5})
        snapshot = [dict(c) for c in self.copies()]
        again = self.org.migrate_mail_receive_order(['worker'],
                                                    expect_stored={'worker': 5})
        self.assertEqual(again['allocated'], 0)
        self.assertEqual(again['reconciled_copies'], 0)
        self.assertEqual([dict(c) for c in self.copies()], snapshot)

    def test_a_mixture_of_assigned_and_unassigned_messages_still_works(self):
        self.mixed()
        self.legacy('worker', {'id': 'later', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-02T00:00:00.000Z', 'body': 'l'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 5})
        by_id = {r['id']: r for r in self.box()}
        self.assertEqual(by_id['same']['recv_seq'], 5)
        self.assertEqual(by_id['later']['recv_seq'], 6)
        self.assertEqual(by_id['later']['seq_origin'], 'migration_unproven')
        self.assertEqual(report['mailboxes']['worker']['reconciled_copies'], 2)


class UnresolvedStateIsRefused(Base):
    """A document that already disagrees with itself cannot be given a total
    order by guessing which half of the disagreement to keep.

    Every case here returned `ambiguous: 0` and a silent success from b8efd35.
    The rule now is: report the conflict with its evidence, change nothing in
    that mailbox, and let a human resolve it."""

    def prep(self, stored=None, mailbox=None):
        n = self.org.node('worker')
        if stored is not None:
            n['mail_seq'] = stored
        if mailbox is not None:
            n['mailbox_id'] = mailbox

    def put(self, *rows, table='mail'):
        self.org.d.setdefault(table, {}).setdefault('worker', []).extend(
            dict({'from': 'x', 'kind': 'message',
                  'at': '2026-01-01T00:00:00.000Z', 'body': 'b'}, **r)
            for r in rows)

    def reasons(self, report):
        out = []
        for entry in report['refused']:
            out.append(entry['reason'])
            out.extend(c['reason'] for c in entry.get('conflicts', []))
        return out

    def assertRefused(self, report, reason):
        self.assertIn(reason, self.reasons(report))
        self.assertEqual(report['allocated'], 0)
        self.assertEqual(report['mailboxes'], {})

    def test_two_ordinals_for_ONE_message_refuse_the_mailbox(self):
        self.prep(stored=9, mailbox='mbox')
        self.put({'id': 'same', 'recv_seq': 5, 'seq_origin': 'deposit',
                  'mailbox': 'mbox'})
        self.put({'id': 'same', 'recv_seq': 9, 'seq_origin': 'deposit',
                  'mailbox': 'mbox'}, table='mail_log')
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 9})
        self.assertRefused(report, 'conflicting_ordinals')
        self.assertEqual([self.org.d['mail']['worker'][0]['recv_seq'],
                          self.org.d['mail_log']['worker'][0]['recv_seq']],
                         [5, 9])          # both values preserved as evidence

    def test_ONE_ordinal_for_two_messages_refuses_the_mailbox(self):
        self.prep(stored=4, mailbox='mbox')
        self.put({'id': 'first', 'recv_seq': 4, 'mailbox': 'mbox'},
                 {'id': 'second', 'recv_seq': 4, 'mailbox': 'mbox'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 4})
        self.assertRefused(report, 'duplicate_ordinal')
        self.assertEqual(self.seqs(self.box()), [4, 4])

    def test_a_stamp_naming_ANOTHER_mailbox_refuses_the_mailbox(self):
        self.prep(stored=9, mailbox='new-mailbox')
        self.put({'id': 'stale', 'recv_seq': 9, 'seq_origin': 'deposit',
                  'mailbox': 'old-mailbox'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 9})
        self.assertRefused(report, 'foreign_mailbox')
        self.assertEqual(self.box()[0]['mailbox'], 'old-mailbox')

    def test_a_foreign_stamped_row_is_not_PRESENTED_as_ordered(self):
        # the ordinal is real, but it belongs to a different mailbox's order.
        # It sorts with the unordered tail rather than ahead of this
        # mailbox's own rows.
        self.prep(mailbox='new-mailbox')
        self.put({'id': 'stale', 'recv_seq': 1, 'mailbox': 'old-mailbox'},
                 {'id': 'mine', 'recv_seq': 2, 'mailbox': 'new-mailbox'})
        self.assertEqual([r['id'] for r in
                          self.org.mailbox_in_receive_order('worker')],
                         ['mine', 'stale'])

    def test_disagreeing_origins_for_one_message_refuse_the_mailbox(self):
        self.prep(stored=5, mailbox='mbox')
        self.put({'id': 'same', 'recv_seq': 5, 'seq_origin': 'deposit',
                  'mailbox': 'mbox'})
        self.put({'id': 'same', 'recv_seq': 5, 'mailbox': 'mbox',
                  'seq_origin': 'migration_unproven'}, table='mail_log')
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 5})
        self.assertRefused(report, 'conflicting_origin')

    def test_an_ordinal_outside_the_supported_domain_refuses_the_mailbox(self):
        self.prep(stored=3, mailbox='mbox')
        self.put({'id': 'zero', 'recv_seq': 0, 'mailbox': 'mbox'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 3})
        self.assertRefused(report, 'unsupported_ordinal')
        self.assertEqual(self.box()[0]['recv_seq'], 0)

    def test_a_bool_is_not_the_ordinal_one(self):
        # isinstance(True, int) is True in Python. A row carrying recv_seq
        # True must never sort as ordinal 1, count towards the assigned
        # maximum, or pass for an assignment.
        self.prep(stored=3, mailbox='mbox')
        self.put({'id': 'boolish', 'recv_seq': True, 'mailbox': 'mbox'})
        self.assertEqual(self.org.mail_seq_state('worker')['assigned_max'], 0)
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 3})
        self.assertRefused(report, 'unsupported_ordinal')
        self.assertIs(self.box()[0]['recv_seq'], True)

    def test_one_refused_mailbox_does_not_stop_the_others(self):
        self.org.hire(ledger.USER, None, 'haiku', 0, 'other')
        self.prep(stored=4, mailbox='mbox')
        self.put({'id': 'first', 'recv_seq': 4, 'mailbox': 'mbox'},
                 {'id': 'second', 'recv_seq': 4, 'mailbox': 'mbox'})
        self.legacy('other', {'id': 'b', 'from': 'x', 'kind': 'message',
                              'at': '2026-01-01T00:00:00.000Z', 'body': 'b'})
        report = self.org.migrate_mail_receive_order(['worker', 'other'])
        self.assertEqual([e['mailbox'] for e in report['refused']], ['worker'])
        self.assertEqual(self.box('other')[0]['recv_seq'], 1)

    def test_the_anomaly_read_names_the_conflict_and_writes_nothing(self):
        self.put({'id': 'first', 'recv_seq': 4}, {'id': 'second', 'recv_seq': 4})
        found = self.org.mailbox_receive_order_anomalies('worker')
        self.assertEqual([c['reason'] for c in found['conflicts']],
                         ['duplicate_ordinal'])
        self.assertEqual(found['conflicts'][0]['messages'], ['first', 'second'])
        self.assertNotIn('mailbox_id', self.org.node('worker'))
        self.assertNotIn('mail_seq', self.org.node('worker'))

    def test_a_self_consistent_mailbox_reports_no_conflicts(self):
        self.send('a')
        self.send('b')
        self.assertEqual(
            self.org.mailbox_receive_order_anomalies('worker')['conflicts'], [])


class TheFloorOutlivesTheRows(Base):
    """A migration that allocates nothing still has to record how far the
    mailbox has counted.

    `_allocate_recv_seq(to, 0)` computes the floor and writes nothing, which is
    invisible while the rows are still there — the next deposit re-derives the
    floor from them. Owner preflight of 3d45fd5 measured what happens when they
    are not: a mailbox whose one surviving row was ordinal 9 and whose counter
    was missing migrated cleanly, lost its rows to retention, and handed the
    next real message ordinal 1."""

    def assigned_only(self, stored='absent', seq=9):
        n = self.org.node('worker')
        if stored != 'absent':
            n['mail_seq'] = stored
        n['mailbox_id'] = 'retained-mailbox'
        row = {'id': 'previous', 'from': 'x', 'kind': 'message',
               'at': '2026-01-01T00:00:00.000Z', 'body': 'b', 'recv_seq': seq,
               'seq_origin': 'deposit', 'mailbox': 'retained-mailbox'}
        self.org.d['mail'] = {'worker': [dict(row)]}
        self.org.d['mail_log'] = {'worker': [dict(row)]}
        return self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker':
                                       None if stored == 'absent' else stored})

    def retain_everything(self):
        self.org.d['mail']['worker'].clear()
        self.org.d['mail_log']['worker'].clear()

    def test_a_missing_counter_is_raised_to_the_assigned_floor(self):
        report = self.assigned_only(stored='absent')
        self.assertEqual(report['allocated'], 0)
        self.assertEqual(report['mailboxes']['worker']['preserved'], 1)
        self.assertTrue(report['mailboxes']['worker']['floor_persisted'])
        self.assertEqual(self.org.node('worker')['mail_seq'], 9)

    def test_a_counter_BEHIND_its_rows_is_raised_to_the_floor(self):
        self.assigned_only(stored=1)
        self.assertEqual(self.org.node('worker')['mail_seq'], 9)

    def test_a_counter_AHEAD_of_its_rows_is_left_alone(self):
        report = self.assigned_only(stored=12)
        self.assertFalse(report['mailboxes']['worker']['floor_persisted'])
        self.assertEqual(self.org.node('worker')['mail_seq'], 12)

    # the whole point of all three: the rows the floor was read from are gone,
    # and the mailbox must still not reuse a position it has already used

    def test_after_retention_a_MISSING_counter_still_clears_the_old_ordinal(self):
        self.assigned_only(stored='absent')
        self.retain_everything()
        self.send('after synthetic retention')
        self.assertEqual(self.box()[-1]['recv_seq'], 10)

    def test_after_retention_a_BEHIND_counter_still_clears_the_old_ordinal(self):
        self.assigned_only(stored=1)
        self.retain_everything()
        self.send('after synthetic retention')
        self.assertEqual(self.box()[-1]['recv_seq'], 10)

    def test_after_retention_an_AHEAD_counter_continues_from_itself(self):
        self.assigned_only(stored=12)
        self.retain_everything()
        self.send('after synthetic retention')
        self.assertEqual(self.box()[-1]['recv_seq'], 13)

    def test_persisting_the_floor_rewrites_no_message(self):
        self.assigned_only(stored='absent')
        row = self.box()[0]
        self.assertEqual((row['id'], row['recv_seq'], row['seq_origin'],
                          row['mailbox']),
                         ('previous', 9, 'deposit', 'retained-mailbox'))

    def test_a_second_pass_persists_the_same_floor_and_changes_nothing(self):
        self.assigned_only(stored='absent')
        snapshot = [dict(r) for r in self.box()]
        again = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 9})
        self.assertEqual(again['allocated'], 0)
        self.assertFalse(again['mailboxes']['worker']['floor_persisted'])
        self.assertEqual(self.org.node('worker')['mail_seq'], 9)
        self.assertEqual(self.box(), snapshot)

    def test_an_empty_mailbox_still_gets_no_counter(self):
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual(report['floors_persisted'], 0)
        self.assertNotIn('mail_seq', self.org.node('worker'))

    def test_a_REFUSED_mailbox_persists_no_floor(self):
        self.org.node('worker')['mailbox_id'] = 'mbox'
        base = {'from': 'x', 'kind': 'message',
                'at': '2026-01-01T00:00:00.000Z', 'body': 'b',
                'mailbox': 'mbox'}
        self.org.d['mail'] = {'worker': [
            dict(base, id='first', recv_seq=4), dict(base, id='second', recv_seq=4)]}
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual(report['floors_persisted'], 0)
        self.assertNotIn('mail_seq', self.org.node('worker'))

    def test_a_STALE_mailbox_persists_no_floor(self):
        self.org.node('worker')['mailbox_id'] = 'mbox'
        self.org.node('worker')['mail_seq'] = 3
        self.org.d['mail'] = {'worker': [
            {'id': 'a', 'from': 'x', 'kind': 'message', 'mailbox': 'mbox',
             'at': '2026-01-01T00:00:00.000Z', 'body': 'b', 'recv_seq': 9}]}
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 0})     # somebody else wrote
        self.assertEqual([s['mailbox'] for s in report['stale']], ['worker'])
        self.assertEqual(report['floors_persisted'], 0)
        self.assertEqual(self.org.node('worker')['mail_seq'], 3)


class AnUnsupportedCounterIsNotAnAbsentOne(Base):
    """`expect_stored: None` is a claim: "I observed this mailbox to have no
    counter." Normalising a stored string to None makes that claim compare
    equal to data the caller never saw, and the CAS then admits a write over
    it. b8efd35 did exactly that and overwrote the value with 1."""

    def test_an_unsupported_stored_counter_is_refused_not_overwritten(self):
        self.org.node('worker')['mail_seq'] = 'unsupported-stored-value'
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': None})
        self.assertEqual([(e['mailbox'], e['reason']) for e in report['refused']],
                         [('worker', 'unsupported_stored')])
        self.assertEqual(report['allocated'], 0)
        self.assertEqual(self.org.node('worker')['mail_seq'],
                         'unsupported-stored-value')
        self.assertNotIn('recv_seq', self.box()[0])

    def test_a_float_counter_is_refused_too(self):
        self.org.node('worker')['mail_seq'] = 2.5
        report = self.org.migrate_mail_receive_order(['worker'])
        self.assertEqual([e['reason'] for e in report['refused']],
                         ['unsupported_stored'])
        self.assertEqual(self.org.node('worker')['mail_seq'], 2.5)

    def test_an_unsupported_EXPECTATION_is_refused_too(self):
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': 'nonsense'})
        self.assertEqual([e['reason'] for e in report['refused']],
                         ['unsupported_expectation'])
        self.assertNotIn('recv_seq', self.box()[0])

    def test_the_pure_read_says_the_counter_is_unsupported(self):
        self.org.node('worker')['mail_seq'] = 'unsupported-stored-value'
        state = self.org.mail_seq_state('worker')
        self.assertIsNone(state['stored'])
        self.assertTrue(state['stored_present'])
        self.assertFalse(state['stored_supported'])
        self.assertEqual(state['stored_type'], 'str')

    def test_an_explicit_NULL_counter_is_present_data_not_an_absent_key(self):
        # the declared domain is a PRESENT non-bool int >= 0, and `None` is
        # not in it. Reading the value instead of the key collapsed a stored
        # null into a missing one, so `expect_stored=None` — an honest claim
        # of "I observed no counter" — matched it and overwrote it.
        self.org.node('worker')['mail_seq'] = None
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        state = self.org.mail_seq_state('worker')
        self.assertTrue(state['stored_present'])
        self.assertFalse(state['stored_supported'])
        self.assertEqual(state['stored_type'], 'NoneType')
        before = copy.deepcopy(self.org.d)
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': None})
        self.assertEqual([(e['mailbox'], e['reason'], e['stored_type'])
                          for e in report['refused']],
                         [('worker', 'unsupported_stored', 'NoneType')])
        self.assertEqual(report['allocated'], 0)
        self.assertIsNone(self.org.node('worker')['mail_seq'])
        self.assertEqual(self.org.d, before)

    def test_a_deposit_into_a_null_counter_still_delivers(self):
        # the deposit door stays tolerant: refusing here loses a message.
        self.org.node('worker')['mail_seq'] = None
        self.send('a')
        self.assertEqual(self.box()[-1]['recv_seq'], 1)

    def test_an_ORDINARY_missing_counter_stays_eligible(self):
        # the legacy case the migration exists for must not be caught by any
        # of the above: absent is absent, and absent migrates.
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        state = self.org.mail_seq_state('worker')
        self.assertIsNone(state['stored'])
        self.assertFalse(state['stored_present'])
        self.assertTrue(state['stored_supported'])
        report = self.org.migrate_mail_receive_order(
            ['worker'], expect_stored={'worker': None})
        self.assertEqual(report['refused'], [])
        self.assertEqual(self.box()[0]['recv_seq'], 1)


class NothingRunsItByAccident(Base):
    def test_loading_a_document_allocates_nothing(self):
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        store.save_org(self.org)
        again = store.load_org(self.slug)
        self.assertNotIn('recv_seq',
                         (again.d.get('mail') or {})['worker'][0])
        self.assertNotIn('mail_seq', again.node('worker'))

    def test_reading_the_mailbox_allocates_nothing(self):
        self.legacy('worker', {'id': 'a', 'from': 'x', 'kind': 'message',
                               'at': '2026-01-01T00:00:00.000Z', 'body': 'a'})
        self.org.mailbox_in_receive_order('worker')
        self.org.mail_seq_state('worker')
        self.assertNotIn('mail_seq', self.org.node('worker'))
        self.assertNotIn('mailbox_id', self.org.node('worker'))


class Durability(Base):
    def test_the_ordinal_and_the_counter_survive_a_save_and_load(self):
        self.send('a')
        self.send('b')
        store.save_org(self.org)
        again = store.load_org(self.slug)
        self.assertEqual([r['recv_seq']
                          for r in (again.d.get('mail') or {})['worker']],
                         [1, 2])
        self.assertEqual(again.node('worker')['mail_seq'], 2)
        again.post_mail(ledger.USER, 'worker', 'c')
        self.assertEqual((again.d['mail'])['worker'][-1]['recv_seq'], 3)


if __name__ == '__main__':
    unittest.main()
