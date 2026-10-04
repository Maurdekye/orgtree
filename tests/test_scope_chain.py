"""Current-chain capability checks preserve configured scope and never scan S."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_old_data = os.environ.get("ORGTREE_DATA")
_data = tempfile.TemporaryDirectory(prefix="orgtree-scope-chain-")
os.environ["ORGTREE_DATA"] = _data.name

from orgtree import scope_chain as sc  # noqa: E402
from orgtree import ledger, lifecycle_tx   # noqa: E402
from orgtree.orgdb import native_move   # noqa: E402


def tearDownModule():
    _data.cleanup()
    if _old_data is None:
        os.environ.pop("ORGTREE_DATA", None)
    else:
        os.environ["ORGTREE_DATA"] = _old_data


def node(parent=None, *, dirs=(), mcp=("*",), visibility="full",
         mode="bypassPermissions", **switches):
    return {"parent": parent, "scope": {
        "add_dirs": [{"path": str(p), "mode": m} for p, m in dirs],
        "tools": {"bash": True, "web": True, "edit": True, "subagents": True,
                  "mcp": list(mcp), **switches},
        "org_visibility": visibility, "permission_mode": mode,
        "effort": "max", "model_version": "chosen", "unknown": {"keep": [1, 2]}}}


class CurrentScope(unittest.TestCase):
    def setUp(self):
        self.root = Path(_data.name)
        self.project = self.root / "project"

    def org_with_reports(self):
        org = ledger.Org.create('native-scope-controls')
        org.hire(ledger.USER, None, 'luna', 20, 'boss')
        org.hire(ledger.USER, 'boss', 'luna', 5, 'parent')
        org.hire(ledger.USER, 'parent', 'luna', 0, 'child')
        for name in ('boss', 'parent', 'child'):
            org.node(name)['scope'] = node(dirs=[(self.project, 'rw')])['scope']
        return org

    def test_native_scope_shrink_and_expansion_leave_descendant_configuration_untouched(self):
        org = self.org_with_reports()
        before = deepcopy(org.nodes)
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(ledger.Org, '_lazy_subtree_index',
                             side_effect=AssertionError('descendant sweep')):
            tools = dict(before['parent']['scope']['tools'], bash=False, mcp=['mail'])
            org.set_scope(ledger.USER, 'parent', tools=tools, permission_mode='plan')
            self.assertFalse(org.capability_scope('child')['tools']['bash'])
            self.assertEqual(org.capability_scope('child')['tools']['mcp'], ['mail'])
            self.assertEqual(org.capability_scope('child')['permission_mode'], 'plan')
            self.assertEqual(org.scope_touched, set())
            self.assertEqual(org.node('child'), before['child'])
            org.set_scope(ledger.USER, 'parent', tools=before['parent']['scope']['tools'],
                          permission_mode='bypassPermissions')
            self.assertEqual(org.capability_scope('child'), before['child']['scope'])
            self.assertEqual(org.node('child'), before['child'])

    def test_native_folder_revoke_changes_only_selected_configuration(self):
        org = self.org_with_reports()
        before = deepcopy(org.node('child'))
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(ledger.Org, 'descendants',
                             side_effect=AssertionError('descendant walk')):
            result = org.revoke_dir(ledger.USER, 'parent', str(self.project))
            self.assertEqual(result['removed_from'], ['parent'])
            self.assertEqual(org.capability_scope('child')['add_dirs'], [])
            self.assertEqual(org.node('child'), before)
            org.set_scope(ledger.USER, 'parent', add_dirs=before['scope']['add_dirs'])
            self.assertEqual(org.capability_scope('child')['add_dirs'],
                             before['scope']['add_dirs'])

    def test_native_scope_plan_names_only_selected_bubble_and_ancestors(self):
        org = self.org_with_reports()
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(lifecycle_tx, '_scope_sweep_rows',
                             side_effect=AssertionError('whole dry-run copy')):
            update, shared, *_ = lifecycle_tx._scope_plan(
                org, ledger.USER, 'parent', {'tools': {'bash': False}})
            self.assertEqual(update, {'boss', 'parent'})
            self.assertEqual(shared, set())
            update, shared, *_ = lifecycle_tx._scope_plan(
                org, 'boss', 'parent', {'tools': {'bash': False}})
            self.assertEqual(update, {'parent'})
            self.assertEqual(shared, {'boss'})

    def test_native_hire_defaults_and_explicit_ceiling_use_effective_parent(self):
        org = self.org_with_reports()
        org.node('boss')['scope']['tools']['bash'] = False
        org.node('boss')['scope']['add_dirs'][0]['mode'] = 'ro'
        with patch.object(native_move, 'enabled', return_value=True):
            result = org.hire(ledger.USER, 'parent', 'luna', 0, 'new-report')
            scope = org.node(result['node'])['scope']
            self.assertFalse(scope['tools']['bash'])
            self.assertEqual(scope['add_dirs'], [{'path': str(self.project), 'mode': 'ro'}])
            before = deepcopy(org.d)
            with self.assertRaisesRegex(ledger.LedgerError, 'bash'):
                org.hire('parent', 'parent', 'luna', 0, 'refused', add_dirs=[],
                         tools=node()['scope']['tools'], org_visibility='self', charter='role')
            self.assertEqual(org.d, before)

    def test_native_rehire_preserves_configured_grants_and_derives_current_scope(self):
        org = self.org_with_reports()
        org.retire(ledger.USER, 'child')
        configured = deepcopy(org.node('child')['scope'])
        org.node('boss')['scope']['tools']['bash'] = False
        org.node('boss')['scope']['permission_mode'] = 'plan'
        with patch.object(native_move, 'enabled', return_value=True):
            result = org.rehire(ledger.USER, 'child')
            self.assertEqual(org.node('child')['scope'], configured)
            self.assertFalse(org.capability_scope('child')['tools']['bash'])
            self.assertEqual(org.capability_scope('child')['permission_mode'], 'plan')
            self.assertTrue(any('configured grants are retained' in w for w in result['warnings']))
            org.node('boss')['scope']['tools']['bash'] = True
            org.node('boss')['scope']['permission_mode'] = 'bypassPermissions'
            self.assertEqual(org.capability_scope('child'), configured)

    def test_ledger_actor_parent_and_scope_request_checks_use_effective_grants(self):
        org = ledger.Org.__new__(ledger.Org)
        org.d = {'nodes': {'top': node(dirs=[(self.root, 'ro')], bash=False,
                                     visibility='self', mode='plan'),
                          'child': node('top', dirs=[(self.project, 'rw')])}}
        configured = deepcopy(org.node('child')['scope'])
        with patch.object(native_move, 'enabled', return_value=True):
            dirs, tools, vis, mode = org._actor_cap('child')
            self.assertEqual(dirs, {str(self.project): 'ro'})
            self.assertFalse(tools['bash'])
            self.assertEqual((vis, mode), ('self', 'plan'))
            self.assertEqual(org._clamp_vis('full', 'child', False), ('self', True))
            self.assertEqual(org._clamp_pm('bypassPermissions', 'child', False), ('plan', True))
            self.assertFalse(org._holds_scope_item('child', {'kind': 'tool', 'tool': 'bash'}))
            self.assertEqual(org._scope_item_state('child', {'kind': 'permission_mode'}),
                             'permission mode plan')
            view = org.effective_agent('child')
            self.assertFalse(view['scope']['tools']['bash'])
            with self.assertRaises(TypeError):
                view['scope']['tools']['bash'] = True
        self.assertEqual(org.node('child')['scope'], configured)

    def test_ledger_scope_always_checks_the_actual_transaction_path_before_read(self):
        org = ledger.Org.__new__(ledger.Org)
        org.d = {'nodes': {'child': node()}}
        raw = object()
        with patch.object(native_move, 'enabled', return_value=True), \
                patch.object(native_move, 'connection', return_value=raw), \
                patch.object(native_move.graph, 'check_scope_paths',
                             side_effect=sc.ScopeError('unheld current path')) as guard:
            with self.assertRaisesRegex(sc.ScopeError, 'unheld'):
                org.capability_scope('child')
        guard.assert_called_once_with(raw, {'child'})

    def test_legacy_capability_checks_keep_existing_configured_mode(self):
        org = ledger.Org.__new__(ledger.Org)
        org.d = {'nodes': {'top': node(bash=False), 'child': node('top')}}
        with patch.object(native_move, 'enabled', return_value=False):
            self.assertTrue(org._actor_cap('child')[1]['bash'])
            self.assertIs(org.effective_agent('child'), org.node('child'))

    def test_all_ancestors_intersect_each_capability_without_changing_preferences(self):
        nodes = {
            "top": node(dirs=[(self.root, "ro")], mcp=["git", "mail"],
                        visibility="team", mode="plan", bash=False),
            "middle": node("top", dirs=[(self.project, "rw")], mcp=["mail", "web"],
                           visibility="subtree", mode="acceptEdits", web=False),
            "child": node("middle", dirs=[(self.project / "src", "rw")])}
        before = deepcopy(nodes)
        got = sc.effective_scope(nodes.__getitem__, "child")
        self.assertEqual(got["add_dirs"], [{"path": str(self.project / "src"), "mode": "ro"}])
        self.assertEqual(got["tools"], {"bash": False, "web": False, "edit": True,
                                        "subagents": True, "mcp": ["mail"]})
        self.assertEqual((got["org_visibility"], got["permission_mode"]), ("team", "plan"))
        self.assertEqual((got["effort"], got["model_version"], got["unknown"]),
                         ("max", "chosen", {"keep": [1, 2]}))
        self.assertEqual(nodes, before)

    def test_move_back_restores_configured_folders_wildcards_and_modes(self):
        nodes = {"wide": node(dirs=[(self.root, "rw")]),
                 "narrow": node(dirs=[(self.root, "ro")], mcp=["git"],
                                mode="default", visibility="self", edit=False),
                 "child": node("wide", dirs=[(self.project, "rw")])}
        configured = deepcopy(nodes["child"]["scope"])
        original = sc.effective_scope(nodes.__getitem__, "child")
        nodes["child"]["parent"] = "narrow"
        narrowed = sc.effective_scope(nodes.__getitem__, "child")
        self.assertFalse(narrowed["tools"]["edit"])
        self.assertEqual(narrowed["tools"]["mcp"], ["git"])
        self.assertEqual(narrowed["add_dirs"][0]["mode"], "ro")
        self.assertEqual((narrowed["org_visibility"], narrowed["permission_mode"]),
                         ("self", "default"))
        nodes["child"]["parent"] = "wide"
        self.assertEqual(sc.effective_scope(nodes.__getitem__, "child"), original)
        self.assertEqual(nodes["child"]["scope"], configured)

    def test_folder_coverage_preserves_existing_drop_and_rw_wins_rules(self):
        nodes = {"top": node(dirs=[(self.root, "ro"), (self.project, "rw")]),
                 "child": node("top", dirs=[(self.project / "src", "rw"),
                                            (self.root.parent, "rw"),
                                            (Path(str(self.root) + "-other"), "rw")])}
        self.assertEqual(sc.effective_scope(nodes.__getitem__, "child")["add_dirs"],
                         [{"path": str(self.project / "src"), "mode": "rw"}])

    def test_missing_and_cyclic_ancestors_never_confer_scope(self):
        for nodes in ({"child": node("gone")},
                      {"child": node("parent"), "parent": node("child")},
                      {"child": node("child")}):
            with self.assertRaises(sc.ScopeError):
                sc.effective_scope(nodes.__getitem__, "child")

    def test_invalid_ancestor_capabilities_are_refused_without_mutating_misfits(self):
        for key, value in (("permission_mode", "unknown"), ("org_visibility", None),
                           ("tools", []), ("add_dirs", [{"path": "x", "mode": "unknown"}])):
            nodes = {"top": node(), "child": node("top")}
            nodes["top"]["scope"][key] = value
            before = deepcopy(nodes)
            with self.assertRaises(sc.ScopeError):
                sc.effective_scope(nodes.__getitem__, "child")
            self.assertEqual(nodes, before)

    def test_reads_only_the_selected_parent_chain_independent_of_descendants(self):
        nodes = {"top": node(), "parent": node("top"), "child": node("parent")}
        nodes.update({f"descendant{i}": node("child") for i in range(1000)})
        reads = []
        def reader(name):
            reads.append(name)
            return nodes[name]
        sc.effective_scope(reader, "child")
        self.assertEqual(reads, ["child", "parent", "top"])

    def test_snapshot_memo_is_read_only_and_fresh_authority_does_not_reuse_it(self):
        nodes = {"top": node(), "child": node("top"), "sibling": node("top")}
        reads = []
        def reader(name):
            reads.append(name)
            return nodes[name]
        with sc.ScopeSnapshot(reader, sc.ScopeStamp("uuid", "incarnation", 4)) as snapshot:
            first = snapshot.scope("child")
            snapshot.scope("sibling")
            self.assertEqual(reads, ["child", "top", "sibling"])
            first["tools"]["bash"] = False
            self.assertTrue(snapshot.scope("child")["tools"]["bash"])
            # The display snapshot is retained; a write must use a fresh reader.
            changed = deepcopy(nodes)
            changed["top"]["scope"]["tools"]["bash"] = False
            self.assertFalse(sc.effective_scope(changed.__getitem__, "child")["tools"]["bash"])
            self.assertTrue(snapshot.scope("child")["tools"]["bash"])
        with self.assertRaises(sc.ScopeError):
            snapshot.scope("child")

    def test_effective_view_and_detached_transport_cannot_overwrite_configured_values(self):
        nodes = {"top": node(edit=False), "child": node("top")}
        before = deepcopy(nodes)
        with sc.ScopeSnapshot(nodes.__getitem__, sc.ScopeStamp("uuid", "incarnation", 1)) as snapshot:
            view = snapshot.agent("child")
            self.assertNotIsInstance(view, dict)
            with self.assertRaises(TypeError):
                view["parent"] = "elsewhere"
            with self.assertRaises(TypeError):
                view["scope"]["tools"]["edit"] = True
            transport = view.transport()
            self.assertFalse(transport["scope"]["tools"]["edit"])
            transport["scope"]["tools"]["edit"] = True
            transport["scope"]["unknown"]["keep"].append(3)
            self.assertFalse(view["scope"]["tools"]["edit"])
            self.assertEqual(nodes, before)


if __name__ == "__main__":
    unittest.main()
