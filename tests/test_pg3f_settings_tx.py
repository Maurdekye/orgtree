"""PG-3f: settings and admin writers on org_tx row transactions.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * each converted writer finishes while ANOTHER thread holds store.DOC_LOCK
    (the §3 rule: org_tx never waits on DOC_LOCK) — the negative control is
    that the old `with store.DOC_LOCK:` bodies would block here until the
    holder let go, and the test fails on that timeout;
  * each writer really locks its row: while another org_tx holds that
    section FOR UPDATE the writer waits, and a holder of an UNRELATED
    section does not stop it;
  * each writer's result is the same as before the conversion.

Converted so far: api._disk_doc_update (disk), api.org_net's two lazy
writes (net_identity/net_hubs/net_autoconnect, share kiosk; net_hubs),
net._record_hub_name (net_hubs), net._clear_registration (net_state).

Run:  python tools/run-python-verification.py tests/test_pg3f_settings_tx.py
"""

import os
from pathlib import Path
import tempfile
import threading
import types
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-pg3f-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_STEER_HOOK='0',
                  ORGTREE_PORT='7404', ORGTREE_PUBLIC_PORT='7404')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import api, net, orgtx, store  # noqa: E402

#: how long a writer may take when nothing it needs is held
FREE_S = 5.0
#: how long we watch a writer that SHOULD be blocked before calling it blocked
BLOCKED_S = 0.5

_n = 0


def _fresh_org(**sections) -> str:
    global _n
    _n += 1
    org = store.create_org(f'pg3f-{_n}')
    slug = org.d['slug']
    for k, v in sections.items():
        org.d[k] = v
    store.save_org(org)
    store.save_org(store.load_org(slug))
    return slug


def _doc(slug: str) -> dict:
    return store.load_org(slug).d


def _request() -> object:
    # admin listener: no public_slug on request.state
    return types.SimpleNamespace(state=types.SimpleNamespace())


class _Held:
    """Hold something (DOC_LOCK, or an org_tx on named rows) in a thread."""

    def __init__(self, cm_factory) -> None:
        self._entered = threading.Event()
        self._release = threading.Event()
        self._err: list[BaseException] = []

        def run() -> None:
            try:
                with cm_factory():
                    self._entered.set()
                    self._release.wait(30)
            except BaseException as e:            # noqa: BLE001
                self._err.append(e)
                self._entered.set()
        self._t = threading.Thread(target=run, daemon=True)

    def __enter__(self) -> '_Held':
        self._t.start()
        assert self._entered.wait(10), 'holder never entered'
        assert not self._err, self._err
        return self

    def __exit__(self, *a) -> None:
        self._release.set()
        self._t.join(10)


def _run(fn, timeout: float) -> tuple[bool, list]:
    """Run fn in a thread. Returns (finished within timeout, [result|exc])."""
    out: list = []

    def go() -> None:
        try:
            out.append(fn())
        except BaseException as e:                # noqa: BLE001
            out.append(e)
    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(timeout)
    return (not t.is_alive()), out, t


class Writers:
    """(name, setup-sections, writer(slug), lock section, check(doc))."""

    @staticmethod
    def all() -> list[tuple]:
        def disk_w(slug):
            api._disk_doc_update(slug, size_mb=8192, pending_size_mb=None)

        def disk_ok(d):
            return d['disk'] == {'size_mb': 8192, 'keep': 1}

        def backfill_w(slug):
            return api.org_net(slug, _request())

        def backfill_ok(d):
            return (d['net_identity'].get('secret')
                    and isinstance(d.get('net_hubs'), list)
                    and d.get('net_autoconnect') is True)

        def scrub_w(slug):
            return api.org_net(slug, _request())

        def scrub_ok(d):
            return d['net_hubs'] == [{'id': 'h1', 'address': 'http://x'}]

        def name_w(slug):
            net._record_hub_name('http://x', 'Hub One',
                                 {slug: {'hubs': [{'id': 'h1', 'address': 'http://x'}]}},
                                 {slug: 'h1'})

        def name_ok(d):
            return d['net_hubs'][0].get('name') == 'Hub One'

        def clear_w(slug):
            net._clear_registration(slug, 'h1')

        def clear_ok(d):
            return d['net_state']['h1']['registered_at'] is None

        ident = {'secret': 's' * 32, 'fingerprint': 'f', 'slug': 'x', 'minted_at': 't'}
        return [
            ('disk', dict(disk={'pending_size_mb': 9000, 'keep': 1}),
             disk_w, 'disk', disk_ok),
            ('net-backfill', {}, backfill_w, 'net_hubs', backfill_ok),
            ('net-scrub', dict(net_identity=ident, net_autoconnect=True,
                               net_hubs=[{'id': 'h1', 'address': 'http://x',
                                          'peer_token': 'old'}]),
             scrub_w, 'net_hubs', scrub_ok),
            ('hub-name', dict(net_hubs=[{'id': 'h1', 'address': 'http://x'}]),
             name_w, 'net_hubs', name_ok),
            ('clear-registration',
             dict(net_state={'h1': {'registered_at': '2026-01-01'}}),
             clear_w, 'net_state', clear_ok),
        ]


class NeverWaitsOnDocLock(unittest.TestCase):
    def test_each_writer_finishes_while_doc_lock_is_held(self) -> None:
        ran = 0
        for name, secs, w, _lock, ok in Writers.all():
            with self.subTest(writer=name):
                slug = _fresh_org(**secs)
                with _Held(lambda: store.DOC_LOCK):
                    done, out, _t = _run(lambda: w(slug), FREE_S)
                    self.assertTrue(done, f'{name} waited on DOC_LOCK')
                self.assertFalse(out and isinstance(out[0], BaseException), out)
                self.assertTrue(ok(_doc(slug)), f'{name}: {_doc(slug)!r}')
                ran += 1
        self.assertEqual(ran, len(Writers.all()))    # the loop really ran


class LocksItsRow(unittest.TestCase):
    def test_writer_waits_for_a_holder_of_its_row(self) -> None:
        ran = 0
        for name, secs, w, lock, ok in Writers.all():
            with self.subTest(writer=name):
                slug = _fresh_org(**secs)
                with _Held(lambda: orgtx.org_tx(slug, sections=[lock])):
                    done, out, t = _run(lambda: w(slug), BLOCKED_S)
                    self.assertFalse(done, f'{name} did not wait for {lock}')
                t.join(FREE_S)
                self.assertFalse(t.is_alive(), f'{name} never finished')
                self.assertFalse(out and isinstance(out[0], BaseException), out)
                self.assertTrue(ok(_doc(slug)), f'{name}: {_doc(slug)!r}')
                ran += 1
        self.assertEqual(ran, len(Writers.all()))

    def test_unrelated_row_holder_does_not_block(self) -> None:
        for name, secs, w, _lock, ok in Writers.all():
            with self.subTest(writer=name):
                slug = _fresh_org(**secs)
                with _Held(lambda: orgtx.org_tx(slug, sections=['compact_at'])):
                    done, out, _t = _run(lambda: w(slug), FREE_S)
                    self.assertTrue(done, f'{name} blocked on an unrelated row')
                self.assertTrue(ok(_doc(slug)))


class ParticipantsSelfHeal(unittest.TestCase):
    """net._participants' four self-heal writes (backfill, local-address
    sync, stale net_state drop, orphan spool re-key), all while another
    thread holds DOC_LOCK."""

    def test_all_four_heals_land_with_doc_lock_held(self) -> None:
        local = 'http://127.0.0.1:7499'
        fresh = _fresh_org()                                   # backfill
        healed = _fresh_org(
            net_identity={'secret': 's' * 32, 'fingerprint': 'f',
                          'slug': 'x.y.ffffff', 'minted_at': 't'},
            net_autoconnect=True,
            net_hubs=[{'id': net.LOCAL_HUB_ID, 'address': 'http://old:1',
                       'enabled': True}],
            net_state={'gone': {'registered_at': 't', 'address': 'http://z'}},
            net_spool={'gone': [{'id': 'm1'}]})
        os.environ['ORGTREE_LOCAL_HUB_ADDRESS'] = local
        try:
            with _Held(lambda: store.DOC_LOCK):
                done, out, _t = _run(net._participants, FREE_S)
                self.assertTrue(done, '_participants waited on DOC_LOCK')
        finally:
            os.environ.pop('ORGTREE_LOCAL_HUB_ADDRESS', None)
        self.assertFalse(out and isinstance(out[0], BaseException), out)
        f = _doc(fresh)
        self.assertTrue(f['net_identity'].get('secret'))
        self.assertIsInstance(f.get('net_hubs'), list)
        h = _doc(healed)
        self.assertEqual(h['net_hubs'][0]['address'], local)
        self.assertNotIn('gone', h.get('net_state') or {})
        self.assertEqual(h['net_spool'], {net.LOCAL_HUB_ID: [{'id': 'm1'}]})
        self.assertIn(healed, out[0])


class RegisterPending(unittest.TestCase):
    def test_registration_lands_with_doc_lock_held(self) -> None:
        from unittest import mock
        slug = _fresh_org(net_hubs=[{'id': 'h1', 'address': 'http://x'}],
                          net_state={})

        class _Resp:
            status_code = 200

            def json(self):
                return {'name': 'Hub X', 'roster': []}

        class _Client:
            posts: list = []

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, url, **kw):
                _Client.posts.append(url)
                return _Resp()

        parts = {slug: {'net_slug': 'x.y.z', 'secret': 's', 'name': slug,
                        'hubs': [{'id': 'h1', 'address': 'http://x'}],
                        'registered': {}}}
        net._backoff.pop('http://x', None)
        with mock.patch.object(net, '_client', _Client):
            with _Held(lambda: store.DOC_LOCK):
                done, out, _t = _run(lambda: net._register_pending(parts), FREE_S)
                self.assertTrue(done, '_register_pending waited on DOC_LOCK')
        self.assertEqual(_Client.posts, ['http://x/api/register'])  # it really ran
        cell = _doc(slug)['net_state']['h1']
        self.assertTrue(cell.get('registered_at'))
        self.assertEqual(cell.get('address'), 'http://x')
        self.assertEqual(_doc(slug)['net_hubs'][0].get('name'), 'Hub X')


class DesktopRecovery(unittest.TestCase):
    def _org(self) -> str:
        slug = _fresh_org(desktop_import={
            'active_nodes': ['w'], 'recovery_phase': 'held',
            'recovery_intents': {'w': {'text': 'hi', 'view': 'hi'}}})
        org = store.load_org(slug)
        org.d['nodes']['w'] = {'id': 'w', 'name': 'w', 'parent': None,
                               'children': [], 'state': 'live'}
        store.save_org(org)
        store.save_org(store.load_org(slug))
        return slug

    def test_status_and_resolve_never_wait_on_doc_lock(self) -> None:
        from orgtree import desktop_recovery as rec
        slug = self._org()
        with _Held(lambda: store.DOC_LOCK):
            done, out, _t = _run(lambda: rec.status(slug), FREE_S)
            self.assertTrue(done, 'status waited on DOC_LOCK')
            self.assertFalse(isinstance(out[0], BaseException), out)
            row = out[0]['nodes'][0]
            done, out, _t = _run(lambda: rec.resolve_import(
                slug, [{'node': 'w', 'attempt': row['attempt'],
                        'expected_phase': row['phase']}],
                'mark-handled', True), FREE_S)
            self.assertTrue(done, 'resolve_import waited on DOC_LOCK')
        self.assertFalse(isinstance(out[0], BaseException), out)
        self.assertEqual(out[0]['results'][0]['phase'], 'handled', out)
        meta = _doc(slug)['desktop_import']
        self.assertEqual(meta['recovery_attempts']['w']['phase'], 'handled')
        self.assertFalse(meta['recovery_pending'])

    def test_resolve_waits_for_a_holder_of_the_seat(self) -> None:
        from orgtree import desktop_recovery as rec
        slug = self._org()
        row = rec.status(slug)['nodes'][0]
        with _Held(lambda: orgtx.org_tx(slug, nodes=['w'])):
            done, out, t = _run(lambda: rec.resolve_import(
                slug, [{'node': 'w', 'attempt': row['attempt'],
                        'expected_phase': row['phase']}],
                'mark-handled', True), BLOCKED_S)
            self.assertFalse(done, 'resolve_import did not wait for the seat row')
        t.join(FREE_S)
        self.assertEqual(out[0]['results'][0]['phase'], 'handled', out)


ALL_TOOLS = {'bash': True, 'web': True, 'edit': True, 'subagents': True, 'mcp': ['*']}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
CEILING = {'tools': NO_TOOLS, 'add_dirs': [], 'org_visibility': 'team',
           'permission_mode': 'acceptEdits'}


class KioskWholeOrg(unittest.TestCase):
    """api.org_kiosk: the kiosk rows + EVERY node row in one org_tx."""

    def setUp(self) -> None:
        from unittest import mock
        from orgtree import ledger, supervisor
        # post-commit effects are not what is measured here (and some take
        # DOC_LOCK themselves, exactly as they did before the conversion)
        for name in ('hard_freeze', 'send_message', 'storage_check'):
            p = mock.patch.object(supervisor, name, return_value=None)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(api, 'hub_changed', return_value=None)
        p.start()
        self.addCleanup(p.stop)
        global _n
        _n += 1
        org = store.create_org(f'pg3f-k{_n}')
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'haiku', 20, 'top', add_dirs=[],
                 tools=ALL_TOOLS, charter='fixture')
        org.d['kiosk'] = {'enabled': True, 'credits': 0, 'spend_limit': 0.0,
                          'storage_limit_mb': 0, 'token': 't', 'auto_raise': False,
                          'max_scope': {**CEILING, 'tools': ALL_TOOLS}}
        org.d['spend_frozen'] = True
        store.save_org(org)
        store.save_org(store.load_org(self.slug))

    def _call(self):
        return api.org_kiosk(self.slug, api.KioskCfg(max_scope=CEILING,
                                                     spend_limit=100.0))

    def _check(self) -> None:
        d = _doc(self.slug)
        self.assertFalse(d['nodes']['top']['scope']['tools']['bash'],
                         'the ceiling sweep did not clamp the node')
        self.assertTrue((d.get('notices') or {}).get('top'),
                        'the swept agent was not told')
        self.assertNotIn('spend_frozen', d)
        self.assertEqual(d['kiosk']['spend_limit'], 100.0)

    def test_never_waits_on_doc_lock(self) -> None:
        with _Held(lambda: store.DOC_LOCK):
            done, out, _t = _run(self._call, FREE_S)
            self.assertTrue(done, 'org_kiosk waited on DOC_LOCK')
        self.assertFalse(isinstance(out[0], BaseException), out)
        self._check()

    def test_waits_for_a_holder_of_any_node_row(self) -> None:
        with _Held(lambda: orgtx.org_tx(self.slug, nodes=['top'])):
            done, out, t = _run(self._call, BLOCKED_S)
            self.assertFalse(done, 'org_kiosk did not lock the node rows')
        t.join(FREE_S)
        self.assertFalse(isinstance(out[0], BaseException), out)
        self._check()

    def test_a_node_added_after_the_listing_is_still_swept(self) -> None:
        from unittest import mock
        from orgtree import settingstx
        real = settingstx._node_ids
        calls: list = []

        def stale(slug):
            ids = real(slug)
            calls.append(ids)
            return ids - {'top'} if len(calls) == 1 else ids
        with mock.patch.object(settingstx, '_node_ids', stale):
            self._call()
        self.assertEqual(len(calls), 2, 'the grown node set was not re-listed')
        self._check()


class Semantics(unittest.TestCase):
    def test_disk_none_pops_and_other_keys_survive(self) -> None:
        slug = _fresh_org(disk={'size_mb': 4096, 'pending_size_mb': 5000})
        api._disk_doc_update(slug, pending_size_mb=None)
        self.assertEqual(_doc(slug)['disk'], {'size_mb': 4096})

    def test_backfill_is_idempotent_and_kiosk_has_none(self) -> None:
        slug = _fresh_org()
        first = api.org_net(slug, _request())
        second = api.org_net(slug, _request())
        self.assertEqual(first['identity']['secret'], second['identity']['secret'])
        kslug = _fresh_org(kiosk={'enabled': False})
        self.assertEqual(api.org_net(kslug, _request())['identity'], None)
        self.assertNotIn('net_identity', _doc(kslug))

    def test_clear_registration_without_cell_writes_nothing(self) -> None:
        slug = _fresh_org(net_state={})
        seen: list = []
        orgtx.commit_listeners.append(seen.append)
        try:
            net._clear_registration(slug, 'nope')
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertTrue(seen, 'the org_tx never committed (listener unheard)')
        self.assertTrue(seen[-1].changes.is_empty(), seen[-1].changes)


if __name__ == '__main__':
    unittest.main()
