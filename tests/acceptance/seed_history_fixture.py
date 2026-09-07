"""Provider-free actual-app fixture. Refuses an existing root; never starts engine lifespan.

python seed-history.py --repo E:/Libraries/Desktop/orgtree --root <NEW absolute directory>
Run the desktop/engine with the environment printed in manifest.json.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--phase', choices=['seed', 'verify'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    assert args.root.is_absolute() and args.repo.is_absolute(), 'Use explicit absolute paths'
    root, repo = args.root.resolve(), args.repo.resolve()
    assert (repo / 'engine/backend/orgtree/store.py').is_file(), 'Expected standalone v2 repo'
    if args.phase is None:
        root.mkdir()  # Existing roots, including empty roots, are refused.
        data, home = root / 'data', root / 'home'
        data.mkdir(); home.mkdir()
        env = dict(os.environ, ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                   PYTHONPATH=str(repo / 'engine/backend'), ORGTREE_STORE='sqlite',
                   ORGTREE_V2='1', PYTHONIOENCODING='utf-8')
        # Do not inherit operator credential/config-directory overrides.
        for key in ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ORGTREE_BASE', 'ORGTREE_ORG',
                    'ORGTREE_NODE', 'ORGTREE_AGENT_TOKEN', 'ORGTREE_V2_TOKEN']:
            env.pop(key, None)
        for phase in ['seed', 'verify']:
            subprocess.run([sys.executable, str(Path(__file__).resolve()), '--repo', str(repo),
                            '--root', str(root), '--phase', phase], env=env, cwd=repo,
                           check=True, timeout=120)
        print((root / 'manifest.json').read_text(encoding='utf-8'))
        return

    # Assert isolation before the first storage import in either child process.
    for key, expected in [('ORGTREE_DATA', root / 'data'), ('HOME', root / 'home'), ('USERPROFILE', root / 'home')]:
        assert Path(os.environ[key]).resolve() == expected, key
    from orgtree import store, ledger, supervisor, appsettings, warmpool
    from fastapi.testclient import TestClient
    from orgtree import api
    assert Path(store.DATA_ROOT).resolve() == root / 'data'
    slug = 'history-acceptance'
    client = TestClient(api.app)  # Intentionally no context manager/lifespan/provider loops.
    if args.phase == 'seed':
        org = store.create_org(slug)
        org.hire('@user', None, 'haiku', 0, 'agent')
        org.hire('@user', None, 'haiku', 0, 'retired')
        ledger.now = lambda: '2026-09-07T20:00:00.000Z'
        def journal(nid, prefix, count):
            rows = [{'type': 'assistant', 'uuid': f'{prefix}-{i:03}', 'timestamp': ledger.now(),
                     'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': f'{prefix}-{i:03}'}]}}
                    for i in range(count)]
            supervisor._codex_journal(slug, org.node(nid)['session_id'], rows)
        journal('agent', 'PRIOR', 105)
        assert org.cheap_compact('@user', 'agent')['bearer'] == 'agent@0'
        journal('agent', 'CURRENT', 105)
        journal('retired', 'RETIRED', 105)
        org.retire('@user', 'retired')
        docs = []
        for i in range(105):
            body = f'# History document {i:03}\n\nSynthetic retained document DOC-{i:03}.\n'
            docid = org.present_document('agent', f'DOC-{i:03}', body)['presented']
            docs.append({'id': docid, 'title': f'DOC-{i:03}', 'body': body})
        for i in range(115):
            org.to_user_inbox({'from': 'agent', 'body': f'READ-MAIL-{i:03}', 'kind': 'message', 'at': ledger.now()})
        mailids = [row['id'] for row in org.d['user_inbox'] if row['body'].startswith('READ-MAIL-')]
        store.save_org(org)
        response = client.post(f'/api/orgs/{slug}/inbox/read', json={'ids': mailids})
        assert response.status_code == 200 and response.json()['read'] == 115, response.text
        # Keep the subsequent actual application provider-free too.
        warmpool.set_enabled(False)
        appsettings.set_working_checkups_enabled(False)
        appsettings.set_idle_docket_reminders_enabled(False)
        appsettings.set_git_periodic_fetch_enabled(False)
        for provider in appsettings.PROVIDERS:
            appsettings.set_provider_enabled(provider, False)
        manifest = {
            'root': str(root), 'repo': str(repo), 'org': slug,
            'environment': {key: os.environ[key] for key in ['ORGTREE_DATA','HOME','USERPROFILE','ORGTREE_STORE','ORGTREE_V2','PYTHONPATH']},
            'documents': docs,
            'read_mail_ids_oldest_first': mailids,
            'history_limit_50': {'documents': [['DOC-104','DOC-055'],['DOC-054','DOC-005'],['DOC-004','DOC-000']],
                                 'user-mail': [['READ-MAIL-114','READ-MAIL-065'],['READ-MAIL-064','READ-MAIL-015'],['READ-MAIL-014','READ-MAIL-000']]},
            'gallery_limit_100': [['DOC-104','DOC-005'],['DOC-004','DOC-000']],
            'chat_sources': {'agent': 'CURRENT', 'agent@0': 'PRIOR', 'retired': 'RETIRED'},
            'chat_limit_50': [[104,55],[54,5],[4,0]],
            'notes': ['All timestamps deliberately tied; ordering must use retained insertion sequence.',
                      'Providers, warming and recurring reminders disabled in fixture settings.',
                      'No engine lifespan or provider process starts while seeding/verifying.',
                      'Start the app with the printed environment and explicit synthetic data root.']}
        (root / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print('Seeded through production ledger, read-mail API and journal writer.')
    else:
        m = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        def pages(section, field, node=''):
            cursor = ''; boundaries = []; count = 0
            while True:
                r = client.get(f'/api/orgs/{slug}/history/{section}', params={'node':node,'limit':50,'cursor':cursor})
                assert r.status_code == 200, r.text
                p = r.json(); rows = p['items']; assert 0 < len(rows) <= 50
                boundaries.append([rows[0][field], rows[-1][field]]); count += len(rows)
                cursor = p['next_cursor']
                if not cursor:
                    assert count == p['total']; return boundaries
        for section, field in [('documents','title'),('user-mail','body')]:
            assert pages(section,field) == m['history_limit_50'][section]
        sources = {r['id']: r for r in client.get(f'/api/orgs/{slug}/history').json()['nodes']}
        assert sources['agent']['generation'] == 1 and sources['agent']['state'] == 'live'
        assert sources['agent@0']['generation'] == 0 and sources['agent@0']['state'] == 'archived'
        assert sources['retired']['state'] == 'archived'
        for node, prefix in m['chat_sources'].items():
            assert pages('chat','text',node) == [[f'{prefix}-{a:03}', f'{prefix}-{b:03}'] for a,b in m['chat_limit_50']]
        for offset, expected in [(0,100),(100,5)]:
            rows = client.get(f'/api/orgs/{slug}/documents',params={'offset':offset}).json()['documents']
            assert len(rows) == expected
            assert [rows[0]['title'],rows[-1]['title']] == m['gallery_limit_100'][offset//100]
        oldest = m['documents'][0]
        assert client.get(f'/api/orgs/{slug}/documents/{oldest["id"]}').json()['body'] == oldest['body']
        org = store.load_org(slug)
        assert len(org.tree()['roots'][0]['documents']) == 10
        assert not org.d.get('user_inbox'), 'all synthetic user mail must already be read'
        m['verified_after_restart'] = True
        (root / 'manifest.json').write_text(json.dumps(m, indent=2), encoding='utf-8')
        print('Fresh verifier process: exact three-page boundaries, lineage, gallery overflow and old body PASS.')


if __name__ == '__main__':
    main()
