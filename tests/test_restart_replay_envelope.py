"""A RESTART-INTERRUPTED REPLAY must not put the mail envelope on the desk as
prose, and must not stack one envelope per restart.

USER REPORT 2026-09-16: "every time i restart orgtree the agents get this long
unformatted block with several recent events run together". The specimen was
`booking-dorix-plan`, showing TWO consecutive `[MAIL — 1 message(s)]` blocks —
not one block saying 2 — inside a single displayed message.

WHAT IS ACTUALLY WRONG, read out of stored rows rather than guessed. The
restart notice is fine: `restart_wake.on_backend_startup` drops exactly one per
agent and supersedes any unread one (measured 2026-09-16: 105 mailboxes, one
notice each). What the user is looking at is the INTERRUPTED-TURN REPLAY. A turn
killed by the shutdown has its whole enveloped text frozen on the node
(`inflight`), and the next boot re-sends it. Two things then go wrong:

  1. the replay carrier brings `text` + `view` and NOTHING ELSE, so
     `_segments_for` falls to its last branch and files the entire projection —
     `[MAIL — 1 message(s)] … [END MAIL]` and all — as {'kind': 'text'}. The
     desk renders a text segment through `md()`, so the internal envelope is
     printed as the agent's words.
  2. the replay text is itself frozen if the NEXT restart interrupts it, so
     the preamble and the envelope under it accumulate, once per restart.

Measured on this machine (2026-09-16, 553 projection sidecars, 4721 rows
carrying segments): 109 rows file a whole `[MAIL]` envelope inside a text
segment, and 41 of those ALSO carry a proper `mail` segment — the same turn
drawing a clean card beside a raw block. Observed nesting depth 2.

⚠ ANTI-VACUITY. §0 drives the carrier shape reconcile built BEFORE the fix and
REQUIRES the raw text segment to appear. If the instrument could not see the
defect, §1 passing would mean nothing. §0 keeps passing after the fix — it is a
statement about the legacy carrier shape, which is still the honest fallback
when a frozen composition is missing.

⚠ AND THE AGENT'S PROMPT IS NOT ALLOWED TO GET POORER. §4 is that guard: the
build identity, the commit and the ancestry hint still reach the model, and so
does the text of the turn being resumed. A "fix" that cleaned up the desk by
withholding facts from agents fails there.

    python -B tests/test_restart_replay_envelope.py
"""
import json, os, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='restart-replay-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'restart-replay-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app          # noqa: E402
load_app()
from orgtree import chat_window, events, ledger, store, supervisor as sup  # noqa: E402
from orgtree import transcript_records as records                  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


#: the running build, as `restart_wake.get_boot_build_info` reports it
BUILD = {
    'commit': '0d3f2719c4b0a1f2e3d4c5b6a7980f1e2d3c4b5a',
    'commit_short': '0d3f271',
    'dirty': False,
    'backend_pid': 25404,
    'provenance': 'source',
    'started_at': '2026-09-16T08:54:51.070861+00:00',
    'branch': 'main',
    'version': '2.1.6-beta.1',
}

#: the restart notice exactly as `restart_wake` mints and renders it
NOTICE_BODY = events.render_agent(events.mint(
    'runtime.restart_notice', {'kind': 'system', 'id': '@system'},
    {'kind': 'build', 'commit': BUILD['commit'], 'short': BUILD['commit_short'],
     'dirty': False, 'pid': 42808, 'provenance': 'source'},
    prev_pid=42808, started_at='2026-09-16T08:03:37.070861+00:00',
    branch='main', version='2.1.5'))

#: the interrupted turn's own projection — a mail envelope, which is what the
#: human projection of ANY mail turn looks like. This is the string that ends
#: up on screen as prose today.
FROZEN_VIEW = ('[MAIL — 1 message(s)]\n'
               'NOTICE FROM orgtree (system) · ⟦t:2026-09-16T08:03:37.101Z|full⟧'
               ' — informational, delivered passively; no reply is expected\n'
               + NOTICE_BODY + '\n[END MAIL]')

#: ...and the bytes that went to the model beside it
FROZEN_RAW = ('[ORG STATE #1 — current as of 2026-09-16T08:03:37.101Z.]\n'
              'Your reports: none yet.\n[END ORG STATE]\n\n' + FROZEN_VIEW)


def text_segments(segments):
    return [s for s in (segments or []) if s.get('kind') == 'text']


def envelopes_in_text_segments(segments):
    """Every mail envelope a text segment would print as prose. Counted by
    KIND, never by scanning a rendered string: a `mail` segment carrying the
    same envelope is the RIGHT answer and must not be flagged here."""
    return [(len(s['text']), s['text'][:60])
            for s in text_segments(segments) if '[MAIL —' in str(s.get('text'))]


def segment_variants(segments, kind):
    out = []
    for s in segments or []:
        if s.get('kind') != kind:
            continue
        ev = s.get('event') or {}
        out.append(str(ev.get('variant') or ''))
    return out


def mail_rows(segments):
    return [r for s in (segments or []) if s.get('kind') == 'mail'
            for r in s.get('rows') or []]


class RestartReplay(unittest.TestCase):
    def setUp(self):
        slug = 'restartreplay-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(self.org)
        self.slug = slug
        self.sid = self.org.node('agent')['session_id']
        self.path = Path(fx.name) / (slug + '.jsonl')
        self.path.write_bytes(b'')
        pt = patch.object(sup, 'transcript_path', return_value=str(self.path))
        pt.start()
        self.addCleanup(pt.stop)

    def compose(self, text, view, segments=None):
        """the REAL composer, on a carrier of the replay shape"""
        views, segs = [], []
        enveloped, _tok, _imgs = sup._envelope(
            self.slug, 'agent', text, via='turn', base_view=view,
            view_out=views, segments_out=segs,
            **({'carried': segments} if segments is not None else {}))
        return enveloped, (views[0] if views else ''), (segs[0] if segs else [])

    # ------------------------------------------------------------------ §0
    def test_0_ANTIVACUITY_the_legacy_carrier_really_does_leak_the_envelope(self):
        """The shape reconcile produced before the fix: preamble + frozen text,
        with the frozen projection beside it and no composition. The whole
        envelope lands in a text segment. If this ever stops reproducing, §1
        below is proving nothing."""
        legacy_text = sup.RESTART_REPLAY_PREAMBLE + '\n\n' + FROZEN_RAW
        _raw, _visible, segments = self.compose(legacy_text, FROZEN_VIEW)
        leaked = envelopes_in_text_segments(segments)
        self.assertTrue(
            leaked,
            'the instrument cannot see the defect: a carrier with no frozen '
            'composition filed no envelope as prose (segments=%r)'
            % ([s.get('kind') for s in segments],))

    # ------------------------------------------------------------------ §1
    def test_1_the_replay_composition_files_no_envelope_as_prose(self):
        """THE REPORTED BUG. The interrupted turn's own typed composition is
        frozen with it and handed back, so its mail renders as the same cards
        it rendered the first time — never as `[MAIL — …]` prose."""
        frozen = sup._segments_for(
            [self._notice_row()], None, None)
        text, view, segments = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW, 'segments': frozen},
            BUILD)
        _raw, _visible, composed = self.compose(text, view, segments=segments)
        self.assertEqual(
            envelopes_in_text_segments(composed), [],
            'the replay filed a mail envelope as a human text segment — the '
            'desk renders that through md() as the agent\'s words')
        self.assertTrue(mail_rows(composed),
                        'the replayed mail vanished instead of being carded')
        self.assertIn('runtime.restart_notice',
                      [str((r.get('ev') or {}).get('variant') or '')
                       for r in mail_rows(composed)],
                      'the replayed restart notice lost its typed event')

    # ------------------------------------------------------------------ §2
    def test_2_the_human_is_told_WHY_the_text_is_back(self):
        """Today the `[ORGTREE RESTART] … continue where you left off`
        explanation is in the model's copy and NOT in `view`, so the reader
        watches an old envelope reappear with no account of itself."""
        frozen = sup._segments_for([self._notice_row()], None, None)
        _text, _view, segments = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW, 'segments': frozen},
            BUILD)
        self.assertIn('context.drive_restart_interrupted',
                      segment_variants(segments, 'drive'),
                      'the composition carries no typed account of the restart')
        self.assertTrue(
            events.human_visible_variant('context.drive_restart_interrupted'),
            'the account is typed but human-hidden, so the desk still draws '
            'nothing and the reader still has no explanation')

    # ------------------------------------------------------------------ §3
    def test_3_a_replay_of_a_replay_does_not_stack(self):
        """Restart twice and the second freeze holds the first replay. The
        preamble and its card must not accumulate once per restart."""
        frozen = sup._segments_for([self._notice_row()], None, None)
        once_text, once_view, once_segs = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW, 'segments': frozen}, BUILD)
        # the second shutdown freezes exactly what the first replay sent
        twice_text, _v, twice_segs = sup._restart_replay(
            {'text': once_text, 'view': once_view, 'segments': once_segs}, BUILD)
        self.assertEqual(
            twice_text.count(sup.RESTART_REPLAY_PREAMBLE), 1,
            'the preamble stacked: %d copies in the replayed text'
            % twice_text.count(sup.RESTART_REPLAY_PREAMBLE))
        self.assertEqual(
            segment_variants(twice_segs, 'drive').count(
                'context.drive_restart_interrupted'), 1,
            'the restart card stacked: %r'
            % (segment_variants(twice_segs, 'drive'),))
        # …and the turn being resumed is still in there exactly once
        self.assertEqual(twice_text.count('[END MAIL]'), 1,
                         'the frozen envelope was duplicated')

    # ------------------------------------------------------------------ §4
    def test_4_CONTROL_the_agent_still_gets_the_build_facts(self):
        """The prompt must not get poorer to make the transcript prettier.

        Two halves, because two different notices are in play. The REPLAY
        repeats the interrupted turn, so the build it carries is the one that
        was live then (2.1.5 here). The build that is live NOW reaches the
        agent the ordinary way — a fresh notice in the mailbox, drained into
        the same envelope — and that is the second half."""
        frozen = sup._segments_for([self._notice_row()], None, None)
        text, view, segments = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW, 'segments': frozen}, BUILD)
        for fact in (BUILD['commit'], '2.1.5',
                     'git merge-base --is-ancestor',
                     'orgtree_restart_wake'):
            self.assertIn(fact, text,
                          'the replayed prompt lost %r' % fact)
        self.assertIn('CONTINUE from where you left off', text,
                      'the replay lost its instruction to the agent')
        self.assertIn('[ORG STATE', text,
                      'the replay lost the frozen turn\'s own text')
        # …and the CURRENT build still arrives, through the mailbox
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            row = self._notice_row()
            row['body'] = row['body'].replace('2.1.5', BUILD['version'])
            org.d.setdefault('mail', {}).setdefault('agent', []).append(row)
            store.save_org(org)
        enveloped, _visible, composed = self.compose(text, view,
                                                     segments=segments)
        self.assertIn(BUILD['version'], enveloped,
                      'the freshly boxed notice did not reach the model text')
        self.assertEqual(envelopes_in_text_segments(composed), [],
                         'a fresh notice arriving on top of a replay put the '
                         'envelope back into a text segment')

    # ------------------------------------------------------------------ §5
    def test_5_CONTROL_a_carrier_with_no_frozen_composition_is_unchanged(self):
        """The honest fallback. A marker written by an older build carries no
        `segments`, and that replay must still work exactly as it does today —
        the projection stands as its own tail."""
        text, view, segments = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW}, BUILD)
        self.assertIsNone(segments,
                          'a marker with no frozen composition must claim none')
        self.assertEqual(view, FROZEN_VIEW)
        self.assertTrue(text.endswith(FROZEN_RAW))
        _raw, _visible, composed = self.compose(text, view, segments=segments)
        tails = text_segments(composed)
        self.assertEqual(tails[-1]['text'] if tails else None, FROZEN_VIEW,
                         'the legacy fallback stopped using the projection as '
                         'its tail (test_replay_envelope_segments §1)')

    # ------------------------------------------------------------------ §6
    def test_6_CONTROL_an_ordinary_turn_still_gets_its_text_segment(self):
        """A fix that simply stopped emitting text segments would pass §1."""
        segs = sup._segments_for(None, None, 'please rebase onto main',
                                 view='please rebase onto main')
        self.assertEqual(text_segments(segs)[-1]['text'], 'please rebase onto main')

    # ------------------------------------------------------------------ §7
    def test_7_the_desk_row_draws_cards_end_to_end(self):
        """Through the real reader: compose the replay, record the sidecar
        exactly as a turn does, write the provider event, read the row back.
        This is the closest this suite gets to the screenshot in the report."""
        frozen = sup._segments_for([self._notice_row()], None, None)
        text, view, segments = sup._restart_replay(
            {'text': FROZEN_RAW, 'view': FROZEN_VIEW, 'segments': frozen}, BUILD)
        enveloped, visible, composed = self.compose(text, view,
                                                    segments=segments)
        at = '2026-09-16T08:54:52.188993Z'
        sup._record_prompt_view(self.slug, self.sid, enveloped, visible, at=at,
                                segments=composed,
                                incarnation=records.incarnation(self.org, 'agent'))
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'type': 'user', 'uuid': 'u-1', 'timestamp': at,
                                'message': {'role': 'user',
                                            'content': enveloped}}) + '\n')
            f.write(json.dumps({'type': 'assistant', 'uuid': 'a-1', 'timestamp': at,
                                'message': {'id': 'm-1', 'role': 'assistant',
                                            'content': 'ok'}}) + '\n')
        rows = chat_window.read_window(self.org, 'agent', 8)['messages']
        user = [r for r in rows if r.get('role') == 'user']
        self.assertTrue(user, 'positive control: the user row projected at all')
        row = user[-1]
        self.assertEqual(envelopes_in_text_segments(row.get('segments')), [],
                         'the rendered row carries the mail envelope in a '
                         'human text segment — the desk prints that as prose')
        self.assertIn('runtime.restart_notice',
                      [str((r.get('ev') or {}).get('variant') or '')
                       for r in mail_rows(row.get('segments'))],
                      'the replayed notice did not reach the desk as a card')
        self.assertIn('context.drive_restart_interrupted',
                      segment_variants(row.get('segments'), 'drive'),
                      'the desk row has no account of why the text is back')

    # --------------------------------------------------------------- helper
    def _notice_row(self):
        """A mailbox row for the restart notice, shaped as `restart_wake`
        writes it — the thing the interrupted turn had been driven by."""
        ev = events.mint(
            'runtime.restart_notice', {'kind': 'system', 'id': '@system'},
            {'kind': 'build', 'commit': BUILD['commit'],
             'short': BUILD['commit_short'], 'dirty': False, 'pid': 42808,
             'provenance': 'source'},
            prev_pid=42808, started_at='2026-09-16T08:03:37.070861+00:00',
            branch='main', version='2.1.5')
        row = {'id': uuid.uuid4().hex[:12], 'from': 'orgtree', 'kind': 'notice',
               'body': NOTICE_BODY, 'at': '2026-09-16T08:03:37.101Z',
               'relationship': 'system', 'restart_notice': True}
        row['ev'] = events.encode_row_ev(ev, row)
        return row


if __name__ == '__main__':
    unittest.main(verbosity=2)
