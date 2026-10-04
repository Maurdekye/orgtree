"""Pure rehearsal controls: boundary collisions, changes, instrumentation and false passes."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import importlib.util
import contextlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rehearse_orgdb', ROOT / 'tools/rehearse-orgdb.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
scan_spec = importlib.util.spec_from_file_location('rehearsal_verifier_scan', ROOT / 'tests/test_orgdb_verify_static.py')
scan = importlib.util.module_from_spec(scan_spec)
sys.modules[scan_spec.name] = scan
scan_spec.loader.exec_module(scan)


class RehearsalControls(unittest.TestCase):
    def test_inventory_digest_catches_same_count_changes_and_framing_collisions(self):
        a, b = r.framed_digest(['a', 'bc']), r.framed_digest(['ab', 'c'])
        self.assertEqual(a['count'], b['count'])
        self.assertNotEqual(a['sha256'], b['sha256'])
        self.assertNotEqual(r.framed_digest(['null'])['sha256'], r.framed_digest(['"null"'])['sha256'])
        # Identical framing must still distinguish the row contents.
        self.assertNotEqual(r.framed_digest(['old']), r.framed_digest(['new']))
        self.assertNotEqual(r.framed_digest(['a', 'a']), r.framed_digest(['a']))
        self.assertEqual(r.framed_digest(iter(['a', 'bc'])), a)

    def test_manifest_catches_edit_add_remove_and_ignores_conversion_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'orgs').mkdir()
            marker = root / 'orgs/a.pg'
            marker.write_bytes(b'{"org_id":1}')
            backup = root / 'pre-postgres/orgs/a.db'
            backup.parent.mkdir(parents=True)
            backup.write_bytes(b'old database')
            before = r.file_manifest(root)
            self.assertIsNone(before['accounts-registry.json'])
            (root / 'conversion').mkdir()
            (root / 'conversion/report.json').write_bytes(b'expected addition')
            self.assertEqual(before, r.file_manifest(root))
            marker.write_bytes(b'{"org_id":2}')
            self.assertNotEqual(before, r.file_manifest(root))
            marker.write_bytes(b'{"org_id":1}')
            backup.unlink()
            self.assertNotEqual(before, r.file_manifest(root))
            backup.write_bytes(b'old database')
            (root / 'accounts-registry.json').write_bytes(b'{}')
            self.assertNotEqual(before, r.file_manifest(root))

    def test_environment_scrubs_credentials_installed_paths_and_switch(self):
        dirty = {'Orgtree_DATA': 'live', 'ORGTREE_V2_TOKEN': 'secret', 'OPENAI_API_KEY': 'key',
                 'PYTHONPATH': 'installed', 'ADMIN': 'admin secret', 'RUNTIME': 'runtime secret',
                 'REHEARSAL_SOURCE_DIR': 'old capture', 'PATH': 'bins', 'SYSTEMROOT': 'windows'}
        self.assertEqual(r.scrub(dirty), {'PATH': 'bins', 'SYSTEMROOT': 'windows'})

    def test_capture_injection_preserves_arguments_and_non_converter_launches(self):
        command = ['python', '-c', 'import sys; sys.path.insert(0,sys.argv[1]); '
                   'from orgtree.orgdb.convert.__main__ import main; sys.exit(main(sys.argv[2:]))',
                   'backend', 'retry', '--org-id', '4']
        actual = r.capture_command(command, Path("folder with spaces/rehearse-orgdb.py"))
        self.assertEqual(actual[:2] + actual[3:], command[:2] + command[3:])
        self.assertEqual(actual[2].count("run_name='rehearsal_capture'"), 1)
        self.assertEqual(command[2].count('runpy'), 0)
        compile(actual[2], '<preamble>', 'exec')
        for other in (['python', 'plain.py'], 'shell string', ['python', '-c', 'print(1)']):
            self.assertIs(r.capture_command(other, Path('tool')), other)

    def test_plain_instrumentation_context_does_not_patch_any_launch(self):
        original = r.subprocess.Popen
        with r.instrument(False):
            self.assertIs(r.subprocess.Popen, original)
        with r.instrument(True):
            self.assertIsNot(r.subprocess.Popen, original)
        self.assertIs(r.subprocess.Popen, original)

    def test_source_wrapper_returns_entire_loader_result_by_identity(self):
        from orgtree.orgdb.convert import legacy
        from types import SimpleNamespace
        import json
        with tempfile.TemporaryDirectory() as folder:
            loaded = ({'nodes': {'a': {'grant': 3}}}, {'inventory': 1}, [('receipt',)])
            with patch.dict(r.os.environ, {r.CAPTURE_ENV: folder}), \
                    patch.object(legacy, 'load_document', return_value=loaded):
                r.install_capture()
                self.assertIs(legacy.load_document(SimpleNamespace(org_id=17)), loaded)
                self.assertEqual(json.loads((Path(folder) / '17.json').read_text()), loaded[0])

    def test_verifier_independence_scan_stays_enforced_and_catches_planted_import(self):
        source = (ROOT / 'tools/orgdb_verify.py').read_text(encoding='utf-8')
        self.assertEqual(scan.scan(source), [])
        self.assertTrue(scan.scan(source + '\nfrom orgtree.orgdb.convert import run\n'))
        self.assertTrue(scan.scan(source + '\nfrom orgtree.orgdb import mappers\n'))

    def test_memory_peaks_include_child_tree_and_do_not_add_peaks_from_different_times(self):
        samples = r.MemorySamples()
        samples.add(100, {4: 20, 5: 30})
        samples.add(200, {4: 5})
        out = samples.report()
        self.assertEqual(out['parent_peak_rss_bytes'], 200)
        self.assertEqual(out['children_peak_rss_bytes'], 50)
        self.assertEqual(out['tree_peak_rss_bytes'], 205)
        self.assertEqual(out['children_observed'], 2)
        self.assertEqual(out['samples'], 2)

    def test_state_validation_rejects_empty_missing_extra_and_wrong_state(self):
        orgs = [(1, 'good'), (2, 'other')]
        good = [{'slug': 'good', 'state': 'active'}, {'slug': 'other', 'state': 'active'}]
        r.validate_states(orgs, good)
        for rows in ([], good[:1], good + [{'slug': 'extra', 'state': 'active'}],
                     good + [good[0]],
                     [{'slug': 'good', 'state': 'unavailable'}, good[1]]):
            with self.assertRaises(RuntimeError):
                r.validate_states(orgs, rows)
        with self.assertRaises(RuntimeError):
            r.validate_states(orgs, good, 'good', 'dup-slug')

    def test_registry_comparison_ignores_time_but_detects_kind_counts(self):
        left = {'a': {'state': 'active', 'counts': {'nodes': [3, 3]}, 'conversion_seconds': [1]}}
        right = {'a': {'state': 'active', 'counts': {'nodes': [3, 3]}, 'conversion_seconds': [2]}}
        self.assertEqual(r.comparable(left), r.comparable(right))
        right['a']['counts'] = {'nodes': [3, 2]}
        self.assertNotEqual(r.comparable(left), r.comparable(right))

    def test_report_fault_counts_handle_embedded_nul_without_exporting_values(self):
        source = {'nodes': {'a': {'title': 'contains\x00nul', 'created': 'not-a-date'}},
                  'mail': [{'body': 'plain'}, {'body': 'two\x00nuls\x00'}], 'missing': None}
        self.assertEqual(r.nul_values(source), 2)
        self.assertEqual(r.nul_values({'text': 'literal\\u0000'}), 0)
        self.assertEqual(r.nul_values([]), 0)

    def test_success_report_collector_retains_other_orgs_across_retry(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = root / 'conversion/first/run.json'
            first.parent.mkdir(parents=True)
            first.write_text(json.dumps({'orgs': [{'slug': 'good', 'outcome': 'active',
                              'kept_in_extra': {'agents': {'created': 2}}},
                             {'slug': 'bad', 'outcome': 'unavailable'}]}))
            before = r.conversion_reports(root)
            self.assertEqual(before, {'good': {'kept_in_extra': {'agents': {'created': 2}}, 'unregistered_keys': []}})
            # The product may reuse a same-second report directory. The caller preserves
            # first-pass counts before Retry and merges the newly read report afterward.
            first.write_text(json.dumps({'slug': 'bad', 'outcome': 'active', 'kept_in_extra': {}}))
            before.update(r.conversion_reports(root))
            self.assertEqual(before, {'good': {'kept_in_extra': {'agents': {'created': 2}}, 'unregistered_keys': []},
                                      'bad': {'kept_in_extra': {}, 'unregistered_keys': []}})

    def test_sqlite_copy_preserves_offline_input_files_and_reads_committed_wal(self):
        import hashlib
        import sqlite3
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / 'input.db', root / 'output.db'
            with contextlib.closing(sqlite3.connect(source)) as c:
                c.execute('PRAGMA journal_mode=WAL')
                c.execute('CREATE TABLE test(value text)')
                c.commit()
                c.execute("INSERT INTO test VALUES ('committed in WAL')")
                c.commit()
                def files():
                    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in root.glob('input.db*')}
                before = files()
                self.assertIn('input.db-wal', before)
                r.sqlite_copy(source, target)
                self.assertEqual(before, files())
                with contextlib.closing(sqlite3.connect(target)) as dest:
                    self.assertEqual(dest.execute('SELECT value FROM test').fetchall(), [('committed in WAL',)])
            self.assertFalse(Path(str(source) + '-wal').exists())
            r.sqlite_copy(source, root / 'closed-copy.db')
            self.assertFalse(Path(str(source) + '-wal').exists())
            self.assertFalse(Path(str(source) + '-shm').exists())

    def test_reader_receipt_rejects_missing_false_zero_and_wrong_checkout(self):
        source = {'nodes': {'agent': {}}, 'work_items': [{'slug': 'active'}],
                  'work_items_archive': [{'slug': 'archived'}]}
        good = {'engine_load_equal': True, 'api_equal': True, 'sections_compared': 3,
                'agents_compared': 1, 'docket_lists_compared': 1, 'docket_details_compared': 2,
                'import_provenance': r.PROVENANCE.as_dict()}
        r.check_load_result(good, source)
        for key in good:
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                r.check_load_result({k: v for k, v in good.items() if k != key}, source)
        for change in ({'engine_load_equal': False}, {'api_equal': False},
                       {'agents_compared': 0}, {'docket_details_compared': 0},
                       {'sections_compared': True}, {'import_provenance': {'repo': 'installed'}}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                r.check_load_result(dict(good, **change), source)

    def test_ordinary_and_retry_coverage_rejects_the_old_selected_org_only_control(self):
        orgs = [(1, 'chosen'), (2, 'other')]
        good = {'engine_load_equal': True, 'api_equal': True}
        r.check_load_coverage(orgs, {'chosen': good, 'other': good})
        with self.assertRaises(RuntimeError):
            r.check_load_coverage([], {})
        for omitted in ({}, {'chosen': good}, {'chosen': good, 'other': {}},
                        {'chosen': good, 'other': good, 'unrelated': good}):
            with self.subTest(rows=omitted), self.assertRaises(RuntimeError):
                r.check_load_coverage(orgs, omitted)

    def test_successful_child_that_never_ran_the_load_control_is_rejected(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(r, 'worker_argv', return_value=['python', 'rehearse-orgdb.py']), \
                patch.object(r, 'child_env', return_value={}), \
                patch.object(r, 'with_db', return_value='private'), \
                patch.object(r, 'run_worker', return_value=0) as child:
            with self.assertRaisesRegex(RuntimeError, 'load did not complete'):
                r.compare_engine_one(SimpleNamespace(prefix='private'), Path(folder),
                    {'legacy_org_id': 1, 'slug': 'chosen'}, Path(folder) / 'source.json',
                    {'nodes': {}}, 'admin', 'runtime', 'legacy')
            self.assertIn('--load-output', child.call_args.args[0])

    def _terminal_report(self, failure=None):
        """Run real main/execute_report/run_pair; replace external DB/process I/O."""
        import argparse
        import json
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'result.json'
            args = argparse.Namespace(
                release='3.0.9', fault='none', json_output=output,
                template=None, dump=Path('synthetic.dump'), legacy_sql=None,
                sqlite_orgs=None, custodian=None, pg_bin=None, side_files=None,
                fault_org=None, worker=False, load_worker=False)

            @contextlib.contextmanager
            def own_cluster(*unused):
                yield 'postgresql://admin@127.0.0.1:9/dev', 'postgresql://runtime@127.0.0.1:9/dev'

            def worker(argv, env, log, timeout):
                result = {'initial_registry': {'org': {'state': 'active', 'counts': {'nodes': [1, 1]}}},
                          'final_registry': {'org': {'state': 'active', 'counts': {'nodes': [1, 1]}}},
                          'verified': {'org': {'engine_load_equal': True, 'api_equal': True}}}
                target = Path(argv[argv.index('--worker-output') + 1])
                target.write_text(json.dumps(result), encoding='utf-8')
                return 0

            inventories = [{'table': {'count': 1, 'sha256': 'before'}}] * 2
            if failure == 'source template changed':
                inventories[1] = {'table': {'count': 1, 'sha256': 'after'}}
            cleanup = [3, 3, RuntimeError(failure) if failure == 'private cleanup failed' else 1]
            with patch.object(r, 'arguments', return_value=args), \
                    patch.object(r, 'free_commit', return_value=20 * 1024 ** 3), \
                    patch.object(r, 'cluster', own_cluster), \
                    patch.object(r, 'prepare'), \
                    patch.object(r, 'inventory', side_effect=inventories), \
                    patch.object(r, 'run_worker', side_effect=worker) as children, \
                    patch.object(r, 'drop_owned', side_effect=cleanup) as dropped:
                if failure:
                    with self.assertRaisesRegex(RuntimeError, failure):
                        r.main()
                else:
                    self.assertEqual(r.main(), 0)
                self.assertEqual(children.call_count, 2)
                self.assertEqual(dropped.call_count, 3)
            saved = json.loads(output.read_text(encoding='utf-8'))
            self.assertTrue(saved['plain_matches_instrumented'])
            self.assertEqual(len(saved['runs']), 2)
            return saved

    def test_saved_report_is_failed_when_final_template_inventory_changes(self):
        self.assertIs(self._terminal_report('source template changed')['passed'], False)

    def test_saved_report_is_failed_when_final_template_cleanup_raises(self):
        self.assertIs(self._terminal_report('private cleanup failed')['passed'], False)

    def test_saved_report_is_successful_after_final_checks_and_cleanup(self):
        saved = self._terminal_report()
        self.assertIs(saved['passed'], True)
        self.assertEqual(saved['template_before'], saved['template_after'])
        self.assertEqual(len(saved['cleanup']), 3)


if __name__ == '__main__':
    unittest.main()
