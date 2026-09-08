"""Enabled production schedulers and persisted restart wake; provider boundary recorded."""
import json, os, sys, time, tempfile, subprocess, hashlib
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if len(sys.argv) == 1:
    root = Path(tempfile.mkdtemp(prefix='orgtree-v2-acceptance-automation-'))
    (root/'data').mkdir(); (root/'home').mkdir()
    env = {**os.environ, 'ORGTREE_DATA':str(root/'data'), 'HOME':str(root/'home'),
           'USERPROFILE':str(root/'home'), 'ORGTREE_WORKING_CACHE_POLL':'5'}
    sources=[REPO/'engine/backend/orgtree'/name for name in ['supervisor.py','ledger.py','restart_wake.py','appsettings.py','store.py']]
    before={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    receipts=[]
    for phase in ['seed','restart','again']:
        run=subprocess.run([sys.executable,__file__,phase,str(root)],env=env,cwd=REPO,
                           capture_output=True,text=True,timeout=55)
        (root/(phase+'.log')).write_text(run.stdout+run.stderr)
        assert run.returncode==0, (root,phase,run.stdout,run.stderr)
        receipts.append(json.loads((root/(phase+'.json')).read_text()))
    assert before=={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    report={'status':'PASS','root':str(root),'phases':receipts,'sourceHashes':before,'sourcesUnchanged':True,
            'limits':['Actual enabled engine scheduler threads and durable SQLite/registry; no Electron UI in this case',
                      'Old due timestamps are synthetic; scheduler intervals are real; provider admissions recorded, never executed']}
    (root/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));sys.exit()

phase, root=sys.argv[1],Path(sys.argv[2]).resolve()
assert Path(os.environ['ORGTREE_DATA']).resolve()==root/'data'
assert root.name.startswith('orgtree-v2-acceptance-automation-')
sys.path.insert(0,str(REPO/'engine/backend'))
from orgtree import store, supervisor, appsettings, restart_wake
from orgtree.ledger import USER
assert Path(store.DATA_ROOT).resolve()==root/'data'
records=[]
def record(slug,nid,text,**kw):
    assert slug=='automation-acceptance' and nid in ['watch','working','reminder','restart']
    row={'node':nid,'text':text,'kwargs':kw,'pid':os.getpid()}
    records.append(row)
    with (root/'admissions.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
    return {'accepted':True}
supervisor.send_message=record
def denied(*a,**kw):raise OSError('No provider or arbitrary process authorized')
subprocess.Popen=denied
try:subprocess.Popen([sys.executable,'--version'])
except OSError:pass
else:raise AssertionError('Inert process barrier')
slug='automation-acceptance'
if phase=='seed':
    org=store.create_org('Automation Acceptance')
    old='2020-01-01T00:00:00+00:00'
    for nid in ['watch','working','reminder','restart','idle-control']:
        org.hire(USER,None,'haiku',0,nid,charter='Synthetic automation acceptance; no execution')
        org.node(nid)['working_activity_at']=old
        org.node(nid)['last_status']={'status':'idle','at':old,'summary':'Synthetic aged idle state'}
    org.node('working')['last_status']={'status':'working','at':old,'summary':'Synthetic due work'}
    org.work_create(USER,'Outstanding task','Synthetic task is unfinished; verify reminder dispatch.',kind='non-code',owner='reminder')
    org.node('reminder')['docket_reminder_at']=old
    org.d.setdefault('mail', {})['reminder']=[] # Synthetic assignment was read before the aged idle interval.
    org.node('watch')['scope'].setdefault('add_dirs', []).append({'path':str(root),'mode':'ro'})
    assert org.work_idle_reminder_items('reminder')
    assert not org.waking_mail('reminder')
    watched=root/'edge.log';watched.write_text('not ready\n')
    dog=org.watchdog_create('watch','one-edge','file',str(watched),pattern='READY=yes',interval_s=15,once=True)
    store.save_org(org)
    appsettings.set_working_checkups_enabled(True)
    appsettings.set_idle_docket_reminders_enabled(True)
    # First boot is genuinely unarmed. Only the following process may wake restart.
    boot=restart_wake.on_backend_startup()
    assert not records
    supervisor.start_watchdog_engine();supervisor.start_working_cache_keeper()
    time.sleep(6)
    assert not any(r['node']=='watch' for r in records),'Nonmatching positive baseline fired'
    with watched.open('a') as f:f.write('READY=yes\n')
    deadline=time.time()+35
    while time.time()<deadline and set(r['node'] for r in records)!={'watch','working','reminder'}:time.sleep(.2)
    assert set(r['node'] for r in records)=={'watch','working','reminder'}, records
    assert all(sum(r['node']==n for r in records)==1 for n in ['watch','working','reminder'])
    current=store.load_org(slug)
    assert not current.d.get('watchdogs'),current.d.get('watchdogs')
    restart_wake.arm_restart_wake(slug,'restart',USER,reason='Synthetic next-process dispatch')
elif phase=='restart':
    boot=restart_wake.on_backend_startup()
    assert [r['node'] for r in records]==['restart'],records
    assert restart_wake.on_backend_startup().get('already_ran')
else:
    boot=restart_wake.on_backend_startup()
    assert not records,'One-shot restart wake dispatched twice'
current=store.load_org(slug)
assert not any(r['node']=='idle-control' for r in records)
assert any(m.get('restart_notice') for m in current.d.get('mail',{}).get('idle-control',[]))
(root/(phase+'.json')).write_text(json.dumps({'phase':phase,'pid':os.getpid(),'admissions':records,'boot':boot,'idlePassiveNotice':True},indent=2))
