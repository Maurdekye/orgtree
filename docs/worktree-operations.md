# Safe worktree operations

## The rule

**Create your worktree under the repository root.** Then there is nothing else
to set up:

```powershell
python tools/worktree.py add my-ticket
cd E:\Libraries\Desktop\orgtree\.worktrees\my-ticket
npm test
```

That is the whole procedure. The worktree has no `node_modules` of its own and
does not need one, because Node resolves a bare specifier by walking the
directory chain upward — from `.worktrees/my-ticket` it reaches the shared tree
at the repository root and finds everything. `add` checks that this actually
worked before it reports success, and prints the path and the command to run.

**Do not junction, symlink or copy `node_modules` into your worktree.** It is
not a shortcut that carries a small risk; it is the cause of every worktree
incident this project has had. See [Why the junction is
banned](#why-the-junction-is-banned).

## Creating a worktree

```powershell
python tools/worktree.py add <name> [--base main] [--branch <branch>] [--dry-run]
```

The worktree is placed at `<repository root>/.worktrees/<name>` and the branch
defaults to `<name>`. The repository root means the **main checkout**, so every
agent's worktree lands in the same flat directory no matter which checkout the
command was run from. `.worktrees/` is already in `.gitignore`.

`add` refuses, rather than warns, when:

- the destination is outside the repository root — that is the case with no
  upward `node_modules`, and the usual next step from there is the junction;
- the destination already exists, so an in-progress worktree is never
  overwritten;
- the name is not a single plain path segment, or the destination is inside
  `.git`.

The outside-the-root refusal can be overridden with `--allow-outside-root` if
you genuinely have another way to supply dependencies. It is a guard, not a
wall — but it is deliberately something you have to type.

After creating the worktree, `add` reports where dependencies resolve from and
whether the suites can run. You can ask the same question about an existing
worktree at any time:

```powershell
python tools/worktree.py verify E:\path\to\worktree
```

This reports the exact directory the dependencies come from, every path it
looked at on the way up, and whether that directory is a link.

## Removing a worktree

```powershell
python tools/worktree.py remove E:\path\to\worktree [--force] [--dry-run]
```

Before removing anything, `remove` scans the worktree for symlinks and
junctions **without following any of them** and refuses `--force` when it finds
one whose target is outside the worktree. It also refuses a non-forced removal
of a worktree with uncommitted or unmerged changes, and refuses to remove the
main checkout at all.

If the scan hits its entry limit it says so and still refuses `--force`,
because "no escaping links found" from a scan that stopped early is a guess
rather than a result.

To clear a link before removal, use the two-phase cleanup below rather than
deleting it by hand.

## Why the junction is banned

Roughly forty-five agents hit this cluster in the 2.1.6 cycle. It is one
mistake with two separate consequences.

**A junction makes the worktree non-private.** Two checkouts that share one
`node_modules` share the most failure-prone directory in the repository. Test
runners write scratch state under it and clear that state before each run, so
two agents running tests at the same time delete each other's files. The
symptom is dozens of sub-50ms failures with no assertion text, which reads
exactly like "your change broke everything" and sends the agent off debugging a
patch that was never at fault. One release had to serialize its entire test
queue by hand, passing a "renderer test slot" between agents.

**A junction is a door out of the worktree.** `git worktree remove --force`
deletes the tree, and it deletes *through* a junction inside it. One agent lost
783 MB when a throwaway worktree's removal followed its `node_modules` junction
into the real checkout. This is current behaviour, not history: it reproduces
on git 2.52.0.windows.1, which is why `remove` refuses the combination instead
of documenting it.

Both consequences disappear if the worktree simply sits under the repository
root, which is why that is the default and the junction is opt-in.

## Linking dependencies anyway

`setup --dependency-source` is the junction route and it is gated:

- it is **refused outright** when the worktree already resolves `node_modules`
  upward, because the link would buy nothing and cost privacy;
- otherwise it still requires `--accept-shared-dependencies`, in as many words.

```powershell
python tools/worktree.py setup E:\path\to\checkout `
  --dependency-source E:\path\to\main\node_modules `
  --accept-shared-dependencies --apply
```

The engine-side surface (`gitworkspace.worktree_setup`) applies the same two
gates, so neither entry point is a way around the other.

Without `--dependency-source`, `setup` plans a real install: `npm ci` when a
lockfile is present, `npm install` otherwise. It reports where dependencies
resolve from either way, and it never runs a package manager or writes Git
metadata itself.

## Inventory

Inventory reads Git's checkout list and reports the branch, owner (when
registered), dirty and unmerged state, active application references, and
total/hidden/omitted counts. A filter changes visibility only; it never removes
a row.

```powershell
python tools/worktree.py inventory E:\path\to\repository
```

## Rename repair

Agent rename moves the agent's registered checkout root and repairs only
registry paths contained by the old root. It returns each old/new path pair.
Unrelated paths and similarly named siblings stay unchanged. No alias is
created at the old path, and a stale path is not recreated.

## Cleanup

Cleanup is two-phase. First produce a preview with exact paths:

```powershell
python tools/worktree.py cleanup-preview E:\path\to\checkout node_modules
```

Only a path explicitly registered as an owned link and currently identified as
a symlink or Windows reparse point is previewed as unlinkable. Unknown reparse
points, ordinary files and directories, dirty or active worktrees, paths
outside the checkout, and anything changed since the preview are preserved. The
target of a link is never opened, traversed, or removed. Retirement alone does
not authorize cleanup; applying an unlink requires explicit confirmation after
the preview.
