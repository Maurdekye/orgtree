# Disruptive probes

Tests in this folder are allowed to do things an ordinary test run must never do
on somebody's desktop: open a console window, show a dialog, raise a UAC prompt,
or execute a compiled installer.

Two redundant barriers keep them out of an ordinary run.

1. **The folder.** The default script is `node --test tests/*.test.mjs`, which
   does not recurse, so it cannot reach this directory. `tests/disruptive-policy.test.mjs`
   §3 reads the REAL script out of `package.json` and fails if it is ever widened
   to a recursive glob — checking the repository rather than its own model of it.
2. **The gate.** Each probe asks `./gate.mjs` before spawning, and it opens only
   on an exact `ORGTREE_DISRUPTIVE_PROBES=1`. §5 enforces that every probe in
   here actually asks; an unasked gate is not a barrier.

To run them, on a machine you are willing to have interrupted:

    ORGTREE_DISRUPTIVE_PROBES=1 npm run test:disruptive

A gated-out probe reports as SKIPPED and prints why. It never reports as passed,
and its acceptance evidence is recorded as `not_exercised` — an unmeasured
control and a satisfied one are different claims.

## What the policy guard does and does not catch

This matters, because the guard is a **tripwire against reintroduction, not a
sandbox**. It reads the text of each file the default glob can reach and looks
for six specific forms:

- a spawn written with `windowsHide: false` or `windowsHide: !flag`
- `user32` — finding, showing or closing somebody else's window
- spawning or exec'ing `makensis`
- `spawn(electron, …)`
- `-Verb RunAs` / `runas` — requesting elevation
- spawning or exec'ing `Setup.exe`, `msiexec` or an `.msi`

**It does not catch these, and they are real.** An independent review of the
first version found them, and they are listed here rather than left implied:

- **A spawn with no `windowsHide` key at all.** Node documents the option as
  defaulting to false, so the ordinary way of writing a console-creating spawn is
  invisible to the text scan. The detector only fires when somebody writes the
  default out by hand.
- Options supplied from a variable (`spawn(exe, [], opts)`), a value behind an
  identifier (`const hide = false`), or `windowsHide : false` with a space before
  the colon.
- A `.test.mjs` that imports a helper which does the disruptive work; only the
  glob-reachable file's own text is read.
- An in-process modal such as `dialog.showMessageBox` inside an Electron main
  process, and `spawn('start cmd', { shell: true })`.
- A bare `node --test` with no path argument, which searches recursively from the
  working directory and reaches this folder. §3 catches that shape in the
  package script; it cannot stop a person typing it at a prompt. THE GATE is what
  protects that case, which is why §5 makes asking it compulsory.
- Hidden helper processes, deliberately. `installer-elevation.test.mjs` spawns a
  hidden PowerShell with `windowsHide: true` and is correctly not flagged; a
  no-spawning-at-all rule would flag much of a legitimate suite. §1b pins that it
  stays unflagged.

Two bounds of the text scan itself, found by the same review:

- `runas` is case-insensitive, so an ordinary identifier such as
  `const runAs = true` trips the elevation detector. It fails CLOSED — a false
  alarm, never a miss — and nothing in the repository trips it today.
- §5 is satisfied by a MENTION of the gate, not by a call to it. A probe whose
  only occurrence is `// we do not need requireDisruptiveOptIn here` passes. That
  is the normal bound of reading source as text, and it is acceptable for a
  tripwire; it is not acceptable as a substitute for reading a new probe.

So: the folder and the gate are the protection. The guard's job is to notice when
a known-disruptive form is added back to a file an ordinary run can reach.
