"""W15 — provider capability and admission evidence.

THE THREE THINGS THIS SUITE HOLDS DOWN, from the W15 package's own acceptance
conditions (suggestion synthesis, 2026-09-12; sources AU01, PP08,
stateaudit-04, statereview-10):

  1. A CHANGED CLI VERSION REFRESHES A STALE NEGATIVE. `unsupported` is a
     measurement against a CLI build, not a property of a provider. The
     Antigravity `/usage` conclusion was reached once, against an older build,
     and outlived it — the CLI grew a structured, zero-token `/usage` while the
     conclusion stayed put (AU01). So every capability negative now carries the
     version it was reached against, and a version change drops it: §1 pins the
     record and its staleness rule, §2 drives the whole flip through the real
     fetch path, §3 pins the same rule over the CACHED board so a positive
     cannot outlive its build either.

  2. UNKNOWN IS NOT ZERO, AND EXHAUSTION IS PER ACCOUNT AND MODEL. §4: a
     fully-consumed window disqualifies the account/model pair that spends it
     and nothing else — a Fable weekly window at 100% on one account is not a
     constraint on an Opus turn, nor on a Fable turn placed elsewhere — and a
     missing reading still reads as missing rather than as room.

  3. NO FORECAST AND NO BILLABLE PROBE. §5: the board states no
     turns-remaining figure (the one thing PP08 and stateaudit-04 both asked
     for, and the one thing no lane publishes), the envelope path spawns no
     process, and the zero-turn contract still refuses a `/usage` result that
     shows any model work.

§6 is the board sentence itself, §7 pins it against the agent-facing doctrine
so the two cannot drift, and §8 is the standing rule that no credential
material rides along.

MEASURED RED ON MAIN (59ba9e4): §1 (all), §2b, §2c, §3a, §4b, §4c, §5a, §6
(all), §7 — main has no `capability` module, no version-keyed usage cache and
no spend line. GREEN before and after: §2a, §3b, §4a, §5b, §5c, §8 — the
controls, which a change that merely printed a new sentence would still pass.

    python -B tests/test_capability_and_admission_evidence.py
"""
import os
import re
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

fx = tempfile.TemporaryDirectory(prefix='w15-capability-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'w15-capability-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import (accounts, accountusage, antigravity_limits,     # noqa: E402
                     capability, codex_limits, ledger, limits, providers,
                     registry, store, supervisor, turnusage)

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

NOW = 1_800_000_000.0
slugs = []

#: The shape `providers.antigravity_status` returns, with the version as the
#: only thing that moves between cases.
STATUS = {'installed': True, 'connected': True, 'path': 'agy-test',
          'email': 'agy@example.test', 'kind': 'oauth', 'version': '1.2.7'}


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def usage_result(*, turns=0, total_tokens=0):
    """A real zero-turn `/usage` payload, with the read-only markers the
    provider actually sends (the same fixture shape as
    `tests/test_antigravity_limits.py`)."""
    return {
        'conversation_id': '', 'status': 'SUCCESS', 'num_turns': turns,
        'usage': {'input_tokens': 0, 'output_tokens': 0, 'thinking_tokens': 0,
                  'cache_read_tokens': 0, 'total_tokens': total_tokens},
        'command': {'name': 'usage', 'data': {'groups': [{
            'name': 'Gemini Models',
            'buckets': [{'id': 'gemini-weekly', 'name': 'Weekly Limit Remaining',
                         'window': 'weekly', 'remaining_fraction': 0.6,
                         'reset_time': '2026-09-17T19:40:25Z'}]}]}},
    }


def limit(kind, percent, resets_at=None, model=None, active=False):
    return {'kind': kind, 'group': kind, 'percent': percent,
            'severity': 'normal', 'resets_at': resets_at,
            'is_active': active, 'model': model, 'label': None}


# ── §1 the capability record: dated, versioned, and droppable ─────────────
class CapabilityRecord(unittest.TestCase):
    def test_s1a_record_names_cli_basis_and_the_version_it_was_judged_by(self):
        rec = capability.observation(cli='antigravity', basis='version',
                                     version='agy version 1.1.9',
                                     requires='1.2.0', observed_at=NOW)
        self.assertEqual(rec['cli'], 'antigravity')
        self.assertEqual(rec['basis'], 'version')
        self.assertFalse(rec['supported'])
        self.assertEqual(rec['version'], '1.1.9',
                         'the comparable key must survive a banner around the '
                         'version, or every reformatted line reads as a new CLI')
        self.assertEqual(rec['version_observed'], 'agy version 1.1.9',
                         'the raw string a person can match against --version '
                         'output is kept beside the lossy key')
        self.assertEqual(rec['requires'], '1.2.0')
        self.assertEqual(rec['observed_at'], '2027-01-15T08:00:00Z')

    def test_s1b_an_unobserved_version_says_so_and_is_never_dated(self):
        rec = capability.observation(cli='claude', basis='scope', version=None)
        self.assertEqual(rec['version'], capability.UNOBSERVED)
        self.assertIsNone(rec['version_observed'])
        self.assertIsNone(rec['observed_at'],
                          'a record built from a cached version is not a fresh '
                          'observation and must not be dated as one')

    def test_s1c_unknown_basis_is_named_unknown_not_invented(self):
        self.assertEqual(
            capability.observation(cli='x', basis='vibes', version='1')['basis'],
            'unknown')
        for basis in capability.BASES:
            self.assertEqual(
                capability.observation(cli='x', basis=basis,
                                       version='1')['basis'], basis)

    def test_s1d_stale_fires_on_any_version_change_in_either_direction(self):
        rec = capability.observation(cli='antigravity', basis='version',
                                     version='1.1.9')
        self.assertFalse(capability.stale(rec, '1.1.9'))
        self.assertTrue(capability.stale(rec, '1.2.7'), 'an upgrade')
        self.assertTrue(capability.stale(rec, '1.0.1'), 'a downgrade')
        self.assertTrue(capability.stale(rec, None), 'a vanished CLI')
        self.assertTrue(capability.stale(None, '1.1.9'), 'no record at all')
        self.assertTrue(capability.stale({'cli': 'antigravity'}, '1.1.9'),
                        'a record with no provenance is not evidence')

    def test_s1e_an_unobserved_version_never_matches_an_observed_one(self):
        blind = capability.observation(cli='antigravity', basis='version',
                                       version=None)
        self.assertTrue(capability.stale(blind, '1.2.7'),
                        'a negative reached while nothing had observed the CLI '
                        'is not evidence about the CLI that turned up later')
        self.assertFalse(capability.stale(blind, None))

    def test_s1f_cached_version_reader_never_probes(self):
        with mock.patch.object(subprocess, 'run',
                               side_effect=AssertionError('spawned')):
            capability.cli_version_cached('claude')
            capability.cli_version_cached('antigravity')
            self.assertIsNone(capability.cli_version_cached('nonesuch'))


# ── §2 acceptance 1: a changed CLI version re-probes ──────────────────────
class VersionChangeRefreshesTheNegative(unittest.TestCase):
    def setUp(self):
        antigravity_limits.invalidate()
        prior = providers._antigravity_status_cache
        providers._antigravity_status_cache = None
        self.addCleanup(setattr, providers, '_antigravity_status_cache', prior)
        self.addCleanup(antigravity_limits.invalidate)

    def test_s2a_an_old_cli_is_unsupported_and_is_not_probed(self):
        old = {**STATUS, 'version': '1.1.9'}
        with mock.patch.object(providers, 'antigravity_status', return_value=old), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               side_effect=AssertionError('probed')) as run:
            out = antigravity_limits.fetch(force=True)
        self.assertTrue(out['unsupported'])
        self.assertFalse(out['available'])
        self.assertEqual(run.call_count, 0)

    def test_s2b_the_negative_carries_the_version_it_was_reached_against(self):
        old = {**STATUS, 'version': '1.1.9'}
        with mock.patch.object(providers, 'antigravity_status', return_value=old), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               side_effect=AssertionError('probed')):
            out = antigravity_limits.fetch(force=True)
        rec = out['capability']
        self.assertEqual((rec['cli'], rec['basis'], rec['version'],
                          rec['requires'], rec['supported']),
                         ('antigravity', 'version', '1.1.9', '1.2.0', False))
        self.assertTrue(capability.stale(rec, '1.2.7'),
                        'the whole point: this conclusion must stop being '
                        'evidence the moment the CLI moves')

    def test_s2c_a_newer_cli_refreshes_it_through_the_zero_turn_probe(self):
        old = {**STATUS, 'version': '1.1.9'}
        with mock.patch.object(providers, 'antigravity_status', return_value=old), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               side_effect=AssertionError('probed')):
            stale_answer = antigravity_limits.fetch(force=True)
        self.assertTrue(stale_answer['unsupported'])

        with mock.patch.object(providers, 'antigravity_status',
                               return_value=dict(STATUS)), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               return_value=usage_result()) as run:
            fresh = antigravity_limits.fetch()
        self.assertEqual(run.call_count, 1,
                         'the version moved, so the lane must be re-probed '
                         'rather than answered from the old conclusion')
        self.assertTrue(fresh['available'])
        self.assertNotIn('unsupported', fresh)
        self.assertEqual(fresh['capability']['version'], '1.2.7')
        self.assertTrue(fresh['capability']['supported'])

    def test_s2d_a_version_change_mid_read_is_not_filed_under_either(self):
        before, after = {**STATUS, 'version': '1.2.7'}, {**STATUS, 'version': '1.3.0'}
        with mock.patch.object(providers, 'antigravity_status',
                               side_effect=[before, after]), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               return_value=usage_result()):
            out = antigravity_limits.fetch(force=True)
        self.assertFalse(out['available'])
        self.assertIn('version changed during', out['error'])
        self.assertFalse(antigravity_limits.snapshot()['available'],
                         'a board whose producing build is unknown is not cached')
        # ⚠ AND IT IS ATTRIBUTED TO NEITHER VERSION (review, py-runner
        # 2026-09-12). Refusing to cache the board is only half of it: stamping
        # the payload with the version observed after the change would credit a
        # successful read to a build that may never have performed it.
        self.assertNotIn('capability', out,
                         'a read spanning a version change must carry no '
                         'capability record, not one filed under either build')
        self.assertTrue(capability.stale(out.get('capability'), '1.2.7'))
        self.assertTrue(capability.stale(out.get('capability'), '1.3.0'),
                        'an absent record is stale against every version, so '
                        'the next reader recomputes rather than inheriting')

    def test_s2e_a_clean_read_is_still_attributed_to_its_own_build(self):
        """The control for §2d: the attribution is removed only where the
        producing build is genuinely unknown."""
        with mock.patch.object(providers, 'antigravity_status',
                               return_value=dict(STATUS)), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               return_value=usage_result()):
            out = antigravity_limits.fetch(force=True)
        self.assertTrue(out['available'])
        self.assertEqual(out['capability']['version'], '1.2.7')
        self.assertTrue(out['capability']['supported'])


# ── §3 the same rule over the cached board, and the shipped isolation ─────
class VersionKeyedCache(unittest.TestCase):
    def setUp(self):
        antigravity_limits.invalidate()
        prior = providers._antigravity_status_cache
        providers._antigravity_status_cache = None
        self.addCleanup(setattr, providers, '_antigravity_status_cache', prior)
        self.addCleanup(antigravity_limits.invalidate)

    def _seed(self, status):
        with mock.patch.object(providers, 'antigravity_status',
                               return_value=status), \
             mock.patch.object(antigravity_limits, '_run_usage',
                               return_value=usage_result()):
            return antigravity_limits.fetch(force=True)

    def test_s3a_a_board_read_by_one_build_is_not_served_after_an_upgrade(self):
        self.assertTrue(self._seed(dict(STATUS))['available'])
        self.assertTrue(antigravity_limits.snapshot()['available'])
        # another surface observes the upgraded CLI; no fetch, no probe
        providers._antigravity_status_cache = (NOW, {**STATUS, 'version': '1.3.0'})
        self.assertFalse(antigravity_limits.snapshot()['available'],
                         'the previous build\'s board must be dropped, not '
                         'republished under the new version')
        self.assertFalse(antigravity_limits.peek()['available'])

    def test_s3b_shipped_account_isolation_regression_still_holds(self):
        self.assertTrue(self._seed(dict(STATUS))['available'])
        providers._antigravity_status_cache = (
            NOW, {**STATUS, 'email': 'other@example.test'})
        self.assertFalse(antigravity_limits.snapshot()['available'],
                         'f967dc2 cache isolation: one account never answers '
                         'for another')


# ── §4 acceptance 2: exhaustion is per account AND model ──────────────────
class ExhaustionIsPerAccountAndModel(unittest.TestCase):
    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        limits.invalidate()
        with codex_limits._lock:
            codex_limits._home_cache.clear()
        self.slug = 'w15-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        self.org.hire(ledger.USER, None, 'fable', 0, 'fabler', add_dirs=[],
                      tools={}, charter='fixture')
        self.org.hire(ledger.USER, None, 'opus', 0, 'opuser', add_dirs=[],
                      tools={}, charter='fixture')
        store.save_org(self.org)

    def account(self, provider, label):
        row = registry.create_account(
            provider, label,
            {'kind': 'managed',
             'path': os.path.join(fx.name, f'{provider}-{label}-{uuid.uuid4().hex[:6]}')})
        return row

    def seed_claude(self, row, lims):
        with limits._lock:
            limits._key_cache[f"acct:{row['id']}"] = {
                'at': NOW - 60.0, 'data': {'available': True, 'limits': lims}}

    def test_s4a_a_fable_turn_spends_both_weekly_windows_an_opus_turn_one(self):
        self.assertEqual(turnusage.spent_windows('fable')[0],
                         ['session', 'weekly_all', 'weekly_scoped:fable'])
        for tier in ('opus', 'sonnet', 'haiku'):
            self.assertEqual(turnusage.spent_windows(tier)[0],
                             ['session', 'weekly_all'],
                             'the lower Claude tiers ignore the Fable-only pool')

    def test_s4b_one_accounts_full_fable_window_constrains_only_that_pair(self):
        full = self.account('claude', 'full')
        room = self.account('claude', 'room')
        self.seed_claude(full, [limit('weekly_all', 40, '2026-09-19T09:00:00Z'),
                                limit('weekly_scoped', 100, '2026-09-19T09:00:00Z',
                                      model='fable', active=True)])
        self.seed_claude(room, [limit('weekly_all', 21, '2026-09-19T09:00:00Z'),
                                limit('weekly_scoped', 37, '2026-09-19T09:00:00Z',
                                      model='fable')])
        text = turnusage.render(self.org, 'fabler', now=NOW)
        rows = {(r['lane'], r['window']): r for r in turnusage.board_rows(text)}
        self.assertEqual(rows[(full['id'], 'weekly_scoped:fable')]['state'],
                         'limit-active')
        self.assertEqual(rows[(room['id'], 'weekly_scoped:fable')]['state'],
                         'ready',
                         'the other account stays a candidate for the same model')
        # and the window an Opus turn spends is not the exhausted one
        self.assertNotIn('weekly_scoped:fable', turnusage.spent_windows('opus')[0])

    def test_s4c_an_unread_account_is_reported_missing_never_zero(self):
        blind = self.account('claude', 'unread')
        text = turnusage.render(self.org, 'opuser', now=NOW)
        rows = [r for r in turnusage.board_rows(text) if r['lane'] == blind['id']]
        self.assertTrue(rows, 'an account with no reading still gets a row')
        self.assertIsNone(rows[0]['used_pct'])
        self.assertIn('unavailable(', text)
        self.assertNotRegex(
            [ln for ln in text.splitlines()
             if ln.startswith(blind['id'])][0].split('|')[2],
            r'\d',
            'an unread window must never render as a number, least of all 0%')


# ── §5 acceptance 3: no forecast, no probe, no billable read ──────────────
class NoForecastNoProbe(unittest.TestCase):
    def setUp(self):
        self.slug = 'w15f-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        self.org.hire(ledger.USER, None, 'opus', 0, 'agent', add_dirs=[],
                      tools={}, charter='fixture')
        store.save_org(self.org)

    def test_s5a_the_board_never_states_a_turns_remaining_figure(self):
        text = turnusage.render(self.org, 'agent', now=NOW)
        spend = [ln for ln in text.splitlines() if ln.startswith('this turn spends:')]
        self.assertEqual(len(spend), 1, 'exactly one spend sentence')
        self.assertIn('no lane publishes a turns-remaining figure', spend[0])
        self.assertNotRegex(spend[0], r'\d+\s*(turns?|more turns?) (left|remaining)')
        self.assertNotRegex(text, r'(?i)turns (left|remaining)\s*[:=]?\s*\d')

    def test_s5b_the_envelope_board_opens_no_process(self):
        with mock.patch.object(subprocess, 'run',
                               side_effect=AssertionError('spawned a process')), \
             mock.patch.object(subprocess, 'Popen',
                               side_effect=AssertionError('spawned a process')):
            text = turnusage.render(self.org, 'agent', now=NOW)
        self.assertIn('[PROVIDER USAGE', text)

    def test_s5c_a_usage_result_showing_model_work_is_still_refused(self):
        with self.assertRaisesRegex(ValueError, 'zero-token'):
            antigravity_limits._normalize(usage_result(turns=1, total_tokens=9),
                                          NOW)

    def test_s5d_a_capability_negative_is_not_capacity(self):
        """`unsupported` says the lane cannot be READ, never that it is empty."""
        row = registry.create_account(
            'google', 'redirected',
            {'kind': 'managed', 'path': os.path.join(fx.name, 'ag-redirect')})
        view = accountusage.view(row, allow_fetch=False, now=NOW)
        self.assertTrue(view['unsupported'])
        self.assertFalse(view['available'])
        self.assertNotIn('limits', view)
        self.assertEqual(view['capability']['basis'], 'no-profile-selector')


# ── §6 the spend sentence ─────────────────────────────────────────────────
class SpendSentence(unittest.TestCase):
    def setUp(self):
        self.slug = 'w15s-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        store.save_org(self.org)

    def hire(self, tier, name):
        self.org.hire(ledger.USER, None, tier, 0, name, add_dirs=[],
                      tools={}, charter='fixture')
        store.save_org(self.org)
        return name

    def spend(self, nid, **kw):
        text = turnusage.render(self.org, nid, now=NOW, **kw)
        return next(ln for ln in text.splitlines()
                    if ln.startswith('this turn spends:'))

    def test_s6a_it_names_the_selected_account_and_the_model(self):
        self.hire('opus', 'a')
        line = self.spend('a', selected_provider='claude', selected_lane='primary')
        self.assertIn('opus on claude/primary', line)
        self.assertIn('session, weekly_all', line)

    def test_s6b_a_fable_turn_names_both_of_its_weekly_windows(self):
        self.hire('fable', 'f')
        self.assertIn('session, weekly_all, weekly_scoped:fable',
                      self.spend('f'))

    def test_s6c_luna_names_the_reserve_window_and_its_one_condition(self):
        windows, conditional = turnusage.spent_windows('luna')
        self.assertEqual(windows, ['session', 'weekly_scoped:gpt-reserve'])
        self.assertIn('gpt-reserve is full', conditional)
        self.assertIn('reserve preference is off', conditional)
        self.assertEqual(turnusage.spent_windows('luna', prefer_reserve=False),
                         (['session', 'weekly_all'], ''),
                         'reserve turned off means the ordinary weekly limit')

    def test_s6d_an_unmeasured_lane_says_not_published_rather_than_guessing(self):
        for tier in ('flash', 'made-up-tier', ''):
            windows, note = turnusage.spent_windows(tier)
            self.assertEqual(windows, [])
            self.assertEqual(note, 'not published for this lane')
        self.hire('flash', 'g')
        self.assertIn('not published for this lane', self.spend('g'))

    def test_s6e_a_model_switch_re_sends_the_board(self):
        self.hire('opus', 'm')
        _text, before = turnusage.board(self.org, 'm', now=NOW)
        self.org.node('m')['model'] = 'fable'      # the node's tier field
        store.save_org(self.org)
        _text2, after = turnusage.board(self.org, 'm', now=NOW)
        self.assertNotEqual(before, after,
                            'the accounting changed, so a suppressed board '
                            'would leave the old sentence standing')

    def test_s6f_the_sentence_sits_inside_the_block_after_the_legend(self):
        self.hire('opus', 'p')
        lines = turnusage.render(self.org, 'p', now=NOW).splitlines()
        spend = next(i for i, ln in enumerate(lines)
                     if ln.startswith('this turn spends:'))
        legend = next(i for i, ln in enumerate(lines)
                      if ln.startswith('* selected for this turn'))
        self.assertLess(legend, spend)
        self.assertEqual(lines[-1], turnusage.CLOSE)
        self.assertEqual(turnusage.board_rows('\n'.join(lines[spend:spend + 1])),
                         [], 'the sentence is not a usage row')


# ── §7 the board and the doctrine cannot drift ────────────────────────────
class DoctrineMatchesTheBoard(unittest.TestCase):
    def test_s7a_the_doctrine_quotes_the_sentence_the_board_renders(self):
        self.assertIn('this turn spends:', supervisor.ACCOUNT_LANE_DOCTRINE)

    def test_s7b_the_doctrine_still_refuses_a_remaining_turns_estimate(self):
        self.assertIn('do not derive one', supervisor.ACCOUNT_LANE_DOCTRINE)
        self.assertIn('never invent a number the board did not give you',
                      supervisor.ACCOUNT_LANE_DOCTRINE)


# ── §8 the standing rule: no credential material rides along ──────────────
class NoSecrets(unittest.TestCase):
    def test_s8a_capability_records_carry_no_path_or_token(self):
        recs = [
            capability.observation(cli='claude', basis='scope', version='2.1.2'),
            capability.observation(cli='antigravity', basis='version',
                                   version='1.2.7', requires='1.2.0'),
        ]
        for rec in recs:
            blob = repr(rec)
            for banned in ('token', 'secret', 'credential', 'sk-', os.sep * 2):
                self.assertNotIn(banned, blob.lower().replace('credentials file', ''))
            self.assertFalse(any(isinstance(v, str) and re.search(r'[A-Za-z]:\\', v)
                                 for v in rec.values()))

    def test_s8b_the_setup_token_row_dates_its_own_scope_conclusion(self):
        doc = accounts.load()
        rec = None
        for key in doc['keys']:
            rec = accounts.account_usage(key['id']).get('capability')
            break
        if rec is None:                 # no fallback key on this machine
            rec = capability.observation(
                cli='claude', basis='scope',
                version=capability.cli_version_cached('claude'),
                detail='D-147')
        self.assertEqual(rec['basis'], 'scope')
        self.assertIn('version', rec)


if __name__ == '__main__':
    unittest.main(verbosity=1)
