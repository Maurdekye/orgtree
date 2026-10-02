"""The org list (/api/orgs) reads no per-agent node documents, on real PostgreSQL.

org-list-api-orgs-reads-grow-with-agent-count: the listing used to fetch the
full document of every active node per org on every 3 s poll. It must now read
a fixed number of rows per org and return exactly what the full-org computation returns.
"""
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
DBNAME = f'orgtree_org_list_t{os.getpid()}'
fixture = tempfile.TemporaryDirectory(prefix='orgtree-org-list-')
os.environ['ORGTREE_DATA'] = str(Path(fixture.name) / 'data')
os.environ['HOME'] = str(Path(fixture.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'org-list-test-only'
if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE {DBNAME}')
    url = urlsplit(ADMIN)
    os.environ['ORGTREE_PG_URL'] = urlunsplit((url.scheme, url.netloc, '/' + DBNAME, url.query, url.fragment))
    os.environ['ORGTREE_STORE'] = 'postgres'

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
load_app()
from orgtree import api, ledger, org_summary, store

slugs = []
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


@unittest.skipUnless(ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class OrgList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from orgtree import pgstore
        pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    def make_org(self, agents, *, shapes=False):
        """An org with `agents` live workers under two top-level seats; with
        `shapes`, also a retired seat, a compacted predecessor and a reseeded
        (lost) predecessor, and a top-level seat left unrecoverable."""
        slug = 'list-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 50, 'lead-a')
        org.hire(ledger.USER, None, 'haiku', 40, 'lead-b')
        for i in range(agents):
            lead = 'lead-a' if i % 2 else 'lead-b'
            org.hire(lead, lead, 'haiku', 0, f'w{i:03d}', add_dirs=[], tools=NO_TOOLS,
                     org_visibility='self', charter='fixture worker')
        if shapes:
            org.hire(ledger.USER, None, 'haiku', 0, 'gone')
            org.retire(ledger.USER, 'gone')
            org.compact_split('w000', str(uuid.uuid4()))
            org.node('w001')['state'] = 'unrecoverable'
            org.reseed(ledger.USER, 'w001', str(uuid.uuid4()))
            org.node('lead-b')['state'] = 'unrecoverable'
        store.save_org(org)
        return slug

    def reference(self, slug):
        """The full-org answer the listing must equal."""
        org = store.load_org(slug)
        active = {k: n for k, n in org.nodes.items() if n['state'] != 'archived'}
        return sum(n['state'] == 'live' for n in active.values())

    def listed(self, slug):
        return next(row for row in api.orgs_list(None) if row['slug'] == slug)

    def test_rows_equal_the_full_org_answer_for_every_node_shape(self):
        slug = self.make_org(6, shapes=True)
        live = self.reference(slug)
        row = self.listed(slug)
        self.assertEqual(row['live'], live)
        self.assertGreater(live, 0, 'control: live nodes exist')

    def test_every_node_creation_path_writes_a_state(self):
        """Ruling (b): node_index counts a node without `state` as live, so no
        creation path may make one. hire, retire, compact_split, reseed and
        record_cli_compaction's predecessor copies are all exercised."""
        slug = self.make_org(4, shapes=True)
        org = store.load_org(slug)
        org.record_cli_compaction('w002', bearer_sid='bearer-' + uuid.uuid4().hex)
        store.save_org(org)
        org = store.load_org(slug)
        kinds = {n.get('state') for n in org.nodes.values()}
        self.assertTrue({'live', 'archived', 'unrecoverable'} <= kinds, kinds)
        missing = [nid for nid, n in org.nodes.items() if 'state' not in n]
        self.assertEqual(missing, [])
        self.assertEqual(self.listed(slug)['live'], self.reference(slug))

    def counted_reads(self, slug):
        """Rows and value bytes the listing request itself fetched for this
        org. Only this thread counts, like the preflight's per-request
        counters: the storage walk it may start runs in a background thread
        and reads no node rows (workspace/scratch/sandbox paths only)."""
        import json
        import threading
        import psycopg
        seen = {'rows': 0, 'bytes': 0}
        me = threading.get_ident()
        original = {n: getattr(psycopg.Cursor, n) for n in ('fetchone', 'fetchall', 'fetchmany')}

        def wrap(name):
            def fetch(self_cur, *a, **k):
                out = original[name](self_cur, *a, **k)
                if threading.get_ident() != me:
                    return out
                rows = ([out] if out is not None else []) if name == 'fetchone' else out
                seen['rows'] += len(rows)
                seen['bytes'] += sum(len(v.encode()) if isinstance(v, str) else len(json.dumps(v, default=str))
                                     for row in rows for v in row if v is not None)
                return out
            return fetch
        from unittest.mock import patch
        with patch.object(store, 'org_slugs', return_value=[slug]), \
             patch.object(store, '_load_lazy',
                          side_effect=AssertionError('control: listing fell back to a whole-org load')), \
             patch.multiple(psycopg.Cursor, **{n: wrap(n) for n in original}):
            api.orgs_list(None)
        return seen

    def test_listing_reads_do_not_grow_with_agents(self):
        small = self.counted_reads(self.make_org(5))
        large = self.counted_reads(self.make_org(50))
        self.assertGreater(small['rows'], 0, 'control: the listing read rows')
        self.assertEqual(large['rows'], small['rows'], (small, large))
        self.assertLess(large['bytes'], small['bytes'] * 1.5, (small, large))


def tearDownModule():
    for slug in slugs:
        store._POOL.close_all(slug)
    if ADMIN:
        from orgtree import pgstore
        pgstore.close_idle()
        with psycopg.connect(ADMIN, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE {DBNAME} WITH (FORCE)')
    fixture.cleanup()


if __name__ == '__main__':
    unittest.main()
