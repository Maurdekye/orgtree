---
name: orgtree-worktrees-and-git
description: "Work in an owned checkout from the assigned base and avoid shared-stash and dependency-link hazards."
---

Up: [orgtree-workspace](../SKILL.md)

# Own your checkout

These are developer working practices for a repository assignment, not permissions supplied by Orgtree. Read that repository's current `AGENTS.md`, handoff and task scope before making changes. Use the branch or exact base named by the integrator; a remembered default or stale local branch is not a substitute.

For this project's Rust-engine development, `rust-engine` is local and is not a branch to fetch from or push to origin. The current team workspace rule places owned source worktrees under `D:/orgtree-work/worktrees`. Earlier repository-root examples in `docs/worktree-operations.md` predate that placement rule. Verify the target does not exist before creating your own branch/worktree:

```powershell
git worktree add -b <agent>/<topic> D:/orgtree-work/worktrees/<agent>-<topic> <assigned-base>
```

Never edit another agent's worktree. Git's stash is shared across worktrees: do not use a bare `git stash` to park your changes. Commit your own work before probing a base or mutating files for a control; `checkout --`, restore and reset can destroy an uncommitted fix.

## Dependencies and sandbox errors

Never junction, symlink or copy `node_modules` between source checkouts. A worktree can look clean while an ignored junction points into another tree; removal can delete through it. Use the repository's dependency verification helper where applicable, and obtain the authorized dependency arrangement rather than improvising a link or install.

When Codex reports a `.git` write denied by its OS sandbox, follow the delivered sandbox retry instructions for an operation already within your grant. The worktree helper runs Git internally and cannot bypass that sandbox. An ungranted path still requires a scope decision; changing command spelling does not create authority.

## Remove only a finished owned worktree

Check ownership, active references, uncommitted/unmerged work and the resolved absolute target before removal. Use the repository's `tools/worktree.py remove <absolute-path>` helper when available: it checks escaping links and refuses incomplete scans. Do not add force or scan-waiver flags to make a refusal disappear. Do not run recursive deletion against a junction or an unchecked computed path.

Leave an assigned worktree in place while its review or integration still needs it. Hand off the exact commits through [reviews and landing](../reviews-and-landing/SKILL.md).

## See also

- [orgtree-builds-under-the-lock](../builds-under-the-lock/SKILL.md)
- [orgtree-reviews-and-landing](../reviews-and-landing/SKILL.md)
