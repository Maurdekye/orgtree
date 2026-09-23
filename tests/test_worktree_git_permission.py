"""The `.git` denial that made every agent's FIRST mandated step fail.

TICKET `creating-a-git-worktree-needs-a-separate-elevate`. Twenty agents
followed the standing charter, ran `git worktree add`, and were stopped by a
'Permission denied' on a path inside a repository they held READ-WRITE. One
raised it on three separate tickets.

WHAT THE CAUSE ACTUALLY IS, because it decides what these tests may assert.
The denial is **not** an orgtree rule and orgtree cannot remove it:

  · It is Codex-lane only. A Claude seat with the same grant creates and
    removes a worktree under the repo root with no prompt at all, in either
    shell. Measured on this machine, 2026-09-16.
  · codex-cli writes an explicit DENY on every `.git` that ALREADY EXISTS
    under a writable root, at turn setup (`supervisor.identity_prompt`, the
    2026-09-04 block). A repo created mid-turn escapes it, so it is a sweep of
    existing repos, not a rule about the name `.git`.
  · The literal `/.git` is hardcoded in the codex binary beside its own
    `read`/`write`/`deny` access values. The only `[sandbox_workspace_write]`
    keys that binary carries are `writable_roots`, `network_access`,
    `exclude_slash_tmp`, `exclude_tmpdir_env_var` — there is NO git knob, and
    the sandbox field on the wire is a bare three-value enum.

SO THE DELIVERABLE IS THE SECOND OF THE TICKET'S TWO PERMITTED OUTCOMES: the
gate stays, and the refusal names the exact permission and the exact path.
The first outcome would require `danger-full-access`, which turns the OS
sandbox off entirely and is NOT limited to granted dirs — the ticket forbids
it. §4 pins that nothing here widens a grant.

⚠ WHAT MUST NOT BE "SIMPLIFIED" HERE. §3 asserts the diagnostic keeps saying
`allowed: true` for this write. That looks wrong and is not: the write IS
within scope and `_approve` auto-accepts the elevated retry, so reporting it
as refused would tell an entitled agent it has no right to a write it has —
and an agent that believes a wall is real stops one retry short of done,
which is the exact failure this ticket exists to end.
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix="worktree-perms-tests-")
os.environ["ORGTREE_DATA"] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger, scope_diagnostics as sd, store, supervisor as sup  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ["ORGTREE_DATA"]).resolve(), \
    "this process would have written to the live root"

slugs: list[str] = []


def tearDownModule():
    # the org store holds a sqlite handle per slug; on Windows the temp-dir
    # cleanup cannot unlink an open .db and the failure surfaces as noise at
    # interpreter exit rather than as a test result
    for s in slugs:
        store._POOL.close_all(s)


def flat(text: object) -> str:
    """Compare on words, not on line breaks.

    The prompt is wrapped prose; re-flowing a paragraph must not turn this
    suite red, while DELETING the rule must.
    """
    return re.sub(r"\s+", " ", str(text or "")).lower()


def make_repo(root: Path, *, worktree_style: bool = False) -> Path:
    """A directory carrying a `.git` marker, without running Git.

    ``worktree_style`` writes `.git` as a FILE, which is what a linked
    worktree actually has — the sandbox sweep sees both kinds, so the helper
    that names repositories must too (§1.6).
    """
    root.mkdir(parents=True, exist_ok=True)
    if worktree_style:
        (root / ".git").write_text("gitdir: /elsewhere/.git/worktrees/x\n")
    else:
        (root / ".git").mkdir()
    return root


# ══ §1 the helper that names the repositories ════════════════════════════
class DeniedGitRoots(unittest.TestCase):
    def test_s1_1_a_granted_repo_root_is_named(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = make_repo(Path(folder) / "repo")
            got = sup.codex_denied_git_roots([{"path": str(repo), "mode": "rw"}])
            self.assertEqual(got, [os.path.normpath(str(repo))])

    def test_s1_2_a_grant_nested_in_a_repo_names_the_ROOT(self):
        # the agent passes this to `git -C`, so the useful answer is the repo
        # root, never the granted subdirectory that happens to sit inside it
        with tempfile.TemporaryDirectory() as folder:
            repo = make_repo(Path(folder) / "repo")
            deep = repo / "engine" / "backend"
            deep.mkdir(parents=True)
            got = sup.codex_denied_git_roots([{"path": str(deep), "mode": "rw"}])
            self.assertEqual(got, [os.path.normpath(str(repo))])

    def test_s1_3_a_read_only_grant_is_NOT_named(self):
        # a read-only seat is told a stricter and DIFFERENT thing — that its
        # escalation will be refused. Naming a path there would invite exactly
        # the retry that branch exists to prevent (supervisor, 2026-09-05).
        with tempfile.TemporaryDirectory() as folder:
            repo = make_repo(Path(folder) / "repo")
            self.assertEqual(
                sup.codex_denied_git_roots([{"path": str(repo), "mode": "ro"}]), [])

    def test_s1_4_a_granted_folder_that_is_not_a_repo_is_not_named(self):
        with tempfile.TemporaryDirectory() as folder:
            plain = Path(folder) / "plain"
            plain.mkdir()
            self.assertEqual(
                sup.codex_denied_git_roots([{"path": str(plain), "mode": "rw"}]), [])

    def test_s1_5_output_is_sorted_and_deduplicated(self):
        # ⚠ CACHE STABILITY, NOT TIDINESS (D-181). This string lands in the
        # cached prompt prefix; an unstable order would re-prefix the system
        # prompt every turn. D-181 exists because live values in this prompt
        # cost this machine ~197M redundant cache-write tokens.
        with tempfile.TemporaryDirectory() as folder:
            a = make_repo(Path(folder) / "aaa")
            b = make_repo(Path(folder) / "bbb")
            sub = a / "nested"
            sub.mkdir()
            grants = [{"path": str(b), "mode": "rw"},
                      {"path": str(a), "mode": "rw"},
                      {"path": str(sub), "mode": "rw"}]   # resolves to `a`
            got = sup.codex_denied_git_roots(grants)
            self.assertEqual(got, sorted(got), "order is not deterministic")
            self.assertEqual(len(got), 2, "the nested grant was not deduplicated")
            self.assertEqual(got, sup.codex_denied_git_roots(list(reversed(grants))),
                             "answer depends on the order the grants arrive in")

    def test_s1_6_a_worktree_dot_git_FILE_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            wt = make_repo(Path(folder) / "wt", worktree_style=True)
            self.assertEqual(sup.codex_denied_git_roots([{"path": str(wt), "mode": "rw"}]),
                             [os.path.normpath(str(wt))])

    def test_s1_7_empty_and_malformed_grants_do_not_raise(self):
        self.assertEqual(sup.codex_denied_git_roots([]), [])
        self.assertEqual(sup.codex_denied_git_roots(None), [])
        self.assertEqual(sup.codex_denied_git_roots([{"path": "", "mode": "rw"},
                                                     {"mode": "rw"}]), [])


# ══ §2 what the Codex seat is actually told ══════════════════════════════
class CodexPromptNamesTheWall(unittest.TestCase):
    def setUp(self):
        slug = "wtperms-" + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.addCleanup(self.folder.cleanup)
        self.repo = make_repo(Path(self.folder.name) / "orgtree")

    def agent(self, tier="luna", *, mode="rw", dirs=None, **kw):
        name = "a" + uuid.uuid4().hex[:6]
        kw.setdefault("add_dirs",
                      dirs if dirs is not None
                      else [{"path": str(self.repo), "mode": mode}])
        kw.setdefault("tools", {"bash": True, "web": False, "edit": True,
                                "subagents": False, "mcp": []})
        kw.setdefault("charter", "fixture agent")
        self.org.hire(ledger.USER, None, tier, 0, name, **kw)
        store.save_org(self.org)
        return name

    def prompt(self, *a, **kw):
        return sup.identity_prompt(self.org, self.agent(*a, **kw))

    def test_s2_1_THE_REGRESSION_git_worktree_add_is_named(self):
        # THE ONE THAT COST TWENTY AGENTS. The sentence used to list `git
        # add`/`commit`/`update-ref`/`merge` and stop there, so the step the
        # charter actually mandates read as unlisted — and therefore as a real
        # refusal rather than a retryable one.
        text = flat(self.prompt())
        self.assertIn("git worktree add", text,
                      "the mandated first step is still not named in the prompt")
        self.assertIn("git worktree remove", text,
                      "removal is the other half of the sequence and is unnamed")

    def test_s2_2_the_exact_path_is_named(self):
        # "told exactly what permission it needs instead of being refused
        # generically" — a permission without a path is still generic.
        text = flat(self.prompt())
        self.assertIn(flat(os.path.normpath(str(self.repo))), text,
                      "the prompt names no path, so the boundary is still "
                      "something you can only find by hitting it")

    def test_s2_3_the_seat_is_told_the_retry_is_automatic(self):
        # the measured failure mode is an agent reporting itself BLOCKED one
        # retry away from done, so "you will be approved" is load-bearing
        text = flat(self.prompt())
        self.assertIn("automatic", text)
        self.assertRegex(text, r"first attempt")

    def test_s2_4_it_is_attributed_to_codex_not_to_the_grant(self):
        # an agent that thinks its GRANT is short asks for a scope raise it
        # does not need; the honest attribution is what stops that
        text = flat(self.prompt())
        self.assertIn("not an orgtree rule", text)

    def test_s2_5_a_read_only_codex_seat_is_NOT_promised_approval(self):
        # supervisor's 2026-09-05 rule: `_approve` DECLINES for a read-only
        # seat, so promising it approval is a promise the seat cannot keep.
        # My change must not leak the write-enabled wording into that branch.
        text = flat(self.prompt(tools={"bash": True, "web": False, "edit": False,
                                       "subagents": False, "mcp": []}))
        self.assertIn("read-only seat", text)
        self.assertNotIn("approval for this seat is automatic", text)

    def test_s2_6_a_claude_seat_gets_no_codex_git_paragraph(self):
        # the whole block is inside `if model in CODEX_TIERS`; a Claude seat
        # has no such sandbox and telling it otherwise would be a false wall.
        # (Verified live: a Claude seat creates and removes a worktree under
        # the repo root with no prompt, in both Bash and PowerShell.)
        text = flat(self.prompt("opus"))
        self.assertNotIn("not an orgtree rule", text)

    def test_s2_7_a_codex_seat_with_no_repo_grant_omits_the_path_clause(self):
        with tempfile.TemporaryDirectory() as plain:
            text = flat(self.prompt(dirs=[{"path": plain, "mode": "rw"}]))
            # the general warning still stands...
            self.assertIn("git worktree add", text)
            # ...but it must not claim a scope-specific path it does not have
            self.assertNotIn("in your scope that means", text)

    def test_s2_8_identity_bytes_are_STABLE_across_renders(self):
        # D-181: this is the cached prefix. Same agent, twice, same bytes.
        name = self.agent()
        first = sup.identity_prompt(self.org, name)
        second = sup.identity_prompt(self.org, name)
        self.assertEqual(first, second, "identity prompt is not byte-stable")

    def test_s2_10_the_helper_script_is_named_when_it_EXISTS(self):
        # worktree-setup owns `python tools/worktree.py add`; it places the
        # worktree correctly and verifies dependencies resolve, so an agent
        # should reach for it before composing raw git.
        (self.repo / "tools").mkdir()
        (self.repo / "tools" / "worktree.py").write_text("# helper\n")
        text = flat(self.prompt())
        self.assertIn("tools/worktree.py add", text)

    def test_s2_12_the_helper_is_NOT_sold_as_a_way_around_the_denial(self):
        # ⚠ THE CORRECTION worktree-setup CAUGHT, and it is the one way this
        # paragraph could actively mislead. `plan_add` builds a plain
        # `git worktree add` and `add` executes it, so the helper hits the
        # SAME deny. Recommending it right after explaining the denial is
        # exactly where an agent infers it is the quiet route, runs it
        # unescalated, eats the denial anyway, and concludes the advice was
        # wrong. The escalation must cover the helper in the same breath.
        (self.repo / "tools").mkdir()
        (self.repo / "tools" / "worktree.py").write_text("# helper\n")
        text = flat(self.prompt())
        self.assertIn("tools/worktree.py add", text)
        self.assertIn("not a way around the denial", text)
        self.assertIn("runs `git worktree add` internally", text)
        # and `verify` is the one subcommand that genuinely needs nothing
        self.assertIn("only `verify` is read-only", text)

    def test_s2_13_the_helper_is_not_claimed_to_GATE_on_dependencies(self):
        # `add` raises only if git failed or the destination is not a
        # directory; it then REPORTS `ready`. The old wording ("checks its
        # dependencies resolve before reporting success") claimed a gate that
        # does not exist, and the value of the command is that its output can
        # be trusted literally.
        (self.repo / "tools").mkdir()
        (self.repo / "tools" / "worktree.py").write_text("# helper\n")
        text = flat(self.prompt())
        self.assertNotIn("before reporting success", text)
        self.assertIn("tells you whether they actually did", text)

    def test_s2_11_the_helper_script_is_NOT_named_when_it_is_absent(self):
        # ⚠ THE REASON THIS LINE WAS HELD BACK ONCE ALREADY. A seat holding
        # some other checkout has no such script; naming it would send the
        # agent after `invalid choice: 'add'` and then back to raw git, which
        # is worse than never mentioning it. The fixture repo has no `tools/`.
        text = flat(self.prompt())
        self.assertNotIn("tools/worktree.py", text)
        # the rest of the paragraph must still be there
        self.assertIn("git worktree add", text)

    def test_s2_9_many_repos_are_bounded_and_the_remainder_COUNTED(self):
        # a silently truncated list reads as "these are all of them"
        dirs = []
        for i in range(6):
            dirs.append({"path": str(make_repo(Path(self.folder.name) / f"r{i}")),
                         "mode": "rw"})
        text = flat(self.prompt(dirs=dirs))
        self.assertIn("more granted repositories", text,
                      "the list was truncated without saying so")


# ══ §3 the diagnostic that used to contradict the OS ═════════════════════
class DiagnosticExplainsDotGit(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.repo = make_repo(Path(self.folder.name) / "repo")
        self.scratch = Path(self.folder.name) / "scratch"
        self.scratch.mkdir()

    def diag(self, target, operation="write", provider="codex", mode="rw"):
        return sd.diagnose_target(
            str(target), operation, scratch=str(self.scratch),
            grants=[{"path": str(self.repo), "mode": mode}], provider=provider)

    def test_s3_1_a_dot_git_write_still_reports_allowed(self):
        # ⚠ DELIBERATE — see the module docstring. The write IS within scope
        # and the elevated retry IS auto-approved, so `allowed: false` would
        # be a different and equally expensive lie.
        got = self.diag(self.repo / ".git" / "worktrees" / "x" / "HEAD.lock")
        self.assertTrue(got["decision"]["allowed"])
        self.assertEqual(got["decision"]["reason_code"], "allowed")

    def test_s3_2_but_it_now_EXPLAINS_the_denial(self):
        got = self.diag(self.repo / ".git" / "worktrees" / "x" / "HEAD.lock")
        note = got["git"]["dot_git_write"]
        self.assertIsNotNone(note, "the report still contradicts the OS silently")
        self.assertEqual(note["status"], "advisory")
        self.assertTrue(note["auto_approved"])

    def test_s3_3_it_names_the_permission_AND_the_path(self):
        # the ticket's literal second outcome
        got = self.diag(self.repo / ".git" / "index.lock")
        note = got["git"]["dot_git_write"]
        # compare in the module's own canonical spelling: `_nearest_git`
        # normcases, so on Windows this is the lowercased/short form. The
        # assertion is that it is THAT repo's `.git`, not how it is spelled.
        self.assertEqual(os.path.normcase(os.path.normpath(note["path"])),
                         os.path.normcase(os.path.normpath(
                             os.path.join(str(self.repo), ".git"))))
        self.assertIn("elevated", flat(note["permission"]))
        self.assertIn("worktree", flat(note["reason"]))

    def test_s3_4_the_advisory_also_rides_the_decision_block(self):
        # a caller that reads only `decision` is exactly the caller that would
        # act on `allowed: true` and be denied by the OS a moment later
        got = self.diag(self.repo / ".git" / "index.lock")
        self.assertIn("advisories", got["decision"])
        self.assertTrue(any("permission denied" in flat(a)
                            for a in got["decision"]["advisories"]))

    def test_s3_5_an_ORDINARY_file_in_the_same_repo_gets_no_advisory(self):
        # no crying wolf: the sweep does not touch these, and an advisory here
        # would train the reader to ignore it where it matters
        got = self.diag(self.repo / "engine" / "main.py")
        self.assertIsNone(got["git"]["dot_git_write"])
        self.assertNotIn("advisories", got["decision"])

    def test_s3_6_a_claude_seat_gets_no_advisory(self):
        got = self.diag(self.repo / ".git" / "index.lock", provider="claude")
        self.assertIsNone(got["git"]["dot_git_write"])

    def test_s3_7_a_READ_of_dot_git_gets_no_advisory(self):
        got = self.diag(self.repo / ".git" / "HEAD", operation="read")
        self.assertIsNone(got["git"]["dot_git_write"])

    def test_s3_8_a_write_orgtree_ITSELF_refuses_is_not_second_guessed(self):
        # there the real reason is the grant; a second explanation would bury
        # it, and the elevated retry would NOT help
        got = self.diag(self.repo / ".git" / "index.lock", mode="ro")
        self.assertFalse(got["decision"]["allowed"])
        self.assertIsNone(got["git"]["dot_git_write"])

    def test_s3_9_openai_is_recognised_as_the_same_lane(self):
        # orgtree's registry calls the provider `openai`; the CLI tool and the
        # existing suite say `codex`. Both must resolve to the same lane.
        got = self.diag(self.repo / ".git" / "index.lock", provider="openai")
        self.assertIsNotNone(got["git"]["dot_git_write"])


# ══ §4 the boundary the ticket forbids moving ════════════════════════════
class NoGrantIsWidened(unittest.TestCase):
    def test_s4_1_the_advisory_grants_nothing_outside_the_grant(self):
        # an ungranted path stays refused and gains no advisory that could be
        # read as a route in
        with tempfile.TemporaryDirectory() as folder:
            repo = make_repo(Path(folder) / "elsewhere")
            scratch = Path(folder) / "scratch"
            scratch.mkdir()
            got = sd.diagnose_target(
                str(repo / ".git" / "index.lock"), "write", scratch=str(scratch),
                grants=[], provider="codex")
            self.assertFalse(got["decision"]["allowed"])
            self.assertIsNone(got["git"]["dot_git_write"])

    def test_s4_2_the_helper_reads_only_the_grants_it_is_given(self):
        # it must never discover a repository the seat was not granted
        with tempfile.TemporaryDirectory() as folder:
            make_repo(Path(folder) / "ungranted")
            granted = Path(folder) / "granted"
            granted.mkdir()
            self.assertEqual(
                sup.codex_denied_git_roots([{"path": str(granted), "mode": "rw"}]), [])


if __name__ == "__main__":
    unittest.main()
