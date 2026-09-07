"""Observe one real Claude subscription turn; preserve launcher and auth gates."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ['ORGTREE_DATA']).resolve()
assert DATA.name == 'data' and DATA.parent.name.startswith('orgtree-v2-provider-')
sys.path.insert(0, str(ROOT))
from engine import launch

original = launch.load_app


def load_observed():
    result = original()
    app, _token, data, port, stopping = result
    from orgtree import agentauth, store, supervisor, warmpool
    assert Path(store.DATA_ROOT).resolve() == DATA and port != 7360
    # This authorization covers one turn, never background provider warming.
    warmpool.start_warm_pool = lambda: None
    original_cmd = supervisor._build_cmd
    def observed_cmd(org, nid, **kwargs):
        cmd = original_cmd(org, nid, **kwargs)
        assert org.d['slug'] == 'v2-claude-acceptance' and nid == 'probe'
        config = json.loads(cmd[cmd.index('--mcp-config') + 1])['mcpServers']['orgtree']
        assert config['command'] == sys.executable
        assert config['env']['ORGTREE_PORT'] == str(port)
        assert agentauth.verify(config['env']['ORGTREE_AGENT_TOKEN']) == (org.d['slug'], nid, 0)
        (DATA.parent / 'mcp-target.json').write_text(json.dumps({'port':port,'dataRoot':str(DATA),'org':org.d['slug'],'node':nid,'generation':0,'scopedCredentialVerified':True,'bundledPythonMcp':True}),encoding='utf-8')
        return cmd
    supervisor._build_cmd = observed_cmd
    original_popen = subprocess.Popen
    def observed_popen(command, *args, **kwargs):
        env = kwargs.get('env') or {}
        if env.get('ORGTREE_AGENT_TOKEN'):
            assert agentauth.verify(env['ORGTREE_AGENT_TOKEN']) == ('v2-claude-acceptance','probe',0)
            assert env.get('ORGTREE_PORT') == str(port)
            assert not env.get('ANTHROPIC_API_KEY') and not env.get('CLAUDE_CODE_OAUTH_TOKEN')
            assert DATA in Path(kwargs['cwd']).resolve().parents
            (DATA.parent/'provider-spawn.json').write_text(json.dumps({'scopedCredentialVerified':True,'port':port,'cwdInsideTestRoot':True,'injectedApiKey':False,'injectedAccountToken':False}),encoding='utf-8')
        return original_popen(command, *args, **kwargs)
    subprocess.Popen = observed_popen
    async def observed_app(scope, receive, send):
        if scope.get('type') != 'http' or scope.get('path') != '/api/agent':
            return await app(scope, receive, send)
        chunks=[]
        while True:
            message=await receive();chunks.append(message)
            if not message.get('more_body'):break
        body=json.loads(b''.join(m.get('body',b'') for m in chunks))
        assert body.get('org') == 'v2-claude-acceptance' and body.get('node') == 'probe'
        if body.get('tool') != 'orgtree_chart':
            await send({'type':'http.response.start','status':403,'headers':[(b'content-type',b'application/json')]})
            await send({'type':'http.response.body','body':b'{"error":"Acceptance permits only one read-only chart"}'})
            return
        index=0
        async def replay():
            nonlocal index
            if index < len(chunks):
                message=chunks[index];index+=1;return message
            return await receive()
        async def observe_send(message):
            if message['type']=='http.response.start':
                with (DATA.parent/'tool-observations.jsonl').open('a',encoding='utf-8') as output:
                    output.write(json.dumps({'tool':'orgtree_chart','org':body['org'],'node':body['node'],'port':port,'httpStatus':message['status']})+'\n')
            await send(message)
        await app(scope,replay,observe_send)
    return observed_app,_token,data,port,stopping


launch.load_app=load_observed
launch.main()
