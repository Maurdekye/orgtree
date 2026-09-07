import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-import-integration-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import store, ledger, supervisor, desktop_recovery


def tearDownModule():
    for slug in ('recover', 'history', 'failed'):
        store._POOL.close_all(slug)
    _root.cleanup()


class ImportIntegrationTests(unittest.TestCase):
    def test_failed_admission_preserves_intent_and_never_blindly_retries(self):
        org = store.create_org('failed')
        org.hire(ledger.USER, None, 'haiku', 0, 'active')
        org.nodes['active']['inflight'] = {'text':'do not lose this'}
        org.d['desktop_import'] = {'active_nodes':['active'], 'recovery_pending':True}
        store.save_org(org)
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=RuntimeError('admission rejected')) as drive:
            with self.assertRaises(RuntimeError): desktop_recovery.resume_import('failed')
            with self.assertRaisesRegex(RuntimeError, 'uncertain'): desktop_recovery.resume_import('failed')
            self.assertEqual(drive.call_count, 1)
        metadata = store.load_org('failed').d['desktop_import']
        self.assertTrue(metadata['recovery_pending'])
        self.assertEqual(metadata['recovery_intents']['active']['text'], 'do not lose this')

    def test_recovery_drives_only_active_after_saved_release(self):
        org = store.create_org('recover')
        for nid in ('active', 'idle'):
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        org.nodes['active']['inflight'] = {'text':'continue exact turn', 'view':'visible original'}
        org.post_mail(ledger.USER, 'idle', 'queued but not active')
        org.d['desktop_import'] = {'active_nodes':['active'], 'recovery_pending':True}
        store.save_org(org)
        driven = []
        def drive(slug, nid, text, **kwargs):
            persisted = store.load_org(slug)
            self.assertNotIn('inflight', persisted.nodes[nid])
            driven.append((nid, text, kwargs))
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=drive):
            result = desktop_recovery.resume_import('recover')
            again = desktop_recovery.resume_import('recover')
        self.assertEqual([row[0] for row in driven], ['active'])
        self.assertIn('continue exact turn', driven[0][1])
        self.assertEqual(driven[0][2]['view'], 'visible original')
        self.assertEqual(result['pending'], [])
        self.assertTrue(again['already_reconciled'])
        self.assertTrue(store.load_org('recover').waking_mail('idle'))

    def test_archive_stays_visible_after_native_history_arrives(self):
        org = store.create_org('history')
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        path = Path(_root.name) / 'imports/history/history/worker.jsonl'
        path.parent.mkdir(parents=True)
        path.write_text('{"type":"assistant","message":{"role":"assistant","content":"copied original"}}\n', encoding='utf-8')
        org.nodes['worker']['desktop_import'] = {'history':'imports/history/history/worker.jsonl', 'source_session_id':'old-session'}
        with patch.object(supervisor, 'transcript_path', return_value=None):
            before = supervisor.read_chat(org, 'worker', hold_back=False)
        with patch.object(supervisor, '_read_chat_current', return_value={'messages':[{'text':'new native turn'}], 'total':1}):
            after = supervisor.read_chat(org, 'worker', hold_back=False)
            limited = supervisor.read_chat(org, 'worker', last=1, hold_back=False)
        self.assertEqual(before['messages'][0]['text'], 'copied original')
        self.assertEqual(after['messages'][0]['event_id'], before['messages'][0]['event_id'])
        self.assertEqual([m['text'] for m in after['messages']], ['copied original', 'new native turn'])
        self.assertEqual(limited['messages'][0]['text'], 'new native turn')
        self.assertEqual(limited['total'], 2)


if __name__ == '__main__': unittest.main()
