"""Quick staff (the ticket menu's Staff…) on the door, end to end: the real
route through FastAPI, PG-0's SeamBackend org_tx, ORGTREE_PGDOOR=1, a
throwaway SQLite root.

  · every mode (request, under the assignee, top level) is ONE run of the
    locked body (the declared rows are complete — a missing row would widen
    and run it twice) and ONE commit, the DOC_LOCK cycle is never entered, and
    the wake goes out after the commit;
  · a replayed request id commits nothing and wakes nobody;
  · the undo (a refused kickoff) runs on the door too: one commit, the ticket
    back at backlogged, the request retracted;
  · a seat name taken between the snapshot and the lock widens (two runs)
    rather than writing an undeclared row.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='staffdoor-qs-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name, ORGTREE_V2_TOKEN='qs-door-tests',
                  ORGTREE_STORE='sqlite', ORGTREE_PGDOOR='1')
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401,E402

from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import (api, appsettings, ledger, orgtx, pgdoor, quickstaff,  # noqa: E402
                     staffcache, store)

HEADERS = {'X-Orgtree-Desktop-Token': 'qs-door-tests'}
T = {'bash': False, 'edit': False, 'web': False, 'subagents': False, 'mcp': []}


class QuickStaffDoor(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        org = ledger.Org.create('qsd-' + uuid.uuid4().hex[:8])
        self.slug = org.d['slug']
        org.d['tiers'] = {'haiku': 1, 'luna': .2}
        self.owner = org.hire(ledger.USER, None, 'haiku', 2, 'manager', add_dirs=[],
                              tools=T, org_visibility='self')['node']
        self.item = org.work_create(self.owner, 'Repair the widget', 'Broken. Repair it.',
                                    status='backlogged', done_so_far=['Described.'],
                                    working_on_next=['Implement it.'])['slug']
        store.save_org(org)
        pgdoor.use_org_tx(None)
        self.path = f'/api/orgs/{self.slug}/work-items/{self.item}/quick-staff'
        self.runs, self.woken = [], []
        self.accept = True
        real = api._quick_staff_locked

        def counted(*a, **k):
            self.runs.append(1)
            return real(*a, **k)

        def send(slug, nid, *a, **k):
            self.woken.append(nid)
            return {'accepted': self.accept, 'queued': 0}

        for obj, name, kw in [
                (api, 'provider_hire_gate', {'return_value': None}),
                (api, 'hub_changed', {'return_value': None}),
                (api, 'mail_notify', {'return_value': None}),
                (api, '_quick_staff_locked', {'side_effect': counted}),
                (api.supervisor, 'send_message', {'side_effect': send}),
                (quickstaff, 'account_reason', {'return_value': None}),
                (quickstaff, 'supported_efforts', {'return_value': ['low', 'high']}),
                (api, '_providers_payload', {'return_value': {'providers': [
                    {'id': 'claude', 'hire_enabled': True,
                     'tiers': [{'tier': 'haiku', 'seat': 1}]}]}}),
                (staffcache, 'read', {'side_effect': lambda **k: staffcache._compute()}),
                (store, 'write_org', {'side_effect': AssertionError('entered the DOC_LOCK cycle')})]:
            p = patch.object(obj, name, **kw)
            p.start()
            self.addCleanup(p.stop)
        staffcache.reset_for_tests()
        self.addCleanup(staffcache.reset_for_tests)
        appsettings.set_quick_staff_behavior('request')
        appsettings.set_quick_staff_request_accounts(False)
        self.addCleanup(store._POOL.close_all, self.slug)

    def selection(self, tier=None):
        r = self.client.get(self.path, headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()
        return {k: p[k] for k in ('mode', 'configured_mode', 'owner')} | {
            'request_id': str(uuid.uuid4()), **({'tier': tier} if tier else {})}

    def post(self, sel):
        return self.client.post(self.path, headers=HEADERS, json=sel)

    def rev(self):
        return orgtx.backend().revision(self.slug)

    def ticket(self):
        return store.load_org(self.slug)._work_find(self.item)[0]

    def test_request_one_run_one_commit_then_wake(self):
        sel = self.selection()
        r0 = self.rev()
        r = self.post(sel)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.rev(), r0 + 1)
        self.assertEqual(self.ticket()['status'], 'open')
        self.assertEqual(self.woken, [self.owner])

    def test_the_archive_move_is_its_own_transaction_first(self):
        # PG-3w decision 13: the operator's quick staff sweeps the archive in
        # its OWN org_tx before the click's, which runs with the move deferred
        org = store.load_org(self.slug)
        old = org.work_create(self.owner, 'Old widget', 'Broken. Repair it.')['slug']
        org.work_update(self.owner, old, done_so_far=['x'], working_on_next=['y'],
                        status='dropped',
                        dropped_reason='Cancelled by the test; nothing to resume.')
        self._save(org)
        self.assertFalse(store.load_org(self.slug)._work_find(old)[1])
        sel = self.selection()
        seen = []
        orgtx.commit_listeners.append(seen.append)
        try:
            r = self.post(sel)
        finally:
            orgtx.commit_listeners.remove(seen.append)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(store.load_org(self.slug)._work_find(old)[1])
        self.assertEqual(len(self.runs), 1)          # no widening re-run
        self.assertEqual(len(seen), 2, seen)         # the sweep, then the click
        self.assertIn('work_items_archive', seen[0].changes.log_sections)
        self.assertNotIn('work_items_archive', seen[-1].changes.log_sections)

    def _drop_new_item(self, title):
        org = store.load_org(self.slug)
        old = org.work_create(self.owner, title, 'Broken. Repair it.')['slug']
        org.work_update(self.owner, old, done_so_far=['x'], working_on_next=['y'],
                        status='dropped',
                        dropped_reason='Cancelled by the test; nothing to resume.')
        self._save(org)
        return old

    def archived(self, slug):
        return store.load_org(self.slug)._work_find(slug)[1]

    def test_the_click_and_its_undo_defer_the_archive_move(self):
        # the deferral alone: with both sweep steps stubbed out, an
        # archive-eligible item survives the staffing AND its undo
        old = self._drop_new_item('Old widget')
        self.accept = False
        sel = self.selection()
        with patch.dict(pgdoor.BEFORE, {'quick_staff': lambda *a: None,
                                        'quick_staff_undo': lambda *a: None}):
            r = self.post(sel)
        self.assertEqual(self.ticket()['status'], 'backlogged', r.text)
        self.assertFalse(self.archived(old))

    def test_the_undo_sweeps_first_too(self):
        # an item becomes archive-eligible BETWEEN the staffing and its undo
        # (the refused send runs between them): the undo's own sweep moves it
        self.accept = False
        sel = self.selection()
        made = []

        def refuse(slug, nid, *a, **k):
            if not made:
                made.append(self._drop_new_item('Dropped meanwhile'))
            self.woken.append(nid)
            return {'accepted': False, 'queued': 0}

        with patch.object(api.supervisor, 'send_message', side_effect=refuse):
            r = self.post(sel)
        self.assertEqual(self.ticket()['status'], 'backlogged', r.text)
        self.assertTrue(made, 'the refused send never ran')
        self.assertTrue(self.archived(made[0]))

    def test_immediate_modes_one_run_one_commit_then_wake(self):
        for i, mode in enumerate(('under_assignee', 'top_level')):
            with self.subTest(mode=mode):
                if i:          # a fresh backlogged ticket for the second mode
                    org = store.load_org(self.slug)
                    self.item = org.work_create(
                        self.owner, f'Second widget {i}', 'Broken. Repair it.',
                        status='backlogged', done_so_far=['Described.'])['slug']
                    self._save(org)
                    self.path = f'/api/orgs/{self.slug}/work-items/{self.item}/quick-staff'
                appsettings.set_quick_staff_behavior(mode)
                sel = self.selection('haiku')
                del self.runs[:], self.woken[:]
                r0 = self.rev()
                r = self.post(sel)
                self.assertEqual(r.status_code, 200, r.text)
                nid = r.json()['node']
                self.assertEqual(len(self.runs), 1)
                self.assertEqual(self.rev(), r0 + 1)
                self.assertIn(nid, store.load_org(self.slug).nodes)
                self.assertIn(nid, self.woken)

    def _save(self, org):
        # setup writes outside the route: the legacy save, with the
        # DOC_LOCK-cycle tripwire lifted for the one call
        with patch.object(store, 'write_org', wraps=_REAL_WRITE):
            store.save_org(org)

    def test_replay_commits_nothing_and_wakes_nobody(self):
        sel = self.selection()
        self.assertEqual(self.post(sel).status_code, 200)
        del self.runs[:], self.woken[:]
        r0 = self.rev()
        saves, hub, sweeping = [], [], []
        real_save = store.save_org
        real_sweep = pgdoor.BEFORE['quick_staff']

        def sweep(*a, **k):
            # PG-3w decision 13: the archive sweep is its own transaction
            # BEFORE admission, so a replay still sweeps (idempotent
            # housekeeping); only the call's own transaction must not save
            sweeping.append(1)
            try:
                return real_sweep(*a, **k)
            finally:
                sweeping.pop()

        # the legacy path returns a replay from INSIDE its lock, before the
        # save and before the hub fan-out: the door must roll back, not commit
        # an empty transaction
        with patch.object(store, 'save_org',
                          lambda *a, **k: (sweeping or saves.append(1))
                          or real_save(*a, **k)), \
                patch.dict(pgdoor.BEFORE, {'quick_staff': sweep}), \
                patch.object(api, 'hub_changed', lambda *a, **k: hub.append(1)):
            r = self.post(sel)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json().get('replayed'))
        self.assertEqual(self.rev(), r0)
        self.assertEqual((self.woken, saves, hub), ([], [], []))

    def test_refused_kickoff_is_undone_on_the_door(self):
        self.accept = False
        sel = self.selection()
        r0 = self.rev()
        r = self.post(sel)
        # staffing, then its compensating undo: two row transactions
        self.assertEqual(self.rev(), r0 + 2, r.text)
        t = self.ticket()
        self.assertEqual(t['status'], 'backlogged')
        self.assertEqual(t.get('quick_staff_receipts') or {}, {})
        box = (store.load_org(self.slug).d.get('mail') or {}).get(self.owner) or []
        self.assertFalse([m for m in box if m.get('kind') == 'request'])

    def test_name_taken_after_the_snapshot_widens(self):
        appsettings.set_quick_staff_behavior('under_assignee')
        sel = self.selection('haiku')
        # the spec is computed from a snapshot taken BEFORE a racer hired
        # 'repair-the-widget'; the locked document has it, so the seat becomes
        # 'repair-the-widget-2' — a row not declared — and the body widens
        snap = store.load_org(self.slug)
        org = store.load_org(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'repair-the-widget', add_dirs=[],
                 tools=T, org_visibility='self')
        self._save(org)
        attempts = []
        body = pgdoor.BODIES['quick_staff']

        def entered(tx):
            attempts.append(tuple(tx.spec.nodes))
            return body(tx)

        with patch.object(pgdoor, '_snapshot', lambda s: snap), \
                patch.dict(pgdoor.BODIES, {'quick_staff': entered}):
            r = self.post(sel)
        self.assertEqual(r.status_code, 200, r.text)
        # two transaction attempts: the first held the snapshot's rows and
        # widened BEFORE writing anything, so the staffing itself ran once
        self.assertEqual(len(attempts), 2, attempts)
        self.assertNotIn('repair-the-widget-2', attempts[0])
        self.assertIn('repair-the-widget-2', attempts[1])
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(r.json()['node'], 'repair-the-widget-2')


_REAL_WRITE = store.write_org


if __name__ == '__main__':
    unittest.main()
