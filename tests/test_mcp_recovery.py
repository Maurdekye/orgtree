"""Recovery must never mistake inventory, text, or local probes for a turn."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import io
import json
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

_fixture = tempfile.TemporaryDirectory(prefix='mcp-recovery-')
os.environ['ORGTREE_DATA'] = _fixture.name
os.environ['ORGTREE_WARM'] = '0'
from orgtree import mcp_recovery as recovery
from orgtree import warmpool


def proc():
    return SimpleNamespace(pid=123, poll=lambda: None,
                           _orgtree_mcp_monitor=recovery.Monitor())


def status(monitor, value, name='orgtree'):
    sent = []
    monitor.probe(sent.append)
    request = json.loads(sent[0])
    event = {'type': 'control_response', 'response': {
        'subtype': 'success', 'request_id': request['request_id'],
        'response': {'mcpServers': [{'name': name, 'status': value}]}}}
    return event


def broken():
    p = proc()
    p._orgtree_mcp_monitor.observe(status(p._orgtree_mcp_monitor, 'failed'))
    return p


class Health(unittest.TestCase):
    def setUp(self):
        recovery._retries.clear()

    def test_actual_named_failure_and_reconnection(self):
        p = broken()
        self.assertTrue(p._orgtree_mcp_monitor.broken())
        self.assertTrue(p._orgtree_mcp_monitor.observe(status(p._orgtree_mcp_monitor, 'connected')))
        self.assertFalse(p._orgtree_mcp_monitor.broken())

    def test_startup_failure(self):
        m = recovery.Monitor()
        self.assertFalse(m.observe({'type': 'system', 'subtype': 'init',
                                   'mcp_servers': [{'name': 'orgtree', 'status': 'failed'}]}))
        self.assertTrue(m.broken())

    def test_pending_external_failure_and_empty_inventory_are_not_loss(self):
        for name, value in [('orgtree', 'pending'), ('external', 'failed')]:
            m = recovery.Monitor()
            m.observe(status(m, value, name))
            self.assertFalse(m.broken())
        m.observe({'type': 'system', 'subtype': 'init', 'tools': [], 'mcp_servers': []})
        self.assertFalse(m.broken())

    def test_previously_present_server_missing_from_status_is_loss(self):
        m = recovery.Monitor()
        m.observe(status(m, 'connected'))
        event = status(m, 'connected')
        event['response']['response']['mcpServers'] = []
        self.assertTrue(m.observe(event))
        self.assertTrue(m.broken())

    def test_bad_status_shape_does_not_break_stdout_pump(self):
        m = recovery.Monitor()
        self.assertTrue(m.observe(status(m, {'unexpected': 'object'})))
        self.assertFalse(m.broken())

    def test_text_and_wrong_generation_reply_are_not_evidence(self):
        m, other = recovery.Monitor(), recovery.Monitor()
        self.assertFalse(m.observe(status(other, 'failed')))
        m.observe({'type': 'assistant', 'message': {'content': 'orgtree CONNECT_TIMEOUT'}})
        self.assertFalse(m.broken())

    def test_only_our_control_response_is_consumed(self):
        m = recovery.Monitor()
        event = status(m, 'failed')
        self.assertTrue(m.observe(event))
        self.assertTrue(m.observe(event))
        self.assertFalse(m.observe({'type': 'result'}))

    def test_delayed_probe_reply_never_acknowledges_mail(self):
        m = recovery.Monitor()
        old = status(m, 'failed')
        current = status(m, 'connected')
        self.assertTrue(m.observe(old))
        self.assertFalse(m.broken())
        self.assertTrue(m.observe(current))
        self.assertFalse(m.broken())

    def test_malformed_status_does_not_fail_or_restart(self):
        m = recovery.Monitor()
        for event in [None, [], {'type': 'control_response', 'response': None}]:
            self.assertFalse(m.observe(event))
        self.assertFalse(recovery.observe_line(proc(), 'not json'))

    def test_recovery_backoff_spans_process_generations_and_caps(self):
        at = 100.0
        for delay in [30, 60, 120, 240, 480, 900, 900]:
            p = broken()
            info = recovery.reserve('org', 'agent', 'same-session', p, at)
            self.assertEqual(info['retry_after_s'], delay)
            self.assertIsNone(recovery.reserve('org', 'agent', 'same-session', p, at + delay))
            self.assertIsNone(recovery.reserve('org', 'agent', 'same-session', broken(), at + delay - 1))
            at += delay

    def test_healthy_ping_does_not_reset_restart_storm_backoff(self):
        recovery.reserve('o', 'n', 's', broken(), 100)
        p = broken()
        p._orgtree_mcp_monitor.observe(status(p._orgtree_mcp_monitor, 'connected'))
        p._orgtree_mcp_monitor.observe(status(p._orgtree_mcp_monitor, 'disconnected'))
        self.assertIsNone(recovery.reserve('o', 'n', 's', p, 110))

    def test_codex_inventory_is_not_subject_to_recovery(self):
        p = SimpleNamespace(pid=1, mcp_servers=[], dynamicTools=[])
        self.assertIsNone(recovery.reserve('o', 'n', 's', p))

    def test_successor_session_is_independent(self):
        recovery.reserve('o', 'n', 'old', broken(), 100)
        self.assertIsNotNone(recovery.reserve('o', 'n', 'new', broken(), 101))

    def test_boundary_requests_once_and_does_not_kill(self):
        wp = SimpleNamespace(slug='o', nid='n', sid='context-kept', proc=broken())
        with patch.object(warmpool, '_journal') as journal, patch.object(warmpool, '_kill_proc') as kill:
            self.assertTrue(warmpool._mcp_recovery_boundary(wp))
            self.assertTrue(warmpool._mcp_recovery_boundary(wp))
            kill.assert_not_called()
            journal.assert_called_once()
            self.assertEqual(journal.call_args.kwargs['session_id'], 'context-kept')

    def test_idle_recovery_uses_generation_cas(self):
        wp = SimpleNamespace(slug='o', nid='n', sid='s', proc=broken())
        with patch.object(warmpool, 'kill_node', return_value=True) as kill, patch.object(warmpool, '_journal') as journal:
            self.assertTrue(warmpool._mcp_recover_idle(wp))
            kill.assert_called_once_with('o', 'n', 'mcp-disconnected', expected=wp)
            journal.assert_called_once()

    def test_idle_claim_race_refuses_and_does_not_record_restart(self):
        wp = SimpleNamespace(slug='o', nid='n', sid='s', proc=broken())
        with patch.object(warmpool, 'kill_node', return_value=False), patch.object(warmpool, '_journal') as journal:
            self.assertFalse(warmpool._mcp_recover_idle(wp))
            journal.assert_not_called()
            self.assertFalse(wp.proc._orgtree_mcp_monitor.restarting)

    def test_claimed_process_cannot_be_killed_by_idle_recovery(self):
        wp = SimpleNamespace(slug='o', nid='n', sid='s', proc=broken(), claimed=True)
        with patch.dict(warmpool._pool, {('o', 'n'): wp}, clear=True), patch.object(warmpool, '_kill_proc') as kill:
            self.assertFalse(warmpool._mcp_recover_idle(wp))
            kill.assert_not_called()

    def test_boundary_declines_reuse_before_identity_or_store_access(self):
        wp = SimpleNamespace(slug='o', nid='n', sid='s', proc=broken())
        with patch.object(warmpool, 'warm_decision', return_value=(True, True)), patch.object(warmpool, '_journal'):
            self.assertEqual(warmpool.boundary_check('o', 'n', 'hash', wp), (False, True, 'mcp-disconnected'))

    def test_dead_stdio_child_overrides_stale_connected_status(self):
        p = proc()
        m = p._orgtree_mcp_monitor
        m.observe(status(m, 'connected'))
        with patch.object(recovery, 'stdio_child_present', return_value=False):
            m.check_transport(p, 100)
            self.assertFalse(m.broken())
            m.check_transport(p, 130)
        m.observe(status(m, 'connected'))
        self.assertTrue(m.broken())
        self.assertEqual(recovery.reserve('o', 'n', 's', p)['reason'], 'orgtree MCP stdio child exited')

    def test_child_scan_unknown_never_means_dead(self):
        p = proc()
        m = p._orgtree_mcp_monitor
        m.observe(status(m, 'connected'))
        with patch.object(recovery, 'stdio_child_present', return_value=None):
            m.check_transport(p, 100)
            m.check_transport(p, 1000)
        self.assertFalse(m.broken())

    def test_reconnected_child_clears_missing_transport(self):
        p = proc()
        m = p._orgtree_mcp_monitor
        m.observe(status(m, 'connected'))
        with patch.object(recovery, 'stdio_child_present', return_value=False):
            m.check_transport(p, 100)
            m.check_transport(p, 130)
        with patch.object(recovery, 'stdio_child_present', return_value=True):
            m.check_transport(p, 140)
        self.assertFalse(m.broken())

    def test_native_delta_beats_stale_status_and_readdition_clears_it(self):
        m = recovery.Monitor()
        delta = {'type': 'attachment', 'attachment': {'type': 'deferred_tools_delta',
            'failedMcpServers': [{'name': 'orgtree', 'errorCode': 'CONNECT_TIMEOUT'}]}}
        m.observe(delta)
        m.observe(status(m, 'connected'))
        self.assertTrue(m.broken())
        m.observe({'type': 'attachment', 'attachment': {'type': 'deferred_tools_delta',
            'addedNames': ['mcp__orgtree__orgtree_work']}})
        self.assertFalse(m.broken())

    def test_transcript_tail_ignores_old_failure_and_reads_partial_new_record(self):
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'session.jsonl'
            event = json.dumps({'type': 'attachment', 'attachment': {'type': 'deferred_tools_delta',
                'failedMcpServers': [{'name': 'orgtree'}]}}).encode()
            path.write_bytes(event + b'\n')
            tail = recovery.TranscriptTail(lambda: str(path))
            m = recovery.Monitor()
            tail.read(m)
            self.assertFalse(m.broken())
            with path.open('ab') as stream:
                stream.write(event[:30])
            tail.read(m)
            self.assertFalse(m.broken())
            with path.open('ab') as stream:
                stream.write(event[30:] + b'\n')
            tail.read(m)
            self.assertTrue(m.broken())

    def test_transcript_tail_reads_new_file_but_never_agent_quoted_delta(self):
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'new-session.jsonl'
            tail = recovery.TranscriptTail(lambda: str(path) if path.exists() else None)
            m = recovery.Monitor()
            path.write_text(json.dumps({'type': 'assistant', 'attachment': {
                'type': 'deferred_tools_delta', 'failedMcpServers': [{'name': 'orgtree'}]}}) + '\n')
            tail.read(m)
            self.assertFalse(m.broken())

    def test_keeper_busy_never_attempts_recovery(self):
        org = SimpleNamespace(nodes={'n': {'state': 'live'}})
        wp = SimpleNamespace(slug='o', nid='n', sid='s', proc=broken(), alive=lambda: True, hash='h')
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(patch.object(warmpool, 'warm_enabled', return_value=True))
            stack.enter_context(patch.object(warmpool.policy_context, 'read', return_value=org))
            stack.enter_context(patch.object(warmpool, '_org_fingerprint', return_value='fp'))
            stack.enter_context(patch.object(warmpool, 'eligible', return_value=(True, '')))
            stack.enter_context(patch.object(warmpool, '_busy', return_value=True))
            stack.enter_context(patch.object(warmpool, '_unchanged', return_value=True))
            stack.enter_context(patch.dict(warmpool._serving, {('o', 'n'): wp}, clear=True))
            stack.enter_context(patch.dict(warmpool._pool, {}, clear=True))
            recover = stack.enter_context(patch.object(warmpool, '_mcp_recover_idle'))
            warmpool._keeper_pass({'o'})
            recover.assert_not_called()

    def test_keeper_replaces_failed_idle_process_with_same_session(self):
        org = SimpleNamespace(nodes={'n': {'state': 'live', 'session_id': 'same-context'}})
        old = SimpleNamespace(slug='o', nid='n', sid='same-context', proc=broken(), alive=lambda: True, hash='h', claimed=False)
        replacement = []
        def spawn(current, nid, why):
            new = proc()
            new._orgtree_mcp_monitor.observe(status(new._orgtree_mcp_monitor, 'connected'))
            replacement.append((current.nodes[nid]['session_id'], new))
        from contextlib import ExitStack
        with ExitStack() as stack:
            for name, value in [('warm_enabled', True), ('_org_fingerprint', 'fp'), ('eligible', (True, '')), ('_busy', False), ('_snapshot_seen', ('h', {})), ('_unchanged', True)]:
                stack.enter_context(patch.object(warmpool, name, return_value=value))
            stack.enter_context(patch.object(warmpool.policy_context, 'read', return_value=org))
            stack.enter_context(patch.dict(warmpool._pool, {('o', 'n'): old}, clear=True))
            stack.enter_context(patch.object(warmpool, 'kill_node', return_value=True))
            stack.enter_context(patch.object(warmpool, '_journal'))
            stack.enter_context(patch.object(warmpool, '_prewarm_node', side_effect=spawn))
            warmpool._keeper_pass({'o'})
        self.assertEqual(replacement[0][0], 'same-context')
        self.assertFalse(replacement[0][1]._orgtree_mcp_monitor.broken())

    def test_stdout_pump_consumes_health_reply_but_preserves_tool_result(self):
        p = broken()
        health = status(p._orgtree_mcp_monitor, 'failed')
        result = json.dumps({'type': 'result', 'result': 'already applied'})
        p.stdout = io.StringIO(json.dumps(health) + '\n' + result + '\n')
        wp = object.__new__(warmpool.WarmProc)
        wp.proc, wp.slug, wp.nid = p, 'o', 'n'
        wp._lk, wp.active, wp.dead = threading.Lock(), True, threading.Event()
        import queue
        wp.lines = queue.Queue()
        with patch.object(warmpool, '_on_proc_exit'):
            wp._pump_out()
        self.assertEqual(wp.lines.get_nowait(), result)
        self.assertIsNone(wp.lines.get_nowait())
        self.assertTrue(wp.lines.empty())
        self.assertTrue(p._orgtree_mcp_monitor.stopped.is_set())


if __name__ == '__main__':
    unittest.main()
