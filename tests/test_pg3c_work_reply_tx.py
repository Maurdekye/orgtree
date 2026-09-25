"""PG-3c: the user's reply on a docket item (POST /work-items/{wid}/reply)
runs as ONE row transaction on the item and the recipient's mail rows (lead
decision 18.6), not the DOC_LOCK cycle.

  * the reply goes through rcdoor.run_op (spied), the mail lands in the
    recipient's box and mail_log, and the reply clears a manual attention
    flag in the same commit;
  * a WRONG snapshot guess of the recipient (the reply is addressed to a
    participant the snapshot did not name) is corrected under the locks:
    the body's hold() widens, the transaction re-runs, and the mail still
    lands — exactly once;
  * CONTROL: the same reply with the `mail` row left out of the declaration
    and pgdoor's auto-widen switched off is refused (UnlockedWrite) and
    NOTHING lands.

Run:  python tools/run-python-verification.py tests/test_pg3c_work_reply_tx.py
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-pg3c-reply-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import ledger, orgtx, pgdoor, rcdoor, store, supervisor  # noqa: E402

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}


def tearDownModule() -> None:
    root.cleanup()


class WorkReplyTx(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        pgdoor.use_org_tx(None)
        WorkReplyTx.n += 1
        self.slug = f'pg3creply{WorkReplyTx.n}'
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 4, 'owner')
        org.hire('owner', 'owner', 'haiku', 0, 'helper', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='a participant')
        created = org.work_create('owner', 'Ship it', 'objective text', owner='owner',
                                  participants=['helper'])
        self.wid = created['slug'] if isinstance(created, dict) and 'slug' in created else created
        store.save_org(org)
        self.assertEqual(store.load_org(self.slug).work_identity_state(), 'slug',
                         'fixture: the org must take the row-transaction path')
        self.client = TestClient(app)
        self.enterContext(patch.object(supervisor, 'send_message', return_value={'accepted': True}))

    def _reply(self, **body):
        return self.client.post(f'/api/orgs/{self.slug}/work-items/{self.wid}/reply',
                                headers=HEADERS, json={'body': 'a reply', **body})

    def _landed(self, nid: str, text: str = 'a reply') -> int:
        d = store.load_org(self.slug).d
        return sum(1 for m in (d.get('mail') or {}).get(nid, [])
                   if text in str(m.get('body') or '') or text in str((m.get('ev') or {})))

    def test_reply_runs_on_one_row_transaction(self) -> None:
        real = rcdoor.run_op
        calls: list = []

        def spy(slug, spec, fn):
            calls.append(spec)
            return real(slug, spec, fn)

        with patch.object(rcdoor, 'run_op', spy):
            r = self._reply()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(calls), 1, 'the reply did not take the row-transaction path')
        self.assertIn('work_items', calls[0].sections)
        self.assertEqual(r.json()['to'], 'owner')
        self.assertEqual(self._landed('owner'), 1)

    def test_a_wrong_snapshot_guess_widens_and_lands_once(self) -> None:
        # the snapshot names nobody; the locked body resolves the addressed
        # participant and must widen to its rows
        with patch.object(rcdoor, 'reply_recipient_guess', lambda org, wid, to: None):
            r = self._reply(to='helper')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['to'], 'helper')
        self.assertEqual(r.json()['role'], 'participant')
        self.assertEqual(self._landed('helper'), 1, 'widened re-run must land the mail exactly once')

    def test_control_without_the_mail_row_nothing_lands(self) -> None:
        real = rcdoor.work_reply_rows

        def under(nid):
            s = real(nid)
            under.ran = True
            return pgdoor.TxSpec(nodes=s.nodes,
                                 sections=tuple(x for x in s.sections if x != 'mail'),
                                 share_nodes=s.share_nodes, share_sections=s.share_sections,
                                 logs=s.logs)

        under.ran = False
        pgdoor.use_org_tx(orgtx.org_tx, refused=lambda e: None)
        self.addCleanup(pgdoor.use_org_tx, None)
        client = TestClient(app, raise_server_exceptions=False)
        with patch.object(rcdoor, 'work_reply_rows', under):
            r = client.post(f'/api/orgs/{self.slug}/work-items/{self.wid}/reply',
                            headers=HEADERS, json={'body': 'must not land'})
        self.assertTrue(under.ran, 'the under-declared control never ran')
        self.assertEqual(r.status_code, 500, r.text)
        self.assertIn('UnlockedWrite', r.text)
        self.assertEqual(self._landed('owner', 'must not land'), 0,
                         'CONTROL FAILED AS DESIGNED: nothing may land')


if __name__ == '__main__':
    unittest.main()
