"""An agent can DISCOVER an account with capacity and HIRE onto it.

USER DECISION 2026-09-12, verbatim: "yes, the agent hire / rehire / retool
tools should be able to decide which account to hire on".

WHAT WAS ACTUALLY BROKEN, and it was not the guidance. The turn envelope's
`[PROVIDER USAGE]` board shows every signed-in account, and the managed
instructions tell an agent how to compare them and which one to place work on.
Then the agent reached for the field that places work on an account and there
was none: `args["account"]` has been read by the hire path for as long as the
account registry has existed, `supervisor.assign_account` has been the one
writer for a rebind — and NEITHER APPEARED IN ANY AGENT-FACING SCHEMA. The
board said "this account has room"; nothing let an agent act on it. Advice an
agent cannot carry out is not a feature, and a model does not read the source
to find an undocumented argument.

Two halves, and the suite is built around the seam between them:

  · the BOARD must publish a value the tools accept. It prints a lane name, a
    label, an email and an id; only the registry id is accepted, so the roster
    names it as `account=<id>` — and the HOST lanes get roster entries too,
    because `registered_views` drops the rows a host lane already serves and
    dropping the row dropped its id. On the ordinary two-account machine the
    ambient sign-in IS one of the two, so half the board was unnameable.

  · the TOOLS must take it, with the same checks at every door: `orgtree_hire`,
    `orgtree_rehire`, `orgtree_retool` and `orgtree_staff` — which composes the
    first two and must therefore not be a route to a binding either of them
    would refuse.

§1 the field exists and names the right value · §2 discover → hire, end to end,
through the real dispatch · §3 per-account exhaustion is visible AND nameable ·
§4 authority (downward only, never your own billing) · §5 provider
compatibility · §6 unbound, and what cannot be unbound · §7 rehire lands on the
named account · §8 staff is not a bypass.

MEASURED against main (41d78e9): 18 of these 23 RED, 5 green before and after.
Red: all of §1 (no `account` property on any of the four schemas, and nothing
in their cards saying the capability exists), §2 and §2b (the board published no
id a tool would accept), §3 and §3b, all of §4 and §5b/§5c's rebind leg (retool
ignored the argument), §6b, §6c, all of §7 (a rehire ignored `account`
entirely) and §8b. Green before and after — the controls, each one a thing this
change reuses rather than rewrites: §3c (no credential material on the board),
§4d (a refused scope change leaves the binding alone), §5 and §8's hire leg and
§6a (the ledger's own validator and its unbound-hire semantics, which the hire
path has always run).

    python -B tests/test_account_selection_contract.py
"""
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

# left for the OS to reclaim, deliberately: this suite hires through the real
# dispatch, so the fixture root fills with agent scratch folders that Windows
# may still hold open when the interpreter exits
FX = tempfile.mkdtemp(prefix='acct-select-')
os.environ['ORGTREE_DATA'] = str(Path(FX) / 'data')
os.environ['HOME'] = str(Path(FX) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'acct-select-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import (api, codex_limits, ledger, limits,              # noqa: E402
                     mcptool, registry, store, supervisor, turnusage)
from starlette.requests import Request                               # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

NOW = 1_800_000_000.0
#: every tool the user's decision names, plus the composite
SURFACES = ('orgtree_hire', 'orgtree_rehire', 'orgtree_retool', 'orgtree_staff')
#: the no-defaults hire rule wants every switch stated; none of them is the
#: subject here, so one spelling serves every hire in the suite
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False,
            'mcp': []}
slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def limit(kind, percent, resets_at=None, model=None, label=None, active=False):
    """One normalized limit entry — the shape `limits._normalize` produces."""
    return {'kind': kind, 'group': kind, 'percent': percent,
            'severity': 'normal', 'resets_at': resets_at,
            'is_active': active, 'model': model, 'label': label}


def schema_of(tool):
    return next(t for t in mcptool.TOOLS
                if t['name'] == tool)['inputSchema']['properties']


class AccountSelectionContract(unittest.TestCase):
    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        limits.invalidate()
        with limits._lock:
            limits._key_cache.clear()
            limits._cache.clear()
        with codex_limits._lock:
            codex_limits._home_cache.clear()
        self.slug = 'acctsel-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        # a manager with credits to spend, and one report under it to rebind
        self.org.hire(ledger.USER, None, 'opus', 20, 'manager',
                      add_dirs=[], tools={}, charter='fixture')
        self.org.hire('manager', 'manager', 'haiku', 0, 'worker',
                      add_dirs=[], tools=NO_TOOLS, org_visibility='self',
                      charter='fixture')
        store.save_org(self.org)
        # ⚠ THE PROVIDER GATE IS NOT THE SUBJECT. It refuses a Claude hire on a
        # machine with no Claude CLI signed in, which every fixture here is,
        # and it fires before a single account check — so it would hide exactly
        # what these tests measure. Patched off, and nothing else is.
        gate = patch.object(api, 'provider_hire_gate', lambda *a, **k: None)
        gate.start()
        self.addCleanup(gate.stop)
        # ⚠ AND THE TURN ITSELF IS NOT THE SUBJECT EITHER. A hire with a
        # kickoff, and an assignment notification, both DRIVE the new seat —
        # which in a fixture means spawning a provider CLI that is not signed
        # in, in a background thread, long after the assertion it belongs to
        # has passed. What this suite measures is the transaction: the binding
        # that was written and the refusals that were not.
        drive = patch.object(supervisor, 'send_message',
                             lambda *a, **k: {})
        drive.start()
        self.addCleanup(drive.stop)

    _seq = 0

    def account(self, provider='claude', label='acct', email=''):
        AccountSelectionContract._seq += 1
        row = registry.create_account(
            provider, label,
            {'kind': 'managed',
             'path': os.path.join(FX, f'{provider}-{self._seq}')})
        if email:
            registry.set_identity(row['id'], {'email': email})
        return registry.get_account(row['id'])

    def make_ambient(self, row):
        """Make this row the one the HOST claude lane serves — the same alias
        `accountusage.ambient_covered` reads, which is how the real machine's
        ambient sign-in is identified."""
        doc = registry.load(strict=True)
        doc['aliases']['primary'] = row['id']
        registry.save(doc)

    def seed_host(self, lims):
        with limits._lock:
            limits._cache.update(at=NOW - 30.0,
                                 data={'available': True, 'limits': lims})

    def seed_account(self, row, lims):
        with limits._lock:
            limits._key_cache[f"acct:{row['id']}"] = {
                'at': NOW - 60.0, 'data': {'available': True, 'limits': lims}}

    # ---- the board, read the way an agent reads it ----------------------
    def board(self):
        return turnusage.board(self.org, 'manager', selected_provider='claude',
                              selected_lane='primary', now=NOW)[0]

    def roster(self, text=None):
        """`{lane: account_id}` — parsed out of the rendered roster line with
        nothing but string handling, exactly as a model would have to."""
        text = self.board() if text is None else text
        line = next((ln for ln in text.splitlines()
                     if ln.startswith(turnusage.ROSTER)), '')
        out = {}
        for entry in line[len(turnusage.ROSTER):].split(' · '):
            bits = entry.split()
            if len(bits) < 2 or not bits[1].startswith('account='):
                continue
            out[bits[0]] = bits[1].split('=', 1)[1]
        return out

    def exhausted_lanes(self, text=None):
        """The lanes whose rows say a window is spent — `limit-active`, which
        is what the board prints for 100% or a provider-flagged active wall."""
        text = self.board() if text is None else text
        return {ln.split('|')[0].strip().rstrip('*')
                for ln in text.splitlines()
                if ln.count('|') >= 6 and 'limit-active' in ln}

    # ---- the real dispatch ---------------------------------------------
    def call(self, tool, actor='manager', **args):
        """One real agent tool call, through `api.agent_call` — the same door
        a live agent's MCP request lands on, so the authority checks, the
        ledger and the account validator are all the real ones."""
        body = api.AgentCall(org=self.slug, node=actor, tool=tool, args=args)
        out = api.agent_call(body, Request({'type': 'http', 'headers': []}))
        self.org = store.load_org(self.slug)
        return out

    def bound(self, nid):
        return store.load_org(self.slug).node(nid).get('account')

    # ── §1 the field is on every surface, naming the value that works ─────
    def test_s1_every_seat_surface_exposes_account(self):
        for tool in SURFACES:
            with self.subTest(tool=tool):
                prop = schema_of(tool).get('account')
                self.assertIsNotNone(
                    prop, f'{tool} cannot place work on a named account')
                self.assertEqual(prop['type'], 'string')

    def test_s1b_the_description_names_the_registry_id_and_the_roster(self):
        """A description that said "the account" would send a model to the
        label or the email — both of which the board prints and the validator
        refuses. So it must name the roster's `account=` field by sight."""
        for tool in SURFACES:
            with self.subTest(tool=tool):
                text = schema_of(tool)['account']['description']
                self.assertIn('account=', text)
                self.assertIn('[PROVIDER USAGE]', text)
                self.assertIn('not the lane name', text)

    def test_s1c_the_tool_cards_say_the_capability_exists(self):
        """The schema property is what a client validates against; the tool
        DESCRIPTION is what a model reads when deciding what the tool can do.
        A capability present only in a property is a capability most callers
        never look for.

        The assertion names the FIELD — `` `account` `` — rather than the word
        "account", which every one of these cards already contained in some
        other sense ("your ChatGPT account", "automatic account switching")."""
        for tool in ('orgtree_hire', 'orgtree_rehire', 'orgtree_retool'):
            with self.subTest(tool=tool):
                card = next(t for t in mcptool.TOOLS if t['name'] == tool)
                self.assertIn('`account`', card['description'])

    # ── §2 discover → hire, end to end ───────────────────────────────────
    def test_s2_an_agent_reads_the_board_and_hires_onto_the_lane_with_room(self):
        """THE ONE THIS SUITE EXISTS FOR, and it is deliberately written as a
        chain: the only thing carried from the board to the hire is the string
        the board printed. No fixture hands the test an account id."""
        host = self.account('claude', 'Main', 'main@example.com')
        self.make_ambient(host)
        spare = self.account('claude', 'Spare')
        # the host lane is the one with capacity; the spare is spent
        self.seed_host([limit('weekly_all', 20.0, NOW + 3 * 86400)])
        self.seed_account(spare, [limit('weekly_all', 100.0, NOW + 3 * 86400)])

        text = self.board()
        roster, spent = self.roster(text), self.exhausted_lanes(text)
        usable = {lane: acct for lane, acct in roster.items()
                  if lane.startswith('claude/') and lane not in spent}
        self.assertEqual(set(usable), {'claude/primary'},
                         f'the board did not leave exactly one usable claude '
                         f'lane nameable: roster={roster} spent={spent}')
        chosen = usable['claude/primary']

        self.call('orgtree_hire', name='picked', tier='haiku', grant=0,
                  charter='hired onto the account with room', add_dirs=[],
                  tools=NO_TOOLS,
                  org_visibility='self', account=chosen)
        self.assertEqual(self.bound('picked'), host['id'],
                         'the value the board published was not the value the '
                         'hire field accepts')

    def test_s2b_and_the_same_string_works_on_staff(self):
        host = self.account('claude', 'Main')
        self.make_ambient(host)
        self.seed_host([limit('weekly_all', 20.0, NOW + 3 * 86400)])
        chosen = self.roster()['claude/primary']
        out = self.call('orgtree_staff', title='Balance the lanes',
                        objective='A problem, then a plan.', name='staffed',
                        tier='haiku', grant=0, charter='fixture', add_dirs=[],
                        tools=NO_TOOLS,
                        org_visibility='self', account=chosen)
        self.assertEqual(out.get('assigned_to'), 'staffed')
        self.assertEqual(self.bound('staffed'), host['id'])

    # ── §3 per-account exhaustion: visible, and nameable ─────────────────
    def test_s3_two_accounts_report_their_own_windows(self):
        full = self.account('claude', 'Full')
        room = self.account('claude', 'Room')
        self.seed_account(full, [limit('weekly_all', 100.0, NOW + 3 * 86400)])
        self.seed_account(room, [limit('weekly_all', 12.0, NOW + 3 * 86400)])
        text = self.board()
        self.assertIn('claude/full', self.exhausted_lanes(text))
        self.assertNotIn('claude/room', self.exhausted_lanes(text))
        # …and BOTH are nameable: the board reports, it does not ration. The
        # 100% rule is the agent's to apply, so the exhausted account keeps an
        # id — an agent that must explain why it did not use a lane needs to
        # be able to refer to it.
        self.assertEqual(self.roster(text).get('claude/full'), full['id'])
        self.assertEqual(self.roster(text).get('claude/room'), room['id'])

    def test_s3b_the_host_lane_is_nameable_too(self):
        """The regression that made the rest of it unactionable. The ambient
        row is dropped from the account ROWS on purpose — its usage is the host
        lane, and drawing it twice would read as two accounts. Dropping the id
        as well left the commonest machine with one nameable lane out of two."""
        host = self.account('claude', 'Ambient', 'me@example.com')
        self.make_ambient(host)
        self.seed_host([limit('weekly_all', 30.0, NOW + 3 * 86400)])
        text = self.board()
        self.assertEqual(self.roster(text).get('claude/primary'), host['id'])
        # and still exactly once — the id on the roster, the usage on one lane
        lanes = {ln.split('|')[0].strip().rstrip('*')
                 for ln in text.splitlines() if ln.count('|') >= 6}
        self.assertNotIn('claude/ambient', lanes)
        self.assertEqual(text.count(host['id']), 1, text)
        # the id is bindable as printed: the same validator every door calls
        registry.validate_binding(self.slug, 'haiku',
                                  self.roster(text)['claude/primary'])

    def test_s3c_still_no_credential_material_on_the_board(self):
        """Control: the roster gained an id, not a licence to print secrets."""
        row = self.account('claude', 'Work', 'work@example.com')
        self.seed_account(row, [limit('weekly_all', 12.0, NOW + 86400)])
        text = self.board()
        self.assertNotIn(row['credential']['path'], text)
        self.assertNotIn(FX, text)

    # ── §4 authority: downward, and never your own billing ───────────────
    def test_s4_a_superior_rebinds_a_report(self):
        row = self.account('claude', 'Target')
        out = self.call('orgtree_retool', node='worker', account=row['id'])
        self.assertEqual(self.bound('worker'), row['id'])
        self.assertEqual(out.get('account'), row['id'])
        # the full disclosure rides along: a rebind that flipped billing or
        # archived a session must say so where the caller can see it
        self.assertEqual(out['account_binding']['billing_mode'], 'subscription')
        self.assertIn('continuity', out['account_binding'])

    def test_s4b_nobody_chooses_their_own_account(self):
        row = self.account('claude', 'Self')
        with self.assertRaises(api.HTTPException) as e:
            self.call('orgtree_retool', node='manager', account=row['id'])
        self.assertEqual(e.exception.status_code, 403)
        self.assertIsNone(self.bound('manager'))

    def test_s4c_nor_upward_at_a_superior(self):
        """The rule is DOWNWARD, so the interesting refusal is the other
        direction: a report choosing the account its own manager bills."""
        row = self.account('claude', 'Upward')
        with self.assertRaises(api.HTTPException) as e:
            self.call('orgtree_retool', actor='worker', node='manager',
                      account=row['id'])
        self.assertEqual(e.exception.status_code, 403)
        self.assertIsNone(self.bound('manager'))

    def test_s4d_a_scope_refusal_leaves_the_binding_alone(self):
        """The rebind runs LAST, after every scope refusal has fired — so a
        retool that asked for a tool grant it does not hold never announces an
        account change it then discarded."""
        row = self.account('claude', 'Atomic')
        with self.assertRaises(Exception):
            self.call('orgtree_retool', node='worker', account=row['id'],
                      tools={'bash': True, 'web': True, 'edit': True,
                             'subagents': True, 'mcp': ['nope']})
        self.assertIsNone(self.bound('worker'))

    # ── §5 provider compatibility, at every door ─────────────────────────
    def test_s5_a_codex_account_is_refused_for_a_claude_tier(self):
        codex = self.account('openai', 'Codex One')
        with self.assertRaises(Exception) as e:
            self.call('orgtree_hire', name='mismatch', tier='haiku', grant=0,
                      charter='fixture', add_dirs=[],
                      tools=NO_TOOLS,
                      org_visibility='self', account=codex['id'])
        self.assertIn('provider', str(e.exception).lower())
        self.assertNotIn('mismatch', store.load_org(self.slug).nodes)

    def test_s5b_and_on_the_rebind_door(self):
        codex = self.account('openai', 'Codex Two')
        with self.assertRaises(Exception):
            self.call('orgtree_retool', node='worker', account=codex['id'])
        self.assertIsNone(self.bound('worker'))

    def test_s5c_an_unregistered_id_is_refused_rather_than_stored(self):
        for tool, args in (('orgtree_hire',
                            dict(name='ghost', tier='haiku', grant=0,
                                 charter='fixture', add_dirs=[],
                                 tools=NO_TOOLS,
                                 org_visibility='self')),
                           ('orgtree_retool', dict(node='worker'))):
            with self.subTest(tool=tool):
                with self.assertRaises(Exception):
                    self.call(tool, account='claude-does-not-exist', **args)
        self.assertNotIn('ghost', store.load_org(self.slug).nodes)
        self.assertIsNone(self.bound('worker'))

    # ── §6 unbound, and what cannot be unbound ───────────────────────────
    def test_s6_an_empty_string_hires_an_explicitly_unbound_seat(self):
        """Control (green before and after): the ledger has always read `""`
        as "unbound, whatever the org default says", and this change keeps it
        as the one way to override a default without naming another account."""
        default = self.account('claude', 'Default')
        self.org.set_hire_defaults(default_account=default['id'])
        store.save_org(self.org)
        self.call('orgtree_hire', name='free', tier='haiku', grant=0,
                  charter='fixture', add_dirs=[],
                  tools=NO_TOOLS,
                  org_visibility='self', account='')
        self.assertIsNone(self.bound('free'))
        # …and omitting the field still inherits that default, untouched
        self.call('orgtree_hire', name='inherited', tier='haiku', grant=0,
                  charter='fixture', add_dirs=[],
                  tools=NO_TOOLS,
                  org_visibility='self')
        self.assertEqual(self.bound('inherited'), default['id'])

    def test_s6b_but_a_rebind_cannot_clear_one_and_says_so(self):
        """There is no unbind writer: `assign_account` validates a row and
        writes it, and nothing takes one away. Accepting `''` here would read
        as an instruction that was obeyed and do nothing at all."""
        row = self.account('claude', 'Bound')
        self.call('orgtree_retool', node='worker', account=row['id'])
        with self.assertRaises(Exception) as e:
            self.call('orgtree_retool', node='worker', account='')
        self.assertIn('unbind', str(e.exception))
        self.assertEqual(self.bound('worker'), row['id'],
                         'a refused clear must leave the binding standing')

    def test_s6c_and_neither_can_a_rehire(self):
        row = self.account('claude', 'Archived')
        self.call('orgtree_retool', node='worker', account=row['id'])
        self.call('orgtree_retire', node='worker')
        with self.assertRaises(Exception) as e:
            self.call('orgtree_rehire', node='worker', account='')
        self.assertIn('unbind', str(e.exception))

    # ── §7 a rehire lands on the account it is told to ───────────────────
    def test_s7_rehire_brings_an_agent_back_on_a_named_account(self):
        old = self.account('claude', 'Old')
        new = self.account('claude', 'New')
        self.call('orgtree_retool', node='worker', account=old['id'])
        self.call('orgtree_retire', node='worker')
        out = self.call('orgtree_rehire', node='worker', account=new['id'])
        self.assertEqual(self.bound('worker'), new['id'],
                         'a rehire that ignored `account` would put the agent '
                         'straight back on the exhausted lane it stopped on')
        self.assertEqual(out.get('account'), new['id'])
        self.assertEqual(out['account_binding']['previous_account'], old['id'])

    def test_s7b_and_omitting_it_restores_the_stored_binding(self):
        """The default has to stay what it always was: a rehire is a restore,
        not a re-decision."""
        old = self.account('claude', 'Keep')
        self.call('orgtree_retool', node='worker', account=old['id'])
        self.call('orgtree_retire', node='worker')
        out = self.call('orgtree_rehire', node='worker')
        self.assertEqual(self.bound('worker'), old['id'])
        self.assertNotIn('account_binding', out)

    def test_s7c_a_refused_account_wakes_nobody(self):
        """Validated before `org.rehire`, because past that point the agent is
        live and may already be in the drive list — a refusal would have to be
        unwound instead of simply raised."""
        codex = self.account('openai', 'Wrong')
        self.call('orgtree_retire', node='worker')
        with self.assertRaises(Exception):
            self.call('orgtree_rehire', node='worker', account=codex['id'])
        self.assertEqual(store.load_org(self.slug).node('worker')['state'],
                         'archived')

    # ── §8 staff composes the two and bypasses neither ───────────────────
    def test_s8_a_staffed_hire_is_refused_by_the_same_validator(self):
        codex = self.account('openai', 'Codex Staff')
        with self.assertRaises(Exception):
            self.call('orgtree_staff', title='Should not exist',
                      objective='A problem, then a plan.', name='nope',
                      tier='haiku', grant=0, charter='fixture', add_dirs=[],
                      tools=NO_TOOLS,
                      org_visibility='self', account=codex['id'])
        after = store.load_org(self.slug)
        self.assertNotIn('nope', after.nodes)
        self.assertEqual([i for i in (after.d.get('work_items') or [])
                          if i.get('title') == 'Should not exist'], [],
                         'a refused seat must leave no docket item behind')

    def test_s8b_a_staffed_rehire_honours_the_named_account(self):
        new = self.account('claude', 'Staff Rehire')
        self.call('orgtree_retire', node='worker')
        self.call('orgtree_staff', staff_mode='rehire', node='worker',
                  title='Back on a lane with room',
                  objective='A problem, then a plan.', account=new['id'])
        self.assertEqual(self.bound('worker'), new['id'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
