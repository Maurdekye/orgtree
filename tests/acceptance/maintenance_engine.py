"""Actual managed launcher with an idle synthetic actor and observation only."""
import json
import os
from pathlib import Path
import runpy

ROOT = Path(os.environ['ORGTREE_ACCEPTANCE_APP']).resolve()
DATA = Path(os.environ['ORGTREE_DATA']).resolve()
assert DATA == Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve() / 'data'
assert DATA.parent.name.startswith('orgtree-v2-acceptance-')
# Reuse the visual fixture's real launcher, isolated ledger and process barrier.
source = (Path(__file__).parent / 'visual_engine.py').read_text()
namespace = {'__name__': 'maintenance_fixture', '__file__': str(Path(__file__).parent / 'visual_engine.py')}
exec(compile(source.replace('launch.main()', ''), 'visual_engine.py', 'exec'), namespace)
launch = namespace['launch']
seeded = launch.load_app

def observed():
    result = seeded()
    from orgtree import store, agentauth, desktop_maintenance, supervisor
    if not any(row['slug']=='acceptance-runtime' for row in store.list_orgs()):
        store.create_org('Acceptance Runtime')
    token = agentauth.child_env('acceptance-runtime', 'planner')['ORGTREE_AGENT_TOKEN']
    assert agentauth.verify(token) == ('acceptance-runtime', 'planner', 0)
    (DATA.parent / 'private-agent-token').write_text(token)
    acknowledge = desktop_maintenance.acknowledge
    def observe_ack(request_id, outcome='execute'):
        value = acknowledge(request_id, outcome)
        with (DATA.parent / 'ack-observations.jsonl').open('a') as output:
            output.write(json.dumps({'id': request_id, 'outcome': outcome, 'accepted': value['accepted'],
                                     'admissionOpen': supervisor._deploy_done.is_set(), 'pid': os.getpid()}) + '\n')
        return value
    desktop_maintenance.acknowledge = observe_ack
    if hasattr(desktop_maintenance,'execution_failed'):
        failed = desktop_maintenance.execution_failed
        def observe_failure(request_id):
            value = failed(request_id)
            with (DATA.parent / 'failure-observations.jsonl').open('a') as output:
                output.write(json.dumps({'id':request_id,**value,'admissionOpen':supervisor._deploy_done.is_set()}) + '\n')
            return value
        desktop_maintenance.execution_failed = observe_failure
    return result

launch.load_app = observed
launch.main()
