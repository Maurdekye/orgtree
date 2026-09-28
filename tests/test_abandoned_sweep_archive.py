"""The 20 s abandoned-ticket pass classifies the docket ARCHIVE by status
alone: closed archived bodies are never decoded, and a non-closed archived row
is still recovered exactly as before. PG-backed; missing PG is a skip."""
import copy
import time
import unittest
from unittest import mock

import test_pgstore as f
from orgtree import orgtx, store

OLD = "1970-01-01T00:16:40Z"


def tearDownModule(): f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class AbandonedSweepArchive(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    _n = 0

    def _org(self, archived_statuses, active_owner="a"):
        AbandonedSweepArchive._n += 1
        slug = f._fresh_org(f'sweep-{self._n}')
        org = store.load_org(slug)
        org.d['nodes']['a'].update(state='live', generation=1)
        org.d['nodes']['b'].update(state='live', generation=1, parent='a')
        org.d['nodes']['gone'] = {'id': 'gone', 'name': 'gone', 'parent': 'a',
                                  'children': [], 'state': 'archived', 'generation': 1}
        org.work_create('a', 'Live ticket', 'live', owner='b')
        base = org._work_active()[0]
        base['owner'] = {'node': active_owner, 'generation': 1}
        arch = []
        for i, st in enumerate(archived_statuses):
            it = copy.deepcopy(base)
            it.update(slug=f'arch-{i}', title=f'Arch {i}', status=st,
                      owner={'node': 'gone', 'generation': 1},
                      docket_at=OLD, updated_at=OLD, objective='x' * 4000)
            arch.append(it)
        org.d['work_items_archive'] = arch
        store.save_org(org)
        return slug

    def _dry(self, slug):
        org = orgtx.org_read(slug)
        moved = org.work_reassign_abandoned(now_ts=time.time())
        return org, sorted(m['assigned'] for m in moved)

    def test_closed_archive_is_never_decoded(self):
        slug = self._org(['done', 'dropped', 'superseded'] * 20)
        org, moved = self._dry(slug)
        self.assertEqual(moved, [])
        # the index answered, and the archive section was never materialised
        self.assertIsNotNone(org.d.archive_statuses())
        self.assertFalse(org.d.resident('work_items_archive'))

    def test_non_closed_archived_row_is_still_recovered(self):
        for st in ('open', 'waiting', 'in_progress', None):
            with self.subTest(status=st):
                slug = self._org(['done'] * 5 + [st] + ['dropped'] * 5)
                org, moved = self._dry(slug)
                self.assertEqual(moved, ['arch-5'])

    def test_fallback_without_index_answers_the_same(self):
        with mock.patch.object(store.LazyDoc, 'archive_statuses', return_value=None):
            slug = self._org(['done'] * 3)
            org, moved = self._dry(slug)
            self.assertEqual(moved, [])
            self.assertFalse(org.d.resident('work_items_archive'))
            slug = self._org(['done', 'blocked', 'done'])
            self.assertEqual(self._dry(slug)[1], ['arch-1'])


if __name__ == '__main__':
    unittest.main()
