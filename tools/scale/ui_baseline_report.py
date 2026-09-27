"""Preserve and summarize the one-arm baseline, without touching engine state."""
import collections
import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil
import statistics
import sys

packet = Path(sys.argv[1]).resolve()
ident = json.loads((packet/'both-identity.json').read_text())
root = Path(ident['root'])
target = packet/'both'/'metrics'
target.mkdir(parents=True, exist_ok=True)
manifest = []
for source in sorted((root/'metrics').rglob('*')):
    if not source.is_file():
        continue
    dest = target/source.relative_to(root/'metrics')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, dest)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest == hashlib.sha256(dest.read_bytes()).hexdigest()
    manifest.append({'path': str(dest.relative_to(packet)), 'sha256': digest, 'bytes': dest.stat().st_size})
(packet/'metrics-sha256.json').write_text(json.dumps(manifest, indent=2))

def rows(name, folder=target/'loaded'):
    path = folder/(name+'.jsonl')
    return [json.loads(line) for line in path.read_text(encoding='utf8').splitlines()] if path.exists() else []

def pct(values):
    values = sorted(values)
    return {'n': len(values), 'p50': values[round((len(values)-1)*.5)],
            'p95': values[round((len(values)-1)*.95)], 'max': values[-1],
            'mean': statistics.fmean(values)} if values else {'n': 0}

summary = json.loads((target/'loaded'/'summary.json').read_text())
stored = json.loads((target/'loaded'/'stored-writes.json').read_text())
calls, ui, steer = rows('calls'), rows('ui'), rows('steer')
groups = collections.defaultdict(list)
for call in calls:
    groups[call['tool'] + (':' + call['action'] if call.get('action') else '')].append(call)
tools = {name: dict(offered=len(values), success=sum(c['status']==200 and not c['err'] for c in values),
    successful_ms=pct(c['total_ms'] for c in values if c['status']==200 and not c['err']),
    all_outcome_ms=pct(c['total_ms'] for c in values)) for name,values in sorted(groups.items())}
groups.clear()
for call in ui:
    groups[call['route']].append(call)
routes = {name: dict(total=len(values), success=sum(c['status'] in (200,304) and not c['err'] for c in values),
    successful_ms=pct(c['ms'] for c in values if c['status'] in (200,304) and not c['err']),
    scheduled_ms=pct(c['total_ms'] for c in values if c['status'] in (200,304) and not c['err']),
    statuses=dict(collections.Counter(str(c['status']) for c in values)),
    bytes=sum(c['bytes'] for c in values)) for name,values in sorted(groups.items())}
config = summary['config']
start,end = config['started'], config['started']+config['duration_s']
samples = [s for s in rows('independent-samples', target) if start<=s['at']<=end]
cpu = {'samples': len(samples)}
if len(samples)>1:
    cpu.update(cpu_s=samples[-1]['cpu_s']-samples[0]['cpu_s'], wall_s=samples[-1]['at']-samples[0]['at'])
    cpu['cores'] = cpu['cpu_s']/cpu['wall_s']
    cpu['min_free_commit_gib'] = min(s['free_commit_gb'] for s in samples)
logs = (target/'serve.log').read_text(encoding='utf8')
access = []
for line in logs.splitlines():
    match = re.search(r'\[orgtree.access\] (\S+) (\S+) (\S+) (\d+) handler=([\d.]+)ms total=([\d.]+)ms bytes=(\d+) inflight=(\d+)',line)
    if match:
        at,method,route,status,handler,total,size,inflight=match.groups()
        if datetime.datetime.fromisoformat(at.replace('Z','+00:00')).timestamp() >= start-1:
            access.append(dict(route=route,status=int(status),handler=float(handler),inflight=int(inflight)))
graphs=rows('pg-holder-waiter', target)
pg_peak=max((len(g.get('activity',[]))+1 for g in graphs),default=0)
facts=dict(product='08d0e0816500add001b3fa5e37a8b64bc37d479d',identity=ident,config=config,
    tools=tools,routes=routes,cpu=cpu,stored=stored,feed=summary['feed'],
    achieved=summary['achieved'],counters=summary['client_counters'],
    pg_peak_observed=pg_peak,pg_sampler=summary['pg'],
    graph_errors=sum('error' in g for g in graphs),
    inflight=pct(a['inflight'] for a in access),
    tool_client_ms=pct(c['total_ms'] for c in calls if c['status']==200 and not c['err']),
    steer_client_ms=pct(c['total_ms'] for c in steer if c['status']==200 and not c['err']),
    all_ui_ms=pct(c['ms'] for c in ui if c['status'] in (200,304) and not c['err']),
    agent_handler_ms=pct(a['handler'] for a in access if a['route']=='/api/agent' and a['status']==200),
    client_errors=[c for c in calls if c['status']!=200 or c['err']],
    errors_55p03=[c for c in calls if '55P03' in str(c['err'])],
    server_55p03_lines=sum('55P03' in line for line in logs.splitlines()),
    guard=summary['guard'],memory=summary['memory'],
    workload_clean=summary['workload_completed_without_errors_or_overload'])
(packet/'baseline-facts.json').write_text(json.dumps(facts,indent=2))
print(json.dumps({key:facts[key] for key in ('tools','routes','cpu','feed','pg_peak_observed',
    'tool_client_ms','all_ui_ms','agent_handler_ms','server_55p03_lines','workload_clean')},indent=2))
