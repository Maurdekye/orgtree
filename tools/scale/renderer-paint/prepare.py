"""Prepare equal seeded history and queued-mail recipients, without provider turns."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys

p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
p.add_argument('--archive-multiplier', type=int, default=1)
p.add_argument('--retired-multiplier', type=int, default=0)
args = p.parse_args()
repo = Path(__file__).resolve().parents[3]
root = Path(args.root).resolve()
sys.path.insert(0, str(repo / 'tools/scale'))
from seed import child_env
desc = json.loads((root / 'scale-descriptor.json').read_text())
env = child_env(root, desc['pg_url'])
os.environ.clear()
os.environ.update(env)
sys.path.insert(0, str(repo / 'tools'))
from assert_repo_import import assert_repo_import
prov = assert_repo_import(str(repo))
from orgtree import appsettings, store, ledger, halt, transcript_records as records, supervisor
from orgtree.chat_window import source_key

for provider in appsettings.PROVIDERS:
    appsettings.set_provider_enabled(provider, False)
appsettings.set_working_checkups_enabled(False)
appsettings.set_idle_docket_reminders_enabled(False)
appsettings.set_blocked_docket_reminders_enabled(False)
org = store.load_org(desc['org'])
# Synthetic fixture only: keep old transcript history but put the unrelated
# cache-read deadline beyond startup + this short measurement. This is declared
# in the receipt and does not change any product default or scheduler code.
keepalive_until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat()
for node in org.nodes.values():
    if node.get('state') == 'live':
        node['cache_keepalive_at'] = keepalive_until
for dog in org.d.get('watchdogs', []):
    org.watchdog_action(ledger.USER, dog['id'], 'pause')
org._work_archive_eligible()
if not 1 <= args.archive_multiplier <= 10:
    raise ValueError('archive multiplier must be1..10 for the bounded N10 experiment')
# Duplicate only inactive item/evidence history. Both arms keep the exact same
# seed configuration, active work and other log/transcript history.
original_archive = list(org.d.get('work_items_archive') or [])
for copy in range(1, args.archive_multiplier):
    for original in original_archive:
        item = json.loads(json.dumps(original))
        item['slug'] = f"{original['slug']}-history-{copy}"
        if item.get('ref'): item['ref'] = f"@item:{desc['org']}/{item['slug']}"
        org.d['work_items_archive'].append(item)
# Retired AGENTS for the paired tree measurement: 20 per multiplier step,
# all archived children of one live top-level agent, with no session and so
# no transcript. Live agents, active work and all other history are equal.
retired_parent = None
if args.retired_multiplier:
    if not 1 <= args.retired_multiplier <= 10:
        raise ValueError('retired multiplier must be1..10 for the bounded N10 experiment')
    tops = sorted(nid for nid, n in org.nodes.items() if n.get('state') == 'live' and not n.get('parent'))
    retired_parent = tops[0]
    prototype = json.loads(json.dumps(org.nodes[retired_parent]))
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for n in range(20 * args.retired_multiplier):
        nid = f'retired-{n:04d}'
        assert nid not in org.nodes
        org.nodes[nid] = {**prototype, 'id': nid, 'title': nid, 'parent': retired_parent,
                          'state': 'archived', 'archived_at': stamp, 'grant': 0, 'free': 0,
                          'session_id': None, 'successor': None, 'lineage': [], 'turns': [],
                          'mail_pending': 0}
store.save_org(org)
live = {nid: n for nid, n in org.nodes.items() if n.get('state') == 'live'}
parents = sorted({n['parent'] for n in live.values() if n.get('parent')})
for nid in parents:
    result = halt.halt(desc['org'], nid, ledger.USER)
    assert result.get('halted') and result.get('settled'), result
org = store.load_org(desc['org'])
sources = []
for nid in org.nodes:
    path = supervisor.transcript_path_for_node(org, nid)
    if path:
        sources.append((source_key(org, nid), path))
assert len(sources) == desc['agents'], len(sources)   # retired seats carry no session
stats = {'bytes_read': 0}
for source, path in sources:
    records.ingest(source, path, 1 << 50, stats)
with records.database() as conn:
    count = conn.execute('SELECT count(*) FROM transcript_records').fetchone()[0]
    pending = conn.execute('SELECT count(*) FROM transcript_sources WHERE lower_byte>0').fetchone()[0]
assert pending == 0
out = dict(halted_parents=parents, callers=sorted(set(live) - set(parents)), sources=len(sources),
           records=count, bytes_read=stats['bytes_read'], synthetic_keepalive_suppression_until=keepalive_until,
           archive_multiplier=args.archive_multiplier, archive_items=len(original_archive) * args.archive_multiplier,
           retired_multiplier=args.retired_multiplier, retired_agents=20 * args.retired_multiplier,
           retired_parent=retired_parent,
           active_work=[{'slug': it['slug'], 'status': it['status'], 'owner': it.get('owner')}
                        for it in org.d.get('work_items') or []])
prov.write_result(root / 'prepared.json', out)
print(json.dumps(out), flush=True)

