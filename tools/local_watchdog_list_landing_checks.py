"""Landing checks for orgtree-watchdog-list-pays-the-managed-wait-jour: every
module that reads the contract registry or its boundary fixtures, plus the
modules the change touches, one module per call, at the tip or at <base>
(the changed code AND docs/state-system restored with `git checkout`, so the
CRLF bytes the span hashes read are the base's own).
Usage: local_watchdog_list_landing_checks.py <base sha> <tag> tip|base [first module index]"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / 'tools'))
os.environ['ORGTREE_DATA'] = 'C:/Temp/watchdog-list-landing-guard'
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(repo)
BASE, PHASE = sys.argv[1], sys.argv[3]
out = Path('C:/Temp/watchdog-list-landing-' + sys.argv[2]) / PHASE
out.mkdir(parents=True, exist_ok=True)
FIRST = int(sys.argv[4]) if len(sys.argv) > 4 else 0
REGISTRY_READERS = sorted(
    'tests/' + p.name for p in (repo / 'tests').glob('test_*.py')
    if re.search(r'source_contract_sha256|operation-contracts\.json', p.read_text(encoding='utf-8')))
MODULES = REGISTRY_READERS + [
    'tests/test_state_operation_inventory.py', 'tests/test_watchdog_list_unmanaged.py',
    'tests/test_s10_watchdog_route.py', 'tests/test_pg3c_watchdog_tx.py',
    'tests/test_pg3c_kiosk_exempt.py', 'tests/test_write_route_timing.py',
    'tests/test_operation_census.py', 'tests/test_send_file_seat.py',
    'tests/test_agent_continue_on.py', 'tests/test_p02_operation_contacts.py']
RESTORE = ['engine/backend/orgtree/api.py', 'engine/backend/orgtree/toolwait.py',
           'docs/state-system', 'tests/test_p02_operation_contacts.py',
           'tests/test_operation_census.py']


def git(*args):
    subprocess.run(['git', *args], cwd=repo, check=True)


summary = {}
try:
    if PHASE == 'base':
        git('checkout', BASE, '--', *RESTORE)
    for mod in MODULES[FIRST:]:
        name = Path(mod).stem
        receipt = out / (name + '.json')
        subprocess.run([sys.executable, 'tools/run-python-verification.py', mod,
                        '--timeout', '900', '--json-output', str(receipt)], cwd=repo,
                       capture_output=True, text=True, timeout=1150)
        if not receipt.exists():
            summary[name] = {'ran': None, 'exit': None, 'failed': ['NO RECEIPT']}
            print(PHASE, name, 'NO RECEIPT', flush=True)
            continue
        m = json.loads(receipt.read_text())['modules'][0]
        assert m['import_provenance'] or m.get('phase') == 'execution_failure', m
        names = sorted(set(re.findall(r'^(?:FAIL|ERROR): (\S+ \([^)]*\))', m['stderr'], re.M)))
        ran = re.findall(r'Ran (\d+) tests', m['stderr'])
        summary[name] = {'ran': ran, 'exit': m['exit_code'], 'failed': names}
        print(PHASE, name, ran, m['exit_code'], len(names), flush=True)
finally:
    if PHASE == 'base':
        git('checkout', 'HEAD', '--', *RESTORE)
    clean = subprocess.run(['git', 'status', '--porcelain', '--', *RESTORE], cwd=repo,
                           capture_output=True, text=True).stdout.strip() == ''
    provenance.write_result(out / f'summary-{FIRST}.json', {'modules': summary, 'source_restored': clean})
    print('source_restored', clean, flush=True)
