"""v3 scale gate: the PostToolUse steer fetch takes NO transaction when idle.

The claude hook POSTs /steer after every tool call; `claim_steer` and
`scan_steer_records` used to open two halt transactions and load the whole org
on every one of them, just to find nothing. They now return at once when there
is no RAM carrier and a scan has proven no attempt is open since the last
attempt write (`supervisor._steer_attempts_clear`).

Correctness outranks speed: mid-task mail must never be missed. So besides the
idle case, these tests pin the three ways the proof could go stale:
  * an attempt written WHILE a scan is running (between its generation read
    and its "clear" verdict) -- the race;
  * an attempt written by a claim after a clear verdict;
  * a fresh process (no RAM) with an attempt already durable.
Each ends in a real committed delivery record (`recorded == 1`), not just a
flag value, and each is broken by a named mutant (see MUTANTS in the
breadcrumbs of the change).
"""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="orgtree-steer-idle-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, orgtx, store, supervisor as sup, warmpool


class SteerIdleFastPathTests(unittest.TestCase):
    def setUp(self):
        self.slug = "steeridle-" + str(time.time_ns())
        org = store.create_org(self.slug)
        org.hire(ledger.USER, None, "luna", 0, "boss")
        org.hire(ledger.USER, "boss", "luna", 0, "worker")
        store.save_org(org)
        self.nid = "worker"
        self.st = sup.state(self.slug, self.nid)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(sup, "_cancel_working_cache"))
        self.stack.enter_context(patch.object(warmpool, "kill_node"))
        self.stack.enter_context(patch.object(warmpool, "poke"))
        self.stack.enter_context(patch.object(sup, "notify"))
        self.stack.enter_context(patch.object(sup, "_emit_committed_steer"))
        fd, self.tp = tempfile.mkstemp(prefix="transcript-", suffix=".jsonl", dir=_root.name)
        os.close(fd)
        self.assertEqual(Path(store.DATA_ROOT).resolve(), Path(_root.name).resolve())

    def tearDown(self):
        self.stack.close()
        store._POOL.close_all(self.slug)

    # -- helpers -----------------------------------------------------------
    def carrier(self, text="mid-task mail"):
        """Real pending mail: a mailbox row drained into a delivering batch,
        and the RAM carrier the hook offers."""
        with store.DOC_LOCK:
            org = store.load_org(self.slug)
            org.post_mail(ledger.USER, self.nid, text, "message")
            store.save_org(org)
        _, tok, _ = sup._envelope(self.slug, self.nid, "mail", base_view="")
        self.assertTrue(tok, "the envelope produced no batch token")
        self.st["steer"] = [{"text": text, "view": text, "toks": [tok]}]

    def record(self, did, tool):
        """The CLI's transcript row proving the delivery was injected."""
        row = {"attachment": {"type": "hook_additional_context", "toolUseID": tool,
                              "content": f"mail ... ORGTREE-DELIVERY:{did}"}}
        with open(self.tp, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def open_attempts(self):
        atts = (store.load_org(self.slug).d.get("steer_attempts") or {}).get(self.nid) or {}
        return [k for k, a in atts.items() if sup._attempt_open(a)]

    def prove_clear(self):
        sup.scan_steer_records(self.slug, self.nid)
        self.assertTrue(sup._steer_attempts_clear(self.st), "first scan did not prove clear")

    # -- the idle case -----------------------------------------------------
    def test_idle_fetch_opens_no_transaction(self):
        with patch.object(orgtx, "org_tx", wraps=orgtx.org_tx) as tx, \
                patch.object(store, "load_org", wraps=store.load_org) as load:
            self.assertEqual(sup.claim_steer(self.slug, self.nid, "tool-a", self.tp), (None, []))
            # CONTROL: the first fetch is unproven, so it really reads — this
            # is what shows the instruments below can count at all
            self.assertGreater(tx.call_count + load.call_count, 0)
            tx.reset_mock()
            load.reset_mock()
            for i in range(20):
                self.assertEqual(sup.claim_steer(self.slug, self.nid, f"tool-{i}", self.tp),
                                 (None, []))
                self.assertEqual(sup.scan_steer_records(self.slug, self.nid), {})
            self.assertEqual(tx.call_count, 0, "an idle fetch opened an org transaction")
            self.assertEqual(load.call_count, 0, "an idle fetch loaded the org")

    def test_pending_carrier_is_still_delivered(self):
        self.prove_clear()
        self.carrier("hello mid-task")
        did, msgs = sup.claim_steer(self.slug, self.nid, "tool-1", self.tp)
        self.assertTrue(did)
        self.assertTrue(any("hello mid-task" in m for m in msgs), msgs)

    # -- the ways the proof could go stale ---------------------------------
    def test_attempt_written_during_a_scan_is_not_skipped(self):
        """THE RACE: a scan reads the generation, loads, sees nothing open —
        and before it records "clear", a claim commits an open attempt."""
        self.prove_clear()
        self.st.pop("steer_att_clear")          # make the next scan do its read
        self.carrier("raced mail")
        real = sup._scan_steer_records_gated
        injected: list[tuple[str | None, list]] = []

        def scan_then_race(*a, **kw):
            out = real(*a, **kw)                # this load saw nothing open
            if not injected:
                injected.append(("pending", []))
                injected[0] = sup.claim_steer(self.slug, self.nid, "tool-r", self.tp)
            return out

        with patch.object(sup, "_scan_steer_records_gated", side_effect=scan_then_race):
            sup.scan_steer_records(self.slug, self.nid)
        did = injected[0][0]
        self.assertTrue(did, "the racing claim made no attempt")
        self.assertEqual(self.open_attempts(), [did])
        self.assertFalse(sup._steer_attempts_clear(self.st),
                         "a scan recorded 'clear' over an attempt committed during it")
        self.st["steer"] = []                    # only the durable attempt remains
        self.record(did, "tool-r")
        self.assertEqual(sup.scan_steer_records(self.slug, self.nid).get("recorded"), 1)
        self.assertEqual(self.open_attempts(), [])

    def test_claim_after_clear_reopens_the_scan(self):
        self.prove_clear()
        self.carrier("after-clear mail")
        did, _ = sup.claim_steer(self.slug, self.nid, "tool-c", self.tp)
        self.assertTrue(did)
        self.st["steer"] = []
        self.record(did, "tool-c")
        self.assertEqual(sup.scan_steer_records(self.slug, self.nid).get("recorded"), 1)
        # and once recorded, the seat goes idle again: the next scan proves it
        sup.scan_steer_records(self.slug, self.nid)
        self.assertTrue(sup._steer_attempts_clear(self.st))

    def test_fresh_process_scans_a_durable_attempt(self):
        self.carrier("before restart")
        did, _ = sup.claim_steer(self.slug, self.nid, "tool-p", self.tp)
        self.assertTrue(did)
        with sup._state_lock:
            sup._state.pop((self.slug, self.nid))   # the process restarted: no RAM
        self.st = sup.state(self.slug, self.nid)
        self.record(did, "tool-p")
        self.assertEqual(sup.claim_steer(self.slug, self.nid, "tool-q", self.tp), (None, []))
        self.assertEqual(self.open_attempts(), [], "the durable attempt was never scanned")


if __name__ == "__main__":
    unittest.main()
