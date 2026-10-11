# 4.2.0 desktop and renderer test repairs

The [release sweep](release-420-checks.md) found nine desktop and 48 renderer
failures on both the merge candidate and alpha.8. This follow-up updates tests
and fixtures to the current contracts. Application and engine behavior are
unchanged by these repair commits.

## What changed

- Desktop assertions now account for hub-menu refresh and the attention dot on
  the themed tray icon. Popout mocks implement content bounds, retaining the
  geometry correction and bounded-refusal controls.
- Version tests cover 4.x stable/alpha candidates, lockfile agreement, stable
  updater exclusion of prereleases, alpha channel behavior, and the separate
  legacy private-alpha identity and publishing restrictions.
- The scope-consumer fixture classifies the new tool-group ancestor check,
  phone network exposure, and docket reader identities. The inventory scanner
  itself is unchanged.
- `tests/disruptive/run-on-startup.test.mjs` now sits outside the default glob
  and calls the existing explicit opt-in gate before loading its probes. It
  retains all five startup tests, including temporary Windows task operations.
  No disruptive probe was enabled in this verification.
- The ACL positive control tries the configured location, process Temp, and
  profile Temp. It skips only when the real checker refuses replaceable
  ancestors; other failures still fail. It never changes ancestor ACLs. On this
  machine D: permits Authenticated Users replacement and profile Temp has
  foreign sandbox-user delete rights, so none of those paths proves trusted
  acceptance. Negative ACL controls still run.
- Legacy mail/docket mocks explicitly return an empty transfer list for the
  panel now mounted beside them. Source inspection confirms both successful
  engine list paths include `transfers`; specialized transfer tests retain their
  own transports. The two mock-timer failures disappeared with the preceding
  render crashes fixed; no timer implementation or timeout was changed.
- Attachment preflight now tests the staging-ticket POST and XHR upload,
  including refusal before any upload and selecting the smallest recipient
  limit. Checkbox counts include seven Orgtree tool groups; the hover-name
  assertion uses the current 600px ceiling.
- Circular-layout checks cover symmetric parent displacement, parent/team
  alignment, minimum pitch and no overlap under spring relaxation. The former
  fixed-parent test required exact contact, which this solver does not promise.
- Conversation retention tests settle both the old page and the reopened
  visit's fresh tail, and assert that stale history cannot land in the reopened
  visit. The retained entry becomes evictable only after all requests settle.
- The subsequent transcript-order merge moved `.draft` inside the live message
  wrapper. `turnpend` now recognizes that content marker without changing its
  assertion that a turn's incoming question precedes the streamed answer.
- The Gold theme merge added a sixth theme; the complete label inventory in
  `apptitle` now includes `langserver: Language Server Gold`.

## Measured verification

Final full suites on base `7ccc5fd` plus the repair commits (`4809b32` before
the final rebase), Windows Node v24.12.0:

| Suite | Total | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| Desktop, all 76 default files | 1,035 | 1,014 | 0 | 21 |
| Renderer, all 384 files | 3,236 | 3,232 | 0 | 4 |

`npm run typecheck` passed. The relocated startup suite was also invoked with
its opt-in absent: it reported one explicit gate skip and ran no probe. The
desktop count is five lower than the baseline because those five startup tests
are now in the explicitly gated suite. The extra default-suite skip is the ACL
positive control described above; the original 20 desktop and four renderer
skips remain skips, not passes. The renderer count increased by five from the
original sweep because the intervening transcript and theme merges added tests.

The branch then rebased cleanly onto `20dd731` (repair head `56f7877`). That
integration changed the renderer's frozen list status and added one test.
Rebuilt and ran 15 affected or related suites: `usagefreeze`, `freezelabel`,
`farzoomstate`, `haltcontrol`, `turnspinner`, `agentstray`, `agentstrayclickaway`,
`startingstatus`, `render`, `turnpend`, `streamorder`, `agentcolors`, `contrast`,
`deployreadycolor`, and `apptitle`: **124 passed, zero failed or skipped**.
Typecheck passed again. The full desktop and renderer counts above are measured
on `7ccc5fd`; the final `20dd731` verification is this targeted run, not another
full sweep. The remaining tests were not rerun after that rebase.

Renderer bundles use the repository runner's esbuild options, batches of eight
with the service stopped between batches, and the worktree's real
`node_modules/.tests-astra` directory. The unmodified runner uses `--prebuilt`,
keeping concurrency four, the 6 GiB job ceiling, per-test timeout and five-minute
run deadline. No node_modules links or copies are created. Desktop concurrency
is two. Temporary build/test output and npm cache are on D:; the explicitly
authorized profile-Temp ACL attempt is a tiny fixture removed in `finally`.

Logs and reproducible bundle helper: `D:/orgtree-work/tests-astra/`:
`desktop-final.log`, `renderer-green.log`, `typecheck-final.log` (full-suite
base); `bundle-freeze.log`, `renderer-freeze.log`, `typecheck-freeze.log`
(final rebase); and `bundle.mjs`. Earlier logs retain the original all-green
`03877f2` checks (desktop 1,014 passed, renderer 3,227 passed), and the
intermediate failures that identified the two additional stale assertions
described above. No application defect was fixed by this branch.

## Limits

These are unit/source/mounted-renderer checks, not installer, real Windows
startup, live-app, or platform deployment proofs. No app or engine build, live
data operation, system setting change, install, tag, release, or push was done.
No rig run was performed for these test-only changes. `npm ci` warns that
jsdom 30.0.1 declares Node ^24.15.0 or another supported major; the passing
results above are measured on the installed v24.12.0, without changing it.
