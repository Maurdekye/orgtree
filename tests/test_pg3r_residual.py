"""PG-3r: the residual DOC_LOCK sites no family owns, converted to org_tx / org_read.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * bridge credential rotation commits through ONE org_tx that names only the
    two credential sections, never waits on DOC_LOCK, bumps the org revision
    by one, and still verifies that the previous credential is refused;
  * gitworkspace.org_facts and history_page read without DOC_LOCK (a reader
    completes while another thread holds DOC_LOCK);
  * an applied pending shrink commits only the `disk` section, lock-free;
  * the reply and transcript incarnation mints are row transactions (reply
    ids, then the transcript id), keep a value once minted, and a caller
    inside a legacy DOC_LOCK hold keeps the legacy mint;
  * an Antigravity billing-route change cuts the lineage in ONE row
    transaction over the seat and its `nid@<gen>` bearer row, lock-free.

Run:  python tools/run-python-verification.py tests/test_pg3r_residual.py
"""

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-pg3r-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import bridgeauth, gitworkspace, orgtx, store  # noqa: E402


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _while_doc_lock_is_held(fn):
    """Run fn on this thread while ANOTHER thread holds DOC_LOCK; fail if fn
    waits for it (a converted site must never take or wait on DOC_LOCK)."""
    held, release = threading.Event(), threading.Event()

    def holder():
        with store.DOC_LOCK:
            held.set()
            release.wait(10)

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    assert held.wait(5)
    out: dict = {}
    worker = threading.Thread(target=lambda: out.update(v=fn()), daemon=True)
    worker.start()
    worker.join(5)
    finished = not worker.is_alive()
    release.set()
    t.join(5)
    worker.join(5)
    return finished, out.get('v')


class BridgeRotation(unittest.TestCase):
    def setUp(self) -> None:
        self.slug = _fresh_org('Bridge Rot')
        self.key = b'k' * 32
        self.patches = [patch.object(bridgeauth, 'legacy_credentials_allowed', return_value=False),
                        patch.object(bridgeauth, 'install_key', return_value=self.key),
                        patch.object(bridgeauth, '_is_sandboxed', return_value=True)]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()

    def test_rotation_is_one_row_transaction_and_refuses_the_old_credential(self):
        before = bridgeauth.org_credential(store.load_org(self.slug))
        self.assertEqual(bridgeauth.resolve_org_credential(before), self.slug)
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            finished, receipt = _while_doc_lock_is_held(lambda: bridgeauth.rotate_org_credential(self.slug))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'rotation waited on DOC_LOCK')
        self.assertEqual(len(seen), 1, 'exactly one commit')
        self.assertEqual(receipt['previous_generation'] + 1, receipt['generation'])
        self.assertTrue(receipt['old_credential_rejected'])
        self.assertIsNone(bridgeauth.resolve_org_credential(before))
        after = bridgeauth.org_credential(store.load_org(self.slug))
        self.assertEqual(bridgeauth.resolve_org_credential(after), self.slug)
        self.assertEqual(store.load_org(self.slug).d['bridge_credential_generation'], receipt['generation'])


class LockFreeReads(unittest.TestCase):
    def test_org_facts_reads_without_doc_lock(self):
        slug = _fresh_org('Facts Org')
        finished, facts = _while_doc_lock_is_held(lambda: gitworkspace.org_facts(slug))
        self.assertTrue(finished, 'org_facts waited on DOC_LOCK')
        self.assertEqual(facts['slug'], slug)
        self.assertIn('a', facts['nodes'])

    def test_history_page_reads_without_doc_lock(self):
        from orgtree import history
        slug = _fresh_org('History Org')
        section = next(k for k, v in history.SECTIONS.items() if not v[2])
        finished, page = _while_doc_lock_is_held(lambda: history.history_page(slug, section))
        self.assertTrue(finished, 'history_page waited on DOC_LOCK')
        self.assertIn('items', page)


class PendingShrink(unittest.TestCase):
    def test_applied_shrink_commits_only_the_disk_section_without_doc_lock(self):
        from orgtree import disk, sandbox
        slug = _fresh_org('Shrink Org')
        org = store.load_org(slug)
        org.d['disk'] = {'size_mb': 4096, 'pending_size_mb': 2048}
        store.save_org(org)
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with patch.object(disk, 'mount'), patch.object(disk, 'usage', return_value=(10 * 1048576, 0)), \
                    patch.object(disk, 'shrink_image') as shrink:
                finished, note = _while_doc_lock_is_held(
                    lambda: sandbox.try_apply_pending_resize(store.load_org(slug)))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the pending shrink waited on DOC_LOCK')
        self.assertIsNone(note)
        shrink.assert_called_once_with(slug, 2048)
        self.assertEqual(len(seen), 1)
        self.assertEqual(store.load_org(slug).d['disk'], {'size_mb': 2048})


class TranscriptIncarnation(unittest.TestCase):
    def test_mint_is_a_row_transaction_on_the_node_and_is_kept_once_minted(self):
        from orgtree import transcript_records
        slug = _fresh_org('Incarnation Org')
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            finished, first = _while_doc_lock_is_held(
                lambda: transcript_records.incarnation(store.load_org(slug), 'a'))
            # two row transactions: the reply ids (reply_events.incarnation), then the transcript id
            self.assertEqual(len(seen), 2)
            again = transcript_records.incarnation(orgtx.org_read(slug), 'a')
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the mint waited on DOC_LOCK')
        self.assertTrue(first)
        self.assertEqual(again, first)
        self.assertEqual(len(seen), 2, 'the second call found the minted values and committed nothing')
        ids = store.load_org(slug)
        self.assertTrue(ids.d['reply_incarnation'] and ids.node('a')['reply_incarnation'])
        self.assertEqual(store.load_org(slug).node('a')['transcript_incarnation'], first)

    def test_a_caller_inside_a_legacy_hold_keeps_the_legacy_mint(self):
        from orgtree import transcript_records
        slug = _fresh_org('Held Incarnation Org')
        with patch.object(orgtx, 'org_tx', side_effect=AssertionError('no org_tx inside a DOC_LOCK hold')):
            with store.DOC_LOCK:
                value = transcript_records.incarnation(store.load_org(slug), 'a')
        self.assertEqual(store.load_org(slug).node('a')['transcript_incarnation'], value)


class AntigravityLineage(unittest.TestCase):
    def test_billing_route_change_is_one_row_transaction_over_seat_and_bearer(self):
        from orgtree import antigravity_session, supervisor
        slug = _fresh_org('Lineage Org')
        org = store.load_org(slug)
        org.node('a').update(antigravity_account='old-acct', antigravity_conversation='conv-1',
                              session_id='sid-1')
        store.save_org(org)
        gen = store.load_org(slug).node('a').get('generation', 0)
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with patch.object(supervisor, 'export_predecessor_transcript', return_value=None), \
                    patch.object(supervisor, '_log_turn_error') as logged:
                caller = store.load_org(slug)
                finished, changed = _while_doc_lock_is_held(lambda: antigravity_session.prepare_lineage(
                    caller, 'a', {'conversation_id': 'conv-1', 'account': 'new-acct'}))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the lineage cut waited on DOC_LOCK')
        self.assertTrue(changed)
        self.assertEqual(len(seen), 1)
        logged.assert_called_once()
        after = store.load_org(slug)
        self.assertIn(f'a@{gen}', after.nodes, 'the bearer row the archive inserts')
        self.assertNotIn('antigravity_account', after.node('a'))
        self.assertNotIn('antigravity_conversation', after.node('a'))
        self.assertIn(f'a@{gen}', caller.nodes, "the caller's org carries the committed document")

    def test_unchanged_route_writes_nothing(self):
        from orgtree import antigravity_session
        slug = _fresh_org('Lineage Same Org')
        org = store.load_org(slug)
        org.node('a').update(antigravity_account='same', antigravity_conversation='conv-1')
        store.save_org(org)
        with patch.object(orgtx, 'org_tx', side_effect=AssertionError('no transaction for an unchanged route')):
            self.assertFalse(antigravity_session.prepare_lineage(
                store.load_org(slug), 'a', {'conversation_id': 'conv-1', 'account': 'same'}))


if __name__ == '__main__':
    unittest.main()
