"""Ordered supervisor values share the legacy formatter and retained inputs."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from contextlib import ExitStack
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orgtree import api, ledger
from orgtree.orgdb import record_runtime as R


def context():
    nodes = {'agent':dict(model='haiku', last_turn_mcp_tool_count=7)}
    return SimpleNamespace(d=dict(slug='overlay-test',nodes=nodes),node=nodes.__getitem__)


def body():
    return dict(id='agent', name='agent', state='live', tier='haiku', ask=None,
                context_window=8192)


def state():
    return dict(busy=True, waiting=False, responding=True, phase='responding',
        queued_for_slot=None, queue=[{'secret':'never serialized'}], last_error=None,
        live=[dict(kind='tool',text='read')], tasks=2, bg_tasks=3, ran_as='account-id',
        proc_warm=False, proc_live=True, proc_relaunch=False,
        mcp_tool_count=4, mcp_tool_provider='claude', mcp_tool_source='discovery',
        mcp_readiness_waiting=False, mcp_readiness_state='ready')


class SupervisorOverlay(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.live = state()
        self.stack.enter_context(patch.object(api.supervisor,'state',side_effect=lambda *_:self.live))
        self.stack.enter_context(patch.object(api.supervisor,'_auto_cheap_cfg',return_value=None))
        self.stack.enter_context(patch.object(api.supervisor,'cache_forecast_public',return_value={'live':True}))
        self.stack.enter_context(patch.object(api.warmpool,'process_control_status',return_value={
            'paused':False,'enabled':True,'action':'pause','reason':None}))
        for target in ('orgtree.api.registry.list_accounts','orgtree.accounts.serving_label',
                       'orgtree.accountusage.serving_card','orgtree.store.load_org'):
            self.stack.enter_context(patch(target,side_effect=AssertionError('overlay read '+target)))
        self.stack.enter_context(patch.object(ledger.Org,'_boot_at',return_value=''))

    def test_shared_formatter_projects_live_fields_without_app_or_private_values(self):
        node = body()
        api._annotate_agent_runtime(context(),node)
        self.assertTrue(node['busy'])
        self.assertTrue(node['responding'])
        self.assertEqual(node['queued'],1)
        self.assertEqual(node['activity'],dict(phase='tool',tool='read'))
        self.assertEqual(node['mcp_tool_count'],4)
        self.assertEqual(node['last_turn_mcp_tool_count'],7)
        self.assertIsNone(node['mcp_tool_count_reason'])
        self.assertTrue(node['proc_control_enabled'])
        self.assertEqual(node['tasks'],2)
        self.assertEqual(node['bg_tasks'],3)
        self.assertEqual(node['ran_as'],'account-id')
        self.assertFalse({'serving_account','ran_as_label','account_label'}.intersection(node))
        self.assertNotIn('never serialized',str(node))
        self.assertTrue(R.AGENT_FIELDS.issubset(node))

    def test_retained_inputs_transition_catalog_copy_removal_and_unchanged_stamp(self):
        host = R.SupervisorOverlays('uuid','inc')
        with self.assertRaisesRegex(ValueError,'snapshot context'):
            host.adopt({'1':body()},{})
        first = host.adopt({'1':body()},{'1':context()})['1']
        delayed = host.full()
        self.assertEqual(host.transition(),{})
        self.live.update(busy=False,responding=False,queue=[],live=[],tasks=0)
        latest = host.transition({'agent'})['1']
        self.assertFalse(latest['busy'])
        self.assertEqual(latest['queued'],0)
        self.assertGreater(latest['seq'],delayed['seq'])
        self.assertTrue(delayed['agents']['1']['busy'])
        self.assertLess(first['seq'],delayed['seq'])
        self.assertEqual(host.transition({'another'}),{})
        self.assertEqual(host.catalog_changed({},{}),{})
        # The full copy owns its values and carries its own copy stamp.
        delayed['agents']['1']['activity']['phase']='corrupt'
        self.assertEqual(host.full()['agents']['1']['activity'],{'phase':'thinking'})
        host.adopt({}, {}, removed=['1'])
        self.assertEqual(host.full()['agents'],{})
        self.assertEqual(host._contexts,{})

    def test_archived_record_never_reads_a_stale_supervisor_process(self):
        host = R.SupervisorOverlays('uuid','inc')
        with patch.object(api,'_annotate_agent_runtime',side_effect=AssertionError('archived process read')):
            host.adopt({'1':{**body(),'state':'archived'}},{'1':context()})
            value = host.full()['agents']['1']
        for name in R.AGENT_FIELDS.intersection(api._ARCHIVED_RUNTIME_DEFAULTS):
            self.assertEqual(value[name],api._ARCHIVED_RUNTIME_DEFAULTS[name],name)
        self.assertFalse(value['proc_control_enabled'])
        self.assertIsNone(value['queued_for_slot'])

    def test_persisted_route_survives_idle_but_live_flag_uses_current_busy(self):
        org = context()
        route = dict(route='reserve',pool='reserve',requested='luna',model='luna',live=True)
        org.node('agent')['codex_route_last'] = route
        self.live['busy'] = False
        node = body()
        api._annotate_agent_runtime(org,node)
        self.assertFalse(node['codex_route']['live'])
        self.live.update(busy=True,codex_route={**route,'model':'sol'})
        api._annotate_agent_runtime(org,node)
        self.assertTrue(node['codex_route']['live'])
        self.assertEqual(node['codex_route']['model'],'sol')
        self.assertEqual(route['model'],'luna')


if __name__ == '__main__':
    unittest.main()
