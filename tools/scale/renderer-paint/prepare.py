"""Prepare equal seeded history and queued-mail recipients, without provider turns."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys

p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
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
assert len(sources) == desc['agents'], len(sources)
stats = {'bytes_read': 0}
for source, path in sources:
    records.ingest(source, path, 1 << 50, stats)
with records.database() as conn:
    count = conn.execute('SELECT count(*) FROM transcript_records').fetchone()[0]
    pending = conn.execute('SELECT count(*) FROM transcript_sources WHERE lower_byte>0').fetchone()[0]
assert pending == 0
out = dict(halted_parents=parents, callers=sorted(set(live) - set(parents)), sources=len(sources),
           records=count, bytes_read=stats['bytes_read'], synthetic_keepalive_suppression_until=keepalive_until)
prov.write_result(root / 'prepared.json', out)
print(json.dumps(out), flush=True)

