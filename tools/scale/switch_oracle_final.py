"""Independent post-run fresh-process storage check; engine must already be stopped."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from write_oracle import WriteOracle
from switch_audit import audit_for, unexpected
p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
p.add_argument('--label', default='loaded')
args = p.parse_args()
root = Path(args.root)
desc = json.loads((root / 'scale-descriptor.json').read_text())
out = root / 'metrics' / args.label
def rows(name):
    path = out / (name + '.jsonl')
    return [json.loads(s) for s in path.read_text().splitlines()] if path.exists() else []
receipts = rows('write-receipts')
overwrites = rows('write-checks')
oracle = WriteOracle(desc)
result = oracle.snapshot(receipts)
ids = [r['request_id'] for r in result['append_checks'] + overwrites]
expected = [r['request_id'] for r in receipts]
result.update(overwrite_checks=len(overwrites), receipts=len(receipts),
              all_overwrites_pass=all(r['passed'] for r in overwrites),
              all_acknowledgments_checked=sorted(ids) == sorted(expected) and len(set(ids)) == len(ids),
              engine_stopped=True)
# Observation negative control: the same acknowledged mail ID with a false body must be rejected.
mail = next(r for r in receipts if r['tool'] in ('orgtree_message', 'orgtree_send_notice'))
wrong = dict(mail, args=dict(mail['args'], body='DELIBERATELY FALSE STORED BODY'))
result['negative_control_caught'] = not oracle.snapshot([wrong])['passed']
oracle.close()
paths = list((root / 'data').rglob('*transcript*.sqlite*'))
transcripts = []
for path in paths:
    if path.suffix not in ('.sqlite', '.sqlite3', '.db'):
        continue
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='transcript_records'").fetchone():
            transcripts.append({'path': str(path.relative_to(root)), 'records': conn.execute(
                'SELECT count(*) FROM transcript_records').fetchone()[0],
                'sources': conn.execute('SELECT count(*) FROM transcript_sources').fetchone()[0]})
result['transcripts'] = transcripts
audit = root/'metrics'/'serve-refused.jsonl'
attempts = [json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
classifier = audit_for(root)
result['unexpected_external_attempts'] = [row for row in attempts if unexpected(classifier, row)]
result['no_launch_sentinel'] = not (root/'metrics'/'qualification-invalid.json').exists()
result['passed'] = (result['passed'] and result['all_overwrites_pass'] and
                    result['all_acknowledgments_checked'] and result['negative_control_caught'] and bool(transcripts)
                    and not result['unexpected_external_attempts'] and result['no_launch_sentinel'])
(out / 'stored-writes.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result), flush=True)
sys.exit(0 if result['passed'] else 2)
