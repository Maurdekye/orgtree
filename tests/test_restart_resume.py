"""A turn interrupted by a backend restart resumes when the backend returns.

The startup pass that does it is supervisor.reconcile(). It used to begin with
ONE org-wide test — `desktop_import.recovery_pending` — and return [] for the
whole organization when an imported agent's interrupted work had not been
resolved by the operator. That flag is durable and clears only when EVERY
imported agent settles, so on the user's own org (imported 2026-09-08, two of
its three imported agents archived and therefore unsettleable) the pass had
been inert for days: on 2026-09-11 a 2.0.6 restart killed two agents mid-turn
and neither was ever resumed, and thirteen mail batches sat stranded in the
delivery journal because the fold-back never ran either.

Every section below is written against that shape: an org that carries an
UNRESOLVED import while ordinary agents work in it.
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='restart-resume-')
_data = Path(_root.name) / 'data'; _data.mkdir()
_home = Path(_root.name) / 'home'; _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN='operator')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)
from engine.launch import load_app
load_app()
from orgtree import store, ledger, supervisor, desktop_recovery

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), store.DATA_ROOT

RETAINED = 'the imported turn that never dispatched'
SLUGS = []


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class RestartResumeTests(unittest.TestCase):

    # ------------------------------------------------------------- fixtures
    def seed(self, slug, *, imported_marker='a turn started after the import',
             unresolved=True):
        """An org shaped like the user's: ordinary agents mid-turn, plus an
        IMPORTED agent whose retained intent the operator never settled."""
        SLUGS.append(slug)
        org = store.create_org(slug)
        for nid in ('worker', 'other', 'imported', 'idle', 'mailed'):
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        org.node('worker')['inflight'] = {'at': '2026-09-11T11:37:45Z',
                                          'text': 'worker original',
                                          'view': 'worker view'}
        org.node('other')['inflight'] = {'at': '2026-09-11T11:38:08Z',
                                         'text': 'other original',
                                         'view': 'other view'}
        if imported_marker is not None:
            org.node('imported')['inflight'] = {'at': '2026-09-11T11:38:30Z',
                                                'text': imported_marker,
                                                'view': 'imported view'}
        org.post_mail(ledger.USER, 'mailed', 'mail that waited across the restart')
        org.d['desktop_import'] = {
            'source_root': 'C:/old-install',
            'active_nodes': ['imported', 'gone-with-the-import'],
            'recovery_pending': unresolved,
            'recovery_attempts': {
                'imported': {'node': 'imported', 'attempt': 'a1',
                             'phase': 'not-dispatched',
                             'intent': {'text': RETAINED, 'view': RETAINED}},
                # the row that makes the flag unsettleable: an agent that was
                # archived after the import keeps its 'uncertain' phase for
                # good, so `recovery_pending` never goes back to False
                'gone-with-the-import': {'node': 'gone-with-the-import',
                                         'attempt': 'a2', 'phase': 'uncertain',
                                         'intent': {'text': '', 'view': ''}}}}
        store.save_org(org)
        return org

    def run_startup(self, slug, driven):
        """The startup pass exactly as api.py runs it, with the provider seam
        recorded instead of executed."""
        def drive(s, nid, text, **kw):
            driven.append((nid, text, kw))
            return {'accepted': True, 'queued': 0}
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=drive):
            supervisor.reconcile(slug, active_only=True)
        store._POOL.close_all(slug)
        return store.load_org(slug)

    # ----------------------------------------------- §1 the reported failure
    def test_interrupted_turns_resume_while_an_import_stays_unresolved(self):
        self.seed('reported')
        driven = []
        saved = self.run_startup('reported', driven)
        # the two agents killed mid-turn are driven, and so is the imported
        # agent — its marker is a turn it started AFTER the import, not the
        # intent recovery retained
        self.assertEqual(sorted(n for n, _, _ in driven),
                         ['imported', 'other', 'worker'])
        by_node = {n: (text, kw) for n, text, kw in driven}
        text, kw = by_node['worker']
        self.assertIn('[ORGTREE RESTART]', text)
        self.assertIn('CONTINUE from where', text)
        self.assertTrue(text.endswith('worker original'), text[-80:])
        self.assertEqual(kw['view'], 'worker view')
        self.assertTrue(by_node['other'][0].endswith('other original'))
        self.assertTrue(by_node['imported'][0].endswith(
            'a turn started after the import'))
        # nobody else is woken: an idle agent stays idle, and mail alone is
        # not a turn (it rides the next one)
        self.assertNotIn('idle', by_node)
        self.assertNotIn('mailed', by_node)
        self.assertTrue(saved.waking_mail('mailed'))
        # and the markers are spent, so a second restart does not replay them
        for nid in ('worker', 'other', 'imported'):
            self.assertIsNone(saved.node(nid).get('inflight'), nid)

    # ------------------------------------- §2 the import hold is still a hold
    def test_the_retained_import_intent_is_still_held_back(self):
        self.seed('held', imported_marker=RETAINED)
        driven = []
        saved = self.run_startup('held', driven)
        # POSITIVE CONTROL inside the same pass: ordinary interrupted agents
        # were driven, so "imported was not driven" is a decision about
        # imported, not a pass that did nothing.
        self.assertEqual(sorted(n for n, _, _ in driven), ['other', 'worker'])
        self.assertEqual(saved.node('imported')['inflight']['text'], RETAINED)
        self.assertTrue(desktop_recovery.status('held')['pending'])
        self.assertEqual(
            {r['node']: r['phase'] for r in desktop_recovery.status('held')['nodes']},
            {'imported': 'not-dispatched', 'gone-with-the-import': 'uncertain'})

    def test_an_imported_agent_with_no_recovery_record_yet_is_held(self):
        # the recovery panel is lazy: before anyone opens it there is no row,
        # and the marker in hand IS the intent it would retain
        org = self.seed('unrecorded')
        org.d['desktop_import'].pop('recovery_attempts')
        store.save_org(org)
        driven = []
        saved = self.run_startup('unrecorded', driven)
        self.assertEqual(sorted(n for n, _, _ in driven), ['other', 'worker'])
        self.assertEqual(saved.node('imported')['inflight']['text'],
                         'a turn started after the import')

    def test_a_settled_import_stops_holding_its_agent(self):
        org = self.seed('settled', imported_marker=RETAINED)
        org.d['desktop_import']['recovery_attempts']['imported']['phase'] = 'handled'
        store.save_org(org)
        driven = []
        self.run_startup('settled', driven)
        self.assertEqual(sorted(n for n, _, _ in driven),
                         ['imported', 'other', 'worker'])

    # --------------------------------------------- §3 each resumes once only
    def test_each_interrupted_agent_resumes_exactly_once(self):
        self.seed('once')
        driven = []
        self.run_startup('once', driven)
        self.assertEqual(len(driven), 3)
        self.run_startup('once', driven)          # a second restart
        self.assertEqual(sorted(n for n, _, _ in driven),
                         ['imported', 'other', 'worker'])

    # --------------------------------------- §4 the queued mail comes back
    def test_mail_drained_for_a_killed_turn_returns_to_the_mailbox(self):
        org = self.seed('journal')
        org.d['delivering'] = {'worker': [
            {'tok': 'c96b90af6d2bcf7a', 'at': '2026-09-09T18:27:27.769Z',
             'mail': [{'id': 'm1', 'from': 'coordinator', 'kind': 'request',
                       'body': 'the message its turn never delivered'}],
             'notices': []}]}
        store.save_org(org)
        saved = self.run_startup('journal', [])
        self.assertEqual([m['id'] for m in saved.d['mail']['worker']], ['m1'])
        self.assertNotIn('worker', saved.d.get('delivering') or {})

    # -------------------------------- §5 a command turn is dropped, not faked
    def test_a_command_turn_is_dropped_and_its_marker_cleared(self):
        org = self.seed('command')
        org.node('worker')['inflight'] = {'at': '2026-09-11T11:37:45Z',
                                          'text': '/compact', 'cmd': True}
        store.save_org(org)
        driven = []
        saved = self.run_startup('command', driven)
        self.assertEqual(sorted(n for n, _, _ in driven), ['imported', 'other'])
        self.assertIsNone(saved.node('worker').get('inflight'))

    # --------------------------- §6 the mail drain still skips a held agent
    def test_the_mail_drain_skips_a_held_agent_and_wakes_the_others(self):
        org = self.seed('drain', imported_marker=None)
        org.post_mail(ledger.USER, 'imported', 'mail for the imported agent')
        store.save_org(org)
        driven = []

        def drive(s, nid, text, **kw):
            driven.append((nid, text, kw))
            return {'accepted': True, 'queued': 0}
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=drive):
            supervisor.reconcile('drain')          # the full pass, revive too
        # 'mailed' is the positive control: the drain does run and does wake
        # an ordinary agent whose mail waited
        self.assertIn('mailed', [n for n, _, _ in driven])
        self.assertNotIn('imported', [n for n, _, _ in driven])

    # ------------------- §7 a held agent is never condemned as unrecoverable
    def test_a_held_agent_is_not_condemned_while_its_import_is_unresolved(self):
        org = self.seed('condemn', imported_marker=None)
        for nid in ('imported', 'idle'):
            org.node(nid)['cost_usd'] = 1.0       # it has demonstrably run
        store.save_org(org)
        self.run_startup('condemn', [])
        saved = store.load_org('condemn')
        # 'idle' is the positive control: same org, same missing transcript,
        # and №31 does condemn it
        self.assertEqual(saved.node('idle')['state'], 'unrecoverable')
        self.assertEqual(saved.node('imported')['state'], 'live')

    # ------------------- §8 the sweep judges only the store it can actually read
    def test_a_foreign_lane_session_is_not_condemned_for_being_elsewhere(self):
        """`seen` is the claude/journal transcript index. A codex or
        antigravity session is never in it, so its absence says nothing —
        and restoring this pass without that rule would have marked every
        live antigravity agent on the user's own org unrecoverable."""
        org = self.seed('lanes', imported_marker=None)
        org.d.pop('desktop_import')
        for nid in ('worker', 'other', 'idle'):
            org.node(nid)['cost_usd'] = 1.0
            org.node(nid).pop('inflight', None)
        org.node('worker')['codex_thread'] = org.node('worker')['session_id']
        org.node('other')['antigravity_conversation'] = org.node('other')['session_id']
        store.save_org(org)
        self.run_startup('lanes', [])
        saved = store.load_org('lanes')
        # 'idle' is the positive control: a claude-lane node, same org, same
        # missing transcript, and the sweep does condemn it
        self.assertEqual(saved.node('idle')['state'], 'unrecoverable')
        self.assertEqual(saved.node('worker')['state'], 'live')
        self.assertEqual(saved.node('other')['state'], 'live')
        # and a stale marker whose session has been re-minted is claude-native
        # again, so the exemption cannot be claimed by pointing at any id
        stale = dict(saved.node('worker'), session_id='re-minted-since')
        self.assertTrue(supervisor._condemnable(stale, set()))

    # ------------------------------------------- §9 an org with no import
    def test_an_ordinary_org_is_unaffected(self):
        org = self.seed('ordinary', unresolved=False)
        org.d.pop('desktop_import')
        store.save_org(org)
        driven = []
        self.run_startup('ordinary', driven)
        self.assertEqual(sorted(n for n, _, _ in driven),
                         ['imported', 'other', 'worker'])


if __name__ == '__main__':
    unittest.main()
