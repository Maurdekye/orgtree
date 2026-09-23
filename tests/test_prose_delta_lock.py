"""The prose branch of capture_reply_stream: same answers, no DOC_LOCK.

`capture_reply_stream`'s `assistant_id` branch used to open with
`with store.DOC_LOCK: org = store.load_org(slug)` on every visible text delta
a Claude agent emitted -- 61.3 ms of a 75.5 ms delta on a 96.6 MB / 673-node
store, measured 2026-09-18, and the whole reason an ordinary write's latency
went 125 ms -> 2685 ms as concurrent streams went 0 -> 32. The branch beneath
it had been given a save-seq-cached, lock-free path on 2026-09-12; this one
had not.

These tests are the safety half of that fix, and they come before any timing.
The rows this path writes through `assistant_messages.observe` are what the
reply quote and the transcript identity are built from, so a fast wrong answer
here corrupts what the user reads back rather than merely slowing it down.
`test_matches_legacy_*` therefore runs the ACTUAL pre-fix implementation --
copied verbatim from 7554447 and checked against that blob by
`test_legacy_copy_is_faithful_to_7554447` -- over the same inputs and demands
byte-identical `assistant_row`, `event_id` and `reply_quote`.
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

fixture = tempfile.TemporaryDirectory(prefix='orgtree-prose-delta-lock-')
os.environ['ORGTREE_DATA'] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import assistant_messages, ledger, reply_events, store, supervisor as sup

REPO = Path(__file__).resolve().parents[1]

#: The commit whose `capture_reply_stream` `_legacy_capture` reproduces.
LEGACY_COMMIT = '7554447'

#: The pre-fix branch, copied verbatim from `supervisor.capture_reply_stream`
#: at 7554447 apart from the `slug, nid, payload, kind, mid` names already
#: being in scope. `test_legacy_copy_is_faithful_to_7554447` proves the copy
#: still matches that blob; do not edit one without the other.
LEGACY_BRANCH_SOURCE = """\
        with store.DOC_LOCK:
            org = store.load_org(slug)
        row = assistant_messages.observe(str(payload.get('assistant_scope') or
            assistant_messages.scope(org, nid)), str(mid),
            str(payload.get('text') or ''), now_iso(), complete=kind == 'text',
            append=kind == 'delta' and not payload.get('assistant_reset'),
            native_id=payload.get('event_id') if kind == 'text' else None,
            owned=payload.get('assistant_ids'))
        annotated = reply_events.annotate(org, nid, {'messages': [row]})['messages'][0]
        return {**payload, 'assistant_row': annotated,
                'event_id': annotated['event_id'], 'reply_quote': annotated['reply_quote']}
"""


def _legacy_capture(slug, nid, payload):
    """Run the pre-fix branch, using the production modules it used."""
    kind = str(payload.get('kind') or '')
    mid = payload.get('assistant_id')
    now_iso = sup.now_iso
    env = {'store': store, 'assistant_messages': assistant_messages,
           'reply_events': reply_events, 'now_iso': now_iso,
           'slug': slug, 'nid': nid, 'payload': payload,
           'kind': kind, 'mid': mid}
    body = 'def _run():\n' + LEGACY_BRANCH_SOURCE
    exec(compile(textwrap.dedent(body), '<legacy 7554447>', 'exec'), env)
    return env['_run']()


class _CountingLock:
    """A DOC_LOCK stand-in that records every acquisition."""

    def __init__(self, real):
        self._real = real
        self.acquired = 0

    def __enter__(self):
        self.acquired += 1
        return self._real.__enter__()

    def __exit__(self, *exc):
        return self._real.__exit__(*exc)

    def acquire(self, *a, **k):
        self.acquired += 1
        return self._real.acquire(*a, **k)

    def release(self):
        return self._real.release()


class ProseDeltaBase(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org('prose-' + uuid.uuid4().hex[:8])
        self.org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(self.org)
        self.slug = self.org.d['slug']
        self.addCleanup(lambda: store._POOL.close_all(self.slug))
        self.addCleanup(reply_events._ident_forget)
        self.addCleanup(assistant_messages._scope_forget)
        reply_events._ident_forget()
        assistant_messages._scope_forget()

    def scope_of(self, nid='agent'):
        return assistant_messages.scope(store.load_org(self.slug), nid)

    def wipe_assistant_rows(self):
        """Return the assistant store to its pre-run state, ordinals included.

        `assistant_messages.ordinal` is INTEGER PRIMARY KEY AUTOINCREMENT, so
        deleting the rows alone leaves `sqlite_sequence` at its high-water
        mark and the replay would allocate different `assistant_order` values
        for reasons that have nothing to do with this change.
        """
        from orgtree import transcript_records
        with transcript_records.database() as conn:
            conn.execute('DELETE FROM assistant_messages')
            conn.execute('DELETE FROM assistant_receipts')
            conn.execute("DELETE FROM sqlite_sequence WHERE name='assistant_messages'")

    def script(self, mid, other=None):
        """One realistic streamed message: deltas, then the sealing text."""
        return [
            {'kind': 'delta', 'text': 'Reading the ', 'assistant_id': mid},
            {'kind': 'delta', 'text': 'ticket now.', 'assistant_id': mid},
            {'kind': 'draft', 'text': 'Reading the ticket now.', 'assistant_id': mid},
            {'kind': 'delta', 'text': ' Restarting.', 'assistant_id': mid,
             'assistant_reset': True},
            {'kind': 'delta', 'text': 'Second block.', 'assistant_id': other or mid},
            {'kind': 'text', 'text': 'Second block, sealed.',
             'assistant_id': other or mid, 'event_id': 'native-' + str(other or mid)},
            # a late delta after completion: observe() must still refuse it
            {'kind': 'delta', 'text': ' late', 'assistant_id': other or mid},
        ]

    def run_script(self, capture, mids):
        out = []
        # A frozen clock across both replays. `observe` stamps a NEW row with
        # now_iso() and both replays create their rows fresh, so a wall-clock
        # difference is an artifact of replaying rather than a difference in
        # behaviour -- and freezing it keeps every other field byte-exact
        # instead of excluding `ts` from the comparison.
        with patch.object(sup, 'now_iso', lambda: '2026-09-18T00:00:00Z'):
            for payload in self.script(*mids):
                result = capture(self.slug, 'agent', dict(payload))
                out.append({k: result[k] for k in
                            ('assistant_row', 'event_id', 'reply_quote')})
        return out


class ProseDeltaBehaviourTests(ProseDeltaBase):
    """The answers must not move. Everything else in this file is secondary."""

    def _compare(self, first, second):
        self.wipe_assistant_rows()   # ordinals are AUTOINCREMENT and the data
                                     # root is shared across methods
        mid = assistant_messages.identity(self.scope_of(), 'claude', 'msg-a', 0)
        other = assistant_messages.identity(self.scope_of(), 'claude', 'msg-a', 1)

        before = self.run_script(first, (mid, other))
        self.wipe_assistant_rows()
        reply_events._ident_forget()
        assistant_messages._scope_forget()
        after = self.run_script(second, (mid, other))

        self.assertEqual(len(before), len(self.script(mid, other)))
        # byte-identical, not merely equal: these are serialized to the client
        for index, (a, b) in enumerate(zip(before, after)):
            self.assertEqual(
                json.dumps(a, sort_keys=True, ensure_ascii=False, default=str),
                json.dumps(b, sort_keys=True, ensure_ascii=False, default=str),
                f'frame {index} of the stream differs')
        # and the control: the script must actually have produced ids
        self.assertTrue(all(f['event_id'].startswith('reply_') for f in before))
        self.assertEqual(before[0]['reply_quote'], 'Reading the ')
        self.assertEqual(before[1]['reply_quote'], 'Reading the ticket now.')
        self.assertEqual(before[3]['reply_quote'], ' Restarting.')
        self.assertEqual(before[6]['reply_quote'], 'Second block, sealed.')
        # 7 frames, 5 distinct reply ids, and the two collisions are the
        # point: a reply id is a hash of (incarnation, source, kind, quote),
        # so frame 2's draft re-states frame 1's accumulated text under the
        # same assistant_id and lands on frame 1's id, and frame 6's late
        # delta is refused by observe()'s completion monotonicity and gets
        # back frame 5's sealed row. Both must survive the change intact.
        self.assertEqual(len({f['event_id'] for f in before}), 5)
        self.assertEqual(before[2]['event_id'], before[1]['event_id'])
        self.assertEqual(before[6]['event_id'], before[5]['event_id'])
        self.assertEqual(before[4]['reply_quote'], 'Second block.')
        return before

    def test_matches_legacy_when_the_fixed_path_runs_first(self):
        """The fixed path mints, the legacy path must agree with what it minted."""
        self._compare(sup.capture_reply_stream, _legacy_capture)

    def test_matches_legacy_when_the_legacy_path_runs_first(self):
        """The legacy path mints, the fixed path must read it back from cache."""
        self._compare(_legacy_capture, sup.capture_reply_stream)

    def test_matches_legacy_with_an_explicit_assistant_scope(self):
        """The payload-supplied-scope short circuit takes the same shape."""
        scope = self.scope_of()
        mid = assistant_messages.identity(scope, 'claude', 'msg-b', 0)
        payload = {'kind': 'delta', 'text': 'explicit', 'assistant_id': mid,
                   'assistant_scope': scope}
        self.wipe_assistant_rows()
        with patch.object(sup, 'now_iso', lambda: '2026-09-18T00:00:00Z'):
            fixed = sup.capture_reply_stream(self.slug, 'agent', dict(payload))
        self.wipe_assistant_rows()
        reply_events._ident_forget()
        assistant_messages._scope_forget()
        with patch.object(sup, 'now_iso', lambda: '2026-09-18T00:00:00Z'):
            legacy = _legacy_capture(self.slug, 'agent', dict(payload))
        self.assertEqual(json.dumps(fixed, sort_keys=True, default=str),
                         json.dumps(legacy, sort_keys=True, default=str))

    def test_legacy_copy_is_faithful_to_7554447(self):
        """The thing we are comparing against is really the code we replaced."""
        try:
            blob = subprocess.run(
                ['git', 'show', f'{LEGACY_COMMIT}:engine/backend/orgtree/supervisor.py'],
                cwd=REPO, capture_output=True, text=True, encoding='utf-8', timeout=60)
        except (OSError, subprocess.SubprocessError) as exc:   # pragma: no cover
            self.skipTest(f'git unavailable: {exc}')
        if blob.returncode != 0:                                # pragma: no cover
            self.skipTest(f'git show failed: {blob.stderr.strip()[:200]}')
        marker = ("    if mid and kind in {'delta', 'draft', 'text'} "
                  "and not payload.get('cmd_output'):\n"
                  "        from . import assistant_messages, reply_events\n")
        start = blob.stdout.find(marker)
        self.assertNotEqual(start, -1, 'the pre-fix branch head moved')
        body = blob.stdout[start + len(marker):]
        self.assertTrue(body.startswith(LEGACY_BRANCH_SOURCE),
                        'LEGACY_BRANCH_SOURCE no longer matches '
                        f'{LEGACY_COMMIT}; the comparison would be against '
                        'code that never shipped')


class ProseDeltaLockTests(ProseDeltaBase):
    """The point of the change: no DOC_LOCK and no load_org in the steady state."""

    def instrument(self):
        lock = _CountingLock(store.DOC_LOCK)
        loads = []
        real_load = store.load_org
        real_lock = store.DOC_LOCK

        def counted(slug):
            loads.append(slug)
            return real_load(slug)

        store.DOC_LOCK = lock
        store.load_org = counted
        self.addCleanup(lambda: setattr(store, 'DOC_LOCK', real_lock))
        self.addCleanup(lambda: setattr(store, 'load_org', real_load))
        return lock, loads

    def test_steady_state_takes_no_lock_and_loads_no_document(self):
        mid = assistant_messages.identity(self.scope_of(), 'claude', 'msg-c', 0)
        # first delta of the session: minting is allowed to cost a lock
        sup.capture_reply_stream(self.slug, 'agent',
                                 {'kind': 'delta', 'text': 'warm', 'assistant_id': mid})
        lock, loads = self.instrument()
        for index in range(25):
            out = sup.capture_reply_stream(self.slug, 'agent',
                {'kind': 'delta', 'text': f' {index}', 'assistant_id': mid})
            # the control: this loop really did stream, and really did answer
            self.assertTrue(out['event_id'].startswith('reply_'))
        self.assertEqual(out['reply_quote'],
                         'warm' + ''.join(f' {i}' for i in range(25)))
        self.assertEqual(lock.acquired, 0,
                         f'DOC_LOCK taken {lock.acquired}x in the steady state')
        self.assertEqual(loads, [], f'load_org called for {loads}')

    def test_legacy_branch_would_have_failed_that_assertion(self):
        """The negative control: the assertion above can fail, and does here.

        Without this, a `scope_ident` that silently stopped being called at
        all would leave `test_steady_state_...` passing for the wrong reason.
        """
        mid = assistant_messages.identity(self.scope_of(), 'claude', 'msg-d', 0)
        _legacy_capture(self.slug, 'agent',
                        {'kind': 'delta', 'text': 'warm', 'assistant_id': mid})
        lock, loads = self.instrument()
        for index in range(5):
            _legacy_capture(self.slug, 'agent',
                {'kind': 'delta', 'text': f' {index}', 'assistant_id': mid})
        self.assertEqual(lock.acquired, 5)
        self.assertEqual(len(loads), 5)

    def test_concurrent_streams_do_not_serialize_on_the_document(self):
        """Eight threads streaming at once take the lock zero times between them."""
        agents = [f'a{i}' for i in range(8)]
        for nid in agents:
            self.org.hire(ledger.USER, None, 'luna', 0, nid)
        store.save_org(self.org)
        mids = {}
        for nid in agents:                       # pass 1: mint, which saves
            mids[nid] = assistant_messages.identity(self.scope_of(nid), 'claude', nid, 0)
            sup.capture_reply_stream(self.slug, nid,
                {'kind': 'delta', 'text': 'x', 'assistant_id': mids[nid]})
        for nid in agents:                       # pass 2: THE steady state.
            # Pass 1 cannot leave every agent cached: each agent's mint saves
            # the document, and that bump invalidates every entry populated
            # before it. Pass 1 mints, pass 2 populates -- only then is this
            # the steady state the change is about.
            sup.capture_reply_stream(self.slug, nid,
                {'kind': 'delta', 'text': 'y', 'assistant_id': mids[nid]})
        lock, loads = self.instrument()
        emitted = []
        emitted_lock = threading.Lock()
        errors = []

        def stream(nid):
            try:
                for index in range(20):
                    sup.capture_reply_stream(self.slug, nid,
                        {'kind': 'delta', 'text': f' {index}', 'assistant_id': mids[nid]})
                    with emitted_lock:
                        emitted.append(nid)
            except Exception as exc:              # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=stream, args=(nid,)) for nid in agents]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=120)
        self.assertEqual(errors, [])
        self.assertFalse([t for t in threads if t.is_alive()])
        # THE CONTROL: 8 agents x 20 deltas really were emitted. Without this
        # the lock count below would read zero for a run that never streamed.
        self.assertEqual(len(emitted), 160)
        self.assertEqual({nid: emitted.count(nid) for nid in agents},
                         {nid: 20 for nid in agents})
        self.assertEqual(lock.acquired, 0)
        self.assertEqual(loads, [])


class ProseDeltaInvalidationTests(ProseDeltaBase):
    """A cache that never invalidates is a correctness bug wearing a stopwatch."""

    def test_scope_follows_a_new_session_id(self):
        first = assistant_messages.scope_ident(self.slug, 'agent')
        self.assertEqual(first, self.scope_of())
        org = store.load_org(self.slug)
        org.node('agent')['session_id'] = 'session-' + uuid.uuid4().hex[:8]
        store.save_org(org)
        second = assistant_messages.scope_ident(self.slug, 'agent')
        self.assertNotEqual(first, second)
        self.assertEqual(second, self.scope_of())

    def test_identity_follows_a_generation_advance(self):
        scope, generation = reply_events.identity(self.slug, 'agent')
        org = store.load_org(self.slug)
        org.node('agent')['generation'] = int(org.node('agent').get('generation') or 0) + 1
        store.save_org(org)
        later_scope, later_generation = reply_events.identity(self.slug, 'agent')
        self.assertEqual(later_generation, generation + 1)
        self.assertEqual(later_scope, scope)   # incarnation survives a rehire

    def test_a_generation_advance_changes_the_rows_the_stream_writes(self):
        """End to end: a compaction/rehire must not reuse the old generation."""
        mid = assistant_messages.identity(self.scope_of(), 'claude', 'msg-e', 0)
        before = sup.capture_reply_stream(self.slug, 'agent',
            {'kind': 'delta', 'text': 'alpha', 'assistant_id': mid})
        org = store.load_org(self.slug)
        org.node('agent')['generation'] = int(org.node('agent').get('generation') or 0) + 1
        store.save_org(org)
        after = sup.capture_reply_stream(self.slug, 'agent',
            {'kind': 'delta', 'text': 'beta', 'assistant_id': mid})
        scope, generation = reply_events.identity(self.slug, 'agent')
        self.assertEqual(generation, 1)
        # the new row is readable under the NEW generation and the old one is not
        self.assertEqual(reply_events.lookup(self.slug, 'agent', 1,
                                             after['event_id'], scope), 'alphabeta')
        self.assertIsNone(reply_events.lookup(self.slug, 'agent', 1,
                                              before['event_id'], scope))
        self.assertEqual(reply_events.lookup(self.slug, 'agent', 0,
                                             before['event_id'], scope), 'alpha')

    def test_scope_survives_a_reply_quote_clear(self):
        """`clear` rotates reply_incarnation; the cached identity must follow."""
        scope, _ = reply_events.identity(self.slug, 'agent')
        org = store.load_org(self.slug)
        reply_events.clear(org, 'agent')
        later, _ = reply_events.identity(self.slug, 'agent')
        self.assertNotEqual(scope, later)


if __name__ == '__main__':
    unittest.main()
