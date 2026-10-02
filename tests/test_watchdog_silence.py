"""Silence deadlines, matching sources, activity authority and tool wiring."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import os
os.environ['ORGTREE_STORE'] = 'sqlite'
os.environ['ORGTREE_PGDOOR'] = '0'
os.environ['ORGTREE_V2_TOKEN'] = 'operator'

from datetime import datetime, timezone
from concurrent.futures import Future
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

root = tempfile.TemporaryDirectory(prefix='watchdog-silence-', ignore_cleanup_errors=True)
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(HOME=str(home), USERPROFILE=str(home))
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

from engine.launch import load_app
app, *_ = load_app()
from fastapi.testclient import TestClient
from orgtree import agentauth, api, ledger, mcptool, orgtx, pgdoor, store, supervisor, watchdog_config

TOOLS = {'bash': True, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule():
    root.cleanup()


class Silence(unittest.TestCase):
    seq = 0

    def setUp(self):
        type(self).seq += 1
        self.slug = f'silence{self.seq}'
        self.clock = datetime(2026, 10, 2, 18, tzinfo=timezone.utc).timestamp()
        for module, key in ((ledger, 'now'), (supervisor, 'now_iso')):
            self.enterContext(patch.object(module, key, side_effect=self.stamp))
        self.enterContext(patch.object(supervisor.time, 'time', side_effect=lambda: self.clock))
        self.sent = self.enterContext(patch.object(supervisor, 'send_message'))
        self.enterContext(patch.object(supervisor, 'mail_spark'))
        self.enterContext(patch.object(api, 'mail_notify'))
        self.enterContext(patch.object(api, 'hub_changed'))
        self.enterContext(patch.object(supervisor, '_wd_activity_pending', {}))
        self.enterContext(patch.object(supervisor, '_wd_streams', {}))
        self.enterContext(patch.object(supervisor, '_wd_cmd_inflight', set()))
        self.enterContext(patch.object(supervisor, '_wd_cmd_pool', None))
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 12, 'boss', tools=TOOLS)
        org.hire('boss', 'boss', 'haiku', 0, 'child', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='test agent')
        org.hire(ledger.USER, None, 'haiku', 0, 'peer', tools=TOOLS)
        store.save_org(org)
        self.enterContext(patch('orgtree.policy_reads.poll_orgs',
                                side_effect=lambda reader: [(self.slug, store.load_org(self.slug))]))

    def stamp(self):
        return datetime.fromtimestamp(self.clock, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def dog(self, kind='activity', target='child', owner='boss', **kw):
        org = store.load_org(self.slug)
        args = {'fire_mode': 'silence', 'quiet_period_s': 20, **kw}
        result = org.watchdog_create(owner, 'test', kind, target, **args)
        store.save_org(org)
        return result['id']

    def get(self, wid):
        return store.load_org(self.slug)._watchdog(wid)

    def tick(self, seconds=0):
        self.clock += seconds
        supervisor._wd_tick()

    def test_deadline_repeats_and_survives_runtime_reset(self):
        wid = self.dog()
        self.tick(19)
        self.assertEqual(self.get(wid)['fired'], 0)
        self.tick(1)
        self.assertEqual(self.get(wid)['fired'], 1)
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())
        supervisor._wd_activity_pending.clear()  # restart loses runtime only
        self.tick(19)
        self.assertEqual(self.get(wid)['fired'], 1)
        self.tick(1)
        self.assertEqual(self.get(wid)['fired'], 2)
        self.assertEqual(self.sent.call_count, 2)

    def test_activity_match_resets_and_nonmatching_activity_does_not(self):
        wid = self.dog(pattern='tool_call exec')
        self.clock += 12
        supervisor._wd_activity(self.slug, 'child', 'tool_call exec')
        self.tick()
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())
        self.tick(10)
        supervisor._wd_activity(self.slug, 'child', 'turn_started')
        self.tick()
        self.assertEqual(self.get(wid)['fired'], 0)
        self.tick(10)
        self.assertEqual(self.get(wid)['fired'], 1)
        self.assertEqual(self.get(wid)['checks_run'], 1)
        mail = store.load_org(self.slug).d['mail']['boss']
        self.assertEqual(len(mail), 1)
        self.assertIn('No matching event', mail[0]['body'])
        self.assertFalse(store.load_org(self.slug).d.get('mail', {}).get('child'))

    def test_live_tool_row_captures_name_without_arguments(self):
        wid = self.dog(pattern='^tool_call exec$')
        self.clock += 13
        supervisor.live_row(self.slug, 'child', {'kind': 'tool', 'id': 'one',
                                               'text': 'exec · private arguments'})
        self.tick()
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())
        self.assertEqual(self.get(wid)['last_output'], 'tool_call exec')

    def test_pending_activity_cancels_a_stale_deadline(self):
        wid = self.dog()
        stale = dict(self.get(wid))
        self.clock += 20
        supervisor._wd_activity(self.slug, 'child', 'turn_started')
        supervisor._wd_silence_check(self.slug, stale)
        self.assertEqual(self.get(wid)['fired'], 0)
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())

    def test_failed_activity_write_retains_the_match_for_retry(self):
        wid = self.dog()
        self.clock += 10
        supervisor._wd_activity(self.slug, 'child', 'turn_started')
        with patch.object(supervisor, '_wd_event', side_effect=OSError('storage unavailable')):
            supervisor._wd_activity_flush()
        self.assertTrue(supervisor._wd_activity_pending)
        self.tick()
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())
        self.assertFalse(supervisor._wd_activity_pending)

    def test_one_shot_notice_is_atomic_and_keeps_settings_in_tomb(self):
        wid = self.dog(once=True, notice=True)
        self.tick(20)
        org = store.load_org(self.slug)
        self.assertFalse(org.d['watchdogs'])
        self.assertEqual(len(org.d['mail']['boss']), 1)
        tomb = org.d['watchdog_tombs'][-1]
        self.assertEqual((tomb['fire_mode'], tomb['quiet_period_s']), ('silence', 20))
        self.assertEqual(tomb['silence_since'], self.stamp())
        self.assertFalse(self.sent.call_args.kwargs['wake'])
        self.tick(20)
        self.assertEqual(self.sent.call_count, 1)

    def test_pause_resume_starts_a_full_quiet_period(self):
        wid = self.dog()
        org = store.load_org(self.slug)
        org.watchdog_action('boss', wid, 'pause')
        store.save_org(org)
        self.tick(100)
        self.assertEqual(self.get(wid)['fired'], 0)
        org = store.load_org(self.slug)
        org.watchdog_action('boss', wid, 'resume')
        store.save_org(org)
        self.tick(19)
        self.assertEqual(self.get(wid)['fired'], 0)
        self.tick(1)
        self.assertEqual(self.get(wid)['fired'], 1)

    def test_activity_authority_self_descendant_and_peer_refusal(self):
        self.dog(target='boss')
        self.dog(target='child')
        with self.assertRaisesRegex(ledger.LedgerError, 'yourself or a descendant'):
            self.dog(target='peer')
        with self.assertRaises(ledger.LedgerError):
            self.dog(target='gone')

    def test_moved_target_is_paused_without_mail_or_reset(self):
        wid = self.dog()
        org = store.load_org(self.slug)
        org.nodes['child']['parent'] = 'peer'
        store.save_org(org)
        self.clock += 20
        supervisor._wd_activity(self.slug, 'child', 'turn_done')
        self.tick()
        self.assertEqual(self.get(wid)['state'], 'paused')
        self.assertEqual(self.get(wid)['fired'], 0)
        self.assertFalse(self.sent.called)

    def test_fire_revalidates_a_target_moved_after_the_snapshot(self):
        wid = self.dog()
        stale = dict(self.get(wid))
        org = store.load_org(self.slug)
        org.nodes['child']['parent'] = 'peer'
        store.save_org(org)
        self.clock += 20
        supervisor._wd_silence_check(self.slug, stale)
        self.assertEqual(self.get(wid)['state'], 'paused')
        self.assertEqual(self.get(wid)['fired'], 0)
        self.assertFalse(self.sent.called)

    def test_file_lines_reset_only_on_regex_matches(self):
        with tempfile.TemporaryDirectory() as root:
            org = store.load_org(self.slug)
            org.nodes['boss']['scope']['add_dirs'] = [{'path': root, 'mode': 'ro'}]
            store.save_org(org)
            path = Path(root) / 'heartbeat.log'
            path.write_text('noise\n', encoding='utf8')
            wid = self.dog(kind='file', target=str(path), pattern='BEAT', interval_s=15)
            self.tick()
            self.clock += 15
            with path.open('a', encoding='utf8') as f:
                f.write('BEAT\n')
            self.tick()
            self.assertEqual(self.get(wid)['silence_since'], self.stamp())
            self.tick(19)
            self.assertEqual(self.get(wid)['fired'], 0)
            self.tick(1)
            self.assertEqual(self.get(wid)['fired'], 1)

    def test_command_matches_reset_but_spawn_diagnostics_do_not(self):
        wid = self.dog(kind='command', target='echo BEAT', pattern='BEAT')
        for offset, result in ((10, (['BEAT'], 'BEAT', 0)),
                               (10, (['failed to start'], 'failed to start', None))):
            self.clock += offset
            fut = Future()
            fut.set_result(result)
            pool = Mock()
            pool.submit.return_value = fut
            with patch.object(supervisor, '_wd_cmd_pool', pool):
                supervisor._wd_cmd_submit(self.slug, self.get(wid), store.load_org(self.slug), self.clock)
        self.assertEqual(watchdog_config.epoch(self.get(wid)['silence_since']), self.clock - 10)
        self.tick(10)
        self.assertEqual(self.get(wid)['fired'], 1)

    def test_stream_matching_line_resets_before_coalescing_gap(self):
        wid = self.dog(kind='stream', target='echo BEAT', interval_s=60)
        self.clock += 18
        proc = Mock()
        proc.poll.return_value = None
        ent = {'proc': proc, 'buf': ['BEAT'], 'last_fire': self.clock,
               'matched_at': self.stamp(), 'seen': 1, 'last_line': 'BEAT',
               'pushed': -1, 'pushed_at': 0}
        supervisor._wd_streams[(self.slug, wid)] = ent
        self.tick()
        self.assertEqual(self.get(wid)['silence_since'], self.stamp())
        self.assertFalse(self.sent.called)
        self.tick(19)
        self.assertEqual(self.get(wid)['fired'], 0)
        self.tick(1)
        self.assertEqual(self.get(wid)['fired'], 1)

    def test_process_down_edge_is_a_matching_event_then_silence_repeats(self):
        wid = self.dog(kind='process', target='pid:123', interval_s=15)
        def observe(state):
            return patch.object(supervisor.liveness, 'observe',
                                return_value={'state': state, 'reason': 'test observation'})
        with observe('alive'):
            self.tick()
        with observe('dead'):
            self.tick(15)
            self.assertEqual(self.get(wid)['silence_since'], self.stamp())
            self.assertEqual(self.get(wid)['fired'], 0)
            self.tick(20)
            self.assertEqual(self.get(wid)['fired'], 1)
            self.tick(20)
            self.assertEqual(self.get(wid)['fired'], 2)
            self.assertEqual(self.get(wid)['state'], 'armed')

    def test_process_silence_can_filter_the_down_edge_and_legacy_mode_keeps_its_edge(self):
        for mode in ('event', 'silence'):
            with self.subTest(mode=mode):
                w = {'kind': 'process', 'target': 'pid:123', 'pattern': 'not a DOWN edge',
                     'fire_mode': mode, 'high_water': {'up': True}}
                with patch.object(supervisor.liveness, 'observe',
                                  return_value={'state': 'dead', 'reason': 'test'}):
                    lines, _, _ = supervisor._wd_check_poll(self.slug, w, store.load_org(self.slug))
                self.assertEqual(lines, ['pid:123 went DOWN'] if mode == 'event' else [])

    def test_stream_exit_keeps_silence_repeating_and_resume_respawns(self):
        wid = self.dog(kind='stream', target='echo BEAT')
        proc = Mock()
        proc.poll.return_value = 0
        supervisor._wd_streams[(self.slug, wid)] = {'proc': proc, 'buf': []}
        self.tick(20)
        self.assertEqual(self.get(wid)['state'], 'armed')
        self.assertEqual(self.get(wid)['exit']['code'], 0)
        self.assertEqual(self.get(wid)['fired'], 1)
        with patch.object(supervisor, '_wd_popen') as spawn:
            self.tick(20)
            self.assertFalse(spawn.called)
        self.assertEqual(self.get(wid)['fired'], 2)
        org = store.load_org(self.slug)
        org.watchdog_action('boss', wid, 'resume')
        self.assertNotIn('exit', org._watchdog(wid))

    def test_legacy_event_mode_stays_sparse_and_fires_on_activity(self):
        wid = self.dog(fire_mode='event', quiet_period_s=None)
        w = self.get(wid)
        self.assertNotIn('fire_mode', w)
        self.assertNotIn('silence_since', w)
        self.assertEqual(supervisor.wd_list_row(w)['fire_mode'], 'event')
        self.assertEqual(store.load_org(self.slug).tree()['watchdogs'][0]['fire_mode'], 'event')
        supervisor._wd_activity(self.slug, 'child', 'turn_started')
        self.tick()
        self.assertEqual(self.get(wid)['fired'], 1)
        self.assertTrue(self.sent.call_args.kwargs['wake'])

    def test_activity_before_creation_is_excluded_from_a_mixed_batch(self):
        supervisor._wd_activity(self.slug, 'child', 'tool_call old')
        self.clock += 1
        wid = self.dog(fire_mode='event', quiet_period_s=None)
        self.clock += 1
        supervisor._wd_activity(self.slug, 'child', 'turn_done')
        self.tick()
        self.assertEqual(self.get(wid)['last_output'], 'turn_done')
        mail = store.load_org(self.slug).d['mail']['boss'][0]['body']
        self.assertNotIn('tool_call old', mail)

    def test_invalid_settings_are_rejected_without_adding_a_dog(self):
        for kw in ({'fire_mode': 'bad'}, {'quiet_period_s': None},
                   {'quiet_period_s': 0}, {'quiet_period_s': -1},
                   {'quiet_period_s': True}, {'quiet_period_s': 1.5},
                   {'fire_mode': 'event', 'quiet_period_s': 20}):
            with self.subTest(kw=kw), self.assertRaises(ledger.LedgerError):
                self.dog(**kw)
        self.assertFalse(store.load_org(self.slug).d.get('watchdogs'))

    def test_tool_create_activity_silence_and_list(self):
        token = agentauth.child_env(self.slug, 'boss')['ORGTREE_AGENT_TOKEN']
        client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(client.close)
        def call(args):
            return client.post('/api/agent', json={'org': self.slug, 'node': 'boss',
                               'tool': 'orgtree_watchdog', 'args': args},
                               headers={'X-Orgtree-Agent-Token': token})
        r = call({'action': 'create', 'name': 'activity', 'kind': 'activity',
                  'target': 'child', 'fire_mode': 'silence', 'quiet_period_s': 20})
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json().get('result', r.json())
        self.assertEqual(result['fire_mode'], 'silence')
        self.assertIn('watching turns', result['smoke']['ran'])
        r = call({'action': 'list'})
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json().get('result', r.json())
        self.assertEqual(result['watchdogs'][0]['quiet_period_s'], 20)
        self.assertEqual(result['watchdogs'][0]['silence_since'], self.stamp())

    def test_tool_schema_contains_both_modes_and_activity(self):
        props = next(t for t in mcptool.TOOLS if t['name'] == 'orgtree_watchdog')['inputSchema']['properties']
        self.assertEqual(props['fire_mode']['enum'], ['event', 'silence'])
        self.assertIn('activity', props['kind']['enum'])
        self.assertEqual(props['quiet_period_s']['minimum'], 1)


if __name__ == '__main__':
    unittest.main()
