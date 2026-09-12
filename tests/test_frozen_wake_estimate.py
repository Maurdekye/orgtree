"""The frozen badge shows the agent's REAL wake estimate (user report
2026-09-12, screenshots image-84/image-86).

A fable agent parked until 3:30pm — with that time on its freeze record and
printed in the Usage modal as "fable limited until 9/12/2026, 3:30:00 PM
(inferred)" — wore the badge `usage limit · capacity available — ▶ to resume`.
Two halves of one bug:

  · `api._rederive_freeze_reset` protected only `reset_src in
    ("text","provider")` and let the LEGACY roster (`accounts.resolve`)
    overwrite everything else. That roster never learns registry account ids
    (`accounts.record_limit` refuses unknowns by design), so for every
    registry-BOUND node it answers "available" unconditionally — and the
    estimate was erased on every one of them.
  · `ledger.tree()` rebuilds `frozen` key by key and never named
    `provenance`, so the "(inferred)" marker the Usage modal prints could not
    reach the badge at all.

THE MANDATORY PRECEDENCE (user ruling 2026-09-12): the specific 429 first;
authoritative usage/reset data only when that 429 is inconclusive; the roster
only when the record carries no live deadline at all. A weaker fallback never
overwrites explicit provider timing, and a wake estimate is never erased.

⚠ THE ROSTER IS INJECTED, NOT WRITTEN. `_rederive_freeze_reset` memoises
`accounts.resolve` per tier in the `cache` argument, so a pre-filled cache
states the roster's answer exactly — and the legacy roster refuses writes
under ORGTREE_DESKTOP_MANAGED anyway. The registry (the CURRENT source, and
the one Usage renders) is written for real.

Run:  python -m unittest tests.test_frozen_wake_estimate -v
"""
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix='v2-wake-estimate-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name,
                  USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    raise unittest.SkipTest(
        'store.DATA_ROOT already bound elsewhere in this process; '
        'run this file on its own (see tests/test_lazydoc_bool.py)')

from orgtree import accounts, api, registry  # noqa: E402

_SLUGS = []


def tearDownModule():
    for slug in list(_SLUGS):
        store._POOL.close_all(slug)
    _root.cleanup()


class _Req:
    def __init__(self):
        self.state = types.SimpleNamespace()
        self.headers = {}
        self.url = types.SimpleNamespace(path='/api/orgs/x')


OPEN = {'available': True, 'refresh_at': None}


def marked(ts):
    return {'available': False, 'refresh_at': ts}


class WakeEstimateTests(unittest.TestCase):
    """The projection in isolation: one freeze record in, one badge out."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self):
        WakeEstimateTests._seq += 1
        return registry.create_account(
            'claude', 't',
            {'kind': 'managed',
             'path': os.path.join(_root.name, f'wake-{self._seq}')})

    def _node(self, tier='fable', **freeze):
        """A tree-payload node, shaped as `ledger.tree()` projects it. ⚠ The
        payload field is `tier`; the node DOCUMENT calls it `model`."""
        fz = {'limit': True, 'at': '2026-09-12T12:00:00Z'}
        fz.update(freeze)
        return {'tier': tier, 'frozen': fz}

    def _derive(self, node, roster=OPEN):
        """`roster` is what `accounts.resolve` would answer for this tier."""
        api._rederive_freeze_reset(node, {node['tier']: dict(roster)})
        return node['frozen']

    # ------------------------------------------------------------------ §1
    # THE REPRODUCTION. A registry-bound fable freeze carrying the account's
    # own mark — the number Usage prints — against a roster that says the tier
    # is wide open, which for a registry id it ALWAYS does.
    def test_bound_fable_mark_survives_an_open_roster(self):
        row = self._account()
        until = time.time() + 37 * 60          # "resets in 37m" → 3:30pm
        registry.record_mark(row['id'], 'fable', until=until,
                             provenance='inferred')
        # THE SPLIT THAT MADE THIS A BUG: the registry knows fable is out
        # until 3:30pm and the legacy roster carries nothing for it — it never
        # learns registry ids, so it can only answer "open" (a signed-in
        # ambient login) or "nothing known". Both used to erase the estimate,
        # so both are driven.
        self.assertIsNone(accounts.resolve('fable')['refresh_at'],
                          'precondition: the legacy roster holds no fable mark')
        self.assertIsNotNone(registry.active_mark(row['id'], 'fable'),
                             'precondition: the registry holds one')

        for roster in (OPEN, {'available': False, 'refresh_at': None}):
            with self.subTest(roster=roster):
                fz = self._derive(self._node(
                    'fable', until_ts=until, reset_src='account-mark',
                    provenance='inferred', schedule_kind='probe'), roster)
                self.assertEqual(
                    fz['until_ts'], until,
                    'the estimate must survive — this is the whole bug')
                self.assertIn('capacity recheck', fz['until'])
                self.assertNotIn('capacity available', fz['until'])
                self.assertNotIn('▶', fz['until'])

    # ------------------------------------------------------------------ §2
    # EXPLICIT 429 — the specific response named a time. Nothing may move it.
    def test_explicit_429_outranks_everything(self):
        stated = time.time() + 30 * 60
        later = time.time() + 3 * 3600
        # a roster holding a LATER time, and a roster saying "open": neither
        # may touch a deadline the provider stated for this turn
        for roster in (OPEN, marked(later)):
            for src in ('text', 'provider'):
                with self.subTest(src=src, roster=roster):
                    fz = self._derive(self._node(
                        'fable', until_ts=stated, reset_src=src,
                        schedule_kind='observed-deadline'), roster)
                    self.assertEqual(fz['until_ts'], stated)
                    self.assertIn('capacity resets', fz['until'])
                    self.assertNotIn('recheck', fz['until'])

    # ------------------------------------------------------------------ §3
    # AMBIGUOUS 429 + USAGE FALLBACK — the response said nothing usable, so
    # the account's own usage readout answered. That is a real estimate and is
    # displayed; it is only ever a FALLBACK, never a thing that overwrites §2.
    def test_ambiguous_429_falls_back_to_the_usage_readout(self):
        until = time.time() + 42 * 60
        fz = self._derive(self._node(
            'opus', until_ts=until, reset_src='usage:session',
            schedule_kind='observed-deadline'))
        self.assertEqual(fz['until_ts'], until)
        self.assertIn('capacity resets', fz['until'])

        # …and when the readout had to BORROW a lane, the supervisor records
        # it as `probe` and the words must stop promising a reset
        fz = self._derive(self._node(
            'opus', until_ts=until, reset_src='usage:weekly_all',
            schedule_kind='probe'))
        self.assertEqual(fz['until_ts'], until)
        self.assertIn('capacity recheck', fz['until'])

    # ------------------------------------------------------------------ §4
    # NO ESTIMATE — nothing live on the record, nothing on the roster.
    # Neutral limited-state text: no invented countdown, no claim about
    # capacity, no instruction to resume by hand (that copy is retired).
    def test_no_estimate_says_so_and_claims_nothing(self):
        for fz_in in ({'until_ts': None, 'reset_src': 'probe'},
                      {'until_ts': time.time() - 60, 'reset_src': 'probe'},
                      {'until_ts': None, 'reset_src': ''}):
            with self.subTest(**fz_in):
                fz = self._derive(self._node('fable', **fz_in))
                self.assertEqual(fz['until'], 'reset time unknown')
                self.assertIsNone(fz['until_ts'])

    def test_an_elapsed_429_is_kept_because_the_node_is_due(self):
        """⚠ CHANGED DELIBERATELY (user ruling 2026-09-12, coordinator
        decision): an elapsed conclusive 429 used to fall through to "reset
        time unknown". It is kept now, because the moment the provider named
        is when this node is DUE and it is owed one real attempt then. The
        scheduler says ready at the same instant — one number — and dropping
        it here would put the badge back out of step with the timer.

        An elapsed weak source still falls through: nothing there was owed an
        attempt (the case above)."""
        past = time.time() - 60
        for src in ('text', 'provider'):
            with self.subTest(src=src):
                fz = self._derive(self._node('fable', until_ts=past,
                                             reset_src=src))
                self.assertEqual(fz['until_ts'], past)
                self.assertNotEqual(fz['until'], 'reset time unknown')

    def test_an_open_roster_never_offers_manual_resume(self):
        """THE RETIRED COPY. `capacity available — ▶ to resume` came out of
        exactly one branch — the roster answering "available" for a freeze
        with no live deadline — so the branch is driven directly rather than
        trusted to be unreachable."""
        fz = self._derive(self._node('fable', until_ts=None,
                                     reset_src='probe'), OPEN)
        self.assertNotIn('▶', fz['until'])
        self.assertNotIn('resume', fz['until'])
        self.assertNotIn('capacity available', fz['until'])

    # ------------------------------------------------------------------ §5
    # THE ROSTER STILL HAS A JOB — a stale record with no live deadline is
    # exactly what it is for. The guard against "fixed it by never asking".
    def test_the_roster_answers_a_record_with_no_live_deadline(self):
        refresh = time.time() + 90 * 60
        fz = self._derive(self._node('opus', until_ts=None,
                                     reset_src='probe'), marked(refresh))
        self.assertAlmostEqual(fz['until_ts'], refresh, delta=1.0)
        self.assertIn('capacity resets', fz['until'])

    # ------------------------------------------------------------------ §6
    # THE OTHER FREEZE KINDS ARE NOT TOUCHED. Each names its own remedy, and
    # re-deriving would replace that with a capacity report — true, and the
    # exact opposite of what to do (D-156).
    def test_other_freeze_kinds_keep_their_own_words(self):
        for fz_in, why in (
            ({'cause': 'auth',
              'until': 'credential rejected — replace it, then resume',
              'until_ts': None}, 'auth freeze'),
            ({'cause': 'balance', 'until': 'balance refused — check balance',
              'until_ts': None}, 'balance freeze'),
            ({'connection': True,
              'until': 'network interruption — attempt 1/4',
              'until_ts': time.time() + 30}, 'connection freeze'),
        ):
            with self.subTest(why):
                want = fz_in['until']
                fz = self._derive(self._node('fable', **fz_in))
                self.assertEqual(fz['until'], want, why)

    def test_a_halted_fable_node_is_left_alone(self):
        """`limit_locked` — the org-wide fable lock. Its clock can never fire,
        so the badge says HALTED and this function must not write a time
        beside it."""
        node = self._node('fable', until='HALTED', until_ts=None)
        node['limit_locked'] = True
        fz = self._derive(node)
        self.assertEqual(fz['until'], 'HALTED')

    def test_an_unknown_tier_is_left_alone(self):
        """The roster answers for the known claude tiers; a codex/openrouter
        node is somebody else's lane and keeps what its own path stamped.

        ⚠ Only the neutral-text branch is scoped this way — that branch exists
        to replace what the legacy CLAUDE roster said, and a lane with no
        roster has nothing to correct. Its TIMING is re-derived like everyone
        else's; see `test_a_non_claude_lane_reads_its_own_account_mark`."""
        fz = self._derive(self._node(
            'gpt-5.6', until='capacity resets soon', until_ts=None))
        self.assertEqual(fz['until'], 'capacity resets soon')

    def test_a_non_claude_lane_reads_its_own_account_mark(self):
        """⚠ ROUND 5. `tier not in accounts.TIERS` sat at the HEAD of the
        re-derivation, so every Luna, Codex, Antigravity and OpenRouter seat
        skipped it entirely — while `auto_resume_ready` had been reading their
        registry marks through the shared contract since round 3. A bound Luna
        freeze showed its own probe +300 and woke on the account's +1800: the
        same disagreement the whole item is about, one provider over.

        The registry marks these lanes and the Usage modal prints them, so the
        badge must read them too. Only the ROSTER rank is Claude-only."""
        from orgtree import supervisor
        acct = registry.create_account(
            'openai', 't', {'kind': 'managed',
                            'path': os.path.join(_root.name, 'wake-luna')})
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'luna', until=mine,
                             provenance='observed')
        fz = {'limit': True, 'at': 'x', 'account': acct['id'],
              'provider': supervisor.providers.provider_of('luna'),
              'until_ts': time.time() + 300, 'reset_src': 'probe'}
        node = {'tier': 'luna', 'account': acct['id'], 'frozen': dict(fz)}
        api._rederive_freeze_reset(node, {})
        self.assertAlmostEqual(node['frozen']['until_ts'], mine, delta=1.0)
        self.assertEqual(node['frozen']['reset_src'], 'account-mark')
        # …and the scheduler was already saying exactly this
        eff = supervisor.effective_freeze_deadline(
            fz, registry.active_mark(acct['id'], 'luna'), time.time())
        self.assertAlmostEqual(eff['ts'], mine, delta=1.0)

    # ------------------------------------------------------------------ §7
    # NON-FABLE (the pooled tiers) take exactly the same route. The bug was
    # reported on fable, but nothing about it is fable-specific: it is the
    # registry-id/legacy-roster split, which every bound node shares.
    def test_the_pooled_tiers_are_not_a_special_case(self):
        row = self._account()
        until = time.time() + 55 * 60
        for tier in ('opus', 'sonnet', 'haiku'):
            with self.subTest(tier=tier):
                registry.record_mark(row['id'], tier, until=until,
                                     provenance='observed')
                self.assertIsNone(accounts.resolve(tier)['refresh_at'],
                                  'precondition: the legacy roster sees nothing')
                fz = self._derive(self._node(
                    tier, until_ts=until, reset_src='account-mark',
                    provenance='observed', schedule_kind='observed-deadline'))
                self.assertEqual(fz['until_ts'], until)
                self.assertIn('capacity resets', fz['until'])

    # ------------------------------------------------------------------ §8
    # THE BADGE AND THE USAGE MODAL READ ONE NUMBER. Usage renders
    # `AccountStanding.marks` ("<pool> limited until …"); the badge renders
    # the projected freeze. Same mark ⇒ same instant, same provenance word.
    def test_the_badge_agrees_with_the_usage_modal(self):
        row = self._account()
        until = time.time() + 37 * 60
        registry.record_mark(row['id'], 'fable', until=until,
                             provenance='inferred')
        modal = registry.standing_of(
            registry.get_account(row['id']))['marks']['fable']

        fz = self._derive(self._node(
            'fable', until_ts=until, reset_src='account-mark',
            provenance=modal['provenance'], schedule_kind='probe'))

        self.assertAlmostEqual(fz['until_ts'], modal['until'], delta=1.0,
                               msg='badge and Usage must name one instant')
        self.assertEqual(fz['provenance'], modal['provenance'])

    # ------------------------------------------------------------------ §9
    # THE WORDS, AS A TABLE. "capacity resets X" claims capacity RETURNS at X
    # and may only be said of a measured deadline; everything else is a
    # bounded recheck and says so.
    def test_capacity_label_keeps_a_measured_deadline_measured(self):
        ts = time.time() + 1800
        for src, kind, want in (
            ('text', 'observed-deadline', 'capacity resets'),
            ('provider', 'observed-deadline', 'capacity resets'),
            ('account-mark', 'observed-deadline', 'capacity resets'),
            ('usage:session', 'observed-deadline', 'capacity resets'),
            ('account-mark', 'probe', 'capacity recheck'),
            ('probe', 'probe', 'capacity recheck'),
            ('inherited', '', 'capacity recheck'),
            # an older record with no `schedule_kind` at all falls back to the
            # source test rather than silently promoting a probe floor
            ('text', '', 'capacity resets'),
        ):
            with self.subTest(src=src, kind=kind):
                self.assertTrue(
                    api._capacity_label(ts, src, kind).startswith(want),
                    api._capacity_label(ts, src, kind))


class MarkVersusMessageTests(unittest.TestCase):
    """`supervisor._mark_supersedes_message` — the freeze-stamp half of the
    precedence, and the half that made the projection's job impossible.

    The account mark is written from the SAME 429 moments earlier, so the two
    normally name one instant — and the stamp overwrote `reset_src` with
    "account-mark" anyway. That threw away the one fact saying a provider had
    stated this time, after which `_rederive_freeze_reset` (which keys on that
    field) could not tell a measured deadline from a guess."""

    def test_the_mark_may_not_relabel_a_deadline_it_did_not_move(self):
        from orgtree import supervisor
        msg = time.time() + 1800
        for src in ('text', 'provider'):
            for mark in (msg, msg - 300):     # equal, and earlier
                with self.subTest(src=src, delta=mark - msg):
                    self.assertFalse(
                        supervisor._mark_supersedes_message(mark, msg, src),
                        'a fallback overwrote explicit provider timing')

    def test_not_even_a_later_mark_may_replace_a_conclusive_429(self):
        """The change perf-review required. A mark that outlives the stated
        time is a fact about ADMISSION, and admission is reconciled on its own
        field — it is not authorization to rewrite what the provider said."""
        from orgtree import supervisor
        msg = time.time() + 1800
        for src in ('text', 'provider'):
            with self.subTest(src=src):
                self.assertFalse(
                    supervisor._mark_supersedes_message(msg + 300, msg, src),
                    'a later fallback overwrote explicit provider timing')

    def test_an_inconclusive_429_hands_the_answer_to_the_mark(self):
        from orgtree import supervisor
        now = time.time()
        for src, ts in (('probe', None), ('', None), ('inherited', now + 60),
                        ('usage:session', now + 60), ('text', None)):
            with self.subTest(src=src, ts=ts):
                self.assertTrue(
                    supervisor._mark_supersedes_message(now + 900, ts, src),
                    'nothing was protecting this deadline')


class WakeFollowsWhatIsShownTests(unittest.TestCase):
    """USER RULING 2026-09-12, answering this exact question on the docket:
    "the wake timer should follow whats shown, and what's shown should always
    take precedence from the 429 error, not from usage."

    An interim version of this fix kept a later account mark on a private
    `frozen.admit_ts` and had `auto_resume_ready` wait for it, so a node could
    display 30 minutes and sleep for 2 hours. The user was asked and chose one
    number. These tests are what stop it coming back."""

    def _org(self, **fz):
        from orgtree import ledger
        org = ledger.Org.create('shown-' + str(id(fz))[-6:])
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        org.node(nid)['frozen'] = {'limit': True, 'provider': 'claude',
                                   'at': 'x', **fz}
        return org, nid

    def test_the_wake_fires_at_the_shown_time(self):
        from orgtree import supervisor
        now = time.time()
        org, nid = self._org(until_ts=now - 120, reset_src='text',
                             until='capacity resets 3:23pm')
        self.assertIn(nid, supervisor.auto_resume_ready(org, now=now))

    def test_nothing_delays_the_wake_past_the_shown_time(self):
        """The regression guard. A stray `admit_ts` on the record — an old
        document, or this field reintroduced — must not hold the node back."""
        from orgtree import supervisor
        now = time.time()
        org, nid = self._org(until_ts=now - 120, reset_src='text',
                             until='capacity resets 3:23pm',
                             admit_ts=now + 7200)
        self.assertIn(nid, supervisor.auto_resume_ready(org, now=now),
                      'a hidden later deadline is delaying the wake')

    def test_the_shown_time_is_not_yet_due(self):
        from orgtree import supervisor
        now = time.time()
        org, nid = self._org(until_ts=now + 1800, reset_src='text',
                             until='capacity resets 3:30pm')
        self.assertNotIn(nid, supervisor.auto_resume_ready(org, now=now))

    def test_the_supervisor_no_longer_carries_an_admission_floor(self):
        from orgtree import supervisor
        self.assertFalse(hasattr(supervisor, '_admission_floor'),
                         'the hidden admission floor is back')


class ShownAndScheduledAgreeTests(unittest.TestCase):
    """THE CONTRACT, end to end (review round 3). The badge and the wake timer
    must name the same instant for the same record.

    They came apart because the re-derivation was PROJECTION-ONLY:
    `_rederive_freeze_reset` ranked the sources on the tree payload and wrote
    nothing durable, while `auto_resume_ready` read the stamped
    `frozen.until_ts` off the document. Both ask
    `supervisor.effective_freeze_deadline` now, and these are the two
    disagreements perf-review reproduced."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _fixture(self, mark_at, **fz):
        """A real bound node with a real registry account, plus the payload the
        desk would repaint from — built from the SAME durable record."""
        import copy
        from orgtree import ledger
        ShownAndScheduledAgreeTests._seq += 1
        seq = ShownAndScheduledAgreeTests._seq
        acct = registry.create_account(
            'claude', 't', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'agree-{seq}')})
        if mark_at:
            registry.record_mark(acct['id'], 'fable', until=mark_at,
                                 provenance='observed')
        org = ledger.Org.create(f'agree-{seq}')
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        org.node(nid)['account'] = acct['id']
        org.node(nid)['frozen'] = {'limit': True, 'provider': 'claude',
                                   'account': acct['id'], 'at': 'x', **fz}
        _SLUGS.append(org.d['slug'])
        payload = {'tier': 'fable', 'account': acct['id'],
                   'frozen': copy.deepcopy(org.node(nid)['frozen'])}
        api._rederive_freeze_reset(payload, {})
        return org, nid, acct['id'], payload['frozen']

    def _assert_agree(self, org, nid, acct, payload_fz, offsets):
        """⚠ BOTH READERS ARE ASKED AT THE SAME INSTANT. `_rederive_freeze_
        reset` reads the wall clock, so the badge cannot be re-derived for a
        future `at`; the contract can, and the badge IS the contract — pinned
        by the first assertion here. Moving the scheduler back onto a raw
        `frozen.until_ts` breaks this test, which is its whole job."""
        from orgtree import supervisor
        now = time.time()
        fzdoc = org.node(nid)['frozen']
        shown_now = supervisor.effective_freeze_deadline(
            fzdoc, registry.active_mark(acct, 'fable'), now)
        # the badge renders exactly what the contract said, at this instant
        self.assertEqual(payload_fz.get('until_ts'),
                         shown_now['ts'] if shown_now else None)
        promised = shown_now['ts'] if shown_now else None
        for off in offsets:
            at = now + off
            with self.subTest(at=off):
                eff = supervisor.effective_freeze_deadline(
                    fzdoc, registry.active_mark(acct, 'fable'), at)
                ready = nid in supervisor.auto_resume_ready(org, now=at)
                if eff is None:
                    # ⚠ NOT A FREE PASS (review round 4: this used to just
                    # `continue`, so a time the badge had already PROMISED
                    # could be dropped on the way here and nothing noticed).
                    # No source can name a time now — but if one did earlier,
                    # that moment has to have arrived, not evaporated.
                    if promised is not None and at >= promised + 60.0:
                        self.assertTrue(
                            ready,
                            f'promised {promised - now:+.0f}s and then stopped '
                            f'naming a time — the wake was lost')
                    continue
                promised = float(eff['ts'])
                self.assertEqual(
                    ready, at >= float(eff['ts']) + 60.0,
                    f'shown {eff["src"]}@{eff["ts"] - now:+.0f}s, ready={ready}')

    def test_a_weak_horizon_under_a_live_mark(self):
        """perf-review's first reproduction: badge +1800, timer +300."""
        now = time.time()
        org, nid, acct, fz = self._fixture(now + 1800, until_ts=now + 300,
                                           reset_src='probe')
        self.assertAlmostEqual(fz['until_ts'], now + 1800, delta=2.0)
        self._assert_agree(org, nid, acct, fz, (0, 400, 1000, 1861, 1900))

    def test_an_elapsed_429_under_a_longer_mark(self):
        """perf-review's second: ready now, badge showing the mark's +1800."""
        now = time.time()
        org, nid, acct, fz = self._fixture(now + 1800, until_ts=now - 120,
                                           reset_src='text')
        self.assertAlmostEqual(fz['until_ts'], now - 120, delta=2.0)
        self._assert_agree(org, nid, acct, fz, (0, 400, 1900))

    def test_a_live_429_under_a_longer_mark(self):
        now = time.time()
        org, nid, acct, fz = self._fixture(now + 7200, until_ts=now + 1800,
                                           reset_src='text')
        self.assertAlmostEqual(fz['until_ts'], now + 1800, delta=2.0)
        self._assert_agree(org, nid, acct, fz, (0, 1000, 1861, 1900, 7300))

    def test_a_record_with_no_horizon_but_a_live_mark(self):
        now = time.time()
        org, nid, acct, fz = self._fixture(now + 1800, until_ts=None,
                                           reset_src='probe')
        self.assertAlmostEqual(fz['until_ts'], now + 1800, delta=2.0)
        self._assert_agree(org, nid, acct, fz, (0, 1000, 1861, 1900))

    def test_an_unbound_node_still_agrees(self):
        """No mark anywhere — rank 3 on both sides."""
        now = time.time()
        org, nid, acct, fz = self._fixture(None, until_ts=now + 300,
                                           reset_src='inherited')
        self.assertAlmostEqual(fz['until_ts'], now + 300, delta=2.0)
        self._assert_agree(org, nid, acct, fz, (0, 200, 361, 500))


class SharedFallbackRanksTests(unittest.TestCase):
    """ROUND 4, the other half of "one number": every rank the BADGE can show,
    the scheduler has to see too — and the ranks that describe an ACCOUNT'S
    CAPACITY must never be applied to a freeze that is not waiting for one.

    Two ways the same bug came back after round 3 moved the ranking into
    `supervisor.effective_freeze_deadline`:

      · the roster stayed behind in `api._rederive_freeze_reset`, so a node
        with no time of its own wore the roster's "+2h" while the scheduler,
        seeing no deadline at all, fired on its 5-minute probe floor;
      · the scheduler started asking the contract about EVERY freeze, so a
        connection drop — which is not a usage wall — got parked behind an
        unrelated usage mark on its account, and an unbound one lost its own
        deadline entirely.
    """

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _node(self, mark_at=None, bind=True, **fz):
        from orgtree import ledger
        SharedFallbackRanksTests._seq += 1
        seq = SharedFallbackRanksTests._seq
        acct = registry.create_account(
            'claude', 't', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'rank-{seq}')})
        if mark_at:
            registry.record_mark(acct['id'], 'fable', until=mark_at,
                                 provenance='observed')
        org = ledger.Org.create(f'rank-{seq}')
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        if bind:
            org.node(nid)['account'] = acct['id']
        org.node(nid)['frozen'] = {'provider': 'claude', 'at': 'x', **fz}
        _SLUGS.append(org.d['slug'])
        return org, nid, acct['id']

    def _with_roster(self, answer, fn):
        real = accounts.resolve
        accounts.resolve = lambda tier, now=None: dict(answer)
        try:
            return fn()
        finally:
            accounts.resolve = real

    # ---------------------------------------------------------------- rank 4
    def test_the_roster_rank_is_shared_with_the_scheduler(self):
        import copy
        from orgtree import supervisor
        now = time.time()
        org, nid, acct = self._node(limit=True, until_ts=None,
                                    reset_src='probe')
        org.d['auto_resume_last'] = now - 301        # the probe floor is ripe

        def _check():
            payload = {'tier': 'fable', 'account': acct,
                       'frozen': copy.deepcopy(org.node(nid)['frozen'])}
            api._rederive_freeze_reset(payload, {})
            self.assertAlmostEqual(payload['frozen']['until_ts'], now + 7200,
                                   delta=2.0, msg='the badge shows the roster')
            self.assertIn('capacity resets', payload['frozen']['until'])
            self.assertNotIn(
                nid, supervisor.auto_resume_ready(org, now=now),
                'the badge said +2h and the timer fired now — round 4')
            self.assertIn(nid, supervisor.auto_resume_ready(org,
                                                            now=now + 7300))

        self._with_roster({'available': False, 'refresh_at': now + 7200,
                           'account': None}, _check)

    def test_an_open_roster_still_says_unknown_and_still_probes(self):
        """Rank 4 answering "open" names no time, so the badge is honest and
        the org-wide probe floor keeps the node moving. Sharing the rank must
        not turn "nothing known" into a wait."""
        import copy
        from orgtree import supervisor
        now = time.time()
        org, nid, acct = self._node(limit=True, until_ts=None,
                                    reset_src='probe')
        org.d['auto_resume_last'] = now - 301

        def _check():
            payload = {'tier': 'fable', 'account': acct,
                       'frozen': copy.deepcopy(org.node(nid)['frozen'])}
            api._rederive_freeze_reset(payload, {})
            self.assertIsNone(payload['frozen']['until_ts'])
            self.assertEqual(payload['frozen']['until'], 'reset time unknown')
            self.assertIn(nid, supervisor.auto_resume_ready(org, now=now))

        self._with_roster(dict(OPEN, account=None), _check)

    # ----------------------------------------------------------- scope guard
    def test_a_connection_freeze_is_not_parked_on_a_usage_mark(self):
        """A dropped connection is not a usage wall. Its own retry deadline
        has passed, so it is ready — whatever the account's capacity says."""
        from orgtree import supervisor
        now = time.time()
        org, nid, _ = self._node(mark_at=now + 1800, connection=True,
                                 until_ts=now - 1, reset_src='connection')
        org.d['auto_resume_last'] = now
        self.assertIn(nid, supervisor.auto_resume_ready(org, now=now))

    def test_an_unbound_connection_freeze_keeps_its_own_deadline(self):
        """…and it must not lose that deadline and fall to the org's 5-minute
        floor either: with no account there is no mark to consult, and the
        record's own number is the answer."""
        from orgtree import supervisor
        now = time.time()
        org, nid, _ = self._node(bind=False, connection=True,
                                 until_ts=now - 1, reset_src='connection')
        org.d['auto_resume_last'] = now
        self.assertIn(nid, supervisor.auto_resume_ready(org, now=now))
        # and a connection freeze still WAITING is still waited for
        org.node(nid)['frozen']['until_ts'] = now + 120
        self.assertNotIn(nid, supervisor.auto_resume_ready(org, now=now))

    def test_the_contract_names_the_kinds_capacity_governs(self):
        from orgtree import supervisor
        now = time.time()
        mark = {'until': now + 1800, 'provenance': 'observed'}
        for fz, governed in (
                ({'limit': True}, True),
                ({'limit': True, 'connection': True}, False),
                ({'connection': True}, False),
                ({'limit': True, 'cause': 'auth'}, False),
                ({'limit': True, 'cause': 'balance'}, False),
                ({'limit': True, 'cause': 'account'}, True),
                ({}, False)):
            with self.subTest(fz=fz):
                self.assertEqual(
                    supervisor.freeze_waits_on_capacity(fz), governed)
                # …and the contract acts on that: only a governed freeze may
                # be moved onto the account's mark.
                eff = supervisor.effective_freeze_deadline(
                    dict(fz, at='x', until_ts=now - 1, reset_src='inherited'),
                    mark, now)
                self.assertEqual(eff['src'] == 'account-mark', governed)


class CommittedWakeTests(unittest.TestCase):
    """ROUND 5 — `frozen.wake`: THE DEADLINE THIS FREEZE WAS ALREADY PROMISED.

    The ranks are re-derived from live state on every read, which is what lets
    the badge follow account changes (round 2). But the chosen number had no
    MEMORY, so when its source went away the next read simply picked a
    different, later one and the wake the node had been promised was never
    taken. Three reproductions, one missing memory:

      · an inherited +300 that expired was replaced by the roster's +7200;
      · an account mark's +1800 vanished when `clear_expired` pruned the row,
        and the record's own inherited +7200 took over;
      · and reading elapsed marks — the round-4 attempt at the second — let an
        hour-old mark from a previous window govern a brand-new freeze.

    `supervisor.commit_wake_deadlines` records the promise on the scheduler's
    own tick; both surfaces read it off the record, so they cannot disagree.
    """

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _fixture(self, **fz):
        from orgtree import ledger
        CommittedWakeTests._seq += 1
        seq = CommittedWakeTests._seq
        acct = registry.create_account(
            'claude', 't', {'kind': 'managed',
                            'path': os.path.join(_root.name, f'wake-c{seq}')})
        org = ledger.Org.create(f'wake-c{seq}')
        org.nodes['root'] = {'state': 'live', 'parent': None, 'generation': 1,
                             'model': 'fable', 'account': acct['id']}
        org.d['auto_resume_last'] = time.time() - 301
        org.node('root')['frozen'] = {'limit': True, 'provider': 'claude',
                                      'at': 'x', 'account': acct['id'], **fz}
        _SLUGS.append(org.d['slug'])
        return org, acct['id']

    @staticmethod
    def _shown(org, cache=None):
        import copy
        n = org.node('root')
        payload = {'tier': n['model'], 'account': n.get('account'),
                   'frozen': copy.deepcopy(n['frozen'])}
        api._rederive_freeze_reset(payload, {} if cache is None else cache)
        return payload['frozen']

    def test_a_promise_outlives_the_pruned_mark_that_made_it(self):
        from orgtree import supervisor
        now = time.time()
        org, acct = self._fixture(until_ts=now + 7200, reset_src='inherited')
        registry.record_mark(acct, 'fable', until=now + 1800,
                             provenance='observed')
        supervisor.commit_wake_deadlines(org, now)
        self.assertAlmostEqual(self._shown(org)['until_ts'], now + 1800,
                               delta=2.0)
        self.assertNotIn('root', supervisor.auto_resume_ready(org, now + 1700))
        registry.clear_expired(now=now + 1861)
        self.assertIn('root', supervisor.auto_resume_ready(org, now + 1861),
                      'pruning the elapsed row took the promise with it')
        self.assertAlmostEqual(self._shown(org)['until_ts'], now + 1800,
                               delta=2.0)

    def test_a_promise_is_not_pushed_out_by_a_weaker_later_source(self):
        from orgtree import supervisor
        now = time.time()
        org, _ = self._fixture(until_ts=now + 300, reset_src='inherited')
        org.node('root').pop('account', None)
        org.node('root')['frozen'].pop('account', None)
        roster = {'fable': marked(now + 7200)}
        supervisor.commit_wake_deadlines(org, now)
        self.assertAlmostEqual(self._shown(org, roster)['until_ts'],
                               now + 300, delta=2.0)
        self.assertNotIn('root', supervisor.auto_resume_ready(org, now + 200))
        self.assertIn('root', supervisor.auto_resume_ready(org, now + 361),
                      'the roster pushed a promise that had come due')

    def test_a_promise_belongs_to_the_record_that_earned_it(self):
        """`of_ts`/`of_src` bind it: rewrite the freeze — a new 429, a re-park
        from a mark — and the old promise is dropped rather than firing a wake
        for a wall that no longer exists."""
        from orgtree import supervisor
        now = time.time()
        org, _ = self._fixture(until_ts=now + 300, reset_src='inherited')
        supervisor.commit_wake_deadlines(org, now)
        fz = org.node('root')['frozen']
        self.assertIsNotNone(supervisor._committed_wake(fz))
        fz['until_ts'], fz['reset_src'] = now + 9000, 'text'
        self.assertIsNone(supervisor._committed_wake(fz))
        self.assertNotIn('root', supervisor.auto_resume_ready(org, now + 361))

    def test_a_fresh_freeze_carries_no_promise(self):
        """Which is what keeps a previous limit window's timing away from a
        freeze taken today: `frozen` is replaced wholesale, promise and all."""
        from orgtree import supervisor
        now = time.time()
        org, acct = self._fixture(until_ts=now + 300, reset_src='probe')
        supervisor.commit_wake_deadlines(org, now)
        self.assertIsNotNone(org.node('root')['frozen'].get('wake'))
        org.node('root')['frozen'] = {'limit': True, 'provider': 'claude',
                                      'at': 'x', 'account': acct,
                                      'until_ts': now + 4000,
                                      'reset_src': 'probe'}
        self.assertIsNone(
            supervisor._committed_wake(org.node('root')['frozen']))

    def test_a_freeze_that_waits_on_nothing_carries_no_promise(self):
        """A connection drop owns its own clock, so it must not accumulate a
        capacity promise — nor keep one written before it changed kind."""
        from orgtree import supervisor
        now = time.time()
        org, _ = self._fixture(until_ts=now + 300, reset_src='probe')
        supervisor.commit_wake_deadlines(org, now)
        self.assertIn('wake', org.node('root')['frozen'])
        org.node('root')['frozen'] = {'connection': True, 'provider': 'claude',
                                      'at': 'x', 'until_ts': now + 300,
                                      'reset_src': 'connection',
                                      'wake': {'ts': now - 5, 'src': 'probe',
                                               'of_ts': now + 300,
                                               'of_src': 'connection'}}
        supervisor.commit_wake_deadlines(org, now)
        self.assertNotIn('wake', org.node('root')['frozen'],
                         'a stale promise must not linger to fire later')

    def test_asking_the_scheduler_a_question_writes_nothing(self):
        """⚠ `auto_resume_ready` stays PURE. It is asked "would this be ready
        at T?" with future clocks all over this file; if it committed, a
        hypothetical T would become a real promise on the document."""
        from orgtree import supervisor
        now = time.time()
        org, acct = self._fixture(until_ts=now + 300, reset_src='probe')
        registry.record_mark(acct, 'fable', until=now + 1800,
                             provenance='observed')
        for at in (now, now + 1000, now + 99999):
            supervisor.auto_resume_ready(org, at)
        self.assertNotIn('wake', org.node('root')['frozen'])


class OneShotGateBypassTests(unittest.TestCase):
    """Coordinator decision 2026-09-12, the narrowest path: the wake of a
    conclusive-429 freeze whose stated time has passed gets ONE real provider
    attempt, instead of being re-frozen on the spot by the pre-slot account
    gate reading an older, longer mark. Everything else stays gated."""

    def _fz(self, **kw):
        return {'limit': True, 'provider': 'claude', 'at': 'x', **kw}

    def test_an_elapsed_429_earns_the_pass(self):
        from orgtree import supervisor
        now = time.time()
        for src in ('text', 'provider'):
            with self.subTest(src=src):
                n = {'account': 'acct-1', 'model': 'fable'}
                self.assertTrue(supervisor._issue_admit_once(
                    n, self._fz(until_ts=now - 60, reset_src=src), now))
                self.assertAlmostEqual(n['admit_once']['at'], now, delta=1.0)
                # ⚠ round 4: the pass names the lane it was earned for, so a
                # rebinding cannot carry it to a different wall.
                self.assertEqual(n['admit_once']['account'], 'acct-1')
                self.assertEqual(n['admit_once']['model'], 'fable')

    def test_the_pass_names_the_freezes_account_over_the_nodes(self):
        """`freeze_account_of`: the badge names the freeze's own lane, and the
        pass is for THAT wall — a node rebound since freezing has not earned
        anything on its new account."""
        from orgtree import supervisor
        now = time.time()
        n = {'account': 'acct-new', 'model': 'fable'}
        self.assertTrue(supervisor._issue_admit_once(
            n, self._fz(until_ts=now - 60, reset_src='text',
                        account='acct-froze-on'), now))
        self.assertEqual(n['admit_once']['account'], 'acct-froze-on')

    def test_nothing_else_earns_it(self):
        """Every clause is load-bearing: the limit kind, a provider-stated
        source, and a deadline that has actually passed."""
        from orgtree import supervisor
        now = time.time()
        for fz in (
                # a wall still standing — not the wake it is owed
                self._fz(until_ts=now + 600, reset_src='text'),
                self._fz(until_ts=now + 600, reset_src='provider'),
                # the fallback sources have no standing over the gate
                self._fz(until_ts=now - 60, reset_src='probe'),
                self._fz(until_ts=now - 60, reset_src='inherited'),
                self._fz(until_ts=now - 60, reset_src='account-mark'),
                self._fz(until_ts=now - 60, reset_src='usage:session'),
                # no time at all, and not a usage-limit freeze
                self._fz(until_ts=None, reset_src='text'),
                {'connection': True, 'until_ts': now - 60,
                 'reset_src': 'text', 'at': 'x'}):
            with self.subTest(src=fz.get('reset_src'),
                              ts=fz.get('until_ts'), limit=fz.get('limit')):
                n = {}
                self.assertFalse(supervisor._issue_admit_once(n, fz, now))
                self.assertNotIn('admit_once', n)

    def test_the_pass_is_spent_once_and_then_gone(self):
        from orgtree import supervisor
        from orgtree import ledger
        org = ledger.Org.create('bypass-once')
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        slug = org.d['slug']
        _SLUGS.append(slug)
        n = org.node(nid)
        n['account'] = 'acct-1'
        n['admit_once'] = {'at': time.time(), 'account': 'acct-1',
                           'model': 'fable'}
        store.save_org(org)
        # ROUND 5 SPLIT THE CHECK FROM THE SPEND. The gate validates; the
        # provider seam spends. A turn that dies in between keeps its pass.
        self.assertTrue(supervisor._admit_once_valid(store.load_org(slug)
                                                     .node(nid)))
        o = store.load_org(slug)
        self.assertTrue(supervisor._spend_admit_once(o, nid))
        store.save_org(o)
        self.assertNotIn('admit_once', store.load_org(slug).node(nid))
        self.assertFalse(supervisor._admit_once_valid(store.load_org(slug)
                                                      .node(nid)))
        self.assertFalse(supervisor._spend_admit_once(store.load_org(slug),
                                                      nid))

    def test_a_pass_earned_on_another_identity_is_refused(self):
        """⚠ ROUND 4. A bare timestamp said only WHEN a pass was issued, so a
        fable 429 on one account waved an opus turn on another straight past
        a live mark that was never that lane's wall.

        Round 5 note: refusal no longer CLEARS the field — the provider seam
        owns clearing now — and it does not need to. A pass naming another
        identity can never validate again, and `ADMIT_ONCE_TTL` removes it
        from play within two minutes regardless."""
        from orgtree import supervisor
        from orgtree import ledger
        now = time.time()
        for label, pass_, binding in (
                ('a rebound account',
                 {'at': now, 'account': 'acct-1', 'model': 'fable'},
                 {'account': 'acct-2', 'model': 'fable'}),
                ('a switched model',
                 {'at': now, 'account': 'acct-1', 'model': 'fable'},
                 {'account': 'acct-1', 'model': 'opus'}),
                ('a pass from before the binding existed',
                 now, {'account': 'acct-1', 'model': 'fable'}),
                ('a pass that names nothing',
                 {'at': now}, {'account': 'acct-1', 'model': 'fable'})):
            with self.subTest(label):
                org = ledger.Org.create('bypass-id')
                nid = org._new_node('fable', None, 0, 'root', [],
                                    {'bash': False, 'web': False,
                                     'edit': False, 'subagents': False,
                                     'mcp': []}, 'full', 'c')
                slug = org.d['slug']
                _SLUGS.append(slug)
                org.node(nid).update(dict(binding, admit_once=pass_))
                store.save_org(org)
                self.assertFalse(supervisor._admit_once_valid(
                    store.load_org(slug).node(nid)))

    def test_an_expired_pass_is_refused_and_cleared(self):
        from orgtree import supervisor
        from orgtree import ledger
        org = ledger.Org.create('bypass-stale')
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        slug = org.d['slug']
        _SLUGS.append(slug)
        org.node(nid).update(
            account='acct-1',
            admit_once={'at': time.time() - supervisor.ADMIT_ONCE_TTL - 30,
                        'account': 'acct-1', 'model': 'fable'})
        store.save_org(org)
        self.assertFalse(supervisor._admit_once_valid(
            store.load_org(slug).node(nid)),
            'a stale pass must not wave an admission through')

    def test_a_node_without_a_pass_is_untouched(self):
        from orgtree import supervisor
        from orgtree import ledger
        org = ledger.Org.create('bypass-none')
        nid = org._new_node('fable', None, 0, 'root', [],
                            {'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []}, 'full', 'c')
        slug = org.d['slug']
        _SLUGS.append(slug)
        store.save_org(org)
        self.assertFalse(supervisor._admit_once_valid(
            store.load_org(slug).node(nid)))
        self.assertFalse(supervisor._spend_admit_once(
            store.load_org(slug), nid))


class BoundAccountMarkTests(unittest.TestCase):
    """Rank 2 read from `registry` when the record carries no live deadline —
    the second change perf-review required.

    The mark is durable and the freeze's stamp is a snapshot, so the account
    can be marked while the record's own number has expired or was never
    written. Before this the projection skipped straight to the LEGACY roster,
    which for a registry-bound node either answers with an unrelated pool time
    or says the tier is wide open — and the Usage modal, reading the mark,
    printed the truth one panel away."""

    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)

    _seq = 0

    def _account(self):
        BoundAccountMarkTests._seq += 1
        return registry.create_account(
            'claude', 't',
            {'kind': 'managed',
             'path': os.path.join(_root.name, f'bound-{self._seq}')})

    def _derive(self, node, roster=OPEN):
        api._rederive_freeze_reset(node, {node['tier']: dict(roster)})
        return node['frozen']

    @staticmethod
    def _aged_mark(account_id, tier, until, provenance='observed'):
        """A mark recorded while it was LIVE, whose time has since passed.

        ⚠ `record_mark` cannot write one directly — it prunes the row of
        anything already elapsed on the way past, so handing it a past `until`
        is a no-op. Ageing the stored row is what real time does to it, and
        the elapsed rows survive because nothing prunes on read."""
        registry.record_mark(account_id, tier, until=time.time() + 60,
                             provenance=provenance)
        doc = registry.load()
        registry.get_account(account_id, doc)['marks'][
            registry.pool_key(tier)]['until'] = float(until)
        registry.save(doc)

    def test_the_own_account_mark_beats_an_unrelated_roster_time(self):
        acct = self._account()
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'fable', until=mine,
                             provenance='observed')
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': None, 'reset_src': 'probe'}},
            roster=marked(time.time() + 7200))
        self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)
        self.assertEqual(fz['reset_src'], 'account-mark')
        self.assertEqual(fz['provenance'], 'observed')
        self.assertIn('capacity resets', fz['until'])

    def test_an_open_roster_no_longer_hides_the_mark(self):
        """The reported shape: `accounts.resolve` answers "available" for
        every registry id, so this used to render "reset time unknown"."""
        acct = self._account()
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'fable', until=mine,
                             provenance='inferred')
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': None, 'reset_src': 'probe'}})
        self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)
        self.assertNotEqual(fz['until'], 'reset time unknown')
        # an inferred mark is a ride-along guess, and says so on both surfaces
        self.assertEqual(fz['provenance'], 'inferred')
        self.assertIn('capacity recheck', fz['until'])

    def test_a_pooled_tier_reads_its_own_pool_mark(self):
        """Non-Fable guard: `pool_key` maps opus/sonnet/haiku to the shared
        pool, so a fable-only mark must not caption a pooled freeze."""
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() + 1800,
                             provenance='observed')
        node = {'tier': 'opus', 'account': acct['id'],
                'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                           'until_ts': None, 'reset_src': 'probe'}}
        self.assertEqual(self._derive(node)['until'], 'reset time unknown')
        pooled = time.time() + 900
        registry.record_mark(acct['id'], 'opus', until=pooled,
                             provenance='observed')
        node = {'tier': 'opus', 'account': acct['id'],
                'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                           'until_ts': None, 'reset_src': 'probe'}}
        self.assertAlmostEqual(self._derive(node)['until_ts'], pooled,
                               delta=1.0)

    def test_a_live_record_still_outranks_the_mark(self):
        """Precedence is unchanged above rank 2: a conclusive 429 on the
        record is never replaced by the account's mark, later or not."""
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() + 7200,
                             provenance='observed')
        stated = time.time() + 1800
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': stated, 'reset_src': 'text',
                        'schedule_kind': 'observed-deadline'}})
        self.assertAlmostEqual(fz['until_ts'], stated, delta=1.0)
        self.assertEqual(fz['reset_src'], 'text')

    def test_an_expired_mark_cannot_resurrect_a_horizon(self):
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() - 60,
                             provenance='observed')
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': None, 'reset_src': 'probe'}})
        self.assertIsNone(fz['until_ts'])
        self.assertEqual(fz['until'], 'reset time unknown')

    def test_a_missing_binding_park_is_left_alone(self):
        """state-audit SH-2: there is no account to be marked, and the park's
        own text names the remedy."""
        fz = self._derive(
            {'tier': 'fable', 'account': 'missing:claude',
             'frozen': {'limit': True, 'at': 'x', 'cause': 'account',
                        'account': 'missing:claude', 'until_ts': None,
                        'reset_src': 'account'}})
        self.assertIsNone(fz['until_ts'])

    def test_an_unknown_account_id_falls_through_to_the_roster(self):
        ts = time.time() + 7200
        fz = self._derive(
            {'tier': 'fable', 'account': 'claude-does-not-exist',
             'frozen': {'limit': True, 'at': 'x',
                        'account': 'claude-does-not-exist',
                        'until_ts': None, 'reset_src': 'probe'}},
            roster=marked(ts))
        self.assertAlmostEqual(fz['until_ts'], ts, delta=1.0)

    def test_the_nodes_binding_answers_for_a_record_without_one(self):
        """Older freezes were stamped before `frozen.account` existed."""
        acct = self._account()
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'fable', until=mine,
                             provenance='observed')
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'until_ts': None,
                        'reset_src': 'probe'}})
        self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)

    def test_a_weak_live_snapshot_no_longer_suppresses_the_mark(self):
        """Round 2. The record's `until_ts` is a SNAPSHOT taken when this node
        froze; the mark is durable and moves under it — a sibling seat hitting
        the same account's wall updates it long afterwards. Returning early
        for any live horizon let a 5-minute probe floor hide an observed
        30-minute mark, and the badge under-reported the wait."""
        acct = self._account()
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'fable', until=mine,
                             provenance='observed')
        for src in ('probe', 'inherited', 'account-mark', 'usage:session'):
            with self.subTest(src=src):
                fz = self._derive(
                    {'tier': 'fable', 'account': acct['id'],
                     'frozen': {'limit': True, 'at': 'x',
                                'account': acct['id'],
                                'until_ts': time.time() + 300,
                                'reset_src': src}})
                self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)
                self.assertEqual(fz['reset_src'], 'account-mark')

    def test_the_mark_wins_even_when_it_shortens_a_stale_horizon(self):
        """Rank 2 is the authoritative reading and rank 3 is a guess nothing
        has re-derived, so precedence holds in BOTH directions — this is the
        ranking as written, not a never-shorten floor."""
        acct = self._account()
        mine = time.time() + 1800
        registry.record_mark(acct['id'], 'fable', until=mine,
                             provenance='observed')
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': time.time() + 7200,
                        'reset_src': 'inherited'}})
        self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)

    def test_a_live_429_still_outranks_the_mark_in_both_directions(self):
        """Rank 1 is untouched by the round-2 reordering: neither a later nor
        an earlier mark may replace a time the provider stated."""
        acct = self._account()
        for mark_at in (time.time() + 7200, time.time() + 600):
            registry.record_mark(acct['id'], 'fable', until=mark_at,
                                 provenance='observed')
            stated = time.time() + 1800
            for src in ('text', 'provider'):
                with self.subTest(src=src, mark=mark_at):
                    fz = self._derive(
                        {'tier': 'fable', 'account': acct['id'],
                         'frozen': {'limit': True, 'at': 'x',
                                    'account': acct['id'],
                                    'until_ts': stated, 'reset_src': src,
                                    'schedule_kind': 'observed-deadline'}})
                    self.assertAlmostEqual(fz['until_ts'], stated, delta=1.0)
                    self.assertEqual(fz['reset_src'], src)

    def test_a_live_snapshot_survives_when_no_mark_stands_behind_it(self):
        """Rank 3 still answers when rank 2 has nothing to say: a node with no
        account, and one whose account was never marked. The badge must not
        deny that a scheduled wake is coming."""
        soon = time.time() + 300
        fz = self._derive(
            {'tier': 'fable',
             'frozen': {'limit': True, 'at': 'x', 'until_ts': soon,
                        'reset_src': 'probe'}})
        self.assertAlmostEqual(fz['until_ts'], soon, delta=1.0)
        acct = self._account()
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': soon, 'reset_src': 'inherited'}})
        self.assertAlmostEqual(fz['until_ts'], soon, delta=1.0)

    def test_an_elapsed_mark_never_governs_on_its_own(self):
        """⚠ THE ROUND-4 FIX, REPLACED IN ROUND 5 — and this is now the
        assertion that stops it coming back.

        Round 4 made the wake path read ELAPSED marks, so a deadline the badge
        had promised survived the mark expiring. It worked for that case and
        was wrong as a mechanism, three ways review proved: it died the moment
        `registry.clear_expired` pruned the row; it let an hour-old mark from a
        PREVIOUS limit window caption a freeze taken minutes ago and schedule
        it immediately; and no ±horizon bound expresses "this mark and this
        freeze are about the same wall".

        A mark is evidence about NOW. What a freeze was PROMISED belongs to
        the freeze — `frozen.wake`, see `CommittedWakeTests` — so an elapsed
        mark with no promise behind it says nothing at all here."""
        acct = self._account()
        soon = time.time() + 7200
        self._aged_mark(acct['id'], 'fable', time.time() - 60)
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': soon, 'reset_src': 'inherited'}})
        self.assertAlmostEqual(fz['until_ts'], soon, delta=1.0)
        self.assertEqual(fz['reset_src'], 'inherited')

    def test_a_prior_windows_mark_cannot_caption_a_new_freeze(self):
        """Review round 5's reproduction, kept as its own case: an hour-old
        mark and a freeze taken seconds ago are not about the same wall, and
        reading the old one both mis-captions the badge AND schedules the node
        immediately."""
        acct = self._account()
        mine = time.time() + 300
        self._aged_mark(acct['id'], 'fable', time.time() - 3600)
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': mine, 'reset_src': 'probe'}})
        self.assertAlmostEqual(fz['until_ts'], mine, delta=1.0)

    def test_an_ancient_mark_cannot_speak_either(self):
        """Same rule as the hour-old row, at the other end of the range: age
        is not what disqualifies an elapsed mark — being elapsed is."""
        acct = self._account()
        soon = time.time() + 300
        self._aged_mark(acct['id'], 'fable', time.time() - 9 * 86400)
        fz = self._derive(
            {'tier': 'fable', 'account': acct['id'],
             'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                        'until_ts': soon, 'reset_src': 'inherited'}})
        self.assertAlmostEqual(fz['until_ts'], soon, delta=1.0)

    def test_the_mark_is_read_once_per_node_not_skipped_by_a_live_horizon(self):
        """⚠ The memo must not make rank 2 conditional on rank 3 being absent:
        a live horizon used to return before the lookup happened at all."""
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() + 1800,
                             provenance='observed')
        seen = []
        real = registry.active_mark
        registry.active_mark = lambda *a, **k: (seen.append(a[:2])
                                                or real(*a, **k))
        try:
            self._derive(
                {'tier': 'fable', 'account': acct['id'],
                 'frozen': {'limit': True, 'at': 'x', 'account': acct['id'],
                            'until_ts': time.time() + 300,
                            'reset_src': 'probe'}})
        finally:
            registry.active_mark = real
        self.assertEqual(len(seen), 1, 'the mark was never consulted')

    def test_the_mark_is_read_once_per_render_not_once_per_node(self):
        """`active_mark` re-reads and re-parses the whole registry FILE per
        call; the tree endpoint is already on an O(n²) warning."""
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() + 1800,
                             provenance='observed')
        calls = []
        real = registry.active_mark

        def counted(*a, **k):
            calls.append(a[:2])
            return real(*a, **k)

        cache = {}
        registry.active_mark = counted
        try:
            for _ in range(5):
                api._rederive_freeze_reset(
                    {'tier': 'fable', 'account': acct['id'],
                     'frozen': {'limit': True, 'at': 'x',
                                'account': acct['id'], 'until_ts': None,
                                'reset_src': 'probe'}}, cache)
        finally:
            registry.active_mark = real
        self.assertEqual(len(calls), 1, calls)

    def test_an_auth_freeze_is_still_untouched(self):
        """D-156: the credential was rejected, not exhausted — a mark on the
        same account must not replace "replace it, then resume"."""
        acct = self._account()
        registry.record_mark(acct['id'], 'fable', until=time.time() + 1800,
                             provenance='observed')
        for cause in ('auth', 'balance'):
            with self.subTest(cause=cause):
                fz = self._derive(
                    {'tier': 'fable', 'account': acct['id'],
                     'frozen': {'limit': True, 'at': 'x', 'cause': cause,
                                'account': acct['id'], 'until_ts': None,
                                'until': 'credential rejected — replace it',
                                'reset_src': 'probe'}})
                self.assertEqual(fz['until'],
                                 'credential rejected — replace it')
                self.assertIsNone(fz['until_ts'])


class WakeEstimateTreeTests(unittest.TestCase):
    """End to end through `GET /api/orgs/{slug}` — the payload the desk
    actually repaints from, projection and re-derivation together."""

    def setUp(self):
        org = store.create_org('Wake ' + self._testMethodName[:24])
        store.save_org(org)
        self.slug = org.d['slug']
        _SLUGS.append(self.slug)
        o = store.load_org(self.slug)
        o.hire(USER, None, 'fable', 0, 'boss', charter='a frozen fable seat')
        store.save_org(o)

    def _freeze(self, **fz):
        o = store.load_org(self.slug)
        o.node('boss')['account'] = 'claude-0'
        o.node('boss')['frozen'] = {
            'limit': True, 'at': '2026-09-12T12:00:00Z', **fz}
        store.save_org(o)

    def _badge(self):
        tree = api.org_tree(self.slug, _Req())

        def walk(ns):
            for n in ns:
                if n['id'] == 'boss':
                    return n
                got = walk(n.get('children') or [])
                if got:
                    return got
            return None

        node = walk(tree['roots'])
        self.assertIsNotNone(node, 'the fixture seat must be in the payload')
        return node['frozen']

    def test_the_payload_carries_the_estimate_and_its_provenance(self):
        """⚠ `ledger.tree()`'s frozen filter DESTROYS SILENTLY what it does
        not name — which is how the "(inferred)" marker came to be dead code
        in both cards.tsx and desk.tsx."""
        until = time.time() + 37 * 60
        self._freeze(until='capacity recheck 3:30pm', until_ts=until,
                     reset_src='account-mark', provenance='inferred',
                     schedule_kind='probe', account='claude-0')
        fz = self._badge()
        self.assertEqual(fz['provenance'], 'inferred',
                         'the badge cannot say what Usage says without this')
        self.assertEqual(fz['account'], 'claude-0')
        self.assertAlmostEqual(fz['until_ts'], until, delta=1.0)
        self.assertIn('capacity recheck', fz['until'])
        self.assertNotIn('▶', fz['until'])

    def test_an_explicit_429_reaches_the_desk_intact(self):
        stated = time.time() + 30 * 60
        self._freeze(until='capacity resets 3:23pm', until_ts=stated,
                     reset_src='text', schedule_kind='observed-deadline')
        fz = self._badge()
        self.assertAlmostEqual(fz['until_ts'], stated, delta=1.0)
        self.assertIn('capacity resets', fz['until'])

    def test_a_freeze_with_no_estimate_reaches_the_desk_neutral(self):
        self._freeze(until='unknown — probing again in ~5 min',
                     until_ts=None, reset_src='probe')
        fz = self._badge()
        self.assertIsNone(fz['until_ts'])
        self.assertEqual(fz['until'], 'reset time unknown')


if __name__ == '__main__':
    unittest.main()
