"""PG-3r: the residual DOC_LOCK sites no family owns, converted to org_tx / org_read.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * bridge credential rotation commits through ONE org_tx that names only the
    two credential sections, never waits on DOC_LOCK, bumps the org revision
    by one, and still verifies that the previous credential is refused;
  * gitworkspace.org_facts and history_page read without DOC_LOCK (a reader
    completes while another thread holds DOC_LOCK).

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


if __name__ == '__main__':
    unittest.main()
