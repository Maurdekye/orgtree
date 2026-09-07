"""Production presentation writer and download adapter on an isolated root."""
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

_temp = tempfile.TemporaryDirectory(prefix='v2-artifact-api-')
os.environ['ORGTREE_DATA'] = _temp.name
os.environ['HOME'] = _temp.name
os.environ['USERPROFILE'] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import api, store, supervisor
from orgtree.ledger import USER

def tearDownModule():
    store._POOL.close_all('download-fixture')
    _temp.cleanup()

class ArtifactAPITests(unittest.TestCase):
    def test_real_present_snapshots_dependency_bytes_and_downloads_zip(self):
        org = store.create_org('download-fixture')
        org.hire(USER, None, 'haiku', 0, 'author')
        store.save_org(org)
        scratch = Path(supervisor.scratch_dir('download-fixture','author'))
        scratch.mkdir(parents=True, exist_ok=True)
        (scratch/'style.css').write_bytes(b'body { color:red }')
        (scratch/'page.html').write_bytes(b'<html><link rel="stylesheet" href="style.css"><body>hello</body></html>')
        result = api._agent_present(org, 'author', {'path':'page.html','title':'Page'})
        store.save_org(org)
        doc = org.d['documents'][-1]
        self.assertTrue(doc['file'].startswith('outbox/presentation-'))
        (scratch/'style.css').write_bytes(b'changed after presentation')
        response = api.document_download('download-fixture', doc['id'])
        self.assertIn('.zip', response.headers['content-disposition'])
        with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
            self.assertEqual(archive.read('style.css'), b'body { color:red }')
            self.assertIn(b'hello', archive.read('page.html'))
        api._agent_present(org, 'author', {'body':'# Exact\r\n','title':'Markdown'})
        store.save_org(org)
        response = api.document_download('download-fixture', org.d['documents'][-1]['id'])
        self.assertEqual(response.body, b'# Exact\r\n')

if __name__ == '__main__': unittest.main()
