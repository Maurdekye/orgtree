"""Record published tags' legacy migration names and LF-normalized checksums."""
from pathlib import Path
import sys
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
PROVENANCE = assert_repo_import(REPO)

import hashlib
import json
import subprocess

MIGRATIONS = 'engine/backend/orgtree/pg_migrations/'
releases = [f'3.0.{n}' for n in range(10)] + ['3.1.0']
result = {}
for release in releases:
    tag = 'v' + release
    paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', tag, MIGRATIONS],
                                    cwd=REPO, text=True).splitlines()
    result[release] = {
        'commit': subprocess.check_output(['git', 'rev-parse', tag + '^{commit}'], cwd=REPO,
                                          text=True).strip(),
        'migrations': {Path(path).name: hashlib.sha256(subprocess.check_output(
            ['git', 'show', tag + ':' + path], cwd=REPO).replace(b'\r\n', b'\n')).hexdigest()
                       for path in paths if '/' not in path[len(MIGRATIONS):]},
    }
out = REPO / 'tests/fixtures/upgrade-paths/published-migrations.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
common = result['3.0.9']['migrations']
assert len(common) == 19
assert all(result[r]['migrations'] == common for r in releases[:-1])
assert all(result['3.1.0']['migrations'][k] == v for k, v in common.items())
assert len(result['3.1.0']['migrations']) == 20
print('Measured: v3.0.0-v3.0.9 ship identical 19 migration names and SHA256 values; '
      'v3.1.0 preserves those 19 and adds 0020.')
