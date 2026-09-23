"""The agent CLI's foreground command ceiling (user ruling 2026-09-18).

`compare --suite python-backend` takes 675 s and the Claude Code harness caps a
foreground shell command at 600 s by default, so the one run every agent here is
told to quote before landing a change could not complete in a plain foreground
call. The ceiling is raised to 25 minutes rather than the suite being made
faster, because the suite is sequential by design and that isolation is what
makes its results worth quoting.

⚠ WHAT THIS FILE CAN AND CANNOT PROVE. It proves the variable is in the
environment orgtree spawns agents with, under the right name and the right
units. It CANNOT prove the CLI read it, honoured it, or that 1500000 means what
we think — a test asserting a key is in a dict only ever proves the dict has the
key. The end-to-end proof is a real spawned agent completing a foreground
command longer than 600 s, and it is recorded on the docket item
`the-python-backend-suite-takes-longer-than-a-for`, not here.
"""
import os
import tempfile
import unittest


import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


class AgentBashCeilingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-bashceiling-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import store, supervisor
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.supervisor = supervisor

    def test_the_ceiling_is_twenty_five_minutes_in_milliseconds(self):
        # Spelled out rather than compared to the constant, so that changing the
        # constant fails this test instead of silently agreeing with itself.
        self.assertEqual(self.supervisor.AGENT_BASH_MAX_TIMEOUT_MS, "1500000")
        self.assertEqual(int(self.supervisor.AGENT_BASH_MAX_TIMEOUT_MS) / 1000 / 60, 25)

    def test_every_spawned_agent_gets_the_raised_ceiling(self):
        env = self.supervisor.clean_env()
        self.assertEqual(env.get("BASH_MAX_TIMEOUT_MS"), "1500000")

    def test_a_lower_host_value_does_not_leak_into_the_agent(self):
        # The host's own value is not the ceiling this org's agents run under.
        # An inherited lower number would be exactly the silent-switch failure
        # the other strips in clean_env() exist to prevent — and it would look
        # like the feature simply not working.
        previous = os.environ.get("BASH_MAX_TIMEOUT_MS")
        os.environ["BASH_MAX_TIMEOUT_MS"] = "600000"
        try:
            self.assertEqual(self.supervisor.clean_env().get("BASH_MAX_TIMEOUT_MS"), "1500000")
        finally:
            if previous is None:
                os.environ.pop("BASH_MAX_TIMEOUT_MS", None)
            else:
                os.environ["BASH_MAX_TIMEOUT_MS"] = previous

    def test_the_default_timeout_is_deliberately_not_raised(self):
        # `BASH_MAX_TIMEOUT_MS` is the largest timeout an agent may ASK FOR.
        # `BASH_DEFAULT_TIMEOUT_MS` is what it gets when it asks for nothing,
        # and raising that would mean every hung command costs 25 minutes of a
        # turn rather than two. This asserts the restraint on purpose: if some
        # later change starts setting it, that is a decision someone should have
        # to make explicitly rather than inherit from this one.
        self.assertIsNone(self.supervisor.clean_env().get("BASH_DEFAULT_TIMEOUT_MS"))

    def test_a_single_node_can_still_override_it(self):
        # env_overrides is the per-node trial knob; the ceiling must not be on
        # its refused list, or trialling a different value on one agent — the
        # thing that knob exists for — would silently do nothing.
        import json
        path = os.path.join(self.root, "env-overrides.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"orgtree/somenode": {"BASH_MAX_TIMEOUT_MS": "300000"}}, f)
        try:
            # defeat the ~2 s mtime cache so the read is of what we just wrote
            self.supervisor._ENV_OVERRIDES_CACHE.update({"at": 0.0, "mtime": None, "val": {}})
            got = self.supervisor.env_overrides("orgtree", "somenode")
            self.assertEqual(got.get("BASH_MAX_TIMEOUT_MS"), "300000")
        finally:
            os.unlink(path)
            self.supervisor._ENV_OVERRIDES_CACHE.update({"at": 0.0, "mtime": None, "val": {}})


if __name__ == "__main__":
    unittest.main()
