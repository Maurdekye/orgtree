"""The converter CLI with a test-only copy of the source loader's output.

Legacy lazy sections materialize from a set and can be ordered differently in
separate processes. Capture today's source loader within the real CLI process,
then check fixed tag values and explicit loader additions before destination checks.
This hook does not change the document, the inventory or any converter operation.
"""
from pathlib import Path
import sys
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
PROVENANCE = assert_repo_import(REPO)

import json
from orgtree.orgdb.convert import legacy
from orgtree.orgdb.convert.__main__ import main

source_dir = Path(sys.argv[1])
source_dir.mkdir(parents=True, exist_ok=True)
original_loader = legacy.load_document


def capture_source(org):
    # The loader's whole result goes back unchanged (the document comes first; stage 1-B
    # added the org's receipts after the inventory).
    loaded = original_loader(org)
    (source_dir / (org.slug + '.json')).write_text(json.dumps(loaded[0], ensure_ascii=False,
                                                              indent=2)
                                                 + '\n', encoding='utf-8')
    return loaded


legacy.load_document = capture_source
try:
    sys.exit(main(sys.argv[2:]))
finally:
    legacy.load_document = original_loader
