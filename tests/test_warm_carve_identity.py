"""A parked warm process is not respawned because a SQLite sidecar came and went.

Item idle-warm-processes-respawn-every-few-seconds-wh. An agent holding a
read-only grant that CONTAINS its own scratch folder gets a carve: every file
beside the chain down to its scratch is denied by name, in the `--settings`
JSON, which is argv, which the warm identity hash covers. A SQLite `-wal` /
`-shm` next to a live database at a carve level therefore flipped the argv
component each time it appeared or went, and the keeper respawned the parked
process (reported: ~18,000 `identity-changed` argv respawns on one seat).

Reproduced here on a throwaway data root through the real `_build_cmd` and
`warmpool.identity_snapshot`: the control (an ordinary new file) still moves
the argv digest, which proves the carve is in the hashed argv at all; the
short-lived names no longer do.
"""
import os
import tempfile
import unittest

_ROOT = tempfile.TemporaryDirectory(prefix="orgtree-warm-carve-",
                                    ignore_cleanup_errors=True)
_HOME = os.path.join(_ROOT.name, "home")
os.makedirs(os.path.join(_HOME, ".claude"), exist_ok=True)
os.environ["ORGTREE_DATA"] = os.path.join(_ROOT.name, "data")
os.environ["ORGTREE_WARM"] = "0"
os.environ["USERPROFILE"] = _HOME
os.environ["HOME"] = _HOME

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, store, warmpool  # noqa: E402
from orgtree import supervisor as sup  # noqa: E402

SLUG = "warmcarve"


def setUpModule():
    global ORG
    org = store.create_org(SLUG)
    org.d["max_top_grant"] = 0
    org.hire(ledger.USER, None, "opus", 0, "reader",
             charter="Reads the data root.",
             add_dirs=[{"path": store.DATA_ROOT, "mode": "ro"}],
             tools={"bash": True, "edit": True, "web": False, "subagents": False, "mcp": []})
    store.save_org(org)
    ORG = store.load_org(SLUG)
    sup.scratch_dir(SLUG, "reader", policy_org=ORG)      # the chain must exist


class WarmCarveIdentity(unittest.TestCase):
    def argv_digest(self):
        return warmpool.ident_parts(ORG, "reader")["argv"]

    def settle(self, path):
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        with open(path, "w", encoding="utf-8") as f:
            f.write("x")

    def test_the_grant_really_carves(self):
        cmd = sup._build_cmd(ORG, "reader", write_ident=False, session_probe=False)
        settings = cmd[cmd.index("--settings") + 1]
        self.assertIn('"deny"', settings)
        scratch = sup.scratch_dir(SLUG, "reader", policy_org=ORG).replace("\\", "/")
        self.assertNotIn(f"Edit({scratch}", settings)

    def test_an_ordinary_file_at_a_carve_level_moves_the_argv_digest(self):
        """The control: the carve's listing is in the hashed argv."""
        before = self.argv_digest()
        self.settle(os.path.join(store.DATA_ROOT, "ordinary-note.txt"))
        self.assertNotEqual(self.argv_digest(), before)

    def test_sqlite_sidecars_coming_and_going_do_not(self):
        before = self.argv_digest()
        levels = [store.DATA_ROOT, store.scratch_root(SLUG)]
        for level in levels:
            for name in ("transcript-records.sqlite3-wal", "transcript-records.sqlite3-shm",
                         "orgtree.db-journal", "accounts.json.4242.tmp"):
                self.settle(os.path.join(level, name))
                self.assertEqual(self.argv_digest(), before, (level, name))
        for level in levels:
            for name in os.listdir(level):
                if name.endswith(("-wal", "-shm", "-journal", ".tmp")):
                    os.remove(os.path.join(level, name))
        self.assertEqual(self.argv_digest(), before)


if __name__ == "__main__":
    unittest.main()
