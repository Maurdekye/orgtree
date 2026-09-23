"""External charter template folders: the app-wide list and its read-only scan.

Docket add-external-agent-charter-templates-folder. HOME/USERPROFILE and
ORGTREE_DATA point at a throwaway folder BEFORE the engine loads, so neither
the real ~/.orgtree nor the real app-settings.json is read or written.

Covered: a configurable ordered list of folders in app-wide settings,
validated and persisted; a scan that reports each folder's state and templates
without creating, writing or following anything; and GET /api/charters (the
hire form's preset source) offering every external template as its own choice
— per the user ruling of 2026-09-23, a repeated name is never shadowed.
"""
import os
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix='v3-charter-dirs-')
data = Path(_root.name) / 'data'; data.mkdir()
home = Path(_root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
app, *_ = load_app()
from orgtree import api, appsettings, store

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
ROUTE = '/api/app-settings/charter-template-dirs'


def tearDownModule():
    store._POOL.close_all('never-created')
    _root.cleanup()


def snapshot(folder: Path) -> dict[str, bytes]:
    return {str(p.relative_to(folder)): (p.read_bytes() if p.is_file() else b'<dir>')
            for p in sorted(folder.rglob('*'))}


class CharterTemplateDirTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.tmp = Path(tempfile.mkdtemp(dir=_root.name))
        self.put([])

    def put(self, dirs, status=200):
        response = self.client.put(ROUTE, headers=HEADERS, json={'dirs': dirs})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def get(self):
        response = self.client.get(ROUTE, headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def folder(self, name, files=None):
        path = self.tmp / name
        path.mkdir()
        for fname, text in (files or {}).items():
            (path / fname).write_text(text, encoding='utf-8')
        return path

    def test_empty_by_default_and_list_round_trips_in_order(self):
        self.assertEqual(self.get()['dirs'], [])
        a, b = self.folder('a'), self.folder('b')
        saved = self.put([str(b), str(a)])
        self.assertEqual(saved['dirs'], [str(b), str(a)], 'order is preserved as given')
        self.assertEqual([d['path'] for d in saved['directories']], [str(b), str(a)])
        self.assertEqual(self.get()['dirs'], [str(b), str(a)])
        # persisted in the app-wide settings record, not in any org document
        self.assertEqual(appsettings.load()['runtime']['charter_template_dirs'],
                         [str(b), str(a)])
        self.assertEqual(self.put([])['dirs'], [])

    def test_invalid_lists_are_refused_before_anything_is_written(self):
        keep = self.folder('keep')
        self.put([str(keep)])
        for bad in (['relative/path'], [''], ['   '], [str(keep), str(keep)],
                    [str(keep), str(keep).upper() if os.name == 'nt' else str(keep)],
                    [str(self.tmp / f'd{i}') for i in range(appsettings.CHARTER_TEMPLATE_DIRS_MAX + 1)],
                    ['C:\\' + 'x' * 2000 if os.name == 'nt' else '/' + 'x' * 2000]):
            self.put(bad, status=422)
            self.assertEqual(self.get()['dirs'], [str(keep)], f'{bad!r} must not replace the list')
        response = self.client.put(ROUTE, headers=HEADERS, json={'dirs': [1]})
        self.assertEqual(response.status_code, 422, response.text)

    def test_missing_folder_is_stored_and_reported_never_created(self):
        gone = self.tmp / 'not-there'
        saved = self.put([str(gone)])
        self.assertEqual(saved['dirs'], [str(gone)])
        (entry,) = saved['directories']
        self.assertEqual(entry['status'], 'missing')
        self.assertEqual(entry['templates'], [])
        self.assertFalse(gone.exists(), 'saving or scanning must never create the folder')

    def test_file_path_is_reported_not_a_directory(self):
        f = self.tmp / 'plain.md'
        f.write_text('x', encoding='utf-8')
        (entry,) = self.put([str(f)])['directories']
        self.assertEqual(entry['status'], 'not_directory')

    def test_unreadable_folder_is_reported_and_others_still_scan(self):
        bad = self.folder('bad')
        good = self.folder('good', {'reviewer.md': 'header\n---\nreview body'})
        real_listdir = os.listdir

        def fake_listdir(p):
            if os.path.normcase(str(p)) == os.path.normcase(str(bad)):
                raise PermissionError(13, 'Access is denied', str(p))
            return real_listdir(p)

        from unittest.mock import patch
        with patch.object(api.os, 'listdir', side_effect=fake_listdir):
            dirs = self.put([str(bad), str(good)])['directories']
        self.assertEqual(dirs[0]['status'], 'unreadable')
        self.assertIn('denied', dirs[0]['error'].lower())
        self.assertEqual(dirs[1]['status'], 'ok')
        self.assertEqual([t['name'] for t in dirs[1]['templates']], ['reviewer'])

    def test_scan_lists_md_templates_read_only_without_bodies_in_settings(self):
        d = self.folder('lib', {'field-lead.md': 'about this file\n---\nLead the field team.',
                                'notes.txt': 'not a template', 'plain.md': 'just a body'})
        (d / 'sub').mkdir()
        (d / 'sub' / 'nested.md').write_text('not walked', encoding='utf-8')
        before = snapshot(d)
        (entry,) = self.put([str(d)])['directories']
        self.assertEqual(entry['status'], 'ok')
        self.assertEqual([(t['name'], t['file']) for t in entry['templates']],
                         [('field lead', 'field-lead.md'), ('plain', 'plain.md')])
        self.assertEqual(entry['templates'][0]['path'], str(d / 'field-lead.md'))
        self.assertTrue(all('content' not in t for t in entry['templates']),
                        'the settings view carries names and paths, not bodies')
        # content scan uses the existing preset format (header ends at ---)
        (full,) = api.external_charter_templates(content=True)['directories']
        bodies = {t['file']: t['content'] for t in full['templates']}
        self.assertEqual(bodies, {'field-lead.md': 'Lead the field team.',
                                  'plain.md': 'just a body'})
        self.assertEqual(snapshot(d), before, 'scanning changes nothing on disk')

    def test_linked_folder_is_refused_and_linked_entries_are_declared_not_read(self):
        import _winapi
        target = self.folder('target', {'secret.md': 'FOREIGN BYTES'})
        link = self.tmp / 'linked-folder'
        _winapi.CreateJunction(str(target), str(link))
        self.addCleanup(lambda: os.rmdir(link))
        real = self.folder('real', {'honest.md': 'honest'})
        _winapi.CreateJunction(str(target), str(real / 'evil.md'))
        self.addCleanup(lambda: os.rmdir(real / 'evil.md'))
        # positive control: both junctions really follow
        self.assertTrue((link / 'secret.md').exists())
        dirs = self.put([str(link), str(real)])['directories']
        self.assertEqual(dirs[0]['status'], 'link_refused')
        self.assertEqual(dirs[0]['templates'], [])
        self.assertEqual(dirs[1]['status'], 'ok')
        self.assertEqual(dirs[1]['skipped_links'], ['evil.md'])
        self.assertEqual([t['file'] for t in dirs[1]['templates']], ['honest.md'])
        content = api.external_charter_templates(content=True)
        self.assertFalse(any('FOREIGN' in t.get('content', '')
                             for d in content['directories'] for t in d['templates']))

    def test_oversize_file_is_declared_and_never_read(self):
        d = self.folder('big', {'small.md': 'ok'})
        (d / 'huge.md').write_bytes(b'x' * (api.TEMPLATE_FILE_MAX_BYTES + 1))
        from unittest.mock import patch
        opened = []
        real_open = open

        def spy_open(p, *a, **k):
            opened.append(os.path.basename(str(p)))
            return real_open(p, *a, **k)

        self.put([str(d)])
        with patch('builtins.open', side_effect=spy_open):
            (entry,) = api.external_charter_templates(content=True)['directories']
        self.assertIn('small.md', opened, 'positive control: the spy sees template reads')
        self.assertEqual(entry['oversize'], ['huge.md'])
        self.assertEqual([t['file'] for t in entry['templates']], ['small.md'])
        self.assertNotIn('huge.md', opened)

    def test_listing_bound_is_declared(self):
        d = self.folder('many', {f't{i:03}.md': 'x' for i in range(5)})
        from unittest.mock import patch
        with patch.object(api, 'TEMPLATE_DIR_MAX_FILES', 3):
            (entry,) = self.put([str(d)])['directories']
        self.assertEqual(len(entry['templates']), 3)
        self.assertTrue(entry['listing_truncated'])

    def test_duplicates_are_reported_with_every_location_and_nothing_is_dropped(self):
        a = self.folder('a', {'coordinator.md': 'external coordinator', 'mine.md': 'a'})
        b = self.folder('b', {'mine.md': 'b', 'only-b.md': 'b'})
        payload = self.put([str(a), str(b)])
        dups = {d['name']: d['locations'] for d in payload['duplicates']}
        self.assertEqual([(l['source'], l['path']) for l in dups['mine']],
                         [('external', str(a / 'mine.md')), ('external', str(b / 'mine.md'))])
        # a bundled preset sharing the name is reported too (positive control:
        # coordinator.md ships in engine/docs/charters)
        self.assertEqual([l['source'] for l in dups['coordinator']], ['bundled', 'external'])
        self.assertNotIn('only b', dups)
        # the scaffold ranks nothing: every template is still listed
        self.assertEqual([t['file'] for t in payload['directories'][0]['templates']],
                         ['coordinator.md', 'mine.md'])
        self.assertEqual([t['file'] for t in payload['directories'][1]['templates']],
                         ['mine.md', 'only-b.md'])

    def charters(self):
        response = self.client.get('/api/charters', headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_hire_form_lists_external_templates_and_never_shadows(self):
        before = self.charters()
        self.assertNotIn('template_dirs', before, 'no folders configured, no new key')
        a = self.folder('a', {'coordinator.md': 'hdr\n---\nexternal coordinator A',
                              'mine.md': 'mine from A'})
        b = self.folder('b', {'mine.md': 'mine from B'})
        gone = self.tmp / 'gone'
        self.put([str(a), str(gone), str(b)])
        payload = self.charters()
        rows = payload['charters']
        # every user/bundled record from before is still there, byte for byte
        for r in before['charters']:
            self.assertIn(r, rows)
        ext = [r for r in rows if r['source'] == 'external']
        self.assertEqual(sorted((r['name'], r['dir'], r['content']) for r in ext), [
            ('coordinator', str(a), 'external coordinator A'),
            ('mine', str(a), 'mine from A'),
            ('mine', str(b), 'mine from B'),
        ])
        # same filename in two folders: BOTH offered, told apart by dir/path
        mines = [r for r in rows if r['name'] == 'mine']
        self.assertEqual([r['dir'] for r in mines], [str(a), str(b)],
                         'equal names order by configured folder order')
        # an external template sharing a bundled name does not hide it or itself
        coords = [r['source'] for r in rows if r['name'] == 'coordinator']
        self.assertEqual(coords, ['external', 'bundled'])
        paths = [r['path'] for r in rows]
        self.assertEqual(len(paths), len(set(paths)), 'path identifies each choice')
        self.assertEqual([(d['path'], d['status'], d['count']) for d in payload['template_dirs']],
                         [(str(a), 'ok', 2), (str(gone), 'missing', 0), (str(b), 'ok', 1)])
        self.assertTrue(all('templates' not in d for d in payload['template_dirs']))

    def test_folder_disappearing_between_reads_is_reported_not_an_error(self):
        d = self.folder('vanishing', {'t.md': 'x'})
        self.put([str(d)])
        self.assertEqual(self.charters()['template_dirs'][0]['status'], 'ok')
        (d / 't.md').unlink(); d.rmdir()
        payload = self.charters()
        self.assertEqual(payload['template_dirs'][0]['status'], 'missing')
        self.assertFalse(any(r['source'] == 'external' for r in payload['charters']))
        self.assertTrue(any(r['source'] == 'bundled' for r in payload['charters']))

    def test_saving_a_charter_never_writes_into_an_external_folder(self):
        d = self.folder('lib', {'shared.md': 'EXTERNAL ORIGINAL'})
        self.put([str(d)])
        before = snapshot(d)
        response = self.client.put('/api/charters/shared', headers=HEADERS,
                                   json={'content': 'saved text'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(Path(response.json()['path']),
                         home / '.orgtree' / 'charters' / 'shared.md')
        self.assertEqual(snapshot(d), before)
        by_source = {r['source']: r['content'] for r in self.charters()['charters']
                     if r['name'] == 'shared'}
        self.assertEqual(by_source, {'user': 'saved text', 'external': 'EXTERNAL ORIGINAL'})
        (home / '.orgtree' / 'charters' / 'shared.md').unlink()

    BAD_PATHS = ('C:\\bad<name\\templates', 'C:\\a:b\\c')

    def store_raw(self, dirs):
        # what a hand edit, or a record written before save-time validation,
        # can leave in app-settings.json: the reader keeps it as configured
        doc = appsettings.load(strict=True)
        doc['runtime']['charter_template_dirs'] = dirs
        appsettings._save(doc)

    def test_invalid_syntax_path_is_refused_on_save_but_missing_is_accepted(self):
        if os.name != 'nt':
            self.skipTest('path syntax refusal is a Windows ERROR_INVALID_NAME case')
        keep = self.folder('keep')
        self.put([str(keep)])
        for bad in self.BAD_PATHS:
            response = self.client.put(ROUTE, headers=HEADERS, json={'dirs': [str(keep), bad]})
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn('not a usable folder path', response.text)
            self.assertEqual(self.get()['dirs'], [str(keep)])
        # control: absent folders and absent drives are still accepted
        self.put([str(keep), str(self.tmp / 'later'), 'Q:\\not\\mounted'])

    def test_invalid_syntax_folder_in_the_record_never_breaks_presets(self):
        # Review F1 (popout-recovery-opus55, 44d7ab1): such a path used to raise
        # OSError [WinError 123] out of GET /api/charters, taking every
        # bundled and user preset with it, and out of the settings view.
        if os.name != 'nt':
            self.skipTest('ERROR_INVALID_NAME is a Windows path error')
        good = self.folder('good', {'lead.md': 'lead body'})
        user_dir = home / '.orgtree' / 'charters'
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / 'mine-f1.md').write_text('user body', encoding='utf-8')
        self.addCleanup(lambda: (user_dir / 'mine-f1.md').unlink())
        self.store_raw([self.BAD_PATHS[0], str(good), self.BAD_PATHS[1]])
        # positive control: the raw path really is refused by the OS as syntax
        with self.assertRaises(OSError) as raised:
            os.lstat(self.BAD_PATHS[0])
        self.assertEqual(getattr(raised.exception, 'winerror', None), 123)
        payload = self.charters()
        sources = {r['source'] for r in payload['charters']}
        self.assertEqual(sources, {'user', 'bundled', 'external'})
        self.assertIn(('lead', str(good)), [(r['name'], r.get('dir')) for r in payload['charters']])
        states = {d['path']: d for d in payload['template_dirs']}
        for bad in self.BAD_PATHS:
            self.assertEqual(states[bad]['status'], 'invalid_path')
            self.assertEqual(states[bad]['count'], 0)
            self.assertTrue(states[bad]['error'])
        self.assertEqual(states[str(good)]['status'], 'ok')
        # the settings view lists it too, so it can be seen and removed
        listed = self.get()
        self.assertEqual(listed['dirs'], [self.BAD_PATHS[0], str(good), self.BAD_PATHS[1]])
        self.assertEqual([d['status'] for d in listed['directories']],
                         ['invalid_path', 'ok', 'invalid_path'])
        self.assertEqual(self.put([str(good)])['dirs'], [str(good)])

    def test_unexpected_os_error_in_one_folder_is_contained(self):
        bad, good = self.folder('boom'), self.folder('fine', {'t.md': 'x'})
        real_lstat = os.lstat

        def fake_lstat(p, *a, **k):
            if os.path.normcase(str(p)) == os.path.normcase(str(bad)):
                raise OSError(5, 'simulated device error', str(p))
            return real_lstat(p, *a, **k)

        from unittest.mock import patch
        with patch.object(api.os, 'lstat', side_effect=fake_lstat):
            self.put([str(bad), str(good)])
            payload = self.charters()
        states = {d['path']: d['status'] for d in payload['template_dirs']}
        self.assertEqual(states, {str(bad): 'unreadable', str(good): 'ok'})
        self.assertTrue(any(r['source'] == 'bundled' for r in payload['charters']))

    def test_folder_named_md_is_not_a_file_and_uppercase_md_counts(self):
        d = self.folder('mixed', {'UPPER.MD': 'upper body', 'lower.md': 'lower body'})
        (d / 'sub.md').mkdir()
        (entry,) = self.put([str(d)])['directories']
        self.assertEqual(sorted(t['file'] for t in entry['templates']), ['UPPER.MD', 'lower.md'])
        self.assertEqual(entry['not_files'], ['sub.md'])
        self.assertNotIn('skipped_links', entry, 'a plain subfolder is not reported as a link')
        names = {r['name'] for r in self.charters()['charters'] if r['source'] == 'external'}
        self.assertEqual(names, {'UPPER', 'lower'})

    def test_file_swapped_between_lstat_and_open_is_not_served(self):
        # Review N1: an entry replaced after the lstat must not be followed.
        # The swap is simulated by an fstat that names a different file.
        d = self.folder('swap', {'victim.md': 'SWAPPED CONTENT', 'ok.md': 'fine'})
        self.put([str(d)])
        real_fstat = os.fstat
        opened_victim = []

        def fake_fstat(fd):
            info = real_fstat(fd)
            if opened_victim:
                return os.stat_result((info.st_mode, info.st_ino + 1, *tuple(info)[2:]))
            return info

        real_open = open

        def spy_open(p, *a, **k):
            opened_victim[:] = [True] if os.path.basename(str(p)) == 'victim.md' else []
            return real_open(p, *a, **k)

        from unittest.mock import patch
        with patch.object(api.os, 'fstat', side_effect=fake_fstat), \
                patch('builtins.open', side_effect=spy_open):
            (entry,) = api.external_charter_templates(content=True)['directories']
        self.assertEqual([t['file'] for t in entry['templates']], ['ok.md'])
        self.assertEqual(entry['skipped_links'], ['victim.md'])
        # control: without the simulated swap the same file is served
        (entry,) = api.external_charter_templates(content=True)['directories']
        self.assertEqual(sorted(t['file'] for t in entry['templates']), ['ok.md', 'victim.md'])

    def test_listing_bound_counts_skipped_entries_too(self):
        d = self.folder('bounded', {'c.md': 'x'})
        (d / 'a.md').mkdir(); (d / 'b.md').mkdir()
        from unittest.mock import patch
        with patch.object(api, 'TEMPLATE_DIR_MAX_FILES', 2):
            (entry,) = self.put([str(d)])['directories']
        self.assertEqual(entry['not_files'], ['a.md', 'b.md'])
        self.assertEqual(entry['templates'], [])
        self.assertTrue(entry['listing_truncated'])

    def test_routes_require_authentication(self):
        for method in ('GET', 'PUT'):
            response = self.client.request(method, ROUTE, json={'dirs': []})
            self.assertNotEqual(response.status_code, 200, method)


if __name__ == '__main__':
    unittest.main()
