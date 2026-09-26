"""scale (hot-paths-off-full-org-reads-child-env-net-polle): `agentauth.child_env`
reads the ONE node row it needs (`store.read_node`), not a whole-org snapshot
per agent spawn.

  * SAME TOKEN: for every seat of a mixed org, the token equals the one built
    from the constructed org view (`orgtx.org_read(...).node(nid)`, the old
    read).
  * NO WHOLE-ORG READ on the row path: `orgtx.org_read`, `store.load_org`
    and `store.load_org_snapshot` are patched to fail, and child_env still
    answers.
  * FALLBACKS keep the old read: a stored row with no `seat_id` (a pre-P04a
    document, which `Org.__init__` backfills from lineage) gets the
    backfilled seat, exactly as before; an unknown node raises what the old
    read raised; when the row read has no answer (None), org_read is used.
  * A DOC_LOCK holder still reads the resident document (unchanged branch).

Run:  python tools/run-python-verification.py tests/test_child_env_row_read.py
"""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-childenv-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import agentauth, ledger, orgtx, store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule() -> None:
    root.cleanup()


def boom(*a, **k):
    raise AssertionError('child_env read the whole org')


class ChildEnvRowRead(unittest.TestCase):
    seq = 0

    @classmethod
    def setUpClass(cls) -> None:
        agentauth.enable()

    def setUp(self) -> None:
        type(self).seq += 1
        self.slug = f'ce{self.seq}'
        org = store.create_org(self.slug)
        org.hire(USER, None, 'haiku', 10, 'top')
        kw = dict(add_dirs=[], tools=TOOLS, org_visibility='team', charter='a test agent')
        for i in range(6):
            org.hire('top', 'top', 'haiku', 0, f'a{i}', **kw)
        store.save_org(org)
        self.ids = ['top'] + [f'a{i}' for i in range(6)]

    def old(self, nid: str) -> dict:
        n = orgtx.org_read(self.slug).node(nid)
        return agentauth.child_env(self.slug, nid,
                                   generation=int(n.get('generation', 0)),
                                   seat_id=str(n.get('seat_id') or ''))

    def test_same_token_as_the_org_view(self) -> None:
        for nid in self.ids:
            self.assertEqual(agentauth.child_env(self.slug, nid), self.old(nid), nid)
            self.assertTrue(agentauth.child_env(self.slug, nid)['ORGTREE_AGENT_TOKEN'])

    def test_row_path_reads_no_whole_org(self) -> None:
        want = {nid: self.old(nid) for nid in self.ids}
        with patch.object(orgtx, 'org_read', boom), \
                patch.object(store, 'load_org', boom), \
                patch.object(store, 'load_org_snapshot', boom):
            for nid in self.ids:
                self.assertEqual(agentauth.child_env(self.slug, nid), want[nid], nid)

    def test_a_row_without_seat_id_gets_the_backfilled_seat(self) -> None:
        # a pre-P04a row: strip seat_id from the STORED row only
        db = store._db_path(self.slug)
        store._POOL.close_all(self.slug)
        c = sqlite3.connect(db)
        val = json.loads(c.execute("SELECT val FROM nodes WHERE id='a2'").fetchone()[0])
        val.pop('seat_id', None)
        c.execute("UPDATE nodes SET val=? WHERE id='a2'", (json.dumps(val),))
        c.commit()
        c.close()
        store._invalidate_snapshot(self.slug)
        self.assertIsNone(store.read_node(self.slug, 'a2').get('seat_id'))
        backfilled = orgtx.org_read(self.slug).node('a2').get('seat_id')
        self.assertTrue(backfilled, 'fixture: the org view did not backfill')
        tok = agentauth.child_env(self.slug, 'a2')['ORGTREE_AGENT_TOKEN']
        self.assertEqual(agentauth.verify(tok)[3], backfilled)

    def test_unknown_node_raises_what_the_old_read_raised(self) -> None:
        with self.assertRaises(Exception) as old:
            orgtx.org_read(self.slug).node('nobody')
        with self.assertRaises(type(old.exception)):
            agentauth.child_env(self.slug, 'nobody')

    def test_no_row_answer_falls_back_to_org_read(self) -> None:
        with patch.object(store, 'read_node', return_value=None):
            self.assertEqual(agentauth.child_env(self.slug, 'a1'), self.old('a1'))

    def test_doc_lock_holder_reads_the_resident_document(self) -> None:
        calls = []
        real = store.load_org

        def spy(slug, *a, **k):
            calls.append(slug)
            return real(slug, *a, **k)
        with store.DOC_LOCK, patch.object(store, 'load_org', spy):
            agentauth.child_env(self.slug, 'a3')
        self.assertEqual(calls, [self.slug])


if __name__ == '__main__':
    unittest.main()
