import os
from pathlib import Path
import tempfile
import subprocess
import sys
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
    def test_real_process_boot_allows_next_deliberate_cycle(self):
        with tempfile.TemporaryDirectory(prefix='v2-maint-boots-') as folder:
            data=Path(folder)/'data'; data.mkdir()
            home=Path(folder)/'home'; home.mkdir()
            env=dict(os.environ,ORGTREE_DATA=str(data),HOME=str(home),USERPROFILE=str(home),ORGTREE_V2_TOKEN='boot-test')
            code='''
import launch
launch.load_app()
from orgtree import desktop_maintenance as m
old=m.status()
if old:
    assert old['state']=='unknown', old
    assert m.pending() is None
new=m.request('fixture','node')['maintenance']
assert not old or new['id'] != old['id']
assert m.acknowledge(new['id'])['accepted']
assert m.status()['state']=='acknowledged'
'''
            for _ in range(3):
                result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1]/'engine',
                                      env=env,capture_output=True,text=True,timeout=20)
                self.assertEqual(result.returncode,0,result.stderr)

    def test_two_cycles_and_unknown_outcome_across_boot(self):
        for cycle in range(2):
            record=maintenance.request('cycle','node')['maintenance']
            self.assertTrue(maintenance.acknowledge(record['id'])['accepted'])
            maintenance.install()
            self.assertEqual(maintenance.status()['state'],'acknowledged')
            self.assertTrue(maintenance.request('cycle','node')['already_armed'])
            # The previous process's admission event dies with that process.
            supervisor._force_hold_settle(maintenance._accepted_hold,release=True)
            with patch.object(maintenance,'_boot_id',f'new-boot-{cycle}'):
                maintenance.install()
                self.assertIsNone(maintenance.pending())
                self.assertEqual(maintenance.status()['state'],'unknown')
                self.assertEqual(maintenance.status()['id'],record['id'])
                maintenance.install()
                self.assertEqual(maintenance.status()['state'],'unknown')

    def test_pending_and_old_boot_failure_never_release_other_hold(self):
        for phase in ('pending','unknown'):
            record=maintenance.request('late','node')['maintenance']
            if phase=='unknown':
                maintenance._write({**record,'state':'unknown'})
            unrelated=supervisor._force_hold_take()
            self.assertIsNotNone(unrelated)
            self.assertFalse(maintenance.execution_failed('wrong')['released'])
            self.assertTrue(maintenance.execution_failed(record['id'])['released'])
            self.assertEqual(maintenance.status()['state'],'failed')
            self.assertFalse(supervisor._deploy_done.is_set())
            supervisor._force_hold_settle(unrelated,release=True)

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
        duplicate=client.post('/api/agent',json=payload,headers=headers)
        self.assertEqual(duplicate.status_code,200,duplicate.text)
        self.assertEqual(maintenance.status()['id'],pending['id'])
        self.assertEqual(maintenance.status()['state'],'acknowledged')
        self.assertFalse(client.post('/api/desktop/maintenance/failure',json={'id':'stale'},headers=operator).json()['released'])
        self.assertFalse(client.post('/api/desktop/maintenance/ack',json={'id':pending['id']},headers=operator).json()['accepted'])
        self.assertTrue(client.post('/api/desktop/maintenance/failure',json={'id':pending['id']},headers=operator).json()['released'])
        self.assertTrue(supervisor._deploy_done.is_set())
        self.assertEqual(maintenance.status()['state'],'failed')
        self.assertIsNone(maintenance.pending())
        self.assertTrue(client.post('/api/desktop/maintenance/failure',json={'id':pending['id']},headers=operator).json()['released'])
        maintenance.cancel('maintenance','boss')
        kid = {'X-Orgtree-Agent-Token':agentauth.child_env('maintenance','kid')['ORGTREE_AGENT_TOKEN']}
        denied = client.post('/api/agent',json={**payload,'node':'kid'},headers=kid)
        self.assertEqual(denied.status_code,422,denied.text)
        self.assertIsNone(maintenance.pending())
        force = client.post('/api/agent',json={**payload,'args':{'force':True}},headers=headers)
        self.assertEqual(force.status_code,422)
        update = maintenance.request('maintenance','boss',action='update')['maintenance']
        hold = supervisor._force_hold_take()
        self.assertTrue(client.post('/api/desktop/maintenance/failure',json={'id':pending['id']},headers=operator).json()['released'] is False)
        self.assertFalse(supervisor._deploy_done.is_set())
        supervisor._force_hold_settle(hold,release=True)
        self.assertTrue(client.post('/api/desktop/maintenance/ack',json={'id':update['id'],'outcome':'up-to-date'},headers=operator).json()['accepted'])
        self.assertTrue(supervisor._deploy_done.is_set())
        store._POOL.close_all('maintenance')

if __name__ == '__main__': unittest.main()
