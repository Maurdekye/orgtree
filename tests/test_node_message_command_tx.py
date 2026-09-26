"""fence-off S2: a slash command sent to an agent is one row transaction.

`node_message`'s command branch used to run in `store.write_org` (DOC_LOCK and
a whole-document save). It is now `mailtx.org_of` on `mailtx.send_rows(nid)`:
the rows `user_deep_reach` writes (every superior's notice row and the user
audience). What must hold:

  1. no DOC_LOCK is taken (a DOC_LOCK that raises proves it, fence off);
  2. the superior chain is told and the audience granted, committed;
  3. on a HALTED node the command's `send_message` runs AFTER the commit,
     outside any transaction, exactly once (p01 d / lead C2);
  4. CHANGED FAILURE BEHAVIOUR, pinned: if that send raises, the notices
     stay committed, the failure is still an ERROR STATUS (502; an
     HTTPException passes through unchanged), and the send is not retried.

Run:  python tools/run-python-verification.py tests/test_node_message_command_tx.py
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='node-message-command-tx-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import api, ledger, orgtx, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class _NoDocLock:
    def _boom(self, *a, **k):
        raise AssertionError('DOC_LOCK was taken')
    acquire = __enter__ = _boom

    def __exit__(self, *a):
        return False

    def release(self):
        raise AssertionError('DOC_LOCK was released without being taken')

    def _is_owned(self):
        return False


class CommandTx(unittest.TestCase):
    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:60]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'top')
        org.hire(ledger.USER, 'top', 'haiku', 0, 'deep')
        store.save_org(org)
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        self.addCleanup(store._POOL.close_all, self.slug)
        for p in (patch.object(api, 'hub_changed', create=True),
                  patch.object(supervisor, 'immediate_command', return_value=True)):
            p.start()
            self.addCleanup(p.stop)

    def halt(self):
        with orgtx.org_tx(self.slug, nodes=['deep']) as tx:
            tx.org.node('deep')['halt'] = {'at': 'now', 'by': ledger.USER}

    def reached(self):
        org = orgtx.org_read(self.slug)
        top = [x for x in (org.d.get('notices') or {}).get('top') or []
               if (x.get('ev') or {}).get('variant') == 'context.deep_reach']
        audience = [(a['grantee'], a['grantor']) for a in org.d.get('audiences') or []]
        return len(top), ('deep', ledger.USER) in audience

    def test_a_command_takes_no_doc_lock_and_commits_the_deep_reach(self):
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            r = api.node_message(self.slug, 'deep', api.Message(text='/context'))
        self.assertTrue(r.get('immediate'), r)
        self.assertEqual(self.reached(), (1, True))

    def test_a_halted_nodes_send_runs_once_after_the_commit(self):
        self.halt()
        seen = []

        def send(slug, nid, text, **kw):
            # the transaction is closed and the notices are already durable
            seen.append((orgtx.current_tx(slug), self.reached(), text, kw))
            return {'accepted': True, 'queued': 0, 'held': True}
        with patch.object(supervisor, 'send_message', side_effect=send), \
                patch.object(store, 'DOC_LOCK', _NoDocLock()):
            r = api.node_message(self.slug, 'deep', api.Message(text='/context'))
        self.assertEqual(r, {'accepted': True, 'queued': 0, 'held': True})
        self.assertEqual(len(seen), 1, 'the command was not sent exactly once')
        tx, reached, text, kw = seen[0]
        self.assertIsNone(tx, 'send_message ran inside the row transaction')
        self.assertEqual(reached, (1, True), 'the notices were not committed before the send')
        self.assertEqual((text, kw), ('/context', {'command': True}))

    def test_a_failed_send_keeps_the_notices_and_is_an_error(self):
        """The CHANGED failure behaviour, pinned: the deep reach is durable,
        the failure is an error status (never a 200 the composer would read
        as 'command sent'), and nothing is retried."""
        self.halt()
        with patch.object(supervisor, 'send_message',
                          side_effect=RuntimeError('boom')) as send:
            with self.assertRaises(api.HTTPException) as e:
                api.node_message(self.slug, 'deep', api.Message(text='/context'))
        self.assertEqual(send.call_count, 1)
        self.assertEqual(e.exception.status_code, 502)
        self.assertIn('the command was not delivered: boom', e.exception.detail)
        self.assertEqual(self.reached(), (1, True))

    def test_a_refusal_from_the_send_passes_through_unchanged(self):
        self.halt()
        refusal = api.HTTPException(409, 'refused by the send')
        with patch.object(supervisor, 'send_message', side_effect=refusal):
            with self.assertRaises(api.HTTPException) as e:
                api.node_message(self.slug, 'deep', api.Message(text='/context'))
        self.assertIs(e.exception, refusal)
        self.assertEqual(self.reached(), (1, True))

    def test_refusals_still_write_nothing(self):
        with orgtx.org_tx(self.slug, nodes=['deep']) as tx:
            tx.org.node('deep')['frozen'] = True
        with self.assertRaises(api.HTTPException) as e:
            api.node_message(self.slug, 'deep', api.Message(text='/context'))
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(self.reached(), (0, False))


if __name__ == '__main__':
    unittest.main()
