"""staffdoor — the ROW AUDIT for hire's lock declaration.

A row store writes back only the rows a transaction holds FOR UPDATE, so a
hire that changes a row its declaration does not name would silently lose
that write (or race it). These tests run REAL hires (`Org.hire`,
`_chain_acquire`, `insert_parent`, exactly as `api._hire_seat` calls them) on
a real org in a throwaway data root, diff the document before and after, and
fail if any changed or created node row is outside `hire_rows(...).nodes`, or
any changed section is outside the declared sections and logs.
"""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='staffdoor-rows-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402
from unittest.mock import patch  # noqa: E402
from orgtree import api, ledger, pgdoor, staffdoor, store  # noqa: E402

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
_N = [0]


def _hire(org, actor, dest, name, grant=0, **kw):
    return org.hire(actor, dest, 'luna', grant, name, add_dirs=[], tools=T,
                    org_visibility='full', charter='c', **kw)


class RowAudit(unittest.TestCase):
    def setUp(self):
        _N[0] += 1
        self.slug = f'rows{_N[0]}'
        org = store.create_org(self.slug)
        org.hire(U, None, 'luna', 20, 'root')
        _hire(org, 'root', 'root', 'mid', 5)
        _hire(org, 'mid', 'mid', 'peer', 0)
        _hire(org, 'root', 'root', 'aside', 0)
        store.save_org(org)
        self.org = store.load_org(self.slug)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def audit(self, actor, a, run):
        """Declare from the document as it stands, run the hire, and check
        every changed row against the declaration. Returns the diff so a test
        can also prove the case exercised what it claims to."""
        org = self.org
        spec = staffdoor.hire_rows(org, actor, a)
        before = copy.deepcopy(dict(org.d))
        run(org)
        after = dict(org.d)
        bn, an = before['nodes'], after['nodes']
        changed = sorted(k for k in an if k not in bn or an[k] != bn[k])
        gone = sorted(k for k in bn if k not in an)
        sections = sorted(k for k in set(before) | set(after)
                          if k != 'nodes' and before.get(k) != after.get(k))
        undeclared_nodes = [k for k in changed + gone if k not in spec.nodes]
        undeclared_secs = [s for s in sections
                           if s not in spec.sections + spec.logs]
        self.assertEqual(undeclared_nodes, [], f'spec={spec} changed={changed}')
        self.assertEqual(undeclared_secs, [], f'spec={spec} sections={sections}')
        return {'changed': changed, 'sections': sections, 'spec': spec,
                'before': before}

    def test_self_hire_within_free(self):
        a = {'name': 'newbie', 'grant': 1}
        d = self.audit('mid', a, lambda o: _hire(o, 'mid', 'mid', 'newbie', 1))
        self.assertEqual(d['changed'], ['newbie'])

    def test_chain_inflation_writes_grants_up_the_path(self):
        # mid has 5 granted, peer costs a seat; 8 more under peer must bubble
        # from mid up to root, inflating grants on peer and mid
        a = {'target': 'peer', 'name': 'deep', 'grant': 8}
        d = self.audit('root', a, lambda o: _hire(o, 'root', 'peer', 'deep', 8))
        self.assertIn('mid', d['changed'])          # the case really inflated
        self.assertIn('peer', d['changed'])
        self.assertEqual(d['spec'].nodes[:3], ('peer', 'mid', 'root'))

    def test_user_hire_deep_inflates_to_the_top(self):
        a = {'target': 'peer', 'name': 'big', 'grant': 40}
        d = self.audit(U, a, lambda o: _hire(o, U, 'peer', 'big', 40))
        self.assertIn('root', d['changed'])
        self.assertNotIn('aside', d['spec'].nodes)   # off the path: not held

    def test_name_collision_declares_the_suffixed_row(self):
        a = {'name': 'peer'}
        d = self.audit('mid', a, lambda o: _hire(o, 'mid', 'mid', 'peer', 0))
        self.assertEqual(d['changed'], ['peer-2'])

    def test_superior_insertion(self):
        a = {'target': 'peer', 'hire_type': 'superior', 'name': 'lead'}

        def run(o):
            r = _hire(o, 'root', 'peer', 'lead', 0)
            o.insert_parent('root', r['node'], 'peer')

        d = self.audit('root', a, run)
        self.assertIn('peer', d['changed'])          # re-parented
        self.assertIn('lead', d['changed'])

    def test_top_level_user_hire(self):
        a = {'target': U, 'name': 'solo', 'grant': 3}
        d = self.audit(U, a, lambda o: o.hire(U, None, 'luna', 3, 'solo'))
        self.assertEqual(d['changed'], ['solo'])

    # ------------------------------------- the FULL agent hire (the door's)
    def seat(self, actor, a):
        """api._hire_seat exactly as agent_call runs it: the hire, the scope
        fields, the audiences and the kickoff (`drive` is consumed after the
        commit, so it is not a row). The provider gate is a machine read that
        runs before the transaction, so it is stubbed here."""
        drive = []

        def run(o):
            with patch.object(api, 'provider_hire_gate', lambda *x, **k: None):
                self.res = api._hire_seat(o, self.slug, actor, a, drive, None)

        d = self.audit(actor, a, run)
        self.assertEqual(drive, [self.res['node']])
        return d

    FULL = {'tools': T, 'add_dirs': [], 'org_visibility': 'full',
            'charter': 'c', 'tier': 'luna', 'kickoff': 'go',
            'permission_mode': 'plan', 'effort': 'high'}

    def test_full_hire_with_kickoff_and_scope(self):
        d = self.seat('mid', dict(self.FULL, name='kid', grant=1))
        self.assertEqual(d['changed'], ['kid'])
        self.assertIn('mail', d['sections'])            # the kickoff

    def test_full_hire_into_the_chain(self):
        d = self.seat('root', dict(self.FULL, name='kid', grant=6,
                                   target='peer'))
        self.assertIn('mid', d['changed'])

    def test_full_superior_insertion(self):
        d = self.seat('root', {'name': 'boss2', 'tier': 'luna',
                               'target': 'peer', 'hire_type': 'superior',
                               'charter': 'c', 'kickoff': 'go'})
        self.assertIn('peer', d['changed'])
        self.assertEqual(self.org.node('peer')['parent'], 'boss2')

    # -------------------------------------------------- body-side helpers
    def test_require_rows_widens_when_the_name_was_taken_meanwhile(self):
        held = staffdoor.hire_rows(self.org, 'mid', {'name': 'x'})
        _hire(self.org, 'mid', 'mid', 'x', 0)       # a racing hire took it
        with self.assertRaises(pgdoor.Widen) as cm:
            staffdoor.require_rows(held, self.org, 'mid', {'name': 'x'})
        self.assertEqual(cm.exception.spec.nodes, ('x-2',))
        staffdoor.require_rows(held.widened(cm.exception), self.org, 'mid',
                               {'name': 'x'})       # now satisfied


if __name__ == '__main__':
    unittest.main()
