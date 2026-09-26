# Known failures — the shared test baseline

**The suite is not green on `main`. Some tests fail on an untouched checkout, on
this machine, for reasons that have nothing to do with your change.** Until you
know which ones, "the suite is red" tells you nothing, and you cannot honestly
say your change broke nothing.

The old way of finding out was to stand up a second worktree at the base commit
and run the whole suite a second time. Eleven agents on the 2.1.6 push described
doing exactly that, one of them three times in a single session, at roughly
twenty minutes of wall clock each. This page is the replacement. The answer is
recorded once, in `docs/test-baseline.json`, and you read it.

---

## What you actually need to do

```text
# What is already broken? Runs nothing; answers in under a second.
node tools/test-baseline.mjs show

# Did MY change break anything? Runs the suite ONCE, here, and splits the
# result against the baseline. Exit 0 means no new failures.
node tools/test-baseline.mjs compare
```

> **A whole `compare` takes ~10 minutes and will outlive a single foreground
> command on an agent harness.** Run it a suite at a time —
> `compare --suite node-root` (~1.5 min), `--suite renderer` (~5 min),
> `--suite python-backend` (~10 min) — or, for the Python suite, hand its files
> to `tools/run-python-verification.py` in chunks with
> `--baseline <ids from docs/test-baseline.json>` and read
> `summary.unexpected_failures`. Do not background the whole run and walk away:
> a run that was killed partway looks exactly like a run that finished clean.

`compare` prints four lists and they are the whole point:

| List | Meaning |
| --- | --- |
| **NEW FAILURES (yours)** | The test exists in the baseline and was passing there. It fails here. This is a regression and it is yours. |
| **FAILURES THE BASELINE CANNOT ACQUIT** | The test is not in the baseline at all — usually your branch added or renamed it. The baseline has no opinion, so it is counted against you. |
| **FLAKY HERE** | It failed, and then passed when `compare` re-ran it in this same checkout. See below. |
| **PRE-EXISTING (not yours)** | Already failing at the baseline commit. Not caused by you. See *Handing one over*, below. |
| **FIXED since the baseline** | Failing in the baseline, passing here. Say so in your report; it is real work. |

The exit code is 0 if and only if the first two lists are empty. That makes
`compare` usable as a gate:

```text
node tools/test-baseline.mjs compare && echo "nothing new is broken"
```

Here is a real one. A deliberate regression was introduced into
`tests/icon-assets.test.mjs` on a checkout that also carries the two known root
failures, and `compare` was run once:

```text
baseline: FRESH — recorded 2026-09-16T17:39:28.511Z (17 minutes ago)
          at commit e2cb7d08d1 (this is HEAD)

── node-root ──
   622/635 passed, 3 failed

   NEW FAILURES (yours): 1
     ✗ tests/icon-assets.test.mjs :: the overseer eye source is orange and transparent outside the silhouette
         The input did not match the regular expression /viewBox="0 0 999 999"/. Input:
   PRE-EXISTING (not yours): 2
     · tests/attach.test.mjs :: the real trust check accepts an owner-exclusive file (positive control)
     · tests/private-update-feed.test.mjs :: §23 ⚠ WEB INSTALLERS ARE REFUSED BEFORE ANY DOWNLOAD, by the library's own gate

VERDICT: 1 failure(s) this baseline does not account for. Read them above.
```

Three failures on screen, one of them the agent's. No second worktree, no second
run of the suite, and an exit code of 1 that a script can act on.

### Flaky failures are named, not counted

`compare` re-runs the files that failed, so it often watches a test fail and
then pass, minutes apart, in the same checkout. That is an observation, not a
guess, and a test that passes on re-run is not a deterministic regression. Those
go in their own list:

```text
   FLAKY HERE — failed, then passed on re-run in this checkout: 1 (not counted against you)
     ~ apps/desktop/renderer/tests/presentfocus.test.tsx :: §5 a presentation already in a window is revealed…
```

They do not fail the gate, because a gate that cries wolf on every flaky file in
the tree is a gate people learn to ignore. They are never silent either: the
`VERDICT` line says how many there were and tells you not to quote it without
them. `--strict-flaky` counts them against you — use it when you suspect your
change is what *made* a test flaky, which is a real defect.

The same care runs the other way. A known-flaky failure that happens to pass
this time is reported as fixed with `[was FLAKY in the baseline — probably
flakiness, not a fix]` attached, because handing an agent a credit it did not
earn is the same dishonesty pointed the other way.

`apps/desktop/renderer/tests/presentfocus.test.tsx` is the live example: across
four recorded runs it alternated which of its `§5` and `§6` cases failed, and
passed both on retry every time.

If you have already run the suite for another reason, do not run it again:

```text
node tools/test-baseline.mjs run --out my-run.json      # once
node tools/test-baseline.mjs compare --results my-run.json   # runs nothing
```

---

## During PYPG: the P01 state-registry tests are declared failing

The Python + PostgreSQL work (PYPG) changes `api.py`, `store.py` and `supervisor.py` in every package, and that moves
the exact source spans and line-hashed witness ids that the P01 state registry pins
(`docs/state-system/operation-contracts.json` and the `*-boundary.json` fixtures). Coordinator ruling (A),
2026-09-25: until ONE re-anchor after the last PG-3x family lands, those 26 modules (`test_state_operation_contracts`,
`test_state_operation_inventory`, `test_state_material_reads` and every `test_state_*_boundary`) are recorded in
`docs/test-baseline.json` as pre-existing failures, so `compare` does not count them against a PYPG landing.

These entries are DECLARED, not measured at the baseline's commit; each one's note says so. They cover only the
binding failures ("stale source span", "source inventory binding is stale", a `KeyError` on a witness id). Any other
assertion failing in those modules is still a regression, so read the message before you file it as known. The
re-anchor, and the rewrite of the DOC_LOCK facts that `org_tx` makes false, are owned by p01-current-gap-opus55.

**PG-0 (PostgreSQL storage core, `orgtx.py` / `pgstore.py`) adds to this, 2026-09-25.** Its `store.py` edits
and its one-line `api.py` edit move pinned spans, so `test_state_operation_contracts` (measured by PG-0: 5
failures on SQLite through `tools/run-python-verification.py`) and `test_state_org_read_boundary` (named by the
lead; not measured by PG-0) fail on span drift, which p01 re-anchors ONCE after the last PYPG family lands. Two
of the `test_state_operation_contracts` messages are CONTENT rather than span drift: "storage: unknown witness" /
"storage: missing witnesses", and the changed S2k storage site set. They come from PG-0's new storage code
(`orgtx.py`, `pgstore.py`, the postgres branches in `store.py`), which the inventory has no rows for yet. Those
rows are added in the same p01 re-anchor, from facts PG-0 supplies.

**Re-anchored, 2026-09-26 (v3 `a814eed`):** the registry was re-anchored after PG-3c, the work items and PG-3e-A
landed: every changed span re-read, the facts it made false corrected, the new sites given pending rows, the 24
fixtures rebound. `test_state_operation_contracts` (71) and `test_state_operation_inventory` (27) pass at that
commit. The registry goes stale again with ANY engine edit that moves a cited span, so a failure here after a later
engine landing is span drift until read otherwise; p01 re-anchors it. `docs/test-baseline.json` still declares both
modules and is not changed by that commit (the baseline is regenerated by its owner). The W1-W8, S2k, launch and
middleware pins name a site by (file, function, ordinal), not by line.

---

## How old is it, and does that matter?

**A baseline that does not say how old it is, is worse than none** — it looks
authoritative and quietly stops being true. Every command that reads the
baseline leads with its age and its provenance, and `compare` will not let you
quote a clean verdict without seeing the drift warnings first:

```text
baseline: FRESH — recorded 2026-09-16T17:30:00.000Z (0.4 hours ago)
          at commit 12ffa49c63 (this is HEAD)
```

Freshness here is **not** measured in commits. It is measured by the git *tree
hashes* of `tests/`, `engine/`, `apps/`, `packages/`, `tools/` and
`package.json`. Two different commits whose measured trees are byte-identical
run the same tests over the same code, so a baseline taken at one is exactly
valid at the other — and most commits on this repository touch neither. Commit
distance is reported, but only as a note; the tree comparison is what decides.

The baseline is called `DRIFTED` when anything that could move the result has
changed — the code under test, the host it was measured on, a dirty tree at
record time — and `STALE` once it is older than seven days. Each reason is
printed on its own line. Three flags make that fatal instead of advisory:

```text
node tools/test-baseline.mjs compare --max-age-days 2
node tools/test-baseline.mjs compare --require-usable
node tools/test-baseline.mjs compare --require-fresh
```

### Out of date is not the same as untrustworthy

`--require-fresh` refuses on **any** drift, and that makes it useless to an
automated gate. A release verification runs on a commit *past* the one the
baseline was recorded at, by construction, so "the code under test changed
since" is its normal condition rather than a warning sign. Measured on
2026-09-17: a baseline recorded fourteen hours and four commits earlier already
reported `DRIFTED`, so a gate carrying `--require-fresh` would have refused
every verification that day.

`--require-usable` draws the line somewhere more useful. It tolerates the code
having moved on and refuses only the cases where the baseline is not describing
this machine, this checkout, or any moment it will name:

| reason | `--require-usable` |
| --- | --- |
| the code under test changed since | tolerated, still printed |
| measured on a different host | **refused** |
| its commit is not in this checkout | **refused** |
| measured with uncommitted changes under test | **refused** |
| records no timestamp | **refused** |
| records no tree hashes, so drift cannot be measured | **refused** |
| older than `--max-age-days` | **refused** |

Refusals are marked `✗` in the age report and mere drift `!`. A refusal exits
**2**, distinct from the **1** that means "found new failures", and it leads with
`BASELINE REFUSED — no suite was run, and this is NOT a failure of your change.`
That wording is load-bearing: an automated caller records both as the same
non-zero exit, and without it the agent whose commit happened to trip a stale
baseline spends an afternoon hunting a regression that does not exist.

**These failures are partly environmental.** The baseline records the host,
platform, arch, node version and the test concurrency it was measured at, and
`compare` treats a different hostname as drift. A baseline recorded on another
machine is a hint, not an acquittal.

### Acquittal does not expire — but it is never silent

A failure that has been in the baseline for a month is still acquitted. Failing
somebody's commit for a failure it did not cause is precisely the defect this
tool exists to remove, and putting an expiry date on acquittal would reintroduce
it on a timer, aimed at whoever happened to commit next.

What replaces expiry is visibility. Every acquitted failure is printed with how
long it has been excused and with whether anybody has ever been told about it:

```text
   PRE-EXISTING (not yours): 1
     · tests/example.test.mjs :: the-broken-one
         failing for 30 day(s); UNOWNED — nobody has been told
         hand it on:  node tools/test-baseline.mjs handover --test "..." --to <agent>
```

The age comes from `failing_since` on the baseline entry, which `record` carries
forward across re-recordings — without that, every re-record resets the clock
and a month-old failure reads exactly like one that appeared this morning. An
entry predating the field falls back to when its suite was last measured, which
is a lower bound, and the report says `at least` when it is quoting one.
`UNOWNED` means no **open** handover in `docs/test-handovers.json` names it.

---

## Release verification runs on this baseline

`npm run verify:release` picks a profile from the changed paths. Anything
matching neither the release nor the installer patterns escalates to `full` —
a deliberate fail-safe, and not something to weaken. What `full` *runs* used to
be a raw `npm test` and `npm run test:renderer`, which have no concept of a test
that was already failing. One unowned failure anywhere in 638 tests therefore
blocked release verification for every ordinary commit, and told the blocked
agent nothing about why.

`full` now runs this tool instead:

```text
node tools/test-baseline.mjs compare --suite node-root --max-age-days 7 --require-usable
node tools/test-baseline.mjs compare --suite renderer  --max-age-days 7 --require-usable
```

Same two suites, same coverage; the only change is that a known failure is
acquitted by name and a new one still blocks.

**One gate per suite, and never a bare `compare`.** A bare `compare` runs all
three registered suites, and `python-backend` alone takes about 11 minutes —
675 seconds, measured twice on an idle machine 2026-09-18; its recorded
`duration_ms` of 9.9 minutes is the optimistic end of the range. Split per
suite the other two were 63s and 80s, measured 2026-09-17 on `5f3a172`. Both
invariants are pinned in `tests/release-verification.test.mjs` so that folding
the gates back together, or dropping `--suite`, fails a test rather than
quietly changing what the release gate measures.

> ⚠ **The 600-second foreground ceiling this section used to cite is no longer
> the limit** (user ruling 2026-09-18). Orgtree now spawns agent processes with
> `BASH_MAX_TIMEOUT_MS=1500000` — 25 minutes — set in
> `supervisor.clean_env()`, because the run every agent is told to quote before
> landing a change could not finish inside 600 s. **So
> `node tools/test-baseline.mjs compare --suite python-backend` is now an
> ordinary foreground command: run it and wait for it.** It does not need to be
> backgrounded and polled, and the first-letter chunking some agents invented
> for it is no longer necessary. Pass the timeout explicitly — the raised number
> is the *ceiling* an agent may ask for, not the default it gets for free.
>
> Raising concurrency is not an alternative and has been measured rather than
> assumed: 11m15s at `--concurrency 4` and 11m10s at 12, because the flag never
> reaches `run-python-verification.py`, which is sequential by design — one
> interpreter and one `ORGTREE_DATA` per module. That isolation is why the
> suite's results are worth quoting, so the ceiling moved instead of the suite.
>
> Claude lane only: surveyed 2026-09-18 against the shipped binaries, neither
> the Codex CLI nor the Gemini CLI reads any shell-timeout environment
> variable, so there is nothing equivalent to set on those lanes.
>
> **Do not round 25 minutes up to 30.** The value is set by provider
> prompt-cache windows, not by the suite's runtime. A long foreground command
> holds the turn open for its whole duration, and a turn that outlasts the
> prompt-cache TTL resumes into a cold cache and re-reads its whole context at
> full price. The shortest window here is Codex at 30 minutes, so 25 leaves
> five minutes of grace; 30 would sit exactly on the edge, and that failure is
> invisible where it is caused. Trimming it down toward the suite's 675s is
> wrong for the same reason — the headroom is a consequence of the cache
> arithmetic, not the point of it.

`python-backend` is not in the `full` profile and was not added by this change;
it would cost ten minutes per verification and `full` never covered it.

Two path rules follow from the gate depending on this tool:

- `tools/test-baseline.mjs` and `tests/test-baseline.test.mjs` are **release
  tooling**. Changing them classifies as `release`, and the focused `source`
  gate runs `tests/test-baseline.test.mjs` — release tooling whose own tests are
  not in that gate can break them and still be waved through green.
- `docs/test-baseline.json` is deliberately **not** release tooling. It is the
  list of failures the gate forgives, so editing it escalates to `full`. The
  gate's own input cannot be widened behind the focused profile.

---

## Regenerating it

Do this when `show` says `DRIFTED` or `STALE`, on a clean checkout:

```text
git checkout main && git pull
node tools/test-baseline.mjs record --by <your-agent-name>
```

It refuses to run on a dirty tree, because a baseline measured on a dirty tree
is not a baseline of any commit. `--force` overrides that and records
`tree_clean: false`, which every reader is then shown.

Two things make regeneration cheap enough to actually do:

- **Human notes survive.** Any `note` you have added to a failure in
  `docs/test-baseline.json` is carried across to the new recording for every
  failure that is still failing. Re-recording does not cost you the sentence
  that explains why a failure is expected.
- **Flaky tests are separated from stable ones.** After the main run, `record`
  re-runs *only the files that failed* and marks each failure `stable` or
  `flaky`. This matters more than it sounds: a test that fails once and passes
  on the retry, recorded as a known failure, is how a real regression gets
  waved through. `compare` labels a pre-existing failure `[FLAKY in baseline]`
  so you know not to trust it either way. Skip the second pass with
  `--no-confirm` if you are in a hurry; the baseline then records
  `stability: "unconfirmed"` and says so.

---

## Handing a pre-existing failure over

A pre-existing failure is a real finding that belongs to somebody else's
ticket. Until now there was no way to write it down that did not read as *I am
taking this on*: a docket finding has to be attached to an item, and the only
item you hold is your own, so filing it there puts the failure on your ticket
and blocks your own completion behind somebody else's bug.

So there is a separate verb, and it is structurally incapable of claiming
anything:

```text
node tools/test-baseline.mjs handover \
  --test "the real trust check accepts an owner-exclusive file" \
  --to attach-owner \
  --by my-agent-name \
  --summary "Fails on untouched main; the ACL ancestry on this machine grants Authenticated Users." \
  --detail "Fails identically on a pristine 2.1.5 checkout, so it is an environment property of this host."
```

That does two things:

1. **Records it durably** in `docs/test-handovers.json`, next to the baseline
   that justifies the claim. The entry carries `claimed: false` and
   `ownership: "not-claimed-by-reporter"` as structural fields.
   `handover --claim` is refused outright.
2. **Prints the message to send**, already worded so the recipient cannot
   misread it — it opens with *"I am not working on this and I am not taking it
   on"*, names the baseline commit and the date it was measured, and gives the
   one-line command to reproduce.

Send that text with **`orgtree_send_notice`**, not `orgtree_message`. A notice
lands in the recipient's mailbox and is read at the start of its next turn
without waking it. A failure that was already there is not urgent to you; do not
interrupt somebody for it.

`handover` only accepts a test the baseline lists as already failing. If it is
not in the baseline, the tool refuses: as far as the record goes the failure is
not pre-existing, so either re-record the baseline or treat it as yours. That
guard is deliberate — without it the ledger becomes a place to disown your own
regressions.

To see the ledger, and to close an entry out:

```text
node tools/test-baseline.mjs handovers --open
node tools/test-baseline.mjs resolve --seq 1 --status accepted --by attach-owner --note "picked up on <ticket>"
```

Statuses are `open`, `accepted`, `closed`, `declined`. A `declined` entry with a
note saying "not mine, try X" is a useful outcome, not a failure.

The full argument for this design — and for rejecting the docket-finding and
new-docket-item alternatives — is recorded as decision #1 on the docket item
`every-agent-re-derives-which-test-failures-were`.

---

## What the baseline does NOT cover

Read this before quoting a clean `compare` as proof of anything. The baseline
covers three suites:

| Suite | What it is | Reports per | Roughly |
| --- | --- | --- | --- |
| `node-root` | `node --test tests/*.test.mjs` — the `npm test` set, 47 modules | test | ~1.5 min |
| `python-backend` | `tools/run-python-verification.py` over `tests/test_*.py`, 192 modules | **module** | several min |
| `renderer` | `node apps/desktop/renderer/tests/run.mjs` — 233 bundled jsdom suites | test | ~4-6 min |

**`python-backend` reports per MODULE, not per test**, and `show` says so on the
suite's own line. The sanctioned runner gives each module a fresh interpreter
and a fresh `ORGTREE_DATA`, and that isolation is the reason the suite is
trustworthy at all — it is not worth trading for finer reporting. Do not run
those tests any other way to check a baseline claim: without the isolated data
root the results are garbage, and the measurement is not close. One module that
passes cleanly under the runner reports **eighteen errors** when run bare with
`python -m unittest`.

### The modules now refuse a bare run, and say why

That warning used to be advice you had to remember. It is now a mechanism.

Your `PYTHONPATH` is `C:\Program Files\Orgtree\resources\engine\backend` — the
**installed** desktop app. This is not a machine setting; the Machine and User
scopes are empty. The installed engine spawns your CLI and prepends its own
backend so the child can import it (`supervisor.py`, `warmpool.py`,
`antigravity_session.py` — four sites). That injection is correct and agent
spawning depends on it; **do not remove it**. Its unintended reach is that every
command you then type inherits it, ahead of the checkout, so `import orgtree`
resolves to the shipped build. The loud direction wasted several agent-hours: a failure was
reported against `main`, investigated with the change reverted in a second
checkout, and the comparison proved nothing because *both arms imported the same
installed package*. The quiet direction is worse and is silent — a green run
reported as a verified fix against a module that never contained the change.

Every `tests/test_*.py` now carries one line:

```python
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
```

`tests/import_provenance.py` checks that `orgtree` and `engine` resolve under the
checkout the test file itself lives in — the worktree you are in, not only the
main checkout — and raises `ForeignImportError` naming the foreign path and the
command to use instead. If you see it, you do not need to investigate; change the
command:

```text
python tools/run-python-verification.py tests/test_x.py
```

The guard **refuses, it does not repair**. It will not quietly put the checkout
on `sys.path` to make a bare run work, because a bare run that looks trustworthy
is the defect, one step further along. Under the sanctioned runner — and so under
`compare`, which goes through it — the check always passes and costs two
`find_spec` calls once per module process.

68 of the 178 modules already did `sys.path.insert(0, str(REPO / "engine" /
"backend"))` before importing the engine, and those were never affected. The
guard sits *after* that insert, so they keep working bare. The other 110 did not,
and those were the silent ones.

### Why two imports of the same engine can disagree in one process

This is the detail that makes the rest of it make sense, and it is worth knowing
before you debug anything in this family.

Your `PYTHONPATH` ends in a **trailing semicolon**:

```text
C:\Program Files\Orgtree\resources\engine\backend;
```

An empty entry in `PYTHONPATH` means **the current working directory**. So
`sys.path` gets the installed backend *first* and the repo root *second*, and
which copy you get depends on the name you import:

| you write | you get | why |
| --- | --- | --- |
| `import orgtree` | `C:\Program Files\...\engine\backend\orgtree` | the installed backend holds `orgtree/` directly, so entry 1 wins |
| `from engine.backend.orgtree import ...` | **your checkout** | the installed backend has no `engine/` under it, so entry 1 misses and the repo root (entry 2) answers |

**Both, in the same process.** That is why some tools looked immune while others
were not: `tools/docket-payload-probe.py` reaches the checkout by accident of
spelling, and a module next to it does not.

It is also why a bare run is worse than "you get the shipped code". Three engine
modules — `clipin.py`, `codexpin.py`, `mcptool.py` — import `orgtree.` absolutely.
A bare run that reaches any of them loads **two copies of the same package at
once**, one from each tree, with separate module state. The guard refuses before
you can get there.

One more consequence, since it looks like a contradiction otherwise:
`%LOCALAPPDATA%` and `%LOCALAPPDATA%\Temp` are not interchangeable for ACL
fixtures. See `tests/attach.test.mjs`, which explains which roots this machine's
ACLs actually permit and why.

Everything else is listed in each suite's `excluded` array and reprinted by
`show`, so the gap is stated rather than hidden:

- **`tests/disruptive/*.test.mjs`** — a separate `npm run test:disruptive`
  target, not part of `npm test`.
- **`tests/*.test.ps1`** — PowerShell boot and installer probes; no node runner
  executes them.
- **`tools/test-*.mjs`** — Electron and native probes needing a display and a
  built application.
- **renderer probe scripts** (`*_probe.py`, `*-probe.tsx`, `*.probe.ts`) — driven
  by hand or by a native probe runner, not by `run.mjs`.

### A probe that lives outside the checkout: `tools/assert_repo_import.py`

Everything above protects `tests/test_*.py`. It does not reach the other half of
the problem: a benchmark or one-off probe in an agent's scratch folder, which
lives outside the repository and reaches into it by hand.

```python
sys.path.insert(0, os.path.join(REPO, "engine", "backend"))
from orgtree import store
```

That pattern is correct and it wins **while `REPO` is right**. The defect is what
happens when it is wrong -- a typo, a shell-quoting slip, a worktree that was
removed after the script was written. The insert then points at nothing, a
fallback answers instead, and **no `ImportError` is raised**. The probe measures
the wrong code and prints a plausible number. Two arms of a real performance A/B
were lost to exactly this; the only thread that caught it was an empty
provenance field in a result file.

There are three fallbacks on this machine, not one:

| fallback | reaches you when | what answers `import orgtree` |
| --- | --- | --- |
| `PYTHONPATH` | any bare `python` | `C:\Program Files\Orgtree\resources\engine\backend` |
| the packaged runtime's `python313._pth` | `-I`, or any launch of the installed `python.exe` | the same installed backend |
| **the runtime's `../backend`, from a worktree** | any bare run using this checkout's `engine/runtime/python.exe` | **the MAIN checkout** -- `engine/runtime/` is gitignored, so a worktree has no interpreter of its own and the `_pth` resolves relative to the main tree |

The third one is the reason an A/B between two worktrees can measure the same
code twice. It is also invisible: both arms run, both report, neither errors.

Two lines at the top of the probe close all three:

```python
sys.path.insert(0, os.path.join(REPO, "tools"))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)      # raises, loudly, if it is wrong
from orgtree import store                  # now provably this checkout
...
provenance.write_result(out, {"ms": 8.2})  # result carries a non-empty sha
```

It proves `REPO` is really a checkout before importing anything, places the same
two roots the sanctioned runner uses, reads back each module's own `__file__`,
and requires that origin to be exactly where the module's dotted name says it
should be -- containment under the repo root is not enough, because a worktree
is *inside* the main root. On success it prints a receipt:

```text
provenance OK: repo E:\...\orgtree @ aba2439ae354
provenance OK: orgtree <- E:\...\orgtree\engine\backend\orgtree\__init__.py
```

The receipt is the point. A guard that is silent when it passes cannot be told
apart from a guard that was never called, which is the failure class this whole
family exists to close. It goes to stderr so a probe's JSON stdout stays clean.

It also refuses to hand back provenance it cannot tie to a commit, so
`write_result` cannot produce the empty field that was the only warning last
time. `--allow-missing-commit` exists for a tree with no git, and it records
*why* the sha is absent rather than leaving a blank.

From the shell, which is also how both directions are demonstrated:

```text
python tools/assert_repo_import.py --repo <path> [--result out.json] [names...]
```

Exit 0 with the receipt, or exit 2 with `IMPORT PROVENANCE FAILED` and no result
file. `tests/test_assert_repo_import.py` drives real subprocesses for both
directions and carries its own negative control -- it proves that *without* the
guard the same wrong path still resolves `orgtree` somewhere else with no error,
so if the hazard ever stops reproducing the suite says so instead of quietly
testing nothing.

**This one repairs `sys.path`; `tests/import_provenance.py` deliberately does
not.** That is not an inconsistency. A test module has a sanctioned runner that
places the roots for it, so quietly making a bare run work would hide the defect.
A scratch probe has nothing else, so placing the roots is the job -- and it
happens only after the root has been proven real. Pass `insert_path=False` for
the refusing behaviour.

#### The runner's protection stops at the process it launches

A test module that spawns its **own** child -- an engine, a hook, a CLI -- gets
none of it. The runner puts the roots on the module's `sys.path` and passes `-I`
to the module's interpreter; neither reaches a `subprocess.Popen` the module
makes. That child starts from the packaged runtime's own configuration, and the
`._pth` has a second effect nobody writes down:

| what the `._pth` does | consequence for a spawned child |
| --- | --- |
| sets `safe_path` / isolated mode | **the child's cwd is NOT on `sys.path`** -- `cwd=` does not make a sibling module importable |
| lists `../backend`, `../mailhub`, `../../` | those are the only roots, and they are relative to whichever checkout owns the interpreter |

`tests/test_engine_http.py` was broken by the first row for days. It spawned the
engine with `cwd=engine/` and `import launch`, which had worked under a system
`python`, and under the bundled runtime died on `No module named 'launch'` --
`Ran 0 tests`, so the one suite covering the HTTP routes end to end asserted
nothing in either direction while `compare` correctly reported it as
pre-existing and stayed green.

The second row is the trap in fixing it. `engine/runtime/` is gitignored, so a
worktree has no interpreter and the runner selects the **main** checkout's; its
`._pth` roots therefore point at the main checkout. Restoring the import by
leaning on `../../` would have run the main checkout's engine underneath a
worktree's tests, passing while measuring code the branch does not contain.

So a module that spawns a child owes that child the same two things the runner
owes the module: pass the checkout in explicitly, place its roots ahead of the
`._pth` entries, and have the child read back what it actually resolved and
refuse to start if it is outside. `tests/test_engine_http.py` does this in the
first twenty lines of its `CHILD` script and is the pattern to copy. Check
`orgtree` with `importlib.util.find_spec`, not `import` -- `launch` captures and
strips the V2 credential before the legacy modules load, and importing them
early defeats that.

### How the renderer suite is captured

Worth knowing, because it looks impossible at first: `run.mjs` spawns node's test
runner with `stdio: 'inherit'` and the human-readable spec reporter, so it
reports an exit code and nothing a diff can use. It also owns a Job Object that
caps memory at 6 GB and the whole run at a wall-clock limit — protections added
after a single hung test reached 22 GB resident and took the machine down.

Rather than re-implement any of that, the baseline rides along. Node accepts
`--test-reporter` through `NODE_OPTIONS`, so `tools/test-baseline-reporter.mjs`
is loaded into every node process in the tree and appends NDJSON to its own file
per process. `run.mjs` is spawned completely unchanged and keeps every guard it
has. Bundled `foo.test.mjs` names are mapped back to `apps/desktop/renderer/
tests/foo.test.tsx` by basename.

**A run that died is not a run that passed.** Besides the runner's own limit,
this suite gets killed from outside: an esbuild child here has reached 5–9 GB,
and a host watchdog now kills any esbuild over 5 GB. Whatever the cause, the
tell is the same — files that were asked for produced no outcome at all. When
that happens the suite is marked `truncated`, the silent files are listed under
`files_that_produced_no_result`, and every screen says unmeasured is not
passing. Recording those files as simply absent would later read as "fixed", or
as nothing at all, which is the most expensive direction to be wrong in.

**One thing to know about that run limit.** Its default is 300 s and the suite
measured 274 s of test time on the machine this baseline was first taken on —
about ten per cent of headroom. When it fires, batches are dropped and the files
that never ran would be recorded as though they had passed. So `record` raises
`ORGTREE_TEST_RUN_TIMEOUT_MS` to 900 s for its own run, writes the override into
the baseline under `env_overrides`, and if the limit fires anyway it marks the
suite `truncated` with a note saying unmeasured is not passing. Nothing about
that changes what `npm run test:renderer` does for anyone else.

A `--filter` narrows which files run. A baseline recorded with one is stored as
`partial` and says so on every screen that shows it, because a filtered run that
did not say so would read as if the unselected files had passed.

---

## The record itself

- `docs/test-baseline.json` — schema `orgtree.test-baseline/v1`. The commit, the
  tree hashes, the machine, the timestamp, and every known failure with its
  file, its test name, its scrubbed error and whether it is stable or flaky.
- `docs/test-handovers.json` — schema `orgtree.test-handover/v1`. The append-only
  handover ledger.

A failure's identity is `suite::file::test name`, never its error text — error
text carries absolute paths, temp directories and randomized fixture names, so
using it as identity would make every entry a one-time match. Error text *is*
recorded, scrubbed and hashed, and `compare` flags a pre-existing failure whose
error has changed since the baseline. That is a hint that something moved
underneath it, not a verdict.

Both files are committed. Do not gitignore them: the whole value is that the
next agent gets the answer without running anything.
