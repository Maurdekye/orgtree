"""Measurement validity and containment controls; no PostgreSQL server required."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import importlib.util
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('measure_orgdb_hot',
    Path(__file__).resolve().parents[1] / 'tools/measure-orgdb-hot.py')
HOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOT)


class Measurement(unittest.TestCase):
    def test_storage_sides_use_the_actual_engine_switch_without_ambient_defaults(self):
        from orgtree.orgdb import enabled
        ambient = {'ORGTREE_STORAGE': 'orgdb', 'OTHER': 'retained'}
        for side, expected in [('legacy', False), ('native', True)]:
            env = HOT.measurement_environment(ambient, side)
            with patch.dict(HOT.os.environ, env, clear=True):
                self.assertEqual(enabled(), expected)
            self.assertEqual(env['OTHER'], 'retained')
        self.assertEqual(ambient['ORGTREE_STORAGE'], 'orgdb')
        with self.assertRaises(ValueError):
            HOT.measurement_environment(ambient, 'unknown')

    def test_operator_adapter_matches_the_current_door_signature(self):
        def door(slug, body, harness):
            return slug, body.op, harness
        api = SimpleNamespace(_op_door=door, Op=SimpleNamespace)
        self.assertEqual(HOT.operator_call(api, 'copy', op='move'), ('copy', 'move', None))

    def test_worker_refuses_foreign_output_and_database_before_engine_start(self):
        root = Path(tempfile.gettempdir()) / 'orgdb-hot-control' / ('hot'+'a'*12+'_')
        cfg = dict(agent='deltas-sol', admin='unused', runtime='dbname='+root.name+'legacy',
                   root=str(root), prefix=root.name, result=str(root/'result.json'))
        with patch.object(HOT, 'require_lock'), patch.object(HOT, 'private_cluster'), patch.dict(
                HOT.os.environ, {'ORGTREE_DATA':str(root/'data'), 'ORGTREE_ORGDB_PREFIX':root.name}):
            HOT.validate_child(cfg)
            for replacement in ({'result':str(root.parent/'outside.json')}, {'runtime':'dbname=orgtree'},
                    {'prefix':'orgtree_'}):
                with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                    HOT.validate_child(dict(cfg, **replacement))

    def test_incomplete_operation_rows_are_flagged_in_markdown(self):
        report = dict(commit='test', org='copy', agents=['dev'], runs=2, warmups=1,
                      table=[], cleanup_ok=True, source_unchanged=True, failure=None, complete=False)
        self.assertIn('not acceptance evidence', HOT.markdown(report))

    def test_failed_or_missing_samples_never_get_a_median(self):
        rows = [dict(operation='tree', side='legacy', ok=True, ms=1, path='legacy'),
                dict(operation='tree', side='legacy', ok=True, ms=3, path='legacy'),
                dict(operation='tree', side='native', ok=True, ms=0.1, path='native'),
                dict(operation='tree', side='native', ok=False, ms=None, path='failed')]
        row = HOT.summarize(rows, 2)[0]
        self.assertEqual(row['sides']['legacy']['median_ms'], 2)
        self.assertIsNone(row['sides']['native']['median_ms'])
        self.assertIsNone(row['ratio_native_over_legacy'])
        self.assertIsNone(HOT.summarize(rows[:1], 2)[0]['sides']['legacy']['median_ms'])

    def test_actual_median_and_ratio(self):
        rows = [dict(operation='title', side=side, ok=True, ms=ms, path=side)
                for side, samples in [('legacy', [9, 1, 2]), ('native', [6, 3, 4])]
                for ms in samples]
        row = HOT.summarize(rows, 3)[0]
        self.assertEqual(row['ratio_native_over_legacy'], 2)
        self.assertEqual(row['sides']['native']['median_ms'], 4)

    def test_environment_has_no_ambient_engine_or_provider_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.dict(HOT.os.environ, {'OPENAI_API_KEY':'secret', 'ORGTREE_PG_URL':'live',
                    'ADMIN':'secret', 'RUNTIME':'secret', 'ANTHROPIC_API_KEY':'secret'}, clear=True):
                env = HOT.clean_environment(Path(root))
            self.assertNotIn('OPENAI_API_KEY', env)
            self.assertNotIn('ANTHROPIC_API_KEY', env)
            self.assertNotIn('ADMIN', env)
            self.assertNotIn('RUNTIME', env)
            self.assertNotIn('ORGTREE_PG_URL', env)
            self.assertEqual(Path(env['ORGTREE_DATA']), Path(root) / 'data')

    def test_database_conninfo_replacement_preserves_other_fields(self):
        from psycopg.conninfo import conninfo_to_dict
        info = conninfo_to_dict(HOT.with_db('host=localhost port=111 user=u password=p dbname=old', 'copy'))
        self.assertEqual(info['dbname'], 'copy')
        self.assertEqual(info['password'], 'p')
        self.assertEqual(info['port'], '111')

    def test_non_loopback_rejected_before_connecting(self):
        with patch('psycopg.connect') as connect:
            with self.assertRaises(ValueError):
                HOT.private_cluster('host=remote dbname=postgres', 'host=localhost user=orgtree_runtime',
                    'deltas-sol', Path('artifacts/p03-db'))
            connect.assert_not_called()

    def test_both_targets_data_directory_checked(self):
        with tempfile.TemporaryDirectory() as root:
            private = Path(root) / 'deltas-sol' / 'pgdata'
            private.mkdir(parents=True)
            with patch('psycopg.connect') as connect:
                raw = connect.return_value.__enter__.return_value
                raw.execute.return_value.fetchone.side_effect = [(str(private),), (str(Path(root)/'live'),)]
                with self.assertRaises(ValueError):
                    HOT.private_cluster('host=localhost port=111 user=orgtree_admin',
                        'host=localhost port=222 user=orgtree_runtime', 'deltas-sol', Path(root))
                self.assertEqual(connect.call_count, 2)

    def test_holder_record_alone_is_not_authorization(self):
        with tempfile.TemporaryDirectory() as root:
            holder = Path(root) / 'holder.json'
            holder.write_text(json.dumps({'agent':'deltas-sol','pid':999999,'small':False}), encoding='utf-8')
            with self.assertRaises(ValueError):
                HOT.require_lock('deltas-sol', Path(root))

    def test_cleanup_never_accepts_a_product_or_broad_prefix(self):
        with patch('psycopg.connect') as connect:
            for prefix in ('orgtree_', '', 'hot', 'hot123_', 'hot'+'f'*12):
                with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                    HOT.drop_groups('unused', [prefix])
            connect.assert_not_called()

    def test_cleanup_continues_after_one_failed_drop_and_keeps_foreign_databases(self):
        prefix = 'hot'+'a'*12+'_'
        with patch('psycopg.connect') as connect:
            raw = connect.return_value.__enter__.return_value
            calls = []
            def execute(statement):
                text = str(statement)
                calls.append(text)
                if text == 'SELECT datname FROM pg_database':
                    if len(calls) == 1:
                        return iter([('orgtree',), (prefix+'org_1',), (prefix+'app',)])
                    return iter([(prefix+'org_1',), ('orgtree',)])
                if 'org_1' in text:
                    raise RuntimeError('private drop failure')
            raw.execute.side_effect = execute
            remaining, errors = HOT.drop_groups('unused', [prefix])
        self.assertEqual(remaining, [prefix+'org_1'])
        self.assertEqual(errors, ['RuntimeError'])
        self.assertTrue(any('app' in call for call in calls[1:-1]))
        self.assertFalse(any("Identifier('orgtree')" in call for call in calls))


class ParentReports(unittest.TestCase):
    def run_parent(self, output_root, *, folder_error=False):
        """Exercise parent orchestration; only external database/child work is mocked."""
        root = output_root / 'orgdb-hot-control'
        root.mkdir()
        output = output_root / 'reports' / 'measurement'
        args = SimpleNamespace(agent='deltas-sol', template='hot_template', org='copy',
                               agents='dev', operations='title', runs=1, warmups=1,
                               output=output)
        original_remove = HOT.shutil.rmtree

        def remove(path):
            self.assertEqual(Path(path), root)
            if folder_error:
                raise PermissionError('private path and connection secrets must not be reported')
            original_remove(path)

        def child(config, *unused):
            if config['phase'] == 'start':
                return {'converted': True}
            return dict(rows=[dict(operation='title', side=config['side'], ok=True,
                                   ms=2, path=config['side'])], warmup_ms=1,
                        source_hash='same-start', import_provenance={'checkout':'test'},
                        refused_launches=[])

        with ExitStack() as mocks:
            mocks.enter_context(patch.object(HOT, 'require_lock'))
            mocks.enter_context(patch.object(HOT, 'private_cluster', return_value='private'))
            mocks.enter_context(patch.object(HOT.tempfile, 'mkdtemp', return_value=str(root)))
            mocks.enter_context(patch.object(HOT, 'digest', return_value={'rows':1}))
            mocks.enter_context(patch.object(HOT, 'call_child', side_effect=child))
            drops = mocks.enter_context(patch.object(HOT, 'drop_groups', return_value=([], [])))
            mocks.enter_context(patch.object(HOT.shutil, 'rmtree', side_effect=remove))
            mocks.enter_context(patch.dict(HOT.os.environ, {
                'ORGTREE_TEST_PG_ADMIN_URL':'dbname=postgres',
                'ORGTREE_TEST_PG_RUNTIME_URL':'dbname=postgres user=orgtree_runtime'}))
            connect = mocks.enter_context(patch('psycopg.connect'))
            raw = connect.return_value.__enter__.return_value
            raw.execute.return_value.fetchone.return_value = None
            raw.execute.return_value.__iter__.return_value = iter([(1, 'copy')])
            result = HOT.parent(args)
        self.assertEqual(drops.call_count, 2)  # Per-group cleanup plus final retry.
        self.assertTrue(output.with_suffix('.json').is_file())
        self.assertTrue(output.with_suffix('.md').is_file())
        report = json.loads(output.with_suffix('.json').read_text(encoding='utf-8'))
        self.assertEqual(len(report['table']), 1)
        self.assertEqual(set(report['table'][0]['sides']), {'legacy', 'native'})
        self.assertTrue(report['source_unchanged'])
        self.assertEqual(report['remaining_databases'], [])
        return result, report, output.with_suffix('.md').read_text(encoding='utf-8'), root

    def test_late_folder_cleanup_error_preserves_both_reports_and_fails_run(self):
        with tempfile.TemporaryDirectory() as folder:
            result, report, markdown, root = self.run_parent(Path(folder), folder_error=True)
            self.assertEqual(result, 1)
            self.assertFalse(report['complete'])
            self.assertFalse(report['cleanup_ok'])
            self.assertFalse(report['folder_cleanup_ok'])
            self.assertEqual(report['failure'], 'PermissionError')
            self.assertEqual(report['folder_cleanup_error']['error'], 'PermissionError')
            self.assertEqual(report['failure_detail'], report['folder_cleanup_error'])
            self.assertIn('not acceptance evidence', markdown)
            self.assertNotIn('connection secrets', json.dumps(report))
            self.assertTrue(root.is_dir())

    def test_successful_parent_removes_folder_and_writes_complete_reports(self):
        with tempfile.TemporaryDirectory() as folder:
            result, report, markdown, root = self.run_parent(Path(folder))
            self.assertEqual(result, 0)
            self.assertTrue(report['complete'])
            self.assertTrue(report['cleanup_ok'])
            self.assertTrue(report['folder_cleanup_ok'])
            self.assertNotIn('folder_cleanup_error', report)
            self.assertIsNone(report['failure'])
            self.assertNotIn('not acceptance evidence', markdown)
            self.assertFalse(root.exists())


if __name__ == '__main__':
    unittest.main()
