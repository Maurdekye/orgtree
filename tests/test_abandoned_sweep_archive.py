"""The 20 s abandoned-ticket pass classifies the docket ARCHIVE by status
alone: closed archived bodies are never decoded, and a non-closed archived row
is still recovered exactly as before. PG-backed; missing PG is a skip."""
import copy
import time
import unittest
from unittest import mock

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
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
        base.update(docket_at=OLD, updated_at=OLD)
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


    def test_recovery_pass_enumerates_identities_not_summaries(self):
        # the 20 s pass must not build `list_orgs()` summary rows (every node
        # row of every org); an active abandoned ticket is still recovered
        from orgtree import supervisor
        slug = self._org(['done'], active_owner='gone')
        with mock.patch.object(store, 'list_orgs',
                               side_effect=AssertionError('list_orgs on tick')),                 mock.patch.object(supervisor, 'send_message'),                 mock.patch.object(supervisor, 'mail_spark'):
            supervisor._abandoned_docket_recovery_pass(now=time.time())
        live = store.load_org(slug)._work_active()[0]
        self.assertEqual(live['owner']['node'], 'a')

    # -- abandoned-ticket-check-decodes-every-node-row-of -----------------
    def test_the_pending_check_answers_as_the_reassignment_does(self):
        cases = [(['done'], 'a'), (['done'], 'gone'), (['done', 'open'], 'a'),
                 (['dropped'], 'b')]
        for statuses, owner in cases:
            with self.subTest(statuses=statuses, owner=owner):
                slug = self._org(statuses, active_owner=owner)
                want = bool(self._dry(slug)[1])
                self.assertEqual(orgtx.org_read(slug).work_abandoned_pending(
                    now_ts=time.time()), want)
                self.assertEqual(store.load_runtime_org(slug).work_abandoned_pending(
                    now_ts=time.time()), want)
        # no live top-level node: nothing can move, whatever is stale
        slug = self._org(['done'], active_owner='gone')
        org = store.load_org(slug)
        org.d['nodes']['a']['state'] = 'archived'
        store.save_org(org)
        self.assertEqual(self._dry(slug)[1], [])
        self.assertFalse(orgtx.org_read(slug).work_abandoned_pending(now_ts=time.time()))

    def _retired_org(self, active_owner):
        slug = self._org(['done'], active_owner=active_owner)
        org = store.load_org(slug)
        for i in range(20):
            org.d['nodes'][f'r{i}'] = {'id': f'r{i}', 'name': f'r{i}', 'parent': 'a',
                                       'children': [], 'state': 'archived',
                                       'generation': 1, 'charter': 'c' * 500}
        store.save_org(org)
        with orgtx.org_tx(slug, nodes=['a']):
            pass                                  # stamps the heal epoch
        return slug

    def _pass(self, slug):
        from orgtree import supervisor
        decoded = []
        real = store.LazyNodesMap._decode

        def spy(nodes, nid, raw, index):
            if nodes._slug == slug:
                decoded.append(nid)
            return real(nodes, nid, raw, index)
        before = dict(store.LAZY_ROWS_STATS)
        with mock.patch.object(store.LazyNodesMap, '_decode', spy), \
                mock.patch.object(supervisor, 'send_message'), \
                mock.patch.object(supervisor, 'mail_spark'), \
                mock.patch.object(orgtx, 'org_read',
                                  side_effect=AssertionError('whole snapshot on tick')):
            supervisor._abandoned_docket_recovery_pass(now=time.time())
        fell = store.LAZY_ROWS_STATS.get('fallbacks', 0) - before.get('fallbacks', 0)
        return decoded, fell

    def test_a_quiet_pass_decodes_only_the_stale_items_owner_rows(self):
        with mock.patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True):
            slug = self._retired_org(active_owner='a')      # stale, owner live
            decoded, fell = self._pass(slug)
        self.assertEqual(sorted(set(decoded)), ['a'], decoded)
        self.assertEqual(fell, 0)
        self.assertEqual(store.load_org(slug)._work_active()[0]['owner']['node'], 'a')

    def test_a_pass_with_work_to_move_still_moves_it(self):
        with mock.patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True):
            slug = self._retired_org(active_owner='gone')
            self._pass(slug)
        self.assertEqual(store.load_org(slug)._work_active()[0]['owner']['node'], 'a')


if __name__ == '__main__':
    unittest.main()
