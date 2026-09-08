import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

_root = tempfile.TemporaryDirectory(prefix='v2-policy-')
data = Path(_root.name)/'data'; data.mkdir()
home = Path(_root.name)/'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'): os.environ.pop(key,None)
from engine.launch import load_app
app,*_ = load_app()
from orgtree import accounts, store, ledger, supervisor, api, mcptool

def tearDownModule():
    store._POOL.close_all('docket-policy')
    _root.cleanup()

class DesktopPolicyTests(unittest.TestCase):
    def test_git_verify_refused_but_docket_list_available(self):
        org = store.create_org('docket-policy')
        org.hire(ledger.USER,None,'haiku',0,'worker')
        store.save_org(org)
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token':'operator'}
        body = {'org':'docket-policy','node':'worker','tool':'orgtree_work',
                'args':{'action':'verify','slug':'anything','stage':'committed'}}
        with patch.object(api.workitems,'evaluate',side_effect=AssertionError('Git must not run')):
            response = client.post('/api/agent',json=body,headers=headers)
            self.assertEqual(response.status_code,422,response.text)
            self.assertIn('Git verification',response.text)
            body['args']={'action':'list'}
            response = client.post('/api/agent',json=body,headers=headers)
            self.assertEqual(response.status_code,200,response.text)
        work = next(t for t in mcptool.available_tools() if t['name']=='orgtree_work')
        self.assertNotIn('verify',work['inputSchema']['properties']['action']['enum'])
        self.assertNotIn('`verify`',work['description'])
        self.assertIn('create',work['inputSchema']['properties']['action']['enum'])
        with patch.dict(os.environ,{'ORGTREE_DESKTOP_MANAGED':'0'}):
            legacy = next(t for t in mcptool.available_tools() if t['name']=='orgtree_work')
            self.assertIn('verify',legacy['inputSchema']['properties']['action']['enum'])

    def test_routes_and_runtime_refuse_excluded_features(self):
        client = TestClient(app)
        headers = {'X-Orgtree-Desktop-Token':'operator'}
        with patch.object(store,'create_org',side_effect=AssertionError('must reject before write')):
            for extra in ({'sandbox':True},{'kiosk':{}},{'disk_mb':4096}):
                response = client.post('/api/orgs',json={'name':'forbidden',**extra},headers=headers)
                self.assertEqual(response.status_code,422,response.text)
        for route in ('/api/accounts/keys','/api/accounts/order'):
            self.assertEqual(client.post(route,json={},headers=headers).status_code,404)
        with patch.object(accounts,'registry_path',side_effect=AssertionError('no registry read')):
            self.assertEqual(accounts.load()['keys'],[])
        with self.assertRaises(accounts.RegistryUnreadable): accounts.save({'keys':[]})
        org = ledger.Org.create('runtime')
        org.d.update(api_fallback=True,api_key='not-a-real-key',api_fallback_until=9999999999)
        self.assertFalse(supervisor.api_fallback_active(org))
        with self.assertRaises(ValueError): supervisor._deployment_org_gate(org)
        org.d.update(api_fallback=False)
        supervisor._deployment_org_gate(org)
        self.assertEqual(client.get('/api/orgs',headers=headers).status_code,200)

if __name__ == '__main__': unittest.main()
