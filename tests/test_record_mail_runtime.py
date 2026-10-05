"""Mailbox delivery stages share the ordered runtime clock, never record bodies."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from orgtree.orgdb.record_mail_runtime import MailboxOverlays


class MailRuntime(unittest.TestCase):
    def test_grace_deadline_without_later_write_and_lifecycle_cancellation(self):
        import asyncio
        from datetime import datetime, timezone
        from unittest.mock import Mock
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        from orgtree.orgdb.record_registry import Selection

        async def exercise(action):
            host = OrgHost('org', self.fail)
            frames, timers = [], []
            now = [100.0]
            def schedule(delay, callback):
                handle = Mock()
                timers.append((delay, callback, handle))
                return handle
            selected = Selection('sub:1',('1',),({'kind':'agent_mail','agent':'1'},))
            host.runner.clients['one'] = SimpleNamespace(selections={1:selected},pending=set())
            host.sends['one'] = lambda frame: frames.append(frame) or True
            batch = {'tok':'batch','at':datetime.fromtimestamp(100, timezone.utc).isoformat()}
            inputs = RuntimeInputs(Cursor('uuid','inc',5),
                {'1':dict(id='agent',state='archived',ask=None,tier='unknown')},
                {'1':SimpleNamespace()}, {}, held=frozenset({'1'}),
                mail={'1':dict(slug='org',name='agent',leased=False,batches=[batch])},
                mail_held=frozenset({'1'}))
            with patch('orgtree.supervisor.state', return_value={'queue':[]}), patch(
                    'orgtree.orgdb.record_host.time.time', side_effect=lambda: now[0]), patch.object(
                    asyncio.get_running_loop(), 'call_later', side_effect=schedule):
                changed = host._adopt(inputs)
                if action == 'crossed':
                    now[0] = 110.001  # expires between projection and scheduling
                host._partial(changed)
                initial = frames[-1]['agents']['1']
                self.assertEqual(initial['mail_stages'], {'batch':'steer'})
                delay, fire, timer = timers[-1]
                self.assertEqual(delay, 0.0 if action == 'crossed' else 10.0)
                if action in ('expire', 'crossed'):
                    now[0] = 110.001
                    fire()  # only time passed: no revision, HTTP read or transition
                    final = frames[-1]['agents']['1']
                    self.assertEqual(final['mail_stages'], {'batch':'stranded'})
                    self.assertGreater(final['seq'], initial['seq'])
                    self.assertEqual(final['epoch'], initial['epoch'])
                    self.assertIsNone(host._mail_timer)
                    self.assertEqual(len(timers), 1)
                else:
                    if action == 'unsubscribe':
                        host.unsubscribe('one', 1)
                    elif action == 'identity':
                        host._adopt(RuntimeInputs(Cursor('new','inc',0),{},{},{},
                            held=frozenset(),mail={},mail_held=frozenset()))
                    else:
                        await host.close()
                    timer.cancel.assert_called()
                    self.assertIsNone(host._mail_timer)
                    before = len(frames)
                    now[0] = 110.0
                    fire()  # even an already-queued stale callback is fenced
                    self.assertEqual(len(frames), before)

        for action in ('expire','crossed','unsubscribe','identity','close'):
            with self.subTest(action=action):
                asyncio.run(exercise(action))

    def test_http_and_join_workers_cannot_restore_unsubscribed_mailboxes(self):
        import asyncio
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        from orgtree.orgdb.record_registry import Selection

        async def exercise(join):
            host = OrgHost('org', self.fail)
            inputs = RuntimeInputs(Cursor('uuid','inc',5),
                {'1':dict(id='agent',state='archived',ask=None,tier='unknown')},
                {'1':SimpleNamespace()}, {}, held=frozenset({'1'}),
                mail={'1':dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])},
                mail_held=frozenset({'1'}))
            selected = Selection('sub:1',('1',),({'kind':'agent_mail','agent':'1'},))
            host.runner.clients['one'] = SimpleNamespace(selections={1:selected},pending=set())
            frames = []
            host.sends['one'] = lambda frame: frames.append(frame) or True
            entered, release = asyncio.Event(), asyncio.Event()

            async def held_read(*args, **kwargs):
                entered.set()
                await release.wait()
                return {'type':'records'}, inputs

            with patch.object(host.runner.run, 'wake'), patch.object(host, '_read', side_effect=held_read), patch(
                    'orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}) as stages:
                host._adopt(inputs)
                task = asyncio.create_task(host.join('new', lambda frame: frames.append(frame) or True)
                                           if join else host.http(selections=(selected,)))
                await entered.wait()
                host.unsubscribe('one', 1)
                frames.clear()
                release.set()
                await task
                self.assertEqual(host.overlay._mail, {})
                self.assertEqual(host.overlay.full()['agents']['1']['mail_stages'], {})
                for frame in frames:
                    self.assertFalse(frame.get('agents',{}).get('1',{}).get('mail_stages'))
                stages.reset_mock()
                host.transition(['agent'])
                stages.assert_not_called()

        for join in (False, True):
            with self.subTest(join=join):
                asyncio.run(exercise(join))

    def test_socket_unsubscribe_keeps_overlap_and_late_worker_cannot_restore_inputs(self):
        from orgtree import record_api
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        from orgtree.orgdb.record_registry import Selection
        host = OrgHost('org',self.fail)
        source = dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])
        inputs = RuntimeInputs(Cursor('uuid','inc',5),
            {'1':dict(id='agent',state='archived',ask=None,tier='unknown')},
            {'1':SimpleNamespace()}, {}, held=frozenset({'1'}),
            mail={'1':source},mail_held=frozenset({'1'}))
        selected = Selection('sub:1',('1',),({'kind':'agent_mail','agent':'1'},))
        for token in ('one','two'):
            host.runner.clients[token] = SimpleNamespace(selections={1:selected},pending=set())
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            host._adopt(inputs)
            record_api.socket_message(host,'one','{"type":"unsubscribe","sub":1}')
            self.assertIn('1',host.overlay._mail)
            host.leave('two')
            self.assertEqual(host.overlay._mail,{})
            changed = host._adopt(inputs)  # the already-running snapshot finishes
            host._published(SimpleNamespace(answers={},runtime=changed))
            self.assertEqual(host.overlay._mail,{})
            self.assertEqual(host.overlay.full()['agents']['1']['mail_stages'],{})

    def test_host_adopts_mail_only_after_cursor_fence_and_clears_on_unsubscribe(self):
        from orgtree.orgdb.record_host import OrgHost, RuntimeInputs
        from orgtree.orgdb.record_reads import Cursor
        body = dict(id='agent',state='archived',ask=None,tier='unknown')
        context = SimpleNamespace()
        host = OrgHost('org',self.fail)
        source = dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            changed = host._adopt(RuntimeInputs(Cursor('uuid','inc',5),{'1':body},{'1':context},{},
                held=frozenset({'1'}),mail={'1':source},mail_held=frozenset({'1'})))
            self.assertEqual(changed['1']['mail_stages'],{'batch':'queued'})
            stale = RuntimeInputs(Cursor('uuid','inc',4),{},{},{},held=frozenset({'1'}),
                                  mail={},mail_held=frozenset())
            self.assertEqual(host._adopt(stale),{})
            self.assertIn('1',host.overlay._mail)
            cleared = host._adopt(RuntimeInputs(Cursor('uuid','inc',5),{},{},{},
                held=frozenset({'1'}),mail={},mail_held=frozenset()))
            self.assertEqual(cleared['1']['mail_stages'],{})
            self.assertEqual(host.overlay._mail,{})

    def test_stage_transition_uses_retained_inputs_and_increases_sequence(self):
        source = dict(slug='org',name='agent',leased=True,batches=[{'tok':'batch'}])
        body = dict(id='agent',state='archived',ask=None,tier='unknown')
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}) as stages:
            overlay = MailboxOverlays('uuid','inc')
            overlay.adopt_mail({'1':source})
            overlay.adopt({'1':body},{'1':SimpleNamespace()})
            initial = overlay.full()['agents']['1']
            self.assertEqual(initial['mail_stages'],{'batch':'queued'})
            stages.assert_called_with('org','agent',[{'tok':'batch'}],leased=True)
            source['batches'].clear()
            stages.return_value = {'batch':'steer'}
            changed = overlay.transition(['agent'])['1']
            self.assertGreater(changed['seq'],initial['seq'])
            self.assertEqual(changed['epoch'],initial['epoch'])
            self.assertEqual(changed['mail_stages'],{'batch':'steer'})
            stages.assert_called_with('org','agent',[{'tok':'batch'}],leased=True)
            self.assertNotIn('mail_stages',body)

    def test_unsubscribe_drops_retained_batches_and_sends_empty_stage_map(self):
        with patch('orgtree.supervisor._delivery_stages',return_value={'batch':'queued'}):
            overlay = MailboxOverlays('uuid','inc')
            overlay.adopt_mail({'1':dict(slug='org',name='agent',leased=False,batches=[{'tok':'batch'}])})
            overlay.adopt({'1':dict(id='agent',state='archived',ask=None,tier='unknown')},{'1':SimpleNamespace()})
            changed = overlay.adopt_mail({},removed=('1',))
            self.assertEqual(changed['1']['mail_stages'],{})
            self.assertEqual(overlay._mail,{})


if __name__ == '__main__':
    unittest.main()
