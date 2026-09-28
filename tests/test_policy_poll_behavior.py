"""Pin watchdog/storage tick decisions before replacing their read strategy."""
from contextlib import ExitStack
import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='policy-poll-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=root.name, ORGTREE_STORE='sqlite', ORGTREE_V2_TOKEN='test')
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import load_app
load_app()
from orgtree import ledger, policy_reads, store, supervisor as sup


def view(nodes=None, **sections):
    org = ledger.Org.__new__(ledger.Org)
    org.d = dict(slug='fixture', nodes=nodes or {}, **sections)
    return org


def node(state='live', **fields):
    return dict(state=state, scope={'tools': {'bash': True}, 'add_dirs': []}, **fields)


class PollBehavior(unittest.TestCase):
    def test_unreadable_org_does_not_hide_later_orgs(self):
        good = view()
        with patch.object(store, 'org_slugs', return_value=['gone', 'bad', 'fixture']), \
                patch.object(store, 'cached_org', side_effect=[
                    ledger.LedgerError('gone'), ValueError('bad JSON'), good]):
            self.assertEqual(list(policy_reads.poll_orgs(policy_reads.watchdog_org)),
                             [('fixture', good)])

    def tick(self, org):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(store, 'cached_list', return_value=[{'slug': 'fixture'}]))
        stack.enter_context(patch.object(store, 'org_slugs', return_value=['fixture']))
        stack.enter_context(patch.object(store, 'cached_org', return_value=org))
        stack.enter_context(patch.object(sup, '_wd_streams', {}))
        pause = stack.enter_context(patch.object(sup, '_wd_pause'))
        reap = stack.enter_context(patch.object(sup, '_wd_reap_stream'))
        command = stack.enter_context(patch.object(sup, '_wd_cmd_submit'))
        stream = stack.enter_context(patch.object(sup, '_wd_ensure_stream'))
        poll = stack.enter_context(patch.object(sup, '_wd_check_poll', return_value=([], {}, 'ok')))
        stack.enter_context(patch.object(sup, '_wd_write', return_value=None))
        sup._wd_tick()
        return pause, reap, command, stream, poll

    def dog(self, **changes):
        return dict(dict(id='dog', owner='owner', kind='process', name='dog',
                         target='pid:123', state='armed', interval_s=15), **changes)

    def test_archived_stream_owner_pauses_before_any_process_or_poll(self):
        pause, reap, command, stream, poll = self.tick(view(
            {'owner': node('archived')}, watchdogs=[self.dog(kind='stream')]))
        pause.assert_called_once_with('fixture', 'dog', ledger.Org.WATCHDOG_ARCHIVE_PAUSE)
        reap.assert_called_once_with(('fixture', 'dog'))
        for m in command, stream, poll: m.assert_not_called()

    def test_missing_owner_pauses_and_frozen_live_owner_still_polls(self):
        pause, reap, *_ = self.tick(view(watchdogs=[self.dog()]))
        pause.assert_called_once_with('fixture', 'dog', 'its owner is gone from the org')
        reap.assert_called_once()
        pause, _, _, _, poll = self.tick(view(
            {'owner': node(frozen={'limit': True}, halt={'at': 'now'})}, watchdogs=[self.dog()]))
        pause.assert_not_called()
        poll.assert_called_once()

    def test_revoked_bash_and_file_grant_pause(self):
        owner = node(); owner['scope']['tools']['bash'] = False
        pause, _, command, _, _ = self.tick(view({'owner': owner}, watchdogs=[self.dog(kind='command')]))
        self.assertIn('no longer holds bash', pause.call_args.args[2])
        command.assert_not_called()
        with patch.object(sup, 'wd_file_contained', return_value=False):
            pause, _, _, _, poll = self.tick(view({'owner': node()}, watchdogs=[self.dog(kind='file')]))
        self.assertIn('no longer holds the folder', pause.call_args.args[2])
        poll.assert_not_called()

    def test_paused_stream_still_visits_cleanup_but_paused_command_does_not_run(self):
        pause, _, command, stream, poll = self.tick(view({}, watchdogs=[
            self.dog(kind='stream', state='paused'), self.dog(id='two', kind='command', state='paused')]))
        pause.assert_not_called(); command.assert_not_called(); poll.assert_not_called()
        stream.assert_called_once()

    def test_interval_and_due_command_decisions(self):
        with patch.object(sup.time, 'time', return_value=100):
            _, _, command, _, poll = self.tick(view({'owner': node()}, watchdogs=[
                self.dog(kind='command', _last_check_ts=99),
                self.dog(id='due', kind='command', _last_check_ts=1)]))
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[1]['id'], 'due')
        poll.assert_not_called()

    def test_storage_idle_blocked_busy_and_sandbox_decisions(self):
        cases = [({}, False, False), ({'storage_blocked': {'at': 'x'}}, False, True),
                 ({'kiosk': {'enabled': False, 'storage_limit_mb': 5}}, True, True),
                 ({'sandbox': {'enabled': True}}, True, True),
                 ({'kiosk': {'sandbox': True}}, True, True),
                 ({'sandbox': {'enabled': True}}, False, False), ({}, True, False)]
        for settings, busy, expected in cases:
            with self.subTest(settings=settings, busy=busy), ExitStack() as stack:
                captured = []
                class Thread:
                    def __init__(self, target, **kwargs): captured.append(target)
                    def start(self): pass
                stack.enter_context(patch.object(sup, '_watchdog_started', False))
                stack.enter_context(patch.object(sup.threading, 'Thread', Thread))
                stack.enter_context(patch.object(store, 'cached_list', return_value=[{'slug': 'fixture'}]))
                stack.enter_context(patch.object(store, 'org_slugs', return_value=['fixture']))
                stack.enter_context(patch.object(store, 'cached_org', return_value=view(**settings)))
                stack.enter_context(patch.object(sup, '_state', {('fixture', 'owner'): {'busy': busy}}))
                walk = stack.enter_context(patch.object(sup, 'storage_check'))
                sup.start_storage_watchdog()
                with patch.object(sup.time, 'sleep', side_effect=[None, StopIteration]):
                    with self.assertRaises(StopIteration): captured[0]()
                self.assertEqual(walk.call_count, int(expected))


def tearDownModule():
    root.cleanup()


if __name__ == '__main__':
    unittest.main()
