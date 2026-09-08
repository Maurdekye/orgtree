"""Synthetic source files around the actual scoped presentation API."""
import json
import os
from pathlib import Path

DATA = Path(os.environ['ORGTREE_DATA']).resolve()
assert DATA == Path(os.environ['ORGTREE_ACCEPTANCE_ROOT']).resolve() / 'data'
source = (Path(__file__).parent / 'maintenance_engine.py').read_text()
namespace = {'__name__': 'artifact_fixture', '__file__': str(Path(__file__).parent / 'maintenance_engine.py')}
exec(compile(source.rsplit('\nlaunch.main()', 1)[0], 'maintenance_engine.py', 'exec'), namespace)
launch = namespace['launch']
observed = launch.load_app

def seeded_artifacts():
    result = observed()
    from orgtree import supervisor, api
    runtime_root = Path(os.environ['ORGTREE_ACCEPTANCE_APP']).resolve()
    assert Path(launch.__file__).resolve() == runtime_root / 'engine' / 'launch.py'
    assert Path(api.__file__).resolve() == runtime_root / 'engine' / 'backend' / 'orgtree' / 'api.py'
    (DATA.parent / 'engine-provenance.json').write_text(json.dumps({'launcher': str(Path(launch.__file__).resolve()), 'api': str(Path(api.__file__).resolve())}))
    folder = Path(supervisor.scratch_dir('acceptance-runtime', 'planner')) / 'artifact-source'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'assets').mkdir(exist_ok=True)
    files = {
        'single.html': '<!doctype html><meta charset="utf-8"><title>Single acceptance</title><h1>Single HTML original</h1><p>Isolated synthetic source.</p>',
        'index.html': '<!doctype html><meta charset="utf-8"><title>Bundle acceptance</title><link rel="stylesheet" href="assets/site.css"><h1>Bundle HTML original</h1><img src="assets/mark.svg"><p>Referenced assets must travel with this document.</p>',
        'assets/site.css': 'body{background:#19212d;color:#e5eaf0;font:18px sans-serif;padding:24px}h1{color:#77c4ff}',
        'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#77c4ff"/></svg>',
    }
    for name, body in files.items():
        (folder / name).write_text(body, encoding='utf-8')
    (folder / 'unrelated.txt').write_text('Unreferenced synthetic file must not enter ZIP.')
    (DATA.parent / 'artifact-manifest.json').write_text(json.dumps({'folder':str(folder),'files':files}), encoding='utf-8')
    return result

launch.load_app = seeded_artifacts
launch.main()
