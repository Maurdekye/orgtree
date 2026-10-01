"""The tree header's resolved-request history is the MOST RECENTLY RESOLVED.

Docket v3-an-answered-question-vanishes-from-the-inbox (review-astra F1 on
bc8a04b): the header kept the last ASK_HISTORY_KEEP resolved requests by
CREATION order, and the inbox the last eight of those. A question left open a
while and answered now fell out of both as soon as enough later-created
requests had been resolved before it, so the user's answered entry vanished
from the inbox on its own. The history is now picked by `resolved_at`
(falling back to `at`), and is still emitted in source order.
"""
import os
from pathlib import Path
import tempfile
import unittest

root = tempfile.TemporaryDirectory(prefix='v3-ask-history-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=str(Path(root.name)), HOME=root.name, USERPROFILE=root.name,
                  ORGTREE_STORE='sqlite')

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store  # noqa: E402


def tearDownModule() -> None:
    root.cleanup()


class AskHistoryRecent(unittest.TestCase):
    def test_an_old_question_answered_last_is_kept(self) -> None:
        org = store.create_org('History')
        org.hire(ledger.USER, None, 'haiku', 0, 'alpha')
        keep = ledger.ASK_HISTORY_KEEP
        org.d['asks'] = (
            [{'id': 'old', 'node': 'alpha', 'status': 'answered', 'at': '2026-09-30T08:00:00Z',
              'resolved_at': '2026-09-30T12:00:00Z', 'question': 'answered last'}]
            + [{'id': f'n{i}', 'node': 'alpha', 'status': 'answered',
                'at': f'2026-09-30T09:{i:02d}:00Z', 'resolved_at': f'2026-09-30T10:{i:02d}:00Z',
                'question': f'resolved earlier {i}'} for i in range(keep + 5)]
            + [{'id': 'open', 'node': 'alpha', 'status': 'open', 'at': '2026-09-30T07:00:00Z',
                'question': 'still open', 'questions': [{'question': 'still open'}]}])
        ids = [a['id'] for a in org.tree()['asks']]
        self.assertIn('old', ids, 'the most recently resolved request is kept')
        self.assertIn('open', ids, 'open requests are never capped')
        resolved = [i for i in ids if i != 'open']
        self.assertEqual(len(resolved), keep)
        self.assertEqual(resolved, ['old'] + [f'n{i}' for i in range(6, keep + 5)],
                         'the newest-resolved, in source order')

    def test_no_resolved_at_falls_back_to_creation_order(self) -> None:
        org = store.create_org('History legacy')
        keep = ledger.ASK_HISTORY_KEEP
        org.d['asks'] = [{'id': f'a{i}', 'node': 'x', 'status': 'answered',
                          'at': f'2026-09-30T09:{i:02d}:00Z', 'question': 'q'} for i in range(keep + 3)]
        self.assertEqual([a['id'] for a in org.tree()['asks']], [f'a{i}' for i in range(3, keep + 3)])


if __name__ == '__main__':
    unittest.main()
