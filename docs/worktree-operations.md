# Safe worktree operations

Orgtree treats a Git worktree as user work, not disposable cache. Inventory
reads Git's checkout list and reports the branch, owner (when registered),
dirty and unmerged state, active application references, and total/hidden/
omitted counts. A filter changes visibility only; it never removes a row.

## Fresh checkout setup

Keep private checkouts under the repository's `.worktrees/<branch>` directory
when possible. That keeps dependency resolution local to the repository and
keeps renderer bundle scratch files isolated from other checkouts.

Run the setup helper from the fresh checkout:

```powershell
python tools/worktree.py setup E:\path\to\checkout
```

When a lockfile is present, the helper recommends `npm ci`; otherwise it
recommends `npm install` for a Node project. To provision the repository's
shared dependencies, pass an explicit source and then opt in to the junction
write:

```powershell
python tools/worktree.py setup E:\path\to\checkout `
  --dependency-source E:\path\to\main\node_modules --apply
```

The source and destination are checked as real directories first, and the
resulting junction is verified. The helper never runs a package manager and
never writes Git metadata. Any repository-metadata write must be an explicit,
separately authorized operation.

## Rename repair

Agent rename moves the agent's registered checkout root and repairs only
registry paths contained by the old root. It returns each old/new path pair.
Unrelated paths and similarly named siblings stay unchanged. No alias is
created at the old path, and a stale path is not recreated.

## Cleanup

Cleanup is two-phase. First produce a preview with exact paths:

```powershell
python tools/worktree.py cleanup-preview E:\path\to\checkout node_modules\.bin
```

Only a path explicitly registered as an owned link and currently identified
as a symlink or Windows reparse point is previewed as unlinkable. Unknown
reparse points, ordinary files/directories, dirty or active worktrees, paths
outside the checkout, and anything changed since preview are preserved. The
target of a link is never opened, traversed, or removed. Retirement alone does
not authorize cleanup; applying an unlink requires explicit confirmation after
the preview.
