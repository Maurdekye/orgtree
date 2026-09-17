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
python tools/worktree.py remove E:\path\to\worktree [--force] [--accept-unscanned] [--dry-run]
```

Before removing anything, `remove` scans the worktree for symlinks and
junctions **without following any of them** and refuses the removal when it
finds one whose target is outside the worktree. It also refuses a non-forced
removal of a worktree with uncommitted or unmerged changes, and refuses to
remove the main checkout at all.

### `--force` has nothing to do with the link check

This is the part that was wrong until 2026-09-17, and it was wrong in the
dangerous direction. The link refusal used to apply **only** when `--force` was
passed, on the assumption that a forced removal was the destructive one.

It is not. `--force` overrides the dirty/untracked *check*; it does not change
how Git deletes the tree afterwards. Measured on git 2.52.0.windows.1, in a real
worktree under the repository root with a `node_modules` junction pointing
outside it:

| command | git exit | target behind the junction |
| --- | --- | --- |
| `git worktree remove <wt>` — no `--force` | 0 | **destroyed** |
| `git worktree remove --force <wt>` | 0 | **destroyed** |

Worse, the un-forced path was the one an agent actually reached. A
`node_modules` junction is gitignored, so `git status` reports the worktree
clean, so none of the force-only refusals applied and the removal went straight
through. The check guarded the careful route and left the default one open.

Both routes refuse now, and `--force` keeps its real meaning: discard my
changes.

### `--accept-unscanned`

If the scan hits its entry limit it says so and refuses, because "no escaping
links found" from a scan that stopped early is a guess rather than a result.

A worktree with a **real** installed `node_modules` is the ordinary way to hit
that limit — a junctioned one is a reparse point and is never descended into, so
it scans small, while a real one was measured at 61,324 entries. The entry
budget is sized well above that, so this should be rare; when it does happen,
`--accept-unscanned` waives **only** that unknown. It never waives a link the
scan actually found, and it is a separate word from `--force` on purpose:
overloading one flag into "discard my changes" *and* "stop checking for links"
is exactly how the original defect happened.

To clear a link before removal, use the cleanup below rather than deleting it by
hand.

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

## Cleaning up junctions that already exist

`cleanup-preview` validates paths you already know about. `cleanup-scan` is the
half that finds them, which is what you want when the question is "what is out
there": it walks a root **without following a single link**, selects the
hazardous shape, and writes a plan that `cleanup-apply` executes.

```powershell
python tools/worktree.py cleanup-scan  "<root>" > plan.json
python tools/worktree.py cleanup-apply plan.json --confirm
```

Read `plan.json` before applying it. Nothing is unlinked by the scan.

**What it selects.** A link is marked for unlinking only when all three hold: it
is named `node_modules` (`--name` changes this), its target is readable, and its
target lies **outside the scanned root**. Everything else found is listed and
preserved with the reason attached — `not selected: target … is INSIDE the
scanned root`, or the name it actually had — so the plan documents what it
skipped instead of quietly narrowing. `--max-depth` and `--limit` bound the walk
and both bounds are reported:

- `complete: false` means the walk ran out of entry budget or hit an unreadable
  directory. The result is **not** a census; raise `--limit` and rerun.
- `exhaustive: false` means only that something sits below `--max-depth`. The
  requested depth was fully examined. On any real tree this is normal.

**Deeper is not safer.** Measured against the live scratch root, `--max-depth`
3, 4 and 5 each found the same 77 links, taking 5s, 11s and 32s. Depth 6 found
eleven, because the extra breadth exhausted the entry budget and truncated
before reaching most of the tree. The default is 4.

**The safe order, which the plan also prints:**

1. Unlink the junction — `cmd /c rmdir "<link>"`, or `cleanup-apply`. `rmdir` on
   a junction removes the **link** and does not follow it.
2. Then remove the worktree.

Doing it in the other order is the incident. And never reach for a recursive
delete on a junction — `rmdir /s`, `Remove-Item -Recurse`, `rm -rf` all follow
the link and empty its target. That is the whole trap: the obvious tool destroys
the thing you were trying to protect.

**Removing the link leaves that worktree unable to resolve dependencies**,
because the link was how it resolved them. That is expected — the worktree was
never private to begin with — and the fix is to recreate it under the repository
root, where `node_modules` resolves upward and no link is needed.

### The current population

Measured 2026-09-17 by two independent methods that agree exactly (this tool,
and `Get-ChildItem -Attributes ReparsePoint`):

- `…\Orgtree v2\data\scratch\orgtree` — **77 reparse points, 75 named
  `node_modules`**. 71 of those target `E:\Libraries\Desktop\orgtree\node_modules`,
  the real checkout. That is the hazard this tooling exists for.
- `C:\Users\ncola_k8bx\orgtree\scratch\orgtree` — a **second** scratch root with
  **27** further `node_modules` junctions, all pointing within itself.

A scan of the first root selects 72 and preserves 5: three `node_modules`
junctions whose targets sit inside the scanned root, and two links by other
names. Those are listed, not hidden.

## Cleanup (validating paths you already have)

Cleanup is two-phase. First produce a preview with exact paths:

```powershell
python tools/worktree.py cleanup-preview E:\path\to\checkout node_modules
```

⚠ `cleanup-preview` takes an `owned` list at the API level and the CLI does not
pass one, so from the command line every candidate comes back preserved. Use
`cleanup-scan` above, which supplies that list from what it actually found.

Only a path explicitly registered as an owned link and currently identified as
a symlink or Windows reparse point is previewed as unlinkable. Unknown reparse
points, ordinary files and directories, dirty or active worktrees, paths
outside the checkout, and anything changed since the preview are preserved. The
target of a link is never opened, traversed, or removed. Retirement alone does
not authorize cleanup; applying an unlink requires explicit confirmation after
the preview.
