"""capture-a-complete-operation-census-for-the-lock: the all-operation census.

The retained slow log cannot answer what fraction of real operations are
agent-local, because `api._access_emit` persists only requests over 500 ms and
carries no action, subtype or target — 18,723 retained rows, 471 with any lock
timing, and 57.5% of those unclassifiable. `census.py` is the unbiased,
classified, bounded replacement; this module is its evidence.

⚠ EVERY CONTROL HERE IS INSTRUMENTED, and that is the shape of the file rather
than a flourish. This team has been bitten by a probe that spun 60 million
times with zero commits and called it success, by a suite that died in
`setUp` and proved only that it had not run, and by an exhaustiveness test so
loosely asserted that deleting the thing it tested left all 17 cases passing.
So: no timing assertion is made unless `counters.observed` provably advanced;
the overflow control asserts the ring actually overflowed before it checks the
accounting; the privacy control asserts its own sentinels reached the request
before it asserts they are absent from the census. A control that cannot show
it did work is not allowed to return a verdict.

⚠ WHAT THIS SUITE DOES NOT ESTABLISH, stated so nobody reads it as more than
it is. It measures no overhead. It observes no storage contact — schema 3's
`db` block is exercised by `test_census_sqlite_contacts`, not here. It proves no locality proportion,
and `ProvenanceDisclosureTests` exists precisely to keep the payload saying so.
It covers HTTP attempts only: workers, tasks, callbacks, hooks, websockets and
restart recovery are outside the middleware and outside this file.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-op-census-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
# ⚠ NOT set to '1'. The census must be provably OFF at import so
# `CaptureDisabledTests` measures the real default rather than a fixture that
# happens to agree with it; every other test turns it on explicitly.
os.environ.pop('ORGTREE_OPERATION_CENSUS', None)
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402  (env must be set first)
app, *_ = load_app()

OPERATOR = {'X-Orgtree-Desktop-Token': 'operator'}
_orgs_created: list[str] = []


def tearDownModule():
    from orgtree import store
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


def _make_org(slug: str):
    from orgtree import store
    store.create_org(slug)
    _orgs_created.append(slug)
    return store


def _hire(slug: str, name: str = 'probe') -> str:
    """A LIVE top-level seat. The agent gateway's diagnostics family
    authenticates with `org.node(body.node)` + `_require_live`, so `node:
    'user'` is refused there — an agent-reachability test that called as the
    user would prove nothing about an agent.

    ⚠ `store.write_org` DOES NOT SAVE BY ITSELF — its own docstring spells the
    cycle `with write_org(slug) as org: … ; save_org(org)`. Without the save
    the hire returns `{'node': 'probe'}` and looks entirely successful while
    `org.nodes` stays empty, and the agent call then fails with
    "authenticated seat is missing", which reads like an authorization bug in
    the code under test rather than a missing line in the fixture.
    """
    from orgtree import ledger, store
    with store.write_org(slug) as org:
        org.hire(ledger.USER, None, 'haiku', 0, name)
        store.save_org(org)
    live = store.load_org(slug).node(name)
    assert live.get('state') == 'live', f'fixture seat is not live: {live!r}'
    return name


class CensusCase(unittest.TestCase):
    """Shared fixture: a fresh capture window per test, capture ON, and the
    denominator check every subclass leans on."""

    def setUp(self):
        from orgtree import census
        census.reset()
        census.set_enabled(True)
        self.client = TestClient(app)
        self.addCleanup(self._disable)

    def _disable(self):
        from orgtree import census
        census.set_enabled(False)
        census.reset()

    def read(self, **kw):
        got = self.client.get('/api/diagnostics/operation-census',
                              headers=OPERATOR, params=kw)
        self.assertEqual(got.status_code, 200, got.text)
        return got.json()

    def assertWindowDidWork(self, body, least=1):
        """⚠ THE CONTROL ON THE CONTROL. Nothing below may report a latency,
        a proportion or an absence from a window in which nothing ran. A
        negative control that 'passes' because it never executed is the
        failure mode this guard exists for, and it is asserted BEFORE the
        assertion it protects, never after."""
        self.assertGreaterEqual(
            body['counters']['observed'], least,
            'the census observed no requests at all in this window, so '
            'nothing below this line means anything: ' + json.dumps(body['counters']))
        self.assertGreaterEqual(
            body['counters']['recorded'], least,
            'requests were observed but none was recorded — capture was off '
            'or every record was rejected: ' + json.dumps(body['counters']))

    def assertAccountingHolds(self, body):
        """⚠ `recorded` MAY NEVER EXCEED `observed` INSIDE ONE WINDOW. That
        invariant is the module's headline claim about its own denominator and
        it is the thing the reset race broke, so it is checked wherever a
        window is read rather than only where a reset happens."""
        counters = body['counters']
        self.assertLessEqual(
            counters['recorded'], counters['observed'],
            'more records than requests observed in one window, which means a '
            'record from another window landed here: ' + json.dumps(counters))


# --------------------------------------------------------------- coverage

class OperationClassCoverageTests(CensusCase):
    """Acceptance 1: EVERY attempted operation class is represented, not only
    slow ones. Each class is asserted to have produced at least one record —
    the test fails on a missing class rather than passing on the subset that
    happened to work."""

    def test_every_operation_class_produces_a_record(self):
        slug = 'census-coverage-org'
        _make_org(slug)
        node = _hire(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)             # read route
        self.client.post('/api/agent', headers=OPERATOR, json={            # agent tool
            'org': slug, 'node': node, 'tool': 'orgtree_chart', 'args': {}})
        self.client.get('/api/orgs/this-org-does-not-exist', headers=OPERATOR)
        self.client.post('/api/definitely-not-a-route', headers=OPERATOR,  # catch-all
                         json={})
        self.client.post('/api/agent', headers=OPERATOR, json={            # refused
            'org': slug, 'node': 'ghost-node', 'tool': 'orgtree_chart', 'args': {}})

        body = self.read()
        self.assertWindowDidWork(body, least=5)
        self.assertAccountingHolds(body)
        rows = body['records']

        # ⚠ FAST REQUESTS ARE THE POINT. The shipped sink persists only
        # handler_ms >= 500; if this census were inheriting that bias every
        # row here would be slow, because none of the calls above is.
        fast = [r for r in rows
                if r['handler_ms'] is not None and r['handler_ms'] < 500]
        self.assertTrue(fast, 'a census that captured no sub-500ms request has '
                              'inherited the slow-only bias it exists to remove')

        classes = {
            'a read route': lambda r: r['rw'] == 'read' and '{slug}' in r['route'],
            'an agent tool call': lambda r: r.get('tool') == 'orgtree_chart',
            'a successful agent tool call': lambda r: (r.get('tool') == 'orgtree_chart'
                                                       and r['outcome'] == 'ok'),
            'the SPA catch-all': lambda r: '{path:path}' in r['route'],
            'a refusal': lambda r: r['outcome'] in ('auth_denied', 'client_error'),
            'a not-found': lambda r: r['outcome'] == 'not_found',
        }
        missing = [name for name, pred in classes.items()
                   if not any(pred(r) for r in rows)]
        self.assertEqual(missing, [], f'operation classes with ZERO records: '
                                      f'{missing}; saw {[r["op"] for r in rows]}')

    def test_every_record_is_labelled_an_attempt_and_says_what_it_is_not(self):
        """⚠ SCHEMA 2, KEPT AT 3. A row is one HTTP ATTEMPT, never one logical operation,
        and that has to be readable off the row itself — an analysis that
        counts rows as operations is the conflation this census exists to
        remove, and a caveat living only in a document is one the analysis
        will not have."""
        slug = 'census-unit-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        body = self.read()
        self.assertWindowDidWork(body)
        # 3 since P02-A3 added the `db` contact block; the attempt unit is
        # unchanged, which is what this test is about.
        self.assertEqual(body['schema_version'], 4)
        for row in body['records']:
            self.assertEqual(row['unit'], 'attempt', json.dumps(row))
            self.assertIn('terminal', row)
        self.assertTrue(any('attempt' in limit for limit in body['limits']))

    def test_an_unmatched_route_maps_to_unknown_and_is_never_guessed(self):
        """⚠ `<unmatched>` IS UNREACHABLE THROUGH THE APP — measured
        2026-09-20: a catch-all `/{path:path}` serves the SPA, so every
        request matches something and an unknown API path comes back as
        `GET /{path:path}` 200 or `POST /{path:path}` 405. The branch is a
        contract with `api._route_label`, which still produces that string
        when `scope["route"]` is absent, so it is asserted here directly
        rather than left to a request that can never produce it."""
        from orgtree import census_classes as cc
        self.assertEqual(cc.classify_route('GET', '<unmatched>'),
                         ('read', 'unknown', 'unknown'))
        self.assertEqual(cc.classify_route('POST', '/{path:path}'),
                         ('write', 'none', 'route_shape'))

    def test_a_handler_that_raises_is_still_censused(self):
        """A failed operation is as much an operation as a successful one, and
        it is the one an outcome census must not lose — the record is written
        from the middleware's `finally`."""
        before = self.read()['counters']['observed']
        # An unroutable method on a real path: reaches the middleware, fails
        # in routing, never reaches a handler. ⚠ DELETE rather than GET, so
        # the census's own self-read exclusion does not swallow it — that
        # exclusion covers READ methods on the census door only.
        self.client.request('DELETE', '/api/diagnostics/operation-census',
                            headers=OPERATOR)
        body = self.read()
        self.assertGreater(body['counters']['observed'], before)
        bad = [r for r in body['records'] if r['status'] >= 400]
        self.assertTrue(bad, 'a request that never reached a handler produced '
                             'no census record: ' + json.dumps(body['counters']))
        self.assertTrue(all(r['outcome'] != 'ok' for r in bad))


# --------------------------------------------------------- classification

class ClassificationTests(CensusCase):
    """Acceptance 1 and 6: the action and ownership scope the shipped
    instrument cannot see. `orgtree_work` arrives in the architect's data as
    176 rows under ONE label mixing a plain `get` with a spanning `assign`;
    these prove the two are now different records."""

    def test_two_actions_of_one_tool_are_different_operations(self):
        slug = 'census-action-org'
        _make_org(slug)
        for action in ('list', 'get'):
            self.client.post('/api/agent', headers=OPERATOR, json={
                'org': slug, 'node': 'user', 'tool': 'orgtree_work',
                'args': {'action': action, 'slug': 'anything-at-all'}})
        body = self.read()
        self.assertWindowDidWork(body, least=2)
        work = [r for r in body['records'] if r.get('tool') == 'orgtree_work']
        self.assertTrue(work, 'no orgtree_work record at all')
        actions = {r.get('action') for r in work}
        self.assertTrue({'list', 'get'} & actions,
                        f'the action was not recorded; saw {actions}')
        self.assertTrue(all(r['op'].startswith('tool:orgtree_work:')
                            for r in work if r.get('action')),
                        'the logical operation key must carry the action')

    def test_the_status_value_decides_locality(self):
        """`working`/`idle` write only the caller's own node; `done`/`blocked`
        also post to the parent. The architect could not make this split (71
        rows, 15.1% of the timed sample) because the value was absent."""
        from orgtree import census_classes as cc
        self.assertEqual(cc.classify_tool('orgtree_status', 'working'),
                         ('write', 'self', 'table'))
        self.assertEqual(cc.classify_tool('orgtree_status', 'done'),
                         ('write', 'other_agent', 'table'))
        self.assertEqual(cc.classify_tool('orgtree_status', 'blocked'),
                         ('write', 'other_agent', 'table'))

    def test_mail_is_never_self_however_local_each_commit_is(self):
        """⚠ The architect's constraint, enforced rather than promised:
        ordinary A→B mail touches two agent stores sequentially, so it is
        `other_agent` even though no single transaction spans both. A `self`
        here would be the exact error that ruling exists to prevent."""
        from orgtree import census_classes as cc
        for tool in ('orgtree_message', 'orgtree_send_notice',
                     'orgtree_submit_report', 'orgtree_send_file',
                     'orgtree_send_file_once'):
            rw, scope, _src = cc.classify_tool(tool, None)
            self.assertEqual(rw, 'write', tool)
            self.assertNotEqual(scope, 'self',
                                f'{tool} claims self-only locality; sender and '
                                f'receiver are two stores')

    def test_only_the_verified_verbs_may_claim_self(self):
        """A closed list, so a future table edit that quietly promotes a verb
        to `self` fails here instead of flattering the architecture decision
        this census feeds."""
        from orgtree import census_classes as cc
        claimed = {tool for (tool, _action), (_rw, scope) in cc.TABLE.items()
                   if scope == 'self'}
        self.assertEqual(claimed, {
            'orgtree_status',          # working/idle only; done/blocked is other_agent
            'orgtree_self_restart',
            'orgtree_prime_restart',
            'orgtree_self_relaunch',   # the desktop-managed spelling of the two above
            'orgtree_prime_relaunch',
            'orgtree_restart_wake',
            'orgtree_watchdog',
            'orgtree_capabilities',    # a READ of the caller's own capability set
        }, 'a verb gained or lost a self-only claim; every such claim needs a '
           'source-verified reason in census_classes.TABLE')

    def test_an_uncatalogued_action_is_counted_not_guessed(self):
        slug = 'census-bogus-action-org'
        _make_org(slug)
        self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': 'user', 'tool': 'orgtree_work',
            'args': {'action': 'definitely-not-a-catalogued-action'}})
        body = self.read()
        self.assertWindowDidWork(body)
        work = [r for r in body['records'] if r.get('tool') == 'orgtree_work']
        self.assertTrue(work)
        self.assertTrue(all('action' not in r for r in work),
                        'an uncatalogued action reached a record')
        self.assertGreaterEqual(body['counters']['unclassified_action'], 1,
                                'the gap was dropped but never counted, which '
                                'is indistinguishable from there being no gap')

    def test_every_catalogued_tool_has_a_classification(self):
        """Exhaustiveness, asserted against the catalogue itself rather than
        against a list somebody remembered to update — the internal wrapper
        below is the only intended exception."""
        from orgtree import census_classes as cc
        unclassified = sorted(
            t for t in cc.tool_names()
            if cc.classify_tool(t, None)[2] == 'unknown')
        self.assertEqual(unclassified, ['orgtree_op_call'],
                         'a catalogued tool has no (rw, scope) entry; '
                         'orgtree_op_call is the one deliberate exception '
                         'because it is unwrapped to its inner verb first')

    def test_every_verb_an_agent_is_actually_offered_is_classified(self):
        """⚠ N16 — THE HOLE `test_every_catalogued_tool_has_a_classification`
        CANNOT SEE, and it was a real one.

        `mcptool.TOOLS` is not the catalogue an agent is offered. On a
        desktop-managed install `available_tools()` runs
        `_desktop_relaunch_catalogue`, which SUBSTITUTES
        `orgtree_self_relaunch`/`orgtree_prime_relaunch` for
        `orgtree_self_restart`/`orgtree_prime_restart`, and `api` dispatches
        the relaunch names for real. Schema 1 built its vocabulary from
        `TOOLS` alone, so on the profile this organization actually runs both
        verbs were `tool_unknown` → `unclassified_tool`, permanently, and the
        exhaustiveness test above passed because it iterated the same
        incomplete set.

        So this asserts BOTH deployment policies, and it asserts the
        substituted names specifically rather than trusting a total.
        """
        from orgtree import census_classes as cc, mcptool
        previous = os.environ.get('ORGTREE_DESKTOP_MANAGED')

        def restore():
            if previous is None:
                os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
            else:
                os.environ['ORGTREE_DESKTOP_MANAGED'] = previous
        self.addCleanup(restore)

        offered: dict[str, set[str]] = {}
        for policy, value in (('standard', None), ('desktop-managed', '1')):
            if value is None:
                os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)
            else:
                os.environ['ORGTREE_DESKTOP_MANAGED'] = value
            offered[policy] = {str(t.get('name') or '')
                               for t in mcptool.available_tools()}

        # THE CONTROL DID WORK: the two policies really do differ, and they
        # differ in exactly the verbs this test exists for. Without this the
        # loop below could pass by comparing one catalogue with itself.
        self.assertIn('orgtree_self_relaunch', offered['desktop-managed'],
                      'the desktop-managed catalogue did not substitute the '
                      'relaunch cards, so this control compared one catalogue '
                      'against itself and proves nothing')
        self.assertNotIn('orgtree_self_relaunch', offered['standard'])

        for policy, names in offered.items():
            for name in sorted(names):
                self.assertIn(name, cc.tool_names(),
                              f'{name} is offered to agents under the {policy} '
                              f'policy but is outside the census vocabulary, so '
                              f'every call to it is unclassified_tool')
                self.assertNotEqual(
                    cc.classify_tool(name, None)[2], 'unknown',
                    f'{name} is offered under the {policy} policy with no '
                    f'(rw, scope) entry')


# -------------------------------------------------------------- privacy

class PrivacyNegativeControlTests(CensusCase):
    """Acceptance 2 and 6. ⚠ The control proves its own sentinels REACHED the
    request before it asserts their absence — otherwise "no sentinel in the
    census" would be satisfied by a request that never happened."""

    SENTINELS = {
        'slug': 'census-secret-org-slug-zzq',
        'node': 'census-secret-node-id-zzq',
        'body': 'census-secret-message-body-zzq',
        'token': 'census-secret-credential-zzq',
        'query': 'census-secret-query-value-zzq',
    }

    def test_no_sentinel_survives_into_the_census(self):
        slug = self.SENTINELS['slug']
        _make_org(slug)
        sent = self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': 'user', 'tool': 'orgtree_message',
            'args': {'to': self.SENTINELS['node'],
                     'body': self.SENTINELS['body'],
                     'kind': 'message'}})
        got = self.client.get(f'/api/orgs/{slug}',
                              headers={**OPERATOR,
                                       'X-Census-Probe': self.SENTINELS['token']},
                              params={'probe': self.SENTINELS['query']})
        # THE CONTROL DID WORK: both requests reached the app and were seen.
        self.assertIn(sent.status_code, range(200, 500), sent.text)
        self.assertIn(got.status_code, range(200, 500), got.text)
        body = self.read()
        self.assertWindowDidWork(body, least=2)
        self.assertTrue(any('{slug}' in r['route'] for r in body['records']),
                        'the sentinel-bearing GET produced no record, so its '
                        'absence from the census proves nothing')

        blob = json.dumps(body)
        for name, value in self.SENTINELS.items():
            self.assertNotIn(value, blob,
                             f'the {name} sentinel reached the census payload')

    def test_route_templates_never_carry_a_path(self):
        slug = 'census-template-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        body = self.read()
        self.assertWindowDidWork(body)
        scoped = [r for r in body['records'] if 'orgs' in r['route']
                  and r['route'] != '<unmatched>']
        self.assertTrue(scoped)
        for row in scoped:
            self.assertIn('{', row['route'], f'not a template: {row["route"]!r}')
            self.assertNotIn(slug, row['route'])

    def test_an_arbitrary_method_token_never_reaches_a_record(self):
        """⚠ N03 — THE FIFTH KIND OF VALUE, closed.

        Schema 1 recorded `scope["method"]` RAW. An ASGI server admits any
        RFC 9110 token as a method, so a caller that can reach the port could
        place an arbitrary ASCII string into an AGENT-READABLE sink — in a
        module whose entire privacy argument is that there are exactly four
        kinds of value and no fifth. The token is now mapped to the closed
        `METHOD` set, and a token outside it becomes `other` and is COUNTED.
        """
        from orgtree import census
        sentinel = 'ZZQ-CENSUS-SMUGGLED-METHOD-TOKEN'
        census.observe(sentinel, '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, {})
        body = census.snapshot()
        # THE CONTROL DID WORK: the call really did produce a record.
        self.assertEqual(body['counters']['recorded'], 1,
                         'the smuggling attempt produced no record, so its '
                         'absence from the payload proves nothing')
        self.assertNotIn(sentinel, json.dumps(body))
        row = body['records'][0]
        self.assertEqual(row['method'], 'other')
        self.assertIn(row['method'], body['vocabulary']['method'])
        self.assertGreaterEqual(body['counters']['unclassified_method'], 1,
                                'the token was dropped but never counted, which '
                                'is indistinguishable from there being no gap')
        # THE POSITIVE HALF: a real method still survives, so the assertion
        # above is not satisfied by a function that maps everything to `other`.
        census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, {})
        self.assertEqual(census.snapshot()['records'][-1]['method'], 'GET')

    def test_a_handler_cannot_smuggle_a_field_or_a_non_finite_number(self):
        """The allowlist is a MECHANISM. A handler that writes an arbitrary
        name, or a NaN under an allowed name, must not reach a record — and
        `float('nan')` is a perfectly valid Python float that `json.dumps`
        would happily emit as the non-standard literal `NaN`."""
        from orgtree import census
        smuggled = {
            'org_load_ms': float('nan'),          # allowed NAME, illegal VALUE
            'org_save_ms': float('inf'),
            'mail_id': 'census-smuggled-mail-id-zzq',     # illegal name, text
            'secret_token_ms': 12.5,                      # illegal name, number
            'lock_wait_ms': True,                         # bool is not a number
            'tree_ms': 7.5,                               # legal, must survive
        }
        record, _bumps = census._build(
            'GET', '/api/orgs/{slug}', 200, 20.0, 21.0, 100, 1, smuggled, None)
        blob = json.dumps(record)
        self.assertNotIn('census-smuggled-mail-id-zzq', blob)
        self.assertNotIn('mail_id', record)
        self.assertNotIn('secret_token_ms', record)
        self.assertNotIn('org_load_ms', record, 'a NaN reached the record')
        self.assertNotIn('org_save_ms', record, 'an Infinity reached the record')
        self.assertNotIn('lock_wait_ms', record, 'a bool was accepted as a number')
        self.assertEqual(record['tree_ms'], 7.5,
                         'the positive half failed: a legal field was dropped, '
                         'so the negatives above prove nothing')

    def test_the_five_middleware_numerics_are_validated_too(self):
        """⚠ N03, SECOND HALF. Schema 1 ran the PROFILE-derived numbers through
        `_number` and converted the five the middleware passes directly with a
        bare `int()`/`float()` — so the guard that exists to reject `bool`,
        `NaN` and `±Infinity` was applied to one half of the record and not
        the other. A `null` here means NOT MEASURABLE and is never a zero."""
        from orgtree import census
        record, _ = census._build('GET', '/api/orgs/{slug}', float('nan'),
                                  20.0, float('inf'), float('nan'), True, {}, None)
        blob = json.dumps(record)
        self.assertNotIn('NaN', blob, 'a non-standard JSON literal was emitted')
        self.assertNotIn('Infinity', blob)
        self.assertIsNone(record['total_ms'])
        self.assertIsNone(record['bytes'])
        self.assertIsNone(record['inflight'], 'a bool was accepted as a count')
        self.assertEqual(record['status'], 0)
        self.assertEqual(record['outcome'], 'unknown')
        # THE POSITIVE HALF: real values still survive this path.
        good, _ = census._build('GET', '/api/orgs/{slug}', 200, 20.0, 21.0,
                                100, 3, {}, None)
        self.assertEqual((good['total_ms'], good['bytes'], good['inflight'],
                          good['status']), (21.0, 100, 3, 200))

    def test_a_missing_response_start_is_null_and_never_a_latency(self):
        """⚠ D04. `api.AccessRecord.__call__` initialises `handler_ms = -1.0`
        and assigns it only on `http.response.start`, so a client disconnect
        leaves the sentinel in place. Schema 1 recorded `-1.0` as a duration
        and subtracted the stage wall from it, so any percentile over the ring
        silently included negative values — the slow-only sink escapes that
        only because it filters `handler_ms >= 500`."""
        from orgtree import census
        record, bumps = census._build('GET', '/api/orgs/{slug}', 0, -1.0, 12.0,
                                      0, 1, {'tree_ms': 3.0}, None)
        self.assertIsNone(record['handler_ms'])
        self.assertTrue(record['no_response_start'])
        self.assertNotIn('unattributed_ms', record,
                         'a subtraction from an unknown duration was published '
                         'as a number')
        self.assertIn('no_response_start', bumps)
        # THE POSITIVE HALF: a real response start still produces both fields.
        good, good_bumps = census._build('GET', '/api/orgs/{slug}', 200, 10.0,
                                         12.0, 0, 1, {'tree_ms': 3.0}, None)
        self.assertEqual(good['handler_ms'], 10.0)
        self.assertEqual(good['unattributed_ms'], 7.0)
        self.assertNotIn('no_response_start', good)
        self.assertNotIn('no_response_start', good_bumps)

    def test_the_declared_scope_vocabulary_is_closed(self):
        """`declare` is the one place a handler writes a non-numeric census
        value. A word outside the published enum must be ignored, not stored."""
        from orgtree import census
        token = census.bind()
        try:
            census.declare(rw='not-a-real-rw', scope='census-invented-scope-zzq')
            record, _ = census._build('GET', '/x', 200, 1.0, 1.0, 0, 1, {},
                                      census._CALL.get())
        finally:
            census.unbind(token)
        self.assertNotIn('census-invented-scope-zzq', json.dumps(record))
        self.assertIn(record['scope'], census_scope_values())
        self.assertIn(record['rw'], census_rw_values())

    def test_every_published_value_belongs_to_a_published_vocabulary(self):
        """Exhaustive over what actually ran: each record's enum fields must
        be members of the vocabulary the snapshot itself publishes."""
        slug = 'census-vocab-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': 'user', 'tool': 'orgtree_chart', 'args': {}})
        body = self.read()
        self.assertWindowDidWork(body, least=2)
        vocab = body['vocabulary']
        for row in body['records']:
            for field in ('rw', 'scope', 'scope_src', 'outcome', 'method'):
                self.assertIn(row[field], vocab[field],
                              f'{field}={row[field]!r} is outside the published '
                              f'vocabulary in record {row["op"]!r}')


def census_scope_values():
    from orgtree import census_classes as cc
    return cc.SCOPE


def census_rw_values():
    from orgtree import census_classes as cc
    return cc.RW


# ------------------------------------------------------- loss accounting

class LossAccountingTests(CensusCase):
    """Acceptance 3. ⚠ The control asserts the ring ACTUALLY OVERFLOWED before
    it checks the accounting — an overflow test that never overflows is the
    'surprising pass' this team keeps paying for."""

    def test_a_deliberate_overflow_is_counted_exactly_and_twice(self):
        from orgtree import census
        census.reset(capacity=64)
        self.addCleanup(census.reset)
        for _ in range(200):
            census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, {})
        body = census.snapshot()

        # THE CONTROL DID WORK: the ring is full and more was written than it holds.
        self.assertEqual(body['capacity'], 64)
        self.assertEqual(len(body['records']), 64,
                         'the ring never filled, so nothing was evicted and '
                         'the accounting below is untested')
        self.assertEqual(body['counters']['recorded'], 200)
        self.assertGreater(body['counters']['evicted'], 0)

        # TWO INDEPENDENT DERIVATIONS THAT MUST AGREE.
        self.assertEqual(body['counters']['evicted'], 200 - 64)
        self.assertEqual(body['counters']['evicted'], body['evicted_derived'],
                         'the maintained counter and the sequence-derived count '
                         'disagree; one of them is lying about retention')
        self.assertEqual(body['counters']['recorded'],
                         len(body['records']) + body['counters']['evicted'])

    def test_a_limit_is_not_reported_as_an_eviction(self):
        """Serving fewer rows than the ring holds is not data loss, and
        conflating the two is exactly the off-by-one the cross-check exists
        to catch."""
        from orgtree import census
        census.reset(capacity=64)
        self.addCleanup(census.reset)
        for _ in range(100):
            census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, {})
        full, limited = census.snapshot(), census.snapshot(limit=10)
        self.assertEqual(len(limited['records']), 10)
        self.assertEqual(limited['truncated_by_limit'], 54)
        self.assertEqual(limited['evicted_derived'], full['evicted_derived'],
                         'a serving limit was counted as retention loss')
        self.assertEqual(limited['counters']['evicted'], 36)

    def test_a_record_that_cannot_be_built_is_counted_as_rejected(self):
        """`rejected` must be reachable. A counter that can never advance is
        indistinguishable from a counter that is never checked."""
        from orgtree import census
        census.reset()
        self.addCleanup(census.reset)
        broken = _ExplodingProfile()
        census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, broken)
        body = census.snapshot()
        self.assertEqual(body['counters']['rejected'], 1,
                         'a record that could not be built was swallowed '
                         'silently instead of counted')
        self.assertEqual(body['counters']['observed'], 1,
                         'the attempt must still count toward the denominator')
        self.assertEqual(body['counters']['recorded'], 0)

    def test_a_record_built_before_a_reset_never_lands_in_the_fresh_window(self):
        """⚠ N06 — THE RESET RACE, which was reachable and is the one defect
        that could make this module's headline claim false.

        `observe` counts `observed` in one critical section and appends in
        another. A `reset()` landing between the two used to append a record
        measured against the OLD window origin into the NEW window: its `t_ms`
        could exceed the window's own `window_ms`, it consumed `seq 1` of a
        window it did not belong to, and its `observed` had already been
        zeroed — so `recorded > observed` was reachable INSIDE ONE WINDOW, at
        exactly the boundary an operator uses to take a clean before/after
        measurement.

        The race is made deterministic rather than hoped for: the profile
        mapping resets the window at the instant `observe` freezes it, which
        is precisely the gap between the two critical sections.
        """
        from orgtree import census
        census.reset()
        self.addCleanup(census.reset)
        resets: list[int] = []

        class _ResettingProfile:
            """Its copy is taken between the two critical sections, so this is
            the exact instant the race needs."""

            def keys(self):
                if not resets:
                    resets.append(1)
                    census.reset()
                return ('tree_ms',)

            def __getitem__(self, key):
                return 1.0

        census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1,
                       _ResettingProfile())
        body = census.snapshot()

        # THE CONTROL DID WORK: the reset really did fire mid-observe.
        self.assertEqual(resets, [1], 'the reset never ran, so no race was '
                                      'exercised and the assertions below are '
                                      'satisfied by nothing happening')
        self.assertEqual(body['counters']['dropped_stale_window'], 1,
                         'the stale record was not dropped, or was dropped '
                         'without being counted')
        self.assertEqual(body['counters']['recorded'], 0)
        self.assertEqual(body['records'], [],
                         'a record measured against the previous window origin '
                         'landed in the fresh one')
        self.assertLessEqual(body['counters']['recorded'],
                             body['counters']['observed'],
                             'recorded exceeded observed inside one window')

    def test_a_record_built_after_capture_is_disabled_is_dropped_and_counted(self):
        """The same gap, the other switch. `_ENABLED` was read only in the
        first critical section, so a record could be appended after capture
        was turned off."""
        from orgtree import census
        census.reset()
        self.addCleanup(census.reset)
        flips: list[int] = []

        class _DisablingProfile:
            def keys(self):
                if not flips:
                    flips.append(1)
                    census.set_enabled(False)
                return ('tree_ms',)

            def __getitem__(self, key):
                return 1.0

        census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1,
                       _DisablingProfile())
        body = census.snapshot()
        self.assertEqual(flips, [1], 'capture was never disabled mid-observe')
        self.assertEqual(body['counters']['dropped_capture_off'], 1)
        self.assertEqual(body['counters']['recorded'], 0)
        self.assertEqual(body['records'], [])

    def test_concurrent_writers_lose_nothing(self):
        """The counters and the ring must stay consistent under the
        concurrency the real middleware has: handlers run in a threadpool."""
        from orgtree import census
        census.reset(capacity=4096)
        self.addCleanup(census.reset)
        per, workers = 250, 8

        def hammer():
            for _ in range(per):
                census.observe('POST', '/api/agent', 200, 1.0, 1.1, 10, 1, {})

        threads = [threading.Thread(target=hammer) for _ in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        body = census.snapshot()
        self.assertEqual(body['counters']['observed'], per * workers)
        self.assertEqual(body['counters']['recorded'], per * workers,
                         'records were lost under concurrency')
        self.assertEqual(body['counters']['rejected'], 0)
        seqs = [r['seq'] for r in body['records']]
        self.assertEqual(seqs, sorted(seqs), 'sequence numbers interleaved')
        self.assertEqual(len(set(seqs)), len(seqs), 'a sequence number was reused')


class _ExplodingProfile:
    """A profile mapping whose COPY raises — the only way to exercise
    `observe`'s own failure path without editing the module under test.

    ⚠ IT BREAKS ON `keys`, NOT ON `get`, AND THAT IS A SCHEMA 2 CHANGE. Schema
    1 read the live profile dict field by field inside `_build`, so a `get`
    that raised was on the path. Schema 2 FREEZES the profile first
    (`census._freeze` → `profiling.snapshot` → `dict(profile)`), and `dict()`
    of a dict subclass never calls the subclass's `get` — the old fixture
    would have exercised the happy path and reported a clean pass for a
    rejection that never happened. A non-dict mapping whose `keys` raises is
    on the copy path by construction, whatever CPython does with dict
    subclasses.
    """

    def keys(self):
        raise RuntimeError('deliberate: exercising the census rejection path')

    def __getitem__(self, key):
        raise RuntimeError('deliberate: exercising the census rejection path')


# ------------------------------------------- the frozen profile boundary

class FrozenProfileTests(CensusCase):
    """⚠ N17. One profile dict CAN have two writers."""

    def test_a_published_record_is_built_from_a_frozen_copy(self):
        """`toolwait.invoke` hands `profiling.current()` to a daemon thread
        which rebinds THE SAME dict and keeps writing to it after the request
        has yielded. `_access_emit` has taken a `profiling.snapshot` copy for
        exactly that reason since the mutex was added — its own comment names
        the `RuntimeError: dictionary changed size during iteration` that
        arrives inside an `except Exception: pass` and makes a record vanish
        without a trace. Schema 1's census read that live dict with no mutex
        at all, so a published record could be assembled from two instants.

        Both halves are asserted: the freeze goes through the function that
        HOLDS `profiling`'s mutex, and a later write by the worker cannot
        change a record already published.
        """
        from orgtree import census, profiling
        census.reset()
        self.addCleanup(census.reset)
        seen: list[object] = []
        real = profiling.snapshot

        def spy(profile):
            seen.append(profile)
            return real(profile)

        profiling.snapshot = spy
        self.addCleanup(setattr, profiling, 'snapshot', real)
        live = {'tree_ms': 7.5}
        census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, live)
        profiling.snapshot = real

        # THE MECHANISM: the copy was taken by the mutex holder, not by an
        # ad-hoc `dict()` in the census.
        self.assertEqual(seen, [live],
                         'the census did not freeze the profile through '
                         'profiling.snapshot, so nothing took profiling\'s mutex')
        body = census.snapshot()
        self.assertEqual(body['counters']['recorded'], 1,
                         'no record was written, so the assertion below is '
                         'satisfied by an empty ring')
        self.assertEqual(body['records'][0]['tree_ms'], 7.5)

        # THE EFFECT: the worker thread keeps writing; the published record
        # does not move.
        live['tree_ms'] = 999.0
        live['org_save_ms'] = 42.0
        after = census.snapshot()['records'][0]
        self.assertEqual(after['tree_ms'], 7.5,
                         'a worker still writing the profile changed a record '
                         'that had already been published')
        self.assertNotIn('org_save_ms', after)


# --------------------------------------------- attempts vs operations

class ManagedYieldTests(CensusCase):
    """⚠ N07. For the eight `mcptool.MANAGED_WAIT_TOOLS`, HTTP 200 is not the
    operation's outcome."""

    def test_a_yielded_managed_call_is_recorded_non_terminal(self):
        """`toolwait.invoke` waits ten seconds and then answers HTTP 200 with
        `{"state": "running"}` while a daemon thread carries on and delivers
        the real result — including a REFUSAL — later as durable mail. Schema
        1 recorded that as `outcome: "ok"`: a completion that had not
        happened, for every hire, retire, staff, dissolve, cheap-compact,
        watchdog and continue-on that ran long.

        The yield is forced rather than waited for — ten real seconds per
        control is not a test — but everything after the patched boundary is
        the production path: the real route, the real middleware, the real
        record.
        """
        from orgtree import census, toolwait
        slug = 'census-managed-yield-org'
        _make_org(slug)
        node = _hire(slug)
        real = toolwait.invoke

        def yielding(body, caller, run, **kw):
            return {'state': 'running', 'operation_id': 'zzq-census-operation-id',
                    'status': 'The original tool operation is still running.'}

        toolwait.invoke = yielding
        self.addCleanup(setattr, toolwait, 'invoke', real)
        got = self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': node, 'tool': 'orgtree_watchdog',
            'args': {'action': 'list'}})
        toolwait.invoke = real

        # THE CONTROL DID WORK: the call really did take the managed path and
        # really did come back 200 with a running state.
        self.assertEqual(got.status_code, 200, got.text)
        self.assertEqual(got.json().get('state'), 'running',
                         'the managed branch was not taken, so no yielded '
                         'attempt exists to classify')
        body = self.read()
        self.assertWindowDidWork(body)
        rows = [r for r in body['records'] if r.get('tool') == 'orgtree_watchdog']
        self.assertTrue(rows, 'the yielded call produced no census record')
        for row in rows:
            self.assertFalse(row['terminal'],
                             'a yielded managed operation was recorded as '
                             'terminal: ' + json.dumps(row))
            self.assertNotEqual(row['outcome'], 'ok',
                                'HTTP 200 was reported as the operation outcome '
                                'for work that had not completed')
            self.assertEqual(row['nonterminal_reason'], 'managed_yield')
            self.assertEqual(row['status'], 200,
                             'the TRANSPORT status is a true fact and must '
                             'still be recorded')
        self.assertGreaterEqual(body['counters']['nonterminal'], 1)
        # ⚠ THE OPERATION ID IS AN IDENTIFIER AND DOES NOT BELONG HERE. Causal
        # linkage is a later stage; smuggling the id in as a "join key" would
        # put a per-operation identifier into an agent-readable sink.
        self.assertNotIn('zzq-census-operation-id', json.dumps(body))

    def test_a_completed_call_is_still_terminal(self):
        """THE POSITIVE HALF of the control above: without this, marking every
        record non-terminal would pass."""
        slug = 'census-managed-done-org'
        _make_org(slug)
        node = _hire(slug)
        self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': node, 'tool': 'orgtree_chart', 'args': {}})
        body = self.read()
        self.assertWindowDidWork(body)
        rows = [r for r in body['records'] if r.get('tool') == 'orgtree_chart']
        self.assertTrue(rows)
        self.assertTrue(all(r['terminal'] for r in rows))
        self.assertTrue(all('nonterminal_reason' not in r for r in rows))


# --------------------------------------------- the instrument's own work

class SelfObservationTests(CensusCase):
    """⚠ N18. A reader polling the census must not inflate the denominator it
    is reading, and diagnostic work must be identifiable as diagnostic."""

    def test_the_census_does_not_record_its_own_reads(self):
        """`api._access_emit`'s bounded sink excludes its own route in so many
        words ("not this route itself — a caller polling
        `/api/desktop/profile-timing`"). Schema 1's census had no such
        exclusion: a reader polling it recorded its own polls as ordinary
        operations, `rw: read`, `scope: none`, and every poll grew the
        denominator of the answer."""
        slug = 'census-self-read-org'
        _make_org(slug)
        node = _hire(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)   # one real request
        for _ in range(3):
            self.client.get('/api/diagnostics/operation-census', headers=OPERATOR)
        self.client.post('/api/agent', headers=OPERATOR, json={  # the agent door
            'org': slug, 'node': node, 'tool': 'orgtree_operation_census',
            'args': {'n': 5}})
        body = self.read()
        self.assertWindowDidWork(body)

        # THE EXCLUSION IS VISIBLE, NOT SILENT.
        self.assertGreaterEqual(body['counters']['skipped_self'], 4,
                                'the census reads were not counted as skipped, '
                                'so an absent record is indistinguishable from '
                                'a request that never happened')
        for row in body['records']:
            self.assertFalse(
                row['route'] == '/api/diagnostics/operation-census'
                and row['method'] in ('GET', 'HEAD', 'OPTIONS'),
                'the census recorded its own read: ' + json.dumps(row))
            self.assertNotEqual(row.get('tool'), 'orgtree_operation_census',
                                'the agent read door recorded itself')
        # THE POSITIVE HALF: real work in the same window still landed.
        self.assertTrue(any('{slug}' in r['route'] for r in body['records']),
                        'nothing at all was recorded, so the exclusion above '
                        'proves nothing')

    def test_diagnostic_work_is_identified_as_diagnostic(self):
        """The v6 contract asks for diagnostic writes to be identified once as
        diagnostic work rather than counted as the organization's."""
        slug = 'census-diagnostic-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        self.client.get('/api/diagnostics/slow-requests', headers=OPERATOR)
        body = self.read()
        self.assertWindowDidWork(body, least=2)
        diagnostics = [r for r in body['records']
                       if r['route'] == '/api/diagnostics/slow-requests']
        self.assertTrue(diagnostics, 'the diagnostics read produced no record')
        self.assertTrue(all(r.get('diagnostic') for r in diagnostics))
        # THE POSITIVE HALF: ordinary work is NOT marked diagnostic, so the
        # assertion above is not satisfied by a flag that is always true.
        ordinary = [r for r in body['records'] if '{slug}' in r['route']]
        self.assertTrue(ordinary)
        self.assertTrue(all('diagnostic' not in r for r in ordinary))


# ------------------------------------------------- provenance disclosure

class ProvenanceDisclosureTests(CensusCase):
    """⚠ N15. The payload must say what its `scope` values are and are not."""

    def test_the_payload_publishes_its_provenance_and_claims_no_contact(self):
        """`scope_src` exists so a reader can separate a source-based
        candidate classification from measured behaviour. Publishing the
        SPLIT, the declared coverage and the explicit "no storage contact is
        measured" in the payload is what stops somebody dividing two numbers
        out of `records` and calling the result a locality proportion — a
        caveat that lives only in a document is one the analysis will not
        have."""
        slug = 'census-provenance-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': 'user', 'tool': 'orgtree_chart', 'args': {}})
        body = self.read()
        self.assertWindowDidWork(body, least=2)
        prov = body['provenance']
        # ⚠ WAS `False` AT SCHEMA 2. P02-A3 observes contacts on the primary
        # SQLite store's connections and nowhere else, and the payload says
        # exactly that rather than a bare boolean either way.
        self.assertEqual(prov['measures_storage_contacts'],
                         'primary_and_listed_sidecar_sqlite_stores')
        self.assertEqual(prov['unit'], 'attempt')
        self.assertEqual(sum(prov['scope_src_counts'].values()), body['served'],
                         'the provenance split does not account for every '
                         'served row, so it cannot be used to check a claim')
        # ⚠ `declare()` HAS NO PRODUCT CALLER AT THIS SCHEMA, so the honest
        # coverage is zero and the payload says so rather than letting a
        # reader assume the table was verified by a handler.
        self.assertEqual(prov['declared_coverage'], 0.0)
        self.assertEqual(prov['scope_src_counts']['declared'], 0)
        self.assertTrue(all(r['scope_src'] != 'declared' for r in body['records']))
        self.assertIn('never an observed storage contact', prov['note'])
        self.assertIn('proves no locality proportion', prov['note'])

    def test_declared_coverage_is_a_real_measurement_of_the_wiring(self):
        """THE POSITIVE HALF: a zero that can never be anything else is not a
        measurement. With `declare()` actually called, the coverage moves — so
        the 0.0 above reports the wiring rather than a constant."""
        from orgtree import census
        census.reset()
        self.addCleanup(census.reset)
        token = census.bind()
        try:
            census.declare(rw='read', scope='self')
            census.observe('GET', '/api/orgs/{slug}', 200, 1.0, 1.1, 10, 1, {})
        finally:
            census.unbind(token)
        body = census.snapshot()
        self.assertEqual(body['counters']['recorded'], 1)
        self.assertEqual(body['records'][0]['scope_src'], 'declared')
        self.assertEqual(body['provenance']['declared_coverage'], 1.0)

    def test_the_limits_travel_with_the_numbers(self):
        body = self.read()
        joined = ' '.join(body['limits']).lower()
        for phrase in ('attempt', 'storage contact', 'non-http', 'overhead'):
            self.assertIn(phrase, joined,
                          f'the payload does not state the {phrase!r} limit, so '
                          f'a reader holding only this response does not have it')

    def test_the_process_and_window_identity_are_published(self):
        """`seq` restarts at zero in a new process and at every reset. Without
        an instance stamp and a window generation a reader comparing two
        snapshots cannot tell "less happened" from "different process" or
        "somebody reset the window under me"."""
        from orgtree import census
        first = self.read()
        self.assertTrue(first['instance'])
        self.assertEqual(first['instance'], census.instance())
        before = first['window_generation']
        self.client.post('/api/diagnostics/operation-census/reset',
                         headers=OPERATOR)
        self.assertGreater(self.read()['window_generation'], before,
                           'the window generation did not advance across a '
                           'reset, so a reader cannot detect one')


# ------------------------------------------------- the two permissions

class PermissionSplitTests(CensusCase):
    """Acceptance 4: an authorized agent reads the census with NO desktop
    token, while toggling capture stays operator-only."""

    def test_an_agent_reads_the_census_without_the_desktop_token(self):
        slug = 'census-agent-read-org'
        _make_org(slug)
        node = _hire(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)  # make a record
        got = self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': node, 'tool': 'orgtree_operation_census',
            'args': {'n': 50}})
        self.assertEqual(got.status_code, 200, got.text)
        body = got.json()
        self.assertEqual(body['schema_version'], 4)
        self.assertTrue(body['enabled'])
        self.assertWindowDidWork(body)
        self.assertTrue(body['records'], 'the agent door returned no records')
        # ⚠ THE POSITIVE HALF: identical payload shape to the operator door,
        # so there is no second projection that could drift.
        for key in ('counters', 'vocabulary', 'evicted_derived', 'capacity',
                    'provenance', 'limits', 'instance'):
            self.assertIn(key, body, f'the agent payload is missing {key}')

    def test_the_agent_door_cannot_toggle_capture(self):
        """The narrow grant, proved rather than asserted: capture state is
        read before and after, and the attempt is named back to the caller."""
        from orgtree import census
        slug = 'census-agent-toggle-org'
        _make_org(slug)
        node = _hire(slug)
        self.assertTrue(census.enabled(), 'precondition: capture is on')
        got = self.client.post('/api/agent', headers=OPERATOR, json={
            'org': slug, 'node': node, 'tool': 'orgtree_operation_census',
            'args': {'enabled': False, 'n': 5}})
        self.assertEqual(got.status_code, 200, got.text)
        self.assertTrue(census.enabled(),
                        'an agent turned process-wide capture OFF through the '
                        'read verb')
        self.assertEqual(got.json().get('ignored_arguments'), ['enabled'],
                         'the refused argument was swallowed in silence')

    def test_the_operator_door_can_toggle_and_the_state_is_real(self):
        off = self.client.post('/api/diagnostics/operation-census',
                               headers=OPERATOR, json={'enabled': False})
        self.assertEqual(off.status_code, 200, off.text)
        self.assertFalse(off.json()['enabled'])
        from orgtree import census
        self.assertFalse(census.enabled())
        on = self.client.post('/api/diagnostics/operation-census',
                              headers=OPERATOR, json={'enabled': True})
        self.assertTrue(on.json()['enabled'])
        self.assertTrue(census.enabled())

    def test_a_non_operator_caller_is_refused_the_toggle(self):
        """`_profile_operator_only` refuses a public or bridge-scoped caller.
        Exercised through the dependency directly, because forging that scope
        state through the client would test the gateway, not this gate."""
        from fastapi import HTTPException
        from orgtree import api

        class _Req:
            def __init__(self, state):
                self.scope = {'state': state}

        for denied in ({'public_slug': 'x'}, {'bridge_slug': 'x'}):
            with self.assertRaises(HTTPException) as caught:
                api._profile_operator_only(_Req(denied))
            self.assertEqual(caught.exception.status_code, 403)
        # THE POSITIVE HALF: the operator is NOT refused, so the two cases
        # above are a real gate rather than a function that always raises.
        api._profile_operator_only(_Req({}))

    def test_the_gate_is_actually_wired_onto_every_census_route(self):
        """⚠ THE GAP THE TEST ABOVE LEAVES, closed deliberately. Calling
        `_profile_operator_only` directly proves the FUNCTION refuses a
        non-operator; it proves nothing about whether any route runs it.
        Deleting `dependencies=[Depends(_profile_operator_only)]` from the
        toggle would leave every other test in this file green while handing
        process-wide capture control to any caller — so the wiring is asserted
        against the live route table, not against the source.
        """
        from orgtree import api
        wanted = {
            ('/api/diagnostics/operation-census', 'GET'),
            ('/api/diagnostics/operation-census', 'POST'),
            ('/api/diagnostics/operation-census/reset', 'POST'),
        }
        seen = set()
        # `api.app`, not the module-level `app`: `load_app()` returns the
        # TokenGate-wrapped ASGI callable, which has no route table.
        for route in api.app.routes:
            path, methods = getattr(route, 'path', None), getattr(route, 'methods', None)
            if not path or not methods:
                continue
            for method in methods:
                if (path, method) not in wanted:
                    continue
                seen.add((path, method))
                names = [getattr(d.dependency, '__name__', '')
                         for d in (getattr(route, 'dependencies', None) or [])]
                self.assertIn(api._profile_operator_only.__name__, names,
                              f'{method} {path} has NO operator gate: {names}')
        self.assertEqual(seen, wanted,
                         f'a census route is missing from the app entirely: '
                         f'{sorted(wanted - seen)}')

    def test_an_agent_token_is_refused_at_transport_on_the_operator_route(self):
        """⚠ N04(b) — THE BOUNDARY THE COMMENTS CREDITED TO THE WRONG PLACE.

        `_profile_operator_only` rejects only a caller carrying `public_slug`
        or `bridge_slug`; it is not a desktop-token check. The REAL gate is one
        layer out: `launch.TokenGate` requires the desktop token on every
        request EXCEPT `POST /api/agent` and the node-steer routes, which may
        instead present a live agent token. So an agent credential cannot reach
        the operator census route at all — it is refused 401 at transport,
        before any dependency runs.

        The test above asserts the DEPENDENCY. A change to `TokenGate`'s
        allowlist would break the real boundary with that test still green, so
        this one goes through the gate with a REAL, VALID agent credential and
        proves the same credential works where it is supposed to.
        """
        from orgtree import agentauth, census
        slug = 'census-transport-gate-org'
        _make_org(slug)
        node = _hire(slug)
        previous_key = agentauth._key
        self.addCleanup(setattr, agentauth, '_key', previous_key)
        agentauth.enable()
        token = agentauth.child_env(slug, node)['ORGTREE_AGENT_TOKEN']
        agent_headers = {'X-Orgtree-Agent-Token': token}   # ⚠ no desktop token

        # THE POSITIVE HALF FIRST: this credential is real and the gate lets it
        # through where the allowlist says it may. Without this, the 401 below
        # would be satisfied by an invalid token and prove nothing about the
        # route allowlist.
        allowed = self.client.post('/api/agent', headers=agent_headers, json={
            'org': slug, 'node': node, 'tool': 'orgtree_chart', 'args': {}})
        self.assertEqual(allowed.status_code, 200, allowed.text)

        self.assertTrue(census.enabled(), 'precondition: capture is on')
        for method, path in (('POST', '/api/diagnostics/operation-census'),
                             ('POST', '/api/diagnostics/operation-census/reset'),
                             ('GET', '/api/diagnostics/operation-census')):
            refused = self.client.request(method, path, headers=agent_headers,
                                          json={'enabled': False})
            self.assertEqual(refused.status_code, 401,
                             f'{method} {path} admitted an agent credential: '
                             f'{refused.text}')
        self.assertTrue(census.enabled(),
                        'an agent credential reached the operator toggle')


# -------------------------------------------------------------- disabled

class CaptureDisabledTests(CensusCase):
    """Off by default, and OFF MEANS SILENT — but the denominator keeps
    counting, which is the whole reason `observed` exists."""

    def setUp(self):
        super().setUp()
        from orgtree import census
        census.set_enabled(False)
        census.reset()

    def test_disabled_capture_records_nothing_but_still_counts(self):
        slug = 'census-disabled-org'
        _make_org(slug)
        self.client.get(f'/api/orgs/{slug}', headers=OPERATOR)
        body = self.read()
        self.assertFalse(body['enabled'])
        self.assertEqual(body['records'], [], 'capture is off yet a record '
                                              'was written')
        self.assertEqual(body['counters']['recorded'], 0)
        # ⚠ THE DENOMINATOR SURVIVES THE TOGGLE. Without this, a window with
        # capture off and a window with capture on and nothing happening are
        # the same empty payload, and no honest proportion can be stated.
        self.assertGreaterEqual(body['counters']['observed'], 1,
                                'the disabled path stopped counting requests, '
                                'so an enable/disable boundary loses its '
                                'denominator')
        self.assertEqual(body['counters']['observed'],
                         body['counters']['skipped_disabled'])

    def test_the_default_for_this_process_was_off(self):
        """The fixture deliberately does NOT set ORGTREE_OPERATION_CENSUS, so
        this measures the shipped default rather than a fixture agreeing with
        it."""
        self.assertIsNone(os.environ.get('ORGTREE_OPERATION_CENSUS'))


class TheLockCensusFieldsReachACensusRecord(CensusCase):
    """§ The lock boundary, published.

    `_NUMERIC_FIELDS` reserved names for a lock-boundary stage that had not
    landed when this module was written, and its note said so. The stage has
    landed: `profiling.TimedRLock` writes four of the six and
    `store._InstrumentedDocLock`'s FIFO gate writes the other two. ⚠ One name,
    `lock_queue_ahead_max`, had NO SLOT in `_NUMERIC_FIELDS` at all, so a
    record could not have carried it however carefully it was measured — that
    is the gap this section exists to close and to keep closed.

    Driven through `census.observe` with EXACT values rather than through a
    real request, because a real request's lock numbers are whatever the
    machine happened to do and cannot be asserted to a number. The end-to-end
    path (a real request really filling these) is covered by
    `tests/test_census_lock_boundaries.py`.
    """

    #: Distinct values, so a field that landed under the wrong name shows up
    #: instead of being masked by a shared number.
    LOCK_VALUES = {'lock_wait_ms': 12.5, 'lock_hold_ms': 42.5,
                   'lock_acquires': 3, 'lock_failed': 1, 'lock_contended': 2,
                   'lock_max_depth': 5, 'lock_queue_ahead_max': 4}

    def observe(self, profile, handler_ms=100.0):
        from orgtree import census
        census.observe('POST', '/api/fake/{id}', 200, handler_ms, handler_ms,
                       0, 1, profile=dict(profile))
        body = self.read()
        self.assertWindowDidWork(body)
        return body['records'][-1]

    def test_all_seven_lock_numbers_reach_a_record_with_their_own_values(self):
        row = self.observe(self.LOCK_VALUES)
        for field, value in self.LOCK_VALUES.items():
            self.assertIn(field, row, f'{field} never reached the census: {row}')
            self.assertEqual(row[field], value,
                             f'{field} arrived as {row[field]!r}, not {value!r}')

    def test_the_queue_depth_has_a_slot_of_its_own(self):
        """The one name that was missing. Asserted separately from the group
        so that losing it again fails a test that says what was lost."""
        from orgtree import census
        self.assertIn('lock_queue_ahead_max', census._NUMERIC_FIELDS)
        row = self.observe({'lock_queue_ahead_max': 4})
        self.assertEqual(row['lock_queue_ahead_max'], 4, row)

    def test_none_of_them_decomposes_handler_time(self):
        from orgtree import census
        for field in self.LOCK_VALUES:
            self.assertNotIn(field, census._WALL_STAGE_FIELDS,
                             f'{field} must never enter the subtraction')
        stages = {'org_load_ms': 10.0, 'mutate_ms': 20.0}
        without = self.observe(stages)
        with_lock = self.observe({**stages, **self.LOCK_VALUES})
        self.assertEqual(without['unattributed_ms'], 70.0,
                         f'the control itself is wrong: {without}')
        self.assertEqual(with_lock['unattributed_ms'], without['unattributed_ms'],
                         'SUPPLYING THE LOCK CENSUS MUST NOT MOVE THE '
                         f'DECOMPOSITION: {with_lock} vs {without}')

    def test_a_hold_spanning_the_whole_handler_leaves_it_positive(self):
        """`lock_hold_ms` is the trap: it IS milliseconds, and it spans
        `mutate_ms` plus the document IO inside the lock. Subtracting it as a
        stage would drive `unattributed_ms` negative here."""
        row = self.observe({'org_load_ms': 10.0, 'mutate_ms': 20.0,
                            'lock_hold_ms': 95.0})
        self.assertEqual(row['unattributed_ms'], 70.0, row)

    def test_nonfinite_wrongly_typed_and_unlisted_values_are_all_refused(self):
        row = self.observe({'lock_acquires': float('nan'),
                            'lock_failed': float('inf'),
                            'lock_contended': float('-inf'),
                            'lock_queue_ahead_max': 'four',
                            'lock_max_depth': True,
                            'lock_hold_ms': None,
                            # shaped like one of the six, named by nobody
                            'lock_secret_ms': 5.0,
                            'org_load_ms': 10.0})
        for field in self.LOCK_VALUES:
            self.assertNotIn(field, row,
                             f'a non-finite or wrongly typed {field} must not '
                             f'reach a census record: {row}')
        self.assertNotIn('lock_secret_ms', row,
                         f'an unlisted name must not ride in on the prefix: {row}')
        self.assertEqual(row.get('org_load_ms'), 10.0,
                         'the good field in the same dict must still pass')

    def test_an_absent_lock_number_is_simply_absent(self):
        """⚠ THE DISCLOSURE THAT MATTERS. Capture is off by default, so most
        records carry none of these. Absence means NOT MEASURED — it must
        never be published as a zero, which a reader would take for "no
        contention"."""
        row = self.observe({'org_load_ms': 10.0})
        for field in self.LOCK_VALUES:
            self.assertNotIn(field, row,
                             f'{field} must be absent, not zero: {row}')


if __name__ == '__main__':
    unittest.main()
