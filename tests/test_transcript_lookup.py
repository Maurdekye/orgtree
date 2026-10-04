"""Fresh native identity lookup without fleet-wide header reads or lock convoys."""
import builtins
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-transcript-lookup-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import desktop_import, desktop_native as native, ledger, store, supervisor
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class TranscriptLookupTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(_root.name).resolve() / 'imports' / uuid.uuid4().hex / 'native'
        self.folder = self.base / 'agent'
        self.folder.mkdir(parents=True)
        self.sid = str(uuid.uuid4())
        self.path = self.folder / (self.sid + '.jsonl')
        self.path.write_text('{"type":"user"}\n', encoding='utf-8')

    def bound_org(self):
        return {'slug': self.base.parent.name, 'nodes': {'agent': {
            'session_id': self.sid, 'desktop_import': {'native_continuity': {
                'status': 'ready', 'session_id': self.sid,
                'path': str(self.path.relative_to(Path(_root.name).resolve()))}}}}}

    def test_display_warm_path_uses_one_stat_and_no_fleet_walk(self):
        org = self.bound_org()
        for index in range(240):
            folder = self.base / ('archived-' + str(index))
            folder.mkdir()
            (folder / (str(uuid.uuid4()) + '.jsonl')).write_text('{"type":"user"}\n')
        with patch.object(native, '_native_inventory', side_effect=AssertionError('display walked fleet')):
            self.assertEqual(native.native_session_path(org, 'agent', display=True), str(self.path))
            with patch.object(Path, 'lstat', autospec=True, side_effect=Path.lstat) as inspected, \
                    patch.object(Path, 'resolve', side_effect=AssertionError('warm display resolved parents')):
                for _ in range(12):
                    self.assertEqual(native.native_session_path(org, 'agent', display=True), str(self.path))
            # The recorded file is validated once per read, independently of
            # archive size. No parent path is re-walked on a warm display read.
            self.assertEqual(inspected.call_count, 12)

    def test_display_move_and_replacement_invalidate_remembered_path(self):
        org = self.bound_org()
        self.assertEqual(native.native_session_path(org, 'agent', display=True), str(self.path))
        moved_folder = self.base / 'moved'; moved_folder.mkdir()
        moved = moved_folder / self.path.name
        self.path.rename(moved)
        with patch.object(native, '_native_inventory', wraps=native._native_inventory) as scanned:
            self.assertEqual(native.native_session_path(org, 'agent', display=True), str(moved))
            self.assertEqual(scanned.call_count, 1)
            self.assertEqual(native.native_session_path(org, 'agent', display=True), str(moved))
            self.assertEqual(scanned.call_count, 1)
            moved.write_text('{"type":"assistant","value":"replacement"}\n')
            self.assertEqual(native.native_session_path(org, 'agent', display=True), str(moved))
            self.assertEqual(scanned.call_count, 2)
            native.forget_display_session(self.sid)
            self.assertEqual(native.native_session_path(org, 'agent', display=True), str(moved))
            self.assertEqual(scanned.call_count, 3)

    def test_display_cache_does_not_bypass_authoritative_collision_check(self):
        org = self.bound_org()
        self.assertEqual(native.native_session_path(org, 'agent', display=True), str(self.path))
        other = self.base / 'new-duplicate'; other.mkdir()
        (other / self.path.name).write_text('{"type":"user"}\n')
        self.assertEqual(native.native_session_path(org, 'agent', display=True), str(self.path))
        self.assertIsNone(native.native_session_path(org, 'agent'))

    def test_cache_semantic_projection_never_resolves_session_files(self):
        org = store.create_org('semantic-' + uuid.uuid4().hex)
        org.hire(ledger.USER, None, 'opus', 0, 'agent')
        org.node('agent')['desktop_import'] = {'native_continuity': {'status': 'ready'}}
        try:
            with patch.object(supervisor, '_build_cmd', wraps=supervisor._build_cmd) as built, \
                    patch.object(supervisor, 'transcript_path', side_effect=AssertionError('forecast resolved transcript')), \
                    patch.object(native, 'native_session_path', side_effect=AssertionError('forecast validated resume')):
                tools, argv = supervisor._cache_semantic_inputs(org, 'agent', 'claude')
            self.assertTrue(tools and argv)
            self.assertFalse(built.call_args.kwargs['session_probe'])
            self.assertFalse(built.call_args.kwargs['native_probe'])
        finally:
            store._POOL.close_all(org.d['slug'])

    def test_lookup_opens_only_requested_header_and_sees_new_collision(self):
        for _ in range(80):
            (self.folder / (str(uuid.uuid4()) + '.jsonl')).write_text('{"type":"session_meta"}\n')
        with patch.object(builtins, 'open', wraps=builtins.open) as opened, \
                patch.object(native, '_native_inventory', wraps=native._native_inventory) as scanned:
            self.assertEqual(native.native_path_for_session(self.sid), str(self.path))
        self.assertEqual(scanned.call_count, 1)
        self.assertEqual([str(c.args[0]) for c in opened.call_args_list], [str(self.path)])
        other = self.base / 'duplicate'; other.mkdir()
        duplicate = other / self.path.name
        duplicate.write_text('{"type":"session_meta"}\n')
        with self.assertRaisesRegex(native.NativeHeld, 'Duplicate'):
            native.native_path_for_session(self.sid)
        duplicate.unlink()
        self.assertEqual(native.native_path_for_session(self.sid), str(self.path))
        self.path.write_text('{"type":"session_meta"}\n')
        self.assertIsNone(native.native_path_for_session(self.sid))

    def test_reparse_directory_refused_before_descent(self):
        target = Path(_root.name) / ('target-' + uuid.uuid4().hex); target.mkdir()
        link = self.base / 'linked-agent'
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        else:
            link.symlink_to(target, target_is_directory=True)
        try:
            with self.assertRaisesRegex(desktop_import.ImportRefused, 'Links and reparse'):
                native.native_path_for_session(self.sid)
        finally:
            if os.name == 'nt':
                os.rmdir(link)  # Remove the junction itself, never recurse.
            else:
                link.unlink()
            self.assertTrue(target.is_dir())
        self.assertEqual(native.native_path_for_session(self.sid), str(self.path))

    def test_projection_resolves_once_even_on_cold_reload_and_warm_read(self):
        org = store.create_org('projection-' + uuid.uuid4().hex)
        org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(org)
        sid = org.node('agent')['session_id']
        supervisor._codex_journal(org.d['slug'], sid, [{'type':'assistant',
            'message': {'id':'message-1','role':'assistant','content':[{'type':'text','text':'hello'}]}}])
        try:
            for _ in range(2):
                with patch.object(supervisor, 'transcript_path', wraps=supervisor.transcript_path) as resolved, \
                        patch.object(native, '_native_inventory', side_effect=AssertionError('ordinary desk scanned imported fleet')):
                    chat = supervisor.read_chat(org, 'agent', last=1, hold_back=False)
                self.assertEqual(chat['messages'][0]['text'], 'hello')
                self.assertEqual(resolved.call_count, 1)
        finally:
            store._POOL.close_all(org.d['slug'])

    def test_directory_replaced_after_enumeration_is_rechecked(self):
        target = Path(_root.name).resolve() / ('replacement-' + uuid.uuid4().hex)
        target.mkdir()
        backup = self.base / 'agent-original'
        original_scandir = os.scandir
        replaced = []

        class Entry:
            def __init__(entry, source):
                entry.path = source.path
                entry.source = source
            def stat(entry, **kwargs):
                info = entry.source.stat(**kwargs)
                if Path(entry.path) == self.folder and not replaced:
                    self.folder.rename(backup)
                    if os.name == 'nt':
                        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(self.folder), str(target)], capture_output=True)
                        self.assertEqual(result.returncode, 0)
                    else:
                        self.folder.symlink_to(target, target_is_directory=True)
                    replaced.append(True)
                return info

        @contextmanager
        def scanning(path):
            with original_scandir(path) as entries:
                yield (Entry(entry) for entry in entries) if Path(path) == self.base else entries

        try:
            with patch.object(os, 'scandir', scanning):
                with self.assertRaisesRegex(desktop_import.ImportRefused, 'Links and reparse'):
                    native.native_path_for_session(self.sid)
            self.assertEqual(replaced, [True], 'replacement control must actually run')
        finally:
            if replaced:
                if os.name == 'nt':
                    os.rmdir(self.folder)
                else:
                    self.folder.unlink()
                backup.rename(self.folder)
            self.assertTrue(target.is_dir())
        self.assertEqual(native.native_path_for_session(self.sid), str(self.path))


if __name__ == '__main__':
    unittest.main()
