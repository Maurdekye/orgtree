"""Account-isolated freeze deadlines, honest retry estimates and background correction."""
import datetime
import os
import tempfile
import time
import unittest
from unittest.mock import patch


def _iso(epoch):
    return datetime.datetime.fromtimestamp(
        epoch, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _board(now, *lanes):
    return {"available": True, "limits": [
        {"kind": k, "group": k, "percent": p,
         "severity": "critical" if p >= 100 else "normal",
         "resets_at": _iso(now + out), "is_active": p >= 100, "model": m}
        for (k, m, p, out) in lanes]}


# the two error shapes that matter, in the shape the incident produced
GENERIC_429 = ('API Error: 429 {"type":"error","error":'
               '{"type":"rate_limit_error","message":"Rate limit exceeded"}}')
PER_MINUTE_429 = ('API Error: 429 {"type":"error","error":{"type":'
                  '"rate_limit_error","message":"Number of requests has '
                  'exceeded your per-minute rate limit"}}')
USAGE_WALL_NO_TIME = "Claude AI usage limit reached"


class ManagedResetSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-mrs-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import (ledger, limits, registry, store,
                                            supervisor)
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(
                f"store bound outside fixture: {store.DATA_ROOT}")
        cls.ledger, cls.limits = ledger, limits
        cls.registry, cls.store, cls.supervisor = registry, store, supervisor

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        self.limits.invalidate()

    _seq = 0

    def _row(self):
        ManagedResetSelectionTests._seq += 1
        return self.registry.create_account(
            "claude", "managed-under-test",
            {"kind": "managed",
             "path": os.path.join(self.root, f"mrs-{self._seq}")})

    def _org(self, slug, account, model="fable"):
        org = self.ledger.Org.create(slug)
        org.nodes["root"] = {"state": "live", "parent": None,
                             "generation": 1, "model": model,
                             "account": account}
        self.store.save_org(org)
        return org

    def _host_board(self, data, now):
        with self.limits._lock:
            self.limits._cache.update(at=now, data=data, account="")

    def _account_board(self, account_id, data, now):
        with self.limits._lock:
            self.limits._key_cache[f"acct:{account_id}"] = {"at": now,
                                                            "data": data}

    # -- R0 . POSITIVE CONTROL ------------------------------------------
    def test_R0_control_host_board_answers_a_timeless_usage_wall(self):
        now = time.time()
        self._host_board(_board(now, ("session", None, 100, 3 * 3600)), now)
        ts, src = self.supervisor._limit_reset_ts(
            USAGE_WALL_NO_TIME, subscription=True, trusted=True, tier="fable")
        self.assertIsNotNone(ts, "host board did not answer - control broken")
        self.assertEqual(src, "usage:session")
        self.assertAlmostEqual(ts - now, 3 * 3600, delta=5)

    # -- R1 . a 429 that IS subscription exhaustion must be timed --------
    def test_R1_exhausted_lane_answers_a_generic_429(self):
        now = time.time()
        self._host_board(
            _board(now, ("weekly_scoped", "Fable 5", 100, 4 * 86400),
                   ("session", None, 12, 2 * 3600)), now)
        ts, src = self.supervisor._limit_reset_ts(
            GENERIC_429, subscription=True, trusted=True, tier="fable")
        self.assertIsNotNone(
            ts, "a 429 against a 100%-spent fable lane was refused the board")
        self.assertAlmostEqual(ts - now, 2 * 3600, delta=5)  # unnamed limit keeps session cap
        self.assertTrue(src.startswith("usage:"), src)

    def test_R1_control_per_minute_429_on_healthy_board_unanswered(self):
        now = time.time()
        self._host_board(
            _board(now, ("weekly_scoped", "Fable 5", 31, 4 * 86400),
                   ("session", None, 12, 2 * 3600)), now)
        ts, _src = self.supervisor._limit_reset_ts(
            PER_MINUTE_429, subscription=True, trusted=True, tier="fable")
        self.assertIsNone(
            ts, "a per-minute 429 was timed off a lane nothing had spent")

    # -- R2 . the MANAGED account's own board must answer ----------------
    def test_R2_managed_account_board_answers_its_own_wall(self):
        now = time.time()
        row = self._row()
        # the HOST board is healthy and must NOT be the source of the answer
        self._host_board(_board(now, ("session", None, 4, 90 * 60)), now)
        # the MANAGED account's own board is the spent one
        self._account_board(
            row["id"],
            _board(now, ("weekly_scoped", "Fable 5", 100, 3 * 86400)), now)
        ts, src = self.supervisor._limit_reset_ts(
            "You reached your Fable limit", subscription=False, trusted=True,
            tier="fable", account=row["id"])
        self.assertIsNotNone(ts, "managed account board was never consulted")
        self.assertAlmostEqual(
            ts - now, 3 * 86400, delta=5,
            msg="answered from the HOST board - the wrong account's quota")
        self.assertTrue(src.startswith("usage:"), src)

    def test_R2_control_never_borrow_another_accounts_quota(self):
        now = time.time()
        self._row()
        self._host_board(_board(now, ("session", None, 100, 3 * 3600)), now)
        ts, _src = self.supervisor._limit_reset_ts(
            USAGE_WALL_NO_TIME, subscription=False, trusted=True,
            tier="fable")
        self.assertIsNone(ts, "borrowed the host subscription's quota")

    # -- R3 . a guess must not be labelled a measurement -----------------
    def test_R3_retry_floor_is_inferred_and_can_be_corrected(self):
        now = time.time()
        row = self._row()
        self.supervisor._record_account_reset(row['id'], 'fable', GENERIC_429, None, '', True)
        guessed = self.registry.active_mark(row['id'], 'fable')
        self.assertEqual(guessed['provenance'], 'inferred')
        self.assertAlmostEqual(guessed['until'], now+self.supervisor.PROBE_FLOOR, delta=2)
        self.supervisor._record_account_reset(row['id'], 'fable', 'limit', now+60, 'text', True)
        self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'], now+60)
        self.supervisor._record_account_reset(row['id'], 'fable', GENERIC_429, None, '', True)
        self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'], now+60)

    # -- R4 . the durable record must not disagree with itself -----------
    def test_R4_mark_sourced_freeze_states_consistent_schedule_kind(self):
        now = time.time()
        row = self._row()
        self.registry.record_mark(row["id"], "fable", now + 3 * 86400,
                                  provenance="observed", now=now)
        self._org("mrs-gate", row["id"], model="fable")
        try:
            self.supervisor._run_one_turn("mrs-gate", "root", "hello")
        except Exception:
            pass                     # the in-slot frozen refusal raises
        fz = (self.store.load_org("mrs-gate").node("root") or {}).get("frozen")
        self.assertIsInstance(fz, dict, "gate wrote no freeze - case is inert")
        # control: the gate DID write the record it is supposed to write
        self.assertEqual(fz.get("reset_src"), "account-mark")
        self.assertEqual(fz.get("provenance"), "observed")
        self.assertIn(
            "schedule_kind", fz,
            "the gate writes a horizon and never says what kind it is")
        self.assertEqual(
            fz["schedule_kind"], "observed-deadline",
            "an OBSERVED mark rendered as a probe - the desk shows "
            "'capacity recheck' for a measured wall")

    # -- R5 . the correction pass must reach a bound account -------------
    def test_R5_correction_pass_is_not_dead_for_a_bound_account(self):
        now = time.time()
        row = self._row()
        org = self._org("mrs-fix", row["id"], model="fable")
        stamped = now + self.supervisor.PROBE_FLOOR
        org.node("root")["frozen"] = {
            "limit": True, "until_ts": stamped,
            "until": "capacity recheck soon", "reset_src": "probe",
            "schedule_kind": "probe", "account": row["id"],
            "provenance": "observed"}
        self.store.save_org(org)
        self._account_board(
            row["id"],
            _board(now, ("weekly_scoped", "Fable 5", 100, 3 * 86400)), now)
        self.registry.record_mark(row["id"], "fable", stamped, provenance="inferred")
        # Background reads use the same profile; no real OAuth/network in tests.
        with patch.object(self.limits.subproxy, "profile_access_token", return_value="fixture"):
            wrote = self.supervisor._refresh_freeze_reset(
            "mrs-fix", "root", "You reached your Fable limit", stamped,
            subscription=False, trusted=True, tier="fable",
            stamped_kind="probe", account=row["id"])
        self.assertTrue(wrote, "correction pass never re-timed a bound freeze")
        fz = (self.store.load_org("mrs-fix").node("root") or {}).get("frozen")
        self.assertAlmostEqual(fz["until_ts"] - now, 3 * 86400, delta=5)
        self.assertNotEqual(fz["reset_src"], "probe")
        self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'], fz['until_ts'])


    def test_healthy_generic_429_and_wrong_model_do_not_borrow_usage(self):
        now = time.time()
        for model, percent in [('Fable 5', 99), ('Opus', 100)]:
            self._host_board(_board(now, ('weekly_scoped', model, percent, 86400),
                                   ('session', None, 10, 3600)), now)
            self.assertEqual(self.supervisor._limit_reset_ts(GENERIC_429, tier='fable'), (None, ''))
        self._host_board(_board(now, ('session', None, 100, 3600)), now)
        self.assertEqual(self.supervisor._limit_reset_ts(PER_MINUTE_429, tier='fable'), (None, ''))

    def test_background_warm_includes_authenticated_profiles_without_host(self):
        row = self._row()
        self.registry.set_auth(row['id'], 'authenticated')
        self._row()  # unobserved profile must not cause an OAuth request
        calls = []
        board = _board(time.time(), ('session', None, 100, 3600))
        def read(account, *, allow_fetch=False):
            calls.append((account, allow_fetch))
            return board, 0
        with patch.object(self.limits, 'account_readout', side_effect=read):
            self.assertEqual(self.supervisor._warm_registered_usage(), [board])
        self.assertEqual(calls, [(row['id'], True)])
        self.assertEqual(self.supervisor._warm_interval(self.limits.pressure(board)), 45)
        self.assertIsNotNone(self.limits.next_reset(data=board))

    def test_account_cache_is_isolated_and_expires_as_evidence(self):
        now = time.time()
        row = self._row()
        other = self._row()
        self._account_board(row['id'], _board(now, ('session', None, 100, 3600)), now)
        self._host_board(_board(now, ('session', None, 100, 7200)), now)
        self.assertIsNone(self.supervisor._limit_reset_ts(USAGE_WALL_NO_TIME, account=other['id'])[0])
        self.assertAlmostEqual(self.supervisor._limit_reset_ts(USAGE_WALL_NO_TIME, account=row['id'])[0], now+3600, delta=2)
        self._account_board(row['id'], _board(now, ('session', None, 100, 3600)), now-self.limits.MAX_EVIDENCE_AGE-1)
        self.assertIsNone(self.supervisor._limit_reset_ts(USAGE_WALL_NO_TIME, account=row['id'])[0])

    def test_correction_cannot_overwrite_a_newer_mark(self):
        now = time.time()
        row = self._row()
        self.registry.record_mark(row['id'], 'fable', now+300, provenance='inferred')
        self.assertTrue(self.registry.correct_mark(row['id'], 'fable', now+300, now+60, provenance='observed'))
        self.assertFalse(self.registry.correct_mark(row['id'], 'fable', now+300, now+600, provenance='observed'))
        self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'], now+60)

    def test_simultaneous_profile_refreshes_share_one_http_request(self):
        import io, json
        from concurrent.futures import ThreadPoolExecutor
        calls = []
        def reply(*args, **kwargs):
            calls.append(1)
            time.sleep(.04)
            return io.BytesIO(json.dumps({'five_hour': {'utilization': 40,
                'resets_at': _iso(time.time()+3600)}}).encode())
        with patch.object(self.limits.urllib.request, 'urlopen', side_effect=reply):
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: self.limits.fetch_for_token('fixture', 'parallel-fixture'), range(8)))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(r['available'] and r['limits'][0]['percent'] == 40 for r in results))

    def test_account_reassignment_prevents_old_background_correction(self):
        now = time.time()
        row, other = self._row(), self._row()
        org = self._org('mrs-rebound', other['id'])
        org.node('root')['frozen'] = {'limit': True, 'until_ts': now+300, 'schedule_kind': 'probe'}
        self.store.save_org(org)
        self.registry.record_mark(row['id'], 'fable', now+300, provenance='inferred')
        with patch.object(self.supervisor, '_limit_reset_ts', return_value=(now+7200, 'text')):
            self.assertFalse(self.supervisor._refresh_freeze_reset('mrs-rebound', 'root', 'limit',
                now+300, account=row['id'], tier='fable', stamped_kind='probe'))
        self.assertEqual(self.store.load_org('mrs-rebound').node('root')['frozen']['until_ts'], now+300)
        self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'], now+300)

    def test_key_billed_turn_cannot_borrow_bound_subscription_readout(self):
        now = time.time()
        row = self._row()
        self._account_board(row['id'], _board(now, ('session', None, 100, 10800)), now)
        for billed_key in (False, True):
            account = self.supervisor._reset_readout_account(billed_key, row['id'])
            answer = self.supervisor._limit_reset_ts(USAGE_WALL_NO_TIME,
                subscription=False, account=account, tier='fable')
            if billed_key:
                self.assertEqual(answer, (None, ''))
            else:
                self.assertAlmostEqual(answer[0], now+10800, delta=2)
        self.assertEqual(self.supervisor._reset_readout_account(False, 'primary'), '')

    def test_freeze_correction_respects_ownership_races(self):
        # (was the V1 fallback-window correction test; the window died with
        # the org-key lane, 2026-09-12 — the ownership races it also pinned
        # for the FREEZE and the MARK keep their coverage here)
        for race in ('none', 'reassigned', 'mark_changed'):
            with self.subTest(race=race):
                now = time.time()
                row, other = self._row(), self._row()
                slug = 'mrs-window-' + race.replace('_', '-')
                org = self._org(slug, other['id'] if race == 'reassigned' else row['id'])
                stamped, actual = now+6*86400, now+7200
                org.node('root')['frozen'] = {'limit': True, 'until_ts': stamped,
                    'schedule_kind': 'probe'}
                self.store.save_org(org)
                mark = stamped+100 if race == 'mark_changed' else stamped
                self.registry.record_mark(row['id'], 'fable', mark, provenance='inferred')
                with patch.object(self.supervisor, '_limit_reset_ts', return_value=(actual, 'text')):
                    wrote = self.supervisor._refresh_freeze_reset(slug, 'root', 'limit',
                        stamped, account=row['id'], tier='fable', stamped_kind='probe')
                self.assertEqual(wrote, race == 'none')
                result = self.store.load_org(slug)
                self.assertEqual(result.node('root')['frozen']['until_ts'],
                    actual if race == 'none' else stamped)
                self.assertEqual(self.registry.active_mark(row['id'], 'fable')['until'],
                    actual if race == 'none' else mark)

    def test_pooled_correction_updates_only_its_inferred_fable_companion(self):
        for sibling in ('companion', 'observed', 'independent', 'absent'):
            with self.subTest(sibling=sibling):
                now = time.time()
                row = self._row()
                self.registry.record_mark(row['id'], 'opus', now+300, provenance='inferred')
                if sibling in ('observed', 'independent'):
                    self.registry.record_mark(row['id'], 'fable', now+600,
                        provenance='observed' if sibling == 'observed' else 'inferred')
                elif sibling == 'absent':
                    doc = self.registry.load(strict=True)
                    self.registry.get_account(row['id'], doc)['marks'].pop('fable')
                    self.registry.save(doc)
                self.assertTrue(self.registry.correct_mark(row['id'], 'opus', now+300,
                    now+10800, provenance='observed'))
                pooled = self.registry.active_mark(row['id'], 'opus')
                fable = self.registry.active_mark(row['id'], 'fable')
                self.assertEqual(pooled['until'], now+10800)
                self.assertEqual(fable['until'], now+(600 if sibling in ('observed','independent') else 10800))
                self.assertEqual(fable['provenance'], 'observed' if sibling == 'observed' else 'inferred')

if __name__ == "__main__":
    unittest.main()
