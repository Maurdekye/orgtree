"""The answered question card must not come back after a restart.

USER REPORT (2026-09-16, another operator's org on 2.1.6-beta.1 / 0d3f271):
"when i restart an org, the last asked question is stuck as an 'answered'
annotation and doesn't go away until some other event that i'm not sure of
interrupts it". Their screenshot shows the resolved card drawn at FULL SIZE —
the whole question body, a fenced JSON block, the answer as its last line —
sitting in the way of the conversation.

THE CAUSE, and it is one line of it that matters: `Ledger.node_ask` lingers the
most recently RESOLVED request so the desk can keep it pinned as the answer's
one visible representation until the answer mail renders in the transcript
(message-visibility invariant, user 2026-09-10 13:22Z). That window was bounded
only by 15 minutes of wall clock measured off the PERSISTED `resolved_at` — so
it outlived the process that opened it. A backend restart changes the
`x-orgtree-instance` header and the client reloads the page (D-60,
tests/restart.test.ts); the reload destroys the desk's in-page record that the
answer was already shown (`answerSeenTranscript`, a useRef in desk.tsx), and the
fresh page can only re-derive it from the transcript window it loaded — which
after a restart is the new CLI session's rows, without the pre-restart answer
mail. So the card re-pinned, at full size, for the rest of the 15 minutes.

WHAT THE FIX MUST PRESERVE, and each has a test below:
  §1  within one process the linger still works — this is not "stop lingering"
  §2  across a restart the card is gone, which is what a session that was
      NEVER restarted looks like once its answer has been handed off
  §3  an OPEN question is never touched: a restart must not hide a live ask
  §4  the 15-minute bound still applies inside one process
  §5  the card is COLLAPSED, not ERASED — the resolved ask keeps its place in
      the user's inbox (`tree['asks']`), which never consulted this window
  §6  the answer is never invisible: a restart while the answer is still
      QUEUED leaves it in the mailbox, which is the desk's other
      representation of exactly one message

Run:  python tools/run-python-verification.py tests/test_answered_card_linger.py
"""

import datetime as dtm
import os
from pathlib import Path
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v2-answered-linger-')
data = Path(_temp.name) / 'data'
data.mkdir()
home = Path(_temp.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                   # noqa: E402
load_app()

from orgtree import ledger as ledger_module, restart_wake, store      # noqa: E402
from orgtree.ledger import USER                                       # noqa: E402

_orgs: list[str] = []


def fixture_org(slug: str):
    org = store.create_org(slug)
    _orgs.append(slug)
    org.hire(USER, None, 'haiku', 0, 'agent', charter='fixture')
    return org


def tearDownModule() -> None:
    _boot('')
    for slug in _orgs:
        store._POOL.close_all(slug)
    _temp.cleanup()


#: Every stamp below is relative to the REAL clock, because the 15-minute bound
#: this change sits beside is measured against it. Fixed calendar dates in a
#: test of a sliding window are a test that silently rots into vacuity: written
#: on 2026-09-16 they pass, and a week later every card is 15 minutes stale and
#: every assertion of absence goes green for the wrong reason.
def _at(seconds_ago: float) -> str:
    """A `resolved_at`, in `ledger.now()`'s millisecond `…Z` format."""
    d = dtm.datetime.now(dtm.timezone.utc) - dtm.timedelta(seconds=seconds_ago)
    return d.strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'


def _booted(seconds_ago: float) -> str:
    """A boot stamp, in `restart_wake.now_iso()`'s `datetime.isoformat()`
    format — offset-bearing and microsecond-wide, deliberately NOT the same
    shape as `_at`, because normalising between the two is what `_boot_at`
    does and a fixture that hands it the easy shape would not test it."""
    return (dtm.datetime.now(dtm.timezone.utc)
            - dtm.timedelta(seconds=seconds_ago)).isoformat()


def _boot(started_at: str) -> None:
    """Pose as a backend process that started at `started_at` (a `now_iso()`
    string, i.e. `datetime.isoformat()`). An empty value restores the real
    per-process caches so nothing leaks into another module's tests."""
    if started_at:
        restart_wake._reset_boot_build_info_for_tests(
            {'backend_pid': 4321, 'commit': 'deadbee', 'commit_short': 'deadbee',
             'branch': 'main', 'dirty': False, 'started_at': started_at})
    else:
        restart_wake._reset_boot_build_info_for_tests(None)
    ledger_module._reset_boot_at_for_tests()


def _answered(org, *, resolved_at: str, mail: str = 'mail-1') -> dict:
    """An agent's question, answered, with the ledger's own stamps overridden
    so the test can place the resolution in time. Going through `ask_user` and
    `ask_answer` rather than hand-writing the row keeps the fixture honest: it
    is the shape the real endpoints file, `answer_mail` binding included."""
    org.ask_user('agent', 'Proceed?', options=[{'label': 'yes'}, {'label': 'no'}])
    aid = org.d['asks'][-1]['id']
    org.ask_answer(aid, selected=['yes'])
    org.bind_answer_mail(mail, ask=aid)
    row = org.d['asks'][-1]
    row['resolved_at'] = resolved_at
    return row


class AnsweredCardLingerTests(unittest.TestCase):

    def tearDown(self) -> None:
        _boot('')

    def test_1_the_linger_still_works_inside_one_process(self):
        # The anti-vacuity control for every test below it. If this one ever
        # goes green by the card being absent, the fix has become "never
        # linger" and the visibility invariant it exists for is gone.
        _boot(_booted(600))                      # this process booted 10 min ago
        org = fixture_org('linger-same-process')
        _answered(org, resolved_at=_at(60))      # the user answered a minute ago
        card = org.node_ask('agent')
        self.assertIsNotNone(card, 'an answer this process posted keeps its card')
        assert card is not None
        self.assertEqual(card['status'], 'answered')
        self.assertEqual(card['answer_mail'], 'mail-1',
                         'and the card still carries the mail the desk hands off against')

    def test_2_a_restart_ends_the_linger(self):
        # THE REPORTED BUG. Same ledger, same 15-minute wall clock, only the
        # process is new — which is exactly what the operator did.
        org = fixture_org('linger-across-restart')
        _boot(_booted(600))
        _answered(org, resolved_at=_at(60))
        self.assertIsNotNone(org.node_ask('agent'), 'fixture: pinned before the restart')
        _boot(_booted(30))                       # ← the restart, after the answer
        self.assertIsNone(org.node_ask('agent'),
                          'the restarted session matches one that was never restarted: '
                          'no card, because the answer was handed off before this process')

    def test_2b_the_boot_second_itself_is_kept(self):
        # The rounding is deliberately on the side of SHOWING the card: an
        # answer resolved in the same second the process booted is a live
        # handoff, not a stale one. Off-by-one here would hide a real card.
        org = fixture_org('linger-boot-second')
        _boot(_booted(60.1))                     # booted 100ms BEFORE the answer
        _answered(org, resolved_at=_at(60.0))    # … in the same wall-clock second
        self.assertIsNotNone(org.node_ask('agent'),
                             'resolved inside the boot second — kept, not dropped')

    def test_3_an_open_question_is_untouched_by_a_restart(self):
        # A restart must never hide a question the user still has to answer.
        # The boot bound guards the RESOLVED pool only; the open branch of
        # node_ask returns before it.
        org = fixture_org('linger-open-ask')
        org.ask_user('agent', 'Still waiting on you?')
        _boot(_booted(0))                        # restarted just now, after the ask
        card = org.node_ask('agent')
        self.assertIsNotNone(card, 'an OPEN question survives any number of restarts')
        assert card is not None
        self.assertEqual(card['status'], 'open')

    def test_4_the_fifteen_minute_bound_still_applies(self):
        # The new bound is an AND, not a replacement. A process that has been
        # up for hours must still drop a card the user resolved long ago.
        org = fixture_org('linger-fifteen-minutes')
        _boot(_booted(7200))                     # up for two hours
        _answered(org, resolved_at=_at(16 * 60))  # answered 16 minutes ago
        self.assertIsNone(org.node_ask('agent'),
                          'resolved far more than 15 minutes ago — still dropped')

    def test_5_the_card_is_collapsed_not_erased(self):
        # The answer text must stay reachable. `tree['asks']` is the user's
        # inbox history and does not consult the linger window at all, so the
        # resolved question and its answer survive the restart that unpins it.
        org = fixture_org('linger-inbox-history')
        _boot(_booted(600))
        _answered(org, resolved_at=_at(60))
        _boot(_booted(30))
        self.assertIsNone(org.node_ask('agent'), 'fixture: the desk card is gone')
        rows = [a for a in org.tree()['asks'] if a['node'] == 'agent']
        self.assertEqual(len(rows), 1, 'the resolved ask is still in the inbox')
        self.assertEqual(rows[0]['status'], 'answered')
        self.assertEqual(rows[0]['question'], 'Proceed?')
        self.assertEqual(rows[0]['answer']['selected'], ['yes'],
                         'and the answer itself is still readable there')

    def test_6_an_answer_still_queued_at_restart_is_not_invisible(self):
        # The one case where dropping the card could have cost visibility.
        # The desk suppresses the answer's own pending bubble only while it is
        # drawing the card, so with no card the queued mail renders as a
        # queued bubble. Asserted at this layer as "the mail is still in the
        # box the desk reads as `pending_mail`".
        org = fixture_org('linger-queued-answer')
        _boot(_booted(600))
        org.ask_user('agent', 'Proceed?')
        aid = org.d['asks'][-1]['id']
        org.ask_answer(aid, selected=['yes'])
        org.d.setdefault('mail', {}).setdefault('agent', []).append(
            {'id': 'mail-q', 'from': '@user', 'kind': 'message',
             'body': 'Answer: yes', 'at': _at(60)})
        org.bind_answer_mail('mail-q', ask=aid)
        org.d['asks'][-1]['resolved_at'] = _at(60)
        _boot(_booted(30))
        self.assertIsNone(org.node_ask('agent'))
        self.assertIn('mail-q', [m['id'] for m in org.d['mail']['agent']],
                      'the undelivered answer is still queued, so the desk has a '
                      'representation for it — exactly one, as the invariant requires')

    def test_7_an_unreadable_boot_stamp_keeps_the_old_behaviour(self):
        # A missing boot stamp is not evidence of a restart. Degrade to the
        # wall-clock-only window rather than hiding a card on a guess.
        org = fixture_org('linger-no-boot-stamp')
        restart_wake._reset_boot_build_info_for_tests({'backend_pid': 1, 'started_at': ''})
        ledger_module._reset_boot_at_for_tests()
        self.assertEqual(ledger_module.Org._boot_at(), '')
        _answered(org, resolved_at=ledger_module.now())
        self.assertIsNotNone(org.node_ask('agent'),
                             'no stamp to judge by — the card stands, as before')


if __name__ == '__main__':
    unittest.main()
