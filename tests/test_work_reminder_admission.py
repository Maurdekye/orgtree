"""Work reminders require actionable assigned work and >20 minutes idle."""
import os
import tempfile
import unittest
from unittest import mock

_data = tempfile.TemporaryDirectory(prefix="orgtree-reminder-admission-")
os.environ["ORGTREE_DATA"] = _data.name
from engine.backend.orgtree import ledger, store, supervisor
assert str(store.DATA_ROOT).lower().startswith(_data.name.lower())

class WorkReminderAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.org = ledger.Org.create("reminder-test")
        self.org.nodes["worker"] = {
            "state": "live", "parent": None, "generation": 1,
            "last_status": {"status": "working", "at": "1970-01-01T00:16:40Z"}}
        self.runtime = {}
        self.stack = __import__('contextlib').ExitStack()
        self.addCleanup(self.stack.close)
        for target, kwargs in (
            ("store.load_org", {"return_value": self.org}),
            ("store.save_org", {}),
            ("store.list_orgs", {"return_value": [{"slug":"reminder-test"}]}),
            ("state", {"return_value": self.runtime}),
            ("mail_spark", {}),
            ("_auto_wake_gates_clear", {"return_value": True}),
        ):
            self.stack.enter_context(mock.patch('engine.backend.orgtree.supervisor.'+target, **kwargs))

    def ticket(self, status="open"):
        self.org.work_create("worker", "Required task", "test", owner="worker")
        self.org._work_active()[0]["status"] = status

    def test_no_ticket_and_terminal_work_do_not_earn_checkup(self):
        self.assertFalse(supervisor._working_checkup_eligible(self.org,"worker"))
        self.ticket()
        self.assertTrue(supervisor._working_checkup_eligible(self.org,"worker"))
        item=self.org._work_active()[0]
        for status in ("done","dropped","blocked","backlogged"):
            item["status"]=status
            self.assertFalse(supervisor._working_checkup_eligible(self.org,"worker"),status)

    def test_strict_twenty_minute_boundary(self):
        self.ticket()
        self.assertIsNone(supervisor._working_checkup_reserve("reminder-test","worker",2200))
        self.assertIsNotNone(supervisor._working_checkup_reserve("reminder-test","worker",2200.001))
        self.assertIsNone(supervisor._working_checkup_reserve("reminder-test","worker",2201))

    def test_runtime_activity_suppresses_working_and_docket_reminders(self):
        self.ticket()
        for sweep in (supervisor._working_checkup_pass, supervisor._idle_docket_reminder_pass):
            for flag in ("busy","waiting","responding","queue","proc_control"):
                self.runtime[flag]=True
                wake=mock.Mock(return_value={"accepted":True})
                sweep(wake=wake,now=5000,mode_enabled=True)
                wake.assert_not_called()
                self.runtime.clear()
        wake=mock.Mock(return_value={"accepted":True})
        supervisor._working_checkup_pass(wake=wake,now=5000,mode_enabled=True)
        wake.assert_called_once()

    def test_archived_seats_do_not_reload_the_org_but_live_work_still_wakes(self):
        import copy
        self.ticket()
        template=copy.deepcopy(self.org.d)
        for sweep in (supervisor._working_checkup_pass, supervisor._idle_docket_reminder_pass):
            self.org.d=copy.deepcopy(template)
            for i in range(40):
                nid=f'archived-{i}'
                self.org.nodes[nid]={**copy.deepcopy(self.org.nodes['worker']), 'state':'archived'}
                item=copy.deepcopy(self.org._work_active()[0])
                item['slug']=f'old-ticket-{i}'
                item['owner']={'node':nid,'generation':1}
                self.org._work_active().append(item)
            with mock.patch.object(store,'load_org',return_value=self.org) as reads, \
                 mock.patch.object(supervisor,'_auto_wake_gates_clear',side_effect=lambda org,nid: org.node(nid)['state']=='live'):
                wake=mock.Mock(return_value={'accepted':True})
                sweep(wake=wake,now=5000,mode_enabled=True)
                self.assertEqual(reads.call_count,2,'one snapshot plus one live reservation, regardless of archived count')
                wake.assert_called_once()
                self.assertEqual(wake.call_args.args[1],'worker')

    def test_prefilter_does_not_replace_locked_eligibility_recheck(self):
        import copy
        self.ticket()
        changed=copy.deepcopy(self.org)
        changed.node('worker')['state']='archived'
        for sweep in (supervisor._working_checkup_pass, supervisor._idle_docket_reminder_pass):
            with mock.patch.object(store,'load_org',side_effect=[self.org,changed]) as reads, \
                 mock.patch.object(supervisor,'_auto_wake_gates_clear',side_effect=lambda org,nid: org.node(nid)['state']=='live') as gate:
                wake=mock.Mock(return_value={'accepted':True})
                sweep(wake=wake,now=5000,mode_enabled=True)
                self.assertEqual(reads.call_count,2)
                gate.assert_called_once_with(changed,'worker')
                wake.assert_not_called()

if __name__ == '__main__': unittest.main()
