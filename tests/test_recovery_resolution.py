import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

root=tempfile.TemporaryDirectory(prefix='recovery-resolution-')
data=Path(root.name)/'data'; data.mkdir()
home=Path(root.name)/'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data),HOME=str(home),USERPROFILE=str(home),ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'): os.environ.pop(key,None)
from engine.launch import load_app
app,*_=load_app()
from orgtree import store,ledger,supervisor,desktop_recovery as recovery

def tearDownModule():
    for slug in ('locked','unknown'): store._POOL.close_all(slug)
    root.cleanup()

class ResolutionTests(unittest.TestCase):
    def seed(self,slug):
        org=store.create_org(slug)
        org.hire(ledger.USER,None,'haiku',0,'active')
        org.node('active')['inflight']={'text':'original intent','view':'original view'}
        org.d['desktop_import']={'active_nodes':['active'],'recovery_pending':True}
        store.save_org(org)
        return org

    def choice(self,slug):
        row=recovery.status(slug)['nodes'][0]
        return {'node':row['node'],'attempt':row['attempt'],'expected_phase':row['phase']}

    def test_real_lock_held_and_guarded_operator_retry(self):
        org=self.seed('locked'); org.node('active')['limit_locked']=True
        org.d['fable_lock']={'no_reset':True}; store.save_org(org)
        with patch.object(supervisor.threading.Thread,'start',side_effect=AssertionError('provider thread forbidden')):
            with self.assertRaises(RuntimeError): recovery.resume_import('locked')
        self.assertEqual(recovery.status('locked')['nodes'][0]['phase'],'held')
        org=store.load_org('locked')
        org.node('active')['desktop_import']={'continuity':'fresh_session_with_history'}
        store.save_org(org)
        with patch.object(supervisor.threading.Thread,'start',side_effect=AssertionError('provider forbidden')):
            refused=supervisor.send_message('locked','active','do not start')
        self.assertFalse(refused['accepted'])
        self.assertTrue(refused['native_context_held'])
        with patch.object(supervisor,'send_message') as drive:
            supervisor.reconcile('locked',active_only=True)
            drive.assert_not_called()
        choice=self.choice('locked')
        client=TestClient(app); path='/api/desktop/import-v1/locked/resolve'
        payload={'nodes':[choice],'action':'retry','acknowledge_duplicate_work':True}
        self.assertEqual(client.post(path,json=payload).status_code,401)
        with patch.object(supervisor,'send_message',return_value={'accepted':True,'queued':0}) as drive:
            headers={'X-Orgtree-Desktop-Token':'operator'}
            stale=client.post(path,json={**payload,'nodes':[{**choice,'attempt':'stale'}]},headers=headers)
            self.assertIn('error',stale.json()['results'][0]); drive.assert_not_called()
            first=client.post(path,json=payload,headers=headers)
            self.assertEqual(first.status_code,200,first.text)
            self.assertEqual(first.json()['results'][0]['phase'],'admitted')
            second=client.post(path,json=payload,headers=headers)
            self.assertEqual(second.json(),first.json())
            self.assertEqual(drive.call_count,1)

    def test_uncertain_never_retried_by_startup_and_explicit_settlement(self):
        self.seed('unknown')
        with patch.object(supervisor,'send_message',side_effect=RuntimeError('outcome lost')) as drive:
            with self.assertRaises(RuntimeError): recovery.resume_import('unknown')
            supervisor.reconcile('unknown',active_only=True)
            self.assertEqual(drive.call_count,1)
        choice=self.choice('unknown')
        with patch.object(supervisor,'send_message') as drive:
            denied=recovery.resolve_import('unknown',[choice],'retry',True)
            self.assertIn('error',denied['results'][0]); drive.assert_not_called()
            org=store.load_org('unknown'); org.node('active')['generation']=1; store.save_org(org)
            denied=recovery.resolve_import('unknown',[choice],'continue',True,'reviewed')
            self.assertIn('error',denied['results'][0]); drive.assert_not_called()
            org.node('active')['generation']=0; store.save_org(org)
            handled=recovery.resolve_import('unknown',[choice],'mark-handled',True,'resolved externally')
            self.assertFalse(handled['pending']); drive.assert_not_called()
            self.assertEqual(handled['results'][0]['phase'],'handled')

if __name__=='__main__': unittest.main()
