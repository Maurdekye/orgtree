"""A keeper pass shares inventory discovery, never per-session validation."""
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import uuid
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import desktop_native as native, supervisor as sup, warmpool as warm


class NativeInventoryPassTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-pass-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'session.jsonl'
        self.path.write_text('{"type":"user"}\n', encoding='utf-8')
        self.ids = [str(uuid.uuid4()) for _ in range(12)]
        self.found = {sid: str(self.path) for sid in self.ids}

    def test_keeper_walks_once_across_orgs_and_walks_again_next_pass(self):
        orgs = {}
        for slug, ids in (('a', self.ids[:6]), ('b', self.ids[6:])):
            orgs[slug] = SimpleNamespace(d={'slug': slug}, nodes={
                str(i): {'state': 'live', 'model': 'sol', 'session_id': sid,
                         'hard_fail_run': True} for i, sid in enumerate(ids)})
        with ExitStack() as stack:
            stack.enter_context(patch.object(warm, 'warm_enabled', return_value=True))
            stack.enter_context(patch.object(warm.policy_context, 'read', side_effect=orgs.__getitem__))
            stack.enter_context(patch.object(warm.policy_context, 'org_rows', return_value=[{'slug': s} for s in orgs]))
            stack.enter_context(patch.object(warm, '_org_fingerprint', return_value=''))
            stack.enter_context(patch.object(warm, '_busy', return_value=True))
            stack.enter_context(patch.object(warm, 'node_excluded', return_value=False))
            stack.enter_context(patch.object(warm, '_pool', {}))
            stack.enter_context(patch.object(warm, '_serving', {}))
            stack.enter_context(patch.object(sup, '_transcript_root', return_value=None))
            walk = stack.enter_context(patch.object(native, '_native_inventory', return_value=(self.found, set())))
            lookup = stack.enter_context(patch.object(sup, 'transcript_path', wraps=sup.transcript_path))
            warm._keeper_pass()
            self.assertEqual(lookup.call_count, 12)
            self.assertEqual(walk.call_count, 1)
            first = lookup.call_args.kwargs['inventory']
            warm._keeper_pass({'a', 'b'})
            self.assertEqual(lookup.call_count, 24)
            self.assertEqual(walk.call_count, 2)
            self.assertIsNot(first, lookup.call_args.kwargs['inventory'])

    def test_shared_inventory_still_validates_path_each_time(self):
        inventory = native.NativeInventory()
        with patch.object(native, '_native_inventory', return_value=(self.found, set())) as walk:
            self.assertEqual(native.native_path_for_session(self.ids[0], inventory=inventory), str(self.path))
            self.path.write_text('{"type":"session_meta"}\n', encoding='utf-8')
            self.assertIsNone(native.native_path_for_session(self.ids[0], inventory=inventory))
            self.assertEqual(walk.call_count, 1)

    def test_ad_hoc_inventory_is_fresh_and_duplicate_id_still_refused(self):
        with patch.object(native, '_native_inventory', side_effect=[
                (self.found, set()), (self.found, {self.ids[0]})]) as walk:
            self.assertEqual(native.native_path_for_session(self.ids[0]), str(self.path))
            with self.assertRaises(native.NativeHeld):
                native.native_path_for_session(self.ids[0])
            self.assertEqual(walk.call_count, 2)


if __name__ == '__main__':
    unittest.main()
