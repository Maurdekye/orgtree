"""Per-org capability activation and legacy protocol preservation."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import asyncio
import copy
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, WebSocketDisconnect
from orgtree import api, record_api as A
from orgtree.orgdb import registry


class Readiness(unittest.TestCase):
    def test_off_never_reads_a_database_and_missing_migration_never_enables(self):
        raw = Mock()
        with patch.object(registry, 'connection', side_effect=AssertionError('off database checkout')):
            for enabled, ready in ((False, True), (True, False), (False, False)):
                with patch.object(A.orgdb, 'enabled', return_value=enabled), patch.object(A, 'READY', ready):
                    self.assertFalse(A.capable('org'))
                    self.assertFalse(A.capable(raw=raw))
        raw.execute.assert_not_called()
        with patch.object(A.orgdb, 'enabled', return_value=True), patch.object(A, 'READY', True):
            for relations in ((None, None, None), ('schema', None, 'revisions')):
                raw.reset_mock()
                raw.execute.return_value.fetchone.return_value = relations
                self.assertFalse(A.capable(raw=raw))
                self.assertEqual(raw.execute.call_count, 1)
            for marker in (False, True):
                raw.reset_mock()
                raw.execute.return_value.fetchone.side_effect = [('schema','changes','revisions'),(marker,)]
                self.assertEqual(A.capable(raw=raw), marker)
                self.assertEqual(raw.execute.call_args.args[1], ('0018_records.sql',))

    def test_no_readiness_cache_or_swallowed_database_failure(self):
        raw = Mock()
        raw.execute.return_value.fetchone.side_effect = [
            ('schema','changes','revisions'),(True,),('schema','changes','revisions'),(False,)]
        with patch.object(A.orgdb, 'enabled', return_value=True), patch.object(A, 'READY', True), \
                patch.object(registry, 'connection') as connection:
            connection.return_value.__enter__.return_value = raw
            self.assertTrue(A.capable('one'))
            self.assertFalse(A.capable('two'))
            self.assertEqual([c.args for c in connection.call_args_list],[('one',),('two',)])
            raw.execute.side_effect = RuntimeError('failed metadata read')
            with self.assertRaisesRegex(RuntimeError,'failed metadata read'):
                A.capable('one')
            connection.side_effect = registry.OrgUnavailable('missing')
            with self.assertRaises(A.foreground_store.OrgNotFound):
                A.capable('missing')

    def test_full_tree_advertisement_does_not_modify_cached_org(self):
        body = {'roots':[], 'name':'example'}
        org = Mock()
        org.tree.side_effect = lambda: copy.deepcopy(body)
        request = SimpleNamespace(state=SimpleNamespace())
        with patch.object(api.store,'cached_org',return_value=org), \
                patch.object(api,'_org_rev',return_value=3), \
                patch.object(api,'_current_sync_rev',return_value=0), \
                patch.object(api.supervisor,'primed_restart',return_value=None), \
                patch.object(api,'_annotate_org_view',side_effect=lambda org,tree,*a,**k:tree):
            for ready in (False,True):
                with patch.object(A,'capable',return_value=ready) as capability:
                    result = api._org_view('example',request,None)
                    self.assertEqual(result.get('capabilities',{}).get('record_changes_v1',False),ready)
                    capability.assert_called_once_with('example')
                self.assertEqual(body, {'roots':[], 'name':'example'})


class Transport(unittest.IsolatedAsyncioTestCase):
    async def test_unmigrated_http_and_socket_never_create_record_host(self):
        socket = SimpleNamespace(receive_text=AsyncMock(side_effect=['old ping',WebSocketDisconnect()]))
        hub = SimpleNamespace(join=AsyncMock(),leave=Mock())
        with patch.object(A,'capable',return_value=False), \
                patch.object(A.orgdb,'enabled',return_value=True), \
                patch.object(A,'host',side_effect=AssertionError('unmigrated host')), \
                patch.object(A.S,'resolve',side_effect=AssertionError('unmigrated selection')), \
                patch.object(api,'hub',hub):
            for call in (lambda:A.records('old'),lambda:A.changes('old','0','u','i'),lambda:A.selection('old')):
                with self.assertRaises(HTTPException) as caught:
                    await call()
                self.assertEqual(caught.exception.status_code,501)
            await api.org_ws(socket,'old')
            hub.leave.assert_called_once_with('old',socket)

    async def test_ready_socket_checks_database_off_event_loop(self):
        import threading
        loop_thread = threading.get_ident()
        seen = []
        def readiness(slug):
            seen.append(threading.get_ident())
            return True
        socket = SimpleNamespace(receive_text=AsyncMock(side_effect=WebSocketDisconnect()))
        current = SimpleNamespace(join=AsyncMock(return_value=True),leave=Mock())
        hub = SimpleNamespace(join=AsyncMock(),leave=Mock(),record=Mock(),record_pages=Mock())
        with patch.object(A,'capable',side_effect=readiness),patch.object(A,'host',return_value=current), \
                patch.object(api,'hub',hub):
            await api.org_ws(socket,'new')
        self.assertEqual(len(seen),1)
        self.assertNotEqual(seen[0],loop_thread)
        current.join.assert_awaited_once()
        current.leave.assert_called_once_with(socket)

    async def test_record_only_room_has_no_coalescing_but_legacy_and_switch_off_do(self):
        loop = asyncio.get_running_loop()
        hub = api.Hub()
        native, legacy = object(),object()
        hub.rooms['org'] = {native}
        hub._boxes[native] = api._Outbox('org')
        hub._boxes[native].records = True
        with patch.object(api,'hub',hub),patch.object(api,'_LOOP',loop), \
                patch.object(A,'READY',True),patch.object(A.orgdb,'enabled',return_value=True), \
                patch.object(A,'transition') as transition,patch.object(api,'_legacy_hub_changed') as changed:
            api.hub_changed('org')
            await asyncio.sleep(0)
            changed.assert_not_called()
            transition.assert_called_once_with('org')
            hub.rooms['org'].add(legacy)
            hub._boxes[legacy] = api._Outbox('org')
            api.hub_changed('org')
            await asyncio.sleep(0)
            changed.assert_called_once_with('org')
            changed.reset_mock()
            hub.rooms['org'].remove(legacy)
            with patch.object(A.orgdb,'enabled',return_value=False):
                api.hub_changed('org')
                changed.assert_called_once_with('org')
            changed.reset_mock()
            with patch.object(A,'READY',False):
                api.hub_changed('org')
                changed.assert_called_once_with('org')


if __name__ == '__main__':
    unittest.main()