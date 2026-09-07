"""Wire-only imported rollout control; no app server or provider is launched."""
import unittest
from engine.backend.orgtree.codexrun import CodexTurn


class Recorder:
    def bind(self, **kwargs): pass
    def initialize(self): pass
    def request(self, method, params):
        self.method, self.params = method, params
        raise RuntimeError('stop at resume before turn/start')


class NativeResumeTests(unittest.TestCase):
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
