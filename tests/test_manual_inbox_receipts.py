"""Manual inbox P06a: original-key receipt and durable attempt, door CLOSED.

A keyed fetch is admitted inside its own DOC_LOCK before anything moves and
files its receipt in the same single save as the drain; every fetch that
takes mail writes a durable attempt that outlives its journal row. Synthetic
stores and a fake runtime only; the real `opreceipts` rules and the real API
lookup are used, and no request reaches a door (there is none). The
negative-control harness in the author's scratch removes one guarantee at a
time and shows the test that names it fails.
"""
import copy
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='manual-inbox-receipts-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import api, inbox, ledger, mailruntime, opreceipts, store, supervisor as sup

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


class ManualInboxReceiptTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"rcpt-{self._testMethodName.replace('_', '-')[:44]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        self.st = sup.state(self.slug, W)
        self.gen = org.node(W)['generation']
        self.n = 0

    def tearDown(self):
        sup._state.pop((self.slug, W), None)
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def canonical(self):
        return json.dumps(self.load().d, sort_keys=True, ensure_ascii=False)

    def deposit(self, body='hello', count=1):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(W, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                 'from': 'boss', 'kind': 'message', 'body': body,
                                 'at': ledger.now()})
            ids.append(mid)
        store.save_org(org)
        return ids

    def journal(self, ids, *, at=OLD):
        org = self.load()
        box = org.d['mail'][W]
        mail = [m for m in box if m['id'] in ids]
        org.d['mail'][W] = [m for m in box if m['id'] not in ids]
        tok = sup._journal_drain(org, W, mail, [], via='steer')
        org.d['delivering'][W][-1]['at'] = at
        store.save_org(org)
        return tok

    def begin(self, attempt=LIVE):
        org = self.load()
        with sup._state_lock:
            self.st['lifecycle_operation_id'] = attempt
            self.st['busy'] = True
            mailruntime.register(self.st, org, W, attempt=attempt, toks=[])

    def end(self, attempt=LIVE):
        with sup._state_lock:
            mailruntime.release(self.st, attempt=attempt)
        sup._fold_back_undelivered(self.slug, W, keep_toks=[])
        with sup._state_lock:
            self.st.pop('lifecycle_operation_id', None)
            self.st['busy'] = False

    def epoch(self):
        with store.DOC_LOCK:
            return opreceipts.custody(self.load().d, store.DATA_ROOT, self.slug)[0]

    def keyed(self, ids, key=None, epoch=None, generation=None):
        key = key or opreceipts.mint_key()
        epoch = epoch or self.epoch()
        out = sup.manual_fetch(self.slug, W, self.gen if generation is None else generation,
                               ids, op_key=key, op_epoch=epoch)
        return key, epoch, out

    def lookup(self, key, epoch, ids):
        body = api.AgentCall(org=self.slug, node=W, tool=api.OP_LOOKUP)
        return api._op_lookup_call(body, {
            'op_key': key, 'op_epoch': epoch, 'for_tool': inbox.TOOL,
            'for_args': {'action': 'fetch', 'message_ids': ids}})

    def journal_rows(self):
        return copy.deepcopy((self.load().d.get('delivering') or {}).get(W) or [])

    def box_ids(self):
        return [m['id'] for m in (self.load().d.get('mail') or {}).get(W) or []]

    def attempts(self):
        return copy.deepcopy((self.load().d.get('manual_attempts') or {}).get(W) or {})

    # ------------------------------------------------------ classification
    def test_fetch_is_transaction_class_and_reads_are_not_receipted(self):
        cov = opreceipts.coverage
        self.assertEqual(cov(inbox.TOOL, {'action': 'fetch'}), opreceipts.TX)
        self.assertEqual(cov(inbox.TOOL, {'action': 'list'}), opreceipts.NONE)
        self.assertEqual(cov(inbox.TOOL, {'action': 'chunk'}), opreceipts.NONE)
        self.assertEqual(cov(inbox.TOOL, {'action': 'no-such-action'}), opreceipts.TX)
        self.assertTrue(opreceipts.provable_absence(cov(inbox.TOOL, {'action': 'fetch'})))
        self.assertEqual(opreceipts.COVERAGE, 1)
        full = {'ok': True, 'delivery_id': 'mf-1', 'fetched': [{'content': 'secret'}],
                'already_moved': [], 'not_found': ['x'], 'deferred_ids': [],
                'unsupported_ids': [], 'fetched_count': 1, 'deferred_count': 0,
                'already_moved_count': 0, 'not_found_count': 1, 'unsupported_count': 0,
                **inbox.disclosure()}
        kept = opreceipts.result_slice(inbox.TOOL, full)
        self.assertEqual(kept['delivery_id'], 'mf-1')
        self.assertEqual(kept['fetched_count'], 1)
        self.assertNotIn('fetched', kept)
        self.assertNotIn('secret', json.dumps(kept))

    def test_a_key_is_refused_unless_fetch_is_receipted(self):
        ids = self.deposit()
        self.begin()
        with patch.dict(opreceipts._ACTION_COVERAGE, {inbox.TOOL: {'fetch': opreceipts.NONE}}):
            before = self.canonical()
            _, _, out = self.keyed(ids)
        self.assertEqual((out.get('error'), out.get('reason')), ('op_key_refused', 'uncovered'))
        self.assertEqual(self.canonical(), before)

    def test_the_door_would_fingerprint_the_same_arguments(self):
        """The API normalises an agent's args before fingerprinting them; the
        fetch's own args must come out of that unchanged, or a lookup through
        the door would never match the receipt."""
        args = {'action': 'fetch', 'message_ids': ['m0001', 'm0002']}
        self.assertEqual(api._norm_args(args), args)

    # ------------------------------------------------------------ NC-13
    def test_a_lost_fetch_response_is_recovered_by_its_key(self):
        ids = self.deposit(count=2)
        self.begin()
        key, epoch, out = self.keyed(ids)          # ... and the response is lost
        [row] = self.journal_rows()
        look = self.lookup(key, epoch, ids)
        self.assertEqual(look['state'], 'applied', look)
        result = look['receipt']['result']
        self.assertEqual(result.get('delivery_id'), row['manual']['delivery_id'])
        self.assertEqual(result.get('fetched_count'), 2)
        self.assertIs(result['confirmable'], False)
        listed = {r['message_id']: r for r in sup.manual_list(self.slug, W, self.gen)['rows']}
        self.assertEqual({listed[i]['delivery']['delivery_id'] for i in ids},
                         {result['delivery_id']})
        chunk = sup.manual_fetch_chunk(self.slug, W, self.gen, result['delivery_id'], ids[0], 0)
        self.assertEqual(chunk['content'], 'hello')

    def test_a_keyed_fetch_that_takes_nothing_still_answers_by_receipt(self):
        self.deposit()                                # the mailbox exists
        self.begin()
        key, epoch, out = self.keyed(['no-such-id'])
        self.assertEqual(out.get('not_found'), ['no-such-id'], out)
        look = self.lookup(key, epoch, ['no-such-id'])
        self.assertEqual(look['state'], 'applied')
        self.assertEqual(look['receipt']['result'].get('fetched_count'), 0)
        self.assertEqual(look['receipt']['result'].get('not_found_count'), 1)
        self.assertNotIn('delivery_id', look['receipt']['result'])

    # ------------------------------------------------- one save, one truth
    def test_the_receipt_rides_the_fetch_save(self):
        ids = self.deposit()
        self.begin()
        with patch.object(store, 'save_org', wraps=store.save_org) as save:
            key, _, out = self.keyed(ids)
        self.assertEqual(save.call_count, 1)
        d = self.load().d
        [receipt] = d[opreceipts.SECTION]
        self.assertEqual(receipt['cls'], opreceipts.TX)
        self.assertEqual(receipt['result']['delivery_id'], out['delivery_id'])
        self.assertEqual(d['delivering'][W][0]['manual']['delivery_id'], out['delivery_id'])

    def test_a_failed_save_leaves_no_receipt_and_a_lookup_fences_the_key(self):
        ids = self.deposit()
        self.begin()
        before = self.canonical()
        epoch = self.epoch()
        key = opreceipts.mint_key()
        with patch.object(store, 'save_org', side_effect=OSError('disk full')):
            out = sup.manual_fetch(self.slug, W, self.gen, ids, op_key=key, op_epoch=epoch)
        self.assertEqual(out['error'], 'fetch_outcome_unknown')
        self.assertEqual(self.canonical(), before)
        look = self.lookup(key, epoch, ids)
        self.assertEqual(look['state'], 'not_applied')
        # the delayed original can never apply now
        _, _, again = self.keyed(ids, key=key, epoch=epoch)
        self.assertEqual((again.get('error'), again.get('reason')), ('op_key_refused', 'fenced'))
        self.assertEqual(self.box_ids(), ids)
        self.assertFalse(self.journal_rows())

    def test_a_response_lost_after_the_commit_is_found_applied(self):
        ids = self.deposit()
        self.begin()
        real = store.save_org

        def commit_then_fail(org):
            real(org)
            raise OSError('connection dropped after commit')
        epoch = self.epoch()
        key = opreceipts.mint_key()
        with patch.object(store, 'save_org', side_effect=commit_then_fail):
            out = sup.manual_fetch(self.slug, W, self.gen, ids, op_key=key, op_epoch=epoch)
        self.assertEqual(out['error'], 'fetch_outcome_unknown')
        look = self.lookup(key, epoch, ids)
        self.assertEqual(look['state'], 'applied')
        [row] = self.journal_rows()
        self.assertEqual(look['receipt']['result'].get('delivery_id'), row['manual']['delivery_id'])

    # ------------------------------------------------------------ replay
    def test_the_same_key_replays_and_drains_nothing(self):
        ids = self.deposit(count=2)
        self.begin()
        key, epoch, first = self.keyed(ids[:1])
        before = self.canonical()
        again = sup.manual_fetch(self.slug, W, self.gen, ids[:1], op_key=key, op_epoch=epoch)
        self.assertTrue(again.get('replayed'))
        self.assertEqual(again['result']['delivery_id'], first['delivery_id'])
        self.assertEqual(again['content_state'], 'present')
        self.assertIs(again['will_redeliver'], True)
        self.assertEqual(self.canonical(), before)

    def test_a_replay_after_redelivery_does_not_take_the_mail_again(self):
        ids = self.deposit()
        self.begin()
        key, epoch, first = self.keyed(ids)
        self.end()
        self.begin('op-next')
        before = self.canonical()
        again = sup.manual_fetch(self.slug, W, self.gen, ids, op_key=key, op_epoch=epoch)
        self.assertTrue(again.get('replayed'))
        self.assertEqual(again['content_state'], 'redelivered')
        self.assertEqual(self.canonical(), before)
        self.assertEqual(self.box_ids(), ids)

    def test_a_reused_key_for_other_messages_is_a_conflict(self):
        ids = self.deposit(count=2)
        self.begin()
        key, epoch, _ = self.keyed(ids[:1])
        before = self.canonical()
        out = sup.manual_fetch(self.slug, W, self.gen, ids[1:], op_key=key, op_epoch=epoch)
        self.assertEqual(out.get('error'), 'op_key_conflict')
        self.assertEqual(self.canonical(), before)

    def test_a_stale_epoch_is_refused_before_anything_moves(self):
        ids = self.deposit(count=2)
        self.journal(ids[1:])                         # an unowned batch fetch would reclaim
        self.begin()
        epoch = self.epoch()
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)    # the backend restarted
        before = self.canonical()
        _, _, out = self.keyed(ids, epoch=epoch)
        self.assertEqual((out.get('error'), out.get('reason')), ('op_key_refused', 'stale_epoch'))
        self.assertEqual(self.canonical(), before)

    def test_a_key_from_an_earlier_generation_is_never_run(self):
        ids = self.deposit(count=2)
        self.begin()
        key, epoch, _ = self.keyed(ids[:1])
        org = self.load()
        org.node(W)['generation'] = self.gen + 1
        store.save_org(org)
        before = self.canonical()
        _, _, out = self.keyed(ids[:1], key=key, epoch=epoch, generation=self.gen + 1)
        self.assertEqual((out.get('error'), out.get('reason')),
                         ('op_key_refused', 'foreign_generation'))
        self.assertEqual(self.canonical(), before)

    def test_an_unkeyed_fetch_never_creates_the_receipt_log(self):
        ids = self.deposit()
        self.begin()
        out = sup.manual_fetch(self.slug, W, self.gen, ids)
        self.assertTrue(out['ok'])
        d = self.load().d
        self.assertNotIn(opreceipts.SECTION, d)
        self.assertNotIn(opreceipts.META, d)

    def test_the_commit_is_witnessed_so_a_rewind_rotates_the_epoch(self):
        ids = self.deposit()
        self.begin()
        key, epoch, _ = self.keyed(ids)
        seq = opreceipts.seq(self.load().d)
        self.assertEqual(opreceipts.witnessed(store.DATA_ROOT, self.slug), seq)
        org = self.load()                             # restored underneath us:
        org.d.pop(opreceipts.SECTION)                 # the pre-fetch receipt log
        org.d[opreceipts.META]['seq'] = seq - 1
        store.save_org(org)
        with store.DOC_LOCK:
            now_epoch, why = opreceipts.custody(self.load().d, store.DATA_ROOT, self.slug)
        self.assertNotEqual(now_epoch, epoch)
        self.assertIn('rewound', why)

    # ------------------------------------------------------- the attempt
    def test_the_attempt_is_written_with_the_drain(self):
        ids = self.deposit(count=2, body='€' * 70000)
        self.begin()
        key, _, out = self.keyed(ids[:1])
        [row] = self.journal_rows()
        self.assertIn(out['delivery_id'], self.attempts())
        att = self.attempts()[out['delivery_id']]
        [receipt] = self.load().d[opreceipts.SECTION]
        self.assertEqual(att['tok'], row['tok'])
        self.assertEqual(att['mail_ids'], ids[:1])
        self.assertEqual(att['digests'][ids[0]]['chunk_total'], 4)
        self.assertEqual(att['op_key'], key)
        self.assertEqual(att['op_id'], receipt['id'])
        self.assertEqual((att['attempt'], att['generation']), (LIVE, self.gen))
        self.assertIsNone(att['provider_call_id'])
        self.assertEqual(att['call_id_source'], 'unsupplied')
        self.assertIsNone(att['resolved'])

    def test_no_attempt_without_a_drain(self):
        before = self.canonical()
        self.assertEqual(sup.manual_fetch(self.slug, W, self.gen, ['x'])['error'],
                         'custody_unproven')
        self.assertEqual(self.canonical(), before)
        self.deposit()
        self.begin()
        self.assertTrue(sup.manual_fetch(self.slug, W, self.gen, ['no-such-id'])['ok'])
        self.assertFalse(self.attempts())

    def test_a_kept_attempt_keeps_saying_where_its_delivery_went(self):
        """N3: after a later reclaim compacts the transition receipts, a read
        of the first delivery still answers from positive records."""
        ids = self.deposit(count=2)
        self.begin()
        first = sup.manual_fetch(self.slug, W, self.gen, ids[:1])
        self.end()
        self.begin('op-2')
        sup.manual_fetch(self.slug, W, self.gen, ids[1:])
        self.end('op-2')                              # this reclaim compacts receipts
        chunk = sup.manual_fetch_chunk(self.slug, W, self.gen, first['delivery_id'], ids[0], 0)
        self.assertEqual(chunk['content_state'], 'redelivered')
        self.assertTrue(chunk['attempt_recorded'])
        self.assertIsNone(chunk['content'])

    def test_an_attempt_confirms_nothing(self):
        ids = self.deposit()
        self.begin()
        out = sup.manual_fetch(self.slug, W, self.gen, ids)
        tok = self.journal_rows()[0]['tok']
        self.assertNotIn(tok, mailruntime.confirmed_tokens(self.load(), W))
        self.end()
        org = self.load()
        self.assertEqual([(m['id'], m['redelivered']) for m in org.d['mail'][W]], [(ids[0], 1)])
        self.assertIn(out['delivery_id'], self.attempts())
        self.assertIsNone(self.attempts()[out['delivery_id']]['resolved'])  # its mail waits again

    def test_open_attempts_are_never_trimmed_and_resolved_ones_are_bounded(self):
        ids = self.deposit(count=2)
        org = self.load()
        atts = org.d.setdefault('manual_attempts', {}).setdefault(W, {})
        for i in range(inbox.ATTEMPTS_KEEP + 5):
            atts[f'mf-old{i:02d}'] = {'at': f'2001-01-01T00:00:{i:02d}Z', 'tok': 'gone',
                                     'mail_ids': ['long-gone'], 'resolved': 'unknown'}
        atts['mf-open'] = {'at': '1999-01-01T00:00:00Z', 'tok': 'gone', 'mail_ids': [ids[1]],
                           'resolved': None}       # oldest, but its mail still waits
        store.save_org(org)
        self.begin()
        sup.manual_fetch(self.slug, W, self.gen, ids[:1])
        kept = self.attempts()
        self.assertIn('mf-open', kept)
        self.assertIsNone(kept['mf-open']['resolved'])
        resolved = sorted(k for k, a in kept.items() if a['resolved'] is not None)
        self.assertEqual(resolved, [f'mf-old{i:02d}' for i in range(5, inbox.ATTEMPTS_KEEP + 5)])

    def test_a_closed_attempt_resolves_from_its_positive_receipt(self):
        ids = self.deposit(count=2)
        self.begin()
        first = sup.manual_fetch(self.slug, W, self.gen, ids[:1])
        self.end()
        org = self.load()                              # its mail is consumed elsewhere
        org.d['mail'][W] = [m for m in org.d['mail'][W] if m['id'] != ids[0]]
        store.save_org(org)
        self.begin('op-2')
        sup.manual_fetch(self.slug, W, self.gen, ids[1:])
        self.assertEqual(self.attempts().get(first['delivery_id'], {}).get('resolved'),
                         'redelivered')


if __name__ == '__main__':
    unittest.main()
