"""v3 scale: an idle steer poll, through the real HTTP door, reads no org.

The claude PostToolUse hook POSTs /api/orgs/{slug}/nodes/{nid}/steer after
EVERY tool call; at N=100 that is 68% of all requests (scale item, evidence
12). `claim_steer` already had an idle fast path, but the door in front of it
still did a full private `orgtx.org_read` to check the credential's seat, and
a seat's first (unproven) poll opened the halt gate's transaction only to
choose nothing. Now the actor is checked against the shared snapshot
(`store.cached_org`, as `_agent_identity` does for /api/agent) and the empty
claim transaction is skipped.

Speed must not cost a meaning, so besides the cost these tests pin, each
through the door: mail is still delivered; a halted seat and a killswitched
org still get nothing even with mail waiting; a stale or replaced credential
is still refused after the save that made it stale; the poll is still
recorded as a tool-call boundary (D-236). Mutants that break each one are
listed in the change's review packet.
"""
from contextlib import ExitStack
import itertools
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-steer-poll-")
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_V2_TOKEN"] = "test-operator"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

_ENV_SWITCH = os.environ.get("ORGTREE_STEER_CHEAP")   # read BEFORE import

from engine.launch import load_app, TokenGate
load_app()
from fastapi.testclient import TestClient
from orgtree import agentauth, api, ledger, orgtx, store, supervisor as sup, warmpool

assert Path(api.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1])
W = "worker"
KEY = b"steer-poll-cost-fixture-key"
_SERIAL = itertools.count()
SLUGS: list[str] = []


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class SteerPollCostTests(unittest.TestCase):
    CHEAP = True                            # the switch under test, ON

    def setUp(self):
        org = store.create_org(f"spc-{next(_SERIAL)}")
        self.slug = org.d["slug"]
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, "haiku", 0, "boss")
        org.hire(ledger.USER, "boss", "haiku", 0, W)
        store.save_org(org)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "STEER_CHEAP", self.CHEAP))
        self.stack.enter_context(patch.object(agentauth, "_key", KEY))
        self.stack.enter_context(patch.object(sup, "_cancel_working_cache"))
        self.stack.enter_context(patch.object(warmpool, "kill_node"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.stack.enter_context(patch.object(sup, "_emit_committed_steer"))
        # the storage walk is its own concern (and backgrounded): keep it out
        self.stack.enter_context(patch.object(sup, "maybe_storage_check"))
        fd, self.tp = tempfile.mkstemp(prefix="transcript-", suffix=".jsonl", dir=_root.name)
        os.close(fd)
        self.client = TestClient(TokenGate(api.app, "test-operator"))
        self.st = sup.state(self.slug, W)
        self.n = 0

    def tearDown(self):
        self.stack.close()
        with sup._state_lock:
            sup._state.pop((self.slug, W), None)
        store._POOL.close_all(self.slug)

    # -- helpers -----------------------------------------------------------
    def token(self, nid=W):
        return agentauth.node_env(self.slug, nid, store.load_org(self.slug).node(nid))[
            "ORGTREE_AGENT_TOKEN"]

    def poll(self, token=None):
        self.n += 1
        return self.client.post(
            f"/api/orgs/{self.slug}/nodes/{W}/steer",
            headers={"x-orgtree-agent-token": token or self.token()},
            json={"tool_use_id": f"toolu_{self.n}", "transcript_path": self.tp})

    def carrier(self, text):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.post_mail(ledger.USER, W, text, "message")
            store.save_org(org)
        _, tok, _ = sup._envelope(self.slug, W, "mail", base_view="")
        self.assertTrue(tok, "the envelope produced no batch token")
        self.st["steer"] = [{"text": text, "view": text, "toks": [tok]}]

    def edit(self, fn):
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            fn(org)
            store.save_org(org)

    def counting(self):
        stack = ExitStack()
        mocks = [stack.enter_context(patch.object(orgtx, "org_tx", wraps=orgtx.org_tx)),
                 stack.enter_context(patch.object(orgtx, "org_read", wraps=orgtx.org_read)),
                 stack.enter_context(patch.object(store, "load_org", wraps=store.load_org))]
        return stack, mocks

    # -- cost ----------------------------------------------------------------
    def test_idle_poll_through_the_door_reads_no_org(self):
        token = self.token()
        stack, (tx, read, load) = self.counting()
        with stack:
            r = self.poll(token)            # unproven seat: its scan really reads
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["messages"], [])
            # CONTROL: the instruments can count at all
            self.assertGreater(read.call_count, 0, "the first poll's scan read nothing")
            for m in (tx, read, load):
                m.reset_mock()
            polls = self.st.get("boundary_polls")
            for _ in range(20):
                r = self.poll(token)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json(), {"messages": [], "delivery_id": None})
            self.assertEqual(tx.call_count, 0, "an idle poll opened an org transaction")
            self.assertEqual(read.call_count, 0, "an idle poll did a private org read")
            self.assertEqual(load.call_count, 0, "an idle poll loaded the org")
        # D-236: every poll is still a recorded tool-call boundary
        self.assertEqual(self.st.get("boundary_polls"), polls + 20)

    def test_first_poll_opens_no_transaction_and_arms_the_fast_path(self):
        self.assertFalse(sup._steer_attempts_clear(self.st))
        stack, (tx, read, _load) = self.counting()
        with stack:
            self.assertEqual(sup.claim_steer(self.slug, W, "toolu_first", self.tp), (None, []))
            self.assertGreater(read.call_count, 0, "CONTROL: the unproven scan must read")
            self.assertEqual(tx.call_count, 0,
                             "an unproven poll with no carrier opened the claim transaction")
        self.assertTrue(sup._steer_attempts_clear(self.st),
                        "the first poll did not prove the seat clear")

    # -- meanings kept ---------------------------------------------------------
    def test_pending_mail_is_still_delivered_through_the_door(self):
        self.poll()                         # prove the seat clear first
        self.assertTrue(sup._steer_attempts_clear(self.st))
        self.carrier("hello mid-task")
        r = self.poll()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["delivery_id"], body)
        self.assertTrue(any("hello mid-task" in m for m in body["messages"]), body)

    def _blocked_gets_nothing(self, block):
        self.poll()
        self.carrier("must not arrive")
        token = self.token()
        self.edit(block)
        before = store.load_org(self.slug).d.get("delivering")
        r = self.poll(token)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["messages"], [], "a blocked seat was handed mail")
        self.assertEqual(store.load_org(self.slug).d.get("delivering"), before)

    def test_halted_seat_gets_nothing_even_with_mail(self):
        def halt(org):
            org.nodes[W]["halt"] = {"at": sup.now_iso(), "by": ledger.USER}
        self._blocked_gets_nothing(halt)

    def test_killswitched_org_gets_nothing_even_with_mail(self):
        def kill(org):
            org.d["killswitch"] = {"at": sup.now_iso(), "by": ledger.USER}
        self._blocked_gets_nothing(kill)

    def test_stale_generation_is_refused_after_the_save(self):
        old = self.token()
        self.assertEqual(self.poll(old).status_code, 200)   # warms the shared snapshot

        def bump(org):
            org.nodes[W]["generation"] = int(org.nodes[W].get("generation", 0)) + 1
        self.edit(bump)
        r = self.poll(old)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.poll(self.token()).status_code, 200)

    def test_replaced_seat_is_refused_after_the_save(self):
        old = self.token()
        self.assertEqual(self.poll(old).status_code, 200)

        def replace(org):
            org.delete(ledger.USER, W)
            org.hire(ledger.USER, "boss", "haiku", 0, W)
        self.edit(replace)
        r = self.poll(old)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.poll(self.token()).status_code, 200)

    def test_archived_seat_is_refused_after_the_save(self):
        old = self.token()
        self.assertEqual(self.poll(old).status_code, 200)

        def archive(org):
            org.nodes[W]["state"] = "archived"
        self.edit(archive)
        self.assertEqual(self.poll(old).status_code, 403)


class SwitchOffTests(SteerPollCostTests):
    """The switch is OFF by default, and off is exactly the old behaviour:
    every meaning test above runs again here (inherited), while the two cost
    tests are replaced by their opposites."""
    CHEAP = False

    def test_switch_is_off_by_default(self):
        self.assertIsNone(_ENV_SWITCH, "the test environment set the switch")
        # the value the module computed at import, not the patched one
        self.assertFalse(type(self)._imported, "STEER_CHEAP defaulted on")

    def test_idle_poll_through_the_door_reads_no_org(self):
        # OFF: the door's credential check still does its private org_read
        token = self.token()
        self.poll(token)
        stack, (_tx, read, _load) = self.counting()
        with stack:
            self.assertEqual(self.poll(token).status_code, 200)
            self.assertGreater(read.call_count, 0, "switch off, but the door skipped org_read")

    def test_first_poll_opens_no_transaction_and_arms_the_fast_path(self):
        # OFF: an unproven poll opens the claim transaction, as it always did
        stack, (tx, _read, _load) = self.counting()
        with stack:
            self.assertEqual(sup.claim_steer(self.slug, W, "toolu_first", self.tp), (None, []))
            self.assertGreater(tx.call_count, 0, "switch off, but the claim tx was skipped")


SwitchOffTests._imported = sup.STEER_CHEAP


class StoragePrecheckTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "STEER_CHEAP", True))

    def tearDown(self):
        self.stack.close()

    def test_precheck_reads_the_snapshot_and_still_fires(self):
        org = store.create_org(f"spc-st-{next(_SERIAL)}")
        slug = org.d["slug"]
        SLUGS.append(slug)
        org.d["kiosk"] = {"storage_limit_mb": 5}
        store.save_org(org)

        class Now:                          # run the background walk inline
            def __init__(self, target, daemon=None):
                self.target = target

            def start(self):
                self.target()

        sup._storage_check_at.pop(slug, None)
        with patch.object(sup.threading, "Thread", Now), \
                patch.object(sup, "storage_check") as walk, \
                patch.object(store, "load_org", wraps=store.load_org) as load:
            sup.maybe_storage_check(slug)
        walk.assert_called_once_with(slug)
        self.assertEqual(load.call_count, 0, "the pre-check did a private full load")


if __name__ == "__main__":
    unittest.main()
