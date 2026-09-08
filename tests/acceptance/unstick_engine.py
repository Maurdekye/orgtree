"""Frozen synthetic descendants; actual release routes, admission observed only."""
import json
import os
from pathlib import Path
ROOT = Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve()
assert Path(os.environ['ORGTREE_DATA']).resolve() == ROOT / 'data'
source = Path(__file__).with_name('maintenance_engine.py').read_text()
namespace = {'__name__': 'unstick_fixture', '__file__': str(Path(__file__).with_name('maintenance_engine.py'))}
exec(compile(source.rsplit('\nlaunch.main()', 1)[0], 'maintenance_engine.py', 'exec'), namespace)
launch = namespace['launch']
original = launch.load_app
def seeded():
    result = original()
    from orgtree import store, supervisor, agentauth
    org = store.load_org('acceptance-runtime')
    for nid in ['builder', 'reviewer']:
        org.node(nid)['frozen'] = {'until': 'Synthetic lock', 'resume_texts': ['Retained work for '+nid], 'resume_views': ['Original view for '+nid]}
        org.node(nid)['limit_locked'] = True
    org.d['fable_lock'] = {'no_reset': True, 'until': 'Synthetic acceptance lock'}
    store.save_org(org)
    (ROOT / 'private-unstick-tokens.json').write_text(json.dumps({nid: agentauth.child_env('acceptance-runtime', nid)['ORGTREE_AGENT_TOKEN'] for nid in ['planner','builder','reviewer']}))
    def observe(slug,nid,text,**kwargs):
        assert slug == 'acceptance-runtime' and nid in ['builder','reviewer']
        with (ROOT / 'unstick-admissions.jsonl').open('a') as output:
            output.write(json.dumps({'node':nid,'text':text,'view':kwargs.get('view'),'sender':kwargs.get('sender')})+'\n')
        return {'accepted': True, 'acceptance_fixture': True}
    supervisor.send_message = observe
    return result
launch.load_app = seeded
launch.main()
