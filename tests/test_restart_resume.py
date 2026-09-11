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
             imported_marker_at='2026-09-11T11:38:30.101Z',
             retained_text=RETAINED, retained_at=None, unresolved=True):
        """An org shaped like the user's: ordinary agents mid-turn, plus an
        IMPORTED agent whose retained intent the operator never settled."""
        SLUGS.append(slug)
        org = store.create_org(slug)
        for nid in ('worker', 'other', 'imported', 'idle', 'mailed'):
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        org.node('worker')['inflight'] = {'at': '2026-09-11T11:37:45.001Z',
                                          'text': 'worker original',
                                          'view': 'worker view'}
        org.node('other')['inflight'] = {'at': '2026-09-11T11:38:08.002Z',
                                         'text': 'other original',
                                         'view': 'other view'}
        if imported_marker is not None:
            marker = {'text': imported_marker, 'view': 'imported view'}
            if imported_marker_at:
                marker['at'] = imported_marker_at
            org.node('imported')['inflight'] = marker
        retained = {'text': retained_text, 'view': retained_text}
        if retained_at:
            retained['at'] = retained_at
        org.post_mail(ledger.USER, 'mailed', 'mail that waited across the restart')
        org.d['desktop_import'] = {
            'source_root': 'C:/old-install',
            'active_nodes': ['imported', 'gone-with-the-import'],
            'recovery_pending': unresolved,
            'recovery_attempts': {
                'imported': {'node': 'imported', 'attempt': 'a1',
                             'phase': 'not-dispatched',
                             'intent': retained},
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

    def test_the_marker_stamp_identifies_the_turn_not_its_prose(self):
        """Two markers are the same turn when their stamps match. Comparing
        the text instead would hold a later turn that happens to repeat an
        earlier prompt FOR EVER, which is the failure this whole item is
        about (reviewer, 2026-09-11)."""
        stamp = '2026-09-10T21:00:35.880Z'
        # (a) same words, later turn — it is a LATER TURN and it must resume
        self.seed('repeat', retained_at=stamp, imported_marker=RETAINED,
                  imported_marker_at='2026-09-11T11:38:30.101Z')
        driven = []
        self.run_startup('repeat', driven)
        self.assertIn('imported', [n for n, _, _ in driven])
        # (b) same turn, different words — the import rewrites a marker's text
        # itself ("[V1 COPY IMPORT] …", desktop_import), so the stamp decides
        self.seed('rewritten', retained_at=stamp,
                  imported_marker='[V1 COPY IMPORT] ' + RETAINED,
                  imported_marker_at=stamp)
        driven = []
        saved = self.run_startup('rewritten', driven)
        self.assertEqual(sorted(n for n, _, _ in driven), ['other', 'worker'])
        self.assertEqual(saved.node('imported')['inflight']['at'], stamp)

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

    # ----- §8 the operator's resume button, with an ordinary agent mid-turn
    def mixed(self, slug):
        """One IMPORTED node holding the retained intent, one ORDINARY node
        mid-turn. `imported` is hired first, so it dispatches first."""
        SLUGS.append(slug)
        org = store.create_org(slug)
        for nid in ('imported', 'ordinary'):
            org.hire(ledger.USER, None, 'haiku', 0, nid)
        org.node('imported')['inflight'] = {'at': '2026-09-08T17:35:00.000Z',
                                            'text': RETAINED, 'view': 'im'}
        org.node('ordinary')['inflight'] = {'at': '2026-09-11T11:38:08.002Z',
                                            'text': "an ordinary agent's turn",
                                            'view': 'ord'}
        org.d['desktop_import'] = {'active_nodes': ['imported'],
                                   'recovery_pending': True}
        store.save_org(org)
        return org

    def test_resume_import_drives_both_and_observes_only_the_imported_node(self):
        self.mixed('mixed')
        seen, driven = [], []
        real_observe = desktop_recovery._observe

        def observe(slug, nid, stage, result=None):
            seen.append((nid, stage))
            return real_observe(slug, nid, stage, result)
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message',
                          side_effect=lambda s, n, t, **k: (
                              driven.append((n, t)),
                              {'accepted': True, 'queued': 0})[1]), \
             patch.object(desktop_recovery, '_observe', side_effect=observe):
            result = desktop_recovery.resume_import('mixed')
        # the observer belongs to the imported agent alone — handing it the
        # ordinary one raised KeyError out of the whole pass, after every
        # marker had already been taken
        self.assertEqual({nid for nid, _ in seen}, {'imported'})
        self.assertEqual([n for n, _ in driven], ['imported', 'ordinary'])
        self.assertEqual(result['pending'], [])
        store._POOL.close_all('mixed')
        saved = store.load_org('mixed')
        for nid in ('imported', 'ordinary'):
            self.assertIsNone(saved.node(nid).get('inflight'), nid)

    def test_a_marker_is_never_spent_by_a_dispatch_that_did_not_happen(self):
        self.mixed('aborted')
        driven = []

        def drive(s, nid, text, **kw):
            driven.append(nid)
            raise RuntimeError('admission rejected')
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=drive):
            with self.assertRaises(RuntimeError):
                desktop_recovery.resume_import('aborted')
        self.assertEqual(driven, ['imported'])     # it never reached 'ordinary'
        store._POOL.close_all('aborted')
        saved = store.load_org('aborted')
        # the turn nobody dispatched is still there for the next restart...
        self.assertEqual(saved.node('ordinary')['inflight']['text'],
                         "an ordinary agent's turn")
        # ...and the imported agent's intent is retained the way it always was
        self.assertEqual(
            saved.d['desktop_import']['recovery_intents']['imported']['text'],
            RETAINED)

    def test_an_accepted_turn_stays_spent_when_its_result_observer_raises(self):
        """The observer writes to storage after the turn has been handed over,
        so it can raise on a turn that WAS accepted. Counting the dispatch
        after it would put that marker back and replay the turn at the next
        restart (reviewer, 2026-09-11) — while the seat the loop never reached
        would keep its marker. One boundary decides both."""
        self.mixed('late-error')
        driven = []
        real_observe = desktop_recovery._observe

        def observe(slug, nid, stage, result=None):
            if stage == 'result':
                raise RuntimeError('the recovery row moved under us')
            return real_observe(slug, nid, stage, result)
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message',
                          side_effect=lambda s, n, t, **k: (
                              driven.append(n),
                              {'accepted': True, 'queued': 0})[1]), \
             patch.object(desktop_recovery, '_observe', side_effect=observe):
            with self.assertRaises(RuntimeError):
                desktop_recovery.resume_import('late-error')
        self.assertEqual(driven, ['imported'])
        store._POOL.close_all('late-error')
        saved = store.load_org('late-error')
        # accepted -> spent, even though the bookkeeping after it blew up
        self.assertIsNone(saved.node('imported').get('inflight'))
        # never reached -> still there for the next restart
        self.assertEqual(saved.node('ordinary')['inflight']['text'],
                         "an ordinary agent's turn")

    def test_a_restored_marker_never_overwrites_a_turn_that_started_since(self):
        self.mixed('overtaken')
        fresh = {'at': '2026-09-11T12:00:00.000Z', 'text': 'a brand new turn'}

        def drive(s, nid, text, **kw):
            # the ordinary node starts a new turn while this pass is still
            # dispatching, and then the imported seat's admission fails
            with store.DOC_LOCK:
                live = store.load_org('overtaken')
                live.node('ordinary')['inflight'] = dict(fresh)
                store.save_org(live)
            raise RuntimeError('admission rejected')
        with patch.object(supervisor, '_transcript_evidence', return_value=set()), \
             patch.object(supervisor, '_reconcile_steer_records'), \
             patch.object(supervisor, 'send_message', side_effect=drive):
            with self.assertRaises(RuntimeError):
                desktop_recovery.resume_import('overtaken')
        store._POOL.close_all('overtaken')
        saved = store.load_org('overtaken')
        self.assertEqual(saved.node('ordinary')['inflight'], fresh)

    # ------------------- §9 the sweep judges only the store it can actually read
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
