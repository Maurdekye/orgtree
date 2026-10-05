"""Host-derived values keep parity without changing org bodies or revisions."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orgtree import ledger, supervisor
from orgtree.orgdb import record_runtime as R

NOW = datetime(2026, 10, 4, 8, 0, tzinfo=timezone.utc).timestamp()


def view(card, *, boot='', began=''):
    return SimpleNamespace(d=dict(asks=[card], credit_requests=[], scope_requests=[]),
        nodes=dict(agent=dict(session_began_at=began)), _boot_at=lambda: boot)


class Runtime(unittest.TestCase):
    def test_resolved_card_restart_split_matches_legacy_without_boot_in_body(self):
        card = dict(id='a', node='agent', status='answered', at='2026-10-04T07:40:00.000Z',
                    resolved_at='2026-10-04T07:55:00.000Z')
        for boot in ('', '2026-10-04T07:54:00.000Z', '2026-10-04T07:56:00.000Z'):
            org = view(card, boot=boot)
            body = dict(ask=ledger.Org.node_ask(org, 'agent', now_ts=NOW, include_boot=False))
            self.assertEqual(body['ask'], card)  # boot never dirties this body
            overlay = R.agent_fields(body, {}, boot_at=boot)
            projected = body['ask'] if overlay['ask_linger_visible'] else None
            self.assertEqual(projected, ledger.Org.node_ask(org, 'agent', now_ts=NOW))
        org = view(card)
        org._boot_at = lambda: self.fail('revisioned body consulted process boot')
        self.assertEqual(ledger.Org.node_ask(org, 'agent', now_ts=NOW, include_boot=False), card)

    def test_time_session_pending_and_empty_boot_rules_are_preserved(self):
        card = dict(id='a', node='agent', status='answered', at='2026-10-04T07:40:00.000Z',
                    resolved_at='2026-10-04T07:55:00.000Z')
        for org, now in ((view(card, began='2026-10-04T07:56:00Z'), NOW),
                         (view(card), NOW+901)):
            self.assertIsNone(ledger.Org.node_ask(org, 'agent', now_ts=now, include_boot=False))
            self.assertIsNone(ledger.Org.node_ask(org, 'agent', now_ts=now))
        self.assertFalse(R.agent_fields(dict(ask=None), {}, boot_at='')['ask_linger_visible'])
        open_card = {**card, 'status':'open', 'questions':[dict(id='q', question='Proceed?')]}
        org = view(open_card, boot='2026-10-04T08:00:00.000Z')
        body = ledger.Org.node_ask(org, 'agent', now_ts=NOW, include_boot=False)
        self.assertEqual(body['status'], 'open')
        self.assertTrue(R.agent_fields(dict(ask=body), {}, boot_at=org._boot_at())['ask_linger_visible'])
        self.assertEqual(body, ledger.Org.node_ask(org, 'agent', now_ts=NOW))

    def test_favourite_add_deselect_and_catalog_refresh_keep_org_precedence(self):
        catalog = {'org/model':100000, 'app/model':200000, 'new/model':300000}
        favourite_context = {}
        def favourite(tier):
            return favourite_context.get(tier)
        def cached(mid):
            return dict(context=catalog[mid]) if mid in catalog else None
        body = dict(tier='or-record-test', model_id='or-record-test', context_window=8192, ask=None)
        with patch('orgtree.openrouter.favorite_for_tier', side_effect=favourite), \
                patch('orgtree.openrouter.cached_card', side_effect=cached), \
                patch.object(ledger.Org,'_boot_at',return_value=''):
            runtime = R.AgentOverlays('uuid','inc')
            runtime.update({'1':body})
            for persisted, favourites, expected in (
                ({},{'or-record-test':'app/model'},200000),
                ({},{},8192),
                ({'or-record-test':'org/model'},{'or-record-test':'app/model'},200000),
                ({'or-record-test':'org/model'},{},100000),
            ):
                favourite_context.clear()
                favourite_context.update({tier:dict(context=catalog[mid]) for tier,mid in favourites.items()})
                runtime.catalog_changed(persisted, favourites)
                value = runtime.full()['agents']['1']
                legacy = {**body, 'model_id':R.add_only(persisted,favourites).get(body['tier'],body['tier'])}
                self.assertEqual(value['context_window'], expected)
                self.assertEqual(value['context_window'], supervisor.context_window(legacy))
                self.assertEqual(body['context_window'],8192)
                for tier,mid in persisted.items():
                    self.assertEqual(legacy['model_id'],mid)  # table wins; helper retains its context rule
            catalog['org/model'] = 400000
            changed = runtime.catalog_changed({'or-record-test':'org/model'}, {})
            self.assertEqual(changed['1']['context_window'],400000)
            self.assertEqual(body['model_id'],'or-record-test')

    def test_body_change_and_new_host_recompute_visibility_and_window(self):
        card = dict(status='answered', resolved_at='2026-10-04T07:55:00Z', at='2026-10-04T07:40:00Z')
        first, second = R.HostClock(), R.HostClock()
        with patch.object(ledger.Org,'_boot_at',return_value='2026-10-04T07:54:00.000Z'):
            old = R.AgentOverlays('uuid','inc',clock=first)
        with patch.object(ledger.Org,'_boot_at',return_value='2026-10-04T07:56:00.000Z'):
            new = R.AgentOverlays('uuid','inc',clock=second)
        body = dict(tier='unknown', ask=card, context_window=4096)
        old.update({'1':body})
        new.update({'1':body})
        self.assertTrue(old.full()['agents']['1']['ask_linger_visible'])
        self.assertFalse(new.full()['agents']['1']['ask_linger_visible'])
        self.assertNotEqual(first.epoch,second.epoch)
        live = new.update({'1':{**body,'ask':{**card,'resolved_at':'2026-10-04T07:57:00Z'},
                                'context_window':8192}})
        self.assertTrue(live['1']['ask_linger_visible'])
        self.assertEqual(live['1']['context_window'],8192)

    def test_clock_is_shared_ordered_under_concurrency_and_copies_are_isolated(self):
        clock = R.HostClock()
        with ThreadPoolExecutor(max_workers=8) as pool:
            stamps = list(pool.map(lambda _:clock.stamp(),range(100)))
        self.assertEqual(sorted(s['seq'] for s in stamps),list(range(1,101)))
        self.assertEqual({s['epoch'] for s in stamps},{clock.epoch})
        with patch.object(ledger.Org,'_boot_at',return_value=''):
            org = R.AgentOverlays('uuid','inc',clock=clock)
        body = dict(ask=None,context_window=1)
        change = org.update({'1':body})
        app_stamp = clock.stamp()  # B4b uses this same counter, never its own
        delayed = org.full()
        newest = org.update({'1':{**body,'context_window':2}})
        self.assertLess(change['1']['seq'],app_stamp['seq'])
        self.assertLess(delayed['seq'],newest['1']['seq'])
        self.assertEqual(delayed['agents']['1']['seq'],delayed['seq'])
        self.assertEqual(delayed['agents']['1']['context_window'],1)
        delayed['agents']['1']['context_window'] = 99
        body['context_window'] = 99
        self.assertEqual(org.full()['agents']['1']['context_window'],2)
        self.assertEqual(org.update({'1':dict(ask=None,context_window=2)}),{})
        org.update({},removed=['1'])
        self.assertEqual(org.full()['agents'],{})


if __name__ == '__main__':
    unittest.main()
