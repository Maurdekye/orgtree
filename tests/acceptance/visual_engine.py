"""Real launcher/HTTP/renderer with synthetic ledger content; providers disabled.

This mode proves rendering and interaction only, never provider execution.
"""
import os
from pathlib import Path
import sys
import subprocess

DATA = Path(os.environ['ORGTREE_DATA']).resolve()
ROOT = Path(os.environ['ORGTREE_ACCEPTANCE_APP']).resolve()
assert DATA.name == 'data' and DATA.parent.name.startswith('orgtree-v2-acceptance-')
assert DATA == Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve() / 'data'
assert os.environ['ORGTREE_ACCEPTANCE_VISUAL_FIXTURE'] == '1'
sys.path.insert(0, str(ROOT))
if os.environ.get('ORGTREE_ACCEPTANCE_IMPORT_FIXTURE') == '1':
    import json
    manifest = json.loads((DATA.parent / 'import-manifest.json').read_text())
    os.environ['HOME'] = os.environ['USERPROFILE'] = manifest['home']
from engine import launch

original = launch.load_app


def seeded():
    result = original()
    from orgtree import store, supervisor, providers, warmpool, antigravity_limits
    from orgtree.ledger import USER
    assert Path(store.DATA_ROOT).resolve() == DATA and result[3] != 7360
    providers.antigravity_status = lambda **kw: {'available': False, 'installed': False}
    providers.codex_status = lambda **kw: {'available': False, 'installed': False}
    antigravity_limits.note_boot = lambda: None
    supervisor.start_usage_warm_loop = lambda: None
    supervisor.start_cred_watcher = lambda: None
    warmpool.start_warm_pool = lambda: None
    if os.environ.get('ORGTREE_ACCEPTANCE_IMPORT_FIXTURE') == '1':
        def record_admission(slug, nid, text, **kwargs):
            assert slug == 'import-demo' and nid == 'active', 'Only imported active work may be admitted'
            with (DATA.parent / 'import-admissions.jsonl').open('a') as output:
                output.write(json.dumps({'org':slug,'node':nid,'text':text,'view':kwargs.get('view')}) + '\n')
            return {'accepted': True}
        supervisor.send_message = record_admission
        supervisor.start_watchdog_engine = lambda: None
    original_popen = subprocess.Popen
    def refuse_process(command, *args, **kwargs):
        # Real hub startup restricts only its readiness file's Windows ACL.
        # Keep that boundary live; no harness or arbitrary command may execute.
        if isinstance(command, list) and command == ['whoami']:
            return original_popen(command, *args, **kwargs)
        if isinstance(command, list) and len(command) == 5 and command[0] == 'icacls' and command[2:4] == ['/inheritance:r', '/grant:r'] and DATA in Path(command[1]).resolve().parents:
            return original_popen(command, *args, **kwargs)
        raise OSError('Visual acceptance forbids provider and arbitrary child processes')
    subprocess.Popen = refuse_process
    # Positive control: the execution barrier must reject a real spawn attempt.
    try:
        subprocess.Popen([sys.executable, '--version'])
    except OSError:
        (DATA.parent / 'visual-process-barrier.json').write_text('{"positiveControl":"denied","providerProcessesAllowed":false,"allowedUtilities":["whoami","icacls on isolated root"]}')
    else:
        raise AssertionError('Visual execution barrier is inert')
    create = store.create_org
    def create_populated(name, *args, **kwargs):
        org = create(name, *args, **kwargs)
        if name == 'Acceptance Runtime':
            org.hire(USER, None, 'haiku', 10, 'planner', charter='Synthetic planning agent for visual acceptance.')
            org.hire(USER, 'planner', 'haiku', 0, 'builder', charter='Synthetic implementation agent. No provider execution.')
            org.hire(USER, 'planner', 'haiku', 0, 'reviewer', charter='Synthetic reviewer for acceptance screenshots.')
            org.present_document('planner', 'Acceptance launch notes', '# Launch notes\n\nThis document belongs to an isolated synthetic organization.\n\n- Three idle agents appear in the graph.\n- Settings and document windows can move between surfaces.\n\n| Check | State |\n| --- | --- |\n| Runtime | Ready |\n| Provider turns | Disabled |')
            store.save_org(org)
        return org
    store.create_org = create_populated
    return result


launch.load_app = seeded
launch.main()
