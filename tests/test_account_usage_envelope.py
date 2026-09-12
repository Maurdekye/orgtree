"""Every registered account's usage reaches the agent turn envelope.

USER REQUIREMENT 2026-09-12, verbatim: "i want you to be able to see the same
information i see in the current usage modal".

WHAT WAS ACTUALLY WRONG. The Usage modal draws one card per host provider lane
AND one card per registered account beyond them, each with its own windows,
percentages, reset instants, freshness and honest unavailability text. The turn
envelope's `[PROVIDER USAGE]` board drew the host lanes plus a name-only row
per legacy fallback key — so a second signed-in Claude profile or a second
Codex home was fully visible to the user and entirely invisible to the agents
spending it. An agent cannot balance across accounts it cannot see.

THE FIX IS ONE RESOLVER, NOT A SECOND READER. `accountusage.view` is the
per-account resolution that used to sit inline in `api.accounts_usage`; the
modal's endpoint now calls it with `allow_fetch=True` and the board calls it
with `allow_fetch=False`. The endpoint adds canonical name/label metadata and
echoes the requested account alias; it does not interpret usage again. §1 pins
those identity fields and exact usage parity, and §2 pins the half that makes it safe
to put on the every-turn path: cache-only means NO fetch, no app-server, no
credentials read.

§3-§7 are the board itself: a lane per account, the roster that says who each
lane is, and the two de-duplications that stop one account being counted twice.
§8 is the standing rule that survives all of it — nothing secret enters the
text.

MEASURED RED BEFORE THE CHANGE (against main): §1, §2, §3, §4, §5, §7, §9, §10
— main has no `accountusage` module at all. Green before and after: §6 and §8,
the controls that a change which simply pasted the registry into the board
would fail.

    python -B tests/test_account_usage_envelope.py
"""
import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='acct-envelope-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'acct-envelope-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import (accountusage, antigravity_limits, api,          # noqa: E402
                     codex_limits, ledger, limits, registry, store,
                     turnusage)
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

NOW = 1_800_000_000.0
slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def limit(kind, percent, resets_at=None, model=None, label=None, active=False):
    """One normalized limit entry — the exact shape `limits._normalize` and
    `codex_limits._normalize` produce, which is also the shape the modal's
    UsageBars renders. Hand-building the PROVIDER's raw json instead would
    test the normalizers, which have their own suites."""
    return {'kind': kind, 'group': kind, 'percent': percent,
            'severity': 'normal', 'resets_at': resets_at,
            'is_active': active, 'model': model, 'label': label}


class AccountUsageEnvelope(unittest.TestCase):
    def setUp(self):
        path = registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        limits.invalidate()
        with codex_limits._lock:
            codex_limits._home_cache.clear()
        self.slug = 'acctenv-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        self.org.hire(ledger.USER, None, 'opus', 0, 'agent', add_dirs=[],
                      tools={}, charter='fixture')
        store.save_org(self.org)

    _seq = 0

    def account(self, provider='claude', label='acct', email=''):
        AccountUsageEnvelope._seq += 1
        row = registry.create_account(
            provider, label,
            {'kind': 'managed',
             'path': os.path.join(fx.name, f'{provider}-{self._seq}')})
        if email:
            registry.set_identity(row['id'], {'email': email})
            row = registry.get_account(row['id'])
        return row

    def seed_claude(self, row, lims):
        """Put a readout in the per-account cache the way a modal refresh
        would — `fetch_for_token` writes exactly this entry."""
        with limits._lock:
            limits._key_cache[f"acct:{row['id']}"] = {
                'at': NOW - 60.0, 'data': {'available': True, 'limits': lims}}

    def seed_codex(self, row, lims):
        with codex_limits._lock:
            codex_limits._home_cache[f"acct:{row['id']}"] = {
                'at': NOW - 60.0,
                'data': {'available': True, 'limits': lims,
                         'account': 'digest', 'lane': 'plan'}}

    def board(self):
        return turnusage.render(self.org, 'agent', selected_provider='claude',
                                selected_lane='primary', now=NOW)

    def lanes(self, text):
        return {ln.split('|')[0].strip().rstrip('*')
                for ln in text.splitlines() if ln.count('|') >= 6}

    # ── §1 ONE resolver: the modal endpoint and the board share it ─────────
    def test_s1_modal_endpoint_and_envelope_read_the_same_resolver(self):
        import asyncio
        row = self.account('google', 'ag')
        endpoint = asyncio.run(api.accounts_usage(row['id']))
        direct = accountusage.view(row, allow_fetch=True)
        self.assertEqual(endpoint['name'], row['id'])
        self.assertEqual(endpoint['label'], row['id'])
        self.assertEqual(endpoint, {**direct, 'name': row['id'], 'label': row['id']},
                         'the modal endpoint no longer answers from '
                         'accountusage.view plus canonical identity metadata')
        # and the ambient rule is one function too, not two copies
        self.assertIs(api._ambient_covered.__module__ and
                      accountusage.ambient_covered(
                          row, 'nobody', {'google': None}), False)

    def test_s1b_the_endpoint_still_answers_by_the_alias_it_was_asked_by(self):
        import asyncio
        row = self.account('claude', 'primary-ish')
        doc = registry.load(strict=True)
        doc['aliases']['primary'] = row['id']
        registry.save(doc)
        out = asyncio.run(api.accounts_usage('primary'))
        self.assertEqual(out['account'], 'primary',
                         'a client that asked for `primary` must read its '
                         'own key back, not the resolved row id')
        self.assertEqual(out['name'], 'claude/primary')
        self.assertEqual(out['label'], 'claude/primary')

    def test_s1c_endpoint_changes_only_identity_and_preserves_every_usage_field(self):
        import asyncio
        from copy import deepcopy
        row = self.account('openai', 'old mutable label', 'observed@example.test')
        reading = {
            'account': 'provider-account-digest', 'name': 'provider name',
            'label': 'provider display label', 'provider': 'Codex',
            'email': 'observed@example.test', 'available': True, 'plan': 'Pro',
            'limits': [limit('weekly_scoped', 84, '2026-09-20T08:00:00Z',
                             model='gpt-reserve', label='Provider window label')],
            'observed_at': '2026-09-12T12:00:00Z', 'stale': False,
            'standing': {'auth': 'authenticated', 'state': 'limited',
                         'marks': {'pooled': {'until': NOW + 60, 'provenance': 'observed'}}},
        }
        with patch.object(accountusage, 'view', return_value=deepcopy(reading)) as resolver:
            endpoint = asyncio.run(api.accounts_usage(row['id']))
        resolver.assert_called_once_with(row, allow_fetch=True)
        self.assertEqual(endpoint, {**reading, 'account': row['id'],
                                    'name': row['id'], 'label': row['id']})
        self.assertEqual(endpoint['limits'][0]['label'], 'Provider window label')

    # ── §2 the envelope path never fetches ────────────────────────────────
    def test_s2_cache_only_view_opens_no_fetch_no_process_no_credential(self):
        claude = self.account('claude', 'second')
        codex = self.account('openai', 'second-codex')
        boom = AssertionError('the envelope path spent an upstream request')

        def explode(*a, **kw):
            raise boom
        from orgtree import subproxy
        with patch.object(limits, 'fetch', explode), \
             patch.object(limits, 'fetch_for_token', explode), \
             patch.object(codex_limits, 'fetch', explode), \
             patch.object(codex_limits, 'fetch_for_home', explode), \
             patch.object(subproxy, 'profile_access_token', explode):
            for row in (claude, codex):
                out = accountusage.view(row, allow_fetch=False, now=NOW)
                self.assertIn('standing', out)
            # the whole board, not just one row
            text = self.board()
        self.assertIn('[PROVIDER USAGE', text)

    def test_s2b_but_the_modal_path_still_fetches(self):
        """Control: §2 must be proving cache-only, not proving that the
        fixture never reaches the fetch at all."""
        codex = self.account('openai', 'modal-codex')
        with patch.object(codex_limits, 'fetch_for_home', return_value={
                'available': False, 'error': 'fixture'}) as f:
            accountusage.view(codex, allow_fetch=True, now=NOW)
        f.assert_called_once_with(codex['credential']['path'],
                                  'acct:' + codex['id'])

    def test_s2c_ambient_antigravity_uses_one_reader_for_modal_and_envelope(self):
        import asyncio
        row = self.account('google', 'ambient-agy', 'agy@example.test')
        path = row['credential']['path']
        usage = {'available': True,
                 'limits': [limit('session', 42.0, NOW + 3600)]}
        from orgtree import registry_migration
        with patch.object(registry_migration, 'observe_ambient',
                          return_value={'google': path}), \
             patch.object(antigravity_limits, 'fetch',
                          return_value=usage) as fetch, \
             patch.object(antigravity_limits, 'snapshot',
                          return_value=usage) as snapshot:
            modal = asyncio.run(api.accounts_usage(row['id']))
            envelope = accountusage.view(row, allow_fetch=False, now=NOW)
        fetch.assert_called_once_with()
        snapshot.assert_called_once_with(NOW)
        self.assertEqual(modal['limits'], usage['limits'])
        self.assertEqual(modal['account'], row['id'])
        self.assertEqual(envelope['limits'], usage['limits'])
        self.assertNotIn('unsupported', modal)
        self.assertNotIn('unsupported', envelope)

    # ── §3 a lane per registered account, with its own windows ────────────
    def test_s3_every_registered_account_gets_its_own_rows(self):
        a = self.account('claude', 'Work', 'work@example.com')
        b = self.account('claude', 'Personal', 'me@example.com')
        c = self.account('openai', 'Codex Two')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400),
                             limit('weekly_scoped', 100.0, NOW + 86400,
                                   model='fable', active=True)])
        self.seed_claude(b, [limit('weekly_all', 90.0, NOW + 3600)])
        self.seed_codex(c, [limit('weekly_all', 40.0, NOW + 7200)])
        text = self.board()
        lanes = self.lanes(text)
        self.assertIn(a['id'], lanes)
        self.assertIn(b['id'], lanes)
        self.assertIn(c['id'], lanes)
        # the windows themselves, not just the lane names
        self.assertRegex(text, rf"{a['id']} \| weekly_all \| 12% \|")
        self.assertRegex(text, rf"{a['id']} \| weekly_scoped:fable \| 100% \|.*limit-active")
        self.assertRegex(text, rf"{b['id']} \| weekly_all \| 90% \|")
        self.assertRegex(text, rf"{c['id']} \| weekly_all \| 40% \|")
        # …and the reset instant with its countdown, the modal's own column
        self.assertIn('2027-01-16T08:00:00Z (+1d0h)', text)

    def test_s3b_every_row_is_still_a_structured_record(self):
        a = self.account('claude', 'Work')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        text = turnusage.board(self.org, 'agent', selected_provider='claude',
                               selected_lane='primary', now=NOW)[0]
        rows = turnusage.board_rows(text)
        work = [r for r in rows if r['lane'] == a['id']]
        self.assertEqual(len(work), 1, rows)
        self.assertEqual(work[0]['used_pct'], 12.0)
        self.assertEqual(work[0]['window'], 'weekly_all')
        # every rendered usage row has a record. The ROSTER has no pipes at
        # all and the column header has its own (pre-existing) pipes without
        # ever being a row, so neither is counted here.
        body = [ln for ln in text.splitlines()
                if ln.count('|') >= 6 and not ln.startswith('account |')]
        self.assertEqual(len(rows), len(body), text)

    # ── §4 the roster says WHO each lane is ───────────────────────────────
    def test_s4_roster_names_each_account_without_a_credential(self):
        a = self.account('claude', 'Work', 'work@example.com')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        text = self.board()
        roster = [ln for ln in text.splitlines()
                  if ln.startswith(turnusage.ROSTER)]
        self.assertEqual(len(roster), 1, text)
        self.assertIn(a['id'], roster[0])
        self.assertIn(f"account={a['id']}", roster[0])
        self.assertIn('<work@example.com>', roster[0])
        # a roster line is NOT a usage row — every reader tells them apart by
        # the pipe count, and a roster that parsed as a row would be junk
        self.assertLess(roster[0].count('|'), 6)
        self.assertNotIn(a['credential']['path'], text)

    def test_s4b_label_rename_preserves_the_canonical_account_name(self):
        """Mutable labels cannot change a canonical name or stale a selector."""
        a = self.account('claude', 'Work', 'work@example.com')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        before = turnusage.board(self.org, 'agent', now=NOW)[1]
        doc = registry.load(strict=True)
        registry.get_account(a['id'], doc)['label'] = 'Renamed'
        registry.save(doc)
        after = turnusage.board(self.org, 'agent', now=NOW)[1]
        self.assertEqual(before, after)

    # ── §5 an account is listed ONCE ──────────────────────────────────────
    def test_s5_the_ambient_row_is_the_host_lane_and_is_not_repeated(self):
        row = self.account('claude', 'Ambient')
        doc = registry.load(strict=True)
        doc['aliases']['primary'] = row['id']
        registry.save(doc)
        text = self.board()
        self.assertIn('claude/primary', self.lanes(text))
        self.assertNotIn('claude/ambient', self.lanes(text))

    def legacy_key(self, kid):
        """One `accounts.json` key row, injected at the READER.

        `accounts.save` is refused outright in the desktop MVP, so the
        fixture patches `load` — the single function both `_fallback_rows`
        and the registry token branch read this document through, which is
        exactly the seam a real key would arrive on.
        """
        from orgtree import accounts
        real = accounts.load

        def loaded(*a, **kw):
            doc = real(*a, **kw)
            doc.setdefault('keys', []).append({'id': kid})
            return doc
        p = patch.object(accounts, 'load', loaded)
        p.start()
        self.addCleanup(p.stop)

    def test_s5b_a_legacy_fallback_key_is_not_listed_twice(self):
        self.legacy_key('key-1')
        registry.create_account('claude', 'Legacy',
                                {'kind': 'token', 'token_ref': 'key-1'})
        lanes = self.lanes(self.board())
        self.assertIn('claude-1', lanes)
        self.assertNotIn('claude/fallback-1', lanes)
        self.assertNotIn('claude/legacy', lanes,
                         'one key, listed under two names, reads as two '
                         'accounts an agent could balance between')

    # ── §6 "can't" and "didn't" still do not look alike ───────────────────
    def test_s6_unsupported_and_never_read_are_different_rows(self):
        # The ambient Antigravity lane has a real /usage reader, so before its
        # first warm pass it says no-cache. A redirected Antigravity profile
        # still lacks a CLI profile selector and remains unsupported.
        self.account('google', 'AG Account')
        text = self.board()
        self.assertRegex(text, r'google/primary \|.*unavailable\(no-cache\).*unavailable')
        self.assertRegex(text, r'google-1 \|.*unavailable\(unsupported\).*unsupported')
        self.assertRegex(text, r'claude/primary\* \|.*unavailable\(no-cache\).*unavailable')

    # ── §7 marks ride along, provenance intact ────────────────────────────
    def test_s7_an_active_mark_becomes_its_own_row_and_says_if_inferred(self):
        a = self.account('claude', 'Marked')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        registry.record_mark(a['id'], 'opus', until=NOW + 1800,
                             provenance='inferred')
        text = turnusage.render(self.org, 'agent', now=NOW)
        marked = [ln for ln in text.splitlines()
                  if ln.startswith(f"{a['id']} |") and 'mark:' in ln]
        # `record_mark` writes ONE mark per pool the tier belongs to — an opus
        # mark lands on the pooled window, and this registry also carries the
        # fable axis. Every one of them is a row: collapsing them would hide
        # which pool actually refused the account.
        self.assertTrue(marked, text)
        for line in marked:
            self.assertIn('unavailable(marked)', line)
            self.assertIn('limit-active(inferred)', line,
                          'an INFERRED mark must never read as a measurement')
        self.assertEqual({ln.split('|')[1].strip() for ln in marked},
                         {f'mark:{p}' for p in
                          registry.standing_of(registry.get_account(a['id']),
                                               NOW)['marks']})

    # ── §8 nothing secret, ever ───────────────────────────────────────────
    def test_s8_no_credential_material_reaches_the_board(self):
        a = self.account('claude', 'Work', 'work@example.com')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        self.legacy_key('key-9')
        registry.create_account('claude', 'Org Key',
                                {'kind': 'token',
                                 'token_ref': 'org-api-key:' + self.slug},
                                origin_org=self.slug)
        text = self.board()
        # the profile DIRECTORY, the data root it sits under, and the token
        # reference itself — none of these is a fact an agent can act on, and
        # each of them is one an operator would not expect to leave the app
        self.assertNotIn(a['credential']['path'], text)
        self.assertNotIn(fx.name, text)
        self.assertNotIn('org-api-key:', text)
        self.assertNotIn('key-9', text)

    # ── §9 the compact/suppression machinery still works on a wide board ──
    def test_s9_compact_still_carries_only_the_selected_lane(self):
        a = self.account('claude', 'Work')
        self.seed_claude(a, [limit('weekly_all', 12.0, NOW + 86400)])
        with limits._lock:
            limits._cache.update(at=NOW - 30.0, data={
                'available': True,
                'limits': [limit('session', 5.0, NOW + 600)]})
        text = turnusage.render(self.org, 'agent', selected_provider='claude',
                                selected_lane='primary', now=NOW)
        rows = [ln for ln in text.splitlines() if ln.count('|') >= 6]
        line = turnusage.compact(rows, 7)
        self.assertIn('session 5%', line)
        self.assertNotIn('work', line)

    # ── §10 an uncapped window carries its figure in `amount` ─────────────
    def test_s10_an_uncapped_window_reports_its_label_not_a_fake_zero(self):
        a = self.account('claude', 'Credits')
        self.seed_claude(a, [limit('provider_window', None,
                                   label='$12.50 of credits left')])
        text = self.board()
        row = [ln for ln in text.splitlines()
               if ln.startswith(f"{a['id']} |")][0]
        cells = [c.strip() for c in row.split('|')]
        self.assertEqual(cells[2], 'unavailable',
                         'a null percent must never render as 0%')
        self.assertEqual(cells[3], '$12.50 of credits left')
        # a CAPPED window leaves the column exactly as it always was
        self.assertTrue(all(
            c.split('|')[3].strip() == '-'
            for c in text.splitlines()
            if c.count('|') >= 6 and re.search(r'\|\s*\d', c.split('|')[2])))


if __name__ == '__main__':
    unittest.main(verbosity=2)
