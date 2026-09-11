"""One durable id across a live row and its transcript twin (no provider process).

User ruling 2026-09-11: "live rows and transcript rows need a singular durable
id that can cross-identify them, that's the whole point of this fix."

Before this, they could not be cross-identified at all. A live row's id is
``live:<boot>:<org>:<agent>:<n>`` (``supervisor.live_row``); a transcript row's
is ``row:<namespace>:<byte offset>:<occurrence>`` -- a byte offset into the CLI
transcript, which nothing outside that file can compute. Different namespaces
by construction, so ``_sweep_live`` had to INFER the twin: tools by the CLI's
tool_use_id (which works), and TEXT by its first 300 characters within the
current turn. That text inference is what strands a row and shows it twice.

Now the emitter hands the live row the durable record's own uuid, ``read_chat``
projects that uuid onto the transcript row as ``native_event_id``, and the
sweep retires on identity.

ANTI-VACUITY. A retire test passes trivially if the text rule would have
retired the row anyway, so every fixture here gives the live row text that
CANNOT match its durable twin -- the truncated head, or different words
entirely -- and each identity leg is paired with the same fixture under a
non-matching id, which must SURVIVE. If the identity rule stopped working, the
survive-controls would still pass and the retire legs would fail.

Run:  python -m unittest tests.test_live_durable_identity -v
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

# ⚠ store.DATA_ROOT BINDS AT IMPORT TIME. The throwaway root is established
# before `orgtree` is importable at all, so this process cannot resolve to the
# operator's live data even if an import below changed.
_root = tempfile.TemporaryDirectory(prefix='v2-live-durable-identity-')
os.environ['ORGTREE_DATA'] = _root.name
os.environ['HOME'] = _root.name
os.environ['USERPROFILE'] = _root.name
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import ledger, store, supervisor  # noqa: E402

DURABLE = 'The complete durable answer, every word of it, written out in full.'
#: what the live copy would carry if the server capped it -- a PREFIX of the
#: durable text, so the 300-char text rule could still match it. Used only
#: where a leg wants the text rule available; the identity legs use words that
#: appear nowhere durable.
UNRELATED = 'wholly different words that appear in no transcript row at all'


class LiveDurableIdentityTests(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org('ldi-' + self._testMethodName[:28])
        self.org.hire(ledger.USER, None, 'luna', 0, 'agent')
        store.save_org(self.org)
        self.slug = self.org.d['slug']
        self.sid = self.org.node('agent')['session_id']
        self.st = supervisor.state(self.slug, 'agent')
        self.st['busy'] = True

    def tearDown(self):
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------- helpers
    def journal(self, record):
        supervisor._codex_journal(self.slug, self.sid, [record])

    def chat(self):
        return supervisor.read_chat(self.org, 'agent', hold_back=False)

    def live_texts(self):
        return [r.get('text') for r in self.chat()['live']]

    # =================================================== the pairing itself
    def test_paired_rows_cannot_be_given_different_ids(self):
        record, live = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.assertEqual(record['uuid'], live['event_id'],
                         'the journal record and its live twin carry ONE id')
        self.assertTrue(record['uuid'], 'and it is a real id, not empty')
        # uuid-shaped, because desktop_native.claude_records rejects anything else
        from orgtree.desktop_native import UUID
        self.assertTrue(UUID.fullmatch(record['uuid']), record['uuid'])
        # two calls are two events
        other, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.assertNotEqual(record['uuid'], other['uuid'])
        # the live copy is still the capped one, and still declares the cut
        long_record, long_live = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-2', 'gpt-5.6', 'x' * 40, cap=10)
        self.assertEqual(long_live['text'], 'x' * 10)
        self.assertIs(long_live['truncated'], True)
        self.assertEqual(
            long_record['message']['content'][0]['text'], 'x' * 40,
            'the durable record keeps the WHOLE text')
        self.assertNotIn('truncated', live, 'an uncapped row declares no cut')

    def test_frame_identity_is_taken_only_when_one_text_block_owns_it(self):
        frame = {'uuid': 'f0000000-0000-4000-8000-000000000001',
                 'message': {'content': [{'type': 'text', 'text': DURABLE}]}}
        self.assertEqual(supervisor._frame_text_identity(frame),
                         {'event_id': 'f0000000-0000-4000-8000-000000000001'})
        # a tool_use block alongside changes nothing: tools pair on tool_use_id
        with_tool = {'uuid': frame['uuid'], 'message': {'content': [
            {'type': 'text', 'text': DURABLE},
            {'type': 'tool_use', 'id': 'tu-1', 'name': 'Read'}]}}
        self.assertEqual(supervisor._frame_text_identity(with_tool),
                         {'event_id': frame['uuid']})
        # ⚠ TWO text blocks: giving both live rows one id would make the
        # renderer's duplicate guard hide a REAL message, so it declines
        two = {'uuid': frame['uuid'], 'message': {'content': [
            {'type': 'text', 'text': 'first'}, {'type': 'text', 'text': 'second'}]}}
        self.assertEqual(supervisor._frame_text_identity(two), {})
        # no uuid, no id, empty/whitespace text, string content, junk: all decline
        self.assertEqual(supervisor._frame_text_identity(
            {'message': {'content': [{'type': 'text', 'text': DURABLE}]}}), {})
        self.assertEqual(supervisor._frame_text_identity(
            {'uuid': '', 'message': {'content': [{'type': 'text', 'text': DURABLE}]}}), {})
        self.assertEqual(supervisor._frame_text_identity(
            {'uuid': frame['uuid'], 'message': {'content': [{'type': 'text', 'text': '   '}]}}), {})
        self.assertEqual(supervisor._frame_text_identity(
            {'uuid': frame['uuid'], 'message': {'content': 'plain string'}}), {})
        self.assertEqual(supervisor._frame_text_identity({'uuid': frame['uuid']}), {})
        self.assertEqual(supervisor._frame_text_identity(
            {'uuid': frame['uuid'], 'message': {'content': [None, 7, 'x']}}), {})

    # ============================================ the sweep, by identity
    def test_the_shared_id_retires_a_live_row_no_text_rule_could_match(self):
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        # the durable row really is there, and really carries the id
        row = self.chat()['messages'][-1]
        self.assertEqual(row['text'], DURABLE)
        self.assertEqual(row['native_event_id'], record['uuid'])
        # the live row: the SAME id, but words that appear in NO transcript
        # row — so only identity can retire it
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'event_id': record['uuid']})
        self.assertEqual(self.chat()['live'], [],
                         'retired on the shared id alone')

    def test_the_same_fixture_survives_under_a_different_id(self):
        # THE POSITIVE CONTROL for the leg above: identical in every respect
        # except the id, and it must stay on screen. If this passed too, the
        # retire above would prove nothing.
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED,
            'event_id': 'f0000000-0000-4000-8000-0000000000ff'})
        self.assertEqual(self.live_texts(), [UNRELATED],
                         'an unrelated id pairs nothing and the row stays')

    def test_a_live_row_with_no_id_is_never_retired_by_identity(self):
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        supervisor.live_row(self.slug, 'agent',
                            {'kind': 'text', 'text': UNRELATED})
        # it gets the per-row `live:` id, which is in no durable row
        self.assertEqual(self.live_texts(), [UNRELATED])

    def test_a_durable_row_without_a_uuid_pairs_nothing(self):
        # legacy journals, and the synthetic steered rows read_chat invents,
        # carry no record uuid — those rows must simply not participate
        self.journal({'type': 'assistant', 'timestamp': '2026-09-11T07:00:00Z',
                      'message': {'id': 'legacy-1', 'role': 'assistant',
                                  'content': [{'type': 'text', 'text': DURABLE}]}})
        self.assertNotIn('native_event_id', self.chat()['messages'][-1])
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED,
            'event_id': 'f0000000-0000-4000-8000-0000000000aa'})
        self.assertEqual(self.live_texts(), [UNRELATED])

    def test_identity_never_retires_a_sticky_row(self):
        # immediate /context output is in no transcript, EVER — only the end
        # of the turn clears it. The identity check must not outrank that.
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'sticky': True,
            'event_id': record['uuid']})
        self.assertEqual(self.live_texts(), [UNRELATED],
                         'a sticky row outranks its own durable twin')

    def test_identity_retires_only_the_row_that_owns_the_id(self):
        # two durable messages, two live rows, one paired and one not: the
        # sweep must take exactly one. A rule that retired the whole tail
        # would pass every leg above.
        first, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        second, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:01Z', 'item-2', 'gpt-5.6', 'A second answer.')
        self.journal(first)
        self.journal(second)
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'event_id': first['uuid']})
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': 'still streaming, no twin yet',
            'event_id': 'f0000000-0000-4000-8000-0000000000bb'})
        self.assertEqual(self.live_texts(), ['still streaming, no twin yet'])

    def test_the_pairing_survives_the_incremental_evidence_path(self):
        # read_chat caches whole-history evidence and EXTENDS it on the next
        # read rather than rebuilding (`_extend_live_evidence`). A durable id
        # learned on an earlier read must still retire a live row that arrives
        # later — the handoff drops any key it does not name, and this is the
        # leg that catches a forgotten one.
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        self.assertEqual(self.chat()['messages'][-1]['native_event_id'],
                         record['uuid'], 'first read: the evidence is built')
        later, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:05Z', 'item-2', 'gpt-5.6', 'A later answer.')
        self.journal(later)
        self.chat()                       # second read: evidence EXTENDED
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'event_id': record['uuid']})
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED + ' two', 'event_id': later['uuid']})
        self.assertEqual(self.chat()['live'], [],
                         'ids from both the cached and the extended range retire')


    # ====================================== what the CLIENT actually receives
    def test_the_projection_carries_the_durable_id_onto_the_live_row(self):
        # ⚠ THE LEG THAT KEEPS THE RENDERER GUARD FROM BEING VACUOUS.
        # `event_id` does NOT survive to the client: reply_events._annotate
        # replaces every row's with a reply-snapshot id hashed over the
        # incarnation, the source AND the quoted text — so a live row and its
        # durable twin could never match on it, their quotes differing because
        # the live copy is the capped one. The id they share has to arrive in
        # a field the projection does not rewrite.
        rid = 'f0000000-0000-4000-8000-000000000042'
        # no journal record for it: nothing to retire it, so it reaches the
        # payload and can be inspected as the client would see it
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'event_id': rid})
        sent = self.chat()['live']
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['native_event_id'], rid,
                         'the durable id reaches the client intact')
        self.assertTrue(str(sent[0]['event_id']).startswith('reply_'),
                        'while event_id really has been rewritten — these are '
                        'two different fields doing two different jobs')
        self.assertNotEqual(sent[0]['event_id'], rid)

    def test_a_live_row_with_no_durable_id_carries_no_native_id(self):
        # the control: the server's own per-row `live:` counter matches no
        # record, so putting it on the wire as a durable id would be a lie the
        # renderer would then act on
        supervisor.live_row(self.slug, 'agent',
                            {'kind': 'text', 'text': UNRELATED})
        sent = self.chat()['live']
        self.assertEqual(len(sent), 1)
        self.assertNotIn('native_event_id', sent[0])

    def test_a_transcript_row_keeps_its_native_id_through_the_projection(self):
        # the other half of the pair: both sides must arrive carrying the SAME
        # field with the SAME value, or the renderer has nothing to compare
        record, _ = supervisor._paired_text_rows(
            '2026-09-11T07:00:00Z', 'item-1', 'gpt-5.6', DURABLE)
        self.journal(record)
        durable = self.chat()['messages'][-1]
        self.assertEqual(durable['native_event_id'], record['uuid'])
        self.assertTrue(str(durable['event_id']).startswith('reply_'))
        # and this is exactly the id an unswept live twin would carry
        supervisor.live_row(self.slug, 'agent', {
            'kind': 'text', 'text': UNRELATED, 'event_id': record['uuid'],
            'sticky': True})     # sticky, so the sweep leaves it for inspection
        live = self.chat()['live'][-1]
        self.assertEqual(live['native_event_id'], durable['native_event_id'],
                         'ONE id, both sides, as the user asked for')


if __name__ == '__main__':
    unittest.main()
