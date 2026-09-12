"""Every agent, on every provider, is told how to balance signed-in accounts.

USER REQUIREMENT 2026-09-12, verbatim: "please update orgtree's agent
instructions to tell [agents] to appropriately load-balance among the available
accounts when multiple are signed in at once, taking into account remaining
usage and time until refresh to assign tasks on the correct account lane. for
example, at distant time until refresh for all accounts by a given provider,
prioritize using the one with less usage. when one account will refresh sooner
than another, prioritize using that account's usage up first before touching
the second one. make sure agents also know the individual rules for how each
lane works: in claude, using fable models uses both the standard weekly limit
and the fable weekly limit, while using lower tier models like opus only use
the weekly limit. in codex, using luna will accumulate only in the gpt-reserve
limit and won't affect the weekly limit at all until it's filled completely,
unless the user has that setting disabled or the gpt-reserve lane is
unavailable."

WHAT THE NUMBERS ALREADY DID AND WHAT WAS MISSING. The per-account usage board
(`[PROVIDER USAGE]`, `turnusage.board`) has always reached every agent on the
turn envelope. It reports; it does not RULE. Nothing in the managed prompt said
which account a task belongs on, so the ordering was left to each agent's
improvisation and capacity was spent out of order.

WHERE THE FIX HAD TO GO, and why this suite asserts on `identity_prompt` rather
than on any one lane's file. `identity_prompt` is the single string all three
provider legs render:

  · claude       → <scratch>/.orgtree-identity.md   (--append-system-prompt-file)
  · codex        → <scratch>/AGENTS.md
  · antigravity  → developer_instructions

so a rule placed there reaches every lane by construction, and §2 pins that the
bytes are the SAME on each. A rule placed in a repo doc would not.

⚠ THE STABILITY HALF IS NOT DECORATION (§8). `identity_prompt` is the cached
prefix; D-181 exists because live values in it cost this machine ~197M
redundant cache-write tokens. A block of account guidance that interpolated an
account name, a percentage or a reset stamp would rewrite the prefix every
turn — so §8 asserts the text carries no telemetry and that identity bytes do
not move when the usage board does.

MEASURED RED BEFORE THE CHANGE (against main's supervisor.py): §1, §2, §3, §4,
§5, §6, §7b, §8a, §9 — main has no such block at all. Green before and after:
§7a (the cache-continuity block was already there) and §8b/§8c (identity was
already stable and already free of usage telemetry), which are the controls
that a "fix" consisting of pasting the board into the prompt would fail.

    python -B tests/test_account_lane_doctrine.py
"""
import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='lane-doctrine-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'lane-doctrine-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import cachecontinuity, ledger, store                   # noqa: E402
from orgtree import supervisor as sup                                # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def norm(text):
    """Case-folded, whitespace-flattened — a pin on the RULE, not on line
    wrapping. Re-flowing the paragraph must not turn this suite red; deleting
    the rule must."""
    return re.sub(r'\s+', ' ', str(text or '')).lower()


class AccountLaneDoctrine(unittest.TestCase):
    def setUp(self):
        slug = 'lanedoc-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug

    def agent(self, tier='opus', name=None, parent=None, grant=0, **kw):
        # an AGENT actor may state no defaults (ledger §4.2), so the explicit
        # scope goes in here rather than in each caller
        name = name or ('a' + uuid.uuid4().hex[:6])
        kw.setdefault('add_dirs', [])
        kw.setdefault('tools', {'bash': True, 'web': False, 'edit': True,
                                'subagents': False, 'mcp': []})
        kw.setdefault('charter', 'fixture agent')
        self.org.hire(ledger.USER if parent is None else parent,
                      parent, tier, grant, name, **kw)
        store.save_org(self.org)
        return name

    def prompt(self, *a, **kw):
        return sup.identity_prompt(self.org, self.agent(*a, **kw))

    # ── §1 the rule reaches an ordinary agent at all ───────────────────────
    def test_s1_identity_prompt_carries_the_account_lane_doctrine(self):
        text = self.prompt()
        self.assertIn(sup.ACCOUNT_LANE_DOCTRINE, text,
                      'the account-balancing rule is not in the managed prompt')
        # positive control on the fixture itself: if `identity_prompt` were
        # returning something degenerate, every other assertion here would
        # pass vacuously on an empty string.
        self.assertGreater(len(text), 2000, 'identity prompt looks degenerate')

    # ── §2 ONE rule, identical on every provider lane ──────────────────────
    def test_s2_every_provider_tier_gets_the_same_bytes(self):
        # claude, codex and antigravity legs all render `identity_prompt`
        # (.orgtree-identity.md / AGENTS.md / developer_instructions), so a
        # tier-dependent block would be a lane telling agents something else.
        seen = {}
        for tier in ('fable', 'opus', 'haiku', 'luna', 'sol', 'flash'):
            text = sup.identity_prompt(self.org, self.agent(tier))
            self.assertIn(sup.ACCOUNT_LANE_DOCTRINE, text, tier)
            # the slice as it actually lands, not the constant re-asserted
            start = text.index(sup.ACCOUNT_LANE_DOCTRINE)
            seen[tier] = text[start:start + len(sup.ACCOUNT_LANE_DOCTRINE)]
        self.assertEqual(len(set(seen.values())), 1,
                         f'the rule differs per lane: {sorted(seen)}')

    # ── §3 rule one: distant reset everywhere → prefer the lower usage ─────
    def test_s3_distant_reset_prefers_the_less_used_account(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('far from its reset', body)
        self.assertIn('lower usage', body)
        self.assertIn('more remaining capacity', body)

    # ── §4 rule two: a nearer reset is spent FIRST ─────────────────────────
    def test_s4_sooner_reset_is_spent_first(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('resets sooner than another', body)
        self.assertIn('sooner-resetting account', body)
        self.assertIn('first', body)
        self.assertIn('later-resetting account alone', body)
        # the two rules must be ORDERED, or an agent reading rule (1) alone
        # would preserve the low-usage account the user wants spent first
        self.assertLess(body.index('far from its reset'),
                        body.index('resets sooner than another'),
                        'the distant-reset case must be stated before the '
                        'nearer-reset case that overrides it')

    # ── §5 claude accounting: fable spends two limits, opus spends one ─────
    def test_s5_fable_spends_both_weekly_limits_and_lower_tiers_one(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('fable model spends both the standard weekly limit and '
                      'the separate fable weekly limit', body)
        self.assertIn('opus', body)
        self.assertIn('spend only the standard weekly limit', body)

    # ── §6 codex accounting: reserve first, and the two exceptions ─────────
    def test_s6_luna_is_reserve_only_until_reserve_is_full(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('luna accumulates only in the gpt-reserve limit', body)
        self.assertIn('does not touch the normal weekly limit at all until '
                      'reserve is completely full', body)
        # BOTH exceptions the user named, not one of them
        self.assertIn('reserve preference off', body)
        self.assertIn('gpt-reserve lane is unavailable', body)

    def test_s6b_the_reserve_rule_matches_the_router_it_describes(self):
        """The prose is checked against the code it claims to describe, so a
        later change to the route cannot leave the instructions lying."""
        from orgtree import codex_route
        self.assertEqual(codex_route.ROUTED_TIER, 'luna')
        self.assertEqual(codex_route.RESERVE_MODEL, 'gpt-reserve')
        board = {'stale': False, 'complete': True,
                 'pools': {'reserve': {'used_percent': 10.0}}}

        def route(prefer):
            return codex_route.resolve('luna', login_kind='subscription',
                                       board=board, marks={}, account='acct',
                                       now=1_800_000_000.0,
                                       prefer_reserve=prefer)
        # reserve-first is the DEFAULT — the prose's main clause
        self.assertEqual(route(True)['pool'], codex_route.RESERVE_POOL)
        # …and the user's "unless that setting is disabled" exception is real
        self.assertEqual(route(False)['pool'], codex_route.PLAN_POOL)

    # ── §6c the 100% rule: a hard bar, and it is PER ACCOUNT ──────────────
    def test_s6c_a_window_at_100_percent_bars_that_model_on_that_account(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('never start a model on an account where a window it '
                      'spends is at 100%', body)
        self.assertIn('hard ineligibility, not a preference', body)
        # the user's two worked examples, by name
        self.assertIn('no astra on a codex account whose weekly window is '
                      'full', body)
        self.assertIn('no fable on a claude account whose fable weekly '
                      'window is full', body)

    def test_s6d_exhaustion_discards_one_pair_not_the_whole_model(self):
        """The user's correction of 2026-09-12: an exhausted allowance on ONE
        account says nothing about the same model on another."""
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('per account, not per model', body)
        self.assertIn('discard only the exhausted account-and-model pair', body)
        self.assertIn('judge the same model on every other compatible account',
                      body)
        self.assertIn('only once every one of them is ineligible or '
                      'unreadable', body)

    def test_s6e_eligibility_is_spelled_out_for_each_tier_family(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        # fable: BOTH windows on that one account
        self.assertIn("fable needs both that account's standard claude weekly "
                      "window and its fable weekly window under 100%", body)
        # opus/lower: the fable-only window is not theirs to be blocked by
        self.assertIn('ignore the fable-only window', body)
        # codex ordinary tiers
        self.assertIn("astra and the ordinary codex tiers need that codex "
                      "account's standard weekly window", body)
        # luna: reserve keeps it alive past a full standard weekly…
        self.assertIn('luna stays eligible on an account whose standard '
                      'weekly window is full', body)
        # …and the three ways that stops being true
        self.assertIn('when reserve is disabled, unavailable, or itself at '
                      '100%', body)

    # ── §6f uncertainty is reported, never filled in ──────────────────────
    def test_s6f_missing_readings_are_named_and_never_read_as_zero(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        for reason in ('unavailable(no-cache)', 'unavailable(stale)',
                       'unavailable(unsupported)'):
            self.assertIn(reason, body)
        self.assertIn('none of those is zero and none of them is room', body)
        self.assertIn('never invent a number the board did not give you', body)

    def test_s6g_the_reasons_it_names_are_the_ones_the_board_emits(self):
        """The prose quotes the board's own words. If `turnusage` renames a
        reason, this goes red rather than leaving agents matching on a string
        that is no longer printed anywhere."""
        from orgtree import turnusage
        import inspect
        rendered = inspect.getsource(turnusage)
        for reason in ('unavailable(no-cache)', 'unavailable(stale)',
                       'unavailable(unsupported)'):
            self.assertIn(reason, rendered)
        self.assertIn(turnusage.ROSTER.rstrip(':'),
                      norm(sup.ACCOUNT_LANE_DOCTRINE),
                      'the rule points at a roster line by a name the board '
                      'does not use')

    # ── §6h the rule names the ACTION, not just the comparison ─────────────
    def test_s6h_it_says_which_field_places_work_on_an_account(self):
        """Coordinator review 2026-09-12, and the user's answer to it: "the
        agent hire / rehire / retool tools should be able to decide which
        account to hire on". Guidance that stops at "prefer the account with
        room" leaves an agent holding a conclusion and no move — so the rule
        has to name the field, and the value that field takes."""
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('`account=`', body)
        for tool in ('orgtree_hire', 'orgtree_rehire', 'orgtree_retool',
                     'orgtree_staff'):
            self.assertIn(tool, body, f'{tool} takes `account` and the rule '
                                      f'never mentions it')
        # and the two traps: the board prints four things per account and only
        # one of them binds; a wrong-provider id is refused, not ignored
        self.assertIn('labels and emails never redirect billing',
                      body)
        self.assertIn('qualified primary names must match the target provider', body)

    def test_s6i_the_tools_it_names_really_take_the_field(self):
        """The prose quotes four tool names and a parameter name. If any of
        them stopped taking `account`, this goes red rather than leaving every
        agent on the machine acting on an instruction the API refuses."""
        from orgtree import mcptool
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        for card in mcptool.TOOLS:
            if card['name'] in body:
                with self.subTest(tool=card['name']):
                    props = card['inputSchema']['properties']
                    self.assertIn('account', props,
                                  f"the rule tells agents to pass `account` to "
                                  f"{card['name']}, which does not take it")

    def test_s6j_and_the_roster_really_prints_that_value(self):
        """The other end of the same seam: the rule says to read `account=<id>`
        off the roster, so the roster has to write it."""
        from orgtree import turnusage
        import inspect
        self.assertIn('account={name}',
                      inspect.getsource(turnusage._roster_entry),
                      'the roster no longer prints the id the rule tells '
                      'agents to pass')

    # ── §7 it contradicts nothing already in the prompt ────────────────────
    def test_s7a_cache_continuity_doctrine_is_still_there(self):
        # control: green before and after. If a change to the prompt dropped
        # this, the account rule's closing sentence would point at nothing.
        self.assertIn(cachecontinuity.CACHE_CONTINUITY_BLOCK, self.prompt())

    def test_s7b_the_rule_defers_to_binding_fallback_and_cache_continuity(self):
        body = norm(sup.ACCOUNT_LANE_DOCTRINE)
        self.assertIn("does not override an agent's account binding", body)
        self.assertIn('fallback order', body)
        self.assertIn('new cache namespace', body)

    def test_s7c_it_sits_under_the_cache_doctrine_it_refers_back_to(self):
        text = self.prompt()
        self.assertLess(text.index(cachecontinuity.CACHE_CONTINUITY_BLOCK),
                        text.index(sup.ACCOUNT_LANE_DOCTRINE),
                        'the rule says "the cache-continuity rules above"')

    # ── §8 stable identity: a rule, never telemetry ────────────────────────
    def test_s8a_the_block_carries_no_live_values(self):
        block = sup.ACCOUNT_LANE_DOCTRINE
        # `100%` is the RULE'S THRESHOLD — a constant, the same bytes every
        # turn. Any OTHER percentage would be somebody's live reading, which
        # is what must never be written into the cached prefix.
        self.assertEqual({p for p in re.findall(r'\d+\s?%', block)}, {'100%'},
                         'a live usage percentage leaked into the prompt')
        self.assertNotRegex(block, r'\d{4}-\d{2}-\d{2}T', 'a reset stamp leaked in')
        self.assertNotRegex(block, r'\{[a-z_]+\}', 'a formatting field leaked in')
        # the only dates it may carry are the user-ruling stamps, which are
        # history and do not move
        self.assertEqual(set(re.findall(r'\d{4}-\d{2}-\d{2}', block)),
                         {'2026-09-12'})

    def test_s8b_identity_bytes_do_not_move_between_turns(self):
        nid = self.agent()
        self.assertEqual(sup.identity_prompt(self.org, nid),
                         sup.identity_prompt(self.org, nid))

    def test_s8c_identity_is_unchanged_while_the_usage_board_changes(self):
        """The board is dynamic; the rule for reading it is not. This is the
        whole reason the guidance lives in identity and the numbers do not."""
        nid = self.agent()
        before = sup.identity_prompt(self.org, nid)
        boards = {sup.turn_usage_block(self.org, nid, now=t)
                  for t in (1_800_000_000.0, 1_800_090_000.0)}
        self.assertEqual(before, sup.identity_prompt(self.org, nid))
        # control: the board really is the moving part (its `as of` stamp
        # differs), so the equality above is not two identical no-ops
        self.assertEqual(len(boards), 2, 'the usage board never moved')

    # ── §9 coordinators AND workers, whatever they can see ─────────────────
    def test_s9_reaches_a_manager_a_worker_and_a_self_scoped_agent(self):
        boss = self.agent('opus', org_visibility='subtree', grant=2)
        worker = self.agent('luna', parent=boss, org_visibility='self')
        for nid in (boss, worker):
            self.assertIn(sup.ACCOUNT_LANE_DOCTRINE,
                          sup.identity_prompt(self.org, nid), nid)
        # and the assigning half is addressed, not just the spending half
        self.assertIn('assigning work to another agent',
                      norm(sup.ACCOUNT_LANE_DOCTRINE))


if __name__ == '__main__':
    unittest.main(verbosity=2)
