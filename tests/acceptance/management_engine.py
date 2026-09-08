"""Actual provider discovery and ledger; no provider turn may start."""
import os
from pathlib import Path
ROOT = Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve()
assert Path(os.environ['ORGTREE_DATA']).resolve() == ROOT / 'data'
source = Path(__file__).with_name('visual_engine.py').read_text()
source = '\n'.join(line for line in source.splitlines() if 'providers.antigravity_status =' not in line and 'providers.codex_status =' not in line)
source = source.rsplit('\nlaunch.main()',1)[0]
# Allow actual read-only CLI detection, retaining the arbitrary turn barrier.
source = source.replace("if isinstance(command, list) and command == ['whoami']:", "if isinstance(command, list) and (command == ['whoami'] or (len(command) <= 4 and command[0] != sys.executable and command[-1:] == ['--version']) or 'app-server' in command or (len(command) >= 4 and command[-1:] == ['models'] and '--log-file' in command)):")
namespace = {'__name__':'management_fixture','__file__':str(Path(__file__).with_name('visual_engine.py'))}
exec(compile(source,'visual_engine.py','exec'),namespace)
launch=namespace['launch'];original=launch.load_app
def observed():
    result=original()
    from orgtree import supervisor, codexrun
    request=codexrun.AppServerClient.request
    def readonly(self,method,*args,**kwargs):
        assert method in ['initialize','model/list','account/read','account/rateLimits/read'], 'No turn or configuration request is authorized'
        with (ROOT / 'discovery-methods.jsonl').open('a') as output:
            import json
            output.write(json.dumps({'method':method})+'\n')
        return request(self,method,*args,**kwargs)
    codexrun.AppServerClient.request=readonly
    def forbidden(*args,**kwargs):
        raise AssertionError('Management acceptance must never start a provider turn')
    supervisor.send_message=forbidden
    supervisor.start_watchdog_engine=lambda:None
    return result
launch.load_app=observed
launch.main()
