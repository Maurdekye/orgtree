"""Precedence-order proof for the two CLI resolvers PROC-01/PROC-02 flagged as
untested: providers.antigravity_path() and supervisor.claude_install_state()/
_claude_argv() must resolve their inputs in the same env > pin-or-install >
PATH order providers.codex_path() already uses (L447-458, the shape
reference). RESEARCH.md found no new resolver code was needed here — this
file proves the ORDER each existing implementation follows, one branch at a
time (with lower-priority signals ALSO available where relevant), not merely
that some path comes back.
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='provider-path-resolution-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'provider-path-resolution-only'
os.environ['ORGTREE_WARM'] = '0'
os.environ['ORGTREE_TURNLOG'] = '1'
for _k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))

from orgtree import providers                       # noqa: E402
from orgtree import supervisor as sup                # noqa: E402


class AntigravityPathResolutionTests(unittest.TestCase):
    """providers.antigravity_path(): ORGTREE_ANTIGRAVITY > install > PATH."""

    def test_env_override_wins_even_when_install_and_path_also_resolve(self):
        with patch.dict(os.environ, {'ORGTREE_ANTIGRAVITY': '/env/agy'}), \
             patch.object(providers, '_antigravity_install_path',
                          lambda: '/install/agy'), \
             patch.object(shutil, 'which', lambda name: '/path/agy'):
            self.assertEqual(('/env/agy', 'env'), providers.antigravity_path())

    def test_install_wins_over_path_when_env_is_absent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_ANTIGRAVITY', None)
            with patch.object(providers, '_antigravity_install_path',
                               lambda: '/install/agy'), \
                 patch.object(shutil, 'which', lambda name: '/path/agy'):
                self.assertEqual(('/install/agy', 'install'),
                                  providers.antigravity_path())

    def test_path_is_used_when_env_and_install_are_absent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_ANTIGRAVITY', None)
            with patch.object(providers, '_antigravity_install_path',
                               lambda: None), \
                 patch.object(shutil, 'which', lambda name: '/path/agy'):
                self.assertEqual(('/path/agy', 'path'),
                                  providers.antigravity_path())

    def test_all_absent_resolves_to_none(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_ANTIGRAVITY', None)
            with patch.object(providers, '_antigravity_install_path',
                               lambda: None), \
                 patch.object(shutil, 'which', lambda name: None):
                self.assertEqual((None, ''), providers.antigravity_path())


class ClaudeInstallStateResolutionTests(unittest.TestCase):
    """supervisor.claude_install_state(force=True): ORGTREE_CLAUDE > _PIN >
    PATH — force=True on every call, since the function caches its result for
    60s (L380-382): without it, a later test's branch would be served the
    FIRST test's cached result instead of being genuinely re-evaluated."""

    def test_env_override_wins_even_when_pin_and_path_also_resolve(self):
        with patch.dict(os.environ, {'ORGTREE_CLAUDE': '/env/claude'}), \
             patch.object(os.path, 'exists', lambda p: True), \
             patch.object(shutil, 'which', lambda name: '/path/claude'):
            st = sup.claude_install_state(force=True)
        self.assertEqual('env', st['source'])
        self.assertEqual('/env/claude', st['path'])
        self.assertTrue(st['installed'])

    def test_pin_wins_over_path_when_env_is_absent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_CLAUDE', None)
            with patch.object(os.path, 'exists', lambda p: True), \
                 patch.object(shutil, 'which', lambda name: '/path/claude'):
                st = sup.claude_install_state(force=True)
        self.assertEqual('pin', st['source'])
        self.assertEqual(sup._PIN, st['path'])
        self.assertTrue(st['installed'])

    def test_path_is_used_when_env_and_pin_are_absent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_CLAUDE', None)
            with patch.object(os.path, 'exists',
                               lambda p: p != sup._PIN), \
                 patch.object(shutil, 'which', lambda name: '/path/claude'):
                st = sup.claude_install_state(force=True)
        self.assertEqual('path', st['source'])
        self.assertEqual('/path/claude', st['path'])
        self.assertTrue(st['installed'])

    def test_all_absent_resolves_to_not_installed(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ORGTREE_CLAUDE', None)
            with patch.object(os.path, 'exists', lambda p: False), \
                 patch.object(shutil, 'which', lambda name: None):
                st = sup.claude_install_state(force=True)
        self.assertEqual('path', st['source'])
        self.assertIsNone(st['path'])
        self.assertFalse(st['installed'])


if __name__ == '__main__':
    unittest.main()
