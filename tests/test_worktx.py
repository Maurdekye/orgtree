"""PG-3w: docket writes on `org_tx` (worktx.py), and race test RT2.

What these prove, on PG-0's SeamBackend fake over a throwaway SQLite root:
  * a docket write commits through `worktx.mutate` and lands the same state
    the DOC_LOCK path lands;
  * the action transaction does NOT archive (the move is deferred), and the
    separate `sweep` transaction does (plan decision 13);
  * a notification row the ledger discovers at run time is refused, the row
    set widens, and the retry commits exactly once (nothing written twice);
  * RT2 same-item edit: two writers forced to interleave on ONE item both
    land with no field lost, and with `expected_rev` exactly one wins. The
    NEGATIVE CONTROL runs the same interleaving without row locks and must
    LOSE a field, which proves the scenario can detect a lost update;
  * decision 13 (d): the sweep racing a reopen of the same item never loses
    the reopen.

Run:  python tools/run-python-verification.py tests/test_worktx.py
"""

import os
from pathlib import Path
import tempfile
import threading
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v3-worktx-', ignore_cleanup_errors=True)
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE='sqlite', ORGTREE_ORGTX_TEST_HOOKS='1')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import events, events_render  # noqa: E402,F401
from orgtree import orgtx, store, worktx  # noqa: E402
from orgtree.ledger import USER, StaleRevError  # noqa: E402

_n = 0


def fixture():
    """A stored org: `own` (with report `sub`) owns item one; `peer` is a
    participant."""
    global _n
    _n += 1
    org = store.create_org(f'wtx-{_n}')
    slug = org.d['slug']
    for nid in ('own', 'peer', 'boss'):
        org.hire(USER, None, 'haiku', 0, nid)
    org.hire(USER, 'own', 'haiku', 0, 'sub')
    org.work_create('own', 'Race fixture item',
                    objective='Problem: one item, two writers. Solution: row locks.',
                    participants=['peer'], acceptance=['It holds.'])
    store.save_org(org)
    store.save_org(store.load_org(slug))
    item = store.load_org(slug).d['work_items'][-1]['slug']
    return slug, item


def get(slug, item):
    org = store.load_org(slug)
    for it in org.d['work_items']:
        if it['slug'] == item:
            return it, False
    for it in org.d['work_items_archive']:
        if it['slug'] == item:
            return it, True
    raise KeyError(item)


class Base(unittest.TestCase):
    def setUp(self):
        orgtx.use_backend(orgtx.SeamBackend())
        orgtx.set_pause_hook(None)
        self.slug, self.item = fixture()

    def tearDown(self):
        orgtx.set_pause_hook(None)


class DocketOnOrgTx(Base):
    def test_update_commits_and_bumps_rev(self):
        before = int(get(self.slug, self.item)[0]['rev'])
        worktx.mutate(self.slug, lambda o: o.work_update(
            'own', self.item, done_so_far=['a'], working_on_next=['b'],
            status='in_progress'))
        it, archived = get(self.slug, self.item)
        self.assertFalse(archived)
        self.assertEqual(it['done_so_far'], ['a'])
        self.assertEqual(int(it['rev']), before + 1)

    def test_evidence_names_only_docket_rows(self):
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            worktx.mutate(self.slug, lambda o: o.work_evidence(
                'own', self.item, 'note', 'log.txt', note='n'))
        finally:
            orgtx.commit_listeners.remove(seen.append)
        wrote = set(seen[-1].changes.doc_upserts)
        self.assertIn('work_items', wrote)
        self.assertLessEqual(wrote, set(worktx.BASE_SECTIONS))
        self.assertFalse(seen[-1].changes.node_updates)

    def test_action_defers_archive_and_sweep_archives(self):
        worktx.mutate(self.slug, lambda o: o.work_update(
            'own', self.item, done_so_far=['x'], working_on_next=['y'],
            status='dropped', dropped_reason='Cancelled by the test; nothing to resume.'))
        # the action transaction ran with the move deferred: still active
        self.assertFalse(get(self.slug, self.item)[1])
        # ⚠ and so does the NEXT docket write, on another item: the inline
        # `_work_sweep` at its head would have archived the dropped item here
        # (the deferral is what this asserts — the drop's own head-of-call
        # sweep ran before the status changed, so it proves nothing alone)
        worktx.run(self.slug, lambda o: o.work_create(
            'own', 'Second item', objective='Problem: a. Solution: b.'))
        self.assertFalse(get(self.slug, self.item)[1],
                         'an action transaction archived another item')
        moved = worktx.sweep(self.slug)
        self.assertEqual(moved, [self.item])
        self.assertTrue(get(self.slug, self.item)[1])
        # idempotent: a second sweep moves nothing
        self.assertEqual(worktx.sweep(self.slug), [])

    def test_assign_widens_to_the_mailed_owner_and_commits_once(self):
        attempts = []
        orgtx.set_pause_hook(lambda p, tx: attempts.append(p) if p == 'after_lock' else None)
        worktx.run(self.slug, lambda o: o.work_assign('own', self.item, 'sub'))
        it, _ = get(self.slug, self.item)
        self.assertEqual(it['owner']['node'], 'sub')
        # unpredicted: the first attempt was refused, a wider one committed
        self.assertGreaterEqual(len(attempts), 2)
        mails = store.load_org(self.slug).d['mail'].get('sub') or []
        self.assertEqual(sum(1 for m in mails if self.item in str(m)), 1,
                         'the assignment mail must land exactly once')

    def test_assign_predicted_rows_commit_first_time(self):
        attempts = []
        orgtx.set_pause_hook(lambda p, tx: attempts.append(p) if p == 'after_lock' else None)
        rows = worktx.Rows().notify('sub')
        worktx.run(self.slug, lambda o: o.work_assign('own', self.item, 'sub'), rows=rows)
        self.assertEqual(get(self.slug, self.item)[0]['owner']['node'], 'sub')
        self.assertEqual(len(attempts), 1)

    def test_rows_for_predicts_common_actions_without_widening(self):
        """The argument-derived prediction is exact for the frequent actions:
        each commits on its FIRST attempt (a miss would show as a second
        `after_lock`)."""
        cases = [
            ('evidence', {}, lambda o: o.work_evidence('own', self.item, 'note', 'e.txt', note='n')),
            ('decision', {}, lambda o: o.work_decision('own', self.item, 'Ruled.')),
            ('update', {}, lambda o: o.work_update('own', self.item, done_so_far=['d'],
                                                   working_on_next=['n'])),
            ('participants', {'add': ['boss']},
             lambda o: o.work_participants('own', self.item, add=['boss'])),
            ('assign', {'owner': 'sub'}, lambda o: o.work_assign('own', self.item, 'sub')),
            ('create', {'participants': ['peer']},
             lambda o: o.work_create('own', 'Predicted create',
                                     objective='Problem: p. Solution: s.',
                                     participants=['peer'])),
        ]
        for action, args, fn in cases:
            with self.subTest(action=action):
                attempts = []
                orgtx.set_pause_hook(
                    lambda p, tx: attempts.append(p) if p == 'after_lock' else None)
                worktx.run(self.slug, fn, rows=worktx.rows_for(action, args))
                orgtx.set_pause_hook(None)
                self.assertEqual(len(attempts), 1, f'{action} widened: prediction missed a row')

    def test_refusal_naming_nothing_new_is_not_retried_forever(self):
        err = orgtx.UnlockedWrite("wrote rows it did not lock: section 'work_items'")
        self.assertEqual(worktx.refused_rows(err), [('section', 'work_items')])
        self.assertFalse(worktx.Rows().widen(worktx.refused_rows(err)))


def _race(slug, a_fn, b_fn, *, locked=True):
    """Force A and B to interleave on one item. With row locks, A holds its
    locks paused at `before_commit` while B starts; B must then wait. Returns
    ({'a': exc|None, 'b': exc|None}, b_blocked_while_a_held)."""
    a_in = threading.Event()
    release = threading.Event()
    out = {}
    b_started = threading.Event()
    b_done = threading.Event()

    def hook(point, tx):
        if point == 'before_commit' and threading.current_thread().name == 'A':
            a_in.set()
            release.wait(10)

    def wrap(name, fn):
        def go():
            try:
                if name == 'B':
                    b_started.set()
                fn()
                out[name] = None
            except Exception as e:  # noqa: BLE001
                out[name] = e
            finally:
                if name == 'B':
                    b_done.set()
        return go

    if locked:
        orgtx.set_pause_hook(hook)
        ta = threading.Thread(target=wrap('A', lambda: worktx.run(slug, a_fn)), name='A')
        tb = threading.Thread(target=wrap('B', lambda: worktx.run(slug, b_fn)), name='B')
        ta.start()
        assert a_in.wait(10), 'A never reached before_commit'
        tb.start()
        b_started.wait(10)
        b_blocked = not b_done.wait(0.5)
        release.set()
        ta.join(10)
        tb.join(10)
        orgtx.set_pause_hook(None)
        return out, b_blocked
    # NEGATIVE CONTROL: the same interleaving with no lock at all — both load,
    # A changes and saves, B (holding a stale load) changes and saves.
    oa, ob = store.load_org(slug), store.load_org(slug)
    for o, fn, name in ((oa, a_fn, 'A'), (ob, b_fn, 'B')):
        try:
            o._work_defer_archive = True
            fn(o)
            out[name] = None
        except Exception as e:  # noqa: BLE001
            out[name] = e
    store.save_org(oa)
    store.save_org(ob)
    return out, False


class RT2SameItemEdit(Base):
    """RT2 (PYPG-PLAN §2): two writers on one item — one winner under CAS,
    and no field lost without it."""

    def a(self, o, **kw):
        return o.work_update('own', self.item, done_so_far=['from A'],
                             working_on_next=['A next'], **kw)

    def b(self, o, **kw):
        return o.work_decision('peer', self.item, 'B decided this.', **kw) \
            if not kw else o.work_evidence('peer', self.item, 'note', 'b.txt',
                                           note='from B', **kw)

    def test_both_land_no_field_lost(self):
        r0 = int(get(self.slug, self.item)[0]['rev'])
        out, b_blocked = _race(self.slug, self.a, self.b)
        self.assertEqual(out, {'A': None, 'B': None})
        self.assertTrue(b_blocked, 'B must wait for A\'s row lock')
        it, _ = get(self.slug, self.item)
        self.assertEqual(it['done_so_far'], ['from A'])
        self.assertTrue(any('B decided this.' in str(s) for s in it.get('scope') or []),
                        'B\'s decision was lost')
        self.assertEqual(int(it['rev']), r0 + 2)

    def test_negative_control_without_locks_loses_a_field(self):
        """Proves the scenario CAN see a lost update: without row locks the
        second save overwrites the first writer's change."""
        out, _ = _race(self.slug, self.a, self.b, locked=False)
        self.assertEqual(out, {'A': None, 'B': None})
        it, _ = get(self.slug, self.item)
        lost_a = it['done_so_far'] != ['from A']
        lost_b = not any('B decided this.' in str(s) for s in it.get('scope') or [])
        self.assertTrue(lost_a or lost_b,
                        'the unlocked control lost nothing — the race did not interleave')

    def test_cas_exactly_one_winner(self):
        r0 = int(get(self.slug, self.item)[0]['rev'])
        out, _ = _race(self.slug,
                       lambda o: self.a(o, expected_rev=r0),
                       lambda o: self.b(o, expected_rev=r0))
        self.assertIsNone(out['A'])
        self.assertIsInstance(out['B'], StaleRevError)
        it, _ = get(self.slug, self.item)
        self.assertEqual(it['done_so_far'], ['from A'])
        self.assertFalse(any('from B' in str(e) for e in it.get('evidence') or []))
        self.assertEqual(int(it['rev']), r0 + 1)


class SweepRacesReopen(Base):
    """Decision 13 (d): the sweep's re-check under the lock never loses a
    reopen that committed first, and a reopen after the sweep still finds
    the item (decision 13 c)."""

    def drop(self):
        worktx.run(self.slug, lambda o: o.work_update(
            'own', self.item, done_so_far=['x'], working_on_next=['y'],
            status='dropped', dropped_reason='Cancelled by the test; nothing to resume.'))

    def reopen(self, o):
        return o.work_update('own', self.item, done_so_far=['back'],
                             working_on_next=['on it'], status='in_progress',
                             reopen=True)

    def test_reopen_holds_the_lock_then_sweep_rechecks(self):
        self.drop()
        out, b_blocked = _race(self.slug, self.reopen,
                               lambda o: o._work_archive_eligible())
        self.assertEqual(out, {'A': None, 'B': None})
        self.assertTrue(b_blocked)
        it, archived = get(self.slug, self.item)
        self.assertFalse(archived, 'the sweep archived an item a reopen had just revived')
        self.assertEqual(it['done_so_far'], ['back'])

    def test_sweep_first_then_reopen_finds_the_archived_item(self):
        self.drop()
        self.assertEqual(worktx.sweep(self.slug), [self.item])
        worktx.run(self.slug, self.reopen)
        it, archived = get(self.slug, self.item)
        self.assertFalse(archived)
        self.assertEqual(it['done_so_far'], ['back'])


if __name__ == '__main__':
    unittest.main()
