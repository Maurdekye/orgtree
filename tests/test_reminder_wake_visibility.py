"""An automatic wake that drives a turn must leave a visible event behind.

USER-VISIBLE DEFECT, reported by coordinator-astra 2026-09-11. The idle-docket
reminder woke the coordinator at 14:02:57Z and drove a whole turn. Nothing about
it appeared in the transcript: the user could see the turn happen and could not
see why.

WHAT WAS ACTUALLY WRONG, read out of live storage rather than guessed:

  · THE CARRIER exists and is correct — orgs/orgtree.db `log_d` seq 12013,
    sect `mail_log`, owner coordinator-astra, at 2026-09-11T14:02:57.338550Z:
    a mail row from @system with `model_only: true` and a valid typed
    `reminder.idle_docket` event naming one item
    (keep-hire-tokens-visible-at-maximum-zoom, deploy_ready, owner).

  · THE PROJECTION lost it — the turn's sidecar row
    (transcript-records.sqlite3 `transcript_view_rows`, 2026-09-11T14:03:02Z)
    reads chars=5138, visible="", spans=[], and its typed composition is
    [state context.org_state, state context.provider_usage,
     notices(1 runtime.delivery_unread), mail ROWS=0,
     drive context.drive_mail_pointer].
    The mail segment was emitted EMPTY. That zero is the whole bug.

  · THE CAUSE. `_segments_for` decided human visibility from the ROW FLAG
    (`model_only`) and dropped the row. But `model_only` is about the [MAIL]
    ENVELOPE — machine prose that must never read as somebody's words, which
    `_human_view_spans` rightly keeps out of `visible`. Whether the EVENT is
    human-visible is a different question, already answered in one place by
    disposition (`events.human_visible_variant`, the derivation the frontend's
    HUMAN_HIDDEN_VARIANTS uses), and `reminder.idle_docket` declares every
    field `both`. Two mechanisms answered one question, and the stricter one
    silently won.

  · AND A SECOND HALF IN THE READER. `_read_chat_source` drops a user record
    whose projection is empty — that was the definition of a machine-only turn.
    An automatic wake has no human text at all, so even a correct composition
    died on reload until that rule learned to ask whether the composition draws
    a machine-context card.

⚠ THE FIXTURE IS THE REAL PRODUCER, NOT A HAND-BUILT ROW. §1-§3, §6 and §7
drive `_idle_docket_reminder_reserve` — the function that wrote seq 12013 — and
then the real composer `_envelope` on a carrier of the real wake shape (a ping,
whose projection is EMPTY). §6, §11 and §12 go on through the real reader.

§13 goes further still and composes the COPIED BYTES of seq 12013 — the row
itself, not a re-minted lookalike — so a later change to the producer cannot
quietly retire the shape an existing archive is full of.

MEASURED RED BEFORE THE FIX (against main's supervisor.py): §2, §3, §6, §7,
§9, §13, §13b. Green before and after: §1, §4, §5, §8, §10, §11, §12 — a "fix"
that showed every machine row fails §4 and §8, and one that showed every
empty-projection turn fails §11 and §12.

    python -B tests/test_reminder_wake_visibility.py
"""
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time, and a module imported first is bound to the LIVE root for the
# rest of the process. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='reminder-visibility-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'reminder-visibility-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import events, ledger, store, supervisor as sup         # noqa: E402
from orgtree import chat_window                                      # noqa: E402
from orgtree import transcript_records as records                    # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs = []

#: the headers the machine envelope is made of — none may reach a human segment
HEADERS = ('[ORG STATE', '[PROVIDER USAGE', '[ORG NOTICES', '[MAIL —',
           '[AUTOMATIC IDLE DOCKET REMINDER]')
#: the real nudge text the wake travels as (supervisor.IDLE_DOCKET_REMINDER_NUDGE)
NUDGE = sup.IDLE_DOCKET_REMINDER_NUDGE.format(n=1)


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def typed(ev):
    """Does this segment event decode? Only a decodable one gets a projected
    card; the renderer falls back to the segment's raw `text` for anything
    else, which is the leak `prose_on_screen` hunts for."""
    return isinstance(ev, dict) and events.decode(ev).get('status') == 'ok'


def drawn(segments):
    """The segments the desk actually DRAWS, by the same rule segments.tsx uses.

    `text`, `mail` and `notices` always draw. A machine-context segment
    (`state`/`drive`) returns null ONLY when its event decodes AND is hidden by
    disposition — mirrored here from the SAME derived policy the generated
    HUMAN_HIDDEN_VARIANTS comes from, so this helper cannot disagree with the
    frontend about one event. An UNDECODABLE machine segment still draws: the
    card has no fields to project, so it renders the raw text.
    """
    out = []
    for seg in segments or []:
        kind = str(seg.get('kind') or '')
        if kind in ('state', 'drive'):
            ev = seg.get('event')
            if typed(ev) and str(ev.get('variant') or '') in \
                    events.human_hidden_variants():
                continue
        if kind == 'mail' and not (seg.get('rows') or []):
            continue                    # an empty batch draws nothing either
        out.append(seg)
    return out


def events_of(segments, variant):
    """Every drawn segment carrying this leaf, whatever kind carries it."""
    found = []
    for seg in drawn(segments):
        if str((seg.get('event') or {}).get('variant') or '') == variant:
            found.append(seg['event'])
        for row in seg.get('rows') or []:
            if str((row.get('ev') or {}).get('variant') or '') == variant:
                found.append(row['ev'])
    return found


def prose_on_screen(segments, visible):
    """Every place a human would read machine-envelope prose AS PROSE.

    A `text` segment is rendered verbatim; a mail/notice row renders its body;
    and a machine segment whose event did not decode renders its raw text as
    the card's fallback. A machine segment that DID decode renders its typed
    fields instead, so its `text` is not on screen and is not counted.
    """
    hits = []
    for seg in drawn(segments):
        kind = str(seg.get('kind') or '')
        texts = []
        if kind == 'text' or (kind in ('state', 'drive')
                              and not typed(seg.get('event'))):
            texts.append(str(seg.get('text') or ''))
        texts += [str(r.get('body') or r.get('text') or '')
                  for r in seg.get('rows') or []]
        for text in texts:
            hits += [(kind, h) for h in HEADERS if h in text]
    hits += [('visible', h) for h in HEADERS if h in (visible or '')]
    return hits


class ReminderWake(unittest.TestCase):
    def setUp(self):
        slug = 'reminder-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        org.work_create('agent', 'Keep hire tokens visible at maximum zoom',
                        'the reported item', owner='agent')
        org._work_active()[0]['status'] = 'deploy_ready'
        store.save_org(org)
        self.slug, self.org = slug, org
        self.item = org._work_active()[0]['slug']
        self.sid = org.node('agent')['session_id']
        self.path = Path(fx.name) / (slug + '.jsonl')
        self.path.write_bytes(b'')
        p = patch.object(sup, 'transcript_path', return_value=str(self.path))
        p.start()
        self.addCleanup(p.stop)

    # -- the real producers -------------------------------------------------
    def reserve(self):
        """Drive the REAL reservation that wrote the measured row — the seat has
        a fresh activity anchor from the hire, so one call past the interval is
        exactly the shipped path."""
        got = sup._idle_docket_reminder_reserve(self.slug, 'agent',
                                                1_800_000_000.0)
        self.assertIsNotNone(got, 'positive control: the real reserve never fired, '
                                  'so nothing below is testing a reminder at all')
        return got

    def stored_row(self):
        """The reserved mail row exactly as it sits in the box."""
        org = store.load_org(self.slug)
        return [dict(m) for m in (org.d.get('mail') or {}).get('agent') or []]

    def compose(self, text=NUDGE, view='', ping=True):
        """The REAL composer, on a carrier of the wake's shape: a ping whose
        projection is EMPTY (`_run_turn` flattens a ping carrier to "")."""
        views, segs = [], []
        enveloped, _tok, _imgs = sup._envelope(
            self.slug, 'agent', text, via='turn', base_view=view,
            view_out=views, segments_out=segs, ping=ping, ping_reason='reminder')
        return enveloped, (views[0] if views else ''), (segs[0] if segs else [])

    # ------------------------------------------------------------------ §1
    def test_1_the_reserved_row_is_the_measured_shape(self):
        """The fixture's own control. If the producer stopped writing a
        model_only row with a typed event, every section below would pass for
        the wrong reason."""
        self.reserve()
        rows = self.stored_row()
        self.assertEqual(len(rows), 1, 'expected exactly one reserved row')
        row = rows[0]
        self.assertIs(row.get('model_only'), True,
                      'the measured row carries model_only: true')
        self.assertEqual(row.get('from'), sup.SYSTEM)
        self.assertEqual(str((row.get('ev') or {}).get('variant') or ''),
                         'reminder.idle_docket')
        self.assertTrue(row.get('body', '').startswith(
            sup.IDLE_DOCKET_REMINDER_MARK), 'the frozen agent rendering')
        # …and the typed policy says this leaf IS human-visible. That is the
        # premise the composition was contradicting.
        self.assertTrue(events.human_visible_variant('reminder.idle_docket'),
                        'precondition: the disposition table calls this leaf '
                        'hidden, so the defect is somewhere else entirely')

    # ------------------------------------------------------------------ §2
    def test_2_THE_BUG_the_wake_reaches_the_transcript_with_its_items(self):
        """THE REPORTED DEFECT. Before the fix the composition held a mail
        segment with zero rows and nothing else a human could see."""
        self.reserve()
        _raw, visible, segments = self.compose()
        mail_rows = [len(s.get('rows') or []) for s in segments
                     if s.get('kind') == 'mail']
        self.assertNotEqual(mail_rows, [0],
                            'the measured failure exactly: a mail segment with '
                            'ZERO rows and the wake dropped on the floor')
        found = events_of(segments, 'reminder.idle_docket')
        self.assertEqual(len(found), 1,
                         'the reminder that drove this turn draws no card: '
                         'drawn segments were %r'
                         % [s.get('kind') for s in drawn(segments)])
        # acceptance: its items and their statuses ride the event
        items = found[0]['items']
        self.assertEqual([i['slug'] for i in items], [self.item])
        self.assertEqual(items[0]['status'], 'deploy_ready')
        self.assertEqual(items[0]['title'],
                         'Keep hire tokens visible at maximum zoom')
        self.assertEqual(int(found[0]['more']), 0)
        self.assertEqual(visible, '', 'the human view string is unchanged: the '
                                      'wake is a card, never the user’s words')

    # ------------------------------------------------------------------ §3
    def test_3_it_is_a_machine_context_card_not_a_mail_envelope(self):
        """Acceptance: labelled and styled as machine-generated context, with
        none of the surrounding envelope exposed."""
        self.reserve()
        _raw, visible, segments = self.compose()
        carrier = [s for s in drawn(segments)
                   if str((s.get('event') or {}).get('variant') or '')
                   == 'reminder.idle_docket']
        self.assertEqual([s['kind'] for s in carrier], ['state'],
                         'the wake must ride the machine-context segment kind, '
                         'not arrive dressed as received mail')
        self.assertEqual(prose_on_screen(segments, visible), [],
                         'envelope prose reached a human segment')
        # the org-state / usage / nudge segments stay hidden beside it
        self.assertEqual(events_of(segments, 'context.drive_mail_pointer'), [],
                         'the nudge is machine-only and must stay hidden')

    # ------------------------------------------------------------------ §4
    def test_4_CONTROL_a_hidden_leaf_on_a_machine_row_stays_hidden(self):
        """THE GATE IS A GATE. A model_only row whose event is hidden BY
        DISPOSITION must still contribute nothing. A fix that simply showed
        every machine row passes §2 and fails here."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            hidden = events.mint(
                'context.drive_mail_pointer', {'kind': 'system', 'id': sup.SYSTEM},
                sup._node_ref(org, 'agent'), text='(orgtree) you have new mail',
                reason='reminder')
            org.append_system_mail('agent', hidden, model_only=True)
            store.save_org(org)
        self.assertIn('context.drive_mail_pointer', events.human_hidden_variants(),
                      'positive control: this leaf is not hidden, so the '
                      'assertion below could not fail either way')
        _raw, visible, segments = self.compose()
        self.assertEqual(events_of(segments, 'context.drive_mail_pointer'), [])
        self.assertEqual(prose_on_screen(segments, visible), [])
        # …and the composer did not even BUILD a carrier the desk would then
        # have to throw away. The gate is in the composition, not only in the
        # renderer, because an untypable row has no gate left downstream (§8).
        self.assertEqual(
            [s for s in segments if s.get('kind') == 'state'], [],
            'a hidden machine row was composed as a machine-context segment')

    # ------------------------------------------------------------------ §5
    def test_5_CONTROL_ordinary_mail_is_untouched(self):
        """The surroundings. Agent mail keeps its mail segment AND its
        envelope in the human view string."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.post_mail(ledger.USER, 'agent', 'please rebase onto main',
                          kind='message')
            store.save_org(org)
        _raw, visible, segments = self.compose(text='carrier', view='')
        rows = [r for s in segments if s.get('kind') == 'mail'
                for r in s.get('rows') or []]
        self.assertEqual(len(rows), 1, 'ordinary mail lost its segment')
        self.assertEqual(rows[0]['body'], 'please rebase onto main')
        self.assertIn('[MAIL —', visible,
                      'ordinary mail still carries its envelope into the view')

    def replay(self, enveloped, visible, segments,
               at='2026-09-11T14:03:02.610931Z'):
        """Record the sidecar exactly as a turn does, write the provider event,
        and read the conversation back through the real reader."""
        sup._record_prompt_view(self.slug, self.sid, enveloped, visible, at=at,
                                segments=segments,
                                incarnation=records.incarnation(self.org, 'agent'))
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'type': 'user', 'uuid': 'u-1', 'timestamp': at,
                                'message': {'role': 'user',
                                            'content': enveloped}}) + '\n')
            f.write(json.dumps({'type': 'assistant', 'uuid': 'a-1', 'timestamp': at,
                                'message': {'id': 'm-1', 'role': 'assistant',
                                            'content': 'picking it back up'}}) + '\n')
        rows = chat_window.read_window(self.org, 'agent', 8)['messages']
        self.assertTrue([r for r in rows if r.get('role') == 'assistant'],
                        'positive control: the reader projected nothing at all '
                        'from this transcript, not even the reply')
        return [r for r in rows if r.get('role') == 'user']

    # ------------------------------------------------------------------ §6
    def test_6_the_visible_event_survives_a_transcript_reload(self):
        """Through the real reader. ⚠ THE SECOND HALF OF THE DEFECT lives here:
        the reader drops a user record whose projection is empty, which is what
        "machine-only turn" used to mean — and an automatic wake has no human
        text at all."""
        self.reserve()
        user = self.replay(*self.compose())
        self.assertTrue(user, 'positive control: the user row did not project '
                              'at all, so nothing here is about the reminder')
        row = user[-1]
        found = events_of(row.get('segments'), 'reminder.idle_docket')
        self.assertEqual(len(found), 1,
                         'the reloaded row carries no reminder: drawn %r'
                         % [s.get('kind') for s in drawn(row.get('segments'))])
        self.assertEqual([i['slug'] for i in found[0]['items']], [self.item])
        self.assertEqual(prose_on_screen(row.get('segments'),
                                         str(row.get('text') or '')), [],
                         'the reloaded row puts envelope prose on screen')

    # ------------------------------------------------------------------ §7
    def test_7_a_machine_row_and_human_rows_keep_their_reading_order(self):
        """One drain can hold both, INTERLEAVED. The segments must appear in
        the order the agent's own [MAIL] block carries them, which means a
        human batch already in hand is closed before the machine card and
        reopened after it — not swept to one end.

        ⚠ The box is deliberately human, MACHINE, human: with the wake merely
        first, a composer that appended all mail at the end would still come
        out in the right order and this section would prove nothing.

        The leading row is a passive NOTICE because that is the only human mail
        that can already be boxed when a reminder reserves — `waking_mail` is
        one of the wake's own admission gates, so an ordinary unread message
        would have suppressed the reminder outright.
        """
        def post(body, kind='message'):
            with store.DOC_LOCK:
                org = store.load_org(self.slug)
                org.post_mail(ledger.USER, 'agent', body, kind=kind)
                store.save_org(org)
        post('before the reminder', kind='notice')
        self.reserve()
        post('after the reminder')
        _raw, _visible, segments = self.compose()
        self.assertEqual([s['kind'] for s in segments
                          if s['kind'] in ('mail', 'state')],
                         ['mail', 'state', 'mail'],
                         'the wake was swept out of its place in the batch')
        self.assertEqual([[r['body'] for r in s['rows']]
                          for s in segments if s['kind'] == 'mail'],
                         [['before the reminder'], ['after the reminder']])

    # ------------------------------------------------------------------ §8
    def test_8_CONTROL_an_undecodable_machine_row_contributes_nothing(self):
        """A machine row whose event cannot be typed must stay off screen: the
        composer may not fall back to putting its raw prose up as words."""
        self.reserve()
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            box = org.d['mail']['agent']
            box[0]['ev'] = {'v': 1, 'variant': 'reminder.idle_docket'}   # truncated
            store.save_org(org)
        _raw, visible, segments = self.compose()
        self.assertEqual(events_of(segments, 'reminder.idle_docket'), [])
        self.assertEqual(prose_on_screen(segments, visible), [],
                         'an undecodable machine row leaked its prose')

    # ------------------------------------------------------------------ §9
    def test_9_the_other_automatic_wake_is_visible_by_the_same_rule(self):
        """`reminder.working_checkup` has no own fields, so the disposition
        derivation calls it visible (its variant IS its content). The rule is
        the family's, not one leaf's."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            ev = events.mint('reminder.working_checkup',
                             {'kind': 'system', 'id': sup.SYSTEM},
                             sup._node_ref(org, 'agent'))
            org.append_system_mail('agent', ev, model_only=True)
            store.save_org(org)
        _raw, visible, segments = self.compose()
        self.assertEqual(len(events_of(segments, 'reminder.working_checkup')), 1)
        self.assertEqual(prose_on_screen(segments, visible), [])


    # ----------------------------------------------------------------- §11
    def test_11_CONTROL_a_machine_only_turn_with_no_card_still_has_no_bubble(self):
        """The reader's rule did not become "show every empty turn". A wake
        whose whole composition is machine state and a hidden nudge is still
        plumbing, and still renders nothing."""
        enveloped, visible, segments = self.compose()
        self.assertEqual(visible, '')
        self.assertTrue(any(s.get('kind') == 'drive' for s in segments),
                        'positive control: this turn composed no nudge at all, '
                        'so there is nothing for the rule to reject')
        self.assertEqual(self.replay(enveloped, visible, segments), [],
                         'a nudge-only turn grew a chat bubble')

    # ----------------------------------------------------------------- §12
    def test_12_CONTROL_a_notice_only_wake_renders_as_it_always_did(self):
        """Acceptance: restart notices keep their existing behaviour. An org
        notice on a turn with no human text is NOT what this change makes
        visible — see `_wake_card_on_screen`."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.d.setdefault('notices', {})['agent'] = [
                {'at': '2026-09-11T13:01:35Z',
                 'text': 'The backend was restarted.'}]
            store.save_org(org)
        enveloped, visible, segments = self.compose()
        notices = [s for s in segments if s.get('kind') == 'notices']
        self.assertTrue(notices and notices[0]['rows'],
                        'positive control: no notice was drained, so this '
                        'section proves nothing about notices')
        self.assertEqual(visible, '')
        self.assertEqual(self.replay(enveloped, visible, segments), [],
                         'a notice-only wake changed its rendering')


class MeasuredRow(unittest.TestCase):
    """§13 — the COPIED BYTES, not a re-minted lookalike.

    `MEASURED` below is `log_d` seq 12013 verbatim: the row that woke
    coordinator-astra. Everything else in this file drives the producer and
    trusts it to keep writing what it wrote that day; this section does not.
    If the producer is ever changed, this row still reads as it is stored, and
    an archive full of them still has to render.
    """

    MEASURED = {
        "id": "47452396",
        "from": "@system",
        "kind": "message",
        "body": "\n".join([
            sup.IDLE_DOCKET_REMINDER_MARK,
            "You have been idle for 20 minutes and these docket items are "
            "waiting on YOU for their next action:",
            "- keep-hire-tokens-visible-at-maximum-zoom (deploy_ready): "
            "Keep hire tokens visible at maximum zoom",
            "Pick the work back up: read each one with orgtree_work get, take "
            "the next concrete step, and leave an honest orgtree_work update.",
        ]),
        "at": "2026-09-11T14:02:57.338550Z",
        "model_only": True,
        "relationship": "the orgtree engine reminding an idle agent of the "
                        "unfinished docket items whose next action is its own, "
                        "after 20 minutes without a wake",
        "ev": {
            "v": 1,
            "variant": "reminder.idle_docket",
            "actor": {"kind": "system", "id": "@system"},
            "object": {"kind": "node", "org": "orgtree",
                       "id": "coordinator-astra", "name": "coordinator-astra",
                       "generation": 1},
            "engine_authored": True,
            "items": [{"slug": "keep-hire-tokens-visible-at-maximum-zoom",
                       "title": "Keep hire tokens visible at maximum zoom",
                       "status": "deploy_ready", "role": "owner"}],
            "more": 0,
        },
    }

    def test_13_the_measured_row_composes_a_visible_wake(self):
        segments = sup._segments_for([dict(self.MEASURED)], None, '', view='')
        self.assertEqual([s['kind'] for s in segments], ['state'],
                         'the stored row composed %r'
                         % ([s['kind'] for s in segments],))
        event = segments[0]['event']
        self.assertEqual(event['variant'], 'reminder.idle_docket')
        self.assertEqual([i['slug'] for i in event['items']],
                         ['keep-hire-tokens-visible-at-maximum-zoom'])
        self.assertEqual(event['items'][0]['status'], 'deploy_ready')
        self.assertEqual(segments[0]['text'], self.MEASURED['body'],
                         'the frozen agent rendering rides along as the '
                         'fallback for a row whose event stops decoding')

    def test_13b_and_the_desk_would_draw_it(self):
        segments = sup._segments_for([dict(self.MEASURED)], None, '', view='')
        self.assertEqual(len(events_of(segments, 'reminder.idle_docket')), 1)
        self.assertEqual(prose_on_screen(segments, ''), [])
        self.assertTrue(sup._wake_card_on_screen(segments),
                        'the reader would still drop this turn as machine-only')


class HumanVisibleVariant(unittest.TestCase):
    """§10 — the single typed answer the composer and the frontend share."""

    def test_10a_it_agrees_with_the_generated_frontend_policy(self):
        hidden = set(events.human_hidden_variants())
        self.assertTrue(hidden, 'positive control: nothing is hidden at all')
        for variant in events.VARIANTS:
            self.assertEqual(events.human_visible_variant(variant),
                             variant not in hidden, variant)

    def test_10b_an_unknown_variant_is_never_called_visible(self):
        self.assertFalse(events.human_visible_variant('reminder.not_a_leaf'))
        self.assertFalse(events.human_visible_variant(''))


if __name__ == '__main__':
    unittest.main(verbosity=2)
