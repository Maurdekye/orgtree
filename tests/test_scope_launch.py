"""Real launch builders consume current scope without rewriting configured rows."""
import import_provenance  # noqa: F401 asserts imports resolve inside this checkout

from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_data = tempfile.TemporaryDirectory(prefix='orgtree-scope-launch-')
_prior_data = os.environ.get('ORGTREE_DATA')
os.environ['ORGTREE_DATA'] = _data.name

from orgtree import antigravity_session, codexrun, ledger, providers, supervisor as sup, warmpool  # noqa: E402
from orgtree.orgdb import native_move  # noqa: E402


def tearDownModule():
    _data.cleanup()
    if _prior_data is None:
        os.environ.pop('ORGTREE_DATA', None)
    else:
        os.environ['ORGTREE_DATA'] = _prior_data


class ScopeLaunch(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(tempfile.TemporaryDirectory(dir=_data.name))
        self.root = Path(self.folder)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.cwd = self.root / 'scratch' / 'leaf'
        self.cwd.mkdir(parents=True)
        self.org = ledger.Org.create('scope-launch')
        self.org.hire(ledger.USER, None, 'haiku', 20, 'boss')
        self.org.hire(ledger.USER, 'boss', 'haiku', 5, 'parent')
        self.org.hire(ledger.USER, 'parent', 'haiku', 0, 'leaf')
        for name in ('boss', 'parent', 'leaf'):
            self.org.node(name)['scope'] = {
                'add_dirs': [{'path': str(self.project), 'mode': 'rw'}],
                'tools': {'bash': True, 'edit': True, 'web': True, 'subagents': True, 'mcp': ['*']},
                'permission_mode': 'bypassPermissions', 'org_visibility': 'full'}
        self.configured = deepcopy(self.org.node('leaf'))
        self.enterContext(patch.object(native_move, 'enabled', return_value=True))
        self.enterContext(patch.object(sup, 'scratch_dir', return_value=str(self.cwd)))
        self.enterContext(patch.object(sup, 'identity_prompt', return_value='issued identity'))
        self.enterContext(patch.object(sup, 'registered_mcp_servers', return_value={
            'alpha': {'command': 'fixture-alpha'}, 'beta': {'command': 'fixture-beta'}}))
        self.enterContext(patch.object(sup, '_claude_argv', return_value=['fixture-claude']))
        self.enterContext(patch.object(sup, 'claude_model_for', return_value='fixture-model'))
        self.enterContext(patch.object(sup, 'cli_capable', return_value=False))
        self.enterContext(patch.object(sup, 'GLOBAL_SKILLS', str(self.root / 'missing-skills')))
        self.enterContext(patch.dict(os.environ, {'ORGTREE_STEER_HOOK': '0',
            'HOME': str(self.root / 'home'), 'USERPROFILE': str(self.root / 'home'),
            'ProgramFiles': str(self.root / 'programs')}))

    def narrow(self):
        scope = self.org.node('boss')['scope']
        scope['tools'] = dict(scope['tools'], bash=False, edit=False, web=False,
                              subagents=False, mcp=['alpha'])
        scope['add_dirs'][0]['mode'] = 'ro'
        scope['permission_mode'] = 'plan'

    def command(self):
        return sup._build_cmd(self.org, 'leaf', write_ident=False, session_probe=False)

    def test_mcp_selection_intersects_all_ancestors_and_restores_wildcard(self):
        self.assertEqual(set(sup.granted_mcp_servers(self.org, 'leaf')), {'alpha', 'beta'})
        self.narrow()
        self.assertEqual(set(sup.granted_mcp_servers(self.org, 'leaf')), {'alpha'})
        self.org.node('boss')['scope']['tools']['mcp'] = ['*']
        self.assertEqual(set(sup.granted_mcp_servers(self.org, 'leaf')), {'alpha', 'beta'})
        self.assertEqual(self.org.node('leaf'), self.configured)

    def test_claude_command_uses_effective_mode_tools_mcp_and_readonly_folder(self):
        issued = self.command()
        self.narrow()
        current = self.command()
        self.assertEqual(current[current.index('--permission-mode') + 1], 'plan')
        denied = current[current.index('--disallowed-tools') + 1].split(',')
        self.assertTrue({'Bash', 'PowerShell', 'Edit', 'Write', 'WebSearch', 'Task'} <= set(denied))
        chosen = json.loads(current[current.index('--mcp-config') + 1])['mcpServers']
        self.assertEqual(set(chosen), {'alpha', 'orgtree'})
        rules = json.loads(current[current.index('--settings') + 1])['permissions']['deny']
        self.assertTrue(any(str(self.project).replace('\\', '/') in rule for rule in rules), rules)
        self.assertEqual(issued[issued.index('--permission-mode') + 1], 'bypassPermissions')
        self.assertEqual(self.org.node('leaf'), self.configured)

    def test_granted_folder_prompt_and_digest_drop_an_ineffective_folder(self):
        note = self.project / 'CLAUDE.md'
        note.write_text('granted instruction', encoding='utf-8')
        self.assertIn('granted instruction', sup._claudemd_block(self.org, 'leaf'))
        before = warmpool.native_startup_context_digest(self.org, 'leaf')
        self.org.node('boss')['scope']['add_dirs'] = []
        self.assertNotIn('granted instruction', sup._claudemd_block(self.org, 'leaf'))
        after = warmpool.native_startup_context_digest(self.org, 'leaf')
        self.assertNotEqual(before, after)
        note.write_text('changed denied instruction', encoding='utf-8')
        self.assertEqual(warmpool.native_startup_context_digest(self.org, 'leaf'), after)
        self.assertEqual(self.org.node('leaf'), self.configured)

    def codex_spec(self):
        self.org.node('leaf')['model'] = 'luna'
        with patch.object(providers, 'codex_status', return_value={
                'installed': True, 'connected': True, 'path': 'fixture-codex'}), \
                patch.object(providers, 'codex_argv', return_value=['fixture-codex']), \
                patch.object(sup, 'codex_bound_home', return_value=('', '')), \
                patch.object(sup.agentauth, 'node_env', return_value={}):
            return sup._codex_process_spec(self.org, 'leaf', write_ident=False)

    def test_codex_launch_overrides_and_git_trust_use_effective_scope(self):
        self.narrow()
        spec = self.codex_spec()
        self.assertEqual(spec['config_overrides'],
            codexrun.mcp_config_overrides(sup.codex_mcp_grant(self.org, 'leaf')[0])
            + sup._codex_tool_config(self.org.capability_scope('leaf')))
        self.assertEqual({key: value for key, value in spec['env_extra'].items()
                          if key.startswith('GIT_CONFIG_')},
                         sup._codex_git_trust_env(self.org.capability_scope('leaf')))
        self.assertEqual(self.org.node('leaf')['scope'], self.configured['scope'])

    def test_codex_manifest_freezes_issued_scope_and_new_manifest_uses_current_chain(self):
        spec = self.codex_spec()
        with patch.object(warmpool, 'codex_startup_context_digest', return_value='fixture-files'):
            issued = sup._codex_startup_manifest(self.org, 'leaf', provider_spec=spec,
                                                  account_override='same', lane_override='same')
            original = deepcopy(issued)
            self.narrow()
            current = sup._codex_startup_manifest(self.org, 'leaf', provider_spec=self.codex_spec(),
                                                   account_override='same', lane_override='same')
        self.assertEqual(issued, original)
        self.assertTrue(issued['cache_tools']['grant']['bash'])
        self.assertFalse(current['cache_tools']['grant']['bash'])
        self.assertEqual((current['account'], current['lane']), ('same', 'same'))
        self.assertNotEqual(issued['cache_argv'], current['cache_argv'])

    def test_antigravity_new_rights_use_effective_scope_with_session_lineage_retained(self):
        self.org.node('leaf').update(model='flash', antigravity_conversation=self.configured['session_id'])
        with patch.object(antigravity_session, 'selected_account', return_value=None), \
                patch.object(antigravity_session, 'environment', return_value={'ORGTREE_PORT': '7360'}), \
                patch.object(providers, 'antigravity_status', return_value={
                    'installed': True, 'connected': True, 'path': 'fixture-agy'}), \
                patch.object(sup.agentauth, 'child_env', return_value={}):
            issued = antigravity_session.specification(self.org, 'leaf')
            self.narrow()
            current = antigravity_session.specification(self.org, 'leaf')
        self.assertEqual(current['rights'], dict(bash=False, edit=False, web=False, subagents=False))
        self.assertTrue(issued['rights']['bash'])
        self.assertEqual(current['conversation_id'], issued['conversation_id'])
        self.assertEqual(current['generation'], issued['generation'])
        self.assertEqual(self.org.node('leaf')['scope'], self.configured['scope'])

    def test_claude_cache_surface_changes_when_ancestor_tools_change(self):
        with patch.object(sup, 'cli_version', return_value='fixture'):
            before = sup._cache_semantic_inputs(self.org, 'leaf', 'claude')
            self.narrow()
            after = sup._cache_semantic_inputs(self.org, 'leaf', 'claude')
        self.assertNotEqual(before[0], after[0])
        self.assertNotEqual(before[1], after[1])

    def test_result_boundary_rejects_old_scope_identity_without_relabeling_process(self):
        with patch.object(sup, 'codex_harness_turn', return_value=False):
            issued_hash, issued_parts = warmpool.identity_snapshot(self.org, 'leaf', env={}, overrides={})
            process = SimpleNamespace(hash=issued_hash, ident_components=deepcopy(issued_parts))
            self.narrow()
            with patch.object(warmpool, 'warm_decision', return_value=(True, True)), \
                    patch.object(warmpool, 'node_excluded', return_value=False), \
                    patch.object(warmpool, 'eligible', return_value=(True, '')), \
                    patch('orgtree.identity_context.load', return_value=self.org), \
                    patch.object(sup, 'spawn_env', return_value={}), \
                    patch.object(sup, 'env_overrides', return_value={}), \
                    patch.object(warmpool, '_record_identity_change') as changed, \
                    patch.object(warmpool, '_set_proc_lifecycle') as lifecycle:
                permitted, _, reason = warmpool.boundary_check(
                    self.org.d['slug'], 'leaf', issued_hash, process)
        self.assertFalse(permitted)
        self.assertEqual(reason, 'identity-changed')
        changed.assert_called_once()
        self.assertTrue(lifecycle.call_args.kwargs['relaunch'])
        self.assertEqual(process.hash, issued_hash)
        self.assertEqual(process.ident_components, issued_parts)


if __name__ == '__main__':
    unittest.main()
