"""Fence-off S5, the pure reads: staffing_options, quick_staff_preview, the
operator preview in org_op and orgtree_list_orgs read the committed document
WITHOUT store.DOC_LOCK (FENCE-OFF-PLAN S5; docket item
fence-off-s5-operator-door-plumbing-and-reads-of).

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * each read finishes while ANOTHER thread holds store.DOC_LOCK — the old
    `with store.DOC_LOCK:` bodies (and orgtree_list_orgs' old seat inside the
    agent_call write cycle) block there until the holder lets go, and the
    test fails on that timeout;
  * each read still answers what it answered before: it is handed the
    committed document (staffing reads), previews the operation
    (org_op preview), and lists the orgs — and list_orgs keeps the
    refusals the write cycle gave it (a halted caller, a latched killswitch).

Run:  python tools/run-python-verification.py tests/test_fence_s5_reads.py
"""
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='fence-s5-reads-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=str(Path(_temp.name)), ORGTREE_STORE='sqlite',
                  ORGTREE_STEER_HOOK='0')
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, net, quickstaff, staffcache, store  # noqa: E402

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
REQUEST = SimpleNamespace(state=SimpleNamespace())
#: how long a read may take when nothing it needs is held
FREE_S = 5.0
_N = [0]


def _org() -> str:
    _N[0] += 1
    slug = f'fs5r{_N[0]}'
    org = store.create_org(slug)
    org.hire(U, None, 'luna', 20, 'root')
    org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    org.hire('mid', 'mid', 'luna', 0, 'kid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    store.save_org(org)
    return slug


class _Held:
    """Hold store.DOC_LOCK in another thread for the duration."""

    def __enter__(self) -> '_Held':
        self._in, self._out = threading.Event(), threading.Event()

        def run() -> None:
            with store.DOC_LOCK:
                self._in.set()
                self._out.wait(30)
        self._t = threading.Thread(target=run, daemon=True)
        self._t.start()
        assert self._in.wait(10), 'holder never took DOC_LOCK'
        return self

    def __exit__(self, *a) -> None:
        self._out.set()
        self._t.join(10)


def _run(fn, timeout: float = FREE_S):
    """Run fn in a thread: (finished within timeout, [result | exception])."""
    out: list = []

    def go() -> None:
        try:
            out.append(fn())
        except BaseException as e:                # noqa: BLE001
            out.append(e)
    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(timeout)
    return (not t.is_alive()), out


class StaffingReads(unittest.TestCase):
    def setUp(self):
        self.slug = _org()
        self.snap = object()
        self.seen: list = []
        self.p = [patch.object(staffcache, 'read', lambda: self.snap)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def test_staffing_options_reads_without_doc_lock(self):
        def availability(org, snap):
            # handed the committed document and the snapshot read before it
            self.seen.append((sorted(org.nodes), snap))
            return {'ok': True}
        with patch.object(quickstaff, 'availability', availability), _Held():
            done, out = _run(lambda: api.staffing_options(self.slug))
        self.assertTrue(done, 'staffing_options waited on DOC_LOCK')
        self.assertEqual(out, [{'ok': True}])
        self.assertEqual(self.seen, [(['kid', 'mid', 'root'], self.snap)])

    def test_quick_staff_preview_reads_without_doc_lock(self):
        org = store.load_org(self.slug)
        wid = org.work_create('mid', 'Item', 'Problem. Fix.', owner='kid')['created']
        store.save_org(org)

        def preview(org, w, snap=None):
            self.seen.append((w, org.work_identity_state(), snap))
            return {'wid': w}
        with patch.object(quickstaff, 'preview', preview), _Held():
            done, out = _run(lambda: api.quick_staff_preview(self.slug, wid))
        self.assertTrue(done, 'quick_staff_preview waited on DOC_LOCK')
        self.assertEqual(out, [{'wid': wid}])
        self.assertEqual(self.seen, [(wid, 'slug', self.snap)])

    def test_an_unconverted_docket_is_migrated_privately_never_stored(self):
        # the preview converts a legacy docket IN ITS OWN COPY (as the unsaved
        # load under DOC_LOCK did): the stored document stays legacy, and a
        # second preview behaves exactly like the first
        org = store.load_org(self.slug)
        wid = org.work_create('mid', 'Item', 'Problem. Fix.', owner='kid',
                              status='backlogged')['created']
        org._work_find(wid)[0]['id'] = 'w1234abcd'       # the retired key
        store.save_org(org)
        self.assertEqual(store.load_org(self.slug).work_identity_state(), 'legacy')

        def preview(org, w, snap=None):
            self.seen.append(org.work_identity_state())
            return {'wid': w}
        with patch.object(quickstaff, 'preview', preview),                 patch.object(store, 'export_json', lambda slug: None):
            first = api.quick_staff_preview(self.slug, wid)
            second = api.quick_staff_preview(self.slug, wid)
        self.assertEqual(first, second)
        self.assertEqual(self.seen, ['slug', 'slug'])   # previewed converted
        self.assertEqual(store.load_org(self.slug).work_identity_state(), 'legacy')
        self.assertEqual(store.cached_org(self.slug).work_identity_state(), 'legacy')

    def test_a_ledger_refusal_is_still_a_422(self):
        def preview(org, w, snap=None):
            raise ledger.LedgerError('no such item')
        with patch.object(quickstaff, 'preview', preview):
            with self.assertRaises(HTTPException) as cm:
                api.quick_staff_preview(self.slug, 'nope')
        self.assertEqual(cm.exception.status_code, 422)


OFFERED = {"providers": [
    {"id": "openai", "hire_enabled": True, "tiers": [{"tier": "luna", "seat": .2}]}]}


def _image(org) -> str:
    """The shared document, as bytes a mutation would change."""
    import json
    return json.dumps({k: org.d[k] for k in sorted(org.d)}, sort_keys=True,
                      default=repr)


class SharedSnapshotUntouched(unittest.TestCase):
    """The staffing reads now read `store.cached_org`, the SHARED snapshot
    every lock-free reader is handed. With the real staffcache and the real
    quickstaff rules, both reads must leave it byte-identical."""

    def setUp(self):
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        for p in (patch.object(api, '_providers_payload', return_value=OFFERED),
                  patch.object(staffcache, '_supported_efforts',
                               return_value=['low', 'high'])):
            p.start()
            self.addCleanup(p.stop)
        self.slug = _org()
        org = store.load_org(self.slug)
        self.wid = org.work_create('mid', 'Item', 'Problem. Fix.',
                                   owner='kid', status='backlogged')['created']
        store.save_org(org)

    def test_the_real_staffing_reads_leave_the_shared_snapshot_as_it_was(self):
        shared = store.cached_org(self.slug)
        before = _image(shared)
        opts = api.staffing_options(self.slug)
        prev = api.quick_staff_preview(self.slug, self.wid)
        self.assertIsInstance(opts, dict)
        self.assertIsInstance(prev, dict)
        self.assertIs(store.cached_org(self.slug), shared)   # nothing saved
        self.assertEqual(_image(shared), before)

    def test_control_a_mutation_of_the_shared_snapshot_is_visible(self):
        # the image above would see a write (or the test proves nothing)
        shared = store.cached_org(self.slug)
        before = _image(shared)
        shared.node('kid')['charter'] = 'changed'
        try:
            self.assertNotEqual(_image(shared), before)
        finally:
            shared.node('kid')['charter'] = 'c'


class OperatorPreview(unittest.TestCase):
    def test_org_op_preview_reads_without_doc_lock(self):
        slug = _org()
        with _Held():
            done, out = _run(lambda: api.org_op(
                slug, api.Op(op='retire', node='kid', preview=True), REQUEST))
        self.assertTrue(done, 'the operator preview waited on DOC_LOCK')
        self.assertIsInstance(out[0], dict, out)
        # a preview: the tree is untouched
        self.assertEqual(store.load_org(slug).node('kid').get('state'), 'live')


class ListOrgs(unittest.TestCase):
    def setUp(self):
        self.slug = _org()
        self.p = [patch.object(net, 'remote_peers', lambda: [])]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def call(self, node='mid'):
        return api.agent_call(api.AgentCall(org=self.slug, node=node,
                                            tool='orgtree_list_orgs', args={}),
                              REQUEST)

    def test_list_orgs_reads_without_doc_lock(self):
        with _Held():
            done, out = _run(self.call)
        self.assertTrue(done, 'orgtree_list_orgs waited on DOC_LOCK')
        self.assertIsInstance(out[0], dict, out)
        mine = [o for o in out[0]['orgs'] if o.get('slug') == self.slug]
        self.assertEqual(len(mine), 1, out[0])
        self.assertTrue(mine[0]['you'])
        self.assertEqual(mine[0]['transports'], ['org'])

    def test_a_halted_caller_is_still_refused(self):
        org = store.load_org(self.slug)
        org.node('mid')['halt'] = {'at': 'x'}
        store.save_org(org)
        # refused at the halt gate before any dispatch (409), as before
        with self.assertRaises(HTTPException) as cm:
            self.call()
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn('agent is halted', str(cm.exception.detail))

    def test_a_latched_killswitch_still_refuses(self):
        org = store.load_org(self.slug)
        org.d['killswitch'] = {'at': 'x'}
        store.save_org(org)
        with self.assertRaises(HTTPException) as cm:
            self.call()
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIn('killswitch is latched', str(cm.exception.detail))

    def test_a_halt_landing_after_the_gate_is_still_refused(self):
        # the gate passed, then the halt landed before the read: the cycle
        # refused this under its lock (422), and so does the read block
        from orgtree import supervisor
        org = store.load_org(self.slug)
        org.node('mid')['halt'] = {'at': 'x'}
        store.save_org(org)
        with patch.object(supervisor.halt, 'blocked', lambda *a, **k: None):
            with self.assertRaises(HTTPException) as cm:
                self.call()
        self.assertEqual(cm.exception.status_code, 422)
        self.assertIn('agent is halted', str(cm.exception.detail))

    def test_a_refusal_writes_nothing(self):
        from orgtree import orgtx, supervisor
        org = store.load_org(self.slug)
        org.node('mid')['halt'] = {'at': 'x'}
        store.save_org(org)
        rev = orgtx.backend().revision(self.slug)
        seq = store.org_seq(self.slug)
        for gate in (None, 'halt'):
            with patch.object(supervisor.halt, 'blocked', lambda *a, **k: gate):
                with self.assertRaises(HTTPException):
                    self.call()
        self.assertEqual((orgtx.backend().revision(self.slug), store.org_seq(self.slug)),
                         (rev, seq))

    def test_an_unknown_caller_is_still_refused(self):
        with self.assertRaises(HTTPException) as cm:
            self.call(node='ghost')
        self.assertIn(cm.exception.status_code, (403, 422))


if __name__ == '__main__':
    unittest.main()
