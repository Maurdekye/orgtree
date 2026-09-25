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
    transaction over the seat and its `nid@<gen>` bearer row, lock-free;
  * the disk-migration flip is ONE whole-org transaction (nodes=ALL) that
    carries the floored-cap notice;
  * api.py's unclaimed routes: document_dismiss, the forced self-restart's
    gate and cost record, and `unstick_rows` (the release in
    _continue_on_account) are row transactions that never wait on DOC_LOCK.

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
from orgtree.ledger import USER  # noqa: E402


def _fresh_org(name: str, nodes=('a',)) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    for nid in nodes:
        org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None, 'children': [], 'state': 'live',
                               'created': '2026-09-25T00:00:00Z'}
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

    def run():
        try:
            out['v'] = fn()
        except BaseException as e:  # re-raised below, on the test's thread
            out['e'] = e

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(5)
    finished = not worker.is_alive()
    release.set()
    t.join(5)
    worker.join(5)
    if 'e' in out:
        raise out['e']
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


class DiskMigrationFlip(unittest.TestCase):
    def test_flip_is_one_whole_org_row_transaction_without_doc_lock(self):
        from types import SimpleNamespace
        from orgtree import disk, sandbox
        slug = _fresh_org('Migrate Org')
        ws = Path(_temp.name) / 'old-ws'
        ws.mkdir(exist_ok=True)
        org = store.load_org(slug)
        org.d['workspace'] = str(ws)
        org.d['dirs'] = [{'path': str(ws), 'mode': 'rw'}]
        org.d['kiosk'] = {'storage_limit_mb': 256}          # floored to 4096: the inbox notice path
        org.d['storage_frozen'] = True
        org.node('a')['frozen'] = {'storage': True, 'storage_error': 'full'}
        org.node('a').setdefault('scope', {})['add_dirs'] = [{'path': str(ws), 'mode': 'rw'}]
        store.save_org(org)
        ok = SimpleNamespace(returncode=0, stdout='MIGRATED', stderr='')
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with patch.object(disk, 'create'), patch.object(sandbox, '_docker', return_value=ok), \
                    patch.object(sandbox, 'ensure_image', return_value='img'), \
                    patch.object(disk, 'windows_sub', return_value='Z:\\\\new-ws'):
                finished, _ = _while_doc_lock_is_held(lambda: sandbox.migrate_to_disk(store.load_org(slug)))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the disk flip waited on DOC_LOCK')
        self.assertEqual(len(seen), 1)
        after = store.load_org(slug)
        self.assertEqual(after.d['disk']['size_mb'], 4096)
        self.assertEqual(after.d['workspace'], 'Z:\\\\new-ws')
        self.assertEqual(after.d['dirs'][0]['path'], 'Z:\\\\new-ws')
        self.assertNotIn('storage_frozen', after.d)
        self.assertNotIn('frozen', after.node('a'))
        self.assertEqual(after.node('a')['scope']['add_dirs'][0]['path'], 'Z:\\\\new-ws')
        mailed = list(after.d.get('user_inbox') or []) + list(after.d.get('user_mail_log') or [])
        self.assertTrue(any('256' in str(m.get('body', '')) for m in mailed),
                        'the floored-cap notice reached the operator inbox in the same commit')


class ApiResidualSites(unittest.TestCase):
    """The api.py routes no family claimed (PG-3r defaults)."""

    def test_document_dismiss_is_a_row_transaction_on_the_documents_log(self):
        from orgtree import api
        slug = _fresh_org('Docs Org')
        org = store.load_org(slug)
        org.d.setdefault('documents', []).append(
            {'id': 'd1', 'node': 'a', 'title': 'T', 'body': 'B', 'at': '2026-09-25T00:00:00Z'})
        store.save_org(org)
        with patch.object(api, 'hub_changed'):
            finished, out = _while_doc_lock_is_held(lambda: api.document_dismiss(slug, 'd1'))
        self.assertTrue(finished, 'document_dismiss waited on DOC_LOCK')
        self.assertEqual(out, {'ok': True, 'node': 'a'})
        self.assertFalse(any(d.get('id') == 'd1' for d in store.load_org(slug).d.get('documents') or []))

    def test_document_dismiss_of_an_unknown_id_is_404_and_writes_nothing(self):
        from fastapi import HTTPException
        from orgtree import api
        slug = _fresh_org('Docs 404 Org')
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with self.assertRaises(HTTPException) as cm:
                api.document_dismiss(slug, 'nope')
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(seen, [])

    def test_unstick_rows_cover_everything_unstick_writes(self):
        from orgtree import api
        slug = _fresh_org('Unstick Org', nodes=('a', 'b'))
        org = store.load_org(slug)
        org.node('a')['frozen'] = {'error': 'stuck', 'resume_texts': ['go on']}
        org.node('a')['limit_locked'] = True
        org.d['fable_lock'] = {'at': 'x'}
        store.save_org(org)
        finished, released = _while_doc_lock_is_held(lambda: orgtx.org_tx_call(
            slug, lambda tx: tx.org.unstick(USER, 'a'), **api.unstick_rows(slug, 'a')))
        self.assertTrue(finished)
        self.assertIn('frozen', released['released'])
        after = store.load_org(slug)
        self.assertNotIn('frozen', after.node('a'))
        self.assertNotIn('fable_lock', after.d, 'the last holder released the org-wide lock')
        self.assertEqual(after.node('a')['unstuck']['by'], USER)

    def test_forced_self_restart_gate_and_cost_record_are_row_transactions(self):
        from orgtree import api, supervisor
        slug = _fresh_org('Restart Org')
        body = api.AgentCall(org=slug, node='a', tool='orgtree_self_restart', args={})
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with patch.object(supervisor, 'force_quiesce_for_restart',
                              return_value={'ok': True, 'cut': ['x'], 'not_settled': []}), \
                    patch.object(supervisor, 'launch_self_restart', return_value={'ok': True}) as launch, \
                    patch.object(api, 'hub_changed'):
                finished, out = _while_doc_lock_is_held(lambda: api._forced_self_restart(
                    body, {'target': 'org', 'reason': 'deploy the fix'}))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the forced restart waited on DOC_LOCK')
        self.assertEqual(out, {'ok': True})
        launch.assert_called_once()
        self.assertEqual(len(seen), 2, 'the gate event, then the cost record')
        import json as _json
        events = _json.dumps(list(store.load_org(slug).d.get('events') or []))
        self.assertIn('"self_restart"', events)
        self.assertIn('"self_restart_forced"', events)


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

    def test_a_caller_inside_an_open_org_tx_mints_on_its_transaction(self):
        # PG-3d's quoted-reply path resolves the incarnation inside its own org_tx
        from orgtree import transcript_records
        slug = _fresh_org('Tx Incarnation Org')
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            def body():
                with orgtx.org_tx(slug, nodes=['a'], sections=['reply_incarnation']) as tx:
                    return transcript_records.incarnation(tx.org, 'a')
            finished, value = _while_doc_lock_is_held(body)
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(finished, 'the in-transaction mint waited on DOC_LOCK')
        self.assertEqual(len(seen), 1, "ONE commit: the caller's own transaction")
        after = store.load_org(slug)
        self.assertEqual(after.node('a')['transcript_incarnation'], value)
        self.assertTrue(after.d['reply_incarnation'] and after.node('a')['reply_incarnation'])

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
