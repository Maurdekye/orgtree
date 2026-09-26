"""The warm-pool keeper's pass got cheaper; the spawn command must not change.

Item warm-pool-keeper-pass-cache-transcript-paths-and (v3 scale gate). At
~700+ live agents a keeper pass took longer than its 20 s period
(scale-runtime, 2026-09-26): ~80% of it was `_build_cmd` -> `transcript_path`
globbing every ~/.claude/projects dir per live node, and ~/.claude.json was
re-parsed about three times per node. Three changes, each pinned here:

  §1  ~/.claude.json is parsed once per (mtime, size). The spawn argv built
      through the cache is byte-identical to the argv built with a fresh
      parse on every read (the old behaviour), for every node of a mixed
      org; an edit to the file is seen on the next read; a caller mutating
      what it got back cannot poison the cache.
  §2  the keeper hashes a `session_probe=False` argv, which skips the
      transcript lookup. The identity hash normalises the session flag's
      name away, so that hash equals the hash of the REAL spawn argv — for
      nodes with a transcript (`--resume`) and without (`--session-id`).
      The real spawn argv (default probe) is untouched: §1 compares it.
  §3  a scoped (save-poke) pass re-hashes only seats whose identity inputs
      moved: a log/mailbox write skips everyone, a charter edit re-hashes
      that seat, an ancestor's team_charter re-hashes its subtree, an
      org-level setting re-hashes everyone, and a process whose hash is not
      the one last taken is never skipped.

Base-vs-tip argv identity across the two commits at N = 100/500/1000 is in
the item's evidence (a probe dump compared node by node).
"""
import json
import os
import tempfile
import unittest
import uuid

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-keeper-cache-",
                                    ignore_cleanup_errors=True)
_HOME = os.path.join(_ROOT.name, "home")
os.makedirs(os.path.join(_HOME, ".claude"), exist_ok=True)
os.environ["ORGTREE_DATA"] = os.path.join(_ROOT.name, "data")
os.environ["ORGTREE_WARM"] = "0"
# ~/.claude.json and ~/.claude/projects come from a throwaway home
os.environ["USERPROFILE"] = _HOME
os.environ["HOME"] = _HOME

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import ledger, registry, store, warmpool  # noqa: E402
from orgtree import supervisor as sup  # noqa: E402

SLUG = "keepercache"
N = 24
CLAUDE_JSON = os.path.expanduser("~/.claude.json")
DIR_A = os.path.join(_ROOT.name, "work-a")
DIR_B = os.path.join(_ROOT.name, "work-b")
TIERS = ("opus", "sonnet", "haiku")


def _write_claude_json(servers):
    with open(CLAUDE_JSON, "w", encoding="utf-8") as f:
        json.dump({"numStartups": 3, "mcpServers": servers}, f)


def setUpModule():
    global ORG, LIVE, WITH_TX
    # the throwaway home really is the one expanduser resolves
    assert (os.path.normcase(os.path.realpath(os.path.dirname(CLAUDE_JSON)))
            == os.path.normcase(os.path.realpath(_HOME))), CLAUDE_JSON
    os.makedirs(DIR_A, exist_ok=True)
    os.makedirs(DIR_B, exist_ok=True)
    _write_claude_json({"alpha": {"command": "alpha-server", "args": ["--x"]}})
    org = store.create_org(SLUG)
    org.d["max_top_grant"] = 0
    # a mixed set: tiers, tool switches (incl. an MCP server read from
    # ~/.claude.json) and granted working folders all vary across nodes
    tool_sets = [
        {"bash": True, "edit": True, "web": True, "subagents": True,
         "mcp": ["alpha"]},
        {"bash": False, "edit": False, "web": False, "subagents": False,
         "mcp": []},
        {"bash": True, "edit": False, "web": False, "subagents": False,
         "mcp": ["alpha"]},
        {"bash": False, "edit": True, "web": True, "subagents": False,
         "mcp": []},
    ]
    dir_sets = [[{"path": DIR_A, "mode": "rw"}, {"path": DIR_B, "mode": "ro"}],
                [], [{"path": DIR_A, "mode": "rw"}],
                [{"path": DIR_B, "mode": "ro"}]]
    # a child may hold only what its parent holds, so each of the root's
    # four children takes one set and its whole subtree inherits it
    names, kind = [], []
    for i in range(N):
        parent = None if i == 0 else names[(i - 1) // 4]
        kind.append(0 if i == 0 else i % 4 if i <= 4 else kind[(i - 1) // 4])
        nm = f"k{i:02d}"
        org.hire(ledger.USER, parent, "opus" if i == 0 else TIERS[i % 3], 0,
                 nm, charter=f"Synthetic keeper-cache agent {i}.",
                 add_dirs=dir_sets[kind[i]], tools=tool_sets[kind[i]],
                 org_visibility="full" if i % 5 == 0 else "team")
        names.append(nm)
    store.save_org(org)
    prof = os.path.join(_ROOT.name, "profile")
    acct = registry.create_account("claude", "keeper-cache",
                                   {"kind": "managed", "path": prof})
    org = store.load_org(SLUG)
    WITH_TX = []
    for i, nm in enumerate(names):
        org.node(nm)["session_id"] = str(
            uuid.uuid5(uuid.NAMESPACE_URL, "keeper-cache/" + nm))
        if i % 3 == 0:
            org.node(nm)["account"] = acct["id"]
            if i % 2 == 0:
                d = os.path.join(prof, "projects", "p")
                os.makedirs(d, exist_ok=True)
                open(os.path.join(d, org.node(nm)["session_id"] + ".jsonl"),
                     "w").close()
                WITH_TX.append(nm)
    store.save_org(org)
    ORG = store.load_org(SLUG)
    LIVE = [k for k, n in ORG.nodes.items() if n.get("state") == "live"]


def tearDownModule():
    _ROOT.cleanup()


def _uncached_cmd(nid):
    """The old behaviour: every ~/.claude.json read parses the file."""
    real = sup._claude_json_doc

    def fresh():
        sup._CLAUDE_JSON.clear()
        return real()
    sup._claude_json_doc = fresh
    try:
        return sup._build_cmd(ORG, nid, write_ident=False)
    finally:
        sup._claude_json_doc = real


class ClaudeJsonCache(unittest.TestCase):
    """§1"""

    def test_spawn_argv_is_byte_identical_to_the_uncached_build(self):
        sup._CLAUDE_JSON.clear()
        resume = 0
        for nid in LIVE:
            old = _uncached_cmd(nid)
            new1 = sup._build_cmd(ORG, nid, write_ident=False)
            new2 = sup._build_cmd(ORG, nid, write_ident=False)   # cache hit
            self.assertEqual(json.dumps(old), json.dumps(new1), nid)
            self.assertEqual(json.dumps(old), json.dumps(new2), nid)
            resume += "--resume" in new1
        # the control actually covered both spawn forms, every tier, the
        # MCP server and the folder grants, and used the cache
        cmds = [json.dumps(sup._build_cmd(ORG, n, write_ident=False))
                for n in LIVE]
        self.assertEqual({ORG.node(n)["model"] for n in LIVE}, set(TIERS))
        self.assertTrue(any("alpha-server" in c for c in cmds))
        self.assertTrue(any("alpha-server" not in c for c in cmds))
        self.assertTrue(any("work-a" in c for c in cmds))
        self.assertTrue(any("work-b" in c for c in cmds))
        self.assertEqual(resume, len(WITH_TX))
        self.assertGreater(len(LIVE) - resume, 0)
        self.assertIn(CLAUDE_JSON, sup._CLAUDE_JSON)

    def test_an_edit_is_seen_on_the_next_read(self):
        sup._CLAUDE_JSON.clear()
        self.assertEqual(set(sup.registered_mcp_servers()), {"alpha"})
        try:
            _write_claude_json({"alpha": {"command": "alpha-server"},
                                "beta": {"command": "beta-server"}})
            self.assertEqual(set(sup.registered_mcp_servers()),
                             {"alpha", "beta"})
        finally:
            _write_claude_json(
                {"alpha": {"command": "alpha-server", "args": ["--x"]}})
        self.assertEqual(set(sup.registered_mcp_servers()), {"alpha"})

    def test_a_caller_cannot_poison_the_cache(self):
        sup._CLAUDE_JSON.clear()
        got = sup.registered_mcp_servers()
        got["alpha"]["args"].append("--poison")
        got["evil"] = {}
        again = sup.registered_mcp_servers()
        self.assertEqual(again, {"alpha": {"command": "alpha-server",
                                           "args": ["--x"]}})

    def test_a_missing_file_is_not_cached(self):
        sup._CLAUDE_JSON.clear()
        os.replace(CLAUDE_JSON, CLAUDE_JSON + ".away")
        try:
            self.assertEqual(sup.registered_mcp_servers(), {})
            self.assertNotIn(CLAUDE_JSON, sup._CLAUDE_JSON)
        finally:
            os.replace(CLAUDE_JSON + ".away", CLAUDE_JSON)
        self.assertEqual(set(sup.registered_mcp_servers()), {"alpha"})


class HashOnlyArgv(unittest.TestCase):
    """§2"""

    def test_hash_without_the_transcript_probe_equals_the_spawn_hash(self):
        for nid in LIVE:
            spawn = sup._build_cmd(ORG, nid, write_ident=False)
            probe_free = sup._build_cmd(ORG, nid, write_ident=False,
                                        session_probe=False)
            self.assertEqual(warmpool._argv_normalized(spawn),
                             warmpool._argv_normalized(probe_free), nid)
            h_keeper, _ = warmpool.identity_snapshot(ORG, nid)
            h_spawn, _ = warmpool.identity_snapshot(ORG, nid, cmd=spawn)
            self.assertEqual(h_keeper, h_spawn, nid)

    def test_the_probe_free_argv_really_differs_for_a_resumed_seat(self):
        # guards the test above against asserting nothing: for a seat with a
        # transcript the raw argvs DO differ (resume vs session-id) and only
        # the normalisation makes them equal
        self.assertTrue(WITH_TX)
        for nid in WITH_TX:
            spawn = sup._build_cmd(ORG, nid, write_ident=False)
            probe_free = sup._build_cmd(ORG, nid, write_ident=False,
                                        session_probe=False)
            self.assertIn("--resume", spawn)
            self.assertIn("--session-id", probe_free)
            self.assertNotEqual(spawn, probe_free)

    def test_the_keeper_hash_skips_the_transcript_lookup(self):
        calls = []
        real = sup.transcript_path

        def counting(*a, **k):
            calls.append(a)
            return real(*a, **k)
        sup.transcript_path = counting
        try:
            for nid in LIVE:
                warmpool.identity_snapshot(ORG, nid)
            self.assertEqual(calls, [])
            sup._build_cmd(ORG, LIVE[0], write_ident=False)
            self.assertEqual(len(calls), 1)      # a spawn still looks
        finally:
            sup.transcript_path = real


class ScopedSkip(unittest.TestCase):
    """§3"""

    def setUp(self):
        self.org = store.load_org(SLUG)
        warmpool._seen.clear()
        fp = warmpool._org_fingerprint(self.org)
        self.hashes = {nid: warmpool._snapshot_seen(self.org, SLUG, nid, fp)[0]
                       for nid in LIVE}

    def tearDown(self):
        warmpool._seen.clear()

    def changed(self):
        fp = warmpool._org_fingerprint(self.org)
        return {nid for nid in LIVE
                if not warmpool._unchanged(self.org, SLUG, nid, fp,
                                           self.hashes[nid])}

    def test_nothing_moved_skips_every_seat(self):
        self.assertEqual(self.changed(), set())

    def test_log_and_mailbox_writes_skip_every_seat(self):
        self.org.d.setdefault("events", []).append({"t": 1, "kind": "x"})
        self.org.d.setdefault("mail_log", {}).setdefault("k01", []).append(
            {"from": "k00", "body": "hi"})
        self.org.d.setdefault("work_items", {})
        self.assertEqual(self.changed(), set())

    def test_a_charter_edit_rehashes_that_seat_only(self):
        self.org.node("k07")["charter"] = "A different charter."
        self.assertEqual(self.changed(), {"k07"})

    def test_an_ancestor_team_charter_rehashes_its_subtree(self):
        self.org.node("k01")["team_charter"] = "Team rule."
        sub = {nid for nid in LIVE if "k01" in self.org.ancestors(nid)}
        self.assertTrue(sub)
        # k01 itself too: its own node row moved (conservative, never wrong)
        self.assertEqual(self.changed(), sub | {"k01"})
        # and those seats' real hashes did move: the skip was not hiding one
        for nid in sub:
            self.assertNotEqual(
                warmpool.identity_snapshot(self.org, nid)[0], self.hashes[nid])

    def test_an_org_level_setting_rehashes_every_seat(self):
        self.org.d["workspace"] = os.path.join(_ROOT.name, "ws")
        self.assertEqual(self.changed(), set(LIVE))

    def test_a_process_with_another_hash_is_never_skipped(self):
        fp = warmpool._org_fingerprint(self.org)
        self.assertFalse(warmpool._unchanged(self.org, SLUG, "k03", fp,
                                             "not-the-hash"))
        self.assertFalse(warmpool._unchanged(self.org, SLUG, "k03", "",
                                             self.hashes["k03"]))
        self.assertFalse(warmpool._unchanged(self.org, SLUG, "k03", fp, None))

    def test_every_skipped_seat_really_hashes_the_same(self):
        # the skip is sound on a mixed edit: everything reported unchanged
        # re-hashes to the value the keeper remembered
        self.org.node("k05")["charter"] = "Edited."
        self.org.d.setdefault("events", []).append({"t": 2})
        moved = self.changed()
        self.assertEqual(moved, {"k05"})
        for nid in set(LIVE) - moved:
            self.assertEqual(warmpool.identity_snapshot(self.org, nid)[0],
                             self.hashes[nid], nid)


if __name__ == "__main__":
    unittest.main()
