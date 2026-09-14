"""Explicit slow negative control: python tests/long-tool-mail-probe.py [seconds].

Runs the real HTTP-route adapter with a controlled blocking orgtree_staff
dispatcher and provider result boundary. No live staffing/provider calls.
Default 130 seconds reproduces the multi-minute gap; shorter runs are smoke checks.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='long-tool-probe-')
os.environ['ORGTREE_DATA'] = root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import api, ledger, store, supervisor as sup, toolwait

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 130
assert seconds > toolwait.WAIT_S
org = store.create_org('long-tool-probe')
for nid in ('fixed', 'old'):
    org.hire(ledger.USER, None, 'haiku', 0, nid)
    sup.state(org.d['slug'], nid).update(busy=True, responding=True)
store.save_org(org)
started = time.monotonic()
side_effects = {'fixed': 0, 'old': 0}
injected = {}
lock = threading.Lock()


def blocked_staff(body, request):
    with lock:
        side_effects[body.node] += 1
    threading.Event().wait(seconds)
    return {'node': 'staffed-once', 'owner': body.node}


def run(nid):
    body = api.AgentCall(org='long-tool-probe', node=nid, tool='orgtree_staff', args={})
    request = SimpleNamespace(state=SimpleNamespace())
    if nid == 'fixed':
        result = asyncio.run(api._agent_call_route(body, request))
    else:
        result = api.agent_call(body, request)  # the previous blocking route
    # Controlled provider: consumes queued context only when its tool returns.
    carriers = sup.pop_steer('long-tool-probe', nid, defer_commit=True)
    injected[nid] = {'boundary_seconds': round(time.monotonic() - started, 3),
                     'mail': [c['text'] for c in carriers], 'tool_result': result}
    print(json.dumps({'node': nid, **injected[nid]}), flush=True)


with ExitStack() as stack:
    stack.enter_context(patch.object(api, 'agent_call', side_effect=blocked_staff))
    stack.enter_context(patch.object(sup, 'send_message', return_value={'accepted': True}))
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, nid) for nid in ('fixed', 'old')]
        time.sleep(1)
        # The acceptance path is durable before its active-turn carrier is queued.
        for i in range(3):
            with store.DOC_LOCK:
                org = store.load_org('long-tool-probe')
                for nid in ('fixed', 'old'):
                    org.post_mail(ledger.USER, nid, f'user message {i}')
                    sup.state('long-tool-probe', nid).setdefault('steer', []).append(
                        {'text': f'user message {i}', 'toks': []})
                store.save_org(org)
        for future in futures:
            future.result(timeout=seconds + 10)
        deadline = time.monotonic() + 5
        while toolwait._live and time.monotonic() < deadline:
            toolwait.sweep()
            time.sleep(.05)

assert injected['fixed']['boundary_seconds'] < 15
assert injected['old']['boundary_seconds'] >= seconds
assert injected['fixed']['mail'] == injected['old']['mail'] == [f'user message {i}' for i in range(3)]
assert side_effects == {'fixed': 1, 'old': 1}
assert not toolwait._live
print(json.dumps({'PASS': True, 'duration': seconds, 'executions': side_effects}), flush=True)
store._POOL.close_all('long-tool-probe')
