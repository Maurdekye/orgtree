"""Host app-value producers: independent cadence, failure and shutdown."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import unittest
from unittest.mock import Mock, patch

from orgtree.app_runtime import Publishers, start


class Runtime(unittest.IsolatedAsyncioTestCase):
    async def test_slow_value_does_not_delay_others_and_shutdown_cancels(self):
        started, cancelled, published = asyncio.Event(), asyncio.Event(), asyncio.Event()
        result = []
        async def slow():
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        async def fast():
            return {'answer': 42}
        def publish(key, value):
            result.append((key, value))
            published.set()
        producers = Publishers(publish, self.fail)
        producers.add('slow', slow)
        producers.add('fast', fast)
        await asyncio.wait_for(published.wait(), 1)
        await started.wait()
        self.assertEqual(result, [('fast', {'answer': 42})])
        await producers.close()
        self.assertTrue(cancelled.is_set())
        self.assertEqual(producers.tasks, [])

    async def test_last_failed_value_retries_on_its_next_period_with_no_client(self):
        attempts, errors, values = [], [], []
        published = asyncio.Event()
        async def read():
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError('first failed')
            return 9
        def publish(key, value):
            values.append((key, value))
            published.set()
        producers = Publishers(publish, errors.append, period=.001)
        producers.add('usage', read)
        try:
            await asyncio.wait_for(published.wait(), 1)
            self.assertEqual(values, [('usage', 9)])
            self.assertEqual(len(errors), 1)
        finally:
            await producers.close()

    async def test_registered_sources_are_complete_without_running_provider_io(self):
        # Inspect production registrations with only add mocked. No provider
        # reader, login CLI, network request or live store is called.
        with patch.object(Publishers, 'add') as add:
            result = start(Mock(), Mock())
        keys = [call.args[0] for call in add.call_args_list]
        self.assertEqual(set(keys), {'usage', 'codex_usage', 'antigravity_usage',
            'openrouter_usage', 'usage_peek', 'codex_usage_peek', 'antigravity_usage_peek',
            'openrouter_usage_peek', 'providers', 'accounts', 'account_readout',
            'account_usage', 'defaults', 'openrouter', 'registered_usage',
            'prefer_reserve_default', 'primed_restart'})
        self.assertEqual(len(keys), len(set(keys)))
        await result.close()

    async def test_registered_usage_keeps_endpoint_identity_metadata(self):
        from orgtree import api, registry
        with patch.object(Publishers, 'add') as add:
            result = start(Mock(), Mock())
        read = next(call.args[1] for call in add.call_args_list if call.args[0] == 'registered_usage')
        expected = {'account': 'openai-1', 'name': 'openai/second', 'label': 'openai/second', 'limits': []}
        with patch.object(registry, 'list_accounts', return_value=[{'id': 'openai-1'}]), \
                patch.object(api, '_accounts_usage', return_value=expected) as projection:
            self.assertEqual(await read(), {'openai-1': expected})
            projection.assert_called_once_with('openai-1')
        await result.close()


if __name__ == '__main__':
    unittest.main()
