"""Read the restored fixture through today's legacy loader in one read-only snapshot.

The committed tag document is the checksum oracle; this reader supplies the
current loader's top-level order, which the converter is specified to preserve.
It imports no converter, mapper, codec or section implementation.
"""
from pathlib import Path
import sys
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
PROVENANCE = assert_repo_import(REPO)

import argparse
import json
import os
from orgtree import pgstore, store

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--slug', required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
marker = os.path.join(store.DATA_ROOT, 'orgs', a.slug + '.pg')
connection = pgstore.open_conn(a.slug, marker)
try:
    connection.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    connection.pinned = True
    store._orgtx_local.pinned = {a.slug: connection}
    d = store.load_org(a.slug).d
    if hasattr(d, 'materialize_all'):
        d.materialize_all()
    doc = {}
    for key in list(d):
        value = d[key]
        if hasattr(value, 'materialize'):
            value.materialize('upgrade-source-oracle')
        doc[key] = value
    if not connection.in_transaction:
        raise RuntimeError('source snapshot ended while reading')
    a.output.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
finally:
    store._orgtx_local.pinned = None
    connection.pinned = False
    connection.close()
