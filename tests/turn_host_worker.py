"""Own a real guardian/provider tree at a durable running-request boundary."""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / 'tools'))
from assert_repo_import import assert_repo_import
assert_repo_import(_REPO)

import json
import os
import subprocess
import time
from dataclasses import asdict
from engine.process_lifetime import arm_process_lifetime

prefix, root, request_id = sys.argv[1:]
root = Path(root).resolve(strict=True)
guardian = arm_process_lifetime(root, os.getppid())

from orgtree import turnqueue, turnslots
from orgtree.orgdb import conn, names, turn_runtime

base = os.environ['ORGTREE_TEST_PG_RUNTIME_URL']
with conn.connect(base, names.app(prefix)) as c:
    owner = c.execute('INSERT INTO orgtree.engine_instances(host,pid) VALUES (%s,%s) '
                      'RETURNING id', ('owned-guardian-control', os.getpid())).fetchone()[0]
host = turn_runtime.Host(base, owner, prefix=prefix)
host.start(limit=1)
org, request = host.prepare('alpha', 'seat', 'turn', request_id)
# Queue.claim deliberately returns None while the admission gate is busy.
# Use the same blocking adapter as a real supervisor, rather than assuming
# a one-shot probe cannot race this worker's own heartbeat/forwarder.
app = turnqueue.Request(request_id, org.org_id, request.agent_id, 'seat', 'turn')
with turnslots.bind_request(app):
    host.slots.acquire('alpha')
ticket = host.slots.current_claim
run = host.begin(org, 'seat', request_id, ticket, lambda: None)
leaf = root / 'provider-leaf.json'
provider_code = ('import json,subprocess,sys,time;from pathlib import Path;'
                 'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(90)"]);'
                 'Path(sys.argv[1]).write_text(json.dumps(p.pid));time.sleep(90)')
provider = subprocess.Popen([sys.executable, '-I', '-c', provider_code, str(leaf)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW)
deadline = time.monotonic() + 10
while not leaf.exists() and time.monotonic() < deadline:
    time.sleep(.02)
grandchild = json.loads(leaf.read_text())
print(json.dumps({'checkout': str(_REPO), 'engine': os.getpid(), 'guardian': guardian,
                  'provider': provider.pid, 'grandchild': grandchild, 'owner': owner,
                  'run': asdict(run)}), flush=True)
sys.stdin.readline()  # The parent suspends this process, then kills this exact Popen handle.
