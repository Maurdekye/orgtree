"""The shared read-only snapshot invalidates on every save and never serves
a stale document (perf-redesign 2026-09-12, REPORT.md #7)."""
import os
import sys
from pathlib import Path
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='v2-cached-snap-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
os.environ.pop('ORGTREE_AGENT_PARENT_DATA', None)
os.environ.pop('ORGTREE_AGENT_LEGACY_DATA', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, store   # noqa: E402


class CachedSnapshots(unittest.TestCase):
    def test_same_object_while_unchanged_fresh_after_save(self):
        org = store.create_org('Snaporg')
        org.d['slug'] = 'snaporg'
        org.hire(ledger.USER, None, 'haiku', 0, 'alpha')
        store.save_org(org)
        a = store.cached_org('snaporg')
        b = store.cached_org('snaporg')
        self.assertIs(a, b)                      # shared while unchanged
        seq0 = store.org_seq('snaporg')
        fresh = store.load_org('snaporg')
        fresh.nodes['alpha']['title'] = 'renamed'
        store.save_org(fresh)
        self.assertGreater(store.org_seq('snaporg'), seq0)
        c = store.cached_org('snaporg')
        self.assertIsNot(a, c)                   # save invalidated the share
        self.assertEqual(c.nodes['alpha']['title'], 'renamed')

    def test_cached_list_matches_list_orgs_rows(self):
        org = store.create_org('Rowsorg')
        org.d['slug'] = 'rowsorg'
        org.hire(ledger.USER, None, 'haiku', 0, 'alpha')
        store.save_org(org)
        want = {r['slug']: r for r in store.list_orgs()}
        got = {r['slug']: r for r in store.cached_list()}
        self.assertEqual(set(got), set(want))
        for slug, row in want.items():
            self.assertEqual(got[slug], row)

    def test_shared_snapshot_never_stamped_by_incarnation_mints(self):
        # perf-review round 2: the incarnation minters memoized their ids
        # onto whatever org they were handed — on the SHARED snapshot that
        # violated the read-only contract. A marked org is never stamped;
        # the mint persists through its own fresh load and the seq bump
        # delivers it to the next cached_org() instead.
        from orgtree import transcript_records
        org = store.create_org('Markorg')
        org.d['slug'] = 'markorg'
        org.hire(ledger.USER, None, 'haiku', 0, 'alpha')
        store.save_org(org)
        shared = store.cached_org('markorg')
        self.assertTrue(getattr(shared, '_shared_snapshot', False))
        value = transcript_records.incarnation(shared, 'alpha')
        self.assertTrue(value)
        self.assertNotIn('transcript_incarnation', shared.nodes['alpha'])
        self.assertNotIn('reply_incarnation', shared.nodes['alpha'])
        fresh = store.cached_org('markorg')      # the mint's save bumped seq
        self.assertIsNot(fresh, shared)
        self.assertEqual(fresh.nodes['alpha'].get('transcript_incarnation'),
                         value)

    def test_deleted_org_leaves_no_snapshot(self):
        org = store.create_org('Goneorg')
        org.d['slug'] = 'goneorg'
        store.save_org(org)
        store.cached_org('goneorg')
        store.delete_org('goneorg')
        with self.assertRaises(ledger.LedgerError):
            store.cached_org('goneorg')
        self.assertNotIn('goneorg', {r['slug'] for r in store.cached_list()})


if __name__ == '__main__':
    unittest.main()
