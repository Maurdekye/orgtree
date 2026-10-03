"""Actual ledger actions and API output through both storage modes."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
from datetime import datetime
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
from orgtree import ledger, store, workdetail
from orgtree.ledger import USER
from orgtree.orgdb import conn

AT = '2026-10-03T12:00:00.000Z'
NOW = datetime.fromisoformat(AT.replace('Z','+00:00')).timestamp()
ITEM = 'fix-the-thing'
SHA = 'a'*40


def setUpModule():
    unittest.addModuleCleanup(fixture.tearDownModule)
    fixture.setUpModule()


def prepare(slug):
    org = store.load_org(slug)
    record = org.d['work_items'][0]
    packet = dict(candidate=SHA,base='b'*40,note='review packet',evidence=[],
                  by={'node':'dev','generation':0},at=AT)
    record.update(status='review',reviewer={'node':'ops','generation':0,'born':'seat-ops'},
                  at=AT,updated_at=AT,docket_at=AT,status_at=AT,
                  review_packet=packet,review_packets=[copy.deepcopy(packet)],
                  candidate_verdict=None,candidate_verdicts=[],scope=[],acceptance=[])
    store.save_org(org)


@fixture.needs_pg
class LedgerActions(unittest.TestCase):
    def test_review_reopen_archive_actions_keep_exact_api_and_parent_identity(self):
        twins = fixture.Twins('event actions',before=prepare)
        with fixture.storage(True), conn.connect(fixture.RUNTIME,fixture.registry.lookup(twins.copy)[1]) as raw:
            rid = raw.execute('SELECT id FROM orgtree.work_items WHERE slug=%s',(ITEM,)).fetchone()[0]
        def update(org,**kwargs):
            return org.work_update(USER,ITEM,done_so_far=['measured'],working_on_next=['next'],
                                   owner='dev',**kwargs)
        actions = [
            ('approve_stage',lambda org:org.work_review_decide('ops',ITEM,'approve_stage',candidate=SHA),
             'approved',False,True),
            ('reopen approval',lambda org:update(org,status='in_progress',reopen=True),
             'in_progress',False,False),
            ('new packet',lambda org:update(org,status='review',reviewer='ops',review_candidate=SHA,review_note='again'),
             'review',True,False),
            ('changes',lambda org:org.work_review_decide('ops',ITEM,'changes',note='change it'),
             'in_progress',False,False),
            ('review again',lambda org:update(org,status='review',reviewer='ops',review_candidate=SHA,review_note='ready'),
             'review',True,False),
            ('approve again',lambda org:org.work_review_decide('ops',ITEM,'approve_stage',candidate=SHA),
             'approved',False,True),
            ('complete',lambda org:update(org,status='done'), 'done',False,True),
            ('archive',lambda org:org.work_archive_now(USER,ITEM),'done',False,True),
            ('reopen archive',lambda org:update(org,status='in_progress',reopen=True),
             'in_progress',False,False),
        ]
        previous = []
        for name,action,status,packet,verdict in actions:
            with self.subTest(action=name), patch.object(ledger,'now',return_value=AT):
                outputs = []
                for on,slug in ((False,twins.legacy),(True,twins.copy)):
                    with fixture.storage(on):
                        org = store.load_org(slug)
                        action(org)
                        store.save_org(org)
                        outputs.append(workdetail.get(slug,USER,ITEM,now_ts=NOW))
                self.assertEqual(outputs[0],outputs[1])
                body = outputs[1]
                self.assertEqual(body['status'],status)
                self.assertEqual(body.get('review_packet') is not None,packet)
                self.assertEqual(body.get('candidate_verdict') is not None,verdict)
                with fixture.storage(True), conn.connect(fixture.RUNTIME,fixture.registry.lookup(twins.copy)[1]) as raw:
                    row = raw.execute('SELECT id,current_verdict_event_id,current_review_packet_event_id '
                                      'FROM orgtree.work_items WHERE slug=%s',(ITEM,)).fetchone()
                    self.assertEqual(row[0],rid)
                    self.assertEqual(row[1] is not None,verdict)
                    self.assertEqual(row[2] is not None,packet)
                    events = raw.execute('SELECT id,seq,xmin::text FROM orgtree.work_item_events '
                                         'WHERE item_id=%s ORDER BY seq',(rid,)).fetchall()
                    self.assertEqual(events[:len(previous)],previous)
                    previous = events


if __name__=='__main__':
    unittest.main()
