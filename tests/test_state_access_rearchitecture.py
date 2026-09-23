"""Phases A/B of the state-access rearchitecture: the section-granular
snapshot, the resident write document, and the access-scoped save.

The properties pinned here are the ones the whole design rests on, each with
the failure mode it refuses:

* Snapshot refresh EQUALS a full load after arbitrary committed changes —
  under-refresh serves stale state, and the equivalence is checked value-
  deep, not by spot fields. Unchanged sections must be SHARED (identity)
  with the previous snapshot, or the refresh quietly re-parses the org and
  the whole phase is a no-op.
* Snapshots are never torn: a save that changes two sections atomically is
  seen by concurrent snapshot readers either wholly or not at all.
* `write_org` keeps the discard property: mutations of a cycle that raises,
  or that ends without saving, never reach disk through a later save.
* The access-scoped save's read barrier is VERIFIABLE: a mutation smuggled
  around the barrier (raw dict access) is caught by the verify control —
  the test proves the control fires, which is what makes "the barrier held"
  a measurement instead of a hope. The `ORGTREE_SCOPED_SAVE=0` escape hatch
  restores the full compare-on-save.
* A legacy `DOC_LOCK + load_org + save_org` cycle interoperates: its save
  drops the resident, and nothing it wrote is lost or resurrected.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

fixture = tempfile.TemporaryDirectory(prefix='orgtree-state-rearch-')
os.environ['ORGTREE_DATA'] = fixture.name
os.environ.setdefault('ORGTREE_STORE', 'sqlite')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store
from orgtree.ledger import USER


def _mk(slug: str):
    org = store.create_org(slug)
    org.hire(USER, None, 'haiku', 5, 'alpha', charter='a')
    org.hire(USER, None, 'haiku', 5, 'beta', charter='b')
    store.save_org(org)
    return store.load_org(slug)


def _canon(o) -> str:
    """Value-deep canonical form of the EAGER document (lazy sections have
    their own row identity and stay unmaterialized on snapshots)."""
    return json.dumps(store.eager_sections(o.d), sort_keys=True, default=str)


class SnapshotRefreshEquivalence(unittest.TestCase):
    def test_refresh_equals_full_load_and_shares_unchanged(self):
        _mk('snap-eq')
        s0 = store.cached_org('snap-eq')
        with store.write_org('snap-eq') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        s1 = store.cached_org('snap-eq')
        self.assertIsNot(s1, s0)
        self.assertEqual(_canon(s1), _canon(store.load_org('snap-eq')))
        self.assertIs(s1.d['nodes']['beta'], s0.d['nodes']['beta'],
                      'unchanged node must be shared, not re-parsed')
        self.assertIsNot(s1.d['nodes']['alpha'], s0.d['nodes']['alpha'])

    def test_refresh_covers_hire_dockey_and_dissolve(self):
        _mk('snap-mix')
        s0 = store.cached_org('snap-mix')
        with store.write_org('snap-mix') as w:
            w.d['compact_at'] = 0.55
            w.hire(USER, None, 'haiku', 5, 'gamma', charter='c')
            store.save_org(w)
        s1 = store.cached_org('snap-mix')
        self.assertEqual(_canon(s1), _canon(store.load_org('snap-mix')))
        self.assertIn('gamma', s1.d['nodes'])
        with store.write_org('snap-mix') as w:
            w.dissolve(USER, 'gamma')
            store.save_org(w)
        s2 = store.cached_org('snap-mix')
        self.assertEqual(_canon(s2), _canon(store.load_org('snap-mix')))
        self.assertIs(s2.d['nodes']['beta'], s0.d['nodes']['beta'],
                      'sharing must survive successive refreshes')

    def test_snapshot_is_never_torn(self):
        """A save writes two related fields in one commit; every concurrent
        snapshot must see them equal. Deliberately hammered: the writer flips
        both, readers assert the invariant, and any refresh that mixed two
        commits fails the equality."""
        _mk('snap-torn')
        with store.write_org('snap-torn') as w:
            w.node('alpha')['charter'] = 'v0'
            w.node('beta')['charter'] = 'v0'
            store.save_org(w)
        stop = threading.Event()
        torn: list[str] = []

        def writer():
            v = 0
            while not stop.is_set():
                v += 1
                with store.write_org('snap-torn') as w:
                    w.node('alpha')['charter'] = f'v{v}'
                    w.node('beta')['charter'] = f'v{v}'
                    store.save_org(w)

        def reader():
            while not stop.is_set():
                s = store.cached_org('snap-torn')
                a = s.node('alpha')['charter']
                b = s.node('beta')['charter']
                if a != b:
                    torn.append(f'{a} != {b}')
                    stop.set()

        threads = [threading.Thread(target=writer, daemon=True),
                   *(threading.Thread(target=reader, daemon=True)
                     for _ in range(3))]
        for t in threads:
            t.start()
        stop.wait(3.0)
        stop.set()
        for t in threads:
            t.join(5)
        self.assertEqual([], torn)


class WriteOrgSemantics(unittest.TestCase):
    def test_resident_is_reused_and_cheap_path_saves(self):
        _mk('wo-reuse')
        with store.write_org('wo-reuse') as w1:
            w1.node('alpha')['state'] = 'working'
            store.save_org(w1)
        with store.write_org('wo-reuse') as w2:
            self.assertIs(w1, w2, 'second cycle must reuse the resident')
            w2.node('alpha')['state'] = 'idle'
            store.save_org(w2)
        self.assertEqual(store.load_org('wo-reuse').node('alpha')['state'],
                         'idle')

    def test_abandoned_mutation_is_discarded(self):
        _mk('wo-abandon')
        with store.write_org('wo-abandon') as w:
            w.node('alpha')['state'] = 'zombie'   # mutated, never saved
        self.assertNotIn('wo-abandon', store._resident)
        with store.write_org('wo-abandon') as w:
            self.assertNotEqual(w.node('alpha').get('state'), 'zombie')
            store.save_org(w)
        self.assertNotEqual(store.load_org('wo-abandon').node('alpha')
                            .get('state'), 'zombie')

    def test_exception_discards_partial_mutations(self):
        _mk('wo-exc')
        with self.assertRaises(RuntimeError):
            with store.write_org('wo-exc') as w:
                w.node('alpha')['state'] = 'broken'
                raise RuntimeError('boom')
        with store.write_org('wo-exc') as w:
            self.assertNotEqual(w.node('alpha').get('state'), 'broken')
            store.save_org(w)

    def test_readonly_hold_keeps_residency(self):
        _mk('wo-ro')
        with store.write_org('wo-ro') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        with store.write_org('wo-ro') as w:
            w.node('alpha').get('state')          # read only
        self.assertIn('wo-ro', store._resident)

    def test_legacy_cycle_shares_the_resident(self):
        """The classic idiom (DOC_LOCK + load_org + save) is served the SAME
        resident as write_org — the unification that accelerates all ~300
        legacy sites without edits — and both spellings' writes land."""
        _mk('wo-legacy')
        with store.write_org('wo-legacy') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        with store.DOC_LOCK:
            legacy = store.load_org('wo-legacy')
            self.assertIs(legacy, w, 'classic load under the lock must be '
                                     'served the resident')
            legacy.node('beta')['state'] = 'working'
            store.save_org(legacy)
        with store.write_org('wo-legacy') as w2:
            self.assertEqual(w2.node('beta')['state'], 'working')
            self.assertEqual(w2.node('alpha')['state'], 'working')
            store.save_org(w2)

    def test_foreign_object_save_invalidates_the_resident(self):
        """A save through an org object that is NOT the resident (loaded
        outside the lock, saved inside — the one shape residency cannot
        vouch for) must drop the resident, and the next cycle must see the
        foreign write rather than resurrect stale state."""
        _mk('wo-foreign')
        with store.write_org('wo-foreign') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        foreign = store.load_org('wo-foreign')      # outside the lock: private
        foreign.node('beta')['state'] = 'working'
        with store.DOC_LOCK:
            store.save_org(foreign)
        self.assertNotIn('wo-foreign', store._resident)
        with store.write_org('wo-foreign') as w2:
            self.assertEqual(w2.node('beta')['state'], 'working')
            self.assertEqual(w2.node('alpha')['state'], 'working')
            store.save_org(w2)

    def test_reload_in_hold_discards_dirty_resident(self):
        """The discard-by-reload contract: code that mutates, then loads
        again inside the SAME hold to get a clean copy, must actually get a
        clean copy — the resident is dropped when a repeat hand-out finds
        unsaved dirt."""
        _mk('wo-reload')
        with store.write_org('wo-reload') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        with store.DOC_LOCK:
            first = store.load_org('wo-reload')
            first.node('alpha')['state'] = 'half-applied'
            again = store.load_org('wo-reload')
            self.assertIsNot(again, first,
                             'a dirty resident must not be re-served')
            self.assertEqual(again.node('alpha')['state'], 'working')
            store.save_org(again)

    def test_post_mail_keeps_residency(self):
        _mk('wo-mail')
        with store.write_org('wo-mail') as w:
            w.post_mail('alpha', 'beta', 'hello there', 'message')
            store.save_org(w)
        self.assertIn('wo-mail', store._resident,
                      'an exposed-then-saved lazy section must keep residency')
        got = store.load_org('wo-mail').d.get('mail', {}).get('beta', [])
        self.assertTrue(any(m.get('body') == 'hello there' for m in got))


class ReleaseHookEnforcement(unittest.TestCase):
    def test_the_hook_is_the_enforcement_not_a_bystander(self):
        """Reviewer finding (flag-clear, 2026-09-19): with the release hook
        disabled, only ONE discard test objected — the others passed through
        the repeat-hand-out backstop, which lives in the same thread's
        hold-tracking and so cannot protect a DIFFERENT thread's next cycle.
        This pins the hook as load-bearing both ways: with it no-opped, an
        abandoned mutation IS served to another thread (the leak the hook
        exists to stop, demonstrated rather than assumed); restored, the
        same schedule stays clean."""
        _mk('hook-pin')
        real = store._on_doc_lock_release
        leaked: list[str] = []

        def cycle(mutate_only: bool, out: list[str]) -> None:
            with store.write_org('hook-pin') as w:
                if mutate_only:
                    w.node('alpha')['state'] = 'leaky'   # never saved
                else:
                    out.append(w.node('alpha').get('state') or '')
                    store.save_org(w)

        try:
            store._on_doc_lock_release = lambda: None
            t1 = threading.Thread(target=cycle, args=(True, leaked))
            t1.start(); t1.join(10)
            seen: list[str] = []
            t2 = threading.Thread(target=cycle, args=(False, seen))
            t2.start(); t2.join(10)
            self.assertEqual(seen, ['leaky'],
                             'with the hook disabled the abandoned mutation '
                             'must leak — otherwise this control is vacuous')
        finally:
            store._on_doc_lock_release = real
            store._resident.pop('hook-pin', None)
            store._invalidate_snapshot('hook-pin')
        # and the same cross-thread schedule, hook restored: no leak
        with store.write_org('hook-pin') as w:
            w.node('alpha')['state'] = 'clean'
            store.save_org(w)
        t3 = threading.Thread(target=cycle, args=(True, leaked))
        t3.start(); t3.join(10)
        seen2: list[str] = []
        t4 = threading.Thread(target=cycle, args=(False, seen2))
        t4.start(); t4.join(10)
        self.assertEqual(seen2, ['clean'],
                         'with the hook active the abandoned mutation must '
                         'be discarded before any other thread can read it')


class ScopedSaveControls(unittest.TestCase):
    def test_smuggled_mutation_is_caught_by_verify(self):
        """THE NEGATIVE CONTROL. Mutate a node through raw dict access —
        exactly the path the read barrier cannot see — and prove the verify
        mode detects the escape. Without this failing armed, 'the barrier
        held' would be unfalsifiable."""
        _mk('scope-neg')
        with store.write_org('scope-neg') as w:
            d = w.d
            nodes = dict.__getitem__(d, 'nodes')
            # raw access: no marks
            dict.__getitem__(nodes, 'alpha')['state'] = 'smuggled'
            store._SCOPED_VERIFY = True
            try:
                with self.assertRaises(RuntimeError) as ctx:
                    store.save_org(w)
                self.assertIn('escaped the read barrier', str(ctx.exception))
            finally:
                store._SCOPED_VERIFY = False
                store._resident.pop('scope-neg', None)
        store._invalidate_snapshot('scope-neg')

    def test_escape_hatch_restores_full_compare(self):
        """ORGTREE_SCOPED_SAVE=0 semantics: the same smuggled mutation is
        simply WRITTEN, because the full compare-on-save never trusted the
        barrier in the first place."""
        _mk('scope-hatch')
        store._SCOPED_SAVE = False
        try:
            with store.write_org('scope-hatch') as w:
                nodes = dict.__getitem__(w.d, 'nodes')
                dict.__getitem__(nodes, 'alpha')['state'] = 'smuggled'
                store.save_org(w)
        finally:
            store._SCOPED_SAVE = True
            store._resident.pop('scope-hatch', None)
        self.assertEqual(store.load_org('scope-hatch').node('alpha')['state'],
                         'smuggled')

    def test_reconcile_still_runs_when_docket_changes(self):
        """The save-fanout gate must not starve reconcile_attention: a save
        that touches work_items reconciles exactly as before."""
        _mk('scope-reconcile')
        with store.write_org('scope-reconcile') as w:
            w.d.setdefault('work_items', []).append({
                'slug': 'it-1', 'title': 'x', 'objective': 'y',
                'status': 'open', 'manual_attention': {'set_rev': 3},
            })
            store.save_org(w)
        item = store.load_org('scope-reconcile').d['work_items'][0]
        self.assertTrue(item.get('notification_attention_active'),
                        'manual attention must reconcile to active')


class SingleNodeRead(unittest.TestCase):
    def test_read_node_returns_stored_row(self):
        _mk('one-node')
        with store.write_org('one-node') as w:
            w.node('alpha')['state'] = 'working'
            store.save_org(w)
        row = store.read_node('one-node', 'alpha')
        assert row is not None
        self.assertEqual(row['state'], 'working')
        self.assertIsNone(store.read_node('one-node', 'nope'))


if __name__ == '__main__':
    unittest.main()
