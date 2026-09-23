"""Manual inbox M1+M2a: internal list/fetch behind a CLOSED door.

Synthetic stores and a fake runtime only. Every test builds its own org. The
negative-control harness in the author's scratch disables one guarantee at a
time and shows the test that names it fails.
"""
import copy
import itertools
import json
import re
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='manual-inbox-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import inbox, ledger, mailruntime, store, supervisor as sup

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []
OLD = '2000-01-01T00:00:00Z'
LIVE = 'op-live'
W = 'worker'
_SERIAL = itertools.count()


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class ManualInboxTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"{self._testMethodName.replace('_', '-')[:48]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.hire(ledger.USER, None, 'haiku', 0, 'peer')
        store.save_org(org)
        self.st = sup.state(self.slug, W)
        self.gen = org.node(W)['generation']
        self.n = 0

    def tearDown(self):
        sup._state.pop((self.slug, W), None)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def canonical(self):
        return json.dumps(self.load().d, sort_keys=True, ensure_ascii=False)

    def deposit(self, body='hello', kind='message', count=1, org=None, **extra):
        own = org is None
        org = org or self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(W, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                 'from': 'boss', 'kind': kind, 'body': body,
                                 'at': ledger.now(), **extra})
            ids.append(mid)
        if own:
            store.save_org(org)
        return ids

    def journal(self, ids, *, at=OLD, via='steer', **row):
        """Move `ids` from the box into one journal batch, as a drain would."""
        org = self.load()
        box = org.d['mail'][W]
        mail = [m for m in box if m['id'] in ids]
        org.d['mail'][W] = [m for m in box if m['id'] not in ids]
        tok = sup._journal_drain(org, W, mail, [], via=via)
        batch = org.d['delivering'][W][-1]
        batch['at'] = at
        batch.update(row)
        store.save_org(org)
        return tok

    def begin(self, attempt=LIVE, toks=()):
        org = self.load()
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = attempt
            self.st['busy'] = True
            mailruntime.register(self.st, org, W, attempt=attempt, toks=list(toks))

    def end(self, attempt=LIVE):
        """The turn-end order `_run_one_turn_recorded` uses: release custody,
        then the ordinary fold, while the node's busy flags are still set."""
        with sup._state_lock:
            mailruntime.release(self.st, attempt=attempt)
        sup._fold_back_undelivered(self.slug, W, keep_toks=[])
        with sup._state_lock:
            self.st.pop('lifecycle_operation_id', None)
            self.st['busy'] = False

    def fetch(self, ids, **kw):
        return sup.manual_fetch(self.slug, W, self.gen, ids, **kw)

    def lst(self, **kw):
        return sup.manual_list(self.slug, W, self.gen, **kw)

    def states(self, result):
        return {r['message_id']: r['state'] for r in result['rows']}

    def journal_rows(self):
        return copy.deepcopy((self.load().d.get('delivering') or {}).get(W) or [])

    def box_ids(self):
        return [m['id'] for m in (self.load().d.get('mail') or {}).get(W) or []]

    # ------------------------------------------------------------ the door
    def test_there_is_no_agent_facing_door(self):
        """Nothing outside the supervisor and this suite reaches the internals:
        no tool card, no agent_call selector, no dispatcher, no receipt key."""
        root = Path(__file__).resolve().parents[1]
        backend = root / 'engine/backend/orgtree'
        for path in sorted(backend.rglob('*.py')):
            if path.name in ('supervisor.py', 'inbox.py'):
                continue
            text = path.read_text(encoding='utf-8', errors='replace')
            for needle in ('manual_list(', 'manual_fetch(', 'manual_fetch_chunk(',
                           'orgtree_inbox'):
                self.assertNotIn(needle, text, f'{path.name} reaches {needle}')
            self.assertIsNone(re.search(r'import[^\n]*\binbox\b', text), path.name)
        sup_text = (backend / 'supervisor.py').read_text(encoding='utf-8')
        callers = re.findall(r'(?<!def )\bmanual_(?:list|fetch|fetch_chunk)\(', sup_text)
        self.assertEqual(callers, [], 'the supervisor itself must not call them')

    def test_target_shaped_arguments_get_one_identical_refusal(self):
        """The validator a future door must apply first: a fixed refusal for any
        target-shaped key, identical whether or not the named peer exists and
        computed without reading any document."""
        self.deposit()
        before = self.canonical()
        outs = [inbox.check_args(action, args) for action, args in (
            ('list', {'target': 'peer'}), ('list', {'target': 'no-such-agent'}),
            ('list', {'node': W}), ('list', {'mailbox': 'anything'}),
            ('list', {'org': 'other'}),
            ('fetch', {'message_ids': ['m0001'], 'agent': 'peer'}),
            ('chunk', {'delivery_id': 'd', 'message_id': 'm', 'chunk_index': 0,
                       'target': 'peer'}))]
        self.assertTrue(all(o == outs[0] for o in outs), outs)
        self.assertEqual(outs[0]['error'], 'target_refused')
        self.assertEqual(outs[0]['text'], inbox.TARGET_REFUSAL)
        self.assertIsNone(inbox.check_args('list', {'cursor': None, 'limit': 5}))
        self.assertIsNone(inbox.check_args('fetch', {'message_ids': ['m0001']}))
        self.assertEqual(self.canonical(), before)

    def test_stale_or_foreign_identity_is_refused_without_reading(self):
        self.deposit()
        a = sup.manual_list(self.slug, W, self.gen + 1)
        b = sup.manual_list(self.slug, 'no-such-agent', self.gen)
        c = sup.manual_fetch(self.slug, W, self.gen + 1, ['m0001'])
        self.assertEqual(a, b)
        self.assertEqual(a, c)
        self.assertEqual(a['error'], 'identity_refused')

    # ------------------------------------------------------------ list
    def test_list_is_pure_inspection(self):
        self.deposit(count=3)
        self.journal(['m0001'])
        self.begin()
        self.fetch(['m0002'])
        org = self.load()
        org.node(W).pop('mailbox_id', None)       # A5: absent stays absent
        org.d.setdefault('notices', {})[W] = [{'at': OLD, 'text': 'n'}]
        store.save_org(org)
        before = self.canonical()
        with sup._state_lock:
            facts = json.dumps(mailruntime.runtime_facts(self.st), sort_keys=True, default=sorted)
        out = self.lst()
        self.assertTrue(out['ok'])
        self.assertNotIn('mailbox_id', out)
        self.assertEqual(out['notices_pending'], 1)
        self.assertEqual(self.canonical(), before)
        self.assertNotIn('mailbox_id', self.load().node(W))
        with sup._state_lock:
            self.assertEqual(json.dumps(mailruntime.runtime_facts(self.st),
                                        sort_keys=True, default=sorted), facts)

    def test_list_rows_carry_identity_facts_and_bounded_preview(self):
        long_line = 'x' * 500 + '\nsecond line'
        self.deposit(body=long_line, attachments=[{'name': 'a.png', 'path': 'outbox/a.png', 'bytes': 7}])
        row = self.lst()['rows'][0]
        self.assertEqual(row['message_id'], 'm0001')
        self.assertEqual(row['operation_id'], 'op-m0001')
        self.assertEqual(row['recv_seq'], 1)
        self.assertEqual(row['seq_origin'], 'deposit')
        self.assertEqual(row['preview'], 'x' * inbox.PREVIEW_CHARS)
        self.assertEqual(row['body_bytes'], len(long_line.encode()))
        self.assertEqual(row['attachments'], [{'name': 'a.png', 'bytes': 7}])
        self.assertNotIn('body', row)
        self.assertEqual(row['state'], 'queued')

    def test_self_view_states_agree_with_the_reclaim_classifier(self):
        ids = self.deposit(count=9)
        orphan = self.journal([ids[0]])
        young = self.journal([ids[1]], at=ledger.now())
        queued = self.journal([ids[2]])
        steered = self.journal([ids[3]])
        held = self.journal([ids[4]])
        turn = self.journal([ids[5]])
        org = self.load()
        org.node(W)['halt_queue'] = [{'text': 'held', 'toks': [held]}]
        store.save_org(org)
        with sup._state_lock:
            self.st['queue'] = [{'text': 'q', 'toks': [queued]}]
            self.st['steer'] = [{'text': 's', 'toks': [steered]}]
        self.begin(toks=[turn])
        self.fetch([ids[6]])
        states = self.states(self.lst())
        self.assertEqual(states, {ids[0]: 'unowned', ids[1]: 'settling',
                                  ids[2]: 'inflight_queue', ids[3]: 'inflight_steer',
                                  ids[4]: 'held_halt', ids[5]: 'inflight_turn',
                                  ids[6]: 'fetched_unconfirmed', ids[7]: 'queued',
                                  ids[8]: 'queued'})
        # one resolver: exactly the `unowned` batches are the reclaimable ones
        org = self.load()
        with sup._state_lock:
            facts = mailruntime.runtime_facts(self.st)
        eligible = mailruntime.eligible_tokens(org, W, facts, now=time.time(), pump_toks=())
        self.assertEqual(eligible, {orphan})
        self.assertEqual(sup.inspect_mail_ownership(self.slug, W).reclaimable_tokens, {orphan})
        self.assertNotIn(young, eligible)

    def test_busy_node_does_not_mask_an_unowned_batch(self):
        ids = self.deposit(count=1)
        self.journal(ids, via='steer')
        with sup._state_lock:
            self.st.update(busy=True, responding=True, waiting=True, proc_control=True)
        self.assertEqual(self.states(self.lst()), {ids[0]: 'unowned'})

    def test_notices_are_ordinary_mail_and_a_notice_only_box_lists(self):
        ids = self.deposit(kind='notice', count=2)
        org = self.load()
        org.d.setdefault('notices', {})[W] = [{'at': OLD, 'text': 'org change'}]
        store.save_org(org)
        out = self.lst()
        self.assertEqual([r['message_id'] for r in out['rows']], ids)
        self.assertEqual([r['wakes'] for r in out['rows']], [False, False])
        self.assertEqual(out['notices_pending'], 1)
        self.begin()
        got = self.fetch(ids)
        self.assertEqual([f['message_id'] for f in got['fetched']], ids)

    def test_every_one_of_250_messages_is_reachable_across_pages(self):
        ids = self.deposit(count=250)
        seen, cursor, pages = [], None, 0
        while True:
            out = self.lst(cursor=cursor)
            pages += 1
            seen += [r['message_id'] for r in out['rows']]
            self.assertLessEqual(len(out['rows']), inbox.LIST_DEFAULT)
            cursor = out['next_cursor']
            if not cursor:
                break
        self.assertEqual(seen, ids)
        self.assertEqual(pages, 5)
        full = self.lst(limit=inbox.LIST_MAX)
        self.assertEqual(len(full['rows']), 200)
        self.assertEqual(self.lst(limit=201)['error'], 'limit_out_of_range')
        self.assertEqual(self.lst(limit=0)['error'], 'limit_out_of_range')

    def test_consumption_between_pages_skips_no_unseen_row(self):
        ids = self.deposit(count=120)
        first = self.lst()
        self.assertEqual([r['message_id'] for r in first['rows']], ids[:50])
        # rows are consumed and folded around between pages: seen rows leave,
        # an older unseen row is prepended by a fold, array positions shift
        org = self.load()
        box = org.d['mail'][W]
        org.d['mail'][W] = [m for m in box if m['id'] not in ids[:30] + ids[55:60]]
        moved = [m for m in org.d['mail'][W] if m['id'] == ids[80]]
        org.d['mail'][W] = moved + [m for m in org.d['mail'][W] if m['id'] != ids[80]]
        store.save_org(org)
        rest, cursor = [], first['next_cursor']
        while cursor:
            out = self.lst(cursor=cursor)
            rest += [r['message_id'] for r in out['rows']]
            cursor = out['next_cursor']
        self.assertEqual(rest, [i for i in ids[50:] if i not in ids[55:60]])

    def test_cursor_is_bound_to_the_mailbox_identity(self):
        self.deposit(count=60)
        cursor = self.lst()['next_cursor']
        org = self.load()
        org.node(W)['mailbox_id'] = 'recreated01'
        store.save_org(org)
        self.assertEqual(self.lst(cursor=cursor)['error'], 'cursor_stale')
        self.assertEqual(self.lst(cursor='garbage')['error'], 'cursor_invalid')

    # ------------------------------------------------------------ fetch
    def test_fetch_needs_the_callers_own_running_turn(self):
        self.deposit()
        before = self.canonical()
        self.assertEqual(self.fetch(['m0001']).get('error'), 'custody_unproven')
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = LIVE
            self.st['busy'] = True      # busy, but no registration: no custody
        self.assertEqual(self.fetch(['m0001']).get('error'), 'custody_unproven')
        self.assertEqual(self.canonical(), before)

    def test_fetch_drains_exactly_the_requested_ids_and_confirms_nothing(self):
        ids = self.deposit(count=3)
        before = self.load()
        seqs = {m['id']: (m['recv_seq'], m['mailbox'], m['seq_origin'])
                for m in before.d['mail'][W]}
        self.begin()
        out = self.fetch([ids[1]])
        self.assertTrue(out['ok'])
        self.assertEqual([f['message_id'] for f in out['fetched']], [ids[1]])
        self.assertEqual(out['fetched'][0]['content'], 'hello')
        self.assertIs(out['confirmable'], False)
        self.assertIs(out['will_redeliver'], True)
        self.assertTrue(out['will_redeliver_reason'])
        self.assertEqual(self.box_ids(), [ids[0], ids[2]])
        after = self.load()
        [row] = after.d['delivering'][W]
        self.assertEqual(row['mode'], 'manual_fetch')
        self.assertEqual(row['manual']['delivery_id'], out['delivery_id'])
        self.assertEqual(row['manual']['attempt'], LIVE)
        self.assertEqual({m['id']: (m['recv_seq'], m['mailbox'], m['seq_origin'])
                          for m in row['mail']}, {ids[1]: seqs[ids[1]]})
        dump = lambda o, k: json.dumps(o.d.get(k), sort_keys=True)  # noqa: E731
        for key in ('mail_log', 'steered_log', 'lifecycle', 'mail_transitions'):
            self.assertEqual(dump(after, key), dump(before, key), key)
        self.assertEqual(after.node(W).get('mail_seq'), before.node(W).get('mail_seq'))

    def test_fetch_reclaims_an_unowned_batch_and_redelivers_it(self):
        ids = self.deposit(count=2)
        orphan = self.journal(ids)
        self.begin()
        out = self.fetch([ids[0]])
        self.assertEqual(out['reclaimed_batches'], 1)
        self.assertEqual(out['fetched'][0]['message_id'], ids[0])
        self.assertGreaterEqual(out['fetched'][0]['redelivered'], 1)
        org = self.load()
        self.assertEqual([m['id'] for m in org.d['mail'][W]], [ids[1]])
        self.assertEqual(org.d['mail'][W][0]['redelivered'], 1)
        self.assertNotIn(orphan, [r['tok'] for r in org.d['delivering'][W]])
        self.assertTrue(any(orphan in r['before']
                            for r in org.d['mail_transitions'][W].values()))

    def test_every_live_owner_class_keeps_its_batch_byte_identical(self):
        cases = {
            'queue': ('inflight_queue', lambda tok, st, org: st.update(queue=[{'text': 'q', 'toks': [tok]}])),
            'steer': ('inflight_steer', lambda tok, st, org: st.update(steer=[{'text': 's', 'toks': [tok]}])),
            'claim': ('inflight_steer', lambda tok, st, org: st.update(steer=[{'text': 's', 'toks': [tok],
                                        'claim': {'delivery_id': 'd1', 'acked': True}}])),
            'halt': ('held_halt', lambda tok, st, org: org.node(W).update(halt_queue=[{'text': 'h', 'toks': [tok]}])),
            'native': ('held_halt', lambda tok, st, org: org.node(W).update(native_held_carriers=[{'toks': [tok]}])),
            'turn': ('inflight_turn', lambda tok, st, org: mailruntime.adopt(st, attempt=LIVE, toks=[tok])),
            'confirming': ('inflight_other', lambda tok, st, org: st.update(mail_confirmed={tok})),
            'lease': ('inflight_other', lambda tok, st, org: org.node(W).update(drive_lease=True)),
            'input': ('inflight_other', lambda tok, st, org: org.d['delivering'][W][0].update(input_attempt='op-old')),
        }
        for name, (stage, arm) in cases.items():
            with self.subTest(owner=name):
                self.setUp()
                ids = self.deposit()
                tok = self.journal(ids)
                self.begin()
                org = self.load()
                with sup._state_lock:
                    arm(tok, self.st, org)
                store.save_org(org)
                before = self.journal_rows()
                out = self.fetch(ids)
                self.assertEqual(out['already_moved'], [{'message_id': ids[0], 'state': stage}])
                self.assertEqual(out['fetched'], [])
                self.assertEqual(self.journal_rows(), before)
                self.tearDown()

    def test_a_batch_inside_the_drain_grace_is_settling_until_it_passes(self):
        ids = self.deposit()
        stamp = ledger.now()
        self.journal(ids, at=stamp)
        self.begin()
        t0 = time.time()
        out = self.fetch(ids, now=t0)
        self.assertEqual(out['already_moved'], [{'message_id': ids[0], 'state': 'settling'}])
        later = self.fetch(ids, now=t0 + sup.STRANDED_GRACE_S + 1)
        self.assertEqual([f['message_id'] for f in later['fetched']], ids)

    def test_a_manual_batch_is_never_reclaimed_within_its_own_turn(self):
        ids = self.deposit()
        self.begin()
        first = self.fetch(ids)
        before = self.journal_rows()
        again = self.fetch(ids, now=time.time() + 3600)   # far past any grace
        self.assertEqual(again['already_moved'],
                         [{'message_id': ids[0], 'state': 'fetched_unconfirmed',
                           'delivery_id': first['delivery_id']}])
        self.assertEqual(self.journal_rows(), before)

    def test_the_running_turn_cannot_reclaim_its_own_envelope(self):
        ids = self.deposit()
        tok = self.journal(ids, via='turn')
        self.begin(toks=[tok])
        before = self.journal_rows()
        out = self.fetch(ids, now=time.time() + 3600)
        self.assertEqual(out['already_moved'], [{'message_id': ids[0], 'state': 'inflight_turn'}])
        self.assertEqual(self.journal_rows(), before)

    def test_turn_end_returns_an_unconfirmed_manual_batch_to_the_mailbox(self):
        ids = self.deposit(count=2)
        self.begin()
        out = self.fetch(ids)
        self.end()
        org = self.load()
        self.assertFalse((org.d.get('delivering') or {}).get(W))
        self.assertEqual([m['id'] for m in org.d['mail'][W]], ids)
        self.assertEqual([m['redelivered'] for m in org.d['mail'][W]], [1, 1])
        chunk = sup.manual_fetch_chunk(self.slug, W, self.gen, out['delivery_id'], ids[0], 0)
        self.assertEqual(chunk['content_state'], 'redelivered')
        self.assertIsNone(chunk['content'])

    def test_a_failed_turn_end_fold_stays_recoverable(self):
        ids = self.deposit()
        self.begin()
        self.fetch(ids)
        with patch.object(store, 'save_org', side_effect=OSError('disk full')):
            self.end()
        self.assertEqual(len(self.journal_rows()), 1)
        self.assertEqual(self.states(self.lst()), {ids[0]: 'unowned'})
        self.begin('op-next')
        self.end('op-next')
        self.assertEqual(self.box_ids(), ids)

    def test_the_budget_defers_whole_messages_and_never_truncates(self):
        body = 'a' * (60 * 1024)
        ids = self.deposit(body=body, count=5)
        self.begin()
        out = self.fetch(ids)
        self.assertEqual([f['message_id'] for f in out['fetched']], ids[:4])
        self.assertTrue(all(f['content'] == body and f['complete'] for f in out['fetched']))
        self.assertEqual(out['deferred_ids'], [{'message_id': ids[4], 'body_bytes': len(body)}])
        self.assertEqual(self.box_ids(), [ids[4]])
        self.assertEqual(self.load().d['mail'][W][0]['body'], body)

    def test_an_oversized_body_is_chunked_and_reassembles_exactly(self):
        body = '€' * 70000 + 'end'                   # 3-byte characters
        ids = self.deposit(body=body)
        self.begin()
        out = self.fetch(ids)
        first = out['fetched'][0]
        self.assertEqual(first['chunk_total'], 4)
        self.assertFalse(first['complete'])
        before = self.canonical()
        parts = []
        for i in range(first['chunk_total']):
            a = sup.manual_fetch_chunk(self.slug, W, self.gen, out['delivery_id'], ids[0], i)
            b = sup.manual_fetch_chunk(self.slug, W, self.gen, out['delivery_id'], ids[0], i)
            self.assertEqual(a, b)                      # a replay is byte-identical
            self.assertEqual(a['body_sha256'], first['body_sha256'])
            self.assertLessEqual(len(a['content'].encode()), inbox.CHUNK_BYTES)
            parts.append(a['content'])
        self.assertEqual(parts[0], first['content'])
        self.assertEqual(''.join(parts), body)
        import hashlib
        self.assertEqual(hashlib.sha256(''.join(parts).encode()).hexdigest(),
                         first['body_sha256'])
        self.assertEqual(self.canonical(), before)     # continuation never re-drains
        bad = sup.manual_fetch_chunk(self.slug, W, self.gen, out['delivery_id'], ids[0], 4)
        self.assertEqual(bad['error'], 'chunk_out_of_range')

    def test_no_confirmation_while_any_chunk_lacks_evidence(self):
        body = '€' * 70000
        ids = self.deposit(body=body)
        ids += self.deposit(body='small')
        self.begin()
        out = self.fetch(ids)
        [row] = self.journal_rows()
        record = row['manual']
        every = {(mid, i): True for mid, p in record['plan'].items()
                 for i in range(p['chunk_total'])}
        self.assertTrue(inbox.confirmation_complete(record, every))
        for missing in every:
            self.assertFalse(inbox.confirmation_complete(
                record, {k: v for k, v in every.items() if k != missing}))
        self.assertFalse(inbox.confirmation_complete(record, {(ids[0], 3): True}))
        self.end()
        self.assertEqual(self.box_ids(), ids)          # folds back whole
        self.assertTrue(out['delivery_id'])

    def test_an_unreadable_body_is_left_in_the_mailbox(self):
        org = self.load()
        org.deposit_mail(W, {'id': 'bad', 'from': 'boss', 'kind': 'message',
                             'body': None, 'at': ledger.now()})
        store.save_org(org)
        self.begin()
        out = self.fetch(['bad', 'missing'])
        self.assertEqual(out['unsupported_ids'], ['bad'])
        self.assertEqual(out['not_found'], ['missing'])
        self.assertEqual(self.box_ids(), ['bad'])

    def test_an_id_boxed_twice_is_not_taken(self):
        ids = self.deposit()
        org = self.load()
        org.d['mail'][W].append(copy.deepcopy(org.d['mail'][W][0]))
        store.save_org(org)
        self.begin()
        out = self.fetch(ids)
        self.assertEqual(out['unsupported_ids'], ids)
        self.assertEqual(self.box_ids(), ids + ids)

    def test_a_carrier_published_before_the_snapshot_keeps_its_batch(self):
        ids = self.deposit()
        tok = self.journal(ids)
        self.begin()
        before = self.journal_rows()
        real, calls = mailruntime.runtime_facts, []

        def racing(st):
            calls.append(1)
            if len(calls) == 2:       # reclaim_orphans' own evidence read
                st['queue'] = [{'text': 'raced', 'toks': [tok]}]
            return real(st)
        with patch.object(mailruntime, 'runtime_facts', racing):
            out = self.fetch(ids)
        self.assertEqual(out['already_moved'], [{'message_id': ids[0], 'state': 'inflight_queue'}])
        self.assertEqual(self.journal_rows(), before)

    def test_a_carrier_composed_during_the_fold_is_never_published(self):
        ids = self.deposit()
        tok = self.journal(ids)
        self.begin()
        raced = {'text': 'raced', 'toks': [tok]}
        real = sup._fold_back_locked

        def racing(org, nid, **kw):
            self.st['queue'] = [raced]          # a publisher holding a local copy
            return real(org, nid, **kw)
        with patch.object(sup, '_fold_back_locked', racing):
            out = self.fetch(ids)
        self.assertEqual([f['message_id'] for f in out['fetched']], ids)
        with sup._state_lock:
            self.assertIsNone(sup._publishable(self.st, raced))

    def test_a_save_failure_reports_an_unknown_outcome_and_loses_nothing(self):
        ids = self.deposit()
        self.begin()
        before = self.canonical()
        with patch.object(store, 'save_org', side_effect=OSError('disk full')):
            out = self.fetch(ids)
        self.assertEqual(out['error'], 'fetch_outcome_unknown')
        self.assertIs(out['will_redeliver'], True)
        self.assertEqual(self.canonical(), before)

    # ------------------------------------------------------------ restart
    def crashed_manual_row(self):
        ids = self.deposit()
        self.begin()
        self.fetch(ids)
        sup._state.pop((self.slug, W), None)            # the process died
        self.st = sup.state(self.slug, W)
        org = self.load()
        row = org.d['delivering'][W][0]
        row['manual']['engine'] = 'prior-engine'
        row['at'] = OLD
        store.save_org(org)
        return ids

    def restart(self, gone):
        with store.DOC_LOCK:
            org = self.load()
            folded = sup._reconcile_mail_journal(org, owners_gone=lambda row: gone)
            store.save_org(org)
        return folded

    def test_a_prior_engines_manual_batch_stays_held_without_owner_proof(self):
        ids = self.crashed_manual_row()
        self.begin('op-new')
        before = self.journal_rows()
        out = self.fetch(ids, now=time.time() + 3600)
        self.assertEqual([m['state'] for m in out['already_moved']], ['fetched_unconfirmed'])
        sup._fold_back_undelivered(self.slug, W)
        self.assertEqual(self.journal_rows(), before)
        self.assertFalse(self.restart(False))
        self.assertEqual(len(self.journal_rows()), 1)

    def test_restart_returns_a_manual_batch_once_its_owner_is_proven_gone(self):
        ids = self.crashed_manual_row()
        self.assertTrue(self.restart(True))
        org = self.load()
        self.assertFalse((org.d.get('delivering') or {}).get(W))
        self.assertEqual([m['id'] for m in org.d['mail'][W]], ids)
        self.assertEqual(org.d['mail'][W][0]['redelivered'], 1)
        self.assertIn('may see them twice', org.d['steered_log'][W][-1]['text'])
        self.assertFalse(self.restart(True))            # idempotent

    def test_a_malformed_manual_record_is_never_released(self):
        ids = self.crashed_manual_row()
        org = self.load()
        org.d['delivering'][W][0]['manual'].pop('delivery_id')
        store.save_org(org)
        self.assertFalse(self.restart(True))
        self.begin('op-new')
        out = self.fetch(ids, now=time.time() + 3600)
        self.assertEqual([m['state'] for m in out['already_moved']], ['fetched_unconfirmed'])


if __name__ == '__main__':
    unittest.main()
