"""Transcript lookup tolerates absent and explicitly null import metadata."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import desktop_native, supervisor


class TranscriptPathNullMetadataTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='transcript-null-')
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        self.sid = str(uuid.uuid4())
        self.path = self.root / 'projects' / 'fixture' / (self.sid + '.jsonl')
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{"type":"user"}\n', encoding='utf-8')
        self.addCleanup(supervisor._TPATH_MEMO.clear)

    def node_org(self, model, **metadata):
        return SimpleNamespace(nodes={'agent': {
            'model': model, 'session_id': self.sid, **metadata,
        }})

    def test_null_desktop_import_uses_existing_transcript(self):
        for model in ('fable', 'or-test'):
            with self.subTest(model=model), \
                    patch.object(supervisor, '_transcript_root', return_value=str(self.root)), \
                    patch.object(desktop_native, 'native_session_path', side_effect=AssertionError('not bound')):
                org = self.node_org(model, desktop_import=None)
                self.assertEqual(supervisor.transcript_path_for_node(org, 'agent'), str(self.path))

    def test_null_native_continuity_uses_existing_transcript(self):
        for model in ('fable', 'or-test'):
            with self.subTest(model=model), \
                    patch.object(supervisor, '_transcript_root', return_value=str(self.root)), \
                    patch.object(desktop_native, 'native_session_path', side_effect=AssertionError('not bound')):
                org = self.node_org(model, desktop_import={'native_continuity': None})
                self.assertEqual(supervisor.transcript_path_for_node(org, 'agent'), str(self.path))

    def test_null_import_without_transcript_returns_none(self):
        self.path.unlink()
        for model in ('fable', 'or-test'):
            with self.subTest(model=model), \
                    patch.object(supervisor, '_transcript_root', return_value=str(self.root)), \
                    patch.object(supervisor, 'journal_store', return_value=str(self.root / 'journal')):
                self.assertIsNone(supervisor.transcript_path_for_node(
                    self.node_org(model, desktop_import=None), 'agent'))

    def test_absent_empty_and_ready_metadata_keep_lookup_behavior(self):
        for model in ('fable', 'or-test'):
            for metadata in ({}, {'desktop_import': {}},
                             {'desktop_import': {'native_continuity': {}}}):
                with self.subTest(model=model, metadata=metadata), \
                        patch.object(supervisor, '_transcript_root', return_value=str(self.root)):
                    self.assertEqual(supervisor.transcript_path_for_node(
                        self.node_org(model, **metadata), 'agent'), str(self.path))
            org = self.node_org(model, desktop_import={'native_continuity': {'status': 'ready'}})
            with self.subTest(model=model, ready=True), \
                    patch.object(desktop_native, 'native_session_path', return_value='bound.jsonl') as bound, \
                    patch.object(supervisor, 'transcript_path', side_effect=AssertionError('not ordinary')):
                self.assertEqual(supervisor.transcript_path_for_node(org, 'agent'), 'bound.jsonl')
                bound.assert_called_once_with(org, 'agent')

    def test_missing_node_and_session_return_none(self):
        org = self.node_org('fable', desktop_import=None)
        org.nodes['agent']['session_id'] = None
        with patch.object(supervisor, '_transcript_root', side_effect=AssertionError('no session')):
            self.assertIsNone(supervisor.transcript_path_for_node(org, 'agent'))
            self.assertIsNone(supervisor.transcript_path_for_node(org, 'missing'))


if __name__ == '__main__':
    unittest.main()
