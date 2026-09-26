"""S6: a Fable content-filter hit is recorded on a row transaction.

`_run_one_turn_recorded` used to take `store.DOC_LOCK` and save the whole
document to record `Org.fable_filter_hit`. `supervisor._fable_filter_commit`
now runs the halt and opus policies on ONE org_tx over the rows
`_fable_filter_spec` plans (the agent, the parent's — and for opus each
peer's — notices row, `user_inbox`, the events/notice_log logs). Each case
counts the org_tx commits (`orgtx.commit_listeners`): the whole-document
save under DOC_LOCK is not one, so a policy that still took it fails.

  * halt: one org_tx commit, the parent and the user are told;
  * opus: the agent's model is converted in that same commit, and every peer
    is told;
  * a plan made on a stale snapshot (the parent moved) widens and still
    commits, telling the NEW parent;
  * auto-autopsy keeps the whole-document path (its named fence-off blocker).
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='s6-filter-site-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['ORGTREE_STORE'] = 'sqlite'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from orgtree import ledger, orgtx, store, supervisor  # noqa: E402

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


class FilterSite(unittest.TestCase):

    def setUp(self):
        _N[0] += 1
        self.slug = f's6fs{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 30, 'boss')
        org.hire(U, None, 'luna', 30, 'other')
        org.hire('boss', 'boss', 'luna', 0, 'flagged', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.hire('boss', 'boss', 'luna', 0, 'peer', add_dirs=[], tools=T,
                 org_visibility='full', charter='c')
        org.node('flagged')['model'] = 'fable'
        store.save_org(org)
        self.commits: list[orgtx.Committed] = []
        orgtx.commit_listeners.append(self.commits.append)

    def tearDown(self):
        orgtx.commit_listeners.remove(self.commits.append)
        store._POOL.close_all(self.slug)

    def policy(self, p):
        org = store.load_org(self.slug)
        org.d['fable_filter_policy'] = p
        store.save_org(org)

    def notices(self, nid):
        """The filter-hit notices `nid` holds (not the fixture's hire/move
        notices)."""
        box = (store.load_org(self.slug).d.get('notices') or {}).get(nid) or []
        return [x for x in box
                if (x.get('ev') or {}).get('variant') == 'policy.fable_flagged']

    def commit(self):
        return supervisor._fable_filter_commit(self.slug, 'flagged',
                                               'content filter flagged')

    def mine(self):
        return [c for c in self.commits if c.slug == self.slug]

    def test_halt_commits_on_one_row_transaction(self):
        self.policy('halt')
        self.commits.clear()
        self.assertEqual(self.commit(), ('halt', 'opus'))
        self.assertEqual(len(self.mine()), 1)
        self.assertTrue(self.notices('boss'))
        self.assertFalse(self.notices('peer'))
        self.assertTrue(store.load_org(self.slug).d.get('user_inbox'))
        self.assertEqual(store.load_org(self.slug).node('flagged')['model'],
                         'fable')

    def test_opus_converts_and_tells_every_peer_in_the_same_commit(self):
        self.policy('opus')
        self.commits.clear()
        self.assertEqual(self.commit()[0], 'opus')
        self.assertEqual(len(self.mine()), 1)
        self.assertEqual(store.load_org(self.slug).node('flagged')['model'],
                         'opus')
        self.assertTrue(self.notices('boss'))
        self.assertTrue(self.notices('peer'))

    def test_a_stale_plan_widens_and_tells_the_new_parent(self):
        self.policy('halt')
        stale = store.load_org(self.slug)          # parent = boss
        org = store.load_org(self.slug)
        org.move(U, 'flagged', 'other')
        store.save_org(org)
        spec = supervisor._fable_filter_spec
        planned = []

        def on_stale(slug, nid):
            with patch.object(store, 'cached_org', lambda _s: stale):
                s = spec(slug, nid)
            planned.append(s)
            return s
        with patch.object(supervisor, '_fable_filter_spec', on_stale):
            self.assertEqual(self.commit()[0], 'halt')
        self.assertIn(('notices', 'boss'), planned[0].sections)
        self.assertTrue(self.notices('other'), 'the new parent was not told')
        self.assertFalse(self.notices('boss'))

    def test_auto_autopsy_keeps_the_whole_document_path(self):
        self.policy('auto-autopsy')
        self.assertIsNone(supervisor._fable_filter_spec(self.slug, 'flagged'))
        with patch.object(supervisor, '_fable_filter_spec', lambda *a: None), \
                patch.object(store, 'save_org', wraps=store.save_org) as sv:
            supervisor._fable_filter_commit(self.slug, 'flagged', 'x')
        self.assertEqual(self.mine(), [])
        self.assertEqual(sv.call_count, 1)


if __name__ == '__main__':
    unittest.main()
