"""Regenerate small synthetic upgrade fixtures using the named release's own store.

Run under the P03 heavy lock. PG URLs must name a DISPOSABLE cluster.
See tests/fixtures/upgrade-paths/README.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import

TAG_ROOT = (Path(sys.argv[sys.argv.index('--tag-root') + 1])
            if '--tag-root' in sys.argv else REPO)
PROVENANCE = assert_repo_import(TAG_ROOT, require_commit=TAG_ROOT == REPO)

import argparse
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import zipfile

RELEASES = ('2.1.14', '3.0.9', '3.1.0')
FIXTURES = REPO / 'tests' / 'fixtures' / 'upgrade-paths'


def digest(value):
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def section_manifest(doc):
    return {k: {'count': len(v) if isinstance(v, (dict, list)) else 1,
                'sha256': digest(v)} for k, v in doc.items()}


def file_digest(path):
    data = path.read_bytes()
    if path.suffix in ('.json', '.pg', '.sql'):
        data = data.replace(b'\r\n', b'\n')
    return hashlib.sha256(data).hexdigest()


def seed(ledger, slug, registry):
    """Small, stable data, with every registered top-level section present."""
    at = '2026-01-01T00:00:00.000Z'
    doc = ledger.Org.create(slug, [], 'acceptEdits', workspace='fixture-workspace').d
    for key, (_, shape, _) in registry.items():
        doc.setdefault(key, {} if shape == 'by_node' else [] if shape == 'row_field' else None)
    doc.update(slug=slug, name=slug, created=at, workspace='fixture-workspace', dirs=[],
               default_dirs=[], models={'opus': 'claude-opus-4-6'}, tiers={'opus': 4},
               version=3, _actors_typed=True, whole_grants_v1=True,
               nodes={'lead': {'id': 'lead', 'name': 'lead', 'parent': None,
                               'state': 'live', 'model': 'claude-opus-4-6', 'tier': 'opus',
                               'grant': 4, 'generation': 0, 'born': 'fixture-lead',
                               'seat_id': 'fixture-seat', 'session_id': 'fixture-session',
                               'created': at, 'title': 'Synthetic leader', 'charter': 'Synthetic',
                               'scope': {'permission_mode': 'acceptEdits', 'add_dirs': [],
                                         'tools': {'bash': False, 'edit': False, 'mcp': []}}}},
               mail={'lead': [{'id': 'm1', 'from': 'user', 'body': 'Synthetic mail', 'at': at}]},
               mail_log={'lead': [{'id': 'm0', 'from': 'user', 'body': 'Archived mail', 'at': at}]},
               notices={'lead': [{'at': at, 'text': 'Synthetic notice'}]},
               delivering={'lead': [{'tok': 'delivery1', 'at': at, 'mail': [], 'notices': []}]},
               steered_log={'lead': [{'at': at, 'text': 'Synthetic steer'}]},
               turn_error_log={'lead': [{'at': at, 'text': 'Synthetic error'}]},
               turn_log={'lead': [{'n': 1, 'at': at, 'cost': 1.5, 'ms': 10}]},
               mail_transitions={'lead': {'transition1': {'operation': 'deliver', 'outcome': 'ok'}}},
               steer_attempts={'lead': {'attempt1': {'at': at, 'toks': ['delivery1']}}},
               manual_attempts={'lead': {'manual1': {'at': at, 'mail_ids': ['m1']}}},
               work_items=[{'slug': 'synthetic-task', 'title': 'Synthetic task', 'status': 'open',
                            'owner': {'node': 'lead', 'generation': 0, 'born': 'fixture-lead'},
                            'at': at, 'updated_at': at, 'acceptance': [], 'history': []},
                           {'slug': 'second-task', 'title': 'Second synthetic task',
                            'status': 'open', 'at': at, 'updated_at': at}],
               work_items_archive=[{'slug': 'old-task', 'title': 'Old task', 'status': 'done',
                                    'archived_at': at, 'history': []}],
               events=[{'at': at, 'op': 'fixture', 'actor': 'user'}],
               documents=[{'id': 'doc1', 'node': 'lead', 'title': 'Synthetic', 'body': 'Body', 'at': at}],
               asks=[{'id': 'ask1', 'node': 'lead', 'kind': 'ask', 'question': 'Synthetic?',
                      'at': at, 'status': 'answered', 'options': [], 'answer': {'text': 'Yes'}}],
               credit_requests=[{'id': 'credit1', 'node': 'lead', 'old': 4, 'new': 5,
                                 'at': at, 'status': 'resolved'}],
               scope_requests=[{'id': 'scope1', 'node': 'lead', 'items': [], 'at': at,
                                'status': 'resolved'}],
               audiences=[{'grantee': 'lead', 'grantor': 'user', 'granted_at': at}],
               audience_requests=[{'id': 'audience1', 'node': 'lead', 'target': 'user', 'at': at}],
               watchdogs=[{'id': 'watch1', 'owner': 'lead', 'name': 'Synthetic', 'kind': 'file',
                           'target': 'synthetic.log', 'state': 'paused', 'at': at, 'interval_s': 60}],
               watchdog_tombs=[{'id': 'watch0', 'owner': 'lead', 'name': 'Old', 'kind': 'file',
                                'target': 'old.log', 'at': at, 'spent_at': at}],
               watchdog_history=[{'watchdog': 'watch0', 'node': 'lead', 'at': at, 'gist': 'Synthetic'}],
               lifecycle=[{'operation_id': 'life1', 'kind': 'fixture', 'state': 'done', 'at': at}],
               notice_log=[{'node': 'lead', 'at': at, 'text': 'Archived notice'}],
               org_inbox=[{'id': 'org1', 'dir': 'in', 'peer': 'synthetic', 'body': 'Body', 'at': at}],
               user_inbox=[{'id': 'user1', 'from': 'lead', 'body': 'Body', 'at': at}],
               user_outbox=[{'id': 'out1', 'to': 'lead', 'body': 'Body', 'at': at}],
               user_mail_log=[{'id': 'log1', 'from': 'lead', 'body': 'Body', 'at': at}],
               op_receipts=[], orphan_keys={}, work_scope_log={'lead': []},
               _migrations={}, work_deleted_names=['deleted-task'])
    return doc


def plain(org):
    d = org.d
    if hasattr(d, 'materialize_all'):
        d.materialize_all()
    out = {}
    for key in list(d):
        val = d[key]
        if hasattr(val, 'materialize'):
            val.materialize('upgrade-fixture')
        out[key] = val
    return json.loads(json.dumps(out))


def worker(args):
    # All engine imports here resolve to the archived tag, guarded above.
    from orgtree import ledger, store
    if args.release != '2.1.14':
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])
    root = Path(os.environ['ORGTREE_DATA'])
    (root / 'orgs').mkdir(parents=True)
    registry = json.loads(args.section_registry.read_text())
    documents = {}
    for slug in ('alpha', 'beta'):
        org = ledger.Org(seed(ledger, slug, registry))
        store.save_org(org)
        # Persist the release loader's initialization too, then read the saved source.
        store.save_org(store.load_org(slug))
        documents[slug] = plain(store.load_org(slug))
    args.output.mkdir(parents=True, exist_ok=True)
    for slug, doc in documents.items():
        (args.output / f'{slug}.json').write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8')
        source = root / 'orgs' / (slug + ('.db' if args.release == '2.1.14' else '.pg'))
        if args.release == '2.1.14':
            with sqlite3.connect(source) as src, sqlite3.connect(args.output / source.name) as dst:
                src.backup(dst)
        else:
            shutil.copyfile(source, args.output / source.name)
    manifest = {'release': args.release, 'tag': 'v' + args.release, 'commit': args.commit,
                'writer': 'tag engine/backend/orgtree/store.py save_org/load_org',
                'writer_sha256': hashlib.sha256(Path(store.__file__).read_bytes().replace(b'\r\n', b'\n')).hexdigest(),
                'registered_sections': sorted(registry),
                'orgs': {s: section_manifest(d) for s, d in documents.items()}}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


def generate(args):
    import psycopg
    from psycopg import sql
    from urllib.parse import urlsplit, urlunsplit
    from orgtree import ledger
    admin = os.environ['ORGTREE_TEST_PG_ADMIN_URL']
    p = urlsplit(admin)
    for release in RELEASES:
        with tempfile.TemporaryDirectory(prefix='orgtree-tag-fixture-') as temp:
            temp = Path(temp)
            tag = 'v' + release
            commit = subprocess.check_output(['git', 'rev-parse', tag + '^{commit}'], cwd=REPO,
                                             text=True).strip()
            archive = subprocess.check_output(['git', 'archive', '--format=zip', tag], cwd=REPO)
            tagroot = temp / 'release'
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                z.extractall(tagroot)
            registry_file = temp / 'sections.json'
            registry_file.write_text(json.dumps(ledger.NODE_KEYED_SECTIONS), encoding='utf-8')
            db = f'upgrade_fixture_{os.getpid()}'
            env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
                ('ORGTREE_', 'PYTHON', 'OPENAI_', 'CLAUDE_', 'CODEX_', 'ANTHROPIC_'))}
            env.update(ORGTREE_DATA=str(temp / 'data'), HOME=str(temp / 'home'),
                       USERPROFILE=str(temp / 'home'), ORGTREE_STORE='sqlite' if release == '2.1.14'
                       else 'postgres', PYTHONIOENCODING='utf-8')
            output = args.output / release
            output.mkdir(parents=True, exist_ok=True)
            created = False
            try:
                if release != '2.1.14':
                    with psycopg.connect(admin, autocommit=True) as c:
                        c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(db)))
                    created = True
                    env['ORGTREE_PG_URL'] = urlunsplit((p.scheme, p.netloc, '/' + db, p.query, p.fragment))
                proc = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()),
                                       '--tag-root', str(tagroot), '--release', release,
                                       '--commit', commit, '--output', str(output),
                                       '--section-registry', str(registry_file)], env=env,
                                      capture_output=True, text=True, timeout=180)
                if proc.returncode:
                    raise RuntimeError(proc.stdout + proc.stderr)
                if created:
                    subprocess.run([str(args.pg_bin / 'pg_dump.exe'), '--dbname', env['ORGTREE_PG_URL'],
                                    '--no-owner', '--file', str(output / 'legacy.sql')],
                                   check=True, capture_output=True, timeout=180)
                    dump = output / 'legacy.sql'
                    dump.write_text(dump.read_text(encoding='utf-8').rstrip() + '\n', encoding='utf-8')
                manifest = json.loads((output / 'manifest.json').read_text())
                manifest['files'] = {f.name: file_digest(f)
                                     for f in sorted(output.iterdir()) if f.name != 'manifest.json'}
                (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
                print(f'{release}: generated by {commit}', flush=True)
            finally:
                if created:
                    with psycopg.connect(admin, autocommit=True) as c:
                        c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(db)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag-root', type=Path)
    parser.add_argument('--release', choices=RELEASES)
    parser.add_argument('--commit')
    parser.add_argument('--section-registry', type=Path)
    parser.add_argument('--pg-bin', type=Path)
    parser.add_argument('--output', type=Path, default=FIXTURES)
    args = parser.parse_args()
    worker(args) if args.tag_root else generate(args)
