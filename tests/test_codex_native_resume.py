"""Wire-only imported rollout control; no app server or provider is launched."""
import unittest
from unittest.mock import patch
from engine.backend.orgtree import codexrun
from engine.backend.orgtree.codexrun import CodexTurn


class Recorder:
    def bind(self, **kwargs): pass
    def initialize(self): pass
    def close(self): pass
    def request(self, method, params):
        self.method, self.params = method, params
        raise RuntimeError('stop at resume before turn/start')


class NativeResumeTests(unittest.TestCase):
    def test_compaction_fork_uses_imported_path_before_any_compact_turn(self):
        client=Recorder()
        with patch.object(codexrun,'AppServerClient',return_value=client):
            with self.assertRaises(RuntimeError):
                codexrun.compact_fork([],cwd='C:/destination',model='model',
                    thread_id='imported-id',resume_path='C:/native/rollout.jsonl',timeout=1)
        self.assertEqual(client.method,'thread/fork')
        self.assertEqual(client.params['path'],'C:/native/rollout.jsonl')
        self.assertEqual(client.params['cwd'],'C:/destination')

    def test_explicit_rollout_and_destination_cwd_without_changing_normal_resume(self):
        for path in (None, 'C:/isolated/imports/org/native/node/fork.jsonl'):
            with self.subTest(path=path):
                client=Recorder()
                turn=CodexTurn([],cwd='C:/isolated/workspace',model='model',effort=None,
                    thread_id='fork-id',resume_path=path,client=client)
                with self.assertRaisesRegex(RuntimeError,'stop at resume'):
                    turn.start('not dispatched')
                self.assertEqual(client.method,'thread/resume')
                self.assertEqual(client.params['threadId'],'fork-id')
                if path:
                    self.assertEqual(client.params['path'],path)
                    self.assertEqual(client.params['cwd'],'C:/isolated/workspace')
                else:
                    self.assertNotIn('path',client.params)
                    self.assertNotIn('cwd',client.params)
