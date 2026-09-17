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
printed on its own line. Two flags make that fatal instead of advisory:

```text
node tools/test-baseline.mjs compare --max-age-days 2
node tools/test-baseline.mjs compare --require-fresh
```

**These failures are partly environmental.** The baseline records the host,
platform, arch, node version and the test concurrency it was measured at, and
`compare` treats a different hostname as drift. A baseline recorded on another
machine is a hint, not an acquittal.

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
| `python-backend` | `tools/run-python-verification.py` over `tests/test_*.py`, 176 modules | **module** | several min |
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
