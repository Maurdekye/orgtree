"""The sensitive-path gate: ONE CLI gate covering NINE directories.

TICKET `a-third-git-gate-blocks-claude-lane-tools-above`. `worktree-perms` was
refused on a plain `rm -f <repo>/.git/index.lock` with one bare sentence —
"… which is a sensitive file" — while cleaning up after a crash, and got no
explanation at all.

WHAT THE CAUSE ACTUALLY IS, because it decides what these tests may assert.
Read out of the shipped `claude.exe` on 2026-09-17, from BOTH the npm global
2.1.241 (the build that seat was running) and the private pin 2.1.258 that
`supervisor.CLAUDE` resolves to — identical in each:

  · The emitter is the CLI's own `checkPathSafetyForAutoEdit`. It returns
    `{safe:false, message:"… which is a sensitive file.",
      classifierApprovable:true}` — a permission REQUEST, which is why the
    harness records `toolDenialKind:"user-rejected"`. A headless turn has
    nobody to answer it, so it surfaces as a refusal.
  · It matches path SEGMENTS against ONE hardcoded array:
    `[".git",".vscode",".idea",".claude",".husky",".cargo",".devcontainer",
      ".yarn",".mvn"]`.

⚠ THE TICKET CALLED THIS A "THIRD MECHANISM". IT IS NOT, AND THESE TESTS PIN
THE CORRECTION. It is the SAME gate, function and array as the `.claude` case
we had already documented. `.claude` is merely the only entry carrying
carve-outs. The real defect was that we documented ONE of NINE — so §1 pins
the whole list, and naming only `.git` would repeat the mistake one entry on.

⚠ WHAT THESE TESTS MAY NOT ASSERT. Orgtree CANNOT change the refusal string:
it lives in a compiled vendor binary, our steering hook is registered on
`PostToolUse` (which never fires when a tool was denied and never ran), and
the CLI's `PermissionDenied` hook may return only `retry` — a boolean, with
nowhere to put a sentence. So nothing here asserts that the refusal text
changed. §3 pins the documentation instead, which is the channel that does
reach the agent, per `8e81614`: an agent must be TOLD about a wall, not left
to find it by hitting it.

⚠ AND NOTHING HERE MAY READ AS A BYPASS (`d707da7`). Hooking
`PermissionRequest` with `decision:"allow"` WOULD make these writes succeed
and was rejected on purpose. §4 pins that the text keeps pointing at the
permitted routes — git itself, and asking for the mode — and never offers a
quiet way around.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="git-gate-tests-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
from orgtree import ledger, steer, store, supervisor as sup  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ["ORGTREE_DATA"]).resolve(), \
    "this process would have written to the live root"

slugs: list[str] = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


def flat(text: object) -> str:
    """Compare on words, not line breaks — re-flowing prose must not go red,
    but DELETING the rule must."""
    return re.sub(r"\s+", " ", str(text or "")).lower()


# the CLI's real wording, quoted from the binary and from the raw transcript
# record `worktree-perms` supplied. Tests use this rather than a paraphrase,
# because the matching is substring matching against exactly this string.
CLI_REFUSAL = ("Claude requested permissions to edit "
               "{path} which is a sensitive file.")


def payload(tool: str = "Write", path: str = "",
            response: object = None, tool_input: dict | None = None) -> str:
    ti = tool_input if tool_input is not None else {"file_path": path}
    if response is None:
        response = CLI_REFUSAL.format(path=path)
    return json.dumps({"session_id": "s", "tool_name": tool,
                       "tool_input": ti, "tool_response": response})


# ══ §1 the list itself ═══════════════════════════════════════════════════
class TheGatedList(unittest.TestCase):
    def test_s1_1_all_nine_directories_are_carried(self):
        # measured from both binaries; if the CLI ever changes this array the
        # prompt silently starts lying, so the whole set is pinned here
        self.assertEqual(
            set(steer.GATED_DIRS),
            {".git", ".vscode", ".idea", ".claude", ".husky", ".cargo",
             ".devcontainer", ".yarn", ".mvn"})

    def test_s1_2_git_and_claude_are_the_SAME_list(self):
        # the correction this ticket exists to record: not a third mechanism
        self.assertIn(".git", steer.GATED_DIRS)
        self.assertIn(".claude", steer.GATED_DIRS)

    def test_s1_3_the_order_is_stable_and_sorted(self):
        # ⚠ CACHE STABILITY, NOT TIDINESS (D-181). This renders into the
        # cached prompt prefix; an unstable order re-prefixes every turn.
        self.assertEqual(list(steer.GATED_DIRS), sorted(steer.GATED_DIRS))

    def test_s1_4_the_multi_segment_path_entry_is_carried(self):
        self.assertIn(".config/git", steer.GATED_DIR_PATHS)


# ══ §2 naming the component that ACTUALLY matched ════════════════════════
class NamesTheRealSegment(unittest.TestCase):
    def test_s2_1_THE_REGRESSION_a_git_path_is_not_called_claude(self):
        # THE BUG. The hook asserted "that path contains a `.claude` segment"
        # for EVERY sensitive refusal, sending an agent holding a `.git`
        # refusal to hunt for a component that was never in its path.
        out = steer.refusal_advice(
            payload(path="E:/Libraries/Desktop/orgtree/.git/index.lock"))
        self.assertIn("`.git`", out)
        self.assertNotIn("contains a `.claude`", out)

    def test_s2_2_each_gated_directory_is_named_as_itself(self):
        for d in steer.GATED_DIRS:
            out = steer.refusal_advice(payload(path=f"C:/proj/{d}/thing.txt"))
            self.assertIn(f"`{d}`", out, d)

    def test_s2_3_claude_is_still_named_for_a_claude_path(self):
        # the previous ticket's case must not regress while fixing the others
        out = steer.refusal_advice(payload(path="C:/Users/x/.claude/settings.json"))
        self.assertIn("`.claude`", out)

    def test_s2_4_a_claude_skills_path_still_names_claude(self):
        # ⚠ we do NOT model the CLI's carve-outs. This runs only on a refusal
        # that ALREADY happened, so a gated component in the path IS the
        # reason — modelling the carve-out only made this case vaguer.
        out = steer.refusal_advice(payload(path="C:/Users/x/.claude/skills/a.md"))
        self.assertIn("`.claude`", out)

    def test_s2_5_an_unrecognised_sensitive_path_does_not_invent_one(self):
        out = steer.refusal_advice(payload(path="C:/proj/.gitconfig"))
        self.assertIn("[ORGTREE", out)
        for d in steer.GATED_DIRS:
            self.assertNotIn(f"contains a `{d}` component", out)

    def test_s2_6_segment_matching_is_per_component_not_substring(self):
        # `.gitignore` is not `.git`; a substring match would name it
        self.assertEqual(steer.gated_segment("C:/proj/.gitignore"), "")
        self.assertEqual(steer.gated_segment("C:/proj/.git/index.lock"), ".git")

    def test_s2_7_windows_backslashes_are_understood(self):
        # the gate reports the path it RESOLVED — an agent that typed forward
        # slashes is refused with backslashes (measured)
        self.assertEqual(
            steer.gated_segment(r"E:\Libraries\orgtree\.git\index.lock"), ".git")


# ══ §3 the SHELL route, which had no explanation at all ══════════════════
class CoversTheShell(unittest.TestCase):
    CMD = 'rm -f "E:/Libraries/Desktop/orgtree/.git/index.lock"'
    WINPATH = r"E:\Libraries\Desktop\orgtree\.git\index.lock"

    def shell(self, tool="Bash"):
        return steer.refusal_advice(payload(
            tool=tool, tool_input={"command": self.CMD},
            response="Error: " + CLI_REFUSAL.format(path=self.WINPATH)))

    def test_s3_1_THE_REGRESSION_a_bash_refusal_is_explained(self):
        # `worktree-perms` got NOTHING: 0 occurrences of the explainer in a
        # 1.7 MB transcript, because the hook only ever looked at file tools.
        out = self.shell()
        self.assertIn("[ORGTREE — that refusal explained]", out)
        self.assertIn("`.git`", out)

    def test_s3_2_powershell_too(self):
        self.assertIn("`.git`", self.shell("PowerShell"))

    def test_s3_3_the_path_comes_out_of_the_refusal_not_the_command(self):
        # on the shell route tool_input is a whole command line; the only
        # usable path is the one the CLI resolved into its own sentence
        self.assertEqual(steer.sensitive_path_from(
            CLI_REFUSAL.format(path=self.WINPATH)), self.WINPATH)
        self.assertIn(self.WINPATH, self.shell())

    def test_s3_4_a_shell_tool_does_NOT_get_the_deny_rule_advice(self):
        # that branch talks about grants and working folders and would be
        # wrong here; only the sensitive branch reaches the shell
        out = steer.refusal_advice(payload(
            tool="Bash", tool_input={"command": "touch /x"},
            response="Error: File is in a directory that is denied by your "
                     "permission settings."))
        self.assertEqual(out, "")

    def test_s3_5_an_unrelated_tool_still_says_nothing(self):
        self.assertEqual(steer.refusal_advice(payload(tool="Read", path="/x")), "")


# ══ §4 never explain a SUCCESS ═══════════════════════════════════════════
class NeverExplainsASuccess(unittest.TestCase):
    """REPRODUCED LIVE against the agent writing this commit.

    An `Edit` that SUCCEEDED came back through the hook and was announced as a
    refusal naming a `.claude` segment the path did not contain — because the
    FILE BEING WRITTEN contained the phrase "which is a sensitive file" and the
    old `_response_text` flattened every value of the response dict. Three
    false statements out of one good call, and the trap fires for anyone
    editing a file that merely discusses this gate — including this one.
    """

    def test_s4_1_THE_REGRESSION_echoed_content_is_not_a_refusal(self):
        out = steer.refusal_advice(json.dumps({
            "tool_name": "Edit", "tool_input": {"file_path": "C:/proj/steer.py"},
            "tool_response": {
                "filePath": "C:/proj/steer.py",
                "content": "the CLI says '… which is a sensitive file' here",
                "structuredPatch": [{"lines": ["+ sensitive file"]}]}}))
        self.assertEqual(out, "")

    def test_s4_2_an_explicit_success_flag_ends_it(self):
        out = steer.refusal_advice(json.dumps({
            "tool_name": "Write", "tool_input": {"file_path": "C:/proj/a.md"},
            "tool_response": {"is_error": False,
                              "result": "which is a sensitive file"}}))
        self.assertEqual(out, "")

    def test_s4_3_a_REAL_refusal_still_explains(self):
        # the guard must not silence the thing it guards
        out = steer.refusal_advice(json.dumps({
            "tool_name": "Write", "tool_input": {"file_path": "C:/p/.git/x"},
            "tool_response": {"is_error": True,
                              "result": CLI_REFUSAL.format(path="C:/p/.git/x")}}))
        self.assertIn("`.git`", out)

    def test_s4_4_a_bare_string_refusal_still_explains(self):
        # a plain string response IS the whole result, so a marker in it is
        # the result — this is the shape the CLI actually sent worktree-perms
        self.assertIn("`.git`", steer.refusal_advice(
            payload(path="C:/p/.git/index.lock")))


# ══ §5 what the agent is TOLD, before it hits the wall ═══════════════════
class ThePromptNamesTheGate(unittest.TestCase):
    """Acceptance condition 3 is met HERE, not in the refusal text.

    Orgtree cannot add a word to the CLI's sentence (see the module docstring),
    so the only channel that reaches the agent is the identity prompt — which
    is exactly the principle `8e81614` established.
    """

    def setUp(self):
        slug = "gitgate-" + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.addCleanup(self.folder.cleanup)

    def agent(self, tier="opus", *, permission_mode=None, **kw):
        name = "a" + uuid.uuid4().hex[:6]
        kw.setdefault("add_dirs", [{"path": self.folder.name, "mode": "rw"}])
        kw.setdefault("tools", {"bash": True, "web": False, "edit": True,
                                "subagents": False, "mcp": []})
        kw.setdefault("charter", "fixture agent")
        self.org.hire(ledger.USER, None, tier, 0, name, **kw)
        if permission_mode:
            # `hire` takes no such kwarg — the mode lives on the node's scope
            self.org.d["nodes"][name]["scope"]["permission_mode"] = permission_mode
        store.save_org(self.org)
        return name

    def prompt(self, **kw):
        return flat(sup.identity_prompt(self.org, self.agent(**kw)))

    def test_s5_1_THE_TICKET_the_gate_is_documented_at_all(self):
        # it was documented NOWHERE; agents met it by hitting it
        self.assertIn("sensitive-path gate", self.prompt())

    def test_s5_2_ALL_NINE_directories_are_named_not_just_git(self):
        # documenting only `.git` would repeat the original mistake one entry
        # later — the other eight bite exactly the same way
        text = self.prompt()
        for d in steer.GATED_DIRS:
            self.assertIn(d, text, d)

    def test_s5_3_it_says_the_request_cannot_be_answered_headless(self):
        text = self.prompt()
        self.assertIn("headless", text)
        self.assertIn("nobody to answer", text)

    def test_s5_4_it_says_there_is_nothing_to_retry_into(self):
        # the single most expensive thing an agent can do here is keep trying
        self.assertIn("nothing retries into success", self.prompt())

    def test_s5_5_it_says_the_grant_is_not_at_fault(self):
        # worktree-perms was inside its own granted rw folder and still refused
        self.assertIn("not a deny rule", self.prompt())

    def test_s5_6_it_names_the_route_that_WORKS(self):
        # the gate matches the path you TYPE, so git itself is untouched —
        # this is the intended route, and it is why `git worktree add` always
        # worked while `rm .git/index.lock` did not
        text = self.prompt()
        self.assertIn("git -c <root> worktree add|remove", text)

    def test_s5_7_it_names_the_shared_lock_escape(self):
        # the exact situation that produced this ticket
        self.assertIn("own worktree has its own index", self.prompt())

    def test_s5_8_it_says_mutating_shell_commands_are_caught_too(self):
        # wider reach than Write/Edit — and reads are NOT caught, which the
        # text must not overstate (worktree-perms measured `ls` passing)
        text = self.prompt()
        self.assertIn("mutating shell commands", text)
        self.assertIn("reads like `ls` are not", text)

    def test_s5_9_a_bypass_seat_is_told_its_mode_clears_it(self):
        text = self.prompt(permission_mode="bypassPermissions")
        self.assertIn("your permission mode clears it", text)
        self.assertNotIn("nothing retries into success", text)

    def test_s5_10_it_is_stable_across_two_renders(self):
        # ⚠ D-181: this is cached prefix. Live values here cost this machine
        # ~197M redundant cache-write tokens once already.
        name = self.agent()
        self.assertEqual(sup.identity_prompt(self.org, name),
                         sup.identity_prompt(self.org, name))


# ══ §6 it must not read as a bypass (`d707da7`) ══════════════════════════
class NeverReadsAsABypass(unittest.TestCase):
    """`d707da7`: a helper that performs a privileged step must not read as a
    way around a deliberate denial. `PermissionRequest` hooks accept
    `decision:"allow"` and hooking one WOULD make these writes succeed; it was
    found, evaluated and rejected. Nothing here may drift toward offering it.
    """

    def setUp(self):
        slug = "gitgate-nb-" + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.addCleanup(self.folder.cleanup)
        name = "a" + uuid.uuid4().hex[:6]
        self.org.hire(ledger.USER, None, "opus", 0, name,
                      add_dirs=[{"path": self.folder.name, "mode": "rw"}],
                      tools={"bash": True, "web": False, "edit": True,
                             "subagents": False, "mcp": []},
                      charter="fixture agent")
        store.save_org(self.org)
        self.text = flat(sup.identity_prompt(self.org, name))

    def test_s6_1_the_prompt_tells_the_agent_not_to_work_around_it(self):
        self.assertIn("do not work around it", self.text)

    def test_s6_2_the_permitted_escalation_is_ASKING_not_taking(self):
        self.assertIn("orgtree_request_scope", self.text)

    def test_s6_3_the_git_route_is_named_as_intended_not_as_a_loophole(self):
        # naming git without this qualifier is exactly how `d707da7` says the
        # worktree helper came to read as the quiet route
        self.assertIn("that is the intended route, not a loophole", self.text)

    def test_s6_4_the_gate_is_NOT_described_as_a_security_boundary(self):
        # it matches the path a call NAMES and is blind to what a subprocess
        # reaches, so calling it protection would be false AND would stop
        # agents using the route that legitimately works
        for w in ("protects", "security boundary", "for your safety"):
            self.assertNotIn(w, self.text)

    def test_s6_5_the_advice_text_also_refuses_to_offer_a_workaround(self):
        out = steer.refusal_advice(payload(path="C:/p/.git/index.lock"))
        self.assertIn("do not work around it", out.lower())


if __name__ == "__main__":
    unittest.main()
