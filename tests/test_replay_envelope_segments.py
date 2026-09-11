"""A REPLAYED frozen turn must not render its stale envelope as a message.

USER BUG 2026-09-11. After the coordinator's provider/account was switched and
the user pressed UNSTUCK, the desk rendered a complete ORG STATE / PROVIDER
USAGE / ORG NOTICES envelope as ordinary message content - unlabeled,
uncollapsed, styled like the agent's own words.

WHAT WAS ACTUALLY WRONG, read out of the stored event rather than guessed. The
engine's classification was intact: the freeze record held the raw enveloped
prompt AND its correct human projection, positionally aligned, and the
sidecar's `visible` string for the replayed turn was composed from that
projection and carried no envelope header anywhere. Only the TYPED COMPOSITION
disagreed: `_segments_for` was handed the carrier's RAW text as its tail, so
the row's segments ended with {'kind': 'text', 'text': <the whole old
envelope>} - and desk.tsx renders a user row from its segments when it has
them. The two encodings of one projection disagreed, and the desk read the one
that was wrong.

The measured specimen (coordinator-astra, 2026-09-11T08:14:12Z): raw 20833
chars, visible 13074 = mail(9686) + 2 + projection(3386), segments
[state, state, notices, mail, text(7504)] - and 7504 is exactly the length of
the 08:07 prompt that had been frozen.

⚠ THE FIXTURE IS THE REAL SHAPE, NOT A SKETCH. Every section drives the actual
composer with a carrier of the shape `resume_frozen`/`node_unstick` build: an
already-enveloped `text` plus the `view` the freeze stored beside it. §1 and
§2 fail against the unfixed engine; §3 and §4 are the surroundings and pass
either way, so a change that fixes §1 by simply deleting the tail is caught.

    python -B tests/test_replay_envelope_segments.py
"""
import ast, json, os, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time, and a module imported first is bound to the LIVE root for the
# rest of the process. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='replay-envelope-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'replay-envelope-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app          # noqa: E402
load_app()
from orgtree import store, ledger, supervisor as sup, chat_window  # noqa: E402
from orgtree import transcript_records as records                  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


#: the shape the freeze stores: the enveloped bytes that went to the model...
FROZEN_RAW = (
    "[ORG STATE #1 — current as of 2026-09-11T08:07:50.967Z. Newest wins; "
    "EARLIER COPIES IN THIS CONVERSATION ARE STALE.]\n"
    "Your reports: none yet. Your peers: none.\n"
    "Credits: seat 5, grant 0, free 0.\n"
    "[END ORG STATE]\n\n"
    "[PROVIDER USAGE #1 — current as of 2026-09-11T08:07:51Z; dynamic/cache-only]\n"
    "provider/lane | window | used\n"
    "claude/primary | session | 46%\n"
    "[END PROVIDER USAGE]\n\n"
    "[ORG NOTICES — 2 change(s) since your last turn]\n"
    "- 2026-09-11T08:03:18Z: a peer changed\n"
    "[END NOTICES]\n\n"
    "[MAIL — 1 message(s)]\nFROM claude-refresh (your report) · status\n"
    "the earlier report body\n[END MAIL]\n\n"
    "(orgtree) You have new mail above — handle it as appropriate.")
#: ...and the human projection stored positionally beside it
FROZEN_VIEW = ("[MAIL — 1 message(s)]\nFROM claude-refresh (your report) · status\n"
               "the earlier report body\n[END MAIL]\n\n"
               "(orgtree) You have new mail above — handle it as appropriate.")

HEADERS = ('[ORG STATE', '[PROVIDER USAGE', '[ORG NOTICES')


def envelope_headers_in(segments):
    """every envelope header a HUMAN-FACING segment would put on screen.

    `state` segments are the envelope done RIGHT — typed, and the desk hides
    them (segments.tsx returns null for a non-human segment event) - so they
    are exempt here BY KIND, never by looking at their text. `text` is the
    kind the desk renders as the agent's words, and that is what this counts.
    """
    out = []
    for seg in segments or []:
        if seg.get('kind') != 'text':
            continue
        for h in HEADERS:
            if h in str(seg.get('text') or ''):
                out.append((h, len(str(seg.get('text')))))
    return out


def tail_text(segments):
    tails = [s for s in (segments or []) if s.get('kind') == 'text']
    return tails[-1]['text'] if tails else None


class ReplayEnvelope(unittest.TestCase):
    def setUp(self):
        slug = 'replay-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(self.org)
        self.slug = slug
        self.sid = self.org.node('agent')['session_id']
        self.path = Path(fx.name) / (slug + '.jsonl')
        self.path.write_bytes(b'')
        p = patch.object(sup, 'transcript_path', return_value=str(self.path))
        p.start()
        self.addCleanup(p.stop)

    def compose(self, text, view, mail_body=None):
        """the REAL composer, on a carrier of the replay shape"""
        if mail_body is not None:
            with store.DOC_LOCK:
                org = store.load_org(self.slug)
                org.post_mail(ledger.USER, 'agent', mail_body, kind='message')
                store.save_org(org)
        views, segs = [], []
        enveloped, tok, _imgs = sup._envelope(
            self.slug, 'agent', text, via='turn', base_view=view,
            view_out=views, segments_out=segs)
        return enveloped, views[0] if views else '', segs[0] if segs else []

    # ------------------------------------------------------------------ §1
    def test_1_replayed_envelope_is_not_filed_as_a_human_text_segment(self):
        """THE REPORTED BUG. A replay carrier brings enveloped bytes and its
        own projection; the tail must be the projection."""
        _raw, visible, segments = self.compose(FROZEN_RAW, FROZEN_VIEW,
                                               mail_body='a newer message')
        # the control first: this fixture really does carry an envelope, so a
        # green result cannot come from there being nothing to leak
        self.assertTrue(any(h in FROZEN_RAW for h in HEADERS),
                        'positive control: the fixture carries no envelope at all')
        self.assertNotIn('[ORG STATE', visible,
                         'precondition: the `visible` string was already correct '
                         'in the measured specimen; if it leaks here the fixture '
                         'is not reproducing the reported failure')
        leaked = envelope_headers_in(segments)
        self.assertEqual(leaked, [],
                         'the stale envelope was filed as a human text segment '
                         '%r — the desk renders a user row from its segments' % (leaked,))
        self.assertEqual(tail_text(segments), FROZEN_VIEW,
                         'the tail segment must be the carrier’s projection')

    # ------------------------------------------------------------------ §2
    def test_2_segments_and_visible_cannot_disagree(self):
        """The two encodings of ONE projection. The desk reads whichever it
        has; they must say the same thing."""
        _raw, visible, segments = self.compose(FROZEN_RAW, FROZEN_VIEW,
                                               mail_body='a newer message')
        self.assertTrue(visible.endswith(FROZEN_VIEW),
                        'the visible string does not end with the projection: %r'
                        % visible[-120:])
        self.assertEqual(tail_text(segments), FROZEN_VIEW,
                         'segments tail %r disagrees with the visible tail'
                         % (tail_text(segments),))

    # ------------------------------------------------------------------ §3
    def test_3_CONTROL_an_ordinary_message_still_gets_its_text_segment(self):
        """The surroundings. A fix that simply dropped the tail would pass §1
        and fail here."""
        _raw, visible, segments = self.compose('please rebase onto main',
                                               'please rebase onto main',
                                               mail_body='a newer message')
        self.assertEqual(tail_text(segments), 'please rebase onto main')
        self.assertTrue(visible.endswith('please rebase onto main'))

    # ------------------------------------------------------------------ §4
    def test_4_CONTROL_a_carrier_with_no_projection_is_unchanged(self):
        """A bare-string carrier composed no projection at all. It must keep
        standing as its own tail — `None` is not `""`."""
        segs = sup._segments_for(None, None, 'a plain carrier', view=None)
        self.assertEqual(tail_text(segs), 'a plain carrier')
        # …and an explicit empty projection is the machine-only case: no tail
        self.assertEqual(tail_text(sup._segments_for(None, None, 'machine nudge',
                                                     view='')), None)

    # ------------------------------------------------------------------ §5
    def test_5_the_desk_row_carries_no_envelope_end_to_end(self):
        """Through the real reader: compose, record the sidecar exactly as a
        turn does, write the provider event, and read the row back."""
        enveloped, visible, segments = self.compose(FROZEN_RAW, FROZEN_VIEW,
                                                    mail_body='a newer message')
        at = '2026-09-11T08:14:12.188993Z'
        sup._record_prompt_view(self.slug, self.sid, enveloped, visible, at=at,
                                segments=segments,
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
        for h in HEADERS:
            self.assertNotIn(h, str(row.get('text') or ''),
                             'the rendered text carries %s' % h)
        self.assertEqual(envelope_headers_in(row.get('segments')), [],
                         'the rendered row carries the envelope in a human '
                         'text segment')


class CarrierProjection(unittest.TestCase):
    """§7 — the rule `_run_turn` applies, now that it has a name.

    "" and absent are DIFFERENT answers and the composer keys on the
    difference: "" hides the carrier's text, absent lets it stand as its own
    tail. Before this was extracted the distinction lived inside a function no
    test can call, and a mutant that collapsed the two survived every section
    (mutants3.py `carrier-view-blind`)."""

    def test_7a_a_replay_carrier_answers_with_its_stored_projection(self):
        self.assertEqual(
            sup._carrier_projection({'text': FROZEN_RAW, 'view': FROZEN_VIEW}),
            FROZEN_VIEW)

    def test_7b_a_machine_only_carrier_answers_EMPTY_not_absent(self):
        got = sup._carrier_projection({'text': '(orgtree) you have mail', 'view': ''})
        self.assertEqual(got, '', 'a carrier saying "nothing human here"')
        self.assertIsNotNone(got, 'empty is an ANSWER; None would let the '
                                  'nudge stand as its own tail again')

    def test_7c_an_ordinary_carrier_is_its_own_projection(self):
        self.assertEqual(sup._carrier_projection({'text': 'rebase please'}),
                         'rebase please')

    def test_7d_a_bare_string_carrier_answers_ABSENT(self):
        self.assertIsNone(sup._carrier_projection('a bare carrier'))
        self.assertIsNone(sup._carrier_projection(None))


def _source_text(path):
    """supervisor.py as one LF-normalised string (the checkout is CRLF)."""
    return path.read_text(encoding='utf-8').replace(chr(13) + chr(10), chr(10))


class EverySitePassesTheProjection(unittest.TestCase):
    """§6 — THE SITE `_run_turn` USES IS NOT REACHABLE FROM ABOVE, so it is
    guarded structurally instead of being left to reading.

    The sections above drive `_envelope`, which is one of the two places that
    compose a turn's typed segments. The other is inside `_run_turn` — a
    thousand-line function that launches a provider process — and there is no
    honest way to call it here. So this asserts the RULE rather than that
    site's behaviour: every `_segments_for(...)` call that passes a text must
    also pass the projection beside it. It is a weaker claim than §1 and says
    so; what it buys is that a NEW call site cannot quietly reintroduce the
    bug, which reading cannot promise about code nobody has written yet.

    Its own positive control is below: the same check, run against a doctored
    copy of the source with the keyword removed, must FAIL."""

    SRC = (Path(__file__).resolve().parents[1] / 'engine' / 'backend'
           / 'orgtree' / 'supervisor.py')

    @staticmethod
    def sites(body):
        """(line, call text) for every `_segments_for(` call, definition and
        signature excluded. Brace-counted rather than regexed: these calls
        span lines and carry nested parens."""
        out = []
        i = 0
        while True:
            i = body.find('_segments_for(', i)
            if i < 0:
                return out
            if body[max(0, i - 4):i] == 'def ':
                i += 1
                continue
            depth, j = 0, i + len('_segments_for(') - 1
            while j < len(body):
                if body[j] == '(':
                    depth += 1
                elif body[j] == ')':
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out.append((body.count(chr(10), 0, i) + 1, body[i:j + 1]))
            i = j + 1

    def check(self, body):
        """→ the sites that pass a text but no projection"""
        bad = []
        for line, call in self.sites(body):
            args = call[len('_segments_for('):-1]
            # `..., None, ...` is the journal row's own composition: it files
            # no tail at all, so it needs no projection
            text_arg = args.split(',')[2].strip() if args.count(',') >= 2 else ''
            if text_arg.startswith('None'):
                continue
            if 'view=' not in args:
                bad.append((line, ' '.join(call.split())[:90]))
        return bad

    def test_6_every_composing_site_passes_a_projection(self):
        body = _source_text(self.SRC)
        found = self.sites(body)
        self.assertGreaterEqual(len(found), 3,
                                'positive control: only %d call sites found — the '
                                'scanner is not finding them' % len(found))
        self.assertEqual(self.check(body), [],
                         'a site composes a tail from the raw text with no '
                         'projection beside it')

    # ---- §6c the same site's ARGUMENT, not just the keyword's presence.
    # Read with `ast`, so reformatting cannot break it and only a real change
    # of meaning can: `_run_turn` must hand the composer the carrier's
    # projection ITSELF. Collapsing it — `_carrier_projection(text) or None`,
    # or `view=carrier_view or None` — puts "" back on the same footing as
    # "brought none" and the replay leak returns, in the one function no test
    # here can execute (it launches a provider process).
    #: the function that composes a turn's segments. Named here once — its
    #: own positive control below is what caught this being wrong the first
    #: time (it is `_run_one_turn_recorded`, not `_run_turn`).
    TURN_FN = '_run_one_turn_recorded'

    @classmethod
    def _turn_node(cls, body):
        for node in ast.walk(ast.parse(body)):
            if isinstance(node, ast.FunctionDef) and node.name == cls.TURN_FN:
                return node
        return None

    @classmethod
    def projection_is_verbatim(cls, body):
        """→ (assignments seen, keywords seen, complaints)"""
        fn = cls._turn_node(body)
        if fn is None:
            return 0, 0, ['%s not found — the scan is measuring nothing'
                          % cls.TURN_FN]
        bad, assigns, kws = [], 0, 0
        for node in ast.walk(fn):
            targets = ([node.target] if isinstance(node, ast.AnnAssign)
                       else getattr(node, 'targets', []) if isinstance(node, ast.Assign)
                       else [])
            for t in targets:
                if isinstance(t, ast.Name) and t.id == 'carrier_view':
                    assigns += 1
                    v = node.value
                    if not (isinstance(v, ast.Call) and isinstance(v.func, ast.Name)
                            and v.func.id == '_carrier_projection'):
                        bad.append('carrier_view is assigned %s, not the bare '
                                   'projection call' % ast.dump(v)[:60])
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                    and node.func.id == '_segments_for':
                for kw in node.keywords:
                    if kw.arg != 'view':
                        continue
                    kws += 1
                    if not (isinstance(kw.value, ast.Name)
                            and kw.value.id == 'carrier_view'):
                        bad.append('view= is %s, not carrier_view itself'
                                   % ast.dump(kw.value)[:60])
        return assigns, kws, bad

    def test_6c_the_turn_hands_over_the_projection_verbatim(self):
        assigns, kws, bad = self.projection_is_verbatim(_source_text(self.SRC))
        self.assertEqual(assigns, 1, 'positive control: %d carrier_view '
                                     'assignments found in %s'
                                     % (assigns, self.TURN_FN))
        self.assertEqual(kws, 1, 'positive control: %d view= keywords found '
                                 'in %s' % (kws, self.TURN_FN))
        self.assertEqual(bad, [])

    def test_6d_POSITIVE_CONTROL_6c_fails_on_a_collapsed_projection(self):
        body = _source_text(self.SRC)
        for old, new in (
            ('carrier_view: str | None = _carrier_projection(text)',
             'carrier_view: str | None = _carrier_projection(text) or None'),
            ('drive=turn_drive, owned=owned, view=carrier_view)',
             'drive=turn_drive, owned=owned, view=carrier_view or None)'),
        ):
            doctored = body.replace(old, new)
            self.assertNotEqual(doctored, body, 'nothing to doctor for %r' % old[:40])
            _a, _k, bad = self.projection_is_verbatim(doctored)
            self.assertTrue(bad, '§6c stayed silent against %r' % new[-40:])

    def test_6b_POSITIVE_CONTROL_the_scan_fails_when_the_keyword_is_removed(self):
        body = _source_text(self.SRC)
        doctored = body.replace('drive=turn_drive, owned=owned, view=carrier_view',
                                'drive=turn_drive, owned=owned')
        self.assertNotEqual(doctored, body,
                            'the doctored copy is identical — this control '
                            'would pass against anything')
        self.assertTrue(self.check(doctored),
                        'the scan reported nothing against a source with the '
                        'projection removed, so it cannot report anything')


if __name__ == '__main__':
    unittest.main(verbosity=2)
