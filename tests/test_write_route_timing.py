"""the-shipped-timing-endpoint-is-blind-to-every-wr: the write routes are now
attributable through `GET /api/desktop/profile-timing`.

WHAT THE INSTRUMENT COULD NOT DO. `ORGTREE_PROFILE_TIMING` + the sink existed
so an operator could answer "which endpoint is slow" without attaching a
profiler. It produced stage records for two read routes and, later,
`history_page` — and for no write at all, because no write handler ever put
anything in its profile dict. So a 4.9 s hire was visible as a slow request
and nothing said whether it had waited for `DOC_LOCK`, parsed the document,
done its work, or written the document back. Those are four different bugs.

WHAT IS PINNED HERE, and why each case is shaped the way it is:

  §1  capture is still opt-in: a real write with it OFF records nothing.
  §2  every operation the ticket names — answering a question, mail send,
      mail read, hire, retire, move, saving agent details — carries all four
      stages, present, finite and non-negative.
  §3  the stages are MEASURED, not decorative. Each one is made slow on
      purpose and only that one is allowed to move. A test that merely asserts
      "the field is there and is a number" passes against an instrument that
      writes 0.0 everywhere, which is the exact failure this ticket exists to
      end — so each stage gets a positive control with a real delay in it.
  §4  the sink's boundary is untouched: route TEMPLATES, allowlisted numeric
      fields, nothing else.
  §5  the read routes still report exactly what they did before — in
      particular `/api/orgs/{slug}` must NOT gain `org_load_ms`, because on
      the JSON backend its snapshot load IS a `load_org` and reporting it
      twice under two names would make the stages sum to double the real IO.
  §6  a MANAGED tool (`orgtree_hire`, `orgtree_retire`, …) reports the work it
      actually did. Those run on a plain `threading.Thread` that starts with
      an empty context; before `toolwait.invoke` carried the profile across,
      a successful retire recorded a 0.03 ms `mutate_ms` and no save at all.
  §7  WHICH agent verb a `/api/agent` record describes. One route serves all
      ~46 verbs, so §2 and §6 above can prove a hire was slow and still leave
      an operator unable to tell a slow hire from a slow retire. The verb is
      the only non-numeric thing a record may carry, and it is the only value
      in one that begins as request text — `AgentCall.tool` is an unvalidated
      `str` off the body and `orgtree_op_call` carries a second one in its
      args — so every case here is really about the closed catalogue that
      stands between those two facts.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-write-timing-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
# DELIBERATELY UNSET: this module starts with capture OFF so §1 is a real
# negative control in the same process that later proves the positive cases,
# rather than a claim about a process nobody ran.
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT',
            'ORGTREE_PROFILE_TIMING'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                             # noqa: E402
app, *_ = load_app()
from orgtree import accounts, agentauth, api, ledger, store    # noqa: E402

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
#: The four stages a write is made of. Named once: every case below asks for
#: this same set, so a stage that stops being populated fails everywhere
#: rather than in whichever test happened to list it.
WRITE_STAGES = ('lock_wait_ms', 'org_load_ms', 'mutate_ms', 'org_save_ms')
_orgs_created: list[str] = []


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    try:
        root.cleanup()
    except OSError:
        pass          # Windows keeps handles on the sqlite files a moment


class WriteTimingBase(unittest.TestCase):
    """One org with a superior, a worker, a spare seat and a parked question."""

    _seq = 0

    def setUp(self) -> None:
        WriteTimingBase._seq += 1
        org = store.create_org(f'write-timing-{WriteTimingBase._seq}')
        self.slug = str(org.d['slug'])
        _orgs_created.append(self.slug)
        # `boss` is top-level, so its `ask_user` really reaches the user
        # rather than being routed up as mail — the answer route needs a card
        # that exists. Its credits are what lets §2 drive a real hire.
        org.hire(ledger.USER, None, 'haiku', 4, 'boss')
        org.hire(ledger.USER, 'boss', 'haiku', 0, 'worker')
        org.hire(ledger.USER, 'boss', 'haiku', 0, 'spare')
        self.ask_id = str(org.ask_user(
            'boss', question='which?',
            options=[{'label': 'yes'}, {'label': 'no'}])['asked'])
        store.save_org(org)
        self.client = TestClient(app)
        self.agent = {'X-Orgtree-Agent-Token':
                      agentauth.child_env(self.slug, 'boss')['ORGTREE_AGENT_TOKEN']}
        self.addCleanup(self.capture, False)

    # ---- controls --------------------------------------------------------
    def capture(self, enabled: bool) -> None:
        """Through the shipped operator control, not by poking the module —
        the endpoint IS the opt-in, and a test that set the global directly
        would not notice the control breaking."""
        got = self.client.put('/api/desktop/profile-timing',
                              json={'enabled': enabled}, headers=HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        self.assertEqual(got.json()['enabled'], enabled)

    def clear_sink(self) -> None:
        api._PROFILE_RECORDS.clear()

    def records(self) -> list[dict]:
        got = self.client.get('/api/desktop/profile-timing', headers=HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        return got.json()['records']

    def rows(self, route: str) -> list[dict]:
        return [r for r in self.records() if r.get('route') == route]

    def only(self, route: str) -> dict:
        found = self.rows(route)
        self.assertEqual(len(found), 1,
                         f'expected exactly one {route} record, got {found}')
        return found[0]

    # ---- the operations the ticket names --------------------------------
    def mail_send(self):
        return self.client.post(f'/api/orgs/{self.slug}/nodes/worker/message',
                                json={'text': 'hello'}, headers=HEADERS)

    def mail_read(self):
        return self.client.post(f'/api/orgs/{self.slug}/org_inbox/read',
                                headers=HEADERS)

    def save_agent_details(self):
        return self.client.post(f'/api/orgs/{self.slug}/nodes/worker/scope',
                                json={'charter': 'a new charter'}, headers=HEADERS)

    def answer_question(self):
        return self.client.post(f'/api/orgs/{self.slug}/asks/{self.ask_id}/answer',
                                json={'selected': ['yes']}, headers=HEADERS)

    def tool(self, name: str, args: dict):
        return self.client.post('/api/agent', json={
            'org': self.slug, 'node': 'boss', 'tool': name, 'args': args},
            headers=self.agent)

    def hire(self):
        # The Claude sign-in check is about this MACHINE, not about the code
        # under test; patched so the fixture can drive a real hire offline.
        with patch.object(accounts, 'live_identity',
                          lambda *a, **k: {'uuid': 'fixture-uuid'}):
            return self.tool('orgtree_hire', {
                'name': 'hired-seat', 'tier': 'haiku', 'charter': 'fixture',
                'add_dirs': [], 'org_visibility': 'self', 'credits': 0,
                'tools': {'bash': True, 'web': False, 'edit': True,
                          'subagents': False, 'mcp': []}})

    def move(self):
        return self.tool('orgtree_move', {'node': 'spare', 'new_parent': 'worker'})

    def retire(self):
        return self.tool('orgtree_retire', {'node': 'spare'})

    # ---- assertions ------------------------------------------------------
    def assertStages(self, row: dict, *, stages=WRITE_STAGES, what: str = ''):
        for field in stages:
            self.assertIn(field, row, f'{what}: {field} missing from {row}')
            value = row[field]
            self.assertIsInstance(value, (int, float), f'{what}: {field} in {row}')
            self.assertFalse(isinstance(value, bool), f'{what}: {field} is a bool')
            self.assertTrue(math.isfinite(value), f'{what}: {field} is not finite: {row}')
            self.assertGreaterEqual(value, 0.0, f'{what}: {field} is negative: {row}')


class CaptureIsStillOptIn(WriteTimingBase):
    """§1. The negative control. Everything below this class is worthless if
    the flag no longer gates the write paths — a diagnostic that cannot be
    turned off is a cost every user pays for a question nobody asked."""

    def test_a_real_write_records_nothing_while_capture_is_off(self):
        body = self.client.get('/api/desktop/profile-timing', headers=HEADERS).json()
        self.assertFalse(body['enabled'], 'this module must start with capture off')
        before = body['newest_seq']
        self.assertEqual(self.save_agent_details().status_code, 200)
        self.assertEqual(self.mail_read().status_code, 200)
        after = self.client.get('/api/desktop/profile-timing', headers=HEADERS).json()
        self.assertFalse(any(r.get('route', '').startswith('/api/orgs')
                             for r in after['records']),
                         f'no write may be recorded with capture off: {after["records"]}')
        self.assertEqual(after['newest_seq'], before,
                         'an off capture must not advance the sequence either')

    def test_turning_capture_off_again_stops_the_writes_being_recorded(self):
        # The toggle is what an operator actually uses; proving only that the
        # PROCESS started silent would leave "on forever once on" undetected.
        self.capture(True)
        self.assertEqual(self.save_agent_details().status_code, 200)
        self.assertTrue(self.rows('/api/orgs/{slug}/nodes/{nid}/scope'))
        self.capture(False)
        self.clear_sink()
        self.assertEqual(self.save_agent_details().status_code, 200)
        self.assertEqual(self.records(), [],
                         'a write after the control was turned off must record nothing')


class EveryNamedOperationIsAttributable(WriteTimingBase):
    """§2. The acceptance condition, operation by operation."""

    def test_the_seven_named_write_operations_each_carry_four_stages(self):
        self.capture(True)
        self.clear_sink()
        checks = [
            ('mail send', self.mail_send, '/api/orgs/{slug}/nodes/{nid}/message'),
            ('mail read', self.mail_read, '/api/orgs/{slug}/org_inbox/read'),
            ('saving agent details', self.save_agent_details,
             '/api/orgs/{slug}/nodes/{nid}/scope'),
            ('answering a question', self.answer_question,
             '/api/orgs/{slug}/asks/{aid}/answer'),
        ]
        for what, call, route in checks:
            with self.subTest(operation=what):
                got = call()
                self.assertEqual(got.status_code, 200, f'{what}: {got.text}')
                self.assertStages(self.only(route), what=what)

        # hire / retire / move are AGENT TOOLS, not routes of their own: all
        # three arrive through the single `/api/agent` template, so they are
        # driven one at a time and each one's record claimed before the next
        # runs. Route granularity is what the endpoint reports; the stages are
        # per request either way.
        for what, call in (('hire', self.hire), ('move', self.move),
                           ('retire', self.retire)):
            with self.subTest(operation=what):
                self.clear_sink()
                got = call()
                self.assertEqual(got.status_code, 200, f'{what}: {got.text}')
                self.assertStages(self.only('/api/agent'), what=what)

    def test_a_write_that_saves_nothing_says_so_rather_than_inventing_a_save(self):
        # `/api/orgs/{slug}/inbox/read` with no ids takes the lock and loads,
        # then saves nothing. The honest record omits `org_save_ms`; a stage
        # set that always reported all four would be reporting a save that
        # never happened.
        self.capture(True)
        self.clear_sink()
        got = self.client.post(f'/api/orgs/{self.slug}/inbox/read',
                               json={'ids': []}, headers=HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}/inbox/read')
        self.assertStages(row, stages=('lock_wait_ms', 'org_load_ms', 'mutate_ms'),
                          what='inbox read')
        self.assertNotIn('org_save_ms', row,
                         f'nothing was written, so no save may be reported: {row}')


class StagesAreMeasuredNotDecorative(WriteTimingBase):
    """§3. THE POINT OF THE WHOLE TICKET.

    Each case makes exactly ONE stage genuinely slow and asserts that stage
    moved and the others did not. An instrument that filled every field with
    `0.0` — or one that lumped all four together — passes §2 and fails every
    case here.

    The thresholds are deliberately loose (a 300 ms delay is asserted at
    200 ms) because this is a real clock on a shared machine; what is being
    pinned is ATTRIBUTION, not precision.
    """

    DELAY = 0.3

    def test_waiting_for_the_document_lock_is_reported_as_lock_wait(self):
        self.capture(True)
        self.clear_sink()
        holding = threading.Event()

        def hold():
            with store.DOC_LOCK:
                holding.set()
                time.sleep(self.DELAY)

        keeper = threading.Thread(target=hold, name='lock-keeper')
        keeper.start()
        try:
            self.assertTrue(holding.wait(5), 'the keeper never took the lock')
            got = self.save_agent_details()
        finally:
            keeper.join(10)
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}/nodes/{nid}/scope')
        self.assertGreater(row['lock_wait_ms'], 200,
                           f'a {self.DELAY}s wait for DOC_LOCK must show up as lock wait: {row}')
        self.assertLess(row['mutate_ms'], 200,
                        f'time spent WAITING is not time spent mutating: {row}')
        self.assertLess(row['org_load_ms'], 200,
                        f'time spent WAITING is not time spent loading: {row}')

    def test_a_slow_document_load_is_reported_as_the_load(self):
        self.capture(True)
        self.clear_sink()
        # the ROW loader, which both the legacy `load_org` and a row
        # transaction's load go through: the route now runs as an org_tx (S4)
        # and never calls `_load_org`
        real = store._load_sqlite_org

        def slow(slug, *a, **k):
            time.sleep(self.DELAY)
            return real(slug, *a, **k)

        with patch.object(store, '_load_sqlite_org', slow):
            got = self.save_agent_details()
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}/nodes/{nid}/scope')
        self.assertGreater(row['org_load_ms'], 200, f'the slow load must be the load: {row}')
        self.assertLess(row['mutate_ms'], 200,
                        f'a load inside the lock is NOT mutation time: {row}')
        self.assertLess(row['org_save_ms'], 200, f'the save was not slowed: {row}')

    def test_a_slow_document_save_is_reported_as_the_save(self):
        self.capture(True)
        self.clear_sink()
        real = store._save_org

        def slow(org):
            time.sleep(self.DELAY)
            return real(org)

        with patch.object(store, '_save_org', slow):
            got = self.save_agent_details()
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}/nodes/{nid}/scope')
        self.assertGreater(row['org_save_ms'], 200, f'the slow save must be the save: {row}')
        self.assertLess(row['mutate_ms'], 200,
                        f'a save inside the lock is NOT mutation time: {row}')
        self.assertLess(row['org_load_ms'], 200, f'the load was not slowed: {row}')

    def test_slow_work_between_the_load_and_the_save_is_reported_as_mutation(self):
        # `mutate_ms` is the one stage nobody measures directly — it is the
        # lock's held time minus the IO that happened inside it. So it needs
        # its own positive control, or a subtraction that silently produced
        # zero would look exactly like a fast mutation.
        self.capture(True)
        self.clear_sink()
        real = ledger.Org.org_inbox_mark_read

        def slow(self_org):
            time.sleep(StagesAreMeasuredNotDecorative.DELAY)
            return real(self_org)

        with patch.object(ledger.Org, 'org_inbox_mark_read', slow):
            got = self.mail_read()
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}/org_inbox/read')
        self.assertGreater(row['mutate_ms'], 200,
                           f'work under the lock that is neither IO nor waiting is mutation: {row}')
        self.assertLess(row['org_load_ms'], 200, f'the load was not slowed: {row}')
        self.assertLess(row['org_save_ms'], 200, f'the save was not slowed: {row}')
        self.assertLess(row['lock_wait_ms'], 200, f'nothing was contending: {row}')

    def test_the_stages_of_one_write_never_exceed_the_handler_that_ran_them(self):
        # The double-counting guard. Four stages that each measure the same
        # milliseconds would pass every case above and still describe a
        # request that spent more time in its parts than it existed for.
        self.capture(True)
        self.clear_sink()
        self.assertEqual(self.save_agent_details().status_code, 200)
        row = self.only('/api/orgs/{slug}/nodes/{nid}/scope')
        summed = sum(row[f] for f in WRITE_STAGES)
        self.assertLessEqual(summed, row['handler_ms'] + 1.0,
                             f'the stages must partition the handler, not overlap it: {row}')


class TheSinkBoundaryIsUnchanged(WriteTimingBase):
    """§4. The two properties the ticket forbids weakening, now that write
    routes — which carry slugs, node ids, mail ids and agent tokens — reach
    the sink for the first time."""

    def test_a_write_record_carries_the_route_template_and_never_the_real_path(self):
        self.capture(True)
        self.clear_sink()
        self.assertEqual(self.save_agent_details().status_code, 200)
        row = self.only('/api/orgs/{slug}/nodes/{nid}/scope')
        self.assertIn('{', row['route'])
        blob = json.dumps(row)
        for secret in (self.slug, 'worker', 'operator', 'a new charter',
                       self.agent['X-Orgtree-Agent-Token']):
            self.assertNotIn(secret, blob,
                             f'{secret!r} must never reach a profile record: {row}')

    def test_a_write_record_contains_only_allowlisted_and_reserved_fields(self):
        self.capture(True)
        self.clear_sink()
        self.assertEqual(self.answer_question().status_code, 200)
        row = self.only('/api/orgs/{slug}/asks/{aid}/answer')
        allowed = (set(api._PROFILE_ALLOWED_FIELDS)
                   | set(api._PROFILE_RESERVED_FIELDS)
                   | {api._PROFILE_TOOL_FIELD})
        self.assertLessEqual(set(row), allowed,
                             f'a write record grew a field outside the allowlist: {row}')
        # …and this route is not `/api/agent`, so the one permitted
        # non-numeric field must be absent rather than merely permitted.
        self.assertNotIn(api._PROFILE_TOOL_FIELD, row,
                         f'a non-agent route must carry no verb: {row}')

    def test_the_new_write_stages_are_on_the_allowlist_deliberately(self):
        # Named, so that removing a stage from `_PROFILE_ALLOWED_FIELDS`
        # cannot quietly turn a populated stage into a dropped one — the
        # filter is silent by design, and silence is what this ticket is about.
        for field in WRITE_STAGES:
            self.assertIn(field, api._PROFILE_ALLOWED_FIELDS)

    def test_a_write_handler_still_cannot_smuggle_a_field_through_its_profile(self):
        # The closed allowlist, exercised at the merge itself: the write paths
        # now populate the dict from `store`, so "only known stage names leave
        # a handler's profile" has more writers than it used to.
        self.capture(True)          # the sink branch is gated on it, like any write

        class FakeRoute:
            path = '/api/orgs/{slug}/nodes/{nid}/scope'

        scope = {'route': FakeRoute(), 'method': 'POST', 'type': 'http'}
        before = len(api._PROFILE_RECORDS)
        api._access_emit(scope, 200, 1.0, 1.0, 0, 1, profile={
            'mutate_ms': 3.0, 'charter_len': 4096, 'token': 1234,
            'agent_nid': 99, 'nan_ms': math.nan})
        self.assertEqual(len(api._PROFILE_RECORDS), before + 1)
        row = api._PROFILE_RECORDS[-1]
        self.assertEqual(row.get('mutate_ms'), 3.0)
        for rejected in ('charter_len', 'token', 'agent_nid', 'nan_ms'):
            self.assertNotIn(rejected, row, f'{rejected!r} must never reach the sink: {row}')


class ReadRoutesReportExactlyWhatTheyDidBefore(WriteTimingBase):
    """§5. The regression the central instrumentation could have caused."""

    def test_the_org_tree_route_keeps_its_own_stages_and_gains_no_load_stage(self):
        self.capture(True)
        self.clear_sink()
        got = self.client.get(f'/api/orgs/{self.slug}', headers=HEADERS)
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/orgs/{slug}')
        for field in ('load_snapshot_ms', 'tree_ms', 'annotate_ms'):
            self.assertIn(field, row, f'{field} is this route\'s own stage: {row}')
        self.assertNotIn(
            'org_load_ms', row,
            'on the JSON backend this route\'s snapshot IS a load_org; billing it '
            f'again as org_load_ms would double-report one parse: {row}')
        self.assertNotIn('mutate_ms', row,
                         f'a read route takes no document lock: {row}')

    def test_the_snapshot_loader_does_not_bill_the_load_it_delegates(self):
        """⚠ THE CASE ABOVE CANNOT SEE THIS ONE, and that is why this exists.

        `load_org_snapshot` only delegates to `load_org` on the JSON backend;
        under SQLite (the default, and what these tests run on) it goes
        straight to `_load_sqlite_org` and never touches the guarded path at
        all. So the HTTP case above passes whether or not the suppression is
        there — measured: removing it left every test in this module green.

        The backend is pinned here instead, at the seam itself, with the
        matching positive control beside it: `load_org` on the SAME patched
        backend must still bill itself, or "no org_load_ms" would prove
        nothing more than that nothing was ever measured.
        """
        from orgtree import profiling
        sentinel = object()

        def one(profile, call):
            token = profiling.bind(profile)
            try:
                with patch.object(store, 'STORE_BACKEND', 'json'), \
                        patch.object(store, '_load_org', lambda slug: sentinel):
                    self.assertIs(call(), sentinel)
            finally:
                profiling.unbind(token)

        billed: dict = {}
        one(billed, lambda: store.load_org(self.slug))
        self.assertGreater(billed.get('org_load_ms', -1.0), -1.0,
                           'positive control: a direct load_org must bill itself')

        suppressed: dict = {}
        one(suppressed, lambda: store.load_org_snapshot(self.slug, ()))
        self.assertNotIn(
            'org_load_ms', suppressed,
            'the caller already reports this load as load_snapshot_ms; billing '
            f'it again would double-report one parse: {suppressed}')


class ManagedToolsReportTheWorkTheyReallyDid(WriteTimingBase):
    """§6. `orgtree_hire`, `orgtree_retire` and the rest of MANAGED_WAIT_TOOLS
    execute on a plain `threading.Thread`, which starts with an EMPTY context.

    MEASURED before `toolwait.invoke` carried the profile across: a successful
    retire produced `org_load_ms` and a 0.03 ms `mutate_ms` — the
    authentication this request thread did — and NO `org_save_ms` at all. The
    operation had happened; the instrument had watched the wrong thread. This
    is the case that catches that, and it is deliberately a separate class
    from §2 because §2 would still pass with the binding removed.
    """

    def test_a_managed_tool_reports_the_save_its_worker_thread_performed(self):
        self.capture(True)
        self.clear_sink()
        got = self.retire()
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/agent')
        self.assertStages(row, what='retire')
        self.assertGreater(
            row['org_save_ms'], 0.0,
            'a retire writes the document; a zero save means the stages were '
            f'collected from the request thread and not from the worker: {row}')

    def test_an_unmanaged_tool_on_the_same_route_reports_its_save_too(self):
        # `orgtree_move` is NOT a managed-wait tool: it runs in the ordinary
        # threadpool. Pairing it with the case above proves the two dispatch
        # paths agree, rather than one of them being the only one ever tested.
        self.capture(True)
        self.clear_sink()
        got = self.move()
        self.assertEqual(got.status_code, 200, got.text)
        row = self.only('/api/agent')
        self.assertStages(row, what='move')
        self.assertGreater(row['org_save_ms'], 0.0, f'a move writes the document: {row}')


class AnAgentRecordSaysWhichVerbItWas(WriteTimingBase):
    """§7. `/api/agent` is one route serving every agent verb.

    Everything above can prove that an agent call waited 4.9 s on the document
    lock and still leave three identical `route: "/api/agent"` rows that no
    operator can tell apart. These cases are about the field that fixes that,
    and about the catalogue check that makes it safe to publish.
    """

    def test_three_different_verbs_on_one_route_are_told_apart(self):
        # THE FEATURE. Note what this does NOT do: assert the field exists.
        # A `tool` field that always said the same thing would satisfy that
        # and be worth nothing, so the three verbs are driven through the
        # same route and the three recorded values must differ.
        self.capture(True)
        self.clear_sink()
        self.assertEqual(self.move().status_code, 200)
        self.assertEqual(self.retire().status_code, 200)
        with patch.object(accounts, 'live_identity',
                          lambda *a, **k: {'uuid': 'fixture-uuid'}):
            self.assertEqual(self.tool('orgtree_chart', {}).status_code, 200)
        verbs = [r.get(api._PROFILE_TOOL_FIELD) for r in self.rows('/api/agent')]
        self.assertEqual(verbs, ['orgtree_move', 'orgtree_retire', 'orgtree_chart'],
                         f'three verbs on one route must be distinguishable: {verbs}')

    def test_a_managed_verb_is_named_too(self):
        # §6's dispatch path again: the managed worker runs on its own thread,
        # and the label is written on the event loop before that thread
        # starts. Pairing this with the unmanaged verbs above keeps both
        # dispatch paths named, not just the one that happened to be tested.
        self.capture(True)
        self.clear_sink()
        self.assertEqual(self.retire().status_code, 200)
        row = self.only('/api/agent')
        self.assertEqual(row.get(api._PROFILE_TOOL_FIELD), 'orgtree_retire')
        self.assertStages(row, what='retire')

    def test_the_wrapper_reports_the_verb_it_carries_not_the_wrapper(self):
        # `orgtree_op_call` exists to carry a receipt key around another verb.
        # Recording the wrapper would file every receipt-bearing call under one
        # name and lose exactly the distinction this section is for.
        self.capture(True)
        self.clear_sink()
        self.client.post('/api/agent', json={
            'org': self.slug, 'node': 'boss', 'tool': 'orgtree_op_call',
            'args': {'tool': 'orgtree_chart', 'args': {}}}, headers=self.agent)
        row = self.only('/api/agent')
        self.assertEqual(row.get(api._PROFILE_TOOL_FIELD), 'orgtree_chart',
                         f'the wrapper must report what it wraps: {row}')

    def test_an_invented_verb_is_dropped_and_the_record_still_arrives(self):
        # THE POSITIVE CONTROL MATTERS MORE THAN THE ASSERTION. "no `tool`
        # field" is also what a vanished record looks like, and a vanished
        # record is the documented failure mode of this emit path — so the row
        # must be shown to exist, with its stages, before its missing verb
        # means anything.
        self.capture(True)
        self.clear_sink()
        self.client.post('/api/agent', json={
            'org': self.slug, 'node': 'boss',
            'tool': 'orgtree_not_a_real_tool', 'args': {}}, headers=self.agent)
        row = self.only('/api/agent')
        self.assertIn('lock_wait_ms', row,
                      f'positive control: the record itself must exist: {row}')
        self.assertNotIn(api._PROFILE_TOOL_FIELD, row,
                         f'an unknown verb must be dropped, not echoed: {row}')

    def test_the_verb_is_never_echoed_from_the_request(self):
        # The actual threat. `AgentCall.tool` is an unvalidated `str` and
        # `orgtree_op_call` carries a second one in its args, so without the
        # catalogue check this field would publish whatever a caller typed —
        # into a sink whose whole promise is "route templates and numbers".
        #
        # The last value is the one with teeth beyond privacy: a non-ASCII
        # byte on the emitted line raises UnicodeEncodeError under the
        # caller's `except Exception: pass` and destroys the WHOLE record in
        # silence (see `_access_emit`). Catalogue membership is what
        # guarantees the field is one of ~49 fixed `[a-z_]` names.
        self.capture(True)
        for hostile in ('orgtree_hire; DROP TABLE', 'sk-ant-secret-token',
                        '../../etc/passwd', 'orgtree_hire—dash', ''):
            with self.subTest(verb=hostile):
                self.clear_sink()
                self.client.post('/api/agent', json={
                    'org': self.slug, 'node': 'boss',
                    'tool': hostile, 'args': {}}, headers=self.agent)
                rows = self.rows('/api/agent')
                self.assertTrue(rows, f'positive control: a record must exist for {hostile!r}')
                for row in rows:
                    self.assertNotIn(api._PROFILE_TOOL_FIELD, row,
                                     f'{hostile!r} reached the sink: {row}')
                    if hostile:     # '' is a substring of everything
                        self.assertNotIn(hostile, json.dumps(row))

    def test_the_catalogue_is_derived_from_the_tool_list_not_retyped(self):
        # A hand-maintained copy of ~46 verb names would go stale at the first
        # tool added after this ticket, and the symptom would be a silently
        # unnamed verb rather than a failure. Pinned against the registry
        # itself, plus the handful of dispatchable verbs deliberately absent
        # from it.
        from orgtree import mcptool
        names = api._profile_tool_names()
        for tool in mcptool.TOOLS:
            self.assertIn(str(tool['name']), names,
                          'every catalogued tool must be nameable in a record')
        for extra in api._PROFILE_EXTRA_TOOL_VERBS:
            self.assertIn(extra, names)
        self.assertNotIn('orgtree_not_a_real_tool', names)
        # Every member is ASCII and boring — the property the emit path relies
        # on, asserted over the whole set rather than over the ones used above.
        for name in names:
            self.assertRegex(name, r'^[a-z_]+$', f'{name!r} is not a plain ASCII verb')

    def test_the_boundary_drops_a_hostile_verb_at_the_emit_itself(self):
        # The same rule as above, exercised directly at `_access_emit` rather
        # than through a route — so it holds for any FUTURE caller of
        # `profiling.label`, not only for the one wiring that exists today.
        self.capture(True)

        class FakeRoute:
            path = '/api/agent'

        scope = {'route': FakeRoute(), 'method': 'POST', 'type': 'http'}
        before = len(api._PROFILE_RECORDS)
        api._access_emit(scope, 200, 1.0, 1.0, 0, 1, profile={
            'mutate_ms': 3.0, api._PROFILE_TOOL_FIELD: 'sk-ant-secret'})
        self.assertEqual(len(api._PROFILE_RECORDS), before + 1)
        row = api._PROFILE_RECORDS[-1]
        self.assertEqual(row.get('mutate_ms'), 3.0, 'positive control')
        self.assertNotIn(api._PROFILE_TOOL_FIELD, row, f'hostile verb survived: {row}')

        api._access_emit(scope, 200, 1.0, 1.0, 0, 1, profile={
            'mutate_ms': 3.0, api._PROFILE_TOOL_FIELD: 'orgtree_hire'})
        self.assertEqual(api._PROFILE_RECORDS[-1].get(api._PROFILE_TOOL_FIELD),
                         'orgtree_hire', 'a catalogued verb must survive')


if __name__ == '__main__':
    unittest.main()
