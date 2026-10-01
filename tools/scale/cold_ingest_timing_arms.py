"""Run the cold-ingest timing arms one at a time: the reviewer's foreground probe
(busy 0 and 20) and the paced profile, at the tip and at the clean base-arm tree.

Usage: cold_ingest_timing_arms.py <base worktree> <tag>
Each arm is a separate interpreter on its own throwaway C:/Temp root and private PG.
"""
import json
from pathlib import Path
import subprocess
import sys

TIP = Path(__file__).resolve().parents[2]
BASE = Path(sys.argv[1]).resolve()
TAG = sys.argv[2]
PY = sys.executable
sys.path.insert(0, str(TIP / 'tools/scale'))
from control import free_commit_gb

out = Path('C:/Temp') / ('cold-arms-' + TAG)
out.mkdir()
arms = []
if len(sys.argv) > 3 and sys.argv[3] == 'preminted':
    for name, repo in (('tip', TIP), ('base', BASE)):
        arms.append((f'fg-{name}-b0-preminted', [PY, str(TIP / 'tools/scale/cold_ingest_fg_probe.py'), '--repo', str(repo),
                     '--root', f'C:/Temp/cold-review-{TAG}-{name}-b0-pre', '--active', '300', '--busy', '0', '--preminted']))
for busy in (0, 20) if not arms else ():
    for name, repo in (('tip', TIP), ('base', BASE)):
        arms.append((f'fg-{name}-b{busy}', [PY, str(TIP / 'tools/scale/cold_ingest_fg_probe.py'), '--repo', str(repo),
                     '--root', f'C:/Temp/cold-review-{TAG}-{name}-b{busy}', '--active', '300', '--busy', str(busy)]))
for name, repo in (('tip', TIP), ('base', BASE)) if len(sys.argv) <= 3 else ():
    arms.append((f'paced-{name}', [PY, str(repo / 'tools/scale/cold_ingest_profile.py'), '--paced',
                 '--root', f'C:/Temp/cold-ingest-{TAG}-paced-{name}']))
summary = {}
for label, cmd in arms:
    if free_commit_gb() < 12:
        raise SystemExit('free commit below 12 GiB before ' + label)
    with (out / (label + '.log')).open('w', encoding='utf-8') as log:
        cp = subprocess.run(cmd, cwd=str(TIP), stdout=log, stderr=subprocess.STDOUT, timeout=420)
    summary[label] = cp.returncode
    print(label, 'exit', cp.returncode, flush=True)
(out / 'summary.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
if any(summary.values()):
    raise SystemExit('an arm failed: ' + json.dumps(summary))
