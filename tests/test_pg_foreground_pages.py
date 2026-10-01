"""Foreground page reads (children, search, lookup) reuse what has not moved.

A page used to rebuild its whole context per request. Now its inputs are
reused under the committed revision that covers them (view_revision for the
settings/list/window/inbox rows, node_revision for funding), and a finished
answer is remembered for the exact committed stamp, runtime stamp and sync
revision it was built from, until the context's clock deadline. Every test
here compares a warm answer against a cold build of the same state.
"""
import copy
import time
import types
import unittest
from unittest.mock import patch

import test_pgstore as fixture
from fastapi.testclient import TestClient
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import TokenGate
from orgtree import api, foreground_api, foreground_cache, foreground_context, foreground_store, ledger, store


def tearDownModule():
    fixture.tearDownModule()


def _clear():
    with foreground_api._page_lock:
        foreground_api._pages.clear()
        foreground_api._page_inputs.clear()
        foreground_api._page_funding.clear()
    foreground_cache._cache.clear()


def _clock(fn):
    ns = {k: getattr(time, k) for k in dir(time) if not k.startswith('__')}
    ns['time'] = fn
    return types.SimpleNamespace(**ns)


@unittest.skipUnless(fixture.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ForegroundPagesPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        org = store.create_org('fg-pages-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'luna', 1000, 'boss', charter='Visible charter')
        for nid in ('a', 'b', 'r1', 'r2'):
            org.hire(ledger.USER, 'boss', 'luna', 10, nid)
        org.nodes['r1']['state'] = 'archived'
        org.nodes['r2']['state'] = 'archived'
        self.org_d = org.d
        store.save_org(ledger.Org(copy.deepcopy(org.d)))
        self.client = TestClient(TokenGate(api.app, 'fg-pages'))
        self.headers = {'X-Orgtree-Desktop-Token': 'fg-pages', 'Accept-Encoding': 'identity'}
        self.base = f'/api/orgs/{self.slug}/foreground-tree'
        self.runtime = ['one']
        self.clock = None
        _clear()
        self.addCleanup(_clear)

    def get(self, suffix, **headers):
        clock = _clock(self.clock if self.clock is not None else time.time)
        with patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: tuple(self.runtime)), \
                patch.object(foreground_context, 'time', clock), patch.object(ledger, '_time', clock):
            return self.client.get(self.base + suffix, headers={**self.headers, **headers})

    def cold(self, suffix):
        _clear()
        return self.get(suffix)

    def save(self, change):
        org = store.load_org(self.slug)
        change(org)
        store.save_org(org)

    PAGES = ('/children?parent=boss&limit=1', '/search?q=r&limit=5', '/lookup/r2')

    def test_a_repeated_page_and_its_304_build_nothing(self):
        for suffix in self.PAGES:
            first = self.get(suffix)
            self.assertEqual(first.status_code, 200, (suffix, first.text))
            with patch.object(foreground_context, 'build',
                              side_effect=AssertionError('page rebuilt without a change')), \
                    patch.object(foreground_store, '_graph',
                                 side_effect=AssertionError('page graph re-read without a change')):
                again = self.get(suffix)
                self.assertEqual((again.status_code, again.content, again.headers['etag']),
                                 (200, first.content, first.headers['etag']), suffix)
                same = self.get(suffix, **{'If-None-Match': first.headers['etag']})
                self.assertEqual(same.status_code, 304, suffix)
                self.assertEqual(same.headers['etag'], first.headers['etag'])
                gz = self.get(suffix, **{'Accept-Encoding': 'gzip'})
                self.assertEqual(gz.content, first.content, suffix)
            self.assertEqual(first.content, self.cold(suffix).content, suffix)

    def test_warm_answers_equal_a_cold_build_after_each_kind_of_write(self):
        url = self.PAGES[0]
        before = self.get(url)
        self.assertEqual(before.status_code, 200, before.text)
        reads = []
        real = foreground_store.read_funding

        def counted(raw):
            reads.append(1)
            return real(raw)

        def check(label, *, funding_reads=None, changed=True):
            reads.clear()
            with patch.object(foreground_store, 'read_funding', side_effect=counted):
                warm = self.get(url)
            self.assertEqual(warm.status_code, 200, (label, warm.text))
            if funding_reads is not None:
                self.assertEqual(len(reads), funding_reads, label)
            cold = self.cold(url)
            self.assertEqual(warm.content, cold.content, label)
            if changed:
                self.assertNotEqual(warm.content, check.last, label + ': the write never reached the page')
            check.last = warm.content
        check.last = before.content

        # a node row: status on the page's ancestor
        self.save(lambda org: org.nodes['boss'].__setitem__(
            'last_status', {'status': 'working', 'summary': 'moved'}))
        check('status')
        # a node row OFF the page that only funding carries: the ancestor's free budget
        self.save(lambda org: org.nodes['a'].__setitem__('grant', 300))
        check('sibling grant', funding_reads=1)
        # a direct committed doc write: view_revision moves, node_revision does not
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.raw.execute("UPDATE doc SET val=%s WHERE key='name'", ('"renamed directly"',))
            conn.execute('COMMIT')
        check('direct doc write', funding_reads=0, changed=False)
        # doc writes the page's cards DO show (effort_effective): the reused
        # inputs must end with view_revision, through a save and through SQL
        self.save(lambda org: org.d.__setitem__('default_effort', 'max'))
        check('saved setting')
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.raw.execute("UPDATE doc SET val=%s WHERE key='default_effort'", ('"low"',))
            conn.execute('COMMIT')
        check('direct setting write', funding_reads=0)
        # a runtime-only change: nothing committed, the answer is rebuilt
        self.runtime = ['two']
        with patch.object(foreground_context, 'build', wraps=foreground_context.build) as build:
            self.get(url)
        self.assertEqual(build.call_count, 1, 'runtime change served a remembered page')

    def test_remembered_page_ends_at_the_context_clock_deadline(self):
        t0 = time.time()
        self.save(lambda org: org.d.__setitem__(
            'fable_lock', {'at': ledger.now(), 'detail': 'probe', 'until_ts': t0 + 600}))
        _clear()
        url = self.PAGES[0]
        self.clock = lambda: t0
        warm = self.get(url)
        self.assertEqual(warm.status_code, 200, warm.text)
        self.clock = lambda: t0 + 1200
        kept = self.get(url)
        control = self.cold(url)
        # control: expiry really changes what a fresh build answers
        self.assertNotEqual((control.status_code, control.content), (warm.status_code, warm.content),
                            'expiry changed nothing: probe inert')
        self.assertEqual((kept.status_code, kept.content), (control.status_code, control.content))

    def test_public_and_operator_answers_are_kept_apart(self):
        self.save(lambda org: org.nodes['boss'].__setitem__('session_id', 'private-session'))
        _clear()
        url = self.PAGES[0]
        public = TestClient(api.PublicGateway(api.app))
        with patch.object(api, '_kiosk_token_map', return_value={'testtoken': self.slug}), \
                patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: tuple(self.runtime)):
            shown = public.get(f'/k/testtoken{self.base}{url}', headers={'Accept-Encoding': 'identity'})
        self.assertEqual(shown.status_code, 200, shown.text)
        self.assertNotIn('session_id', shown.json()['nodes']['boss'])
        operator = self.get(url)
        self.assertEqual(operator.content, self.cold(url).content)
        self.assertEqual(operator.json()['nodes']['boss'].get('session_id'), 'private-session')
        with patch.object(api, '_kiosk_token_map', return_value={'testtoken': self.slug}), \
                patch.object(api, '_tree_runtime_stamp', side_effect=lambda slug: tuple(self.runtime)):
            again = public.get(f'/k/testtoken{self.base}{url}', headers={'Accept-Encoding': 'identity'})
        self.assertEqual(again.content, shown.content)

    def test_funding_is_read_as_the_four_index_fields(self):
        with store._POOL.acquire(self.slug) as conn:
            conn.use()
            conn.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                rows = foreground_store.read_funding(conn.raw)
                whole = [{'id': nid, **{k: meta[k] for k in ('parent', 'state', 'model', 'grant')}}
                         for nid, meta in conn.raw.execute(
                             "SELECT id,meta FROM node_index WHERE meta->>'state'<>'archived' "
                             'ORDER BY ord,id').fetchall()]
            finally:
                conn.raw.execute('ROLLBACK')
        self.assertEqual(rows, whole)
        self.assertEqual({r['id'] for r in rows}, {'boss', 'a', 'b'})


if __name__ == '__main__':
    unittest.main()
