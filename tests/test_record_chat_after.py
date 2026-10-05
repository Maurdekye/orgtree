"""Incremental transcript reads stop at an indexed, identity-fenced anchor."""
import import_provenance  # noqa: F401
import copy
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from orgtree import chat_after, api, transcript_records


def payload(*ranks):
    return {'conversation_id': 'session', 'assistant_scope': 'scope', 'order_epoch': 1,
            'messages': [{'row_id': str(n), 'event_id': str(n), 'seq': n,
                          'role': 'user', 'text': str(n)} for n in ranks]}


def cursor(n):
    return chat_after.finish(payload(n), None, ['org', 'agent'])['after']


class ChatAfter(unittest.TestCase):
    def test_anchor_lookup_uses_real_order_store_and_rejects_rebalance_or_wrong_row(self):
        source = 'record-chat-after-control'
        rows = [{'event_id': 'anchor'}]
        epoch = transcript_records.order(source, rows)
        rank = rows[0]['seq']
        self.assertTrue(transcript_records.valid_order_anchor(source, 'anchor', rank, epoch))
        self.assertFalse(transcript_records.valid_order_anchor(source, 'missing', rank, epoch))
        self.assertFalse(transcript_records.valid_order_anchor(source, 'anchor', rank + 1, epoch))
        with transcript_records.database() as conn:
            plan = conn.execute('EXPLAIN QUERY PLAN SELECT rank FROM transcript_order WHERE source=? AND event=?',
                                (source, 'anchor')).fetchall()
            self.assertTrue(any('SEARCH' in str(row) for row in plan), plan)
            transcript_records._rebalance(conn, source)
        self.assertFalse(transcript_records.valid_order_anchor(source, 'anchor', rank, epoch))

    def test_assistant_revision_update_does_not_resend_it_as_a_new_message(self):
        old = payload(1)
        old['messages'][0].update(assistant_id='a', assistant_revision=1)
        token = chat_after.finish(old, None, ['org', 'agent'])['after']
        fresh = copy.deepcopy(old)
        fresh['messages'][0].update(text='complete', assistant_revision=2)
        out, rank = chat_after.prepare(fresh, token, ['org', 'agent'], Mock(), lambda *a: True)
        out = chat_after.finish(out, rank, ['org', 'agent'])
        self.assertEqual(out['messages'], [])
        self.assertEqual(out['message_updates'][0]['text'], 'complete')

    def test_same_tail_sends_only_new_rows_and_empty_delta_keeps_cursor(self):
        page = Mock(side_effect=AssertionError('must not page inactive history'))
        for rows, wanted in [((1, 2, 3, 4), [4]), ((1, 2, 3), [])]:
            out, rank = chat_after.prepare(payload(*rows), cursor(3), ['org', 'agent'], page, lambda *a: True)
            out = chat_after.finish(out, rank, ['org', 'agent'])
            self.assertEqual([r['seq'] for r in out['messages']], wanted)
            self.assertTrue(out['incremental'])
            self.assertIn('after', out)
        page.assert_not_called()

    def test_burst_pages_only_new_interval_and_preserves_evidence_until_finish(self):
        newest = dict(payload(7, 8), before='p6')
        pages = {'p6': dict(payload(4, 5, 6), before='p3'), 'p3': dict(payload(1, 2, 3), before='inactive')}
        reader = Mock(side_effect=lambda key: pages[key])
        out, rank = chat_after.prepare(newest, cursor(3), ['org', 'agent'], reader, lambda *a: True)
        self.assertEqual([r['seq'] for r in out['messages']], list(range(1, 9)))
        self.assertEqual(reader.call_count, 2)
        self.assertEqual([r['seq'] for r in chat_after.finish(out, rank, ['org', 'agent'])['messages']], list(range(4, 9)))

    def test_replacement_or_missing_anchor_returns_explicit_baseline_without_paging(self):
        reader = Mock(side_effect=AssertionError('no old history lookup'))
        for change in ({'conversation_id': 'replacement'}, {'order_epoch': 2}, {'assistant_scope': 'new'}):
            out, rank = chat_after.prepare(dict(payload(10), **change), cursor(3), ['org', 'agent'], reader, lambda *a: True)
            self.assertTrue(out['after_reset']); self.assertIsNone(rank)
        out, rank = chat_after.prepare(payload(10), cursor(3), ['org', 'agent'], reader, lambda *a: False)
        self.assertTrue(out['after_reset']); self.assertIsNone(rank)
        reader.assert_not_called()

    def test_bad_cursor_and_nonadvancing_or_reordered_pages_are_rejected(self):
        with self.assertRaises(ValueError):
            chat_after.prepare(payload(1), 'not-base64!', ['org', 'agent'], Mock(), Mock())
        for page in (dict(payload(7, 8), before='same'), dict(payload(4, 5), order_epoch=2)):
            with self.assertRaises(ValueError):
                chat_after.prepare(dict(payload(7, 8), before='same'), cursor(3), ['org', 'agent'], lambda _: page, lambda *a: True)

    def test_api_filters_only_after_pending_mail_proof(self):
        org = SimpleNamespace(d={'mail': {'agent': [{'id': 'old', 'from': 'user', 'at': 'at', 'body': 'old'}]}},
                              node=lambda _: {'session_id': 'session'})
        initial = payload(1, 2)
        initial['conversation_id'] = 'inc:session'
        initial['messages'][0]['text'] = 'old evidence'
        token = chat_after.finish(copy.deepcopy(initial), None, ['org', 'agent'])['after']
        with patch.object(api.store, 'load_org', return_value=org), \
                patch.object(api, '_CHAT_RUNTIME_VIEW', False), \
                patch.object(api.supervisor, '_transcript_incarnation', return_value='inc'), \
                patch.object(api.supervisor, 'read_chat', return_value=copy.deepcopy(initial)), \
                patch.object(api.supervisor, 'delivering_mail', return_value=[]), \
                patch.object(api.supervisor, 'mail_marker_in', side_effect=lambda text, m: text == 'old evidence'), \
                patch('orgtree.chat_window.source_key', return_value='source'), \
                patch('orgtree.transcript_records.valid_order_anchor', return_value=True):
            out = api.node_chat('org', 'agent', after=token)
        self.assertEqual(out['messages'], [])
        self.assertEqual(out['pending_mail'], [])
        self.assertTrue(out['incremental'])


if __name__ == '__main__':
    unittest.main()
