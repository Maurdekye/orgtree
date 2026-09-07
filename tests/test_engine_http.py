"""Real launcher/HTTP boundary with fixture data, no provider turns."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
CHILD = r'''
import json, launch
original = launch.load_app
def seeded():
    result = original()
    from orgtree import store, agentauth, supervisor, providers, warmpool, antigravity_limits
    # External CLI discovery/turn processes are outside this HTTP-auth test.
    # Keep the real startup, routes, persistence and MCP transport untouched.
    providers.antigravity_status = lambda **kw: {'available':False, 'installed':False}
    providers.codex_status = lambda **kw: {'available':False, 'installed':False}
    antigravity_limits.note_boot = lambda: None
    supervisor.start_usage_warm_loop = lambda: None
    supervisor.start_cred_watcher = lambda: None
    warmpool.start_warm_pool = lambda: None
    from orgtree.ledger import USER
    org = store.create_org("auth-fixture")
    org.hire(USER, None, "haiku", 0, "caller")
    org.hire(USER, None, "haiku", 0, "old")
    store.save_org(org)
    stale = agentauth.child_env('auth-fixture', 'old')['ORGTREE_AGENT_TOKEN']
    org.node('old')['generation'] = 1
    store.save_org(org)
    from pathlib import Path
    import uuid
    from orgtree import desktop_native
    duplicate_sid = str(uuid.uuid4())
    good_sid = str(uuid.uuid4())
    for slug, sid in [('duplicate-one',duplicate_sid),('duplicate-two',duplicate_sid),('unrelated-native',good_sid)]:
        fixture = store.create_org(slug)
        fixture.hire(USER,None,'haiku',0,'worker')
        node = fixture.node('worker'); node['session_id'] = sid
        node.pop('session_unrun',None); node['cost_usd']=1
        if slug.startswith('duplicate'):
            node['inflight']={'text':'retained ambiguous intent','view':'retained view'}
        relative = f'imports/{slug}/native/worker/{sid}.jsonl'
        path = Path(store.DATA_ROOT)/relative; path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'type':'user','uuid':str(uuid.uuid4()),'parentUuid':None,
            'sessionId':sid,'timestamp':'2026-09-07T20:00:00Z',
            'message':{'role':'user','content':'unrelated native context'}})+'\n')
        node['desktop_import']={'native_continuity':{'status':'ready','provider':'claude',
            'session_id':sid,'path':relative,'storage_node':'worker'}}
        store.save_org(fixture)
    # Explicit foreign-provider fallback control: it must never be selected.
    foreign = Path.home()/'.claude'/'projects'/'foreign'/f'{duplicate_sid}.jsonl'
    foreign.parent.mkdir(parents=True); foreign.write_text('{}\n')
    assert supervisor.transcript_path(duplicate_sid) is None
    assert supervisor._native_context_hold(store.load_org('duplicate-one'),'worker')
    good = store.load_org('unrelated-native')
    assert supervisor._native_context_hold(good,'worker') is None
    assert supervisor.transcript_path(good_sid)
    assert good_sid in supervisor._transcript_evidence(good)
    assert duplicate_sid not in supervisor._transcript_evidence(good)
    missing=store.create_org('ordinary-missing')
    missing.hire(USER,None,'haiku',0,'worker')
    missing.node('worker').pop('session_unrun',None)
    missing.node('worker')['cost_usd']=1
    store.save_org(missing)
    from orgtree import api
    @api.app.on_event('startup')
    def verify_native_startup_state():
        for slug in ('duplicate-one','duplicate-two'):
            node=store.load_org(slug).node('worker')
            assert node['state']=='live' and node['session_id']==duplicate_sid
            assert node['inflight']['text']=='retained ambiguous intent'
        assert store.load_org('unrelated-native').node('worker')['state']=='live'
        assert store.load_org('ordinary-missing').node('worker')['state']=='unrecoverable'
    token = agentauth.child_env("auth-fixture", "caller")["ORGTREE_AGENT_TOKEN"]
    print(json.dumps({"fixtureToken":token, "staleToken":stale}), flush=True)
    import os
    os.environ['ORGTREE_V2_HUB_TOKEN'] = 'owner-control'
    safe = supervisor.clean_env()
    assert 'ORGTREE_V2_HUB_TOKEN' not in safe
    assert 'ORGTREE_V2_TOKEN' not in safe
    assert safe['ORGTREE_PORT'] == str(result[3])
    return result
launch.load_app = seeded
launch.main()
'''

class EngineHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="v2-http-")
        root = Path(cls.tmp.name)
        data = root / 'data'; data.mkdir()
        home = root / 'home'; home.mkdir()
        ui = root / 'ui'; ui.mkdir(); (ui / 'assets').mkdir()
        (ui / 'index.html').write_text('<!doctype html><title>UI positive control</title>', encoding='utf-8')
        env = dict(os.environ)
        for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_PORT', 'ORGTREE_BASE', 'ORGTREE_V2_PORT'):
            env.pop(key, None)
        env.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                   ORGTREE_V2_TOKEN='test-operator-secret', ORGTREE_V2_UI_DIR=str(ui))
        cls.log = (root / 'stderr.log').open('w+')
        cls.process = subprocess.Popen([sys.executable, '-c', CHILD], cwd=ROOT / 'engine',
             env=env, stdout=subprocess.PIPE, stderr=cls.log, text=True)
        lines = queue.Queue()
        def reader():
            for line in cls.process.stdout:
                lines.put(line)
            lines.put(None)
        threading.Thread(target=reader, daemon=True).start()
        cls.token = None
        try:
            while True:
                line = lines.get(timeout=60)
                if line is None:
                    cls.log.seek(0)
                    raise AssertionError('launcher exited: ' + cls.log.read())
                try: row = json.loads(line)
                except ValueError: continue
                if 'fixtureToken' in row:
                    cls.token = row['fixtureToken']
                    cls.stale = row['staleToken']
                if row.get('type') == 'ready':
                    cls.port = row['port']
                    assert cls.port != 7360
                    assert row['dataRootId'] == str(data.resolve())
                    break
        except BaseException:
            cls.process.terminate(); cls.process.wait(timeout=15)
            raise

    @classmethod
    def tearDownClass(cls):
        try: cls.request('/api/desktop/shutdown', {}, operator=True)
        finally:
            try: cls.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                cls.process.terminate(); cls.process.wait(timeout=15)
            cls.log.close()
            cls.tmp.cleanup()

    @classmethod
    def request(cls, path, payload=None, operator=False, token=None):
        headers = {'Content-Type':'application/json'}
        if operator: headers['X-Orgtree-Desktop-Token'] = 'test-operator-secret'
        if token: headers['X-Orgtree-Agent-Token'] = token
        req = urllib.request.Request(f'http://127.0.0.1:{cls.port}{path}',
            data=None if payload is None else json.dumps(payload).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                if 'application/json' not in r.headers.get('Content-Type',''):
                    raise AssertionError(f'{path} returned non-JSON content type: {r.headers.get("Content-Type")}')
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_scoped_agent_and_operator_controls(self):
        call = {'org':'auth-fixture','node':'caller','tool':'orgtree_chart','args':{}}
        status, body = self.request('/api/agent', call, token=self.token)
        self.assertEqual(status, 200, body)
        self.assertIn('chart', body)
        self.assertEqual(self.request('/api/agent', call)[0], 401)
        self.assertEqual(self.request('/api/agent', call, token=self.token+'x')[0], 401)
        self.assertEqual(self.request('/api/agent', {**call,'node':'forged'}, token=self.token)[0], 403)
        self.assertEqual(self.request('/api/agent', {**call,'org':'foreign'}, token=self.token)[0], 403)
        self.assertEqual(self.request('/api/agent', {**call,'node':'old'}, token=self.stale)[0], 403)
        self.assertEqual(self.request('/api/desktop/status', token=self.token)[0], 401)
        status, body = self.request('/api/desktop/status', operator=True)
        self.assertEqual(status, 200)
        self.assertEqual(body['activeAgents'], 0)
        self.assertTrue(body['idle'])

    def test_duplicate_native_ids_do_not_prevent_real_startup(self):
        status, body = self.request('/api/orgs',operator=True)
        self.assertEqual(status,200)
        self.assertIn('unrelated-native',json.dumps(body))
        status, body = self.request('/api/orgs/unrelated-native/nodes/worker/chat',operator=True)
        self.assertEqual(status,200,body)
        self.assertIn('unrelated native context',json.dumps(body))

    def test_real_mcptool_post_uses_scoped_token_and_engine_port(self):
        env = dict(os.environ)
        env.update(ORGTREE_PORT=str(self.port), ORGTREE_AGENT_TOKEN=self.token,
                   ORGTREE_DATA=str(Path(self.tmp.name) / 'data'),
                   HOME=str(Path(self.tmp.name) / 'home'),
                   USERPROFILE=str(Path(self.tmp.name) / 'home'),
                   PYTHONPATH=str(ROOT / 'engine' / 'backend'))
        env.pop('ORGTREE_BASE', None)
        env.pop('ORGTREE_V2_TOKEN', None)
        code = "from orgtree.mcptool import _post; import json; print(json.dumps(_post({'org':'auth-fixture','node':'caller','tool':'orgtree_chart','args':{}})))"
        result = subprocess.run([sys.executable, '-c', code], env=env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        kind, body = json.loads(result.stdout)
        self.assertEqual(kind, 'ok', body)
        self.assertIn('chart', json.loads(body))

    def test_packaged_ui_does_not_shadow_desktop_routes(self):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}/',
            headers={'X-Orgtree-Desktop-Token':'test-operator-secret'})
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertIn(b'UI positive control', response.read())
        for path, field in (('/api/desktop/status','activeAgents'),
                            ('/api/desktop/hub','enabled'),('/api/desktop/notifications','notices')):
            status, body = self.request(path, operator=True)
            self.assertEqual(status,200,(path,body))
            self.assertIsInstance(body,dict)
            self.assertIn(field,body)
        status, body = self.request('/api/desktop/import-v1/preview', {}, operator=True)
        self.assertEqual(status,422,body)

if __name__ == '__main__':
    unittest.main()
