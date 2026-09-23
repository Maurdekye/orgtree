"""THE RESERVE CARD ONLY APPEARS WHEN THE AGENT IS ACTUALLY ON RESERVE
(user ruling 2026-09-16, docket `only-show-the-reserve-card-on-a-luna-agent-when`:
"dont show a card on a luna when it isnt running on reserve; only show a card
when its on reserve").

THE BUG THIS FILE PINS. A Luna does not always spend the reserve bucket. It
accumulates in `gpt-reserve` and does not touch the normal weekly limit at all
UNTIL reserve is completely full — except in two cases, where it spends the
normal weekly limit instead: the user turned the reserve preference off for
that agent, or the `gpt-reserve` lane is unavailable. So "is a Luna" and "is
on reserve" are different questions, and `route_label` used to answer the
first while looking like it answered the second: a Luna running on the plan
pool because reserve was spent or withdrawn still wore a token reading
"direct · reserve out", and one the provider bounced off reserve wore
"direct · rerouted off reserve". Both are reserve cards on an agent that is
not on reserve.

⚠ THE CASE THIS FILE REALLY EXISTS FOR is the UNKNOWN one, because it is the
one that makes this kind of fix wrong in the other direction. There are two
distinct unknowns and they must not be collapsed into "not on reserve":

  * A STALE OR ABSENT USAGE BOARD IS NOT AN UNKNOWN LANE. `resolve` picks the
    reserve pool on evidence it does not have — `reason` comes back
    `board-stale` or `board-unknown` — because unknown never excludes and the
    turn is its own probe. But a reserve route puts `gpt-reserve` on the wire,
    and sending that model IS spending reserve. Those turns are ON reserve and
    MUST show the card; treating them as unknown would hide the card on most
    healthy turns. `test_unread_board_still_lands_on_reserve` is the control.

  * AN UNATTRIBUTABLE REROUTE IS A GENUINELY UNKNOWN LANE. The server reported
    `model/rerouted` to an id no pool is known for, so where the turn ran was
    never established. `on_reserve` answers None there and the card is hidden —
    a card shown on it would be a confident claim built on a reading nobody
    took, which is the same class of bug as the one being fixed.

Every gate is therefore asserted in BOTH polarities, and `on_reserve` is
checked for the three-way distinction itself (True / False / None) rather than
only for truthiness — a rule that answered `False` where it should answer
`None` would pass a truthiness test and still have thrown the distinction away.
"""
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import codex_route as cr


def route(**over):
    """A luna route receipt in the shape `_codex_route_stamp` writes."""
    base = {
        "requested": "luna", "route": "reserve", "pool": cr.RESERVE_POOL,
        "model": cr.RESERVE_MODEL, "account": "openai/primary",
        "reason": "granted", "evidence": "board", "board_age": 3.0,
        "reset_ts": None, "selection": "preflight", "prefer": cr.RESERVE_POOL,
    }
    base.update(over)
    return base


def direct(**over):
    """A luna route that went down the PLAN pool instead."""
    return route(route="direct", pool=cr.PLAN_POOL,
                 model=cr.DIRECT_LUNA_MODEL, **over)


def reroute(to):
    return {"fromModel": cr.RESERVE_MODEL, "toModel": to, "reason": "capacity"}


class OnReserveTests(unittest.TestCase):
    """`on_reserve` is the ONE definition; everything else reads it."""

    def test_reserve_pool_is_true(self):
        self.assertIs(cr.on_reserve(route()), True)

    def test_plan_pool_is_false_not_none(self):
        # FALSE, not None: we know perfectly well it is not on reserve, and
        # calling that "unknown" would lose a fact we hold
        self.assertIs(cr.on_reserve(direct(reason="reserve-exhausted")), False)

    def test_every_way_a_luna_falls_to_the_weekly_limit_is_false(self):
        # the three the ticket names, by the `reason` resolve actually emits
        for why in ("reserve-exhausted",          # reserve spent
                    "no-grant",                   # lane unavailable
                    "login-kind",                 # api-key login holds no reserve
                    "preferred",                  # reserve preference OFF
                    "reserve-marked:rejected",    # provider rejected reserve
                    "both-out:reserve-exhausted,direct-exhausted"):
            self.assertIs(cr.on_reserve(direct(reason=why)), False, why)

    def test_unread_board_still_lands_on_reserve(self):
        # ⚠ THE CONTROL. An unread/stale board does not make the LANE
        # unknown — the turn was still sent as `gpt-reserve`.
        for why in ("board-unknown", "board-stale"):
            r = route(reason=why, evidence="none", board_age=None)
            self.assertIs(cr.on_reserve(r), True, why)
            self.assertEqual(cr.route_label(r, live=True), "reserve", why)

    def test_reroute_onto_reserve_is_true_even_when_sent_direct(self):
        r = direct(rerouted=reroute(cr.RESERVE_MODEL))
        self.assertIs(cr.on_reserve(r), True)

    def test_reroute_off_reserve_is_false_even_when_sent_to_reserve(self):
        r = route(rerouted=reroute(cr.DIRECT_LUNA_MODEL))
        self.assertIs(cr.on_reserve(r), False)

    def test_unattributable_reroute_is_none_not_false(self):
        # ⚠ the whole point of the third value
        r = route(rerouted=reroute("gpt-9-mystery"))
        self.assertIsNone(cr.on_reserve(r))
        r2 = route(rerouted=reroute(""))
        self.assertIsNone(cr.on_reserve(r2))

    def test_non_routing_tiers_and_no_record_are_none(self):
        self.assertIsNone(cr.on_reserve(None))
        self.assertIsNone(cr.on_reserve(route(requested="astra")))
        # a legacy `gpt-reserve` node is not the routed tier either
        self.assertIsNone(cr.on_reserve(route(requested=cr.LEGACY_RESERVE_TIER)))

    def test_a_receipt_with_no_pool_is_none(self):
        r = route()
        r.pop("pool")
        self.assertIsNone(cr.on_reserve(r))

    def test_explicit_rerouted_argument_overrides_the_record(self):
        r = route(rerouted=reroute(cr.DIRECT_LUNA_MODEL))
        self.assertIs(cr.on_reserve(r, None), True)   # ignore the record


class RouteLabelTests(unittest.TestCase):
    """The card's text. It exists only where `on_reserve` is True."""

    def test_running_on_reserve_shows_the_card(self):
        self.assertEqual(cr.route_label(route(), live=True), "reserve")

    def test_last_turn_on_reserve_keeps_the_card_with_a_last_prefix(self):
        # user ruling 2026-09-17, answering the question on the docket item:
        # an idle luna whose PREVIOUS turn ran on reserve keeps its card. The
        # gate is about the LANE; liveness is a separate axis and keeps the
        # 2026-09-04 "last: " wording so idle is never read as running.
        self.assertEqual(cr.route_label(route(), live=False), "last: reserve")

    def test_no_card_for_a_luna_on_the_weekly_limit(self):
        # the reported bug, in both liveness states
        for why in ("reserve-exhausted", "no-grant", "preferred", "login-kind",
                    "both-out:reserve-exhausted,direct-exhausted"):
            for live in (True, False):
                self.assertIsNone(cr.route_label(direct(reason=why), live=live),
                                  f"{why} live={live}")

    def test_no_card_when_the_provider_rerouted_off_reserve(self):
        r = route(rerouted=reroute(cr.DIRECT_LUNA_MODEL))
        self.assertIsNone(cr.route_label(r, live=True))
        self.assertIsNone(cr.route_label(r, live=False))

    def test_no_card_when_the_lane_was_never_established(self):
        r = route(rerouted=reroute("gpt-9-mystery"))
        self.assertIsNone(cr.route_label(r, live=True))
        self.assertIsNone(cr.route_label(r, live=False))

    def test_a_reroute_onto_reserve_says_it_was_rerouted(self):
        r = direct(rerouted=reroute(cr.RESERVE_MODEL))
        self.assertEqual(cr.route_label(r, live=True), "reserve · rerouted")
        self.assertEqual(cr.route_label(r, live=False), "last: reserve · rerouted")
        # sent to reserve AND served on reserve is just "reserve"
        self.assertEqual(
            cr.route_label(route(rerouted=reroute(cr.RESERVE_MODEL)), live=True),
            "reserve")

    def test_no_card_on_a_tier_that_does_not_route(self):
        for tier in ("astra", "sol", "terra", cr.LEGACY_RESERVE_TIER):
            self.assertIsNone(cr.route_label(route(requested=tier), live=True), tier)
        self.assertIsNone(cr.route_label(None, live=True))

    def test_the_label_agrees_with_on_reserve_on_every_shape(self):
        # the invariant, stated once: a card exists if and only if the lane
        # answer is True. Nothing may show a card on False or on None.
        shapes = [
            route(), direct(), direct(reason="no-grant"),
            route(rerouted=reroute(cr.RESERVE_MODEL)),
            direct(rerouted=reroute(cr.RESERVE_MODEL)),
            route(rerouted=reroute(cr.DIRECT_LUNA_MODEL)),
            route(rerouted=reroute("gpt-9-mystery")),
            route(requested="astra"), None,
        ]
        for s in shapes:
            for live in (True, False):
                self.assertEqual(
                    cr.route_label(s, live=live) is not None,
                    cr.on_reserve(s) is True,
                    f"label/on_reserve disagree: {s} live={live}")


class ResolveIntegrationTests(unittest.TestCase):
    """The real resolver, not hand-built receipts — the gate must hold on the
    routes `resolve` actually produces for the ticket's three cases."""

    ACCT = "openai/primary"

    def _board(self, *, percent, complete=True, absent=False):
        # NORMALIZED windows (`codex_limits._normalize` shape): `model` is the
        # limitName, and the reserve bucket is the one named after the reserve
        # model. A plan window (unnamed) is always present so the fallback
        # pool has room to fall back to.
        limits = [{"model": "", "percent": 10.0, "observed_at": 1.0,
                   "resets_at": None}]
        if not absent:
            limits.append({"model": cr.RESERVE_MODEL, "percent": percent,
                           "observed_at": 1.0, "resets_at": None})
        return {"available": True, "stale": False, "complete": complete,
                "account": self.ACCT, "age": 1.0, "limits": limits}

    def test_reserve_with_room_is_on_reserve(self):
        r = cr.resolve("luna", login_kind="chatgpt", board=self._board(percent=20),
                       marks={}, account=self.ACCT, now=1.0,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "reserve")
        self.assertIs(cr.on_reserve(r), True)
        self.assertEqual(cr.route_label(r, live=True), "reserve")

    def test_reserve_preference_off_shows_no_card(self):
        # the user turned the per-agent "Prefer reserve" box OFF: the turn
        # spends the normal weekly limit, so there is no reserve card
        r = cr.resolve("luna", login_kind="chatgpt", board=self._board(percent=20),
                       marks={}, account=self.ACCT, now=1.0, prefer_reserve=False,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "direct")
        self.assertIs(cr.on_reserve(r), False)
        self.assertIsNone(cr.route_label(r, live=True))

    def test_reserve_lane_unavailable_shows_no_card(self):
        # a COMPLETE board that carries no reserve bucket at all = no grant
        r = cr.resolve("luna", login_kind="chatgpt",
                       board=self._board(percent=0, absent=True, complete=True),
                       marks={}, account=self.ACCT, now=1.0,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "direct")
        self.assertEqual(r["reason"], "no-grant")
        self.assertIs(cr.on_reserve(r), False)
        self.assertIsNone(cr.route_label(r, live=True))

    def test_reserve_exhausted_shows_no_card(self):
        r = cr.resolve("luna", login_kind="chatgpt", board=self._board(percent=100),
                       marks={}, account=self.ACCT, now=1.0,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "direct")
        self.assertIs(cr.on_reserve(r), False)
        self.assertIsNone(cr.route_label(r, live=True))

    def test_an_api_key_login_has_no_reserve_and_no_card(self):
        r = cr.resolve("luna", login_kind="api-key", board=self._board(percent=20),
                       marks={}, account=self.ACCT, now=1.0,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "direct")
        self.assertIs(cr.on_reserve(r), False)
        self.assertIsNone(cr.route_label(r, live=True))

    def test_a_board_that_was_never_read_still_shows_the_card(self):
        # ⚠ the control again, through the real resolver: nothing has been
        # read, so `resolve` sends to reserve anyway and the turn is the
        # probe. It IS on reserve and the card must be there.
        blank = {"available": False, "stale": True, "complete": False,
                 "account": None, "age": None, "limits": []}
        r = cr.resolve("luna", login_kind="chatgpt", board=blank, marks={},
                       account=self.ACCT, now=1.0,
                       direct_model="gpt-5.6-luna")
        self.assertEqual(r["route"], "reserve")
        self.assertIs(cr.on_reserve(r), True)
        self.assertEqual(cr.route_label(r, live=True), "reserve")


if __name__ == "__main__":
    unittest.main()
