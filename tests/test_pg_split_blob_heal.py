"""A pre-split `notices` blob on real PostgreSQL is converted before an
owner-scoped org_tx writes to it.

v3-user-message-to-an-agent-in-maurdekye-works-f: an org imported from v2
(pgimport copies doc rows as they are) and idle since still stored `notices`
as ONE whole-section row. The first `org_tx(sections=[("notices", nid)])`
made the save split it, which rewrote the container row the owner lock never
takes, and the commit failed: "wrote rows it did not lock: section
'notices'". The load-heal now converts the blob first.

Run:  python tools/run-python-verification.py tests/test_pg_split_blob_heal.py
"""
import json
import os
import unittest

import test_pgstore as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, orgtx, store

SEP = store.SPLIT_SEP


def tearDownModule():
    fixture.tearDownModule()


@unittest.skipUnless(fixture.ADMIN, 'disposable PG not configured: NOT RUN')
class PreSplitBlob(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('blob-' + self._testMethodName[:40].replace('_', '-'))
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 0, 'boss')
        store.save_org(org)

    def sql(self, fn):
        import psycopg
        with psycopg.connect(os.environ['ORGTREE_PG_URL'], autocommit=True) as conn:
            oid = conn.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                               (self.slug,)).fetchone()[0]
            return fn(conn, f'org_{int(oid)}')

    def rows(self):
        return self.sql(lambda conn, s: dict(conn.execute(
            f"SELECT key, val FROM {s}.doc WHERE key LIKE 'notices%%'").fetchall()))

    def set_blob(self, blob):
        """What a v2 import leaves: the whole section in the container row,
        no owner rows. Committed from outside, as another process would."""
        def put(conn, s):
            with conn.transaction():
                conn.execute(f"DELETE FROM {s}.doc WHERE key LIKE %s", ('notices' + SEP + '%',))
                conn.execute(f"INSERT INTO {s}.doc(key, val) VALUES ('notices', %s) "
                             "ON CONFLICT (key) DO UPDATE SET val = excluded.val",
                             (json.dumps(blob),))
                conn.execute("UPDATE public.orgs SET revision=revision+1 WHERE slug=%s",
                             (self.slug,))
        self.sql(put)
        store.external_change(self.slug)
        self.assertEqual(set(self.rows()), {'notices'})

    def test_an_owner_scoped_write_on_a_blob_converts_it_and_lands(self):
        self.set_blob({'boss': [{'at': 't0', 'text': 'old'}]})    # the live shape
        with orgtx.org_tx(self.slug, sections=[('notices', 'boss')]) as tx:
            tx.d['notices']['boss'].append({'at': 't1', 'text': 'new'})
        rows = self.rows()
        self.assertEqual(rows['notices'], '{}')
        self.assertEqual([n['text'] for n in json.loads(rows['notices' + SEP + 'boss'])],
                         ['old', 'new'])
        self.assertEqual([n['text'] for n in store.load_org(self.slug).d['notices']['boss']],
                         ['old', 'new'])

    def test_a_blob_without_the_owner_keeps_the_other_owners(self):
        self.set_blob({'other': [{'at': 't0', 'text': 'theirs'}]})
        with orgtx.org_tx(self.slug, sections=[('notices', 'boss')]) as tx:
            tx.d['notices'].setdefault('boss', []).append({'at': 't1', 'text': 'mine'})
        self.assertEqual(dict(store.load_org(self.slug).d['notices']),
                         {'other': [{'at': 't0', 'text': 'theirs'}],
                          'boss': [{'at': 't1', 'text': 'mine'}]})
        self.assertEqual(set(self.rows()),
                         {'notices', 'notices' + SEP + 'other', 'notices' + SEP + 'boss'})


if __name__ == '__main__':
    unittest.main()
