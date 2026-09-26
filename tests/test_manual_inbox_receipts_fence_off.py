"""fence-off S2: the manual inbox's fetch and chunk take no DOC_LOCK.

Every test of `test_manual_inbox_receipts` (the keyed fetch and chunk: admission,
receipts, replays, the witness) re-run with the transition fence OFF and
`supervisor.manual_fetch` / `supervisor.manual_fetch_chunk` wrapped so any
DOC_LOCK acquisition during either call fails the test. The behaviour those
tests pin (exact drains, reclaims, budget, chunking, save-failure outcomes)
must hold unchanged on the row transaction.

Run:  python tools/run-python-verification.py tests/test_manual_inbox_receipts_fence_off.py
"""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_manual_inbox_receipts as base  # noqa: E402  (sets this run's data root)

from orgtree import orgtx, store, supervisor as sup  # noqa: E402
import unittest  # noqa: E402

tearDownModule = base.tearDownModule


class _NoDocLock:
    def _boom(self, *a, **k):
        raise AssertionError('DOC_LOCK was taken by the manual inbox')
    acquire = __enter__ = _boom

    def __exit__(self, *a):
        return False

    def release(self):
        raise AssertionError('DOC_LOCK was released without being taken')

    def _is_owned(self):
        return False


def _tripwired(fn):
    def call(*a, **k):
        with patch.object(store, 'DOC_LOCK', _NoDocLock()):
            return fn(*a, **k)
    return call


class ManualInboxReceiptsFenceOff(base.ManualInboxReceiptTests):
    def setUp(self):
        super().setUp()
        fence = orgtx.TRANSITION_FENCE
        orgtx.TRANSITION_FENCE = False
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', fence)
        for name in ('manual_fetch', 'manual_fetch_chunk'):
            p = patch.object(sup, name, _tripwired(getattr(sup, name)))
            p.start()
            self.addCleanup(p.stop)


if __name__ == '__main__':
    unittest.main()
