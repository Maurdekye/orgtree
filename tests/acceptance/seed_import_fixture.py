"""Seed only synthetic import data; no API/server/provider imports or cleanup.
Usage: python seed_import_fixture.py REPOSITORY NEW_ABSOLUTE_FIXTURE_ROOT
The new root basename must start v2-import-fixture-. Prints reusable JSON paths.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('repository')
parser.add_argument('fixture_root')
args = parser.parse_args()
repository = Path(args.repository).resolve()
root = Path(args.fixture_root)
if not root.is_absolute() or root.exists() or not root.name.startswith('v2-import-fixture-'):
    raise SystemExit('Refusing: choose a NEW absolute directory named v2-import-fixture-*')
root = root.resolve()
root.mkdir(parents=True)
source, destination, home = root / 'source', root / 'destination', root / 'home'
for path in (source / 'orgs', destination, home):
    path.mkdir(parents=True)
# Storage and profile bindings are explicit BEFORE importing any engine code.
for key in list(os.environ):
    if key.startswith('ORGTREE_'):
        os.environ.pop(key)
os.environ.update(ORGTREE_DATA=str(destination), ORGTREE_STORE='sqlite', HOME=str(home), USERPROFILE=str(home))
sys.path.insert(0, str(repository / 'engine/backend'))
from orgtree import ledger, desktop_import, store
assert Path(store.DATA_ROOT).resolve() == destination
org = ledger.Org.create('Import Demo', workspace=str(source / 'workspaces/import-demo'))
for nid in ('active', 'idle'):
    org.hire(ledger.USER, None, 'haiku', 0, nid)
org.nodes['active']['inflight'] = {
    'text': 'Continue the synthetic import acceptance task. No real provider turn should run.',
    'view': 'Synthetic pending work', 'at': '2026-09-07T22:00:00Z'}
org.post_mail(ledger.USER, 'idle', 'Synthetic queued mail; this agent was idle.')
org.d['documents'] = [{'id':'import-report','node':'active','title':'Copied Import Report',
                        'body':'# Imported document\nThis synthetic document must survive the copy.',
                        'at':'2026-09-07T22:00:00Z'}]
org.d['auto_resume'] = True
scratch = source / 'scratch/import-demo/active'
scratch.mkdir(parents=True)
(scratch / 'breadcrumbs.md').write_text('First synthetic step completed; inspect before continuing.\n', encoding='utf-8')
(scratch / 'watch.log').write_text('READY\n', encoding='utf-8')
(scratch / 'outbox').mkdir()
(scratch / 'outbox/report.txt').write_text('Independent copied file.\n', encoding='utf-8')
(source / 'workspaces/import-demo').mkdir(parents=True)
org.d['watchdogs'] = [{'id':'import-watch','name':'Synthetic import watcher','owner':'active',
                      'kind':'file','target':str(scratch / 'watch.log'),'pattern':'READY',
                      'state':'armed','interval_s':60,'notice':True}]
org.d['op_receipts'] = [{'id':'synthetic-uncertain-effect','outcome':'unknown'}]
journals = source / 'journals/projects/import-demo'
journals.mkdir(parents=True)
for nid in ('active', 'idle'):
    sid = org.nodes[nid]['session_id']
    (journals / (sid + '.jsonl')).write_text(json.dumps({
        'type':'assistant','message':{'role':'assistant','content':f'Copied V1 history for {nid}.'}})+'\n', encoding='utf-8')
desktop_import._write_candidate(source / 'orgs/import-demo.db', org.d)
hashes = {str(path.relative_to(source)):hashlib.sha256(path.read_bytes()).hexdigest()
          for path in source.rglob('*') if path.is_file()}
manifest = {'root':str(root),'source_root':str(source),'destination_root':str(destination),'home':str(home),
            'slug':'import-demo','expected_active':['active'],'expected_idle':['idle'],
            'history_texts':['Copied V1 history for active.','Copied V1 history for idle.'],
            'document_title':'Copied Import Report','watchdog':'import-watch','source_hashes':hashes}
(root / 'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest))
