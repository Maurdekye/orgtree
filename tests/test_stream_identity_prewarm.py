"""Startup warms one real identity without changing data or walking the fleet."""
import asyncio
from contextlib import ExitStack
import threading
from unittest.mock import patch
import unittest

from test_prose_delta_lock import ProseDeltaBase
from orgtree import assistant_messages, reply_events, store


class StreamIdentityPrewarm(ProseDeltaBase):
    def test_real_projection_runs_once_without_mint_or_org_materialization(self):
        before = store.read_stream_identity(self.slug, 'agent')
        seq = store.org_seq(self.slug)
        with patch.object(store, 'org_slugs', return_value=[self.slug, 'must-not-open']), \
             patch.object(store, 'cached_org', side_effect=AssertionError('full Org read')), \
             patch.object(store, 'load_org', side_effect=AssertionError('full Org read')), \
             patch.object(store, 'read_stream_identity', wraps=store.read_stream_identity) as read:
            self.assertTrue(store.prewarm_stream_identity())
        read.assert_called_once_with(self.slug, 'agent')
        self.assertEqual(store.read_stream_identity(self.slug, 'agent'), before)
        self.assertEqual(store.org_seq(self.slug), seq)
        self.assertNotIn((self.slug, 'agent'), reply_events._ident_cache)
        self.assertNotIn((self.slug, 'agent'), assistant_messages._scope_cache)

    def test_empty_and_legacy_backends_do_not_read_or_write_nodes(self):
        with patch.object(store, 'org_slugs', return_value=[]):
            self.assertFalse(store.prewarm_stream_identity())
        with patch.object(store, 'row_store', return_value=False), \
             patch.object(store, 'org_slugs', side_effect=AssertionError('legacy listing')):
            self.assertFalse(store.prewarm_stream_identity())

    def test_refused_org_does_not_stop_warming_a_usable_org(self):
        with patch.object(store, 'org_slugs', return_value=['missing-org', self.slug]):
            self.assertTrue(store.prewarm_stream_identity())


class ReadinessOrdering(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_waits_for_warmup_before_starting_recovery(self):
        from orgtree import api, registry_migration, startup
        entered, release = threading.Event(), threading.Event()
        events = []
        def warm():
            events.append('warm-start')
            entered.set()
            if not release.wait(5):
                raise AssertionError('warmup gate not released')
            events.append('warm-end')
        with ExitStack() as stack:
            stack.enter_context(patch.object(api, '_deployment_preflight'))
            stack.enter_context(patch.object(registry_migration, 'run_startup_migration'))
            stack.enter_context(patch.object(registry_migration, 'run_apikey_cutover'))
            stack.enter_context(patch.object(api, '_start_revision_feed'))
            stack.enter_context(patch.object(store, 'arm_doc_lock_tripwire_from_env'))
            stack.enter_context(patch.object(store, 'prewarm_stream_identity', side_effect=warm))
            start = stack.enter_context(patch.object(startup.recovery, 'start',
                side_effect=lambda _: events.append('recovery')))
            task = asyncio.create_task(api._wire_notify())
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                self.assertFalse(task.done(), 'readiness overtook identity warmup')
                start.assert_not_called()
            finally:
                release.set()
                await task
            self.assertEqual(events, ['warm-start', 'warm-end', 'recovery'])


if __name__ == '__main__':
    unittest.main()
