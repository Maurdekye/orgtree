"""Actual engine with synthetic persisted chat, never a provider turn."""
import os
from pathlib import Path

ROOT = Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve()
assert Path(os.environ['ORGTREE_DATA']).resolve() == ROOT / 'data'
source = Path(__file__).with_name('maintenance_engine.py').read_text()
namespace = {'__name__': 'lifecycle_fixture', '__file__': str(Path(__file__).with_name('maintenance_engine.py'))}
exec(compile(source.rsplit('\nlaunch.main()', 1)[0], 'maintenance_engine.py', 'exec'), namespace)
launch = namespace['launch']
original = launch.load_app
def seeded():
    result = original()
    from orgtree import store, supervisor
    marker = ROOT / 'lifecycle-seeded'
    if not marker.exists():
        org = store.load_org('acceptance-runtime')
        supervisor._codex_journal('acceptance-runtime', org.node('planner')['session_id'], [{
            'type': 'assistant', 'uuid': 'lifecycle-source-001', 'timestamp': '2026-09-07T20:00:00Z',
            'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Persistent synthetic source for a reply after restart.'}]}}])
        marker.write_text('synthetic journal seeded once')
    return result
launch.load_app = seeded
launch.main()
