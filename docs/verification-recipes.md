# Verification recipes

This document is the handoff entry point for W12. The machine-readable source is
[`verification-recipes.json`](verification-recipes.json); it records the pinned
candidate, owner, runner, command, controls, and every intentionally skipped or
unexecuted check.

## Feature-to-suite map

| Area | Canonical runner | Focused command | What it proves |
| --- | --- | --- | --- |
| Root/desktop | Node's built-in runner | `node --test tests/notifications.test.mjs tests/taskbarattention.test.mjs tests/icon-assets.test.mjs` | Main-process notification lifecycle and native/icon source guards |
| Renderer | `apps/desktop/renderer/tests/run.mjs` | `node apps/desktop/renderer/tests/run.mjs pendingattention notifydelivery notificationsettings` | Real bundled renderer paths for attention, delivery, and preferences |
| Native | Electron probe scripts under `tools/` | `node tools/test-popout-header-regions.mjs; node tools/test-taskbar-native.mjs` | Platform-bound behavior that cannot be established by jsdom |
| Backend | Python unittest and receipt tools | `python -m unittest tests.test_work_evidence_receipts tests.test_python_verification_runner` | Receipt provenance, isolated data roots, and failure classification |
| Quality guards | Root runner plus acceptance isolation tests | `node --test tests/portal-fixture.test.mjs tests/benchmark-controls.test.mjs tests/w07-acceptance-isolation.test.mjs` | Fixture cleanup, negative controls, and disposable acceptance roots |

The renderer runner accepts bare filename filters and may be split into several
batches. Keep `ORGTREE_TEST_CONCURRENCY=4` and its timeout/job limits unless a
recipe explicitly records a different setting. A filter is not evidence that a
test ran: retain the command output and receipt.

## Shared portal fixture

`tests/fixtures/portal.mjs` owns both jsdom documents and restores the globals it
installs. Use `withPortalFixture(async fixture => { ... })`; its `finally` path
returns React-owned nodes to the document where their root was created before
unmounting. This is important for failed assertions and for portal tests that
move the same component between windows. A fixture failure must not leave a
global `window`, observer, storage object, or open jsdom window for the next
case.

## Benchmarks and no-op controls

`tests/fixtures/benchmark.mjs` requires a transition to report whether it changed
state. Every run performs real transition iterations and then performs one
labelled `no-op control`. A no-op is not a zero-time transition and must not be
counted as a change. If the supposed transition is unchanged, the helper fails
instead of producing a flattering benchmark.

## Receipts and safe Git inspection

For a check against a peer's tree, use the portable receipt tool with an explicit
checkout and a full candidate SHA:

```text
python tools/verification-receipt.py --repo-root <checkout> --candidate <full-sha> -- <command>
```

A short SHA is suitable for a heading or a human message, but it is not a stable
provenance key. Resolve it with `git rev-parse --verify <short>^{commit}` and
record the full result in the receipt. Do not pipe Git output through a shell
when comparing patch identity on Windows; write the diff to a file or use
`git range-diff`, which preserves object-store values.

These inspection commands are read-only and safe for a reviewer:

```text
git status --short
git rev-parse HEAD^{commit}
git show --stat --oneline <full-sha>
git diff --check <base> <candidate>
git range-diff <old-base>..<old-tip> <new-base>..<new-tip>
```

Do not use `npm ci` or `npm install` from a worktree whose `node_modules` is a
junction. It can delete or reconcile a dependency tree shared by other runs.

## Watchdogs and process evidence

For a condition that can occur later, use a persistent watchdog. Prefer a
`process` watchdog on the producer PID over a file watchdog on its log: a quiet
log cannot distinguish a slow producer from a dead producer. Use a one-shot dog
for a single deadline or edge, and remove a persistent dog after handling its
first matching event. The watchdog's wake mail is evidence that the event was
observed, not evidence that an unrelated command succeeded.

## Native stderr and skipped checks

Native probes may write diagnostics to stderr while exiting successfully. Treat
stderr as captured diagnostic output; classify success from the exit status and
the probe's assertions. A nonzero exit is a failure even if stdout says PASS,
and a zero exit is not proof when the probe reports an unexecuted or inert case.
The receipt keeps command, exit code, stdout, stderr, and result class together.

The JSON recipe lists installer, real-provider, full-sweep, and taskbar-native
checks that are skipped or unexecuted in the focused run. Do not silently turn
any of those into PASS; run them separately with their own explicit
authorization and receipt. The taskbar probe was attempted but did not start:
the shared Electron install raced another process while creating `locales`.

## Handoff metadata

Successors should start with `docs/verification-recipes.json`, verify the pinned
candidate and checkout, then run the focused commands above. Reviewers should
compare the receipt's full candidate and tree state before interpreting a green
result. Update the metadata when the canonical runner, candidate, or skip reason
changes.
