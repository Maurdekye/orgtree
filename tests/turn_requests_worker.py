"""Stop at committed turn-handshake boundaries for real process fault tests."""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / 'tools'))
from assert_repo_import import assert_repo_import
assert_repo_import(_REPO)

import json
import os
from orgtree import turnqueue
from orgtree.orgdb import conn, jobs, names, turn_requests as requests
from orgtree.orgdb import turn_runtime
from dataclasses import asdict

prefix, database, org_id, slug, owner, rid, boundary = sys.argv[1:]
owner, org_id = int(owner), int(org_id)
base = os.environ['ORGTREE_TEST_PG_RUNTIME_URL']
queue = turnqueue.Queue(lambda: conn.connect(base, names.app(prefix)))

with conn.connect(base, database) as c:
    if boundary == 'queued':
        with c.transaction():
            (job,) = requests.claim_jobs(c, owner, limit=1)
        jobs.execute(c, job, requests.queue_job)
    row = requests.get(c, rid)
    agent = c.execute('SELECT name FROM orgtree.agents WHERE id=%s',
                      (row.agent_id,)).fetchone()[0]
app = turnqueue.Request(rid, org_id, row.agent_id, agent, row.reason)
if boundary == 'inserted':
    queue.enqueue(app, owner)

print(json.dumps({'boundary': boundary, 'request_id': rid,
                  'pid': os.getpid(), 'checkout': str(_REPO)}), flush=True)
command = sys.stdin.readline().strip()
if command == 'insert':
    ticket = queue.enqueue(app, owner)
    print(json.dumps({'state': ticket.state}), flush=True)
elif command == 'claim' and boundary == 'compete':
    ticket = queue.claim(owner, rid)
    if ticket is None:
        print(json.dumps({'admitted': False}), flush=True)
    else:
        host = turn_runtime.Host(base, owner, prefix=prefix)
        org = host.org(slug)
        run = host.begin(org, agent, rid, ticket, lambda: None)
        print(json.dumps({'admitted': True, 'run': asdict(run), 'pid': os.getpid()}), flush=True)
elif command != 'exit':
    raise RuntimeError('fault worker stopped before the next boundary')
