"""Charter documents in ~/.orgtree/charters: listing, populate, save.

HOME/USERPROFILE point at a throwaway folder BEFORE the engine loads, so the
user charter directory resolves inside the fixture and the real ~/.orgtree is
never read or written. The bundled presets are the repository's real
engine/docs/charters files — their presence is this suite's positive control.
"""
import os
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix='v2-charters-')
data = Path(_root.name) / 'data'; data.mkdir()
home = Path(_root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app
app, *_ = load_app()
from orgtree import api, store

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
USER_DIR = home / '.orgtree' / 'charters'


def tearDownModule():
    store._POOL.close_all('never-created')
    _root.cleanup()


class CharterDocumentTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        if USER_DIR.is_dir():
            for f in USER_DIR.iterdir():
                f.unlink()

    def charters(self):
        response = self.client.get('/api/charters', headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_bundled_presets_are_listed_and_user_dir_is_the_documented_location(self):
        payload = self.charters()
        self.assertEqual(Path(payload['user_dir']), USER_DIR)
        bundled = {r['file']: r for r in payload['charters']}
        # positive control: the repository ships these exact presets
        for name in ('coordinator.md', 'redteam.md', 'implementer.md'):
            self.assertIn(name, bundled)
            self.assertEqual(bundled[name]['source'], 'bundled')
            self.assertTrue(bundled[name]['content'].strip())
        self.assertTrue(all(r['source'] in ('user', 'bundled') for r in payload['charters']))

    def test_populate_creates_every_preset_and_never_overwrites_user_edits(self):
        first = self.client.post('/api/charters/populate', headers=HEADERS).json()
        self.assertEqual(Path(first['dir']), USER_DIR)
        self.assertIn('coordinator.md', first['created'])
        self.assertEqual(first['existing'], [])
        created = sorted(p.name for p in USER_DIR.iterdir())
        self.assertEqual(created, sorted(first['created']))
        bundled_bytes = (Path(api.CHARTERS_DIR) / 'coordinator.md').read_bytes()
        self.assertEqual((USER_DIR / 'coordinator.md').read_bytes(), bundled_bytes)
        # user edits one file; repopulating must preserve the edit byte for byte
        (USER_DIR / 'coordinator.md').write_bytes(b'my own coordinator charter')
        second = self.client.post('/api/charters/populate', headers=HEADERS).json()
        self.assertEqual(second['created'], [])
        self.assertEqual(sorted(second['existing']), created)
        self.assertEqual((USER_DIR / 'coordinator.md').read_bytes(),
                         b'my own coordinator charter')
        # and the listing now serves the user's text for that name
        rows = {r['file']: r for r in self.charters()['charters']}
        self.assertEqual(rows['coordinator.md']['source'], 'user')
        self.assertEqual(rows['coordinator.md']['content'], 'my own coordinator charter')
        self.assertEqual(rows['redteam.md']['source'], 'user')

    def test_user_file_shadows_bundled_and_new_user_files_appear(self):
        USER_DIR.mkdir(parents=True, exist_ok=True)
        (USER_DIR / 'redteam.md').write_text('sharper redteam text', encoding='utf-8')
        (USER_DIR / 'my-team.md').write_text('a charter of my own', encoding='utf-8')
        rows = {r['file']: r for r in self.charters()['charters']}
        self.assertEqual(rows['redteam.md']['source'], 'user')
        self.assertEqual(rows['redteam.md']['content'], 'sharper redteam text')
        self.assertEqual(rows['my-team.md']['source'], 'user')
        self.assertEqual(rows['my-team.md']['name'], 'my team')
        self.assertEqual(rows['coordinator.md']['source'], 'bundled')
        files = [r['file'] for r in self.charters()['charters']]
        self.assertEqual(len(files), len(set(files)), 'a shadowed preset must not repeat')

    def test_save_writes_only_plain_names_into_the_user_directory(self):
        response = self.client.put('/api/charters/field notes', headers=HEADERS,
                                   json={'content': 'saved through the editing seam'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((USER_DIR / 'field notes.md').read_text(encoding='utf-8'),
                         'saved through the editing seam')
        rows = {r['file']: r for r in self.charters()['charters']}
        self.assertEqual(rows['field notes.md']['source'], 'user')
        # overwrite through the same route is the documented edit path
        self.client.put('/api/charters/field notes', headers=HEADERS,
                        json={'content': 'edited'})
        self.assertEqual((USER_DIR / 'field notes.md').read_text(encoding='utf-8'), 'edited')

    def test_traversal_and_oversize_names_are_refused_before_any_write(self):
        before = sorted(USER_DIR.iterdir()) if USER_DIR.is_dir() else []
        # an encoded separator re-routes away from the charter route entirely
        # (405/404 from the fallback); a plain bad name reaches it and gets 422.
        # Either way it is a refusal and nothing may be written anywhere.
        for name in ('..%2Fescape', 'a%2Fb', 'a%5Cb'):
            response = self.client.put(f'/api/charters/{name}', headers=HEADERS,
                                       json={'content': 'x'})
            self.assertIn(response.status_code, (404, 405, 422), f'{name}: {response.text}')
        for name in ('.hidden', 'dot.', ' lead', 'trail '):
            response = self.client.put(f'/api/charters/{name}', headers=HEADERS,
                                       json={'content': 'x'})
            self.assertEqual(response.status_code, 422, f'{name}: {response.text}')
        response = self.client.put('/api/charters/big', headers=HEADERS,
                                   json={'content': 'x' * (api.PRESET_MAX + 1)})
        self.assertEqual(response.status_code, 422, response.text)
        after = sorted(USER_DIR.iterdir()) if USER_DIR.is_dir() else []
        self.assertEqual(before, after)
        for parent in (home / '.orgtree', home):
            self.assertFalse((parent / 'escape.md').exists())

    def test_routes_require_authentication(self):
        for method, url in (('GET', '/api/charters'),
                            ('POST', '/api/charters/populate'),
                            ('PUT', '/api/charters/plain')):
            response = self.client.request(method, url, json={'content': 'x'})
            self.assertNotEqual(response.status_code, 200, url)


if __name__ == '__main__':
    unittest.main()
