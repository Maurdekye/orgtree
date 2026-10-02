"""An independent engine process for turnqueue concurrency verification."""
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / 'tools'))
from assert_repo_import import assert_repo_import
assert_repo_import(_REPO)

import dataclasses
import json
import os
import socket
from orgtree import turnqueue
from orgtree.orgdb import conn


def connect():
    return conn.connect(os.environ['ORGTREE_TEST_PG_RUNTIME_URL'], sys.argv[1])


with connect() as c:
    instance = c.execute('INSERT INTO orgtree.engine_instances(host, pid) VALUES (%s, %s) RETURNING id',
                         (socket.gethostname(), os.getpid())).fetchone()[0]
queue = turnqueue.Queue(connect)
print(json.dumps({'ready': instance, 'pid': os.getpid()}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if command['op'] == 'close':
        break
    if command['op'] == 'claim':
        ticket = queue.claim(instance, command.get('request'))
        answer = dataclasses.asdict(ticket) if ticket else None
    elif command['op'] == 'fill':
        answer = []
        while True:
            ticket = queue.claim(instance)
            if ticket is None:
                break
            answer.append(dataclasses.asdict(ticket))
    elif command['op'] == 'finish':
        answer = queue.finish(turnqueue.Ticket(**command['ticket']))
    else:
        raise ValueError(command)
    print(json.dumps(answer), flush=True)
