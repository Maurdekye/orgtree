"""Synthetic fleet contention probe. No provider calls or existing data roots.

Run with python tests/probe_transcript_contention.py. Reports measured latency;
unit tests separately enforce lookup work and collision/link correctness.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

root = Path(tempfile.mkdtemp(prefix='v2-transcript-contention-')).resolve()
os.environ.update(ORGTREE_DATA=str(root), HOME=str(root), USERPROFILE=str(root))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store, supervisor, ledger
assert Path(store.DATA_ROOT).resolve() == root
org = store.create_org('fleet')
org.hire(ledger.USER, None, 'luna', 0, 'agent')
store.save_org(org)
for i in range(522):
    folder = root / 'imports/fleet/native' / str(i)
    folder.mkdir(parents=True)
    (folder / (str(uuid.uuid4()) + '.jsonl')).write_text('{"type":"session_meta"}\n')
sid = org.node('agent')['session_id']
supervisor._codex_journal('fleet', sid, [
    {'type':'assistant','message':{'id':str(i),'role':'assistant',
     'content':[{'type':'text','text':'reply ' + str(i)}]}}
    for i in range(12)])

def read(_):
    start = time.perf_counter()
    chat = supervisor.read_chat(store.load_org('fleet'), 'agent', last=8, hold_back=False)
    assert [row['text'] for row in chat['messages']] == ['reply ' + str(i) for i in range(4, 12)]
    return round(time.perf_counter() - start, 3)

start = time.perf_counter()
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    timings = list(pool.map(read, range(16)))
store._POOL.close_all('fleet')
print(json.dumps({'root':str(root),'native_directories':522,'concurrent_reads':16,
                  'seconds':round(time.perf_counter()-start,3),'request_seconds':timings,
                  'all_exact_pages':True,'provider_calls':0}))
