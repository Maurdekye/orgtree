"""Clock candidates cross where the existing Python display rules cross."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

import test_foreground_context as fixture
from orgtree import ledger, limits, supervisor
from orgtree.foreground_context import ForegroundContext, CompatibilityRequired
from orgtree.orgdb import record_time as T
from orgtree.orgdb import docket


UTC = timezone.utc
EPS = timedelta(microseconds=1)


class ClockCandidates(unittest.TestCase):
    def ask_rows(self, kind, stamp):
        # Actual body producer, not a second implementation of its predicate.
        org,args = fixture.fixture()
        row = dict(id='q',node='parent',status='answered',at=stamp,resolved_at=stamp)
        if kind == 'scope':
            row.update(status='granted',items=[])
        if kind == 'credit':
            row.update(status='granted',old=1,new=2,reason='test')
        section = {'ask':'asks','credit':'credit_requests','scope':'scope_requests'}[kind]
        org.d[section] = [row]
        return org,dict(row,kind=kind)

    def test_ask_candidates_match_fractional_whole_second_offset_and_naive_stamps(self):
        for kind in ('ask','credit','scope'):
            for stamp in ('2026-10-04T12:00:00.123Z','2026-10-04T12:00:00Z',
                          '2026-10-04T12:00:00+03:00','2026-10-04T12:00:00',
                          '2026-99-99T12:00:00Z','2026-10-04T99:00:00Z'):
                with self.subTest(kind=kind,stamp=stamp):
                    org,row = self.ask_rows(kind,stamp)
                    candidates = T.asks([row],{'parent':'42'},{})
                    self.assertEqual(len(candidates),1)
                    boundary = candidates[0]
                    self.assertEqual(boundary.records,frozenset((('agent','42'),)))
                    before = org.node_ask('parent',now_ts=(boundary.at-EPS).timestamp(),include_boot=False)
                    self.assertIsNotNone(before)
                    self.assertIsNone(org.node_ask('parent',now_ts=boundary.at.timestamp(),include_boot=False))

    def test_open_batches_withdrawn_and_new_session_have_no_linger_crossing(self):
        org,row = self.ask_rows('ask','2026-10-04T12:00:00.123Z')
        for kind,status,section in (('ask','open','asks'),('credit','pending','credit_requests'),
                                    ('scope','pending','scope_requests')):
            with self.subTest(kind=kind):
                pending = dict(row,id='p',kind=kind,status=status,
                               questions=[dict(id='tab',question='Ready?')],
                               items=[dict(kind='tool',tool='bash')],
                               old=1,new=2,reason='test')
                org.d[section] = [pending] if section != 'asks' else [row,pending]
                self.assertEqual(T.asks([row,pending],{'parent':42},{}),[])
                self.assertIsNotNone(org.node_ask('parent',now_ts=2e9,include_boot=False))
                org.d[section] = [row] if section == 'asks' else []
        withdrawn = dict(row,kind='credit',status='withdrawn')
        self.assertEqual(T.asks([withdrawn],{'parent':42},{}),[])
        org.node('parent')['session_began_at'] = '2026-10-04T12:00:01.000Z'
        self.assertEqual(T.asks([row],{'parent':42},{'parent':org.node('parent')['session_began_at']}),[])
        self.assertIsNone(org.node_ask('parent',now_ts=1760e6,include_boot=False))

    def test_latest_card_only_and_unreachable_lexical_stamps_have_no_clock(self):
        org,row = self.ask_rows('ask','2026-10-04T12:00:00.123Z')
        newer = dict(row,id='new',resolved_at='2026-10-04T12:01:00Z')
        org.d['asks'].append(newer)
        boundary, = T.asks([row,newer],{'parent':42},{})
        self.assertEqual(org.node_ask('parent',now_ts=(boundary.at-EPS).timestamp(),include_boot=False)['id'],'new')
        self.assertIsNone(org.node_ask('parent',now_ts=boundary.at.timestamp(),include_boot=False))
        for stamp in ('not a date','9999-99-99T12:00:00Z',None):
            self.assertIsNone(T.ask_expiry(stamp))

    def test_tomb_enters_and_expires_at_the_actual_strict_clock_predicate(self):
        org,_ = fixture.fixture()
        row = dict(spent_at='2026-10-04T12:00:00.123456Z')
        enter,leave = T.tombs([row])
        self.assertTrue(org._tomb_expired(row,now_ts=(enter.at-EPS).timestamp()))
        self.assertFalse(org._tomb_expired(row,now_ts=enter.at.timestamp()))
        self.assertFalse(org._tomb_expired(row,now_ts=(leave.at-EPS).timestamp()))
        self.assertTrue(org._tomb_expired(row,now_ts=leave.at.timestamp()))
        for stamp in (None,'2026-10-04T12:00:00Z','bad'):
            self.assertEqual(T.tombs([dict(spent_at=stamp)]),[])
            self.assertTrue(org._tomb_expired(dict(spent_at=stamp)))

    def test_freeze_horizon_entry_uses_record_ranking_and_does_not_clear_a_promise(self):
        own = datetime(2026,10,20,tzinfo=UTC).timestamp()
        freeze = dict(until_ts=own,reset_src='provider',reason='network disconnected')
        original = copy.deepcopy(freeze)
        boundary, = T.freezes([(42,freeze)])
        self.assertEqual(boundary.at.timestamp(),own-limits.MAX_HORIZON)
        self.assertIsNone(supervisor.effective_freeze_deadline(freeze,None,(boundary.at-EPS).timestamp()))
        self.assertEqual(supervisor.effective_freeze_deadline(freeze,None,boundary.at.timestamp())['ts'],own)
        self.assertEqual(freeze,original)
        # Its due instant is a countdown; the reader's promised deadline
        # survives that instant. No spurious expiry revision is scheduled.
        self.assertEqual(T.Plan(T.freezes([(42,freeze)])).next(datetime.fromtimestamp(own,UTC)),None)
        self.assertEqual(T.freezes([(42,dict(until_ts='bad'))]),[])

    def test_plan_deduplicates_crossings_and_does_not_republish_old_clock_span(self):
        first = datetime(2026,10,4,tzinfo=UTC)
        keys = frozenset((('org','watchdogs'),))
        plan = T.Plan([T.Boundary(first,keys),T.Boundary(first,keys),
                       T.Boundary(first+EPS,frozenset((('agent','42'),)))])
        self.assertEqual(len(plan.boundaries),2)
        self.assertEqual(plan.due(first-EPS,first),keys)
        self.assertEqual(plan.due(first,first+EPS),frozenset((('agent','42'),)))
        self.assertEqual(plan.due(first+EPS,first),frozenset())
        self.assertEqual(plan.next(first),first+EPS)
        self.assertIsNone(plan.next(first+EPS))

    def test_docket_boundary_matches_policy_header_and_strict_legacy_archive(self):
        org,_ = fixture.fixture()
        item = dict(slug='clock',status='done',docket_at='2026-10-04T12:00:00.123Z')
        fields = docket.write_fields(item)
        boundary, = T.docket([(17,T.instant(fields['docket_deadline']))])
        self.assertFalse(org._work_archived(item,False,(boundary.at-EPS).timestamp()))
        self.assertTrue(org._work_archived(item,False,boundary.at.timestamp()))
        self.assertIn(('work_item','17'),boundary.records)
        item['manual_attention'] = True
        self.assertTrue(docket.write_fields(item)['docket_manual'])
        self.assertFalse(org._work_archived(item,False,boundary.at.timestamp()))
        for status in ('open','blocked','in_progress'):
            item['status'] = status
            self.assertIsNone(docket.write_fields(item)['docket_deadline'])


class FableDisplay(unittest.TestCase):
    def test_record_snapshot_expires_detached_lock_and_agent_flags_at_its_clock(self):
        org,args = fixture.fixture()
        args['settings']['fable_lock'] = dict(until_ts=2000,reason='wall')
        args['graph']['rows']['parent']['node']['limit_locked'] = True
        untouched = copy.deepcopy(args)
        lock = args['settings']['fable_lock']
        boundary, = T.fable(lock)
        before = ForegroundContext(**args,records=True,now_ts=(boundary.at-EPS).timestamp())
        after = ForegroundContext(**args,records=True,now_ts=boundary.at.timestamp())
        self.assertTrue(before.nodes['parent']['limit_locked'])
        self.assertEqual(before.d['fable_lock'],lock)
        self.assertNotIn('fable_lock',after.d)
        self.assertNotIn('limit_locked',after.nodes['parent'])
        full_document = copy.deepcopy(org.d)
        full_document['fable_lock'] = copy.deepcopy(lock)
        full_document['nodes']['parent']['limit_locked'] = True
        with patch('time.time',return_value=boundary.at.timestamp()):
            normalized = ledger.Org(full_document)
        self.assertEqual(after.d.get('fable_lock'),normalized.d.get('fable_lock'))
        self.assertEqual(after.nodes['parent'].get('limit_locked'),normalized.node('parent').get('limit_locked'))
        self.assertEqual(args,untouched)
        with self.assertRaises(CompatibilityRequired):
            ForegroundContext(**args,now_ts=2000)

    def test_record_reuse_does_not_mutate_before_clock_copy_or_emit_notices(self):
        org,args = fixture.fixture()
        args['settings']['fable_lock'] = dict(until_ts=2000)
        args['graph']['rows']['parent']['node']['limit_locked'] = True
        old = ForegroundContext(**args,records=True,now_ts=1999)
        new = ForegroundContext(**args,records=True,now_ts=2000,reuse=old.nodes)
        self.assertTrue(old.nodes['parent']['limit_locked'])
        self.assertNotIn('limit_locked',new.nodes['parent'])
        self.assertEqual(new.d.get('user_inbox'),old.d.get('user_inbox'))

    def test_no_reset_lock_survives_and_missing_time_is_display_only_normalized(self):
        org,args = fixture.fixture()
        for lock,retained in ((dict(until_ts=1,no_reset=True),True),(dict(reason='old'),False)):
            args['settings']['fable_lock'] = lock
            args['graph']['rows']['parent']['node']['limit_locked'] = True
            self.assertEqual(T.fable(lock),[])
            view = ForegroundContext(**args,records=True,now_ts=2000)
            self.assertEqual(bool(view.d.get('fable_lock')),retained)
            self.assertEqual(bool(view.nodes['parent'].get('limit_locked')),retained)
            self.assertEqual(args['settings']['fable_lock'],lock)


if __name__ == '__main__':
    unittest.main()
