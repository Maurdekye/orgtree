import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

_temp = tempfile.TemporaryDirectory(prefix='v2-maintenance-')
_data = Path(_temp.name) / 'data'
_home = Path(_temp.name) / 'home'
_data.mkdir(); _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator-test')
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'):
    os.environ.pop(key,None)
from engine import launch
app, _, _, _, _ = launch.load_app()
from orgtree import store, ledger, supervisor, agentauth, desktop_maintenance as maintenance

def tearDownModule():
    store._POOL.close_all('maintenance')
    _temp.cleanup()

class MaintenanceTests(unittest.TestCase):
    def test_authenticated_dispatch_and_atomic_ack_controls(self):
        org = store.create_org('maintenance')
        org.hire(ledger.USER,None,'haiku',2,'boss')
        org.hire(ledger.USER,'boss','haiku',0,'kid')
        store.save_org(org)
        client = TestClient(app)
        headers = {'X-Orgtree-Agent-Token':agentauth.child_env('maintenance','boss')['ORGTREE_AGENT_TOKEN']}
        operator = {'X-Orgtree-Desktop-Token':'operator-test'}
        payload = {'org':'maintenance','node':'boss','tool':'orgtree_self_restart','args':{}}
        with patch.object(supervisor, '_detached_spawn', side_effect=AssertionError('V1 updater forbidden')):
            response = client.post('/api/agent', json=payload, headers=headers)
        self.assertEqual(response.status_code,200,response.text)
        pending = client.get('/api/desktop/status',headers=operator).json()['maintenance']
        self.assertEqual(pending['action'],'restart')
        self.assertEqual(client.post('/api/desktop/maintenance/ack',json={'id':pending['id']},headers=headers).status_code,401)
        self.assertFalse(client.post('/api/desktop/maintenance/ack',json={'id':'stale'},headers=operator).json()['accepted'])
        st = supervisor.state('maintenance','boss')
        st['busy'] = True
        self.assertFalse(client.post('/api/desktop/maintenance/ack',json={'id':pending['id']},headers=operator).json()['accepted'])
        self.assertTrue(supervisor._deploy_done.is_set())
        st['busy'] = False
        self.assertTrue(client.post('/api/desktop/maintenance/ack',json={'id':pending['id']},headers=operator).json()['accepted'])
        self.assertFalse(supervisor._deploy_done.is_set())
        self.assertFalse(client.post('/api/desktop/maintenance/ack',json={'id':pending['id']},headers=operator).json()['accepted'])
        supervisor._force_hold_settle(supervisor._force_hold['token'],release=True)
        kid = {'X-Orgtree-Agent-Token':agentauth.child_env('maintenance','kid')['ORGTREE_AGENT_TOKEN']}
        denied = client.post('/api/agent',json={**payload,'node':'kid'},headers=kid)
        self.assertEqual(denied.status_code,422,denied.text)
        self.assertIsNone(maintenance.pending())
        force = client.post('/api/agent',json={**payload,'args':{'force':True}},headers=headers)
        self.assertEqual(force.status_code,422)
        store._POOL.close_all('maintenance')

if __name__ == '__main__': unittest.main()
