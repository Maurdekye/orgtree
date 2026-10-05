"""Exercise the real startup orchestration without a database or engine."""
import sys
from pathlib import Path
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree.orgdb import startup, registry, turn_runtime


class MigrationProgressTests(unittest.TestCase):
    def run_start(self, failure=False):
        phases = []
        lc = mock.Mock(build='test', instance_id='test', prefix='test_')

        def migrate():
            self.assertEqual(phases[-1], 'database-convert: upgrading organization schemas')
            if failure:
                raise RuntimeError('migration failed')
            return {'migrated': {}, 'unavailable': {}}

        lc.migrate_orgs.side_effect = migrate
        with mock.patch.object(registry, 'use_lifecycle'), \
             mock.patch.object(startup, 'first_pass', return_value={}), \
             mock.patch.object(startup, 'resume_claims', return_value={}), \
             mock.patch.object(startup, 'retry_new_build', return_value={}), \
             mock.patch.object(turn_runtime, 'start') as turn_start, \
             mock.patch.object(startup, '_register_turn_shutdown'):
            if failure:
                with self.assertRaisesRegex(RuntimeError, 'migration failed'):
                    startup.start(runtime='', data_root='unused', lc=lc, env={}, progress=phases.append)
                turn_start.assert_not_called()
                self.assertNotIn('database-orgdb-migrated', phases)
            else:
                startup.start(runtime='', data_root='unused', lc=lc, env={}, progress=phases.append)
                self.assertEqual(phases[-1], 'database-orgdb-migrated')
                turn_start.assert_called_once()
        lc.migrate_orgs.assert_called_once()

    def test_migration_gets_conversion_window_then_returns_to_normal(self):
        self.run_start()

    def test_failed_migration_does_not_announce_completion_or_start_turns(self):
        self.run_start(failure=True)


if __name__ == '__main__':
    unittest.main()
