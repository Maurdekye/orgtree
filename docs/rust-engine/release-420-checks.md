# 4.2.0 release merge and full test sweep

Measured on Windows, 2026-10-11, by agy-astra. Merge candidate: **3b3810f**, based on **230039d** (4.2.0-alpha.8), with **v4.1.3 / ff0a40e** as its second parent.

## Result

The release ancestry is merged and no application or test code changed. The engine and main-path rig checks pass. The full desktop and renderer suites are **not green**: all 57 failures also reproduced on 230039d. This report is evidence for review, not a release approval.

Follow-up: [test repairs and green-suite verification](release-420-test-repairs.md)
records the subsequent test-only fixes and their measured results.

The 16 commits absent from rust-engine's ancestry did not mean their functional changes were absent. Inspection found the required behavior already on 230039d. Resolving the seven conflicted files in favor of the current candidate preserves both the released fixes and newer 4.2 behavior. The merge's net tree change is exactly docs/release-notes-4.1.2.md and docs/release-notes-4.1.3.md (27 lines). Version strings stay 4.2.0-alpha.8. The tag is now an ancestor.

## Preserved behavior

- Linux refuses an unsafe group-writable parent configuration folder, naming the fix. The engine trust checks were retained unchanged.
- A disabled D-Bus session address does not prevent the systemd user-service attempt. The corresponding desktop unit test passes.
- macOS/Linux engine data folders are private; only Orgtree's own folder is tightened. The platform-independent unit test passes; actual POSIX mode checks skip on Windows.
- Autostart fallback reasons, the Linux desktop-like CI script and workflow, and the 4.2 Run on startup gate remain unchanged.
- Conflict resolutions preserve the newer tray/startup wiring and avoid adding a second copy of the D-Bus regression test.

## Measured suites

| Suite | Pass | Fail | Skip | Notes |
|---|---:|---:|---:|---|
| Engine cargo check | 1 | 0 | 0 | orgtree-engine manifest, -j 2 |
| Full Rust workspace tests | 72 | 0 | 0 | engine/rs/Cargo.toml --workspace; broker/macro/doc targets also completed, with zero tests |
| npm run typecheck | 1 | 0 | 0 | Full desktop/renderer TypeScript |
| Desktop, all 77 root test files | 1,011 | 9 | 20 | 1,040 total; all files completed |
| Renderer, all 384 test files | 3,179 | 48 | 4 | 3,231 total; both batches completed |
| Rig hire-scope | 12 | 0 | 0 | Hire inheritance/refusals; fake CLI receives granted directories |
| Rig docket-rules | 16 | 0 | 0 | Agent tool calls, ownership, permissions, revision CAS and history |
| Rig mailbox | 13 | 0 | 0 | Message tools, paging/chunks, attachment snapshot and restart recovery |
| Baseline desktop failing-file rerun at 230039d | 86 | 9 | 0 | Seven files; exact nine failing test names reproduced |
| Baseline renderer failing-file rerun at 230039d | 385 | 48 | 0 | Twenty files; exact 48 failing test names reproduced |

The rig engine and fake CLI built successfully under the shared build lock; the lock was released. Rig runs used isolated state and fake inference, and each was shut down by the runner.

## Reproduction and evidence

All command output is under D:/orgtree-work/release-420-checks:

- cargo-check.log, cargo-test.log, rig-build.log
- desktop-merged.log and desktop-baseline.log
- renderer-merged.log and renderer-baseline.log
- desktop-classification.json and renderer-classification.json: each failure's name, location, error excerpt and baseline result
- rig-hire-scope.log, rig-docket-rules.log, rig-mailbox.log

Rig structured evidence:

- D:/orgtree-work/rig/agy-astra/evidence/hire-scope-20261011T103919
- D:/orgtree-work/rig/agy-astra/evidence/docket-rules-20261011T103929
- D:/orgtree-work/rig/agy-astra/evidence/mailbox-20261011T103936

Cargo used D:/orgtree-work/cargo-target/agy-astra and -j 2. Desktop ran the complete tests/*.test.mjs set with Node test concurrency 2. TEMP/TMP and the ACL fixture base were placed on D:.

Renderer tests used the repository runner's esbuild options, bundling into the worktree's existing node_modules/.release-checks-merged directory, then the unchanged runner with --prebuilt. This avoids creating the runner's usual node_modules junction, which the team rules prohibit. The normal 6 GiB job ceiling, concurrency 4, per-test timeout and five-minute run deadline remained active. No tests or assertions were changed. All 384 files completed, in two command-line batches.

For baseline classification, the worktree was checked out at 230039d and every failing file rerun. Renderer bundles were reused because git diff proves the complete application, test and runner sources byte-identical at the two commits. The source files read directly by tests were read from the 230039d checkout. The worktree was then returned to the merge branch. These are measured baseline reruns, not a classification inferred only from ancestry.

## Failure interpretation

All failures below are **pre-existing relative to this merge**, measured at 230039d. That does not make them harmless or approved for release.

Desktop failures include one environment-sensitive ACL positive control: D:'s ancestors grant Authenticated Users replacement rights, which the real trust checker correctly refuses. No ACLs were changed. Other failures include stale source-pattern expectations, incomplete window mocks, 3.x-only version/update expectations, the new startup-test source tripping the disruptive-policy scanner, and missing scope-consumer inventory entries.

Renderer: 40 failures throw in TransferPanel after older fixtures return no transfers array. Two later tests throw in Node's mocked timer queue. The remaining six cover a missing XMLHttpRequest fixture, circular layout, conversation retention, a stylesheet assertion and two old checkbox-count expectations (new tool-group controls add seven). These diagnoses come from the failure traces and source inspection; only the failure reproduction is proven here. No fixes were folded into this release-ancestry merge.

## Individual failures

Every row reproduced with the same test name on 230039d. Renderer file names below identify source suites; generated bundle line numbers are intentionally omitted.

### Desktop

| File / test | Failure | Baseline 230039d |
|---|---|---|
| tests\attach.test.mjs:266:1 ? the real trust check accepts an owner-exclusive file (positive control) | AssertionError [ERR_ASSERTION]: path replaceable via ancestor D:\orgtree-work\release-420-checks\acl\acl-fixtures-kbOMvq=S-1-5-11;D:\orgtree-work\release-420-checks\acl=S-1-5-11;D:\orgtree-work\release-420-checks=S-1-5-11;D:\orgtree-work=S-1-5-11;D:\=S-1-5-11 | Fails |
| tests\disruptive-policy.test.mjs:132:1 ? §2 no file reachable from the default glob contains a disruptive primitive | AssertionError [ERR_ASSERTION]: these files can disturb the desktop from an ordinary `npm test`. Move them to tests/disruptive/ and gate them on ORGTREE_DISRUPTIVE_PROBES: | Fails |
| tests\engine-restart.test.mjs:418:1 ? the row is refreshed on every rebuild and while the menu is open | AssertionError [ERR_ASSERTION]: The input did not match the regular expression /if \(trayMenuOpen\) \{ refreshTrayUpdates\(\); refreshTrayEngine\(\); return \}/. Input: | Fails |
| tests\icon-assets.test.mjs:106:1 ? packaging, renderer, tray and windows reference the eye icons | AssertionError [ERR_ASSERTION]: The input did not match the regular expression /tray\?\.setImage\(image\)/. Input: | Fails |
| tests\popout-windows.test.mjs:161:1 ? native creation applies the accepted rectangle once and only to its named child | TypeError: window.setContentBounds is not a function | Fails |
| tests\popout-windows.test.mjs:192:1 ? native initial placement corrects measured frame drift and is bounded when the OS refuses | TypeError: window.setContentBounds is not a function | Fails |
| tests\private-alpha-identity.test.mjs:42:1 ? the v3 package and lockfile identify a public 3.x release; the private packager keeps its alpha version | AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^3\.\d+\.\d+$/. Input: | Fails |
| tests\private-alpha-identity.test.mjs:159:1 ? a stable installation is never offered the alpha, 3.0.0 is stable, and the alpha build has no updater | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | Fails |
| tests\scope-consumer-inventory.test.mjs:7:1 ? every renderer scope source has an explicit classification | AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: | Fails |

### Renderer

| Source suite / test | Failure | Baseline 230039d |
|---|---|---|
| agentrowmenu.test.ts(x) ? §3 a right-click on a row does not navigate, and the list survives its own menu | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| attachment-limits.test.ts(x) ? attachment preflight uses the smallest recipient limit before sending any bytes | Error: XMLHttpRequest is not defined | Fails |
| circularlayout.test.ts(x) ? colliding neighbouring teams move equally in opposite directions only as far as needed | AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: | Fails |
| closemenu.test.ts(x) ? §10 node inbox: its title-bar menu offers Close, and Close runs the panel's own dismiss | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| closemenu.test.ts(x) ? §10 org inbox: its title-bar menu offers Close, and Close runs the panel's own dismiss | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| closemenu.test.ts(x) ? §11 node inbox, PINNED: Close closes the window and keeps its placement | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| closemenu.test.ts(x) ? §11 org inbox, PINNED: Close closes the window and keeps its placement | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| closemenu.test.ts(x) ? §12 compose, opened from inside the org inbox, closes on its own without taking the inbox with it | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| contextmenu.test.ts(x) ? §B2d the node inbox wires the node-box reference; the desk's scaled row still gets a body-level menu | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| convoretention.test.ts(x) ? older-page fetch is retained until it settles after last unsubscribe | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | Fails |
| copytitles.test.ts(x) ? Agent-scoped modal bar: node-inbox | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| deskrefs.test.ts(x) ? §10 a reference in a mail body is live in the node inbox panel | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| deskrefs.test.ts(x) ? §10b CONTROL — the same panel with no world renders the token as text | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| deskrefs.test.ts(x) ? §10c the node inbox MODAL closes on its way to what a reference names | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| docket.test.ts(x) ? §16 NodeInboxModal counterparty is clickable agent jump that closes modal | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| docket.test.ts(x) ? §17 OrgInboxModal inbox sender is external peer and stays plain (no agent jump) | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| docket.test.ts(x) ? §18 OrgInboxModal outbox @by links resolvable local agent, while recipient stays plain | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| docket.test.ts(x) ? §19 multiple questions on an item render separate question boxes with respective askers | TypeError: Cannot read properties of undefined (reading 'runAt') | Fails |
| farzoomname.test.ts(x) ? §2 Stylesheet places model token at upper-left resting corner and centers hover annotation above node | AssertionError [ERR_ASSERTION]: hover reveals sq-far-name with opacity and max-width expansion | Fails |
| inboxnoclose.test.ts(x) ? an agent inbox: no footer close button, and the mail itself rendered | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| inboxnoclose.test.ts(x) ? an agent inbox: Escape still dismisses it | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| inboxnoclose.test.ts(x) ? an agent inbox: a backdrop click still dismisses it | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §11 a repeat request re-runs the folder decision after the reader has moved | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §11b CONTROL — an unrelated repoll does not move the reader | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §11c a reference to retained mail outside the window opens the folder that HOLDS it, as received mail | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §12 a rejected question, followed from Sent, is reported as a failed question — with a retry | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §12b an unanswered question, followed from Sent, claims nothing yet | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §12c CONTROL — a question ANSWERED "no" from Sent still says the message is not here | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §14 an answer that arrives after a repoll still opens the folder | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §15 an older question, answered late, does not move the reader off a newer target that was already loaded | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §15b CONTROL — the same request re-delivered under a repoll is not superseded by itself | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailjump.test.ts(x) ? §15c an outcome belongs to the request that produced it, and does not outlive it | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailnav.test.ts(x) ? §1 the DESK INBOX: clicking a sender takes you to that agent's desk, with a camera that is still a camera | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailnav.test.ts(x) ? §3 the READING PANE's sender navigates too, and selecting a row does not navigate by itself | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailroute.test.ts(x) ? §3 a NODE box pointer opens that node's inbox, once | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailroute.test.ts(x) ? §4 an ORG box pointer opens the org inbox | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §5.1 an org-inbox row names the outside party as plain text — no chip, no route — while the SENT pane still shows who sent it, in full | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §5.2 …and a peer that spells itself EXACTLY like one of our live agents still gets nothing — the row obeys the call site, not the name | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §12.4 …and it is WIRED: NodeInboxModal carries the tree down to the row | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §12.5 the DESK inbox tab: a sender name is a real route, and clicking it reaches the desk's own onJump | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §12.6 CONTROL: the same desk with NO onJump draws no route in the inbox | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailsender.test.ts(x) ? §12.7 the desk inbox: the row BODY still selects, and the name does not | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailwire.test.ts(x) ? §11.1 an org-inbox row goes read on the POST, not on the next tree poll — the prop never changes here | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| mailwire.test.ts(x) ? §12.1 the org-inbox label is an element, not a loose text node — a bare one wraps under the unread badge and evicts the last-mail line | TypeError: Cannot read properties of undefined (reading 'runAt') | Fails |
| orgsettings.test.ts(x) ? ⑦  Hire defaults displays current registered MCP servers while wildcard is checked and switches to checklist on uncheck | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | Fails |
| render.test.ts(x) ? §6.7 rapid tab switching keeps the conversation | TypeError: Cannot read properties of undefined (reading 'length') | Fails |
| scopebody.test.ts(x) ? settings retain configured rights while the current chain narrows the display | AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | Fails |
| tierwire.test.ts(x) ? the node inbox draws a sender chip when the caller can resolve the model | TypeError: Cannot read properties of undefined (reading 'length') | Fails |

## Limits

The 20 desktop and four renderer skips are retained as skips, not passes. They include unavailable POSIX programs/mode checks, missing legacy provisioned Python runtime, elevated-HKLM testing, and browser-dependent cases as recorded in the logs. Windows unit tests do not establish that systemd/launchd or the Linux packaged application starts on a real machine; those CI scripts are preserved but were not executed here.

The explicit disruptive desktop/installer suite was not enabled. No installer or app bundle was built, no live data was changed, no release was pushed/tagged, and no installation was performed. The requested rig main paths ran, not every specialized rig proof.
