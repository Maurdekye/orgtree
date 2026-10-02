"""The install-wide deployment profile selector (`deployment.current_policy`).

Only the "standard" profile exists. The removed "frozen" profile must stop
startup with a DeploymentConfigError that names it, and an unknown value must
raise too: a stale or mistyped selector is never silently ignored.

Run:  python tools/run-python-verification.py tests/test_deployment_profile.py
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-deployment-profile-', ignore_cleanup_errors=True)
data = Path(_root.name) / 'data'
data.mkdir()
home = Path(_root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import deployment  # noqa: E402

ENV = deployment.PROFILE_ENV


def tearDownModule():
    _root.cleanup()


class DeploymentProfileTests(unittest.TestCase):
    def test_unset_selects_standard(self):
        with patch.dict(os.environ):
            os.environ.pop(ENV, None)
            self.assertIs(deployment.current_policy(), deployment.STANDARD)
        self.assertEqual(deployment.STANDARD.name, 'standard')

    def test_blank_and_standard_select_standard(self):
        for value in ('', '   ', 'standard', ' Standard '):
            with self.subTest(value=value), patch.dict(os.environ, {ENV: value}):
                self.assertIs(deployment.current_policy(), deployment.STANDARD)

    def test_frozen_raises_a_config_error_naming_the_removed_profile(self):
        for value in ('frozen', ' FROZEN ', 'Frozen'):
            with self.subTest(value=value), patch.dict(os.environ, {ENV: value}):
                with self.assertRaises(deployment.DeploymentConfigError) as caught:
                    deployment.current_policy()
                message = str(caught.exception)
                self.assertIn("'frozen'", message)
                self.assertIn('has been removed', message)
                self.assertIn(ENV, message)

    def test_unknown_value_raises(self):
        for value in ('bogus', 'kiosk', 'standard2'):
            with self.subTest(value=value), patch.dict(os.environ, {ENV: value}):
                with self.assertRaises(deployment.DeploymentConfigError) as caught:
                    deployment.current_policy()
                self.assertIn(value, str(caught.exception))
                self.assertNotIn('has been removed', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
