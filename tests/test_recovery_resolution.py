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
    for slug in ('locked','unknown','resume-route','native-ready'): store._POOL.close_all(slug)
    root.cleanup()

class ResolutionTests(unittest.TestCase):

    def test_resume_route_preserves_native_hold_with_ordinary_positive_control(self):
        org=store.create_org('resume-route')
        for nid in ('imported','ordinary'):
            org.hire(ledger.USER,None,'haiku',0,nid)
            org.node(nid)['frozen']={'limit':True,'at':'2026-09-07T20:00:00Z','resume_texts':['retained turn']}
        org.node('imported')['desktop_import']={'continuity':'fresh_session_with_history'}
        store.save_org(org)
        started=[]
        original_start=supervisor.threading.Thread.start
        def start(thread):
            if thread._target is supervisor._run_turn: started.append(thread._args[1])
            else: return original_start(thread)
        with patch.object(supervisor.threading.Thread,'start',start):
            response=TestClient(app).post('/api/orgs/resume-route/resume',headers={'X-Orgtree-Desktop-Token':'operator'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['resumed'],['ordinary'])
        self.assertEqual(started,['ordinary'])
        saved=store.load_org('resume-route')
        self.assertIn('frozen',saved.node('imported'))
        self.assertNotIn('frozen',saved.node('ordinary'))
        # Positive seam control: the native validator approves the imported
        # clone. Validator path/auth semantics are tested by its owning module.
        with patch.object(supervisor,'_native_context_hold',return_value=None), \
             patch.object(supervisor.threading.Thread,'start',start):
            allowed=TestClient(app).post('/api/orgs/resume-route/resume',headers={'X-Orgtree-Desktop-Token':'operator'})
        self.assertEqual(allowed.json()['resumed'],['imported'])
        self.assertEqual(started,['ordinary','imported'])
        # Queued/admitted work is checked again immediately before execution.
        with patch.object(supervisor,'_cancel_working_cache'), \
             patch.object(supervisor,'_note_working_activity'), \
             patch.object(supervisor,'_hold_for_deploy'), \
             patch.object(supervisor,'_run_one_turn',side_effect=AssertionError('provider must not run')):
            supervisor._run_turn('resume-route','imported',{'text':'queued retained work'})
        saved=store.load_org('resume-route')
        self.assertEqual(saved.node('imported')['inflight']['text'],'queued retained work')
        self.assertFalse(supervisor.state('resume-route','imported')['busy'])
        st=supervisor.state('resume-route','imported')
        st['queue']=[{'text':'third carrier'}]
        with patch.object(supervisor,'_cancel_working_cache'), \
             patch.object(supervisor,'_note_working_activity'), \
             patch.object(supervisor,'_hold_for_deploy'), \
             patch.object(supervisor,'_run_one_turn',side_effect=AssertionError('provider must not run')):
            supervisor._run_turn('resume-route','imported',{'text':'second carrier','view':'second view'})
        self.assertEqual([c['text'] for c in st['queue']],['second carrier','third carrier'])
        self.assertEqual(st['queue'][0]['view'],'second view')
        self.assertEqual(store.load_org('resume-route').node('imported')['inflight']['text'],'queued retained work')
        retained=store.load_org('resume-route').node('imported')['native_held_carriers']
        self.assertEqual([(c['text'],c['view']) for c in retained],[('second carrier','second view')])
        # A replacement process has no queue: the next explicitly admitted
        # original turn restores the retained carrier exactly once.
        st['queue']=[]
        with patch.object(supervisor,'_cancel_working_cache'), \
             patch.object(supervisor,'_note_working_activity'), \
             patch.object(supervisor,'_hold_for_deploy'), \
             patch.object(supervisor,'_native_context_hold',return_value=None), \
             patch.object(supervisor,'_run_one_turn',side_effect=RuntimeError('stop before provider')):
            with self.assertRaises(RuntimeError):
                supervisor._run_turn('resume-route','imported',{'text':'original resumed'})
        self.assertEqual([c['text'] for c in st['queue']],['second carrier'])

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
