"""The cache-protective cheap-compaction gate, pinned to a live incident.

2026-09-16T06:02:20Z, node `answer-crash`: 518641 tokens of a 1,000,000 window
(52%), org floor 25%, forecast `expired_known_entry` after seven idle hours, and
no compaction. Every guard in `_auto_cheap_context_ready` was clear except one —
the agent had reported `blocked` at 22:50:23Z while it waited for the user to
answer its question, and the gate read that stale word as "durably blocked".

The word is stale by construction at that site: a turn start pops `last_status`
into `prev_status`, and that pop runs AFTER the gate, so the gate always reads
the PREVIOUS turn's self-report while a turn is being admitted. The recorded
node still carries the proof — `prev_status` holds the 22:50:23Z blocked row.

These tests hold both halves: the recorded shape must compact, and the thing the
old guard was worth keeping — never mooting a request the user has not resolved
— must still refuse.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='auto-cheap-gate-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import cachecontinuity as cc, ledger, store, supervisor as sup

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()

# ── the recorded 06:02:20Z shape ──────────────────────────────────────────
OCCUPANCY = 518641                 # measured, not estimated
WINDOW = 1_000_000                 # opus, pinned per tier
CFG = {'occ': 0.25}                # org auto_cheap_compact {enabled, occ}
MODELS = {'opus': 'claude-opus-5'}
BLOCKED_AT = '2026-09-15T22:50:23.489Z'
RECEIPT_AT = '2026-09-15T22:50:41.223000Z'
ADMITTED_AT = '2026-09-16T06:02:21.000000Z'
NOW = 1789538541.0                 # epoch of ADMITTED_AT
COMPONENTS = {'system': 'a' * 32, 'tools': 'b' * 32, 'argv': 'c' * 32,
              'env': 'd' * 32, 'startup': 'e' * 64, 'lineage': 'f' * 32,
              'mcp_surface': '0' * 32}
LANE = {'provider': 'claude', 'account': 'claude-4', 'lane': 'subscription',
        'model': 'claude-opus-5', 'session': 'ee021129-803f-4ab4-8a69',
        'node_generation': 0, 'components': COMPONENTS}


def recorded_node(**over):
    """The node document as the 06:02:20Z admission read it."""
    n = {'state': 'live', 'model': 'opus', 'occupancy': OCCUPANCY,
         'session_id': LANE['session'], 'generation': 0,
         'occupancy_est': None, 'compacted_unrun': None, 'session_unrun': None,
         'cheap_compacted': None, 'bearer_state': None, 'frozen': None,
         'limit_locked': None, 'remote_controlled': None,
         'last_status': {'status': 'blocked', 'at': BLOCKED_AT,
                         'summary': 'waiting on the user to answer q87f7f3e9'}}
    n.update(over)
    return n


def expired_forecast(history):
    """The real classifier's verdict on the recorded book, at 06:02:21Z."""
    book = {'last_turn': {**LANE, 'history': history,
                          'observed_at': RECEIPT_AT},
            'receipt': {**LANE, 'history': history, 'observed_at': RECEIPT_AT}}
    current = {**LANE, 'captured_at': ADMITTED_AT,
               'expected_input_tokens': OCCUPANCY,
               'last_turn_history_relation': 'same_or_appended',
               'receipt_history_relation': 'same_or_appended'}
    return cc.classify(current, book, NOW)


HISTORY = {'bytes': 16, 'sha256': hashlib.sha256(b'x' * 16).hexdigest()}


class RecordedIncidentTests(unittest.TestCase):
    """The pure gate, over the exact shape that failed to compact."""

    def setUp(self):
        self.forecast = expired_forecast(HISTORY)

    def test_the_recorded_forecast_really_was_a_cold_entry(self):
        # Not an assumption carried in from the incident report: the shipped
        # classifier, given the book as it stood, says the entry is gone.
        self.assertEqual(self.forecast['state'], 'expired_known_entry')
        self.assertEqual(self.forecast['ttl_seconds'], 3600)

    def test_the_recorded_shape_compacts(self):
        # THE REGRESSION. Before the fix this is False, refused with
        # "the agent is durably blocked".
        self.assertTrue(sup._auto_cheap_ready(
            recorded_node(), CFG, self.forecast, MODELS))

    def test_a_blocked_report_is_not_a_reason_to_skip_compaction(self):
        ready, why = sup._auto_cheap_context_ready(
            recorded_node(), CFG, MODELS)
        self.assertTrue(ready, why)
        self.assertIn('52%', why)
        # and identically with no status at all: the word must not decide it
        self.assertEqual(
            sup._auto_cheap_context_ready(
                recorded_node(last_status=None), CFG, MODELS)[0], ready)

    def test_an_unresolved_user_request_still_refuses(self):
        # The half of the old guard worth keeping: `cheap_compact` moots the
        # seat's open request batch, so a standing card must outlive the gate.
        ready, why = sup._auto_cheap_context_ready(
            recorded_node(), CFG, MODELS, open_request=True)
        self.assertFalse(ready)
        self.assertIn('moot', why)
        self.assertFalse(sup._auto_cheap_ready(
            recorded_node(), CFG, self.forecast, MODELS, open_request=True))

    def test_the_other_guards_are_untouched(self):
        for over, fragment in (
                ({'state': 'archived'}, 'not live'),
                ({'frozen': {'limit': True}}, 'frozen'),
                ({'occupancy': None}, 'unmeasured'),
                ({'occupancy_est': 4}, 'estimated'),
                ({'cheap_compacted': True}, 'estimated'),
                ({'bearer_state': 'kept'}, 'knowledge-bearer'),
                ({'occupancy': 200_000}, 'below')):
            with self.subTest(over=over):
                ready, why = sup._auto_cheap_context_ready(
                    recorded_node(**over), CFG, MODELS)
                self.assertFalse(ready)
                self.assertIn(fragment, why)

    def test_a_warm_forecast_still_refuses(self):
        # Time enters solely through the receipt, as the docstring promises.
        warm = cc.classify(
            {**LANE, 'captured_at': RECEIPT_AT,
             'last_turn_history_relation': 'same_or_appended',
             'receipt_history_relation': 'same_or_appended'},
            {'last_turn': {**LANE, 'history': HISTORY,
                           'observed_at': RECEIPT_AT},
             'receipt': {**LANE, 'history': HISTORY,
                         'observed_at': RECEIPT_AT}},
            cc.epoch(RECEIPT_AT) + 60)
        self.assertEqual(warm['state'], 'compatible_observed')
        self.assertFalse(sup._auto_cheap_ready(
            recorded_node(), CFG, warm, MODELS))


class OpenRequestReadingTests(unittest.TestCase):
    """`_auto_cheap_open_request` over a real org document."""

    def setUp(self):
        self.slug = self._testMethodName.replace('_', '-')[:40]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 0, 'worker')
        store.save_org(org)

    def tearDown(self):
        store._POOL.close_all(self.slug)

    def org(self):
        return store.load_org(self.slug)

    def test_no_request_no_refusal(self):
        self.assertFalse(sup._auto_cheap_open_request(self.org(), 'worker'))

    def test_an_open_question_is_seen_and_an_answered_one_is_not(self):
        org = self.org()
        r = org.ask_user('worker', 'which way?', [{'label': 'left'},
                                                  {'label': 'right'}])
        store.save_org(org)
        self.assertTrue(sup._auto_cheap_open_request(self.org(), 'worker'))
        # …and the answer closes the row BEFORE `ask_answer` drives the node,
        # which is what lets the answer's own wake compact.
        org = self.org()
        org.ask_answer(r['asked'], selected=['left'])
        store.save_org(org)
        self.assertFalse(sup._auto_cheap_open_request(self.org(), 'worker'))

    def test_another_agents_open_question_does_not_hold_this_seat(self):
        org = self.org()
        org.hire(ledger.USER, None, 'opus', 0, 'other')
        org.ask_user('other', 'which way?')
        store.save_org(org)
        self.assertFalse(sup._auto_cheap_open_request(self.org(), 'worker'))
        self.assertTrue(sup._auto_cheap_open_request(self.org(), 'other'))

    def test_the_badge_and_the_gate_give_the_same_answer(self):
        org = self.org()
        org.node('worker').update(recorded_node())
        org.d['auto_cheap_compact'] = {'enabled': True, 'occ': 0.25}
        org.d['models'] = dict(MODELS)
        store.save_org(org)
        action, why = sup._cache_precompact_decision(
            self.org(), 'worker', expired_forecast(HISTORY))
        self.assertEqual((action, 'moot' in why), ('will_compact', False))
        # a standing question flips the badge in step with the gate
        org = self.org()
        org.ask_user('worker', 'which way?')
        store.save_org(org)
        action, why = sup._cache_precompact_decision(
            self.org(), 'worker', expired_forecast(HISTORY))
        self.assertEqual(action, 'not_applicable')
        self.assertIn('moot', why)


class AdmissionPathTests(unittest.TestCase):
    """The carrier half: an ask answer reaches the gate, and it fires there.

    `api.ask_answer` posts the answer mail and then calls
    `supervisor.send_message(mail_ping=True, ping_reason='ask_answer')`, which
    is the ordinary drive door — no separate delivery path exists for it. This
    runs the real `_run_one_turn_recorded` over that carrier and stops it one
    statement past the gate, so what is asserted is the gate's live effect on
    the ledger rather than a reading of the code.
    """

    class Reached(RuntimeError):
        """Raised where the drain begins — immediately after the gate."""


    def _stop_at_drain(self, *a, **kw):
        self.drain_reached = True
        raise self.Reached('past the gate')

    def setUp(self):
        self.drain_reached = False
        self.slug = 'admission-' + self._testMethodName.replace('_', '-')[-24:]
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, 'opus', 0, 'worker')
        org.d['auto_cheap_compact'] = {'enabled': True, 'occ': 0.25}
        org.d['models'] = dict(MODELS)
        n = org.node('worker')
        n.update({k: v for k, v in recorded_node().items()
                  if k not in ('generation',)})
        n['session_id'] = org.node('worker')['session_id']
        store.save_org(org)
        self.session_before = org.node('worker')['session_id']

        # a real history file, so the shipped prefix comparison runs for real
        self.history_file = Path(_root.name) / f'{self.slug}-history.jsonl'
        self.history_file.write_bytes(b'x' * 16)
        history = {'bytes': 16,
                   'sha256': hashlib.sha256(b'x' * 16).hexdigest()}
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.node('worker')['cache_continuity'] = {
                'version': 1, 'seq': 1,
                'last_turn': {**LANE, 'session': self.session_before,
                              'history': history, 'observed_at': RECEIPT_AT},
                'receipt': {**LANE, 'session': self.session_before,
                            'history': history, 'observed_at': RECEIPT_AT}}
            store.save_org(org)

        def snapshot(org_, nid, **kw):
            return {**LANE, 'session': self.session_before,
                    'captured_at': ADMITTED_AT,
                    'expected_input_tokens': OCCUPANCY,
                    'fingerprint': 'fp', '_history_path': str(self.history_file)}

        self.patches = [
            patch.object(sup, '_cache_snapshot', side_effect=snapshot),
            patch.object(sup, 'spawn_env', return_value={}),
            patch.object(sup, '_deployment_org_gate'),
            patch.object(sup.appsettings, 'subscription_inference_enabled',
                         return_value=True),
            patch.object(sup, 'export_predecessor_transcript'),
            patch.object(sup, '_take_delivery_mail',
                         side_effect=self._stop_at_drain),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        store._POOL.close_all(self.slug)

    def admit(self):
        """Run the real admission path over an ask-answer carrier."""
        carrier = {'text': '(orgtree) The mail above answers the question you '
                           'asked the user — act on it now.',
                   'view': '', 'ping': True, 'ping_reason': 'ask_answer',
                   'mail_ids': []}
        # The sentinel stops the turn where the mail drain begins — one
        # statement past the gate. `_run_one_turn_recorded` owns its own
        # failure handling, so the stop is observed as "the turn ended here"
        # rather than as a propagated exception; what is asserted is the
        # gate's effect on the ledger, which is written before this point.
        try:
            sup._run_one_turn_recorded(self.slug, 'worker', carrier)
        except Exception:                                    # noqa: BLE001
            pass
        self.assertTrue(self.drain_reached,
                        'the turn never reached the mail drain — the gate '
                        'was not evaluated on this carrier')

    def test_the_ask_answer_carrier_compacts_at_the_gate(self):
        self.admit()
        org = store.load_org(self.slug)
        self.assertNotEqual(org.node('worker')['session_id'],
                            self.session_before)
        bearers = [nid for nid, n in org.nodes.items()
                   if n.get('successor') == 'worker']
        self.assertEqual(len(bearers), 1)

    def test_a_standing_question_holds_the_same_carrier_back(self):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.ask_user('worker', 'which way?')
            store.save_org(org)
        self.admit()
        org = store.load_org(self.slug)
        self.assertEqual(org.node('worker')['session_id'],
                         self.session_before)
        self.assertEqual([a['status'] for a in org.d['asks']], ['open'])


if __name__ == '__main__':
    unittest.main()
