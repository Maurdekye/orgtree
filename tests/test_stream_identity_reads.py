"""Stream identity misses must not wait for an unrelated Org rebuild."""
import json
import threading
from unittest.mock import patch
import unittest

from test_prose_delta_lock import ProseDeltaBase
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import assistant_messages, reply_events, store, supervisor


class StreamIdentityReads(ProseDeltaBase):
    def mint(self):
        reply_events.identity(self.slug, 'agent')
        assistant_messages.scope_ident(self.slug, 'agent')

    def change(self, **fields):
        org = store.load_org(self.slug)
        org.node('agent').update(fields)
        store.save_org(org)

    def test_cold_stream_completes_while_shared_rebuild_is_blocked(self):
        self.mint()
        self.change(charter='unrelated save invalidates the stream caches')
        gate = store._rebuild_mutex(self.slug)
        entered, done = threading.Event(), threading.Event()
        rows, errors = [], []

        def stream():
            entered.set()
            try:
                for text in ('first ', 'second ', 'third'):
                    rows.append(supervisor.capture_reply_stream(self.slug, 'agent',
                        {'kind': 'delta', 'text': text, 'assistant_id': 'bounded-stream'}))
            except BaseException as exc:
                errors.append(exc)
            finally:
                done.set()

        gate.acquire()
        thread = threading.Thread(target=stream)
        try:
            thread.start()
            self.assertTrue(entered.wait(2))
            completed_before_release = done.wait(2)
        finally:
            gate.release()
            thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(completed_before_release, 'stream joined the unrelated Org rebuild')
        self.assertEqual([r['reply_quote'] for r in rows], ['first ', 'first second ', 'first second third'])
        scope, generation = reply_events.identity(self.slug, 'agent')
        for row in rows:
            self.assertEqual(reply_events.lookup(self.slug, 'agent', generation, row['event_id'], scope),
                             row['reply_quote'])

    def test_commit_during_projection_is_not_cached_as_current(self):
        self.mint()
        real_read = store.read_stream_identity
        for method, forget in ((reply_events.identity, reply_events._ident_forget),
                               (assistant_messages.scope_ident, assistant_messages._scope_forget)):
            with self.subTest(method=method.__name__):
                forget()
                before = method(self.slug, 'agent')
                forget()
                read, release = threading.Event(), threading.Event()
                result, errors = [], []

                def paused_read(slug, nid):
                    value = real_read(slug, nid)
                    read.set()
                    if not release.wait(5):
                        raise AssertionError('writer did not release reader')
                    return value

                def reader():
                    try:
                        result.append(method(self.slug, 'agent'))
                    except BaseException as exc:
                        errors.append(exc)

                with patch.object(store, 'read_stream_identity', paused_read):
                    thread = threading.Thread(target=reader)
                    thread.start()
                    try:
                        self.assertTrue(read.wait(5))
                        node = store.load_org(self.slug).node('agent')
                        self.change(generation=int(node['generation']) + 1,
                                    session_id='next-' + str(node['generation']),
                                    reply_incarnation='next-' + str(node['generation']))
                    finally:
                        release.set()
                        thread.join(10)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(result, [before])
                after = method(self.slug, 'agent')
                self.assertNotEqual(after, before)
                org = store.load_org(self.slug)
                expected = ((reply_events.incarnation(org, 'agent'), int(org.node('agent')['generation']))
                            if method is reply_events.identity else assistant_messages.scope(org, 'agent'))
                self.assertEqual(after, expected)

    def test_projection_does_not_materialize_unrelated_rows(self):
        self.mint()
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN')
            try:
                # Valid identity rows beside deliberately unreadable unrelated data.
                conn.execute("INSERT INTO nodes(id,ord,val) VALUES (?,?,?)", ('unrelated', 999, 'not-json'))
                conn.execute("INSERT INTO doc(key,val) VALUES (?,?)", ('unrelated_poison', 'not-json'))
                conn.execute('COMMIT')
                fields = store.read_stream_identity(self.slug, 'agent')
                self.assertTrue(fields['org_reply'])
                self.assertTrue(fields['node_reply'])
                self.assertTrue(fields['transcript'])
                self.assertEqual(fields['generation'], 0)
            finally:
                conn.execute("DELETE FROM nodes WHERE id=?", ('unrelated',))
                conn.execute("DELETE FROM doc WHERE key=?", ('unrelated_poison',))

    def test_missing_unminted_and_legacy_nodes_keep_fallback(self):
        # Fresh fixtures have not minted a transcript identity.
        fields = store.read_stream_identity(self.slug, 'agent')
        self.assertFalse(fields['transcript'])
        self.assertIsNone(store.read_stream_identity(self.slug, 'missing'))
        with self.assertRaises(store.LedgerError):
            reply_events.identity(self.slug, 'missing')
        self.mint()
        org = store.load_org(self.slug)
        self.assertEqual(assistant_messages.scope_ident(self.slug, 'agent'),
                         assistant_messages.scope(org, 'agent'))
        with store._POOL.acquire(self.slug) as conn:
            # A legacy blob takes precedence even if stale row-table data remain.
            conn.execute("INSERT INTO doc(key,val) VALUES (?,?)", ('nodes', json.dumps(org.nodes)))
            try:
                self.assertIsNone(store.read_stream_identity(self.slug, 'agent'))
            finally:
                conn.execute("DELETE FROM doc WHERE key='nodes'")
        with patch.object(store, 'row_store', return_value=False):
            self.assertIsNone(store.read_stream_identity(self.slug, 'agent'))


if __name__ == '__main__':
    unittest.main()
