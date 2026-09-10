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
