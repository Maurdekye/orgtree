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
