"""PG-0b (plan decision 39): org_tx, org_tx_call and org_read on ORGTREE_STORE=json.

Before this, a converted route answered 500 on the JSON store ("org_tx needs
sqlite or postgres"). The fallback is the legacy cycle behind the org_tx
interface: DOC_LOCK plus a whole-document load and save, row declarations
ignored, receipts best-effort (in memory).

What these prove, over a throwaway JSON data root:
  * a converted route (api.document_dismiss, PG-3r) works end to end;
  * a write to a row the transaction did not declare commits (declarations
    are ignored) and the published Committed says its changes are unknown;
  * the body runs holding DOC_LOCK even with the transition fence off;
  * an exception in the body writes nothing;
  * an op_key replays within the process (body discarded) and a different
    fingerprint is refused; org_tx_call returns the stored result;
  * org_read hands back a private copy: writing to it saves nothing.

Run:  python tools/run-python-verification.py tests/test_orgtx_json.py
"""

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='v3-orgtx-json-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='json')
os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import orgtx, store  # noqa: E402

# the fallback must hold DOC_LOCK on its own, not because the fence does
orgtx.TRANSITION_FENCE = False


def tearDownModule() -> None:
    _temp.cleanup()


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['a'] = {'id': 'a', 'name': 'a', 'parent': None, 'children': []}
    org.d['settings_x'] = {'v': 0}
    store.save_org(org)
    return slug


class OrgTxOnJson(unittest.TestCase):
    def setUp(self) -> None:
        self.assertEqual(store.STORE_BACKEND, 'json')
        orgtx.use_backend(None)                  # the default choice, as in production
        self.slug = _fresh_org(f'json-{self._testMethodName}'[:60])
        self.assertTrue(os.path.exists(store.org_path(self.slug)))

    def test_a_converted_route_works(self) -> None:
        from orgtree import api
        org = store.load_org(self.slug)
        org.d.setdefault('documents', []).append(
            {'id': 'd1', 'node': 'a', 'title': 'T', 'body': 'B', 'at': '2026-09-25T00:00:00Z'})
        store.save_org(org)
        seen: list[orgtx.Committed] = []
        orgtx.commit_listeners.append(seen.append)
        try:
            with patch.object(api, 'hub_changed'):
                out = api.document_dismiss(self.slug, 'd1')
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertEqual(out, {'ok': True, 'node': 'a'})
        d = store.load_org(self.slug).d
        self.assertFalse(any(x.get('id') == 'd1' for x in d.get('documents') or []))
        self.assertIn('present_dismissed', [e.get('op') for e in d.get('events') or []])
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0].changes_known)

    def test_undeclared_write_commits_and_revision_bumps(self) -> None:
        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            tx.d['settings_x']['v'] = 7                   # not declared: ignored on json
            tx.d['nodes']['a']['name'] = 'A'
        r1 = tx.revision
        self.assertIsNotNone(tx.committed)
        with orgtx.org_tx(self.slug) as tx2:
            tx2.append('events', {'kind': 'json-append'})
        d = store.load_org(self.slug).d
        self.assertEqual(d['settings_x']['v'], 7)
        self.assertEqual(d['nodes']['a']['name'], 'A')
        self.assertIn('json-append', [e.get('kind') for e in d['events']])
        self.assertEqual(tx2.revision, r1 + 1)

    def test_body_holds_doc_lock_with_the_fence_off(self) -> None:
        self.assertFalse(orgtx.TRANSITION_FENCE)
        got: list[bool] = []

        def other() -> None:
            got.append(store.DOC_LOCK.acquire(timeout=0.2))
            if got[-1]:
                store.DOC_LOCK.release()

        with orgtx.org_tx(self.slug, nodes=['a']) as tx:
            t = threading.Thread(target=other)
            t.start()
            t.join(5)
            tx.d['nodes']['a']['name'] = 'held'
        self.assertEqual(got, [False], 'another thread took DOC_LOCK inside the body')

    def test_body_exception_writes_nothing(self) -> None:
        with self.assertRaises(KeyError):
            with orgtx.org_tx(self.slug, nodes=['a']) as tx:
                tx.d['nodes']['a']['name'] = 'lost'
                raise KeyError('boom')
        self.assertEqual(store.load_org(self.slug).d['nodes']['a']['name'], 'a')

    def test_receipts_replay_in_process(self) -> None:
        calls: list[int] = []

        def body(tx: orgtx.OrgTx) -> dict:
            calls.append(1)
            tx.d['settings_x']['v'] += 1
            return {'v': tx.d['settings_x']['v']}

        first = orgtx.org_tx_call(self.slug, body, sections=['settings_x'],
                                  op_key='k1', fingerprint='f')
        again = orgtx.org_tx_call(self.slug, body, sections=['settings_x'],
                                  op_key='k1', fingerprint='f')
        self.assertEqual(first, {'v': 1})
        self.assertEqual(again, {'v': 1})
        self.assertEqual(len(calls), 1)
        self.assertEqual(store.load_org(self.slug).d['settings_x']['v'], 1)
        with orgtx.org_tx(self.slug, op_key='k1', fingerprint='f') as tx:
            self.assertTrue(tx.replayed)
            tx.d['settings_x']['v'] = 99                  # discarded
        self.assertEqual(store.load_org(self.slug).d['settings_x']['v'], 1)
        with self.assertRaises(orgtx.ReceiptConflict):
            with orgtx.org_tx(self.slug, op_key='k1', fingerprint='other'):
                pass

    def test_org_read_is_a_private_copy(self) -> None:
        view = orgtx.org_read(self.slug, sections=['events'])
        view.d['nodes']['a']['name'] = 'scribbled'
        self.assertEqual(store.load_org(self.slug).d['nodes']['a']['name'], 'a')


if __name__ == '__main__':
    unittest.main()
