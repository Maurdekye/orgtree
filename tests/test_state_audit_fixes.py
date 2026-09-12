"""state-audit hardening (user-authorized 2026-09-12): the transitions the
audit found could strand an agent, and the self-healing added for them.

Covers, at the ledger + supervisor level (no real CLI spawn):
  · F1/SH-1 — a queued cross-provider switch hands the unfreeze-wake to the
    caller (`_apply_pending_switch_locked`'s `wake` out-param) instead of
    dropping it, so the boundary/reconcile paths can drive the node.
  · SH-2   — a `missing:` binding parks with `cause="account"`; the timer
    (`auto_resume_ready`) never wakes such a park; `announce_missing_rebind_
    candidates` finds the parked nodes.
  · SH-6   — `_invariant_sweep_org` quarantines an unknown True freeze flag
    (the pre-№41 permanent-skip trap) and tells someone.
  · F4     — a stranding caused by another actor notifies the stranded node.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

# the backend's [orgtree] diagnostics use unicode (→, ⚠, №); a bare Windows
# console is cp1252 and would crash the print, not the code under test. The
# packaged backend runs UTF-8; match that here so the harness is faithful.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")                # type: ignore[union-attr]
    except Exception:                                    # noqa: BLE001
        pass

_root = tempfile.mkdtemp(prefix="state-audit-fixes-")
# the packaged backend's default store; a fresh root needs no migration, and
# the cross-provider transcript-export path reaches a native-import helper
# that is sqlite-only, so this matches production rather than forcing json.
os.environ.update(ORGTREE_DATA=str(Path(_root) / "data"),
                  HOME=str(Path(_root) / "home"),
                  USERPROFILE=str(Path(_root) / "home"),
                  ORGTREE_STORE="sqlite", ORGTREE_V2_TOKEN="op")
Path(os.environ["ORGTREE_DATA"]).mkdir(parents=True)
Path(os.environ["HOME"]).mkdir(parents=True)

from engine.backend.orgtree import ledger, store, supervisor  # noqa: E402

NOW = time.time()


def _fresh(slug, model="opus"):
    """A one-node live org saved to the store, ready for supervisor calls."""
    org = ledger.Org.create(slug)
    nid = org._new_node(model, None, 0, "root", [],
                        {"bash": True, "web": True, "edit": True,
                         "subagents": True, "mcp": []}, "full", "c")
    store.save_org(org)
    return slug, nid


class SwitchBoundaryWakeTests(unittest.TestCase):
    """F1/SH-1: the queued-switch applier surfaces resume_stale_freeze."""

    def test_boundary_apply_reports_the_unfrozen_node(self):
        slug, nid = _fresh("f1-wake", model="opus")
        with store.DOC_LOCK:
            org = store.load_org(slug)
            n = org.node(nid)
            # frozen for a usage limit on the CURRENT provider (claude)…
            n["frozen"] = {"limit": True, "provider": "claude",
                           "until_ts": NOW + 3600, "until": "later",
                           "resume_texts": ["the interrupted prompt"],
                           "at": "2026-09-12T00:00:00Z"}
            # …with a switch to a DIFFERENT provider (openai) queued behind it
            n["pending_switch"] = {"tier": "luna", "from": "opus",
                                   "by": "USER", "at": "2026-09-12T00:00:00Z",
                                   "crossing": True, "account": None}
            store.save_org(org)

        wake = []
        with store.DOC_LOCK:
            o2 = store.load_org(slug)
            changed = supervisor._apply_pending_switch_locked(
                o2, slug, nid, wake=wake)
            store.save_org(o2)

        self.assertTrue(changed)
        # the crossing cleared the stale freeze AND reported the node to wake
        self.assertIn(nid, wake)
        after = store.load_org(slug).node(nid)
        self.assertEqual(after["model"], "luna")
        self.assertIsNone(after.get("frozen"))
        self.assertNotIn("pending_switch", after)

    def test_same_provider_switch_reports_no_wake(self):
        slug, nid = _fresh("f1-same", model="opus")
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["pending_switch"] = {
                "tier": "sonnet", "from": "opus", "by": "USER",
                "at": "2026-09-12T00:00:00Z", "crossing": False,
                "account": None}
            store.save_org(org)
        wake = []
        with store.DOC_LOCK:
            o2 = store.load_org(slug)
            supervisor._apply_pending_switch_locked(o2, slug, nid, wake=wake)
            store.save_org(o2)
        self.assertEqual(wake, [])                       # nothing was frozen
        self.assertEqual(store.load_org(slug).node(nid)["model"], "sonnet")


class MissingAccountParkTests(unittest.TestCase):
    """SH-2: the missing-binding park never auto-wakes and is discoverable."""

    def test_auto_resume_skips_an_account_park(self):
        org = ledger.Org.create("sh2-timer")
        nid = org._new_node("opus", None, 0, "root", [],
                            {"bash": False, "web": False, "edit": False,
                             "subagents": False, "mcp": []}, "full", "c")
        org.node(nid)["frozen"] = {"limit": True, "cause": "account",
                                   "provider": "claude", "until_ts": None,
                                   "until": "no account", "at": "x"}
        # a control node with an ELAPSED ordinary limit IS ready
        ctl = org._new_node("opus", None, 0, "ctl", [],
                            {"bash": False, "web": False, "edit": False,
                             "subagents": False, "mcp": []}, "full", "c")
        org.node(ctl)["frozen"] = {"limit": True, "provider": "claude",
                                   "until_ts": NOW - 3600, "until": "past",
                                   "at": "x"}   # past the limit-kind +60s grace
        ready = supervisor.auto_resume_ready(org, now=NOW)
        self.assertNotIn(nid, ready)                     # the account park
        self.assertIn(ctl, ready)                        # the ordinary limit

    def test_announce_finds_parked_nodes(self):
        slug, nid = _fresh("sh2-find", model="opus")
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["account"] = "missing:claude"
            store.save_org(org)
        n = supervisor.announce_missing_rebind_candidates("claude", "acct-1")
        self.assertGreaterEqual(n, 1)


class FreezeQuarantineTests(unittest.TestCase):
    """SH-6: an unknown True freeze flag is quarantined, not skipped forever."""

    def test_unknown_flag_is_quarantined_and_announced(self):
        slug, nid = _fresh("sh6", model="opus")
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["frozen"] = {"error": "x", "bogus_kind": True,
                                       "at": "2026-09-12T00:00:00Z"}
            store.save_org(org)

        supervisor._invariant_sweep_org(slug)

        fz = store.load_org(slug).node(nid)["frozen"]
        self.assertIsNotNone(fz)
        self.assertNotEqual(fz.get("bogus_kind"), True)   # no longer active
        self.assertEqual(fz.get("_quarantined", {}).get("bogus_kind"), True)
        # a top-level node's finding reaches the user (a notice arrives
        # already-read, so it lands in the read archive by construction)
        d = store.load_org(slug).d
        seen = (d.get("user_inbox") or []) + (d.get("user_mail_log") or [])
        self.assertTrue(any("bogus_kind" in str(m.get("body", ""))
                            for m in seen))

    def test_known_flags_are_left_alone(self):
        slug, nid = _fresh("sh6-known", model="opus")
        with store.DOC_LOCK:
            org = store.load_org(slug)
            org.node(nid)["frozen"] = {"limit": True, "provider": "claude",
                                       "until_ts": NOW + 60, "at": "x"}
            store.save_org(org)
        supervisor._invariant_sweep_org(slug)
        fz = store.load_org(slug).node(nid)["frozen"]
        self.assertEqual(fz.get("limit"), True)           # untouched
        self.assertNotIn("_quarantined", fz)


class StrandingNoticeTests(unittest.TestCase):
    """F4: a stranding caused by another actor notifies the stranded node."""

    def test_payer_is_notified_when_another_actor_strands_it(self):
        org = ledger.Org.create("f4")
        payer = org._new_node("opus", None, 0, "boss", [],
                              {"bash": False, "web": False, "edit": False,
                               "subagents": False, "mcp": []}, "full", "c")
        child = org._new_node("haiku", payer, 0, "kid", [],
                              {"bash": False, "web": False, "edit": False,
                               "subagents": False, "mcp": []}, "full", "c")
        org.node(child)["state"] = "archived"             # rehireable dependent

        cost = org.seat_cost(child) + org.node(child)["grant"]
        warns = org._stranding_warnings(payer, cost + 1, cost - 1,
                                        actor="someone-else")
        self.assertTrue(warns)                            # it WAS stranded
        notices = org.d.get("notices", {}).get(payer) or []
        self.assertTrue(any(child in str(x.get("text", "")) for x in notices))

    def test_no_notice_when_the_payer_is_the_actor(self):
        org = ledger.Org.create("f4-self")
        payer = org._new_node("opus", None, 0, "boss", [],
                              {"bash": False, "web": False, "edit": False,
                               "subagents": False, "mcp": []}, "full", "c")
        child = org._new_node("haiku", payer, 0, "kid", [],
                              {"bash": False, "web": False, "edit": False,
                               "subagents": False, "mcp": []}, "full", "c")
        org.node(child)["state"] = "archived"
        cost = org.seat_cost(child) + org.node(child)["grant"]
        org._stranding_warnings(payer, cost + 1, cost - 1, actor=payer)
        self.assertFalse(org.d.get("notices", {}).get(payer))


if __name__ == "__main__":
    unittest.main()
