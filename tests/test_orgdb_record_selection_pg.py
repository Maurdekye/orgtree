"""Real selection queries and mounted renderer parity on a disposable org."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree import api, ledger
from orgtree.orgdb import record_reads as Q, record_tree as T, record_runtime as R
from orgtree.orgdb import record_selection as S
from orgtree.orgdb.record_registry import Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class SelectionParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def seed(slug):
            org = fixture.store.load_org(slug)
            for n in range(300):
                name = f'pinned-{n:03}'
                org.nodes[name] = {**fixture.node(name, 'boss'), 'state': 'archived',
                    'session_id': 'selection-'+name, 'bearer_state': None,
                    'ui_order': n % 11, 'title': 'Archive '+str(n)}
            for name, node in org.nodes.items():
                node.setdefault('session_id', 'selection-'+name)
                node.setdefault('bearer_state', None)
            for ask in org.d['asks']:
                ask['questions'] = [{'id': 'question-1', 'question': ask['question']}]
            fixture.store.save_org(org)
        cls.twin = fixture.Twins('record selection parity', seed)
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]
        cls.clock = R.HostClock()

    def legacy(self, state):
        # Every converted row is decoded on the record reader's connection.
        # The unchanged full-tree producer therefore observes EXACTLY R, even
        # if a concurrent writer commits after this snapshot was established.
        doc = fixture.sections.decode_document(fixture.rowio.read(state.raw),
            fixture.mappers.sections(), fixture.sections.Context())
        org = ledger.Org(doc)
        tree = api._annotate_org_view(org, org.tree(), SimpleNamespace(state=SimpleNamespace()))
        tree['org_rev'] = Q.cursor(state).rev
        return tree

    def packet(self, state, selections):
        registry = T.register(Registry())
        baseline = Q.baseline(registry, state)
        pages = [page for selection in selections
                 for page in Q.subscribed_pages(registry, state, selection, page_records=37)]
        held = Q.records(registry, state, (Selection(), *selections))
        bodies = {row['id']: row['body'] for row in held if row['entity'] == 'agent'}
        models = next(row['body']['models'] for row in held if row['entity']=='org' and row['id']=='tiers')
        overlay = R.AgentOverlays(Q.cursor(state).org_uuid, Q.cursor(state).incarnation, clock=self.clock)
        overlay.catalog_changed(models, {})
        overlay.update(bodies)
        return dict(baseline=baseline, pages=pages, runtime=overlay.full(), expected=self.legacy(state))

    def test_real_name_search_queries_and_mounted_full_display_at_same_revision(self):
        names = [f'pinned-{n:03}' for n in range(300)]
        with fixture.storage(True), ExitStack() as stack:
            stack.enter_context(patch.object(api.registry, 'list_accounts', return_value=[]))
            stack.enter_context(patch.object(api.registry, 'resolve_alias', return_value=None))
            stack.enter_context(patch('orgtree.registry_migration.observe_ambient', return_value={}))
            stack.enter_context(patch.object(fixture.store, 'local_net_slugs', return_value=set()))
            stack.enter_context(patch.object(api.supervisor, 'cache_forecast_public', return_value=None))
            stack.enter_context(patch.object(api.warmpool, 'process_control_status', return_value={}))
            resolved = S.resolve(self.twin.copy, (*names, 'absent'), dict(query='pinned-', state='archived'))
            self.assertEqual(resolved['missing'], ['absent'])
            self.assertEqual(set(resolved['names']), set(names))
            self.assertEqual(set(resolved['matches']), set(resolved['names'].values()))
            with Q.snapshot(self.twin.copy) as state:
                self.assertEqual(resolved['cursor'], Q.cursor(state).wire())
                boss = T._identities(state, ['boss'])['boss']
                ids = sorted(resolved['names'].values())
                split = tuple(Selection('sub:'+str(n+1), tuple(ids[offset:offset+128]))
                              for n, offset in enumerate(range(0, len(ids), 128)))
                cases = [dict(label='300 includes', selection=dict(include=names, hideRetired=False, fronts={}),
                    answer={**resolved, 'names': {k:v for k,v in resolved['names'].items() if k!='absent'},
                            'missing': [], 'matches': []}, inputs=[dict(agents=list(s.agents), windows=[]) for s in split],
                    **self.packet(state, split))]
                for label, selection, declarations, answer in (
                    ('browse all', dict(include=[], hideRetired=False, fronts={}, browse=dict(kind='all')),
                     (Selection('sub:1', windows=({'kind':'archived_all'},)),),
                     dict(cursor=Q.cursor(state).wire(), names={}, missing=[], matches=[])),
                    ('browse children', dict(include=[], hideRetired=False, fronts={}, browse=dict(kind='children',parent='boss')),
                     (Selection('sub:1',(boss,)), Selection('sub:2',windows=({'kind':'archived_under','parent':boss},))),
                     dict(cursor=Q.cursor(state).wire(), names={'boss':boss}, missing=[], matches=[])),
                ):
                    cases.append(dict(label=label, selection=selection, answer=answer,
                        inputs=[dict(agents=list(s.agents), windows=list(s.windows)) for s in declarations],
                        **self.packet(state, declarations)))
            # Keep the all-set declaration alive across actual committed state
            # changes. The mounted client gets only catch-ups, never a baseline.
            after = Q.Cursor(**cases[1]['baseline']['cursor'])
            changes = []
            with fixture.dbconn.connect(fixture.ADMIN, self.database) as raw:
                for new_state in ('live', 'archived'):
                    raw.execute('UPDATE orgtree.agents SET state=%s WHERE name=%s', (new_state, names[141]))
                    with Q.snapshot(self.twin.copy) as state:
                        declaration = Selection('sub:1', windows=({'kind':'archived_all'},))
                        frame = Q.catchup(T.register(Registry()), state, after,
                                          selections=(Selection(), declaration))
                        self.assertEqual(frame['type'], 'record_changes')
                        packet = self.packet(state, (declaration,))
                        changes.append(dict(frame=frame, runtime=packet['runtime'], expected=packet['expected']))
                        after = Q.cursor(state)
            cases[1]['changes'] = changes
            # A source fault cannot replace this fixture with mocked identities:
            # all pages and body fields below came from reached SQL at R.
            payload = dict(cases=cases, header_keys=sorted({key for keys in T.GROUPS.values() for key in keys}
                - {'retired_roots_total','retired_total'}), runtime_keys=sorted(R.AGENT_FIELDS))
            output = os.environ.get('ORGTREE_RECORD_SELECTION_OUTPUT')
            if output:
                Path(output).write_text(json.dumps(payload, ensure_ascii=True), encoding='utf-8')
            with tempfile.TemporaryDirectory(prefix='record-pg-selection-') as root:
                path = Path(root)/'fixture.json'
                path.write_text(json.dumps(payload, ensure_ascii=True), encoding='utf-8')
                env = {**os.environ, 'ORGTREE_RECORD_SELECTION_FIXTURE':str(path)}
                renderer = Path(__file__).resolve().parents[1]/'apps/desktop/renderer'
                result = subprocess.run(['node','tests/run.mjs','recordpgselection'], cwd=renderer,
                    env=env, capture_output=True, text=True, timeout=150, encoding='utf-8', errors='replace')
                print(result.stdout)
                self.assertEqual(result.returncode, 0, result.stdout+'\n'+result.stderr)
                self.assertRegex(result.stdout, r'(?:#|\u2139) pass 1\b')
                self.assertRegex(result.stdout, r'(?:#|\u2139) skipped 0\b')


if __name__ == '__main__':
    unittest.main()
