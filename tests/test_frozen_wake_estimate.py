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
                      {'until_ts': time.time() - 60, 'reset_src': 'text'},
                      {'until_ts': None, 'reset_src': ''}):
            with self.subTest(**fz_in):
                fz = self._derive(self._node('fable', **fz_in))
                self.assertEqual(fz['until'], 'reset time unknown')
                self.assertIsNone(fz['until_ts'])

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
        node is somebody else's lane and keeps what its own path stamped."""
        fz = self._derive(self._node(
            'gpt-5.6', until='capacity resets soon', until_ts=None))
        self.assertEqual(fz['until'], 'capacity resets soon')

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

    def test_a_later_mark_still_wins_because_the_gate_admits_against_it(self):
        from orgtree import supervisor
        msg = time.time() + 1800
        for src in ('text', 'provider'):
            with self.subTest(src=src):
                self.assertTrue(
                    supervisor._mark_supersedes_message(msg + 300, msg, src),
                    'the freeze would wake before the pre-slot gate lets it '
                    'in, be refused, and re-freeze')

    def test_an_inconclusive_429_hands_the_answer_to_the_mark(self):
        from orgtree import supervisor
        now = time.time()
        for src, ts in (('probe', None), ('', None), ('inherited', now + 60),
                        ('usage:session', now + 60), ('text', None)):
            with self.subTest(src=src, ts=ts):
                self.assertTrue(
                    supervisor._mark_supersedes_message(now + 900, ts, src),
                    'nothing was protecting this deadline')


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
