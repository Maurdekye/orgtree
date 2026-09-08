"""Real child imports and provider environment construction; no provider launch."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DevGuardTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='v2-devguard-')).resolve()
        self.live = self.root / 'live'
        self.home = self.root / 'home'
        self.legacy = self.home / 'orgtree'
        self.env = dict(os.environ)
        for key in ('ORGTREE_AGENT_PARENT_DATA', 'ORGTREE_AGENT_LEGACY_DATA'):
            self.env.pop(key, None)
        self.env.update(ORGTREE_DATA=str(self.live), HOME=str(self.home),
                        USERPROFILE=str(self.home), ORGTREE_DESKTOP_MANAGED='1',
                        ORGTREE_STORE='sqlite', PYTHONPATH=str(ROOT/'engine'/'backend'))

    def run_code(self, code, env=None):
        return subprocess.run([sys.executable, '-c', code], env=env or self.env,
                              cwd=self.root, capture_output=True, text=True, timeout=25)

    def child(self, provider):
        if provider == 'claude':
            code = 'from orgtree import supervisor; print(json.dumps(supervisor.clean_env()))'
        elif provider == 'antigravity':
            code = '''
from unittest.mock import patch
from orgtree import antigravityrun
captured = {}
def capture(*args, **kw):
    captured.update(kw['env'])
    raise RuntimeError('captured before provider')
turn = antigravityrun.AntigravityTurn(['forbidden-provider'], cwd='.', model='model', effort=None)
with patch.object(antigravityrun.subprocess, 'Popen', capture):
    try: turn.start('no provider')
    except RuntimeError as e: assert str(e) == 'captured before provider'
print(json.dumps(captured))
'''
        else:
            code = '''
from unittest.mock import patch
from orgtree import codexrun
def capture(*args, **kw):
    print(json.dumps(kw['env']))
    raise RuntimeError('captured before provider')
with patch.object(codexrun.subprocess, 'Popen', capture):
    try: codexrun.AppServerClient(['forbidden-provider'])
    except RuntimeError as e: assert str(e) == 'captured before provider'
'''
        result = self.run_code('import json\n' + code)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_both_real_child_seams_refuse_live_and_fallback_but_allow_explicit_root(self):
        for provider in ('claude', 'codex', 'antigravity'):
            with self.subTest(provider=provider):
                child = self.child(provider)
                self.assertIn('ORGTREE_AGENT_PARENT_DATA', child)
                for target in (None, '', str(self.live), str(self.live/'nested'),
                               str(self.root), str(self.legacy), str(self.legacy/'nested'),
                               str(self.live/'..'/'live'), 'relative'):
                    env = dict(child)
                    if target is None: env.pop('ORGTREE_DATA', None)
                    else: env['ORGTREE_DATA'] = target
                    result = self.run_code('from orgtree import store', env)
                    self.assertNotEqual(result.returncode, 0, (provider, target))
                    self.assertIn('explicit independent', result.stderr)
                if os.name == 'nt':
                    env = dict(child, ORGTREE_DATA=str(self.live).upper())
                    self.assertNotEqual(self.run_code('from orgtree import store', env).returncode, 0)
                self.assertFalse(self.live.exists())
                self.assertFalse(self.legacy.exists())
                chosen = self.root / ('explicit-' + provider)
                env = dict(child, ORGTREE_DATA=str(chosen))
                result = self.run_code("from orgtree import store; store.create_org('dev-positive'); print(store.DATA_ROOT)", env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((chosen/'orgs'/'dev-positive.db').exists())
                together = self.root / ('home-data-' + provider)
                env = dict(child, ORGTREE_DATA=str(together), HOME=str(together),
                           USERPROFILE=str(together))
                result = self.run_code(f"from orgtree import store; store.create_org('home-positive-{provider}')", env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((together/'orgs'/f'home-positive-{provider}.db').exists())
                parent_env = dict(child, ORGTREE_DATA=str(self.home), HOME=str(self.home),
                                  USERPROFILE=str(self.home))
                result = self.run_code('from orgtree import store', parent_env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('explicit independent', result.stderr)

    def test_engine_own_storage_is_unaffected_and_rebinding_is_guarded(self):
        result = self.run_code("from orgtree import store; store.create_org('engine-positive')")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.live/'orgs'/'engine-positive.db').exists())
        child = self.child('claude')
        child['ORGTREE_DATA'] = str(self.root/'explicit')
        code = '''
import os
from orgtree import store
store.DATA_ROOT = os.environ['ORGTREE_AGENT_PARENT_DATA']
os.environ['ORGTREE_DATA'] = store.DATA_ROOT
store.create_org('must-not-exist')
'''
        result = self.run_code(code, child)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('explicit independent', result.stderr)
        self.assertFalse((self.live/'orgs'/'must-not-exist.db').exists())

    def test_non_desktop_child_contract_unchanged(self):
        self.env.pop('ORGTREE_DESKTOP_MANAGED')
        for provider in ('claude', 'codex', 'antigravity'):
            self.assertNotIn('ORGTREE_AGENT_PARENT_DATA', self.child(provider))


if __name__ == '__main__': unittest.main()
