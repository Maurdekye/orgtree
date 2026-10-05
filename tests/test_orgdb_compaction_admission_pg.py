"""Automatic compaction traverses the real admission and PostgreSQL graph guard."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack, contextmanager
from unittest.mock import patch
import unittest
from uuid import uuid4

import test_orgdb_compat_pg as fixture
from orgtree import halt, ledger, maildrain, orgtx, pgdoor, store, supervisor as sup
from orgtree.orgdb import graph

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


class PastAdmission(RuntimeError):
    pass


@fixture.needs_pg
class Compaction(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(fixture.storage(True))
        store.claim_data_root()
        self.slug = 'compact-' + uuid4().hex[:12]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 8, 'boss')
        org.hire(ledger.USER, 'boss', 'opus', 0, 'worker')
        self.before = org.node('worker')['session_id']
        self.generation = org.node('worker').get('generation', 0)
        self.mail_id = org.post_mail(ledger.USER, 'worker', 'keep this work')['id']
        maildrain.request(org, 'worker')
        store.save_org(org)
        self.addCleanup(maildrain._forget, self.slug, 'worker')
        self.st = sup.state(self.slug, 'worker')
        self.st['mail_attempt_ids'] = [self.mail_id]
        self.at_drain = []
        self.exports = []
        self.widenings = []
        self.plans = []
        real_check = graph.check_paths

        def check(*a, **kw):
            try:
                return real_check(*a, **kw)
            except pgdoor.Widen as exc:
                self.widenings.append(exc.spec)
                raise

        self.stack.enter_context(patch.object(graph, 'check_paths', side_effect=check))
        real_txn = halt.txn

        @contextmanager
        def txn(slug, **rows):
            if any('@' in str(n) for n in rows.get('nodes', ())):
                self.plans.append(rows)
            with real_txn(slug, **rows) as tx:
                yield tx

        self.stack.enter_context(patch.object(halt, 'txn', side_effect=txn))
        forecast = ({}, None, {'state': 'known_incompatible', 'reason': 'test'}, None, None)
        for name, kwargs in (
            ('_turn_forecast', {'return_value': forecast}),
            ('_auto_cheap_cfg', {'return_value': {'occ': .25}}),
            ('_auto_cheap_ready', {'return_value': True}),
            ('spawn_env', {'return_value': {}}),
            ('_envelope_state_block', {'side_effect': self.past_admission}),
            ('export_after_commit', {'side_effect': self.export}),
            ('_cancel_working_cache', {}), ('_note_working_activity', {}),
            ('_hold_for_deploy', {'return_value': True}),
            ('_native_context_hold', {'return_value': None}),
            ('_turn_abandoned', {}), ('scan_steer_records', {}),
            ('scan_manual_records', {}),
        ):
            self.stack.enter_context(patch.object(sup, name, **kwargs))
        self.stack.enter_context(patch.object(sup.subprocess, 'Popen',
            side_effect=AssertionError('no external provider may launch')))

    def saved(self):
        return orgtx.org_read(self.slug)

    def past_admission(self, *args, **kwargs):
        saved = self.saved()
        self.at_drain.append((saved.node('worker')['session_id'],
            [m['id'] for m in saved.d.get('mail', {}).get('worker', [])]))
        raise PastAdmission('stop before provider')

    def export(self, slug, org, nid, old_sid, reason):
        saved = self.saved()
        self.assertEqual(saved.node(nid)['session_id'], org.node(nid)['session_id'])
        self.assertNotEqual(saved.node(nid)['session_id'], old_sid)
        self.assertTrue(any(n.get('successor') == nid for n in saved.nodes.values()))
        self.exports.append(old_sid)

    def admit(self):
        return sup._run_one_turn_recorded(self.slug, 'worker', 'run queued work')

    def test_real_graph_widen_commits_one_successor_before_drain(self):
        self.admit()
        self.assertTrue(self.widenings, 'control never reached the actual graph guard')
        self.assertEqual(len(self.at_drain), 1, self.st.get('last_error'))
        self.assertNotEqual(self.at_drain[0][0], self.before)
        self.assertNotIn(self.mail_id, self.at_drain[0][1])
        saved = self.saved()
        self.assertEqual(len([n for n in saved.nodes.values()
                              if n.get('successor') == 'worker']), 1)
        self.assertEqual(self.exports, [self.before])
        self.assertGreaterEqual(len(self.plans), 2)
        for required in self.widenings:
            last = pgdoor.TxSpec(**{k: tuple(v) for k, v in self.plans[-1].items()})
            self.assertTrue(last.covers(required).empty())

    def test_expansion_keeps_all_lock_dimensions(self):
        original = ledger.Org.cheap_compact
        calls = []
        missing = dict(nodes=('boss',), share_nodes=('observer',),
                       sections=(('notices', 'observer'),), share_sections=('settings',),
                       logs=(('mail_log', 'observer'),), structural_roots=('boss',))
        # Test the planner with an actual existing observer node.
        org = self.saved()
        org.hire(ledger.USER, None, 'opus', 0, 'observer')
        store.save_org(org)

        def compact(org, actor, nid):
            calls.append(True)
            result = original(org, actor, nid)
            if len(calls) == 1:
                raise pgdoor.Widen(**missing)
            return result

        with patch.object(ledger.Org, 'cheap_compact', compact):
            self.admit()
        self.assertEqual(len(self.at_drain), 1, self.st.get('last_error'))
        self.assertTrue(pgdoor.TxSpec(**{k: tuple(v) for k, v in self.plans[1].items()})
                        .covers(pgdoor.TxSpec(**missing)).empty())
        self.assertEqual(self.exports, [self.before])

    def test_exhaustion_is_bounded_rolls_back_and_does_not_export(self):
        original = ledger.Org.cheap_compact
        calls = []

        def compact(org, actor, nid):
            calls.append(True)
            original(org, actor, nid)
            raise pgdoor.Widen(structural_roots=('boss',))

        with patch.object(ledger.Org, 'cheap_compact', compact):
            self.admit()
        self.assertEqual(len(calls), pgdoor.MAX_WIDEN + 1)
        self.assertFalse(self.at_drain)
        self.assertFalse(self.exports)
        saved = self.saved()
        self.assertEqual(saved.node('worker')['session_id'], self.before)
        self.assertFalse(any(n.get('successor') == 'worker' for n in saved.nodes.values()))
        self.assertIn(self.mail_id, [m['id'] for m in saved.d['mail']['worker']])
        self.assertIn('automatic compaction', sup._turn_abandoned.call_args.args[2])
        self.assertNotIn('account binding', sup._turn_abandoned.call_args.args[2])

    def test_unexpected_compaction_error_stops_mail_redrive_without_recording(self):
        with patch.object(ledger.Org, 'cheap_compact', side_effect=ValueError('fixture fault')) as compact, \
             patch.object(sup.turnlog, 'start', return_value=None), \
             patch.object(sup, '_start_turn_worker', side_effect=sup._run_turn) as start:
            sup._run_turn(self.slug, 'worker', {'text': 'pending mail', 'ping': True,
                                              'mail_ids': [self.mail_id]})
            for _ in range(26):
                self.assertFalse(maildrain.recover(self.slug, 'worker'))
        self.assertEqual(compact.call_count, 1)
        self.assertEqual(start.call_count, 0)
        self.assertFalse(maildrain.pending(self.saved(), 'worker'))
        self.assertIn(self.mail_id, [m['id'] for m in self.saved().d['mail']['worker']])
        self.assertEqual(sup._turn_abandoned.call_count, 1)
        door = sup._turn_abandoned.call_args.args[2]
        self.assertIn('automatic compaction (ValueError)', door)
        self.assertNotIn('account binding', door)
        self.assertIn('fixture fault', self.st['last_error'])

    def test_halt_between_attempts_is_rechecked(self):
        real = ledger.Org.cheap_compact
        calls = []
        real_txn = halt.txn

        def compact(org, actor, nid):
            calls.append(True)
            return real(org, actor, nid)

        @contextmanager
        def txn(slug, **rows):
            if any('@' in str(n) for n in rows.get('nodes', ())):
                if calls:
                    with real_txn(slug, nodes=['worker']) as tx:
                        tx.org.node('worker')['halt'] = {'phase': 'halted'}
            with real_txn(slug, **rows) as tx:
                yield tx

        with patch.object(ledger.Org, 'cheap_compact', compact), \
             patch.object(halt, 'txn', side_effect=txn):
            self.admit()
        self.assertEqual(len(calls), 1)
        self.assertTrue(self.widenings)
        self.assertFalse(self.at_drain)
        self.assertFalse(self.exports)
        self.assertEqual(self.saved().node('worker')['session_id'], self.before)

    def test_export_failure_after_commit_does_not_repeat_compaction(self):
        with patch.object(sup, 'export_after_commit', side_effect=OSError('export unavailable')) as export:
            self.admit()
        self.assertEqual(export.call_count, 1)
        self.assertEqual(len(self.at_drain), 1, self.st.get('last_error'))
        self.assertNotEqual(self.saved().node('worker')['session_id'], self.before)
        self.assertEqual(len([n for n in self.saved().nodes.values()
                              if n.get('successor') == 'worker']), 1)


if __name__ == '__main__':
    unittest.main()
